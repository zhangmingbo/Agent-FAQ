# 前端源码交接文档

> 用途：交予其他 AI/开发者继续前端开发。本文档说明前端代码结构、可改/不可改区域、
> 注入扩展模式、前后端 API 对接清单与开发注意事项。
> 最后更新：对应 git 提交（本项目的后续修改均在 master 分支）

---

## 1. 前端代码构成

```
public/
├── index.html              # 客服聊天页（原生 HTML+JS，完整源码，可直接改）
└── admin/
    ├── index.html          # 管理后台入口（Vue 打包产物 + 大量原生 JS 注入扩展）
    └── assets/             # Vue 构建产物（压缩 JS/CSS，不可读不可改）
        ├── index-CzApALvg.js    # Vue 运行时 + 公共逻辑
        ├── index-D334h4Ji.js    # Element UI + 业务组件打包（1.2MB）
        ├── SysConfig-HFAZ40Z7.js    # 系统配置页组件
        ├── FaqManage-DGIb-ub5.js    # FAQ 管理页
        ├── Issues-DMVnUBbz.js       # 问题追踪页
        ├── Analysis-QTHl41Pb.js     # 智能分析页
        ├── Rules-oLH4ALDu.js        # 规则引擎页
        ├── Monitor-DPrNNAmG.js      # 服务监控页
        ├── Dashboard-Co3YLy1c.js    # 概览页
        ├── FaqEditModal-D_LrKSVs.js # FAQ 编辑弹窗
        ├── ExpandCell-DGrC0jMP.js   # 表格展开单元格
        ├── dialogueRules-C-os3FM2.js
        ├── StatCard-CV92Nb3L.js
        └── *.css                    # 各页样式
```

**重要**：
- 管理后台是 **Vue 3 打包产物**，**原始 .vue 源码不在此项目**（由另一套构建工程产出，本项目只保留 dist）。直接改 `assets/*.js` 不可行（压缩、无源码映射）。
- 所有管理后台功能扩展都是**注入原生 JS 到 `admin/index.html`** 实现的（见第 2 节），**这些是真正的"前端源码"，可自由修改**。
- 客服页 `index.html` 是完整原生源码。

---

## 2. 管理后台注入扩展清单（admin/index.html 内）

注入代码集中在 `<script>` 块内，用 `// ===== 区块名 =====` 注释分隔。每个区块通过 `MutationObserver` 监听 Vue 渲染，往 DOM 注入元素/逻辑。清单如下：

| 区块（行号随版本变化，按注释名搜） | 功能 | 注入方式 |
|---|---|---|
| Token 管理 / 登录请求 | admin token 存取 + 自动带 Authorization | 原生 fetch/XHR monkey-patch |
| 表格列宽修正 setTableColumnWidths | el-table 列宽对齐修正 | MutationObserver |
| 修复分类树重复 header fixDuplicateHeader | FAQ 分类树重复表头 | MutationObserver |
| 聊天预览右侧面板 | 聊天预览页增强 | 注入 DOM |
| 规则引擎·任务管理标签页 | 任务流程管理 tab | 注入 DOM |
| 问题追踪页·表达挖掘子页签 injectSuggestTab | 问题追踪页加「🔍 表达挖掘」子页签 | MutationObserver + DOM |
| 系统配置·仲裁阈值 injectArbThresholds | 任务/FAQ 仲裁阈值配置 | 注入 DOM |
| 系统配置·高级判定 injectAdvThresholds | 候选竞争/重排/短句防护参数 | 注入 DOM |
| 系统配置·分析建议 injectAnalysisThresholds | 分析/建议阈值 + 自动扩写参数 | 注入 DOM |
| 系统配置·重排布局 restructureConfigLayout | 配置页改为 6 个 tab 卡片 | DOM 重组 |
| 系统配置·LLM 连接 renderLLMConnection | LLM 连接配置（全系统唯一模型控制点） | 注入 DOM |
| 系统配置·固定话术 renderTextsForm | 所有用户可见话术编辑 | 注入 DOM |
| 系统配置·保存按钮 placeTopRightSave | 右上角「保存配置」按钮 | 注入 DOM |
| LLM 智能层面板 | LLM 节点开关 + 提示词编辑 | 注入 DOM |
| 任务面板 / 任务列表 / 编辑弹窗 | 任务 CRUD + v2 步骤 DSL 编辑器 | 注入 DOM |
| 表达挖掘 loadSuggestions | 未匹配话术 → 任务匹配建议（采纳/忽略） | 注入 DOM |
| 会话调试（独立浮层） | 每轮对话后端处理轨迹可视化 | 注入 overlay |
| 动作输出日志 | 流程引擎动作审计 + 失败重发 | 注入 overlay |
| 智能分析·答案反馈/任务漏斗/自动扩写 | 分析数据展示 | 注入 DOM |
| **数据分析独立页签** openAnalysisOverlay | 答案反馈/任务漏斗/自动扩写三 tab overlay | 注入侧边栏菜单 + overlay |
| 右上角登出按钮 | 登出 | 注入 DOM |
| 头部调整 adjustHeader | 删刷新按钮 + LOGO 改「智能体平台」 | 注入 DOM |
| 问题追踪·批量处理 injectIssueBatch | 多选 + 批量处理（标记忽略） | 注入 DOM |
| 问题追踪·处理按钮 injectIssueDeleteBtns | 每行「处理」按钮 | 注入 DOM |

---

## 3. 客服聊天页（public/index.html）

原生 HTML+CSS+JS，完整源码。要点：
- 调用 `POST /api/chat`，请求体 `{ text, sessionId, userId, debug }`
- **sessionId 持久化**（localStorage `faq_sid_<userId>`，按用户隔离）——刷新/重开沿用同一会话（任务进度/上下文不丢）
- 渲染支持：`answer`（文本）、`richContent`（富内容）、`links`、`related`（相关推荐可点）、`source`（来源标签）、`events`（转人工等事件）、`_debug`（?debug=1 时显示）
- 快捷问题栏 quick-bar

---

## 4. 前后端 API 对接清单

### 客服对话
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/chat` | 对话主入口，返回 `{answer, source, intent_code, confidence, events?, related?, links?, _debug?}` |

### 管理后台（全部需 admin token，`Authorization: Bearer <token>`）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录 `{username,password}` → `{token}` |
| GET | `/api/config` | 系统配置（含 sessionTimeout/taskSessionTtlMinutes/llmNodes 等） |
| POST | `/api/config` | 保存配置（识别参数/仲裁/阈值/话术/LLM/扩写/超时） |
| GET | `/api/config/llm-nodes` | LLM 节点配置 |
| GET/POST | `/api/config/llm-prompts` | LLM 提示词注册表（14 个调用点，可编辑） |
| GET | `/api/faq` / `/api/faq/:code` | FAQ 列表/详情 |
| GET | `/api/tasks` / POST `/api/tasks` | 任务列表/保存 |
| POST | `/api/tasks/suggestions/ignore` | 表达挖掘·忽略话术 |
| GET | `/api/tasks/suggestions` | 表达挖掘·候选（**只读后台预计算结果，附数据时间**） |
| POST | `/api/tasks/suggestions/refresh` | 表达挖掘·手动触发后台重算 |
| POST | `/api/tasks/:code/adopt-example` | 采纳话术为意图例句 |
| GET | `/api/debug/sessions` / `/api/debug/session/:id` | 会话轨迹列表/详情 |
| GET | `/api/debug/llm-calls` | LLM 调用日志（节点/请求/响应/耗时/提示词来源） |
| POST | `/api/debug/llm-calls/clear` | 清空 LLM 调用日志 |
| GET | `/api/action-logs` | 动作输出审计 |
| GET | `/api/analysis/feedback` | 答案反馈（答错高频） |
| GET | `/api/analysis/funnel` | 任务漏斗 |
| GET | `/api/analysis/expand/audit` | 自动扩写审计 |
| POST | `/api/analysis/expand/run` / `revert` | 自动扩写执行/回滚 |
| POST | `/api/analysis/add-questions-batch` | 批量自动加入相似问（自动识别目标 FAQ） |
| GET | `/api/chat-log/unmatched` | 未匹配问题列表 |
| GET | `/api/chat-log/low-confidence` | 低置信度列表 |
| POST | `/api/chat-log/ignore` | 处理（忽略）问题 |

---

## 5. 开发注意事项（踩坑记录）

1. **注入模式**：管理后台是 Vue 产物，所有扩展用 `MutationObserver` 监听 `#app` 子节点变化后注入；**用 `data-*` 属性防重复**（`if (el.querySelector('[data-xxx]')) return`）。
2. **绝不碰 el-overlay**：Vue 的全屏遮罩层（el-dialog/el-message-box 背景）由 Vue 管理，注入代码隐藏/显示兄弟节点时会误伤它，**曾导致页面卡死**。只操作自己注入的元素。
3. **表格列对齐**：el-table 的 cell 需要 `display:flex` 横排才能让 checkbox/按钮与内容垂直居中；注入的表格用固定列宽 + `word-break:break-all` 防挤压。
4. **Vue 重建后重注入**：Vue 切页/重渲染会清掉注入的 DOM，MutationObserver 应持续观察并重新注入；布尔防重标志在 `location.href` 变化时要重置，但**DOM 存在性检查比标志更可靠**（曾出现重复页签 bug）。
5. **系统配置页结构**：原生 el-form 被重组进「识别参数」tab；原生「保存配置」按钮（el-form 最后一个 el-form-item）不能被 CSS 隐藏（曾误隐藏导致无法保存）；右上角保存按钮点击需触发面板内原生按钮。
6. **LLM 提示词优先级**：任务级 `llm.prompts.*` > 全局注册表（sys_config.llm_prompt.*）> 内置默认。任务编辑器里 4 个提示词框"与全局一致则不存"。
7. **LLM 调用日志**：`/api/debug/llm-calls` 内存存储（重启清空），控制台每次调用会打印 `[LLM-CALL]` 入参/返回/提示词来源（task/global/default）。
8. **前端样式纪律**：新增区块与 Element 风格一致（白底卡片、圆角 8px、浅灰表头 #f5f7fa、标题/内容左对齐），避免挤压。
9. **API key**：DB `llm_api_key` 为空时回退环境变量 `DEEPSEEK_API_KEY`（.env 文件，已被 .gitignore）。保存配置不得用空 key 覆盖导致 LLM 失效（已修复）。
10. **会话超时**：系统配置「识别参数」页的会话超时 = `sys_config.session_timeout`（毫秒），保存即热更新 dialogueRules；任务会话超时 = `task_session_ttl_minutes`（分钟）独立配置。

---

## 6. 给接手者的建议

- 管理后台**优先在注入区扩展**（新功能加一个 `// ===== 区块 =====` + MutationObserver），不要尝试改 assets 打包产物。
- 若需要真正重构管理后台为可维护 Vue 源码，需要**另一套独立构建工程**（Vite + Vue3 + Element Plus），本项目的 admin/index.html + assets 是它的产物输出，注入扩展可平移到新工程的挂载后逻辑。
- 客服页 index.html 是纯源码，可随意重构。
- 改任何配置类页面后，**用真实浏览器验证保存→刷新→值不变**（曾发生"保存按钮失效""参数改不生效"等配置链路问题）。
