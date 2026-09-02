# AGENTS.md

This file provides guidance to Lingma (lingma.aliyun.com) when working with code in this repository.

## Project Overview

Argos 智能体平台 - FAQ 问答机器人 + 任务型对话系统。基于 Express + Vue 3 + MySQL，支持意图识别、多轮对话、任务流程编排。

## Commands

### Backend
```bash
npm start          # 启动服务 (http://localhost:3001)
npm run dev        # 开发模式 (自动重启)
npm run test:taskflow  # 运行任务流程测试
```

### Frontend
```bash
cd frontend
npm run dev        # 开发模式 (Vite 热更新)
npm run build      # 构建生产版本
npm run deploy     # 构建并部署到 public/admin/
```

### Docker
```bash
docker build -t faq-bot .
docker run -p 3001:3001 faq-bot
```

### Cloud Deployment
```bash
./deploy-cloud.sh v3.1.1  # 增量构建并部署到云服务器
```

## Architecture

### Backend Structure

```
server.js              # 主入口，Express 应用初始化
faq-engine.js          # FAQ 问答引擎（对话编排层）
config/index.js        # 统一配置管理（环境变量 > .env > 默认值）
db/pool.js            # MySQL 连接池
middleware/
  auth.js             # JWT 认证中间件 + /api/auth 路由
  errorHandler.js     # 全局错误处理
  rateLimit.js        # 限流中间件
routes/               # API 路由（每个文件一个模块）
  chat.js             # 核心聊天接口 POST /api/chat
  faq.js              # FAQ CRUD
  tasks.js            # 任务流程定义
  taskInstance.js     # 任务实例管理
  config.js           # 系统配置（热更新）
  analysis.js         # 智能分析
  chatLog.js          # 咨询记录
  category.js         # 分类管理
  upload.js           # 文件上传
services/
  faqService.js       # 知识库领域服务（识别器 + 答案缓存）
  taskflow/           # 任务流程引擎
    index.js          # 任务引擎入口
    nlu.js            # 意图识别（LLM + 语义仲裁）
    flow.js           # 流程执行器
    stateMachine.js   # 状态机
    slotExtractor.js  # 槽位提取（NER + 规则）
    nerClient.js      # NER 服务客户端
    instanceStore.js  # 实例持久化
    taskDefs.js       # 任务定义 DSL
  llmClient.js        # 大模型客户端
  llmPrompts.js       # 提示词管理
  replyTexts.js       # 回复话术配置
  matchVocab.js       # 匹配词库配置
```

### Frontend Structure

```
frontend/
  src/
    App.vue           # 根组件（始终渲染 AppLayout）
    router/index.js   # Vue Router（Hash 模式）
    components/
      AppLayout.vue   # 主布局（侧边栏 + 顶部导航 + router-view）
    views/
      Login.vue       # 登录页
      Dashboard.vue   # 概览仪表盘
      FaqManage.vue   # FAQ 管理
      TaskTracking.vue # 任务实例管理
      Analysis.vue    # 智能分析
      Monitor.vue     # 服务监控
      Rules.vue       # 规则引擎
      SysConfig.vue   # 系统配置
    utils/
      http.js         # Axios 实例（自动注入 Authorization）
      auth.js         # Token 管理
    api/              # API 模块（每个文件对应一个后端路由）
  dist/               # 构建产物
  deploy.mjs          # 部署脚本（复制 dist 到 public/admin/）
```

### Static Files

```
public/
  admin/              # 前端构建产物（由 frontend/deploy.mjs 生成）
    index.html        # 入口 HTML（包含登录遮罩层 + XHR 拦截器）
    assets/           # JS/CSS 资源
  index.html          # 聊天窗口（独立页面）
  admin-legacy.html   # 旧版管理后台（兼容）
```

## Key Design Decisions

### Authentication Flow

1. **Login Overlay**: `public/admin/index.html` 包含登录遮罩层（z-index: 99999）
2. **Token Storage**: localStorage key = `faq_admin_token`
3. **Verify Endpoint**: `GET /api/auth/verify` - 真正验证 JWT（不依赖全局白名单）
4. **Axios Interceptor**: `frontend/src/utils/http.js` 自动注入 Authorization 头
5. **401 Handling**: 全局中间件 + axios 拦截器双重处理

**Important**: XHR monkey-patch 在 index.html 中仅用于 401 监听，不再注入 Authorization（避免与 axios 冲突）。

### FAQ Engine Architecture

```
用户输入 → FAQEngine.chat()
         ↓
    无意义检测（规则/LLM）
         ↓
    任务意图识别（taskEngine.route()）
         ↓
    FAQ 匹配（faqService.match()）
         ↓
    语义仲裁（arbitrateTaskFaq）
         ↓
    答案返回 / 追问确认 / 兜底
```

### Task Flow Engine

- **DSL v2**: 任务定义使用 YAML/JSON 格式（collect/confirm/action/subtask/branch/message 步骤类型）
- **State Machine**: 每个任务实例有独立状态机（idle/collecting/confirming/executing/done/cancelled）
- **Slot Extraction**: NER 模型 + 正则规则双来源
- **NLU**: LLM 意图识别 + 语义仲裁（arb_gap/arb_task_min/arb_faq_min 阈值）

### Database Schema

- `faq` - FAQ 知识库（code/name/category/answer/similar_questions）
- `task` - 任务流程定义（code/name/steps/slots/trigger_keywords）
- `task_instance` - 任务实例（session_id/task_code/status/slots/turn_count）
- `chat_log` - 对话日志（session_id/user_text/intent_code/answer）
- `sys_config` - 系统配置（key/value/description）
- `category` - FAQ 分类（name/parent_id/sort_order）

### Configuration System

- **Runtime Config**: `sys_config` 表存储，支持热更新（无需重启）
- **Static Config**: `config/index.js` 从环境变量/.env 加载
- **Priority**: 环境变量 > .env 文件 > 默认值

## Critical Files

| File | Purpose |
|------|---------|
| `server.js` | Express 应用入口，路由注册顺序很重要 |
| `faq-engine.js` | 对话编排核心，处理无意义过滤/意图路由/追问/兜底 |
| `middleware/auth.js` | JWT 认证，`/api/auth/verify` 必须真正验证 token |
| `services/taskflow/nlu.js` | 语义仲裁逻辑，决定走任务还是 FAQ |
| `services/taskflow/slotExtractor.js` | 槽位提取，NER + 规则双来源 |
| `frontend/src/utils/http.js` | Axios 实例，自动注入 Authorization |
| `public/admin/index.html` | 登录遮罩层 + 401 监听（不要重复注入 Authorization） |

## Common Pitfalls

1. **Frontend Build**: `npm run build` 会生成带 hash 的文件名，必须同步更新 `public/admin/index.html` 的资源引用
2. **Verify Endpoint**: `/api/auth/verify` 必须真正验证 JWT，不能依赖全局白名单直接返回 valid:true
3. **XHR Monkey-patch**: 不要在 index.html 中重复注入 Authorization 头（axios 已处理）
4. **Route Cache**: Vue Router 的 `router-view` 需要 `:key="route.fullPath"` 防止组件复用
5. **Config Hot Reload**: `sys_config` 修改后自动生效，但 `config/index.js` 的修改需要重启服务

## Testing

```bash
# API 测试
curl http://localhost:3001/api/health
curl -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"admin123"}'

# 带 Token 测试
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"admin123"}' | jq -r .token)
curl http://localhost:3001/api/faq -H "Authorization: Bearer $TOKEN"

# 任务流程测试
npm run test:taskflow
```

## Deployment Checklist

- [ ] 前端构建：`cd frontend && npm run deploy`
- [ ] 更新 index.html 资源引用（如果文件名变化）
- [ ] Git 提交并打 tag：`git tag -a v3.x.x -m "..."`
- [ ] 云端部署：`./deploy-cloud.sh v3.x.x`
- [ ] 验证：访问 http://47.102.129.76:3001/admin/
