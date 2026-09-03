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
 * 工厂：
 *   getStore({ driver, url, ttl }) → MemoryStore | RedisStore
 *   closeStore() → 关闭 Redis 连接（优雅退出用）
 */

import { createClient } from 'redis'

// ========== MemoryStore ==========

class MemoryStore {
  constructor() {
    this._map = new Map()
    this._timer = setInterval(() => this._sweep(), 60_000)
  }

  async get(key) {
    const entry = this._map.get(key)
    if (!entry) return null
    if (entry.expireAt && Date.now() > entry.expireAt) {
      this._map.delete(key)
      return null
    }
    return entry.value
  }

  async set(key, value, ttlMs) {
    this._map.set(key, {
      value,
      expireAt: ttlMs ? Date.now() + ttlMs : null,
    })
  }

  async del(key) {
    this._map.delete(key)
  }

  async keys(pattern) {
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    return [...this._map.keys()].filter(k => re.test(k))
  }

  _sweep() {
    const now = Date.now()
    for (const [key, entry] of this._map) {
      if (entry.expireAt && now > entry.expireAt) this._map.delete(key)
    }
  }

  close() {
    clearInterval(this._timer)
  }
}

// ========== RedisStore ==========

class RedisStore {
  constructor(url, ttl) {
    this._redis = createClient({ url })
    this._redis.on('error', (err) => console.error('[TaskFlow] Redis error:', err.message))
    this._ttl = ttl
    this._connected = false
  }

  async _ensure() {
    if (this._connected) return
    await this._redis.connect()
    this._connected = true
  }

  async get(key) {
    await this._ensure()
    const raw = await this._redis.get(key)
    return raw ? JSON.parse(raw) : null
  }

  async set(key, value, ttlMs) {
    await this._ensure()
    const ttl = Math.ceil((ttlMs || this._ttl) / 1000)
    await this._redis.set(key, JSON.stringify(value), { EX: ttl })
  }

  async del(key) {
    await this._ensure()
    await this._redis.del(key)
  }

  async keys(pattern) {
    await this._ensure()
    return this._redis.keys(pattern)
  }

  async close() {
    if (this._connected) {
      await this._redis.quit()
      this._connected = false
    }
  }
}

// ========== 工厂 ==========

let _currentStore = null

/**
 * 获取存储实例
 * @param {{ driver?: 'memory'|'redis', url?: string, ttl?: number }} options
 */
export async function getStore(options = {}) {
  const driver = options.driver || (options.url ? 'redis' : 'memory')

  if (driver === 'redis' && options.url) {
    try {
      const store = new RedisStore(options.url, options.ttl)
      await store._ensure()
      console.log('[TaskFlow] Redis 连接成功')
      _currentStore = store
      return store
    } catch (e) {
      console.warn('[TaskFlow] Redis 连接失败，降级到 MemoryStore:', e.message)
    }
  }

  console.log('[TaskFlow] 使用 MemoryStore（进程内存储）')
  _currentStore = new MemoryStore()
  return _currentStore
}

/** 关闭当前存储（优雅退出用） */
export async function closeStore() {
  if (_currentStore) {
    await _currentStore.close()
    _currentStore = null
  }
}

export { MemoryStore, RedisStore }
