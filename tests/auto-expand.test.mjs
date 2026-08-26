// 测试 C：直接注入 fallback 日志验证扩写链路（绕过识别，测扩写本身）
import pool from '../db/pool.js'
import autoExpandService from '../services/autoExpandService.js'
import { default as FaqService } from '../services/faqService.js'

let pass = 0, fail = 0
function t(name, cond, extra) { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '') } }

// ① 加载引擎 + 注入
const svc = new FaqService()
await svc.loadAll()
autoExpandService.setNlpEngine(svc.recognizer.nlpEngine, svc.recognizer.allSamples)
autoExpandService.setFaqService(svc)
autoExpandService.configure({ simThreshold: 0.75, minCount: 2, enabled: true })

// ② 先探测：哪些变体向量匹配到知识 FAQ（>0.75）
const candidates = ['换滤芯费用多少', '上门换芯怎么收费', '滤芯换一次要多少钱', '安装净水机多少钱', '保修期是几年', '你们上门安装怎么收费']
for (const text of candidates) {
  const m = await autoExpandService._matchFaq(text)
  console.log(`  探测 "${text}" → ${m ? m.intentCode + ' ' + m.intentName + ' sim=' + m.similarity.toFixed(3) : '无匹配'}`)
}

// ③ 选一个匹配上的注入 chat_log（fallback ×3）
const target = '滤芯换一次要多少钱'
const m = await autoExpandService._matchFaq(target)
if (!m) { console.log('  没有可用测试句，跳过'); process.exit(0) }
const sid = 'expand-test-' + Date.now()
for (let i = 0; i < 3; i++) {
  await pool.execute(
    "INSERT INTO chat_log (session_id, user_id, user_text, intent_code, confidence, source, answer, meaningful) VALUES (?, 'test', ?, NULL, 0, 'fallback', '兜底', 1)",
    [sid, target]
  )
}

// ④ 跑扩写
const before = await autoExpandService.list()
const run = await autoExpandService.run()
console.log('  run added:', JSON.stringify(run.added, null, 1))
t('① 目标句被扩写', run.added.some(a => a.text === target), run.added)
// 短句防护：现有 fallback "习近平"(3字) 不应被扩写
t('①c 短句不被扩写（习近平）', !run.added.some(a => a.text === '习近平'), run.added)

// ④b 该相似问已写库
const [qrow] = await pool.execute('SELECT id FROM faq_question WHERE question = ?', [target])
t('①b 相似问已写入 faq_question', qrow.length === 1)

// ⑤ 审计落库
const after = await autoExpandService.list()
t('② 审计表新增记录', after.length > before.length && after.some(i => i.user_text === target && i.status === 'applied'), after[0])

// ⑥ 幂等：再跑不重复
const run2 = await autoExpandService.run()
t('③ 重复 run 无重复', !run2.added.some(a => a.text === target), run2.added)

// ⑦ 回滚
const row = after.find(i => i.user_text === target)
const rev = await autoExpandService.revert(row.id)
t('④ 回滚成功', rev.ok === true, rev)
const [exists] = await pool.execute('SELECT id FROM faq_question WHERE question = ?', [target])
t('⑤ 相似问已删除', exists.length === 0)
const after2 = await autoExpandService.list()
t('⑥ 审计标记 reverted', after2.find(i => i.id === row.id)?.status === 'reverted')

// 清理
await pool.execute("DELETE FROM chat_log WHERE session_id = ?", [sid])
await pool.execute("DELETE FROM expand_audit WHERE user_text = ?", [target])

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
await pool.end()
process.exit(fail ? 1 : 0)
