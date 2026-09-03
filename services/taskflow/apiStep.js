/**
 * "调用接口"步骤执行器（type:'api'）—— v3 统一后为 httpCall 的薄封装
 *
 * 配置（统一结构，见 httpCall.js）：
 *   { type:'api', url, method, headers, body, result, retries, timeout, done_message, next }
 *   兼容旧字段：fieldMap / fixedParams / resultMap / resultSlot / resultField
 *   - body：{ 接口字段: 值或 {slot.xxx} 模板 }
 *   - result：{ 变量名: 点路径 }，提取结果写入对应槽位（槽位存在时）与 vars
 *   - done_message：回给用户的话术，支持 {result.xxx} / {结果槽位key} 插值；
 *     未配置（或为空）→ 调用后不向用户追加任何内容（静默，默认行为）
 */

import { executeHttpCall } from './httpCall.js'

export async function executeApiStep(step, slots, trace = null, vars = {}) {
  const r = await executeHttpCall(step, { slots, vars, trace })
  return {
    ok: r.ok,
    result: r.result,
    results: r.results,
    message: r.message,
    error: r.error,
    vars: r.vars,
  }
}

export default { executeApiStep }
