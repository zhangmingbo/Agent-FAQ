// 临时诊断：查看数据库/表/连接的字符集与排序规则（跑完即删）
import pool from './db/pool.js'

const [globalRow] = await pool.execute("SHOW VARIABLES LIKE 'character_set_database'")
console.log('DB charset:', globalRow[0].Variable_name, '=', globalRow[0].Value)
const [collRow] = await pool.execute("SHOW VARIABLES LIKE 'collation_database'")
console.log('DB collation:', collRow[0].Variable_name, '=', collRow[0].Value)
const [conn] = await pool.execute("SELECT @@character_set_connection AS cs, @@collation_connection AS cc")
console.log('连接字符集:', conn[0].cs, '| 连接排序规则:', conn[0].cc)

for (const t of ['sys_config', 'chat_log', 'faq', 'faq_question', 'task']) {
  try {
    const [rows] = await pool.execute(
      `SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [t]
    )
    if (rows.length) console.log(`表 ${t}: collation=${rows[0].TABLE_COLLATION}`)
    else console.log(`表 ${t}: 不存在`)
  } catch (e) { console.log(`表 ${t}: 查询失败 ${e.message}`) }
}

// sys_config 的 config_value 列字符集
try {
  const [cols] = await pool.execute(
    `SELECT COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_config' AND COLUMN_NAME IN ('config_key','config_value')`
  )
  for (const c of cols) console.log(`sys_config.${c.COLUMN_NAME}: charset=${c.CHARACTER_SET_NAME} collation=${c.COLLATION_NAME}`)
} catch (e) { console.log('列查询失败:', e.message) }

await pool.end()
