/**
 * v5.0 全量数据库迁移脚本
 * 
 * 确保生产数据库包含 v5.0 所需的全部表结构
 * 所有操作幂等：已存在的字段/索引/表会自动跳过
 * 
 * 用法: node scripts/migrate-v5.js
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'

async function migrate() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 1,
    multipleStatements: true,
  })

  const results = { success: 0, skipped: 0, failed: 0 }

  async function safeExec(description, sql) {
    try {
      await pool.execute(sql)
      console.log(`  ✅ ${description}`)
      results.success++
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME' || e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_TABLE_EXISTS_ERROR') {
        console.log(`  ⏭️  ${description} (已存在，跳过)`)
        results.skipped++
      } else {
        console.error(`  ❌ ${description}: ${e.message}`)
        results.failed++
      }
    }
  }

  async function columnExists(table, column) {
    const [rows] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [process.env.DB_NAME, table, column]
    )
    return rows.length > 0
  }

  async function tableExists(table) {
    const [rows] = await pool.execute(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
      [process.env.DB_NAME, table]
    )
    return rows.length > 0
  }

  try {
    console.log('\n🔧 v5.0 数据库迁移开始\n')

    // ========================================
    // 1. chat_log 表变更
    // ========================================
    console.log('📋 chat_log 表:')

    if (!(await columnExists('chat_log', 'channel_type'))) {
      await safeExec(
        '添加 channel_type 字段',
        "ALTER TABLE chat_log ADD COLUMN channel_type VARCHAR(20) NOT NULL DEFAULT 'web' COMMENT '接入渠道' AFTER user_id"
      )
    } else {
      console.log('  ⏭️  channel_type 字段已存在')
      results.skipped++
    }

    if (!(await columnExists('chat_log', 'is_hidden'))) {
      await safeExec(
        '添加 is_hidden 字段',
        'ALTER TABLE chat_log ADD COLUMN is_hidden TINYINT(1) DEFAULT 0 COMMENT \'是否隐藏: 0-显示, 1-隐藏\''
      )
    } else {
      console.log('  ⏭️  is_hidden 字段已存在')
      results.skipped++
    }

    if (!(await columnExists('chat_log', 'meaningful'))) {
      await safeExec(
        '添加 meaningful 字段',
        'ALTER TABLE chat_log ADD COLUMN meaningful TINYINT DEFAULT 1 COMMENT \'是否有意义\''
      )
    } else {
      console.log('  ⏭️  meaningful 字段已存在')
      results.skipped++
    }

    // chat_log 索引
    await safeExec('添加 idx_channel_time 索引', 'ALTER TABLE chat_log ADD INDEX idx_channel_time (channel_type, created_at)')
    await safeExec('添加 idx_is_hidden 索引', 'ALTER TABLE chat_log ADD INDEX idx_is_hidden (is_hidden)')

    // ========================================
    // 2. faq 表变更
    // ========================================
    console.log('\n📋 faq 表:')

    if (!(await columnExists('faq', 'rich_content'))) {
      await safeExec('添加 rich_content 字段', 'ALTER TABLE faq ADD COLUMN rich_content JSON NULL')
    } else {
      console.log('  ⏭️  rich_content 字段已存在')
      results.skipped++
    }

    if (!(await columnExists('faq', 'links'))) {
      await safeExec('添加 links 字段', 'ALTER TABLE faq ADD COLUMN links JSON NULL')
    } else {
      console.log('  ⏭️  links 字段已存在')
      results.skipped++
    }

    if (!(await columnExists('faq', 'related'))) {
      await safeExec('添加 related 字段', 'ALTER TABLE faq ADD COLUMN related JSON NULL')
    } else {
      console.log('  ⏭️  related 字段已存在')
      results.skipped++
    }

    if (!(await columnExists('faq', 'follow_up'))) {
      await safeExec('添加 follow_up 字段', 'ALTER TABLE faq ADD COLUMN follow_up VARCHAR(200) NULL')
    } else {
      console.log('  ⏭️  follow_up 字段已存在')
      results.skipped++
    }

    if (!(await columnExists('faq', 'priority'))) {
      await safeExec('添加 priority 字段', 'ALTER TABLE faq ADD COLUMN priority INT DEFAULT 0')
    } else {
      console.log('  ⏭️  priority 字段已存在')
      results.skipped++
    }

    if (!(await columnExists('faq', 'category_id'))) {
      await safeExec('添加 category_id 字段', 'ALTER TABLE faq ADD COLUMN category_id INT NULL')
    } else {
      console.log('  ⏭️  category_id 字段已存在')
      results.skipped++
    }

    // ========================================
    // 3. faq_question 表
    // ========================================
    console.log('\n📋 faq_question 表:')

    if (!(await columnExists('faq_question', 'is_regex'))) {
      await safeExec('添加 is_regex 字段', 'ALTER TABLE faq_question ADD COLUMN is_regex TINYINT(1) DEFAULT 0')
    } else {
      console.log('  ⏭️  is_regex 字段已存在')
      results.skipped++
    }

    // ========================================
    // 4. faq_category 表（可能整表不存在）
    // ========================================
    console.log('\n📋 faq_category 表:')

    if (!(await tableExists('faq_category'))) {
      await safeExec('创建 faq_category 表', `
        CREATE TABLE faq_category (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(50) NOT NULL,
          code VARCHAR(50) NOT NULL,
          parent_id INT DEFAULT 0,
          level TINYINT DEFAULT 1,
          sort_order INT DEFAULT 0,
          icon VARCHAR(50) NOT NULL DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
    } else {
      console.log('  ⏭️  faq_category 表已存在')
      results.skipped++
    }

    // ========================================
    // 5. sys_config 表（可能整表不存在）
    // ========================================
    console.log('\n📋 sys_config 表:')

    if (!(await tableExists('sys_config'))) {
      await safeExec('创建 sys_config 表', `
        CREATE TABLE sys_config (
          id INT AUTO_INCREMENT PRIMARY KEY,
          config_key VARCHAR(50) NOT NULL UNIQUE,
          config_value TEXT NULL,
          description VARCHAR(200) NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
    } else {
      console.log('  ⏭️  sys_config 表已存在')
      results.skipped++
    }

    // ========================================
    // 6. expand_audit 表（智能扩审）
    // ========================================
    console.log('\n📋 expand_audit 表:')

    if (!(await tableExists('expand_audit'))) {
      await safeExec('创建 expand_audit 表', `
        CREATE TABLE expand_audit (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_text TEXT NULL,
          faq_code VARCHAR(100) NULL,
          faq_name VARCHAR(200) NULL,
          similarity DECIMAL(6,4) NULL,
          status VARCHAR(20) DEFAULT 'applied',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
    } else {
      console.log('  ⏭️  expand_audit 表已存在')
      results.skipped++
    }

    // ========================================
    // 7. answer_feedback 表
    // ========================================
    console.log('\n📋 answer_feedback 表:')

    if (!(await tableExists('answer_feedback'))) {
      await safeExec('创建 answer_feedback 表', `
        CREATE TABLE answer_feedback (
          id INT AUTO_INCREMENT PRIMARY KEY,
          session_id VARCHAR(100) NULL,
          user_text TEXT NULL,
          original_question TEXT NULL,
          intent_code VARCHAR(50) NULL,
          confidence DECIMAL(5,4) NULL,
          answer TEXT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
    } else {
      console.log('  ⏭️  answer_feedback 表已存在')
      results.skipped++
    }

    // ========================================
    // 8. task 表字段检查
    // ========================================
    console.log('\n📋 task 表:')

    const taskColumns = [
      ['clarify_options', 'ALTER TABLE task ADD COLUMN clarify_options JSON NULL'],
      ['arb_gap', 'ALTER TABLE task ADD COLUMN arb_gap DECIMAL(4,3) NULL'],
      ['arb_task_min', 'ALTER TABLE task ADD COLUMN arb_task_min DECIMAL(4,3) NULL'],
      ['arb_faq_min', 'ALTER TABLE task ADD COLUMN arb_faq_min DECIMAL(4,3) NULL'],
      ['arb_strong_hit', 'ALTER TABLE task ADD COLUMN arb_strong_hit DECIMAL(4,3) NULL'],
      ['llm', 'ALTER TABLE task ADD COLUMN llm JSON NULL'],
      ['api_action', 'ALTER TABLE task ADD COLUMN api_action JSON NULL'],
      ['completion_message', 'ALTER TABLE task ADD COLUMN completion_message TEXT NULL'],
      ['on_complete', 'ALTER TABLE task ADD COLUMN on_complete TEXT NULL'],
    ]

    for (const [col, sql] of taskColumns) {
      if (!(await columnExists('task', col))) {
        await safeExec(`添加 task.${col} 字段`, sql)
      } else {
        console.log(`  ⏭️  task.${col} 字段已存在`)
        results.skipped++
      }
    }

    // ========================================
    // 9. task_instance 表字段
    // ========================================
    console.log('\n📋 task_instance 表:')

    const tiColumns = [
      ['remark', "ALTER TABLE task_instance ADD COLUMN remark VARCHAR(500) DEFAULT ''"],
      ['trigger_text', 'ALTER TABLE task_instance ADD COLUMN trigger_text VARCHAR(500) NULL'],
    ]

    for (const [col, sql] of tiColumns) {
      if (!(await columnExists('task_instance', col))) {
        await safeExec(`添加 task_instance.${col} 字段`, sql)
      } else {
        console.log(`  ⏭️  task_instance.${col} 字段已存在`)
        results.skipped++
      }
    }

    // ========================================
    // 10. action_log 表（可能不存在）
    // ========================================
    console.log('\n📋 action_log 表:')

    if (!(await tableExists('action_log'))) {
      await safeExec('创建 action_log 表', `
        CREATE TABLE action_log (
          id INT AUTO_INCREMENT PRIMARY KEY,
          session_id VARCHAR(100) NULL,
          task_code VARCHAR(50) NULL,
          action VARCHAR(50) NULL,
          step VARCHAR(50) NULL,
          status VARCHAR(10) NULL,
          idempotency_key VARCHAR(100) NULL,
          url VARCHAR(500) NULL,
          payload JSON NULL,
          response TEXT NULL,
          error VARCHAR(500) NULL,
          retries TINYINT DEFAULT 0,
          duration_ms INT DEFAULT 0,
          message VARCHAR(500) NULL,
          resent_at DATETIME NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
    } else {
      console.log('  ⏭️  action_log 表已存在')
      results.skipped++
    }

    // ========================================
    // 汇总
    // ========================================
    console.log('\n' + '='.repeat(40))
    console.log(`✅ 新增: ${results.success} 项`)
    console.log(`⏭️  跳过: ${results.skipped} 项 (已存在)`)
    console.log(`❌ 失败: ${results.failed} 项`)
    console.log('='.repeat(40))

    if (results.failed > 0) {
      console.log('\n⚠️  有失败项，请检查上方错误信息')
    } else {
      console.log('\n🎉 v5.0 数据库迁移完成！')
    }

  } catch (e) {
    console.error('\n❌ 迁移异常:', e.message)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

migrate()
