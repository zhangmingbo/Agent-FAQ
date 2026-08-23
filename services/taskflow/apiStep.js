/**
 * "调用接口"步骤执行器（type:'api'）
 *
 * 步骤 DSL：
 *   { type:'api', url, method, fieldMap, resultSlot, resultField, resultMap, done_message, next }
 *   - fieldMap：{ 槽位key: 接口字段名 }，用已收集槽位组装请求；留空=传全部槽位
 *   - resultSlot/resultField：单字段结果（旧式）——resultField 点路径（如 data.orderNo）提取后写入 resultSlot
 *   - resultMap：多字段结果（新式，优先于 resultSlot/resultField）——
 *     { 槽位key: 接口字段点路径 }，逐个提取并写入对应槽位，如
 *     { order_number: 'data.orderNo', order_status: 'data.status' }
 *   - done_message：回给用户的话术，支持 {result} / {结果槽位key} 插值；
 *     未配置（或为空）→ 调用后不向用户追加任何内容（静默，默认行为）
 *   - next：下一步骤 key
 *
 * 触发：确定性按步骤执行（规则版步骤机 / LLM 版前置槽位填好后），不依赖 LLM 信号。
 */

import { getReply } from '../replyTexts.js'
import traceService from '../traceService.js'

/** 按点路径写入嵌套对象：setPath(obj, 'data.phone', v) → obj.data.phone = v */
function setPath(obj, path, value) {
  const keys = String(path).split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
}

export async function executeApiStep(step, slots, trace = null) {
  if (!step || !step.url) return { ok: false, result: null, message: 'api 步骤未配置接口地址' }

  const fieldMap = step.fieldMap || {}
  let payload
  if (fieldMap && Object.keys(fieldMap).length) {
    payload = {}
    for (const [slotKey, apiField] of Object.entries(fieldMap)) {
      const v = slots[slotKey]
      setPath(payload, apiField, (v !== undefined && v !== null) ? String(v) : '')
    }
  } else {
    payload = { ...slots }
  }
  // 固定入参（静态值，如 appId/渠道号；覆盖同名字段，支持嵌套）
  if (step.fixedParams && typeof step.fixedParams === 'object') {
    for (const [k, v] of Object.entries(step.fixedParams)) {
      if (v && typeof v === 'object') setPath(payload, k, v) // 对象原样（嵌套结构）
      else setPath(payload, k, String(v === undefined || v === null ? '' : v))
    }
  }

  try {
    const method = (step.method || 'POST').toUpperCase()
    traceService.traceStep(trace, '任务·调用接口', {
      step: step.key || null,
      url: step.url,
      method,
      payload,
    }, 'task')
    const res = await fetch(step.url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(step.headers || {}) },
      body: method === 'GET' ? undefined : JSON.stringify(payload),
    })
    if (!res.ok) {
      console.error(`[TaskFlow] api 步骤 HTTP ${res.status}:`, (await res.text()).slice(0, 200))
      traceService.traceStep(trace, '任务·接口结果', { ok: false, httpStatus: res.status }, 'error')
      return { ok: false, result: null, message: getReply('api_action_fail', { code: res.status }) }
    }

    const text = await res.text()
    let result = text
    /** 多字段提取结果：{ 槽位key: 值 }（resultMap 全部；旧式单字段时含 resultSlot） */
    const results = {}
    try {
      const j = JSON.parse(text)
      if (step.resultMap && typeof step.resultMap === 'object' && Object.keys(step.resultMap).length) {
        // 多字段：按 { 槽位key: 点路径 } 逐个提取
        for (const [slotKey, path] of Object.entries(step.resultMap)) {
          const v = j && String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), j)
          results[slotKey] = (v === undefined || v === null) ? text : (typeof v === 'string' ? v : JSON.stringify(v))
        }
        // 主结果取第一个映射值（供 {result} 插值 / 兼容单值消费方）
        result = Object.values(results)[0] ?? text
      } else if (step.resultField) {
        // 旧式单字段：resultField 点路径提取 → resultSlot
        const v = j && step.resultField.split('.').reduce((o, k) => (o == null ? o : o[k]), j)
        result = (v === undefined || v === null) ? text : (typeof v === 'string' ? v : JSON.stringify(v))
        if (step.resultSlot) results[step.resultSlot] = result
      } else {
        result = typeof j === 'string' ? j : JSON.stringify(j)
      }
    } catch { /* 非 JSON，保留原文 */ }

    // 回复话术：仅当配置了 done_message 才向用户追加内容（支持 {result}/{结果槽位key} 插值）；
    // 未配置或为空 → 静默，接口调用结果不回显给用户（默认行为）
    const hasMsg = step.done_message !== undefined && step.done_message !== null
    let message = hasMsg ? String(step.done_message) : ''
    message = message.split('{result}').join(result)
    for (const [slotKey, val] of Object.entries(results)) {
      message = message.split('{' + slotKey + '}').join(val)
    }
    traceService.traceStep(trace, '任务·接口结果', {
      ok: true,
      response: text, // 接口原始完整返回
      result,
      results: Object.keys(results).length ? results : undefined,
      resultSlot: step.resultSlot || null,
    }, 'task')
    return { ok: true, result, results, message }
  } catch (e) {
    console.error('[TaskFlow] api 步骤异常:', e.message)
    traceService.traceStep(trace, '任务·接口异常', { message: e.message }, 'error')
    return { ok: false, result: null, message: getReply('api_action_fail', { code: '' }) }
  }
}
