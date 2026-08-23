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
import { getReply } from '../replyTexts.js'

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
  return { ok: true, message: ctx.step?.done_message || ctx.task.completion_message || getReply('complete_fallback', { taskName: ctx.task.name }) }
})

/**
 * 调用接口（任务级配置）：用户确认后，把收集的槽位 POST/GET 到任务里配的接口生成工单
 * 配置来源：任务定义 api_action = { url, method, fieldMap, successMessage }
 *   - fieldMap：{ 槽位key: 接口字段名 }；未配置则传全部槽位
 *   - successMessage：成功话术（留空用默认 replyTexts.api_action_done）
 */
register('call_api', async (ctx) => {
  const cfg = ctx.task?.api_action || {}
  if (!cfg.url) {
    return { ok: false, message: '任务未配置接口地址' }
  }
  const slots = ctx.slots || {}
  let payload
  if (cfg.fieldMap && Object.keys(cfg.fieldMap).length) {
    payload = {}
    for (const [slotKey, apiField] of Object.entries(cfg.fieldMap)) {
      const v = slots[slotKey]
      payload[apiField] = (v !== undefined && v !== null) ? String(v) : ''
    }
  } else {
    payload = { ...slots }
  }

  try {
    const method = (cfg.method || 'POST').toUpperCase()
    const res = await fetch(cfg.url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
      body: method === 'GET' ? undefined : JSON.stringify(payload),
    })
    if (!res.ok) {
      console.error(`[TaskFlow] 接口调用失败 HTTP ${res.status}:`, (await res.text()).slice(0, 200))
      return { ok: false, message: getReply('api_action_fail', { code: res.status }) }
    }
    const data = await res.json().catch(() => null)
    const orderNo = data?.orderNo || data?.order_no || data?.id || data?.orderId || ''
    let message = cfg.successMessage || getReply('api_action_done')
    if (orderNo) message = message.split('{orderNo}').join(String(orderNo))
    return { ok: true, message }
  } catch (e) {
    console.error('[TaskFlow] 接口调用异常:', e.message)
    return { ok: false, message: getReply('api_action_fail', { code: '' }) }
  }
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

  return { ok: true, message: getReply('repair_order_done', { orderId: result.insertId }) }
})

register('transfer_human', async () => {
  return { ok: true, message: getReply('transfer_human') }
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

  return { ok: true, message: getReply('meter_replace_done', { orderId: result.insertId }) }
})

register('create_service_appointment', async (ctx) => {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS service_appointment (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(100),
      code VARCHAR(50) NOT NULL,
      phone VARCHAR(20),
      service_type VARCHAR(50),
      customer_name VARCHAR(50),
      address VARCHAR(255),
      machine_model VARCHAR(50),
      time_slot VARCHAR(50),
      status TINYINT DEFAULT 1 COMMENT '1=待联系 2=已预约 3=已完成',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  )

  const slots = ctx.slots || {}
  const [result] = await pool.execute(
    'INSERT INTO service_appointment (session_id, code, phone, service_type, customer_name, address, machine_model, time_slot, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
    [ctx.sessionId, ctx.task.code, slots.phone || null, slots.service_type || null, slots.customer_name || null, slots.address || null, slots.machine_model || null, slots.time_slot || null]
  )

  return { ok: true, message: getReply('service_appointment_done', { serviceType: slots.service_type || '', orderId: result.insertId }) }
})

export default { register, runAction, listActions }
