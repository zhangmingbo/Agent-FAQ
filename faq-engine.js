/**
 * FAQ 问答引擎
 * 
 * 核心流程：
 *   用户输入 → 意图识别 → 答案匹配 → 多轮对话处理 → 返回完整答案
 * 
 * 支持：
 *   - 高置信度直接回答
 *   - 中置信度追问确认
 *   - 低置信度大模型兜底
 *   - 会话上下文管理
 */

import IntentRecognizer from './src/index.js'
import pool from './db.js'
import ruleLoader from './rules/ruleLoader.js'
import dialogueRules from './rules/dialogueRules.js'

class FAQEngine {
  /**
   * @param {Object} options - 配置
   * @param {number} options.minConfidence - 最低匹配阈值
   * @param {number} options.clarifyThreshold - 追问确认阈值
   * @param {number} options.topK - 返回 Top K 结果
   * @param {Object} options.llm - 大模型配置
   */
  constructor(options = {}) {
    this.clarifyThreshold = options.clarifyThreshold ?? 0.65
    this.llmConfig = options.llm || { enabled: false }
    this.meaninglessDetectionMode = 'rule' // 'rule' 或 'llm'

    // 底层意图识别器
    this.recognizer = new IntentRecognizer({
      minConfidence: options.minConfidence ?? 0.5,
      topK: options.topK ?? 5,
    })

    // FAQ 知识库（code → faq item）
    this.faqMap = new Map()

    // 会话管理（sessionId → context）
    this.sessions = new Map()

    // 会话过期时间（从规则管理器获取，默认30分钟）
    this.sessionTimeout = dialogueRules.getSessionTimeout()
  }

  /**
   * 初始化引擎（启动时调用）
   */
  async initialize() {
    console.log('[FAQEngine] 初始化引擎...')
    
    // 初始化规则加载器
    await ruleLoader.initialize()
    
    // 加载 FAQ 知识库
    await this.loadFAQ()
    
    console.log('[FAQEngine] 初始化完成')
  }

  /**
   * 从数据库加载 FAQ 知识库
   */
  async loadFAQ() {
    // 从数据库加载 FAQ 列表
    const [faqs] = await pool.execute('SELECT * FROM faq ORDER BY priority DESC, id ASC')
    
    // 从数据库加载所有相似问
    const [questions] = await pool.execute('SELECT faq_code, question, is_regex FROM faq_question')
    const questionsMap = new Map()
    for (const q of questions) {
      if (!questionsMap.has(q.faq_code)) questionsMap.set(q.faq_code, [])
      // ✅ 新增：如果是正则，恢复 /.../ 标记
      const questionText = q.is_regex ? `/${q.question}/` : q.question
      questionsMap.get(q.faq_code).push(questionText)
    }

    // 构建意图配置并加载到识别器
    const intents = faqs.map(faq => ({
      code: faq.code,
      name: faq.name,
      questions: questionsMap.get(faq.code) || [],
      priority: faq.priority || 0,
    }))

    await this.recognizer.addIntents(intents)

    // 存储 FAQ 答案数据（JSON 字段已被 mysql2 自动解析）
    for (const faq of faqs) {
      this.faqMap.set(faq.code, {
        ...faq,
        richContent: faq.rich_content || null,
        links: faq.links || null,
        related: faq.related || null,
        questions: questionsMap.get(faq.code) || [],
      })
    }

    console.log(`[FAQ引擎] 已加载 ${faqs.length} 条 FAQ`)
  }

  /**
   * 处理用户提问（核心接口）
   * @param {string} text - 用户输入
   * @param {string} sessionId - 会话ID（可选）
   * @returns {Promise<ChatResponse>}
   */
  async chat(text, sessionId = 'default', userId = null) {
    const startTime = Date.now()
    const timestamp = new Date().toISOString()
    
    // ===== [STEP 1] 收到请求 =====
    console.log(`\n${'='.repeat(80)}`)
    console.log(`[CHAT-START] ${timestamp} | Session: ${sessionId} | User: ${userId || 'anonymous'}`)
    console.log(`[INPUT] "${text}"`)
    console.log(`${'='.repeat(80)}\n`)
    
    // Phase 2: 无意义输入过滤（在规则模式下）
    if (this.meaninglessDetectionMode === 'rule') {
      // ===== [STEP 2] 无意义检测 =====
      console.log('[STEP 2] 检查无意义输入...')
      const meaninglessResult = dialogueRules.isMeaningless(text)
      const isMeaningless = typeof meaninglessResult === 'object' ? meaninglessResult.isMeaningless : meaninglessResult
      
      if (isMeaningless) {
        // ===== [STEP 2.1] 判定为无意义 =====
        const score = typeof meaninglessResult === 'object' ? meaninglessResult.score : 1.0
        const reason = typeof meaninglessResult === 'object' ? meaninglessResult.reason : '未知'
        console.log(`[RESULT] ❌ 无意义输入 detected! Score: ${score}, Reason: ${reason}`)
        
        // 无意义输入，直接返回兜底回复，不进入意图识别
        const response = {
          intent_code: null,
          confidence: 0,
          source: 'meaningless',
          answer: this.fallbackAnswer || '抱歉，我没有理解您的意思。您可以尝试描述您遇到的问题，或输入"转人工"联系人工客服。'
        }
        
        console.log(`[OUTPUT] Source: ${response.source} | Answer: "${response.answer.substring(0, 50)}..."`)
        
        // 记录日志
        await this._logChat(sessionId, text, response, userId, Date.now() - startTime)
        
        console.log(`[CHAT-END] Duration: ${Date.now() - startTime}ms`)
        console.log(`${'='.repeat(80)}\n`)
        return response
      } else {
        console.log('[RESULT] ✅ 有意义输入，继续处理')
      }
    }
    
    // 获取或创建会话上下文
    const context = this._getSession(sessionId)

    // 记录用户输入到历史
    context.history.push({ role: 'user', text, timestamp: Date.now() })

    let response

    // 检查是否在追问确认流程中
    if (context.pendingClarify) {
      response = await this._handleClarify(text, context)
    } else {
      // 正常意图识别
      response = await this._handleRecognize(text, context)
    }

    // 记录回复到历史
    context.history.push({ role: 'assistant', text: response.answer, timestamp: Date.now() })

    // 保留最近 20 条历史
    if (context.history.length > 20) {
      context.history = context.history.slice(-20)
    }

    // 保存会话
    this.sessions.set(sessionId, context)
    
    // ===== [STEP 6] 完成响应 =====
    const duration = Date.now() - startTime
    console.log(`\n${'='.repeat(80)}`)
    console.log(`[CHAT-END] Duration: ${duration}ms`)
    console.log(`[OUTPUT] Source: ${response.source} | Intent: ${response.intent_code || 'None'} | Confidence: ${response.confidence?.toFixed(2) || 'N/A'}`)
    console.log(`[ANSWER] "${response.answer.substring(0, 100)}${response.answer.length > 100 ? '...' : ''}"`)
    console.log(`${'='.repeat(80)}\n`)

    // 记录聊天日志到数据库（异步，不阻塞响应）
    this._logChat(sessionId, text, response, userId, duration).catch(e => {
      console.error('[聊天日志] 记录失败:', e.message)
    })

    return response
  }

  /**
   * 判断输入是否有意义（规则模式）- v2.0
   * 委托给 dialogueRules 模块处理，支持正则和权重评分
   */
  _isMeaninglessByRule(text) {
    const result = dialogueRules.isMeaningless(text)
    // 兼容旧格式：返回布尔值或对象
    return typeof result === 'object' ? result.isMeaningless : result
  }

  /**
   * 判断输入是否有意义（大模型模式）
   * 调用大模型判断用户输入是否是有意义的咨询问题
   */
  async _isMeaninglessByLLM(text) {
    if (!this.llmConfig.enabled || !this.llmConfig.apiUrl || !this.llmConfig.apiKey) {
      // 大模型未配置，降级为规则模式
      return this._isMeaninglessByRule(text)
    }

    try {
      const response = await fetch(this.llmConfig.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: this.llmConfig.model,
          messages: [
            {
              role: 'system',
              content: '你是一个对话质量判断器。判断用户输入是否是有意义的咨询问题（不是闲聊、语气词、无意义输入）。只返回 true 或 false，不要其他内容。'
            },
            { role: 'user', content: text }
          ],
          max_tokens: 10,
          temperature: 0.1,
        }),
      })

      const data = await response.json()
      const result = data.choices?.[0]?.message?.content?.trim().toLowerCase()
      // 大模型返回 false 表示无意义
      return result === 'false'
    } catch (e) {
      console.error('[FAQ引擎] 大模型无意义判断失败，降级为规则模式:', e.message)
      return this._isMeaninglessByRule(text)
    }
  }

  /**
   * 记录聊天日志到数据库
   * 根据 meaninglessDetectionMode 选择规则或大模型判断输入是否有意义
   */
  async _logChat(sessionId, userText, response, userId, latency) {
    let meaningful = 1

    if (this.meaninglessDetectionMode === 'llm') {
      // 大模型模式：调用 LLM 判断
      const isMeaningless = await this._isMeaninglessByLLM(userText)
      meaningful = isMeaningless ? 0 : 1
    } else {
      // 规则模式：使用规则过滤
      const isMeaningless = this._isMeaninglessByRule(userText)
      meaningful = isMeaningless ? 0 : 1
    }

    await pool.execute(
      'INSERT INTO chat_log (session_id, user_id, user_text, intent_code, confidence, source, answer, meaningful) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [sessionId, userId, userText, response.intent_code || null, response.confidence || 0, response.source || null, response.answer, meaningful]
    )
  }

  /**
   * 获取服务统计数据
   */
  async getStats() {
    // 总请求数
    const [total] = await pool.execute('SELECT COUNT(*) as cnt FROM chat_log')
    // 今日请求数
    const [today] = await pool.execute('SELECT COUNT(*) as cnt FROM chat_log WHERE DATE(created_at) = CURDATE()')
    // 平均置信度
    const [avgConf] = await pool.execute('SELECT AVG(confidence) as avg_conf FROM chat_log WHERE confidence > 0')
    // 各来源分布
    const [bySource] = await pool.execute('SELECT source, COUNT(*) as cnt FROM chat_log GROUP BY source')
    // 平均响应时间（从 created_at 无法精确计算，这里用近似值）
    // 最近 10 条记录
    const [recent] = await pool.execute('SELECT * FROM chat_log ORDER BY created_at DESC LIMIT 10')
    // 热门意图 Top 10
    const [topIntents] = await pool.execute('SELECT intent_code, COUNT(*) as cnt FROM chat_log WHERE intent_code IS NOT NULL GROUP BY intent_code ORDER BY cnt DESC LIMIT 10')

    const sourceMap = {}
    for (const s of bySource) sourceMap[s.source || 'unknown'] = s.cnt

    return {
      totalRequests: total[0].cnt,
      todayRequests: today[0].cnt,
      avgConfidence: avgConf[0].avg_conf ? parseFloat(avgConf[0].avg_conf).toFixed(3) : 0,
      bySource: sourceMap,
      recentLogs: recent.map(r => ({
        time: r.created_at,
        userText: r.user_text,
        intent: r.intent_code,
        confidence: r.confidence,
        source: r.source,
      })),
      topIntents: topIntents.map(t => ({
        code: t.intent_code,
        count: t.cnt,
      })),
    }
  }

  /**
   * 正常意图识别处理
   */
  async _handleRecognize(text, context) {
    // ===== [STEP 3] 意图识别 =====
    console.log('[STEP 3] 开始意图识别...')
    const result = await this.recognizer.recognize(text)
    
    console.log(`[RESULT] Matched: ${result.matched} | Confidence: ${result.confidence?.toFixed(2) || 'N/A'} | Intent: ${result.intent_code || 'None'}`)
    if (result.top_results && result.top_results.length > 0) {
      console.log('[TOP-5 INTENTS]:')
      result.top_results.slice(0, 5).forEach((r, i) => {
        // 修正：top_results中的字段是intentCode、intentName、similarity
        const intentCode = r.intentCode || r.intent_code || 'unknown'
        const intentName = r.intentName || r.intent_name || '未命名'
        const confidence = r.similarity || r.confidence || 0
        console.log(`  ${i + 1}. ${intentCode} (${intentName}): ${(confidence * 100).toFixed(1)}%`)
      })
    }

    if (result.matched) {
      const faq = this.faqMap.get(result.intent_code)

      if (result.confidence >= this.clarifyThreshold) {
        // ===== [STEP 4.1] 高置信度 - 直接回答 =====
        console.log(`[STEP 4.1] ✅ 高置信度 (${(result.confidence * 100).toFixed(1)}% >= ${(this.clarifyThreshold * 100).toFixed(0)}%) → 直接回答`)
        context.pendingClarify = null
        return this._buildResponse(result, faq, 'direct')
      } else {
        // ===== [STEP 4.2] 中置信度 - 追问确认 =====
        console.log(`[STEP 4.2] ⚠️ 中置信度 (${(result.confidence * 100).toFixed(1)}% < ${(this.clarifyThreshold * 100).toFixed(0)}%) → 追问确认`)
        context.pendingClarify = {
          intentCode: result.intent_code,
          intentName: result.intent_name,
          confidence: result.confidence,
          topResults: result.top_results,
        }
        return this._buildClarifyResponse(result, faq)
      }
    } else {
      // ===== [STEP 4.3] 未匹配 - 大模型兜底 =====
      console.log('[STEP 4.3] ❌ 未匹配任何意图 → 大模型兜底')
      context.pendingClarify = null
      return await this._handleFallback(text, context, result)
    }
  }

  /**
   * 处理追问确认 - v2.0
   * 使用规则管理器判断用户意图，支持权重评分
   */
  async _handleClarify(text, context) {
    const pending = context.pendingClarify

    // 使用规则管理器判断用户意图（v2.0 - 返回对象格式）
    const confirmResult = dialogueRules.isConfirm(text)
    const denyResult = dialogueRules.isDeny(text)
    
    // 兼容新旧格式：对象或布尔值
    const isConfirmed = typeof confirmResult === 'object' ? confirmResult.matched : confirmResult
    const isDenied = typeof denyResult === 'object' ? denyResult.matched : denyResult

    if (isConfirmed) {
      // 用户确认了 → 返回答案
      const faq = this.faqMap.get(pending.intentCode)
      console.log('[FAQEngine] 确认后获取FAQ:', pending.intentCode, '找到:', !!faq)
      
      context.pendingClarify = null
      
      if (!faq) {
        // FAQ不存在，返回兜底回复
        return {
          intent_code: pending.intentCode,
          confidence: pending.confidence,
          source: 'confirmed',
          answer: this.fallbackAnswer || '抱歉，没有找到相关答案。'
        }
      }
      
      return this._buildResponse(
        { matched: true, intent_code: pending.intentCode, intent_name: pending.intentName, confidence: pending.confidence },
        faq,
        'confirmed'
      )
    } else if (isDenied) {
      // 用户否认 → 重新识别
      context.pendingClarify = null
      return await this._handleRecognize(text, context)
    } else {
      // 用户输入了新的内容 → 当作新问题分析
      context.pendingClarify = null
      return await this._handleRecognize(text, context)
    }
  }

  /**
   * 构建直接回答响应
   */
  _buildResponse(result, faq, source) {
    // ===== [STEP 5] 构建响应 =====
    console.log(`[STEP 5] 构建${source === 'direct' ? '直接' : '确认后'}回答...`)
    
    const response = {
      matched: true,
      confidence: result.confidence,
      intent_code: result.intent_code,
      intent_name: result.intent_name,
      answer: faq?.answer || '抱歉，该问题暂无详细解答。',
      source: source, // 'direct' | 'confirmed'
    }

    // 附加富内容
    if (faq?.richContent) {
      response.richContent = faq.richContent
    }

    // 附加链接
    if (faq?.links) {
      response.links = faq.links
    }

    // 附加相关推荐
    if (faq?.related) {
      response.related = faq.related
    }
    
    console.log(`[OUTPUT] Intent: ${result.intent_code} | Source: ${source} | Answer Length: ${response.answer.length}`)

    return response
  }

  /**
   * 构建追问确认响应
   */
  _buildClarifyResponse(result, faq) {
    const followUp = faq?.followUp || `您是想咨询"${result.intent_name}"吗？请回复"是"或"不是"`

    return {
      matched: false,
      confidence: result.confidence,
      intent_code: null,
      intent_name: null,
      answer: followUp,
      source: 'clarify',
      candidates: result.top_results?.slice(0, 3).map(r => ({
        intent_code: r.intentCode,
        intent_name: r.intentName,
        similarity: r.similarity,
      })) || [],
    }
  }

  /**
   * 处理未匹配情况
   */
  async _handleFallback(text, context, result) {
    // ===== [STEP 4.3.1] 尝试大模型兜底 =====
    console.log('[STEP 4.3.1] 检查大模型配置...')
    
    // 尝试大模型兜底
    if (this.llmConfig.enabled) {
      console.log(`[LLM] ✅ 已启用，调用大模型: ${this.llmConfig.model || 'default'}`)
      try {
        const llmAnswer = await this._callLLM(text, context)
        console.log(`[LLM] ✅ 成功获取回答 (${llmAnswer.length} chars)`)
        return {
          matched: false,
          confidence: result?.confidence || 0,
          intent_code: null,
          intent_name: null,
          answer: llmAnswer,
          source: 'llm',
        }
      } catch (e) {
        console.error(`[LLM]  调用失败: ${e.message}`)
      }
    } else {
      console.log('[LLM] ⚠️ 未启用，使用默认兜底回复')
    }

    // ===== [STEP 4.3.2] 默认兜底回复 =====
    console.log('[STEP 4.3.2] 返回默认兜底回复')
    const fallbackResponse = {
      matched: false,
      confidence: result?.confidence || 0,
      intent_code: null,
      intent_name: null,
      answer: '抱歉，我暂时无法回答这个问题。\n\n您可以尝试：\n1. 换一种方式描述您的问题\n2. 输入"转人工"联系人工客服\n\n常见问题推荐：',
      source: 'fallback',
      related: ['怎么交燃气费', '营业厅在哪里', '天然气多少钱一方'],
    }
    
    console.log(`[OUTPUT] Source: fallback | Answer Length: ${fallbackResponse.answer.length}`)
    return fallbackResponse
  }

  /**
   * 调用大模型（可选功能）
   */
  async _callLLM(text, context) {
    if (!this.llmConfig.apiUrl || !this.llmConfig.apiKey) {
      throw new Error('大模型配置不完整')
    }

    // 构建上下文消息
    const messages = [
      { role: 'system', content: this.llmConfig.systemPrompt },
    ]

    // 加入最近 5 轮对话作为上下文
    const recentHistory = context.history.slice(-10)
    for (const msg of recentHistory) {
      messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.text })
    }

    const response = await fetch(this.llmConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: this.llmConfig.model,
        messages,
        max_tokens: 500,
        temperature: 0.7,
      }),
    })

    const data = await response.json()
    return data.choices?.[0]?.message?.content || '抱歉，暂时无法回答。'
  }

  /**
   * 获取会话上下文
   */
  _getSession(sessionId) {
    const session = this.sessions.get(sessionId)
    const now = Date.now()

    // 从规则管理器获取最新的超时时间
    const timeout = dialogueRules.getSessionTimeout()

    if (session && (now - session.lastActive) < timeout) {
      session.lastActive = now
      return session
    }

    // 新建会话
    const newSession = {
      sessionId,
      history: [],
      pendingClarify: null,
      lastActive: now,
      createdAt: now,
    }
    this.sessions.set(sessionId, newSession)
    return newSession
  }

  /**
   * 获取分类树形结构
   */
  async listCategories() {
    const [cats] = await pool.execute(
      'SELECT * FROM faq_category ORDER BY level, sort_order, id'
    )
    const [faqCounts] = await pool.execute(
      'SELECT category_id, COUNT(*) as cnt FROM faq GROUP BY category_id'
    )
    const countMap = new Map(faqCounts.map(r => [r.category_id, r.cnt]))

    // 构建树形结构
    const tree = []
    const catMap = new Map()
    
    for (const cat of cats) {
      const node = {
        id: cat.id,
        name: cat.name,
        code: cat.code,
        parentId: cat.parent_id,
        level: cat.level,
        sortOrder: cat.sort_order,
        faqCount: countMap.get(cat.id) || 0,
        children: [],
      }
      catMap.set(cat.id, node)
      
      if (cat.parent_id === 0) {
        tree.push(node)
      } else {
        const parent = catMap.get(cat.parent_id)
        if (parent) parent.children.push(node)
      }
    }
    
    return tree
  }

  /**
   * 获取指定分类下的 FAQ 列表
   */
  async listFAQByCategory(categoryId) {
    let sql = 'SELECT * FROM faq'
    const params = []
    
    if (categoryId) {
      // 获取该分类及其子分类的 ID
      const [subCats] = await pool.execute(
        'SELECT id FROM faq_category WHERE id = ? OR parent_id = ?',
        [categoryId, categoryId]
      )
      const catIds = subCats.map(c => c.id)
      sql += ` WHERE category_id IN (${catIds.map(() => '?').join(',')})`
      params.push(...catIds)
    }
    
    sql += ' ORDER BY priority DESC, id ASC'
    
    const [faqs] = await pool.execute(sql, params)
    const [qCounts] = await pool.execute('SELECT faq_code, COUNT(*) as cnt FROM faq_question GROUP BY faq_code')
    const countMap = new Map(qCounts.map(r => [r.faq_code, r.cnt]))

    return faqs.map(faq => ({
      code: faq.code,
      name: faq.name,
      categoryId: faq.category_id,
      questionCount: countMap.get(faq.code) || 0,
      hasAnswer: !!faq.answer,
      answerPreview: faq.answer ? faq.answer.substring(0, 50) + (faq.answer.length > 50 ? '...' : '') : '',
    }))
  }

  /**
   * 获取 FAQ 列表（从数据库）
   */
  async listFAQ() {
    const [faqs] = await pool.execute('SELECT * FROM faq ORDER BY priority DESC, id ASC')
    const [qCounts] = await pool.execute('SELECT faq_code, COUNT(*) as cnt FROM faq_question GROUP BY faq_code')
    const countMap = new Map(qCounts.map(r => [r.faq_code, r.cnt]))

    return faqs.map(faq => ({
      code: faq.code,
      name: faq.name,
      categoryId: faq.category_id,
      questionCount: countMap.get(faq.code) || 0,
      hasAnswer: !!faq.answer,
      answerPreview: faq.answer ? faq.answer.substring(0, 50) + (faq.answer.length > 50 ? '...' : '') : '',
      hasRichContent: !!faq.rich_content,
      hasRelated: !!faq.related,
    }))
  }

  /**
   * 获取单个 FAQ 详情（从数据库）
   */
  async getFAQ(code) {
    const [faqs] = await pool.execute('SELECT * FROM faq WHERE code = ?', [code])
    if (!faqs.length) return null
    const faq = faqs[0]
    const [questions] = await pool.execute('SELECT question FROM faq_question WHERE faq_code = ?', [code])
    return {
      ...faq,
      richContent: faq.rich_content || null,
      links: faq.links || null,
      related: faq.related || null,
      questions: questions.map(q => q.question),
    }
  }

  /**
   * 添加/更新 FAQ（写入数据库）
   */
  async addFAQ(faqConfig) {
    const { code, name, questions, answer, richContent, links, related, followUp, priority, categoryId } = faqConfig

    // 写入数据库
    await pool.execute(
      'INSERT INTO faq (code, name, answer, rich_content, links, related, follow_up, priority, category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, answer=?, rich_content=?, links=?, related=?, follow_up=?, priority=?, category_id=?',
      [code, name, answer || null, richContent ? JSON.stringify(richContent) : null, links ? JSON.stringify(links) : null, related ? JSON.stringify(related) : null, followUp || null, priority || 0, categoryId || null, name, answer || null, richContent ? JSON.stringify(richContent) : null, links ? JSON.stringify(links) : null, related ? JSON.stringify(related) : null, followUp || null, priority || 0, categoryId || null]
    )

    // 删除旧的相似问，重新插入
    await pool.execute('DELETE FROM faq_question WHERE faq_code = ?', [code])
    if (questions && questions.length > 0) {
      for (const q of questions) {
        // ✅ 新增：判断是否为正则表达式
        const isRegex = q.startsWith('/') && q.endsWith('/') && q.length > 2
        const questionText = isRegex ? q.slice(1, -1) : q  // 去除 /.../ 标记
        
        await pool.execute(
          'INSERT INTO faq_question (faq_code, question, is_regex) VALUES (?, ?, ?)',
          [code, questionText, isRegex ? 1 : 0]
        )
      }
    }

    // ✅ 优化：增量更新，只添加/更新这个意图，不重新加载全部
    console.log(`[FAQ-UPDATE] 开始增量更新意图: ${code} (${name})`)
    
    // 3.1 构建单个意图对象
    const singleIntent = {
      code,
      name,
      questions,
      priority: priority || 0,
      answer,
      richContent
    }

    // 3.2 先删除旧的意图（如果存在）
    this.recognizer.removeIntent(code)
    console.log(`[FAQ-UPDATE] 已删除旧意图`)

    // 3.3 添加到意图识别器（会自动编码这个意图的相似问）
    await this.recognizer.addIntent(singleIntent)
    console.log(`[FAQ-UPDATE] ✅ 意图已添加到识别器`)

    // 3.4 更新本地faqMap缓存
    this.faqMap.set(code, {
      code,
      name,
      answer,
      richContent,
      links,
      related,
      followUp,
      priority: priority || 0,
      categoryId
    })
    console.log(`[FAQ-UPDATE] ✅ FAQ缓存已更新`)
    console.log(`[FAQ-UPDATE] 总意图数: ${this.recognizer.allSamples.length}`)

    return true
  }

  /**
   * 删除 FAQ（从数据库）
   */
  async removeFAQ(code) {
    await pool.execute('DELETE FROM faq WHERE code = ?', [code])
    this.faqMap.delete(code)
    return this.recognizer.removeIntent(code)
  }

  /**
   * 获取意图数量
   */
  getIntentCount() {
    return this.recognizer.getIntentCount()
  }

  /**
   * 清理过期会话
   */
  cleanSessions() {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (now - session.lastActive > this.sessionTimeout) {
        this.sessions.delete(id)
      }
    }
  }

  /**
   * 智能分析：获取优化建议
   */
  async getAnalysis() {
    // 1. 未匹配问题聚合（按用户输入文本聚类）
    const [unmatched] = await pool.execute(
      `SELECT user_text, COUNT(*) as cnt, MAX(created_at) as last_time
       FROM chat_log 
       WHERE intent_code IS NULL AND source IN ('fallback', 'clarify')
       GROUP BY user_text 
       ORDER BY cnt DESC 
       LIMIT 50`
    )

    // 2. 低置信度匹配（< 70%）
    const [lowConf] = await pool.execute(
      `SELECT user_text, intent_code, confidence, created_at
       FROM chat_log 
       WHERE confidence > 0 AND confidence < 0.7 AND intent_code IS NOT NULL
       ORDER BY created_at DESC 
       LIMIT 50`
    )

    // 3. 高频问题 Top 20
    const [topQuestions] = await pool.execute(
      `SELECT user_text, intent_code, COUNT(*) as cnt, 
              AVG(confidence) as avg_conf, MAX(created_at) as last_time
       FROM chat_log 
       WHERE intent_code IS NOT NULL
       GROUP BY user_text, intent_code
       ORDER BY cnt DESC 
       LIMIT 20`
    )

    // 4. 答案覆盖率统计
    const [totalFaq] = await pool.execute('SELECT COUNT(*) as cnt FROM faq')
    const [withAnswer] = await pool.execute('SELECT COUNT(*) as cnt FROM faq WHERE answer IS NOT NULL AND answer != ""')
    const [withRich] = await pool.execute('SELECT COUNT(*) as cnt FROM faq WHERE rich_content IS NOT NULL')
    const [withRelated] = await pool.execute('SELECT COUNT(*) as cnt FROM faq WHERE related IS NOT NULL')
    const [questionCounts] = await pool.execute(
      'SELECT fq.faq_code, f.name, COUNT(*) as cnt FROM faq_question fq LEFT JOIN faq f ON f.code = fq.faq_code GROUP BY fq.faq_code HAVING cnt < 5'
    )

    // 5. 近 7 天趋势
    const [trend] = await pool.execute(
      `SELECT DATE(created_at) as date, COUNT(*) as total,
              SUM(CASE WHEN intent_code IS NOT NULL THEN 1 ELSE 0 END) as matched,
              SUM(CASE WHEN source = 'fallback' THEN 1 ELSE 0 END) as fallback,
              AVG(CASE WHEN confidence > 0 THEN confidence ELSE NULL END) as avg_conf
       FROM chat_log 
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date`
    )

    // 6. 转人工/无意义输入统计
    const [meaningless] = await pool.execute(
      `SELECT user_text, COUNT(*) as cnt FROM chat_log 
       WHERE source = 'fallback'
       GROUP BY user_text ORDER BY cnt DESC LIMIT 20`
    )

    return {
      unmatched: unmatched.map(r => ({
        text: r.user_text,
        count: r.cnt,
        lastTime: r.last_time,
      })),
      lowConfidence: lowConf.map(r => ({
        text: r.user_text,
        intent: r.intent_code,
        confidence: parseFloat(r.confidence),
        time: r.created_at,
      })),
      topQuestions: topQuestions.map(r => ({
        text: r.user_text,
        intent: r.intent_code,
        count: r.cnt,
        avgConfidence: parseFloat(r.avg_conf),
        lastTime: r.last_time,
      })),
      coverage: {
        totalFaq: totalFaq[0].cnt,
        withAnswer: withAnswer[0].cnt,
        withRichContent: withRich[0].cnt,
        withRelated: withRelated[0].cnt,
        answerRate: ((withAnswer[0].cnt / totalFaq[0].cnt) * 100).toFixed(1),
        richRate: ((withRich[0].cnt / totalFaq[0].cnt) * 100).toFixed(1),
        relatedRate: ((withRelated[0].cnt / totalFaq[0].cnt) * 100).toFixed(1),
        lowQuestionFaqs: questionCounts.map(r => ({ code: r.faq_code, name: r.name, count: r.cnt })),
      },
      trend: trend.map(r => ({
        date: r.date,
        total: r.total,
        matched: r.matched,
        fallback: r.fallback,
        avgConfidence: r.avg_conf ? parseFloat(r.avg_conf).toFixed(3) : 0,
      })),
      meaningless: meaningless.map(r => ({
        text: r.user_text,
        count: r.cnt,
      })),
    }
  }
}

export default FAQEngine
