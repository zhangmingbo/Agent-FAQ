/**
 * LLMDialogManager 单元测试（mock LLM / mock 任务定义，不依赖 DB）
 *
 * 覆盖 LLM 驱动对话的关键门禁：
 *   1. 取消意图（规则快检）
 *   2. 收集轮：LLM 提取槽位 + 回复
 *   3. 必填全齐 → 自动进入确认态并展示确认清单
 *   4. 确认态：规则确认词 → 执行动作 → 完成
 *   5. 确认态：否认 → 回到收集态
 *   6. 槽位校验门禁：LLM 返回非法值（枚举/正则不符）→ 拒绝应用
 *   7. 提问插话：question 标记 + questionText
 *   8. 确认态修改：LLM 返回新值 → 重新展示确认清单
 *   9. LLM 报错 → processTurn 抛出（上层降级规则版）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import LLMDialogManager from '../services/taskflow/llmDialogManager.js'
import { TaskState } from '../services/taskflow/stateMachine.js'

// ========== mock 任务定义 ==========

const TASK = {
  code: 'mock_appointment',
  name: '上门服务预约',
  slots: [
    { key: 'phone', label: '联系电话', required: true },
    { key: 'address', label: '地址', required: true },
    { key: 'service_type', label: '服务类型', required: true },
    { key: 'remark', label: '备注', required: false },
  ],
  steps: [
    { key: 'collect', type: 'collect', slot_key: 'phone', question: '请提供您的联系电话：' },
    { key: 'collect2', type: 'collect', slot_key: 'address', question: '请提供您的地址：' },
    { key: 'collect3', type: 'collect', slot_key: 'service_type', question: '请问需要什么服务？', extract: { method: 'enum', enum: ['维修', '保养', '换芯'] } },
    { key: 'collect4', type: 'collect', slot_key: 'remark', question: '还有其他需要补充的吗？' },
    { key: 'act', type: 'action', action: 'complete_message', done_message: '预约已确认！' },
  ],
}

const DEFS = {
  get(code) {
    return code === TASK.code ? TASK : null
  },
}

// ========== mock nlu ==========

function makeFakeNlu(dialogueImpl, overrides = {}) {
  return {
    dialogue: dialogueImpl || (async () => ({ slots: {}, reply: '好的。', ask_confirm: false, question: null })),
    // 校验门禁 mock：默认按枚举/正则校验
    valueMatchesSlot(slotDef, value) {
      if (overrides.valueMatchesSlot) return overrides.valueMatchesSlot(slotDef, value)
      const v = String(value)
      if (slotDef.extract?.method === 'enum') {
        const options = slotDef.extract.enum || []
        return options.includes(v)
      }
      return true
    },
    validate(slotDef, value) {
      if (overrides.validate) return overrides.validate(slotDef, value)
      return { ok: true }
    },
  }
}

function newState() {
  const mgr = new LLMDialogManager(DEFS, makeFakeNlu())
  return {
    mgr,
    state: {
      sessionId: 's1',
      taskCode: TASK.code,
      taskName: TASK.name,
      status: TaskState.COLLECTING,
      slots: mgr.initSlots(TASK),
      stack: [],
      turnCount: 0,
      history: [],
      startedAt: Date.now(),
      lastActive: Date.now(),
    },
  }
}

function filledState() {
  const { mgr, state } = newState()
  for (const k of ['phone', 'address', 'service_type']) {
    state.slots[k].value = k === 'phone' ? '13800138000' : k === 'address' ? '上海市嘉定区' : '维修'
    state.slots[k].filled = true
  }
  state.status = TaskState.CONFIRMING
  return { mgr, state }
}

// ========== 用例 ==========

test('LLM 对话：取消意图 → cancelled', async () => {
  const { mgr, state } = newState()
  const r = await mgr.processTurn(state, '算了，不弄了')
  assert.equal(r.cancelled, true)
  assert.equal(state.status, TaskState.CANCELLED)
})

test('LLM 对话：收集轮提取槽位并回复', async () => {
  const nlu = makeFakeNlu(async () => ({
    slots: { phone: '13800138000' },
    reply: '收到，您的电话是13800138000，请提供地址：',
    ask_confirm: false,
    question: null,
  }))
  const mgr = new LLMDialogManager(DEFS, nlu)
  const state = { sessionId: 's1', taskCode: TASK.code, status: TaskState.COLLECTING, slots: mgr.initSlots(TASK), stack: [], turnCount: 0, history: [] }
  const r = await mgr.processTurn(state, '我的电话是13800138000')
  assert.equal(r.isComplete, false)
  assert.equal(state.slots.phone.value, '13800138000')
  assert.equal(state.slots.phone.filled, true)
  assert.equal(r.reply, '收到，您的电话是13800138000，请提供地址：')
  assert.equal(state.status, TaskState.COLLECTING)
})

test('LLM 对话：必填全齐 → 进入确认态并展示确认清单', async () => {
  const nlu = makeFakeNlu(async () => ({
    slots: { phone: '13800138000', address: '上海市嘉定区', service_type: '维修' },
    reply: '好的。',
    ask_confirm: false,
    question: null,
  }))
  const mgr = new LLMDialogManager(DEFS, nlu)
  const state = { sessionId: 's1', taskCode: TASK.code, status: TaskState.COLLECTING, slots: mgr.initSlots(TASK), stack: [], turnCount: 0, history: [] }
  const r = await mgr.processTurn(state, '13800138000，上海市嘉定区，维修')
  assert.equal(state.status, TaskState.CONFIRMING)
  // 确认清单包含已填项
  assert.match(r.reply, /13800138000/)
  assert.match(r.reply, /上海市嘉定区/)
  assert.match(r.reply, /确认/)
})

test('LLM 对话：确认态回复确认 → 执行动作完成', async () => {
  const { mgr, state } = filledState()
  const r = await mgr.processTurn(state, '确认')
  assert.equal(r.isComplete, true)
  assert.equal(state.status, TaskState.DONE)
  assert.equal(r.reply, '预约已确认！')
})

test('LLM 对话：确认态回复否认 → 回到收集态', async () => {
  const { mgr, state } = filledState()
  const r = await mgr.processTurn(state, '不对，地址写错了')
  assert.equal(r.isComplete, false)
  assert.equal(state.status, TaskState.COLLECTING)
  assert.match(r.reply, /修改/)
})

test('LLM 对话：槽位校验门禁——枚举不符的 LLM 值被拒绝', async () => {
  const nlu = makeFakeNlu(async () => ({
    slots: { service_type: '随便吧' }, // 不在枚举里
    reply: '好的。',
    ask_confirm: false,
    question: null,
  }))
  const mgr = new LLMDialogManager(DEFS, nlu)
  const state = { sessionId: 's1', taskCode: TASK.code, status: TaskState.COLLECTING, slots: mgr.initSlots(TASK), stack: [], turnCount: 0, history: [] }
  await mgr.processTurn(state, '服务类型随便吧')
  assert.equal(state.slots.service_type.filled, false)
  assert.equal(state.slots.service_type.value, null)
})

test('LLM 对话：校验失败（validate 不过）→ 拒绝应用', async () => {
  const nlu = makeFakeNlu(
    async () => ({ slots: { phone: 'abc' }, reply: '好的。', ask_confirm: false, question: null }),
    { validate: (def, v) => (String(v).length >= 6 ? { ok: true } : { ok: false, message: '太短' }) }
  )
  const mgr = new LLMDialogManager(DEFS, nlu)
  const state = { sessionId: 's1', taskCode: TASK.code, status: TaskState.COLLECTING, slots: mgr.initSlots(TASK), stack: [], turnCount: 0, history: [] }
  await mgr.processTurn(state, 'abc')
  assert.equal(state.slots.phone.filled, false)
})

test('LLM 对话：提问插话 → question 标记 + questionText', async () => {
  const nlu = makeFakeNlu(async () => ({
    slots: {},
    reply: '请继续。',
    ask_confirm: false,
    question: '你们上门服务收费吗？',
  }))
  const mgr = new LLMDialogManager(DEFS, nlu)
  const state = { sessionId: 's1', taskCode: TASK.code, status: TaskState.COLLECTING, slots: mgr.initSlots(TASK), stack: [], turnCount: 0, history: [] }
  const r = await mgr.processTurn(state, '上门服务收费吗')
  assert.equal(r.question, true)
  assert.equal(r.questionText, '你们上门服务收费吗？')
  assert.equal(r.isComplete, false)
})

test('LLM 对话：确认态修改 → 重新展示确认清单', async () => {
  const nlu = makeFakeNlu(async () => ({
    slots: { address: '上海市浦东新区' },
    reply: '好的，已更新地址。',
    ask_confirm: false,
    question: null,
  }))
  const mgr = new LLMDialogManager(DEFS, nlu)
  const { state } = filledState()
  // 覆写 nlu（filledState 里建了别的 nlu，这里直接换）
  mgr.nlu = nlu
  const r = await mgr.processTurn(state, '地址改成上海市浦东新区')
  assert.equal(state.slots.address.value, '上海市浦东新区')
  assert.equal(state.status, TaskState.CONFIRMING)
  assert.match(r.reply, /上海市浦东新区/)
  assert.match(r.reply, /确认/)
})

test('LLM 对话：LLM 抛错 → 抛出异常（上层降级）', async () => {
  const nlu = makeFakeNlu(async () => { throw new Error('LLM timeout') })
  const mgr = new LLMDialogManager(DEFS, nlu)
  const state = { sessionId: 's1', taskCode: TASK.code, status: TaskState.COLLECTING, slots: mgr.initSlots(TASK), stack: [], turnCount: 0, history: [] }
  await assert.rejects(() => mgr.processTurn(state, '你好'), /LLM timeout/)
})

test('LLM 对话：可选槽位不填也能进确认态', async () => {
  const nlu = makeFakeNlu(async () => ({
    slots: { phone: '13800138000', address: '上海市嘉定区', service_type: '维修' },
    reply: '好的。',
    ask_confirm: false,
    question: null,
  }))
  const mgr = new LLMDialogManager(DEFS, nlu)
  const state = { sessionId: 's1', taskCode: TASK.code, status: TaskState.COLLECTING, slots: mgr.initSlots(TASK), stack: [], turnCount: 0, history: [] }
  await mgr.processTurn(state, '13800138000 上海市嘉定区 维修')
  // remark 未填，但必填已齐 → 确认态
  assert.equal(state.status, TaskState.CONFIRMING)
  assert.equal(state.slots.remark.filled, false)
})
