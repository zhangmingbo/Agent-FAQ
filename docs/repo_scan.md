# Argos 智能体平台 - 项目全景扫描

> 扫描时间：2026-08-21 | 版本：v3.1.1

---

## 1. 技术栈与前后端目录边界

### 1.1 后端技术栈

| 类别 | 技术 | 版本 | 用途 |
|------|------|------|------|
| 运行时 | Node.js | 18+ | ES Module 模式 |
| Web 框架 | Express | ^5.2.1 | HTTP 服务 |
| 数据库 | MySQL | - | 业务数据持久化 |
| 数据库驱动 | mysql2 | ^3.23.4 | 连接池 + Promise API |
| 缓存 | Redis | ^6.2.1 | 会话状态（可选） |
| 认证 | jsonwebtoken | ^9.0.3 | JWT Token |
| 密码 | bcryptjs | ^2.4.3 | 密码哈希 |
| NLP 模型 | @huggingface/transformers | ^3.0.0 | 本地向量模型 |
| 限流 | express-rate-limit | ^7.5.1 | API 限流 |
| 配置 | dotenv | ^17.4.2 | 环境变量 |
| 跨域 | cors | ^2.8.6 | CORS |

### 1.2 前端技术栈

| 类别 | 技术 | 版本 | 用途 |
|------|------|------|------|
| 框架 | Vue 3 | ^3.4.0 | 响应式 UI |
| 路由 | Vue Router | ^4.3.0 | Hash 模式路由 |
| 状态 | Pinia | ^2.1.0 | 状态管理 |
| UI 组件 | Element Plus | ^2.7.0 | 组件库 |
| HTTP | Axios | ^1.7.0 | 请求封装 |
| 图标 | @element-plus/icons-vue | ^2.3.0 | 图标库 |
| 构建 | Vite | ^5.3.0 | 开发/构建 |

### 1.3 前后端目录边界

```
d:\New AI\                    # 项目根目录（后端）
├── server.js                 # 后端入口
├── faq-engine.js             # 核心引擎
├── config/                   # 后端配置
├── db/                       # 数据库连接池
├── middleware/               # 后端中间件
├── routes/                   # 后端路由
├── repositories/             # 数据访问层
├── services/                 # 业务服务层
├── rules/                    # 对话规则引擎
├── src/                      # NLP/SDK 源码
├── public/                   # 静态文件（前端构建产物部署于此）
│   └── admin/                # Vue 管理后台构建产物
├── uploads/                  # 上传文件
├── model_cache/              # 本地 NLP 模型
└── frontend/                 # 前端源码目录（独立项目）
    ├── src/                  # Vue 源码
    ├── dist/                 # 构建产物（临时）
    └── deploy.mjs            # 部署脚本（复制 dist → public/admin/）
```

**边界规则**：
- `frontend/` 是独立 Vue 项目，有自己的 `package.json`
- `public/admin/` 是前端构建产物的部署目标
- 后端通过 `express.static` 托管 `public/` 目录
- 前端构建后必须执行 `deploy.mjs` 将产物复制到 `public/admin/`

---

## 2. 完整目录结构

```
d:\New AI\
├── AGENTS.md                          # AI 助手架构指南
├── Dockerfile                         # Docker 构建文件
├── deploy.sh                          # 本地部署脚本
├── ecosystem.config.js                # PM2 进程配置
├── package.json                       # 后端依赖
├── server.js                          # Express 应用入口
├── faq-engine.js                      # FAQ 对话引擎（1483 行）
├── db.js                              # 数据库初始化脚本
├── .env / .env.example                # 环境变量
├── .dockerignore                      # Docker 忽略文件
│
├── config/
│   └── index.js                       # 统一配置管理（环境变量 > .env > 默认值）
│
├── db/
│   ── pool.js                        # MySQL 连接池
│
├── middleware/
│   ├── auth.js                        # JWT 认证 + /api/auth 路由
│   ├── errorHandler.js                # 全局错误处理 + asyncHandler
│   ── rateLimit.js                   # 限流中间件
│
├── routes/                            # API 路由（13 个文件）
│   ├── actionLogs.js                  # 动作日志
│   ├── analysis.js                    # 智能分析
│   ├── category.js                    # 分类管理
│   ├── chat.js                        # 核心聊天接口
│   ├── chatLog.js                     # 咨询记录
│   ├── config.js                      # 系统配置
│   ├── debug.js                       # 调试接口
│   ├── dialogueRules.js               # 对话规则
│   ├── faq.js                         # FAQ CRUD
│   ├── health.js                      # 健康检查
│   ├── stats.js                       # 统计数据
│   ├── taskInstance.js                # 任务实例
│   ├── tasks.js                       # 任务流程定义
│   └── upload.js                      # 文件上传
│
├── repositories/                      # 数据访问层（4 个文件）
│   ├── categoryRepo.js                # 分类数据访问
│   ├── chatLogRepo.js                 # 对话日志数据访问
│   ├── configRepo.js                  # 系统配置数据访问
│   └── faqRepo.js                     # FAQ 数据访问
│
├── rules/
│   ├── dialogueRules.js               # 对话规则定义
│   ── ruleLoader.js                  # 规则加载器（热更新）
│
├── services/                          # 业务服务层
│   ├── faqService.js                  # 知识库领域服务
│   ├── statsService.js                # 统计服务
│   ├── llmClient.js                   # 大模型客户端
│   ├── llmPrompts.js                  # 提示词管理
│   ├── replyTexts.js                  # 回复话术配置
│   ├── matchVocab.js                  # 匹配词库配置
│   ├── cancelWords.js                 # 取消词配置
│   ├── negationWords.js               # 否定词配置
│   ├── traceService.js                # 链路追踪
│   ├── llmCallLogger.js               # LLM 调用日志
│   ├── taskSuggestService.js          # 任务建议服务
│   ├── autoExpandService.js           # 自动扩展服务
│   └── taskflow/                      # 任务流程引擎（18 个文件）
│       ├── index.js                   # 引擎入口
│       ├── nlu.js                     # 意图识别（LLM + 语义仲裁）
│       ├── flow.js                    # 流程执行器
│       ├── stateMachine.js            # 状态机
│       ├── slotExtractor.js           # 槽位提取
│       ├── nerClient.js               # NER 服务客户端
│       ├── instanceStore.js           # 实例持久化
│       ├── taskDefs.js                # 任务定义 DSL
│       ├── store.js                   # KV 存储
│       ├── actionRegistry.js          # 动作注册表
│       ├── apiStep.js                 # API 调用步骤
│       ├── httpCall.js                # HTTP 调用
│       ├── condition.js               # 条件判断
│       ├── dialogManager.js           # 对话管理
│       ├── expr.js                    # 表达式解析
│       ├── extractor.js               # 提取器
│       ├── slotAnswerValidator.js     # 槽位答案验证
│       └── validator.js               # 验证器
│
├── src/                               # NLP SDK 源码
│   ├── index.js                       # SDK 入口
│   ├── nlpEngine.js                   # NLP 引擎
│   ├── recognizer.js                  # 意图识别器
│   └── similarity.js                  # 相似度计算
│
├── frontend/                          # 前端源码（独立项目）
│   ├── package.json
│   ├── vite.config.js
│   ├── deploy.mjs                     # 部署脚本
│   └── src/
│       ├── App.vue                    # 根组件
│       ├── main.js                    # 入口
│       ├── router/index.js            # 路由配置
│       ├── components/
│       │   └── AppLayout.vue          # 主布局（侧边栏 + 顶部导航）
│       ├── views/                     # 页面组件（9 个）
│       │   ├── Login.vue              # 登录页
│       │   ├── Dashboard.vue          # 概览仪表盘
│       │   ├── FaqManage.vue          # FAQ 管理
│       │   ├── TaskTracking.vue       # 任务实例管理
│       │   ├── Analysis.vue           # 智能分析
│       │   ├── Monitor.vue            # 服务监控
│       │   ├── Rules.vue              # 规则引擎
│       │   ├── SysConfig.vue          # 系统配置
│       │   └── Issues.vue             # 问题追踪
│       ├── api/                       # API 模块（11 个文件）
│       │   ├── analysis.js
│       │   ├── category.js
│       │   ├── chat.js
│       │   ├── chatLog.js
│       │   ├── config.js
│       │   ├── dialogueRules.js
│       │   ├── faq.js
│       │   ├── stats.js
│       │   ├── task.js
│       │   ├── taskInstance.js
│       │   └── upload.js
│       └── utils/
│           ├── http.js                # Axios 实例（自动注入 Authorization）
│           ── auth.js                # Token 管理
│
├── public/                            # 静态文件
│   ├── admin/                         # 前端构建产物（由 deploy.mjs 生成）
│   │   ├── index.html                 # 入口（含登录遮罩层 + 401 监听）
│   │   ── assets/                    # JS/CSS 资源（带 hash 文件名）
│   ├── admin-legacy.html              # 旧版管理后台（兼容）
│   └── index.html                     # 聊天窗口（独立页面）
│
── tests/                             # 测试文件（14 个）
│   ├── taskflow.test.mjs              # 任务流程测试
│   ├── route.test.mjs                 # 路由测试
│   ├── arbitrate.test.mjs             # 仲裁测试
│   └── ...
│
├── ner-service/                       # NER 微服务（Python）
│   ├── app.py
│   └── requirements.txt
│
└── scripts/
    └── backup.sh                      # 备份脚本
```

---

## 3. 后端接口与数据表

### 3.1 API 接口清单（按模块）

#### 认证模块 `/api/auth`
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 用户登录 |
| GET | `/api/auth/verify` | 验证 Token（真正验证 JWT） |

#### 核心聊天 `/api`
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | 核心聊天接口（限流 30 次/分） |
| POST | `/api/recognize` | 兼容旧版识别接口 |

#### FAQ 管理 `/api/faq`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/faq` | 获取 FAQ 列表 |
| GET | `/api/faq/:code` | 获取 FAQ 详情 |
| POST | `/api/faq` | 新增 FAQ |
| DELETE | `/api/faq/:code` | 删除 FAQ |
| POST | `/api/faq/import` | JSON 批量导入 |
| POST | `/api/faq/import/csv` | CSV 导入 |
| GET | `/api/faq/template` | 下载导入模板 |

#### 分类管理 `/api/categories`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/categories` | 获取分类树 |
| GET | `/api/categories/:id/faqs` | 获取分类下 FAQ |
| POST | `/api/categories` | 新增分类 |
| DELETE | `/api/categories/:id` | 删除分类 |
| PUT | `/api/faq/:code/category` | 移动 FAQ 到分类 |

#### 任务流程 `/api/tasks`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks` | 获取任务列表 |
| GET | `/api/tasks/:code` | 获取任务详情 |
| POST | `/api/tasks` | 创建/更新任务 |
| DELETE | `/api/tasks/:code` | 删除任务 |
| GET | `/api/tasks/actions` | 获取动作列表 |
| GET | `/api/tasks/suggestions` | 获取任务建议 |
| POST | `/api/tasks/suggestions/refresh` | 刷新建议 |

#### 任务实例 `/api/task-instances`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/task-instances` | 获取实例列表 |
| GET | `/api/task-instances/stats` | 获取实例统计 |
| GET | `/api/task-instances/:id` | 获取实例详情 |
| PUT | `/api/task-instances/:id` | 更新实例 |
| DELETE | `/api/task-instances/:id` | 删除实例 |
| POST | `/api/task-instances/:id/cancel` | 取消实例 |

#### 咨询记录 `/api/chat-log`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/chat-log/unmatched` | 未匹配问题 |
| GET | `/api/chat-log/low-confidence` | 低置信度问题 |
| POST | `/api/chat-log/ignore` | 忽略问题 |
| GET | `/api/chat-log/dates` | 日期列表 |
| GET | `/api/chat-log/recent` | 最近记录 |
| GET | `/api/chat-log/recent-dates` | 最近日期 |
| GET | `/api/chat-log/session/:sessionId` | 会话详情 |
| GET | `/api/chat-log/live` | 实时对话 |

#### 智能分析 `/api/analysis`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/analysis` | 获取分析数据 |
| POST | `/api/analysis/suggest` | 生成建议 |
| POST | `/api/analysis/add-question` | 添加相似问 |
| POST | `/api/analysis/add-questions-batch` | 批量添加 |
| POST | `/api/analysis/check-questions` | 检查问题 |
| GET | `/api/analysis/feedback` | 反馈数据 |
| GET | `/api/analysis/funnel` | 漏斗数据 |
| POST | `/api/analysis/expand/run` | 执行扩展 |
| GET | `/api/analysis/expand/audit` | 扩展审核 |
| POST | `/api/analysis/expand/revert` | 回滚扩展 |

#### 系统配置 `/api/config`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | 获取所有配置 |
| POST | `/api/config` | 保存配置 |
| GET | `/api/config/ner-types` | 获取 NER 类型 |
| POST | `/api/config/ner-types` | 保存 NER 类型 |
| POST | `/api/config/ner-types/test` | 测试 NER 类型 |
| GET | `/api/config/llm-nodes` | 获取 LLM 节点 |
| GET | `/api/config/llm-prompts` | 获取提示词 |
| POST | `/api/config/llm-prompts` | 保存提示词 |

#### 对话规则 `/api/dialogue-rules`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/dialogue-rules` | 获取规则 |
| POST | `/api/dialogue-rules` | 保存规则 |
| POST | `/api/dialogue-rules/reset` | 重置规则 |
| GET | `/api/dialogue-rules/export` | 导出规则 |
| POST | `/api/dialogue-rules/import` | 导入规则 |
| GET | `/api/dialogue-rules/stats` | 规则统计 |
| POST | `/api/dialogue-rules/stats/reset` | 重置统计 |
| GET | `/api/dialogue-rules/logs` | 规则日志 |
| POST | `/api/dialogue-rules/logs/clear` | 清空日志 |

#### 文件上传 `/api/upload`
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/upload` | 上传文件 |
| GET | `/api/uploads` | 文件列表 |
| DELETE | `/api/uploads/:name` | 删除文件 |

#### 动作日志 `/api/action-logs`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/action-logs` | 获取日志列表 |
| GET | `/api/action-logs/:id` | 获取日志详情 |
| POST | `/api/action-logs/:id/resend` | 重发动作 |

#### 调试接口 `/api/debug`
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/debug/sessions` | 会话列表 |
| GET | `/api/debug/session/:id` | 会话详情 |
| GET | `/api/debug/llm-calls` | LLM 调用日志 |
| POST | `/api/debug/clear` | 清空会话 |
| POST | `/api/debug/llm-calls/clear` | 清空 LLM 日志 |

#### 统计与健康
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 统计数据 |
| GET | `/api/health` | 健康检查 |
| POST | `/api/mock/*` | 假接口（联调测试） |

### 3.2 数据库表清单

| 表名 | 用途 | 定义位置 |
|------|------|----------|
| `faq` | FAQ 知识库 | repositories/faqRepo.js |
| `faq_question` | FAQ 相似问 | repositories/faqRepo.js |
| `faq_category` | FAQ 分类 | repositories/categoryRepo.js |
| `chat_log` | 对话日志 | repositories/chatLogRepo.js |
| `sys_config` | 系统配置 | repositories/configRepo.js |
| `task` | 任务流程定义 | services/taskflow/taskDefs.js |
| `task_instance` | 任务实例 | services/taskflow/instanceStore.js |
| `action_log` | 动作执行日志 | services/taskflow/actionRegistry.js |
| `taskflow_kv` | 任务 KV 存储 | services/taskflow/store.js |
| `answer_feedback` | 答案反馈 | faq-engine.js |
| `chat_session` | 会话管理 | faq-engine.js |
| `suggest_cache` | 建议缓存 | services/taskSuggestService.js |
| `expand_audit` | 扩展审核 | services/autoExpandService.js |

---

## 4. 前端接口调用与请求封装

### 4.1 请求封装位置

**核心文件**：`frontend/src/utils/http.js`

```javascript
// Axios 实例配置
const http = axios.create({
  baseURL: '',        // 相对路径，由浏览器解析
  timeout: 15000,     // 15 秒超时
})

// 请求拦截器：自动注入 Authorization
http.interceptors.request.use(config => {
  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截器：401 自动跳转登录
http.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      removeToken()
      if (window.location.hash !== '#/login') {
        window.location.hash = '#/login'
      }
    }
    return Promise.reject(err)
  }
)
```

**Token 管理**：`frontend/src/utils/auth.js`
- localStorage key: `faq_admin_token`
- 登录使用原生 `fetch`（不经过 axios 拦截器）
- 其他 API 使用 `http` 实例

### 4.2 API 模块清单

| 文件 | 导出函数 | 对应后端接口 |
|------|----------|--------------|
| `api/faq.js` | `getFaqList`, `getFaqDetail`, `addFaq`, `deleteFaq`, `updateFaqCategory`, `importFaqs`, `importCsv` | `/api/faq/*` |
| `api/category.js` | `getCategories`, `getCategoryFaqs`, `addCategory`, `deleteCategory` | `/api/categories/*` |
| `api/task.js` | `getTasks`, `getTaskDetail`, `saveTask`, `deleteTask` | `/api/tasks/*` |
| `api/taskInstance.js` | `getTaskInstances`, `getTaskInstanceStats`, `getTaskInstance`, `updateTaskInstance`, `deleteTaskInstance`, `cancelTaskInstance` | `/api/task-instances/*` |
| `api/chatLog.js` | `getUnmatched`, `getLowConfidence`, `getChatLogDates`, `getRecentChatLogs` | `/api/chat-log/*` |
| `api/analysis.js` | `getAnalysis`, `getSuggest`, `addQuestion`, `checkQuestions` | `/api/analysis/*` |
| `api/config.js` | `getConfig`, `saveConfig` | `/api/config` |
| `api/dialogueRules.js` | `getDialogueRules`, `saveDialogueRules`, `resetDialogueRules`, `getRuleStats`, `resetRuleStats`, `getRuleLogs`, `clearRuleLogs` | `/api/dialogue-rules/*` |
| `api/upload.js` | `uploadFile`, `getUploads`, `deleteUpload` | `/api/upload/*` |
| `api/stats.js` | `getStats` | `/api/stats` |
| `api/chat.js` | `sendChat` | `/api/chat` |

### 4.3 登录流程

```
1. 用户访问 /admin/ → 显示登录遮罩层（index.html）
2. 输入用户名/密码 → POST /api/auth/login（原生 fetch）
3. 登录成功 → token 存入 localStorage
4. 页面刷新 → GET /api/auth/verify（验证 token）
5. 验证通过 → 隐藏登录遮罩层，Vue 应用加载
6. 后续请求 → axios 自动注入 Authorization 头
7. Token 过期 → 401 响应 → axios 拦截器清除 token → 跳转登录页
```

---

## 5. 编码规范与项目约定

### 5.1 后端规范

#### 路由定义模式
```javascript
// 所有异步路由必须使用 asyncHandler 包装
router.get('/path', asyncHandler(async (req, res) => {
  // 业务逻辑
  res.json({ success: true, data: ... })
}))
```

#### 错误处理
- 使用 `asyncHandler` 包装异步路由，自动捕获异常
- 全局 `errorHandler` 中间件统一返回 JSON 格式
- 开发环境返回堆栈信息，生产环境只返回错误消息

#### 响应格式
```javascript
// 成功
{ success: true, data: ... }

// 失败
{ success: false, message: '错误信息' }
```

#### 中间件顺序（server.js）
```javascript
1. cors()
2. express.json()
3. 静态文件（/admin → public/admin/）
4. authMiddleware（JWT 认证）
5. adminLimiter（限流）
6. 业务路由
7. notFoundHandler（404）
8. errorHandler（全局错误）
```

#### 认证白名单
以下接口不需要 Token：
- `/api/chat`, `/api/recognize`（聊天接口）
- `/api/auth/login`, `/api/auth/verify`（认证接口）
- `/api/health`（健康检查）
- `/api/mock/*`（假接口）

#### 配置管理
- 优先级：环境变量 > .env 文件 > 默认值
- 运行时配置：`sys_config` 表，支持热更新
- 静态配置：`config/index.js`，修改需重启

### 5.2 前端规范

#### 组件结构
```vue
<template>
  <!-- 模板 -->
</template>

<script setup>
// 组合式 API
import { ref, computed, onMounted } from 'vue'
import { http } from '@/utils/http'

// 状态
const loading = ref(false)
const data = ref([])

// 方法
const fetchData = async () => {
  loading.value = true
  try {
    const res = await http.get('/api/xxx')
    data.value = res.data
  } finally {
    loading.value = false
  }
}

// 生命周期
onMounted(() => {
  fetchData()
})
</script>

<style scoped>
/* 样式 */
</style>
```

#### API 调用模式
```javascript
// api/xxx.js
import http from '@/utils/http'

export const getXxx = () => http.get('/api/xxx').then(r => r.data)
export const createXxx = (data) => http.post('/api/xxx', data).then(r => r.data)
```

#### 路由配置
- 使用 Hash 模式（`createWebHashHistory`）
- 路由守卫检查登录状态
- 登录页标记 `meta: { public: true }`

### 5.3 构建与部署约定

#### 前端构建
```bash
cd frontend
npm run build      # 生成 dist/（带 hash 文件名）
npm run deploy     # 复制 dist/ → public/admin/
```

**重要**：构建后必须检查 `public/admin/index.html` 的资源引用是否指向正确的 hash 文件名。

#### 后端启动
```bash
npm start          # 生产模式
npm run dev        # 开发模式（自动重启）
```

#### Docker 部署
```bash
docker build -t faq-bot .
docker run -p 3001:3001 faq-bot
```

#### 云端部署
使用 Docker 构建镜像后推送到私有仓库,在云服务器上拉取并运行。
```bash
# 本地构建
docker build -t faq-bot:v3.1.1 .

# 推送到私有仓库
docker push <registry>/faq-bot:v3.1.1

# 云服务器拉取并运行
docker pull <registry>/faq-bot:v3.1.1
docker run -d --name faq-bot -p 3001:3001 \
  --env-file .env \
  faq-bot:v3.1.1
```
**注意**: 通过 `.env` 文件或环境变量注入敏感配置,不要硬编码。

### 5.4 关键陷阱

1. **前端构建产物覆盖**：`npm run build` 会生成带 hash 的文件名，必须同步更新 `public/admin/index.html` 的资源引用，否则页面空白。

2. **Verify 端点必须真正验证**：`/api/auth/verify` 不能依赖全局白名单直接返回 `valid:true`，必须真正验证 JWT，否则导致登录循环。

3. **XHR Monkey-patch 不要重复注入 Authorization**：`index.html` 中的 XHR 拦截器仅用于 401 监听，不要注入 Authorization 头（axios 已处理），否则导致请求失败。

4. **Vue Router 组件缓存**：`router-view` 需要 `:key="route.fullPath"` 防止组件复用导致页面内容不更新。

5. **配置热更新范围**：`sys_config` 表的修改自动生效，但 `config/index.js` 的修改需要重启服务。

6. **路由注册顺序**：`/admin` 静态文件必须在根静态文件之前注册，否则 `/admin/*` 会被错误拦截。

---

## 附录：文件行数统计

| 模块 | 文件数 | 约行数 |
|------|--------|--------|
| 后端核心 | 4 | ~2,000 |
| 路由层 | 13 | ~1,500 |
| 服务层 | 18+ | ~3,000 |
| 数据访问层 | 4 | ~800 |
| 前端源码 | 20+ | ~4,000 |
| 测试文件 | 14 | ~2,000 |
| **总计** | **73+** | **~13,300** |
