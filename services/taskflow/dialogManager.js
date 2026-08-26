/**
 * 对话策略管理器（DST + Policy）
 *
 * 根据任务状态与用户输入，推进步骤流程：
 *   collect（提取→校验→填槽→下一步，支持一轮多槽）
 *   message（直接回复）
 *   branch（按槽位值分支跳转）
 *   confirm（收集完毕后确认：确认/否认/纠正）
 *   action（执行动作 → 完成或失败重试）
 *   subtask（压栈启动子任务，子任务完成后 on_return 返回）
 *
 * 返回信封（供引擎层使用）：
 *   { reply, isComplete, extracted, cancelled, reask, taskState }
 *   - extracted=true  本轮有进展（填槽/确认/执行/纠正…），引擎直接使用 reply
 *   - reask=true      本轮校验失败需要重问，引擎直接使用 reply（不 FAQ 回退）
 *   - 两者皆 false    本轮无进展，引擎回退 FAQ 匹配
 */

import extractor from './extractor.js'
import { runAction } from './actionRegistry.js'
import { executeApiStep } from './apiStep.js'
import { TaskState } from './stateMachine.js'
import dialogueRules from '../../rules/dialogueRules.js'
import { getReply } from '../replyTexts.js'
import traceService from '../traceService.js'
import { evaluateCondition, describeCondition } from './condition.js'
import { runFlow } from './flow.js'

const CANCEL_PATTERNS = ['取消', '算了', '不办了', '不需要了', '退出', '停止', '不弄了', '放弃']
const CORRECT_PATTERNS = ['修改', '改成', '换成', '改为', '变更', '改一下']

class DialogManager {
  /**
   * @param {import('./taskDefs.js').default} defs - 任务定义加载器
   * @param {import('./nlu.js').default} nlu - 理解层（意图判定/槽位提取，可插拔模式）
   */
  constructor(defs, nlu) {
    this.defs = defs
    this.nlu = nlu
  }

  /**
   * 处理一轮任务对话
   * @param {Object} state - 任务状态（含 stack）
   * @param {string} text - 用户输入
   * @param {Array|null} trace - 轨迹步骤数组（调试用，可选）
   * @returns {Promise<Object>} 信封
   */
  async processTurn(state, text, trace = null) {
    const _t = (step, detail = {}, level = 'info') => traceService.traceStep(trace, step, detail, level)
    state.turnCount = (state.turnCount || 0) + 1
    state.lastActive = Date.now()

    // 1) 取消意图
    if (this._isCancel(text)) {
      _t('任务对话·取消意图', { text }, 'rule')
      return this._cancel(state, trace)
    }

    // 2) 修改等待状态：上一轮用户要求"修改XX"，本轮的输入即新值
    if (state.pendingModify) {
      return this._applyPendingModify(state, text, trace)
    }

    // 3) 槽位纠正（"地址改成XX"带值，直接更新）
    const correction = this._detectCorrection(text, state)
    if (correction) {
      state.slots[correction.key] = {
        ...state.slots[correction.key],
        value: correction.value,
        filled: true,
      }
      state.skipCount = 0
      console.log(`[TaskFlow] 槽位纠正: ${correction.key} = "${correction.value}"`)
      _t('任务对话·槽位纠正', { slot: correction.key, value: correction.value }, 'rule')

      const prefix = `好的，${state.slots[correction.key].label}已更新为「${correction.value}」。\n`

      // 确认态 → 重新展示确认清单
      if (state.status === TaskState.CONFIRMING) {
        return this._renderConfirm(state, prefix)
      }

      // 收集态 → 移到下一个未填槽位提问（纠正文本不再当作新槽位值）
      const nextUnfilled = Object.entries(state.slots).find(([_, s]) => s.required && !s.filled)
      if (!nextUnfilled) {
        state.status = TaskState.CONFIRMING
        return this._renderConfirm(state, prefix)
      }
      const step = this._findStepBySlot(state, nextUnfilled[0])
      state.currentStep = step?.key
      const prompt = step ? this._slotDef(state, step)?.prompt || step.prompt : getReply('slot_prompt_fallback', { label: nextUnfilled[1].label })
      return {
        reply: prefix + (prompt || ''),
        isComplete: false,
        extracted: true,
        reask: false,
        cancelled: false,
        taskState: state,
      }
    }

    // 4) "修改XX"不带新值 → 进入修改等待（避免被当作槽位值吞掉）
    const modifyReq = this._detectModifyRequest(text, state)
    if (modifyReq) {
      state.pendingModify = modifyReq
      state.skipCount = 0
      console.log(`[TaskFlow] 修改请求: ${modifyReq}`)
      _t('任务对话·修改请求', { slot: modifyReq }, 'rule')
      return {
        reply: getReply('modify_prompt', { label: state.slots[modifyReq]?.label || modifyReq }),
        isComplete: false,
        extracted: true,
        reask: false,
        cancelled: false,
        taskState: state,
      }
    }

    // 5) 按当前状态推进
    if (state.status === TaskState.CONFIRMING) {
      return this._handleConfirmTurn(state, text, trace)
    }
    return this._advanceCollect(state, text, '', trace)
  }

  // ========== 收集阶段 ==========

  async _advanceCollect(state, text, prefix, trace = null) {
    const _t = (step, detail = {}, level = 'info') => traceService.traceStep(trace, step, detail, level)
    let reply = prefix
    let extracted = false
    let alreadyExtracted = false
    let textUsed = false
    let anchorStep = null
    let anchorPrompt = ''
    let probing = false
    let stepsWalked = 0

    while (stepsWalked < 10) {
      const step = this._currentStep(state)
      if (!step) {
        // 流程结束（无下一步）
        return this._finish(state, reply || '已完成。', trace)
      }

      switch (step.type) {
        case 'message': {
          reply += step.text || ''
          state.currentStep = step.next
          extracted = true
          alreadyExtracted = true
          break
        }
        case 'branch': {
          const next = await this._evalBranch(step, state)
          _t('任务对话·分支判定', {
            step: step.key,
            cases: (step.cases || []).map((c) => this.describeCase(c)),
            to: next || '结束',
          }, 'rule')
          state.currentStep = next
          extracted = true
          alreadyExtracted = true
          break
        }
        case 'confirm': {
          // 仍有必填槽位未填（如一轮多槽提取不完整）→ 回到第一个未填槽位提问
          const unfilled = this._firstUnfilledRequired(state)
          if (unfilled) {
            const s = this._findStepBySlot(state, unfilled[0])
            state.currentStep = s?.key
            const p = s ? (this._slotDef(state, s)?.prompt || s.prompt) : getReply('slot_prompt_fallback', { label: unfilled[1].label })
            return this._withQuestion(text, state, {
              reply: (reply || '') + p,
              isComplete: false,
              extracted: alreadyExtracted || extracted,
              reask: false,
              cancelled: false,
              taskState: state,
            })
          }
          // 全部必填已填 → 进入确认态
          state.status = TaskState.CONFIRMING
          state.confirmAsked = true
          _t('任务对话·完整性检查', { allFilled: true, unfilled: '(全齐)', status: '进入确认态' }, 'rule')
          return this._renderConfirm(state, reply)
        }
        case 'action': {
          const result = await this._execAction(state, step, reply, trace)
          if (result) return result // 完成或失败重试（返回信封）
          return this._finish(state, reply, trace)
        }
        case 'api': {
          // 中间/收尾"调用接口"步骤：按步骤机走到即执行，结果写入结果槽位
          const slots = {}
          for (const [k, s] of Object.entries(state.slots || {})) slots[k] = s.value
          const r = await executeApiStep(step, slots, trace, state.vars)
          if (r.ok) {
            // 多字段结果逐槽写入（resultMap 全部 / 旧式单字段含 resultSlot）
            for (const [slotKey, val] of Object.entries(r.results || {})) {
              if (state.slots[slotKey]) {
                state.slots[slotKey].value = val
                state.slots[slotKey].filled = true
              }
            }
            // 出参变量 → 任务上下文（供后续步骤/判断/话术引用）
            state.vars = { ...(state.vars || {}), ...(r.vars || {}) }
          }
          if (r.message) reply += (reply ? '\n' : '') + r.message
          state.currentStep = step.next
          extracted = true
          alreadyExtracted = true
          break
        }
        case 'subtask': {
          return this._startSubtask(state, step, reply, trace)
        }
        case 'collect':
        default: {
          // 有效提取方式（步骤未显式配置时按默认 text 处理，保证防重填守卫生效）
          const stepDef = this._slotDef(state, step)
          const effMethod = stepDef?.extract?.method || 'text'
          const canText = !(textUsed && effMethod === 'text')
          const outcome = await this._tryFillSlot(state, step, text, canText, probing, trace)
          if (outcome.extracted) {
            reply += outcome.note || ''
            extracted = true
            alreadyExtracted = true
            // 本轮已填入任意槽位后，后续文本槽位只认显式标签（避免同一段话重复填入）
            textUsed = true
            state.currentStep = step.next
            state.skipCount = 0
          } else if (outcome.reask) {
            return {
              reply: (reply || '') + outcome.reask,
              isComplete: false,
              extracted: extracted || false,
              reask: true,
              cancelled: false,
              taskState: state,
            }
          } else {
            // 未提取：记住第一个未填锚点，继续探测后续步骤（支持"地址是X，电话是Y"一轮多槽）
            if (!anchorStep) {
              anchorStep = step.key
              anchorPrompt = this._buildPrompt(state, step)
            }
            const nextUnfilled = this._nextUnfilledCollectStep(state, state.currentStep)
            if (nextUnfilled) {
              probing = true
              state.currentStep = nextUnfilled
              state.skipCount = (state.skipCount || 0) + 1
              break // 继续循环探测
            }
            // 探测完毕：回到锚点提问
            state.currentStep = anchorStep
            state.skipCount = (state.skipCount || 0) + 1
            return this._withQuestion(text, state, {
              reply: (reply || '') + (anchorPrompt || ''),
              isComplete: false,
              extracted: alreadyExtracted,
              reask: false,
              cancelled: false,
              taskState: state,
            })
          }
        }
      }
      stepsWalked++
    }
    // 防御：步骤循环过深
    return {
      reply: reply || getReply('slot_continue_hint'),
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  /** 尝试从用户输入填充当前槽位 */
  async _tryFillSlot(state, step, text, canText, probing = false, trace = null) {
    const _t = (step, detail = {}, level = 'info') => traceService.traceStep(trace, step, detail, level)
    const slotDef = this._slotDef(state, step)
    if (!slotDef) {
      return { extracted: false, reask: '步骤配置错误：槽位不存在。' }
    }

    // 槽位已填（分支跳回等场景）→ 直接推进
    if (state.slots[slotDef.key]?.filled) {
      return { extracted: true, note: '' }
    }

    // 纯文本提取在两种情况下受限：首轮（避免触发句误填）、本轮已用过文本提取
    // 受限时仍允许显式标签提取（"地址是X"）
    const method = slotDef.extract?.method || 'text'
    const isFirstTurn = state.turnCount <= 1
    const textBlocked = method === 'text' && (isFirstTurn || !canText)

    // 控制词（确认/提交等）不作为槽位值：还有必填未填时提示缺什么
    if (/^(确认|提交|是的|就是)$/.test(text.trim())) {
      const missing = Object.entries(state.slots).filter(([_, s]) => s.required && !s.filled)
      if (missing.length > 0) {
        return { extracted: false, reask: getReply('slot_missing_hint', { labels: missing.map(([_, s]) => s.label).join('、') }) }
      }
    }

    const task = this.defs.get(state.taskCode)
    const { value } = await this.nlu.extractSlotValue(
      text, slotDef,
      { taskCode: state.taskCode, task, state },
      { labelOnly: textBlocked }
    )

    // LLM 提取的值必须满足槽位约束（枚举/正则），防止 LLM 乱填/回显整句
    let finalValue = (value !== null && this.nlu.valueMatchesSlot(slotDef, value)) ? value : null

    // 规则/单槽未提取到 → LLM 批量兜底（一次性抽取所有未填槽位；探测阶段不重复调用）
    // 首轮且输入未提到任何槽位关键词时跳过（避免把触发句"我要报修燃气表"瞎填成槽位值）
    if (finalValue === null && !probing && this.nlu.mode !== 'rule') {
      const canBatch = state.turnCount > 1 || this._textMentionsSlots(text, state)
      if (canBatch) {
        const all = await this._llmExtractAll(state, text)
        if (all && Object.keys(all).length > 0) {
          let llmFilledAny = false
          for (const [k, v] of Object.entries(all)) {
            const s = state.slots[k]
            if (!s || s.filled || !v) continue
            const sDef = this._slotDefByKey(state, k)
            // LLM 值必须满足槽位约束
            if (!sDef || !this.nlu.valueMatchesSlot(sDef, v)) continue
            const check = this.nlu.validate(sDef, v)
            if (check.ok) {
              s.value = String(v)
              s.filled = true
              llmFilledAny = true
              console.log(`[TaskNLU] LLM提取槽位 ${k} = "${v}"`)
            }
          }
          if (llmFilledAny) {
            const filled = state.slots[slotDef.key]
            if (filled?.filled) {
              return { extracted: true, note: '' }
            }
            return { extracted: false, reask: '' }
          }
        }
      }
    }

    if (finalValue === null) {
      // 结构化槽位（regex/number/enum）：输入非空且不像闲聊 → 视为格式错误，直接重问
      // 探测模式下不重问（避免"地址X，电话Y"场景下地址被问成电话）
      if (!probing && method !== 'text' && text.trim().length > 0 && !extractor.isQuestion(text)) {
        return { extracted: false, reask: slotDef.validate?.reask || getReply('slot_reask_invalid', { label: slotDef.label || '' }) }
      }
      return { extracted: false, reask: '' }
    }

    const check = this.nlu.validate(slotDef, finalValue)
    if (!check.ok) {
      return { extracted: false, reask: check.message }
    }

    state.slots[slotDef.key] = {
      ...state.slots[slotDef.key],
      value: finalValue,
      filled: true,
      label: slotDef.label || slotDef.key,
      required: slotDef.required !== false,
    }
    console.log(`[TaskFlow] 已填槽位 ${slotDef.key} = "${finalValue}"`)
    _t('任务对话·填入槽位', { slot: slotDef.key, value: finalValue }, 'rule')
    return { extracted: true, note: getReply('slot_recorded', { label: slotDef.label || slotDef.key }) }
  }

  // ========== 智能辅助 ==========

  /**
   * 边答边问：提取槽位后若剩余文本含疑问 → 标记 question，交给引擎 FAQ 回答
   */
  _withQuestion(text, state, envelope) {
    const q = this._detectQuestion(text, state)
    if (q) {
      envelope.question = true
      envelope.questionText = q
    }
    return envelope
  }

  /** 检测剩余文本中的疑问（去掉已填槽位的标签片段后） */
  _detectQuestion(text, state) {
    const remainder = this._stripFilledFragments(text, state)
    if (remainder.length < 2) return ''
    const q = remainder.trim()
    if (q.includes('？') || q.includes('?') || /(怎么|如何|怎样|什么|哪里|哪儿|多少|几个|为什么|能不能|可以吗|是否|有没有|多久|几时|请问|怎么办|好不好|行不行|是不是|呢|吗)/.test(q)) {
      return q
    }
    return ''
  }

  /** 去掉已填槽位的"标签+值"片段（如"地址是幸福小区3栋502，") */
  _stripFilledFragments(text, state) {
    let t = text
    for (const [key, slot] of Object.entries(state.slots)) {
      if (!slot.filled) continue
      const names = [slot.label, ...(slot.aliases || [])].filter(Boolean)
      for (const name of names) {
        if (!name) continue
        try {
          t = t.replace(new RegExp(`${name}[是为]?[:：\\s]*[^，。；;！？!?]*`, 'g'), '')
        } catch { /* ignore */ }
      }
    }
    return t.replace(/^[，,、\s]+|[，,、\s]+$/g, '')
  }

  /** 下一个未填槽位的 collect 步骤（用于一轮多槽探测） */
  _nextUnfilledCollectStep(state, fromKey) {
    const task = this.defs.get(state.taskCode)
    const steps = (task?.steps || []).filter(s => s.type === 'collect')
    const startIdx = steps.findIndex(s => s.key === fromKey)
    for (let i = startIdx + 1; i < steps.length; i++) {
      const s = steps[i]
      if (!state.slots[s.slot_key]?.filled) return s.key
    }
    return null
  }

  /** 第一个未填的必填槽位（排除 api 步骤的系统填充槽位） */
  _firstUnfilledRequired(state) {
    const task = this.defs.get(state.taskCode)
    const system = new Set(task?.apiResultSlots || [])
    return Object.entries(state.slots).find(([_, s]) => s.required && !s.filled && !system.has(s.key)) || null
  }

  /** 按槽位 key 查找其步骤定义（含 extract/validate） */
  _slotDefByKey(state, slotKey) {
    const task = this.defs.get(state.taskCode)
    const step = (task?.steps || []).find(s => s.type === 'collect' && s.slot_key === slotKey)
    if (!step) return null
    return this._slotDef(state, step)
  }

  /** LLM 一次性抽取所有未填槽位（委托理解层） */
  async _llmExtractAll(state, text) {
    const task = this.defs.get(state.taskCode)
    if (!task) return null
    const unfilled = Object.entries(state.slots).filter(([_, s]) => !s.filled)
    if (unfilled.length === 0) return null
    const slotsSpec = {}
    for (const [key, s] of unfilled) {
      const sDef = this._slotDefByKey(state, key)
      slotsSpec[key] = {
        label: s.label,
        type: sDef?.extract?.method || 'text',
        rule: sDef?.extract?.rule || '',
        required: s.required,
      }
    }
    return this.nlu.extractSlotsBatch(text, task, slotsSpec, state)
  }

  /** 构建当前步骤的提问话术（含进度提示） */
  _buildPrompt(state, step) {
    if (state.skipCount >= 2) {
      state.skipCount = 0
      return this._buildSmartGuidance(state)
    }
    const slotDef = this._slotDef(state, step)
    return slotDef?.prompt || step.prompt || getReply('slot_prompt_fallback', { label: slotDef?.label || step.slot_key })
  }

  /** 连续无法提取时的智能引导 */
  _buildSmartGuidance(state) {
    const filled = Object.entries(state.slots).filter(([_, s]) => s.filled)
    const unfilled = Object.entries(state.slots).filter(([_, s]) => s.required && !s.filled)
    let msg = getReply('guidance_header')
    for (const [key, slot] of unfilled) {
      msg += getReply('guidance_item', { label: slot.label })
    }
    if (filled.length > 0) {
      msg += getReply('guidance_filled_hint')
    }
    return msg
  }

  // ========== 确认阶段 ==========

  _handleConfirmTurn(state, text, trace = null) {
    const _t = (step, detail = {}, level = 'info') => traceService.traceStep(trace, step, detail, level)
    const confirmR = dialogueRules.isConfirm(text)
    const denyR = dialogueRules.isDeny(text)

    const isConfirm = typeof confirmR === 'object' ? confirmR.matched : confirmR
    const isDeny = typeof denyR === 'object' ? denyR.matched : denyR
    _t('任务对话·确认判定', { isConfirm, isDeny }, isConfirm || isDeny ? 'rule' : 'info')

    // 同时命中时按分数裁决（如"不是"→deny 分数更高），平局优先 deny
    if (isConfirm && isDeny) {
      const cs = typeof confirmR === 'object' ? (confirmR.score || 0) : 1
      const ds = typeof denyR === 'object' ? (denyR.score || 0) : 1
      if (ds >= cs) {
        return this._denyConfirm(state, trace)
      }
      return this._acceptConfirm(state, text, trace)
    }
    if (isConfirm) return this._acceptConfirm(state, text, trace)
    if (isDeny) return this._denyConfirm(state, trace)

    // 用户在确认态重新提供某个槽位值（"电话换成XX""地址是XX"）
    const slotMatch = this._findSlotByText(state, text)
    if (slotMatch) {
      state.slots[slotMatch.key].value = slotMatch.value.trim()
      state.slots[slotMatch.key].filled = true
      _t('任务对话·确认态改槽位', { slot: slotMatch.key, value: slotMatch.value.trim() }, 'rule')
      return this._renderConfirm(state, getReply('slot_updated', { label: slotMatch.label, value: slotMatch.value.trim() }))
    }

    // 无进展 → FAQ 回退
    _t('任务对话·确认态无进展，转 FAQ 回退', {}, 'warn')
    return this._renderConfirm(state, '', true)
  }

  _acceptConfirm(state, text, trace = null) {
    traceService.traceStep(trace, '任务对话·确认接受，执行动作', {}, 'rule')
    state.confirmAsked = false
    state.status = TaskState.COLLECTING
    const step = this._currentStep(state)
    state.currentStep = step?.next
    return this._advanceCollect(state, text, getReply('submitting'), trace)
  }

  _denyConfirm(state, trace = null) {
    traceService.traceStep(trace, '任务对话·否认确认，回到收集态', {}, 'rule')
    state.confirmAsked = false
    state.status = TaskState.COLLECTING
    const firstUnfilled = Object.entries(state.slots).find(([_, s]) => s.required && !s.filled)
    const step = firstUnfilled ? this._findStepBySlot(state, firstUnfilled[0]) : null
    state.currentStep = step?.key
    const reply = getReply('modify_reask') + this._buildSmartGuidance(state)
    return { reply, isComplete: false, extracted: true, reask: false, cancelled: false, taskState: state }
  }

  _renderConfirm(state, prefix, asFallback = false) {
    const summary = this._buildSummary(state)
    const prompt = getReply('confirm_prompt')
    return {
      reply: (prefix || '') + summary + '\n' + prompt,
      isComplete: false,
      extracted: !asFallback,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  _buildSummary(state) {
    const lines = [getReply('confirm_summary_header')]
    for (const [key, slot] of Object.entries(state.slots)) {
      if (slot.filled) lines.push(getReply('confirm_summary_item', { label: slot.label, value: slot.value }))
    }
    return lines.join('\n')
  }

  // ========== 动作执行 ==========

  async _execAction(state, step, replyPrefix = '', trace = null) {
    const _t = (step, detail = {}, level = 'info') => traceService.traceStep(trace, step, detail, level)
    state.status = TaskState.EXECUTING
    const slots = {}
    for (const [key, s] of Object.entries(state.slots)) slots[key] = s.value

    const task = this.defs.get(state.taskCode)
    const ctx = {
      sessionId: state.sessionId,
      task,
      state,
      step,
      slots,
      params: step.params || {},
    }

    let result
    let events = []
    // 任务级动作编排优先（v3 P3）
    if (task?.on_complete && typeof task.on_complete === 'object' && Array.isArray(task.on_complete.steps)) {
      result = await runFlow(task.on_complete, { sessionId: state.sessionId, task, state, slots }, trace)
      _t('任务对话·执行编排', { ok: result.ok, error: result.error || undefined, idempotent: !!result.idempotent }, result.ok ? 'task' : 'error')
      if (!result.ok) {
        // 编排失败兜底：附加转人工事件（前端展示人工入口）
        events = [this._transferEvent(state)]
        state.status = TaskState.COLLECTING
        return {
          reply: getReply('action_fail_rule', { message: result.message || result.error }),
          isComplete: false,
          extracted: true,
          reask: false,
          cancelled: false,
          taskState: state,
          events,
        }
      }
    } else {
      result = await runAction(step.action, { ...ctx, trace })
      events = result.events || []
    }

    if (result.ok) {
      // 转人工（v3 P4）：标记已转人工，任务结束
      if (step.action === 'transfer_human') {
        state.status = TaskState.TRANSFERRED
        const msg = (replyPrefix ? replyPrefix + (result.message ? '\n' : '') : '') + (result.message || '')
        _t('任务对话·转人工', { taskCode: state.taskCode }, 'task')
        return {
          reply: msg,
          isComplete: true,
          extracted: true,
          reask: false,
          cancelled: false,
          taskState: state,
          events,
        }
      }
      state.currentStep = step.next
      const message = (replyPrefix ? replyPrefix + (result.message ? '\n' : '') : '') + (result.message || '')
      _t('任务对话·执行动作', { action: step.action, ok: true, message: (result.message || '').slice(0, 60) }, 'task')
      // 子任务完成 → 返回父任务
      if (state.stack && state.stack.length > 0) {
        const env = this._popSubtask(state, message, trace)
        env.events = env.events || events
        return env
      }
      return this._finish(state, message, trace, events)
    }

    // 动作失败
    _t('任务对话·执行动作', { action: step.action, ok: false, message: (result.message || '').slice(0, 60) }, 'error')
    const onFail = step.on_fail || 'reask'
    if (onFail === 'retry') {
      return this._execAction(state, step, replyPrefix, trace)
    }
    // 失败兜底：附加转人工事件（前端展示人工入口）
    if (!events.some(e => e.type === 'transfer_human')) events.push(this._transferEvent(state))
    state.status = TaskState.COLLECTING
    return {
      reply: getReply('action_fail_rule', { message: result.message }),
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
      events,
    }
  }

  /** 构造转人工事件（失败兜底时复用，前端展示人工入口） */
  _transferEvent(state) {
    const slots = {}
    for (const [k, s] of Object.entries(state.slots || {})) {
      slots[k] = (s && s.value !== undefined && s.value !== null) ? s.value : null
    }
    return {
      type: 'transfer_human',
      sessionId: state.sessionId,
      taskCode: state.taskCode,
      taskName: state.taskName,
      slots,
    }
  }

  // ========== 子任务 ==========

  _startSubtask(state, step, replyPrefix, trace = null) {
    const childDef = this.defs.get(step.task)
    if (!childDef) {
      state.currentStep = step.next
      return this._advanceCollect(state, '', replyPrefix + `子任务「${step.task}」不存在。\n`, trace)
    }
    // 压栈当前任务
    state.stack = state.stack || []
    state.stack.push({
      taskCode: state.taskCode,
      taskName: state.taskName,
      currentStep: step.next,
      slots: state.slots,
      turnCount: state.turnCount,
      onReturn: step.on_return,
    })
    // 切换为子任务
    state.taskCode = childDef.code
    state.taskName = childDef.name
    state.currentStep = childDef.steps[0]?.key
    state.status = TaskState.COLLECTING
    state.slots = this.initSlots(childDef)
    state.turnCount = 1
    state.skipCount = 0
    console.log(`[TaskFlow] 进入子任务: ${childDef.code}`)
    traceService.traceStep(trace, '任务对话·进入子任务', { child: childDef.code, parent: state.stack[state.stack.length - 1]?.taskCode }, 'task')
    return {
      reply: replyPrefix + getReply('subtask_start', { name: childDef.name }) + (childDef.steps[0]?.prompt || getReply('subtask_first_prompt')),
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  _popSubtask(state, childDoneMsg, trace = null) {
    const parent = state.stack.pop()
    if (!parent) return null
    state.taskCode = parent.taskCode
    state.taskName = parent.taskName
    state.slots = parent.slots
    state.turnCount = parent.turnCount || 0
    state.skipCount = 0
    state.status = TaskState.COLLECTING
    state.currentStep = parent.onReturn || parent.currentStep
    console.log(`[TaskFlow] 子任务完成，返回父任务: ${state.taskCode}`)
    traceService.traceStep(trace, '任务对话·子任务完成返回父任务', { taskCode: state.taskCode }, 'task')

    // 返回后提示父任务下一个需要的信息
    const step = this._currentStep(state)
    const prompt = step?.type === 'collect'
      ? (this._slotDef(state, step)?.prompt || step.prompt || getReply('slot_continue_hint'))
      : getReply('slot_continue_short')
    return {
      reply: (childDoneMsg ? childDoneMsg + '\n' : '') + prompt,
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  // ========== 完成/取消 ==========

  _finish(state, message, trace = null, events = []) {
    state.status = TaskState.DONE
    traceService.traceStep(trace, '任务对话·完成任务', { taskCode: state.taskCode }, 'task')
    return {
      reply: message || `已为您完成${state.taskName}。`,
      isComplete: true,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
      events,
    }
  }

  _cancel(state, trace = null) {
    state.status = TaskState.CANCELLED
    traceService.traceStep(trace, '任务对话·取消任务', { taskCode: state.taskCode }, 'rule')
    return {
      reply: getReply('cancel_done'),
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: true,
      taskState: state,
    }
  }

  // ========== 工具 ==========

  _currentStep(state) {
    const task = this.defs.get(state.taskCode)
    if (!task) return null
    return task.steps.find(s => s.key === state.currentStep) || null
  }

  _slotDef(state, step) {
    const task = this.defs.get(state.taskCode)
    const def = (task?.slots || []).find(s => s.key === step.slot_key)
    if (!def) return null

    const extract = step.extract || {
      method: def.extract_type || 'text',
      rule: def.extract_rule || '',
    }

    // 提问话术：枚举槽位自动追加可选值，让用户知道怎么回答（话术已含选项则跳过）
    let prompt = step.prompt || def.prompt || getReply('slot_prompt_fallback', { label: def.label || step.slot_key })
    if (extract.method === 'enum') {
      const options = Array.isArray(extract.enum)
        ? extract.enum
        : String(extract.rule || '').split(',').map(s => s.trim()).filter(Boolean)
      const alreadyShown = options.some(opt => opt.length > 1 && prompt.includes(opt))
      if (options.length > 0 && !alreadyShown) {
        prompt += `（可选：${options.join('、')}）`
      }
    }

    return {
      ...def,
      extract,
      prompt,
      validate: step.validate || def.validate || {},
      _triggers: task.trigger_keywords || [],
    }
  }

  _findStepBySlot(state, slotKey) {
    const task = this.defs.get(state.taskCode)
    return (task?.steps || []).find(s => s.type === 'collect' && s.slot_key === slotKey) || null
  }

  /** 输入文本是否提到任意槽位关键词（槽位标签/别名） */
  _textMentionsSlots(text, state) {
    for (const slot of Object.values(state.slots)) {
      const names = this._slotNames(slot)
      for (const name of names) {
        if (name && name.length >= 2 && text.includes(name)) return true
      }
    }
    return false
  }

  /** 槽位名称（含别名 + 默认别名：自动去掉常见业务前缀） */
  _slotNames(slot) {
    const names = [slot.label, ...(slot.aliases || [])].filter(Boolean)
    // 默认别名：'安装地址'→'地址'、'联系电话'→'电话'、'客户姓名'→'姓名'
    if (slot.label && slot.label.length >= 3) {
      for (const prefix of ['安装', '收货', '客户', '联系', '配送', '上门']) {
        if (slot.label.startsWith(prefix) && slot.label.length > prefix.length + 1) {
          names.push(slot.label.slice(prefix.length))
          break
        }
      }
    }
    return names
  }

  /** 确认态：识别用户重新提供某个槽位值（按名称/别名匹配） */
  _findSlotByText(state, text) {
    for (const [key, slot] of Object.entries(state.slots)) {
      if (!slot.filled) continue
      const names = this._slotNames(slot)
      for (const name of names) {
        if (text.includes(name)) {
          // 提取名称之后的内容作为新值（"电话换成139..." → "139..."）
          const idx = text.indexOf(name) + name.length
          let value = text.substring(idx).replace(/^[是为]?[:：\s]*/, '').replace(/[。！!？?]$/, '').trim()
          // 若值以纠正词开头则去掉（"换成"）
          value = value.replace(/^(修改|改成|换成|改为|变更|改一下)/, '').trim()
          if (value.length >= 1) return { key, label: slot.label || key, value }
        }
      }
    }
    return null
  }

  /** 分支判断：统一条件求值（condition.js，支持操作符扩展/时间/函数/表达式/组合） */
  async _evalBranch(step, state) {
    const ctx = { slots: state.slots, vars: state.vars || {}, result: state.vars || {} }
    for (const c of (step.cases || [])) {
      if (await evaluateCondition(c.when, ctx)) return c.next
    }
    return step.default_next
  }

  /** 分支条件描述（trace 用） */
  describeCase(c) {
    return describeCondition((c && c.when) || null)
  }

  _isCancel(text) {
    const t = text.trim()
    return CANCEL_PATTERNS.some(p => t.includes(p))
  }

  _detectCorrection(text, state) {
    const filled = Object.entries(state.slots).filter(([_, s]) => s.filled)
    if (filled.length === 0) return null
    const t = text.trim()
    for (const [key, slot] of filled) {
      const names = this._slotNames(slot)
      for (const name of names) {
        for (const p of CORRECT_PATTERNS) {
          if (t.includes(p + name) || t.includes(name + p)) {
            const idx = t.indexOf(p)
            const afterP = t.substring(idx + p.length).trim()
            const value = afterP.replace(new RegExp(`^${name}[是为]?`), '').trim()
            if (value.length >= 1) return { key, value }
          }
        }
        // 模式3："地址不对，是XX" / "地址错了，是XX" / "地址有误，应该改XX"
        const denyMatch = t.match(new RegExp(`${name}(?:不对|错了|有误|写错|不是)[，,、\\s]*(?:应该|应当)?[是]?[:：\\s]*(.+)$`))
        if (denyMatch && denyMatch[1] && denyMatch[1].trim().length >= 1) {
          const value = denyMatch[1].trim().replace(/^[，,、\s]+/, '')
          if (value.length >= 1) return { key, value }
        }
      }
    }
    return null
  }

  /**
   * 检测"修改XX"请求（不带新值，如"修改联系电话"）
   * 与 _detectCorrection 的区别：这里要求槽位名后面没有内容
   * @returns {string|null} 槽位 key
   */
  _detectModifyRequest(text, state) {
    const t = text.trim()
    if (!t) return null
    const MODIFIERS = '修改|改成|换成|改为|变更|改一下|换一下|改下|改改|重填|重新填'
    for (const [key, slot] of Object.entries(state.slots)) {
      const names = [slot.label, ...(slot.aliases || [])].filter(Boolean)
      for (const name of names) {
        if (!name) continue
        try {
          // 模式1："修改联系电话" / "重新填一下地址"（修改词在前，名字后无内容）
          const m1 = t.match(new RegExp(`(?:${MODIFIERS})\\s*${name}\\s*[是为]?[:：\\s]*$`))
          if (m1) return key
          // 模式2："电话我想改一下"（名字在前，修改词在后）
          const m2 = t.match(new RegExp(`${name}\\s*(?:${MODIFIERS})\\s*[是为]?[:：\\s]*$`))
          if (m2) return key
          // 模式3："地址不对" / "电话错了"（名字 + 否定词，无新值 → 进入修改等待）
          const m3 = t.match(new RegExp(`^${name}(?:不对|错了|有误|写错|不是|填错)[，,、\\s]*$`))
          if (m3) return key
        } catch { /* ignore */ }
      }
    }
    return null
  }

  /**
   * 应用修改等待状态：本轮的输入即被修改槽位的新值
   */
  _applyPendingModify(state, text, trace = null) {
    const _t = (step, detail = {}, level = 'info') => traceService.traceStep(trace, step, detail, level)
    const key = state.pendingModify
    const slot = state.slots[key]
    state.pendingModify = null
    if (!slot) {
      return this._advanceCollect(state, '', '', trace)
    }
    if (this._isCancel(text)) return this._cancel(state, trace)

    let value = text.trim()
    // 清理修饰词/标签前缀："改成139..."、"电话是139..."
    const names = [slot.label, ...(slot.aliases || [])].filter(Boolean)
    for (const name of names) {
      value = value.replace(new RegExp(`^(?:修改|改成|换成|改为|变更|改一下|换一下|改下|改改|重填|重新填)\\s*${name}[是为]?[:：\\s]*`), '')
      value = value.replace(new RegExp(`^${name}[是为]?[:：\\s]*`), '')
    }
    value = value.replace(/^(?:修改|改成|换成|改为|变更|改一下|换一下|改下|改改|重填|重新填)\s*/, '').trim()

    if (!value) {
      state.pendingModify = key
      return {
        reply: getReply('direct_input', { label: slot.label || key }),
        isComplete: false,
        extracted: true,
        reask: true,
        cancelled: false,
        taskState: state,
      }
    }

    // 校验
    const slotDef = this._slotDefByKey(state, key)
    if (slotDef) {
      const check = this.nlu.validate(slotDef, value)
      if (!check.ok) {
        state.pendingModify = key
        return {
          reply: check.message,
          isComplete: false,
          extracted: true,
          reask: true,
          cancelled: false,
          taskState: state,
        }
      }
    }

    slot.value = value
    slot.filled = true
    console.log(`[TaskFlow] 修改完成 ${key} = "${value}"`)
    _t('任务对话·修改完成', { slot: key, value }, 'rule')
    const prefix = `好的，${slot.label}已更新为「${value}」。\n`

    // 确认态 → 重新展示确认清单
    if (state.status === TaskState.CONFIRMING) {
      return this._renderConfirm(state, prefix)
    }

    // 收集态 → 从该槽位步骤之后继续
    const step = this._findStepBySlot(state, key)
    state.currentStep = step?.next || state.currentStep
    return this._advanceCollect(state, '', prefix, trace)
  }

  /** 初始化槽位状态（新任务/子任务） */
  initSlots(taskDef) {
    const slots = {}
    for (const s of (taskDef.slots || [])) {
      slots[s.key] = {
        value: null,
        filled: false,
        label: s.label || s.key,
        aliases: s.aliases || [],
        required: s.required !== false,
        prompt: s.prompt || getReply('slot_prompt_fallback', { label: s.label || s.key }),
      }
    }
    return slots
  }
}

export default DialogManager
