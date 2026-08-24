# 动作系统完整测试报告

- **测试套件**：`tests/action-system.test.mjs`
- **运行命令**：`node tests/action-system.test.mjs`（需服务器在 `localhost:3001` 运行）
- **执行时间**：2026-08-23
- **结果**：✅ **69 通过 / 0 失败**
- **覆盖范围**：表达式引擎、条件判断、统一接口调用、动作注册表、动作编排、状态机、端到端 chat 链路

---

## 一、覆盖矩阵

| 模块 | 文件 | 断言数 | 内容 |
|---|---|---|---|
| ① 表达式引擎 | `expr.js` | 15 | 算术/括号/取模/负数、比较、逻辑、宽松相等、变量点路径、组合、异常不抛出 |
| ② 条件判断 | `condition.js` | 19 | 12 操作符、5 判断源、and/or 组合、注册表函数、表达式、时间判断 |
| ③ 模板与归一化 | `httpCall.js` | 7 | 占位符解析、旧配置 4 种归一化、出参点路径提取 |
| ④ 状态机 | `stateMachine.js` | 2 | 已转人工（TRANSFERRED）转移合法性 |
| ⑤ 动作注册表 | `actionRegistry.js` | 4 | 内置动作、complete_message、transfer_human 事件、未注册动作 |
| ⑥ 统一接口调用 | `httpCall.js` | 7 | 成功、出参、话术插值、body 模板、静默、失败重试、旧格式兼容 |
| ⑦ call_api + 日志 | `actionRegistry.js` + `action_log` | 5 | 成功/失败、日志 ok/fail、payload 快照（固定入参+模板） |
| ⑧ 动作编排 | `flow.js` | 7 | 线性执行、分支 then/else、幂等、失败、嵌套、步骤日志 |
| ⑨ 端到端 chat 链路 | faq-engine + taskflow | 3 | 转人工事件返回、编排任务完成、编排日志落库 |

---

## 二、案例明细与结果

### ① 表达式引擎（15/15 ✓）
- 算术：`1+2*3=7`、`(1+2)*3=9`、`5%2=1`、`-3+5=2`
- 比较：`5>3`、`5>=5`、`"5"==5`（宽松相等）
- 逻辑：`&&`、`||`、`!`
- 变量：`slot.phone`、`result.a.b`（点路径）、组合表达式
- 健壮性：缺失路径返回 null 不抛异常、语法错误返回 null 不抛异常（无 eval，防注入）

### ② 条件判断（19/19 ✓）
- 操作符：eq / ne / contains / notContains / regex / gt / gte / lt / lte / empty / notEmpty
- 判断源：槽位值、上下文变量、**接口结果点路径**（`check.status`）、时间、函数、表达式
- 组合：and（全真/一假）、or
- 注册表函数：自定义 `is_even` 判断
- 时间：`workday`（第三方节假日 API）与 `business_hours` 返回布尔

### ③ 模板与归一化（7/7 ✓）
- 占位符：`{slot.x}` `{var.x}` `{result.y.z}` `{sessionId}` `{taskCode}` `{idempotencyKey}`；`{result}` 无路径保留
- 旧配置归一化：fieldMap/fixedParams → body；resultMap → result；resultSlot/resultField → result；successMessage → done_message
- 出参点路径提取：`extractResult({data:{orderNo}}, 'data.orderNo')`

### ④ 状态机（2/2 ✓）
- `CONFIRMING → TRANSFERRED` 允许；`DONE → TRANSFERRED` 不允许

### ⑤ 动作注册表（4/4 ✓）
- 3 个内置动作齐全；complete_message 返回配置话术；transfer_human 返回转人工事件（含 sessionId/taskCode/slots）；未注册动作明确报错

### ⑥ 统一接口调用（7/7 ✓）
- 成功调用 mock 接口；出参提取 orderNo/status；done_message 插值 `{result.orderNo}`；body 模板（槽位）+ 固定值；未配话术 → 静默；失败自动重试（retries=1 → 2 次尝试）；旧 `{result}` 主值插值

### ⑦ call_api + 审计日志（5/5 ✓）
- 成功（message 含订单号）；`action_log` 记录 status=ok + url；payload 快照含固定入参（appId=10086）与模板（traceId={sessionId}→实际会话）；失败记录 status=fail + error

### ⑧ 动作编排（7/7 ✓）
- 线性执行：check → branch → notify；步骤日志 2 条（含 step 名与幂等键 `{sessionId}-{taskCode}-flow`）
- 分支：`check.status == 已受理` → 正确走 **then** 分支（payload 验证）
- **幂等**：同会话第二次执行直接命中（不重复调接口，防重复办业务）
- 失败：接口不可达 → 整链 fail + error
- 嵌套分支（2 层）正常执行

### ⑨ 端到端 chat 链路（3/3 ✓）
- **转人工任务**：真实对话（触发→办理→收集→确认）→ 响应携带 `transfer_human` 事件（type/sessionId/taskCode/slots）
- **编排任务**：真实对话 → 确认后编排执行 → task_complete
- 编排步骤日志落库（≥2 条 flow 步骤，含幂等键）

---

## 三、本次测试发现并修复的问题

| 问题 | 影响 | 修复 |
|---|---|---|
| **done_message 出参引用错误**（真 bug） | `executeHttpCall` 话术中的 `{result.xxx}` 引用的是调用方传入的 result 上下文，而非本次调用提取的出参（results）→ 话术插值变空（如"单号 状态"） | done_message 一律基于**本次出参 results** 解析（`httpCall.js`） |

### 测试过程中确认的非 bug 现象
1. **编排分支走 else**：非逻辑问题——MySQL JSON 列存储 `"branch": "then"`（带空格）与断言字符串不匹配，逻辑本身正确
2. **转人工任务首轮未触发**：测试触发词"测试转人工"与 FAQ 库 human_agent 意图语义撞车，被仲裁分流——**新增任务的触发词应避免与 FAQ 语义重复**（用更独特的词）

---

## 四、会话调试可见性说明

- **测试套件的端到端部分（⑨ 节）**：走真实 `/api/chat` 接口 → **可在管理后台「会话调试」中查看完整轨迹**（本次运行留存的会话）：
  - `e2e-t-*`：转人工测试任务（4 轮，含"任务对话·转人工"步骤与事件）
  - `e2e-f-*`：编排测试任务（4 轮，含"任务对话·执行编排"步骤）
- **单元/集成部分（①–⑧ 节）**：直接调用后端模块（expr/condition/httpCall/runAction/runFlow），**不走 chat 接口，不会出现在会话调试中**——它们的结果以本报告断言为准

> 会话调试为内存存储（重启清空，每会话保留最近 50 轮 / 最多 200 个会话），测试会话可能被后续对话覆盖。
