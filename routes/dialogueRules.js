/**
 * 对话规则管理路由
 * GET/POST /api/dialogue-rules, reset, export, import, stats, logs
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as configRepo from '../repositories/configRepo.js'

export function createRouter(engine, ruleLoader, dialogueRules) {
  const router = Router()

  // 获取对话规则配置
  router.get('/dialogue-rules', asyncHandler(async (req, res) => {
    const rules = ruleLoader.getCurrentRules()
    res.json(rules)
  }))

  // 更新对话规则配置
  router.post('/dialogue-rules', asyncHandler(async (req, res) => {
    const { confirmWords, denyWords, meaninglessWords, resumeWords, sessionTimeout } = req.body

    if (!Array.isArray(confirmWords) || !Array.isArray(denyWords) || !Array.isArray(meaninglessWords)) {
      res.status(400).json({ success: false, message: '参数格式错误' })
      return
    }

    await configRepo.set('dialogue_rules', JSON.stringify({
      confirmWords,
      denyWords,
      meaninglessWords,
      resumeWords: Array.isArray(resumeWords) ? resumeWords : [],
    }))

    if (typeof sessionTimeout === 'number' && sessionTimeout > 0) {
      await configRepo.set('session_timeout', String(sessionTimeout))
    }

    await ruleLoader.refreshRules()

    res.json({ success: true, version: ruleLoader.getCurrentRules().version })
  }))

  // 重置为默认规则
  router.post('/dialogue-rules/reset', asyncHandler(async (req, res) => {
    await configRepo.remove(['dialogue_rules', 'session_timeout'])
    dialogueRules.resetToDefaults()
    res.json({ success: true, message: '已重置为默认规则' })
  }))

  // 导出规则配置
  router.get('/dialogue-rules/export', asyncHandler(async (req, res) => {
    const jsonStr = dialogueRules.exportToJson()
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="dialogue-rules-${Date.now()}.json"`)
    res.send(jsonStr)
  }))

  // 导入规则配置
  router.post('/dialogue-rules/import', asyncHandler(async (req, res) => {
    const { jsonData } = req.body
    if (!jsonData) {
      res.status(400).json({ success: false, message: '缺少 jsonData 参数' })
      return
    }

    const success = dialogueRules.importFromJson(jsonData)
    if (success) {
      const rules = dialogueRules.getRules()
      await configRepo.set('dialogue_rules', JSON.stringify({
        confirmWords: rules.confirmWords,
        denyWords: rules.denyWords,
        meaninglessWords: rules.meaninglessWords,
        resumeWords: rules.resumeWords || [],
      }))
      res.json({ success: true, version: rules.version })
    } else {
      res.status(400).json({ success: false, message: '导入失败，JSON 格式错误' })
    }
  }))

  // 获取命中率统计
  router.get('/dialogue-rules/stats', asyncHandler(async (req, res) => {
    const stats = dialogueRules.getHitStats()
    res.json(stats)
  }))

  // 重置命中率统计
  router.post('/dialogue-rules/stats/reset', asyncHandler(async (req, res) => {
    dialogueRules.resetHitStats()
    res.json({ success: true, message: '统计数据已重置' })
  }))

  // 获取匹配日志
  router.get('/dialogue-rules/logs', asyncHandler(async (req, res) => {
    const { type, limit, keyword } = req.query
    const options = {}
    if (type) options.type = type
    if (limit) options.limit = parseInt(limit)
    if (keyword) options.keyword = keyword

    const logs = dialogueRules.getMatchLogs(options)
    res.json({ success: true, count: logs.length, logs })
  }))

  // 清空匹配日志
  router.post('/dialogue-rules/logs/clear', asyncHandler(async (req, res) => {
    dialogueRules.clearMatchLogs()
    res.json({ success: true, message: '日志已清空' })
  }))

  return router
}
