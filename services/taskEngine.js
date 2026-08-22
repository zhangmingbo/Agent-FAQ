/**
 * 任务型对话引擎
 * 
 * 管理多轮对话任务的定义、状态跟踪和槽位填充
 */

import pool from '../db/pool.js'

class TaskEngine {
  constructor() {
    // 任务定义缓存（code → task）
    this.taskDefs = new Map()
    // 活跃任务会话（sessionId → { taskCode, slots: {key: {filled, value}}, status, history }）
    this.activeTasks = new Map()
  }

  /**
   * 初始化：从数据库加载任务定义
   */
  async initialize() {
    try {
      await this._ensureTable()
      await this.loadTasks()
      console.log(`[TaskEngine] 已加载 ${this.taskDefs.size} 个任务定义`)
    } catch (e) {
      console.error('[TaskEngine] 初始化失败:', e.message)
    }
  }

  /**
   * 确保数据库表存在
   */
  async _ensureTable() {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS task (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        trigger_keywords JSON COMMENT '触发关键词列表',
        slots JSON COMMENT '槽位定义列表',
        completion_message TEXT COMMENT '完成时的回复模板',
        on_complete VARCHAR(100) DEFAULT '' COMMENT '完成后动作',
        status TINYINT DEFAULT 1 COMMENT '1=启用 0=禁用',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
  }

  /**
   * 从数据库加载所有任务定义
   */
  async loadTasks() {
    const [rows] = await pool.execute('SELECT * FROM task ORDER BY id ASC')
    this.taskDefs.clear()
    for (const row of rows) {
      const task = {
        ...row,
        trigger_keywords: typeof row.trigger_keywords === 'string' 
          ? JSON.parse(row.trigger_keywords) : (row.trigger_keywords || []),
        slots: typeof row.slots === 'string' 
          ? JSON.parse(row.slots) : (row.slots || []),
      }
      this.taskDefs.set(task.code, task)
    }
  }

  /**
   * 检查用户输入是否匹配某个任务的触发条件
   * @param {string} text - 用户输入
   * @returns {Object|null} 匹配到的任务定义，或 null
   */
  matchTask(text) {
    if (!text) return null
    const lowerText = text.trim().toLowerCase()
    
    for (const [code, task] of this.taskDefs) {
      if (task.status !== 1) continue
      const keywords = task.trigger_keywords || []
      for (const kw of keywords) {
        if (typeof kw === 'string') {
          if (lowerText.includes(kw.toLowerCase())) {
            return task
          }
        } else if (kw.regex) {
          try {
            const regex = new RegExp(kw.regex, 'i')
            if (regex.test(lowerText)) return task
          } catch (e) { /* ignore */ }
        }
      }
    }
    return null
  }

  /**
   * 开始一个新任务
   * @param {string} sessionId 
   * @param {Object} task - 任务定义
   * @returns {Object} 任务状态
   */
  startTask(sessionId, task) {
    // 初始化槽位状态
    const slots = {}
    for (const slot of (task.slots || [])) {
      slots[slot.key] = {
        filled: false,
        value: null,
        label: slot.label,
        required: slot.required !== false,
        prompt: slot.prompt || `请提供${slot.label}`,
        extractType: slot.extract_type || 'text', // text, regex, number, enum
        extractRule: slot.extract_rule || null,    // 提取规则（正则、枚举值等）
      }
    }

    const state = {
      taskCode: task.code,
      taskName: task.name,
      slots,
      status: 'in_progress', // in_progress, completed, cancelled
      startedAt: Date.now(),
      lastActive: Date.now(),
      turnCount: 0, // 对话轮次（用于判断首轮）
    }
    this.activeTasks.set(sessionId, state)
    return state
  }

  /**
   * 处理任务对话（从用户输入中提取槽位信息）
   * @param {string} sessionId 
   * @param {string} text - 用户输入
   * @returns {Object} { reply, isComplete, extracted, taskState, cancelled }
   */
  processInput(sessionId, text) {
    const state = this.activeTasks.get(sessionId)
    if (!state || state.status !== 'in_progress') {
      return null
    }
  
    state.lastActive = Date.now()
    state.turnCount = (state.turnCount || 0) + 1
  
    // 检查是否要取消
    if (this._isCancel(text)) {
      state.status = 'cancelled'
      this.activeTasks.delete(sessionId)
      return {
        reply: '好的，已为您取消操作。',
        isComplete: false,
        extracted: true,
        cancelled: true,
        taskState: state,
      }
    }
  
    // 检查是否要修改已填槽位（如“地址改成XX”“电话是XXX”）
    const correction = this._detectCorrection(text, state)
    if (correction) {
      const oldVal = state.slots[correction.key].value
      state.slots[correction.key].value = correction.value
      state.slots[correction.key].filled = true
      state.skipCount = 0
      console.log(`[TASK] 槽位纠正: ${correction.key} 从 "${oldVal}" 改为 "${correction.value}"`)
  
      // 检查纠正后是否全部填完
      const allFilled = Object.values(state.slots).every(s => !s.required || s.filled)
      if (allFilled) {
        return this._completeTask(sessionId, state)
      }
      const nextPrompt = this._getNextPrompt(state)
      return {
        reply: `好的，${state.slots[correction.key].label}已更新为「${correction.value}」。\n${nextPrompt}`,
        isComplete: false,
        extracted: true,
        cancelled: false,
        taskState: state,
      }
    }
  
    // 首轮不提取（触发消息通常只是意图表达，不含具体信息）
    // 但如果用户一次性给了多个信息（如“我要报修，地址是XX”），则尝试提取
    const isFirstTurn = state.turnCount <= 1
    const isRichInput = !isFirstTurn || this._isRichInput(text, state.taskCode)
  
    // 尝试从未填充的槽位中提取信息（支持多槽位同时提取）
    const unfilledSlots = Object.entries(state.slots).filter(([_, s]) => !s.filled)
    let extracted = []
  
    if (isRichInput) {
      // 优先用结构化提取（正则、枚举），再用文本提取
      const structuredSlots = unfilledSlots.filter(([_, s]) => s.extractType !== 'text')
      const textSlots = unfilledSlots.filter(([_, s]) => s.extractType === 'text')
  
      // 先提取结构化槽位（更精确）
      for (const [key, slot] of structuredSlots) {
        const value = this._extractValue(text, slot)
        if (value !== null) {
          slot.filled = true
          slot.value = value
          extracted.push(slot.label)
        }
      }
      // 再提取第一个匹配的文本槽位
      if (extracted.length === 0 || textSlots.length === 1) {
        for (const [key, slot] of textSlots) {
          const value = this._extractValue(text, slot)
          if (value !== null) {
            slot.filled = true
            slot.value = value
            extracted.push(slot.label)
            break
          }
        }
      }
    }
  
    const didExtract = extracted.length > 0
    state.skipCount = didExtract ? 0 : (state.skipCount || 0) + 1
  
    // 检查是否所有必填槽位都已填充
    const allFilled = Object.values(state.slots).every(s => !s.required || s.filled)
  
    if (allFilled) {
      return this._completeTask(sessionId, state)
    }
  
    // 构建回复
    let reply = ''
    if (didExtract) {
      reply += `好的，已记录：${extracted.join('、')}。\n`
    }
  
    const nextPrompt = this._getNextPrompt(state)
  
    if (state.skipCount >= 2 && !didExtract) {
      // 连续多次无法提取，给出智能引导
      reply += this._buildSmartGuidance(state)
      state.skipCount = 0 // 重置，给一次机会
    } else {
      reply += nextPrompt
    }
  
    return {
      reply: reply || '请继续提供所需信息。',
      isComplete: false,
      extracted: didExtract,
      cancelled: false,
      taskState: state,
    }
  }

  /**
   * 完成当前任务
   * @private
   */
  _completeTask(sessionId, state) {
    state.status = 'completed'
    const taskDef = this.taskDefs.get(state.taskCode)
    const summary = this._buildSummary(state)
    const completionMsg = taskDef?.completion_message || `已为您完成${state.taskName}。`
    this.activeTasks.delete(sessionId)
    return {
      reply: completionMsg + '\n' + summary,
      isComplete: true,
      extracted: true,
      cancelled: false,
      taskState: state,
    }
  }

  /**
   * 获取下一个需要填充的槽位的提问
   * @private
   */
  _getNextPrompt(state) {
    const nextSlot = Object.entries(state.slots).find(([_, s]) => s.required && !s.filled)
    if (nextSlot) return nextSlot[1].prompt
    const optSlot = Object.entries(state.slots).find(([_, s]) => !s.required && !s.filled)
    if (optSlot) return `您还需要提供${optSlot[1].label}吗？不需要的话回复“提交”即可。`
    return '信息已收集完毕，回复“提交”确认。'
  }

  /**
   * 构建智能引导消息（连续多次无法提取时）
   * @private
   */
  _buildSmartGuidance(state) {
    const filled = Object.entries(state.slots).filter(([_, s]) => s.filled)
    const unfilled = Object.entries(state.slots).filter(([_, s]) => s.required && !s.filled)
    
    let msg = '目前还需要以下信息：\n'
    for (const [key, slot] of unfilled) {
      const status = slot.filled ? `✅ ${slot.value}` : '❓ 待提供'
      msg += `  ${slot.label}：${status}\n`
    }
    if (filled.length > 0) {
      msg += '\n您可以直接回复对应的内容，或说“修改XX”来更改已填信息。'
    } else {
      msg += '\n请逐一提供以上信息。'
    }
    return msg
  }

  /**
   * 检测用户是否在纠正已填槽位
   * 如“地址改成XX”“电话换成XXX”“地址是XX”（重新提供）
   * @private
   */
  _detectCorrection(text, state) {
    const filledSlots = Object.entries(state.slots).filter(([_, s]) => s.filled)
    if (filledSlots.length === 0) return null

    const t = text.trim()
    // 模式1：“修改/改成/换成 + 槽位标签 + 内容”
    const modifyPatterns = ['修改', '改成', '换成', '改为', '变更', '改一下']
    for (const [key, slot] of filledSlots) {
      for (const p of modifyPatterns) {
        if (t.includes(p + slot.label) || t.includes(slot.label + p)) {
          // 提取修改后的值：取标签和关键词后面的内容
          const idx = t.indexOf(p)
          const afterP = t.substring(idx + p.length).trim()
          // 去掉可能的槽位标签前缀
          const value = afterP.replace(new RegExp(`^${slot.label}[是为]?`), '').trim()
          if (value.length >= 2) {
            return { key, value }
          }
        }
      }
    }

    // 模式2：用户重新提供某个槽位的信息（如之前问了地址，用户直接说新地址）
    // 这种情况在 processInput 的提取阶段会处理，这里不重复检测
    return null
  }

  /**
   * 检查会话是否有活跃任务
   */
  hasActiveTask(sessionId) {
    const state = this.activeTasks.get(sessionId)
    return state && state.status === 'in_progress'
  }

  /**
   * 获取活跃任务状态
   */
  getActiveTask(sessionId) {
    return this.activeTasks.get(sessionId)
  }

  /**
   * 检查首轮输入是否包含丰富的信息（不仅仅是触发意图）
   * @private
   */
  _isRichInput(text, taskCode) {
    const task = this.taskDefs.get(taskCode)
    if (!task) return false
    const lowerText = text.trim().toLowerCase()
    // 去除触发词后，剩余内容超过 4 个字符，说明有额外信息
    let stripped = lowerText
    for (const kw of (task.trigger_keywords || [])) {
      const kwStr = typeof kw === 'string' ? kw : (kw.regex || '')
      if (kwStr) stripped = stripped.replace(kwStr.toLowerCase(), '')
    }
    return stripped.trim().length > 4
  }

  /**
   * 从文本中提取槽位值
   * @private
   */
  _extractValue(text, slot) {
    if (!text) return null

    switch (slot.extractType) {
      case 'regex': {
        if (!slot.extractRule) return text.trim()
        try {
          // 处理数据库存储时可能的双重转义
          let pattern = slot.extractRule
          if (pattern.includes('\\\\')) {
            pattern = pattern.replace(/\\\\/g, '\\')
          }
          const regex = new RegExp(pattern, 'i')
          const match = text.match(regex)
          return match ? (match[1] || match[0]) : null
        } catch (e) { return null }
      }
      case 'number': {
        const num = text.match(/\d+\.?\d*/)
        return num ? num[0] : null
      }
      case 'enum': {
        if (!slot.extractRule) return null
        const lowerText = text.trim().toLowerCase()
        const options = typeof slot.extractRule === 'string' 
          ? slot.extractRule.split(',').map(s => s.trim())
          : slot.extractRule
        for (const opt of options) {
          if (lowerText.includes(opt.toLowerCase())) return opt
        }
        return null
      }
      case 'text':
      default: {
        // 文本类型：要求输入至少4个字符，且不能是纯触发词
        const t = text.trim()
        if (t.length < 4) return null
        // 如果输入看起来像在提问，不作为文本槽位值
        if (this._isQuestion(t)) return null
        return t
      }
    }
  }

  /**
   * 检测取消意图
   * @private
   */
  _isCancel(text) {
    const cancelPatterns = ['取消', '算了', '不办了', '不需要了', '退出', '停止', '不弄了', '放弃']
    const t = text.trim()
    return cancelPatterns.some(p => t.includes(p))
  }

  /**
   * 检测用户输入是否在提问（而不是提供信息）
   * @private
   */
  _isQuestion(text) {
    const t = text.trim()
    // 以问号结尾
    if (t.includes('？') || t.includes('?')) return true
    // 包含疑问词
    const questionWords = ['怎么', '如何', '怎样', '什么', '哪里', '哪儿', '多少', '几个', '为什么',
      '能不能', '可以吗', '是否', '有没有', '多久', '几时', '请问', '想知道',
      '怎么办', '好不好', '行不行', '是不是']
    return questionWords.some(w => t.includes(w))
  }

  /**
   * 构建完成摘要
   * @private
   */
  _buildSummary(state) {
    const lines = ['\n📋 信息确认：']
    for (const [key, slot] of Object.entries(state.slots)) {
      if (slot.filled) {
        lines.push(`  ${slot.label}：${slot.value}`)
      }
    }
    return lines.join('\n')
  }

  /**
   * 清理过期的活跃任务（30分钟无活动）
   */
  cleanupStale() {
    const now = Date.now()
    const timeout = 30 * 60 * 1000
    for (const [sessionId, state] of this.activeTasks) {
      if (now - state.lastActive > timeout) {
        this.activeTasks.delete(sessionId)
      }
    }
  }

  // ========== CRUD 操作 ==========

  /**
   * 获取所有任务列表
   */
  async list() {
    const [rows] = await pool.execute('SELECT * FROM task ORDER BY id ASC')
    return rows.map(r => ({
      ...r,
      trigger_keywords: typeof r.trigger_keywords === 'string' ? JSON.parse(r.trigger_keywords) : (r.trigger_keywords || []),
      slots: typeof r.slots === 'string' ? JSON.parse(r.slots) : (r.slots || []),
    }))
  }

  /**
   * 获取单个任务详情
   */
  async get(code) {
    const [rows] = await pool.execute('SELECT * FROM task WHERE code = ?', [code])
    if (!rows.length) return null
    const r = rows[0]
    return {
      ...r,
      trigger_keywords: typeof r.trigger_keywords === 'string' ? JSON.parse(r.trigger_keywords) : (r.trigger_keywords || []),
      slots: typeof r.slots === 'string' ? JSON.parse(r.slots) : (r.slots || []),
    }
  }

  /**
   * 创建或更新任务
   */
  async save(taskData) {
    const { code, name, description, trigger_keywords, slots, completion_message, on_complete, status } = taskData
    
    await pool.execute(
      `INSERT INTO task (code, name, description, trigger_keywords, slots, completion_message, on_complete, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name=?, description=?, trigger_keywords=?, slots=?, completion_message=?, on_complete=?, status=?`,
      [
        code, name, description || null,
        JSON.stringify(trigger_keywords || []),
        JSON.stringify(slots || []),
        completion_message || null, on_complete || '', status ?? 1,
        // ON DUPLICATE 部分
        name, description || null,
        JSON.stringify(trigger_keywords || []),
        JSON.stringify(slots || []),
        completion_message || null, on_complete || '', status ?? 1,
      ]
    )

    // 刷新缓存
    await this.loadTasks()
    return true
  }

  /**
   * 删除任务
   */
  async remove(code) {
    await pool.execute('DELETE FROM task WHERE code = ?', [code])
    this.taskDefs.delete(code)
    return true
  }

  /**
   * 更新任务状态（启用/禁用）
   */
  async toggleStatus(code, status) {
    await pool.execute('UPDATE task SET status = ? WHERE code = ?', [status ? 1 : 0, code])
    await this.loadTasks()
    return true
  }
}

export default new TaskEngine()
