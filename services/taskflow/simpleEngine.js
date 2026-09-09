/**
 * SimpleFlowEngine v3.0 - 纯解释器式流程引擎
 * 
 * 设计理念 (参考 Coze/Dify/Botpress):
 * - 画布即代码(Canvas as Code):所有逻辑在JSON DSL中定义
 * - 极简节点类型:仅5种(start/message/collect/branch/end)
 * - 无智能提取:用户输入直接赋值给变量,不做NER
 * - 无语义理解:条件判断基于显式表达式 ${age} > 18
 * - 完全可预测:易于调试和维护,业务人员可配置
 * 
 * 节点生命周期 (参考 Botpress):
 * - onEnter: 进入节点时执行(发送消息/提示)
 * - onReceive: 接收用户输入(仅collect节点)
 * - onNext: 跳转到下一节点
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
   * @returns {object} { reply, isComplete, variables, debug }
   */
  async execute(sessionId, taskDef, userInput = null) {
    const startTime = Date.now()
    
    // 1. 加载或初始化会话状态
    let state = this.sessions.get(sessionId)
    if (!state) {
      // 【核心设计】找到入口节点:优先start节点,否则第一个节点
      const startNode = taskDef.steps.find(s => s.type === 'start')
      const entryNode = startNode || taskDef.steps[0]
      
      state = {
        variables: {},
        currentStepKey: entryNode.key,
        history: [],
        pendingCollect: null,
        executionLog: [] // 【新增】执行日志(用于调试)
      }
      this.sessions.set(sessionId, state)
      
      state.executionLog.push({
        event: 'session_started',
        entryNode: entryNode.key,
        timestamp: new Date().toISOString()
      })
    }

    // 2. 如果有用户输入且处于等待收集状态,保存变量
    if (userInput && state.pendingCollect) {
      const collectStep = state.pendingCollect
      const trimmedValue = userInput.trim()
      
      // 【格式校验】如果配置了validation,先验证再保存
      if (collectStep.validation) {
        const validationResult = this._validateInput(trimmedValue, collectStep.validation)
        if (!validationResult.valid) {
          return {
            reply: validationResult.errorMessage || '输入格式不正确,请重新输入',
            isComplete: false,
            variables: { ...state.variables },
            waitingForInput: true,
            variable: collectStep.variable,
            validationFailed: true
          }
        }
      }
      
      // 保存变量值
      state.variables[collectStep.variable] = trimmedValue
      
      // 记录历史
      state.history.push({
        step: collectStep.key,
        type: 'collected',
        variable: collectStep.variable,
        value: trimmedValue,
        timestamp: Date.now()
      })
      
      // 【可观测性】记录执行日志
      state.executionLog.push({
        event: 'variable_collected',
        node: collectStep.key,
        variable: collectStep.variable,
        value: trimmedValue,
        timestamp: new Date().toISOString()
      })
      
      // 跳转到下一节点
      state.currentStepKey = collectStep.next
      state.pendingCollect = null
    }

    // 3. 执行当前步骤
    const step = taskDef.steps.find(s => s.key === state.currentStepKey)
    if (!step) {
      const errorMsg = `流程配置错误:找不到下一步骤 [${state.currentStepKey}]`
      console.error('[SimpleFlowEngine]', errorMsg)
      
      return {
        reply: errorMsg,
        isComplete: true,
        variables: state.variables,
        error: true
      }
    }
    
    // 【可观测性】记录节点执行开始
    state.executionLog.push({
      event: 'node_executing',
      node: step.key,
      type: step.type,
      timestamp: new Date().toISOString()
    })

    // 4. 根据节点类型执行
    let result = null
    switch (step.type) {
      case 'start':
        result = this._executeStart(step, state)
        break
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
          variables: state.variables,
          error: true
        }
    }
    
    // 【可观测性】记录节点执行结果
    const execTime = Date.now() - startTime
    state.executionLog.push({
      event: 'node_completed',
      node: step.key,
      type: step.type,
      executionTimeMs: execTime,
      timestamp: new Date().toISOString()
    })

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
   * 执行 start 节点:流程入口(可选)
   * 【参考 Coze】start节点用于定义输入参数,但v3中简化为普通跳转
   */
  _executeStart(step, state) {
    // start节点只是标记入口,直接跳转到下一节点
    state.currentStepKey = step.next
    
    return {
      reply: null, // start节点不输出消息
      isComplete: false,
      variables: { ...state.variables }
    }
  }

  /**
   * 执行 message 节点:发送消息
   * 【参考 Dify】支持变量替换 ${variable_name}
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
   * 【核心改造】直接赋值模式,无NER智能提取
   * 【参考 Botpress】onReceive阶段等待用户输入
   */
  _executeCollect(step, state) {
    // 设置等待状态
    state.pendingCollect = step
    
    // 【可观测性】记录等待输入
    state.executionLog.push({
      event: 'waiting_for_input',
      node: step.key,
      variable: step.variable,
      prompt: step.prompt,
      timestamp: new Date().toISOString()
    })
    
    return {
      reply: step.prompt,
      isComplete: false,
      variables: { ...state.variables },
      waitingForInput: true,
      variable: step.variable,
      validation: step.validation || null // 返回校验规则(前端可显示提示)
    }
  }

  /**
   * 执行 branch 节点:条件分支
   * 【核心改造】简化为单一条件(true/false分支),参考 Dify 的 if-else
   * 【旧版】cases数组支持多分支 → 【新版】condition + true_next + false_next
   */
  _executeBranch(step, state) {
    // 【新版】单一条件分支
    if (step.condition) {
      const conditionMet = this._evalCondition(step.condition, state.variables)
      const nextKey = conditionMet ? step.true_next : step.false_next
      
      state.currentStepKey = nextKey
      
      // 【可观测性】记录分支选择
      state.executionLog.push({
        event: 'branch_taken',
        node: step.key,
        condition: step.condition,
        conditionMet,
        nextNode: nextKey,
        timestamp: new Date().toISOString()
      })
      
      return {
        reply: null, // 分支节点不输出消息
        isComplete: false,
        variables: { ...state.variables },
        branchTaken: conditionMet ? 'true' : 'false'
      }
    }
    
    // 【兼容旧版】cases数组方式(逐步废弃)
    if (step.cases && step.cases.length > 0) {
      for (const c of step.cases) {
        if (this._evalCondition(c.condition, state.variables)) {
          state.currentStepKey = c.next
          
          return {
            reply: null,
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
        variables: { ...state.variables },
        error: true
      }
    }
    
    // 既没有condition也没有cases,配置错误
    return {
      reply: '分支节点配置错误:缺少condition或cases',
      isComplete: true,
      variables: { ...state.variables },
      error: true
    }
  }

  /**
   * 执行 end 节点:流程结束
   * 【参考 Coze】end节点输出最终结果
   */
  _executeEnd(step, state) {
    // 【可观测性】记录流程结束
    state.executionLog.push({
      event: 'flow_completed',
      node: step.key,
      totalSteps: state.history.length,
      variables: { ...state.variables },
      timestamp: new Date().toISOString()
    })
    
    return {
      reply: step.doneMessage || '流程已完成',
      isComplete: true,
      variables: { ...state.variables }
    }
  }

  /**
   * 变量替换:将 ${varName} 替换为实际值
   * 【参考 Dify】支持上游节点输出的变量引用
   */
  _replaceVariables(text, variables) {
    if (!text) return ''
    
    return text.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = variables[varName]
      return value !== undefined && value !== null ? value : match
    })
  }

  /**
   * 输入格式校验
   * 【核心改造】仅做基础格式检查,不做语义理解
   */
  _validateInput(value, validation) {
    if (!validation) return { valid: true }
    
    try {
      switch (validation.type) {
        case 'regex':
          const regex = new RegExp(validation.rule)
          if (!regex.test(value)) {
            return {
              valid: false,
              errorMessage: validation.errorMessage || `格式不符合要求: ${validation.rule}`
            }
          }
          break
          
        case 'number':
          if (isNaN(Number(value))) {
            return {
              valid: false,
              errorMessage: validation.errorMessage || '请输入有效的数字'
            }
          }
          break
          
        case 'enum':
          if (validation.options && !validation.options.includes(value)) {
            return {
              valid: false,
              errorMessage: validation.errorMessage || `请选择: ${validation.options.join('、')}`
            }
          }
          break
          
        case 'email':
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
          if (!emailRegex.test(value)) {
            return {
              valid: false,
              errorMessage: validation.errorMessage || '请输入有效的邮箱地址'
            }
          }
          break
          
        case 'phone':
          const phoneRegex = /^1[3-9]\d{9}$/
          if (!phoneRegex.test(value)) {
            return {
              valid: false,
              errorMessage: validation.errorMessage || '请输入有效的手机号'
            }
          }
          break
          
        default:
          console.warn('[SimpleFlowEngine] 未知校验类型:', validation.type)
      }
      
      return { valid: true }
    } catch (error) {
      console.error('[SimpleFlowEngine] 校验失败:', error)
      return { valid: true } // 校验出错时放行,避免阻塞流程
    }
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

// 导出单例 (ESM)
export default new SimpleFlowEngine()
