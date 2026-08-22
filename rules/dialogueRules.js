/**
 * 对话规则管理器 v2.0 - 智能化增强版
 * 职责：管理追问确认、否认、无意义过滤等对话规则
 * 特点：支持正则表达式、模糊匹配、权重评分
 */

class DialogueRules {
  constructor() {
    // 默认规则（兜底值）- 支持字符串和正则对象
    this.defaults = {
      confirmWords: [
        { pattern: '是', weight: 1.0 },
        { pattern: '对', weight: 1.0 },
        { pattern: '好的', weight: 1.0 },
        { pattern: '没错', weight: 1.0 },
        { pattern: '是的', weight: 1.0 },
        { pattern: '嗯', weight: 0.8 },
        { pattern: '确认', weight: 1.0 },
        { pattern: '对的', weight: 1.0 },
        { pattern: 'OK|ok', weight: 0.9, isRegex: true },
        { pattern: '行', weight: 0.9 },
        { pattern: '可以', weight: 0.9 },
      ],
      denyWords: [
        { pattern: '不是', weight: 1.0 },
        { pattern: '不对', weight: 1.0 },
        { pattern: '否', weight: 1.0 },
        { pattern: '不', weight: 0.8 },
        { pattern: '没有', weight: 0.9 },
        { pattern: '错了', weight: 1.0 },
        { pattern: 'NO|no', weight: 0.9, isRegex: true },
        { pattern: '不行', weight: 0.9 },
      ],
      meaninglessWords: [
        { pattern: '^(.)\\1{2,}$', weight: 1.0, isRegex: true }, // 重复字符
        { pattern: '^[.。…！!?？~～\\-—_]{2,}$', weight: 1.0, isRegex: true }, // 纯标点
        { pattern: '^\\d+$', weight: 1.0, isRegex: true }, // 纯数字
        { pattern: '嗯|哦|噢|啊|呀|哈|呵|嘛|呢|吧|了|呃|咦|哟|嚯', weight: 0.7, isRegex: true },
        { pattern: '谢谢|感谢|麻烦了|辛苦了|多谢', weight: 0.6, isRegex: true },
        { pattern: '再见|拜拜|bye|byebye|88', weight: 0.5, isRegex: true },
        { pattern: '知道(了)?|明白(了)?|了解', weight: 0.4, isRegex: true },
        { pattern: '随便|都行|不知道|不清楚|不懂', weight: 0.3, isRegex: true },
      ],
      // 恢复词：任务被 FAQ 插话挂起后，用户表达"继续办理"时恢复任务
      resumeWords: [
        { pattern: '继续', weight: 1.0 },
        { pattern: '接着', weight: 1.0 },
        { pattern: '继续办', weight: 1.0 },
        { pattern: '继续吧', weight: 1.0 },
        { pattern: '接着办', weight: 1.0 },
        { pattern: '好，继续', weight: 1.0 },
        { pattern: '好的，继续', weight: 1.0 },
        { pattern: '恩继续', weight: 1.0 },
        { pattern: '嗯继续', weight: 1.0 },
        { pattern: '继续预约', weight: 1.0 },
        { pattern: '继续办理', weight: 1.0 },
      ],
      sessionTimeout: 30 * 60 * 1000, // 30分钟
    }
    
    // 当前生效的规则
    this.currentRules = JSON.parse(JSON.stringify(this.defaults))
    
    // 规则版本（用于追踪变更）
    this.version = '2.0.0'
    this.updatedAt = null
    
    // 命中率统计
    this.hitStats = {
      confirmHits: 0,
      denyHits: 0,
      meaninglessHits: 0,
      totalChecks: 0,
    }
    
    // 详细匹配日志（最近100条）
    this.matchLogs = []
    this.maxLogSize = 100
  }

  /**
   * 更新规则配置（v2.0 - 支持智能格式）
   * @param {Object} newRules - 新规则配置
   * @param {(string|Object)[]} newRules.confirmWords - 确认关键词列表（支持字符串或{pattern, weight, isRegex}对象）
   * @param {(string|Object)[]} newRules.denyWords - 否认关键词列表
   * @param {(string|Object)[]} newRules.meaninglessWords - 无意义词表
   * @param {number} [newRules.sessionTimeout] - 会话超时时间（毫秒）
   */
  updateRules(newRules) {
    if (!newRules) return
    
    // 验证并合并规则 - 转换为统一格式
    if (Array.isArray(newRules.confirmWords)) {
      this.currentRules.confirmWords = newRules.confirmWords.map(w => this._normalizeRule(w))
    }
    
    if (Array.isArray(newRules.denyWords)) {
      this.currentRules.denyWords = newRules.denyWords.map(w => this._normalizeRule(w))
    }
    
    if (Array.isArray(newRules.meaninglessWords)) {
      this.currentRules.meaninglessWords = newRules.meaninglessWords.map(w => this._normalizeRule(w))
    }
    
    if (Array.isArray(newRules.resumeWords)) {
      this.currentRules.resumeWords = newRules.resumeWords.map(w => this._normalizeRule(w))
    }
    
    if (typeof newRules.sessionTimeout === 'number' && newRules.sessionTimeout > 0) {
      this.currentRules.sessionTimeout = newRules.sessionTimeout
    }
    
    // 更新元数据
    this.version = this._incrementVersion(this.version)
    this.updatedAt = new Date().toISOString()
    
    console.log(`[DialogueRules] 规则已更新 v${this.version}`)
  }
  
  /**
   * 标准化规则项（将字符串转换为对象格式）
   * @private
   */
  _normalizeRule(rule) {
    if (typeof rule === 'string') {
      return { pattern: rule, weight: 1.0, isRegex: false }
    }
    if (typeof rule === 'object' && rule.pattern) {
      return {
        pattern: rule.pattern,
        weight: rule.weight || 1.0,
        isRegex: rule.isRegex || false,
      }
    }
    return null
  }

  /**
   * 获取当前规则
   * @returns {Object} 当前规则配置
   */
  getRules() {
    return { ...this.currentRules, version: this.version, updatedAt: this.updatedAt }
  }

  /**
   * 重置为默认规则
   */
  resetToDefaults() {
    this.currentRules = { ...this.defaults }
    this.version = '1.0.0'
    this.updatedAt = null
    console.log('[DialogueRules] 已重置为默认规则')
  }

  /**
   * 判断文本是否匹配确认意图（v2.0 - 支持权重评分）
   * @param {string} text - 用户输入
   * @returns {{matched: boolean, score: number, matchedRule?: Object}} 匹配结果
   */
  isConfirm(text) {
    if (!text) return { matched: false, score: 0 }
    const lowerText = text.trim().toLowerCase()
    this.hitStats.totalChecks++
    
    // ===== [RULES-LOG] 确认词匹配开始 =====
    console.log(`[RULES-CONFIRM] 检查 "${text}" (${this.currentRules.confirmWords.length} 条规则)`)
    
    let bestMatch = null
    let maxScore = 0
    const matchDetails = [] // 记录所有规则的匹配情况
    
    for (const rule of this.currentRules.confirmWords) {
      const score = this._matchRule(lowerText, rule)
      matchDetails.push({
        pattern: rule.pattern,
        isRegex: rule.isRegex || false,
        weight: rule.weight,
        score: score,
        matched: score > 0
      })
      if (score > maxScore) {
        maxScore = score
        bestMatch = rule
      }
    }
    
    const result = {
      matched: maxScore > 0,
      score: maxScore,
      matchedRule: bestMatch
    }
    
    // 打印匹配结果
    if (maxScore > 0) {
      console.log(`[RULES-CONFIRM] ✅ MATCHED! Score: ${maxScore.toFixed(2)} | Rule: "${bestMatch.pattern}" (Regex: ${bestMatch.isRegex || false})`)
      this.hitStats.confirmHits++
      this._addLog('confirm', text, result, matchDetails)
    } else {
      console.log('[RULES-CONFIRM] ❌ NO MATCH')
    }
    
    return result
  }
  
  /**
   * 判断文本是否匹配否认意图（v2.0 - 支持权重评分）
   * @param {string} text - 用户输入
   * @returns {{matched: boolean, score: number, matchedRule?: Object}} 匹配结果
   */
  isDeny(text) {
    if (!text) return { matched: false, score: 0 }
    const lowerText = text.trim().toLowerCase()
    this.hitStats.totalChecks++
    
    // ===== [RULES-LOG] 否认词匹配开始 =====
    console.log(`[RULES-DENY] 检查 "${text}" (${this.currentRules.denyWords.length} 条规则)`)
    
    let bestMatch = null
    let maxScore = 0
    const matchDetails = [] // 记录所有规则的匹配情况
    
    for (const rule of this.currentRules.denyWords) {
      const score = this._matchRule(lowerText, rule)
      matchDetails.push({
        pattern: rule.pattern,
        isRegex: rule.isRegex || false,
        weight: rule.weight,
        score: score,
        matched: score > 0
      })
      if (score > maxScore) {
        maxScore = score
        bestMatch = rule
      }
    }
    
    const result = {
      matched: maxScore > 0,
      score: maxScore,
      matchedRule: bestMatch
    }
    
    // 打印匹配结果
    if (maxScore > 0) {
      console.log(`[RULES-DENY] ✅ MATCHED! Score: ${maxScore.toFixed(2)} | Rule: "${bestMatch.pattern}" (Regex: ${bestMatch.isRegex || false})`)
      this.hitStats.denyHits++
      this._addLog('deny', text, result, matchDetails)
    } else {
      console.log('[RULES-DENY] ❌ NO MATCH')
    }
    
    return result
  }
  
  /**
   * 匹配单个规则（支持正则和模糊匹配）
   * @private
   */
  _matchRule(text, rule) {
    if (!rule || !rule.pattern) return 0
    
    let score = 0
    
    if (rule.isRegex) {
      // 正则匹配
      try {
        const regex = new RegExp(rule.pattern, 'i')
        if (regex.test(text)) {
          score = rule.weight
          console.log(`    [MATCH] ✅ Regex "${rule.pattern}" → Score: ${score.toFixed(2)}`)
        }
      } catch (e) {
        console.warn('[DialogueRules] 正则表达式错误:', rule.pattern, e.message)
      }
    } else {
      // 精确匹配
      if (text === rule.pattern.toLowerCase()) {
        score = rule.weight
        console.log(`    [MATCH] ✅ Exact "${rule.pattern}" → Score: ${score.toFixed(2)}`)
      }
      // 包含匹配（短文本）
      else if (text.length <= 10 && text.includes(rule.pattern.toLowerCase())) {
        score = rule.weight * 0.8 // 包含匹配降低权重
        console.log(`    [MATCH] ⚠️ Contains "${rule.pattern}" → Score: ${score.toFixed(2)} (x0.8)`)
      }
      // 编辑距离模糊匹配（仅对短词）
      else if (rule.pattern.length <= 4 && text.length <= 10) {
        const distance = this._levenshteinDistance(text, rule.pattern.toLowerCase())
        const maxLength = Math.max(text.length, rule.pattern.length)
        const similarity = 1 - distance / maxLength
        
        if (similarity >= 0.8) { // 相似度阈值
          score = rule.weight * similarity * 0.7 // 模糊匹配进一步降低权重
          console.log(`    [MATCH] 🔄 Fuzzy "${rule.pattern}" → Distance: ${distance}, Similarity: ${(similarity*100).toFixed(0)}%, Score: ${score.toFixed(2)}`)
        }
      }
    }
    
    return score
  }
  
  /**
   * 计算编辑距离（Levenshtein Distance）
   * @private
   */
  _levenshteinDistance(str1, str2) {
    const m = str1.length
    const n = str2.length
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0))
    
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1]
        } else {
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,     // 删除
            dp[i][j - 1] + 1,     // 插入
            dp[i - 1][j - 1] + 1  // 替换
          )
        }
      }
    }
    
    return dp[m][n]
  }

  /**
   * 判断文本是否为无意义输入（v2.0 - 支持正则和权重）
   * @param {string} text - 用户输入
   * @returns {{isMeaningless: boolean, score: number, reason?: string}} 判断结果
   */
  isMeaningless(text) {
    if (!text) return { isMeaningless: true, score: 1.0, reason: '空输入' }
    const t = text.trim()
    if (!t) return { isMeaningless: true, score: 1.0, reason: '空白输入' }
    
    this.hitStats.totalChecks++
    
    // ===== [RULES-LOG] 无意义检测开始 =====
    console.log(`[RULES-MEANINGLESS] 检查 "${text}" (${this.currentRules.meaninglessWords.length} 条规则)`)
    
    let maxScore = 0
    let matchedReason = ''
    const matchDetails = [] // 记录所有规则的匹配情况
    
    // 遍历所有无意义规则
    for (const rule of this.currentRules.meaninglessWords) {
      const score = this._matchRule(t, rule)
      matchDetails.push({
        pattern: rule.pattern,
        isRegex: rule.isRegex || false,
        weight: rule.weight,
        score: score,
        matched: score > 0
      })
      if (score > maxScore) {
        maxScore = score
        matchedReason = rule.pattern
      }
    }
    
    const result = {
      isMeaningless: maxScore > 0,
      score: maxScore,
      reason: matchedReason
    }
    
    // 打印匹配结果
    if (maxScore > 0) {
      console.log(`[RULES-MEANINGLESS] ✅ MATCHED! Score: ${maxScore.toFixed(2)} | Rule: "${matchedReason}"`)
      this.hitStats.meaninglessHits++
      this._addLog('meaningless', text, result, matchDetails)
    } else {
      console.log('[RULES-MEANINGLESS] ❌ NO MATCH')
    }
    
    return result
  }

  /**
   * 判断文本是否为"恢复任务"意图（任务被 FAQ 插话挂起后，用户表达继续办理）
   * @param {string} text - 用户输入
   * @returns {{matched: boolean, score: number, matchedRule?: Object}} 匹配结果
   */
  isResume(text) {
    if (!text) return { matched: false, score: 0 }
    const lowerText = text.trim().toLowerCase()
    const rules = this.currentRules.resumeWords || []

    let maxScore = 0
    let bestMatch = null
    for (const rule of rules) {
      const score = this._matchRule(lowerText, rule)
      if (score > maxScore) {
        maxScore = score
        bestMatch = rule
      }
    }
    return { matched: maxScore > 0, score: maxScore, matchedRule: bestMatch }
  }

  /**
   * 获取会话超时时间
   * @returns {number} 超时时间（毫秒）
   */
  getSessionTimeout() {
    return this.currentRules.sessionTimeout
  }
  
  /**
   * 获取命中率统计
   * @returns {Object} 统计数据
   */
  getHitStats() {
    const stats = { ...this.hitStats }
    stats.confirmRate = stats.totalChecks > 0 ? (stats.confirmHits / stats.totalChecks * 100).toFixed(2) : 0
    stats.denyRate = stats.totalChecks > 0 ? (stats.denyHits / stats.totalChecks * 100).toFixed(2) : 0
    stats.meaninglessRate = stats.totalChecks > 0 ? (stats.meaninglessHits / stats.totalChecks * 100).toFixed(2) : 0
    return stats
  }
  
  /**
   * 重置命中率统计
   */
  resetHitStats() {
    this.hitStats = {
      confirmHits: 0,
      denyHits: 0,
      meaninglessHits: 0,
      totalChecks: 0,
    }
  }
  
  /**
   * 添加匹配日志
   * @private
   */
  _addLog(type, inputText, result, matchDetails) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type: type, // 'confirm', 'deny', 'meaningless'
      input: inputText,
      matched: result.matched || result.isMeaningless,
      score: result.score,
      matchedRule: result.matchedRule ? {
        pattern: result.matchedRule.pattern,
        isRegex: result.matchedRule.isRegex || false,
        weight: result.matchedRule.weight
      } : null,
      reason: result.reason || null,
      allMatches: matchDetails.filter(m => m.matched), // 只记录命中的规则
      totalRulesChecked: matchDetails.length
    }
    
    // 添加到日志数组
    this.matchLogs.push(logEntry)
    
    // 限制日志数量（保留最近maxLogSize条）
    if (this.matchLogs.length > this.maxLogSize) {
      this.matchLogs.shift()
    }
    
    // 控制台输出（开发环境）
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[RULES-LOG] ${type.toUpperCase()} | "${inputText}" → ${logEntry.matched ? `MATCHED (${result.score})` : 'NO MATCH'} | Rule: ${logEntry.matchedRule?.pattern || 'N/A'}`)
    }
  }
  
  /**
   * 获取匹配日志
   * @param {Object} options - 过滤选项
   * @param {string} [options.type] - 日志类型 ('confirm', 'deny', 'meaningless', 'all')
   * @param {number} [options.limit] - 返回数量限制
   * @param {string} [options.keyword] - 搜索关键词
   * @returns {Array} 日志列表
   */
  getMatchLogs(options = {}) {
    let logs = [...this.matchLogs]
    
    // 按类型过滤
    if (options.type && options.type !== 'all') {
      logs = logs.filter(log => log.type === options.type)
    }
    
    // 按关键词过滤
    if (options.keyword) {
      const kw = options.keyword.toLowerCase()
      logs = logs.filter(log => 
        log.input.toLowerCase().includes(kw) ||
        (log.matchedRule?.pattern?.toLowerCase().includes(kw)) ||
        (log.reason?.toLowerCase().includes(kw))
      )
    }
    
    // 限制数量
    if (options.limit) {
      logs = logs.slice(-options.limit)
    }
    
    return logs
  }
  
  /**
   * 清空匹配日志
   */
  clearMatchLogs() {
    this.matchLogs = []
  }

  /**
   * 导出规则为JSON（用于备份/迁移）
   * @returns {string} JSON字符串
   */
  exportToJson() {
    return JSON.stringify({
      version: this.version,
      updatedAt: this.updatedAt,
      rules: this.currentRules
    }, null, 2)
  }

  /**
   * 从JSON导入规则
   * @param {string} jsonStr - JSON字符串
   * @returns {boolean} 是否成功
   */
  importFromJson(jsonStr) {
    try {
      const data = JSON.parse(jsonStr)
      if (data.rules) {
        this.updateRules(data.rules)
        if (data.version) this.version = data.version
        if (data.updatedAt) this.updatedAt = data.updatedAt
        return true
      }
      return false
    } catch (e) {
      console.error('[DialogueRules] 导入规则失败:', e.message)
      return false
    }
  }

  /**
   * 版本号自增
   * @private
   */
  _incrementVersion(version) {
    const parts = version.split('.').map(Number)
    parts[2] = (parts[2] || 0) + 1
    return parts.join('.')
  }
}

// 单例导出
export default new DialogueRules()
