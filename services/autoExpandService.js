/**
 * 相似问自动扩写服务（第二批 C）
 *
 * 数据指向：chat_log 中高频 fallback（用户反复问但一直答不上）——如"电费收费标准"、
 * "你们和史密斯哪个好"等，与已有 FAQ 例句语义接近却未命中（例句覆盖不足）。
 *
 * 逻辑：对高频未匹配输入做向量比对（与全部 FAQ 例句），相似度 ≥ 阈值（sys_config 可配，
 * 默认 0.75 保守）的自动扩写为该 FAQ 的相似问（写 faq_question 表 + 增量重编码），
 * 同时写审计表 expand_audit（支持一键回滚）。低于阈值或匹配不到的不动。
 *
 * 三层分离：配置（sys_config.expand_sim_threshold / expand_enabled / expand_min_count）
 *          → 数据（expand_audit 独立表）→ 逻辑（本服务读配置、写审计，不写其他运营数据）
 */

import * as chatLogRepo from '../repositories/chatLogRepo.js'
import * as configRepo from '../repositories/configRepo.js'
import { cosineSimilarity } from '../src/similarity.js'

/** 噪声过滤（复用表达挖掘的过滤思路，避免闲聊/乱码入池） */
const NOISE_RE = /^(嗯|哦|啊|哈|呵|呃|哦哦|嗯嗯|好的|好|ok|okay|谢谢|感谢|再见|拜拜|88|哈哈|呵呵|我的妈|天哪|啊啊|哇|咦|唉|哎|。！!?？~\s]{1,})$|^(.)\1{2,}$|^[.。…！!?？~～\-—_]{2,}$|^\d+$|^[\u4e00-\u9fa5]{1,2}$/
const NEGATION_RE = /(没|不|别|无需|不用|不是|不要|不想|没说|没要|没有)[^，。！？!?、]{0,4}(要|说|想|打算|预约|办理|申请|安排|换|装|修|拆|移|检测|保养|报修|上门)/
const CANCEL_RE = /(取消|退订|退掉|撤销|不办|不弄|不用了|不需要了|算了|放弃|终止|停止|不要了|退了吧)/

/** 引导/占位类意图：相似度再高也不扩写（它们吸收所有低相似 top1，扩进去无意义） */
const SKIP_INTENTS = new Set(['selfI_Introduce', 'human_agent', 'other', 'greeting', 'goodbye', 'transfer'])

class AutoExpandService {
  constructor() {
    /** 相似度阈值：低于此值不扩写（运营可配，默认保守 0.75） */
    this.simThreshold = 0.75
    /** 最低出现次数：只处理出现 ≥ N 次的未匹配（默认 2） */
    this.minCount = 2
    /** 总开关（sys_config.expand_enabled，默认开） */
    this.enabled = true
    /** 单轮最多扩写条数（防止一次写太多） */
    this.maxPerRun = 20
    /** 短句防护长度线（与识别器 shortTextLen 一致，默认 4） */
    this.shortTextLen = 4
    /** 共享 NLP 引擎（注入：encodeQuery + 全量例句样本） */
    this.nlpEngine = null
    this.samples = [] // [{intentCode, intentName, questionText, vector}]
    /** 共享 FAQ 领域服务（注入实例，复用其 addQuestion/syncIntent/faqMap） */
    this.faqService = null
  }

  /** 运行时更新配置（管理后台保存后调用） */
  configure({ simThreshold, minCount, enabled, maxPerRun } = {}) {
    if (simThreshold !== undefined) {
      const n = parseFloat(simThreshold)
      if (!isNaN(n)) this.simThreshold = n
    }
    if (minCount !== undefined) {
      const n = parseInt(minCount, 10)
      if (n > 0) this.minCount = n
    }
    if (enabled !== undefined) this.enabled = !!enabled
    if (maxPerRun !== undefined) {
      const n = parseInt(maxPerRun, 10)
      if (n > 0) this.maxPerRun = n
    }
  }

  /** 注入共享 NLP 引擎与 FAQ 例句样本（启动时调用） */
  setNlpEngine(nlpEngine, samples) {
    this.nlpEngine = nlpEngine
    this.samples = Array.isArray(samples) ? samples : []
  }

  /** 注入共享 FAQ 领域服务实例（server.js 启动时调用） */
  setFaqService(faqService) {
    this.faqService = faqService
  }

  /**
   * 扫描高频未匹配并自动扩写
   * @param {Object} opts - { limit? }
   * @returns {Promise<{added: Array, skipped: Array, scanned: number}>}
   */
  async run(opts = {}) {
    const added = []
    const skipped = []
    if (!this.enabled) {
      return { added, skipped, scanned: 0, disabled: true }
    }
    if (!this.nlpEngine || !this.samples.length) {
      return { added, skipped, scanned: 0, noEngine: true }
    }

    // 1) 高频未匹配（fallback + clarify 未命中）
    let candidates = []
    try {
      candidates = await chatLogRepo.getUnmatchedForAnalysis()
    } catch (e) {
      console.error('[AutoExpand] 读取未匹配日志失败:', e.message)
    }
    const pool = candidates
      .filter(c => (c.count || 1) >= this.minCount)
      .filter(c => !NOISE_RE.test(c.text) && !NEGATION_RE.test(c.text) && !CANCEL_RE.test(c.text))
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, this.maxPerRun)

    // 2) 逐条向量匹配 + 扩写
    for (const c of pool) {
      const text = (c.text || '').trim()
      if (!text) continue

      const match = await this._matchFaq(text)
      if (!match) {
        skipped.push({ text, count: c.count, reason: '未匹配到高相似 FAQ' })
        continue
      }

      // 已存在该相似问 → 跳过
      const dup = await this._existsInFaq(match.intentCode, text)
      if (dup) {
        skipped.push({ text, count: c.count, reason: `已存在（${match.intentCode}）` })
        continue
      }

      // 写 FAQ 相似问 + 审计
      const ok = await this._apply(text, match)
      if (ok) {
        added.push({ text, count: c.count, faqCode: match.intentCode, faqName: match.intentName, similarity: match.similarity })
      } else {
        skipped.push({ text, count: c.count, reason: '写库失败' })
      }
    }

    return { added, skipped, scanned: pool.length }
  }

  /** 向量匹配最像的 FAQ（相似度 ≥ 阈值；引导/占位意图不扩写） */
  async _matchFaq(text) {
    // 短句防护：与识别器 shortTextLen 一致——短词（人名/地名如"习近平"）向量匹配不可靠，
    // 曾出现"习近平" sim=0.826 被误扩到"查询明细"，短句一律不扩写
    if (String(text || '').trim().length < (this.shortTextLen || 4)) return null
    let qv
    try {
      qv = await this.nlpEngine.encodeQuery(text)
    } catch (e) {
      return null
    }
    let best = null
    for (const s of this.samples) {
      if (!s.vector || SKIP_INTENTS.has(s.intentCode)) continue
      const sim = cosineSimilarity(qv, s.vector)
      if (!best || sim > best.similarity) {
        best = { intentCode: s.intentCode, intentName: s.intentName, similarity: sim, questionText: s.questionText }
      }
    }
    if (best && best.similarity >= this.simThreshold) {
      return best
    }
    return null
  }

  /** 该文本是否已是某 FAQ 的相似问 */
  async _existsInFaq(faqCode, text) {
    try {
      return await this.faqService.questionExists(faqCode, text)
    } catch (e) {
      return false
    }
  }

  /** 执行扩写：写 faq_question + 增量重编码 + 审计 */
  async _apply(text, match) {
    try {
      await this.faqService.addQuestion(match.intentCode, text)
      await this._audit(text, match)
      console.log(`[AutoExpand] 自动扩写: "${text}" → ${match.intentCode} (sim=${match.similarity.toFixed(3)})`)
      return true
    } catch (e) {
      console.error('[AutoExpand] 扩写失败:', e.message)
      return false
    }
  }

  /** 审计落库（可回滚） */
  async _audit(text, match) {
    try {
      const pool = (await import('../db/pool.js')).default
      await pool.execute(
        `CREATE TABLE IF NOT EXISTS expand_audit (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_text TEXT,
          faq_code VARCHAR(100),
          faq_name VARCHAR(200),
          similarity DECIMAL(6,4),
          status VARCHAR(20) DEFAULT 'applied',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      )
      await pool.execute(
        'INSERT INTO expand_audit (user_text, faq_code, faq_name, similarity) VALUES (?, ?, ?, ?)',
        [text, match.intentCode, match.intentName || match.intentCode, match.similarity]
      )
    } catch (e) {
      console.error('[AutoExpand] 审计落库失败:', e.message)
    }
  }

  /** 回滚一条扩写：删除对应相似问 + 审计标记 reverted */
  async revert(id) {
    try {
      const pool = (await import('../db/pool.js')).default
      const [rows] = await pool.execute('SELECT * FROM expand_audit WHERE id = ? AND status = "applied"', [id])
      if (!rows.length) return { ok: false, message: '记录不存在或已回滚' }
      const row = rows[0]
      const existed = await this.faqService.questionExists(row.faq_code, row.user_text)
      if (existed) {
        // 需要删除该条相似问：faqRepo 无按值删除，走数据库直删 + 增量重编码
        await pool.execute('DELETE FROM faq_question WHERE faq_code = ? AND question = ?', [row.faq_code, row.user_text])
        await this.faqService.syncIntent(row.faq_code)
        // 同步更新答案缓存中的相似问列表
        const cached = this.faqService.faqMap.get(row.faq_code)
        if (cached) cached.questions = await (await import('../repositories/faqRepo.js')).getQuestions(row.faq_code)
      }
      await pool.execute('UPDATE expand_audit SET status = "reverted" WHERE id = ?', [id])
      return { ok: true, message: `已回滚：删除相似问"${row.user_text}"` }
    } catch (e) {
      return { ok: false, message: '回滚失败: ' + e.message }
    }
  }

  /** 审计列表 */
  async list() {
    try {
      const pool = (await import('../db/pool.js')).default
      const [rows] = await pool.execute(
        'SELECT id, user_text, faq_code, faq_name, similarity, status, DATE_FORMAT(created_at, "%Y/%m/%d %H:%i") AS created_time FROM expand_audit ORDER BY id DESC LIMIT 100'
      )
      return rows
    } catch (e) {
      return []
    }
  }
}

export default new AutoExpandService()
