/**
 * TaskFlow 任务型对话引擎（v2）
 *
 * 入口对外契约（与 v1 taskEngine 兼容，faq-engine.js 集成点不变）：
 *   initialize()                         启动：建表 + 加载定义 + 初始化存储 + 恢复会话
 *   matchTask(text)                      触发词匹配 → taskDef | null（同步）
 *   startTask(sessionId, taskDef)        开始任务 → taskState（同步，异步持久化）
 *   processInput(sessionId, text)        处理一轮任务对话 → 信封（异步）
 *   hasActiveTask(sessionId)             是否有进行中的任务（同步）
 *   getActiveTask(sessionId)             获取任务状态（同步）
 *   list()/get()/save()/remove()/toggleStatus()  任务定义 CRUD（供路由）
 *   cleanupStale()                       清理过期会话
 *
 * 架构：taskDefs（定义/迁移）+ dialogManager（DST/Policy）+ store（持久化）
 */

import { getStore, closeStore } from './store.js'
import TaskDefs from './taskDefs.js'
import DialogManager from './dialogManager.js'
import LLMDialogManager from './llmDialogManager.js'
import llmClient, { DEFAULT_LLM_NODES } from '../llmClient.js'
import nlu from './nlu.js'
import traceService from '../traceService.js'
import { TaskState, validateTransitions } from './stateMachine.js'
import * as configRepo from '../../repositories/configRepo.js'

const SESSION_TTL = 30 * 60 * 1000 // 30 分钟

class TaskFlowEngine {
  constructor() {
    /** @type {Map<string, Object>} sessionId -> 任务状态（内存镜像，权威态） */
    this.activeTasks = new Map()

    /** 任务定义（code → def），委托 taskDefs 单例 */
    this.taskDefs = TaskDefs.defs

    // 理解层（意图判定/槽位提取，可插拔模式：rule/hybrid/llm）
    this.nlu = nlu
    // 规则版对话管理器（确定性骨架，LLM 不可用时降级用）
    this.dialog = new DialogManager(TaskDefs, nlu)
    // LLM 驱动对话管理器（llm/hybrid 模式主用）
    this.llmDialog = new LLMDialogManager(TaskDefs, nlu)

    /** @type {import('./store.js').MemoryStore|import('./store.js').RedisStore|null} */
    this.store = null
    this.sessionTtl = SESSION_TTL

    // LLM 智能层
    this.llm = llmClient
  }

  /**
   * 注入共享 NLP 引擎（复用 FAQ 识别器已加载的模型，避免二次加载），并重建意图例句向量
   */
  async setNlpEngine(nlpEngine) {
    nlu.setNlpEngine(nlpEngine)
    await nlu.refreshVectors(this.taskDefs)
    console.log('[TaskFlow] 已接入语义触发（意图例句向量）')
  }

  /** 设置理解模式（rule/hybrid/llm），返回是否成功 */
  setNluMode(mode) {
    return nlu.setMode(mode)
  }

  /** 运行时更新 LLM 配置（管理后台保存后调用） */
  setLlmConfig(cfg) {
    this.llm.configure(cfg)
    return this.llm.enabled
  }

  async initialize(options = {}) {
    console.log('[TaskFlow] 初始化任务引擎...')

    // 状态机一致性自检
    const errors = validateTransitions()
    if (errors.length > 0) console.error('[TaskFlow] 状态机配置错误:', errors)

    // 1) 表结构（含 v2 steps 列与 intent_examples 意图例句）
    await TaskDefs.ensureTable()

    // 2) 加载任务定义（含 v1 → v2 迁移）
    const count = await TaskDefs.loadTasks()
    console.log(`[TaskFlow] 已加载 ${count} 个任务定义`)

    // 3) 初始化持久化存储
    this.store = await getStore({
      driver: options.storeDriver,
      url: process.env.REDIS_URL || options.redisUrl,
      ttl: this.sessionTtl,
    })

    // 4) 加载 LLM / NLU 配置（sys_config，环境变量 DEEPSEEK_API_KEY 兜底自动启用）
    try {
      const dbConfig = await configRepo.getAll()
      this.llm.configure(this.llm.resolveFromDb(dbConfig))
      // 调用节点配置（llm_nodes 首次自动落库，之后以库为准）
      try {
        if (dbConfig.llm_nodes) this.llm.setNodes(JSON.parse(dbConfig.llm_nodes))
        else {
          this.llm.setNodes()
          await configRepo.set('llm_nodes', JSON.stringify(DEFAULT_LLM_NODES))
        }
      } catch (e) {
        console.warn('[TaskFlow] 解析 llm_nodes 失败，使用默认节点配置:', e.message)
      }
      if (dbConfig.nlu_mode) nlu.setMode(dbConfig.nlu_mode)
      else nlu.setMode(options.nluMode || process.env.NLU_MODE || 'hybrid')
      // 任务/FAQ 统一仲裁阈值（运营在管理后台配置，sys_config 存储）
      nlu.setArbConfig({
        gap: dbConfig.arb_gap,
        taskMin: dbConfig.arb_task_min,
        faqMin: dbConfig.arb_faq_min,
        strongHit: dbConfig.arb_strong_hit,
        vectorThreshold: dbConfig.arb_vector_threshold,
        taskBoost: dbConfig.arb_task_boost,
        vecMinLen: dbConfig.task_vec_min_len,
      })
    } catch (e) {
      console.warn('[TaskFlow] LLM 配置读取失败，使用规则模式:', e.message)
    }

    // 5) 恢复未完成任务（Redis 场景：重启后继续）
    if (this.store && typeof this.store.keys === 'function') {
      try {
        const keys = await this.store.keys('taskflow:session:*')
        let restored = 0
        for (const key of keys) {
          const state = await this.store.get(key)
          if (state && state.status === TaskState.COLLECTING || (state && state.status === TaskState.CONFIRMING)) {
            this.activeTasks.set(state.sessionId, state)
            restored++
          }
        }
        if (restored > 0) console.log(`[TaskFlow] 已恢复 ${restored} 个进行中的任务会话`)
      } catch (e) {
        console.error('[TaskFlow] 恢复会话失败:', e.message)
      }
    }

    console.log('[TaskFlow] 初始化完成')
    return true
  }

  // ========== 触发与开始 ==========

  /**
   * 匹配任务触发条件（委托理解层：关键词+近义 → 意图例句向量 → LLM 判定）
   * @param {string} text
   * @param {string|null} currentCode - 进行中的任务（排除自身重复触发）
   * @returns {Promise<Object|null>} 任务定义
   */
  async matchTask(text, currentCode = null, trace = null) {
    return nlu.matchTask(text, [...this.taskDefs.values()], currentCode, trace)
  }

  /**
   * 开始一个任务
   * @param {string} sessionId
   * @param {Object} taskDef
   * @param {Array|null} trace - 轨迹步骤数组（调试用，可选）
   * @returns {Object} taskState
   */
  startTask(sessionId, taskDef, trace = null) {
    const state = {
      sessionId,
      taskCode: taskDef.code,
      taskName: taskDef.name,
      status: TaskState.COLLECTING,
      currentStep: taskDef.steps[0]?.key || null,
      slots: this.dialog.initSlots(taskDef),
      stack: [],
      turnCount: 0,
      skipCount: 0,
      // LLM 驱动对话的对话历史（最近若干轮，仅 llmDialog 使用）
      history: [],
      startedAt: Date.now(),
      lastActive: Date.now(),
    }
    this.activeTasks.set(sessionId, state)
    this._persist(sessionId, state)
    traceService.traceStep(trace, '任务开始', { taskCode: taskDef.code, taskName: taskDef.name }, 'task')
    console.log(`[TaskFlow] 任务开始: ${taskDef.code} (${taskDef.name}) @ session ${sessionId}`)
    return state
  }

  /**
   * 处理一轮任务对话
   * @param {string} sessionId
   * @param {string} text
   * @param {Array|null} trace - 轨迹步骤数组（调试用，可选）
   * @returns {Promise<Object|null>} 信封 { reply, isComplete, extracted, reask, cancelled, question, questionText, taskState }
   */
  async processInput(sessionId, text, trace = null) {
    const state = this.activeTasks.get(sessionId)
    if (!state || (state.status !== TaskState.COLLECTING && state.status !== TaskState.CONFIRMING)) {
      return null
    }
    const _t = (step, detail = {}, level = 'info') => traceService.traceStep(trace, step, detail, level)

    // LLM 驱动对话（llm/hybrid 模式且 LLM 可用，且该任务未关闭 LLM）；失败自动降级回规则版
    const taskDef = this.taskDefs.get(state.taskCode)
    const useLlmDialog = (this.nlu.mode === 'llm' || this.nlu.mode === 'hybrid')
      && this.llm.nodeEnabled('dialogue', taskDef?.llm || null)
    _t('任务对话·模式选择', {
      taskCode: state.taskCode,
      mode: useLlmDialog ? 'llm' : 'rule',
      nluMode: this.nlu.mode,
      dialogueNodeEnabled: this.llm.nodeEnabled('dialogue', taskDef?.llm || null),
      taskLlmEnabled: taskDef?.llm ? taskDef.llm.enabled !== false : null,
      taskLlmConfig: taskDef?.llm ? Object.keys(taskDef.llm) : null,
    }, useLlmDialog ? 'llm' : 'rule')
    let result = null
    if (useLlmDialog) {
      try {
        result = await this.llmDialog.processTurn(state, text, trace)
      } catch (e) {
        console.error(`[TaskFlow] LLM 对话失败，降级规则模式: ${e.message}`)
        _t('任务对话·LLM 失败，降级规则模式', { message: e.message }, 'error')
        result = await this.dialog.processTurn(state, text, trace)
      }
    } else {
      result = await this.dialog.processTurn(state, text, trace)
    }

    if (result.isComplete || result.cancelled) {
      this.activeTasks.delete(sessionId)
      await this._remove(sessionId)
    } else {
      // 子任务切换时 taskCode 可能变化，持久化最新状态
      this.activeTasks.set(sessionId, state)
      await this._persist(sessionId, state)
    }

    return result
  }

  // ========== 查询 ==========

  hasActiveTask(sessionId) {
    const state = this.activeTasks.get(sessionId)
    return !!(state && (state.status === TaskState.COLLECTING || state.status === TaskState.CONFIRMING))
  }

  getActiveTask(sessionId) {
    return this.activeTasks.get(sessionId) || null
  }

  // ========== 任务挂起/恢复（FAQ 插话双向穿透） ==========

  /**
   * 挂起任务：用户中途问 FAQ 时保留槽位进度，标记 interrupted
   * 挂起后任务仍在 activeTasks 中，但 faq-engine 路由到 FAQ 通道回答；
   * 用户回复恢复词（继续/接着办…）后 resume() 回到任务通道。
   */
  suspend(sessionId, trace = null) {
    const state = this.activeTasks.get(sessionId)
    if (!state) return false
    state.suspended = true
    state.suspendedAt = Date.now()
    this._persist(sessionId, state)
    traceService.traceStep(trace, '任务挂起', { taskCode: state.taskCode }, 'task')
    console.log(`[TaskFlow] 任务挂起: ${state.taskCode} @ session ${sessionId}`)
    return true
  }

  /** 恢复任务（用户说"继续"等恢复词） */
  resume(sessionId, trace = null) {
    const state = this.activeTasks.get(sessionId)
    if (!state) return false
    state.suspended = false
    state.suspendedAt = null
    this._persist(sessionId, state)
    traceService.traceStep(trace, '任务恢复', { taskCode: state.taskCode }, 'task')
    console.log(`[TaskFlow] 任务恢复: ${state.taskCode} @ session ${sessionId}`)
    return true
  }

  /** 是否有被挂起的任务 */
  isSuspended(sessionId) {
    const state = this.activeTasks.get(sessionId)
    return !!(state && state.suspended)
  }

  /**
   * 中断当前任务（用户换办另一件事）：把进度暂存到 store，从 activeTasks 移除。
   * 新任务结束后可 popStashed() 恢复继续。
   */
  async stash(sessionId, trace = null) {
    const state = this.activeTasks.get(sessionId)
    if (!state) return false
    state.suspended = true
    state.suspendedAt = Date.now()
    if (this.store) {
      try {
        await this.store.set(`taskflow:stash:${sessionId}`, state, this.sessionTtl)
      } catch (e) {
        console.error('[TaskFlow] 任务暂存失败:', e.message)
      }
    }
    this.activeTasks.delete(sessionId)
    traceService.traceStep(trace, '任务中断暂存', { taskCode: state.taskCode }, 'task')
    console.log(`[TaskFlow] 任务中断暂存: ${state.taskCode} @ session ${sessionId}`)
    return true
  }

  /** 是否有暂存的任务可恢复 */
  async hasStashed(sessionId) {
    return !!(await this.getStashed(sessionId))
  }

  /** 读取暂存的任务状态（不弹出） */
  async getStashed(sessionId) {
    if (!this.store) return null
    try {
      return await this.store.get(`taskflow:stash:${sessionId}`) || null
    } catch (e) {
      return null
    }
  }

  /** 恢复暂存的任务（回到 activeTasks） */
  async popStashed(sessionId, trace = null) {
    let state = null
    if (this.store) {
      try {
        state = await this.store.get(`taskflow:stash:${sessionId}`)
      } catch (e) {
        console.error('[TaskFlow] 暂存任务读取失败:', e.message)
      }
    }
    if (!state) return null
    state.suspended = false
    state.suspendedAt = null
    this.activeTasks.set(sessionId, state)
    try { await this.store.del(`taskflow:stash:${sessionId}`) } catch { /* ignore */ }
    traceService.traceStep(trace, '任务恢复暂存', { taskCode: state.taskCode }, 'task')
    console.log(`[TaskFlow] 恢复暂存任务: ${state.taskCode} @ session ${sessionId}`)
    return state
  }

  /**
   * 调试快照：查看某个会话的任务状态（前端调试用）
   */
  getDebugInfo(sessionId) {
    const state = this.activeTasks.get(sessionId)
    if (!state) return { active: false, sessionId }
    return {
      active: true,
      sessionId,
      taskCode: state.taskCode,
      taskName: state.taskName,
      status: state.status,
      currentStep: state.currentStep,
      turnCount: state.turnCount,
      skipCount: state.skipCount || 0,
      pendingModify: state.pendingModify || null,
      stack: (state.stack || []).map(p => ({
        taskCode: p.taskCode,
        taskName: p.taskName,
        currentStep: p.currentStep,
      })),
      slots: Object.entries(state.slots).map(([k, s]) => ({
        key: k,
        label: s.label || k,
        value: s.value,
        filled: !!s.filled,
        required: !!s.required,
      })),
    }
  }

  // ========== 持久化 ==========

  async _persist(sessionId, state) {
    if (!this.store) return
    try {
      await this.store.set(`taskflow:session:${sessionId}`, state, this.sessionTtl)
    } catch (e) {
      console.error('[TaskFlow] 状态持久化失败:', e.message)
    }
  }

  async _remove(sessionId) {
    if (!this.store) return
    try {
      await this.store.del(`taskflow:session:${sessionId}`)
    } catch (e) {
      console.error('[TaskFlow] 状态删除失败:', e.message)
    }
  }

  // ========== 清理与关闭 ==========

  /** 清理过期会话（定时调用） */
  async cleanupStale() {
    const now = Date.now()
    const timeout = this.sessionTtl
    for (const [id, state] of this.activeTasks) {
      if (now - state.lastActive > timeout) {
        this.activeTasks.delete(id)
        await this._remove(id)
      }
    }
    // 内存存储的 TTL 清扫
    this.store?.sweep?.()
  }

  /** 关闭存储连接（服务退出时） */
  async stop() {
    await closeStore()
  }

  // ========== 任务定义 CRUD（委托 taskDefs，供路由） ==========

  list() {
    return TaskDefs.list()
  }

  async get(code) {
    return TaskDefs.get(code)
  }

  async save(def) {
    const check = TaskDefs.validateDef(def)
    if (!check.ok) {
      const err = new Error('任务定义校验失败: ' + check.errors.join('；'))
      err.statusCode = 400
      throw err
    }
    const result = await TaskDefs.save(def)
    await nlu.refreshVectors(this.taskDefs)
    return result
  }

  async remove(code) {
    const result = await TaskDefs.remove(code)
    await nlu.refreshVectors(this.taskDefs)
    return result
  }

  async toggleStatus(code, status) {
    const result = await TaskDefs.toggleStatus(code, status)
    await nlu.refreshVectors(this.taskDefs)
    return result
  }
}

export default new TaskFlowEngine()
