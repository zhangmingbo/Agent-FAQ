// 测试3：挂起提醒（规则版任务，加例句让触发词过仲裁）
const BASE = 'http://localhost:3001'
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(r => r.json())
const token = login.token
async function chat(text, sid) {
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, sessionId: sid }) })
  return r.json()
}
async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
  return r.json()
}
let pass = 0, fail = 0
function t(name, cond, extra) { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') } }

const ruleTask = {
  code: 'suspend_rule_test', name: '挂起规则测试', status: 1, trigger_keywords: ['挂起规则测试'],
  intent_examples: ['我要办理挂起规则测试', '帮我处理挂起规则测试业务', '挂起规则测试申请'],
  llm: { enabled: false },
  slots: [{ key: 'phone', label: '联系电话', prompt: '请问您的电话？', required: true }],
  steps: [
    { key: 'c_phone', type: 'collect', slot_key: 'phone', next: 'confirm' },
    { key: 'confirm', type: 'confirm', next: 'submit' },
    { key: 'submit', type: 'action', action: 'complete_message' },
  ],
}
const sv = await post('/api/tasks', ruleTask)
console.log('保存:', sv.success)
const sid = 'susp-rule2-' + Date.now()
const r1 = await chat('挂起规则测试', sid)
t('① 任务开始', r1.source === 'task_started' || r1.source === 'task_progress', { s: r1.source, a: (r1.answer || '').slice(0, 40) })
if (r1.source === 'task_started' || r1.source === 'task_progress') {
  const r2 = await chat('滤芯多久换一次', sid)
  console.log('  ② FAQ 插话:', r2.source, '|', (r2.answer || '').slice(0, 40))
  t('② FAQ 插话 → 任务挂起', r2.source === 'task_suspended_faq', { s: r2.source })
  if (r2.source === 'task_suspended_faq') {
    const r3 = await chat('我手表坏了', sid)
    console.log('  ③ 无关话术:', r3.source, '|', (r3.answer || '').slice(0, 50))
    t('③ 挂起中无关话术 → 提醒', r3.source === 'task_suspended_remind', { s: r3.source })
    t('④ 提醒含任务名与"继续"', (r3.answer || '').includes('挂起规则测试') && (r3.answer || '').includes('继续'), { a: (r3.answer || '').slice(0, 40) })
    const r4 = await chat('继续', sid)
    t('⑤ 继续 → 恢复任务', r4.source === 'task_resumed' || r4.source === 'task_progress', { s: r4.source })
  }
}
await fetch(BASE + '/api/tasks/suspend_rule_test', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
