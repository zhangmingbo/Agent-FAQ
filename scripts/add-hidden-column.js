/**
 * 数据库迁移脚本: 为 chat_log 表添加 is_hidden 字段
 */
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

async function migrate() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 1,
  })

  try {
    console.log('🔧 开始数据库迁移...')
    
    // 检查字段是否已存在
    const [columns] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'chat_log' AND COLUMN_NAME = 'is_hidden'",
      [process.env.DB_NAME]
    )

    if (columns.length > 0) {
      console.log('✅ is_hidden 字段已存在,跳过迁移')
      return
    }

    // 添加字段
    await pool.execute(`
      ALTER TABLE chat_log 
      ADD COLUMN is_hidden TINYINT(1) DEFAULT 0 COMMENT '是否隐藏: 0-显示, 1-隐藏',
      ADD INDEX idx_is_hidden (is_hidden)
    `)

    console.log('✅ 成功添加 is_hidden 字段和索引')
    
    // 验证
    const [verify] = await pool.execute(
      "SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'chat_log' AND COLUMN_NAME = 'is_hidden'",
      [process.env.DB_NAME]
    )
    
    console.log('📋 字段信息:', JSON.stringify(verify[0], null, 2))
    console.log('✅ 数据库迁移完成!')
  } catch (error) {
    console.error('❌ 迁移失败:', error.message)
    throw error
  } finally {
    await pool.end()
  }
}

migrate().catch(err => {
  console.error('迁移异常:', err)
  process.exit(1)
})
