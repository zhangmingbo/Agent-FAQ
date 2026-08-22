/**
 * 系统配置路由
 * GET/POST /api/config
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as configRepo from '../repositories/configRepo.js'

export function createRouter(engine) {
  const router = Router()

  // 获取配置
  router.get('/config', asyncHandler(async (req, res) => {
    const config = await configRepo.getAll()
    res.json({
      minConfidence: parseFloat(config.min_confidence) || 0.5,
      clarifyThreshold: parseFloat(config.clarify_threshold) || 0.65,
      topK: parseInt(config.top_k) || 5,
      intentCount: engine.getIntentCount(),
      llmEnabled: config.llm_enabled === 'true',
      meaninglessDetectionMode: config.meaningless_detection_mode || 'rule',
    })
  }))

  // 更新配置
  router.post('/config', asyncHandler(async (req, res) => {
    const { minConfidence, clarifyThreshold, topK } = req.body

    if (minConfidence !== undefined) {
      await configRepo.set('min_confidence', minConfidence)
      engine.recognizer.minConfidence = minConfidence
    }
    if (clarifyThreshold !== undefined) {
      await configRepo.set('clarify_threshold', clarifyThreshold)
      engine.clarifyThreshold = clarifyThreshold
    }
    if (topK !== undefined) {
      await configRepo.set('top_k', topK)
      engine.recognizer.topK = topK
    }
    if (req.body.meaninglessDetectionMode !== undefined) {
      const mode = req.body.meaninglessDetectionMode
      if (mode === 'rule' || mode === 'llm') {
        await configRepo.set('meaningless_detection_mode', mode)
        engine.meaninglessDetectionMode = mode
      }
    }

    res.json({
      success: true,
      minConfidence: engine.recognizer.minConfidence,
      clarifyThreshold: engine.clarifyThreshold,
      topK: engine.recognizer.topK,
      meaninglessDetectionMode: engine.meaninglessDetectionMode,
    })
  }))

  return router
}
