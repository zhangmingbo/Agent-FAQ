/**
 * LLM 驱动任务对话管理器（agentic dialogue）
 *
 * 设计原则：LLM 负责"说什么"，系统负责"能不能"。
 *   - 每轮把「任务目标 + 字段约束 + 已收集 + 对话历史 + 用户输入」交给 LLM
 *   - LLM 输出 { slots, reply, ask_confirm, question }，系统做校验/确认门禁/执行
 *   - 状态机退化为检查器：必填是否齐（→确认态）、用户是否确认（→执行）
 *
 * 与 RuleDialogManager（dialogManager.js）并存：
 *   - nlu_mode = llm / hybrid 时使用本管理器
 *   - LLM 不可用/失败 → index.js 捕获后降级回规则管理器
 */

import { runAction } from './actionRegistry.js'
import { executeApiStep } from './apiStep.js'
import { TaskState } from './stateMachine.js'
import { get as getPrompt } from '../llmPrompts.js'
import dialogueRules from '../../rules/dialogueRules.js'
import { getReply } from '../replyTexts.js'

const CANCEL_PATTERNS = ['取消', '算了', '不办了', '不需要了', '退出', '停止', '不弄了', '放弃']

/**
 * 完成性承诺词（动作校验用）：LLM 只有真正执行了动作才能说"已转接/已提交"。
 * 非完成轮次命中 → 追加澄清，防止 LLM 编造"已办理/已转接"等虚假承诺。
 */
const COMPLETE_CLAIM_RE = /(已转接|转接成功|已提交|提交成功|已登记|登记成功|已办理|已预约|预约成功|已安排|已完成|办好了|登记好了|提交好了|转接好了|已下单|下单成功|已申请|申请成功|已经帮您|已帮您)/

class LLMDialogManager {
  /**
   * @param {import('./taskDefs.js').default} defs - 任务定义
   * @param {import('./nlu.js').default} nlu - 理解层（dialogue 单轮决策）
   */
  constructor(defs, nlu) {
    this.defs = defs
    this.nlu = nlu
  }

  /** 初始化槽位状态 */
  initSlots(taskDef) {
    const slots = {}
    for (const s of (taskDef.slots || [])) {
      slots[s.key] = {
        value: null,
        filled: false,
        label: s.label || s.key,
        aliases: s.aliases || [],
        required: s.required !== false,
      }
    }
    return slots
  }

  /**
   * 处理一轮对话（LLM 决策）
   * @returns {Promise<Object>} 信封（与规则管理器一致，兼容 faq-engine 集成）
   */
  async processTurn(state, text) {
    state.turnCount = (state.turnCount || 0) + 1
    state.lastActive = Date.now()
    state.history = state.history || []

    // 1) 取消意图（规则快检，便宜可靠）
    if (this._isCancel(text)) return this._cancel(state)

    // 2) 确认态：确认/否认用规则判定（确定性、零成本）
    if (state.status === TaskState.CONFIRMING) {
      const confirmR = dialogueRules.isConfirm(text)
      const denyR = dialogueRules.isDeny(text)
      const isConfirm = typeof confirmR === 'object' ? confirmR.matched : confirmR
      const isDeny = typeof denyR === 'object' ? denyR.matched : denyR
      if (isConfirm && !isDeny) {
        state.history.push({ role: 'user', text })
        return await this._complete(state)
      }
      if (isDeny) {
        state.status = TaskState.COLLECTING
        const reply = getReply('modify_prompt_llm')
        state.history.push({ role: 'user', text }, { role: 'assistant', text: reply })
        return { reply, isComplete: false, extracted: true, reask: false, cancelled: false, taskState: state }
      }
      // 非确认非否认 → 交给 LLM（可能是修改/补充信息）
    }

    // 3) LLM 单轮决策
    const result = await this.nlu.dialogue({
      task: this.defs.get(state.taskCode),
      slotDesc: this._slotDesc(state),
      filledDesc: this._filledDesc(state),
      history: this._history(state),
      text,
    })

    // 4) 应用槽位（业务校验兜底：防 LLM 编造/乱填）
    //    —— 诊断日志：记录 LLM 原始输出与每个槽位的接受/丢弃原因（判定逻辑不变）
    const llmSlots = result.slots || {}
    console.log(`[TaskFlow-LLM] [${state.taskCode}] LLM 原始 slots:`, JSON.stringify(llmSlots))
    let applied = false
    for (const [k, v] of Object.entries(llmSlots)) {
      const slot = state.slots[k]
      if (!slot) {
        console.log(`[TaskFlow-LLM]   ✗ 丢弃 ${k}=${JSON.stringify(v)}：任务中不存在该槽位 key`)
        continue
      }
      if (slot.filled && state.status === TaskState.COLLECTING) {
        console.log(`[TaskFlow-LLM]   - 跳过 ${k}=${JSON.stringify(v)}：槽位已填（收集态不覆盖）`)
        continue
      }
      const sDef = this._slotDefByKey(state, k)
      if (!sDef || !this.nlu.valueMatchesSlot(sDef, v)) {
        console.log(`[TaskFlow-LLM]   ✗ 丢弃 ${k}=${JSON.stringify(v)}：值格式与槽位定义不匹配`)
        continue
      }
      const check = this.nlu.validate(sDef, v)
      if (!check.ok) {
        console.log(`[TaskFlow-LLM]   ✗ 丢弃 ${k}=${JSON.stringify(v)}：校验失败（${check.message || ''}）`)
        continue
      }
      slot.value = String(v)
      slot.filled = true
      applied = true
      console.log(`[TaskFlow-LLM]   ✓ 应用 ${k}=${JSON.stringify(v)}`)
    }
    const filledNow = Object.entries(state.slots).filter(([, s]) => s.filled).map(([k, s]) => `${k}=${s.value}`).join('；') || '(无)'
    const unfilledNow = Object.entries(state.slots).filter(([, s]) => s.required && !s.filled).map(([k, s]) => k).join('、')
    console.log(`[TaskFlow-LLM] [${state.taskCode}] 槽位状态 → 已填: ${filledNow} | 待填: ${unfilledNow || '(全齐)'}`)

    let reply = result.reply || (applied ? '好的，已记录。' : '请继续。')

    // 4.5) 中间"调用接口"步骤（确定性触发，不依赖 LLM 信号）：前置槽位填好后自动执行
    const apiReplies = await this._runPendingApiSteps(state)
    if (apiReplies.length) reply = reply + (reply ? '\n' : '') + apiReplies.join('\n')

    // 4.6) 动作承诺校验：非完成轮次禁止"已转接/已提交/已登记"等完成性宣称。
    //      LLM 只负责说话，动作执行由系统在用户确认后统一完成（_complete）——
    //      在收集/确认阶段就宣称"已办理"属于编造，追加系统澄清避免误导用户。
    if (COMPLETE_CLAIM_RE.test(reply)) {
      console.warn('[TaskFlow-LLM] 检测到未执行的完成性承诺，追加澄清:', reply.slice(0, 50))
      reply = reply + getReply('claim_clarify_suffix')
    }

    // 5) 完整性检查 → 确认态（确定性门禁：必填全齐才算齐；api 系统填充槽位不算必填）
    const taskDefNow = this.defs.get(state.taskCode)
    const systemSlots = new Set(taskDefNow?.apiResultSlots || [])
    const allFilled = Object.values(state.slots).every(s => !s.required || s.filled || systemSlots.has(s.key))
    if (allFilled && state.status !== TaskState.CONFIRMING) {
      state.status = TaskState.CONFIRMING
      reply = this._renderConfirm(state, result.reply)
    } else if (state.status === TaskState.CONFIRMING && applied) {
      // 确认态修改了信息 → 重新展示确认清单
      reply = this._renderConfirm(state, result.reply)
    }

    state.history.push({ role: 'user', text })
    state.history.push({ role: 'assistant', text: reply })
    if (state.history.length > 20) state.history = state.history.slice(-20)

    // 6) 提问插话 → 标记 question，由引擎先 FAQ 回答再继续
    if (result.question) {
      return {
        reply,
        isComplete: false,
        extracted: true,
        reask: false,
        cancelled: false,
        question: true,
        questionText: result.question,
        taskState: state,
      }
    }

    return {
      reply,
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  /** 完成：用户确认后执行动作（写库/调API） */
  async _complete(state) {
    const task = this.defs.get(state.taskCode)
    const actionStep = (task?.steps || []).find(s => s.type === 'action')
    const slots = {}
    for (const [k, s] of Object.entries(state.slots)) slots[k] = s.value

    let message
    if (actionStep) {
      const ctx = { sessionId: state.sessionId, task, state, step: actionStep, slots, params: actionStep.params || {} }
      const result = await runAction(actionStep.action, ctx)
      if (result.ok) {
        state.status = TaskState.DONE
        message = result.message || actionStep.done_message || getReply('complete_fallback', { taskName: task.name })
      } else {
        // 动作失败：保持确认态，告知用户
        message = getReply('action_fail_llm', { message: result.message })
        state.history.push({ role: 'assistant', text: message })
        return { reply: message, isComplete: false, extracted: true, reask: false, cancelled: false, taskState: state }
      }
    } else {
      state.status = TaskState.DONE
      message = task.completion_message || getReply('complete_fallback', { taskName: task.name })
    }

    state.history.push({ role: 'assistant', text: message })
    return {
      reply: message,
      isComplete: true,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  _cancel(state) {
    state.status = TaskState.CANCELLED
    return {
      reply: getReply('cancel_done'),
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: true,
      taskState: state,
    }
  }

  /** 确认清单（模板来自运营配置注册表 dialogue.confirm） */
  _renderConfirm(state, prefix) {
    const summary = Object.entries(state.slots)
      .filter(([, s]) => s.filled)
      .map(([, s]) => `  ${s.label}：${s.value}`)
      .join('\n')
    const confirmTpl = getPrompt('dialogue.confirm', { summary })
    return (prefix ? prefix + '\n' : '') + confirmTpl
  }

  /** 字段约束描述（含格式/枚举），供 LLM 理解（排除 api 步骤的系统填充槽位） */
  _slotDesc(state) {
    const task = this.defs.get(state.taskCode)
    const system = new Set(task?.apiResultSlots || [])
    return (task?.slots || []).filter(s => !system.has(s.key)).map(s => {
      const step = (task.steps || []).find(st => st.type === 'collect' && st.slot_key === s.key)
      const extract = step?.extract || {}
      let extra = ''
      if (extract.method === 'regex' && extract.rule) extra = `，格式：${extract.rule}`
      if (extract.method === 'enum') {
        const opts = Array.isArray(extract.enum) ? extract.enum : String(extract.rule || '').split(',')
        extra = `，可选：${opts.join('/')}`
      }
      return `${s.key}: ${s.label}（${s.required !== false ? '必填' : '选填'}${extra}）`
    }).join('；')
  }

  _filledDesc(state) {
    const filled = Object.entries(state.slots).filter(([, s]) => s.filled)
    return filled.length ? filled.map(([k, s]) => `${k}=${s.value}`).join(', ') : '无'
  }

  /** 最近对话历史（最近 10 轮） */
  _history(state) {
    const h = state.history || []
    return h.slice(-10).map(m => `${m.role === 'user' ? '用户' : '客服'}: ${String(m.text).slice(0, 80)}`).join('\n') || '（无）'
  }

  _slotDefByKey(state, slotKey) {
    const task = this.defs.get(state.taskCode)
    const def = (task?.slots || []).find(s => s.key === slotKey)
    if (!def) return null
    const step = (task?.steps || []).find(st => st.type === 'collect' && st.slot_key === slotKey)
    return {
      ...def,
      extract: step?.extract || { method: 'text', rule: '' },
      validate: step?.validate || def.validate || {},
    }
  }

  /** 收集当前槽位值（接口请求组装用） */
  _slotValues(state) {
    const o = {}
    for (const [k, s] of Object.entries(state.slots || {})) o[k] = s.value
    return o
  }

  /**
   * 执行"待触发的中间 api 步骤"（确定性，不靠 LLM 信号）：
   * 前置 collect 步骤的槽位已填、且结果槽位尚未写入 → 执行，结果写入 resultSlot。
   * @returns {Promise<string[]>} 各步骤的回显话术
   */
  async _runPendingApiSteps(state) {
    const task = this.defs.get(state.taskCode)
    if (!task?.steps) return []
    const out = []
    state.apiSteps = state.apiSteps || {}
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i]
      if (step.type !== 'api') continue
      if (state.apiSteps[step.key]) continue // 已执行过（防止每轮重复调用）
      // 前置步骤若是 collect，其槽位填好才执行（如：填完电话 → 查订单）
      const prev = i > 0 ? task.steps[i - 1] : null
      const prereqFilled = !prev || prev.type !== 'collect' || !!(state.slots[prev.slot_key] && state.slots[prev.slot_key].filled)
      if (!prereqFilled) continue
      const r = await executeApiStep(step, this._slotValues(state))
      state.apiSteps[step.key] = true
      if (r.ok && step.resultSlot && state.slots[step.resultSlot]) {
        state.slots[step.resultSlot].value = r.result
        state.slots[step.resultSlot].filled = true
      }
      out.push(r.message)
    }
    return out
  }

  _isCancel(text) {
    const t = text.trim()
    return CANCEL_PATTERNS.some(p => t.includes(p))
  }
}

export default LLMDialogManager
