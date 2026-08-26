/**
 * 表达挖掘服务（运营工具底层能力）
 *
 * 目标：帮运营把"真实用户说了但没触发任务"的表达，变成任务的意图例句/触发词。
 * 原则：机器只推荐，人做决定——本服务只产出候选+匹配建议，不写任何运营数据。
 *
 * 数据流：
 *   chat_log 中未触发任务的高频表达（source in direct/other/fallback/clarify）
 *   → 过滤噪声（闲聊/否定句/重复字符）
 *   → 与每个任务做语义匹配（意图例句向量相似度 + 触发词命中）
 *   → 输出候选列表：{ text, count, matchedTask, score, reason }
 *
 * 运营在管理后台「表达挖掘」面板采纳 → 追加到任务的 intent_examples（走现有 save 链路）
 */

import * as chatLogRepo from '../repositories/chatLogRepo.js'
import { cosineSimilarity } from '../src/similarity.js'
import * as configRepo from '../repositories/configRepo.js'
import pool from '../db/pool.js'

/** 闲聊/无意义噪声过滤（避免"我的妈/啊啊啊"污染候选池） */
const NOISE_RE = /^(嗯|哦|啊|哈|呵|呃|哦哦|嗯嗯|好的|好|ok|okay|谢谢|感谢|再见|拜拜|88|哈哈|呵呵|呵呵呵|我的妈|天哪|啊啊|哇|咦|唉|哎|嗯嗯嗯|.。！!?？~\s]{1,})$|^(.)\1{2,}$|^[.。…！!?？~～\-—_]{2,}$|^\d+$|^[\u4e00-\u9fa5]{1,2}$/

/** 取消/拒绝类表达过滤（"我想取消/不装了/不用了"不是办理意图） */
const CANCEL_RE = /(取消|退订|退掉|撤销|不办|不弄|不用了|不需要了|算了|放弃|终止|停止|不要了|退了吧)/

/** 否定句过滤（"不装了/算了/不用了"不是办理意图） */
const NEGATION_RE = /(没|不|别|无需|不用|不是|不要|不想|没说|没要|没有|没必要)[^，。！？!?、]{0,4}(要|说|想|打算|预约|办理|申请|安排|换|装|修|拆|移|检测|保养|报修|上门)/

/** 赞美/情绪类表达过滤（"你真聪明/太棒了"与办理无关） */
const PRAISE_RE = /(你真|你好棒|太棒|厉害|聪明|牛逼|优秀|感谢你|辛苦了|有你是|多亏你|谢谢|不错|可以啊)/

/** 太短/相似度/触发词门槛 → 实例字段 this.minLen / this.simThreshold / this.keywordMinScore（sys_config 可配） */

class TaskSuggestService {
  constructor() {
    /** 未匹配日志读取器（默认仓库实现；测试可注入 mock） */
    this.logRepo = chatLogRepo
    /** 建议挖掘参数（运营可配，sys_config → configure() 更新） */
    this.minLen = 4
    this.simThreshold = 0.55
    this.keywordMinScore = 0.75
    /** 运营手动删除（忽略）的候选话术，持久化在 sys_config.suggest_ignored */
    this.ignored = []
    /** 挖掘结果缓存：表达挖掘数据短期不变，重复打开/切页签应秒开（TTL 60s，忽略/采纳后失效） */
    this._cache = null
    this._cacheTtl = 60 * 1000
  }

  /** 使缓存失效（运营做了忽略/采纳等数据变更后调用） */
  invalidateCache() {
    this._cache = null
  }

  /** 启动/配置时加载已忽略话术列表（sys_config.suggest_ignored，JSON 数组） */
  async loadIgnored() {
    try {
      const raw = await configRepo.get('suggest_ignored')
      if (raw) {
        const list = JSON.parse(raw)
        if (Array.isArray(list)) this.ignored = list
      }
    } catch (e) {
      console.warn('[Suggest] 加载忽略列表失败:', e.message)
    }
    return this.ignored
  }

  /** 删除（忽略）一条候选话术：加入忽略列表并持久化 */
  async ignore(text) {
    const t = String(text || '').trim()
    if (!t) return false
    if (!this.ignored.includes(t)) this.ignored.push(t)
    await configRepo.set('suggest_ignored', JSON.stringify(this.ignored))
    this.invalidateCache()
    return true
  }

  /** 运行时更新挖掘参数（管理后台保存后调用） */
  configure({ minLen, simThreshold, keywordMinScore } = {}) {
    if (minLen !== undefined) this.minLen = parseInt(minLen, 10) > 0 ? parseInt(minLen, 10) : this.minLen
    if (simThreshold !== undefined) {
      const n = parseFloat(simThreshold)
      if (!isNaN(n)) this.simThreshold = n
    }
    if (keywordMinScore !== undefined) {
      const n = parseFloat(keywordMinScore)
      if (!isNaN(n)) this.keywordMinScore = n
    }
  }

  /**
   * 挖掘候选表达 + 任务匹配建议
   * @param {Object} opts - { limit, taskDefs: Map<code,def>, vectors, logRepo? }
   * @returns {Promise<{items: Array, total: number}>}
   */
  async suggest(opts = {}) {
    const limit = opts.limit || 50
    const taskDefs = opts.taskDefs || new Map()
    const vectors = opts.vectors || new Map() // code -> [vec]
    const logRepo = opts.logRepo || this.logRepo

    // 1) 未触发任务的高频表达（复用仓库层聚合）
    let candidates = []
    try {
      candidates = await logRepo.getUnmatchedForAnalysis()
    } catch (e) {
      console.error('[Suggest] 读取未匹配日志失败:', e.message)
    }

    // 2) 过滤噪声，收集候选池（已忽略的话术直接跳过）
    const pool = []
    for (const c of candidates) {
      const text = (c.text || '').trim()
      if (text.length < this.minLen) continue
      if (this.ignored.includes(text)) continue
      if (NOISE_RE.test(text)) continue
      if (NEGATION_RE.test(text)) continue
      if (CANCEL_RE.test(text)) continue
      if (PRAISE_RE.test(text)) continue
      pool.push({ text, count: c.count || 1, lastTime: c.lastTime || null })
      if (pool.length >= limit) break
    }

    // 3) 批量编码所有候选（一次模型调用，避免每条候选各推理一次——原实现
    //    每条 encodeQuery 一次 CPU 推理，50 条候选 ≈ 50 次模型调用，加载很慢）
    let qvs = null
    if (this.nlpEngine && pool.length > 0) {
      try {
        qvs = await this.nlpEngine.encodeTexts(pool.map(p => p.text))
      } catch (e) {
        console.error('[Suggest] 批量编码失败，降级逐条:', e.message)
      }
    }

    // 4) 逐条匹配任务
    const items = []
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]
      const qv = (qvs && qvs[i]) || null
      const match = await this._matchTask(c.text, taskDefs, vectors, qv)
      if (!match) continue // 匹配不到任何任务 → 不算候选（避免纯闲聊入池）

      items.push({
        text: c.text,
        count: c.count,
        lastTime: c.lastTime,
        matchedTask: match.taskCode,
        matchedName: match.taskName,
        score: match.score,
        reason: match.reason, // 'vector' | 'keyword'
      })
    }

    return { items, total: items.length }
  }

  /**
   * 后台预计算：完整跑一次挖掘（含模型推理），结果落库到 suggest_cache 表。
   * 定时任务 / 启动时 / 运营变更后调用——前端打开页面只读缓存，不触发推理。
   * @param {Object} opts - { taskDefs, vectors }（缺省时由调用方注入后传入）
   */
  async refreshCache(opts = {}) {
    const taskDefs = opts.taskDefs || new Map()
    const vectors = opts.vectors || new Map()
    const t0 = Date.now()
    let result
    try {
      result = await this.suggest({ limit: 50, taskDefs, vectors, noCache: true })
    } catch (e) {
      console.error('[Suggest] 后台预计算失败:', e.message)
      return null
    }
    const payload = { items: result.items, total: result.total, computedAt: new Date().toISOString(), durationMs: Date.now() - t0 }
    try {
      await pool.execute(
        `CREATE TABLE IF NOT EXISTS suggest_cache (
          id INT PRIMARY KEY,
          data_json LONGTEXT,
          computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_id (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      )
      await pool.execute(
        `INSERT INTO suggest_cache (id, data_json, computed_at)
         VALUES (1, ?, NOW())
         ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), computed_at = NOW()`,
        [JSON.stringify(payload)]
      )
      this._cache = { time: Date.now(), limit: 50, result }
      console.log(`[Suggest] 后台预计算完成: ${result.items.length} 条（耗时 ${Date.now() - t0}ms）`)
    } catch (e) {
      console.error('[Suggest] 预计算结果落库失败:', e.message)
    }
    return result
  }

  /** 读取后台预计算结果（接口用，零推理）；无缓存时返回 null */
  async getCached() {
    try {
      const [rows] = await pool.execute(
        'SELECT data_json, computed_at FROM suggest_cache WHERE id = 1'
      )
      if (!rows.length) return null
      const data = JSON.parse(rows[0].data_json)
      return {
        ...data,
        computedAtLabel: rows[0].computed_at ? String(rows[0].computed_at).replace('T', ' ').slice(0, 19) : '',
      }
    } catch (e) {
      console.error('[Suggest] 读取预计算缓存失败:', e.message)
      return null
    }
  }

  /**
   * 单条表达 → 最像哪个任务
   * 双信号：意图例句向量相似度（主要） + 触发词命中（辅助）
   * @param {number[]|null} precomputedQv - 外部已批量编码的查询向量（复用，避免重复推理）
   * @returns {Promise<{taskCode, taskName, score, reason}|null>}
   */
  async _matchTask(text, taskDefs, vectors, precomputedQv = null) {
    let best = null

    // 查询向量只编码一次，供所有任务复用（原实现放在任务循环内，
    // 一条文本被编码 N 次，50 条候选 × 多任务 = 数百次 CPU 模型推理，加载很慢）
    let qv = precomputedQv
    if (!qv) {
      try {
        qv = await this._encodeQuery(text)
      } catch { /* 编码失败跳过语义信号 */ }
    }

    for (const [code, def] of taskDefs) {
      if (def.status !== 1) continue

      // 信号 A：触发词命中（确定性，命中即高分）
      const triggers = def._triggerExpanded || def.trigger_keywords || []
      const kwHit = triggers.some(kw => typeof kw === 'string' && text.toLowerCase().includes(kw.toLowerCase()))

      // 信号 B：意图例句向量相似度（语义）
      let vecScore = 0
      const taskVectors = vectors.get(code)
      if (qv && taskVectors && taskVectors.length > 0) {
        let maxSim = 0
        for (const v of taskVectors) {
          const sim = cosineSimilarity(qv, v)
          if (sim > maxSim) maxSim = sim
        }
        vecScore = maxSim
      }

      // 综合：触发词命中 → 高置信；否则看语义
      let score = 0
      let reason = ''
      if (kwHit) {
        score = 0.85 + vecScore * 0.1 // 触发词为主，语义微调
        reason = 'keyword'
        if (score < this.keywordMinScore) { score = 0; reason = '' } // 触发词在但整体仍弱 → 不算
      } else if (vecScore >= this.simThreshold) {
        score = vecScore
        reason = 'vector'
      }

      if (score > 0 && (!best || score > best.score)) {
        best = { taskCode: code, taskName: def.name, score, reason }
      }
    }

    return best
  }

  /** 编码查询文本（复用共享 NLP 引擎） */
  async _encodeQuery(text) {
    if (!this.nlpEngine) return null
    try {
      return await this.nlpEngine.encodeQuery(text)
    } catch {
      return null
    }
  }

  /** 注入共享 NLP 引擎（与 taskEngine 同一实例） */
  setNlpEngine(engine) {
    this.nlpEngine = engine
  }
}

export default new TaskSuggestService()
