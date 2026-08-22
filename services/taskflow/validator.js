/**
 * 槽位值校验器
 *
 * 校验规则（slot.validate.rule 字符串，多条用 && 连接）：
 *   nonempty         非空
 *   length>=N        最小长度
 *   length<=N        最大长度
 *   number           必须为数字
 *   phone            中国大陆手机号（1[3-9]开头11位）
 *   enum:a,b,c       必须属于枚举
 *   regex:/pattern/  必须匹配正则
 *
 * 校验失败时返回 { ok:false, message: slot.validate.reask || 默认提示 }
 */

export function validateSlot(slot, value) {
  if (value === null || value === undefined || value === '') {
    if (slot.required === false) return { ok: true }
    return { ok: false, message: slot.validate?.reask || `请提供${slot.label || '该信息'}` }
  }

  const rule = slot.validate?.rule
  if (!rule) return { ok: true }

  const rules = String(rule).split('&&').map(r => r.trim()).filter(Boolean)
  for (const r of rules) {
    const result = _checkRule(r, value)
    if (!result.ok) {
      return { ok: false, message: slot.validate?.reask || result.message }
    }
  }
  return { ok: true }
}

function _checkRule(rule, value) {
  const v = String(value).trim()

  // length>=N / length<=N
  let m = rule.match(/^length>=\s*(\d+)$/)
  if (m) return v.length >= parseInt(m[1]) ? { ok: true } : { ok: false, message: `长度不能少于${m[1]}个字符` }
  m = rule.match(/^length<=\s*(\d+)$/)
  if (m) return v.length <= parseInt(m[1]) ? { ok: true } : { ok: false, message: `长度不能超过${m[1]}个字符` }

  switch (rule) {
    case 'nonempty':
      return { ok: true }
    case 'number':
      return /^\d+(\.\d+)?$/.test(v) ? { ok: true } : { ok: false, message: '请输入数字' }
    case 'phone':
      return /^1[3-9]\d{9}$/.test(v) ? { ok: true } : { ok: false, message: '请输入正确的11位手机号' }
    default:
      if (rule.startsWith('enum:')) {
        const options = rule.slice(5).split(',').map(s => s.trim())
        return options.includes(v) ? { ok: true } : { ok: false, message: `请输入：${options.join('、')}` }
      }
      if (rule.startsWith('regex:')) {
        try {
          const re = new RegExp(rule.slice(6), 'i')
          return re.test(v) ? { ok: true } : { ok: false, message: '输入格式不正确' }
        } catch {
          return { ok: true }
        }
      }
      return { ok: true }
  }
}
