/**
 * 动作输出日志 API（流程引擎审计）
 * GET  /api/action-logs          列表（筛选 task/status/session + 分页）
 * GET  /api/action-logs/:id      详情（含完整 payload/response）
 * POST /api/action-logs/:id/resend  重发（业务系统恢复后补数据）
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import pool from '../db/pool.js'
import { deliver } from '../services/taskflow/actionRegistry.js'

export function createRouter() {
  const router = Router()

  // 列表
  router.get('/action-logs', asyncHandler(async (req, res) => {
    const { task, status, session, page = 1, limit = 20 } = req.query
    const where = []
    const params = []
    if (task) { where.push('task_code = ?'); params.push(task) }
    if (status) { where.push('status = ?'); params.push(status) }
    if (session) { where.push('session_id = ?'); params.push(session) }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : ''
    const limitN = Math.min(parseInt(limit) || 20, 100)
    const pageN = Math.max(parseInt(page) || 1, 1)
    const offset = (pageN - 1) * limitN
    const [rows] = await pool.execute(
      `SELECT id, session_id, task_code, action, status, url, error, retries, duration_ms, resent_at, created_at,
              LEFT(CAST(payload AS CHAR), 200) AS payload_preview
       FROM action_log${whereSql} ORDER BY id DESC LIMIT ${limitN} OFFSET ${offset}`,
      params
    )
    const [cnt] = await pool.execute(`SELECT COUNT(*) AS c FROM action_log${whereSql}`, params)
    res.json({ success: true, data: { items: rows, total: cnt[0].c, page: pageN, limit: limitN } })
  }))

  // 详情
  router.get('/action-logs/:id', asyncHandler(async (req, res) => {
    const [rows] = await pool.execute('SELECT * FROM action_log WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ success: false, message: '日志不存在' })
    if (rows[0].payload) { try { rows[0].payload = JSON.parse(rows[0].payload) } catch { /* 保留原文 */ } }
    res.json({ success: true, data: rows[0] })
  }))

  // 重发（业务系统恢复后补数据：用原 payload 重新投递）
  router.post('/action-logs/:id/resend', asyncHandler(async (req, res) => {
    const [rows] = await pool.execute('SELECT * FROM action_log WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ success: false, message: '日志不存在' })
    const row = rows[0]
    let payload = row.payload
    try { payload = JSON.parse(payload) } catch { /* 保留原文 */ }
    const r = await deliver(payload, { url: row.url, method: 'POST', timeout: 10000 })
    if (r.ok) {
      await pool.execute(
        "UPDATE action_log SET status = 'ok', error = NULL, response = ?, retries = 0, resent_at = NOW() WHERE id = ?",
        [String(r.text || '').slice(0, 2000), row.id]
      )
      res.json({ success: true, message: '重发成功，数据已补发' })
    } else {
      res.json({ success: false, message: '重发失败: ' + (r.error || ('HTTP ' + (r.status || '?'))) })
    }
  }))

  return router
}
