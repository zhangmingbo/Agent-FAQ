/**
 * 任务状态持久化适配器
 *
 * 接口统一为：
 *   get(key) / set(key, value, ttlMs) / del(key)  —— 均为 async
 *
 * 实现：
 *   - RedisStore：生产环境（REDIS_URL 配置时启用），TTL 自动过期
 *   - MemoryStore：开发/降级环境（无 Redis 或连接失败），进程内 Map + TTL 扫描
 *
 * 通过 getStore(config) 工厂选择实现，连接失败自动降级到内存并告警。
 */

// ========== 内存实现（降级/开发） ==========

class MemoryStore {
  constructor() {
    this.data = new Map() // key -> { value, expireAt }
  }

  async get(key) {
    const entry = this.data.get(key)
    if (!entry) return null
    if (entry.expireAt && Date.now() > entry.expireAt) {
      this.data.delete(key)
      return null
    }
    return entry.value
  }

  async set(key, value, ttlMs = 0) {
    this.data.set(key, {
      value,
      expireAt: ttlMs ? Date.now() + ttlMs : 0,
    })
    return true
  }

  async del(key) {
    return this.data.delete(key)
  }

  /** 列出匹配前缀的 key（供启动恢复会话） */
  async keys(pattern = '*') {
    const prefix = pattern.replace(/\*/g, '')
    return [...this.data.keys()].filter(k => k.startsWith(prefix))
  }

  /** 清理过期条目（由引擎定时调用） */
  sweep() {
    const now = Date.now()
    for (const [key, entry] of this.data) {
      if (entry.expireAt && now > entry.expireAt) this.data.delete(key)
    }
  }
}

// ========== Redis 实现（生产） ==========

class RedisStore {
  /**
   * @param {import('redis').RedisClientType} client
   */
  constructor(client) {
    this.client = client
  }

  async get(key) {
    const raw = await this.client.get(key)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async set(key, value, ttlMs = 0) {
    const raw = JSON.stringify(value)
    if (ttlMs > 0) {
      await this.client.set(key, raw, { PX: ttlMs })
    } else {
      await this.client.set(key, raw)
    }
    return true
  }

  async del(key) {
    await this.client.del(key)
    return true
  }

  /** 列出匹配前缀的 key（Redis SCAN，供启动恢复会话） */
  async keys(pattern = '*') {
    const keys = []
    for await (const k of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      keys.push(k)
    }
    return keys
  }

  sweep() { /* Redis TTL 自动过期 */ }
}

// ========== 工厂 ==========

let cachedStore = null
let redisClient = null

/**
 * 获取持久化 store 实例（单例）
 * @param {Object} config
 * @param {string} config.driver - 'redis' | 'memory' | 'auto'
 * @param {string} config.url - REDIS_URL
 * @param {number} config.ttl - 会话默认 TTL（毫秒）
 */
export async function getStore(config = {}) {
  if (cachedStore) return cachedStore

  const driver = config.driver || 'auto'
  const useRedis = driver === 'redis' || (driver === 'auto' && config.url)

  if (useRedis) {
    try {
      const { createClient } = await import('redis')
      const client = createClient({ url: config.url })
      client.on('error', (err) => {
        console.error('[TaskFlow] Redis 连接错误:', err.message)
      })
      await client.connect()
      redisClient = client
      cachedStore = new RedisStore(client)
      console.log('[TaskFlow] 任务状态存储: Redis (' + config.url + ')')
      return cachedStore
    } catch (e) {
      console.error('[TaskFlow] Redis 不可用，降级为内存存储:', e.message)
    }
  }

  cachedStore = new MemoryStore()
  console.log('[TaskFlow] 任务状态存储: 内存模式（重启后任务状态丢失）')
  return cachedStore
}

/** 关闭 Redis 连接（服务退出时调用） */
export async function closeStore() {
  if (redisClient) {
    try { await redisClient.quit() } catch { /* ignore */ }
    redisClient = null
  }
  cachedStore = null
}

export { MemoryStore, RedisStore }
