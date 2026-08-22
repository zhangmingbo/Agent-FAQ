/**
 * 任务对话状态机
 *
 * 状态：
 *   idle       未开始
 *   collecting 正在收集槽位（顺序执行 collect 步骤）
 *   confirming 槽位收集完毕，等待用户确认
 *   executing  正在执行完成动作
 *   done       已完成
 *   cancelled  已取消
 *
 * 转移规则（from → to → 条件）：
 *   idle → collecting        触发词命中
 *   collecting → confirming  全部必填槽位已填
 *   collecting → cancelled   用户取消
 *   confirming → executing   用户确认
 *   confirming → collecting  用户否认 / 纠正槽位
 *   confirming → cancelled   用户取消
 *   executing → done         动作执行成功
 *   executing → collecting   动作执行失败（回退重试）
 *   * → cancelled            任意状态可取消
 *
 * 注意：任务中的"挂起/恢复"（SUSPENDED）由引擎层隐式处理——
 *   提取失败时任务状态保留在 store 中，用户插话 FAQ 后返回即可继续，
 *   无需显式状态位，因此不在此状态机中单独建模。
 */

export const TaskState = Object.freeze({
  IDLE: 'idle',
  COLLECTING: 'collecting',
  CONFIRMING: 'confirming',
  EXECUTING: 'executing',
  DONE: 'done',
  CANCELLED: 'cancelled',
})

/**
 * 允许的转移表：from -> Set(to)
 */
const TRANSITIONS = {
  [TaskState.IDLE]: new Set([TaskState.COLLECTING]),
  [TaskState.COLLECTING]: new Set([TaskState.CONFIRMING, TaskState.CANCELLED]),
  [TaskState.CONFIRMING]: new Set([TaskState.EXECUTING, TaskState.COLLECTING, TaskState.CANCELLED]),
  [TaskState.EXECUTING]: new Set([TaskState.DONE, TaskState.COLLECTING]),
  [TaskState.DONE]: new Set(),
  [TaskState.CANCELLED]: new Set(),
}

/**
 * 尝试状态转移
 * @param {string} from
 * @param {string} to
 * @returns {boolean} 是否允许并已转移
 */
export function canTransition(from, to) {
  if (from === to) return true
  const allowed = TRANSITIONS[from]
  return !!(allowed && allowed.has(to))
}

/**
 * 校验状态机一致性（供测试使用）
 */
export function validateTransitions() {
  const errors = []
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      if (!TRANSITIONS[to]) errors.push(`${from} -> ${to}（目标状态未定义）`)
    }
  }
  return errors
}
