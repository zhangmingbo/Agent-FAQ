/**
 * FAQ 数据访问层
 * 
 * 封装 faq + faq_question 表的所有 SQL 操作
 * 纯数据层，不含业务逻辑
 */

import pool from '../db/pool.js'

/**
 * 获取所有 FAQ 列表（含相似问数量统计）
 */
export async function listAll() {
  const [faqs] = await pool.execute('SELECT * FROM faq ORDER BY priority DESC, id ASC')
  const [qCounts] = await pool.execute('SELECT faq_code, COUNT(*) as cnt FROM faq_question GROUP BY faq_code')
  const countMap = new Map(qCounts.map(r => [r.faq_code, r.cnt]))

  return faqs.map(faq => ({
    ...faq,
    questionCount: countMap.get(faq.code) || 0,
    hasAnswer: !!faq.answer,
    answerPreview: faq.answer ? faq.answer.substring(0, 50) + (faq.answer.length > 50 ? '...' : '') : '',
    hasRichContent: !!faq.rich_content,
    hasRelated: !!faq.related,
  }))
}

/**
 * 获取所有 FAQ 原始数据（含 rich_content/links/related JSON）
 */
export async function listAllRaw() {
  const [faqs] = await pool.execute('SELECT * FROM faq ORDER BY priority DESC, id ASC')
  return faqs
}

/**
 * 获取所有相似问（按 faq_code 分组）
 */
export async function listAllQuestions() {
  const [questions] = await pool.execute('SELECT faq_code, question, is_regex FROM faq_question')
  const questionsMap = new Map()
  for (const q of questions) {
    if (!questionsMap.has(q.faq_code)) questionsMap.set(q.faq_code, [])
    const questionText = q.is_regex ? `/${q.question}/` : q.question
    questionsMap.get(q.faq_code).push(questionText)
  }
  return questionsMap
}

/**
 * 根据 code 获取单个 FAQ 详情
 */
export async function getByCode(code) {
  const [faqs] = await pool.execute('SELECT * FROM faq WHERE code = ?', [code])
  if (!faqs.length) return null
  const faq = faqs[0]
  const [questions] = await pool.execute('SELECT question FROM faq_question WHERE faq_code = ?', [code])
  return {
    ...faq,
    richContent: faq.rich_content || null,
    links: faq.links || null,
    related: faq.related || null,
    questions: questions.map(q => q.question),
  }
}

/**
 * 创建或更新 FAQ（UPSERT）
 */
export async function upsert(faqConfig) {
  const { code, name, answer, richContent, links, related, followUp, priority, categoryId } = faqConfig
  await pool.execute(
    `INSERT INTO faq (code, name, answer, rich_content, links, related, follow_up, priority, category_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name=?, answer=?, rich_content=?, links=?, related=?, follow_up=?, priority=?, category_id=?`,
    [
      code, name, answer || null,
      richContent ? JSON.stringify(richContent) : null,
      links ? JSON.stringify(links) : null,
      related ? JSON.stringify(related) : null,
      followUp || null, priority || 0, categoryId || null,
      // ON DUPLICATE KEY UPDATE 部分
      name, answer || null,
      richContent ? JSON.stringify(richContent) : null,
      links ? JSON.stringify(links) : null,
      related ? JSON.stringify(related) : null,
      followUp || null, priority || 0, categoryId || null,
    ]
  )
}

/**
 * 替换某个 FAQ 的所有相似问（先删后插）
 */
export async function replaceQuestions(code, questions) {
  await pool.execute('DELETE FROM faq_question WHERE faq_code = ?', [code])
  if (questions && questions.length > 0) {
    for (const q of questions) {
      const isRegex = q.startsWith('/') && q.endsWith('/') && q.length > 2
      const questionText = isRegex ? q.slice(1, -1) : q
      await pool.execute(
        'INSERT INTO faq_question (faq_code, question, is_regex) VALUES (?, ?, ?)',
        [code, questionText, isRegex ? 1 : 0]
      )
    }
  }
}

/**
 * 删除 FAQ
 */
export async function remove(code) {
  await pool.execute('DELETE FROM faq WHERE code = ?', [code])
}

/**
 * 按分类获取 FAQ 列表
 */
export async function listByCategory(categoryId, subCategoryIds) {
  let sql = 'SELECT * FROM faq'
  const params = []

  if (categoryId) {
    const catIds = subCategoryIds || [categoryId]
    sql += ` WHERE category_id IN (${catIds.map(() => '?').join(',')})`
    params.push(...catIds)
  }

  sql += ' ORDER BY priority DESC, id ASC'
  const [faqs] = await pool.execute(sql, params)

  const [qCounts] = await pool.execute('SELECT faq_code, COUNT(*) as cnt FROM faq_question GROUP BY faq_code')
  const countMap = new Map(qCounts.map(r => [r.faq_code, r.cnt]))

  return faqs.map(faq => ({
    code: faq.code,
    name: faq.name,
    categoryId: faq.category_id,
    questionCount: countMap.get(faq.code) || 0,
    hasAnswer: !!faq.answer,
    answerPreview: faq.answer ? faq.answer.substring(0, 50) + (faq.answer.length > 50 ? '...' : '') : '',
  }))
}

/**
 * 更新 FAQ 的分类
 */
export async function updateCategory(code, categoryId) {
  await pool.execute('UPDATE faq SET category_id = ? WHERE code = ?', [categoryId, code])
}

/**
 * 获取各 FAQ 的相似问数量
 */
export async function getQuestionCounts() {
  const [rows] = await pool.execute('SELECT faq_code, COUNT(*) as cnt FROM faq_question GROUP BY faq_code')
  return new Map(rows.map(r => [r.faq_code, r.cnt]))
}

/**
 * 获取某个 FAQ 的全部相似问（正则带 /.../ 标记，供识别器使用）
 */
export async function getQuestions(code) {
  const [rows] = await pool.execute(
    'SELECT question, is_regex FROM faq_question WHERE faq_code = ?',
    [code]
  )
  return rows.map(r => (r.is_regex ? `/${r.question}/` : r.question))
}

/**
 * 检查相似问是否已存在
 */
export async function questionExists(faqCode, question) {
  const [rows] = await pool.execute(
    'SELECT id FROM faq_question WHERE faq_code = ? AND question = ?',
    [faqCode, question]
  )
  return rows.length > 0
}

/**
 * 添加单条相似问
 */
export async function addQuestion(faqCode, question) {
  await pool.execute(
    'INSERT INTO faq_question (faq_code, question) VALUES (?, ?)',
    [faqCode, question]
  )
}

/**
 * 批量检查文本是否已作为相似问存在
 */
export async function checkQuestions(texts) {
  if (!texts || texts.length === 0) return {}
  const placeholders = texts.map(() => '?').join(',')
  const [rows] = await pool.execute(
    `SELECT question, faq_code FROM faq_question WHERE question IN (${placeholders})`,
    texts
  )
  const results = {}
  for (const r of rows) {
    results[r.question] = { exists: true, faqCode: r.faq_code }
  }
  return results
}

/**
 * 获取相似问数量不足的 FAQ（< 5条，含名称）
 */
export async function getLowQuestionFaqs() {
  const [rows] = await pool.execute(
    `SELECT fq.faq_code, f.name, COUNT(*) as cnt
     FROM faq_question fq LEFT JOIN faq f ON f.code = fq.faq_code
     GROUP BY fq.faq_code HAVING cnt < 5`
  )
  return rows.map(r => ({ code: r.faq_code, name: r.name, count: r.cnt }))
}

/**
 * FAQ 总数统计
 */
export async function getStats() {
  const [totalFaq] = await pool.execute('SELECT COUNT(*) as cnt FROM faq')
  const [withAnswer] = await pool.execute('SELECT COUNT(*) as cnt FROM faq WHERE answer IS NOT NULL AND answer != ""')
  const [withRich] = await pool.execute('SELECT COUNT(*) as cnt FROM faq WHERE rich_content IS NOT NULL')
  const [withRelated] = await pool.execute('SELECT COUNT(*) as cnt FROM faq WHERE related IS NOT NULL')

  return {
    totalFaq: totalFaq[0].cnt,
    withAnswer: withAnswer[0].cnt,
    withRichContent: withRich[0].cnt,
    withRelated: withRelated[0].cnt,
  }
}
