/**
 * 对话策略管理器（DST + Policy）
 *
 * 根据任务状态与用户输入，推进步骤流程：
 *   collect（提取→校验→填槽→下一步，支持一轮多槽）
 *   message（直接回复）
 *   branch（按槽位值分支跳转）
 *   confirm（收集完毕后确认：确认/否认/纠正）
 *   action（执行动作 → 完成或失败重试）
 *   subtask（压栈启动子任务，子任务完成后 on_return 返回）
 *
 * 返回信封（供引擎层使用）：
 *   { reply, isComplete, extracted, cancelled, reask, taskState }
 *   - extracted=true  本轮有进展（填槽/确认/执行/纠正…），引擎直接使用 reply
 *   - reask=true      本轮校验失败需要重问，引擎直接使用 reply（不 FAQ 回退）
 *   - 两者皆 false    本轮无进展，引擎回退 FAQ 匹配
 */

import extractor from './extractor.js'
import { runAction } from './actionRegistry.js'
import { TaskState } from './stateMachine.js'
import dialogueRules from '../../rules/dialogueRules.js'

const CANCEL_PATTERNS = ['取消', '算了', '不办了', '不需要了', '退出', '停止', '不弄了', '放弃']
const CORRECT_PATTERNS = ['修改', '改成', '换成', '改为', '变更', '改一下']

class DialogManager {
  /**
   * @param {import('./taskDefs.js').default} defs - 任务定义加载器
   * @param {import('./nlu.js').default} nlu - 理解层（意图判定/槽位提取，可插拔模式）
   */
  constructor(defs, nlu) {
    this.defs = defs
    this.nlu = nlu
  }

  /**
   * 处理一轮任务对话
   * @param {Object} state - 任务状态（含 stack）
   * @param {string} text - 用户输入
   * @returns {Promise<Object>} 信封
   */
  async processTurn(state, text) {
    state.turnCount = (state.turnCount || 0) + 1
    state.lastActive = Date.now()

    // 1) 取消意图
    if (this._isCancel(text)) {
      return this._cancel(state)
    }

    // 2) 槽位纠正（"地址改成XX"）
    const correction = this._detectCorrection(text, state)
    if (correction) {
      state.slots[correction.key] = {
        ...state.slots[correction.key],
        value: correction.value,
        filled: true,
      }
      state.skipCount = 0
      console.log(`[TaskFlow] 槽位纠正: ${correction.key} = "${correction.value}"`)

      const prefix = `好的，${state.slots[correction.key].label}已更新为「${correction.value}」。\n`

      // 确认态 → 重新展示确认清单
      if (state.status === TaskState.CONFIRMING) {
        return this._renderConfirm(state, prefix)
      }

      // 收集态 → 移到下一个未填槽位提问（纠正文本不再当作新槽位值）
      const nextUnfilled = Object.entries(state.slots).find(([_, s]) => s.required && !s.filled)
      if (!nextUnfilled) {
        state.status = TaskState.CONFIRMING
        return this._renderConfirm(state, prefix)
      }
      const step = this._findStepBySlot(state, nextUnfilled[0])
      state.currentStep = step?.key
      const prompt = step ? this._slotDef(state, step)?.prompt || step.prompt : `请提供${nextUnfilled[1].label}`
      return {
        reply: prefix + (prompt || ''),
        isComplete: false,
        extracted: true,
        reask: false,
        cancelled: false,
        taskState: state,
      }
    }

    // 3) 按当前状态推进
    if (state.status === TaskState.CONFIRMING) {
      return this._handleConfirmTurn(state, text)
    }
    return this._advanceCollect(state, text, '')
  }

  // ========== 收集阶段 ==========

  async _advanceCollect(state, text, prefix) {
    let reply = prefix
    let extracted = false
    let alreadyExtracted = false
    let textUsed = false
    let anchorStep = null
    let anchorPrompt = ''
    let probing = false
    let stepsWalked = 0

    while (stepsWalked < 10) {
      const step = this._currentStep(state)
      if (!step) {
        // 流程结束（无下一步）
        return this._finish(state, reply || '已完成。')
      }

      switch (step.type) {
        case 'message': {
          reply += step.text || ''
          state.currentStep = step.next
          extracted = true
          alreadyExtracted = true
          break
        }
        case 'branch': {
          const next = this._evalBranch(step, state.slots)
          state.currentStep = next
          extracted = true
          alreadyExtracted = true
          break
        }
        case 'confirm': {
          // 仍有必填槽位未填（如一轮多槽提取不完整）→ 回到第一个未填槽位提问
          const unfilled = this._firstUnfilledRequired(state)
          if (unfilled) {
            const s = this._findStepBySlot(state, unfilled[0])
            state.currentStep = s?.key
            const p = s ? (this._slotDef(state, s)?.prompt || s.prompt) : `请提供${unfilled[1].label}`
            return this._withQuestion(text, state, {
              reply: (reply || '') + p,
              isComplete: false,
              extracted: alreadyExtracted || extracted,
              reask: false,
              cancelled: false,
              taskState: state,
            })
          }
          // 全部必填已填 → 进入确认态
          state.status = TaskState.CONFIRMING
          state.confirmAsked = true
          return this._renderConfirm(state, reply)
        }
        case 'action': {
          const result = await this._execAction(state, step, reply)
          if (result) return result // 完成或失败重试（返回信封）
          return this._finish(state, reply)
        }
        case 'subtask': {
          return this._startSubtask(state, step, reply)
        }
        case 'collect':
        default: {
          const canText = !(textUsed && step.extract?.method === 'text')
          const outcome = await this._tryFillSlot(state, step, text, canText, probing)
          if (outcome.extracted) {
            reply += outcome.note || ''
            extracted = true
            alreadyExtracted = true
            if (step.extract?.method === 'text') textUsed = true
            state.currentStep = step.next
            state.skipCount = 0
          } else if (outcome.reask) {
            return {
              reply: (reply || '') + outcome.reask,
              isComplete: false,
              extracted: extracted || false,
              reask: true,
              cancelled: false,
              taskState: state,
            }
          } else {
            // 未提取：记住第一个未填锚点，继续探测后续步骤（支持"地址是X，电话是Y"一轮多槽）
            if (!anchorStep) {
              anchorStep = step.key
              anchorPrompt = this._buildPrompt(state, step)
            }
            const nextUnfilled = this._nextUnfilledCollectStep(state, state.currentStep)
            if (nextUnfilled) {
              probing = true
              state.currentStep = nextUnfilled
              state.skipCount = (state.skipCount || 0) + 1
              break // 继续循环探测
            }
            // 探测完毕：回到锚点提问
            state.currentStep = anchorStep
            state.skipCount = (state.skipCount || 0) + 1
            return this._withQuestion(text, state, {
              reply: (reply || '') + (anchorPrompt || ''),
              isComplete: false,
              extracted: alreadyExtracted,
              reask: false,
              cancelled: false,
              taskState: state,
            })
          }
        }
      }
      stepsWalked++
    }
    // 防御：步骤循环过深
    return {
      reply: reply || '请继续提供所需信息。',
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  /** 尝试从用户输入填充当前槽位 */
  async _tryFillSlot(state, step, text, canText, probing = false) {
    const slotDef = this._slotDef(state, step)
    if (!slotDef) {
      return { extracted: false, reask: '步骤配置错误：槽位不存在。' }
    }

    // 槽位已填（分支跳回等场景）→ 直接推进
    if (state.slots[slotDef.key]?.filled) {
      return { extracted: true, note: '' }
    }

    // 纯文本提取在两种情况下受限：首轮（避免触发句误填）、本轮已用过文本提取
    // 受限时仍允许显式标签提取（"地址是X"）
    const method = slotDef.extract?.method || 'text'
    const isFirstTurn = state.turnCount <= 1
    const textBlocked = method === 'text' && (isFirstTurn || !canText)

    const task = this.defs.get(state.taskCode)
    const { value } = await this.nlu.extractSlotValue(
      text, slotDef,
      { taskCode: state.taskCode, task, state },
      { labelOnly: textBlocked }
    )

    // 规则/单槽未提取到 → LLM 批量兜底（一次性抽取所有未填槽位）
    if (value === null && this.nlu.mode !== 'rule') {
      const all = await this._llmExtractAll(state, text)
      if (all && Object.keys(all).length > 0) {
        let llmFilledAny = false
        for (const [k, v] of Object.entries(all)) {
          const s = state.slots[k]
          if (!s || s.filled || !v) continue
          const sDef = this._slotDefByKey(state, k)
          const check = sDef ? this.nlu.validate(sDef, v) : { ok: true }
          if (check.ok) {
            s.value = String(v)
            s.filled = true
            llmFilledAny = true
            console.log(`[TaskNLU] LLM提取槽位 ${k} = "${v}"`)
          }
        }
        if (llmFilledAny) {
          const filled = state.slots[slotDef.key]
          if (filled?.filled) {
            return { extracted: true, note: '' }
          }
          return { extracted: false, reask: '' }
        }
      }
    }

    if (value === null) {
      // 结构化槽位（regex/number/enum）：输入非空且不像闲聊 → 视为格式错误，直接重问
      // 探测模式下不重问（避免"地址X，电话Y"场景下地址被问成电话）
      if (!probing && method !== 'text' && text.trim().length > 0 && !extractor.isQuestion(text)) {
        return { extracted: false, reask: slotDef.validate?.reask || `请提供有效的${slotDef.label || ''}` }
      }
      return { extracted: false, reask: '' }
    }

    const check = this.nlu.validate(slotDef, value)
    if (!check.ok) {
      return { extracted: false, reask: check.message }
    }

    state.slots[slotDef.key] = {
      ...state.slots[slotDef.key],
      value,
      filled: true,
      label: slotDef.label || slotDef.key,
      required: slotDef.required !== false,
    }
    console.log(`[TaskFlow] 已填槽位 ${slotDef.key} = "${value}"`)
    return { extracted: true, note: `已记录：${slotDef.label || slotDef.key}。\n` }
  }

  // ========== 智能辅助 ==========

  /**
   * 边答边问：提取槽位后若剩余文本含疑问 → 标记 question，交给引擎 FAQ 回答
   */
  _withQuestion(text, state, envelope) {
    const q = this._detectQuestion(text, state)
    if (q) {
      envelope.question = true
      envelope.questionText = q
    }
    return envelope
  }

  /** 检测剩余文本中的疑问（去掉已填槽位的标签片段后） */
  _detectQuestion(text, state) {
    const remainder = this._stripFilledFragments(text, state)
    if (remainder.length < 2) return ''
    const q = remainder.trim()
    if (q.includes('？') || q.includes('?') || /(怎么|如何|怎样|什么|哪里|哪儿|多少|几个|为什么|能不能|可以吗|是否|有没有|多久|几时|请问|怎么办|好不好|行不行|是不是|呢|吗)/.test(q)) {
      return q
    }
    return ''
  }

  /** 去掉已填槽位的"标签+值"片段（如"地址是幸福小区3栋502，") */
  _stripFilledFragments(text, state) {
    let t = text
    for (const [key, slot] of Object.entries(state.slots)) {
      if (!slot.filled) continue
      const names = [slot.label, ...(slot.aliases || [])].filter(Boolean)
      for (const name of names) {
        if (!name) continue
        try {
          t = t.replace(new RegExp(`${name}[是为]?[:：\\s]*[^，。；;！？!?]*`, 'g'), '')
        } catch { /* ignore */ }
      }
    }
    return t.replace(/^[，,、\s]+|[，,、\s]+$/g, '')
  }

  /** 下一个未填槽位的 collect 步骤（用于一轮多槽探测） */
  _nextUnfilledCollectStep(state, fromKey) {
    const task = this.defs.get(state.taskCode)
    const steps = (task?.steps || []).filter(s => s.type === 'collect')
    const startIdx = steps.findIndex(s => s.key === fromKey)
    for (let i = startIdx + 1; i < steps.length; i++) {
      const s = steps[i]
      if (!state.slots[s.slot_key]?.filled) return s.key
    }
    return null
  }

  /** 第一个未填的必填槽位 */
  _firstUnfilledRequired(state) {
    return Object.entries(state.slots).find(([_, s]) => s.required && !s.filled) || null
  }

  /** 按槽位 key 查找其步骤定义（含 extract/validate） */
  _slotDefByKey(state, slotKey) {
    const task = this.defs.get(state.taskCode)
    const step = (task?.steps || []).find(s => s.type === 'collect' && s.slot_key === slotKey)
    if (!step) return null
    return this._slotDef(state, step)
  }

  /** LLM 一次性抽取所有未填槽位（委托理解层） */
  async _llmExtractAll(state, text) {
    const task = this.defs.get(state.taskCode)
    if (!task) return null
    const unfilled = Object.entries(state.slots).filter(([_, s]) => !s.filled)
    if (unfilled.length === 0) return null
    const slotsSpec = {}
    for (const [key, s] of unfilled) {
      const sDef = this._slotDefByKey(state, key)
      slotsSpec[key] = {
        label: s.label,
        type: sDef?.extract?.method || 'text',
        rule: sDef?.extract?.rule || '',
        required: s.required,
      }
    }
    return this.nlu.extractSlotsBatch(text, task, slotsSpec, state)
  }

  /** 构建当前步骤的提问话术（含进度提示） */
  _buildPrompt(state, step) {
    if (state.skipCount >= 2) {
      state.skipCount = 0
      return this._buildSmartGuidance(state)
    }
    const slotDef = this._slotDef(state, step)
    return slotDef?.prompt || step.prompt || `请提供${slotDef?.label || step.slot_key}`
  }

  /** 连续无法提取时的智能引导 */
  _buildSmartGuidance(state) {
    const filled = Object.entries(state.slots).filter(([_, s]) => s.filled)
    const unfilled = Object.entries(state.slots).filter(([_, s]) => s.required && !s.filled)
    let msg = '目前还需要以下信息：\n'
    for (const [key, slot] of unfilled) {
      msg += `  ${slot.label}：❓ 待提供\n`
    }
    if (filled.length > 0) {
      msg += '\n您可以直接回复对应内容，或说"修改XX"来更改已填信息。'
    }
    return msg
  }

  // ========== 确认阶段 ==========

  _handleConfirmTurn(state, text) {
    const confirmR = dialogueRules.isConfirm(text)
    const denyR = dialogueRules.isDeny(text)

    const isConfirm = typeof confirmR === 'object' ? confirmR.matched : confirmR
    const isDeny = typeof denyR === 'object' ? denyR.matched : denyR

    // 同时命中时按分数裁决（如"不是"→deny 分数更高），平局优先 deny
    if (isConfirm && isDeny) {
      const cs = typeof confirmR === 'object' ? (confirmR.score || 0) : 1
      const ds = typeof denyR === 'object' ? (denyR.score || 0) : 1
      if (ds >= cs) {
        return this._denyConfirm(state)
      }
      return this._acceptConfirm(state, text)
    }
    if (isConfirm) return this._acceptConfirm(state, text)
    if (isDeny) return this._denyConfirm(state)

    // 用户在确认态重新提供某个槽位值（"电话换成XX""地址是XX"）
    const slotMatch = this._findSlotByText(state, text)
    if (slotMatch) {
      state.slots[slotMatch.key].value = slotMatch.value.trim()
      state.slots[slotMatch.key].filled = true
      return this._renderConfirm(state, `好的，${slotMatch.label}已更新为「${slotMatch.value.trim()}」。\n`)
    }

    // 无进展 → FAQ 回退
    return this._renderConfirm(state, '', true)
  }

  _acceptConfirm(state, text) {
    state.confirmAsked = false
    state.status = TaskState.COLLECTING
    const step = this._currentStep(state)
    state.currentStep = step?.next
    return this._advanceCollect(state, text, '好的，正在为您提交。\n')
  }

  _denyConfirm(state) {
    state.confirmAsked = false
    state.status = TaskState.COLLECTING
    const firstUnfilled = Object.entries(state.slots).find(([_, s]) => s.required && !s.filled)
    const step = firstUnfilled ? this._findStepBySlot(state, firstUnfilled[0]) : null
    state.currentStep = step?.key
    const reply = '好的，请重新提供需要修改的信息。\n' + this._buildSmartGuidance(state)
    return { reply, isComplete: false, extracted: true, reask: false, cancelled: false, taskState: state }
  }

  _renderConfirm(state, prefix, asFallback = false) {
    const summary = this._buildSummary(state)
    const prompt = '请确认以上信息，回复"确认"提交，或说"修改XX"更正。'
    return {
      reply: (prefix || '') + summary + '\n' + prompt,
      isComplete: false,
      extracted: !asFallback,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  _buildSummary(state) {
    const lines = ['\n📋 请确认以下信息：']
    for (const [key, slot] of Object.entries(state.slots)) {
      if (slot.filled) lines.push(`  ${slot.label}：${slot.value}`)
    }
    return lines.join('\n')
  }

  // ========== 动作执行 ==========

  async _execAction(state, step, replyPrefix = '') {
    state.status = TaskState.EXECUTING
    const slots = {}
    for (const [key, s] of Object.entries(state.slots)) slots[key] = s.value

    const ctx = {
      sessionId: state.sessionId,
      task: this.defs.get(state.taskCode),
      state,
      step,
      slots,
      params: step.params || {},
    }

    const result = await runAction(step.action, ctx)
    if (result.ok) {
      state.currentStep = step.next
      const message = (replyPrefix ? replyPrefix + (result.message ? '\n' : '') : '') + (result.message || '')
      // 子任务完成 → 返回父任务
      if (state.stack && state.stack.length > 0) {
        return this._popSubtask(state, message)
      }
      return this._finish(state, message)
    }

    // 动作失败
    const onFail = step.on_fail || 'reask'
    if (onFail === 'retry') {
      return this._execAction(state, step)
    }
    state.status = TaskState.COLLECTING
    return {
      reply: `操作未能完成：${result.message}\n您可以回复"重试"，或"取消"结束。`,
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  // ========== 子任务 ==========

  _startSubtask(state, step, replyPrefix) {
    const childDef = this.defs.get(step.task)
    if (!childDef) {
      state.currentStep = step.next
      return this._advanceCollect(state, '', replyPrefix + `子任务「${step.task}」不存在。\n`)
    }
    // 压栈当前任务
    state.stack = state.stack || []
    state.stack.push({
      taskCode: state.taskCode,
      taskName: state.taskName,
      currentStep: step.next,
      slots: state.slots,
      turnCount: state.turnCount,
      onReturn: step.on_return,
    })
    // 切换为子任务
    state.taskCode = childDef.code
    state.taskName = childDef.name
    state.currentStep = childDef.steps[0]?.key
    state.status = TaskState.COLLECTING
    state.slots = this.initSlots(childDef)
    state.turnCount = 1
    state.skipCount = 0
    console.log(`[TaskFlow] 进入子任务: ${childDef.code}`)
    return {
      reply: replyPrefix + `好的，开始「${childDef.name}」。\n` + (childDef.steps[0]?.prompt || '请提供信息'),
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  _popSubtask(state, childDoneMsg) {
    const parent = state.stack.pop()
    if (!parent) return null
    state.taskCode = parent.taskCode
    state.taskName = parent.taskName
    state.slots = parent.slots
    state.turnCount = parent.turnCount || 0
    state.skipCount = 0
    state.status = TaskState.COLLECTING
    state.currentStep = parent.onReturn || parent.currentStep
    console.log(`[TaskFlow] 子任务完成，返回父任务: ${state.taskCode}`)

    // 返回后提示父任务下一个需要的信息
    const step = this._currentStep(state)
    const prompt = step?.type === 'collect'
      ? (this._slotDef(state, step)?.prompt || step.prompt || '请继续提供信息')
      : '请继续。'
    return {
      reply: (childDoneMsg ? childDoneMsg + '\n' : '') + prompt,
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  // ========== 完成/取消 ==========

  _finish(state, message) {
    state.status = TaskState.DONE
    return {
      reply: message || `已为您完成${state.taskName}。`,
      isComplete: true,
      extracted: true,
      reask: false,
      cancelled: false,
      taskState: state,
    }
  }

  _cancel(state) {
    state.status = TaskState.CANCELLED
    return {
      reply: '好的，已为您取消操作。',
      isComplete: false,
      extracted: true,
      reask: false,
      cancelled: true,
      taskState: state,
    }
  }

  // ========== 工具 ==========

  _currentStep(state) {
    const task = this.defs.get(state.taskCode)
    if (!task) return null
    return task.steps.find(s => s.key === state.currentStep) || null
  }

  _slotDef(state, step) {
    const task = this.defs.get(state.taskCode)
    const def = (task?.slots || []).find(s => s.key === step.slot_key)
    if (!def) return null
    return {
      ...def,
      // 提取配置优先取步骤 DSL；v1 槽位字段（extract_type/extract_rule）兜底
      extract: step.extract || {
        method: def.extract_type || 'text',
        rule: def.extract_rule || '',
      },
      validate: step.validate || def.validate || {},
      _triggers: task.trigger_keywords || [],
    }
  }

  _findStepBySlot(state, slotKey) {
    const task = this.defs.get(state.taskCode)
    return (task?.steps || []).find(s => s.type === 'collect' && s.slot_key === slotKey) || null
  }

  /** 槽位名称（含别名） */
  _slotNames(slot) {
    return [slot.label, ...(slot.aliases || [])].filter(Boolean)
  }

  /** 确认态：识别用户重新提供某个槽位值（按名称/别名匹配） */
  _findSlotByText(state, text) {
    for (const [key, slot] of Object.entries(state.slots)) {
      if (!slot.filled) continue
      const names = this._slotNames(slot)
      for (const name of names) {
        if (text.includes(name)) {
          // 提取名称之后的内容作为新值（"电话换成139..." → "139..."）
          const idx = text.indexOf(name) + name.length
          let value = text.substring(idx).replace(/^[是为]?[:：\s]*/, '').replace(/[。！!？?]$/, '').trim()
          // 若值以纠正词开头则去掉（"换成"）
          value = value.replace(/^(修改|改成|换成|改为|变更|改一下)/, '').trim()
          if (value.length >= 1) return { key, label: slot.label || key, value }
        }
      }
    }
    return null
  }

  _evalBranch(step, slots) {
    for (const c of (step.cases || [])) {
      const slot = slots[c.when?.slot]
      const value = slot?.value
      if (value === undefined || value === null) continue
      switch (c.when?.op) {
        case 'eq': if (String(value) === String(c.when.value)) return c.next; break
        case 'contains': if (String(value).includes(c.when.value)) return c.next; break
        case 'regex': try { if (new RegExp(c.when.value, 'i').test(String(value))) return c.next } catch { /* ignore */ } break
        default: break
      }
    }
    return step.default_next
  }

  _isCancel(text) {
    const t = text.trim()
    return CANCEL_PATTERNS.some(p => t.includes(p))
  }

  _detectCorrection(text, state) {
    const filled = Object.entries(state.slots).filter(([_, s]) => s.filled)
    if (filled.length === 0) return null
    const t = text.trim()
    for (const [key, slot] of filled) {
      const names = this._slotNames(slot)
      for (const name of names) {
        for (const p of CORRECT_PATTERNS) {
          if (t.includes(p + name) || t.includes(name + p)) {
            const idx = t.indexOf(p)
            const afterP = t.substring(idx + p.length).trim()
            const value = afterP.replace(new RegExp(`^${name}[是为]?`), '').trim()
            if (value.length >= 1) return { key, value }
          }
        }
      }
    }
    return null
  }

  /** 初始化槽位状态（新任务/子任务） */
  initSlots(taskDef) {
    const slots = {}
    for (const s of (taskDef.slots || [])) {
      slots[s.key] = {
        value: null,
        filled: false,
        label: s.label || s.key,
        aliases: s.aliases || [],
        required: s.required !== false,
        prompt: s.prompt || `请提供${s.label || s.key}`,
      }
    }
    return slots
  }
}

export default DialogManager
