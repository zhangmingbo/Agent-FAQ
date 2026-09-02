# AGENTS.md

Argos 智能体平台 - FAQ 问答机器人 + 任务型对话系统。基于 Express + Vue 3 + MySQL，支持意图识别、多轮对话、任务流程编排。
## 核心声明（每次任务必须先读）
你在本项目的每一次代码生成、修改、重构、修复BUG，都必须**完全遵守本文档所有规约**。
收到任务第一句话必须输出：【已完整阅读并严格遵守本项目全栈开发规约】。
同时列出本次任务**待修改/新增文件清单**，确认无误后再开发。

# 1. 项目整体架构约束
1. 本项目为【前后端分离架构】，前端、后端职责严格隔离，禁止跨层乱写逻辑。
2. 目录结构为固定架构，**禁止私自新增顶层目录、移动目录、删除原有架构文件**。
3. 所有新增功能必须遵循：后端分层、前端分层，禁止逻辑堆砌。
4. 所有功能必须遵循：逻辑与业务配置分离，禁止在代码中硬编码参数和配置。
4. 禁止私自升级框架大版本、私自新增无关第三方依赖。

# 2. 后端开发强制规约 
## 分层规范（严格执行）
分层顺序：路由(api) → 入参出参(schema) → 业务服务(service) → 数据库模型(model)
绝不允许路由写业务、绝不允许service写SQL原生乱语句。

## 配置规范
1. 所有端口、账号、路径、开关、参数 **全部写在 yaml 配置**
2. 业务代码**禁止任何硬编码**

## 代码质量规范
1. 禁止删除已有可用业务代码，废弃代码注释保留
2. 修改已有函数**禁止擅自修改入参、返回结构**
3. 如需破坏性改动，必须先说明、全链路同步修改
4. 所有异常必须捕获、日志必须完整

## 接口规范
1. 所有接口统一 RESTful 风格
2. 统一返回结构体，禁止自定义返回格式
3. 所有新增接口必须可分页、可筛选（列表类）

## 测试规范
每改动一处后端逻辑，**必须同步更新单元测试**
不允许只改代码不补测试

# 3. 前端开发强制规约（Vue3 + TS + Vite）
## 语法规范
1. 全部使用 setup + ts 语法，禁止选项式 API
2. 严格使用 TypeScript，所有变量、接口、入参必须定义类型
3. 禁止 any 泛滥，实在无法定义需注释说明

## 分层规范
1. api 层：只做请求封装
2. utils 层：工具函数
3. store 层：全局状态
4. views 层：页面UI
5. components：公共组件
**禁止跨层乱写逻辑**

## 请求规范
1. 所有请求统一走 axios 拦截器
2. 自动携带 token、自动处理401/403/500
3. 前端 TS 类型必须**严格对齐后端 schema 字段**

## UI规范
使用 Element Plus，样式简洁标准，不写冗余CSS

# 4. 数据库约束
1. 所有表字段必须在 model 定义
2. 新增字段必须同步：model、schema、接口、前端TS类型、页面展示
3. 禁止随意删字段、改字段类型

# 5. 全栈联动铁律（最重要、杜绝BUG根源）
**后端改动字段/接口 → 必须同步前端类型、页面、表格、弹窗**
**前端新增参数 → 必须核对后端是否支持，不允许前端私自造字段**

# 6. 迭代开发流程（每轮任务强制执行）
1. 阅读 AGENTS.md
2. 列出本次改动文件清单
3. 开发完成
4. /review 查看完整diff
5. 自检是否破坏原有逻辑
6. 给出可落地的验证步骤

# 7. 严格禁止行为
1. 禁止脑补不存在函数、变量、文件、接口
2. 禁止大范围无理由重构
3. 禁止改动需求外的无关文件
4. 禁止删除原有稳定逻辑
5. 禁止省略单元测试、跳过报错
6. 禁止前后端字段不一致、类型不匹配

# 8. 会话混乱兜底规则
如果当前会话出现：幻觉代码、逻辑断层、遗忘架构、代码错乱
立刻停止深度开发，仅做小修复，等待新建Quest迭代新功能。

执行任务时，按阶段切换角色，不新建独立Quest。

角色定义：
1.【产品/架构角色】：负责需求拆解、模块设计、数据表设计、接口契约定义；输出方案、数据表结构、OpenAPI契约；**不写实现代码**。输出方案后，需要确认方案可行，再交给后端角色。
2.【后端开发角色】：根据架构输出的接口契约、数据表，实现后端代码；严格遵守契约，不能私自修改接口入参出参；完成业务代码。
3.【前端开发角色】：严格依据后端接口契约、TS类型定义，实现前端页面组件；保证字段类型对齐后端schema。
4.【测试角色】：后端完成后编写单元测试；前端完成后编写组件测试；给出手动测试用例；执行review做代码审查，找出逻辑漏洞、边界case。

工作流转顺序，强制串行：
①产品架构输出方案设计 → ②后端实现 → ③前端实现 → ④测试角色补测试、审查代码。
不允许跨角色并行开发。
每一个阶段完成之后，列出改动文件，执行/review。
如果架构需要调整，回到①重新修订方案，下游后端、前端同步跟随修改。

约束：
所有角色必须遵守AGENTS.md全部规约；角色切换只是思维视角切换，仍然操作同一套项目文件。



## Project Overview


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
使用 CI/CD 流程或手动构建 Docker 镜像后推送到私有仓库,然后在云服务器上拉取并运行。
**注意**: 不要硬编码敏感信息(如数据库密码),应通过环境变量或 `.env` 文件注入。

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
- [ ] Docker 构建：`docker build -t faq-bot:v3.x.x .`
- [ ] 推送镜像到私有仓库：`docker push <registry>/faq-bot:v3.x.x`
- [ ] 云服务器拉取并运行新镜像
- [ ] 验证：访问管理后台
