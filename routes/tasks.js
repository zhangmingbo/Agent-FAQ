/**
 * 任务管理 API 路由
 * GET/POST /api/tasks
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import taskEngine from '../services/taskflow/index.js'
import { listActions } from '../services/taskflow/actionRegistry.js'

export function createRouter() {
  const router = Router()

  // 获取可用动作列表（供管理后台步骤配置下拉）
  router.get('/tasks/actions', asyncHandler(async (req, res) => {
    res.json({ success: true, data: listActions() })
  }))

  // 获取所有任务列表
  router.get('/tasks', asyncHandler(async (req, res) => {
    const tasks = await taskEngine.list()
    res.json({ success: true, data: tasks })
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
    const { code, name, description, trigger_keywords, slots, steps, completion_message, on_complete, status } = req.body

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
      code, name, description, trigger_keywords, slots, steps,
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
