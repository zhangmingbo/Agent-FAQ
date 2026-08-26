/**
 * 可视化调试 API（处理轨迹追踪）
 * GET /api/debug/sessions           最近有轨迹的会话列表
 * GET /api/debug/session/:id        某个会话的完整处理轨迹（每轮的步骤链）
 * POST /api/debug/clear             清空内存轨迹
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import traceService from '../services/traceService.js'
import llmCallLogger from '../services/llmCallLogger.js'

export function createRouter() {
  const router = Router()

  // 最近有轨迹的会话列表
  router.get('/debug/sessions', asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 20
    res.json({ success: true, data: traceService.listSessions(limit) })
  }))

  // 某个会话的完整轨迹
  router.get('/debug/session/:id', asyncHandler(async (req, res) => {
    const trace = traceService.getSessionTrace(req.params.id)
    res.json({ success: true, data: trace })
  }))

  // 某个会话的 LLM 调用日志（会话调试页查看每次调用 LLM 的请求/响应/耗时）
  router.get('/debug/llm-calls', asyncHandler(async (req, res) => {
    const sessionId = req.query.sessionId || null
    const limit = parseInt(req.query.limit) || 50
    const items = llmCallLogger.query({ sessionId, limit })
    res.json({ success: true, data: { items, total: items.length } })
  }))

  // 清空轨迹
  router.post('/debug/clear', asyncHandler(async (req, res) => {
    traceService.clearAll()
    res.json({ success: true, message: '轨迹已清空' })
  }))

  // 清空 LLM 调用日志
  router.post('/debug/llm-calls/clear', asyncHandler(async (req, res) => {
    llmCallLogger.clear()
    res.json({ success: true, message: 'LLM 调用日志已清空' })
  }))

  return router
}
