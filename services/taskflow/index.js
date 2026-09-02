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
import llmClient, { DEFAULT_LLM_NODES } from '../llmClient.js'
import nlu from './nlu.js'
import traceService from '../traceService.js'
import { ensureActionLogTable } from './actionRegistry.js'
import { TaskState, validateTransitions } from './stateMachine.js'
import * as configRepo from '../../repositories/configRepo.js'
import instanceStore from './instanceStore.js'

const SESSION_TTL = 30 * 60 * 1000 // 30 分钟（默认；运营可通过 sys_config.task_session_ttl_minutes 覆盖）

class TaskFlowEngine {
  constructor() {
    /** @type {Map<string, Object>} sessionId -> 任务状态（内存镜像，权威态） */
    this.activeTasks = new Map()

    /** 任务定义（code → def），委托 taskDefs 单例 */
    this.taskDefs = TaskDefs.defs

    // 理解层（意图判定/槽位提取）
    this.nlu = nlu
    // 规则版对话管理器（确定性骨架）
    this.dialog = new DialogManager(TaskDefs, nlu)

    /** @type {import('./store.js').MemoryStore|import('./store.js').RedisStore|null} */
    this.store = null
    this.sessionTtl = SESSION_TTL

    // LLM 智能层
    this.llm = llmClient
  }

  /**
   * 设置任务会话超时（分钟；运营配置 sys_config.task_session_ttl_minutes，保存即生效）
   * 影响：任务状态持久化 TTL + 过期清理（cleanupStale）
   */
  setSessionTtl(minutes) {
    const n = parseInt(minutes, 10)
    if (!isNaN(n) && n > 0) {
      this.sessionTtl = n * 60 * 1000
      console.log(`[TaskFlow] 任务会话超时: ${n} 分钟`)
    }
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

    // 1.5) 动作输出审计表（action_log）
    await ensureActionLogTable()

    // 1.6) 任务实例表（task_instance）
    await instanceStore.ensureTable()

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
  startTask(sessionId, taskDef, trace = null, triggerText = '', userId = null) {
    const state = {
      sessionId,
      taskCode: taskDef.code,
      taskName: taskDef.name,
      userId,
      status: TaskState.COLLECTING,
      currentStep: taskDef.steps[0]?.key || null,
      slots: this.dialog.initSlots(taskDef),
      stack: [],
      turnCount: 0,
      skipCount: 0,
      startedAt: Date.now(),
      lastActive: Date.now(),
    }
    this.activeTasks.set(sessionId, state)
    this._persist(sessionId, state)
    traceService.traceStep(trace, '任务开始', { taskCode: taskDef.code, taskName: taskDef.name }, 'task')
    console.log(`[TaskFlow] 任务开始: ${taskDef.code} (${taskDef.name}) @ session ${sessionId}`)

    // 写入任务实例记录
    instanceStore.create({
      sessionId,
      taskCode: taskDef.code,
      taskName: taskDef.name,
      triggerText,
      userId,
    }).then(id => {
      state._instanceId = id
    }).catch(e => {
      console.warn('[TaskFlow] 写入任务实例失败:', e.message)
    })

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
      console.log(`[DEBUG taskEngine.processInput] 任务不存在或状态不符: sessionId=${sessionId}, state=${state ? state.status : 'null'}`)
      return null
    }
    
    console.log(`[DEBUG taskEngine.processInput] 开始处理: sessionId=${sessionId}, text="${text}"`)
    console.log(`[DEBUG taskEngine.processInput] 当前步骤: ${state.currentStep}, 状态: ${state.status}`)
    console.log(`[DEBUG taskEngine.processInput] 已填槽位:`, Object.entries(state.slots || {})
      .filter(([_, s]) => s && s.filled)
      .map(([k, v]) => `${k}=${v.value}`)
      .join(', '))
    
    const _t = (step, detail = {}, level = 'info') => traceService.traceStep(trace, step, detail, level)

    // 纯规则引擎对话（dialogManager）
    _t('任务对话·模式', {
      taskCode: state.taskCode,
      mode: 'rule',
    }, 'info')
    const result = await this.dialog.processTurn(state, text, trace)

    // 更新任务实例
    this._updateInstance(state, result)

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
   * 中断当前任务（用户换办另一件事）：把进度压入暂存栈，从 activeTasks 移除。
   * 暂存栈支持多级暂存（LIFO）：最近被中断的优先恢复。
   * 新任务结束后可 popStashed() 恢复继续。
   */
  async stash(sessionId, trace = null) {
    const state = this.activeTasks.get(sessionId)
    if (!state) return false
    state.suspended = true
    state.suspendedAt = Date.now()
    if (this.store) {
      try {
        // 读取现有栈（数组），push 当前状态
        let stack = await this.store.get(`taskflow:stash:${sessionId}`) || []
        if (!Array.isArray(stack)) stack = [stack] // 兼容旧版单条存储
        stack.push(state)
        await this.store.set(`taskflow:stash:${sessionId}`, stack, this.sessionTtl)
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

  /** 读取暂存栈顶的任务状态（不弹出） */
  async getStashed(sessionId) {
    if (!this.store) return null
    try {
      const stack = await this.store.get(`taskflow:stash:${sessionId}`)
      if (!stack) return null
      if (Array.isArray(stack)) return stack.length > 0 ? stack[stack.length - 1] : null
      return stack // 兼容旧版单条存储
    } catch (e) {
      return null
    }
  }

  /** 恢复暂存栈顶的任务（回到 activeTasks） */
  async popStashed(sessionId, trace = null) {
    let stack = null
    if (this.store) {
      try {
        stack = await this.store.get(`taskflow:stash:${sessionId}`)
      } catch (e) {
        console.error('[TaskFlow] 暂存任务读取失败:', e.message)
      }
    }
    if (!stack) return null
    if (!Array.isArray(stack)) stack = [stack] // 兼容旧版单条存储
    if (stack.length === 0) return null
    const state = stack.pop() // LIFO：弹出栈顶（最近暂存的）
    state.suspended = false
    state.suspendedAt = null
    this.activeTasks.set(sessionId, state)
    try {
      if (stack.length > 0) {
        await this.store.set(`taskflow:stash:${sessionId}`, stack, this.sessionTtl)
      } else {
        await this.store.del(`taskflow:stash:${sessionId}`)
      }
    } catch { /* ignore */ }
    traceService.traceStep(trace, '任务恢复暂存', { taskCode: state.taskCode }, 'task')
    console.log(`[TaskFlow] 恢复暂存任务: ${state.taskCode} @ session ${sessionId}（栈剩余 ${stack.length} 个）`)
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

  // ========== 任务实例跟踪 ==========

  /**
   * 更新任务实例记录（每轮对话后调用）
   */
  _updateInstance(state, result) {
    if (!state._instanceId) return
    const fields = {
      currentStep: state.currentStep,
      turnCount: state.turnCount,
    }
    // 槽位快照（只取已填值）
    const slotSnapshot = {}
    if (state.slots) {
      for (const [k, s] of Object.entries(state.slots)) {
        slotSnapshot[k] = { label: s.label, value: s.value, filled: !!s.filled }
      }
    }
    fields.slots = slotSnapshot

    // 状态同步
    if (result.isComplete) {
      fields.status = state.status === TaskState.TRANSFERRED ? 'transferred' : 'done'
      fields.finishedAt = new Date()
    } else if (result.cancelled) {
      fields.status = 'cancelled'
      fields.finishedAt = new Date()
    } else if (state.suspended) {
      fields.status = 'suspended'
    } else {
      fields.status = state.status
    }

    instanceStore.update(state._instanceId, fields).catch(e => {
      console.warn('[TaskFlow] 更新任务实例失败:', e.message)
    })
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
