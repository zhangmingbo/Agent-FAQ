/**
 * 任务动作注册表（v2/v3：输出型动作 + 统一接口调用）
 *
 * 定位：任务流程引擎不记录业务数据；动作 = 把收集的数据「输出」给外部系统
 *   - call_api          统一接口调用（与流程中间 api 步骤同一套配置/执行，见 httpCall.js）
 *   - complete_message  仅回复完成话术（无副作用）
 *   - transfer_human    转人工提示（v3 P4 将升级为「转人工事件」）
 *
 * 动作签名：async (ctx) => { ok:boolean, message?:string, error?:string, log?:{...} }
 *   ctx = { sessionId, task, state, slots: {key: value}, step, params }
 *   log（可选）：{ url, payload, response, retries } —— runAction 统一写入 action_log，
 *   作为流程引擎的输出审计（外部系统未就绪时在此查看/补发），不存储业务数据。
 */

import pool from '../../db/pool.js'
import { getReply } from '../replyTexts.js'
import { executeHttpCall, deliver } from './httpCall.js'

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

// ========== 内置动作 ==========

register('complete_message', async (ctx) => {
  return { ok: true, message: ctx.step?.done_message || ctx.task.completion_message || getReply('complete_fallback', { taskName: ctx.task.name }) }
})

register('transfer_human', async () => {
  return { ok: true, message: getReply('transfer_human') }
})

/**
 * 统一接口调用动作（与流程中间 api 步骤同一套配置/执行，见 httpCall.js）
 * 配置（任务级 api_action 或步骤级 params，后者优先合并）：
 *   { url, method, headers, body, result, retries, timeout, done_message }
 *   兼容旧字段：fieldMap / fixedParams / successMessage
 */
register('call_api', async (ctx) => {
  const stepCfg = ctx.step?.params || {}
  const cfg = { ...(ctx.task?.api_action || {}), ...stepCfg }
  if (!cfg.url) {
    return { ok: false, message: '未配置输出接口地址（任务「完成动作」或步骤 params.url）', error: '未配置输出接口地址' }
  }
  const r = await executeHttpCall(cfg, {
    slots: ctx.slots || {},
    vars: ctx.state?.vars || {},
    idempotencyKey: ctx.idempotencyKey,
  })
  if (r.ok) {
    return { ok: true, message: r.message || getReply('api_action_done'), log: r.log }
  }
  return { ok: false, message: r.message || getReply('api_action_fail', { code: '' }), error: r.error, log: r.log }
})

export default { register, runAction, listActions, ensureActionLogTable, deliver }
export { deliver }
