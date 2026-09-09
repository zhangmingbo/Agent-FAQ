/**
 * SimpleFlowEngine - 纯解释器式流程引擎
 * 
 * 设计理念:
 * - 画布即代码,所有逻辑在JSON DSL中定义
 * - 无智能提取,用户输入直接赋值给变量
 * - 无语义理解,条件判断基于显式表达式
 * - 完全可预测,易于调试和维护
 */

class SimpleFlowEngine {
  constructor() {
    this.sessions = new Map() // sessionId -> state
  }

  /**
   * 启动或继续执行流程
   * @param {string} sessionId - 会话ID
   * @param {object} taskDef - 任务定义(包含steps数组)
   * @param {string|null} userInput - 用户输入(首次为null)
   * @returns {object} { reply, isComplete, variables }
   */
  async execute(sessionId, taskDef, userInput = null) {
    // 1. 加载或初始化会话状态
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        variables: {},
        currentStepKey: taskDef.steps[0].key, // 从第一个step开始
        history: [],
        pendingCollect: null
      }
      this.sessions.set(sessionId, state)
    }

    // 2. 如果有用户输入且处于等待收集状态,保存变量
    if (userInput && state.pendingCollect) {
      const collectStep = state.pendingCollect
      state.variables[collectStep.variable] = userInput.trim()
      state.history.push({
        step: collectStep.key,
        type: 'collected',
        variable: collectStep.variable,
        value: userInput.trim(),
        timestamp: Date.now()
      })
      state.currentStepKey = collectStep.next
      state.pendingCollect = null
    }

    // 3. 执行当前步骤
    const step = taskDef.steps.find(s => s.key === state.currentStepKey)
    if (!step) {
      return {
        reply: '流程配置错误:找不到下一步骤',
        isComplete: true,
        variables: state.variables
      }
    }

    // 4. 根据节点类型执行
    let result = null
    switch (step.type) {
      case 'message':
        result = this._executeMessage(step, state)
        break
      case 'collect':
        result = this._executeCollect(step, state)
        break
      case 'branch':
        result = this._executeBranch(step, state)
        break
      case 'end':
        result = this._executeEnd(step, state)
        break
      default:
        result = {
          reply: `未知节点类型: ${step.type}`,
          isComplete: true,
          variables: state.variables
        }
    }

    // 5. 记录执行历史
    state.history.push({
      step: step.key,
      type: step.type,
      timestamp: Date.now(),
      ...result
    })

    return result
  }

  /**
   * 执行 message 节点:发送消息
   */
  _executeMessage(step, state) {
    const reply = this._replaceVariables(step.text, state.variables)
    state.currentStepKey = step.next
    
    return {
      reply,
      isComplete: false,
      variables: { ...state.variables }
    }
  }

  /**
   * 执行 collect 节点:收集用户输入
   */
  _executeCollect(step, state) {
    // 设置等待状态
    state.pendingCollect = step
    
    return {
      reply: step.prompt,
      isComplete: false,
      variables: { ...state.variables },
      waitingForInput: true,
      variable: step.variable
    }
  }

  /**
   * 执行 branch 节点:条件分支
   */
  _executeBranch(step, state) {
    // 遍历所有条件,找到第一个匹配的
    for (const c of step.cases) {
      if (this._evalCondition(c.condition, state.variables)) {
        state.currentStepKey = c.next
        
        return {
          reply: null, // 分支节点不输出消息
          isComplete: false,
          variables: { ...state.variables },
          branchTaken: c.label
        }
      }
    }
    
    // 没有匹配的条件,流程结束
    return {
      reply: '未找到匹配的流程分支',
      isComplete: true,
      variables: { ...state.variables }
    }
  }

  /**
   * 执行 end 节点:流程结束
   */
  _executeEnd(step, state) {
    return {
      reply: step.doneMessage || '流程已完成',
      isComplete: true,
      variables: { ...state.variables }
    }
  }

  /**
   * 变量替换:将 ${varName} 替换为实际值
   */
  _replaceVariables(text, variables) {
    if (!text) return ''
    
    return text.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = variables[varName]
      return value !== undefined && value !== null ? value : match
    })
  }

  /**
   * 条件表达式求值
   * 支持: ${age} > 18, ${name} == '张三', ${score} >= 60
   */
  _evalCondition(condition, variables) {
    if (!condition) return false
    
    try {
      // 1. 替换变量: "${age} > 18" → "25 > 18"
      const expr = condition.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        const value = variables[varName]
        if (value === undefined || value === null) {
          return 'null'
        }
        // 字符串需要加引号
        if (typeof value === 'string') {
          return `'${value}'`
        }
        return value
      })
      
      // 2. 安全求值
      // 只允许基本运算符和比较符
      if (!/^[0-9+\-*/().\s'"=<>&|!]+$/.test(expr)) {
        console.warn('[SimpleFlowEngine] 非法条件表达式:', condition)
        return false
      }
      
      return new Function('return ' + expr)()
    } catch (error) {
      console.error('[SimpleFlowEngine] 条件求值失败:', condition, error)
      return false
    }
  }

  /**
   * 清除会话状态
   */
  clearSession(sessionId) {
    this.sessions.delete(sessionId)
  }

  /**
   * 获取会话状态(用于调试)
   */
  getSessionState(sessionId) {
    return this.sessions.get(sessionId) || null
  }
}

// 导出单例
module.exports = new SimpleFlowEngine()
