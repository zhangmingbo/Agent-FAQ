/**
 * 分类管理路由
 * GET/POST/DELETE /api/categories, GET /api/categories/:id/faqs, PUT /api/faq/:code/category
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as categoryRepo from '../repositories/categoryRepo.js'

export function createRouter(engine) {
  const router = Router()

  // 获取分类树形结构
  router.get('/categories', asyncHandler(async (req, res) => {
    const tree = await categoryRepo.listTree()
    res.json(tree)
  }))

  // 获取指定分类下的 FAQ 列表
  router.get('/categories/:id/faqs', asyncHandler(async (req, res) => {
    const categoryId = parseInt(req.params.id) || null
    const list = await engine.listFAQByCategory(categoryId)
    res.json(list)
  }))

  // 添加分类
  router.post('/categories', asyncHandler(async (req, res) => {
    const { name, code, parentId, sortOrder } = req.body
    if (!name || !code) {
      res.status(400).json({ message: '名称和编码不能为空' })
      return
    }

    const level = await categoryRepo.calculateLevel(parentId)
    if (level > 3) {
      res.status(400).json({ message: '最多支持三级分类' })
      return
    }

    await categoryRepo.create({ name, code, parentId, level, sortOrder })
    res.json({ success: true, message: `分类 "${name}" 添加成功` })
  }))

  // 删除分类
  router.delete('/categories/:id', asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id)

    if (await categoryRepo.hasChildren(id)) {
      res.status(400).json({ message: '请先删除子分类' })
      return
    }
    if (await categoryRepo.hasFAQs(id)) {
      res.status(400).json({ message: '请先移除该分类下的 FAQ' })
      return
    }

    await categoryRepo.remove(id)
    res.json({ success: true })
  }))

  // 更新 FAQ 分类
  router.put('/faq/:code/category', asyncHandler(async (req, res) => {
    const { categoryId } = req.body
    const faqRepo = await import('../repositories/faqRepo.js')
    await faqRepo.updateCategory(req.params.code, categoryId)
    res.json({ success: true })
  }))

  return router
}
