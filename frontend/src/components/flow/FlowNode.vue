<template>
  <div class="flow-node" :class="[`flow-node--${nodeType}`, { 'flow-node--selected': selected }]" @dblclick="$emit('edit', data)">
    <!-- 输入锚点（开始节点无输入） -->
    <Handle
      v-if="nodeType !== 'start'"
      type="target"
      position="left"
      class="flow-handle flow-handle--target"
    />

    <!-- 节点内容 -->
    <div class="flow-node__body">
      <span class="flow-node__icon">{{ nodeIcon }}</span>
      <span class="flow-node__label">{{ displayLabel }}</span>
    </div>

    <!-- 输出锚点 -->
    <template v-if="nodeType === 'branch'">
      <!-- 分支节点：每个 case 一个输出 -->
      <Handle
        v-for="(c, i) in branchCases"
        :key="i"
        type="source"
        position="right"
        :id="`case_${i}`"
        class="flow-handle flow-handle--source flow-handle--branch"
        :style="{ top: `${20 + i * 28}px` }"
      />
    </template>
    <Handle
      v-else
      type="source"
      position="right"
      class="flow-handle flow-handle--source"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle } from '@vue-flow/core'
import { NODE_TYPES } from '@/utils/flowConverter'

const props = defineProps({
  data: { type: Object, default: () => ({}) },
  selected: { type: Boolean, default: false },
})

defineEmits(['edit'])

const nodeType = computed(() => {
  // Vue Flow 通过 type prop 传入，这里从父组件的 nodeTypes 映射
  return props.data._nodeType || 'message'
})

const nodeConfig = computed(() => NODE_TYPES[nodeType.value] || NODE_TYPES.message)
const nodeIcon = computed(() => nodeConfig.value.icon)

const displayLabel = computed(() => {
  const d = props.data
  switch (nodeType.value) {
    case 'start': return '开始'
    case 'collect': return d.label || d.slotKey || '收集'
    case 'message': return d.text ? (d.text.length > 12 ? d.text.slice(0, 12) + '...' : d.text) : '回复'
    case 'branch': return d.label || '分支'
    case 'api': return d.url ? (d.url.length > 12 ? d.url.slice(0, 12) + '...' : d.url) : '接口'
    case 'confirm': return '确认'
    case 'subtask': return d.task || '子任务'
    case 'end': return d.doneMessage ? (d.doneMessage.length > 12 ? d.doneMessage.slice(0, 12) + '...' : d.doneMessage) : '结束'
    default: return d.label || nodeConfig.value.label
  }
})

const branchCases = computed(() => {
  if (nodeType.value === 'branch') {
    return (props.data.cases || [{ label: '条件1' }, { label: '条件2' }])
  }
  return []
})
</script>

<style scoped>
.flow-node {
  position: relative;
  border-radius: 22px;
  padding: 0 20px;
  min-width: 100px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: box-shadow 0.2s, transform 0.15s;
  user-select: none;
}

.flow-node:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.flow-node--selected {
  box-shadow: 0 0 0 2px #1890ff, 0 4px 12px rgba(24, 144, 255, 0.3);
}

/* 橙色 = 用户分支/意图节点 */
.flow-node--branch,
.flow-node--confirm {
  background: #fa8c16;
  color: #fff;
  font-weight: 500;
}

/* 蓝色 = 系统动作节点 */
.flow-node--start,
.flow-node--collect,
.flow-node--message,
.flow-node--api,
.flow-node--subtask {
  background: #1890ff;
  color: #fff;
  font-weight: 500;
}

/* 结束节点 - 红色 */
.flow-node--end {
  background: #f5222d;
  color: #fff;
  font-weight: 500;
}

.flow-node__body {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.flow-node__icon {
  font-size: 14px;
  flex-shrink: 0;
}

.flow-node__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 连接锚点 */
.flow-handle {
  width: 10px !important;
  height: 10px !important;
  border: 2px solid #fff !important;
  border-radius: 50% !important;
  background: #fff !important;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.flow-handle--target {
  left: -5px !important;
}

.flow-handle--source {
  right: -5px !important;
}

.flow-handle--branch {
  position: absolute !important;
}
</style>
