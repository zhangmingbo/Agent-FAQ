// 全流程测试：答案反馈闭环 + 任务漏斗
import pool from '../db/pool.js'
const BASE = 'http://localhost:3001'
async function post(path, body, token) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })
  return { status: r.status, data: await r.json() }
}
async function get(path, token) {
  const r = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
  return r.json()
}
const login = await post('/api/auth/login', { username: 'admin', password: 'admin123' })
const token = login.data.token

let pass = 0, fail = 0
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

// ===== A. 答案反馈闭环 =====
console.log('===== A. 答案反馈闭环 =====')
// ① 先问一个 FAQ，再否定它
const sid = 'fb-' + Date.now()
const r1 = await post('/api/chat', { text: '滤芯多久换一次', sessionId: sid })
t('① FAQ 回答成功', !!r1.data.answer && r1.data.source !== 'fallback', { s: r1.data.source, a: (r1.data.answer || '').slice(0, 20) })
const r2 = await post('/api/chat', { text: '不是这个，我问的是别的型号', sessionId: sid })
console.log('    否定回复 source:', r2.data.source)

// ② 反馈表有记录
const [fb] = await pool.execute('SELECT user_text, answer FROM answer_feedback WHERE session_id = ?', [sid])
t('② 反馈落库', fb.length === 1 && fb[0].user_text.includes('不是这个'), fb[0])

// ③ 查询接口
const fbApi = await get('/api/analysis/feedback', token)
t('③ feedback 接口', fbApi.success && Array.isArray(fbApi.items) && fbApi.items.some(i => i.user_text.includes('不是这个')), fbApi.items)

// ④ 正常输入不触发反馈
const sid2 = 'fb2-' + Date.now()
await post('/api/chat', { text: '滤芯多久换一次', sessionId: sid2 })
await post('/api/chat', { text: '好的谢谢', sessionId: sid2 })
const [fb2] = await pool.execute('SELECT COUNT(*) AS c FROM answer_feedback WHERE session_id = ?', [sid2])
t('④ 正常对话不误记录', fb2[0].c === 0)

// ===== B. 任务漏斗 =====
console.log('===== B. 任务漏斗 =====')
const r3 = await get('/api/analysis/funnel', token)
t('① funnel 接口', r3.success && Array.isArray(r3.items), r3.items)
const meter = r3.items.find(i => i.task === 'meter_replace')
t('② meter_replace 有统计数据', !!meter && typeof meter.started === 'number', meter)
t('③ 完成率字段存在', meter && typeof meter.completeRate === 'number')
console.log('    funnel:', JSON.stringify(r3.items.map(i => ({ t: i.task, s: i.started, c: i.completed, ok: i.actionOk, rate: i.completeRate }))))

// 清理测试反馈数据
await pool.execute('DELETE FROM answer_feedback WHERE session_id LIKE "fb-%" OR session_id LIKE "fb2-%"')
await pool.end()
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
