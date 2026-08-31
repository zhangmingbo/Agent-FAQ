/**
 * LLM 智能层客户端（共享模块，全系统唯一 LLM 出口）
 *
 * 设计：
 *   - 连接配置（总开关 + apiUrl/apiKey/model）与「调用节点」配置分离
 *   - 每个用途（meaningless/rerank）是一个可配置节点：
 *     { enabled, model, temperature, maxTokens }，管理后台可视化编辑，sys_config.llm_nodes 存储
 *   - 各业务方法先查 nodeEnabled(用途) 再调用；未启用或失败返回 null/空，上层自行降级
 *
 * 注意：任务流程（触发/提取/对话/路由）已改为纯规则引擎，不再使用 LLM
 *
 * 提示词来源：运营配置注册表 llmPrompts（管理后台「LLM 智能层」可编辑，默认值兜底）
 * 兼容任意 OpenAI 格式服务：DeepSeek / 通义千问 / 智谱 GLM / Ollama 等
 */

import { get as getPrompt, getPromptSource } from './llmPrompts.js'
import llmCallLogger from './llmCallLogger.js'

/** 调用节点默认配置（管理后台可改，sys_config.llm_nodes 覆盖）
 *  任务流程已改为纯规则引擎，仅保留 FAQ 侧辅助节点
 *  注意：模型不在这里配——全系统统一在「连接配置」的全局模型（llm_model）里控制 */
export const DEFAULT_LLM_NODES = {
  meaningless: { enabled: true, temperature: 0.1, maxTokens: 10 },   // 无意义检测（FAQ 侧）
  rerank:      { enabled: true, temperature: 0, maxTokens: 5 },      // FAQ 意图重排
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
  nodeEnabled(name) {
    if (!this.enabled) return false
    const n = this.nodes[name]
    if (n) return n.enabled !== false
    return DEFAULT_LLM_NODES[name]?.enabled !== false
  }

  /** 全局模板来源标注（meaningless/rerank 用） */
  _globalPromptSource(keys) {
    const src = (k) => getPromptSource(k) === 'custom' ? 'global' : 'default'
    return {
      system: keys[0] ? src(keys[0]) : 'default',
      user: keys[1] ? src(keys[1]) : 'default',
    }
  }

  /**
   * 底层统一 chat 调用
   * @param {Array<{role:string, content:string}>} messages
   * @param {Object} opts - { model?, maxTokens, temperature, node?, sessionId? }
   *   node: 调用节点名（meaningless/rerank），埋点日志用
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
          promptSource: opts.promptSource || null,
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
          promptSource: opts.promptSource || null,
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
    // 提示词来源（调试：默认 / 全局自定义 / 任务自定义）
    const ps = opts.promptSource || {}
    const srcDesc = ps.system || ps.user
      ? ` | 提示词: sys=${ps.system || '?'} user=${ps.user || '?'}`
      : ''
    console.log(`\n[LLM-CALL] 节点: ${node} | 会话: ${sid} | 模型: ${model} | 状态: ${status} | 耗时: ${durationMs}ms${srcDesc}`)
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

  // ==================== 业务方法（FAQ 侧） ====================

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
      ], { model: n.model, maxTokens: n.maxTokens, temperature: n.temperature, node: 'meaningless', promptSource: this._globalPromptSource(['meaningless.system']) })
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
      ], { model: n.model, maxTokens: n.maxTokens, temperature: n.temperature, node: 'rerank', promptSource: this._globalPromptSource(['llm_rerank.system', 'llm_rerank.user']) })
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
