# LLM 调用节点架构图

> 全系统唯一 LLM 出口：`services/llmClient.js`（共享模块）
> 连接配置（总开关/apiUrl/apiKey/model）与「调用节点」分离，管理后台「LLM 智能层」可视化编辑
> 每个节点可独立开关（`sys_config.llm_nodes`），未启用/失败返回 null，上层自动降级规则

```mermaid
flowchart TB
    subgraph USER["用户输入 /api/chat"]
        U[用户消息 + sessionId]
    end

    subgraph ENGINE["faq-engine.js（对话编排）"]
        M[无意义检测] -->|meaningless 节点<br/>规则未定且 meaningless模式=llm| LLMCLIENT
        R1[意图识别 recognize]
        R1 -->|候选≥2 且 置信度<0.9<br/>rerank 节点| RR[意图重排 rerankIntent]
        RR --> LLMCLIENT
        R1 -->|常规 FAQ 命中| FAQ[直接返回 FAQ 答案]
        R1 -->|fallback| DOMAIN[业务域外引导<br/>不调 LLM]
    end

    subgraph TASK["任务引擎 taskflow（index.js）"]
        subgraph NLU["nlu.js 理解层"]
            T1[任务触发判定 matchTask] -->|trigger 节点<br/>规则+向量未命中| LLMCLIENT
            T2[新任务意图 detectNewTask] -->|trigger 节点<br/>统一仲裁 out_of_scope| LLMCLIENT
            T3[意图路由 route] -->|route 节点<br/>规则拿不准时兜底| LLMCLIENT
        end
        subgraph DM["对话管理器"]
            D1[规则版 dialogManager] -->|extract 节点<br/>规则提取失败| EX[槽位提取 extractSlots]
            EX --> LLMCLIENT
            D2[LLM版 llmDialogManager] -->|dialogue 节点<br/>单轮决策 dialogueTurn| DIALOG[任务对话<br/>slots+reply+ask_confirm+question]
            DIALOG --> LLMCLIENT
        end
    end

    LLMCLIENT[llmClient.js<br/>chat() 统一 HTTP 调用<br/>OpenAI 兼容格式]
    LLMCLIENT -->|POST /chat/completions| DS[DeepSeek API<br/>api.deepseek.com<br/>model: deepseek-chat]

    M --> ENGINE
    U --> ENGINE
    ENGINE --> TASK
    TASK --> ENGINE
    ENGINE -->|response + events| U
```

## 六个活跃节点（+1 预留）

| 节点 | 提示词（管理后台可编辑） | 调用点 | 作用 | 开关默认 |
|---|---|---|---|---|
| **trigger** | judge_trigger.system | `nlu.js` matchTask / detectNewTask | 任务触发判定：规则+向量都没命中时，LLM 判断用户想办哪个业务 | 开 |
| **extract** | extract_slots.system | `llmClient.extractSlots`（规则版）/ `extractSlotsBatch`（LLM版） | 槽位提取：从用户输入抽电话/地址/型号等字段 | 开 |
| **dialogue** | dialogue.system + dialogue.user | `llmDialogManager.processTurn` | 任务对话单轮决策：LLM 决定本轮回复+填哪些槽+是否确认 | 开 |
| **route** | router.system + router.user | `nlu.js` route() | 意图路由兜底：规则拿不准时 LLM 判 continue/new_task/faq | 开 |
| **meaningless** | meaningless.system | `faq-engine._isMeaninglessByLLM` | 无意义输入检测（仅 meaningless 模式=llm 时） | 开 |
| **rerank** | llm_rerank.system + user | `faq-engine._llmRerankIntent` | FAQ 意图重排：候选≥2 且置信度<0.9 时，LLM 选更优意图 | 开 |
| ~~faq_answer~~ | faq_answer.system | 无调用点（预留） | FAQ 兜底回答——当前**未启用**：fallback 走业务域外引导，不用 LLM 兜底 | 关 |

## 触发路径说明

1. **任务触发**：用户输入 → 规则快检（触发词）→ 向量语义 → 都未命中 → `trigger` 节点 LLM 判定
2. **任务对话**：任务进行中 → 每轮先 `detectNewTask`（仲裁判新任务）→ 未切任务则 `dialogue` 节点单轮决策
3. **槽位提取**：规则版任务规则提取失败 → `extract` 节点；LLM 版任务 → `extractSlotsBatch`
4. **意图路由**：任务中插话/换任务/咨询拿不准 → 规则判定 → 未决 → `route` 节点兜底
5. **无意义检测**：模式=llm 且规则未定 → `meaningless` 节点
6. **FAQ 重排**：识别候选≥2 且 top1 置信度 < 0.9 → `rerank` 节点重排选优
7. **FAQ 兜底**：fallback **不调 LLM**（业务域外引导，方案 A 设计）

## 降级链

```
LLM 节点启用 && 调用成功 ──→ 用 LLM 结果
LLM 节点未启用/调用失败 ──→ 返回 null/空 ──→ 上层规则降级：
  trigger   → 不触发任务（走 FAQ/域外）
  extract   → 规则提取（可能失败→重问）
  dialogue  → 降级规则版 dialogManager
  route     → task_continue 保守处理
  meaningless→ 规则判定
  rerank    → 用原 top1 结果
```

## 任务级覆盖

每个任务可配置 `llm: { enabled: false }` 整体关闭，或 `llm: { <node>: { enabled: false } }` 关闭单个节点（如报修任务不用 dialogue 用规则流程）。
