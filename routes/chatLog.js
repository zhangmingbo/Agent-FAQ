/**
 * 问题追踪路由
 * GET /api/chat-log/unmatched, low-confidence, dates, recent, recent-dates, live
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as chatLogRepo from '../repositories/chatLogRepo.js'

export function createRouter(engine) {
  const router = Router()

  // 未匹配问题列表
  router.get('/chat-log/unmatched', asyncHandler(async (req, res) => {
    const result = await chatLogRepo.getUnmatched(req.query)
    res.json(result)
  }))

  // 低置信度列表
  router.get('/chat-log/low-confidence', asyncHandler(async (req, res) => {
    const result = await chatLogRepo.getLowConfidence({ ...req.query, maxConfidence: engine.analysisMaxConfidence ?? 0.7 })
    res.json(result)
  }))

  // 可用日期列表
  router.get('/chat-log/dates', asyncHandler(async (req, res) => {
    const rows = await chatLogRepo.getDates(req.query.type, engine.analysisMaxConfidence ?? 0.7)
    res.json(rows)
  }))

  // 最近咨询记录
  router.get('/chat-log/recent', asyncHandler(async (req, res) => {
    const result = await chatLogRepo.getRecent(req.query)
    res.json(result)
  }))

  // 最近咨询记录可用日期
  router.get('/chat-log/recent-dates', asyncHandler(async (req, res) => {
    const rows = await chatLogRepo.getRecentDates()
    res.json(rows)
  }))

  // 实时问答日志（调试用）
  router.get('/chat-log/live', asyncHandler(async (req, res) => {
    const logs = await chatLogRepo.getLive(req.query)
    res.json({ success: true, count: logs.length, logs })
  }))

  // 删除某问题文本对应的对话记录（未匹配/低置信度列表的「删除」按钮）
  router.post('/chat-log/delete', asyncHandler(async (req, res) => {
    const { text } = req.body || {}
    if (!text) {
      res.status(400).json({ success: false, message: '缺少问题文本' })
      return
    }
    const count = await chatLogRepo.deleteByText(text)
    res.json({ success: true, message: '已删除 ' + count + ' 条对话记录' })
  }))

  return router
}
