/**
 * 接口限流中间件
 * 
 * 基于 express-rate-limit，按接口类型设置不同限流策略
 */

import rateLimit from 'express-rate-limit'
import config from '../config/index.js'

/**
 * 聊天接口限流：30次/分钟
 */
export const chatLimiter = rateLimit({
  windowMs: config.rateLimit.chat.windowMs,
  max: config.rateLimit.chat.max,
  message: { success: false, message: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.sessionId || req.ip,
})

/**
 * 管理接口限流：120次/分钟
 */
export const adminLimiter = rateLimit({
  windowMs: config.rateLimit.admin.windowMs,
  max: config.rateLimit.admin.max,
  message: { success: false, message: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
})
