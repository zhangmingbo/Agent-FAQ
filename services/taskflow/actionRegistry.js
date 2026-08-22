/**
 * 任务动作注册表
 *
 * 任务步骤 type:'action' 通过 action 字段引用这里注册的动作。
 * 动作签名：async (ctx) => { ok:boolean, message?:string }
 *   ctx = { sessionId, task, state, slots: {key: value}, params }
 *
 * 内置动作：
 *   complete_message   仅返回完成话术（v1 兼容，无副作用）
 *   create_repair_order 写库生成报修工单
 *   transfer_human      转人工提示
 *
 * 自定义动作通过 register() 注册（如调用外部 API）。
 */

import pool from '../../db/pool.js'

const actions = new Map()

/** 注册动作 */
export function register(name, fn) {
  if (typeof fn !== 'function') throw new Error(`动作 ${name} 必须是函数`)
  actions.set(name, fn)
}

/** 执行动作 */
export async function runAction(name, ctx) {
  const fn = actions.get(name)
  if (!fn) {
    return { ok: false, message: `动作「${name}」未注册` }
  }
  try {
    const result = await fn(ctx)
    return result && typeof result.ok === 'boolean' ? result : { ok: true, message: result?.message || '完成' }
  } catch (e) {
    console.error(`[TaskFlow] 动作 ${name} 执行失败:`, e.message)
    return { ok: false, message: e.message }
  }
}

/** 获取已注册动作列表（供管理后台下拉选择） */
export function listActions() {
  return [...actions.keys()]
}

// ========== 内置动作 ==========

register('complete_message', async (ctx) => {
  return { ok: true, message: ctx.step?.done_message || ctx.task.completion_message || `已为您完成${ctx.task.name}。` }
})

register('create_repair_order', async (ctx) => {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS repair_order (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(100),
      code VARCHAR(50) NOT NULL,
      address VARCHAR(255),
      fault TEXT,
      phone VARCHAR(20),
      status TINYINT DEFAULT 1 COMMENT '1=待处理 2=处理中 3=已完成',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  )

  const slots = ctx.slots || {}
  const [result] = await pool.execute(
    'INSERT INTO repair_order (session_id, code, address, fault, phone, status) VALUES (?, ?, ?, ?, ?, 1)',
    [ctx.sessionId, ctx.task.code, slots.address || null, slots.fault || null, slots.phone || null]
  )

  return { ok: true, message: `已为您提交报修工单（单号 #${result.insertId}），我们会尽快处理。` }
})

register('transfer_human', async () => {
  return { ok: true, message: '好的，正在为您转接人工客服，请稍候...\n客服热线：400-123-4567' }
})

register('create_meter_replace_order', async (ctx) => {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS meter_replace_order (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(100),
      code VARCHAR(50) NOT NULL,
      customer_name VARCHAR(50),
      phone VARCHAR(20),
      address VARCHAR(255),
      reason VARCHAR(50),
      time_slot VARCHAR(20),
      status TINYINT DEFAULT 1 COMMENT '1=待联系 2=已预约 3=已完成',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  )

  const slots = ctx.slots || {}
  const [result] = await pool.execute(
    'INSERT INTO meter_replace_order (session_id, code, customer_name, phone, address, reason, time_slot, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    [ctx.sessionId, ctx.task.code, slots.customer_name || null, slots.phone || null, slots.address || null, slots.reason || null, slots.time_slot || null]
  )

  return { ok: true, message: `已为您登记换表申请（单号 #${result.insertId}），师傅会尽快联系您确认上门时间。` }
})

export default { register, runAction, listActions }
