/**
 * 任务实例管理 API 路由
 * 
 * GET    /api/task-instances          分页列表（支持筛选）
 * GET    /api/task-instances/stats    统计卡片
 * GET    /api/task-instances/:id      单条详情
 * PUT    /api/task-instances/:id      编辑（标注/状态）
 * DELETE /api/task-instances/:id      删除
 * POST   /api/task-instances/:id/cancel  手动取消
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as instanceStore from '../services/taskflow/instanceStore.js'

export function createRouter() {
  const router = Router()

  // 统计卡片（放在 /:id 之前，避免被参数路由拦截）
  router.get('/task-instances/stats', asyncHandler(async (req, res) => {
    const data = await instanceStore.stats()
    res.json({ success: true, data })
  }))

  // 分页列表
  router.get('/task-instances', asyncHandler(async (req, res) => {
    const { status, taskCode, date, keyword, page, pageSize } = req.query
    const data = await instanceStore.list({
      status,
      taskCode,
      date,
      keyword,
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 20,
    })
    res.json({ success: true, data })
  }))

  // 单条详情
  router.get('/task-instances/:id', asyncHandler(async (req, res) => {
    const data = await instanceStore.get(parseInt(req.params.id))
    if (!data) {
      return res.status(404).json({ success: false, message: '实例不存在' })
    }
    res.json({ success: true, data })
  }))

  // 编辑（标注/状态）
  router.put('/task-instances/:id', asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id)
    const { remark, status } = req.body
    const fields = {}
    if (remark !== undefined) fields.remark = remark
    if (status !== undefined) fields.status = status
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: '无更新字段' })
    }
    await instanceStore.update(id, fields)
    res.json({ success: true })
  }))

  // 删除
  router.delete('/task-instances/:id', asyncHandler(async (req, res) => {
    const ok = await instanceStore.remove(parseInt(req.params.id))
    if (!ok) {
      return res.status(404).json({ success: false, message: '实例不存在' })
    }
    res.json({ success: true })
  }))

  // 手动取消
  router.post('/task-instances/:id/cancel', asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id)
    const inst = await instanceStore.get(id)
    if (!inst) {
      return res.status(404).json({ success: false, message: '实例不存在' })
    }
    if (inst.status === 'done' || inst.status === 'cancelled') {
      return res.status(400).json({ success: false, message: '该状态不可取消' })
    }
    await instanceStore.update(id, {
      status: 'cancelled',
      finishedAt: new Date(),
    })
    res.json({ success: true })
  }))

  return router
}
