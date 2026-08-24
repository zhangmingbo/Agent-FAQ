# 路由判定：一个问题进来，系统如何判断走 FAQ / 任务 / 域外

> 核心链路：`faq-engine.chat()` → `nlu.route()`（5 层递进判定）→ 各通道处理
> 相关代码：`faq-engine.js` / `services/taskflow/nlu.js`（route / arbitrateTaskFaq / matchTask）

---

## 一、整体流程（总览图）

```mermaid
flowchart TD
    A[用户输入] --> B[无意义检测]
    B -->|无意义| B1[回兜底话术]
    B -->|有意义| C[会话上下文<br/>历史 / 上轮追问待选]
    C -->|上轮在追问二选一| C1[解析选择]
    C1 -->|办理| C2[进入任务通道]
    C1 -->|咨询| C3[进入 FAQ 通道]
    C -->|正常轮次| D{有活跃任务?}

    D -->|A: 挂起中| E1[恢复词?]
    E1 -->|是| E2[恢复任务, 继续办理]
    E1 -->|否| R[路由判定 route]

    D -->|B: 进行中| F1[新任务意图预检<br/>detectNewTask 确定性判定]
    F1 -->|切换新任务| F2[暂存当前, 触发新任务]
    F1 -->|否| F3[任务对话 LLM 提取槽位]
    F3 -->|提取成功| F4[任务回复]
    F3 -->|提取失败| R

    D -->|C: 无活跃任务| R

    R -->|task_new| T1[开始任务<br/>matchTask 确认 → 问第一个槽位]
    R -->|faq| T2[FAQ 通道<br/>_handleRecognize 意图识别]
    R -->|clarify| T3[追问二选一<br/>办理「任务名」/ 咨询]
    R -->|out_of_scope| T4[域外业务引导]
    R -->|task_continue| T5[任务通道继续]
```

---

## 二、路由判定 `route()` —— 5 层递进

```mermaid
flowchart TD
    IN[输入进入 route] --> L1[① 规则快检<br/>确认/否认/取消/点名槽位标签]
    L1 -->|命中| T1[task_continue]
    L1 -->|未命中| L2[② 触发词规则快检<br/>触发词+近义扩展 / 否定防护]
    L2 -->|命中 且 非否定| L2A[给任务 taskBoost=0.85<br/>标记 byRuleHit]
    L2 -->|未命中| L3
    L2A --> L3[③ 任务/FAQ 统一语义仲裁<br/>一次编码, 两套向量对比]
    L3 -->|见仲裁分支图| L3R{仲裁结果}
    L3R -->|task_new| L3B[return task_new]
    L3R -->|faq| L3C[return faq]
    L3R -->|clarify 且一侧达线| L3D[return clarify]
    L3R -->|out_of_scope 且无触发词| L3E[return out_of_scope]
    L3R -->|out_of_scope 但触发词命中| L3F[不判域外, 继续细分]
    L3R -->|仲裁双低| L3G[完整 matchTask<br/>LLM judgeTrigger 补强]
    L3G -->|命中| L3B
    L3G -->|未命中| L4[④ LLM 兜底 route 节点<br/>三选一 faq/new_task/continue/null]
    L3D --> L4
    L4 -->|faq| L3C
    L4 -->|new_task| L3B
    L4 -->|continue 且有任务| L4A[task_continue]
    L4 -->|continue 无任务 / null| L4B[clarify]
    L4 -->|LLM 失败/未启用| L5[⑤ 降级]
    L5 -->|触发词命中但 rule 模式| L5A[clarify]
    L5 -->|默认| L5B{有任务上下文?}
    L5B -->|是| T1
    L5B -->|否| L3C
```

---

## 三、仲裁（arbitrateTaskFaq）判定分支

```mermaid
flowchart TD
    A[用户输入编码成向量 qv] --> B[任务侧: 与意图例句向量逐任务对比<br/>取每个任务最高相似度]
    B --> B1{触发词命中且<br/>与语义最高任务一致?}
    B1 -->|是| B2[taskScore = max 语义分, 0.85]
    B1 -->|否| B3[taskScore = 语义分]
    A --> C[FAQ 侧: 与 FAQ 问题+相似问向量对比<br/>取最高相似度 faqScore]
    B2 --> D[判定]
    B3 --> D
    C --> D
    D --> D1{任务<taskMin 且 FAQ<faqMin?}
    D1 -->|是| R1[out_of_scope 无候选]
    D1 -->|否| D2{无触发词 且 两侧都<strongHit 0.8?}
    D2 -->|是| R2[out_of_scope 弱匹配<br/>'我家门坏了' 任务0.64/FAQ0.61]
    D2 -->|否| D3{差 diff > gap 0.08?}
    D3 -->|是, 任务高| R3[task_new]
    D3 -->|是, FAQ 高| R4[faq]
    D3 -->|否, 接近| R5[clarify]
```

---

## 四、各通道后续处理

| route 返回 | 处理 | 走向 |
|---|---|---|
| `task_new` | `_tryStartTask`：matchTask 确认任务 → `startTask` → 问第一个槽位 | 任务流程 |
| `faq` | `_handleRecognize`：FAQ 意图识别（见下） | FAQ 回答 |
| `clarify` | 追问二选一：*"您是想办理「任务名」业务，还是想咨询其他问题呢？"* | 用户选择后再路由 |
| `out_of_scope` | 域外引导话术（"您的问题超出我的服务范围…"） | 结束 |
| `task_continue` | 任务通道继续（规则版步骤机 / LLM 版对话） | 任务流程 |

---

## 五、FAQ 通道内部（_handleRecognize）

```mermaid
flowchart TD
    A[进入 FAQ 通道] --> B[NLP 意图识别<br/>用户输入 vs FAQ 全部问题+相似问向量 top1]
    B --> C{置信度}
    C -->|高置信 ≥ minConfidence| D[直接回答该 FAQ]
    C -->|中置信<br/>minConfidence ~ clarifyThreshold| E[追问确认<br/>您是想咨询XXX吗? 是/否]
    C -->|低置信| F[LLM 兜底 / 域外引导]
```

---

## 六、三个例子走一遍

| 用户输入 | 触发词 | 任务侧 | FAQ 侧 | 判定链 | 结果 |
|---|---|---|---|---|---|
| "换表怎么办理" | ✅ 命中"换表" | 0.82 → 抬升 **0.85** | 0.71 | 触发词命中→抬升→差 0.136>gap | **task_new** → 开始换表任务 |
| "滤芯多久换一次" | ❌ | 0.51 | **0.90**（滤芯 FAQ） | FAQ 达强命中且更高 | **faq** → 直接答 |
| "我家门坏了" | ❌ | 0.64 | 0.61 | 无触发词 + 双低 <0.8 | **out_of_scope** → 域外引导 |
| "上门维修多少钱" | ❌ | 0.52 | 0.58 | 无触发词 + 双低 <0.8 | **out_of_scope** |

---

## 七、仲裁对比的数据与阈值（可配）

**对比的数据**：
- 任务侧：任务的**意图例句**（`intent_examples`）编码的向量（只有配了例句的任务参与语义仲裁）
- FAQ 侧：**FAQ 的问题 + 相似问**（`recognizer.allSamples`）编码的向量
- 触发词：`trigger_keywords` + 近义扩展（确定性信号，独立于向量）

**判定阈值**（`sys_config` 可配，任务级 `arb_*` 可覆盖）：

| 阈值 | 默认 | 作用 |
|---|---|---|
| `arb_task_min` | 0.45 | 任务侧候选最低线 |
| `arb_faq_min` | 0.55 | FAQ 侧候选最低线 |
| `arb_strong_hit` | 0.80 | 强命中线（无触发词时双低=弱匹配→域外） |
| `arb_gap` | 0.08 | 强命中后两侧差距（>gap 判胜出，否则澄清） |
| `arb_task_boost` | 0.85 | 触发词命中时的任务侧抬升分 |

---

## 八、一句话总结

**判断顺序 = 确定性规则（确认/取消/触发词）→ 语义仲裁（任务例句 vs FAQ 例句的向量相似度）→ LLM 兜底 → 降级**。判 FAQ 还是任务，本质是"用户输入更接近哪套配置例句"；判 out_of_scope 是"两个都不够像且没有触发词"（保守不误触发）。
