/**
 * LLM 智能层客户端（共享模块，全系统唯一 LLM 出口）
 *
 * 设计：
 *   - 连接配置（总开关 + apiUrl/apiKey/model）与「调用节点」配置分离
 *   - 每个用途（trigger/extract/dialogue/route/meaningless/rerank）是一个可配置节点：
 *     { enabled, model, temperature, maxTokens }，管理后台可视化编辑，sys_config.llm_nodes 存储
 *   - 各业务方法先查 nodeEnabled(用途) 再调用；未启用或失败返回 null/空，上层自行降级
 *
 * 提示词来源：运营配置注册表 llmPrompts（管理后台「LLM 智能层」可编辑，默认值兜底）
 * 兼容任意 OpenAI 格式服务：DeepSeek / 通义千问 / 智谱 GLM / Ollama 等
 */

import { get as getPrompt } from './llmPrompts.js'
import llmCallLogger from './llmCallLogger.js'

/** 调用节点默认配置（管理后台可改，sys_config.llm_nodes 覆盖，默认全开=现行为）
 *  注意：模型不在这里配——全系统统一在「连接配置」的全局模型（llm_model）里控制 */
export const DEFAULT_LLM_NODES = {
  trigger:     { enabled: true, temperature: 0,   maxTokens: 20 },   // 任务触发判定
  extract:     { enabled: true, temperature: 0,   maxTokens: 200 },  // 槽位提取
  dialogue:    { enabled: true, temperature: 0.2, maxTokens: 400 },  // 任务对话
  route:       { enabled: true, temperature: 0,   maxTokens: 10 },   // 意图路由兜底
  meaningless: { enabled: true, temperature: 0.1, maxTokens: 10 },   // 无意义检测
  rerank:      { enabled: true, temperature: 0,   maxTokens: 5 },    // FAQ 意图重排
}

class LLMClient {
  constructor() {
    /** @type {{enabled:boolean, apiUrl:string, apiKey:string, model:string, systemPrompt:string}|null} */
    this.config = null
    /** @type {Object<string, {enabled:boolean, model:string, temperature:number, maxTokens:number}>} */
    this.nodes = {}
    this.timeoutMs = 15000
  }

  /** 连接配置（启动时从 sys_config 加载，或后台保存后调用） */
  configure(cfg = {}) {
    this.config = {
      enabled: !!cfg.enabled && !!(cfg.apiUrl && cfg.apiKey),
      apiUrl: cfg.apiUrl || '',
      apiKey: cfg.apiKey || '',
      model: cfg.model || 'deepseek-chat',
      systemPrompt: cfg.systemPrompt || '',
    }
    if (this.config.enabled) {
      console.log(`[LLM] 已启用: ${this.config.model} @ ${this.config.apiUrl}`)
    }
  }

  get enabled() {
    return !!(this.config?.enabled)
  }

  /**
   * 从数据库配置解析 LLM 连接配置，环境变量兜底：
   *   DEEPSEEK_API_KEY（或 LLM_API_KEY）存在时自动启用
   *   LLM_API_URL / LLM_MODEL 可覆盖默认值
   * @param {Object} dbConfig - configRepo.getAll() 结果
   */
  resolveFromDb(dbConfig = {}) {
    const envKey = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || ''
    const apiUrl = dbConfig.llm_api_url || process.env.LLM_API_URL || 'https://api.deepseek.com/chat/completions'
    const model = dbConfig.llm_model || process.env.LLM_MODEL || 'deepseek-chat'
    const enabled = dbConfig.llm_enabled === 'true' || !!envKey
    return {
      enabled,
      apiUrl,
      apiKey: dbConfig.llm_api_key || envKey,
      model,
    }
  }

  /** 设置调用节点配置（启动加载 / 后台保存，缺省合并默认值） */
  setNodes(nodes = {}) {
    for (const name of Object.keys(DEFAULT_LLM_NODES)) {
      const n = nodes?.[name]
      const d = DEFAULT_LLM_NODES[name]
      this.nodes[name] = {
        enabled: n && n.enabled !== undefined ? !!n.enabled : d.enabled,
        temperature: n && typeof n.temperature === 'number' ? n.temperature : d.temperature,
        maxTokens: n && typeof n.maxTokens === 'number' ? n.maxTokens : d.maxTokens,
      }
    }
  }

  /** 获取全部节点配置（管理后台编辑用） */
  getNodes() {
    return { ...this.nodes }
  }

  /** 某用途是否可调用 LLM（总开关 && 节点开关；节点未设置时按默认 true） */
  nodeEnabled(name, taskLlm = null) {
    if (!this.enabled) return false
    // 任务级总开关：本任务完全不用 LLM
    if (taskLlm && taskLlm.enabled === false) return false
    const t = taskLlm?.[name]
    if (t && t.enabled !== undefined) return !!t.enabled
    const n = this.nodes[name]
    if (n) return n.enabled !== false
    return DEFAULT_LLM_NODES[name]?.enabled !== false
  }

  /**
   * 解析某用途的"生效节点配置"（任务级 > 全局节点 > 默认值）
   * 注意：模型不在此解析——全系统统一用「连接配置」的全局模型
   * @param {string} name - 用途名
   * @param {Object|null} taskLlm - 任务定义里的 llm 配置块
   * @returns {{enabled:boolean, model:string, temperature:number, maxTokens:number}}
   */
  resolveEffective(name, taskLlm = null) {
    if (taskLlm && taskLlm.enabled === false) {
      return { enabled: false, model: this.config?.model || 'deepseek-chat', temperature: 0, maxTokens: 0 }
    }
    const t = taskLlm?.[name] || {}
    const g = this.nodes[name] || DEFAULT_LLM_NODES[name] || {}
    return {
      enabled: t.enabled !== undefined ? !!t.enabled : g.enabled !== false,
      model: this.config?.model || 'deepseek-chat',
      temperature: typeof t.temperature === 'number' ? t.temperature : (g.temperature ?? 0),
      maxTokens: typeof t.maxTokens === 'number' ? t.maxTokens : (g.maxTokens ?? 100),
    }
  }

  /** 填充占位符 {xxx}（任务级提示词覆盖用） */
  _fill(template, vars = {}) {
    let t = String(template || '')
    for (const [k, v] of Object.entries(vars)) {
      t = t.split(`{${k}}`).join(v ?? '')
    }
    return t
  }

  /**
   * 底层统一 chat 调用
   * @param {Array<{role:string, content:string}>} messages
   * @param {Object} opts - { model?, maxTokens, temperature, node?, sessionId? }
   *   node: 调用节点名（trigger/extract/dialogue/route/meaningless/rerank），埋点日志用
   *   sessionId: 关联的会话（会话调试按会话查看 LLM 调用）
   * @returns {Promise<string>}
   */
  async chat(messages, opts = {}) {
    if (!this.enabled) throw new Error('LLM 未配置')
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model || this.config.model,
          messages,
          max_tokens: opts.maxTokens || 300,
          temperature: opts.temperature ?? 0.1,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const data = await res.json()
      const content = data.choices?.[0]?.message?.content
      if (!content) throw new Error('LLM 返回为空')
      // 埋点：控制台打印每次调用的入参与返回（排查 LLM 行为），并记录到内存日志
      const durationMs = Date.now() - startedAt
      try {
        this._printLlmCall(opts, messages, content, durationMs, null)
        llmCallLogger.log({
          sessionId: opts.sessionId,
          node: opts.node,
          model: opts.model || this.config.model,
          messages,
          response: content,
          status: 'ok',
          durationMs,
        })
      } catch (e) { /* 埋点失败不影响主流程 */ }
      return content.trim()
    } catch (e) {
      // 埋点：控制台打印失败调用 + 记录到内存日志
      const durationMs = Date.now() - startedAt
      try {
        this._printLlmCall(opts, messages, '', durationMs, e.message)
        llmCallLogger.log({
          sessionId: opts.sessionId,
          node: opts.node,
          model: opts.model || this.config.model,
          messages,
          status: 'error',
          error: e.message,
          durationMs,
        })
      } catch (e2) { /* ignore */ }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 打印每次 LLM 调用的入参与返回（服务端控制台，排查用）
   * 输出格式：
   *   [LLM-CALL] 节点: dialogue | 会话: xxx | 模型: deepseek-chat | 耗时: 800ms
   *   [LLM-IN ] system: ... / user: ...
   *   [LLM-OUT] ...
   */
  _printLlmCall(opts, messages, response, durationMs, error) {
    const node = opts.node || 'unknown'
    // 会话：优先显式传入，其次用当前会话上下文（faq-engine 每轮设置）
    const sid = opts.sessionId || llmCallLogger.getCurrentSession?.() || '-'
    const model = opts.model || (this.config && this.config.model) || 'deepseek-chat'
    const status = error ? '失败' : '成功'
    console.log(`\n[LLM-CALL] 节点: ${node} | 会话: ${sid} | 模型: ${model} | 状态: ${status} | 耗时: ${durationMs}ms`)
    for (const m of messages || []) {
      const role = m.role === 'system' ? 'IN(system)' : 'IN(user)'
      const content = String(m.content || '').replace(/\n/g, '⏎').slice(0, 600)
      console.log(`[LLM-${role}] ${content}`)
    }
    if (error) {
      console.log(`[LLM-ERROR] ${error}`)
    } else {
      console.log(`[LLM-OUT] ${String(response || '').replace(/\n/g, '⏎').slice(0, 600)}`)
    }
  }

  // ==================== 业务方法（每个节点一个） ====================

  /**
   * LLM 驱动对话：单轮决策（agentic dialogue）——节点 dialogue
   * @param {string} system - 系统提示词（已填充；任务级覆盖时由调用方传入覆盖模板）
   * @param {string} user - 用户消息（已填充）
   * @param {Object} [cfg] - 生效节点配置（任务级解析结果；缺省用全局节点）
   * @returns {Promise<Object>} { slots, reply, ask_confirm, question }
   */
  async dialogueTurn(system, user, cfg = null) {
    const eff = cfg || this.resolveEffective('dialogue')
    if (!eff.enabled) {
      return { slots: {}, reply: '', ask_confirm: false, question: null }
    }
    const raw = await this.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { model: eff.model, maxTokens: eff.maxTokens, temperature: eff.temperature, node: 'dialogue' })

    const obj = this._parseJson(raw)
    if (!obj || typeof obj !== 'object') return { slots: {}, reply: '', ask_confirm: false, question: null }
    return {
      slots: obj.slots && typeof obj.slots === 'object' ? obj.slots : {},
      reply: typeof obj.reply === 'string' ? obj.reply.trim() : '',
      ask_confirm: !!obj.ask_confirm,
      question: typeof obj.question === 'string' && obj.question.trim() ? obj.question.trim() : null,
    }
  }

  /**
   * 从用户输入一次性抽取所有未填槽位——节点 extract
   * @returns {Promise<Object>} { key: value }（未启用/失败返回 {}）
   */
  async extractSlots(text, task, slotsSpec, state) {
    const eff = this.resolveEffective('extract', task?.llm || null)
    if (!eff.enabled) return {}
    const slotDesc = Object.entries(slotsSpec)
      .map(([k, s]) => `${k}: ${s.label}${s.type === 'regex' && s.rule ? `（格式：${s.rule}）` : ''}${s.type === 'enum' && s.rule ? `（可选：${s.rule}）` : ''}`)
      .join('；')

    const filledDesc = Object.entries(state?.slots || {})
      .filter(([_, s]) => s.filled)
      .map(([k, s]) => `${k}: ${s.value}`)
      .join('；')

    // 意图例句帮助 LLM 理解业务语境（如"报修"场景下的地址/故障/电话）
    const examples = Array.isArray(task.intent_examples) && task.intent_examples.length > 0
      ? `\n业务场景例句（用户可能这么说）：${task.intent_examples.slice(0, 8).join('；')}`
      : ''

    // 提示词：任务级覆盖优先，其次运营配置注册表（管理后台可编辑），默认值兜底
    const sysTpl = task?.llm?.prompts?.extractSystem
    const system = sysTpl ? this._fill(sysTpl, {}) : getPrompt('extract_slots.system')
    const userTpl = task?.llm?.prompts?.extractUser
    const user = userTpl
      ? this._fill(userTpl, { taskName: task.name, examples, slotDesc, filledDesc: filledDesc ? `已提取字段：${filledDesc}\n` : '', text })
      : getPrompt('extract_slots.user', {
          taskName: task.name,
          examples,
          slotDesc,
          filledDesc: filledDesc ? `已提取字段：${filledDesc}\n` : '',
          text,
        })

    const raw = await this.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { model: eff.model, maxTokens: eff.maxTokens, temperature: eff.temperature, node: 'extract' })

    return this._parseJson(raw)
  }

  /**
   * 提取单个槽位值（LLM 兜底用）——节点 extract
   * @returns {Promise<string|null>}
   */
  async extractSlot(text, slotDef, ctx = {}) {
    if (!this.nodeEnabled('extract', ctx?.task?.llm || null) || !slotDef?.key) return null
    const task = ctx.task || { name: '当前任务' }
    const result = await this.extractSlots(text, task, {
      [slotDef.key]: {
        label: slotDef.label || slotDef.key,
        type: slotDef.extract?.method || 'text',
        rule: slotDef.extract?.rule || '',
        required: slotDef.required !== false,
      },
    }, ctx.state)
    const v = result[slotDef.key]
    return v ? String(v) : null
  }

  /**
   * 判断用户输入是否意图触发某个任务（口语化触发判定）——节点 trigger
   * @returns {Promise<string|null>} 触发的任务 code，未触发返回 null
   */
  async judgeTrigger(text, tasks) {
    if (!this.nodeEnabled('trigger') || !tasks || tasks.length === 0) return null
    const n = this.nodes.trigger
    const taskDesc = tasks.map(t =>
      `${t.code}（${t.name}）：触发表达如 ${(t.trigger_keywords || []).filter(k => typeof k === 'string').slice(0, 5).join('、')}`
    ).join('\n')

    const system = getPrompt('judge_trigger.system')
    const user = getPrompt('judge_trigger.user', { taskDesc, text })

    const raw = await this.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { model: n.model, maxTokens: n.maxTokens, temperature: n.temperature, node: 'trigger' })

    const trimmed = raw.replace(/["'`\s]/g, '')
    if (!trimmed || trimmed === 'null' || trimmed === '无' || trimmed === '没有') return null
    const hit = tasks.find(t => t.code === trimmed || trimmed.startsWith(t.code))
    return hit ? hit.code : null
  }

  /**
   * 意图路由判定：用户输入该走哪条通道（规则拿不准时由 LLM 兜底）——节点 route
   * @returns {Promise<string>} 'continue' | 'new_task' | 'faq' | null
   */
  async routeTurn({ taskName, taskContext, text }) {
    if (!this.nodeEnabled('route')) return null
    const n = this.nodes.route
    const system = getPrompt('router.system', { taskName, taskContext })
    const user = getPrompt('router.user', { taskName, taskContext, text })

    const raw = await this.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { model: n.model, maxTokens: n.maxTokens, temperature: n.temperature, node: 'route' })

    const trimmed = raw.trim().toLowerCase()
    if (trimmed.startsWith('continue')) return 'continue'
    if (trimmed.startsWith('new_task')) return 'new_task'
    if (trimmed.startsWith('faq')) return 'faq'
    return null
  }

  /**
   * 无意义检测（FAQ 侧）——节点 meaningless
   * @returns {Promise<boolean|null>} true=无意义 false=有意义 null=未启用/失败（调用方降级）
   */
  async isMeaningless(text) {
    if (!this.nodeEnabled('meaningless')) return null
    const n = this.nodes.meaningless
    try {
      const raw = await this.chat([
        { role: 'system', content: getPrompt('meaningless.system') },
        { role: 'user', content: text },
      ], { model: n.model, maxTokens: n.maxTokens, temperature: n.temperature, node: 'meaningless' })
      // 大模型返回 false 表示无意义
      return raw.trim().toLowerCase() === 'false'
    } catch (e) {
      console.error('[LLM] 无意义判断失败:', e.message)
      return null
    }
  }

  /**
   * FAQ 意图重排（FAQ 侧）——节点 rerank
   * @param {string} text - 用户输入
   * @param {Array<{intentCode?, intent_code?, intentName?, questionText?}>} candidates - 候选意图
   * @returns {Promise<string|null>} 重排后更优的意图 code，失败/未启用返回 null
   */
  async rerankIntent(text, candidates) {
    if (!this.nodeEnabled('rerank') || !candidates || candidates.length === 0) return null
    const n = this.nodes.rerank
    try {
      const list = candidates.map((c, i) => `${i + 1}. ${c.intentName || c.intentCode}（${(c.questionText || '').slice(0, 30)}）`).join('\n')
      const raw = await this.chat([
        { role: 'system', content: getPrompt('llm_rerank.system') },
        { role: 'user', content: getPrompt('llm_rerank.user', { list, text }) },
      ], { model: n.model, maxTokens: n.maxTokens, temperature: n.temperature, node: 'rerank' })
      const idx = parseInt(raw.trim(), 10) - 1
      const hit = candidates[idx]
      return hit ? (hit.intentCode || hit.intent_code) : null
    } catch (e) {
      console.error('[LLM] 意图重排失败:', e.message)
      return null
    }
  }

  /** 解析 LLM 返回的 JSON（容忍 ```json 包裹与前后噪声） */
  _parseJson(raw) {
    let s = raw.trim()
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) s = fence[1].trim()
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start >= 0 && end > start) s = s.slice(start, end + 1)
    try {
      const obj = JSON.parse(s)
      return obj && typeof obj === 'object' ? obj : {}
    } catch {
      console.warn('[LLM] JSON 解析失败:', raw.slice(0, 120))
      return {}
    }
  }
}

export default new LLMClient()
