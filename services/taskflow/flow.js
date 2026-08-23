/**
 * 动作编排执行引擎（动作系统 v3 P3）
 *
 * 任务级完成动作支持编排：on_complete = { idempotencyKey, steps: [...] }
 *   steps 元素：
 *     { type:'http', name:'步骤名', url/method/body/result/retries/timeout/done_message }
 *     { type:'branch', when:{条件}, then:[子步骤], else:[子步骤] }
 *
 * 上下文与模板：
 *   exec = { slots, vars, results: { 步骤名: 出参变量 } }
 *   模板引用：{slot.x} {var.x} {result.步骤名.字段} {idempotencyKey}
 *
 * 幂等：执行前查 action_log(idempotency_key, status='ok')，命中直接返回（防重复办业务）；
 *       每次执行每一步都写 action_log（含 idempotency_key / step），业务系统可按幂等键去重。
 *
 * 失败：单步 http 内部重试；仍失败 → 整链 fail，日志定位到失败步骤（该步 status='fail'）。
 */

import pool from '../../db/pool.js'
import { executeHttpCall, resolveTemplate } from './httpCall.js'
import { evaluateCondition } from './condition.js'

/** 编排执行入口 */
export async function runFlow(flow, ctx) {
  const slots = ctx.slots || {}
  const idemKey = resolveTemplate(flow.idempotencyKey || '{sessionId}-{taskCode}-submit', {
    slots,
    vars: ctx.state?.vars || {},
    result: {},
    idempotencyKey: '',
    sessionId: ctx.sessionId || '',
    taskCode: ctx.task?.code || '',
  }) || `${ctx.sessionId || 's'}-${ctx.task?.code || 't'}-submit`

  // 幂等检查：该幂等键已有成功记录 → 跳过
  const prev = await findFlowSuccess(idemKey)
  if (prev) {
    return { ok: true, message: prev.message || '该次提交此前已完成（幂等命中）', idempotent: true, log: { url: null, payload: null, response: prev.response } }
  }

  const exec = {
    slots,
    vars: { ...(ctx.state?.vars || {}) },
    results: {},
  }
  try {
    await runSteps(flow.steps || [], exec, ctx, idemKey, 0)
    return { ok: true, message: '已完成', log: { url: null, payload: { flow: 'done', steps: (flow.steps || []).length }, response: '' } }
  } catch (e) {
    return { ok: false, message: e.message || '编排执行失败', error: e.message, log: { url: null, payload: { flow: 'fail', steps: (flow.steps || []).length }, response: '' } }
  }
}

async function runSteps(steps, exec, ctx, idemKey, depth) {
  if (depth > 5) throw new Error('编排嵌套过深（超过 5 层）')
  for (const step of steps || []) {
    if (step.type === 'http') {
      const httpCtx = {
        slots: exec.slots,
        vars: exec.vars,
        result: exec.results, // {result.步骤名.字段} 引用
        idempotencyKey: idemKey,
      }
      const r = await executeHttpCall(step, httpCtx)
      await logFlowStep(ctx, step, idemKey, r)
      if (!r.ok) {
        throw new Error(`编排步骤「${step.name || step.type}」失败: ${r.error || r.message}`)
      }
      if (step.name && r.vars && Object.keys(r.vars).length) {
        exec.results[step.name] = r.vars
      }
    } else if (step.type === 'branch') {
      const hit = await evaluateCondition(step.when, { slots: exec.slots, vars: exec.vars, result: exec.results })
      await runSteps(hit ? step.then : step.else, exec, ctx, idemKey, depth + 1)
    } else {
      throw new Error(`编排步骤类型不支持: ${step.type || '?'}`)
    }
  }
}

/** 幂等查询：该键是否已有成功执行记录 */
async function findFlowSuccess(idemKey) {
  try {
    const [rows] = await pool.execute(
      "SELECT message, response FROM action_log WHERE idempotency_key = ? AND status = 'ok' ORDER BY id DESC LIMIT 1",
      [idemKey]
    )
    return rows[0] || null
  } catch { return null }
}

/** 编排步骤日志（action_log，含幂等键与步骤名） */
async function logFlowStep(ctx, step, idemKey, r) {
  try {
    await pool.execute(
      `INSERT INTO action_log (session_id, task_code, action, step, status, idempotency_key, url, payload, response, error, retries, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        ctx?.sessionId || null,
        ctx?.task?.code || null,
        'flow',
        step.name || 'step',
        r.ok ? 'ok' : 'fail',
        idemKey,
        step.url || null,
        r.log?.payload !== undefined ? JSON.stringify(r.log.payload) : null,
        r.log?.response || null,
        r.ok ? null : (r.error || r.message),
        r.log?.retries ?? 0,
      ]
    )
  } catch (e) {
    console.error('[TaskFlow] 编排日志写入失败:', e.message)
  }
}

/** 完成动作统一入口：任务级编排优先，否则执行动作 */
export async function runCompletionAction(task, ctx) {
  if (task?.on_complete && typeof task.on_complete === 'object' && Array.isArray(task.on_complete.steps)) {
    return runFlow(task.on_complete, ctx)
  }
  return null // 无编排配置（由调用方走动作步骤）
}

export default { runFlow, runCompletionAction }
