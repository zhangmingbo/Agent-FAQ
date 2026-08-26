/**
 * FAQ 问答机器人 - 服务入口
 * 
 * 运行: node server.js
 * 访问: http://localhost:3001
 */

import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync } from 'fs'

import config from './config/index.js'
import pool from './db/pool.js'
import FAQEngine, { DEFAULT_FEEDBACK_WORDS, DEFAULT_COMPLAINT_WORDS } from './faq-engine.js'
import FaqService from './services/faqService.js'
import { initPrompts } from './services/llmPrompts.js'
import ruleLoader from './rules/ruleLoader.js'
import dialogueRules from './rules/dialogueRules.js'

// 中间件
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { authMiddleware, createAuthRouter } from './middleware/auth.js'
import { adminLimiter } from './middleware/rateLimit.js'

// 路由
import { createRouter as createChatRouter } from './routes/chat.js'
import { createRouter as createFaqRouter } from './routes/faq.js'
import { createRouter as createCategoryRouter } from './routes/category.js'
import { createRouter as createStatsRouter } from './routes/stats.js'
import { createRouter as createChatLogRouter } from './routes/chatLog.js'
import { createRouter as createAnalysisRouter } from './routes/analysis.js'
import { createRouter as createConfigRouter } from './routes/config.js'
import { createRouter as createDialogueRulesRouter } from './routes/dialogueRules.js'
import { createRouter as createUploadRouter } from './routes/upload.js'
import { createRouter as createHealthRouter } from './routes/health.js'
import { createRouter as createTasksRouter } from './routes/tasks.js'
import { createRouter as createDebugRouter } from './routes/debug.js'
import { createRouter as createActionLogRouter } from './routes/actionLogs.js'
import taskEngine from './services/taskflow/index.js'
import taskSuggestService from './services/taskSuggestService.js'
import autoExpandService from './services/autoExpandService.js'
import { initReplyTexts, getAllReplyTexts, DEFAULT_REPLY_TEXTS } from './services/replyTexts.js'
import { initMatchVocab, getAllMatchVocab, DEFAULT_MATCH_VOCAB } from './services/matchVocab.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ========== 创建 Express 应用 ==========

const app = express()

// 基础中间件
app.use(cors())
app.use(express.json({ limit: '50mb' }))

// 静态文件
const PUBLIC_DIR = join(__dirname, 'public')
const UPLOADS_DIR = join(__dirname, 'uploads')
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true })

// Vue 管理后台（no-cache：管理界面脚本经常更新，禁止浏览器缓存旧版）
// 注意：必须放在根静态之前，否则 /admin/* 会被下面的 express.static(PUBLIC_DIR) 先拦截
// （serve-static 自带 /admin → /admin/ 目录重定向，无需手动 redirect 路由）
app.use('/admin', (req, res, next) => {
  // 强制改写 Cache-Control（send 内部会按 maxAge 设置，这里统一覆盖为 no-cache）
  const setHeader = res.setHeader.bind(res)
  res.setHeader = (name, value) => {
    if (String(name).toLowerCase() === 'cache-control') value = 'no-cache'
    return setHeader(name, value)
  }
  next()
})
app.use('/admin', express.static(join(PUBLIC_DIR, 'admin')))

app.use(express.static(PUBLIC_DIR))
app.use('/uploads', express.static(UPLOADS_DIR))

// 兼容旧路径 /admin.html → admin-legacy.html
app.get('/admin.html', (req, res) => res.sendFile(join(PUBLIC_DIR, 'admin-legacy.html')))

// ========== 创建 FAQ 引擎 ==========

// 知识库领域服务（持有识别器与答案缓存，供引擎与路由共享）
const faqService = new FaqService({
  minConfidence: config.engine.minConfidence,
  topK: config.engine.topK,
})

const engine = new FAQEngine({
  faqService,
  clarifyThreshold: config.engine.clarifyThreshold,
  llm: { enabled: false },
})
engine.meaninglessDetectionMode = config.engine.meaninglessDetectionMode

// ========== 认证中间件 ==========

app.use(authMiddleware)

// 管理限流（聊天接口有自己的限流）
app.use('/api/', adminLimiter)

// ========== 注册路由 ==========

// 假接口（联调测试用）：任务"调用接口"步骤可直接指向 /api/mock/xxx
// 返回 OrderNo（兼容 orderNo/orrder_num/order_num 字段名，含 data.* 层级），并回显请求体
app.use('/api/mock', (req, res) => {
  const orderNo = 'QY' + new Date().toISOString().replace(/\D/g, '').slice(0, 14) + String(Math.floor(Math.random() * 900) + 100)
  const received = (req.body && typeof req.body === 'object') ? req.body : {}
  res.json({
    code: 0,
    message: 'success',
    orderNo,
    orrder_num: orderNo,
    order_num: orderNo,
    data: { orderNo, orrder_num: orderNo, order_num: orderNo, status: '已受理', received },
  })
})

// 健康检查
app.use('/api', createHealthRouter(engine))

// 认证路由
app.use('/api/auth', createAuthRouter())

// 业务路由
app.use('/api', createChatRouter(engine))
app.use('/api', createFaqRouter(engine))
app.use('/api', createCategoryRouter(engine))
app.use('/api', createStatsRouter(engine))
app.use('/api', createChatLogRouter(engine))
app.use('/api', createAnalysisRouter(engine))
app.use('/api', createConfigRouter(engine))
app.use('/api', createDialogueRulesRouter(engine, ruleLoader, dialogueRules))
app.use('/api', createUploadRouter(engine, UPLOADS_DIR))
app.use('/api', createTasksRouter())
app.use('/api', createDebugRouter())
app.use('/api', createActionLogRouter())

// ========== 错误处理 ==========

app.use(notFoundHandler)
app.use(errorHandler)

// ========== 启动服务 ==========

async function start() {
  console.log('\n🤖 FAQ 问答机器人正在启动...')

  // 从数据库加载配置
  try {
    const configRepo = await import('./repositories/configRepo.js')
    const dbConfig = await configRepo.getAll()

    if (dbConfig.min_confidence) engine.recognizer.minConfidence = parseFloat(dbConfig.min_confidence)
    if (dbConfig.clarify_threshold) engine.clarifyThreshold = parseFloat(dbConfig.clarify_threshold)
    if (dbConfig.top_k) engine.recognizer.topK = parseInt(dbConfig.top_k)
    // LLM 连接/节点配置由共享模块 llmClient 统一管理（taskEngine.initialize 加载并自动落库 llm_nodes）
    if (dbConfig.meaningless_detection_mode) {
      engine.meaninglessDetectionMode = dbConfig.meaningless_detection_mode
    }
    // 高级判定阈值（FAQ 候选竞争 / LLM 重排 / 短句防护）
    if (dbConfig.faq_compete_ceiling) engine.faqCompeteCeiling = parseFloat(dbConfig.faq_compete_ceiling)
    if (dbConfig.faq_compete_gap) engine.faqCompeteGap = parseFloat(dbConfig.faq_compete_gap)
    if (dbConfig.llm_rerank_ceiling) engine.llmRerankCeiling = parseFloat(dbConfig.llm_rerank_ceiling)
    if (dbConfig.short_text_len) engine.recognizer.shortTextLen = parseInt(dbConfig.short_text_len)
    if (dbConfig.short_regex_hit) engine.recognizer.shortRegexHit = parseFloat(dbConfig.short_regex_hit)
    if (dbConfig.short_contains_hit) engine.recognizer.shortContainsHit = parseFloat(dbConfig.short_contains_hit)
    // 分析/建议阈值
    if (dbConfig.analysis_recommend_threshold) engine.analysisRecommendThreshold = parseFloat(dbConfig.analysis_recommend_threshold)
    if (dbConfig.analysis_max_confidence) engine.analysisMaxConfidence = parseFloat(dbConfig.analysis_max_confidence)
    taskSuggestService.configure({
      minLen: dbConfig.suggest_min_len,
      simThreshold: dbConfig.suggest_sim_threshold,
      keywordMinScore: dbConfig.suggest_keyword_min_score,
    })
    await taskSuggestService.loadIgnored()
    // 相似问自动扩写（第二批 C：配置 → sys_config，数据 → expand_audit，逻辑 → autoExpandService）
    autoExpandService.configure({
      simThreshold: dbConfig.expand_sim_threshold,
      minCount: dbConfig.expand_min_count,
      enabled: dbConfig.expand_enabled === undefined ? true : dbConfig.expand_enabled !== 'false',
    })
    if (dbConfig.expand_sim_threshold === undefined) await configRepo.set('expand_sim_threshold', '0.75')
    if (dbConfig.expand_min_count === undefined) await configRepo.set('expand_min_count', '2')
    if (dbConfig.expand_enabled === undefined) await configRepo.set('expand_enabled', 'true')
    // 答案反馈信号词（运营可配，默认仅首次落库）
    if (!dbConfig.feedback_trigger_words) {
      await configRepo.set('feedback_trigger_words', JSON.stringify(DEFAULT_FEEDBACK_WORDS))
    }
    try { engine.feedbackTriggerWords = JSON.parse(dbConfig.feedback_trigger_words || '[]') } catch { engine.feedbackTriggerWords = DEFAULT_FEEDBACK_WORDS }
    // 投诉情绪兜底信号词（运营可配，默认仅首次落库）
    if (!dbConfig.complaint_trigger_words) {
      await configRepo.set('complaint_trigger_words', JSON.stringify(DEFAULT_COMPLAINT_WORDS))
      engine.complaintTriggerWords = DEFAULT_COMPLAINT_WORDS
    } else {
      try { engine.complaintTriggerWords = JSON.parse(dbConfig.complaint_trigger_words) } catch { engine.complaintTriggerWords = DEFAULT_COMPLAINT_WORDS }
    }
    // 固定话术 / 匹配词表（首次启动自动落库，之后以库为准）
    if (!dbConfig.reply_texts) {
      await configRepo.set('reply_texts', JSON.stringify(DEFAULT_REPLY_TEXTS))
    }
    if (!dbConfig.match_vocab) {
      await configRepo.set('match_vocab', JSON.stringify(DEFAULT_MATCH_VOCAB))
    }
    initReplyTexts(dbConfig)
    initMatchVocab(dbConfig)
    console.log('   ✅ 系统配置已加载')
  } catch (e) {
    console.log('   ⚠️ 使用默认配置')
  }

  // 加载 FAQ 知识库
  console.log('   📚 正在加载 FAQ 知识库...')
  await engine.initialize()
  console.log(`   ✅ FAQ 加载完成，共 ${engine.getIntentCount()} 条`)
  
  // 加载 LLM 提示词注册表（运营配置，管理后台可编辑）
  try {
    await initPrompts()
    console.log('   ✅ LLM 提示词已加载')
  } catch (e) {
    console.log('   ⚠️ LLM 提示词加载失败，使用默认值:', e.message)
  }

  // 初始化任务引擎
  console.log('   📋 正在加载任务流程...')
  await taskEngine.initialize()
  // 接入共享 NLP 引擎（复用 FAQ 识别器已加载的向量模型，支持语义触发）
  await taskEngine.setNlpEngine(engine.recognizer.nlpEngine)
  // 注入 FAQ 例句向量源（同一模型编码，任务 vs FAQ 统一语义仲裁用）
  taskEngine.nlu.setFaqSamples(engine.recognizer.allSamples)
  // 相似问自动扩写：共享同一 NLP 引擎 + FAQ 例句样本（第一批数据驱动，第二批 C）
  autoExpandService.setNlpEngine(engine.recognizer.nlpEngine, engine.recognizer.allSamples)
  autoExpandService.setFaqService(engine.faqService)
  engine.taskEngine = taskEngine
  console.log(`   ✅ 任务加载完成，共 ${taskEngine.taskDefs.size} 个`)

  // 启动 HTTP 服务
  const PORT = config.server.port
  const server = app.listen(PORT, () => {
    console.log(`\n🤖 FAQ 问答机器人已启动: http://localhost:${PORT}`)
    console.log(`   环境: ${config.server.env}`)
    console.log(`   请在浏览器中打开上述地址\n`)
  })

  // 定时清理过期会话（FAQ 会话 + 任务会话）
  const cleanupTimer = setInterval(() => {
    engine.cleanSessions()
    taskEngine.cleanupStale().catch(e => console.error('[TaskFlow] 清理失败:', e.message))
  }, config.session.cleanupInterval)

  // 表达挖掘后台预计算：推理完全在后台做，前端打开页面只读结果（不阻塞启动）
  const suggestRefresh = () => {
    taskSuggestService.setNlpEngine(engine.recognizer.nlpEngine)
    taskSuggestService.refreshCache({
      taskDefs: taskEngine.taskDefs,
      vectors: taskEngine.nlu._vectors,
    }).catch(e => console.error('[Suggest] 后台预计算异常:', e.message))
  }
  const SUGGEST_REFRESH_MS = 10 * 60 * 1000 // 每 10 分钟后台重算一次（日志有新数据才变化）
  const suggestTimer = setInterval(suggestRefresh, SUGGEST_REFRESH_MS)
  suggestRefresh() // 启动后立即预计算一次

  // ========== 优雅关闭 ==========
  async function shutdown(signal) {
    console.log(`\n[${signal}] 正在关闭服务...`)

    // 停止接受新连接
    server.close(() => {
      console.log('   ✅ HTTP 服务已关闭')
    })

    // 清理定时器
    clearInterval(cleanupTimer)
    clearInterval(suggestTimer)

    // 关闭任务引擎存储（Redis 连接）
    try {
      await taskEngine.stop()
      console.log('   ✅ 任务存储已关闭')
    } catch (e) {
      console.error('   ⚠️ 关闭任务存储失败:', e.message)
    }

    // 关闭数据库连接池
    try {
      await pool.end()
      console.log('   ✅ 数据库连接已关闭')
    } catch (e) {
      console.error('   ⚠️ 关闭数据库连接失败:', e.message)
    }

    console.log('   👋 服务已安全退出\n')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // 未捕获异常处理
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] 未捕获异常:', err)
    shutdown('uncaughtException')
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] 未处理的 Promise 拒绝:', reason)
  })
}

start().catch(err => {
  console.error('[FATAL] 启动失败:', err)
  process.exit(1)
})
