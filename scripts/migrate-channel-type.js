/**
 * 数据库迁移：chat_log 表新增 channel_type 字段 + 联合索引
 */
import 'dotenv/config'
import pool from '../db/pool.js'

async function migrate() {
  try {
    // 1. 新增 channel_type 字段
    await pool.execute(
      `ALTER TABLE chat_log 
       ADD COLUMN channel_type VARCHAR(20) NOT NULL DEFAULT 'web' 
       COMMENT '接入渠道：web/wechat/mp/app/api' 
       AFTER user_id`
    )
    console.log('✅ channel_type 字段添加成功')
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log('⚠️ channel_type 字段已存在，跳过')
    } else {
      console.error(' 添加字段失败:', e.message)
      process.exit(1)
    }
  }

  try {
    // 2. 添加联合索引
    await pool.execute(
      'ALTER TABLE chat_log ADD INDEX idx_channel_time (channel_type, created_at)'
    )
    console.log('✅ 联合索引 idx_channel_time 添加成功')
  } catch (e) {
    if (e.code === 'ER_DUP_KEYNAME') {
      console.log('⚠️ 索引 idx_channel_time 已存在，跳过')
    } else {
      console.error('❌ 添加索引失败:', e.message)
    }
  }

  await pool.end()
  console.log('✅ 迁移完成')
}

migrate()
