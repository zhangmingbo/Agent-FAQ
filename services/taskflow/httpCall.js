/**
 * 统一接口调用模块（动作系统 v3 P1）
 *
 * 目标：流程中间 api 步骤 与 完成动作 call_api 共用同一套配置结构与执行逻辑。
 *
 * 统一配置结构：
 *   {
 *     url, method, headers,
 *     body: { 接口字段: 值/模板 },        // 模板支持 {slot.xxx} {var.xxx} {result.xxx} {idempotencyKey}
 *     result: { 变量名: 点路径 },          // 出参解析：接口响应 → 上下文变量
 *     retries, timeout, done_message      // done_message 支持 {result.xxx} 插值
 *   }
 *
 * 兼容旧配置（自动归一化）：
 *   fieldMap  { 槽位key: 接口字段 } → body
 *   fixedParams { 接口字段: 固定值 } → body
 *   resultMap { 变量/槽位key: 点路径 } → result
 *   resultSlot / resultField → result[resultSlot] = resultField
 *   successMessage → done_message
 */

import { getReply } from '../replyTexts.js'
import traceService from '../traceService.js'

/** 模板解析：{slot.phone} {var.x} {result.y.z} {idempotencyKey}；{result}（无路径）原样保留，由调用方做主值插值 */
export function resolveTemplate(str, ctx = {}) {
  if (str === undefined || str === null) return str
  return String(str).replace(/\{(slot|var|result|idempotencyKey)(?:\.([\w.-]+))?\}/g, (m, kind, path) => {
    if (kind === 'idempotencyKey') return ctx.idempotencyKey || ''
    if (!path) return m // 无路径（如 {result}）：保留原样
    const src = kind === 'slot' ? (ctx.slots || {}) : kind === 'var' ? (ctx.vars || {}) : (ctx.result || {})
    const v = String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), src)
    return (v === undefined || v === null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))
  })
}

/** body 解析：字符串值做模板替换，对象/数组/数字原样 */
function resolveBody(body, ctx) {
  if (!body || typeof body !== 'object') return body
  const out = Array.isArray(body) ? [] : {}
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && v.includes('{')) out[k] = resolveTemplate(v, ctx)
    else if (v && typeof v === 'object') out[k] = resolveBody(v, ctx)
    else out[k] = v
  }
  return out
}

/** 旧配置 → 统一配置归一化（不动原对象） */
export function normalizeConfig(raw = {}) {
  const c = { ...raw }
  // 入参：新 body 优先；旧 fieldMap/fixedParams 转换
  if (!c.body && (raw.fieldMap || raw.fixedParams)) {
    const body = {}
    if (raw.fieldMap && typeof raw.fieldMap === 'object') {
      for (const [slotKey, apiField] of Object.entries(raw.fieldMap)) {
        setPath(body, apiField, `{slot.${slotKey}}`)
      }
    }
    if (raw.fixedParams && typeof raw.fixedParams === 'object') {
      for (const [k, v] of Object.entries(raw.fixedParams)) {
        if (v && typeof v === 'object') setPath(body, k, v)
        else setPath(body, k, String(v === undefined || v === null ? '' : v))
      }
    }
    c.body = body
  }
  // 出参：新 result 优先；旧 resultMap/resultSlot+resultField 转换
  if (!c.result) {
    const result = {}
    if (raw.resultMap && typeof raw.resultMap === 'object') {
      for (const [k, v] of Object.entries(raw.resultMap)) result[k] = v
    }
    if (raw.resultSlot) result[raw.resultSlot] = raw.resultField || ''
    if (Object.keys(result).length) c.result = result
  }
  if (raw.successMessage && !c.done_message) c.done_message = raw.successMessage
  return c
}

/** 出参解析：按点路径从响应中提取多个变量 */
export function extractResult(j, text, resultMap = {}) {
  const out = {}
  for (const [name, path] of Object.entries(resultMap)) {
    if (!path) { out[name] = text; continue }
    const v = j && String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), j)
    out[name] = (v === undefined || v === null) ? text : (typeof v === 'string' ? v : JSON.stringify(v))
  }
  return out
}

/** 按点路径写入嵌套对象 */
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

/**
 * 投递输出数据（当前 HTTP/Webhook；未来 MQ 在此扩展 delivery 类型）
 */
export async function deliver(payload, cfg = {}) {
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

/**
 * 统一执行一次接口调用
 * @param {Object} rawConfig - 统一/兼容配置
 * @param {Object} ctx - { slots, vars, idempotencyKey, trace }
 * @returns {Promise<{ok, result, results, message, error, vars, log}>}
 *   result = 主值（第一个出参或整个响应）；results = 出参变量表（含 result 主值命名）
 *   vars = 出参变量（供调用方写入 state.vars）
 */
export async function executeHttpCall(rawConfig, ctx = {}) {
  const trace = ctx.trace || null
  const cfg = normalizeConfig(rawConfig || {})
  if (!cfg.url) {
    return { ok: false, result: null, results: {}, message: '接口调用未配置地址', error: '未配置地址', vars: {}, log: { url: null } }
  }

  // 组装入参
  const slots = ctx.slots || {}
  const payload = cfg.body && typeof cfg.body === 'object'
    ? resolveBody(cfg.body, { slots, vars: ctx.vars || {}, result: ctx.result || {}, idempotencyKey: ctx.idempotencyKey })
    : (cfg.body !== undefined ? resolveTemplate(cfg.body, ctx) : { ...slots })

  traceService.traceStep(trace, '任务·调用接口', {
    url: cfg.url,
    method: (cfg.method || 'POST').toUpperCase(),
    payload,
  }, 'task')

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
      break
    }
    lastErr = r.error || `HTTP ${r.status || '?'}`
    responseText = r.text || ''
    if (attempt < retries) await new Promise(res => setTimeout(res, 800))
  }

  // 出参解析
  let result = responseText
  const results = {}
  try {
    const j = JSON.parse(responseText)
    if (cfg.result && typeof cfg.result === 'object' && Object.keys(cfg.result).length) {
      Object.assign(results, extractResult(j, responseText, cfg.result))
      result = Object.values(results)[0] ?? responseText
    } else {
      result = typeof j === 'string' ? j : JSON.stringify(j)
      // 兼容旧 call_api 行为：未配 result 时自动提取常用单号字段（供 {orderNo} 插值）
      const autoOrder = j && (j.orderNo || j.order_no || j.orderId || j.id || j.data?.orderNo || j.data?.order_no)
      if (autoOrder) results.orderNo = String(autoOrder)
    }
  } catch { /* 非 JSON，保留原文 */ }

  // 话术（done_message 支持 {result.xxx} / {result} 主值 / {槽位key} 插值）
  let message = ''
  if (cfg.done_message !== undefined && cfg.done_message !== null) {
    message = resolveTemplate(cfg.done_message, { slots, vars: ctx.vars || {}, result: results })
    message = message.split('{result}').join(String(result))
    for (const [k, v] of Object.entries(results)) {
      message = message.split('{' + k + '}').join(String(v))
    }
  }

  const ok = attempt <= retries
  traceService.traceStep(trace, '任务·接口结果', {
    ok,
    response: responseText,
    result,
    results: Object.keys(results).length ? results : undefined,
  }, ok ? 'task' : 'error')

  return {
    ok,
    result,
    results,
    message,
    error: ok ? undefined : lastErr,
    vars: results,
    log: { url: cfg.url, payload, response: responseText.slice(0, 2000), retries: attempt },
  }
}
