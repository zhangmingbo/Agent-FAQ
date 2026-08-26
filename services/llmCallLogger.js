/**
 * LLM 调用日志记录器（可视化调试用）
 *
 * 目标：把系统每次调用 LLM 的请求/响应/耗时/节点记录下来，
 * 在「会话调试」页按会话查看，用于排查 LLM 行为（如"电脑坏了"被消化成任务话术）。
 *
 * 原则：
 *   - 只记录不改变行为（纯旁路观测）
 *   - 内存存储（管理后台调试用，重启清空，与 traceService 一致）
 *   - 关联 sessionId（faq-engine 调用 LLM 的环节传入；无法关联的记为 null）
 */

/** 内存存储：Array<record>，倒序插入（最新在前） */
let store = []
const MAX_RECORDS = 1000 // 内存最多保留的调用记录

/** 当前正在处理的会话（faq-engine 每轮 chat 入口设置；LLM 埋点读取关联） */
let currentSession = null

/** 设置当前会话（faq-engine chat() 入口调用） */
export function setCurrentSession(sessionId) {
  currentSession = sessionId || null
}

/** 读取当前会话（控制台打印 LLM 调用时关联用） */
export function getCurrentSession() {
  return currentSession
}

/**
 * 记录一次 LLM 调用（llmClient.chat 埋点调用）
 * @param {Object} r - { node, model, messages, response, status, error, durationMs, sessionId? }
 */
export function log(r = {}) {
  const record = {
    id: (store[0]?.id || 0) + 1,
    sessionId: r.sessionId || currentSession || null,
    node: r.node || 'unknown',
    model: r.model || '',
    system: _truncate(r.messages?.find?.(m => m.role === 'system')?.content || ''),
    user: _truncate(r.messages?.find?.(m => m.role === 'user')?.content || ''),
    response: _truncate(r.response || ''),
    status: r.status || 'ok', // ok | error
    error: r.error || '',
    durationMs: r.durationMs || 0,
    promptSource: r.promptSource || null, // { system, user }: task/global/default（调试：提示词来源）
    time: Date.now(),
  }
  store.unshift(record)
  if (store.length > MAX_RECORDS) store.length = MAX_RECORDS
  return record
}

/**
 * 查询 LLM 调用日志
 * @param {Object} opts - { sessionId?, limit? }
 * @returns {Array} 按时间倒序（最新在前）
 */
export function query({ sessionId, limit = 50 } = {}) {
  let rows = store
  if (sessionId) rows = rows.filter(r => r.sessionId === sessionId)
  return rows.slice(0, limit)
}

/** 统计（调试页概览用） */
export function stats(limit = 20) {
  return store.slice(0, limit).map(r => ({
    id: r.id,
    sessionId: r.sessionId,
    node: r.node,
    status: r.status,
    durationMs: r.durationMs,
    time: r.time,
  }))
}

/** 清空（调试用） */
export function clear() {
  store = []
}

function _truncate(s, n = 400) {
  const t = String(s || '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

export default { log, query, stats, clear, setCurrentSession, getCurrentSession }
