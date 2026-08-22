/**
 * 智能分析路由
 * GET /api/analysis, POST /api/analysis/suggest, add-question, check-questions
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as faqRepo from '../repositories/faqRepo.js'

export function createRouter(engine) {
  const router = Router()

  // 获取智能分析报告
  router.get('/analysis', asyncHandler(async (req, res) => {
    const analysis = await engine.getAnalysis()
    res.json(analysis)
  }))

  // 智能建议：判断未匹配问题应该新建 FAQ 还是加入已有 FAQ 的相似问
  router.post('/analysis/suggest', asyncHandler(async (req, res) => {
    const { text } = req.body
    if (!text) {
      res.status(400).json({ message: '文本不能为空' })
      return
    }

    const result = await engine.recognizer.recognize(text)
    const allFaqs = await engine.listFAQ()

    const suggestions = []
    if (result.matched && result.top_results) {
      for (const r of result.top_results.slice(0, 5)) {
        const faq = allFaqs.find(f => f.code === r.intentCode)
        if (faq) {
          suggestions.push({
            action: 'add_question',
            faqCode: r.intentCode,
            faqName: faq.name,
            similarity: r.similarity,
            questionCount: faq.questionCount,
          })
        }
      }
    }

    res.json({
      text,
      matched: result.matched,
      confidence: result.confidence,
      suggestions,
      recommendAction: (result.matched && result.confidence > 0.3) ? 'add_question' : 'create_new',
    })
  }))

  // 将未匹配问题加入已有 FAQ 的相似问
  router.post('/analysis/add-question', asyncHandler(async (req, res) => {
    const { faqCode, question } = req.body
    if (!faqCode || !question) {
      res.status(400).json({ message: '参数不完整' })
      return
    }

    if (await faqRepo.questionExists(faqCode, question)) {
      res.json({ success: false, message: '该相似问已存在' })
      return
    }

    await faqRepo.addQuestion(faqCode, question)
    await engine.loadFAQ()

    res.json({ success: true, message: `已将"${question}"加入"${faqCode}"的相似问` })
  }))

  // 批量检查文本是否已作为相似问存在
  router.post('/analysis/check-questions', asyncHandler(async (req, res) => {
    const { texts } = req.body
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      res.json({ results: {} })
      return
    }
    const results = await faqRepo.checkQuestions(texts)
    res.json({ results })
  }))

  return router
}
