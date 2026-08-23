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
import { getReply } from './services/replyTexts.js'
import { getRouteChoiceWords } from './services/matchVocab.js'
import traceService from './services/traceService.js'

class FAQEngine {
  /**
   * @param {Object} options - 配置
   * @param {FaqService} options.faqService - 知识库领域服务（不传则自建）
   * @param {Object} options.statsService - 统计领域服务（不传则用默认模块）
   * @param {number} options.minConfidence - 最低匹配阈值（自建 faqService 时生效）
   * @param {number} options.clarifyThreshold - 追问确认阈值
   * @param {number} options.topK - 返回 Top K 结果（自建 faqService 时生效）
   * @param {Object} options.llm - 大模型配置
   * @param {number} options.faqCompeteCeiling - 候选竞争：top1 相似度上限（默认 0.95）
   * @param {number} options.faqCompeteGap - 候选竞争：top1-top2 差距下限（默认 0.06）
   * @param {number} options.llmRerankCeiling - LLM 意图重排触发上限（低于此值且候选≥2 才重排，默认 0.9）
   * @param {number} options.analysisMaxConfidence - 分析页低置信度过滤上限（默认 0.7）
   * @param {number} options.analysisRecommendThreshold - 分析页"加相似问"建议线（默认 0.3）
   */
  constructor(options = {}) {
    this.clarifyThreshold = options.clarifyThreshold ?? 0.65
    this.llmConfig = options.llm || { enabled: false }
    this.meaninglessDetectionMode = 'rule' // 'rule' 或 'llm'

    // 开放给运营的判定参数（sys_config 可配，routes/config.js 热更新）
    this.faqCompeteCeiling = options.faqCompeteCeiling ?? 0.95
    this.faqCompeteGap = options.faqCompeteGap ?? 0.06
    this.llmRerankCeiling = options.llmRerankCeiling ?? 0.9
    this.analysisMaxConfidence = options.analysisMaxConfidence ?? 0.7
    this.analysisRecommendThreshold = options.analysisRecommendThreshold ?? 0.3

    // 知识库领域服务（默认自建，便于独立使用引擎；server.js 显式注入共享实例）
    this.faqService = options.faqService || new FaqService({
      minConfidence: options.minConfidence ?? 0.5,
      topK: options.topK ?? 5,
      shortTextLen: options.shortTextLen ?? 4,
      shortRegexHit: options.shortRegexHit ?? 0.95,
      shortContainsHit: options.shortContainsHit ?? 0.9,
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
    
    // ===== [STEP 0] 轨迹追踪：本轮对话的处理步骤链（可视化调试用） =====
    const traceSteps = traceService.startTurn(sessionId)
    const _t = (step, detail = {}, level = 'info') => traceService.traceStep(traceSteps, step, detail, level)
    
    // ===== [STEP 1] 收到请求 =====
    console.log(`\n${'='.repeat(80)}`)
    console.log(`[CHAT-START] ${timestamp} | Session: ${sessionId} | User: ${userId || 'anonymous'}`)
    console.log(`[INPUT] "${text}"`)
    console.log(`${'='.repeat(80)}\n`)
    _t('收到输入', { text, sessionId, userId: userId || 'anonymous' })
    
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
        _t('无意义检测', { isMeaningless: true, score, reason }, 'warn')
        
        // 无意义输入，直接返回兜底回复，不进入意图识别
        const response = {
          intent_code: null,
          confidence: 0,
          source: 'meaningless',
          answer: getReply('meaningless')
        }
        
        console.log(`[OUTPUT] Source: ${response.source} | Answer: "${response.answer.substring(0, 50)}..."`)
        
        // 记录日志
        await this._logChat(sessionId, text, response, userId, Date.now() - startTime)
        
        if (opts.debug) this._attachDebug(response, sessionId)
        traceService.endTurn(sessionId, traceSteps, { input: text, output: response.answer, duration: Date.now() - startTime })
        console.log(`[CHAT-END] Duration: ${Date.now() - startTime}ms`)
        console.log(`${'='.repeat(80)}\n`)
        return response
      } else {
        console.log('[RESULT] ✅ 有意义输入，继续处理')
        _t('无意义检测', { isMeaningless: false })
      }
    }
    
    // 获取或创建会话上下文
    const context = this._getSession(sessionId)

    // 记录用户输入到历史
    context.history.push({ role: 'user', text, timestamp: Date.now() })

    let response

    // ===== 意图路由澄清待选（pendingRoute）：用户上轮被追问"办理还是咨询"，本轮回复选项 =====
    if (context.pendingRoute) {
      console.log('[ROUTE] 处理路由澄清选项:', text)
      const pending = context.pendingRoute
      const choice = this._parseRouteChoice(text)
      _t('路由澄清待选', { choice: choice || '未识别', pendingTask: pending.taskCode || null })

      if (choice === 'task') {
        // 用户选"办理"
        context.pendingRoute = null
        const hasActiveNow = this.taskEngine.hasActiveTask(sessionId)
        if (pending.suspended && hasActiveNow) {
          // 场景 A：恢复被挂起的任务
          this.taskEngine.resume(sessionId)
          const taskState = this.taskEngine.getActiveTask(sessionId)
          const unfilled = Object.entries(taskState.slots).filter(([_, s]) => s.required && !s.filled)
          const progressHint = unfilled.length
            ? getReply('progress_needed', { labels: unfilled.map(([_, s]) => s.label).join('、') })
            : getReply('progress_all_filled')
          response = {
            intent_code: `task:${taskState.taskCode}`,
            confidence: 1,
            source: 'task_resumed',
            answer: getReply('continue_task', { taskName: taskState.taskName, hint: progressHint }),
          }
        } else if (hasActiveNow) {
          // 场景 B：任务中插话拿不准，用户选择继续办理当前任务
          const taskState = this.taskEngine.getActiveTask(sessionId)
          const unfilled = Object.entries(taskState.slots).filter(([_, s]) => s.required && !s.filled)
          const progressHint = unfilled.length
            ? getReply('progress_needed', { labels: unfilled.map(([_, s]) => s.label).join('、') })
            : getReply('progress_all_filled')
          response = {
            intent_code: `task:${taskState.taskCode}`,
            confidence: 1,
            source: 'task_progress',
            answer: getReply('continue_task', { taskName: taskState.taskName, hint: progressHint }),
          }
        } else if (pending.taskCode) {
          // 场景 C：无任务时澄清 → 触发候选任务（用原始触发句）
          const def = await this.taskEngine.get(pending.taskCode)
          if (def) {
            const state = this.taskEngine.startTask(sessionId, def)
            const taskResult = await this.taskEngine.processInput(sessionId, pending.triggerText)
            response = {
              intent_code: `task:${def.code}`,
              confidence: 1,
              source: taskResult?.isComplete ? 'task_complete' : 'task_started',
              answer: taskResult?.reply || `好的，开始办理「${def.name}」。`,
            }
          }
        }
        if (!response) {
          response = {
            intent_code: null,
            confidence: 1,
            source: 'route',
            answer: getReply('ask_business'),
          }
        }
      } else if (choice === 'faq') {
        // 用户选"咨询"
        context.pendingRoute = null
        const faqResponse = await this._handleRecognize(pending.triggerText, context)
        if (faqResponse.source === 'direct' || faqResponse.source === 'confirmed') {
          // 有活跃任务（挂起或进行中）→ 附挂起提示
          const taskState = this.taskEngine.getActiveTask(sessionId)
          if (taskState) {
            this.taskEngine.suspend(sessionId)
            response = {
              ...faqResponse,
              answer: faqResponse.answer + this._suspendedHint(taskState),
              source: 'task_suspended_faq',
            }
          } else {
            response = faqResponse
          }
        } else {
          // FAQ 也没匹配到 → 兜底
          response = faqResponse
        }
      } else {
        // 未识别选项 → 重复澄清
        console.log('[ROUTE] 未识别澄清选项，重复追问')
        response = await this._buildRouteClarifyResponse(pending, /* repeat */ true)
      }
    }

    // ===== 意图路由 + 任务流程检查 =====
    // 任务引擎存在时，每轮输入先经路由判定通道，实现任务/FAQ 双向穿透：
    //   有活跃任务（含挂起）→ task_continue / task_new / faq / clarify 四选一
    //   无活跃任务        → 命中触发词则发起任务，否则 FAQ
    if (!response && this.taskEngine) {
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
            ? getReply('progress_needed', { labels: unfilled.map(([_, s]) => s.label).join('、') })
            : getReply('progress_all_filled')
          response = {
            intent_code: `task:${taskState.taskCode}`,
            confidence: 1,
            source: 'task_resumed',
            answer: getReply('continue_task', { taskName: taskState.taskName, hint: progressHint }),
          }
        } else {
          // 不是恢复词：可能是继续 FAQ 提问，或想换办别的事
          const route = await this.taskEngine.nlu.route(text, {
            taskState,
            tasks: [...this.taskEngine.taskDefs.values()],
            filledDesc: this._taskFilledDesc(taskState),
            trace: traceSteps,
          })
          if (route === 'task_new') {
            // 换办另一件事：中断暂存当前任务，走新任务流程
            await this.taskEngine.stash(sessionId)
            response = await this._tryStartTask(sessionId, text, context, /* fromStash */ true, traceSteps)
          } else if (route === 'clarify') {
            // 挂起状态下仍拿不准 → 追问（恢复办理 or 继续咨询）
            console.log('[ROUTE] 挂起中拿不准，追问用户')
            context.pendingRoute = {
              taskCode: taskState.taskCode,
              taskName: taskState.taskName,
              triggerText: text,
              suspended: true,
              askedAt: Date.now(),
            }
            response = await this._buildRouteClarifyResponse(context.pendingRoute, /* repeat */ false)
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

      // ---------- 场景 B：活跃任务（未挂起）→ 先任务对话（LLM 提取），失败才路由判定 ----------
      else if (hasActive) {
        console.log('[TASK] 检测到活跃任务，进入任务对话模式')
        const taskState = this.taskEngine.getActiveTask(sessionId)
        _t('有任务上下文', { taskCode: taskState.taskCode, status: taskState.status })

        // 任务进行中：先让任务对话（LLM 提取）判断——用户在回答槽位问题（电话/姓名/地址）时，
        // LLM 能理解裸回答（"18516237700"→电话、"我姓张"→姓名），不应与 FAQ 抢
        const taskResult = await this.taskEngine.processInput(sessionId, text)

        if (taskResult && (taskResult.extracted || taskResult.isComplete || taskResult.cancelled || taskResult.reask)) {
          // 任务内：提取到槽位/确认/取消/重问 → 直接用任务回复
          _t('任务内回复（LLM 提取）', { extracted: taskResult.extracted, isComplete: taskResult.isComplete, cancelled: taskResult.cancelled, reask: taskResult.reask })
          if (taskResult.question && taskResult.questionText) {
            // 边答边问：先 FAQ 回答问题，再接任务进度提示
            console.log('[TASK] 检测到边答边问，FAQ 回答:', taskResult.questionText)
            _t('边答边问（LLM 判 question）', { question: taskResult.questionText }, 'llm')
            const faqResponse = await this._handleRecognize(taskResult.questionText, context)
            if (faqResponse.source === 'direct' || faqResponse.source === 'confirmed') {
              response = {
                ...faqResponse,
                answer: faqResponse.answer + '\n' + taskResult.reply,
                source: 'task_faq',
              }
            } else {
              response = {
                intent_code: `task:${taskResult.taskState.taskCode}`,
                confidence: 1,
                source: 'task_progress',
                answer: taskResult.reply,
              }
            }
          } else {
            response = {
              intent_code: `task:${taskResult.taskState.taskCode}`,
              confidence: 1,
              source: taskResult.isComplete ? 'task_complete' : (taskResult.cancelled ? 'task_cancelled' : 'task_progress'),
              answer: taskResult.reply,
            }
          }
        } else {
          // LLM 提取失败（用户没说槽位、也没确认/取消）→ 可能是任务外（插话/换任务/澄清），用路由判定
          _t('任务对话未提取到槽位，转路由判定', {}, 'warn')
          const route = await this.taskEngine.nlu.route(text, {
            taskState,
            tasks: [...this.taskEngine.taskDefs.values()],
            filledDesc: this._taskFilledDesc(taskState),
            trace: traceSteps,
          })
          console.log(`[TASK] 提取失败后路由判定: ${route}`)
          _t('路由判定（任务外）', { route }, route === 'clarify' ? 'warn' : 'task')

          if (route === 'clarify') {
            // 拿不准：任务中插话无法区分是继续办理还是咨询 → 追问二选一
            console.log('[TASK] 路由拿不准，追问用户')
            context.pendingRoute = {
              taskCode: taskState.taskCode,
              taskName: taskState.taskName,
              triggerText: text,
              askedAt: Date.now(),
            }
            response = await this._buildRouteClarifyResponse(context.pendingRoute, /* repeat */ false)
          } else if (route === 'faq') {
            // 用户问知识（费用/故障/操作…）→ FAQ 通道 + 任务挂起
            console.log('[TASK] 路由→FAQ，任务挂起')
            _t('任务挂起（FAQ 插话）', { taskCode: taskState.taskCode })
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
              response = taskResult
                ? {
                    intent_code: `task:${taskResult.taskState.taskCode}`,
                    confidence: 1,
                    source: 'task_progress',
                    answer: taskResult.reply,
                  }
                : null
            }
          } else if (route === 'task_new') {
            // 用户想办另一件事 → 中断暂存当前任务，触发新任务
            console.log('[TASK] 路由→新任务，当前任务中断暂存')
            _t('切换新任务（当前中断暂存）', { taskCode: taskState.taskCode })
            await this.taskEngine.stash(sessionId)
            response = await this._tryStartTask(sessionId, text, context, /* fromStash */ true, traceSteps)
          } else if (route === 'out_of_scope') {
            // 任务中用户说域外话（"我家门坏了"）→ 不挂起，回任务继续引导（不打断办事）
            console.log('[TASK] 域外输入，继续任务引导')
            _t('域外输入 → 继续任务', {}, 'warn')
            response = taskResult
              ? {
                  intent_code: `task:${taskResult.taskState.taskCode}`,
                  confidence: 1,
                  source: 'task_progress',
                  answer: taskResult.reply,
                }
              : null
          } else {
            // task_continue → 用任务引擎的引导回复（提取失败但路由认为还在任务内）
            response = taskResult
              ? {
                  intent_code: `task:${taskResult.taskState.taskCode}`,
                  confidence: 1,
                  source: 'task_progress',
                  answer: taskResult.reply,
                }
              : null
          }
        }
      }

      // ---------- 场景 C：无活跃任务 → 路由判定后决定触发任务或 FAQ ----------
      else {
        // 无任务上下文时 route 判定：命中触发词且无咨询疑云 → task_new；
        // 咨询疑云（"上门换滤芯收费吗"）→ faq；两者混杂拿不准 → clarify 追问
        const route = await this.taskEngine.nlu.route(text, {
          taskState: null,
          tasks: [...this.taskEngine.taskDefs.values()],
          filledDesc: '',
          trace: traceSteps,
        })
        _t('路由判定', { route, hasActiveTask: false }, route === 'clarify' ? 'warn' : 'task')
        if (route === 'task_new') {
          response = await this._tryStartTask(sessionId, text, context, /* fromStash */ false, traceSteps)
        } else if (route === 'clarify') {
          // 无法区分任务还是咨询（触发词+咨询疑云混杂）→ 追问二选一
          console.log('[ROUTE] 无法区分任务/咨询，追问用户')
          _t('路由拿不准，追问用户二选一', {}, 'warn')
          const candTask = await this.taskEngine.matchTask(text, null, traceSteps)
          context.pendingRoute = {
            taskCode: candTask ? candTask.code : null,
            taskName: candTask ? candTask.name : '',
            triggerText: text,
            askedAt: Date.now(),
          }
          response = await this._buildRouteClarifyResponse(context.pendingRoute, /* repeat */ false)
        } else if (route === 'out_of_scope') {
          // 任务/FAQ 均未达强命中线（"我家门坏了"）→ 业务域外引导（不用 LLM 兜底）
          console.log('[ROUTE] 域外输入，业务引导')
          _t('域外输入 → 业务引导', {}, 'warn')
          response = await this._handleFallback(text, context, { confidence: 0 })
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

    // ===== 轨迹收尾 =====
    _t('生成回复', { source: response.source, intent: response.intent_code || null, confidence: response.confidence ?? null }, 'result')
    traceService.endTurn(sessionId, traceSteps, { input: text, output: response.answer, duration: Date.now() - startTime })

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
   * 注：场景 B 已内联此逻辑（先 LLM 提取、失败才路由判定），本方法保留备用
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
        const progressHint = getReply('task_faq_progress', { taskName: taskState.taskName, labels: unfilled.map(([_, s]) => s.label).join('、') })
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
   * @param {Array|null} traceSteps - 轨迹步骤数组（调试用，可选）
   */
  async _tryStartTask(sessionId, text, context, fromStash = false, traceSteps = null) {
    let matchedTask = await this.taskEngine.matchTask(text, null, traceSteps)
    // matchTask 有长度门槛（LLM≥3字/向量≥5字），短句如"安装"会被跳过；
    // 但 route() 仲裁已判任务胜出（例句向量无长度门槛）——回退用仲裁结果补上
    if (!matchedTask) {
      try {
        const arb = await this.taskEngine.nlu.arbitrateTaskFaq(text, {
          taskState: null,
          tasks: [...this.taskEngine.taskDefs.values()],
        })
        if (arb.channel === 'task_new' && arb.taskCode) {
          const def = await this.taskEngine.get(arb.taskCode)
          if (def) {
            matchedTask = def
            console.log(`[TASK] 仲裁回退触发任务: ${def.code} (${def.name})`)
          }
        }
      } catch (e) {
        console.error('[TASK] 仲裁回退失败:', e.message)
      }
    }
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
          answer = getReply('stashed_hint', { taskName: stashed.taskName }) + answer
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
    return getReply('suspended_hint', { taskName: taskState.taskName })
  }

  /** 解析路由澄清的用户选项回复 → 'task' | 'faq' | null */
  _parseRouteChoice(text) {
    const t = (text || '').trim()
    if (!t) return null
    const lower = t.toLowerCase()

    // 数字选项：1=办理 2=咨询（支持 "1" "1." "1、" 等）
    if (/^1[.、．，,。]?\s*$/.test(t)) return 'task'
    if (/^2[.、．，,。]?\s*$/.test(t)) return 'faq'

    // 语义关键词（运营可配：sys_config match_vocab）
    const words = getRouteChoiceWords()
    const taskWords = words.task
    const faqWords = words.faq

    if (taskWords.some(w => lower.includes(w))) return 'task'
    if (faqWords.some(w => lower.includes(w))) return 'faq'
    return null
  }

  /** 构建路由澄清话术响应
   *  优先级：任务定义里的 clarify_question/clarify_options（管理后台任务编辑器配置）
   *          → 回退全局模板 router.clarify（管理后台「LLM 智能层」可编辑）
   *  注意：与 FAQ 追问确认的 _buildClarifyResponse 是不同机制，勿混用 */
  async _buildRouteClarifyResponse(pending, repeat = false) {
    // 优先取任务级澄清配置
    let question = ''
    let options = []
    if (pending.taskCode) {
      try {
        const taskDef = await this.taskEngine.get(pending.taskCode)
        if (taskDef) {
          question = taskDef.clarify_question || ''
          options = Array.isArray(taskDef.clarify_options) ? taskDef.clarify_options : []
        }
      } catch { /* 任务不存在则回退全局模板 */ }
    }

    let tpl
    if (question && options.length > 0) {
      // 任务级：自定义话术 + 自定义选项（与 _parseRouteChoice 一致，取前 2 项：1=办理 2=咨询）
      const opts = options.slice(0, 2)
      const optText = opts.map((o, i) => `${i + 1}. ${o}`).join('\n')
      tpl = `${question}\n请回复对应数字：\n${optText}`
    } else {
      // 回退全局模板
      const taskName = pending.taskName || '相关业务'
      tpl = getPrompt('router.clarify', { taskName })
    }
    return {
      intent_code: pending.taskCode ? `task:${pending.taskCode}` : null,
      confidence: 1,
      source: 'route_clarify',
      answer: (repeat ? getReply('route_clarify_repeat_prefix') : '') + tpl,
    }
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
      if (this.llmConfig?.enabled && result.confidence < this.llmRerankCeiling && (result.top_results?.length || 0) >= 2) {
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
        && top1.similarity < this.faqCompeteCeiling
        && (top1.similarity - top2.similarity) < this.faqCompeteGap
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
          answer: getReply('no_answer')
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
      && top1.similarity < this.faqCompeteCeiling
      && (top1.similarity - top2.similarity) < this.faqCompeteGap
    )

    let followUp
    if (competition) {
      const options = top.slice(0, 3).map((r, i) => `${i + 1}. ${r.intentName || r.intentCode}`).join('\n')
      followUp = getReply('clarify_options', { options })
    } else {
      followUp = faq?.followUp || getReply('clarify_yes_no', { intentName: result.intent_name })
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
   * 处理未匹配情况（方案 A：不用 LLM 兜底，识别为业务域外）
   * 任务和 FAQ 都没匹配上 → 大概率与客服业务无关（"习近平是谁"/天气/闲聊），
   * 不浪费 LLM 资源去答域外问题，直接给业务边界引导。
   */
  async _handleFallback(text, context, result) {
    // ===== [STEP 4.3.1] 业务域外识别 =====
    console.log('[STEP 4.3.1] 任务/FAQ 均未匹配，判定为业务域外')
    const fallbackResponse = {
      matched: false,
      confidence: result?.confidence || 0,
      intent_code: null,
      intent_name: null,
      answer: getReply('domain_fallback'),
      source: 'fallback',
      related: ['怎么预约上门服务', '滤芯多久换一次', '机器不出水怎么办'],
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
      // 意图路由澄清：{ taskCode, taskName, askedAt } —— 路由拿不准时等用户二选一
      pendingRoute: null,
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
    return this.statsService.getAnalysis(this.analysisMaxConfidence)
  }
}

export default FAQEngine
