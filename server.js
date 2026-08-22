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
import FAQEngine from './faq-engine.js'
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

app.use(express.static(PUBLIC_DIR))
app.use('/uploads', express.static(UPLOADS_DIR))

// Vue 管理后台
app.get('/admin', (req, res) => res.redirect('/admin/'))
app.use('/admin', express.static(join(PUBLIC_DIR, 'admin')))

// 兼容旧路径 /admin.html → admin-legacy.html
app.get('/admin.html', (req, res) => res.sendFile(join(PUBLIC_DIR, 'admin-legacy.html')))

// ========== 创建 FAQ 引擎 ==========

const engine = new FAQEngine({
  minConfidence: config.engine.minConfidence,
  clarifyThreshold: config.engine.clarifyThreshold,
  topK: config.engine.topK,
  llm: { enabled: false },
})
engine.meaninglessDetectionMode = config.engine.meaninglessDetectionMode

// ========== 认证中间件 ==========

app.use(authMiddleware)

// 管理限流（聊天接口有自己的限流）
app.use('/api/', adminLimiter)

// ========== 注册路由 ==========

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
    if (dbConfig.llm_enabled === 'true') {
      engine.llmConfig = {
        enabled: true,
        apiUrl: dbConfig.llm_api_url || '',
        apiKey: dbConfig.llm_api_key || '',
        model: dbConfig.llm_model || '',
      }
    }
    if (dbConfig.meaningless_detection_mode) {
      engine.meaninglessDetectionMode = dbConfig.meaningless_detection_mode
    }
    console.log('   ✅ 系统配置已加载')
  } catch (e) {
    console.log('   ⚠️ 使用默认配置')
  }

  // 加载 FAQ 知识库
  console.log('   📚 正在加载 FAQ 知识库...')
  await engine.initialize()
  console.log(`   ✅ FAQ 加载完成，共 ${engine.getIntentCount()} 条`)

  // 启动 HTTP 服务
  const PORT = config.server.port
  const server = app.listen(PORT, () => {
    console.log(`\n🤖 FAQ 问答机器人已启动: http://localhost:${PORT}`)
    console.log(`   环境: ${config.server.env}`)
    console.log(`   请在浏览器中打开上述地址\n`)
  })

  // 定时清理过期会话
  const cleanupTimer = setInterval(() => engine.cleanSessions(), config.session.cleanupInterval)

  // ========== 优雅关闭 ==========
  async function shutdown(signal) {
    console.log(`\n[${signal}] 正在关闭服务...`)

    // 停止接受新连接
    server.close(() => {
      console.log('   ✅ HTTP 服务已关闭')
    })

    // 清理定时器
    clearInterval(cleanupTimer)

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
