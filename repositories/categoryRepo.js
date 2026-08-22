/**
 * 分类数据访问层
 * 
 * 封装 faq_category 表的所有 SQL 操作
 */

import pool from '../db/pool.js'

/**
 * 获取分类树形结构（含每个分类下的 FAQ 数量）
 */
export async function listTree() {
  const [cats] = await pool.execute(
    'SELECT * FROM faq_category ORDER BY level, sort_order, id'
  )
  const [faqCounts] = await pool.execute(
    'SELECT category_id, COUNT(*) as cnt FROM faq GROUP BY category_id'
  )
  const countMap = new Map(faqCounts.map(r => [r.category_id, r.cnt]))

  const tree = []
  const catMap = new Map()

  for (const cat of cats) {
    const node = {
      id: cat.id,
      name: cat.name,
      code: cat.code,
      parentId: cat.parent_id,
      level: cat.level,
      sortOrder: cat.sort_order,
      faqCount: countMap.get(cat.id) || 0,
      children: [],
    }
    catMap.set(cat.id, node)

    if (cat.parent_id === 0) {
      tree.push(node)
    } else {
      const parent = catMap.get(cat.parent_id)
      if (parent) parent.children.push(node)
    }
  }

  return tree
}

/**
 * 根据 ID 获取分类
 */
export async function getById(id) {
  const [rows] = await pool.execute('SELECT * FROM faq_category WHERE id = ?', [id])
  return rows.length ? rows[0] : null
}

/**
 * 创建分类
 */
export async function create({ name, code, parentId, level, sortOrder }) {
  await pool.execute(
    'INSERT INTO faq_category (name, code, parent_id, level, sort_order) VALUES (?, ?, ?, ?, ?)',
    [name, code, parentId || 0, level, sortOrder || 0]
  )
}

/**
 * 删除分类
 */
export async function remove(id) {
  await pool.execute('DELETE FROM faq_category WHERE id = ?', [id])
}

/**
 * 检查是否有子分类
 */
export async function hasChildren(id) {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) as cnt FROM faq_category WHERE parent_id = ?', [id]
  )
  return rows[0].cnt > 0
}

/**
 * 检查分类下是否有 FAQ
 */
export async function hasFAQs(id) {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) as cnt FROM faq WHERE category_id = ?', [id]
  )
  return rows[0].cnt > 0
}

/**
 * 获取子分类 ID 列表（含自身）
 */
export async function getSubCategoryIds(categoryId) {
  const [rows] = await pool.execute(
    'SELECT id FROM faq_category WHERE id = ? OR parent_id = ?',
    [categoryId, categoryId]
  )
  return rows.map(r => r.id)
}

/**
 * 计算分类层级（根据 parentId）
 */
export async function calculateLevel(parentId) {
  if (!parentId) return 1
  const [parent] = await pool.execute(
    'SELECT level FROM faq_category WHERE id = ?', [parentId]
  )
  return parent.length ? parent[0].level + 1 : 1
}
