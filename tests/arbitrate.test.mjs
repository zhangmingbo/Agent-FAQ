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
    else if (text === '模糊表达') { v[1] = 1; v[3] = 1 }          // 命中 appt 任务(dim1) + gas_price FAQ(dim3)
    else { v[0] = 0.01; v[1] = 0.01; v[2] = 0.01; v[3] = 0.01 }    // 与所有例句都弱相关（都低）
    return v
  },
})

// 任务例句向量：每个任务独占一个维度（避免交叉干扰）
nlu._vectors.clear()
nlu._vectors.set('service_appointment', [[0, 1, 0, 0]])   // appt 占 dim1
nlu._vectors.set('meter_replace', [[1, 0, 0, 0]])         // meter 占 dim0

// FAQ 例句向量
nlu.setFaqSamples([
  { intentCode: 'gas_usage_detail', intentName: '用气明细查询', vector: [0, 0, 1, 0] },  // 占 dim2
  { intentCode: 'gas_price', intentName: '气价查询', vector: [0, 0, 0, 1] },             // 占 dim3
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

test('仲裁：两者接近 → clarify（让用户选）', async () => {
  const r = await nlu.arbitrateTaskFaq('模糊表达', { tasks: TASKS })
  assert.equal(r.channel, 'clarify')
})

test('仲裁：均未达线 → clarify', async () => {
  const r = await nlu.arbitrateTaskFaq('今天天气不错', { tasks: TASKS })
  assert.equal(r.channel, 'clarify')
})
