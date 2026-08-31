<template>
  <div class="category-tree">
    <div class="tree-header">
      <h4>分类目录</h4>
      <el-button size="small" @click="$emit('addCategory')">+ 分类</el-button>
    </div>
    <el-tree
      :data="treeData"
      :props="{ label: 'name', children: 'children' }"
      node-key="id"
      highlight-current
      :default-expand-all="true"
      @node-click="handleNodeClick"
    >
      <template #default="{ node, data }">
        <div class="tree-node">
          <span>{{ data.name }}</span>
          <el-tag size="small" :type="data.id === modelValue ? '' : 'info'" round>
            {{ data.faqCount || 0 }}
          </el-tag>
        </div>
      </template>
    </el-tree>
  </div>
</template>

<script setup>
const props = defineProps({
  treeData: { type: Array, default: () => [] },
  modelValue: { type: [Number, null], default: null },
})

const emit = defineEmits(['update:modelValue', 'addCategory'])

function handleNodeClick(data) {
  emit('update:modelValue', data.id)
}
</script>

<style scoped>
.category-tree {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  padding: 16px;
  width: 260px;
  min-width: 260px;
  height: fit-content;
  position: sticky;
  top: 0;
}
.tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.tree-header h4 {
  font-size: 14px;
  color: #333;
  margin: 0;
}
.tree-node {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  font-size: 13px;
}
</style>
