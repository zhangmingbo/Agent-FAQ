/**
 * TaskFlow 任务型对话引擎（v3 - 纯解释器版）
 * 
 * 设计理念:
 * - 画布即代码,所有逻辑在JSON DSL中定义
 * - 无智能提取,用户输入直接赋值给变量
 * - 无语义理解,条件判断基于显式表达式
 * - 完全可预测,易于调试和维护
 * 
 * 核心变化:
 * - 移除 DialogManager (976行复杂状态机)
 * - 移除 NLU/NER 智能提取
 * - 使用 SimpleFlowEngine (150行纯解释器)
 */

import simpleEngine from './simpleEngine.js'
import TaskDefs from './taskDefs.js'
import { getStore, closeStore } from './store.js'
import traceService from '../traceService.js'
import * as configRepo from '../../repositories/configRepo.js'

const SESSION_TTL = 30 * 60 * 1000 // 30分钟

class TaskFlowEngine {
  constructor() {
    // 任务定义(code -> def)
    this.taskDefs = TaskDefs.defs
    
    // 使用新的简单引擎
    this.engine = simpleEngine
    
    // 存储层(Redis或内存)
    this.store = null
    this.sessionTtl = SESSION_TTL
  }

  /**
   * 初始化引擎
   */
  async initialize() {
    console.log('[TaskFlow v3] 初始化纯解释器引擎...')
    
    // 加载任务定义
    await TaskDefs.loadTasks()
    console.log(`[TaskFlow v3] 已加载 ${this.taskDefs.size} 个任务`)
    
    // 初始化存储
    const storeType = process.env.TASKFLOW_STORE || 'memory'
    if (storeType === 'redis') {
      this.store = await getStore('redis')
      console.log('[TaskFlow v3] 使用 Redis 存储')
    } else {
      this.store = await getStore('memory')
      console.log('[TaskFlow v3] 使用内存存储')
    }
    
    console.log('[TaskFlow v3] 初始化完成')
  }

  /**
   * 匹配任务(根据触发词)
   * @param {string} text - 用户输入
   * @returns {object|null} 任务定义或null
   */
  matchTask(text) {
    const defs = Array.from(this.taskDefs.values())
    
    for (const def of defs) {
      const keywords = def.trigger_keywords || []
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          return def
        }
      }
    }
    
    return null
  }

  /**
   * 启动任务
   * @param {string} sessionId - 会话ID
   * @param {object} taskDef - 任务定义
   * @returns {object} 任务状态
   */
  startTask(sessionId, taskDef) {
    const state = {
      taskId: taskDef.code,
      taskName: taskDef.name,
      startedAt: Date.now(),
      variables: {},
      currentStep: taskDef.steps[0]?.key || null
    }
    
    // 保存到存储
    if (this.store) {
      this.store.set(`task:${sessionId}`, state, this.sessionTtl)
    }
    
    return state
  }

  /**
   * 处理用户输入
   * @param {string} sessionId - 会话ID
   * @param {string} text - 用户输入
   * @returns {object} { reply, isComplete, variables }
   */
  async processInput(sessionId, text) {
    // 获取任务定义(从当前活跃任务或重新匹配)
    let taskDef = null
    
    // 尝试从存储恢复任务状态
    if (this.store) {
      const state = await this.store.get(`task:${sessionId}`)
      if (state) {
        taskDef = this.taskDefs.get(state.taskId)
      }
    }
    
    // 如果没有活跃任务,尝试匹配
    if (!taskDef && text) {
      taskDef = this.matchTask(text)
    }
    
    if (!taskDef) {
      return {
        reply: '未找到匹配的任务',
        isComplete: true,
        variables: {}
      }
    }
    
    // 执行流程引擎
    const result = await this.engine.execute(sessionId, taskDef, text)
    
    // 保存状态到存储
    if (this.store && result.variables) {
      const state = await this.store.get(`task:${sessionId}`) || {}
      state.variables = result.variables
      state.lastActive = Date.now()
      await this.store.set(`task:${sessionId}`, state, this.sessionTtl)
    }
    
    return result
  }

  /**
   * 检查是否有活跃任务
   */
  hasActiveTask(sessionId) {
    if (!this.store) return false
    return this.store.get(`task:${sessionId}`).then(s => !!s)
  }

  /**
   * 获取活跃任务状态
   */
  async getActiveTask(sessionId) {
    if (!this.store) return null
    return await this.store.get(`task:${sessionId}`)
  }

  /**
   * 清理过期会话
   */
  async cleanupStale() {
    if (this.store && this.store.cleanup) {
      await this.store.cleanup()
    }
  }

  /**
   * 停止引擎
   */
  async stop() {
    if (this.store) {
      await closeStore(this.store)
    }
  }
  
  list() {
    return Array.from(this.taskDefs.values())
  }

  get(code) {
    return this.taskDefs.get(code) || null
  }

  async save(taskDef) {
    await TaskDefs.save(taskDef)
    this.taskDefs.set(taskDef.code, taskDef)
    return taskDef
  }

  async remove(code) {
    await TaskDefs.remove(code)
    this.taskDefs.delete(code)
  }

  async toggleStatus(code) {
    const def = this.taskDefs.get(code)
    if (def) {
      def.status = def.status === 1 ? 0 : 1
      await this.save(def)
    }
  }

  setSessionTtl(minutes) {
    this.sessionTtl = minutes * 60 * 1000
  }

  // ========== 兼容旧API(空实现,避免server.js报错) ==========
  
  setNlpEngine() {
    // v3 不需要 NLP 引擎,纯解释执行
    console.log('[TaskFlow v3] setNlpEngine 被忽略(v3不使用NLP)')
  }
  
  get nlu() {
    // 兼容 faq-engine.js 中的 taskEngine.nlu 访问
    return {
      setFaqSamples: () => {} // 空实现
    }
  }
}

// 导出单例
export default new TaskFlowEngine()
