// 测试：任务活跃中域外输入不再被 LLM 消化成任务话术
const BASE = 'http://localhost:3001'
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(r => r.json())
const token = login.token
async function chat(text, sid) {
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, sessionId: sid }) })
  return r.json()
}
let pass = 0, fail = 0
function t(name, cond, extra) { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') } }

console.log('===== 任务活跃中域外快检 =====')
const sid = 'oosc-' + Date.now()
const r1 = await chat('怎么预约上门服务', sid)
t('① 任务开始', r1.source === 'task_started', { s: r1.source })

// ② 域外话术（日志场景）：应 fallback，不再被 LLM 消化
const r2 = await chat('我电脑坏了', sid)
console.log('  ② "我电脑坏了" →', r2.source, '|', (r2.answer || '').slice(0, 50))
t('② 域外输入 → 业务引导（非 task_progress）', r2.source !== 'task_progress', { s: r2.source })

// ③ 裸槽位回答仍正常收集（纯数字电话）
const r3 = await chat('13800138000', sid)
console.log('  ③ 电话 →', r3.source, '|', (r3.answer || '').slice(0, 50))
t('③ 纯数字电话仍进任务对话', r3.source === 'task_progress', { s: r3.source })

// ④ 含槽位标签的回答（地址）仍正常
const r4 = await chat('地址是幸福小区3栋502', sid)
t('④ 含标签回答仍进任务对话', r4.source === 'task_progress', { s: r4.source })

// ⑤ 短句姓名
const r5 = await chat('张伟', sid)
t('⑤ 短句姓名仍进任务对话', r5.source === 'task_progress', { s: r5.source })

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
