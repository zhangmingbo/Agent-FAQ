<template>
  <div class="expand-cell" :class="{ expanded }" @click="expanded = !expanded" :style="{ cursor: hasMore ? 'pointer' : 'default' }">
    <span v-if="!expanded">{{ displayText }}</span>
    <span v-else class="full-text">{{ text }}</span>
    <span v-if="hasMore" class="toggle-hint">{{ expanded ? '收起' : '展开' }}</span>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  text: { type: String, default: '' },
  maxLen: { type: Number, default: 50 },
})

const expanded = ref(false)
const hasMore = computed(() => props.text.length > props.maxLen)
const displayText = computed(() =>
  hasMore.value ? props.text.substring(0, props.maxLen) + '...' : props.text
)
</script>

<style scoped>
.expand-cell {
  font-size: 13px;
  overflow: hidden;
  word-break: break-word;
}
.expand-cell.expanded {
  white-space: normal;
}
.full-text {
  white-space: pre-wrap;
}
.toggle-hint {
  color: #1890ff;
  margin-left: 4px;
  font-size: 12px;
}
</style>
