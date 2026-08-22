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
    const result = await chatLogRepo.getLowConfidence(req.query)
    res.json(result)
  }))

  // 可用日期列表
  router.get('/chat-log/dates', asyncHandler(async (req, res) => {
    const rows = await chatLogRepo.getDates(req.query.type)
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

  return router
}
