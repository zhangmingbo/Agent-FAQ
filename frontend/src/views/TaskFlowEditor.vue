<template>
  <div class="task-flow-editor">
    <div class="page-header">
      <h3>任务流程管理</h3>
      <el-button type="primary" size="small" @click="openEditor(null)">+ 新建任务</el-button>
    </div>

    <!-- 任务列表 -->
    <el-table :data="tasks" size="small" style="width:100%" v-loading="loading">
      <el-table-column type="index" label="#" width="50" />
      <el-table-column prop="code" label="编码" width="160">
        <template #default="{ row }"><code>{{ row.code }}</code></template>
      </el-table-column>
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column label="触发词" min-width="200">
        <template #default="{ row }">
          <span :title="keywordText(row)" class="kw-cell">{{ keywordText(row) || '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="步骤数" width="70" align="center">
        <template #default="{ row }">{{ (row.steps?.length) || (row.slots?.length ? '自动' : '0') }}</template>
      </el-table-column>
      <el-table-column label="状态" width="70" align="center">
        <template #default="{ row }">
          <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">{{ row.status === 1 ? '启用' : '禁用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" align="center">
        <template #default="{ row }">
          <el-button size="small" text @click="openEditor(row.code)">编辑</el-button>
          <el-button size="small" text :type="row.status === 1 ? 'warning' : 'success'" @click="handleToggle(row)">{{ row.status === 1 ? '禁用' : '启用' }}</el-button>
          <el-button size="small" text type="danger" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 编辑/新建弹窗 -->
    <el-dialog v-model="editorVisible" :title="isEdit ? '编辑任务' : '新建任务'" width="min(94vw, 860px)" top="3vh" destroy-on-close>
      <div class="editor-body">
        <el-form label-width="130px" size="small">
          <el-form-item label="任务编码">
            <el-input v-model="form.code" :disabled="isEdit" placeholder="如：repair_order" />
          </el-form-item>
          <el-form-item label="任务名称">
            <el-input v-model="form.name" placeholder="如：报修工单" />
          </el-form-item>
          <el-form-item label="描述">
            <el-input v-model="form.description" type="textarea" :rows="2" placeholder="任务描述（可选）" />
          </el-form-item>
          <el-form-item label="触发关键词">
            <div class="tag-input-wrap">
              <el-tag v-for="(kw, i) in form.trigger_keywords" :key="i" closable @close="form.trigger_keywords.splice(i, 1)" size="small">{{ kw }}</el-tag>
              <el-input v-model="kwInput" placeholder="输入后回车" size="small" style="width:160px" @keyup.enter="addKeyword" />
            </div>
          </el-form-item>
          <el-form-item label="意图例句">
            <div class="tag-input-wrap">
              <el-tag v-for="(ex, i) in form.intent_examples" :key="i" closable @close="form.intent_examples.splice(i, 1)" size="small">{{ ex }}</el-tag>
              <el-input v-model="exampleInput" placeholder="用户可能怎么说" size="small" style="width:200px" @keyup.enter="addExample" />
            </div>
            <div style="font-size:12px;color:#999;margin-top:4px">例句帮助 AI 理解该任务的业务场景</div>
          </el-form-item>
          <el-form-item label="冲突澄清话术">
            <el-input v-model="form.clarify_question" type="textarea" :rows="2" placeholder="留空使用全局模板" />
            <el-input v-model="form.clarify_options_text" type="textarea" :rows="2" placeholder="每行一个选项" style="margin-top:4px" />
          </el-form-item>
          <el-form-item label="仲裁阈值">
            <div class="arb-row">
              <label>差距 <el-input-number v-model="form.arb_gap" :step="0.01" :controls="false" size="small" style="width:80px" placeholder="0.08" /></label>
              <label>任务最低 <el-input-number v-model="form.arb_task_min" :step="0.01" :controls="false" size="small" style="width:80px" /></label>
              <label>FAQ最低 <el-input-number v-model="form.arb_faq_min" :step="0.01" :controls="false" size="small" style="width:80px" /></label>
              <label>强命中 <el-input-number v-model="form.arb_strong_hit" :step="0.01" :controls="false" size="small" style="width:80px" /></label>
            </div>
          </el-form-item>

          <!-- 槽位定义 -->
          <el-form-item label="槽位定义">
            <div class="slots-area">
              <div v-for="(slot, si) in form.slots" :key="si" class="slot-card">
                <div class="slot-card-header">
                  <el-input v-model="slot.key" placeholder="key" size="small" style="width:100px" />
                  <el-input v-model="slot.label" placeholder="名称" size="small" style="width:100px" />
                  <el-select v-model="slot.extract_type" size="small" style="width:80px">
                    <el-option value="ner" label="NER" />
                    <el-option value="regex" label="正则" />
                    <el-option value="enum" label="枚举" />
                    <el-option value="free" label="自由" />
                  </el-select>
                  <el-select v-model="slot.extract_ner_type" size="small" style="width:90px" clearable placeholder="NER类型">
                    <el-option v-for="nt in nerTypes" :key="nt.type" :value="nt.type" :label="nt.label || nt.type" />
                  </el-select>
                  <el-checkbox v-model="slot.required" style="font-size:12px">必填</el-checkbox>
                  <el-button size="small" text type="danger" @click="form.slots.splice(si, 1)">删除</el-button>
                </div>
                <div class="slot-card-body">
                  <el-input v-model="slot.prompt" placeholder="提问话术" size="small" style="margin-bottom:6px" />
                  <div class="slot-row">
                    <el-input v-model="slot.extract_rule" placeholder="提取/校验规则（正则或枚举值）" size="small" style="flex:1" />
                  </div>
                  <div class="slot-row" style="margin-top:6px">
                    <el-input v-model="slot.validate_rule" placeholder="校验正则" size="small" style="flex:1" />
                    <el-input v-model="slot.validate_reask" placeholder="校验失败提示" size="small" style="flex:1;margin-left:6px" />
                  </div>
                </div>
              </div>
              <el-button size="small" @click="addSlot">+ 添加槽位</el-button>
            </div>
          </el-form-item>

          <!-- 流程步骤 -->
          <el-form-item label="流程步骤">
            <div class="steps-area">
              <div v-for="(step, sti) in form.steps" :key="sti" class="step-card">
                <div class="step-header">
                  <el-input v-model="step.key" placeholder="步骤key" size="small" style="width:110px" />
                  <el-select v-model="step.type" size="small" style="width:80px">
                    <el-option value="collect" label="收集" />
                    <el-option value="confirm" label="确认" />
                    <el-option value="action" label="动作" />
                    <el-option value="message" label="回复" />
                    <el-option value="branch" label="分支" />
                  </el-select>
                  <el-select v-if="step.type === 'collect'" v-model="step.slot_key" size="small" style="width:100px" clearable placeholder="关联槽位">
                    <el-option v-for="s in form.slots" :key="s.key" :value="s.key" :label="s.label || s.key" />
                  </el-select>
                  <el-select v-if="step.type === 'action'" v-model="step.action" size="small" style="width:100px" placeholder="动作类型">
                    <el-option value="complete_message" label="回复话术" />
                    <el-option value="call_api" label="调用接口" />
                  </el-select>
                  <el-input v-model="step.next" placeholder="下一步key" size="small" style="width:110px" />
                  <el-button size="small" text type="danger" @click="form.steps.splice(sti, 1)">删除</el-button>
                </div>
                <div v-if="step.prompt || step.type === 'collect'" class="step-body">
                  <el-input v-model="step.prompt" placeholder="提问话术" size="small" />
                </div>
                <div v-if="(step.type === 'action' && step.action === 'complete_message') || step.type === 'message'" class="step-body">
                  <el-input v-model="step.done_message" placeholder="回复话术" size="small" />
                </div>
              </div>
              <div class="step-actions">
                <el-button size="small" @click="form.steps.push({ key: '', type: 'collect', next: '' })">+ 添加步骤</el-button>
                <el-button size="small" type="primary" @click="autoGenerateSteps">⚡ 从槽位自动生成</el-button>
              </div>
            </div>
          </el-form-item>

          <!-- 完成动作 -->
          <el-form-item label="完成动作">
            <el-select v-model="form.on_complete_type" size="small" style="width:160px">
              <el-option value="complete_message" label="仅回复完成话术" />
              <el-option value="call_api" label="调用接口" />
              <el-option value="flow" label="动作编排" />
            </el-select>
            <el-input v-model="form.completion_message" placeholder="完成话术" size="small" style="margin-top:6px" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSave" :loading="saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getTasks, getTaskDetail, saveTask, deleteTask, toggleTask } from '@/api/task'
import { getNerTypes } from '@/api/config'
import { ElMessage, ElMessageBox } from 'element-plus'

const loading = ref(false)
const tasks = ref([])
const nerTypes = ref([])
const editorVisible = ref(false)
const isEdit = ref(false)
const saving = ref(false)
const kwInput = ref('')
const exampleInput = ref('')

const defaultForm = () => ({
  code: '', name: '', description: '',
  trigger_keywords: [], intent_examples: [],
  clarify_question: '', clarify_options_text: '',
  arb_gap: undefined, arb_task_min: undefined, arb_faq_min: undefined, arb_strong_hit: undefined,
  slots: [], steps: [],
  on_complete_type: 'complete_message', completion_message: '',
})
const form = ref(defaultForm())

async function loadTasks() {
  loading.value = true
  try {
    const res = await getTasks()
    tasks.value = res.data || []
  } finally { loading.value = false }
}

async function loadNerTypes() {
  try {
    const res = await getNerTypes()
    nerTypes.value = res.data || []
  } catch { /* ignore */ }
}

function keywordText(row) {
  return (row.trigger_keywords || []).map(k => typeof k === 'string' ? k : k.regex || '').join(', ')
}

async function openEditor(code) {
  if (code) {
    const res = await getTaskDetail(code)
    if (!res.success || !res.data) return
    const t = res.data
    isEdit.value = true
    form.value = {
      code: t.code, name: t.name, description: t.description || '',
      trigger_keywords: [...(t.trigger_keywords || [])],
      intent_examples: [...(t.intent_examples || [])],
      clarify_question: t.clarify_question || '',
      clarify_options_text: Array.isArray(t.clarify_options) ? t.clarify_options.join('\n') : '',
      arb_gap: t.arb_gap, arb_task_min: t.arb_task_min, arb_faq_min: t.arb_faq_min, arb_strong_hit: t.arb_strong_hit,
      slots: (t.slots || []).map(s => ({
        ...s,
        required: s.required !== false,
        validate_rule: s.validate?.rule || '',
        validate_reask: s.validate?.reask || '',
      })),
      steps: (t.steps || []).map(s => ({ ...s })),
      on_complete_type: t.api_action ? 'call_api' : (typeof t.on_complete === 'string' && t.on_complete.trim().startsWith('{') ? 'flow' : 'complete_message'),
      completion_message: t.completion_message || '',
    }
  } else {
    isEdit.value = false
    form.value = defaultForm()
  }
  editorVisible.value = true
}

function addKeyword() {
  const v = kwInput.value.trim()
  if (v && !form.value.trigger_keywords.includes(v)) {
    form.value.trigger_keywords.push(v)
    kwInput.value = ''
  }
}
function addExample() {
  const v = exampleInput.value.trim()
  if (v && !form.value.intent_examples.includes(v)) {
    form.value.intent_examples.push(v)
    exampleInput.value = ''
  }
}

function addSlot() {
  form.value.slots.push({ key: '', label: '', prompt: '', extract_type: 'ner', extract_ner_type: '', extract_rule: '', required: true, validate_rule: '', validate_reask: '' })
}

function autoGenerateSteps() {
  const slots = form.value.slots.filter(s => s.key && s.label)
  const usedKeys = new Set()
  const steps = []
  slots.forEach((s, i) => {
    let stepKey = s.key
    let counter = 1
    while (usedKeys.has(stepKey)) stepKey = s.key + '_' + (++counter)
    usedKeys.add(stepKey)
    const nextKey = i < slots.length - 1 ? slots[i + 1].key : 'confirm_step'
    steps.push({ key: stepKey, type: 'collect', slot_key: s.key, label: s.label, prompt: s.prompt || ('请提供' + s.label), next: nextKey })
  })
  if (slots.length) steps.push({ key: 'confirm_step', type: 'confirm', next: 'submit' })
  steps.push({ key: 'submit', type: 'action', action: 'complete_message' })
  form.value.steps = steps
}

async function handleSave() {
  if (!form.value.code.trim() || !form.value.name.trim()) {
    ElMessage.warning('编码和名称不能为空')
    return
  }
  const slots = form.value.slots.filter(s => s.key && s.label).map(s => {
    const slot = { key: s.key, label: s.label, prompt: s.prompt || '', extract_type: s.extract_type, extract_rule: s.extract_rule || '', extract_ner_type: s.extract_ner_type || null, required: s.required !== false }
    if (s.validate_rule) slot.validate = { rule: s.validate_rule, reask: s.validate_reask || '' }
    return slot
  })
  const clarifyOptions = form.value.clarify_options_text.trim()
    ? form.value.clarify_options_text.trim().split('\n').map(x => x.trim()).filter(Boolean)
    : undefined

  const data = {
    code: form.value.code, name: form.value.name, description: form.value.description,
    trigger_keywords: form.value.trigger_keywords,
    intent_examples: form.value.intent_examples.length ? form.value.intent_examples : undefined,
    clarify_question: form.value.clarify_question || undefined,
    clarify_options: clarifyOptions,
    arb_gap: form.value.arb_gap, arb_task_min: form.value.arb_task_min,
    arb_faq_min: form.value.arb_faq_min, arb_strong_hit: form.value.arb_strong_hit,
    slots, steps: form.value.steps.length ? form.value.steps : undefined,
    completion_message: form.value.completion_message || undefined,
    on_complete: form.value.on_complete_type === 'complete_message' ? 'complete_message' : undefined,
    status: 1,
  }
  saving.value = true
  try {
    const res = await saveTask(data)
    if (res.success) {
      ElMessage.success('已保存')
      editorVisible.value = false
      await loadTasks()
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } finally { saving.value = false }
}

async function handleToggle(row) {
  const newStatus = row.status === 1 ? 0 : 1
  try {
    const res = await toggleTask(row.code, newStatus)
    if (res.success) await loadTasks()
  } catch { /* ignore */ }
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(`确认删除任务「${row.name}」？`, '确认')
    const res = await deleteTask(row.code)
    if (res.success) {
      ElMessage.success('已删除')
      await loadTasks()
    }
  } catch { /* cancelled */ }
}

onMounted(() => { loadTasks(); loadNerTypes() })
</script>

<style scoped>
.task-flow-editor { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.page-header h3 { font-size: 15px; margin: 0; }
.kw-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.editor-body { max-height: 70vh; overflow-y: auto; padding-right: 8px; }
.tag-input-wrap { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.arb-row { display: flex; gap: 10px; flex-wrap: wrap; }
.arb-row label { font-size: 12px; color: #666; display: flex; align-items: center; gap: 4px; }
.slots-area { width: 100%; }
.slot-card { border: 1px solid #e8ecff; border-radius: 8px; margin-bottom: 10px; background: #fafbff; overflow: hidden; }
.slot-card-header { display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: #f0f4ff; flex-wrap: wrap; }
.slot-card-body { padding: 10px 12px; }
.slot-row { display: flex; gap: 6px; }
.steps-area { width: 100%; }
.step-card { border: 1px solid #e8ecff; border-radius: 6px; margin-bottom: 6px; background: #fafbff; padding: 8px 12px; }
.step-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.step-body { padding: 6px 0 0 0; }
.step-actions { display: flex; gap: 6px; margin-top: 6px; }
</style>
