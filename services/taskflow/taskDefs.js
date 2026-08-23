/**
 * 任务定义加载器（DSL v2）
 *
 * 声明式任务定义模型（task 表）：
 *   code, name, description,
 *   trigger_keywords JSON,     // ['报修'] 或 [{keyword|regex}]
 *   slots JSON,                // v1 兼容：简单槽位（无 steps 时自动生成流程）
 *   steps JSON,                // v2 流程 DSL（collect/confirm/action/subtask/branch/message）
 *   completion_message, on_complete, status
 *
 * v2 步骤 DSL：
 *   { key, type, next, ... }
 *   type=collect : { slot_key, label, required, prompt, extract:{method,rule,enum}, validate:{rule,reask} }
 *   type=confirm : { prompt? }  —— 收集完毕后确认
 *   type=action  : { action, params, done_message, on_fail:'retry'|'reask' }
 *   type=subtask : { task, on_return }
 *   type=branch  : { cases:[{when:{slot,op,value},next}], default_next }
 *   type=message : { text }
 *
 * v1 → v2 运行时迁移：无 steps 时由 slots 自动生成
 *   collect(slot) xN → confirm → complete action
 */

import pool from '../../db/pool.js'
import { getTriggerSynonyms } from '../matchVocab.js'

class TaskDefs {
  constructor() {
    /** @type {Map<string, Object>} code -> taskDef（含规范化后的 steps） */
    this.defs = new Map()
  }

  /** 确保表结构存在（含 v2 的 steps 列与 intent_examples 意图例句） */
  async ensureTable() {
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS task (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        trigger_keywords JSON COMMENT '触发关键词列表',
        slots JSON COMMENT '槽位定义列表（v1 兼容）',
        steps JSON COMMENT '流程 DSL（v2）',
        intent_examples JSON COMMENT '意图例句（NLU 理解用）',
        clarify_question VARCHAR(500) DEFAULT '' COMMENT '任务/FAQ 冲突时的追问话术（留空用全局模板）',
        clarify_options JSON COMMENT '追问选项列表（如 ["预约上门服务","咨询其他问题"]，留空用默认二选一）',
        arb_gap DECIMAL(4,3) NULL COMMENT '仲裁差距阈值（任务级，null=用全局 sys_config）',
        arb_task_min DECIMAL(4,3) NULL COMMENT '任务侧最低线（任务级，null=用全局）',
        arb_faq_min DECIMAL(4,3) NULL COMMENT 'FAQ 侧最低线（任务级，null=用全局）',
        arb_strong_hit DECIMAL(4,3) NULL COMMENT '强命中线（任务级，null=用全局）',
        completion_message TEXT,
        on_complete VARCHAR(100) DEFAULT '' COMMENT '完成后动作',
        status TINYINT DEFAULT 1 COMMENT '1=启用 0=禁用',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )
    // 老表补充 v2 列（已存在则忽略错误）
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN steps JSON NULL COMMENT \'流程 DSL（v2）\' AFTER slots')
    } catch { /* 列已存在 */ }
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN intent_examples JSON NULL COMMENT \'意图例句（NLU 理解用）\' AFTER steps')
    } catch { /* 列已存在 */ }
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN clarify_question VARCHAR(500) DEFAULT \'\' COMMENT \'任务/FAQ 冲突时的追问话术\' AFTER intent_examples')
    } catch { /* 列已存在 */ }
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN clarify_options JSON NULL COMMENT \'追问选项列表\' AFTER clarify_question')
    } catch { /* 列已存在 */ }
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN arb_gap DECIMAL(4,3) NULL COMMENT \'仲裁差距阈值（任务级）\' AFTER clarify_options')
    } catch { /* 列已存在 */ }
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN llm JSON NULL COMMENT \'任务级 LLM 配置（dialogue/extract 覆盖全局节点）\' AFTER arb_strong_hit')
    } catch { /* 列已存在 */ }
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN api_action JSON NULL COMMENT \'调用接口配置（url/method/fieldMap/successMessage）\' AFTER llm')
    } catch { /* 列已存在 */ }
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN arb_task_min DECIMAL(4,3) NULL COMMENT \'任务侧最低线（任务级）\' AFTER arb_gap')
    } catch { /* 列已存在 */ }
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN arb_faq_min DECIMAL(4,3) NULL COMMENT \'FAQ 侧最低线（任务级）\' AFTER arb_task_min')
    } catch { /* 列已存在 */ }
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN arb_strong_hit DECIMAL(4,3) NULL COMMENT \'强命中线（任务级）\' AFTER arb_faq_min')
    } catch { /* 列已存在 */ }
  }

  /** 全量加载任务定义（含 v1 → v2 迁移） */
  async loadTasks() {
    const [rows] = await pool.execute('SELECT * FROM task ORDER BY id ASC')
    this.defs.clear()
    for (const row of rows) {
      const def = this._normalize(row)
      if (def) this.defs.set(def.code, def)
    }
    return this.defs.size
  }

  /** 规范化任务定义：解析 JSON 字段、迁移 v1 slots → v2 steps、扩展触发词 */
  _normalize(row) {
    const triggerKeywords = _parseJson(row.trigger_keywords, [])
    const slots = _parseJson(row.slots, [])
    let steps = _parseJson(row.steps, null)

    if (!Array.isArray(steps) || steps.length === 0) {
      steps = this._migrateFromSlots(row, slots)
    }

    // 意图例句：语义向量/LLM 理解只服务"显式声明例句"的任务；
    // 未写例句的任务仅靠触发词+近义规则（确定性，避免短词向量噪声误触发）
    const intentExamples = _parseJson(row.intent_examples, null)
    const vectorSources = (Array.isArray(intentExamples) && intentExamples.length > 0) ? intentExamples : []

    const def = {
      code: row.code,
      name: row.name,
      description: row.description || '',
      trigger_keywords: triggerKeywords,
      // 近义扩展后的触发表达（规则匹配用，不覆盖原始定义）
      _triggerExpanded: this._expandTriggers(triggerKeywords),
      // 意图例句（NLU 向量/LLM 理解用）
      intent_examples: intentExamples,
      _vectorSources: vectorSources,
      // 任务/FAQ 冲突追问配置（运营在管理后台任务编辑器配置，留空回退全局模板）
      clarify_question: row.clarify_question || '',
      clarify_options: _parseJson(row.clarify_options, null),
      // 任务级仲裁阈值（null=用全局 sys_config 的 arb_gap/arb_task_min/arb_faq_min/arb_strong_hit）
      arb_gap: row.arb_gap === null || row.arb_gap === undefined ? null : parseFloat(row.arb_gap),
      arb_task_min: row.arb_task_min === null || row.arb_task_min === undefined ? null : parseFloat(row.arb_task_min),
      arb_faq_min: row.arb_faq_min === null || row.arb_faq_min === undefined ? null : parseFloat(row.arb_faq_min),
      arb_strong_hit: row.arb_strong_hit === null || row.arb_strong_hit === undefined ? null : parseFloat(row.arb_strong_hit),
      // 任务级 LLM 配置（覆盖全局节点；undefined = 全用全局）
      //   { enabled: bool(本任务总开关), dialogue: {enabled, model, temperature, maxTokens},
      //     extract: {...}, prompts: {dialogueSystem, dialogueUser, extractSystem, extractUser} }
      llm: _parseJson(row.llm, null),
      // 调用接口配置（完成动作 call_api 用）：{ url, method, fieldMap, successMessage }
      api_action: _parseJson(row.api_action, null),
      // api 步骤的结果槽位（系统填充，不向用户收集，也不阻塞确认）
      apiResultSlots: [...new Set((steps || []).filter(s => s.type === 'api' && s.resultSlot).map(s => s.resultSlot))],
      slots,
      steps,
      completion_message: row.completion_message || '',
      on_complete: row.on_complete || '',
      status: row.status ?? 1,
    }
    return def
  }

  /** 触发词近义扩展：命中同义词表则并入相关表达（确定性模糊匹配）
   *  注意：单字近义词（修/装/约等）过于宽泛会导致误触发
   *  （如"修改电话"含"修"字误触报修），因此只保留 2 字及以上表达 */
  _expandTriggers(keywords) {
    const expanded = new Set()
    for (const kw of (keywords || [])) {
      if (typeof kw !== 'string') {
        expanded.add(kw) // regex 对象原样保留
        continue
      }
      expanded.add(kw)
      for (const [key, syns] of Object.entries(getTriggerSynonyms())) {
        // 单字 key 不参与包含匹配，避免"修改"含"修"误触
        if (key.length < 2) continue
        if (kw.includes(key) || key.includes(kw)) {
          for (const s of syns) {
            if (s.length >= 2) expanded.add(s)
          }
        }
      }
    }
    return [...expanded]
  }

  /** v1 slots → v2 steps 自动迁移 */
  _migrateFromSlots(row, slots) {
    const steps = []
    slots.forEach((s, i) => {
      const next = i < slots.length - 1 ? `collect_${slots[i + 1].key}` : 'confirm_step'
      steps.push({
        key: `collect_${s.key}`,
        type: 'collect',
        slot_key: s.key,
        label: s.label || s.key,
        required: s.required !== false,
        prompt: s.prompt || `请提供${s.label || s.key}`,
        extract: { method: s.extract_type || 'text', rule: s.extract_rule || '' },
        next,
      })
    })
    if (steps.length > 0) {
      steps.push({ key: 'confirm_step', type: 'confirm', next: 'complete_step' })
    }
    steps.push({
      key: 'complete_step',
      type: 'action',
      action: row.on_complete || 'complete_message',
      done_message: row.completion_message || `已为您完成${row.name}。`,
    })
    return steps
  }

  /** DSL 结构校验（保存前调用），返回 { ok, errors[] } */
  validateDef(def) {
    const errors = []
    if (!def.code || !/^[a-zA-Z0-9_-]+$/.test(def.code)) errors.push('编码必须为英文/数字/下划线')
    if (!def.name) errors.push('名称不能为空')

    const steps = def.steps || []
    if (!Array.isArray(steps) || steps.length === 0) errors.push('至少需要一个步骤')

    if (def.intent_examples !== undefined && !Array.isArray(def.intent_examples)) {
      errors.push('intent_examples 必须是数组')
    }

    // 澄清配置（可选）：clarify_question 为字符串，clarify_options 为字符串数组
    if (def.clarify_question !== undefined && def.clarify_question !== null && typeof def.clarify_question !== 'string') {
      errors.push('clarify_question 必须是字符串')
    }
    if (def.clarify_options !== undefined && def.clarify_options !== null) {
      if (!Array.isArray(def.clarify_options)) errors.push('clarify_options 必须是数组')
      else if (def.clarify_options.some(o => typeof o !== 'string')) errors.push('clarify_options 元素必须是字符串')
    }

    // 任务级仲裁阈值（可选，0~1 之间；留空=用全局）
    for (const key of ['arb_gap', 'arb_task_min', 'arb_faq_min', 'arb_strong_hit']) {
      const v = def[key]
      if (v === undefined || v === null || v === '') continue
      const n = parseFloat(v)
      if (isNaN(n) || n < 0 || n > 1) errors.push(`${key} 必须是 0~1 之间的数字`)
    }

    const keys = new Set()
    const collectKeys = new Set()
    steps.forEach((step, i) => {
      if (!step.key) { errors.push(`步骤${i + 1}缺少 key`); return }
      if (keys.has(step.key)) errors.push(`步骤 key 重复: ${step.key}`)
      keys.add(step.key)
      if (step.type === 'collect') {
        if (!step.slot_key) errors.push(`步骤 ${step.key}: 缺少 slot_key`)
        collectKeys.add(step.slot_key)
        if (step.extract?.method && !['text', 'regex', 'number', 'enum'].includes(step.extract.method)) {
          errors.push(`步骤 ${step.key}: 不支持的提取方式 ${step.extract.method}`)
        }
      }
      if (step.type === 'action' && !step.action) errors.push(`步骤 ${step.key}: 缺少 action`)
      if (step.type === 'subtask' && !step.task) errors.push(`步骤 ${step.key}: 缺少子任务 code`)
      // next 指向必须存在（允许空 = 流程结束）
      if (step.next && !steps.some(s => s.key === step.next)) {
        errors.push(`步骤 ${step.key}: next 指向不存在的步骤 ${step.next}`)
      }
    })
    // collect 步骤的 slot_key 应在 slots 定义中（或自动补齐）
    for (const key of collectKeys) {
      if (!def.slots.some(s => s.key === key)) {
        const step = steps.find(s => s.slot_key === key)
        def.slots.push({ key, label: step?.label || key, required: step?.required !== false })
      }
    }
    return { ok: errors.length === 0, errors }
  }

  get(code) {
    return this.defs.get(code) || null
  }

  /** 全部定义（规范化后，含 steps） */
  list() {
    return [...this.defs.values()]
  }

  size() {
    return this.defs.size
  }

  /** 保存（创建/更新）并刷新缓存 */
  async save(def) {
    const { code, name, description, trigger_keywords, slots, steps, intent_examples, clarify_question, clarify_options, arb_gap, arb_task_min, arb_faq_min, arb_strong_hit, llm, api_action, completion_message, on_complete, status } = def
    // 任务级仲裁阈值：null/undefined/'' → 存 NULL（表示用全局）
    const arbNum = (v) => {
      if (v === null || v === undefined || v === '') return null
      const n = parseFloat(v)
      return isNaN(n) ? null : n
    }
    await pool.execute(
      `INSERT INTO task (code, name, description, trigger_keywords, slots, steps, intent_examples, clarify_question, clarify_options, arb_gap, arb_task_min, arb_faq_min, arb_strong_hit, llm, api_action, completion_message, on_complete, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name=?, description=?, trigger_keywords=?, slots=?, steps=?, intent_examples=?, clarify_question=?, clarify_options=?, arb_gap=?, arb_task_min=?, arb_faq_min=?, arb_strong_hit=?, llm=?, api_action=?, completion_message=?, on_complete=?, status=?`,
      [
        code, name, description || null,
        JSON.stringify(trigger_keywords || []),
        JSON.stringify(slots || []),
        JSON.stringify(steps || null),
        JSON.stringify(intent_examples || null),
        clarify_question || '',
        JSON.stringify(Array.isArray(clarify_options) ? clarify_options : null),
        arbNum(arb_gap), arbNum(arb_task_min), arbNum(arb_faq_min), arbNum(arb_strong_hit),
        JSON.stringify(llm || null),
        JSON.stringify(api_action || null),
        completion_message || null, on_complete || '', status ?? 1,
        name, description || null,
        JSON.stringify(trigger_keywords || []),
        JSON.stringify(slots || []),
        JSON.stringify(steps || null),
        JSON.stringify(intent_examples || null),
        clarify_question || '',
        JSON.stringify(Array.isArray(clarify_options) ? clarify_options : null),
        arbNum(arb_gap), arbNum(arb_task_min), arbNum(arb_faq_min), arbNum(arb_strong_hit),
        JSON.stringify(llm || null),
        JSON.stringify(api_action || null),
        completion_message || null, on_complete || '', status ?? 1,
      ]
    )
    await this.loadTasks()
    return true
  }

  /** 删除 */
  async remove(code) {
    await pool.execute('DELETE FROM task WHERE code = ?', [code])
    this.defs.delete(code)
    return true
  }

  /** 启用/禁用 */
  async toggleStatus(code, status) {
    await pool.execute('UPDATE task SET status = ? WHERE code = ?', [status ? 1 : 0, code])
    await this.loadTasks()
    return true
  }
}

function _parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return fallback }
  }
  return raw
}

export default new TaskDefs()
