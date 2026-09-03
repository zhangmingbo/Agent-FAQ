/**
 * 会话调试 API 封装
 */
import http from '@/utils/http'

/**
 * 获取会话列表
 * @param {number} limit - 返回条数，默认20
 */
export function getSessionList(limit = 20) {
  return http.get('/api/debug/sessions', { params: { limit } })
}

/**
 * 获取会话详细轨迹
 * @param {string} sessionId - 会话ID
 */
export function getSessionTrace(sessionId) {
  return http.get(`/api/debug/session/${sessionId}`)
}

/**
 * 获取LLM调用日志
 * @param {Object} params - 查询参数
 * @param {string} params.sessionId - 可选，按会话ID筛选
 * @param {number} params.limit - 返回条数，默认50
 */
export function getLlmCalls(params = {}) {
  return http.get('/api/debug/llm-calls', { params })
}

/**
 * 清空所有轨迹
 */
export function clearAllTraces() {
  return http.post('/api/debug/clear')
}

/**
 * 清空LLM日志
 */
export function clearLlmCalls() {
  return http.post('/api/debug/llm-calls/clear')
}
