/**
 * LLM 驱动对话评测（真实客服数据金标准）
 *
 * 数据源：tt.xml（真实沁园客服会话，28 个 SESSION）
 * 方法：把每个会话的「客户发言」按时间顺序回放给 LLMDialogManager，
 *       对照会话中出现的真实信息（电话/地址/姓名/服务类型/时间等）检查是否被正确收集。
 *
 * 用法：
 *   node tests/dialogue.eval.mjs                # 离线 mock（校验脚手架本身）
 *   RUN_MODE=real node tests/dialogue.eval.mjs  # 真实 LLM（需 .env 有 DEEPSEEK_API_KEY）
 *   FILTER=xxx node tests/dialogue.eval.mjs     # 只跑包含指定 session 片段
 *   TOP=5     node tests/dialogue.eval.mjs      # 只跑前 N 个会话（快速调试）
 *
 * 输出：每个会话的槽位收集通过率 + 汇总。>=90% 为阶段验收线。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import LLMDialogManager from '../services/taskflow/llmDialogManager.js'
import { TaskState } from '../services/taskflow/stateMachine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TT_XML = path.join(__dirname, '..', 'tt.xml')

// ========== 1) 解析 tt.xml ==========

/**
 * 解析 tt.xml → { sessionId: [{time, sender, content}] }
 * 发送者：坐席 | 客户
 */
export function parseTtXml(xml) {
  const sessions = new Map()
  const recordRe = /<RECORD>([\s\S]*?)<\/RECORD>/g
  const tag = (name) => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i')

  let m
  while ((m = recordRe.exec(xml)) !== null) {
    const body = m[1]
    const g = (name) => {
      const mm = body.match(tag(name))
      return mm ? mm[1].trim() : ''
    }
    const sessionId = g('SESSIONID')
    if (!sessionId) continue
    const sender = g('发送者')
    if (sender !== '客户' && sender !== '坐席') continue
    const time = g('DATATIMESTAMP')
    const content = g('CONTENT')
    if (!content) continue
    if (!sessions.has(sessionId)) sessions.set(sessionId, [])
    sessions.get(sessionId).push({ time, sender, content })
  }

  // 按时间排序（字符串时间戳近似有序，按出现顺序即可）
  for (const msgs of sessions.values()) {
    msgs.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  }
  return sessions
}

// ========== 2) 金标准提取（从客户真实发言中找信息） ==========

const PHONE_RE = /1[3-9]\d{9}/
const NAME_RE = /联系(人|电话)?[:：]?\s*([\u4e00-\u9fa5]{2,4})/
const MODEL_RE = /型号[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9\-]{2,20})/
const ADDR_HINT = /(路|街|区|号|小区|苑|村|大厦|公寓|号楼)/
const SERVICE_WORDS = ['维修', '保养', '换芯', '检测', '移机', '拆机']
const TIME_WORDS = ['今天上午', '今天下午', '明天', '全天']

/**
 * 从会话的客户发言中提取期望槽位 → { phone: [...], address: [...], ... }
 * @param {Array<{sender:string, content:string}>} msgs
 */
export function extractGold(msgs) {
  const gold = { phone: [], address: [], customer_name: [], machine_model: [], service_type: [], time_slot: [] }
  for (const msg of msgs) {
    if (msg.sender !== '客户') continue
    const c = msg.content
    const phone = c.match(PHONE_RE)
    if (phone) pushUnique(gold.phone, phone[0])

    // 联系人姓名（避免抓取整句）
    const name = c.match(NAME_RE)
    if (name && c.length < 60) pushUnique(gold.customer_name, name[2])

    const model = c.match(MODEL_RE)
    if (model) pushUnique(gold.machine_model, model[1])

    // 地址：出现地址提示词且长度足够（去掉电话后的有效内容）
    if (ADDR_HINT.test(c) && c.replace(PHONE_RE, '').length >= 8) {
      pushUnique(gold.address, c.replace(PHONE_RE, '').trim())
    }

    for (const w of SERVICE_WORDS) if (c.includes(w)) pushUnique(gold.service_type, w)
    for (const w of TIME_WORDS) if (c.includes(w)) pushUnique(gold.time_slot, w)
  }
  return gold
}

function pushUnique(arr, v) {
  if (v && !arr.includes(v)) arr.push(v)
}

// ========== 3) 评测任务定义（对齐线上 service_appointment） ==========

const EVAL_TASK = {
  code: 'eval_appointment',
  name: '上门服务预约',
  slots: [
    { key: 'phone', label: '联系电话', required: true },
    { key: 'service_type', label: '服务类型', required: true },
    { key: 'customer_name', label: '客户姓名', required: false },
    { key: 'address', label: '地址', required: true },
    { key: 'machine_model', label: '机器型号', required: false },
    { key: 'time_slot', label: '上门时间', required: false },
  ],
  steps: [
    { key: 's1', type: 'collect', slot_key: 'phone', question: '请提供您的联系电话：' },
    { key: 's2', type: 'collect', slot_key: 'service_type', question: '请问需要什么服务？', extract: { method: 'enum', enum: SERVICE_WORDS } },
    { key: 's3', type: 'collect', slot_key: 'customer_name', question: '请问怎么称呼您？' },
    { key: 's4', type: 'collect', slot_key: 'address', question: '请提供您的地址：' },
    { key: 's5', type: 'collect', slot_key: 'machine_model', question: '请问机器型号是？' },
    { key: 's6', type: 'collect', slot_key: 'time_slot', question: '请问什么时间方便上门？', extract: { method: 'enum', enum: TIME_WORDS } },
    { key: 'act', type: 'action', action: 'complete_message', done_message: '预约已确认！' },
  ],
}

const DEFS = {
  get(code) {
    return code === EVAL_TASK.code ? EVAL_TASK : null
  },
}

// ========== 4) 两种 NLU：mock（离线） / 真实 LLM ==========

/** mock NLU：启发式单轮决策（验证脚手架，不调用网络） */
function makeMockNlu() {
  const method = (slotKey) => (EVAL_TASK.steps.find(s => s.slot_key === slotKey)?.extract?.method) || 'text'
  return {
    async dialogue({ task, slotDesc, filledDesc, history, text }) {
      const slots = {}
      if (PHONE_RE.test(text)) slots.phone = text.match(PHONE_RE)[0]
      for (const w of SERVICE_WORDS) if (text.includes(w)) { slots.service_type = w; break }
      for (const w of TIME_WORDS) if (text.includes(w)) { slots.time_slot = w; break }
      const name = text.match(NAME_RE)
      if (name) slots.customer_name = name[2]
      if (ADDR_HINT.test(text) && text.replace(PHONE_RE, '').length >= 8) {
        slots.address = text.replace(PHONE_RE, '').trim()
      }
      const filled = Object.keys(slots)
      return {
        slots,
        reply: filled.length ? `已记录：${filled.join('、')}。` : '请继续。',
        ask_confirm: false,
        question: null,
      }
    },
    valueMatchesSlot(slotDef, value) {
      const m = method(slotDef.key)
      if (m === 'enum') {
        const opts = slotDef.extract?.enum || []
        return opts.includes(String(value))
      }
      return true
    },
    validate() {
      return { ok: true }
    },
  }
}

/** 真实 LLM NLU：加载 .env 并配置 llmClient */
async function makeRealNlu() {
  const { config } = await import('dotenv')
  config({ path: path.join(__dirname, '..', '.env') })
  const nlu = (await import('../services/taskflow/nlu.js')).default
  const llmClient = (await import('../services/taskflow/llm.js')).default
  llmClient.configure(llmClient.resolveFromDb({}))
  nlu.setMode('llm')
  if (!llmClient.enabled) throw new Error('真实模式需要 .env 中配置 DEEPSEEK_API_KEY')
  return nlu
}

// ========== 5) 会话回放评测 ==========

/**
 * 回放一个会话的客户发言，检查期望槽位是否被收集
 * @returns {{sessionId, gold:Object, collected:Object, pass:Object, msgs:number}}
 */
async function evalSession(sessionId, msgs, nlu, opts = {}) {
  const mgr = new LLMDialogManager(DEFS, nlu)
  const state = {
    sessionId,
    taskCode: EVAL_TASK.code,
    taskName: EVAL_TASK.name,
    status: TaskState.COLLECTING,
    slots: mgr.initSlots(EVAL_TASK),
    stack: [],
    turnCount: 0,
    history: [],
    startedAt: Date.now(),
    lastActive: Date.now(),
  }

  const gold = extractGold(msgs)
  const collected = {}

  const userMsgs = msgs.filter(m => m.sender === '客户')
  const limit = opts.topTurns || userMsgs.length
  for (const msg of userMsgs.slice(0, limit)) {
    const c = msg.content.trim()
    if (!c) continue
    try {
      await mgr.processTurn(state, c)
    } catch (e) {
      // LLM 失败降级由引擎层做；评测里记录并继续（真实模式超时会走到这里）
      console.warn(`  [${sessionId}] 轮次失败: ${e.message}`)
    }
  }

  for (const [key, values] of Object.entries(gold)) {
    if (values.length === 0) continue
    const slot = state.slots[key]
    const got = slot?.value ? String(slot.value) : ''
    // 宽松匹配：LLM 可能提取出更规范的表达（如"嘉定江桥"⊂地址原句）
    const ok = !!got && values.some(v => got.includes(v) || v.includes(got))
    collected[key] = got
    // 仅记录 pass 结构
    if (opts.detail) {
      console.log(`    ${key}: 期望=${values.join('|')} 得到=${got || '（未收集）'} ${ok ? '✅' : '❌'}`)
    }
    if (!collected._pass) collected._pass = {}
    collected._pass[key] = ok
  }

  return { sessionId, gold, collected, msgs: userMsgs.length }
}

// ========== 6) 主流程 ==========

async function main() {
  const runMode = process.env.RUN_MODE === 'real' ? 'real' : 'mock'
  const filter = process.env.FILTER || ''
  const top = parseInt(process.env.TOP || '0', 10)

  const xml = readFileSync(TT_XML, 'utf8')
  const sessions = parseTtXml(xml)
  console.log(`[eval] 解析 ${sessions.size} 个会话 (模式: ${runMode})`)

  const nlu = runMode === 'real' ? await makeRealNlu() : makeMockNlu()

  let totalSlots = 0
  let passSlots = 0
  let totalSessions = 0
  let passSessions = 0

  const allEntries = [...sessions.entries()].filter(([id]) => !filter || id.includes(filter))
  const entries = top > 0 ? allEntries.slice(0, top) : allEntries

  for (const [id, msgs] of entries) {
    const r = await evalSession(id, msgs, nlu)
    const goldKeys = Object.keys(r.gold).filter(k => r.gold[k].length > 0)
    if (goldKeys.length === 0) continue
    totalSessions++
    const okKeys = goldKeys.filter(k => r.collected._pass[k])
    totalSlots += goldKeys.length
    passSlots += okKeys.length
    const sp = okKeys.length === goldKeys.length
    if (sp) passSessions++
    console.log(`[会话] ${id} (客户发言 ${r.msgs} 条) 槽位 ${okKeys.length}/${goldKeys.length} ${sp ? '✅' : '⚠️'} ${okKeys.join(',') || ''}`)
  }

  console.log('\n========== 汇总 ==========')
  console.log(`会话: ${passSessions}/${totalSessions} 全槽通过`)
  console.log(`槽位: ${passSlots}/${totalSlots} (${(passSlots / Math.max(totalSlots, 1) * 100).toFixed(1)}%)`)
  const rate = passSlots / Math.max(totalSlots, 1)
  console.log(rate >= 0.9 ? '✅ 达到阶段验收线 (>=90%)' : '⚠️ 未达验收线，需要调优提示词')
}

// 仅直接运行时执行主流程（被 import 时只导出函数，供其他测试复用）
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('[eval] 失败:', e)
    process.exit(1)
  })
}
