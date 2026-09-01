/**
 * 任务实例存储层
 * 
 * 每次触发一个任务产生一条 task_instance 记录，
 * 跟踪任务进展状态、槽位快照、步骤轨迹。
 */

import pool from '../../db/pool.js'

/** 确保表结构存在（服务启动时调用） */
export async function ensureTable() {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS task_instance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(100) NOT NULL COMMENT '会话ID',
      task_code VARCHAR(50) NOT NULL COMMENT '任务编号',
      task_name VARCHAR(100) NOT NULL COMMENT '任务名称（冗余）',
      status VARCHAR(20) NOT NULL DEFAULT 'collecting' COMMENT 'collecting/confirming/executing/done/cancelled/transferred',
      current_step VARCHAR(50) DEFAULT NULL COMMENT '当前步骤 key',
      trigger_text TEXT COMMENT '触发原文',
      slots JSON COMMENT '槽位快照',
      turn_count INT DEFAULT 0 COMMENT '对话轮次',
      remark VARCHAR(500) DEFAULT '' COMMENT '管理员标注',
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
      finished_at DATETIME DEFAULT NULL COMMENT '结束时间',
      INDEX idx_session (session_id),
      INDEX idx_task_code (task_code),
      INDEX idx_status (status),
      INDEX idx_started (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务实例'`
  )
  // 迁移：旧表可能缺少 remark 列
  try {
    const [cols] = await pool.execute("SHOW COLUMNS FROM task_instance LIKE 'remark'")
    if (cols.length === 0) {
      await pool.execute("ALTER TABLE task_instance ADD COLUMN remark VARCHAR(500) DEFAULT '' COMMENT '管理员标注' AFTER turn_count")
      console.log('[instanceStore] 已添加 remark 列')
    }
  } catch (e) {
    console.warn('[instanceStore] remark 列迁移跳过:', e.message)
  }
}

/**
 * 创建任务实例（任务启动时调用）
 * @returns {number} 新记录的 id
 */
export async function create({ sessionId, taskCode, taskName, triggerText, userId }) {
  const [result] = await pool.execute(
    `INSERT INTO task_instance (session_id, task_code, task_name, trigger_text, user_id, status, current_step, slots, turn_count)
     VALUES (?, ?, ?, ?, ?, 'collecting', NULL, '{}', 0)`,
    [sessionId, taskCode, taskName, triggerText || null, userId || null]
  )
  return result.insertId
}

/**
 * 更新任务实例（每轮对话后调用）
 */
export async function update(id, fields) {
  const sets = []
  const values = []

  if (fields.status !== undefined) {
    sets.push('status = ?')
    values.push(fields.status)
  }
  if (fields.currentStep !== undefined) {
    sets.push('current_step = ?')
    values.push(fields.currentStep)
  }
  if (fields.slots !== undefined) {
    sets.push('slots = ?')
    values.push(JSON.stringify(fields.slots))
  }
  if (fields.turnCount !== undefined) {
    sets.push('turn_count = ?')
    values.push(fields.turnCount)
  }
  if (fields.finishedAt !== undefined) {
    sets.push('finished_at = ?')
    values.push(fields.finishedAt)
  }
  if (fields.remark !== undefined) {
    sets.push('remark = ?')
    values.push(fields.remark)
  }

  if (sets.length === 0) return

  values.push(id)
  await pool.execute(
    `UPDATE task_instance SET ${sets.join(', ')} WHERE id = ?`,
    values
  )
}

/**
 * 获取单条实例详情
 */
export async function get(id) {
  const [rows] = await pool.execute('SELECT * FROM task_instance WHERE id = ?', [id])
  if (!rows.length) return null
  return _formatRow(rows[0])
}

/**
 * 根据 sessionId + taskCode 查找最新实例
 */
export async function findBySession(sessionId, taskCode) {
  const [rows] = await pool.execute(
    'SELECT * FROM task_instance WHERE session_id = ? AND task_code = ? ORDER BY id DESC LIMIT 1',
    [sessionId, taskCode]
  )
  if (!rows.length) return null
  return _formatRow(rows[0])
}

/**
 * 分页列表（支持筛选）
 */
export async function list({ status, taskCode, date, keyword, page = 1, pageSize = 20 } = {}) {
  const where = []
  const params = []

  if (status) {
    if (status === 'active') {
      where.push("status IN ('collecting','confirming','executing','suspended')")
    } else {
      where.push('status = ?')
      params.push(status)
    }
  }
  if (taskCode) {
    where.push('task_code = ?')
    params.push(taskCode)
  }
  if (date) {
    where.push('DATE(started_at) = ?')
    params.push(date)
  }
  if (keyword) {
    where.push('(trigger_text LIKE ? OR task_name LIKE ? OR session_id LIKE ? OR task_code LIKE ?)')
    const kw = `%${keyword}%`
    params.push(kw, kw, kw, kw)
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  // 总数
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM task_instance ${whereClause}`,
    params
  )
  const total = countRows[0].total

  // 分页数据
  const offset = (page - 1) * pageSize
  const [rows] = await pool.execute(
    `SELECT * FROM task_instance ${whereClause} ORDER BY id DESC LIMIT ${Number(pageSize)} OFFSET ${Number(offset)}`,
    params
  )

  return {
    items: rows.map(_formatRow),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  }
}

/**
 * 统计卡片数据
 */
export async function stats() {
  const [rows] = await pool.execute(`
    SELECT
      COUNT(CASE WHEN status IN ('collecting','confirming','executing','suspended') THEN 1 END) AS active,
      COUNT(CASE WHEN status = 'done' THEN 1 END) AS done,
      COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled,
      COUNT(CASE WHEN DATE(started_at) = CURDATE() THEN 1 END) AS todayTotal
    FROM task_instance
  `)
  const s = rows[0]
  return {
    active: s.active || 0,
    done: s.done || 0,
    cancelled: s.cancelled || 0,
    todayTotal: s.todayTotal || 0,
  }
}

/**
 * 删除实例记录
 */
export async function remove(id) {
  const [result] = await pool.execute('DELETE FROM task_instance WHERE id = ?', [id])
  return result.affectedRows > 0
}

// ===== 内部工具 =====

function _formatRow(row) {
  return {
    id: row.id,
    session_id: row.session_id,
    task_code: row.task_code,
    task_name: row.task_name,
    status: row.status,
    current_step: row.current_step,
    trigger_text: row.trigger_text || '',
    slots: _parseJson(row.slots, {}),
    turn_count: row.turn_count || 0,
    remark: row.remark || '',
    started_at: _formatDate(row.started_at),
    updated_at: _formatDate(row.updated_at),
    finished_at: row.finished_at ? _formatDate(row.finished_at) : null,
  }
}

function _parseJson(raw, fallback) {
  if (!raw) return fallback
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return fallback }
}

function _formatDate(d) {
  if (!d) return ''
  if (typeof d === 'string') return d.replace('T', ' ').slice(0, 19)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export default { ensureTable, create, update, get, findBySession, list, stats, remove }
