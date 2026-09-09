<template>
  <div class="task-flow-v6">
    <!-- ====== 任务列表视图 ====== -->
    <div v-if="!editing" class="list-view">
      <div class="page-header">
        <h3>任务流程管理 <span class="version-tag">v6.0</span></h3>
        <el-button type="primary" size="small" @click="openCanvas(null)">+ 新建任务</el-button>
      </div>
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
        <el-table-column label="操作" width="220" align="center">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openCanvas(row.code)">画布编辑</el-button>
            <el-button size="small" text :type="row.status === 1 ? 'warning' : 'success'" @click="handleToggle(row)">{{ row.status === 1 ? '禁用' : '启用' }}</el-button>
            <el-button size="small" text type="danger" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- ====== 画布编辑视图 ====== -->
    <div v-else class="canvas-view">
      <!-- 顶部工具栏 -->
      <div class="canvas-toolbar">
        <div class="toolbar-left">
          <el-button text size="small" @click="exitCanvas">← 返回列表</el-button>
          <span class="toolbar-title">{{ currentTask?.name || '新建任务' }}</span>
        </div>
        <div class="toolbar-center">
          <el-input v-model="taskForm.name" size="small" placeholder="任务名称" style="width:180px" />
          <el-input v-model="taskForm.code" size="small" placeholder="编码" style="width:140px" :disabled="isEdit" />
        </div>
        <div class="toolbar-right">
          <el-button size="small" @click="handleAutoLayout">自动布局</el-button>
          <el-button size="small" @click="handleFitView">适应画布</el-button>
          <el-button type="primary" size="small" @click="handleSave" :loading="saving">保存</el-button>
        </div>
      </div>

      <div class="canvas-body">
        <!-- 左侧节点库 -->
        <div class="node-palette">
          <div class="palette-title">节点库</div>
          <div
            v-for="(cfg, type) in NODE_TYPES"
            :key="type"
            class="palette-item"
            :style="{ borderLeftColor: cfg.color }"
            draggable="true"
            @dragstart="onDragStart($event, type)"
          >
            <span class="palette-icon">{{ cfg.icon }}</span>
            <span class="palette-label">{{ cfg.label }}</span>
          </div>

          <!-- 任务基础信息 -->
          <div class="palette-section">
            <div class="palette-title">触发词</div>
            <div class="tag-input-wrap">
              <el-tag v-for="(kw, i) in taskForm.trigger_keywords" :key="i" closable size="small" @close="taskForm.trigger_keywords.splice(i, 1)">{{ kw }}</el-tag>
              <el-input v-model="kwInput" size="small" style="width:100px" placeholder="回车添加" @keyup.enter="addKeyword" />
            </div>
          </div>

          <div class="palette-section">
            <div class="palette-title">意图例句</div>
            <div class="tag-input-wrap">
              <el-tag v-for="(ex, i) in taskForm.intent_examples" :key="i" closable size="small" @close="taskForm.intent_examples.splice(i, 1)">{{ ex }}</el-tag>
              <el-input v-model="exampleInput" size="small" style="width:120px" placeholder="回车添加" @keyup.enter="addExample" />
            </div>
          </div>

          <!-- 槽位列表 -->
          <div class="palette-section">
            <div class="palette-title">
              槽位定义
              <el-button size="small" text type="primary" @click="addSlot">+ 添加</el-button>
            </div>
            <div v-for="(slot, si) in taskForm.slots" :key="si" class="slot-mini">
              <el-input v-model="slot.key" size="small" style="width:70px" placeholder="key" />
              <el-input v-model="slot.label" size="small" style="width:70px" placeholder="名称" />
              <el-button size="small" text type="danger" @click="taskForm.slots.splice(si, 1)">✕</el-button>
            </div>
          </div>
        </div>

        <!-- 画布区域 -->
        <div class="canvas-area" @drop="onDrop" @dragover.prevent>
          <VueFlow
            v-model:nodes="nodes"
            v-model:edges="edges"
            :node-types="nodeTypes"
            :default-edge-options="{
              type: 'bezier',
              animated: false,
              style: { stroke: '#94a3b8', strokeWidth: 2 },
              markerEnd: { type: 'arrowclosed', color: '#94a3b8' }
            }"
            fit-view-on-init
            @connect="onConnect"
            @node-click="onNodeClick"
            @node-double-click="onNodeDblClick"
            @edge-click="onEdgeClick"
            @delete="onDelete"
            ref="vueFlowRef"
          >
            <Background :gap="20" :color="'#e2e8f0'" />
            <Controls :show-interactive="false" />
            <MiniMap :node-color="getMiniMapColor" :mask-color="'rgba(0,0,0,0.05)'" />
          </VueFlow>
        </div>

        <!-- 右侧属性面板 -->
        <NodePanel
          :visible="panelVisible"
          :node-type="selectedNodeType"
          :node-data="selectedNodeData"
          :slots="taskForm.slots"
          :all-tasks="allTasks"
          @apply="onNodeApply"
          @close="panelVisible = false"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { ElMessage, ElMessageBox } from 'element-plus'

// Vue Flow 主题样式
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

import { getTasks, getTaskDetail, saveTask, deleteTask, toggleTask } from '@/api/task'
import { getNerTypes } from '@/api/config'
import { NODE_TYPES, dslToCanvas, canvasToDSL, generateKey } from '@/utils/flowConverter'
import FlowNode from '@/components/flow/FlowNode.vue'
import NodePanel from '@/components/flow/NodePanel.vue'

// ========== 状态 ==========
const loading = ref(false)
const tasks = ref([])
const allTasks = ref([])
const editing = ref(false)
const isEdit = ref(false)
const saving = ref(false)
const kwInput = ref('')
const exampleInput = ref('')

const nodes = ref([])
const edges = ref([])
const panelVisible = ref(false)
const selectedNodeData = ref({})
const selectedNodeType = ref('message')
const vueFlowRef = ref(null)

const currentTask = ref(null)

const taskForm = ref({
  code: '', name: '', description: '',
  trigger_keywords: [], intent_examples: [],
  slots: [],
})

// ========== 自定义节点类型 ==========
const nodeTypes = {
  start: FlowNode,
  collect: FlowNode,
  message: FlowNode,
  branch: FlowNode,
  api: FlowNode,
  confirm: FlowNode,
  subtask: FlowNode,
  end: FlowNode,
}

// ========== 列表操作 ==========
function keywordText(row) {
  return (row.trigger_keywords || []).map(k => typeof k === 'string' ? k : k.regex || '').join(', ')
}

async function loadTasks() {
  loading.value = true
  try {
    const res = await getTasks()
    tasks.value = res.data || []
    allTasks.value = res.data || []
  } finally { loading.value = false }
}

function addKeyword() {
  const v = kwInput.value.trim()
  if (v && !taskForm.value.trigger_keywords.includes(v)) {
    taskForm.value.trigger_keywords.push(v)
    kwInput.value = ''
  }
}

function addExample() {
  const v = exampleInput.value.trim()
  if (v && !taskForm.value.intent_examples.includes(v)) {
    taskForm.value.intent_examples.push(v)
    exampleInput.value = ''
  }
}

function addSlot() {
  taskForm.value.slots.push({ key: '', label: '', required: true })
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

// ========== 画布操作 ==========
async function openCanvas(code) {
  if (code) {
    const res = await getTaskDetail(code)
    if (!res.success || !res.data) return
    const t = res.data
    isEdit.value = true
    currentTask.value = t
    taskForm.value = {
      code: t.code, name: t.name, description: t.description || '',
      trigger_keywords: [...(t.trigger_keywords || [])],
      intent_examples: [...(t.intent_examples || [])],
      slots: (t.slots || []).map(s => ({ key: s.key, label: s.label || s.key, required: s.required !== false })),
    }

    // DSL → Canvas
    const { nodes: n, edges: e } = dslToCanvas(t.steps, t.flow_canvas)
    // 注入 _nodeType 到每个节点 data
    nodes.value = n.map(nd => ({
      ...nd,
      data: { ...nd.data, _nodeType: nd.type },
    }))
    edges.value = e
  } else {
    isEdit.value = false
    currentTask.value = null
    taskForm.value = {
      code: '', name: '', description: '',
      trigger_keywords: [], intent_examples: [], slots: [],
    }
    // 默认：一个开始节点
    nodes.value = [{
      id: 'node_start',
      type: 'start',
      position: { x: 100, y: 200 },
      data: { key: 'start', label: '开始', _nodeType: 'start' },
    }]
    edges.value = []
  }
  editing.value = true
}

function exitCanvas() {
  editing.value = false
  panelVisible.value = false
}

// ========== 拖拽创建节点 ==========
let dragType = null

function onDragStart(event, type) {
  dragType = type
  event.dataTransfer.effectAllowed = 'move'
}

function onDrop(event) {
  event.preventDefault()
  if (!dragType) return

  const canvasRect = event.currentTarget.getBoundingClientRect()
  const x = event.clientX - canvasRect.left
  const y = event.clientY - canvasRect.top

  const existingKeys = new Set(nodes.value.map(n => n.data?.key || ''))
  const key = generateKey(dragType, existingKeys)

  nodes.value.push({
    id: `node_${key}`,
    type: dragType,
    position: { x: x - 70, y: y - 22 },
    data: {
      key,
      label: NODE_TYPES[dragType]?.label || dragType,
      _nodeType: dragType,
      // 各类型默认数据
      ...(dragType === 'collect' ? { slotKey: '', prompt: '' } : {}),
      ...(dragType === 'message' ? { text: '' } : {}),
      ...(dragType === 'branch' ? { cases: [{ label: '条件1' }, { label: '条件2' }] } : {}),
      ...(dragType === 'api' ? { url: '', method: 'POST', message: '' } : {}),
      ...(dragType === 'confirm' ? { prompt: '' } : {}),
      ...(dragType === 'subtask' ? { task: '' } : {}),
      ...(dragType === 'end' ? { doneMessage: '' } : {}),
    },
  })

  dragType = null
}

// ========== 连线处理 ==========
function onConnect(connection) {
  // 防止重复连线
  const exists = edges.value.some(e =>
    e.source === connection.source && e.target === connection.target
  )
  if (exists) return

  // 结束节点不能作为源
  const sourceNode = nodes.value.find(n => n.id === connection.source)
  if (sourceNode?.data?._nodeType === 'end') return

  // 开始节点不能作为目标
  const targetNode = nodes.value.find(n => n.id === connection.target)
  if (targetNode?.data?._nodeType === 'start') return

  edges.value.push({
    id: `edge_${connection.source}_${connection.target}`,
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle || undefined,
    type: 'bezier',
  })
}

// ========== 节点交互 ==========
function onNodeClick({ node }) {
  // 单击选中（Vue Flow 自动处理高亮）
}

function onNodeDblClick({ node }) {
  selectedNodeData.value = { ...node.data }
  selectedNodeType.value = node.type
  panelVisible.value = true
}

function onEdgeClick({ edge }) {
  // 点击边可删除
  edges.value = edges.value.filter(e => e.id !== edge.id)
}

function onDelete(params) {
  // Vue Flow 的 delete 事件
}

function onNodeApply(updatedData) {
  // 找到选中的节点并更新
  const nodeId = nodes.value.find(n => n.data?.key === selectedNodeData.value.key)?.id
  if (nodeId) {
    const idx = nodes.value.findIndex(n => n.id === nodeId)
    if (idx !== -1) {
      nodes.value[idx] = {
        ...nodes.value[idx],
        data: { ...nodes.value[idx].data, ...updatedData },
      }
    }
  }
  panelVisible.value = false
}

// ========== 自动布局 ==========
function handleAutoLayout() {
  // 简单重新触发 dagre 布局
  const { steps } = canvasToDSL(nodes.value, edges.value)
  const { nodes: n, edges: e } = dslToCanvas(steps, null)
  nodes.value = n.map(nd => ({
    ...nd,
    data: { ...nd.data, _nodeType: nd.type },
  }))
  edges.value = e
}

function handleFitView() {
  if (vueFlowRef.value?.fitView) {
    vueFlowRef.value.fitView({ padding: 0.2 })
  }
}

// ========== 小地图颜色 ==========
function getMiniMapColor(node) {
  const colorMap = {
    start: '#52c41a', collect: '#1890ff', message: '#1890ff',
    branch: '#fa8c16', api: '#1890ff', confirm: '#fa8c16',
    subtask: '#8c8c8c', end: '#f5222d',
  }
  return colorMap[node.type] || '#1890ff'
}

// ========== 保存 ==========
async function handleSave() {
  if (!taskForm.value.name.trim()) {
    ElMessage.warning('请输入任务名称')
    return
  }
  if (!taskForm.value.code.trim()) {
    ElMessage.warning('请输入任务编码')
    return
  }

  // Canvas → DSL
  const { steps, flowCanvas } = canvasToDSL(nodes.value, edges.value)

  saving.value = true
  try {
    const data = {
      code: taskForm.value.code,
      name: taskForm.value.name,
      description: taskForm.value.description,
      trigger_keywords: taskForm.value.trigger_keywords,
      intent_examples: taskForm.value.intent_examples.length ? taskForm.value.intent_examples : undefined,
      slots: taskForm.value.slots.filter(s => s.key && s.label).map(s => ({
        key: s.key, label: s.label, required: s.required !== false,
      })),
      steps: steps.length > 0 ? steps : undefined,
      flow_canvas: flowCanvas,
      status: 1,
    }

    const res = await saveTask(data)
    if (res.success) {
      ElMessage.success('保存成功')
      await loadTasks()
      editing.value = false
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } finally {
    saving.value = false
  }
}

// ========== 初始化 ==========
onMounted(() => { loadTasks() })
</script>

<style scoped>
.task-flow-v6 {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* ===== 列表视图 ===== */
.list-view {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.page-header h3 {
  font-size: 15px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.version-tag {
  font-size: 11px;
  background: #1890ff;
  color: #fff;
  padding: 1px 8px;
  border-radius: 10px;
  font-weight: 500;
}

.kw-cell {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

/* ===== 画布视图 ===== */
.canvas-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.canvas-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: #fff;
  border-bottom: 1px solid #e8e8e8;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toolbar-title {
  font-size: 14px;
  font-weight: 600;
}

.toolbar-center {
  display: flex;
  gap: 8px;
}

.toolbar-right {
  display: flex;
  gap: 8px;
}

.canvas-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ===== 节点库 ===== */
.node-palette {
  width: 220px;
  background: #fafafa;
  border-right: 1px solid #e8e8e8;
  padding: 12px;
  overflow-y: auto;
  flex-shrink: 0;
}

.palette-title {
  font-size: 12px;
  font-weight: 600;
  color: #333;
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.palette-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 6px;
  background: #fff;
  border-radius: 8px;
  border-left: 3px solid;
  cursor: grab;
  font-size: 13px;
  transition: box-shadow 0.15s;
}

.palette-item:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.palette-item:active {
  cursor: grabbing;
}

.palette-icon {
  font-size: 14px;
}

.palette-label {
  flex: 1;
}

.palette-section {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid #e8e8e8;
}

.tag-input-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.slot-mini {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}

/* ===== 画布区域 ===== */
.canvas-area {
  flex: 1;
  position: relative;
  background: #f8fafc;
  border-radius: 8px;
  margin: 8px;
  overflow: hidden;
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.04);
}

/* Vue Flow 样式覆盖 */
.canvas-area :deep(.vue-flow) {
  background: #f8fafc;
}

.canvas-area :deep(.vue-flow__edge-path) {
  stroke: #94a3b8;
  stroke-width: 2;
}

.canvas-area :deep(.vue-flow__edge:hover .vue-flow__edge-path) {
  stroke: #3b82f6;
  stroke-width: 3;
}

.canvas-area :deep(.vue-flow__edge.animated path) {
  stroke-dasharray: 5;
  animation: dashdraw 0.5s linear infinite;
}

@keyframes dashdraw {
  from { stroke-dashoffset: 10; }
  to { stroke-dashoffset: 0; }
}

/* 小地图样式 */
.canvas-area :deep(.vue-flow__minimap) {
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* 控制按钮样式 */
.canvas-area :deep(.vue-flow__controls) {
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.canvas-area :deep(.vue-flow__controls-button) {
  border: none;
  border-bottom: 1px solid #e2e8f0;
}

.canvas-area :deep(.vue-flow__controls-button:hover) {
  background: #f1f5f9;
}
</style>
