/**
 * 聊天路由
 * POST /api/chat, POST /api/recognize
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import { chatLimiter } from '../middleware/rateLimit.js'
import { getChannelValues } from '../services/channelTypes.js'

/** 校验并规范化渠道标识（动态读取配置） */
function normalizeChannel(raw) {
  const valid = getChannelValues()
  return valid.includes(raw) ? raw : 'web'
}

export function createRouter(engine) {
  const router = Router()

  // 核心聊天接口
  router.post('/chat', chatLimiter, asyncHandler(async (req, res) => {
    const { text, sessionId, userId, debug, channelType } = req.body
    if (!text) {
      res.status(400).json({ message: '输入不能为空' })
      return
    }
    const channel = normalizeChannel(channelType)
    const result = await engine.chat(text, sessionId || 'default', userId || null, { debug: !!debug }, channel)
    res.json(result)
  }))

  // 兼容旧接口
  router.post('/recognize', chatLimiter, asyncHandler(async (req, res) => {
    const { text } = req.body
    if (!text) {
      res.status(400).json({ message: '输入不能为空' })
      return
    }
    const result = await engine.chat(text)
    res.json(result)
  }))

  return router
}
