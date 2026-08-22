/**
 * FAQ 知识库领域服务
 *
 * 职责：
 *   - 通过 repositories 访问数据库（faq / faq_question / faq_category）
 *   - 维护意图识别器（recognizer）与 FAQ 答案缓存（faqMap）的内存态，并保证与数据库一致
 *   - 提供增量同步（save / addQuestion 只重编码受影响的意图，避免全量加载）
 *
 * 解耦点：不依赖对话编排（FAQEngine），可独立测试
 */

import IntentRecognizer from '../src/index.js'
import * as faqRepo from '../repositories/faqRepo.js'
import * as categoryRepo from '../repositories/categoryRepo.js'

class FaqService {
  /**
   * @param {Object} options - 配置
   * @param {number} options.minConfidence - 意图识别最低置信度阈值
   * @param {number} options.topK - 识别器返回 Top K 数量
   */
  constructor({ minConfidence = 0.5, topK = 5 } = {}) {
    // 底层意图识别器（供引擎与路由复用）
    this.recognizer = new IntentRecognizer({ minConfidence, topK })

    // FAQ 答案缓存（code → faq item），与识别器同步维护
    this.faqMap = new Map()
  }

  /**
   * 获取缓存的 FAQ 条目（对话编排用，不查库）
   * @param {string} code - FAQ 编码
   */
  getFaq(code) {
    return this.faqMap.get(code) || null
  }

  /**
   * 获取意图数量
   */
  getIntentCount() {
    return this.recognizer.getIntentCount()
  }

  /**
   * 全量加载知识库（启动时调用）
   * @returns {Promise<number>} FAQ 条数
   */
  async loadAll() {
    const faqs = await faqRepo.listAllRaw()
    const questionsMap = await faqRepo.listAllQuestions()

    // 重建意图识别器
    this.recognizer.clear()
    const intents = faqs.map(faq => ({
      code: faq.code,
      name: faq.name,
      questions: questionsMap.get(faq.code) || [],
      priority: faq.priority || 0,
    }))
    await this.recognizer.addIntents(intents)

    // 重建答案缓存（JSON 字段已被 mysql2 自动解析）
    this.faqMap.clear()
    for (const faq of faqs) {
      this.faqMap.set(faq.code, {
        ...faq,
        richContent: faq.rich_content || null,
        links: faq.links || null,
        related: faq.related || null,
        questions: questionsMap.get(faq.code) || [],
      })
    }

    console.log(`[FaqService] 已加载 ${faqs.length} 条 FAQ`)
    return faqs.length
  }

  /**
   * FAQ 列表（管理后台用）
   */
  listAll() {
    return faqRepo.listAll()
  }

  /**
   * 按分类（含子分类）获取 FAQ 列表
   * @param {number|null} categoryId - 分类 ID，为空返回全部
   */
  async listByCategory(categoryId) {
    const subCategoryIds = categoryId ? await categoryRepo.getSubCategoryIds(categoryId) : null
    return faqRepo.listByCategory(categoryId || null, subCategoryIds)
  }

  /**
   * 获取分类树形结构
   */
  listCategories() {
    return categoryRepo.listTree()
  }

  /**
   * 获取单个 FAQ 详情
   */
  getByCode(code) {
    return faqRepo.getByCode(code)
  }

  /**
   * 新增/更新 FAQ：写库 + 增量同步识别器与缓存
   * @param {Object} config - FAQ 配置（含 questions 相似问列表）
   */
  async save(config) {
    const { code, name, answer, richContent, links, related, followUp, priority, categoryId, questions } = config

    await faqRepo.upsert({ code, name, answer, richContent, links, related, followUp, priority, categoryId })
    await faqRepo.replaceQuestions(code, questions || [])

    // 增量更新意图识别器（只重编码这一个意图，避免全量加载）
    await this.syncIntent(code)
    console.log(`[FaqService] 已保存 FAQ: ${code} (${name})，总样本 ${this.recognizer.allSamples.length}`)

    // 更新答案缓存
    this.faqMap.set(code, {
      code,
      name,
      answer: answer || null,
      richContent: richContent || null,
      links: links || null,
      related: related || null,
      followUp: followUp || null,
      priority: priority || 0,
      categoryId: categoryId || null,
      questions: questions || [],
    })
    return true
  }

  /**
   * 删除 FAQ：写库 + 同步内存
   */
  async remove(code) {
    await faqRepo.remove(code)
    this.faqMap.delete(code)
    this.recognizer.removeIntent(code)
    console.log(`[FaqService] 已删除 FAQ: ${code}`)
    return true
  }

  /**
   * 追加一条相似问：写库 + 增量重编码该意图
   */
  async addQuestion(faqCode, question) {
    await faqRepo.addQuestion(faqCode, question)
    await this.syncIntent(faqCode)

    // 同步更新答案缓存中的相似问列表
    const cached = this.faqMap.get(faqCode)
    if (cached) cached.questions = await faqRepo.getQuestions(faqCode)

    console.log(`[FaqService] 已追加相似问: "${question}" → ${faqCode}`)
    return true
  }

  /**
   * 检查相似问是否已存在
   */
  questionExists(faqCode, question) {
    return faqRepo.questionExists(faqCode, question)
  }

  /**
   * 批量检查文本是否已作为相似问存在
   * @param {string[]} texts
   * @returns {Promise<Object>} { question: { exists, faqCode } }
   */
  checkQuestions(texts) {
    return faqRepo.checkQuestions(texts)
  }

  /**
   * 重编码单个意图（先删后加），保持识别器与数据库一致
   * @private
   */
  async syncIntent(code) {
    const faq = await faqRepo.getByCode(code)
    this.recognizer.removeIntent(code)
    if (!faq) return

    const questions = await faqRepo.getQuestions(code)
    if (questions.length === 0) return

    await this.recognizer.addIntent({
      code,
      name: faq.name,
      questions,
      priority: faq.priority || 0,
    })
  }
}

export default FaqService
