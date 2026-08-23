/**
 * 表达挖掘服务单测（不依赖 DB/LLM，mock 日志与向量）
 *
 * 覆盖：
 *   1. 候选 → 任务匹配（触发词命中）
 *   2. 候选 → 任务匹配（意图例句向量语义）
 *   3. 噪声过滤（闲聊/语气词/重复字符）
 *   4. 否定句过滤（"不装了/算了"）
 *   5. 太短表达过滤
 *   6. 匹配不到任何任务 → 不入候选池
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import taskSuggestService from '../services/taskSuggestService.js'

// mock logRepo（不连 DB，通过 suggest 的 logRepo 参数注入）
const mockLogRepo = {
  getUnmatchedForAnalysis: async () => [
    { text: '安排人来安装', count: 3, lastTime: '2026/8/22 10:00:00' },
    { text: '我要预约上门服务', count: 5, lastTime: '2026/8/22 09:00:00' },
    { text: '我想取消明天的上门服务', count: 2 },  // 取消类
    { text: '你真聪明', count: 1 },               // 赞美类
    { text: '我的妈', count: 2 },                 // 噪声
    { text: '啊啊啊啊', count: 2 },               // 重复字符噪声
    { text: '不装了', count: 1 },                 // 否定句
    { text: '好', count: 4 },                     // 太短
    { text: '今天天气不错', count: 1 },            // 匹配不到任务
  ],
}

// mock 任务定义
const TASK_APPT = {
  code: 'service_appointment',
  name: '上门服务预约',
  status: 1,
  trigger_keywords: ['预约', '上门', '换芯', '移机', '拆机', '保养', '检测'],
  _triggerExpanded: ['预约', '上门', '换芯', '移机', '拆机', '保养', '检测', '预约上门'],
}
const TASK_METER = {
  code: 'meter_replace',
  name: '更换燃气表申请',
  status: 1,
  trigger_keywords: ['换表', '更换', '换燃气表'],
  _triggerExpanded: ['换表', '更换', '换燃气表'],
}

const taskDefs = new Map([
  ['service_appointment', TASK_APPT],
  ['meter_replace', TASK_METER],
])

// mock 向量：只给 service_appointment 例句向量（[1,0,0]），
// "安排人来安装" 与之相似 → 语义命中
const vectors = new Map([
  ['service_appointment', [[1, 0, 0]]],
])

const OPTS = { limit: 50, taskDefs, vectors, logRepo: mockLogRepo }

// mock NLP 引擎：编码查询返回固定向量（不同文本不同向量，便于区分）
taskSuggestService.setNlpEngine({
  async encodeQuery(text) {
    if (text.includes('安装') || text.includes('预约')) return [0.95, 0.1, 0.05]
    return [0.1, 0.9, 0.1] // 无关文本
  },
})

test('挖掘：触发词命中候选 → 匹配到任务', async () => {
  const { items } = await taskSuggestService.suggest(OPTS)
  const appt = items.find(i => i.text === '我要预约上门服务')
  assert.ok(appt, '应包含"我要预约上门服务"')
  assert.equal(appt.matchedTask, 'service_appointment')
  assert.equal(appt.reason, 'keyword')
  assert.ok(appt.score >= 0.85, '触发词命中应高分')
})

test('挖掘：语义向量命中候选 → 匹配到任务', async () => {
  const { items } = await taskSuggestService.suggest(OPTS)
  const install = items.find(i => i.text === '安排人来安装')
  assert.ok(install, '应包含"安排人来安装"')
  assert.equal(install.matchedTask, 'service_appointment')
  assert.equal(install.reason, 'vector')
})

test('挖掘：噪声表达被过滤（闲聊/重复字符/太短）', async () => {
  const { items } = await taskSuggestService.suggest(OPTS)
  const texts = items.map(i => i.text)
  assert.ok(!texts.includes('我的妈'), '闲聊应被过滤')
  assert.ok(!texts.includes('啊啊啊啊'), '重复字符应被过滤')
  assert.ok(!texts.includes('好'), '太短应被过滤')
})

test('挖掘：否定句被过滤（"不装了"）', async () => {
  const { items } = await taskSuggestService.suggest(OPTS)
  const texts = items.map(i => i.text)
  assert.ok(!texts.includes('不装了'), '否定句应被过滤')
})

test('挖掘：取消类被过滤（"我想取消明天的上门服务"）', async () => {
  const { items } = await taskSuggestService.suggest(OPTS)
  const texts = items.map(i => i.text)
  assert.ok(!texts.includes('我想取消明天的上门服务'), '取消类应被过滤')
})

test('挖掘：赞美类被过滤（"你真聪明"）', async () => {
  const { items } = await taskSuggestService.suggest(OPTS)
  const texts = items.map(i => i.text)
  assert.ok(!texts.includes('你真聪明'), '赞美类应被过滤')
})

test('挖掘：匹配不到任务 → 不入候选池（"今天天气不错"）', async () => {
  const { items } = await taskSuggestService.suggest(OPTS)
  const texts = items.map(i => i.text)
  assert.ok(!texts.includes('今天天气不错'), '无匹配不应入池')
})

test('挖掘：候选按匹配任务归组且带 count', async () => {
  const { items } = await taskSuggestService.suggest(OPTS)
  assert.ok(items.length >= 2, '至少 2 个有效候选')
  const appt = items.find(i => i.text === '我要预约上门服务')
  assert.equal(appt.count, 5)
  assert.equal(appt.matchedName, '上门服务预约')
})
