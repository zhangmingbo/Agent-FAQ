<template>
  <div class="node-panel" v-if="props.visible">
    <div class="node-panel__header">
      <span class="node-panel__title">{{ panelTitle }}</span>
      <div class="node-panel__header-actions">
        <el-button size="small" @click="handleCancel">取消</el-button>
        <el-button size="small" type="primary" @click="handleApply">保存</el-button>
      </div>
    </div>

    <div class="node-panel__body">
      <!-- 通用字段 -->
      <div class="panel-field">
        <label>节点名称</label>
        <el-input v-model="localData.label" size="small" placeholder="节点显示名称" />
      </div>

      <!-- 收集节点 -->
      <template v-if="nodeType === 'collect'">
        <div class="panel-field">
          <label>变量名</label>
          <el-input v-model="localData.variableName" size="small" placeholder="如 user_name, phone_number" />
          <span class="field-hint">用于存储用户输入的变量名</span>
        </div>
        <div class="panel-field">
          <label>提示话术</label>
          <el-input v-model="localData.prompt" size="small" type="textarea" :rows="3" placeholder="向用户提问的内容，如：请输入您的姓名" />
        </div>
        <div class="panel-field">
          <label>是否必填</label>
          <el-switch v-model="localData.required" active-text="是" inactive-text="否" />
        </div>
      </template>

      <!-- 回复节点 -->
      <template v-if="nodeType === 'message'">
        <div class="panel-field">
          <label>回复内容</label>
          <el-input v-model="localData.text" size="small" type="textarea" :rows="4" placeholder="发送给用户的消息" />
        </div>
      </template>

      <!-- 分支节点 -->
      <template v-if="nodeType === 'branch'">
        <div class="panel-field">
          <label>分支条件</label>
          <div v-for="(c, i) in localData.cases" :key="i" class="branch-case">
            <el-input v-model="c.label" size="small" placeholder="条件标签" style="width:100px" />
            <el-button size="small" text type="danger" @click="localData.cases.splice(i, 1)"></el-button>
          </div>
          <el-button size="small" text type="primary" @click="localData.cases.push({ label: '', when: {} })">+ 添加条件</el-button>
        </div>
      </template>

      <!-- 接口节点 -->
      <template v-if="nodeType === 'api'">
        <div class="panel-field">
          <label>接口地址</label>
          <el-input v-model="localData.url" size="small" placeholder="POST /api/xxx" />
        </div>
        <div class="panel-field">
          <label>请求方法</label>
          <el-select v-model="localData.method" size="small" style="width:100%">
            <el-option value="GET" label="GET" />
            <el-option value="POST" label="POST" />
            <el-option value="PUT" label="PUT" />
            <el-option value="DELETE" label="DELETE" />
          </el-select>
        </div>
        <div class="panel-field">
          <label>成功话术</label>
          <el-input v-model="localData.message" size="small" placeholder="接口调用成功后的回复" />
        </div>
      </template>

      <!-- 确认节点 -->
      <template v-if="nodeType === 'confirm'">
        <div class="panel-field">
          <label>确认话术</label>
          <el-input v-model="localData.prompt" size="small" type="textarea" :rows="3" placeholder="请确认以上信息是否正确" />
        </div>
      </template>

      <!-- 子任务节点 -->
      <template v-if="nodeType === 'subtask'">
        <div class="panel-field">
          <label>子任务编码</label>
          <el-select v-model="localData.task" size="small" style="width:100%" placeholder="选择子任务" clearable filterable>
            <el-option v-for="t in allTasks" :key="t.code" :value="t.code" :label="t.name" />
          </el-select>
        </div>
      </template>

      <!-- 结束节点 -->
      <template v-if="nodeType === 'end'">
        <div class="panel-field">
          <label>完成话术</label>
          <el-input v-model="localData.doneMessage" size="small" type="textarea" :rows="3" placeholder="任务完成后的回复" />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  nodeType: { type: String, default: 'message' },
  nodeData: { type: Object, default: () => ({}) },
  slots: { type: Array, default: () => [] },
  allTasks: { type: Array, default: () => [] },
})

const emit = defineEmits(['apply', 'close'])

const localData = ref({})

// 监听节点数据变化，实时更新面板内容
watch(() => props.nodeData, (newData) => {
  if (props.visible && newData && Object.keys(newData).length > 0) {
    localData.value = JSON.parse(JSON.stringify(newData))
  }
}, { deep: true })

watch(() => props.visible, (v) => {
  if (v && props.nodeData && Object.keys(props.nodeData).length > 0) {
    localData.value = JSON.parse(JSON.stringify(props.nodeData))
  }
})

// 自动保存：数据变化时立即应用
let saveTimer = null
watch(() => localData.value, (newVal) => {
  if (props.visible && newVal && Object.keys(newVal).length > 0) {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      // 深拷贝确保数据完整性
      emit('apply', JSON.parse(JSON.stringify(newVal)))
    }, 300)
  }
}, { deep: true })

const panelTitle = computed(() => {
  const titles = {
    start: '开始节点', collect: '收集节点', message: '回复节点',
    branch: '分支节点', api: '接口节点', confirm: '确认节点',
    subtask: '子任务节点', end: '结束节点',
  }
  return titles[props.nodeType] || '节点属性'
})

function handleApply() {
  emit('apply', { ...localData.value })
}

function handleCancel() {
  // 恢复原始数据
  localData.value = JSON.parse(JSON.stringify(props.nodeData || {}))
  emit('close')
}
</script>

<style scoped>
.node-panel {
  width: 100%;
  height: 100%;
  background: #fff;
  border-radius: 8px;
  box-shadow: -2px 0 8px rgba(0,0,0,0.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.node-panel__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
}

.node-panel__title {
  font-size: 14px;
  font-weight: 600;
}

.node-panel__header-actions {
  display: flex;
  gap: 8px;
}

.node-panel__body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.panel-field {
  margin-bottom: 16px;
}

.panel-field label {
  display: block;
  font-size: 12px;
  color: #666;
  margin-bottom: 6px;
}

.field-hint {
  display: block;
  font-size: 11px;
  color: #999;
  margin-top: 4px;
}

.branch-case {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
</style>
