/**
 * 管理端 JWT 认证中间件
 * 
 * 保护管理 API 接口，聊天接口（/api/chat, /api/recognize）不需要认证
 */

import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import config from '../config/index.js'

/**
 * 生成 JWT token
 */
function generateToken(payload) {
  return jwt.sign(payload, config.auth.secret, { expiresIn: config.auth.expiresIn })
}

/**
 * 验证密码
 */
async function verifyPassword(input, stored) {
  // 首次使用：明文比较（默认账号 admin/admin123）
  // 如果 stored 是 bcrypt hash（$2a$ 开头），则用 bcrypt 比较
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$')) {
    return bcrypt.compare(input, stored)
  }
  return input === stored
}

/**
 * 创建认证路由（挂载到 /api/auth）
 */
export function createAuthRouter() {
  const router = Router()

  // 登录接口
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body
      if (!username || !password) {
        return res.status(400).json({ message: '用户名和密码不能为空' })
      }

      const valid = username === config.auth.defaultAdmin.username &&
        await verifyPassword(password, config.auth.defaultAdmin.password)

      if (!valid) {
        return res.status(401).json({ message: '用户名或密码错误' })
      }

      const token = generateToken({ username, role: 'admin' })
      res.json({ success: true, token, expiresIn: config.auth.expiresIn })
    } catch (e) {
      res.status(500).json({ message: e.message })
    }
  })

  // 验证 token 有效性（全局中间件已处理白名单，此处无需再次验证）
  router.get('/verify', (req, res) => {
    // 能从全局中间件到达这里，说明 token 有效
    res.json({ valid: true, user: req.user || {} })
  })

  return router
}

/**
 * 认证中间件
 * 从 Authorization header 中提取并验证 JWT token
 */
export function authMiddleware(req, res, next) {
  // 白名单：这些接口不需要认证
  const whitelist = [
    '/api/chat',
    '/api/recognize',
    '/api/auth/login',
    '/api/auth/verify',
    '/api/health',
    '/api/mock', // 假接口（联调测试用，无需登录）
  ]

  // 静态文件不需要认证
  if (!req.url.startsWith('/api/')) {
    return next()
  }

  // 检查白名单
  if (whitelist.some(path => req.url.startsWith(path))) {
    return next()
  }

  // 提取 token
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: '未提供认证令牌' })
  }

  const token = authHeader.substring(7)
  try {
    const decoded = jwt.verify(token, config.auth.secret)
    req.user = decoded
    next()
  } catch (e) {
    res.status(401).json({ message: '认证令牌无效或已过期' })
  }
}
