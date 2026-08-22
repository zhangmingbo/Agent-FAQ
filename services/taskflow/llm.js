/**
 * LLM 智能层客户端（OpenAI 兼容接口）
 *
 * 配置来源：sys_config 的 llm_enabled / llm_api_url / llm_api_key / llm_model
 * （与 FAQ 引擎的大模型兜底共用同一套配置，管理后台可改）
 *
 * 能力：
 *   extractSlots()  从自由文本一次性抽取所有槽位（JSON 输出），理解任意口语表达
 *   judgeTrigger()  判断用户输入是否意图触发某个任务（口语化触发）
 *
 * 未配置 / 调用失败时：enabled=false，上层自动降级为规则提取。
 * 兼容任意 OpenAI 格式的服务：DeepSeek API、通义千问、智谱 GLM、Ollama 等。
 */

class LLMClient {
  constructor() {
    /** @type {{enabled:boolean, apiUrl:string, apiKey:string, model:string}|null} */
    this.config = null
    this.timeoutMs = 15000
  }

  /** 配置（启动时从 sys_config 加载，或后台保存后调用） */
  configure(cfg = {}) {
    this.config = {
      enabled: !!cfg.enabled && !!(cfg.apiUrl && cfg.apiKey),
      apiUrl: cfg.apiUrl || '',
      apiKey: cfg.apiKey || '',
      model: cfg.model || 'deepseek-chat',
      systemPrompt: cfg.systemPrompt || '',
    }
    if (this.config.enabled) {
      console.log(`[TaskFlow-LLM] 已启用: ${this.config.model} @ ${this.config.apiUrl}`)
    }
  }

  get enabled() {
    return !!(this.config?.enabled)
  }

  /**
   * 从数据库配置解析 LLM 配置，环境变量兜底：
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

  /**
   * 通用 chat 调用
   * @param {Array<{role:string, content:string}>} messages
   * @param {Object} opts - { maxTokens, temperature }
   * @returns {Promise<string>}
   */
  async chat(messages, opts = {}) {
    if (!this.enabled) throw new Error('LLM 未配置')
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
          model: this.config.model,
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
      return content.trim()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 从用户输入一次性抽取所有未填槽位
   * @param {string} text - 用户输入
   * @param {Object} task - 任务定义
   * @param {Object} slotsSpec - { key: {label, type, rule, required} }
   * @param {Object} state - 任务状态
   * @returns {Promise<Object>} { key: value }
   */
  async extractSlots(text, task, slotsSpec, state) {
    const slotDesc = Object.entries(slotsSpec)
      .map(([k, s]) => `${k}: ${s.label}${s.type === 'regex' && s.rule ? `（格式：${s.rule}）` : ''}`)
      .join('；')

    const filledDesc = Object.entries(state?.slots || {})
      .filter(([_, s]) => s.filled)
      .map(([k, s]) => `${k}: ${s.value}`)
      .join('；')

    // 意图例句帮助 LLM 理解业务语境（如"报修"场景下的地址/故障/电话）
    const examples = Array.isArray(task.intent_examples) && task.intent_examples.length > 0
      ? `\n业务场景例句（用户可能这么说）：${task.intent_examples.slice(0, 8).join('；')}`
      : ''

    const system = '你是客服信息提取助手。只根据用户话术提取指定字段，返回严格 JSON 对象，不要任何解释、前后缀或 markdown 代码块。提取不到的字段不要出现。'
    const user = `任务：${task.name}${examples}\n` +
      `需提取字段：${slotDesc}\n` +
      (filledDesc ? `已提取字段：${filledDesc}\n` : '') +
      `用户输入："${text}"\n` +
      `请返回 JSON：`

    const raw = await this.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 200, temperature: 0 })

    return this._parseJson(raw)
  }

  /**
   * 提取单个槽位值（LLM 兜底用）
   * @param {string} text - 用户输入
   * @param {Object} slotDef - 槽位定义
   * @param {Object} ctx - { taskCode, state, task }
   * @returns {Promise<string|null>}
   */
  async extractSlot(text, slotDef, ctx = {}) {
    if (!slotDef?.key) return null
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
   * 判断用户输入是否意图触发某个任务（口语化触发判定）
   * @param {string} text - 用户输入
   * @param {Array<{code:string, name:string, trigger_keywords:Array}>} tasks - 候选任务
   * @returns {Promise<string|null>} 触发的任务 code，未触发返回 null
   */
  async judgeTrigger(text, tasks) {
    if (!this.enabled || tasks.length === 0) return null
    const taskDesc = tasks.map(t =>
      `${t.code}（${t.name}）：触发表达如 ${(t.trigger_keywords || []).filter(k => typeof k === 'string').slice(0, 5).join('、')}`
    ).join('\n')

    const system = '你是客服意图判定器。判断用户输入是否意图办理某个业务任务（而非单纯咨询/闲聊）。只返回任务 code 或 null，不要任何其他文字。'
    const user = `可选任务：\n${taskDesc}\n用户输入："${text}"\n请返回触发的任务 code（未触发返回 null）：`

    const raw = await this.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 20, temperature: 0 })

    const trimmed = raw.replace(/["'`\s]/g, '')
    if (!trimmed || trimmed === 'null' || trimmed === '无' || trimmed === '没有') return null
    const hit = tasks.find(t => t.code === trimmed || trimmed.startsWith(t.code))
    return hit ? hit.code : null
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
      console.warn('[TaskFlow-LLM] JSON 解析失败:', raw.slice(0, 120))
      return {}
    }
  }
}

export default new LLMClient()
