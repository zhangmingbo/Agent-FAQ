/**
 * 统一语义仲裁单测（任务 vs FAQ，同一模型对比相似度）
 *
 * 覆盖：
 *   1. FAQ 显著高 → faq（"查一下用气量"：任务 0.47 vs FAQ 0.99）
 *   2. 任务显著高 → task_new
 *   3. 两者接近 → clarify（让用户选）
 *   4. 均未达线 → clarify
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import nlu from '../services/taskflow/nlu.js'

const TASK_APPT = { code: 'service_appointment', name: '上门服务预约', status: 1 }
const TASK_METER = { code: 'meter_replace', name: '更换燃气表申请', status: 1 }

// 注入 mock NLP 引擎：encodeQuery 按输入返回可预测向量（4 维足够，测试不涉及真实模型）
nlu.setNlpEngine({
  async encodeQuery(text) {
    const v = [0, 0, 0, 0]
    if (text === '查一下用气量') { v[2] = 1 }                     // 只命中 FAQ gas_usage_detail（dim2）
    else if (text === '我要预约上门服务') { v[1] = 1 }            // 只命中 appt 任务例句（dim1）
    else if (text === '模糊表达') { v[1] = 1; v[3] = 0.9 }      // 任务 0.743(dim1) vs FAQ 0.669(dim3)，接近但任务略高
    else { v[0] = 0.01; v[1] = 0.01; v[2] = 0.01; v[3] = 0.01 }    // 与所有例句都弱相关（都低）
    return v
  },
})

// 任务例句向量：每个任务独占一个维度（避免交叉干扰）
nlu._vectors.clear()
nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])   // appt 占 dim1
nlu._vectors.set('meter_replace', [[1, 0, 0, 0]])         // meter 占 dim0

// FAQ 例句向量（gas_price 带 dim1 分量，与任务例句非正交，可模拟"接近"）
nlu.setFaqSamples([
  { intentCode: 'gas_usage_detail', intentName: '用气明细查询', vector: [0, 0, 1, 0] },  // 占 dim2
  { intentCode: 'gas_price', intentName: '气价查询', vector: [0, 0.4, 0, 1] },           // dim3 + 少量 dim1
])

const TASKS = [TASK_APPT, TASK_METER]

test('仲裁：FAQ 显著高 → faq（"查一下用气量"场景）', async () => {
  const r = await nlu.arbitrateTaskFaq('查一下用气量', { tasks: TASKS })
  assert.equal(r.channel, 'faq')
  assert.equal(r.faqCode, 'gas_usage_detail')
  assert.ok(r.faqScore > r.taskScore)
})

test('仲裁：任务显著高 → task_new', async () => {
  const r = await nlu.arbitrateTaskFaq('我要预约上门服务', { tasks: TASKS })
  assert.equal(r.channel, 'task_new')
  assert.equal(r.taskCode, 'service_appointment')
})

test('仲裁：弱匹配（未达强命中线）→ out_of_scope（不澄清）', async () => {
  // "模糊表达"当前环境：任务 0.743、FAQ 0.897，均已过线但 FAQ 更高 → faq；
  // 弱匹配场景（均 <0.72）应返回 out_of_scope —— 由 route 层走业务引导
  nlu.setNlpEngine({
    async encodeQuery() { return [0.5, 0, 0.5, 0] }, // 与任务/FAQ 均 0.707 < 0.72
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])
  nlu._vectors.set('meter_replace', [[1, 0, 0, 0]])
  nlu.setFaqSamples([
    { intentCode: 'gas_usage_detail', intentName: '用气明细查询', vector: [0, 0, 1, 0] },
    { intentCode: 'gas_price', intentName: '气价查询', vector: [0, 0, 0, 1] },
  ])
  const r = await nlu.arbitrateTaskFaq('我家门坏了', { tasks: TASKS })
  assert.equal(r.channel, 'out_of_scope')
})

test('仲裁：均未达强命中线（弱匹配）→ out_of_scope', async () => {
  const r = await nlu.arbitrateTaskFaq('今天天气不错', { tasks: TASKS })
  assert.equal(r.channel, 'out_of_scope')
})

test('仲裁：强命中但接近 → clarify（gap 可调：gap 小则任务胜）', async () => {
  // 特制环境：任务例句 appt=(0,1,0,0)，FAQ gas_price=(0,0.5,0,1)（共享 dim1+dim3）
  // 查询 v=(0,1,0,1)：appt 余弦 0.707 <0.72 不够 → 用 v=(0,1,0,0.6)：appt 0.857、gp 0.806 → 接近且都>0.72
  nlu.setNlpEngine({
    async encodeQuery(text) {
      const v = [0, 0, 0, 0]
      if (text === '小差距表达') { v[1] = 1; v[3] = 0.62 }
      else if (text === '查一下用气量') { v[2] = 1 }
      else if (text === '我要预约上门服务') { v[1] = 1 }
      else { v[0] = 0.01; v[1] = 0.01; v[2] = 0.01; v[3] = 0.01 }
      return v
    },
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])
  nlu.setFaqSamples([{ intentCode: 'gas_price', intentName: '气价查询', vector: [0, 0.35, 0, 1] }])
  // 默认 gap=0.08：task 0.850 vs faq 0.778，差 0.072 < 0.08 → clarify
  nlu.setArbConfig({ gap: 0.08 })
  const before = await nlu.arbitrateTaskFaq('小差距表达', { tasks: TASKS })
  assert.equal(before.channel, 'clarify')
  // gap 调小到 0.04：差 0.051 > 0.04 → task_new
  nlu.setArbConfig({ gap: 0.04 })
  const after = await nlu.arbitrateTaskFaq('小差距表达', { tasks: TASKS })
  assert.equal(after.channel, 'task_new')
  nlu.setArbConfig({ gap: 0.08 })
})

test('仲裁：任务级阈值优先于全局（任务配 gap 大 → 全局 gap 小也不覆盖）', async () => {
  // 复用上面的特制环境：task 0.857 vs faq 0.806，差 0.051
  nlu.setNlpEngine({
    async encodeQuery(text) {
      const v = [0, 0, 0, 0]
      if (text === '小差距表达') { v[1] = 1; v[3] = 0.62 }
      else if (text === '查一下用气量') { v[2] = 1 }
      else if (text === '我要预约上门服务') { v[1] = 1 }
      else { v[0] = 0.01; v[1] = 0.01; v[2] = 0.01; v[3] = 0.01 }
      return v
    },
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])
  nlu.setFaqSamples([{ intentCode: 'gas_price', intentName: '气价查询', vector: [0, 0.35, 0, 1] }])
  // 全局 gap=0.04（宽松 → 任务胜），但任务级 arb_gap=0.5（严格 → 澄清）
  nlu.setArbConfig({ gap: 0.04 })
  const TASKS_TASKLEVEL = [
    { ...TASK_APPT, arb_gap: 0.5, arb_task_min: 0.4, arb_faq_min: 0.5 },
    { ...TASK_METER },
  ]
  const r = await nlu.arbitrateTaskFaq('小差距表达', { tasks: TASKS_TASKLEVEL })
  assert.equal(r.channel, 'clarify')
  assert.equal(r.taskCode, 'service_appointment')
  nlu.setArbConfig({ gap: 0.08 })
})

test('仲裁：任务未配任务级阈值 → 用全局（兜底）', async () => {
  // 同上特制环境，但任务无 arb_* → 全局 gap=0.04 生效 → 任务胜
  nlu.setNlpEngine({
    async encodeQuery(text) {
      const v = [0, 0, 0, 0]
      if (text === '小差距表达') { v[1] = 1; v[3] = 0.62 }
      else if (text === '查一下用气量') { v[2] = 1 }
      else if (text === '我要预约上门服务') { v[1] = 1 }
      else { v[0] = 0.01; v[1] = 0.01; v[2] = 0.01; v[3] = 0.01 }
      return v
    },
  })
  nlu._vectors.clear()
  nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])
  nlu.setFaqSamples([{ intentCode: 'gas_price', intentName: '气价查询', vector: [0, 0.35, 0, 1] }])
  nlu.setArbConfig({ gap: 0.04 })
  const r = await nlu.arbitrateTaskFaq('小差距表达', { tasks: TASKS })
  assert.equal(r.channel, 'task_new')
  nlu.setArbConfig({ gap: 0.08 })
})
