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
import traceService from '../traceService.js'

/** 否定句防护（避免"没坏/不用修"触发任务） */
const NEGATION_RE = /没(有)?(坏|问题|故障|事|毛病)|不(是|用|要|想)(报修|维修|修)|没(有)?必要/

class TaskNLU {
  constructor() {
    /** @type {'rule'|'hybrid'|'llm'} */
    this.mode = 'hybrid'
    this.nlpEngine = null
    this.vectorThreshold = 0.45
    /**
     * 任务/FAQ 统一语义仲裁阈值（运营可配，管理后台写入 sys_config）
     *   gap       差距阈值：任务与 FAQ 相似度差 > gap 才判显著胜出，否则澄清
     *   taskMin   任务侧最低线：低于此值不算"像任务"
     *   faqMin    FAQ 侧最低线：低于此值不算"像 FAQ"
     *   strongHit 强命中线：两侧都低于此值判"域外"（无真实业务信号，不澄清直接业务引导）
     */
    this.arbConfig = { gap: 0.08, taskMin: 0.45, faqMin: 0.55, strongHit: 0.72 }
    /** @type {Map<string, Array>} code -> 意图例句向量 */
    this._vectors = new Map()
    /**
     * FAQ 侧例句向量源（与任务同一模型编码，可公平对比相似度）
     * 由 faq-engine 注入 recognizer.allSamples（[{intentCode,intentName,vector}]）
     * 用于"任务 vs FAQ"统一语义仲裁
     */
    this.faqSamples = []
  }

  /** 设置仲裁阈值（运营配置，sys_config 读取后调用） */
  setArbConfig(cfg = {}) {
    const num = (v, d) => {
      const n = parseFloat(v)
      return isNaN(n) ? d : n
    }
    this.arbConfig = {
      gap: num(cfg.gap, this.arbConfig.gap ?? 0.08),
      taskMin: num(cfg.taskMin, this.arbConfig.taskMin ?? 0.45),
      faqMin: num(cfg.faqMin, this.arbConfig.faqMin ?? 0.55),
      strongHit: num(cfg.strongHit, this.arbConfig.strongHit ?? 0.72),
    }
    console.log(`[TaskNLU] 仲裁阈值: gap=${this.arbConfig.gap} taskMin=${this.arbConfig.taskMin} faqMin=${this.arbConfig.faqMin} strongHit=${this.arbConfig.strongHit}`)
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

  /** 注入 FAQ 例句向量源（recognizer.allSamples），用于统一语义仲裁 */
  setFaqSamples(samples) {
    this.faqSamples = Array.isArray(samples) ? samples : []
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
   * @param {Array|null} trace - 轨迹步骤数组（调试用，可选）
   * @returns {Promise<Object|null>}
   */
  async matchTask(text, tasks, currentCode = null, trace = null) {
    if (!text) return null
    const lowerText = text.trim().toLowerCase()
    const _t = (step, detail = {}, level = 'info') => {
      if (trace) traceService.traceStep(trace, '触发·' + step, detail, level)
    }

    // 1) 关键词 + 近义扩展（确定性，所有模式都先走）
    //    否定表达不触发（"我没说要换表啊"含"换表"但明确否定）
    const byRule = this._matchByRules(lowerText, tasks, currentCode)
    _t('触发词规则', { hit: byRule ? byRule.code : null, negated: this._isNegation(lowerText) })
    if (byRule && !this._isNegation(lowerText)) return byRule
    if (this.mode === 'rule') return null

    // 2) LLM 判定（llm 模式优先；hybrid 在规则未命中后尝试）
    if (llmClient.enabled && text.trim().length >= 3) {
      try {
        const candidates = tasks.filter(t => t.status === 1 && t.code !== currentCode)
        const code = await llmClient.judgeTrigger(text, candidates)
        _t('LLM 判定（judgeTrigger）', { result: code || 'null' }, code ? 'llm' : 'llm')
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
    if (this.nlpEngine && text.trim().length >= 5 && !NEGATION_RE.test(text) && !this._isNegation(lowerText)) {
      const hit = await this._matchByVector(text, tasks, currentCode)
      _t('意图例句向量', { hit: hit ? hit.code : null }, hit ? 'rule' : 'info')
      if (hit) return hit
    } else {
      _t('跳过向量语义', { reason: !this.nlpEngine ? '无模型' : (text.trim().length < 5 ? '太短' : '否定句') })
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

  // ========== 统一语义仲裁（任务 vs FAQ） ==========

  /**
   * 用同一模型对输入打分，比较"最像哪个任务"与"最像哪个 FAQ 意图"，
   * 谁显著高就选谁；两者接近则无法确定（返回 'clarify' 让用户选）。
   *
   * 这是"查一下用气量"类误判的根治：
   *   任务侧 meter_replace sim=0.471，FAQ 侧 gas_usage_detail sim=1.0
   *   → FAQ 显著高 → 走 FAQ，不再被任务抢
   *
   * @param {string} text - 用户输入
   * @param {Object} ctx - { tasks, taskBoost? }
   *   taskBoost: 触发词命中时给任务侧的基础分（运营配置的强信号，但允许 FAQ 高置信反超）
   * @returns {Promise<{channel:'task_new'|'faq'|'clarify', taskScore, faqScore, taskCode?, taskName?, faqCode?, faqName?, diff}>}
   */
  async arbitrateTaskFaq(text, ctx = {}) {
    const empty = { channel: 'clarify', taskScore: 0, faqScore: 0, diff: 0 }
    if (!this.nlpEngine) return empty
    const tasks = ctx.tasks || []

    // 编码一次，两套向量共用
    let qv
    try {
      qv = await this.nlpEngine.encodeQuery(text)
    } catch {
      return empty
    }

    // 任务侧最高相似度 + 全部任务分数（调试用）
    let taskScore = 0
    let taskCode = null
    let taskName = ''
    const taskScores = [] // [{code, name, score}] 按分排序
    for (const [code, samples] of this._vectors) {
      const def = tasks.find(t => t.code === code)
      if (!def || def.status !== 1) continue
      let bestSim = 0
      for (const v of samples) {
        const sim = cosineSimilarity(qv, v)
        if (sim > bestSim) bestSim = sim
      }
      taskScores.push({ code, name: def.name, score: bestSim })
      if (bestSim > taskScore) {
        taskScore = bestSim
        taskCode = code
        taskName = def.name
      }
    }
    taskScores.sort((a, b) => b.score - a.score)

    // 触发词命中兜底：仅当仲裁任务侧未锁定任务（向量分过低/短句）时生效。
    // 若仲裁已算出语义更贴的任务（如"更换"命中换表任务，但语义"换滤芯"更贴预约任务），
    // 以语义任务为准——触发词只是候选信号，不覆盖语义判定。
    if (ctx.taskBoost && ctx.taskBoost.taskCode && !taskCode) {
      const boostDef = tasks.find(t => t.code === ctx.taskBoost.taskCode)
      if (boostDef && boostDef.status === 1) {
        taskScore = ctx.taskBoost.score
        taskCode = ctx.taskBoost.taskCode
        taskName = boostDef.name
      }
    }

    // FAQ 侧最高相似度 + 全部 FAQ 分数（调试用）
    let faqScore = 0
    let faqCode = null
    let faqName = ''
    const faqScores = [] // [{code, name, score}] 按分排序
    for (const s of this.faqSamples) {
      if (!s.vector) continue
      const sim = cosineSimilarity(qv, s.vector)
      faqScores.push({ code: s.intentCode, name: s.intentName, score: sim })
      if (sim > faqScore) {
        faqScore = sim
        faqCode = s.intentCode
        faqName = s.intentName
      }
    }
    faqScores.sort((a, b) => b.score - a.score)

    const diff = taskScore - faqScore

    // 阈值三级优先级：任务级配置（任务定义里的 arb_*）> 全局配置（sys_config）> 代码默认
    let { gap, taskMin, faqMin } = this.arbConfig
    if (taskCode) {
      const def = tasks.find(t => t.code === taskCode)
      if (def) {
        if (def.arb_gap !== null && def.arb_gap !== undefined) gap = def.arb_gap
        if (def.arb_task_min !== null && def.arb_task_min !== undefined) taskMin = def.arb_task_min
        if (def.arb_faq_min !== null && def.arb_faq_min !== undefined) faqMin = def.arb_faq_min
      }
    }

    // 强命中线（运营可配）：至少一侧达到此值才算"真实业务命中"。
    // 两侧都只是弱匹配（0.5~0.7 的碰巧接近，如"我家门坏了"任务0.64/FAQ0.61）
    // → 不构成澄清理由，判域外（由上层走 fallback 业务引导）
    // 注意：empty 场景（taskScore=0 且 faqScore=0，无引擎/双低）不在此列——上层走 matchTask 补判
    const strongHit = this.arbConfig.strongHit ?? 0.72
    const scores = { taskTop: taskScores.slice(0, 5), faqTop: faqScores.slice(0, 5) }
    if ((taskScore > 0 || faqScore > 0) && taskScore < strongHit && faqScore < strongHit) {
      console.log(`[TaskNLU] 仲裁：任务=${taskScore.toFixed(3)} FAQ=${faqScore.toFixed(3)}，均未达强命中线(${strongHit}) → 域外`)
      return { channel: 'out_of_scope', taskScore, faqScore, taskCode, taskName, faqCode, faqName, diff, scores }
    }

    // 两者都太低（都未达各自语义线）→ 无法判定
    if (taskScore < taskMin && faqScore < faqMin) {
      console.log(`[TaskNLU] 仲裁：任务=${taskScore.toFixed(3)} FAQ=${faqScore.toFixed(3)}，均未达线 → clarify`)
      return { ...empty, scores }
    }

    // 差距阈值（运营可配）：任务或 FAQ 显著高时直接选（参照 FAQ 竞争澄清的 0.06）
    if (diff > gap) {
      console.log(`[TaskNLU] 仲裁：任务 ${taskCode}(${taskScore.toFixed(3)}) > FAQ ${faqCode}(${faqScore.toFixed(3)}) → task_new`)
      return { channel: 'task_new', taskScore, faqScore, taskCode, taskName, faqCode, faqName, diff, scores }
    }
    if (-diff > gap) {
      console.log(`[TaskNLU] 仲裁：FAQ ${faqCode}(${faqScore.toFixed(3)}) > 任务 ${taskCode}(${taskScore.toFixed(3)}) → faq`)
      return { channel: 'faq', taskScore, faqScore, taskCode, taskName, faqCode, faqName, diff, scores }
    }

    console.log(`[TaskNLU] 仲裁：任务=${taskScore.toFixed(3)} FAQ=${faqScore.toFixed(3)} 接近(Δ=${diff.toFixed(3)}) → clarify`)
    return { channel: 'clarify', taskScore, faqScore, taskCode, taskName, faqCode, faqName, diff, scores }
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
    // 轨迹埋点：faq-engine 传入当前轮 steps，route 内部逐步记录判断过程
    const trace = ctx.trace
    const _t = (step, detail = {}, level = 'info') => {
      if (trace) traceService.traceStep(trace, '路由·' + step, detail, level)
    }

    // ===== 规则快检 =====
    // 1) 当前任务中的确定性表达：确认/否认/取消 → 继续任务
    if (ctx.taskState) {
      const state = ctx.taskState
      _t('有任务上下文', { taskCode: state.taskCode, status: state.status })
      if (state.status === 'confirming') {
        const confirmR = dialogueRules.isConfirm(t)
        const denyR = dialogueRules.isDeny(t)
        const isConfirm = typeof confirmR === 'object' ? confirmR.matched : confirmR
        const isDeny = typeof denyR === 'object' ? denyR.matched : denyR
        _t('确认态词快检', { isConfirm, isDeny })
        if (isConfirm || isDeny) return 'task_continue'
      }
      if (this._isCancel(lower)) {
        _t('取消词快检', { matched: true })
        return 'task_continue'
      }
      // 话术直接点名槽位标签（"电话是X" "地址改X"）→ 继续任务
      const slotLabels = Object.values(state.slots || {}).map(s => s.label || s.key).filter(Boolean)
      const labelHit = slotLabels.find(l => l && l.length >= 2 && t.includes(l))
      _t('槽位标签快检', { matched: labelHit || null })
      if (labelHit) return 'task_continue'
    } else {
      _t('无任务上下文')
    }

    // 2) 新任务意图判定：规则快检（含否定防护）+ 任务/FAQ 统一语义仲裁（同步对比）
    let byRuleHit = false
    let matchedTask = null
    let taskBoost = null // 触发词命中时给任务侧的基础分（强信号，但允许 FAQ 反超）
    if (ctx.tasks && ctx.tasks.length > 0) {
      // 2.1 规则快检（触发词/近义扩展），否定表达不触发（"我没说要换表啊"）
      const byRule = this._matchByRules(lower, ctx.tasks, ctx.taskState?.taskCode || null)
      const negated = this._isNegation(lower)
      _t('触发词规则快检', { byRule: byRule ? byRule.code : null, negated })
      if (byRule && !negated) {
        byRuleHit = true
        matchedTask = byRule
        // 触发词命中 → 任务侧强信号（0.92，运营配置的高置信表达），但仍与 FAQ 同步对比。
        // 注意：taskBoost 指向规则命中的任务；若仲裁算出语义更贴的其他任务（如"更换"命中
        // 换表但语义是"换滤芯"→预约），仲裁的任务侧最高分会覆盖（见 arbitrateTaskFaq）
        taskBoost = { taskCode: byRule.code, score: 0.92 }
      }

      // 2.2 任务/FAQ 统一语义仲裁（同步对比，谁高选谁，接近则澄清）
      //    触发词命中时通过 taskBoost 抬升任务侧，但不免检
      if (this.mode !== 'rule') {
        const arb = await this.arbitrateTaskFaq(t, { ...ctx, taskBoost })
        // 相似度明细（调试：每个任务/FAQ 的分数）
        const taskTop = (arb.scores?.taskTop || []).map(s => `${s.name}(${s.score.toFixed(2)})`).join(' ')
        const faqTop = (arb.scores?.faqTop || []).map(s => `${s.name}(${s.score.toFixed(2)})`).join(' ')
        _t('任务/FAQ 统一仲裁（同步）', {
          taskScore: arb.taskScore ? arb.taskScore.toFixed(3) : null,
          faqScore: arb.faqScore ? arb.faqScore.toFixed(3) : null,
          taskHit: arb.taskCode || null,
          faqHit: arb.faqCode ? arb.faqCode + '(' + (arb.faqName || '') + ')' : null,
          channel: arb.channel,
          boosted: !!taskBoost,
          taskTop,
          faqTop,
        }, arb.channel === 'clarify' || arb.channel === 'out_of_scope' ? 'warn' : 'task')
        if (arb.channel === 'faq') return 'faq'
        if (arb.channel === 'task_new') return 'task_new'
        // 域外：两侧都未达强命中线（"我家门坏了"0.6级碰巧接近）→ 不澄清，直接业务引导
        // 但触发词命中时（taskBoost 生效）即使分数弱也是确定性业务信号（"请个师父上门来看看"），
        // 不判域外——由下方细分逻辑处理（可能 task_new/faq/clarify）
        if (arb.channel === 'out_of_scope' && !taskBoost) return 'out_of_scope'
        // 仲裁判 clarify 且有一侧达线（接近）→ 追问用户；双低（都未达线）→ 继续
        if (arb.taskScore > 0 || arb.faqScore > 0) return 'clarify'

        // 仲裁双低（任务/FAQ 语义都拿不准）→ 走完整 matchTask（LLM judgeTrigger 补强）
        if (!matchedTask) {
          _t('仲裁双低，走完整 matchTask（LLM 判定补强）')
          try {
            const hit = await this.matchTask(t, ctx.tasks, ctx.taskState?.taskCode || null, trace)
            _t('matchTask 结果', { hit: hit ? hit.code : null })
            if (hit) {
              // 向量双低时 LLM judgeTrigger 判定为任务 → 采信
              matchedTask = hit
              return 'task_new'
            }
          } catch (e) {
            _t('matchTask 异常', { message: e.message }, 'error')
            console.error('[TaskNLU] 路由 matchTask 判定失败:', e.message)
          }
        }
      }
    } else {
      _t('无候选任务')
    }

    // ===== LLM 兜底（规则拿不准：任务中插话 / 触发词+咨询疑云 / 无任务咨询疑云） =====
    if (llmClient.enabled) {
      _t('走 LLM 三选一兜底（router 提示词）')
      try {
        const decision = await llmClient.routeTurn({
          taskName: ctx.taskState?.taskName || '',
          taskContext: ctx.filledDesc || '',
          text: t,
        })
        _t('LLM 路由判定', { decision: decision || 'null(拿不准)' }, decision ? 'llm' : 'warn')
        if (decision === 'faq') return 'faq'
        if (decision === 'new_task') return 'task_new'
        if (decision === 'continue') {
          // LLM 认为在继续任务：无任务上下文则不合理 → 追问
          return ctx.taskState ? 'task_continue' : 'clarify'
        }
        // LLM 返回 null（拿不准）→ 追问用户
        return 'clarify'
      } catch (e) {
        _t('LLM 路由判定异常', { message: e.message }, 'error')
        console.error('[TaskNLU] LLM 路由判定失败:', e.message)
      }
    }

    // ===== 降级（LLM 不可用/失败） =====
    // 触发词命中但仲裁未执行（rule 模式无向量）→ 追问用户二选一
    if (byRuleHit && this.mode === 'rule') {
      _t('降级：触发词命中但无仲裁能力 → 澄清', { byRuleHit }, 'warn')
      return 'clarify'
    }
    // 有任务上下文且规则拿不准 → 保守继续任务（不丢进度）
    const fallback = ctx.taskState ? 'task_continue' : 'faq'
    _t('降级默认', { fallback })
    return fallback
  }

  /**
   * 否定句防护：明确否定的表达不触发任务（"我没说要换表啊"、"不用换滤芯"）
   * 匹配模式：否定词 + 业务意图动词（换/装/修/预约/办理…）
   * @param {string} lowerText - 小写文本
   */
  _isNegation(lowerText) {
    if (!lowerText) return false
    // 否定词 + 0~4 个任意字符 + 业务意图词
    const neg = /(没|不|别|无需|不用|不是|不要|不想|没说|没要|没有|没必要)[^，。！？!?、]{0,4}(要|说|想|打算|预约|办理|申请|安排|换|装|修|拆|移|检测|保养|报修|上门)/
    return neg.test(lowerText)
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
