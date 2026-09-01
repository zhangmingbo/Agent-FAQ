/**
 * 系统配置路由
 * GET/POST /api/config
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as configRepo from '../repositories/configRepo.js'
import llmPrompts from '../services/llmPrompts.js'
import taskSuggestService from '../services/taskSuggestService.js'
import autoExpandService from '../services/autoExpandService.js'
import { getAllReplyTexts, setReplyTexts } from '../services/replyTexts.js'
import { getAllMatchVocab, setMatchVocab } from '../services/matchVocab.js'
import llmClient from '../services/llmClient.js'
import nerClient from '../services/taskflow/nerClient.js'

export function createRouter(engine) {
  const router = Router()

  // ===== NER 类型管理 =====
  // 获取完整 NER 类型列表（内置 + 自定义）
  router.get('/config/ner-types', asyncHandler(async (req, res) => {
    res.json({ success: true, data: nerClient.getTypes() })
  }))

  // 保存用户自定义 NER 类型
  router.post('/config/ner-types', asyncHandler(async (req, res) => {
    const { types } = req.body
    if (!Array.isArray(types)) {
      res.status(400).json({ success: false, message: 'types 必须是数组' })
      return
    }
    // 只保存用户自定义的 regex 类型（过滤掉内置 model 类型）
    const custom = types.filter(t => t.source === 'regex')
    await nerClient.setCustomTypes(custom)
    res.json({ success: true, data: nerClient.getTypes() })
  }))

  // 测试正则匹配
  router.post('/config/ner-types/test', asyncHandler(async (req, res) => {
    const { text } = req.body
    if (!text) {
      res.status(400).json({ success: false, message: '缺少 text 参数' })
      return
    }
    const results = nerClient.testRegex(text)
    res.json({ success: true, data: results })
  }))

  // LLM 调用节点配置（页面单独刷新用；主数据已含在 GET /config 的 llmNodes）
  router.get('/config/llm-nodes', asyncHandler(async (req, res) => {
    res.json({ success: true, data: llmClient.getNodes() })
  }))

  // 获取 LLM 提示词注册表（管理后台「LLM 智能层」用）
  router.get('/config/llm-prompts', asyncHandler(async (req, res) => {    const data = await llmPrompts.getAll()
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
      // 会话超时（毫秒；Vue 原生"识别参数"表单字段，存入 sys_config.session_timeout，dialogueRules 读取）
      sessionTimeout: parseInt(config.session_timeout) || (30 * 60 * 1000),
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
      // 相似问自动扩写（第二批 C）
      expandEnabled: config.expand_enabled !== 'false',
      expandSimThreshold: parseFloat(config.expand_sim_threshold) || 0.75,
      expandMinCount: parseInt(config.expand_min_count) || 2,
      // 任务会话超时（分钟；任务挂起/中断后超过此时间失效）
      taskSessionTtlMinutes: parseInt(config.task_session_ttl_minutes) || 30,
      // 固定话术 / 匹配词表（运营可配，sys_config 存储）
      replyTexts: getAllReplyTexts(),
      matchVocab: getAllMatchVocab(),
      // LLM 调用节点（可视化编辑，sys_config.llm_nodes 存储）
      llmNodes: llmClient.getNodes(),
    })
  }))

  // 更新配置
  router.post('/config', asyncHandler(async (req, res) => {
    const body = req.body
    const save = async (key, val) => configRepo.set(key, String(val))

    // ===== 识别参数 =====
    if (body.minConfidence !== undefined) {
      await save('min_confidence', body.minConfidence)
      engine.recognizer.minConfidence = parseFloat(body.minConfidence)
    }
    if (body.clarifyThreshold !== undefined) {
      await save('clarify_threshold', body.clarifyThreshold)
      engine.clarifyThreshold = parseFloat(body.clarifyThreshold)
    }
    if (body.topK !== undefined) {
      await save('top_k', body.topK)
      engine.recognizer.topK = parseInt(body.topK)
    }
    if (body.meaninglessDetectionMode !== undefined) {
      const mode = body.meaninglessDetectionMode
      if (mode === 'rule' || mode === 'llm') {
        await save('meaningless_detection_mode', mode)
        engine.meaninglessDetectionMode = mode
      }
    }
    if (body.sessionTimeout !== undefined) {
      const timeout = parseInt(body.sessionTimeout)
      if (timeout > 0) {
        await save('session_timeout', timeout)
        const dialogueRules = (await import('../rules/dialogueRules.js')).default
        dialogueRules.updateRules?.({ sessionTimeout: timeout })
      }
    }

    // ===== 理解层模式 =====
    if (body.nluMode !== undefined && ['rule', 'hybrid', 'llm'].includes(body.nluMode)) {
      await save('nlu_mode', body.nluMode)
      engine.taskEngine?.setNluMode?.(body.nluMode)
    }

    // ===== 仲裁阈值（统一刷新 NLU）=====
    const arbKeys = ['arbGap', 'arbTaskMin', 'arbFaqMin', 'arbStrongHit', 'arbVectorThreshold', 'arbTaskBoost', 'taskVecMinLen']
    const arbUpdated = arbKeys.some(k => body[k] !== undefined)
    if (arbUpdated) {
      if (body.arbGap !== undefined) await save('arb_gap', body.arbGap)
      if (body.arbTaskMin !== undefined) await save('arb_task_min', body.arbTaskMin)
      if (body.arbFaqMin !== undefined) await save('arb_faq_min', body.arbFaqMin)
      if (body.arbStrongHit !== undefined) await save('arb_strong_hit', body.arbStrongHit)
      if (body.arbVectorThreshold !== undefined) await save('arb_vector_threshold', body.arbVectorThreshold)
      if (body.arbTaskBoost !== undefined) await save('arb_task_boost', body.arbTaskBoost)
      if (body.taskVecMinLen !== undefined) await save('task_vec_min_len', body.taskVecMinLen)
      // 直接用 body 值刷新 NLU（无需重新读 DB）
      engine.taskEngine?.nlu?.setArbConfig?.({
        gap: body.arbGap,
        taskMin: body.arbTaskMin,
        faqMin: body.arbFaqMin,
        strongHit: body.arbStrongHit,
        vectorThreshold: body.arbVectorThreshold,
        taskBoost: body.arbTaskBoost,
        vecMinLen: body.taskVecMinLen,
      })
    }

    // ===== 高级判定阈值 =====
    if (body.faqCompeteCeiling !== undefined) { await save('faq_compete_ceiling', body.faqCompeteCeiling); engine.faqCompeteCeiling = parseFloat(body.faqCompeteCeiling) }
    if (body.faqCompeteGap !== undefined) { await save('faq_compete_gap', body.faqCompeteGap); engine.faqCompeteGap = parseFloat(body.faqCompeteGap) }
    if (body.llmRerankCeiling !== undefined) { await save('llm_rerank_ceiling', body.llmRerankCeiling); engine.llmRerankCeiling = parseFloat(body.llmRerankCeiling) }
    if (body.shortTextLen !== undefined) { await save('short_text_len', body.shortTextLen); engine.recognizer.shortTextLen = parseInt(body.shortTextLen) || 4 }
    if (body.shortRegexHit !== undefined) { await save('short_regex_hit', body.shortRegexHit); engine.recognizer.shortRegexHit = parseFloat(body.shortRegexHit) }
    if (body.shortContainsHit !== undefined) { await save('short_contains_hit', body.shortContainsHit); engine.recognizer.shortContainsHit = parseFloat(body.shortContainsHit) }

    // ===== 分析/建议阈值 =====
    if (body.analysisRecommendThreshold !== undefined) { await save('analysis_recommend_threshold', body.analysisRecommendThreshold); engine.analysisRecommendThreshold = parseFloat(body.analysisRecommendThreshold) }
    if (body.analysisMaxConfidence !== undefined) { await save('analysis_max_confidence', body.analysisMaxConfidence); engine.analysisMaxConfidence = parseFloat(body.analysisMaxConfidence) }
    // 相似问建议（直接用 body 值，无需重新读 DB）
    if (body.suggestMinLen !== undefined || body.suggestSimThreshold !== undefined || body.suggestKeywordMinScore !== undefined) {
      if (body.suggestMinLen !== undefined) await save('suggest_min_len', body.suggestMinLen)
      if (body.suggestSimThreshold !== undefined) await save('suggest_sim_threshold', body.suggestSimThreshold)
      if (body.suggestKeywordMinScore !== undefined) await save('suggest_keyword_min_score', body.suggestKeywordMinScore)
      taskSuggestService.configure({
        minLen: body.suggestMinLen,
        simThreshold: body.suggestSimThreshold,
        keywordMinScore: body.suggestKeywordMinScore,
      })
    }

    // ===== 相似问自动扩写（直接用 body 值，无需重新读 DB）=====
    if (body.expandEnabled !== undefined || body.expandSimThreshold !== undefined || body.expandMinCount !== undefined) {
      if (body.expandEnabled !== undefined) await save('expand_enabled', body.expandEnabled)
      if (body.expandSimThreshold !== undefined) await save('expand_sim_threshold', body.expandSimThreshold)
      if (body.expandMinCount !== undefined) await save('expand_min_count', body.expandMinCount)
      autoExpandService.configure({
        simThreshold: body.expandSimThreshold,
        minCount: body.expandMinCount,
        enabled: body.expandEnabled,
      })
    }

    // ===== 任务会话超时 =====
    if (body.taskSessionTtlMinutes !== undefined) {
      await save('task_session_ttl_minutes', body.taskSessionTtlMinutes)
      engine.taskEngine?.setSessionTtl?.(parseInt(body.taskSessionTtlMinutes))
    }

    // ===== 固定话术 / 匹配词表 =====
    if (body.replyTexts !== undefined) {
      await save('reply_texts', JSON.stringify(body.replyTexts))
      setReplyTexts(body.replyTexts)
    }
    if (body.matchVocab !== undefined) {
      await save('match_vocab', JSON.stringify(body.matchVocab))
      setMatchVocab(body.matchVocab)
    }

    // ===== LLM 配置（直接用 body 值构建，无需重新读 DB）=====
    if (body.llmEnabled !== undefined || body.llmApiUrl !== undefined || body.llmApiKey !== undefined || body.llmModel !== undefined) {
      if (body.llmEnabled !== undefined) await save('llm_enabled', body.llmEnabled)
      if (body.llmApiUrl !== undefined) await save('llm_api_url', body.llmApiUrl)
      if (body.llmApiKey !== undefined && body.llmApiKey) await save('llm_api_key', body.llmApiKey)
      if (body.llmModel !== undefined) await save('llm_model', body.llmModel)
      // 直接用 body 值构建配置（未传的字段保持现状）
      const envKey = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || ''
      const llmCfg = {
        enabled: body.llmEnabled !== undefined ? body.llmEnabled : llmClient.enabled,
        apiUrl: body.llmApiUrl !== undefined ? body.llmApiUrl : llmClient.config?.apiUrl || '',
        apiKey: body.llmApiKey || envKey,
        model: body.llmModel !== undefined ? body.llmModel : llmClient.config?.model || 'deepseek-chat',
      }
      engine.taskEngine?.setLlmConfig?.(llmCfg)
    }

    // ===== LLM 调用节点 =====
    if (body.llmNodes !== undefined) {
      await save('llm_nodes', JSON.stringify(body.llmNodes))
      llmClient.setNodes(body.llmNodes)
    }

    // 返回完整配置状态
    res.json({
      success: true,
      minConfidence: engine.recognizer.minConfidence,
      clarifyThreshold: engine.clarifyThreshold,
      topK: engine.recognizer.topK,
      meaninglessDetectionMode: engine.meaninglessDetectionMode,
      nluMode: body.nluMode || engine.taskEngine?.nlu?.mode,
      llmEnabled: llmClient.enabled,
    })
  }))

  return router
}
