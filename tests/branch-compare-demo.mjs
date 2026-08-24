// 对比演示：同一"报修分流"需求，三种实现方式的差异
// 场景：用户报修，按原因分流——"漏水"走漏水处理（调漏水接口），否则走普通处理
const BASE = 'http://localhost:3001'
async function post(path, body, token) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })
  return r.json()
}
const login = await post('/api/auth/login', { username: 'admin', password: 'admin123' })
const token = login.token

// 公共槽位
const slots = [{ key: 'reason', label: '原因', prompt: '请问什么情况？', required: true }]

// 任务①：LLM 版，无 branch 步骤（旧行为——没有分流能力，全靠 LLM 自由发挥）
const defNoBranch = {
  code: 'cmp_nobranch', name: '对比测试一', status: 1, trigger_keywords: ['对比测试一'],
  intent_examples: ['我要办一个对比测试业务'],
  slots,
  steps: [
    { key: 'c_reason', type: 'collect', slot_key: 'reason' },
    { key: 'confirm', type: 'confirm' },
    { key: 'submit', type: 'action', action: 'complete_message' },
  ],
  on_complete: 'complete_message',
}

// 任务②：规则版 + branch（步骤机确定性分流）
const defRuleBranch = {
  code: 'cmp_rulebranch', name: '对比测试二', status: 1, trigger_keywords: ['对比测试二'],
  intent_examples: ['我要办理规则版对比测试'],
  llm: { enabled: false },
  slots: [...slots, { key: 'leak_detail', label: '漏水详情', prompt: '请问漏水多严重？', required: true }],
  steps: [
    { key: 'c_reason', type: 'collect', slot_key: 'reason', next: 'branch_step' },
    { key: 'branch_step', type: 'branch',
      cases: [{ when: { source: 'slot', ref: 'reason', op: 'contains', value: '漏水' }, next: 'leak_q' }],
      default_next: 'normal_end' },
    { key: 'leak_q', type: 'collect', slot_key: 'leak_detail', next: 'confirm' },
    { key: 'normal_end', type: 'message', text: '好的，已按普通报修处理。' },
    { key: 'confirm', type: 'confirm' },
    { key: 'submit', type: 'action', action: 'complete_message' },
  ],
  on_complete: 'complete_message',
}

// 任务③：LLM 版 + branch（新功能——系统确定性分流 + 分支后接口触发）
const defLlmBranch = {
  code: 'cmp_llmbranch', name: '对比测试三', status: 1, trigger_keywords: ['对比测试三'],
  intent_examples: ['我要办理LLM版对比测试'],
  slots: [...slots, { key: 'leak_result', label: '漏水单号', required: false }],
  steps: [
    { key: 'c_reason', type: 'collect', slot_key: 'reason' },
    { key: 'branch_step', type: 'branch',
      cases: [{ when: { source: 'slot', ref: 'reason', op: 'contains', value: '漏水' }, next: 'leak_api' }],
      default_next: 'normal_api' },
    { key: 'leak_api', type: 'api', url: BASE + '/api/mock/order/create', method: 'POST',
      body: { reason: '{slot.reason}', branch: 'leak' }, resultMap: { leak_result: 'data.orderNo' }, done_message: '' },
    { key: 'normal_api', type: 'api', url: BASE + '/api/mock/order/create', method: 'POST',
      body: { reason: '{slot.reason}', branch: 'normal' }, resultMap: { leak_result: 'data.orderNo' }, done_message: '' },
  ],
  on_complete: 'complete_message',
}

for (const d of [defNoBranch, defRuleBranch, defLlmBranch]) {
  const r = await post('/api/tasks', d, token)
  if (!r.success) console.log('创建失败:', d.code, JSON.stringify(r).slice(0, 100))
}

async function runCase(triggerWord, reason, extra, skipConfirm) {
  const sid = 'cmp-' + Date.now()
  const flow = [triggerWord, ...(skipConfirm ? [] : ['办理']), reason, ...(extra || [])]
  console.log(`\n————— 用户输入：${flow.join(' → ')} —————`)
  for (const txt of flow) {
    const r = await post('/api/chat', { text: txt, sessionId: sid })
    console.log('  用户:', txt)
    console.log('  客服:', (r.answer || '').slice(0, 90).replace(/\n/g, ' '))
  }
  const g = await fetch(BASE + '/api/debug/session/' + sid, { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json())
  let branchTrace = null, apiCalls = [], slotStates = []
  for (const turn of (g.data.turns || [])) {
    for (const s of turn.steps) {
      if (s.step === '任务对话·分支判定') branchTrace = s.detail
      if (s.step === '任务·调用接口') apiCalls.push(s.detail.payload)
      if (s.step === '任务对话·槽位状态') slotStates.push(s.detail)
    }
  }
  if (branchTrace) console.log('  [trace] 分支判定:', JSON.stringify(branchTrace))
  if (apiCalls.length) console.log('  [trace] 接口调用:', JSON.stringify(apiCalls))
  if (!branchTrace && !apiCalls.length) console.log('  [trace] 无分支判定、无接口调用')
  return { branchTrace, apiCalls }
}

console.log('\n============================================================')
console.log('对比一：LLM 版任务【没有 branch 步骤】（旧行为）')
console.log('============================================================')
await runCase('对比测试一', '厨房漏水了', [], true)

console.log('\n============================================================')
console.log('对比二：规则版任务【有 branch 步骤】（步骤机确定性分流）')
console.log('============================================================')
// 规则版触发直接进入收集（无需"办理"澄清），直接回答原因即可
await runCase('对比测试二', '厨房漏水了', ['渗水很严重'], /* skipConfirm */ true)

console.log('\n============================================================')
console.log('对比三：LLM 版任务【有 branch 步骤】（新功能：LLM 对话 + 系统判定分流）')
console.log('============================================================')
await runCase('对比测试三', '厨房漏水了', [], true)
console.log('  → 对比看：同样说"厨房漏水了"，LLM 版无分支=靠 LLM 自由发挥（无判定无接口）；')
console.log('     规则版=按步骤机问漏水详情；LLM 版有分支=LLM 对话但分流由系统判定、漏水接口被触发')

// 清理
for (const c of ['cmp_nobranch', 'cmp_rulebranch', 'cmp_llmbranch']) {
  await fetch(BASE + '/api/tasks/' + c, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })
}


