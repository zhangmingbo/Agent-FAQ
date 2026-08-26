// 测试：LLM 调用日志记录（dialogue 节点）
const BASE = 'http://localhost:3001'
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(r => r.json())
const token = login.token
async function chat(text, sid) {
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, sessionId: sid }) })
  return r.json()
}
let pass = 0, fail = 0
function t(name, cond, extra) { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') } }

console.log('===== LLM 调用日志 =====')
// 触发任务对话（LLM 模式），产生 dialogue 调用
const sid = 'llmlog-' + Date.now()
await chat('怎么预约上门服务', sid)
await chat('13800138000', sid)

// 查询该会话的 LLM 调用日志
const r = await fetch(BASE + '/api/debug/llm-calls?sessionId=' + encodeURIComponent(sid), { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json())
console.log('  条数:', r.data && r.data.items ? r.data.items.length : 0)
t('① 接口成功且有记录', r.success && r.data && r.data.items.length > 0, r.data)
if (r.data && r.data.items.length > 0) {
  const first = r.data.items[0]
  console.log('  第一条:', JSON.stringify({ node: first.node, status: first.status, durationMs: first.durationMs, sessionId: first.sessionId, user: (first.user || '').slice(0, 40) }, null, 1))
  t('② 记录含节点名（dialogue）', first.node === 'dialogue' || first.node === 'extract' || first.node === 'trigger', first.node)
  t('③ 记录关联到正确会话', first.sessionId === sid, first.sessionId)
  t('④ 记录含请求/响应内容', !!(first.user && first.response), { user: (first.user || '').slice(0, 30), resp: (first.response || '').slice(0, 30) })
  t('⑤ 记录含耗时', typeof first.durationMs === 'number' && first.durationMs > 0, first.durationMs)
}

// 全局列表也应有记录
const all = await fetch(BASE + '/api/debug/llm-calls?limit=10', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json())
t('⑥ 全局列表正常', all.success && Array.isArray(all.data.items))

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
