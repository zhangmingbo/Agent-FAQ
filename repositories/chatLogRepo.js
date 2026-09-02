/**
 * 聊天日志数据访问层
 * 
 * 封装 chat_log 表的所有 SQL 操作
 */

import pool from '../db/pool.js'

/**
 * 记录聊天日志
 */
export async function log({ sessionId, userId, userText, intentCode, confidence, source, answer, meaningful }) {
  await pool.execute(
    'INSERT INTO chat_log (session_id, user_id, user_text, intent_code, confidence, source, answer, meaningful) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',    [sessionId, userId, userText, intentCode || null, confidence || 0, source || null, answer, meaningful]
  )
}

/**
 * 未匹配问题列表（分页/日期/搜索/排序）
 */
export async function getUnmatched({ date, keyword, sortBy = 'count', sortOrder = 'desc', page = 1, pageSize = 20, ignored = [] }) {
  let where = "WHERE intent_code IS NULL AND source IN ('fallback', 'clarify') AND meaningful = 1 AND (is_hidden IS NULL OR is_hidden = 0)"
  const params = []

  if (date) {
    where += ' AND DATE(created_at) = ?'
    params.push(date)
  }
  if (keyword) {
    where += ' AND user_text LIKE ?'
    params.push(`%${keyword}%`)
  }
  if (ignored && ignored.length) {
    where += ` AND user_text NOT IN (${ignored.map(() => '?').join(',')})`
    params.push(...ignored)
  }

  console.log('[ChatLogRepo] getUnmatched WHERE:', where)
  console.log('[ChatLogRepo] getUnmatched params:', params)

  // 总数
  const [countRows] = await pool.execute(
    `SELECT COUNT(DISTINCT user_text) as total FROM chat_log ${where}`, params
  )
  const total = countRows[0].total

  // 排序 - 使用白名单验证防止SQL注入
  const orderMap = { count: 'cnt', lastTime: 'last_time', text: 'user_text' }
  const orderField = orderMap[sortBy] || 'cnt'
  const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC'
  // 白名单验证，只允许预定义的字段
  const allowedFields = ['cnt', 'last_time', 'user_text']
  const safeOrderField = allowedFields.includes(orderField) ? orderField : 'cnt'
  const safeOrderDir = orderDir === 'ASC' ? 'ASC' : 'DESC'

  // 分页查询
  const offset = (parseInt(page) - 1) * parseInt(pageSize)
  const limit = parseInt(pageSize)
  console.log('[ChatLogRepo] getUnmatched WHERE:', where)
  console.log('[ChatLogRepo] getUnmatched params:', params)
  console.log('[ChatLogRepo] getUnmatched limit:', limit, 'offset:', offset)
    
  const [rows] = await pool.execute(
    `SELECT user_text, COUNT(*) as cnt,
            DATE_FORMAT(MAX(created_at), '%Y/%c/%e %H:%i:%s') as last_time,
            DATE_FORMAT(MIN(created_at), '%Y/%c/%e %H:%i:%s') as first_time,
            SUBSTRING_INDEX(GROUP_CONCAT(answer ORDER BY created_at DESC SEPARATOR '|||'), '|||', 1) as last_answer
     FROM chat_log ${where}
     GROUP BY user_text
     ORDER BY ${safeOrderField} ${safeOrderDir}
     LIMIT ${limit} OFFSET ${offset}`,
    params
  )

  return {
    total,
    page: parseInt(page),
    pageSize: parseInt(pageSize),
    totalPages: Math.ceil(total / parseInt(pageSize)),
    items: rows.map(r => ({
      text: r.user_text,
      count: r.cnt,
      lastTime: r.last_time,
      firstTime: r.first_time,
      answer: r.last_answer,
    })),
  }
}

/**
 * 低置信度列表（分页/日期/搜索/排序）
 */
export async function getLowConfidence({ date, keyword, sortBy = 'confidence', sortOrder = 'asc', page = 1, pageSize = 20, maxConfidence = 0.7, ignored = [] }) {
  let where = `WHERE confidence > 0 AND confidence < ${parseFloat(maxConfidence)} AND intent_code IS NOT NULL AND meaningful = 1 AND (is_hidden IS NULL OR is_hidden = 0)`
  const params = []

  if (date) {
    where += ' AND DATE(created_at) = ?'
    params.push(date)
  }
  if (keyword) {
    where += ' AND user_text LIKE ?'
    params.push(`%${keyword}%`)
  }
  if (ignored && ignored.length) {
    where += ` AND user_text NOT IN (${ignored.map(() => '?').join(',')})`
    params.push(...ignored)
  }

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) as total FROM chat_log ${where}`, params
  )
  const total = countRows[0].total

  const orderMap = { confidence: 'confidence', time: 'created_at', text: 'user_text', intent: 'intent_code' }
  const orderField = orderMap[sortBy] || 'confidence'
  const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC'
  // 白名单验证
  const allowedFields = ['confidence', 'created_at', 'user_text', 'intent_code']
  const safeOrderField = allowedFields.includes(orderField) ? orderField : 'confidence'
  const safeOrderDir = orderDir === 'ASC' ? 'ASC' : 'DESC'

  const offset = (parseInt(page) - 1) * parseInt(pageSize)
  const limit = parseInt(pageSize)
  const [rows] = await pool.execute(
    `SELECT user_text, intent_code, confidence,
            DATE_FORMAT(created_at, '%Y/%c/%e %H:%i:%s') as created_at,
            answer
     FROM chat_log ${where}
     ORDER BY ${safeOrderField} ${safeOrderDir}
     LIMIT ${limit} OFFSET ${offset}`,
    params
  )

  return {
    total,
    page: parseInt(page),
    pageSize: parseInt(pageSize),
    totalPages: Math.ceil(total / parseInt(pageSize)),
    items: rows.map(r => ({
      text: r.user_text,
      intent: r.intent_code,
      confidence: parseFloat(r.confidence),
      time: r.created_at,
      answer: r.answer,
    })),
  }
}

/**
 * 获取可用日期列表（按类型）
 */
export async function getDates(type, maxConfidence = 0.7) {
  let where = ''
  if (type === 'unmatched') {
    where = "WHERE intent_code IS NULL AND source IN ('fallback', 'clarify') AND meaningful = 1 AND (is_hidden IS NULL OR is_hidden = 0)"
  } else if (type === 'low-confidence') {
    where = `WHERE confidence > 0 AND confidence < ${parseFloat(maxConfidence)} AND intent_code IS NOT NULL AND meaningful = 1 AND (is_hidden IS NULL OR is_hidden = 0)`
  } else if (type === 'recent') {
    where = 'WHERE meaningful = 1 AND (is_hidden IS NULL OR is_hidden = 0)'
  }
  const [rows] = await pool.execute(
    `SELECT DISTINCT DATE(created_at) as date, COUNT(*) as cnt
     FROM chat_log ${where}
     GROUP BY DATE(created_at)
     ORDER BY date DESC
     LIMIT 30`
  )
  return rows.map(r => ({ date: r.date, count: r.cnt }))
}

/**
 * 最近咨询记录（按会话聚合，分页/日期/搜索/排序）
 */
export async function getRecent({ date, keyword, sortBy = 'time', sortOrder = 'desc', page = 1, pageSize = 20 }) {
  let where = 'WHERE meaningful = 1 AND (is_hidden IS NULL OR is_hidden = 0)'
  const params = []

  if (date) {
    where += ' AND DATE(created_at) = ?'
    params.push(date)
  }
  if (keyword) {
    where += ' AND user_text LIKE ?'
    params.push(`%${keyword}%`)
  }

  // 按会话聚合计数
  const [countRows] = await pool.execute(
    `SELECT COUNT(DISTINCT session_id) as total FROM chat_log ${where}`, params
  )
  const total = countRows[0].total

  const orderMap = { time: 'last_time', msgCount: 'msg_count', userId: 'user_id' }
  const orderField = orderMap[sortBy] || 'last_time'
  const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC'
  // 白名单验证
  const allowedFields = ['last_time', 'msg_count', 'user_id']
  const safeOrderField = allowedFields.includes(orderField) ? orderField : 'last_time'
  const safeOrderDir = orderDir === 'ASC' ? 'ASC' : 'DESC'

  const offset = (parseInt(page) - 1) * parseInt(pageSize)
  const limit = parseInt(pageSize)
  const [rows] = await pool.execute(
    `SELECT session_id, ANY_VALUE(user_id) as user_id, COUNT(*) as msg_count,
            DATE_FORMAT(MIN(created_at), '%Y/%c/%e %H:%i:%s') as start_time,
            DATE_FORMAT(MAX(created_at), '%Y/%c/%e %H:%i:%s') as last_time,
            SUBSTRING_INDEX(GROUP_CONCAT(user_text ORDER BY created_at ASC SEPARATOR '|||'), '|||', 1) as first_question,
            SUBSTRING_INDEX(GROUP_CONCAT(answer ORDER BY created_at DESC SEPARATOR '|||'), '|||', 1) as last_answer
     FROM chat_log ${where}
     GROUP BY session_id
     ORDER BY ${safeOrderField} ${safeOrderDir}
     LIMIT ${limit} OFFSET ${offset}`,
    params
  )

  return {
    total,
    page: parseInt(page),
    pageSize: parseInt(pageSize),
    totalPages: Math.ceil(total / parseInt(pageSize)),
    items: rows.map(r => ({
      sessionId: r.session_id,
      userId: r.user_id,
      msgCount: r.msg_count,
      startTime: r.start_time,
      lastTime: r.last_time,
      firstQuestion: r.first_question,
      lastAnswer: r.last_answer,
    })),
  }
}

/**
 * 最近咨询记录可用日期
 */
export async function getRecentDates() {
  const [rows] = await pool.execute(
    `SELECT DISTINCT DATE(created_at) as date, COUNT(*) as cnt
     FROM chat_log WHERE meaningful = 1
     GROUP BY DATE(created_at)
     ORDER BY date DESC
     LIMIT 30`
  )
  return rows.map(r => ({ date: r.date, count: r.cnt }))
}

/**
 * 获取某个会话的完整对话记录
 */
export async function getSessionDetail(sessionId) {
  const [rows] = await pool.execute(
    `SELECT user_id, user_text, intent_code, confidence, source, answer,
            DATE_FORMAT(created_at, '%H:%i:%s') as time
     FROM chat_log WHERE session_id = ? AND meaningful = 1
     ORDER BY created_at ASC`,
    [sessionId]
  )
  if (!rows.length) return null
  return {
    sessionId,
    userId: rows[0].user_id,
    msgCount: rows.length,
    messages: rows.map(r => ({
      question: r.user_text,
      answer: r.answer,
      intent: r.intent_code,
      confidence: parseFloat(r.confidence || 0),
      source: r.source,
      time: r.time,
    })),
  }
}

/**
 * 实时问答日志（调试用）
 */
export async function getLive({ limit = 20, keyword, intent, source, userId }) {
  let sql = 'SELECT * FROM chat_log WHERE meaningful = 1'
  const params = []

  if (keyword) {
    sql += ' AND user_text LIKE ?'
    params.push(`%${keyword}%`)
  }
  if (intent) {
    sql += ' AND intent_code = ?'
    params.push(intent)
  }
  if (source) {
    sql += ' AND source = ?'
    params.push(source)
  }
  if (userId) {
    sql += ' AND user_id = ?'
    params.push(userId)
  }

  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(parseInt(limit))

  const [rows] = await pool.execute(sql, params)

  return rows.map(row => ({
    id: row.id,
    time: row.created_at,
    userId: row.user_id || '-',
    question: row.user_text,
    intent: row.intent_code || '未匹配',
    confidence: row.confidence,
    source: row.source,
    answer: row.answer,
    sessionId: row.session_id,
  }))
}

// ========== 统计分析查询 ==========

/**
 * 服务统计数据（监控概览）
 */
export async function getServiceStats() {
  const [total] = await pool.execute('SELECT COUNT(*) as cnt FROM chat_log')
  const [today] = await pool.execute('SELECT COUNT(*) as cnt FROM chat_log WHERE DATE(created_at) = CURDATE()')
  const [avgConf] = await pool.execute('SELECT AVG(confidence) as avg_conf FROM chat_log WHERE confidence > 0')
  const [bySource] = await pool.execute('SELECT source, COUNT(*) as cnt FROM chat_log GROUP BY source')
  const [recent] = await pool.execute('SELECT * FROM chat_log ORDER BY created_at DESC LIMIT 10')
  const [topIntents] = await pool.execute(
    'SELECT intent_code, COUNT(*) as cnt FROM chat_log WHERE intent_code IS NOT NULL GROUP BY intent_code ORDER BY cnt DESC LIMIT 10'
  )

  const sourceMap = {}
  for (const s of bySource) sourceMap[s.source || 'unknown'] = s.cnt

  return {
    totalRequests: total[0].cnt,
    todayRequests: today[0].cnt,
    avgConfidence: avgConf[0].avg_conf ? parseFloat(avgConf[0].avg_conf).toFixed(3) : 0,
    bySource: sourceMap,
    recentLogs: recent.map(r => ({
      time: r.created_at,
      userText: r.user_text,
      intent: r.intent_code,
      confidence: r.confidence,
      source: r.source,
    })),
    topIntents: topIntents.map(t => ({ code: t.intent_code, count: t.cnt })),
  }
}

/**
 * 未匹配问题聚合（智能分析用）
 */
export async function getUnmatchedForAnalysis() {
  const [rows] = await pool.execute(
    `SELECT user_text, COUNT(*) as cnt, MAX(created_at) as last_time
     FROM chat_log 
     WHERE intent_code IS NULL AND source IN ('fallback', 'clarify')
     GROUP BY user_text 
     ORDER BY cnt DESC 
     LIMIT 50`
  )
  return rows.map(r => ({ text: r.user_text, count: r.cnt, lastTime: r.last_time }))
}

/**
 * 低置信度匹配（智能分析用）
 */
export async function getLowConfidenceForAnalysis(maxConfidence = 0.7) {
  const [rows] = await pool.execute(
    `SELECT user_text, intent_code, confidence, created_at
     FROM chat_log 
     WHERE confidence > 0 AND confidence < ${parseFloat(maxConfidence)} AND intent_code IS NOT NULL
     ORDER BY created_at DESC 
     LIMIT 50`
  )
  return rows.map(r => ({
    text: r.user_text,
    intent: r.intent_code,
    confidence: parseFloat(r.confidence),
    time: r.created_at,
  }))
}

/**
 * 高频问题 Top 20
 */
export async function getTopQuestions() {
  const [rows] = await pool.execute(
    `SELECT user_text, intent_code, COUNT(*) as cnt, 
            AVG(confidence) as avg_conf, MAX(created_at) as last_time
     FROM chat_log 
     WHERE intent_code IS NOT NULL
     GROUP BY user_text, intent_code
     ORDER BY cnt DESC 
     LIMIT 20`
  )
  return rows.map(r => ({
    text: r.user_text,
    intent: r.intent_code,
    count: r.cnt,
    avgConfidence: parseFloat(r.avg_conf),
    lastTime: r.last_time,
  }))
}

/**
 * 近 7 天趋势
 */
export async function getTrend() {
  const [rows] = await pool.execute(
    `SELECT DATE(created_at) as date, COUNT(*) as total,
            SUM(CASE WHEN intent_code IS NOT NULL THEN 1 ELSE 0 END) as matched,
            SUM(CASE WHEN source = 'fallback' THEN 1 ELSE 0 END) as fallback,
            AVG(CASE WHEN confidence > 0 THEN confidence ELSE NULL END) as avg_conf
     FROM chat_log 
     WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
     GROUP BY DATE(created_at)
     ORDER BY date`
  )
  return rows.map(r => ({
    date: r.date,
    total: r.total,
    matched: r.matched,
    fallback: r.fallback,
    avgConfidence: r.avg_conf ? parseFloat(r.avg_conf).toFixed(3) : 0,
  }))
}

/**
 * 转人工/无意义输入统计
 */
export async function getFallbackStats() {
  const [rows] = await pool.execute(
    `SELECT user_text, COUNT(*) as cnt FROM chat_log 
     WHERE source = 'fallback'
     GROUP BY user_text ORDER BY cnt DESC LIMIT 20`
  )
  return rows.map(r => ({ text: r.user_text, count: r.cnt }))
}

/**
 * 单条隐藏：根据问题文本隐藏所有相关记录
 */
export async function hideByText(text) {
  const [result] = await pool.execute(
    'UPDATE chat_log SET is_hidden = 1 WHERE user_text = ?',
    [text]
  )
  return result.affectedRows
}

/**
 * 批量隐藏：根据问题文本列表隐藏
 */
export async function batchHideByTexts(texts) {
  if (texts.length === 0) return 0
  
  const placeholders = texts.map(() => '?').join(',')
  const [result] = await pool.execute(
    `UPDATE chat_log SET is_hidden = 1 WHERE user_text IN (${placeholders})`,
    texts
  )
  return result.affectedRows
}
