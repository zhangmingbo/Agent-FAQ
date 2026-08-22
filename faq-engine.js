/**
 * FAQ 问答引擎（对话编排层）
 * 
 * 核心流程：
 *   用户输入 → 任务流程/意图识别 → 答案匹配 → 多轮对话处理 → 返回完整答案
 * 
 * 职责边界：
 *   - 对话编排：任务流程、无意义过滤、意图识别路由、追问确认、兜底
 *   - 会话管理：上下文、超时清理
 *   - 数据访问委托给领域服务：知识库 → FaqService，统计 → statsService
 * 
 * 支持：
 *   - 高置信度直接回答
 *   - 中置信度追问确认
 *   - 低置信度大模型兜底
 *   - 会话上下文管理
 */

import ruleLoader from './rules/ruleLoader.js'
import dialogueRules from './rules/dialogueRules.js'
import FaqService from './services/faqService.js'
import * as statsService from './services/statsService.js'
import * as chatLogRepo from './repositories/chatLogRepo.js'
import { get as getPrompt } from './services/llmPrompts.js'

class FAQEngine {
  /**
   * @param {Object} options - 配置
   * @param {FaqService} options.faqService - 知识库领域服务（不传则自建）
   * @param {Object} options.statsService - 统计领域服务（不传则用默认模块）
   * @param {number} options.minConfidence - 最低匹配阈值（自建 faqService 时生效）
   * @param {number} options.clarifyThreshold - 追问确认阈值
   * @param {number} options.topK - 返回 Top K 结果（自建 faqService 时生效）
   * @param {Object} options.llm - 大模型配置
   */
  constructor(options = {}) {
    this.clarifyThreshold = options.clarifyThreshold ?? 0.65
    this.llmConfig = options.llm || { enabled: false }
    this.meaninglessDetectionMode = 'rule' // 'rule' 或 'llm'

    // 知识库领域服务（默认自建，便于独立使用引擎；server.js 显式注入共享实例）
    this.faqService = options.faqService || new FaqService({
      minConfidence: options.minConfidence ?? 0.5,
      topK: options.topK ?? 5,
    })

    // 兼容访问：识别器与答案缓存由 faqService 持有
    this.recognizer = this.faqService.recognizer

    // 统计领域服务（注入或默认模块）
    this.statsService = options.statsService || statsService

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
    await this.faqService.loadAll()
    
    console.log('[FAQEngine] 初始化完成')
  }

  /**
   * 从数据库加载 FAQ 知识库（兼容门面，委托 FaqService）
   */
  loadFAQ() {
    return this.faqService.loadAll()
  }

  /**
   * 处理用户提问（核心接口）
   * @param {string} text - 用户输入
   * @param {string} sessionId - 会话ID（可选）
   * @param {string|null} userId - 用户ID（可选）
   * @param {Object} opts - 选项；opts.debug=true 时响应附加 _debug 调试信息
   * @returns {Promise<ChatResponse>}
   */
  async chat(text, sessionId = 'default', userId = null, opts = {}) {
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
        
        if (opts.debug) this._attachDebug(response, sessionId)
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

    // ===== 意图路由 + 任务流程检查 =====
    // 任务引擎存在时，每轮输入先经路由判定通道，实现任务/FAQ 双向穿透：
    //   有活跃任务（含挂起）→ task_continue / task_new / faq 三选一
    //   无活跃任务        → 命中触发词则发起任务，否则 FAQ
    if (this.taskEngine) {
      const hasActive = this.taskEngine.hasActiveTask(sessionId)
      const isSuspended = this.taskEngine.isSuspended(sessionId)

      // ---------- 场景 A：任务被 FAQ 插话挂起 ----------
      if (hasActive && isSuspended) {
        console.log('[TASK] 检测到挂起任务，先判定是否恢复')
        const taskState = this.taskEngine.getActiveTask(sessionId)
        const resumeR = dialogueRules.isResume(text)
        const isResume = typeof resumeR === 'object' ? resumeR.matched : resumeR
        if (isResume) {
          // 用户说"继续/接着办" → 恢复任务并回到任务通道
          this.taskEngine.resume(sessionId)
          const unfilled = Object.entries(taskState.slots).filter(([_, s]) => s.required && !s.filled)
          const progressHint = unfilled.length
            ? `还需要：${unfilled.map(([_, s]) => s.label).join('、')}`
            : '信息已齐全，请确认'
          response = {
            intent_code: `task:${taskState.taskCode}`,
            confidence: 1,
            source: 'task_resumed',
            answer: `好的，我们继续「${taskState.taskName}」～${progressHint}`,
          }
        } else {
          // 不是恢复词：可能是继续 FAQ 提问，或想换办别的事
          const route = await this.taskEngine.nlu.route(text, {
            taskState,
            tasks: [...this.taskEngine.taskDefs.values()],
            filledDesc: this._taskFilledDesc(taskState),
          })
          if (route === 'task_new') {
            // 换办另一件事：中断暂存当前任务，走新任务流程
            await this.taskEngine.stash(sessionId)
            response = await this._tryStartTask(sessionId, text, context, /* fromStash */ true)
          } else {
            // 继续 FAQ 通道（任务保持挂起）
            response = await this._handleRecognize(text, context)
            if (response.source === 'direct' || response.source === 'confirmed') {
              response = {
                ...response,
                answer: response.answer + this._suspendedHint(taskState),
                source: 'task_suspended_faq',
              }
            }
          }
        }
      }

      // ---------- 场景 B：活跃任务（未挂起）→ 路由三选一 ----------
      else if (hasActive) {
        console.log('[TASK] 检测到活跃任务，进入任务对话模式')
        const taskState = this.taskEngine.getActiveTask(sessionId)
        const route = await this.taskEngine.nlu.route(text, {
          taskState,
          tasks: [...this.taskEngine.taskDefs.values()],
          filledDesc: this._taskFilledDesc(taskState),
        })
        console.log(`[TASK] 路由判定: ${route}`)

        if (route === 'faq') {
          // 用户问知识（费用/故障/操作…）→ FAQ 通道 + 任务挂起
          console.log('[TASK] 路由→FAQ，任务挂起')
          const faqResponse = await this._handleRecognize(text, context)
          if (faqResponse.source === 'direct' || faqResponse.source === 'confirmed') {
            this.taskEngine.suspend(sessionId)
            response = {
              ...faqResponse,
              answer: faqResponse.answer + this._suspendedHint(taskState),
              source: 'task_suspended_faq',
            }
          } else {
            // FAQ 也没匹配到 → 回任务通道继续引导
            response = await this._handleTaskTurn(sessionId, text, context)
          }
        } else if (route === 'task_new') {
          // 用户想办另一件事 → 中断暂存当前任务，触发新任务
          console.log('[TASK] 路由→新任务，当前任务中断暂存')
          await this.taskEngine.stash(sessionId)
          response = await this._tryStartTask(sessionId, text, context, /* fromStash */ true)
        } else {
          // task_continue → 任务对话（原逻辑）
          response = await this._handleTaskTurn(sessionId, text, context)
        }
      }

      // ---------- 场景 C：无活跃任务 → 路由判定后决定触发任务或 FAQ ----------
      else {
        // 无任务上下文时 route 判定：命中触发词且无咨询疑云 → task_new；
        // 咨询疑云（"上门换滤芯收费吗"）→ faq，不触发任务（避免误抢 FAQ）
        const route = await this.taskEngine.nlu.route(text, {
          taskState: null,
          tasks: [...this.taskEngine.taskDefs.values()],
          filledDesc: '',
        })
        if (route === 'task_new') {
          response = await this._tryStartTask(sessionId, text, context, /* fromStash */ false)
        }
        // route === 'faq' → 走下方常规 FAQ 流程（response 保持 null）
      }
    }

    // 3. 常规 FAQ 对话流程
    if (!response) {
      // 检查是否在追问确认流程中
      if (context.pendingClarify) {
        response = await this._handleClarify(text, context)
      } else {
        // 正常意图识别
        response = await this._handleRecognize(text, context)
      }
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

    if (opts.debug) this._attachDebug(response, sessionId)

    return response
  }

  /**
   * 任务对话轮次（task_continue 通道）—— 原 processInput 处理逻辑
   */
  async _handleTaskTurn(sessionId, text, context) {
    const taskResult = await this.taskEngine.processInput(sessionId, text)
    if (!taskResult) return null

    if (taskResult.extracted || taskResult.isComplete || taskResult.cancelled || taskResult.reask) {
      if (taskResult.question && taskResult.questionText) {
        // 边答边问：先 FAQ 回答问题，再接任务进度提示
        console.log('[TASK] 检测到边答边问，FAQ 回答:', taskResult.questionText)
        const faqResponse = await this._handleRecognize(taskResult.questionText, context)
        if (faqResponse.source === 'direct' || faqResponse.source === 'confirmed') {
          return {
            ...faqResponse,
            answer: faqResponse.answer + '\n' + taskResult.reply,
            source: 'task_faq',
          }
        }
        return {
          intent_code: `task:${taskResult.taskState.taskCode}`,
          confidence: 1,
          source: 'task_progress',
          answer: taskResult.reply,
        }
      }
      return {
        intent_code: `task:${taskResult.taskState.taskCode}`,
        confidence: 1,
        source: taskResult.isComplete ? 'task_complete' : (taskResult.cancelled ? 'task_cancelled' : 'task_progress'),
        answer: taskResult.reply,
      }
    }

    // 提取失败（用户输入不匹配任何槽位）→ 尝试 FAQ 匹配
    console.log('[TASK] 提取失败，尝试 FAQ 匹配...')
    const faqResponse = await this._handleRecognize(text, context)
    if (faqResponse.source === 'direct' || faqResponse.source === 'confirmed') {
      const taskState = this.taskEngine.getActiveTask(sessionId)
      if (taskState) {
        const unfilled = Object.entries(taskState.slots).filter(([_, s]) => s.required && !s.filled)
        const progressHint = `\n\n———\n📌 您正在进行「${taskState.taskName}」，还需要：${unfilled.map(([_, s]) => s.label).join('、')}`
        return { ...faqResponse, answer: faqResponse.answer + progressHint, source: 'task_faq' }
      }
      return faqResponse
    }
    return {
      intent_code: `task:${taskResult.taskState.taskCode}`,
      confidence: 1,
      source: 'task_progress',
      answer: taskResult.reply,
    }
  }

  /**
   * 尝试发起新任务（无活跃任务时，或从挂起中断后换办新任务时）
   * @param {boolean} fromStash - 是否有被中断的任务可恢复
   */
  async _tryStartTask(sessionId, text, context, fromStash = false) {
    const matchedTask = await this.taskEngine.matchTask(text)
    if (!matchedTask) return null

    console.log(`[TASK] 触发任务: ${matchedTask.name} (${matchedTask.code})`)
    const taskState = this.taskEngine.startTask(sessionId, matchedTask)
    const taskResult = await this.taskEngine.processInput(sessionId, text)
    if (taskResult) {
      let answer = taskResult.reply
      // 有被中断的任务时，提示可恢复
      if (fromStash) {
        const stashed = await this.taskEngine.getStashed(sessionId)
        if (stashed) {
          answer = `（您之前正在进行「${stashed.taskName}」，回复"继续"可接着办理）\n\n` + answer
        }
      }
      return {
        intent_code: `task:${matchedTask.code}`,
        confidence: 1,
        source: taskResult.isComplete ? 'task_complete' : 'task_started',
        answer,
      }
    }
    return null
  }

  /** 任务已收集槽位摘要（路由 LLM 上下文用） */
  _taskFilledDesc(state) {
    if (!state?.slots) return ''
    const filled = Object.entries(state.slots).filter(([, s]) => s.filled)
    return filled.length ? `已收集：${filled.map(([k, s]) => `${s.label || k}: ${s.value}`).join('；')}` : '已收集：无'
  }

  /** 挂起提示话术（FAQ 回答后拼接，引导用户恢复任务） */
  _suspendedHint(taskState) {
    return `\n\n———\n📌 您正在进行「${taskState.taskName}」，回复"继续"可接着办理。`
  }

  /**
   * 附加调试信息（前端调试模式用，仅 debug=true 时调用）
   */
  _attachDebug(response, sessionId) {
    response._debug = {
      source: response.source,
      intent: response.intent_code,
      confidence: response.confidence,
      task: this.taskEngine?.getDebugInfo ? this.taskEngine.getDebugInfo(sessionId) : null,
    }
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
              content: getPrompt('meaningless.system'),
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

    await chatLogRepo.log({
      sessionId,
      userId,
      userText,
      intentCode: response.intent_code || null,
      confidence: response.confidence || 0,
      source: response.source || null,
      answer: response.answer,
      meaningful,
    })
  }

  /**
   * 获取服务统计数据（兼容门面，委托 statsService）
   */
  getStats() {
    return this.statsService.getStats()
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
      // ===== [STEP 3.5] LLM 意图重排（可选，配置启用且置信度不高时） =====
      if (this.llmConfig?.enabled && result.confidence < 0.9 && (result.top_results?.length || 0) >= 2) {
        const choice = await this._llmRerankIntent(text, result.top_results.slice(0, 5))
        if (choice && choice !== result.intent_code) {
          const alt = result.top_results.find(r => (r.intentCode || r.intent_code) === choice)
          if (alt && this.faqService.getFaq(choice)) {
            console.log(`[LLM] 意图重排: ${result.intent_code} → ${choice}`)
            result.intent_code = choice
            result.intent_name = alt.intentName || alt.intent_name
            result.confidence = alt.similarity
          }
        }
      }

      const faq = this.faqService.getFaq(result.intent_code)

      // ===== [STEP 3.6] 候选竞争检测：top1/top2 是不同意图且差距很小 → 追问让用户选 =====
      const top1 = result.top_results?.[0]
      const top2 = result.top_results?.[1]
      const competition = !!(
        top1 && top2
        && (top1.intentCode || top1.intent_code) !== (top2.intentCode || top2.intent_code)
        && top1.similarity < 0.95
        && (top1.similarity - top2.similarity) < 0.06
      )

      if (result.confidence >= this.clarifyThreshold && !competition) {
        // ===== [STEP 4.1] 高置信度 - 直接回答 =====
        console.log(`[STEP 4.1] ✅ 高置信度 (${(result.confidence * 100).toFixed(1)}% >= ${(this.clarifyThreshold * 100).toFixed(0)}%) → 直接回答`)
        context.pendingClarify = null
        return this._buildResponse(result, faq, 'direct')
      } else {
        // ===== [STEP 4.2] 中置信度/候选竞争 - 追问确认 =====
        console.log(`[STEP 4.2] ⚠️ ${competition ? '候选竞争' : '中置信度'} (${(result.confidence * 100).toFixed(1)}%) → 追问确认`)
        context.pendingClarify = {
          intentCode: result.intent_code,
          intentName: result.intent_name,
          confidence: result.confidence,
          topResults: result.top_results,
          competition,
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

    // 0) 用户在候选竞争追问中选择了候选（"1"/"2"/"第一个"/候选名称）
    const selected = this._matchClarifySelection(text, pending)
    if (selected) {
      console.log(`[FAQEngine] 用户选择候选: ${selected.intentCode}`)
      context.pendingClarify = null
      const faq = this.faqService.getFaq(selected.intentCode)
      return this._buildResponse(
        { matched: true, intent_code: selected.intentCode, intent_name: selected.intentName, confidence: selected.confidence },
        faq,
        'direct'
      )
    }

    // 使用规则管理器判断用户意图（v2.0 - 返回对象格式）
    const confirmResult = dialogueRules.isConfirm(text)
    const denyResult = dialogueRules.isDeny(text)
    
    // 兼容新旧格式：对象或布尔值
    const isConfirmed = typeof confirmResult === 'object' ? confirmResult.matched : confirmResult
    const isDenied = typeof denyResult === 'object' ? denyResult.matched : denyResult

    if (isConfirmed) {
      // 用户确认了 → 返回答案
      const faq = this.faqService.getFaq(pending.intentCode)
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
   * 匹配用户在追问中的候选选择："1"/"2"/"3"/"第一个"/候选名称
   */
  _matchClarifySelection(text, pending) {
    if (!pending?.topResults?.length) return null
    const t = text.trim().toLowerCase()
    const candidates = pending.topResults.slice(0, 3)

    // 数字/序数选择
    const numMatch = t.match(/^[第]?([123])[个项条]?$/) || t.match(/^(第一个|第二个|第三个)$/)
    if (numMatch) {
      let idx = -1
      if (/^[123]$/.test(numMatch[1])) {
        idx = parseInt(numMatch[1], 10) - 1
      } else {
        idx = ['第一个', '第二个', '第三个'].indexOf(numMatch[1])
      }
      const c = candidates[idx]
      if (c) return { intentCode: c.intentCode, intentName: c.intentName, confidence: c.similarity }
    }

    // 候选名称包含匹配（如回复"气价"命中"气价查询"）
    for (const c of candidates) {
      const name = c.intentName || ''
      if (name && name.length > 1 && t.includes(name)) {
        return { intentCode: c.intentCode, intentName: name, confidence: c.similarity }
      }
    }
    return null
  }

  /**
   * LLM 意图重排（可选）：从 top-5 候选中选最符合用户问题的意图
   * 提示词来自运营配置注册表（llm_rerank.*）
   * @returns {Promise<string|null>} 意图 code
   */
  async _llmRerankIntent(text, candidates) {
    try {
      const list = candidates.map((c, i) => `${i + 1}. ${c.intentName || c.intentCode}（${(c.questionText || '').slice(0, 30)}）`).join('\n')
      const response = await fetch(this.llmConfig.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: this.llmConfig.model,
          messages: [
            { role: 'system', content: getPrompt('llm_rerank.system') },
            { role: 'user', content: getPrompt('llm_rerank.user', { list, text }) },
          ],
          max_tokens: 5,
          temperature: 0,
        }),
      })
      const data = await response.json()
      const content = (data.choices?.[0]?.message?.content || '').trim()
      const idx = parseInt(content, 10) - 1
      const hit = candidates[idx]
      return hit ? (hit.intentCode || hit.intent_code) : null
    } catch (e) {
      console.error('[LLM] 意图重排失败:', e.message)
      return null
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
   * 候选竞争时改为"选项选择"话术；普通低置信度保持"是/不是"确认
   */
  _buildClarifyResponse(result, faq) {
    const top = result.top_results || []
    const top1 = top[0]
    const top2 = top[1]
    const competition = !!(
      top1 && top2
      && (top1.intentCode || top1.intent_code) !== (top2.intentCode || top2.intent_code)
      && top1.similarity < 0.95
      && (top1.similarity - top2.similarity) < 0.06
    )

    let followUp
    if (competition) {
      const options = top.slice(0, 3).map((r, i) => `${i + 1}. ${r.intentName || r.intentCode}`).join('\n')
      followUp = `您的问题可能属于以下几种，请回复序号（1/2/3）选择：\n${options}`
    } else {
      followUp = faq?.followUp || `您是想咨询"${result.intent_name}"吗？请回复"是"或"不是"`
    }

    return {
      matched: false,
      confidence: result.confidence,
      intent_code: null,
      intent_name: null,
      answer: followUp,
      source: 'clarify',
      candidates: top.slice(0, 3).map(r => ({
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

    // 构建上下文消息（系统提示词来自运营配置注册表，可后台覆盖）
    const messages = [
      { role: 'system', content: this.llmConfig.systemPrompt || getPrompt('faq_answer.system') },
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
   * 获取分类树形结构（兼容门面，委托 FaqService）
   */
  listCategories() {
    return this.faqService.listCategories()
  }

  /**
   * 获取指定分类下的 FAQ 列表（兼容门面，委托 FaqService）
   */
  listFAQByCategory(categoryId) {
    return this.faqService.listByCategory(categoryId)
  }

  /**
   * 获取 FAQ 列表（兼容门面，委托 FaqService）
   */
  listFAQ() {
    return this.faqService.listAll()
  }

  /**
   * 获取单个 FAQ 详情（兼容门面，委托 FaqService）
   */
  getFAQ(code) {
    return this.faqService.getByCode(code)
  }

  /**
   * 添加/更新 FAQ（兼容门面，委托 FaqService，含增量同步）
   */
  addFAQ(faqConfig) {
    return this.faqService.save(faqConfig)
  }

  /**
   * 删除 FAQ（兼容门面，委托 FaqService）
   */
  removeFAQ(code) {
    return this.faqService.remove(code)
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
   * 智能分析：获取优化建议（兼容门面，委托 statsService）
   */
  getAnalysis() {
    return this.statsService.getAnalysis()
  }
}

export default FAQEngine
