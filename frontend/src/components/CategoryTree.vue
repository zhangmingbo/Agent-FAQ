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
          <div class="tree-node-actions">
            <el-tag size="small" :type="data.id === modelValue ? '' : 'info'" round>
              {{ data.faqCount || 0 }}
            </el-tag>
            <el-button size="small" text type="danger" @click.stop="handleDelete(data)" class="delete-btn">×</el-button>
          </div>
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

const emit = defineEmits(['update:modelValue', 'addCategory', 'deleteCategory'])

function handleNodeClick(data) {
  emit('update:modelValue', data.id)
}

function handleDelete(data) {
  emit('deleteCategory', data)
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
.tree-node-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.delete-btn {
  display: none;
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
}
.tree-node:hover .delete-btn {
  display: inline-flex;
}
</style>
