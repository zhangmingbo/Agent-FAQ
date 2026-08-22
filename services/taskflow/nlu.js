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
   * 提取单个槽位值（规则 → LLM 单槽兜底）
   * @param {string} text
   * @param {Object} slotDef - 槽位定义（含 extract/validate）
   * @param {Object} ctx - { taskCode, state }
   * @param {Object} opts - { labelOnly }
   * @returns {Promise<{value:string|null, source:'rule'|'llm'|null}>}
   */
  async extractSlotValue(text, slotDef, ctx = {}, opts = {}) {
    let value = await extractor.extract(text, slotDef, ctx, { labelOnly: !!opts.labelOnly })
    let source = value !== null ? 'rule' : null

    if (value === null && this.mode !== 'rule' && llmClient.enabled && !opts.labelOnly) {
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
}

export default new TaskNLU()
