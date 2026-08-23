/**
 * 意图路由 route() 单元测试（mock LLM，不依赖 DB）
 *
 * 覆盖双向穿透的关键判定：
 *   1. 规则快检：确认/否认（确认态）→ task_continue
 *   2. 规则快检：取消词 → task_continue
 *   3. 规则快检：点名槽位标签 → task_continue
 *   4. 规则快检：触发其他任务且无咨询疑云 → task_new
 *   5. 规则快检：触发词命中但带咨询词（"上门换滤芯收费吗"）→ 不武断，交 LLM
 *   6. LLM 兜底：任务中插话问费用 → faq
 *   7. 降级：LLM 失败 → 有任务上下文 task_continue，无任务上下文 faq
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import nlu from '../services/taskflow/nlu.js'
import llmClient from '../services/taskflow/llm.js'
import { TaskState } from '../services/taskflow/stateMachine.js'

// 任务上下文 mock
const TASK_APPT = {
  code: 'service_appointment',
  name: '上门服务预约',
  status: 1,
  trigger_keywords: ['预约', '上门', '换芯', '移机', '拆机', '保养', '检测'],
  _triggerExpanded: ['预约', '上门', '换芯', '移机', '拆机', '保养', '检测', '上门服务', '预约上门'],
}
const TASK_METER = {
  code: 'meter_replace',
  name: '更换燃气表申请',
  status: 1,
  trigger_keywords: ['换表', '更换', '换燃气表'],
  _triggerExpanded: ['换表', '更换', '换燃气表'],
}

function makeState(overrides = {}) {
  return {
    sessionId: 's1',
    taskCode: TASK_APPT.code,
    taskName: TASK_APPT.name,
    status: TaskState.COLLECTING,
    slots: {
      phone: { value: '13800138000', filled: true, label: '联系电话' },
      address: { value: null, filled: false, label: '地址' },
      service_type: { value: null, filled: false, label: '服务类型' },
    },
    ...overrides,
  }
}

function ctx(state) {
  return { taskState: state, tasks: [TASK_APPT, TASK_METER], filledDesc: '已收集：联系电话: 13800138000' }
}

// 注入可控的 LLM 路由响应
function stubRouteTurn(decision) {
  llmClient.configure({ enabled: true, apiUrl: 'http://mock', apiKey: 'x' })
  llmClient.routeTurn = async () => decision
}

test('route: 确认态回复"确认" → task_continue', async () => {
  const state = makeState({ status: TaskState.CONFIRMING })
  const r = await nlu.route('确认', ctx(state))
  assert.equal(r, 'task_continue')
})

test('route: 确认态回复"不对，地址错了" → task_continue（否认也继续任务内纠正）', async () => {
  const state = makeState({ status: TaskState.CONFIRMING })
  const r = await nlu.route('不对，地址错了', ctx(state))
  assert.equal(r, 'task_continue')
})

test('route: 取消词 → task_continue（交给任务引擎取消）', async () => {
  const r = await nlu.route('算了，不办了', ctx(makeState()))
  assert.equal(r, 'task_continue')
})

test('route: 点名槽位标签"电话是13900000000" → task_continue', async () => {
  const r = await nlu.route('电话是13900000000', ctx(makeState()))
  assert.equal(r, 'task_continue')
})

test('route: 点名槽位标签"地址在静安区" → task_continue（无需 LLM）', async () => {
  const r = await nlu.route('地址在上海市静安区', ctx(makeState()))
  assert.equal(r, 'task_continue')
})

test('route: 明确触发其他任务"我要换燃气表" → task_new', async () => {
  stubRouteTurn('new_task')
  const r = await nlu.route('我要换燃气表', ctx(makeState()))
  assert.equal(r, 'task_new')
})

test('route: 触发词命中但带咨询疑云"上门换滤芯收费吗" → 交 LLM，LLM 判 faq', async () => {
  stubRouteTurn('faq')
  const r = await nlu.route('上门换滤芯收费吗', ctx(makeState()))
  assert.equal(r, 'faq')
})

test('route: 任务中插话问"换芯后出水发黑正常吗" → LLM 判 faq', async () => {
  stubRouteTurn('faq')
  const r = await nlu.route('换芯后出水发黑正常吗', ctx(makeState()))
  assert.equal(r, 'faq')
})

test('route: 任务中继续答槽位"我姓张" → LLM 判 continue', async () => {
  stubRouteTurn('continue')
  const r = await nlu.route('我姓张', ctx(makeState()))
  assert.equal(r, 'task_continue')
})

test('route: LLM 判定失败 → 降级（有任务上下文 task_continue）', async () => {
  llmClient.configure({ enabled: true, apiUrl: 'http://mock', apiKey: 'x' })
  llmClient.routeTurn = async () => { throw new Error('timeout') }
  const r = await nlu.route('随便说点什么', ctx(makeState()))
  assert.equal(r, 'task_continue')
})

test('route: LLM 未启用 + 无任务上下文 → faq', async () => {
  llmClient.configure({ enabled: false })
  const r = await nlu.route('今天天气怎么样', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'faq')
})

test('route: LLM 未启用 + 有任务上下文 → task_continue（保守）', async () => {
  llmClient.configure({ enabled: false })
  const r = await nlu.route('随便说点什么', ctx(makeState()))
  assert.equal(r, 'task_continue')
})

test('route: 空输入 → faq', async () => {
  const r = await nlu.route('', ctx(makeState()))
  assert.equal(r, 'faq')
})

// ========== clarify（拿不准 → 追问用户二选一） ==========

test('route: 触发词+咨询疑云 + LLM 不可用 → clarify（不武断触发任务）', async () => {
  llmClient.configure({ enabled: false })
  const r = await nlu.route('上门换滤芯收费吗', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'clarify')
})

test('route: 无任务 + 触发词+咨询疑云 + LLM 也拿不准(null) → clarify', async () => {
  stubRouteTurn(null) // LLM 无法判定
  const r = await nlu.route('上门换滤芯收费吗', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'clarify')
})

test('route: 无任务 + LLM 返回 continue（无任务却说要继续）→ clarify', async () => {
  stubRouteTurn('continue')
  const r = await nlu.route('随便说说', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'clarify')
})

test('route: 任务中插话 + LLM 拿不准(null) → clarify（追问继续办理还是咨询）', async () => {
  stubRouteTurn(null)
  const r = await nlu.route('你们还有什么服务', ctx(makeState()))
  assert.equal(r, 'clarify')
})

test('route: 任务中插话 + LLM 明确 faq → faq（不打扰）', async () => {
  stubRouteTurn('faq')
  const r = await nlu.route('换芯后出水发黑正常吗', ctx(makeState()))
  assert.equal(r, 'faq')
})

test('route: 触发词+咨询疑云 + LLM 明确 faq → faq（明确咨询不追问）', async () => {
  stubRouteTurn('faq')
  const r = await nlu.route('上门换滤芯收费吗', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'faq')
})

test('route: 触发词+咨询疑云 + LLM 明确 new_task → task_new（明确办理不追问）', async () => {
  stubRouteTurn('new_task')
  const r = await nlu.route('能上门换滤芯吗', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'task_new')
})

// ========== 意图例句向量触发（matchTask 完整链路） ==========

test('route: 触发词未覆盖但意图例句命中 → task_new（"安排人来安装"）', async () => {
  // 注入 mock nlpEngine：对"安排人来安装"返回高相似度（命中 service_appointment 例句）
  nlu.setNlpEngine({
    async encodeTexts() { return [] },
    async encodeQuery() { return [1, 0, 0] },
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[1, 0, 0]])
  stubRouteTurn(null) // 即使 LLM 拿不准，语义向量已命中
  const r = await nlu.route('我家机器到了，什么时候安排人来安装', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'task_new')
  nlu._vectors.clear()
})

test('route: 否定句不误触发任务（"我没说要换表啊"）→ 交 LLM，LLM 判 faq', async () => {
  stubRouteTurn('faq')
  const r = await nlu.route('我没说要换表啊', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'faq')
})

test('route: 否定句不误触发任务，LLM 判 new_task 才触发（"我说的是换表"）', async () => {
  stubRouteTurn('new_task')
  const r = await nlu.route('我没说要换表啊，我是说换燃气表', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'task_new')
})
