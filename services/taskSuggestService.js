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

/** 闲聊/无意义噪声过滤（避免"我的妈/啊啊啊"污染候选池） */
const NOISE_RE = /^(嗯|哦|啊|哈|呵|呃|哦哦|嗯嗯|好的|好|ok|okay|谢谢|感谢|再见|拜拜|88|哈哈|呵呵|呵呵呵|我的妈|天哪|啊啊|哇|咦|唉|哎|嗯嗯嗯|.。！!?？~\s]{1,})$|^(.)\1{2,}$|^[.。…！!?？~～\-—_]{2,}$|^\d+$|^[\u4e00-\u9fa5]{1,2}$/

/** 取消/拒绝类表达过滤（"我想取消/不装了/不用了"不是办理意图） */
const CANCEL_RE = /(取消|退订|退掉|撤销|不办|不弄|不用了|不需要了|算了|放弃|终止|停止|不要了|退了吧)/

/** 否定句过滤（"不装了/算了/不用了"不是办理意图） */
const NEGATION_RE = /(没|不|别|无需|不用|不是|不要|不想|没说|没要|没有|没必要)[^，。！？!?、]{0,4}(要|说|想|打算|预约|办理|申请|安排|换|装|修|拆|移|检测|保养|报修|上门)/

/** 赞美/情绪类表达过滤（"你真聪明/太棒了"与办理无关） */
const PRAISE_RE = /(你真|你好棒|太棒|厉害|聪明|牛逼|优秀|感谢你|辛苦了|有你是|多亏你|谢谢|不错|可以啊)/

/** 太短的表达无法可靠匹配（少于 4 字基本是语气词/碎片） */
const MIN_LEN = 4
/** 匹配阈值：语义相似度低于此值不算"像某个任务"（避免噪声入池） */
const SIM_THRESHOLD = 0.55
/** 触发词命中的最低分（触发词在但语义极低也要过此门槛，防止"电话xxx"误配） */
const KEYWORD_MIN_SCORE = 0.75

class TaskSuggestService {
  constructor() {
    /** 未匹配日志读取器（默认仓库实现；测试可注入 mock） */
    this.logRepo = chatLogRepo
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

    // 2) 过滤噪声 + 匹配任务
    const items = []
    for (const c of candidates) {
      const text = (c.text || '').trim()
      if (text.length < MIN_LEN) continue
      if (NOISE_RE.test(text)) continue
      if (NEGATION_RE.test(text)) continue
      if (CANCEL_RE.test(text)) continue
      if (PRAISE_RE.test(text)) continue

      const match = await this._matchTask(text, taskDefs, vectors)
      if (!match) continue // 匹配不到任何任务 → 不算候选（避免纯闲聊入池）

      items.push({
        text,
        count: c.count || 1,
        lastTime: c.lastTime || null,
        matchedTask: match.taskCode,
        matchedName: match.taskName,
        score: match.score,
        reason: match.reason, // 'vector' | 'keyword'
      })
      if (items.length >= limit) break
    }

    return { items, total: items.length }
  }

  /**
   * 单条表达 → 最像哪个任务
   * 双信号：意图例句向量相似度（主要） + 触发词命中（辅助）
   * @returns {Promise<{taskCode, taskName, score, reason}|null>}
   */
  async _matchTask(text, taskDefs, vectors) {
    let best = null

    for (const [code, def] of taskDefs) {
      if (def.status !== 1) continue

      // 信号 A：触发词命中（确定性，命中即高分）
      const triggers = def._triggerExpanded || def.trigger_keywords || []
      const kwHit = triggers.some(kw => typeof kw === 'string' && text.toLowerCase().includes(kw.toLowerCase()))

      // 信号 B：意图例句向量相似度（语义）
      let vecScore = 0
      const taskVectors = vectors.get(code)
      if (taskVectors && taskVectors.length > 0) {
        try {
          const qv = await this._encodeQuery(text)
          if (qv) {
            let maxSim = 0
            for (const v of taskVectors) {
              const sim = cosineSimilarity(qv, v)
              if (sim > maxSim) maxSim = sim
            }
            vecScore = maxSim
          }
        } catch { /* 编码失败跳过语义信号 */ }
      }

      // 综合：触发词命中 → 高置信；否则看语义
      let score = 0
      let reason = ''
      if (kwHit) {
        score = 0.85 + vecScore * 0.1 // 触发词为主，语义微调
        reason = 'keyword'
        if (score < KEYWORD_MIN_SCORE) { score = 0; reason = '' } // 触发词在但整体仍弱 → 不算
      } else if (vecScore >= SIM_THRESHOLD) {
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
