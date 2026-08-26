// 验证：投诉兜底（A1）
const BASE = 'http://localhost:3001'
let pass = 0, fail = 0
function t(name, cond, extra) { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') } }

async function chat(text, sid) {
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, sessionId: sid }) })
  return r.json()
}

console.log('===== A1 投诉兜底 =====')
const sid = 'complaint-' + Date.now()
const r1 = await chat('你们服务太差了，我要投诉', sid)
t('① 命中投诉 → source=complaint', r1.source === 'complaint', { s: r1.source })
t('② 回复含安抚话术', (r1.answer || '').includes('人工客服'), { a: (r1.answer || '').slice(0, 40) })
t('③ 附转人工事件', Array.isArray(r1.events) && r1.events.some(e => e.type === 'transfer_human'), r1.events)
t('④ 事件带 reason', r1.events && r1.events[0].reason === 'complaint:投诉', r1.events && r1.events[0])

const r2 = await chat('我不是投诉，我是问滤芯怎么换', 'complaint2-' + Date.now())
t('⑤ 否定表达不触发（走 FAQ 或正常路由）', r2.source !== 'complaint', { s: r2.source })

const r3 = await chat('我要找消协投诉你们', 'complaint3-' + Date.now())
t('⑥ 消协词触发', r3.source === 'complaint' && r3.events && r3.events.length > 0, { s: r3.source })

// 任务中投诉：应打断任务转人工
const sid4 = 'complaint4-' + Date.now()
await chat('换表', sid4)
const r4 = await chat('你们太垃圾了，我要投诉', sid4)
t('⑦ 任务中投诉仍触发', r4.source === 'complaint' && r4.events && r4.events.length > 0, { s: r4.source })

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
