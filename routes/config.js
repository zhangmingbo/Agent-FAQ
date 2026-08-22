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
      llmApiUrl: config.llm_api_url || '',
      llmModel: config.llm_model || '',
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

    // LLM 配置（任务智能层 + FAQ 兜底共用，保存即生效）
    if (req.body.llmEnabled !== undefined) {
      await configRepo.set('llm_enabled', req.body.llmEnabled ? 'true' : 'false')
    }
    if (req.body.llmApiUrl !== undefined) {
      await configRepo.set('llm_api_url', req.body.llmApiUrl)
    }
    if (req.body.llmApiKey !== undefined && req.body.llmApiKey) {
      await configRepo.set('llm_api_key', req.body.llmApiKey)
    }
    if (req.body.llmModel !== undefined) {
      await configRepo.set('llm_model', req.body.llmModel)
    }
    if (req.body.llmEnabled !== undefined || req.body.llmApiUrl !== undefined || req.body.llmApiKey !== undefined || req.body.llmModel !== undefined) {
      const cfg = await configRepo.getAll()
      const llmCfg = {
        enabled: cfg.llm_enabled === 'true',
        apiUrl: cfg.llm_api_url || '',
        apiKey: cfg.llm_api_key || '',
        model: cfg.llm_model || 'deepseek-chat',
      }
      // 同步任务引擎 LLM 层（配置即激活）
      if (engine.taskEngine?.setLlmConfig) {
        engine.taskEngine.setLlmConfig(llmCfg)
      }
      // 同步 FAQ 引擎大模型兜底
      if (llmCfg.enabled) {
        engine.llmConfig = { enabled: true, apiUrl: llmCfg.apiUrl, apiKey: llmCfg.apiKey, model: llmCfg.model }
      } else {
        engine.llmConfig = { enabled: false }
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
