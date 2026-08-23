/**
 * 对话处理轨迹追踪器（可视化调试用）
 *
 * 目标：把每轮对话"后端做了什么"记录下来，前端渲染成交互图。
 * 原则：
 *   - 只记录不改变行为（纯旁路观测）
 *   - 内存存储（管理后台调试用，不需要跨重启保留）
 *   - 每轮一个会话的步骤链：{ step, detail, time }
 *
 * 埋点由 faq-engine 在关键决策处调用 trace.push()，
 * 本服务只负责存储与查询，不参与对话逻辑。
 */

/** 内存轨迹存储：sessionId -> [{ steps: [...], input, output, duration }] */
const store = new Map()
const MAX_TURNS_PER_SESSION = 50 // 每个会话最多保留的轮次
const MAX_SESSIONS = 200 // 内存中最多保留的会话

/**
 * 开始一轮对话轨迹（chat() 入口调用）
 * @returns {Array} 本轮 steps 数组（埋点往里 push）
 */
export function startTurn(sessionId) {
  const session = _getOrCreate(sessionId)
  const turn = { steps: [], startedAt: Date.now() }
  session.turns.push(turn)
  if (session.turns.length > MAX_TURNS_PER_SESSION) session.turns.shift()
  return turn.steps
}

/**
 * 追加一步处理记录
 * @param {Array} steps - startTurn 返回的数组
 * @param {string} step - 步骤名（如 '路由判定'）
 * @param {Object} detail - 详情（如 { route: 'faq' }）
 * @param {string} level - 'info' | 'warn' | 'error' | 'llm' | 'rule' | 'task'
 */
export function traceStep(steps, step, detail = {}, level = 'info') {
  if (!steps) return
  steps.push({
    step,
    detail,
    level,
    time: Date.now(),
  })
}

/** 结束一轮对话（chat() 返回前调用）：补上输出摘要 */
export function endTurn(sessionId, steps, { input, output, duration }) {
  const session = _getOrCreate(sessionId)
  const turn = session.turns[session.turns.length - 1]
  if (turn && turn.steps === steps) {
    turn.input = input
    turn.output = output
    turn.duration = duration
    turn.endedAt = Date.now()
  }
}

/** 获取某个会话的完整轨迹（按时间正序：最早一轮在上，与对话时间顺序一致） */
export function getSessionTrace(sessionId) {
  const session = store.get(sessionId)
  if (!session) return { sessionId, turns: [] }
  return {
    sessionId,
    turns: session.turns.slice(-MAX_TURNS_PER_SESSION),
  }
}

/** 列出最近有轨迹的会话（倒序） */
export function listSessions(limit = 20) {
  return [...store.entries()]
    .map(([sessionId, s]) => ({
      sessionId,
      turns: s.turns.length,
      lastActive: s.lastActive,
      lastInput: s.turns[s.turns.length - 1]?.input || '',
      lastOutput: s.turns[s.turns.length - 1]?.output || '',
    }))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, limit)
}

function _getOrCreate(sessionId) {
  let s = store.get(sessionId)
  if (!s) {
    s = { turns: [], lastActive: Date.now() }
    store.set(sessionId, s)
    // 防止无限增长
    if (store.size > MAX_SESSIONS) {
      const oldest = [...store.keys()].shift()
      store.delete(oldest)
    }
  }
  s.lastActive = Date.now()
  return s
}

/** 清空轨迹（调试用） */
export function clearAll() {
  store.clear()
}

export default { startTurn, traceStep, endTurn, getSessionTrace, listSessions, clearAll }
