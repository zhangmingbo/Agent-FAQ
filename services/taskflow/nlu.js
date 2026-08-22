/**
 * 任务引擎理解层（NLU）—— 可插拔门面
 *
 * 职责：
 *   1) 意图判定（matchTask）：用户输入 → 触发哪个任务
 *      分层：关键词+近义扩展（确定性）→ 向量语义（意图例句）→ LLM 判定
 *   2) 槽位提取：规则提取（快/免费）→ LLM 批量补漏（理解任意口语）
 *
 * 三种模式（配置 nlu_mode，sys_config / 环境变量）：
 *   rule   纯规则（离线，零成本）
 *   hybrid 规则优先 + LLM 补漏（默认）
 *   llm    LLM 优先理解，规则校验兜底
 *
 * 关键设计：每个任务在 DSL 中声明 intent_examples（意图例句），
 * 向量与 LLM 都以例句为语义资产——新增业务 = 写例句，不维护规则。
 */

import extractor from './extractor.js'
import { validateSlot } from './validator.js'
import llmClient from './llm.js'
import { cosineSimilarity } from '../../src/similarity.js'
import { get as getPrompt } from '../llmPrompts.js'
import dialogueRules from '../../rules/dialogueRules.js'

/** 否定句防护（避免"没坏/不用修"触发任务） */
const NEGATION_RE = /没(有)?(坏|问题|故障|事|毛病)|不(是|用|要|想)(报修|维修|修)|没(有)?必要/

class TaskNLU {
  constructor() {
    /** @type {'rule'|'hybrid'|'llm'} */
    this.mode = 'hybrid'
    this.nlpEngine = null
    this.vectorThreshold = 0.45
    /** @type {Map<string, Array>} code -> 意图例句向量 */
    this._vectors = new Map()
  }

  /** 设置模式 */
  setMode(mode) {
    if (['rule', 'hybrid', 'llm'].includes(mode)) {
      this.mode = mode
      console.log(`[TaskNLU] 理解模式: ${mode}`)
      return true
    }
    return false
  }

  /** 注入共享 NLP 引擎（复用 FAQ 模型） */
  setNlpEngine(engine) {
    this.nlpEngine = engine
  }

  /** 任务定义变更后重建意图例句向量 */
  async refreshVectors(tasks) {
    if (!this.nlpEngine) return
    this._vectors.clear()
    for (const [code, task] of tasks) {
      const sources = task._vectorSources || []
      if (sources.length === 0) continue
      try {
        const vecs = await this.nlpEngine.encodeTexts(sources)
        this._vectors.set(code, vecs)
      } catch (e) {
        console.error(`[TaskNLU] 例句编码失败 ${code}:`, e.message)
      }
    }
    console.log(`[TaskNLU] 意图例句向量就绪: ${this._vectors.size} 个任务`)
  }

  // ========== 意图判定（触发） ==========

  /**
   * 判断用户输入触发哪个任务
   * @param {string} text
   * @param {Array} tasks - 全部任务定义
   * @param {string|null} currentCode - 当前进行中的任务（排除自身重复触发）
   * @returns {Promise<Object|null>}
   */
  async matchTask(text, tasks, currentCode = null) {
    if (!text) return null
    const lowerText = text.trim().toLowerCase()

    // 1) 关键词 + 近义扩展（确定性，所有模式都先走）
    const byRule = this._matchByRules(lowerText, tasks, currentCode)
    if (byRule) return byRule
    if (this.mode === 'rule') return null

    // 2) LLM 判定（llm 模式优先；hybrid 在规则未命中后尝试）
    if (llmClient.enabled && text.trim().length >= 3) {
      try {
        const candidates = tasks.filter(t => t.status === 1 && t.code !== currentCode)
        const code = await llmClient.judgeTrigger(text, candidates)
        if (code) {
          const hit = tasks.find(t => t.code === code)
          if (hit) {
            console.log(`[TaskNLU] LLM触发: ${code}`)
            return hit
          }
        }
      } catch (e) {
        console.error('[TaskNLU] LLM 触发判定失败:', e.message)
      }
    }

    // 3) 向量语义（意图例句；仅较长句子，否定句不触发）
    if (this.nlpEngine && text.trim().length >= 5 && !NEGATION_RE.test(text)) {
      const hit = await this._matchByVector(text, tasks, currentCode)
      if (hit) return hit
    }

    return null
  }

  /** 关键词 + 近义扩展匹配 */
  _matchByRules(lowerText, tasks, currentCode) {
    for (const task of tasks) {
      if (task.status !== 1 || task.code === currentCode) continue
      const triggers = task._triggerExpanded || task.trigger_keywords || []
      for (const kw of triggers) {
        if (typeof kw === 'string') {
          if (lowerText.includes(kw.toLowerCase())) return task
        } else if (kw.regex) {
          try {
            const regex = new RegExp(kw.regex, 'i')
            if (regex.test(lowerText)) return task
          } catch { /* ignore */ }
        }
      }
    }
    return null
  }

  /** 向量语义匹配（基于意图例句） */
  async _matchByVector(text, tasks, currentCode) {
    if (this._vectors.size === 0) return null
    let qv
    try {
      qv = await this.nlpEngine.encodeQuery(text)
    } catch (e) {
      return null
    }
    let best = null
    for (const [code, samples] of this._vectors) {
      if (code === currentCode) continue
      const task = tasks.find(t => t.code === code)
      if (!task || task.status !== 1) continue
      for (const vec of samples) {
        const sim = cosineSimilarity(qv, vec)
        if (!best || sim > best.sim) best = { code, sim }
      }
    }
    if (best && best.sim >= this.vectorThreshold) {
      console.log(`[TaskNLU] 语义触发: ${best.code} (sim=${best.sim.toFixed(3)})`)
      return tasks.find(t => t.code === best.code) || null
    }
    return null
  }

  // ========== 槽位提取 ==========

  /**
   * 提取单个槽位值
   * llm 模式：文本槽位 LLM 优先（规则对自然语言只会整句抓取，LLM 才能理解任意口语）
   * hybrid/rule：规则优先，hybrid 下 LLM 兜底
   * @param {string} text
   * @param {Object} slotDef - 槽位定义（含 extract/validate）
   * @param {Object} ctx - { taskCode, state }
   * @param {Object} opts - { labelOnly }
   * @returns {Promise<{value:string|null, source:'rule'|'llm'|null}>}
   */
  async extractSlotValue(text, slotDef, ctx = {}, opts = {}) {
    const method = slotDef.extract?.method || 'text'
    const llmFirst = this.mode === 'llm' && llmClient.enabled && !opts.labelOnly && method === 'text'
    let value = null
    let source = null

    // LLM 优先（llm 模式）：理解任意口语，如"我姓张"→"张"
    if (llmFirst) {
      try {
        value = await llmClient.extractSlot(text, slotDef, ctx)
        source = value !== null ? 'llm' : null
      } catch (e) {
        console.error('[TaskNLU] LLM 单槽提取失败:', e.message)
      }
    }

    // 规则提取（显式标签优先，如"地址是X"）
    if (value === null) {
      value = await extractor.extract(text, slotDef, ctx, { labelOnly: !!opts.labelOnly })
      source = value !== null ? 'rule' : null
    }

    // LLM 兜底（hybrid 模式：规则未提取到时）
    if (value === null && !llmFirst && this.mode !== 'rule' && llmClient.enabled && !opts.labelOnly) {
      try {
        value = await llmClient.extractSlot(text, slotDef, ctx)
        source = value !== null ? 'llm' : null
      } catch (e) {
        console.error('[TaskNLU] LLM 单槽提取失败:', e.message)
      }
    }
    return { value, source }
  }

  /**
   * LLM 批量提取所有未填槽位（规则未覆盖时的补漏）
   * @returns {Promise<Object|null>} { key: value }
   */
  async extractSlotsBatch(text, task, slotsSpec, state) {
    if (this.mode === 'rule' || !llmClient.enabled) return null
    try {
      return await llmClient.extractSlots(text, task, slotsSpec, state)
    } catch (e) {
      console.error('[TaskNLU] LLM 批量提取失败:', e.message)
      return null
    }
  }

  /** 校验槽位值（规则层，任何模式下都执行） */
  validate(slotDef, value) {
    return validateSlot(slotDef, value)
  }

  // ========== LLM 驱动对话（agentic dialogue） ==========

  /**
   * 单轮对话决策：LLM 看到「任务目标 + 字段约束 + 已收集 + 对话历史 + 最新输入」，
   * 输出 { slots, reply, ask_confirm, question }。系统侧负责校验/确认门禁/执行。
   * @param {Object} opts - { task, slotDesc, filledDesc, history, text }
   * @returns {Promise<{slots:Object, reply:string, ask_confirm:boolean, question:string|null}>}
   */
  async dialogue({ task, slotDesc, filledDesc, history, text }) {
    if (!llmClient.enabled) throw new Error('LLM 未配置，无法执行 LLM 对话')
    const system = getPrompt('dialogue.system', {
      brand: '沁园',
      taskName: task.name,
      slotDesc,
    })
    const user = getPrompt('dialogue.user', {
      taskName: task.name,
      slotDesc,
      filledDesc,
      history,
      text,
    })
    return llmClient.dialogueTurn(system, user)
  }

  // ========== 意图路由（任务通道 vs FAQ 通道） ==========

  /**
   * 判定用户输入该走哪条通道（双向穿透的核心）
   *
   * 返回：
   *   'task_continue'  继续当前任务（答槽位/确认/取消/纠正）
   *   'task_new'       发起新任务（用户想办另一件事）
   *   'faq'            知识咨询（费用/故障/操作，应交给 FAQ 回答）
   *   'clarify'        拿不准，需要追问用户二选一（任务 or 咨询）
   *
   * 混合策略（运营可配）：
   *   1. 规则快检（确定性、零成本）：
   *      - 确认态下的确认/否认、任意状态的取消 → task_continue
   *      - 话术直接点名当前槽位标签 → task_continue
   *      - 明确触发其他任务（触发词命中且无咨询疑云）→ task_new
   *   2. LLM 兜底：仅当规则拿不准时调用（router 提示词，管理后台可编辑）
   *      - LLM 明确 faq / new_task → 按判定走
   *      - LLM 也拿不准（返回 null / continue 但无任务上下文）→ clarify
   *   3. 降级：LLM 失败或不可用
   *      - 触发词+咨询疑云（无法区分任务还是咨询）→ clarify（把选择权交给用户）
   *      - 有任务上下文且规则无法判定 → task_continue（保守不丢进度）
   *
   * @param {string} text - 用户输入
   * @param {Object} ctx - { taskState, tasks, filledDesc }
   * @returns {Promise<string>}
   */
  async route(text, ctx = {}) {
    const t = (text || '').trim()
    if (!t) return 'faq'
    const lower = t.toLowerCase()

    // ===== 规则快检 =====
    // 1) 当前任务中的确定性表达：确认/否认/取消 → 继续任务
    if (ctx.taskState) {
      const state = ctx.taskState
      if (state.status === 'confirming') {
        const confirmR = dialogueRules.isConfirm(t)
        const denyR = dialogueRules.isDeny(t)
        const isConfirm = typeof confirmR === 'object' ? confirmR.matched : confirmR
        const isDeny = typeof denyR === 'object' ? denyR.matched : denyR
        if (isConfirm || isDeny) return 'task_continue'
      }
      if (this._isCancel(lower)) return 'task_continue'
      // 话术直接点名槽位标签（"电话是X" "地址改X"）→ 继续任务
      const slotLabels = Object.values(state.slots || {}).map(s => s.label || s.key).filter(Boolean)
      if (slotLabels.some(l => l && l.length >= 2 && t.includes(l))) return 'task_continue'
    }

    // 2) 触发词命中 → 可能新任务，也可能只是咨询（费用/怎么/为什么…）
    let byRuleHit = false
    let consultHint = false
    if (ctx.tasks && ctx.tasks.length > 0) {
      const byRule = this._matchByRules(lower, ctx.tasks, ctx.taskState?.taskCode || null)
      if (byRule) {
        byRuleHit = true
        // 触发词命中但话术像咨询（费用/价格/怎么/为什么…）→ 不武断
        consultHint = /(多少钱|收费|价格|怎么|如何|正常吗|原因|为什么|能不能|能否|吗)[，,。？?]?$|(多少钱|收费|价格|怎么|如何|为什么)[，,。？?]/.test(t)
        // 无咨询疑云 → 明确新任务
        if (!consultHint) return 'task_new'
      }
    }

    // ===== LLM 兜底（规则拿不准：任务中插话 / 触发词+咨询疑云 / 无任务咨询疑云） =====
    if (llmClient.enabled) {
      try {
        const decision = await llmClient.routeTurn({
          taskName: ctx.taskState?.taskName || '',
          taskContext: ctx.filledDesc || '',
          text: t,
        })
        if (decision === 'faq') return 'faq'
        if (decision === 'new_task') return 'task_new'
        if (decision === 'continue') {
          // LLM 认为在继续任务：无任务上下文则不合理 → 追问
          return ctx.taskState ? 'task_continue' : 'clarify'
        }
        // LLM 返回 null（拿不准）→ 追问用户
        return 'clarify'
      } catch (e) {
        console.error('[TaskNLU] LLM 路由判定失败:', e.message)
      }
    }

    // ===== 降级（LLM 不可用/失败） =====
    // 触发词+咨询疑云，规则无法区分任务还是咨询 → 追问用户二选一
    if (byRuleHit && consultHint) return 'clarify'
    // 有任务上下文且规则拿不准 → 保守继续任务（不丢进度）
    return ctx.taskState ? 'task_continue' : 'faq'
  }

  /** 取消词快检（规则确定性，任何模式生效） */
  _isCancel(lowerText) {
    return ['取消', '算了', '不办了', '不需要了', '退出', '停止', '不弄了', '放弃', '不用了']
      .some(k => lowerText.includes(k))
  }

  /**
   * LLM 提取值是否符合槽位约束（枚举/正则），防止 LLM 乱填/回显整句
   */
  valueMatchesSlot(slotDef, value) {
    if (!slotDef || value === null || value === undefined || value === '') return false
    const v = String(value)
    const method = slotDef.extract?.method
    if (method === 'enum') {
      const options = Array.isArray(slotDef.extract.enum)
        ? slotDef.extract.enum
        : String(slotDef.extract.rule || '').split(',').map(s => s.trim())
      return options.includes(v)
    }
    if (method === 'regex' && slotDef.extract?.rule) {
      try {
        const rule = slotDef.extract.rule.replace(/\\\\/g, '\\')
        return new RegExp(rule, 'i').test(v)
      } catch { return true }
    }
    return true
  }
}

export default new TaskNLU()
