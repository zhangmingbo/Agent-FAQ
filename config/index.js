/**
 * 统一配置管理
 * 
 * 集中管理所有配置项，支持 .env 文件和环境变量覆盖
 * 优先级：环境变量 > .env 文件 > 默认值
 */

import 'dotenv/config'

const config = {
  // ========== 服务配置 ==========
  server: {
    port: parseInt(process.env.PORT) || 3001,
    env: process.env.NODE_ENV || 'development',
  },

  // ========== 数据库配置 ==========
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'aibot',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'faqdb',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
  },

  // ========== FAQ 引擎配置 ==========
  engine: {
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE) || 0.5,
    clarifyThreshold: parseFloat(process.env.CLARIFY_THRESHOLD) || 0.65,
    topK: parseInt(process.env.TOP_K) || 5,
    meaninglessDetectionMode: process.env.MEANINGLESS_MODE || 'rule',
  },

  // ========== 大模型配置（运行时从数据库加载） ==========
  llm: {
    enabled: false,
    apiUrl: '',
    apiKey: '',
    model: '',
    systemPrompt: '你是一个智能客服助手，请根据用户的问题提供准确、友好的回答。',
  },

  // ========== 上传配置 ==========
  upload: {
    maxSize: 50 * 1024 * 1024,
    allowedTypes: [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/ogg',
      'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3', 'audio/x-wav',
      'application/pdf',
    ],
  },

  // ========== 会话配置 ==========
  session: {
    // 清理周期：默认 5 分钟一次（任务会话 TTL 默认 30 分钟、可配，清理必须明显更频繁，
    // 否则过期任务要等一个完整清理周期才失效——曾出现任务跨 76 分钟仍存活）
    cleanupInterval: 5 * 60 * 1000,
    maxHistoryLength: 20,
  },

  // ========== 限流配置 ==========
  rateLimit: {
    chat: { windowMs: 60 * 1000, max: 30 },
    admin: { windowMs: 60 * 1000, max: 120 },
  },

  // ========== JWT 认证配置 ==========
  auth: {
    secret: process.env.JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    defaultAdmin: {
      username: process.env.ADMIN_USER || 'admin',
      password: process.env.ADMIN_PASS || '',
    },
  },
}

export default config