-- ============================================================
-- FAQ 智能问答机器人 v5.0 - 数据库初始化脚本
-- 
-- 使用方法:
--   mysql -u root -p < init.sql
--   或在 MySQL 客户端中: source /path/to/init.sql
--
-- 说明:
--   - 所有表使用 IF NOT EXISTS，可重复执行
--   - 数据库名: faqdb (可在执行前修改)
--   - 字符集: utf8mb4 (支持 emoji)
-- ============================================================

-- 创建数据库（如不存在）
CREATE DATABASE IF NOT EXISTS `faqdb` 
  DEFAULT CHARACTER SET utf8mb4 
  COLLATE utf8mb4_unicode_ci;

USE `faqdb`;

-- ============================================================
-- 1. FAQ 主表
-- ============================================================
CREATE TABLE IF NOT EXISTS `faq` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(100) NOT NULL UNIQUE COMMENT 'FAQ 编号',
  `name` VARCHAR(200) NOT NULL COMMENT 'FAQ 名称/问题',
  `answer` TEXT COMMENT '标准答案',
  `rich_content` JSON NULL COMMENT '富媒体内容（图片/视频/卡片等）',
  `links` JSON NULL COMMENT '相关链接',
  `related` JSON NULL COMMENT '相关推荐 FAQ 编号列表',
  `follow_up` VARCHAR(200) NULL COMMENT '追问引导语',
  `priority` INT DEFAULT 0 COMMENT '优先级（越高越优先）',
  `category_id` INT NULL COMMENT '分类 ID',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_category` (`category_id`),
  INDEX `idx_priority` (`priority`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='FAQ 知识库';

-- ============================================================
-- 2. FAQ 相似问句表
-- ============================================================
CREATE TABLE IF NOT EXISTS `faq_question` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `faq_code` VARCHAR(100) NOT NULL COMMENT '关联 FAQ 编号',
  `question` TEXT NOT NULL COMMENT '相似问句文本（或正则表达式）',
  `is_regex` TINYINT(1) DEFAULT 0 COMMENT '是否为正则表达式: 0-否, 1-是',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_faq_code` (`faq_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='FAQ 相似问句';

-- ============================================================
-- 3. FAQ 分类表
-- ============================================================
CREATE TABLE IF NOT EXISTS `faq_category` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(50) NOT NULL COMMENT '分类名称',
  `code` VARCHAR(50) NOT NULL COMMENT '分类编号',
  `parent_id` INT DEFAULT 0 COMMENT '父分类 ID（0=顶级）',
  `level` TINYINT DEFAULT 1 COMMENT '层级',
  `sort_order` INT DEFAULT 0 COMMENT '排序权重',
  `icon` VARCHAR(50) NOT NULL DEFAULT '' COMMENT '图标',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='FAQ 分类';

-- ============================================================
-- 4. 聊天日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS `chat_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `session_id` VARCHAR(100) COMMENT '会话 ID',
  `user_id` VARCHAR(100) COMMENT '用户 ID',
  `channel_type` VARCHAR(20) NOT NULL DEFAULT 'web' COMMENT '接入渠道: web/app/mp/dingtalk 等',
  `user_text` TEXT COMMENT '用户输入',
  `intent_code` VARCHAR(100) COMMENT '匹配到的意图编号',
  `confidence` DECIMAL(5,4) COMMENT '匹配置信度',
  `source` VARCHAR(50) COMMENT '答案来源: direct/clarify/fallback/task 等',
  `answer` TEXT COMMENT '回复内容',
  `is_hidden` TINYINT(1) DEFAULT 0 COMMENT '是否隐藏: 0-显示, 1-隐藏',
  `meaningful` TINYINT DEFAULT 1 COMMENT '是否有意义: 0-无意义, 1-有意义',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_session` (`session_id`),
  INDEX `idx_channel_time` (`channel_type`, `created_at`),
  INDEX `idx_intent` (`intent_code`),
  INDEX `idx_is_hidden` (`is_hidden`),
  INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='聊天日志';

-- ============================================================
-- 5. 会话持久化表（重启恢复对话上下文）
-- ============================================================
CREATE TABLE IF NOT EXISTS `chat_session` (
  `session_id` VARCHAR(100) PRIMARY KEY COMMENT '会话 ID',
  `context_json` LONGTEXT COMMENT '会话上下文 JSON',
  `last_active` BIGINT COMMENT '最后活跃时间戳',
  `created_at` BIGINT COMMENT '创建时间戳',
  INDEX `idx_session_active` (`last_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话持久化';

-- ============================================================
-- 6. 任务流程定义表
-- ============================================================
CREATE TABLE IF NOT EXISTS `task` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(50) NOT NULL UNIQUE COMMENT '任务编号',
  `name` VARCHAR(100) NOT NULL COMMENT '任务名称',
  `description` TEXT COMMENT '任务描述',
  `trigger_keywords` JSON COMMENT '触发关键词列表',
  `slots` JSON COMMENT '槽位定义列表（v1 兼容）',
  `steps` JSON COMMENT '流程 DSL（v2）',
  `intent_examples` JSON COMMENT '意图例句（NLU 理解用）',
  `clarify_question` VARCHAR(500) DEFAULT '' COMMENT '任务/FAQ 冲突时的追问话术',
  `clarify_options` JSON COMMENT '追问选项列表',
  `arb_gap` DECIMAL(4,3) NULL COMMENT '仲裁差距阈值（任务级）',
  `arb_task_min` DECIMAL(4,3) NULL COMMENT '任务侧最低线',
  `arb_faq_min` DECIMAL(4,3) NULL COMMENT 'FAQ 侧最低线',
  `arb_strong_hit` DECIMAL(4,3) NULL COMMENT '强命中线',
  `llm` JSON NULL COMMENT 'LLM 配置（任务级）',
  `api_action` JSON NULL COMMENT 'API 动作配置',
  `completion_message` TEXT COMMENT '完成提示语',
  `on_complete` TEXT COMMENT '完成后动作（动作名或编排 JSON）',
  `status` TINYINT DEFAULT 1 COMMENT '1=启用 0=禁用',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务流程定义';

-- ============================================================
-- 7. 任务实例表（每次触发产生一条记录）
-- ============================================================
CREATE TABLE IF NOT EXISTS `task_instance` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `session_id` VARCHAR(100) NOT NULL COMMENT '会话 ID',
  `task_code` VARCHAR(50) NOT NULL COMMENT '任务编号',
  `task_name` VARCHAR(100) NOT NULL COMMENT '任务名称（冗余）',
  `status` VARCHAR(20) NOT NULL DEFAULT 'collecting' COMMENT 'collecting/confirming/executing/done/cancelled/transferred',
  `current_step` VARCHAR(50) DEFAULT NULL COMMENT '当前步骤 key',
  `trigger_text` VARCHAR(500) NULL COMMENT '触发原文',
  `slots` JSON COMMENT '槽位快照',
  `turn_count` INT DEFAULT 0 COMMENT '对话轮次',
  `remark` VARCHAR(500) DEFAULT '' COMMENT '管理员标注',
  `started_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `finished_at` DATETIME DEFAULT NULL COMMENT '结束时间',
  INDEX `idx_session` (`session_id`),
  INDEX `idx_task_code` (`task_code`),
  INDEX `idx_status` (`status`),
  INDEX `idx_started` (`started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务实例';

-- ============================================================
-- 8. 系统配置表（运营可配参数）
-- ============================================================
CREATE TABLE IF NOT EXISTS `sys_config` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `config_key` VARCHAR(50) NOT NULL UNIQUE COMMENT '配置键',
  `config_value` TEXT NULL COMMENT '配置值',
  `description` VARCHAR(200) NULL COMMENT '配置说明',
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_key` (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统配置';

-- ============================================================
-- 9. 相似问自动扩写审计表
-- ============================================================
CREATE TABLE IF NOT EXISTS `expand_audit` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_text` TEXT NULL COMMENT '用户原文',
  `faq_code` VARCHAR(100) NULL COMMENT '目标 FAQ 编号',
  `faq_name` VARCHAR(200) NULL COMMENT '目标 FAQ 名称',
  `similarity` DECIMAL(6,4) NULL COMMENT '相似度',
  `status` VARCHAR(20) DEFAULT 'applied' COMMENT 'applied/rejected',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_faq_code` (`faq_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='相似问扩写审计';

-- ============================================================
-- 10. 答案反馈表（用户否定回答的记录）
-- ============================================================
CREATE TABLE IF NOT EXISTS `answer_feedback` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `session_id` VARCHAR(100) NULL COMMENT '会话 ID',
  `user_text` TEXT NULL COMMENT '用户反馈文本',
  `original_question` TEXT NULL COMMENT '原始问题',
  `intent_code` VARCHAR(50) NULL COMMENT '匹配意图',
  `confidence` DECIMAL(5,4) NULL COMMENT '置信度',
  `answer` TEXT NULL COMMENT '被否定的回答',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_feedback_time` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='答案反馈';

-- ============================================================
-- 11. 动作执行日志表（API 调用审计）
-- ============================================================
CREATE TABLE IF NOT EXISTS `action_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `session_id` VARCHAR(100) NULL COMMENT '会话 ID',
  `task_code` VARCHAR(50) NULL COMMENT '任务编号',
  `action` VARCHAR(50) NULL COMMENT '动作名称',
  `step` VARCHAR(50) NULL COMMENT '编排步骤名',
  `status` VARCHAR(10) NULL COMMENT 'ok=成功 fail=失败',
  `idempotency_key` VARCHAR(100) NULL COMMENT '幂等键（防重复）',
  `url` VARCHAR(500) NULL COMMENT '请求 URL',
  `payload` JSON NULL COMMENT '请求数据快照',
  `response` TEXT NULL COMMENT '响应内容',
  `error` VARCHAR(500) NULL COMMENT '错误信息',
  `retries` TINYINT DEFAULT 0 COMMENT '重试次数',
  `duration_ms` INT DEFAULT 0 COMMENT '执行耗时（毫秒）',
  `message` VARCHAR(500) NULL COMMENT '备注消息',
  `resent_at` DATETIME NULL COMMENT '重发成功时间',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_action_session` (`session_id`),
  INDEX `idx_action_task` (`task_code`),
  INDEX `idx_action_status` (`status`),
  INDEX `idx_action_idem` (`idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='动作执行日志';

-- ============================================================
-- 12. 表达挖掘缓存表（后台预计算结果）
-- ============================================================
CREATE TABLE IF NOT EXISTS `suggest_cache` (
  `id` INT PRIMARY KEY COMMENT '缓存 ID（固定为 1）',
  `data_json` LONGTEXT COMMENT '缓存数据 JSON',
  `computed_at` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '计算时间',
  UNIQUE KEY `uk_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表达挖掘缓存';

-- ============================================================
-- 初始化默认系统配置
-- ============================================================
INSERT INTO `sys_config` (`config_key`, `config_value`, `description`) VALUES
  ('min_confidence', '0.5', '最低匹配置信度'),
  ('clarify_threshold', '0.65', '追问确认阈值'),
  ('top_k', '5', '返回 Top K 候选'),
  ('meaningless_detection_mode', 'rule', '无意义检测模式: rule/llm'),
  ('task_session_ttl_minutes', '30', '任务会话超时（分钟）'),
  ('reply_texts', '{}', '固定回复话术 JSON'),
  ('match_vocab', '{}', '匹配词表 JSON'),
  ('channel_types', '["web","app","mp","dingtalk"]', '渠道类型列表'),
  ('feedback_trigger_words', '["不是这个","不是问这个","答错","答非所问"]', '答案反馈信号词'),
  ('complaint_trigger_words', '["投诉","消协","12315","举报","差评"]', '投诉情绪信号词')
ON DUPLICATE KEY UPDATE `config_value` = `config_value`;

-- ============================================================
-- 完成
-- ============================================================
SELECT '✅ 数据库初始化完成！' AS message;
SELECT CONCAT('  - 表数量: ', COUNT(*)) AS info FROM information_schema.tables WHERE table_schema = 'faqdb';
