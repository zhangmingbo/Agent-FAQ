/**
 * "调用接口"步骤执行器（type:'api'）
 *
 * 步骤 DSL：
 *   { type:'api', url, method, fieldMap, resultSlot, resultField, done_message, next }
 *   - fieldMap：{ 槽位key: 接口字段名 }，用已收集槽位组装请求；留空=传全部槽位
 *   - resultSlot：接口响应写入该槽位（槽位需在任务定义里，系统填充，不向用户收集）
 *   - resultField：可选，JSON 点路径（如 data.orderNo），只取响应某字段；留空存整个响应
 *   - done_message：回给用户的话术，支持 {result} / {resultSlot} 插值；留空默认回显结果
 *
 * 触发：确定性按步骤执行（规则版步骤机 / LLM 版前置槽位填好后），不依赖 LLM 信号。
 */

import { getReply } from '../replyTexts.js'

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

export async function executeApiStep(step, slots) {
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
    const res = await fetch(step.url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(step.headers || {}) },
      body: method === 'GET' ? undefined : JSON.stringify(payload),
    })
    if (!res.ok) {
      console.error(`[TaskFlow] api 步骤 HTTP ${res.status}:`, (await res.text()).slice(0, 200))
      return { ok: false, result: null, message: getReply('api_action_fail', { code: res.status }) }
    }

    const text = await res.text()
    let result = text
    try {
      const j = JSON.parse(text)
      if (step.resultField) {
        const v = j && step.resultField.split('.').reduce((o, k) => (o == null ? o : o[k]), j)
        result = (v === undefined || v === null) ? text : (typeof v === 'string' ? v : JSON.stringify(v))
      } else {
        result = typeof j === 'string' ? j : JSON.stringify(j)
      }
    } catch { /* 非 JSON，保留原文 */ }

    let message = step.done_message || result || getReply('api_action_done')
    message = message.split('{result}').join(result)
    if (step.resultSlot) message = message.split('{' + step.resultSlot + '}').join(result)
    return { ok: true, result, message }
  } catch (e) {
    console.error('[TaskFlow] api 步骤异常:', e.message)
    return { ok: false, result: null, message: getReply('api_action_fail', { code: '' }) }
  }
}
