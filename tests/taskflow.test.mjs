/**
 * TaskFlow 引擎测试（可重复运行）
 *
 * 运行: node tests/taskflow.test.mjs
 *
 * 覆盖：触发匹配 / 完整收集流程 / 校验重问 / 确认 / 取消 / 槽位纠正（收集态+确认态）
 *      否认 / 子任务 / 分支 / 挂起恢复 / 状态机一致性
 *
 * 注意：initialize 会读写真实数据库（task 表），请确保 DB 可达。
 * 测试注入的临时任务定义（address_query/combo/branchy）结束后会清理。
 */

import taskEngine from '../services/taskflow/index.js'
import TaskDefs from '../services/taskflow/taskDefs.js'
import { validateTransitions } from '../services/taskflow/stateMachine.js'

let pass = 0
let fail = 0

function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  [PASS] ${name} ${extra}`) }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`) }
}

// 状态机一致性
{
  const errors = validateTransitions()
  check('状态机转移表一致', errors.length === 0, errors.join(';'))
}

await taskEngine.initialize({ storeDriver: 'memory' })
const def = await taskEngine.matchTask('我要报修燃气表')
check('触发匹配 repair_order', def?.code === 'repair_order', `| code=${def?.code}`)
check('v2 DSL 步骤已生效（含 confirm 与 action）',
  def.steps.some(s => s.type === 'confirm') && def.steps.some(s => s.type === 'action'))

let r

// ===== 完整报修流程 =====
taskEngine.startTask('t-full', def)
r = await taskEngine.processInput('t-full', '我要报修燃气表')
check('首轮不误提取文本槽位', r.extracted === false && !r.taskState.slots.address.filled)
r = await taskEngine.processInput('t-full', '幸福小区3栋502')
check('填地址', r.taskState.slots.address.filled && !r.taskState.slots.fault.filled)
r = await taskEngine.processInput('t-full', '燃气表不走了')
check('填故障描述', r.taskState.slots.fault.filled)
r = await taskEngine.processInput('t-full', '123')
check('非法电话→重问', r.reask === true && !r.taskState.slots.phone.filled)
r = await taskEngine.processInput('t-full', '13800138000')
check('填电话→进入确认', r.taskState.slots.phone.filled && r.taskState.status === 'confirming')
r = await taskEngine.processInput('t-full', '确认')
check('确认→动作→完成', r.isComplete === true, `| ${r.reply.slice(0, 30)}`)
check('完成后会话清除', !taskEngine.hasActiveTask('t-full'))

// ===== 取消 =====
taskEngine.startTask('t-cancel', def)
r = await taskEngine.processInput('t-cancel', '取消')
check('取消', r.cancelled === true)

// ===== 槽位纠正（收集态 + 确认态） =====
taskEngine.startTask('t-corr', def)
await taskEngine.processInput('t-corr', '我要报修')
await taskEngine.processInput('t-corr', '幸福小区3栋502')
r = await taskEngine.processInput('t-corr', '地址改成阳光花园5栋')
check('收集态纠正', r.taskState.slots.address.value === '阳光花园5栋', `| ${r.taskState.slots.address.value}`)
await taskEngine.processInput('t-corr', '取消')

taskEngine.startTask('t-corr2', def)
await taskEngine.processInput('t-corr2', '我要报修')
await taskEngine.processInput('t-corr2', '幸福小区3栋502')
await taskEngine.processInput('t-corr2', '燃气表不走了')
await taskEngine.processInput('t-corr2', '13800138000')
r = await taskEngine.processInput('t-corr2', '电话换成13900000000')
check('确认态别名纠正', r.taskState.slots.phone.value === '13900000000', `| ${r.taskState.slots.phone.value}`)
r = await taskEngine.processInput('t-corr2', '确认')
check('纠正后确认完成', r.isComplete === true)

// ===== 确认态否认 =====
taskEngine.startTask('t-deny', def)
await taskEngine.processInput('t-deny', '我要报修')
await taskEngine.processInput('t-deny', '幸福小区3栋502')
await taskEngine.processInput('t-deny', '燃气表不走了')
await taskEngine.processInput('t-deny', '13800138000')
r = await taskEngine.processInput('t-deny', '不是')
check('确认态否认→回到填槽', r.taskState.status === 'collecting', `| status=${r.taskState.status}`)
await taskEngine.processInput('t-deny', '取消')

// ===== 校验重问 =====
taskEngine.startTask('t-validate', def)
await taskEngine.processInput('t-validate', '我要报修')
r = await taskEngine.processInput('t-validate', '甲路')
check('地址过短→重问', r.reask === true, `| ${r.reply.slice(0, 20)}`)
await taskEngine.processInput('t-validate', '取消')

// ===== 子任务 =====
TaskDefs.defs.set('address_query', {
  code: 'address_query', name: '地址查询', trigger_keywords: ['地址'],
  slots: [{ key: 'street', label: '街道', required: true }],
  steps: [
    { key: 'c1', type: 'collect', slot_key: 'street', label: '街道', required: true, prompt: '请提供街道', next: 'act' },
    { key: 'act', type: 'action', action: 'complete_message', done_message: '地址查询完成' },
  ],
})
TaskDefs.defs.set('combo', {
  code: 'combo', name: '组合任务', trigger_keywords: ['组合'],
  slots: [{ key: 'addr', label: '完整地址', required: true }],
  steps: [
    { key: 'sub', type: 'subtask', task: 'address_query', on_return: 'c2' },
    { key: 'c2', type: 'collect', slot_key: 'addr', label: '完整地址', required: true, prompt: '请提供完整地址', next: 'confirm_step' },
    { key: 'confirm_step', type: 'confirm', next: 'act2' },
    { key: 'act2', type: 'action', action: 'complete_message', done_message: '已生成工单' },
  ],
})
taskEngine.startTask('t-combo', TaskDefs.defs.get('combo'))
r = await taskEngine.processInput('t-combo', '组合')
check('进入子任务', r.taskState.taskCode === 'address_query', `| task=${r.taskState.taskCode}`)
r = await taskEngine.processInput('t-combo', '人民路')
check('子任务完成返回父任务', r.taskState.taskCode === 'combo' && r.taskState.currentStep === 'c2', `| step=${r.taskState.currentStep}`)
r = await taskEngine.processInput('t-combo', '幸福小区')
check('父任务继续填槽', r.taskState.slots.addr.filled)
r = await taskEngine.processInput('t-combo', '确认')
check('父任务完成', r.isComplete === true)
TaskDefs.defs.delete('address_query')
TaskDefs.defs.delete('combo')

// ===== 分支 =====
TaskDefs.defs.set('branchy', {
  code: 'branchy', name: '分支任务', trigger_keywords: ['分支'],
  slots: [{ key: 'type', label: '故障类型', required: true }],
  steps: [
    { key: 'c1', type: 'collect', slot_key: 'type', label: '故障类型', required: true, prompt: '什么故障？', extract: { method: 'enum', enum: ['漏水', '不通气'] }, next: 'br' },
    { key: 'br', type: 'branch', cases: [{ when: { slot: 'type', op: 'eq', value: '漏水' }, next: 'leak' }, { when: { slot: 'type', op: 'eq', value: '不通气' }, next: 'gas' }], default_next: 'act3' },
    { key: 'leak', type: 'message', text: '漏水：请关总阀。', next: 'act3' },
    { key: 'gas', type: 'message', text: '不通气：检查燃气表。', next: 'act3' },
    { key: 'act3', type: 'action', action: 'complete_message', done_message: '处理完成' },
  ],
})
taskEngine.startTask('t-branch', TaskDefs.defs.get('branchy'))
await taskEngine.processInput('t-branch', '分支')
r = await taskEngine.processInput('t-branch', '漏水')
check('分支→漏水分支', r.reply.includes('关总阀'), `| ${r.reply.slice(0, 25)}`)
check('分支后完成', r.isComplete === true)
TaskDefs.defs.delete('branchy')

// ===== 挂起/恢复 =====
taskEngine.startTask('t-suspend', def)
await taskEngine.processInput('t-suspend', '我要报修')
r = await taskEngine.processInput('t-suspend', '燃气费怎么算？')
check('疑问句不提取+任务仍活跃', r.extracted === false && taskEngine.hasActiveTask('t-suspend'))
r = await taskEngine.processInput('t-suspend', '阳光花园7号')
check('恢复后继续填槽', r.taskState.slots.address.filled)
await taskEngine.processInput('t-suspend', '取消')

// ===== 智能增强：近义扩展触发（口语化） =====
{
  const hit1 = await taskEngine.matchTask('师傅，我家煤气表好像出问题了，麻烦来修一下')
  check('口语化触发（出问题）', hit1?.code === 'repair_order', `| code=${hit1?.code}`)
  const hit2 = await taskEngine.matchTask('燃气表不动了，能不能来个人看看')
  check('口语化触发（不动了）', hit2?.code === 'repair_order', `| code=${hit2?.code}`)
  const hit3 = await taskEngine.matchTask('我的表走字不准')
  check('口语化触发（不准）', hit3?.code === 'repair_order', `| code=${hit3?.code}`)
  const neg1 = await taskEngine.matchTask('你好')
  check('问候不触发任务', neg1 === null, `| code=${neg1?.code || 'null'}`)
  const neg2 = await taskEngine.matchTask('燃气表没坏，我就是问问怎么查余额')
  check('否定句不触发任务', neg2 === null, `| code=${neg2?.code || 'null'}`)
}

// ===== 智能增强：首轮显式标签提取 =====
taskEngine.startTask('t-smart1', def)
r = await taskEngine.processInput('t-smart1', '我要报修，地址是幸福小区3栋502')
check('首轮标签提取地址', r.taskState.slots.address.filled && r.taskState.slots.address.value === '幸福小区3栋502', `| value=${r.taskState.slots.address.value}`)
await taskEngine.processInput('t-smart1', '取消')

// ===== 智能增强：一轮多槽（标签锚点） =====
taskEngine.startTask('t-smart2', def)
r = await taskEngine.processInput('t-smart2', '我要报修，地址是幸福小区3栋502，燃气表不走了，电话13800138000')
check('一轮填地址+电话', r.taskState.slots.address.filled && r.taskState.slots.phone.filled && !r.taskState.slots.fault.filled,
  `| address=${r.taskState.slots.address.value} phone=${r.taskState.slots.phone.value}`)
check('剩余槽位被追问', r.reply.includes('故障') || r.reply.includes('描述'), `| reply=${r.reply.slice(0, 40)}`)
await taskEngine.processInput('t-smart2', '取消')

// ===== 智能增强：边答边问 =====
taskEngine.startTask('t-smart3', def)
await taskEngine.processInput('t-smart3', '我要报修')
r = await taskEngine.processInput('t-smart3', '地址是幸福小区3栋502，你们多久能到？')
check('提取地址且标记疑问', r.taskState.slots.address.filled && r.question === true, `| question=${r.questionText}`)
await taskEngine.processInput('t-smart3', '取消')

// ===== NLU 理解层 =====
check('nlu 模式设置', taskEngine.setNluMode('rule') === true && taskEngine.setNluMode('bad') === false)
taskEngine.setNluMode('hybrid')
check('matchTask 排除当前任务', (await taskEngine.matchTask('我要报修', 'repair_order')) === null, `| code=${(await taskEngine.matchTask('我要报修', 'repair_order'))?.code || 'null'}`)

// intent_examples 保存往返（写入真实 DB，测完清理）
await taskEngine.save({
  code: 'nlu_test', name: 'NLU测试任务', trigger_keywords: ['测试'],
  slots: [],
  steps: [{ key: 'done', type: 'action', action: 'complete_message', done_message: '完成' }],
  intent_examples: ['我要测试一下', '帮我跑个测试'],
})
const saved = taskEngine.taskDefs.get('nlu_test')
check('intent_examples 持久化', Array.isArray(saved.intent_examples) && saved.intent_examples.length === 2, `| ${saved.intent_examples?.length}`)
check('例句向量源就绪', Array.isArray(saved._vectorSources) && saved._vectorSources.length === 2)
await taskEngine.remove('nlu_test')
check('测试任务已清理', taskEngine.taskDefs.get('nlu_test') === undefined)

// ===== 修改请求（"修改XX"不带新值） =====
taskEngine.startTask('t-mod1', def)
await taskEngine.processInput('t-mod1', '我要报修')
await taskEngine.processInput('t-mod1', '幸福小区3栋502')
r = await taskEngine.processInput('t-mod1', '修改联系电话')
check('收集态修改请求→询问新值', r.extracted === true && r.reply.includes('新的联系电话'), `| reply=${r.reply.slice(0, 25)}`)
check('修改请求未被吞成槽位值', r.taskState.slots.fault.filled === false && r.taskState.slots.address.value === '幸福小区3栋502')
r = await taskEngine.processInput('t-mod1', '13900000000')
check('修改后新值生效', r.taskState.slots.phone.value === '13900000000', `| phone=${r.taskState.slots.phone.value}`)
await taskEngine.processInput('t-mod1', '取消')

taskEngine.startTask('t-mod2', def)
await taskEngine.processInput('t-mod2', '我要报修')
await taskEngine.processInput('t-mod2', '幸福小区3栋502')
await taskEngine.processInput('t-mod2', '燃气表不走了')
await taskEngine.processInput('t-mod2', '13800138000')
r = await taskEngine.processInput('t-mod2', '修改联系电话')
check('确认态修改请求→询问新值', r.taskState.status === 'confirming' && r.reply.includes('新的联系电话'), `| reply=${r.reply.slice(0, 25)}`)
r = await taskEngine.processInput('t-mod2', '13900000000')
check('确认态修改后清单更新', r.taskState.slots.phone.value === '13900000000' && r.taskState.status === 'confirming', `| phone=${r.taskState.slots.phone.value}`)
r = await taskEngine.processInput('t-mod2', '确认')
check('修改后确认完成', r.isComplete === true)

// ===== 识别问题修复（用户测试日志暴露） =====
{
  const noFalse = await taskEngine.matchTask('修改电话')
  check('修改电话不再误触发报修', noFalse === null, `| code=${noFalse?.code || 'null'}`)
}

taskEngine.startTask('t-corr3', def)
await taskEngine.processInput('t-corr3', '我要报修')
await taskEngine.processInput('t-corr3', '上海嘉定南翔')
r = await taskEngine.processInput('t-corr3', '地址不对，是嘉定江桥')
check('口语纠正（地址不对，是X）', r.taskState.slots.address.value === '嘉定江桥', `| value=${r.taskState.slots.address.value}`)
await taskEngine.processInput('t-corr3', '取消')

taskEngine.startTask('t-confirmword', def)
await taskEngine.processInput('t-confirmword', '我要报修')
r = await taskEngine.processInput('t-confirmword', '确认')
check('收集态"确认"不被吞', r.taskState.slots.address.filled === false && r.reask === true, `| reply=${r.reply.slice(0, 20)}`)
await taskEngine.processInput('t-confirmword', '取消')

// ===== 默认别名纠正（'安装地址'→'地址'，无需手动配别名） =====
TaskDefs.defs.set('alias_test', {
  code: 'alias_test', name: '别名测试', trigger_keywords: ['测试别名'],
  slots: [{ key: 'addr', label: '安装地址', required: true }],
  steps: [
    { key: 'c1', type: 'collect', slot_key: 'addr', label: '安装地址', required: true, prompt: '请问安装地址？', next: 'confirm_step' },
    { key: 'confirm_step', type: 'confirm', next: 'act' },
    { key: 'act', type: 'action', action: 'complete_message', done_message: '完成' },
  ],
})
taskEngine.startTask('t-alias', TaskDefs.defs.get('alias_test'))
await taskEngine.processInput('t-alias', '测试别名')
await taskEngine.processInput('t-alias', '上海嘉定南翔')
r = await taskEngine.processInput('t-alias', '地址不对，是嘉定江桥')
check('默认别名纠正（安装地址→地址）', r.taskState.slots.addr.value === '嘉定江桥', `| value=${r.taskState.slots.addr.value}`)
TaskDefs.defs.delete('alias_test')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
await taskEngine.stop()
process.exit(fail > 0 ? 1 : 0)
