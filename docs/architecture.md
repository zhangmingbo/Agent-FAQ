# FAQ 智能客服系统 — 架构说明文档

> 更新时间：2026-08-21

---

## 一、系统架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                        前端 (Vue 3 SPA)                       │
│  技术栈: Vue 3 + Element Plus + Vite + Vue Router            │
│  路径: d:\New AI\frontend\src                                │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (JWT Bearer)
┌──────────────────────────▼──────────────────────────────────┐
│                     Express.js 后端服务                        │
│  端口: 3001 | PM2 进程管理 | JWT 认证中间件                    │
│  入口: server.js                                             │
├─────────────────────────────────────────────────────────────┤
│  路由层 (routes/)                                             │
│  chat / faq / category / stats / chatLog / analysis /       │
│  config / dialogueRules / upload / health / tasks /         │
│  debug / actionLogs / taskInstance                          │
├─────────────────────────────────────────────────────────────┤
│  业务引擎层                                                  │
│  ┌─────────────────┐    ┌────────────────────────────────┐ │
│  │  FAQEngine       │    │  TaskFlowEngine                │ │
│  │  (faq-engine.js) │    │  (services/taskflow/index.js)  │ │
│  │  意图识别+答案匹配 │    │  槽位填充+状态机+对话管理      │ │
│  └────────┬────────┘    └──────────┬─────────────────────┘ │
│           │                        │                        │
│  ┌────────▼────────────────────────▼─────────────────────┐ │
│  │  NLU 理解层 (taskflow/nlu.js)                          │ │
│  │  路由判定 / 意图仲裁 / 槽位提取 / 语义触发              │ │
│  └───────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│  数据访问层                                                  │
│  MySQL (阿里云 RDS)  │  Redis (可选)  │  内存降级            │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、技术栈

| 层级 | 技术选型 |
|------|---------|
| 前端 | Vue 3 + Element Plus + Vite + Vue Router (Hash 模式) |
| 后端 | Express.js 5.x (ESM 模块) |
| 数据库 | MySQL 8.0 (阿里云 RDS) |
| 缓存 | Redis 6.x (可选，降级为 MySQL KV 表) |
| 向量模型 | @huggingface/transformers (paraphrase-multilingual-MiniLM-L12-v2) |
| 认证 | JWT (jsonwebtoken + bcryptjs) |
| 进程管理 | PM2 |
| 部署 | Docker 容器化 |

---

## 三、数据库表结构（13 张表）

| 表名 | 用途 | 核心字段 |
|------|------|---------|
| **faq** | FAQ 条目 | id, question, answer, category_id, confidence |
| **faq_question** | FAQ 相似问（一问多答） | id, faq_id, question |
| **faq_category** | FAQ 分类 | id, name, parent_id, sort_order |
| **chat_log** | 对话日志 | id, session_id, user_id, user_text, intent_code, answer, source, confidence |
| **chat_session** | 会话上下文 | id, session_id, history (JSON) |
| **task** | 任务定义（配置态） | id, code, name, trigger_words, steps (JSON), status |
| **task_instance** | 任务实例（运行态） | id, session_id, task_code, task_name, status, trigger_text, slots (JSON), turn_count, remark |
| **taskflow_kv** | 任务状态持久化（Redis 降级） | k, value (JSON), expire_at |
| **sys_config** | 系统配置（运营可配） | config_key, config_value |
| **action_log** | 任务动作日志 | id, session_id, action_type, payload (JSON) |
| **answer_feedback** | 答案反馈（满意/不满意） | id, session_id, faq_id, feedback_type |
| **suggest_cache** | 表达挖掘建议缓存 | id, source_question, suggested_task, score |
| **expand_audit** | 相似问自动扩写审计 | id, source_question, expanded_question, status |

### task_instance 表结构（详细）

```sql
CREATE TABLE task_instance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL COMMENT '会话ID',
  task_code VARCHAR(50) NOT NULL COMMENT '任务编号',
  task_name VARCHAR(100) NOT NULL COMMENT '任务名称（冗余）',
  status VARCHAR(20) NOT NULL DEFAULT 'collecting'
    COMMENT 'collecting/confirming/executing/done/cancelled/transferred',
  current_step VARCHAR(50) DEFAULT NULL COMMENT '当前步骤 key',
  trigger_text TEXT COMMENT '触发原文（用户启动任务的那句话）',
  slots JSON COMMENT '槽位快照',
  turn_count INT DEFAULT 0 COMMENT '对话轮次',
  remark VARCHAR(500) DEFAULT '' COMMENT '管理员标注',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  finished_at DATETIME DEFAULT NULL COMMENT '结束时间',
  INDEX idx_session (session_id),
  INDEX idx_task_code (task_code),
  INDEX idx_status (status),
  INDEX idx_started (started_at)
);
```

---

## 四、核心交互流程

### 1. 用户对话主流程

```
用户输入 text
    │
    ▼
FAQEngine.chat(text, sessionId, userId)
    │
    ├─ 有活跃任务？ ──► TaskFlowEngine.processInput(sessionId, text)
    │                       │
    │                       ├─ 槽位填充（NER/规则/LLM）
    │                       ├─ 状态机流转 (collecting→confirming→executing→done)
    │                       ├─ _updateInstance() → 更新 task_instance 表
    │                       └─ 返回任务回复
    │
    └─ 无活跃任务 ──► _handleNoActiveTask(text, context, traceSteps, userId)
                        │
                        ├─ NLU route() 判定：
                        │   ├─ task_new    → _tryStartTask() → startTask() → instanceStore.create()
                        │   ├─ faq         → FAQ 匹配流程（向量相似度+LLM重排）
                        │   ├─ clarify     → 追问二选一（任务 or 咨询）
                        │   └─ out_of_scope → 域外引导
                        │
                        └─ 返回回复
```

### 2. 任务实例生命周期

```
触发任务（用户说"我要预约上门服务"）
    │
    ▼
instanceStore.create()  →  task_instance INSERT (status='collecting')
    │                        trigger_text = 用户原话
    ▼
每轮对话 → _updateInstance()  →  UPDATE status/slots/turn_count
    │
    ├─ 槽位全填完 → status='confirming'（等待用户确认）
    ├─ 用户确认   → status='executing' → API 调用/动作执行
    ├─ 完成       → status='done', finished_at=now()
    ├─ 用户取消   → status='cancelled'
    └─ 转人工     → status='transferred'
```

### 3. 认证流程

```
前端 Login.vue → POST /api/auth/login → 返回 JWT token
    │
    ▼
localStorage 存储 token
    │
    ▼
http.js 拦截器：每次请求自动附加 Authorization: Bearer <token>
    │
    ▼
后端 authMiddleware 验证
    │  白名单: /api/auth/*, /api/chat, /api/health
    │
    └─ 401 → 前端清除 token → 跳转 /login
```

---

## 五、前端管理后台页面

```
前端页面 (Vue Router Hash 模式)
├── /login           → Login.vue          登录页（admin/admin123）
├── /                → Dashboard.vue      概览（统计卡片+趋势图）
├── /monitor         → Monitor.vue        服务监控
├── /analysis        → Analysis.vue       智能分析（低置信度/未命中）
├── /issues          → Issues.vue         问题追踪
├── /task-tracking   → TaskTracking.vue   任务管理（实例列表+标注/取消/删除）
├── /faq             → FaqManage.vue      FAQ 管理
├── /rules           → Rules.vue          规则引擎（对话规则配置）
└── /config          → SysConfig.vue      系统配置（阈值/话术/LLM）
```

### 任务管理页（TaskTracking.vue）表格列顺序

```
# → 用户名 → 会话ID → 任务名称 → 触发原文 → 状态 → 当前步骤 → 轮次 → 开始时间 → 操作
```

操作列包含：详情 / 标注 / 取消 / 删除

---

## 六、关键模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| **对话编排** | faq-engine.js (1483行) | 路由决策、任务/FAQ 仲裁、会话管理、投诉/反馈处理 |
| **任务引擎** | taskflow/index.js (512行) | 任务定义管理、触发匹配、状态机、实例写入 |
| **理解层** | taskflow/nlu.js | 意图判定、槽位提取、语义仲裁、FAQ/任务统一路由 |
| **对话管理** | taskflow/dialogManager.js | DST 状态追踪、Policy 策略、槽位填充流程 |
| **持久化** | taskflow/store.js | Redis/MySQL/内存三级适配，任务状态 TTL |
| **实例存储** | taskflow/instanceStore.js | task_instance 表 CRUD、统计、分页 |
| **知识库** | faqService.js | FAQ 条目管理、向量索引、相似度计算 |
| **识别器** | src/recognizer.js | 语义向量匹配、正则/关键词、置信度计算 |
| **LLM** | services/llmClient.js | 大模型调用（答案生成、重排、意图判定） |
| **配置** | config/index.js + sys_config 表 | 环境变量 + 数据库双源配置 |

---

## 七、存储层级

```
内存 (activeTasks Map)     ← 权威态，实时读写
    │
    ▼ 持久化（每轮对话后）
Redis / MySQL (taskflow_kv) ← 重启恢复用，TTL 30分钟可配
    │
    ▼ 审计/运营
MySQL (task_instance)       ← 管理后台展示，永久保存
```

---

## 八、API 路由清单

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/auth/login | 登录（返回 JWT） |
| POST | /api/chat | 核心对话接口 |
| GET  | /api/health | 健康检查 |
| GET/POST/PUT/DELETE | /api/faq/* | FAQ CRUD |
| GET/POST | /api/category/* | 分类管理 |
| GET  | /api/stats/* | 统计数据 |
| GET  | /api/chat-log | 对话日志 |
| GET  | /api/analysis/* | 智能分析 |
| GET/POST | /api/config/* | 系统配置 |
| GET/POST | /api/dialogue-rules/* | 对话规则 |
| POST | /api/upload | 文件上传 |
| GET/POST/PUT/DELETE | /api/tasks/* | 任务定义 CRUD |
| GET  | /api/task-instances | 任务实例列表（分页） |
| GET  | /api/task-instances/stats | 任务实例统计卡片 |
| GET  | /api/task-instances/:id | 任务实例详情 |
| PUT  | /api/task-instances/:id | 编辑实例（标注/状态） |
| DELETE | /api/task-instances/:id | 删除实例 |
| POST | /api/task-instances/:id/cancel | 手动取消实例 |

---

## 九、目录结构

```
d:\New AI\
├── server.js              # 服务入口（Express 初始化 + 引擎加载）
├── faq-engine.js          # 对话编排层（核心路由决策）
├── config/index.js        # 统一配置（环境变量 + 默认值）
├── db/pool.js             # MySQL 连接池
├── middleware/
│   ├── auth.js            # JWT 认证中间件
│   ├── errorHandler.js    # 错误处理
│   └── rateLimit.js       # API 限流
├── routes/                # 路由层（14 个路由模块）
│   ├── chat.js            # 核心对话 API
│   ├── taskInstance.js    # 任务实例管理 API
│   └── ...
├── services/              # 领域服务层
│   ├── taskflow/          # 任务型对话引擎
│   │   ├── index.js       # TaskFlowEngine 主类
│   │   ├── nlu.js         # NLU 理解层
│   │   ├── dialogManager.js # 对话管理器
│   │   ├── instanceStore.js # 任务实例存储
│   │   ├── store.js       # 持久化适配器
│   │   ├── stateMachine.js  # 状态机
│   │   └── ...
│   ├── faqService.js      # FAQ 知识库服务
│   ├── llmClient.js       # LLM 调用客户端
│   └── ...
├── src/                   # 识别器 SDK
│   ├── recognizer.js      # 语义向量匹配
│   ├── nlpEngine.js       # NLP 引擎
│   └── similarity.js      # 相似度计算
├── repositories/          # 数据访问层
├── frontend/              # 前端源码
│   └── src/
│       ├── views/         # 页面组件（9 个）
│       ├── api/           # API 调用（11 个模块）
│       ├── components/    # 公共组件
│       ├── utils/         # 工具（auth.js + http.js）
│       └── router/        # 路由配置
└── public/admin/          # 前端构建产物（部署目录）
```
