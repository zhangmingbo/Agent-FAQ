/**
 * 暂存栈（stash stack）单元测试
 *
 * 运行: node tests/stashStack.test.mjs
 *
 * 覆盖：
 *   1. 基础 stash/popStashed 往返（单条）
 *   2. 多级暂存（LIFO 顺序）
 *   3. 旧版单条存储兼容
 *   4. getStashed 不弹出
 *   5. hasStashed 空栈返回 false
 *   6. popStashed 空栈返回 null
 *   7. stash 时 activeTasks 清除
 *   8. popStashed 恢复到 activeTasks
 *   9. 暂存状态字段完整性（suspended/suspendedAt）
 */

import taskEngine from '../services/taskflow/index.js'
import TaskDefs from '../services/taskflow/taskDefs.js'

let pass = 0
let fail = 0

function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  [PASS] ${name} ${extra}`) }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`) }
}

// 初始化（内存存储）
await taskEngine.initialize({ storeDriver: 'memory' })
taskEngine.setNluMode('rule')

// 注入测试任务
const defA = {
  code: 'task_a', name: '任务A', trigger_keywords: ['任务A'],
  slots: [
    { key: 'name', label: '姓名', required: true },
    { key: 'phone', label: '电话', required: true },
  ],
  steps: [
    { key: 'c1', type: 'collect', slot_key: 'name', label: '姓名', required: true, prompt: '请问姓名？', next: 'c2' },
    { key: 'c2', type: 'collect', slot_key: 'phone', label: '电话', required: true, prompt: '请问电话？', next: 'act' },
    { key: 'act', type: 'action', action: 'complete_message', done_message: '任务A完成' },
  ],
  status: 1,
}
const defB = {
  code: 'task_b', name: '任务B', trigger_keywords: ['任务B'],
  slots: [{ key: 'addr', label: '地址', required: true }],
  steps: [
    { key: 'c1', type: 'collect', slot_key: 'addr', label: '地址', required: true, prompt: '请问地址？', next: 'act' },
    { key: 'act', type: 'action', action: 'complete_message', done_message: '任务B完成' },
  ],
  status: 1,
}
TaskDefs.defs.set('task_a', defA)
TaskDefs.defs.set('task_b', defB)

const SID = 'test-stash-stack'

// ===== 1. 基础 stash/popStashed 往返 =====
console.log('\n--- 1. 基础 stash/popStashed 往返 ---')
{
  taskEngine.startTask(SID + '-1', defA)
  await taskEngine.processInput(SID + '-1', '张三')
  const before = taskEngine.getActiveTask(SID + '-1')
  check('stash前任务活跃', taskEngine.hasActiveTask(SID + '-1'))

  await taskEngine.stash(SID + '-1')
  check('stash后任务不活跃', !taskEngine.hasActiveTask(SID + '-1'))
  check('hasStashed=true', await taskEngine.hasStashed(SID + '-1'))

  const stashed = await taskEngine.getStashed(SID + '-1')
  check('getStashed返回任务A', stashed?.taskCode === 'task_a', `| code=${stashed?.taskCode}`)
  check('getStashed不弹出（仍在）', await taskEngine.hasStashed(SID + '-1'))

  const restored = await taskEngine.popStashed(SID + '-1')
  check('popStashed恢复任务', restored?.taskCode === 'task_a')
  check('恢复后suspended=false', restored?.suspended === false)
  check('恢复后activeTasks有值', taskEngine.hasActiveTask(SID + '-1'))
  check('popStashed后栈空', !(await taskEngine.hasStashed(SID + '-1')))

  // 清理
  taskEngine.activeTasks.delete(SID + '-1')
  await taskEngine._remove(SID + '-1')
}

// ===== 2. 多级暂存（LIFO 顺序） =====
// 实际场景：同一用户（sessionId）连续中断多个任务
console.log('\n--- 2. 多级暂存（LIFO 顺序） ---')
{
  const sid = SID + '-2'
  // 启动任务A，填一个槽位，stash
  taskEngine.startTask(sid, defA)
  await taskEngine.processInput(sid, '开始') // 首轮不提取（isFirstTurn保护）
  await taskEngine.processInput(sid, '张三') // 第2轮提取姓名
  await taskEngine.stash(sid)
  check('任务A暂存成功', await taskEngine.hasStashed(sid))

  // 同一sessionId启动任务B，stash（模拟用户中断A后办B，B又被中断）
  taskEngine.startTask(sid, defB)
  await taskEngine.stash(sid)
  check('任务B暂存成功', await taskEngine.hasStashed(sid))

  // 栈顶应该是任务B（LIFO）
  const top = await taskEngine.getStashed(sid)
  check('栈顶是任务B', top?.taskCode === 'task_b', `| top=${top?.taskCode}`)

  // pop 出任务B
  const poppedB = await taskEngine.popStashed(sid)
  check('pop出任务B', poppedB?.taskCode === 'task_b')

  // 栈顶应该是任务A
  const top2 = await taskEngine.getStashed(sid)
  check('pop后栈顶是任务A', top2?.taskCode === 'task_a', `| top=${top2?.taskCode}`)

  // pop 出任务A
  const poppedA = await taskEngine.popStashed(sid)
  check('pop出任务A', poppedA?.taskCode === 'task_a')
  check('栈已空', !(await taskEngine.hasStashed(sid)))

  // 验证任务A的槽位数据完整
  check('任务A槽位数据完整', poppedA?.slots?.name?.filled === true && poppedA.slots.name.value === '张三',
    `| name=${poppedA?.slots?.name?.value}`)

  // 清理
  taskEngine.activeTasks.delete(sid)
  await taskEngine._remove(sid)
}

// ===== 3. 旧版单条存储兼容 =====
console.log('\n--- 3. 旧版单条存储兼容 ---')
{
  // 直接写入单条状态（模拟旧版数据）
  const oldState = {
    sessionId: SID + '-3',
    taskCode: 'task_a',
    taskName: '任务A',
    status: 'collecting',
    suspended: true,
    suspendedAt: Date.now(),
    slots: { name: { value: '旧数据', filled: true, label: '姓名', required: true } },
    stack: [],
    turnCount: 1,
    skipCount: 0,
  }
  await taskEngine.store.set(`taskflow:stash:${SID + '-3'}`, oldState, taskEngine.sessionTtl)

  // getStashed 应该能读取旧版单条
  const got = await taskEngine.getStashed(SID + '-3')
  check('兼容旧版单条存储', got?.taskCode === 'task_a', `| code=${got?.taskCode}`)

  // popStashed 应该能弹出旧版
  const popped = await taskEngine.popStashed(SID + '-3')
  check('popStashed兼容旧版', popped?.taskCode === 'task_a')
  check('旧版数据完整', popped?.slots?.name?.value === '旧数据')

  // 清理
  taskEngine.activeTasks.delete(SID + '-3')
}

// ===== 4. 空栈操作 =====
console.log('\n--- 4. 空栈操作 ---')
{
  check('空栈hasStashed=false', !(await taskEngine.hasStashed(SID + '-empty')))
  check('空栈getStashed=null', (await taskEngine.getStashed(SID + '-empty')) === null)
  check('空栈popStashed=null', (await taskEngine.popStashed(SID + '-empty')) === null)
}

// ===== 5. 暂存状态字段完整性 =====
console.log('\n--- 5. 暂存状态字段完整性 ---')
{
  taskEngine.startTask(SID + '-5', defA)
  await taskEngine.processInput(SID + '-5', '李四')
  const stateBefore = taskEngine.getActiveTask(SID + '-5')
  const turnCountBefore = stateBefore.turnCount

  await taskEngine.stash(SID + '-5')
  const stashed = await taskEngine.getStashed(SID + '-5')
  check('暂存保留turnCount', stashed?.turnCount === turnCountBefore, `| before=${turnCountBefore}, after=${stashed?.turnCount}`)
  check('暂存标记suspended=true', stashed?.suspended === true)
  check('暂存记录suspendedAt', typeof stashed?.suspendedAt === 'number' && stashed.suspendedAt > 0)

  // 清理
  taskEngine.activeTasks.delete(SID + '-5')
  await taskEngine._remove(SID + '-5')
  await taskEngine.store.del(`taskflow:stash:${SID + '-5'}`)
}

// ===== 6. stash 时 activeTasks 清除 =====
console.log('\n--- 6. stash 时 activeTasks 清除 ---')
{
  taskEngine.startTask(SID + '-6', defB)
  check('stash前activeTasks有值', taskEngine.hasActiveTask(SID + '-6'))
  await taskEngine.stash(SID + '-6')
  check('stash后activeTasks清除', !taskEngine.hasActiveTask(SID + '-6'))

  // 清理
  await taskEngine.store.del(`taskflow:stash:${SID + '-6'}`)
}

// ===== 7. popStashed 恢复到 activeTasks =====
console.log('\n--- 7. popStashed 恢复到 activeTasks ---')
{
  taskEngine.startTask(SID + '-7', defA)
  await taskEngine.processInput(SID + '-7', '王五')
  await taskEngine.stash(SID + '-7')
  check('恢复前activeTasks为空', !taskEngine.hasActiveTask(SID + '-7'))

  const restored = await taskEngine.popStashed(SID + '-7')
  check('恢复后activeTasks有值', taskEngine.hasActiveTask(SID + '-7'))
  check('恢复后suspended=false', restored?.suspended === false)
  check('恢复后suspendedAt=null', restored?.suspendedAt === null)

  // 清理
  taskEngine.activeTasks.delete(SID + '-7')
  await taskEngine._remove(SID + '-7')
}

// ===== 结果 =====
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
await taskEngine.stop()
process.exit(fail > 0 ? 1 : 0)
