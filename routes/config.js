/**
 * 系统配置路由
 * GET/POST /api/config
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as configRepo from '../repositories/configRepo.js'
import llmPrompts from '../services/llmPrompts.js'
import taskSuggestService from '../services/taskSuggestService.js'
import { getAllReplyTexts, setReplyTexts } from '../services/replyTexts.js'
import { getAllMatchVocab, setMatchVocab } from '../services/matchVocab.js'
import llmClient from '../services/llmClient.js'

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
      arbVectorThreshold: parseFloat(config.arb_vector_threshold) || 0.45,
      arbTaskBoost: parseFloat(config.arb_task_boost) || 0.85,
      // 高级判定阈值（FAQ 候选竞争 / LLM 重排 / 短句防护 / 任务向量最短长度）
      faqCompeteCeiling: parseFloat(config.faq_compete_ceiling) || 0.95,
      faqCompeteGap: parseFloat(config.faq_compete_gap) || 0.06,
      llmRerankCeiling: parseFloat(config.llm_rerank_ceiling) || 0.9,
      shortTextLen: parseInt(config.short_text_len) || 4,
      shortRegexHit: parseFloat(config.short_regex_hit) || 0.95,
      shortContainsHit: parseFloat(config.short_contains_hit) || 0.9,
      taskVecMinLen: parseInt(config.task_vec_min_len) || 5,
      // 分析/建议阈值
      analysisRecommendThreshold: parseFloat(config.analysis_recommend_threshold) || 0.3,
      analysisMaxConfidence: parseFloat(config.analysis_max_confidence) || 0.7,
      suggestMinLen: parseInt(config.suggest_min_len) || 4,
      suggestSimThreshold: parseFloat(config.suggest_sim_threshold) || 0.55,
      suggestKeywordMinScore: parseFloat(config.suggest_keyword_min_score) || 0.75,
      // 固定话术 / 匹配词表（运营可配，sys_config 存储）
      replyTexts: getAllReplyTexts(),
      matchVocab: getAllMatchVocab(),
      // LLM 调用节点（可视化编辑，sys_config.llm_nodes 存储）
      llmNodes: llmClient.getNodes(),
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
    let arbUpdated = false
    if (req.body.arbGap !== undefined || req.body.arbTaskMin !== undefined || req.body.arbFaqMin !== undefined || req.body.arbStrongHit !== undefined || req.body.arbVectorThreshold !== undefined || req.body.arbTaskBoost !== undefined) {
      arbUpdated = true
      if (req.body.arbGap !== undefined) await configRepo.set('arb_gap', req.body.arbGap)
      if (req.body.arbTaskMin !== undefined) await configRepo.set('arb_task_min', req.body.arbTaskMin)
      if (req.body.arbFaqMin !== undefined) await configRepo.set('arb_faq_min', req.body.arbFaqMin)
      if (req.body.arbStrongHit !== undefined) await configRepo.set('arb_strong_hit', req.body.arbStrongHit)
      if (req.body.arbVectorThreshold !== undefined) await configRepo.set('arb_vector_threshold', req.body.arbVectorThreshold)
      if (req.body.arbTaskBoost !== undefined) await configRepo.set('arb_task_boost', req.body.arbTaskBoost)
    }

    // 高级判定阈值（FAQ 候选竞争 / LLM 重排 / 短句防护，保存即生效）
    if (req.body.faqCompeteCeiling !== undefined) { await configRepo.set('faq_compete_ceiling', req.body.faqCompeteCeiling); engine.faqCompeteCeiling = parseFloat(req.body.faqCompeteCeiling) }
    if (req.body.faqCompeteGap !== undefined) { await configRepo.set('faq_compete_gap', req.body.faqCompeteGap); engine.faqCompeteGap = parseFloat(req.body.faqCompeteGap) }
    if (req.body.llmRerankCeiling !== undefined) { await configRepo.set('llm_rerank_ceiling', req.body.llmRerankCeiling); engine.llmRerankCeiling = parseFloat(req.body.llmRerankCeiling) }
    if (req.body.shortTextLen !== undefined) { await configRepo.set('short_text_len', req.body.shortTextLen); engine.recognizer.shortTextLen = parseInt(req.body.shortTextLen) || 4 }
    if (req.body.shortRegexHit !== undefined) { await configRepo.set('short_regex_hit', req.body.shortRegexHit); engine.recognizer.shortRegexHit = parseFloat(req.body.shortRegexHit) }
    if (req.body.shortContainsHit !== undefined) { await configRepo.set('short_contains_hit', req.body.shortContainsHit); engine.recognizer.shortContainsHit = parseFloat(req.body.shortContainsHit) }
    if (req.body.taskVecMinLen !== undefined) { await configRepo.set('task_vec_min_len', req.body.taskVecMinLen); arbUpdated = true }

    // 仲裁/任务向量参数统一刷新 NLU（含 vecMinLen）
    if (arbUpdated) {
      const cfg = await configRepo.getAll()
      engine.taskEngine?.nlu?.setArbConfig?.({
        gap: cfg.arb_gap,
        taskMin: cfg.arb_task_min,
        faqMin: cfg.arb_faq_min,
        strongHit: cfg.arb_strong_hit,
        vectorThreshold: cfg.arb_vector_threshold,
        taskBoost: cfg.arb_task_boost,
        vecMinLen: cfg.task_vec_min_len,
      })
    }

    // 分析/建议阈值（保存即生效）
    if (req.body.analysisRecommendThreshold !== undefined) { await configRepo.set('analysis_recommend_threshold', req.body.analysisRecommendThreshold); engine.analysisRecommendThreshold = parseFloat(req.body.analysisRecommendThreshold) }
    if (req.body.analysisMaxConfidence !== undefined) { await configRepo.set('analysis_max_confidence', req.body.analysisMaxConfidence); engine.analysisMaxConfidence = parseFloat(req.body.analysisMaxConfidence) }
    if (req.body.suggestMinLen !== undefined) { await configRepo.set('suggest_min_len', req.body.suggestMinLen) }
    if (req.body.suggestSimThreshold !== undefined) { await configRepo.set('suggest_sim_threshold', req.body.suggestSimThreshold) }
    if (req.body.suggestKeywordMinScore !== undefined) { await configRepo.set('suggest_keyword_min_score', req.body.suggestKeywordMinScore) }
    if (req.body.suggestMinLen !== undefined || req.body.suggestSimThreshold !== undefined || req.body.suggestKeywordMinScore !== undefined) {
      taskSuggestService.configure({
        minLen: req.body.suggestMinLen,
        simThreshold: req.body.suggestSimThreshold,
        keywordMinScore: req.body.suggestKeywordMinScore,
      })
    }

    // 固定话术 / 匹配词表（保存即生效）
    if (req.body.replyTexts !== undefined) {
      await configRepo.set('reply_texts', JSON.stringify(req.body.replyTexts))
      setReplyTexts(req.body.replyTexts)
    }
    if (req.body.matchVocab !== undefined) {
      await configRepo.set('match_vocab', JSON.stringify(req.body.matchVocab))
      setMatchVocab(req.body.matchVocab)
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
      // 同步共享 LLM 模块（配置即激活；taskEngine.setLlmConfig 配置的就是同一实例）
      if (engine.taskEngine?.setLlmConfig) {
        engine.taskEngine.setLlmConfig(llmCfg)
      }
    }

    // LLM 调用节点配置（可视化编辑，保存即生效）
    if (req.body.llmNodes !== undefined) {
      await configRepo.set('llm_nodes', JSON.stringify(req.body.llmNodes))
      llmClient.setNodes(req.body.llmNodes)
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
