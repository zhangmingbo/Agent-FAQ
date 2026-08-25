/**
 * 智能分析路由
 * GET /api/analysis, POST /api/analysis/suggest, add-question, check-questions
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import pool from '../db/pool.js'

export function createRouter(engine) {
  const router = Router()

  // 答案反馈：用户否定上轮回答的高频问答对（定位"答错的高频问题"）
  router.get('/analysis/feedback', asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const [rows] = await pool.execute(
      `SELECT user_text, COUNT(*) as cnt,
              LEFT(MAX(answer), 100) as answer,
              DATE_FORMAT(MAX(created_at), '%Y/%m/%d %H:%i') as last_time
       FROM answer_feedback
       GROUP BY user_text ORDER BY cnt DESC LIMIT ${limit}`
    )
    res.json({ success: true, items: rows })
  }))

  // 任务漏斗：触发 → 收集 → 完成 → 动作成功（定位任务流失环节）
  router.get('/analysis/funnel', asyncHandler(async (req, res) => {
    const [started] = await pool.execute(
      "SELECT SUBSTRING_INDEX(intent_code, ':', -1) AS task, COUNT(*) AS cnt FROM chat_log WHERE source = 'task_started' AND intent_code LIKE 'task:%' GROUP BY task"
    )
    const [progressed] = await pool.execute(
      "SELECT SUBSTRING_INDEX(intent_code, ':', -1) AS task, COUNT(*) AS cnt FROM chat_log WHERE source = 'task_progress' AND intent_code LIKE 'task:%' GROUP BY task"
    )
    const [completed] = await pool.execute(
      "SELECT SUBSTRING_INDEX(intent_code, ':', -1) AS task, COUNT(*) AS cnt FROM chat_log WHERE source = 'task_complete' AND intent_code LIKE 'task:%' GROUP BY task"
    )
    const [actions] = await pool.execute(
      "SELECT task_code AS task, COUNT(*) AS cnt FROM action_log WHERE status = 'ok' GROUP BY task_code"
    )
    const [names] = await pool.execute('SELECT code, name FROM task')
    const nameMap = {}
    names.forEach(n => { nameMap[n.code] = n.name })
    const merged = {}
    started.forEach(r => { merged[r.task] = merged[r.task] || { task: r.task, name: nameMap[r.task] || r.task }; merged[r.task].started = r.cnt })
    progressed.forEach(r => { merged[r.task] = merged[r.task] || { task: r.task, name: nameMap[r.task] || r.task }; merged[r.task].progressed = r.cnt })
    completed.forEach(r => { merged[r.task] = merged[r.task] || { task: r.task, name: nameMap[r.task] || r.task }; merged[r.task].completed = r.cnt })
    actions.forEach(r => { merged[r.task] = merged[r.task] || { task: r.task, name: nameMap[r.task] || r.task }; merged[r.task].actionOk = r.cnt })
    const items = Object.values(merged).map(it => {
      const started = it.started || 0
      return {
        ...it,
        started, progressed: it.progressed || 0, completed: it.completed || 0, actionOk: it.actionOk || 0,
        completeRate: started ? Math.round(((it.completed || 0) / started) * 100) : 0,
      }
    }).sort((a, b) => b.started - a.started)
    res.json({ success: true, items })
  }))

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
    const allFaqs = await engine.faqService.listAll()

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
      recommendAction: (result.matched && result.confidence > (engine.analysisRecommendThreshold ?? 0.3)) ? 'add_question' : 'create_new',
    })
  }))

  // 将未匹配问题加入已有 FAQ 的相似问（写库 + 增量重编码，无需全量加载）
  router.post('/analysis/add-question', asyncHandler(async (req, res) => {
    const { faqCode, question } = req.body
    if (!faqCode || !question) {
      res.status(400).json({ message: '参数不完整' })
      return
    }

    if (await engine.faqService.questionExists(faqCode, question)) {
      res.json({ success: false, message: '该相似问已存在' })
      return
    }

    await engine.faqService.addQuestion(faqCode, question)

    res.json({ success: true, message: `已将"${question}"加入"${faqCode}"的相似问` })
  }))

  // 批量检查文本是否已作为相似问存在
  router.post('/analysis/check-questions', asyncHandler(async (req, res) => {
    const { texts } = req.body
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      res.json({ results: {} })
      return
    }
    const results = await engine.faqService.checkQuestions(texts)
    res.json({ results })
  }))

  return router
}
