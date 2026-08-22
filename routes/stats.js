/**
 * 监控统计路由
 * GET /api/stats
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'

export function createRouter(engine) {
  const router = Router()

  router.get('/stats', asyncHandler(async (req, res) => {
    const stats = await engine.getStats()
    res.json(stats)
  }))

  return router
}
