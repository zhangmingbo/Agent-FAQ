/**
 * 路由澄清话术优先级单测（不依赖 DB/LLM）
 * 验证：任务级 clarify_question/clarify_options 优先，未配置回退全局模板 router.clarify
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import FAQEngine from '../faq-engine.js'
// 注意：不调用 initPrompts()（会连 DB 导致测试进程不退出）；
// get() 未初始化时自动用注册表默认值，足够验证回退逻辑

// mock taskEngine：只提供 get()
const DEFS = {
  service_appointment: {
    code: 'service_appointment',
    name: '上门服务预约',
    clarify_question: '您是想预约上门服务，还是想咨询其他问题呢？',
    clarify_options: ['预约上门服务', '咨询其他问题'],
  },
  meter_replace: {
    code: 'meter_replace',
    name: '更换燃气表申请',
    clarify_question: '',
    clarify_options: [],
  },
}

// 不 new 完整引擎（避免 FaqService 加载模型）——用原型方法 + mock taskEngine
const engine = Object.create(FAQEngine.prototype)
engine.taskEngine = {
  async get(code) {
    return DEFS[code] || null
  },
}

test('任务级澄清配置：有 clarify_question+options → 用任务配置', async () => {
  const r = await engine._buildRouteClarifyResponse({
    taskCode: 'service_appointment',
    taskName: '上门服务预约',
  })
  assert.equal(r.source, 'route_clarify')
  assert.ok(r.answer.includes('您是想预约上门服务，还是想咨询其他问题呢？'))
  assert.ok(r.answer.includes('1. 预约上门服务'))
  assert.ok(r.answer.includes('2. 咨询其他问题'))
  assert.ok(!r.answer.includes('相关业务'), '不应使用全局模板的占位任务名')
})

test('任务级澄清配置：未配置（空）→ 回退全局模板', async () => {
  const r = await engine._buildRouteClarifyResponse({
    taskCode: 'meter_replace',
    taskName: '更换燃气表申请',
  })
  assert.equal(r.source, 'route_clarify')
  assert.ok(r.answer.includes('更换燃气表申请'), '全局模板应带任务名')
  assert.ok(r.answer.includes('1. 办理'), '全局默认选项')
})

test('任务级澄清配置：repeat 前缀', async () => {
  const r = await engine._buildRouteClarifyResponse({
    taskCode: 'service_appointment',
    taskName: '上门服务预约',
  }, true)
  assert.ok(r.answer.startsWith('抱歉，我没有理解您的选择。'))
  assert.ok(r.answer.includes('您是想预约上门服务'))
})
