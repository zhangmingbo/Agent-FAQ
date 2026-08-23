/**
 * 系统配置路由
 * GET/POST /api/config
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as configRepo from '../repositories/configRepo.js'
import llmPrompts from '../services/llmPrompts.js'

export function createRouter(engine) {
  const router = Router()

  // 获取 LLM 提示词注册表（管理后台「LLM 智能层」用）
  router.get('/config/llm-prompts', asyncHandler(async (req, res) => {
    const data = await llmPrompts.getAll()
    res.json({ success: true, data })
  }))

  // 更新 LLM 提示词（空值=恢复默认；保存即生效，无需重启）
  router.post('/config/llm-prompts', asyncHandler(async (req, res) => {
    const { prompts } = req.body
    if (!prompts || typeof prompts !== 'object') {
      res.status(400).json({ success: false, message: 'prompts 必须是对象' })
      return
    }
    await llmPrompts.updatePrompts(prompts)
    // 同步 FAQ 引擎兜底回答的系统提示词
    if (engine.llmConfig) {
      engine.llmConfig.systemPrompt = llmPrompts.get('faq_answer.system')
    }
    res.json({ success: true, message: '提示词已保存' })
  }))

  // 获取配置
  router.get('/config', asyncHandler(async (req, res) => {
    const config = await configRepo.getAll()
    // 实际生效的 LLM 配置（数据库配置 + 环境变量 DEEPSEEK_API_KEY 兜底）
    const llmCfg = engine.taskEngine?.llm?.resolveFromDb
      ? engine.taskEngine.llm.resolveFromDb(config)
      : { enabled: config.llm_enabled === 'true', apiUrl: config.llm_api_url || '', model: config.llm_model || '' }
    res.json({
      minConfidence: parseFloat(config.min_confidence) || 0.5,
      clarifyThreshold: parseFloat(config.clarify_threshold) || 0.65,
      topK: parseInt(config.top_k) || 5,
      intentCount: engine.getIntentCount(),
      llmEnabled: llmCfg.enabled,
      llmApiUrl: llmCfg.apiUrl || '',
      llmModel: llmCfg.model || '',
      nluMode: config.nlu_mode || 'hybrid',
      meaninglessDetectionMode: config.meaningless_detection_mode || 'rule',
      // 任务/FAQ 统一语义仲裁阈值（运营可配）
      arbGap: parseFloat(config.arb_gap) || 0.08,
      arbTaskMin: parseFloat(config.arb_task_min) || 0.45,
      arbFaqMin: parseFloat(config.arb_faq_min) || 0.55,
      arbStrongHit: parseFloat(config.arb_strong_hit) || 0.72,
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

    // 理解层模式（rule 纯规则 / hybrid 规则+LLM 补漏 / llm LLM 优先）
    if (req.body.nluMode !== undefined) {
      const mode = req.body.nluMode
      if (['rule', 'hybrid', 'llm'].includes(mode)) {
        await configRepo.set('nlu_mode', mode)
        engine.taskEngine?.setNluMode?.(mode)
      }
    }

    // 任务/FAQ 统一语义仲裁阈值（保存即生效）
    if (req.body.arbGap !== undefined || req.body.arbTaskMin !== undefined || req.body.arbFaqMin !== undefined || req.body.arbStrongHit !== undefined) {
      if (req.body.arbGap !== undefined) await configRepo.set('arb_gap', req.body.arbGap)
      if (req.body.arbTaskMin !== undefined) await configRepo.set('arb_task_min', req.body.arbTaskMin)
      if (req.body.arbFaqMin !== undefined) await configRepo.set('arb_faq_min', req.body.arbFaqMin)
      if (req.body.arbStrongHit !== undefined) await configRepo.set('arb_strong_hit', req.body.arbStrongHit)
      const cfg = await configRepo.getAll()
      engine.taskEngine?.nlu?.setArbConfig?.({
        gap: cfg.arb_gap,
        taskMin: cfg.arb_task_min,
        faqMin: cfg.arb_faq_min,
        strongHit: cfg.arb_strong_hit,
      })
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
