/**
 * 统一条件判断模块（动作系统 v3 P2 判断能力）
 *
 * 用于：流程 branch 步骤（规则版）与 动作编排内 branch（P3）共用。
 *
 * 条件结构：
 *   { source, ref, op, value }                   基本条件
 *   { source:'time', op:'workday'|'business_hours' }  时间判断
 *   { source:'fn', ref:函数名, args:[...] }       注册表函数判断
 *   { source:'expr', expr:'表达式' }               表达式判断
 *   { and:[...] } / { or:[...] }                  组合
 *
 * 判断源取值：
 *   slot   → ctx.slots[ref]（槽位值）
 *   var    → ctx.vars[ref]（上下文变量，接口出参等）
 *   result → ctx.result[ref]（编排步骤结果）
 *   time   → 系统时间（op: workday/business_hours）
 *   fn     → 注册的判断函数（与动作同机制）
 *   expr   → 表达式引擎
 *
 * 内置判断函数：is_workday（节假日第三方 API + 缓存，异常降级工作日）、is_business_hour（上班时间，sys_config work_start/work_end）
 */

import { evalExpr } from './expr.js'
import * as configRepo from '../../repositories/configRepo.js'

const judges = new Map()

/** 注册判断函数：async (...args, ctx) => boolean */
export function registerJudge(name, fn) {
  if (typeof fn !== 'function') throw new Error(`判断函数 ${name} 必须是函数`)
  judges.set(name, fn)
}

/** 已注册判断函数列表（供管理后台/校验） */
export function listJudges() {
  return [...judges.keys()]
}

// ========== 操作符求值 ==========

function toNum(v) {
  const n = parseFloat(v)
  return Number.isNaN(n) ? NaN : n
}

export function evalOp(op, actual, expected) {
  const a = (actual === undefined || actual === null) ? '' : actual
  switch (op) {
    case 'eq': return String(a) === String(expected ?? '')
    case 'ne': return String(a) !== String(expected ?? '')
    case 'contains': return String(a).includes(String(expected ?? ''))
    case 'notContains': return !String(a).includes(String(expected ?? ''))
    case 'regex':
      try { return new RegExp(String(expected ?? ''), 'i').test(String(a)) } catch { return false }
    case 'gt': return toNum(a) > toNum(expected)
    case 'gte': return toNum(a) >= toNum(expected)
    case 'lt': return toNum(a) < toNum(expected)
    case 'lte': return toNum(a) <= toNum(expected)
    case 'empty': return a === '' || a === undefined || a === null
    case 'notEmpty': return !(a === '' || a === undefined || a === null)
    default: return false
  }
}

// ========== 判断源取值 ==========

/** 简单描述条件（trace 用，供 dialogManager / flow 共用） */
export function describeCondition(when) {
  if (!when) return '?'
  if (when.and) return 'and(' + when.and.map(describeCondition).join(' & ') + ')'
  if (when.or) return 'or(' + when.or.map(describeCondition).join(' | ') + ')'
  if (when.source === 'fn') return 'fn:' + when.ref
  if (when.source === 'expr') return 'expr:' + when.expr
  if (when.source === 'time') return 'time:' + when.op
  return `${when.source || 'slot'}.${when.ref || when.slot} ${when.op} ${when.value}`
}

/** 判断源取值：slot/var/result（点路径），兼容旧 { slot, op, value } */
function resolveSource(cond, ctx) {
  const source = cond.source || 'slot'
  const ref = cond.ref || cond.slot // 兼容旧格式 { slot, op, value }
  const path = String(ref || '').split('.').filter(Boolean)
  if (source === 'slot') {
    const s = ctx.slots && ctx.slots[ref]
    const v = (s && typeof s === 'object' && 'value' in s) ? s.value : s
    return v
  }
  if (source === 'var') return getPath(ctx.vars, path)
  if (source === 'result') return getPath(ctx.result, path)
  return undefined
}

function getPath(obj, path) {
  let cur = obj
  for (const k of path) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[k]
  }
  return cur
}

function resolveArg(arg, ctx) {
  if (typeof arg === 'string' && arg.includes('{')) {
    // 模板：{slot.x} / {var.x} / {result.x}
    return String(arg).replace(/\{(slot|var|result)\.([\w.-]+)\}/g, (m, kind, path) => {
      const src = kind === 'slot' ? (ctx.slots || {}) : kind === 'var' ? (ctx.vars || {}) : (ctx.result || {})
      const v = String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), src)
      return (v === undefined || v === null) ? '' : String(v)
    })
  }
  return arg
}

function buildExprEnv(ctx) {
  // 槽位值拍平：slot.phone → '138...'
  const slotEnv = {}
  for (const [k, s] of Object.entries(ctx.slots || {})) {
    slotEnv[k] = (s && typeof s === 'object' && 'value' in s) ? s.value : s
  }
  return { slot: slotEnv, var: ctx.vars || {}, result: ctx.result || {} }
}

// ========== 主入口 ==========

/**
 * 条件求值（支持组合 and/or、时间、函数、表达式）
 * @param {Object} cond
 * @param {Object} ctx - { slots, vars, result }
 * @returns {Promise<boolean>}
 */
export async function evaluateCondition(cond, ctx = {}) {
  if (!cond) return false
  if (cond.and && Array.isArray(cond.and)) {
    for (const c of cond.and) if (!(await evaluateCondition(c, ctx))) return false
    return true
  }
  if (cond.or && Array.isArray(cond.or)) {
    for (const c of cond.or) if (await evaluateCondition(c, ctx)) return true
    return false
  }
  const source = cond.source || 'slot'

  if (source === 'time') {
    const d = cond.value ? new Date(cond.value) : new Date()
    if (cond.op === 'workday') return isWorkday(d)
    if (cond.op === 'business_hours') return isBusinessHour(d)
    return false
  }

  if (source === 'fn') {
    const fn = judges.get(cond.ref || cond.fn)
    if (!fn) return false
    const args = (cond.args || []).map(a => resolveArg(a, ctx))
    return !!(await fn(...args, ctx))
  }

  if (source === 'expr') {
    const v = evalExpr(cond.expr !== undefined ? cond.expr : cond.value, buildExprEnv(ctx))
    return !!v
  }

  const actual = resolveSource(cond, ctx)
  return evalOp(cond.op, actual, cond.value)
}

// ========== 时间判断（节假日/上班时间） ==========

let holidayCache = { year: null, data: null, at: 0 }
const HOLIDAY_TTL = 6 * 3600 * 1000 // 缓存 6 小时

/** 获取某年节假日数据（第三方 API：https://timor.tech/api/holiday/year/{year}），带缓存 */
async function fetchHolidayData(year) {
  if (holidayCache.year === year && Date.now() - holidayCache.at < HOLIDAY_TTL) return holidayCache.data
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
      const res = await fetch(`https://timor.tech/api/holiday/year/${year}`, { signal: controller.signal })
      const j = await res.json()
      if (j && j.code === 0 && j.holiday) {
        holidayCache = { year, data: j.holiday, at: Date.now() }
        return j.holiday
      }
    } finally {
      clearTimeout(timer)
    }
  } catch { /* 网络异常，降级 */ }
  return null
}

/** 工作日判断：节假日 API 优先（含调休），异常/未命中降级周一~周五 */
export async function isWorkday(date) {
  const d = date || new Date()
  const ymd = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  const dow = d.getDay()
  try {
    const data = await fetchHolidayData(d.getFullYear())
    if (data && data[ymd]) return !data[ymd].holiday // holiday:false = 调休上班日
  } catch { /* 降级 */ }
  return dow >= 1 && dow <= 5
}

/** 上班时间判断：sys_config work_start/work_end（默认 09:00–18:00） */
export async function isBusinessHour(date) {
  const d = date || new Date()
  let start = '09:00', end = '18:00'
  try {
    const cfg = await configRepo.getAll()
    if (cfg.work_start) start = cfg.work_start
    if (cfg.work_end) end = cfg.work_end
  } catch { /* 默认 */ }
  const cur = d.getHours() * 60 + d.getMinutes()
  const [sh, sm] = String(start).split(':').map(Number)
  const [eh, em] = String(end).split(':').map(Number)
  const s = (isNaN(sh) ? 9 : sh) * 60 + (isNaN(sm) ? 0 : sm)
  const e = (isNaN(eh) ? 18 : eh) * 60 + (isNaN(em) ? 0 : em)
  return cur >= s && cur < e
}

// ========== 内置判断函数 ==========

registerJudge('is_workday', async (date) => isWorkday(date ? new Date(date) : new Date()))
registerJudge('is_business_hour', async () => isBusinessHour(new Date()))

export default { registerJudge, listJudges, evaluateCondition, evalOp, isWorkday, isBusinessHour, describeCondition }
