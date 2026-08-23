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
import llmClient from '../services/llmClient.js'
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

test('route: 触发词命中 + LLM 不可用 → 仲裁决定（无 nlpEngine 时双低走 matchTask→默认）', async () => {
  llmClient.configure({ enabled: false })
  // 无 nlpEngine 环境：仲裁双低 → matchTask（LLM 不可用也不命中）→ 默认无任务上下文 faq
  const r = await nlu.route('上门换滤芯收费吗', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'faq')
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

// ========== 同步仲裁（重构后：仲裁无条件前置，两侧同步对比） ==========

// 注入带 FAQ 侧样本的 mock 环境：任务 appt 占 dim1，FAQ selfI_Introduce 占 dim2
function setupSyncArbEnv() {
  nlu.setNlpEngine({
    async encodeTexts() { return [] },
    async encodeQuery(text) {
      const v = [0, 0, 0, 0]
      if (text === '你是谁') { v[2] = 1 }                    // 命中 FAQ selfI_Introduce
      else if (text === '我要预约上门服务') { v[1] = 1 }     // 命中任务 appt
      else if (text === '不相关的话') { v[0] = 0.01; v[1] = 0.01; v[2] = 0.01 } // 双低
      return v
    },
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])
  nlu.setFaqSamples([
    { intentCode: 'selfI_Introduce', intentName: '业务引导', vector: [0, 0, 1, 0] },
  ])
}

test('route: FAQ 高置信 → 直接 faq（"你是谁"不经过 matchTask/澄清）', async () => {
  setupSyncArbEnv()
  stubRouteTurn('continue') // 即使 LLM 说 continue，仲裁已判 FAQ 优先
  const r = await nlu.route('你是谁', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'faq')
  nlu._vectors.clear()
  nlu.setFaqSamples([])
})

test('route: 任务显著高 → 直接 task_new（不经 matchTask 重复判定）', async () => {
  setupSyncArbEnv()
  stubRouteTurn('faq') // 即使 LLM 说 faq，仲裁已判任务优先
  const r = await nlu.route('我要预约上门服务', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'task_new')
  nlu._vectors.clear()
  nlu.setFaqSamples([])
})

test('route: 触发词命中但 FAQ 更高 → faq（不再无条件进任务）', async () => {
  // 环境：任务 appt 触发词含"预约"（规则命中），但语义上更贴 FAQ QY-013（"净水机怎么预约安装？"）
  nlu.setNlpEngine({
    async encodeTexts() { return [] },
    async encodeQuery(text) {
      const v = [0, 0, 0, 0]
      if (text === '如何预约安装') { v[1] = 0.3; v[3] = 2 } // 任务侧 0.3 低分 + FAQ 0.989 高分
      return v
    },
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])
  nlu.setFaqSamples([
    { intentCode: 'QY-013', intentName: '净水机安装预约', vector: [0, 0, 0, 1] },
  ])
  llmClient.configure({ enabled: true, apiUrl: 'http://mock', apiKey: 'x' })
  llmClient.judgeTrigger = async () => null
  stubRouteTurn('faq')
  // "如何预约安装"：触发词"预约"命中 → boost 0.85（触发词任务=语义任务），
  // FAQ QY-013 相似度 0.989 显著高于 0.85 → FAQ 胜
  const r = await nlu.route('如何预约安装', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'faq')
  nlu._vectors.clear()
  nlu.setFaqSamples([])
})

test('route: 仲裁双低 → 走 matchTask，LLM judgeTrigger 判任务 → task_new', async () => {
  // 双低环境：任务/FAQ 向量都低（查询向量与所有例句正交），但 LLM judgeTrigger 判定为任务
  nlu.setNlpEngine({
    async encodeTexts() { return [] },
    async encodeQuery() { return [0, 0, 0, 1] }, // 与 appt(dim1)/FAQ(dim2) 正交 → 双低
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])
  nlu.setFaqSamples([{ intentCode: 'selfI_Introduce', intentName: '业务引导', vector: [0, 0, 1, 0] }])
  // mock judgeTrigger 返回任务 code（走 matchTask 的 LLM 判定）
  llmClient.configure({ enabled: true, apiUrl: 'http://mock', apiKey: 'x' })
  llmClient.judgeTrigger = async () => 'service_appointment'
  stubRouteTurn(null) // 即使 LLM 三选一拿不准
  const r = await nlu.route('安排人来安装', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'task_new')
  nlu._vectors.clear()
  nlu.setFaqSamples([])
})

test('route: 仲裁双低 + matchTask 未命中 → 落 LLM 三选一（无任务上下文拿不准 → faq 或 clarify）', async () => {
  // 双低环境 + judgeTrigger 也不命中
  nlu.setNlpEngine({
    async encodeTexts() { return [] },
    async encodeQuery() { return [0, 0, 0, 1] },
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])
  nlu.setFaqSamples([{ intentCode: 'selfI_Introduce', intentName: '业务引导', vector: [0, 0, 1, 0] }])
  llmClient.configure({ enabled: true, apiUrl: 'http://mock', apiKey: 'x' })
  llmClient.judgeTrigger = async () => null
  stubRouteTurn('faq') // LLM 三选一判 faq
  const r = await nlu.route('今天天气怎么样', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'faq')
  nlu._vectors.clear()
  nlu.setFaqSamples([])
})

test('route: 两侧弱匹配（0.6级碰巧接近）→ out_of_scope（不澄清）', async () => {
  // "我家门坏了"：任务 0.64 / FAQ 0.61，均未达强命中线 0.72
  nlu.setNlpEngine({
    async encodeTexts() { return [] },
    async encodeQuery() { return [0.5, 0, 0.5, 0] }, // 与任务例句(dim0)余弦 0.5、FAQ(dim2) 0.5，均 < 0.72
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[1, 0, 0, 0]])
  nlu.setFaqSamples([{ intentCode: 'some_faq', intentName: '某FAQ', vector: [0, 0, 1, 0] }])
  llmClient.configure({ enabled: true, apiUrl: 'http://mock', apiKey: 'x' })
  llmClient.judgeTrigger = async () => null
  stubRouteTurn('faq') // 即使 LLM 说 faq，仲裁已判域外
  const r = await nlu.route('我家门坏了', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'out_of_scope')
  nlu._vectors.clear()
  nlu.setFaqSamples([])
})

test('route: 触发词命中豁免域外——弱匹配但含触发词 → task_new 而非 out_of_scope', async () => {
  // "请个师父上门来看看吧"：含触发词"上门"（taskBoost 生效），分数弱但属确定性业务信号
  nlu.setNlpEngine({
    async encodeTexts() { return [] },
    async encodeQuery() { return [0.5, 0, 0.5, 0] }, // 弱匹配（同上门用例）
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[1, 0, 0, 0]])
  nlu.setFaqSamples([{ intentCode: 'some_faq', intentName: '某FAQ', vector: [0, 0, 1, 0] }])
  llmClient.configure({ enabled: true, apiUrl: 'http://mock', apiKey: 'x' })
  llmClient.judgeTrigger = async () => null
  stubRouteTurn('faq')
  // "上门"是 TASK_APPT 触发词 → taskBoost 生效 → 不判域外 → 触发词任务抬到 0.85 > FAQ 0.5 → task_new
  const r = await nlu.route('请个师父上门来看看吧', { tasks: [TASK_APPT, TASK_METER] })
  assert.equal(r, 'task_new')
  nlu._vectors.clear()
  nlu.setFaqSamples([])
})
