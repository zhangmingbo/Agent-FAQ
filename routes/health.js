/**
 * 健康检查路由
 * GET /api/health
 */

import { Router } from 'express'
import pool from '../db/pool.js'

export function createRouter(engine) {
  const router = Router()

  router.get('/health', async (req, res) => {
    let dbOk = false
    try {
      await pool.execute('SELECT 1')
      dbOk = true
    } catch (e) { /* ignore */ }

    res.json({
      status: dbOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      faqCount: engine.getIntentCount(),
      database: dbOk ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    })
  })

  return router
}
