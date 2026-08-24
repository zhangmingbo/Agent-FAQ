/**
 * 动作系统完整测试套件
 * 覆盖：表达式引擎 / 条件判断 / 统一接口调用 / 动作注册表 / 编排 / 状态机 / 端到端
 * 运行：node tests/action-system.test.mjs（需服务器在 localhost:3001 运行）
 */

import pool from '../db/pool.js'
import { evalExpr } from '../services/taskflow/expr.js'
import { evaluateCondition, registerJudge, evalOp, isBusinessHour } from '../services/taskflow/condition.js'
import { resolveTemplate, normalizeConfig, extractResult, executeHttpCall } from '../services/taskflow/httpCall.js'
import { runAction, listActions, ensureActionLogTable } from '../services/taskflow/actionRegistry.js'
import { runFlow } from '../services/taskflow/flow.js'
import { TaskState, canTransition } from '../services/taskflow/stateMachine.js'

const BASE = 'http://localhost:3001'
let pass = 0, fail = 0
const failures = []
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; failures.push(name + (extra ? ' | ' + JSON.stringify(extra) : '')); console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') }
}
async function section(title) { console.log('\n===== ' + title + ' =====') }

// 服务器前置检查
try {
  const h = await fetch(BASE + '/api/health').then(r => r.json())
  if (h.status !== 'ok') { console.log('服务器未就绪'); process.exit(1) }
} catch { console.log('服务器未运行（需先 node server.js）'); process.exit(1) }
await ensureActionLogTable()

// ================= ① 表达式引擎 =================
await section('① 表达式引擎 expr.js')
t('算术 1+2*3=7', evalExpr('1 + 2 * 3', {}) === 7)
t('括号 (1+2)*3=9', evalExpr('(1 + 2) * 3', {}) === 9)
t('取模 5%2=1', evalExpr('5 % 2', {}) === 1)
t('负数 -3+5=2', evalExpr('-3 + 5', {}) === 2)
t('比较 5>3', evalExpr('5 > 3', {}) === true)
t('比较 5>=5', evalExpr('5 >= 5', {}) === true)
t('宽松相等 "5"==5', evalExpr('"5" == 5', {}) === true)
t('逻辑 &&', evalExpr('true && false', {}) === false)
t('逻辑 ||', evalExpr('false || true', {}) === true)
t('逻辑 !', evalExpr('!false', {}) === true)
t('槽位变量 slot.phone', evalExpr('slot.phone == "13800138000"', { slot: { phone: '13800138000' } }) === true)
t('结果点路径 result.a.b', evalExpr('result.a.b == 42', { result: { a: { b: 42 } } }) === true)
t('组合表达式', evalExpr('slot.amount > 100 && var.status == "ok" && !slot.blocked', { slot: { amount: 150, blocked: false }, var: { status: 'ok' } }) === true)
t('缺失路径 → null(不抛)', evalExpr('nothing.x', {}) == null)
t('语法错误 → null(不抛)', evalExpr('1 +', {}) === null)

// ================= ② 条件判断 =================
await section('② 条件判断 condition.js')
const ctx = { slots: { phone: '13800138000', count: '5', addr: '' }, vars: { status: '已受理' }, result: { check: { status: '已受理', debt: 0 } } }
t('eq', await evaluateCondition({ source: 'slot', ref: 'phone', op: 'eq', value: '13800138000' }, ctx))
t('ne', await evaluateCondition({ source: 'slot', ref: 'phone', op: 'ne', value: '139' }, ctx))
t('contains', await evaluateCondition({ source: 'var', ref: 'status', op: 'contains', value: '受理' }, ctx))
t('notContains', await evaluateCondition({ source: 'var', ref: 'status', op: 'notContains', value: '取消' }, ctx))
t('regex', await evaluateCondition({ source: 'slot', ref: 'phone', op: 'regex', value: '^1\\d{10}$' }, ctx))
t('gt 数值', await evaluateCondition({ source: 'slot', ref: 'count', op: 'gt', value: 3 }, ctx))
t('lte 数值', await evaluateCondition({ source: 'slot', ref: 'count', op: 'lte', value: 5 }, ctx))
t('empty', await evaluateCondition({ source: 'slot', ref: 'addr', op: 'empty' }, ctx))
t('notEmpty', await evaluateCondition({ source: 'slot', ref: 'phone', op: 'notEmpty' }, ctx))
t('result 点路径', await evaluateCondition({ source: 'result', ref: 'check.status', op: 'eq', value: '已受理' }, ctx))
t('result 数值比较', await evaluateCondition({ source: 'result', ref: 'check.debt', op: 'eq', value: 0 }, ctx))
t('and 组合（全真）', await evaluateCondition({ and: [{ source: 'slot', ref: 'phone', op: 'eq', value: '13800138000' }, { source: 'var', ref: 'status', op: 'eq', value: '已受理' }] }, ctx))
t('and 组合（一假）', !(await evaluateCondition({ and: [{ source: 'slot', ref: 'phone', op: 'eq', value: '139' }, { source: 'var', ref: 'status', op: 'eq', value: '已受理' }] }, ctx)))
t('or 组合', await evaluateCondition({ or: [{ source: 'slot', ref: 'count', op: 'lt', value: 1 }, { source: 'var', ref: 'status', op: 'eq', value: '已受理' }] }, ctx))
t('expr 判断源', await evaluateCondition({ source: 'expr', expr: 'slot.count >= 5 && var.status == "已受理"' }, ctx))
// fn 注册表
registerJudge('test_is_even', (n) => Number(n) % 2 === 0)
t('fn 函数判断（偶数）', await evaluateCondition({ source: 'fn', ref: 'test_is_even', args: ['4'] }, ctx))
t('fn 函数判断（奇数→false）', !(await evaluateCondition({ source: 'fn', ref: 'test_is_even', args: ['5'] }, ctx)))
// time（宽容断言：返回布尔即可；business_hours 本地判断）
const wd = await evaluateCondition({ source: 'time', op: 'workday' }, {})
t('time workday 返回布尔', typeof wd === 'boolean')
t('isBusinessHour 返回布尔', typeof (await isBusinessHour()) === 'boolean')

// ================= ③ 模板/归一化 =================
await section('③ 模板解析与配置归一化 httpCall.js')
t('模板 {slot}/{var}/{result}/{sessionId}/{taskCode}/{idempotencyKey}', resolveTemplate('{slot.p}-{var.v}-{result.r}-{sessionId}-{taskCode}-{idempotencyKey}', { slots: { p: '1' }, vars: { v: '2' }, result: { r: '3' }, sessionId: 's', taskCode: 't', idempotencyKey: 'k' }) === '1-2-3-s-t-k')
t('模板 {result} 无路径保留', resolveTemplate('值 {result}', { result: { x: 1 } }) === '值 {result}')
const n = normalizeConfig({ url: 'u', fieldMap: { phone: 'phone' }, fixedParams: { appId: '10086' }, resultMap: { orderNo: 'data.orderNo' }, successMessage: 'ok' })
t('归一化 fieldMap→body', n.body.phone === '{slot.phone}' && n.body.appId === '10086')
t('归一化 resultMap→result', n.result.orderNo === 'data.orderNo')
t('归一化 successMessage→done_message', n.done_message === 'ok')
const n2 = normalizeConfig({ url: 'u', resultSlot: 'order_Number', resultField: 'data.orderNo' })
t('归一化 resultSlot/resultField→result', n2.result.order_Number === 'data.orderNo')
t('extractResult 点路径', JSON.stringify(extractResult({ data: { orderNo: 'QY1' } }, 'raw', { orderNo: 'data.orderNo' })) === '{"orderNo":"QY1"}')

// ================= ④ 状态机 =================
await section('④ 状态机 stateMachine.js')
t('CONFIRMING→TRANSFERRED 允许', canTransition(TaskState.CONFIRMING, TaskState.TRANSFERRED))
t('DONE→TRANSFERRED 不允许', !canTransition(TaskState.DONE, TaskState.TRANSFERRED))

// ================= ⑤ 动作注册表 =================
await section('⑤ 动作注册表 actionRegistry.js')
t('动作列表含 3 个内置', ['complete_message', 'transfer_human', 'call_api'].every(a => listActions().includes(a)))
const rCm = await runAction('complete_message', { sessionId: 't-unit', task: { code: 't', completion_message: '完成话术X' }, slots: {} })
t('complete_message 返回话术', rCm.ok && rCm.message === '完成话术X')
const rTh = await runAction('transfer_human', { sessionId: 't-unit', task: { code: 't', name: '任务名' }, slots: { phone: '138' } })
t('transfer_human 返回事件', rTh.ok && rTh.events && rTh.events[0].type === 'transfer_human' && rTh.events[0].sessionId === 't-unit' && rTh.events[0].slots.phone === '138')
const rMiss = await runAction('no_such_action', { sessionId: 't-unit', task: { code: 't' }, slots: {} })
t('未注册动作 → fail', !rMiss.ok && rMiss.message.includes('未注册'))

// ================= ⑥ 统一接口调用（集成，需 mock 服务器） =================
await section('⑥ 统一接口调用 executeHttpCall')
const r1 = await executeHttpCall({
  url: BASE + '/api/mock/order/create', method: 'POST',
  body: { phone: '{slot.phone}', data: { name: '{slot.name}' }, appId: '10086' },
  result: { orderNo: 'data.orderNo', status: 'data.status' },
  done_message: '单号 {result.orderNo} 状态 {result.status}',
}, { slots: { phone: '13800138000', name: '张三' }, sessionId: 'u1', taskCode: 't1' })
t('成功 ok', r1.ok)
t('出参提取 orderNo/status', r1.vars.orderNo && /^QY/.test(r1.vars.orderNo) && r1.vars.status === '已受理')
t('done_message 插值', r1.message.includes('单号 QY') && r1.message.includes('状态 已受理'))
t('body 模板+固定值', r1.log.payload.phone === '13800138000' && r1.log.payload.data.name === '张三' && r1.log.payload.appId === '10086')
const r2 = await executeHttpCall({ url: BASE + '/api/mock/order/create', body: { phone: '{slot.phone}' } }, { slots: { phone: '138' } })
t('未配 done_message → 静默', r2.message === '')
const r3 = await executeHttpCall({ url: BASE + '/api/no-such-xyz', method: 'POST', retries: 1, timeout: 1000, body: { a: 'b' } }, {})
t('失败重试（2 次尝试）', !r3.ok && r3.log.retries === 2)
const r4 = await executeHttpCall({ url: BASE + '/api/mock/order/create', body: { phone: '{slot.phone}' }, result: { order_Number: 'data.orderNo' }, done_message: '查到 {result},请确认' }, { slots: { phone: '138' } })
t('旧 {result} 主值插值', r4.message.includes('QY'))

// ================= ⑦ 动作 call_api（含 action_log） =================
await section('⑦ call_api 动作 + action_log')
const r5 = await runAction('call_api', {
  sessionId: 'unit-callapi', task: { code: 'unit_task', api_action: { url: BASE + '/api/mock/order/create', method: 'POST', fieldMap: { phone: 'phone' }, fixedParams: { appId: '10086', traceId: '{sessionId}' }, successMessage: '已提交 {orderNo}' } },
  slots: { phone: '13800138000' },
})
t('call_api 成功', r5.ok && r5.message.includes('已提交') && r5.message.includes('QY'))
const [lg1] = await pool.execute("SELECT status, url, payload, error, retries FROM action_log WHERE session_id = 'unit-callapi' ORDER BY id DESC LIMIT 1")
t('action_log 记录 ok', lg1[0].status === 'ok' && lg1[0].url.includes('mock'))
const pl = typeof lg1[0].payload === 'string' ? JSON.parse(lg1[0].payload) : lg1[0].payload
t('action_log payload 含固定入参+模板', pl.appId === '10086' && pl.traceId === 'unit-callapi' && pl.phone === '13800138000')
const r6 = await runAction('call_api', {
  sessionId: 'unit-callapi-fail', task: { code: 'unit_task', api_action: { url: BASE + '/api/no-such-xyz', method: 'POST', retries: 0, timeout: 1000 } },
  slots: { phone: '138' },
})
t('call_api 失败', !r6.ok)
const [lg2] = await pool.execute("SELECT status, error FROM action_log WHERE session_id = 'unit-callapi-fail' ORDER BY id DESC LIMIT 1")
t('action_log 记录 fail', lg2[0].status === 'fail' && lg2[0].error)

// ================= ⑧ 动作编排 flow.js =================
await section('⑧ 动作编排 runFlow')
const flow = {
  idempotencyKey: '{sessionId}-{taskCode}-flow',
  steps: [
    { type: 'http', name: 'check', url: BASE + '/api/mock/order/create', method: 'POST', body: { phone: '{slot.phone}' }, result: { status: 'data.status' } },
    { type: 'branch', when: { source: 'result', ref: 'check.status', op: 'eq', value: '已受理' },
      then: [{ type: 'http', name: 'notify', url: BASE + '/api/mock/order/create', method: 'POST', body: { phone: '{slot.phone}', branch: 'then' } }],
      else: [{ type: 'http', name: 'notify2', url: BASE + '/api/mock/order/create', method: 'POST', body: { phone: '{slot.phone}', branch: 'else' } }] },
  ],
}
const flowCtx = { sessionId: 'unit-flow-' + Date.now(), task: { code: 'unit_flow' }, state: { vars: {} }, slots: { phone: '13800138000' } }
const f1 = await runFlow(flow, flowCtx)
t('编排执行成功', f1.ok && !f1.idempotent)
const [flg] = await pool.execute("SELECT step, status, idempotency_key, LEFT(CAST(payload AS CHAR), 60) AS p FROM action_log WHERE session_id = ? AND action='flow' ORDER BY id", [flowCtx.sessionId])
t('编排步骤日志（2 步）', flg.length === 2)
t('日志含步骤名与幂等键', flg[0].step === 'check' && flg[0].idempotency_key === flowCtx.sessionId + '-unit_flow-flow' && flg[0].status === 'ok')
t('分支走 then（payload 含 branch=then）', flg.some(l => l.status === 'ok' && (l.p || '').includes('then')))
const f2 = await runFlow(flow, flowCtx)
t('幂等命中（第二次直接返回）', f2.ok && f2.idempotent === true)
const flowBad = { idempotencyKey: '{sessionId}-bad', steps: [{ type: 'http', name: 'bad', url: BASE + '/api/no-such-xyz', method: 'POST', retries: 0, timeout: 1000 }] }
const f3 = await runFlow(flowBad, { ...flowCtx, sessionId: 'unit-flow-bad' })
t('编排失败', !f3.ok && f3.error)
const flowDeep = { idempotencyKey: '{sessionId}-deep', steps: [{ type: 'branch', when: { source: 'slot', ref: 'phone', op: 'notEmpty' }, then: [{ type: 'branch', when: { source: 'slot', ref: 'phone', op: 'notEmpty' }, then: [{ type: 'http', name: 'x', url: BASE + '/api/mock/order/create' }] }] }] }
const f4 = await runFlow(flowDeep, { ...flowCtx, sessionId: 'unit-flow-deep' })
t('嵌套分支执行', f4.ok)

// ================= ⑨ 端到端：真实任务 =================
await section('⑨ 端到端（chat 链路）')
async function chat(text, sessionId) {
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, sessionId }) })
  return r.json()
}
async function login() {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })
  return (await r.json()).token
}
const token = await login()

// 9a. 转人工任务（触发词用独特词，避免撞 FAQ 库的 human_agent 意图）
await fetch(BASE + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({
  code: 'test_transfer', name: '测试转人工', status: 1, trigger_keywords: ['转人工流程测试'],
  slots: [{ key: 'phone', label: '电话', prompt: '电话？', required: true }],
  steps: [
    { key: 'c1', type: 'collect', slot_key: 'phone', next: 'confirm' },
    { key: 'confirm', type: 'confirm', next: 'submit' },
    { key: 'submit', type: 'action', action: 'transfer_human' },
  ],
  on_complete: 'transfer_human',
}) })
const sidT = 'e2e-t-' + Date.now()
let evt = null
for (const txt of ['转人工流程测试', '办理', '13800138000', '确认']) {
  const r = await chat(txt, sidT)
  if (r.events && r.events.length) evt = r.events
}
t('端到端 转人工事件返回', evt && evt[0].type === 'transfer_human' && evt[0].slots.phone === '13800138000')
await fetch(BASE + '/api/tasks/test_transfer', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })

// 9b. 编排任务（on_complete 编排 JSON）
await fetch(BASE + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({
  code: 'test_flow', name: '测试编排', status: 1, trigger_keywords: ['测试编排'],
  slots: [{ key: 'phone', label: '电话', prompt: '电话？', required: true }],
  steps: [
    { key: 'c1', type: 'collect', slot_key: 'phone', next: 'confirm' },
    { key: 'confirm', type: 'confirm', next: 'submit' },
    { key: 'submit', type: 'action', action: 'call_api' },
  ],
  on_complete: JSON.stringify({
    idempotencyKey: '{sessionId}-{taskCode}-submit',
    steps: [
      { type: 'http', name: 's1', url: BASE + '/api/mock/order/create', method: 'POST', body: { phone: '{slot.phone}' } },
      { type: 'http', name: 's2', url: BASE + '/api/mock/order/create', method: 'POST', body: { phone: '{slot.phone}', from: '{result.s1.orderNo}' } },
    ],
  }),
}) })
const sidF = 'e2e-f-' + Date.now()
let flowDone = false
for (const txt of ['测试编排', '办理', '13800138000', '确认']) {
  const r = await chat(txt, sidF)
  if (r.source === 'task_complete') flowDone = true
}
t('端到端 编排任务完成', flowDone)
const [flg2] = await pool.execute("SELECT COUNT(*) AS c FROM action_log WHERE session_id = ? AND action='flow' AND status='ok'", [sidF])
t('端到端 编排步骤日志落库（≥2 步）', flg2[0].c >= 2)
await fetch(BASE + '/api/tasks/test_flow', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })

// ================= 汇总 =================
console.log('\n========================================')
console.log(`测试结果: ${pass} 通过 / ${fail} 失败`)
if (fail) { console.log('失败项:'); failures.forEach(f => console.log('  -', f)) }
await pool.end()
process.exit(fail ? 1 : 0)
