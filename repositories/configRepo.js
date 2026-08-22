/**
 * 系统配置数据访问层
 * 
 * 封装 sys_config 表的所有 SQL 操作
 */

import pool from '../db/pool.js'

/**
 * 获取所有配置（key-value 对象）
 */
export async function getAll() {
  const [rows] = await pool.execute('SELECT config_key, config_value FROM sys_config')
  const config = {}
  for (const row of rows) {
    config[row.config_key] = row.config_value
  }
  return config
}

/**
 * 获取单个配置值
 */
export async function get(key) {
  const [rows] = await pool.execute(
    'SELECT config_value FROM sys_config WHERE config_key = ?', [key]
  )
  return rows.length ? rows[0].config_value : null
}

/**
 * 设置配置值（UPSERT：键不存在时插入）
 */
export async function set(key, value) {
  await pool.execute(
    'INSERT INTO sys_config (config_key, config_value, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE config_value = ?, updated_at = NOW()',
    [key, String(value), String(value)]
  )
}

/**
 * 删除配置项
 */
export async function remove(keys) {
  const placeholders = keys.map(() => '?').join(',')
  await pool.execute(
    `DELETE FROM sys_config WHERE config_key IN (${placeholders})`,
    keys
  )
}
