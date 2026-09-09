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
  border-radius: 8px;
  padding: 12px 20px;
  min-width: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  font-weight: 500;
  border: 2px solid transparent;
}

/* 默认阴影 */
.flow-node {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.06);
}

.flow-node:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.12), 0 4px 8px rgba(0, 0, 0, 0.08);
}

.flow-node--selected {
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2), 0 8px 16px rgba(0, 0, 0, 0.12);
}

/* 橙色 = 用户分支/意图节点 */
.flow-node--branch,
.flow-node--confirm {
  background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
  color: #fff;
  border-color: #ea580c;
}

.flow-node--branch:hover,
.flow-node--confirm:hover {
  background: linear-gradient(135deg, #fb923c 0%, #f97316 100%);
}

/* 蓝色 = 系统动作节点 */
.flow-node--start,
.flow-node--collect,
.flow-node--message,
.flow-node--api,
.flow-node--subtask {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: #fff;
  border-color: #2563eb;
}

.flow-node--start:hover,
.flow-node--collect:hover,
.flow-node--message:hover,
.flow-node--api:hover,
.flow-node--subtask:hover {
  background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
}

/* 开始节点 - 绿色 */
.flow-node--start {
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
  border-color: #16a34a;
}

.flow-node--start:hover {
  background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
}

/* 结束节点 - 红色 */
.flow-node--end {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: #fff;
  border-color: #dc2626;
}

.flow-node--end:hover {
  background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
}

.flow-node__body {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.flow-node__icon {
  font-size: 16px;
  flex-shrink: 0;
}

.flow-node__label {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}

/* 连接锚点 - 官方风格 */
.flow-handle {
  width: 12px !important;
  height: 12px !important;
  border: 2px solid #fff !important;
  border-radius: 50% !important;
  background: #3b82f6 !important;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  transition: all 0.2s ease;
}

.flow-handle:hover {
  transform: scale(1.3);
  background: #60a5fa !important;
  box-shadow: 0 4px 8px rgba(59, 130, 246, 0.4);
}

.flow-handle--target {
  left: -6px !important;
}

.flow-handle--source {
  right: -6px !important;
}

.flow-handle--branch {
  position: absolute !important;
}

/* 分支节点的特殊锚点颜色 */
.flow-node--branch .flow-handle,
.flow-node--confirm .flow-handle {
  background: #f97316 !important;
}

.flow-node--branch .flow-handle:hover,
.flow-node--confirm .flow-handle:hover {
  background: #fb923c !important;
  box-shadow: 0 4px 8px rgba(249, 115, 22, 0.4);
}

/* 结束节点的锚点 */
.flow-node--end .flow-handle {
  background: #ef4444 !important;
}

.flow-node--end .flow-handle:hover {
  background: #f87171 !important;
  box-shadow: 0 4px 8px rgba(239, 68, 68, 0.4);
}

/* 开始节点的锚点 */
.flow-node--start .flow-handle {
  background: #22c55e !important;
}

.flow-node--start .flow-handle:hover {
  background: #4ade80 !important;
  box-shadow: 0 4px 8px rgba(34, 197, 94, 0.4);
}
</style>
