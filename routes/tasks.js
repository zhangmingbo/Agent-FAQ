/**
 * 任务管理 API 路由
 * GET/POST /api/tasks
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import taskEngine from '../services/taskflow/index.js'
import taskSuggestService from '../services/taskSuggestService.js'
import { listActions } from '../services/taskflow/actionRegistry.js'

export function createRouter() {
  const router = Router()

  // 获取可用动作列表（供管理后台步骤配置下拉）
  router.get('/tasks/actions', asyncHandler(async (req, res) => {
    res.json({ success: true, data: listActions() })
  }))

  // 表达挖掘：未触发任务的高频表达 + 任务匹配建议（运营工具，机器推荐人决定）
  // 推理在后台定时预计算（suggest_cache 表），此处只读缓存，打开页面零推理
  router.get('/tasks/suggestions', asyncHandler(async (req, res) => {
    let data = await taskSuggestService.getCached()
    if (!data) {
      // 后台任务尚未跑出结果（如首次启动瞬间）：即时算一次并落库
      taskSuggestService.setNlpEngine(taskEngine.nlu.nlpEngine)
      await taskSuggestService.refreshCache({
        taskDefs: taskEngine.taskDefs,
        vectors: taskEngine.nlu._vectors,
      })
      data = await taskSuggestService.getCached()
    }
    res.json({ success: true, data: data || { items: [], total: 0, computedAtLabel: '' } })
  }))

  // 手动触发后台预计算（管理后台「重新挖掘」按钮）
  router.post('/tasks/suggestions/refresh', asyncHandler(async (req, res) => {
    taskSuggestService.setNlpEngine(taskEngine.nlu.nlpEngine)
    await taskSuggestService.refreshCache({
      taskDefs: taskEngine.taskDefs,
      vectors: taskEngine.nlu._vectors,
    })
    const data = await taskSuggestService.getCached()
    res.json({ success: true, data, message: '已重新计算' })
  }))

  // 删除（忽略）一条候选话术：加入忽略列表（sys_config.suggest_ignored），下次挖掘不再出现
  router.post('/tasks/suggestions/ignore', asyncHandler(async (req, res) => {
    const { text } = req.body || {}
    if (!text) {
      res.status(400).json({ success: false, message: '缺少话术内容' })
      return
    }
    await taskSuggestService.ignore(text)
    // 忽略即数据变更 → 后台重算一次（不阻塞响应）
    taskSuggestService.setNlpEngine(taskEngine.nlu.nlpEngine)
    taskSuggestService.refreshCache({ taskDefs: taskEngine.taskDefs, vectors: taskEngine.nlu._vectors }).catch(() => {})
    res.json({ success: true, message: '已删除该话术，下次挖掘不再出现' })
  }))

  // 采纳候选：把一条表达追加到任务的意图例句（运营点「采纳」触发）
  router.post('/tasks/:code/adopt-example', asyncHandler(async (req, res) => {
    const { code } = req.params
    const { text } = req.body
    if (!text || !text.trim()) {
      res.status(400).json({ success: false, message: '缺少表达内容' })
      return
    }
    const def = await taskEngine.get(code)
    if (!def) {
      res.status(404).json({ success: false, message: '任务不存在' })
      return
    }
    const examples = Array.isArray(def.intent_examples) ? [...def.intent_examples] : []
    const t = text.trim()
    if (!examples.includes(t)) examples.push(t)
    await taskEngine.save({
      code: def.code,
      name: def.name,
      description: def.description,
      trigger_keywords: def.trigger_keywords,
      slots: def.slots,
      steps: def.steps,
      intent_examples: examples,
      clarify_question: def.clarify_question,
      clarify_options: def.clarify_options,
      completion_message: def.completion_message,
      on_complete: def.on_complete,
      status: def.status,
    })
    // 例句变更 → 后台重算一次（不阻塞响应）
    taskSuggestService.setNlpEngine(taskEngine.nlu.nlpEngine)
    taskSuggestService.refreshCache({ taskDefs: taskEngine.taskDefs, vectors: taskEngine.nlu._vectors }).catch(() => {})
    res.json({ success: true, message: `已采纳，例句已加入「${def.name}」` })
  }))

  // 获取所有任务列表
  router.get('/tasks', asyncHandler(async (req, res) => {
    const tasks = await taskEngine.list()
    res.json({ success: true, data: tasks })
  }))

  // 任务会话调试：查看某个 session 的任务状态（前端调试用）
  router.get('/tasks/debug', asyncHandler(async (req, res) => {
    const sessionId = req.query.sessionId
    if (!sessionId) {
      res.status(400).json({ success: false, message: '缺少 sessionId 参数' })
      return
    }
    res.json({ success: true, data: taskEngine.getDebugInfo(sessionId) })
  }))

  // 获取单个任务详情
  router.get('/tasks/:code', asyncHandler(async (req, res) => {
    const task = await taskEngine.get(req.params.code)
    if (!task) {
      res.status(404).json({ success: false, message: '任务不存在' })
      return
    }
    res.json({ success: true, data: task })
  }))

  // 创建/更新任务
  router.post('/tasks', asyncHandler(async (req, res) => {
    const { code, name, description, trigger_keywords, slots, steps, intent_examples, clarify_question, clarify_options, arb_gap, arb_task_min, arb_faq_min, arb_strong_hit, llm, api_action, completion_message, on_complete, status } = req.body

    if (!code || !name) {
      res.status(400).json({ success: false, message: '编码和名称不能为空' })
      return
    }

    // 验证 slots 格式
    if (slots && !Array.isArray(slots)) {
      res.status(400).json({ success: false, message: 'slots 必须是数组' })
      return
    }

    // 验证 trigger_keywords 格式
    if (trigger_keywords && !Array.isArray(trigger_keywords)) {
      res.status(400).json({ success: false, message: 'trigger_keywords 必须是数组' })
      return
    }

    // 验证 steps 格式
    if (steps !== undefined && !Array.isArray(steps)) {
      res.status(400).json({ success: false, message: 'steps 必须是数组' })
      return
    }

    await taskEngine.save({
      code, name, description, trigger_keywords, slots, steps, intent_examples,
      clarify_question, clarify_options,
      arb_gap, arb_task_min, arb_faq_min, arb_strong_hit,
      llm, api_action,
      completion_message, on_complete, status,
    })

    res.json({ success: true, message: '保存成功' })
  }))

  // 删除任务
  router.delete('/tasks/:code', asyncHandler(async (req, res) => {
    await taskEngine.remove(req.params.code)
    res.json({ success: true, message: '已删除' })
  }))

  // 启用/禁用任务
  router.post('/tasks/:code/toggle', asyncHandler(async (req, res) => {
    const { status } = req.body
    await taskEngine.toggleStatus(req.params.code, status)
    res.json({ success: true, message: status ? '已启用' : '已禁用' })
  }))

  return router
}
