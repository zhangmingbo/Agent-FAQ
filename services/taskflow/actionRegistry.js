/**
 * 任务动作注册表（v2：输出型动作）
 *
 * 定位：任务流程引擎不记录业务数据；动作 = 把收集的数据「输出」给外部系统
 *   - call_api          通过 HTTP 调用外部接口（Webhook 本质）：支持重试/超时/出参提取/入参映射
 *   - complete_message  仅回复完成话术（无副作用）
 *   - transfer_human    转人工提示
 *
 * 动作签名：async (ctx) => { ok:boolean, message?:string, error?:string, log?:{...} }
 *   ctx = { sessionId, task, state, slots: {key: value}, step, params }
 *   log（可选）：{ url, payload, response, retries } —— runAction 统一写入 action_log，
 *   作为流程引擎的输出审计（外部系统未就绪时在此查看/补发），不存储业务数据。
 *
 * 未来扩展：投递抽象 deliver(payload, cfg)，当前实现 HTTP(Webhook)，
 * 支持 MQ 时新增 delivery:'mq' 分支，业务代码不变。
 */

import pool from '../../db/pool.js'
import { getReply } from '../replyTexts.js'

const actions = new Map()

/** 注册动作 */
export function register(name, fn) {
  if (typeof fn !== 'function') throw new Error(`动作 ${name} 必须是函数`)
  actions.set(name, fn)
}

/** 执行动作（统一记录 action_log：成败都记，payload 为输出快照） */
export async function runAction(name, ctx) {
  const start = Date.now()
  const fn = actions.get(name)
  if (!fn) {
    await logAction(ctx, { action: name, status: 'fail', error: `动作「${name}」未注册`, durationMs: 0 })
    return { ok: false, message: `动作「${name}」未注册` }
  }
  try {
    const result = await fn(ctx)
    const ok = result && typeof result.ok === 'boolean' ? result.ok : true
    const lg = result?.log || {}
    await logAction(ctx, {
      action: name,
      status: ok ? 'ok' : 'fail',
      error: ok ? undefined : (result?.error || result?.message),
      url: lg.url,
      payload: lg.payload,
      response: lg.response,
      retries: lg.retries ?? 0,
      durationMs: Date.now() - start,
    })
    return { ok, message: (result && result.message) || '完成' }
  } catch (e) {
    console.error(`[TaskFlow] 动作 ${name} 执行失败:`, e.message)
    await logAction(ctx, { action: name, status: 'fail', error: e.message, durationMs: Date.now() - start })
    return { ok: false, message: e.message }
  }
}

/** 获取已注册动作列表（供管理后台下拉选择） */
export function listActions() {
  return [...actions.keys()]
}

// ========== action_log（输出审计） ==========

/** 建表（服务启动时调用） */
export async function ensureActionLogTable() {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS action_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(100),
      task_code VARCHAR(50),
      action VARCHAR(50),
      status VARCHAR(10) COMMENT 'ok=成功 fail=失败',
      url VARCHAR(500),
      payload JSON NULL COMMENT '输出数据快照（不落业务库，仅供联调/补发）',
      response TEXT,
      error VARCHAR(500),
      retries TINYINT DEFAULT 0,
      duration_ms INT DEFAULT 0,
      resent_at DATETIME NULL COMMENT '重发成功时间（业务系统恢复后补数据）',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_action_log_session (session_id),
      KEY idx_action_log_task (task_code),
      KEY idx_action_log_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  )
}

/** 记录一条动作日志 */
async function logAction(ctx, entry) {
  try {
    await pool.execute(
      `INSERT INTO action_log (session_id, task_code, action, status, url, payload, response, error, retries, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx?.sessionId || null,
        ctx?.task?.code || null,
        entry.action,
        entry.status,
        entry.url || null,
        entry.payload !== undefined ? JSON.stringify(entry.payload) : null,
        entry.response || null,
        entry.error || null,
        entry.retries ?? 0,
        entry.durationMs ?? 0,
      ]
    )
  } catch (e) {
    console.error('[TaskFlow] action_log 写入失败:', e.message)
  }
}

// ========== 投递抽象（当前 HTTP/Webhook，未来 MQ 在此扩展） ==========

/**
 * 投递输出数据
 * @param {Object} payload - 输出数据
 * @param {Object} cfg - { url, method, headers, timeout, delivery }
 * @returns {Promise<{ok:boolean, status?:number, text?:string, error?:string}>}
 */
async function deliver(payload, cfg) {
  if (cfg.delivery === 'mq') {
    return { ok: false, error: '消息队列投递未实现（当前仅支持 HTTP/Webhook）' }
  }
  const method = (cfg.method || 'POST').toUpperCase()
  const timeoutMs = Math.max(1000, parseInt(cfg.timeout) || 10000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(cfg.url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
      body: method === 'GET' ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : e.message }
  } finally {
    clearTimeout(timer)
  }
}

// ========== 内置动作 ==========

register('complete_message', async (ctx) => {
  return { ok: true, message: ctx.step?.done_message || ctx.task.completion_message || getReply('complete_fallback', { taskName: ctx.task.name }) }
})

register('transfer_human', async () => {
  return { ok: true, message: getReply('transfer_human') }
})

/**
 * 输出动作：把收集的槽位数据投递到外部接口（Webhook）
 * 配置（任务级 api_action 或步骤级 params，后者优先合并）：
 *   { url, method, headers, fieldMap, fixedParams, successMessage, retries, timeout }
 *   - fieldMap：{ 槽位key: 接口字段名 }；未配置则传全部槽位
 *   - fixedParams：固定入参（覆盖同名字段）
 *   - successMessage：成功话术（支持 {orderNo} 占位符）
 *   - retries：失败重试次数（默认 3），timeout：超时毫秒（默认 10000）
 */
register('call_api', async (ctx) => {
  const stepCfg = ctx.step?.params || {}
  const cfg = { ...(ctx.task?.api_action || {}), ...stepCfg }
  if (!cfg.url) {
    return { ok: false, message: '未配置输出接口地址（任务「完成动作」或步骤 params.url）', error: '未配置输出接口地址' }
  }

  // 组装输出数据
  const slots = ctx.slots || {}
  let payload
  if (cfg.fieldMap && Object.keys(cfg.fieldMap).length) {
    payload = {}
    for (const [slotKey, apiField] of Object.entries(cfg.fieldMap)) {
      const v = slots[slotKey]
      setPath(payload, apiField, (v !== undefined && v !== null) ? String(v) : '')
    }
  } else {
    payload = { ...slots }
  }
  if (cfg.fixedParams && typeof cfg.fixedParams === 'object') {
    for (const [k, v] of Object.entries(cfg.fixedParams)) {
      if (v && typeof v === 'object') setPath(payload, k, v)
      else setPath(payload, k, String(v === undefined || v === null ? '' : v))
    }
  }

  // 投递 + 重试
  const retryN = parseInt(cfg.retries, 10)
  const retries = Number.isNaN(retryN) ? 3 : Math.max(0, retryN)
  let lastErr = ''
  let responseText = ''
  let attempt = 0
  for (; attempt <= retries; attempt++) {
    const r = await deliver(payload, cfg)
    if (r.ok) {
      responseText = r.text || ''
      // 出参提取（业务单号等，供 {orderNo} 插值）
      let orderNo = ''
      try {
        const d = JSON.parse(responseText)
        orderNo = d?.orderNo || d?.order_no || d?.orderId || d?.id || d?.data?.orderNo || d?.data?.order_no || ''
      } catch { /* 非 JSON */ }
      let message = cfg.successMessage || getReply('api_action_done')
      if (orderNo) message = message.split('{orderNo}').join(String(orderNo))
      return { ok: true, message, log: { url: cfg.url, payload, response: responseText.slice(0, 2000), retries: attempt } }
    }
    lastErr = r.error || `HTTP ${r.status || '?'}`
    responseText = r.text || ''
    if (attempt < retries) await new Promise(res => setTimeout(res, 800))
  }
  console.error(`[TaskFlow] 输出动作失败(重试${retries}次): ${lastErr}`)
  return {
    ok: false,
    message: getReply('api_action_fail', { code: '' }),
    error: lastErr,
    log: { url: cfg.url, payload, response: responseText.slice(0, 2000), retries: attempt },
  }
})

/** 按点路径写入嵌套对象：setPath(obj, 'data.phone', v) → obj.data.phone = v */
function setPath(obj, path, value) {
  const keys = String(path).split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
}

export default { register, runAction, listActions, ensureActionLogTable, deliver }
export { deliver }
