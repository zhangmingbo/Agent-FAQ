/**
 * 问题追踪路由
 * GET /api/chat-log/unmatched, low-confidence, dates, recent, recent-dates, live
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as chatLogRepo from '../repositories/chatLogRepo.js'
import * as configRepo from '../repositories/configRepo.js'

/** 已处理（忽略）的问题文本列表：sys_config.issue_ignored，JSON 数组 */
async function getIgnored() {
  try {
    const raw = await configRepo.get('issue_ignored')
    if (raw) {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) return list
    }
  } catch (e) {
    console.warn('[ChatLog] 读取忽略列表失败:', e.message)
  }
  return []
}

export function createRouter(engine) {
  const router = Router()

  // 未匹配问题列表（已处理的不再展示，原始记录保留）
  router.get('/chat-log/unmatched', asyncHandler(async (req, res) => {
    const ignored = await getIgnored()
    const result = await chatLogRepo.getUnmatched({ ...req.query, ignored })
    res.json(result)
  }))

  // 低置信度列表（已处理的不再展示，原始记录保留）
  router.get('/chat-log/low-confidence', asyncHandler(async (req, res) => {
    const ignored = await getIgnored()
    const maxConf = parseFloat(engine.analysisMaxConfidence) || 0.7
    const result = await chatLogRepo.getLowConfidence({ ...req.query, maxConfidence: maxConf, ignored })
    res.json(result)
  }))

  // 标记某问题为已处理（忽略）：不再出现在未匹配/低置信度列表，原始 chat_log 保留
  router.post('/chat-log/ignore', asyncHandler(async (req, res) => {
    const { text } = req.body || {}
    if (!text) {
      res.status(400).json({ success: false, message: '缺少问题文本' })
      return
    }
    const list = await getIgnored()
    const t = String(text).trim()
    if (!list.includes(t)) list.push(t)
    await configRepo.set('issue_ignored', JSON.stringify(list))
    res.json({ success: true, message: '已标记为处理，不再展示（原始记录保留）' })
  }))

  // 可用日期列表
  router.get('/chat-log/dates', asyncHandler(async (req, res) => {
    const maxConf = parseFloat(engine.analysisMaxConfidence) || 0.7
    const rows = await chatLogRepo.getDates(req.query.type, maxConf)
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

  // 会话详情（查看某个 session 的完整对话记录）
  router.get('/chat-log/session/:sessionId', asyncHandler(async (req, res) => {
    const data = await chatLogRepo.getSessionDetail(req.params.sessionId)
    if (!data) {
      res.status(404).json({ success: false, message: '会话不存在' })
      return
    }
    res.json({ success: true, data })
  }))

  // 实时问答日志（调试用）
  router.get('/chat-log/live', asyncHandler(async (req, res) => {
    const logs = await chatLogRepo.getLive(req.query)
    res.json({ success: true, count: logs.length, logs })
  }))

  // 单条隐藏：根据问题文本隐藏所有相关记录
  router.post('/chat-log/hide', asyncHandler(async (req, res) => {
    const { text } = req.body || {}
    if (!text) {
      res.status(400).json({ success: false, message: '缺少问题文本' })
      return
    }
    
    const hiddenCount = await chatLogRepo.hideByText(text)
    res.json({ 
      success: true, 
      message: `已隐藏 ${hiddenCount} 条记录`,
      count: hiddenCount 
    })
  }))

  // 批量隐藏：根据问题文本列表隐藏
  router.post('/chat-log/batch-hide', asyncHandler(async (req, res) => {
    const { texts } = req.body || {}
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      res.status(400).json({ success: false, message: '缺少问题文本列表' })
      return
    }
    
    // 限制单次批量隐藏数量，防止误操作
    if (texts.length > 100) {
      res.status(400).json({ success: false, message: '单次最多隐藏100条记录' })
      return
    }
    
    const hiddenCount = await chatLogRepo.batchHideByTexts(texts)
    res.json({ 
      success: true, 
      message: `已隐藏 ${hiddenCount} 条记录`,
      count: hiddenCount 
    })
  }))

  return router
}
