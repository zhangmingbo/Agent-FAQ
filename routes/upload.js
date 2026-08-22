/**
 * 文件上传路由
 * POST /api/upload, GET /api/uploads, DELETE /api/uploads/:name
 */

import { Router } from 'express'
import { randomUUID } from 'crypto'
import { writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { asyncHandler } from '../middleware/errorHandler.js'
import config from '../config/index.js'

export function createRouter(engine, uploadsDir) {
  const router = Router()

  // 获取今日上传目录路径
  function getTodayUploadDir() {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const dateDir = join(uploadsDir, String(year), month, day)
    if (!existsSync(dateDir)) mkdirSync(dateDir, { recursive: true })
    return { dir: dateDir, datePath: `${year}/${month}/${day}` }
  }

  // 上传文件（base64 方式）
  router.post('/upload', asyncHandler(async (req, res) => {
    const { filename, data, type } = req.body
    if (!filename || !data) {
      res.status(400).json({ message: '文件名和数据不能为空' })
      return
    }

    if (type && !config.upload.allowedTypes.includes(type)) {
      res.status(400).json({ message: `不支持的文件类型: ${type}` })
      return
    }

    const ext = filename.split('.').pop() || 'bin'
    const uniqueName = `${randomUUID().substring(0, 8)}.${ext}`
    const { dir, datePath } = getTodayUploadDir()

    const buffer = Buffer.from(data, 'base64')
    writeFileSync(join(dir, uniqueName), buffer)

    res.json({
      success: true,
      url: `/uploads/${datePath}/${uniqueName}`,
      filename: uniqueName,
      originalName: filename,
      size: buffer.length,
      type: type || 'application/octet-stream',
      datePath,
    })
  }))

  // 获取已上传文件列表
  router.get('/uploads', asyncHandler(async (req, res) => {
    const files = readdirSync(uploadsDir).map(name => {
      const stat = statSync(join(uploadsDir, name))
      return {
        name,
        url: `/uploads/${name}`,
        size: stat.size,
        createdAt: stat.birthtime,
      }
    }).sort((a, b) => b.createdAt - a.createdAt)
    res.json(files)
  }))

  // 删除已上传文件
  router.delete('/uploads/:name', asyncHandler(async (req, res) => {
    const filePath = join(uploadsDir, req.params.name)
    unlinkSync(filePath)
    res.json({ success: true })
  }))

  return router
}
