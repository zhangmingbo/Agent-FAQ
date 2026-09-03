/**
 * 规则配置加载器
 * 职责：从数据库加载规则配置，提供缓存和热更新能力
 * 解耦点：不依赖业务引擎，可独立测试
 */

import pool from '../db/pool.js'
import dialogueRules from './dialogueRules.js'

class RuleLoader {
  constructor() {
    this.cache = null
    this.lastLoadTime = 0
    this.cacheDuration = 60 * 1000 // 1分钟缓存
    this.autoRefreshInterval = null
  }

  /**
   * 初始化加载器（启动时调用）
   */
  async initialize() {
    console.log('[RuleLoader] 初始化规则加载器...')
    
    // 首次加载规则
    await this.loadRules()
    
    // 启动自动刷新（每5分钟检查一次）
    this.autoRefreshInterval = setInterval(() => {
      this._checkForUpdates().catch(e => {
        console.error('[RuleLoader] 自动刷新失败:', e.message)
      })
    }, 5 * 60 * 1000)
    
    console.log('[RuleLoader] 初始化完成')
  }

  /**
   * 加载规则配置
   * @param {boolean} forceReload - 是否强制重新加载（忽略缓存）
   * @returns {Object} 规则配置
   */
  async loadRules(forceReload = false) {
    const now = Date.now()
    
    // 缓存未过期且不强制重载，直接返回
    if (!forceReload && this.cache && (now - this.lastLoadTime) < this.cacheDuration) {
      return this.cache
    }
    
    try {
      const rules = await this._fetchFromDatabase()
      
      // 更新内存中的规则管理器
      dialogueRules.updateRules(rules)
      
      // 更新缓存
      this.cache = rules
      this.lastLoadTime = now
      
      console.log(`[RuleLoader] 规则已加载 v${dialogueRules.version}`)
      return rules
    } catch (e) {
      console.error('[RuleLoader] 加载规则失败:', e.message)
      
      // 降级：使用默认规则
      if (!this.cache) {
        dialogueRules.resetToDefaults()
        this.cache = dialogueRules.getRules()
        this.lastLoadTime = now
      }
      
      return this.cache
    }
  }

  /**
   * 手动触发规则刷新（配置保存后调用）
   */
  async refreshRules() {
    console.log('[RuleLoader] 手动刷新规则...')
    await this.loadRules(true)
  }

  /**
   * 获取当前规则（带缓存）
   * @returns {Object} 规则配置
   */
  getCurrentRules() {
    return dialogueRules.getRules()
  }

  /**
   * 停止自动刷新（服务关闭时调用）
   */
  stopAutoRefresh() {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval)
      this.autoRefreshInterval = null
      console.log('[RuleLoader] 自动刷新已停止')
    }
  }

  /**
   * 从数据库 fetch 规则配置
   * @private
   */
  async _fetchFromDatabase() {
    const [rows] = await pool.execute(
      "SELECT config_key, config_value FROM sys_config WHERE config_key IN ('dialogue_rules', 'session_timeout')"
    )
    
    const config = {}
    for (const row of rows) {
      config[row.config_key] = row.config_value
    }
    
    const rules = {}
    
    // 解析对话规则（v2.0 - 支持智能格式）
    if (config.dialogue_rules) {
      try {
        const parsed = JSON.parse(config.dialogue_rules)
        
        // 兼容旧格式（字符串数组）和新格式（对象数组）
        // 注意：DB 无该字段时不要传空数组（会覆盖 dialogueRules 默认值），
        // 因此仅在 parsed 存在对应字段时才赋值
        if (parsed.confirmWords) rules.confirmWords = this._normalizeRulesArray(parsed.confirmWords)
        if (parsed.denyWords) rules.denyWords = this._normalizeRulesArray(parsed.denyWords)
        if (parsed.meaninglessWords) rules.meaninglessWords = this._normalizeRulesArray(parsed.meaninglessWords)
        if (parsed.resumeWords) rules.resumeWords = this._normalizeRulesArray(parsed.resumeWords)
        if (parsed.matchTolerance && typeof parsed.matchTolerance === 'object') {
          rules.matchTolerance = parsed.matchTolerance
        }
      } catch (e) {
        console.warn('[RuleLoader] 解析对话规则失败，使用默认值')
      }
    }
    
    // 解析会话超时时间
    if (config.session_timeout) {
      const timeout = parseInt(config.session_timeout)
      if (!isNaN(timeout) && timeout > 0) {
        rules.sessionTimeout = timeout
      }
    }
    
    return rules
  }
  
  /**
   * 标准化规则数组（兼容新旧格式）
   * @private
   */
  _normalizeRulesArray(rules) {
    if (!Array.isArray(rules)) return []
    
    return rules.map(rule => {
      // 如果是字符串，转换为对象格式
      if (typeof rule === 'string') {
        return { pattern: rule, weight: 1.0, isRegex: false }
      }
      // 如果已经是对象格式，直接使用
      if (typeof rule === 'object' && rule.pattern) {
        return {
          pattern: rule.pattern,
          weight: rule.weight || 1.0,
          isRegex: rule.isRegex || false,
        }
      }
      return null
    }).filter(r => r !== null)
  }

  /**
   * 检查数据库是否有更新
   * @private
   */
  async _checkForUpdates() {
    try {
      const [rows] = await pool.execute(
        "SELECT config_value, updated_at FROM sys_config WHERE config_key = 'dialogue_rules'"
      )
      
      if (rows.length > 0) {
        const updatedAt = new Date(rows[0].updated_at).getTime()
        
        // 如果数据库更新时间晚于缓存时间，则重新加载
        if (updatedAt > this.lastLoadTime) {
          console.log('[RuleLoader] 检测到规则更新，正在刷新...')
          await this.loadRules(true)
        }
      }
    } catch (e) {
      console.error('[RuleLoader] 检查更新失败:', e.message)
    }
  }
}

// 单例导出
export default new RuleLoader()
