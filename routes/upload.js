/**
 * 文件上传路由
 * POST /api/upload, GET /api/uploads, DELETE /api/uploads/:name
 */

import { Router } from 'express'
import { randomUUID } from 'crypto'
import { writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
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

    // 防止路径穿越：只取文件名部分
    const safeFilename = basename(filename)
    if (!safeFilename || safeFilename !== filename) {
      res.status(400).json({ message: '非法的文件名' })
      return
    }

    // 校验扩展名（白名单）
    const ext = safeFilename.split('.').pop()?.toLowerCase() || 'bin'
    const allowedExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'doc', 'docx', 'txt', 'csv', 'xlsx']
    if (!allowedExts.includes(ext)) {
      res.status(400).json({ message: `不支持的文件类型: .${ext}` })
      return
    }

    // 校验 MIME type（如果提供）
    if (type && !config.upload.allowedTypes.includes(type)) {
      res.status(400).json({ message: `不支持的文件类型: ${type}` })
      return
    }

    const uniqueName = `${randomUUID().substring(0, 8)}.${ext}`
    const { dir, datePath } = getTodayUploadDir()

    const buffer = Buffer.from(data, 'base64')
    writeFileSync(join(dir, uniqueName), buffer)

    res.json({
      success: true,
      url: `/uploads/${datePath}/${uniqueName}`,
      filename: uniqueName,
      originalName: safeFilename,
      size: buffer.length,
      type: type || 'application/octet-stream',
      datePath,
    })
  }))

  // 递归获取所有上传文件（包括子目录）
  function getAllFiles(dir, relativePath = '') {
    const files = []
    const items = readdirSync(dir)
    for (const item of items) {
      const fullPath = join(dir, item)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        // 递归子目录
        const subFiles = getAllFiles(fullPath, join(relativePath, item))
        files.push(...subFiles)
      } else {
        // 文件
        files.push({
          name: join(relativePath, item).replace(/^\\/g, ''), // 移除前导反斜杠
          url: `/uploads/${join(relativePath, item).replace(/\\/g, '/')}`,
          size: stat.size,
          createdAt: stat.birthtime,
        })
      }
    }
    return files
  }

  // 获取已上传文件列表
  router.get('/uploads', asyncHandler(async (req, res) => {
    const files = getAllFiles(uploadsDir)
      .sort((a, b) => b.createdAt - a.createdAt)
    res.json(files)
  }))

  // 删除已上传文件
  router.delete('/uploads/:name', asyncHandler(async (req, res) => {
    // 防止路径穿越：只允许文件名，不允许路径
    const filename = basename(req.params.name)
    if (!filename || filename !== req.params.name) {
      res.status(400).json({ message: '非法的文件名' })
      return
    }

    // 递归查找文件（因为文件可能在子目录中）
    function findFile(dir, targetName) {
      const items = readdirSync(dir)
      for (const item of items) {
        const fullPath = join(dir, item)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          const found = findFile(fullPath, targetName)
          if (found) return found
        } else if (item === targetName) {
          return fullPath
        }
      }
      return null
    }

    const filePath = findFile(uploadsDir, filename)
    if (!filePath) {
      res.status(404).json({ message: '文件不存在' })
      return
    }

    unlinkSync(filePath)
    res.json({ success: true })
  }))

  return router
}
