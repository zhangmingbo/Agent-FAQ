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

class TaskDefs {
  constructor() {
    /** @type {Map<string, Object>} code -> taskDef（含规范化后的 steps） */
    this.defs = new Map()
  }

  /** 确保表结构存在（含 v2 的 steps 列） */
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
        completion_message TEXT,
        on_complete VARCHAR(100) DEFAULT '' COMMENT '完成后动作',
        status TINYINT DEFAULT 1 COMMENT '1=启用 0=禁用',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )
    // 老表补充 steps 列（已存在则忽略错误）
    try {
      await pool.execute('ALTER TABLE task ADD COLUMN steps JSON NULL COMMENT \'流程 DSL（v2）\' AFTER slots')
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

  /** 规范化任务定义：解析 JSON 字段、迁移 v1 slots → v2 steps */
  _normalize(row) {
    const triggerKeywords = _parseJson(row.trigger_keywords, [])
    const slots = _parseJson(row.slots, [])
    let steps = _parseJson(row.steps, null)

    if (!Array.isArray(steps) || steps.length === 0) {
      steps = this._migrateFromSlots(row, slots)
    }

    const def = {
      code: row.code,
      name: row.name,
      description: row.description || '',
      trigger_keywords: triggerKeywords,
      slots,
      steps,
      completion_message: row.completion_message || '',
      on_complete: row.on_complete || '',
      status: row.status ?? 1,
    }
    return def
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
    const { code, name, description, trigger_keywords, slots, steps, completion_message, on_complete, status } = def
    await pool.execute(
      `INSERT INTO task (code, name, description, trigger_keywords, slots, steps, completion_message, on_complete, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name=?, description=?, trigger_keywords=?, slots=?, steps=?, completion_message=?, on_complete=?, status=?`,
      [
        code, name, description || null,
        JSON.stringify(trigger_keywords || []),
        JSON.stringify(slots || []),
        JSON.stringify(steps || null),
        completion_message || null, on_complete || '', status ?? 1,
        name, description || null,
        JSON.stringify(trigger_keywords || []),
        JSON.stringify(slots || []),
        JSON.stringify(steps || null),
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
