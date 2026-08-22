/**
 * FAQ 管理路由
 * GET/POST/DELETE /api/faq, POST /api/faq/import, /api/faq/import/csv, GET /api/faq/template
 */

import { Router } from 'express'
import express from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'

export function createRouter(engine) {
  const router = Router()

  // 获取 FAQ 列表
  router.get('/faq', asyncHandler(async (req, res) => {
    const list = await engine.listFAQ()
    res.json(list)
  }))

  // 获取单个 FAQ 详情
  router.get('/faq/:code', asyncHandler(async (req, res) => {
    const faq = await engine.getFAQ(req.params.code)
    if (!faq) {
      res.status(404).json({ message: 'FAQ 不存在' })
      return
    }
    res.json(faq)
  }))

  // 添加 FAQ
  router.post('/faq', asyncHandler(async (req, res) => {
    await engine.addFAQ(req.body)
    res.json({ success: true, message: `FAQ "${req.body.name}" 添加成功` })
  }))

  // 删除 FAQ
  router.delete('/faq/:code', asyncHandler(async (req, res) => {
    const removed = await engine.removeFAQ(req.params.code)
    res.json({ success: removed })
  }))

  // 批量导入 FAQ（JSON 格式）
  router.post('/faq/import', asyncHandler(async (req, res) => {
    const { faqs, defaultCategoryId } = req.body
    if (!Array.isArray(faqs) || faqs.length === 0) {
      res.status(400).json({ success: false, message: '导入数据不能为空' })
      return
    }

    let successCount = 0
    let failCount = 0
    const errors = []

    for (let i = 0; i < faqs.length; i++) {
      const faq = faqs[i]
      try {
        if (!faq.code || !faq.name) throw new Error('编码和名称不能为空')
        if (!faq.questions || faq.questions.length === 0) throw new Error('相似问不能为空')

        let questions = faq.questions
        if (typeof questions === 'string') {
          questions = questions.split('\n').map(s => s.trim()).filter(Boolean)
        }

        await engine.addFAQ({
          code: faq.code.trim(),
          name: faq.name.trim(),
          questions,
          answer: faq.answer || null,
          categoryId: faq.categoryId || defaultCategoryId || null,
        })
        successCount++
      } catch (e) {
        failCount++
        errors.push({ index: i + 1, code: faq.code || '-', error: e.message })
      }
    }

    res.json({ success: true, total: faqs.length, successCount, failCount, errors })
  }))

  // 批量导入 FAQ（CSV 格式）
  router.post('/faq/import/csv', express.text({ type: 'text/csv', limit: '10mb' }), asyncHandler(async (req, res) => {
    const csvText = req.body
    if (!csvText) {
      res.status(400).json({ success: false, message: 'CSV 内容不能为空' })
      return
    }

    const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) {
      res.status(400).json({ success: false, message: 'CSV 至少需要包含表头和一行数据' })
      return
    }

    const headers = parseCSVLine(lines[0])
    const headerMap = {
      code: headers.indexOf('code'),
      name: headers.indexOf('name'),
      questions: headers.indexOf('questions'),
      answer: headers.indexOf('answer'),
      category: headers.indexOf('category'),
    }

    if (headerMap.code === -1 || headerMap.name === -1 || headerMap.questions === -1) {
      res.status(400).json({ success: false, message: 'CSV 必须包含 code, name, questions 列' })
      return
    }

    const faqs = []
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i])
      faqs.push({
        code: cols[headerMap.code] || '',
        name: cols[headerMap.name] || '',
        questions: cols[headerMap.questions] || '',
        answer: headerMap.answer !== -1 ? cols[headerMap.answer] : '',
        category: headerMap.category !== -1 ? cols[headerMap.category] : '',
      })
    }

    // 调用 JSON 导入逻辑
    const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }))
    const result = await fetch('http://localhost:' + (engine._port || 3001) + '/api/faq/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ faqs }),
    }).then(r => r.json())

    res.json(result)
  }))

  // 下载导入模板（CSV）
  router.get('/faq/template', (req, res) => {
    const template = `code,name,questions,answer,category
gas_price,气价查询,"天然气多少钱
气价是多少
燃气价格",当前气价为2.53元/方,gas_price_cat
`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename=faq-template.csv')
    res.send('\ufeff' + template)
  })

  return router
}

// CSV 行解析（支持引号）
function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())
  return result
}
