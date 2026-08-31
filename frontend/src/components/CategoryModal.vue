<template>
  <el-dialog v-model="visible" title="新增分类" width="420px" destroy-on-close>
    <el-form :model="form" label-width="80px">
      <el-form-item label="分类名称">
        <el-input v-model="form.name" placeholder="如: 燃气业务" />
      </el-form-item>
      <el-form-item label="分类编码">
        <el-input v-model="form.code" placeholder="如: gas" />
      </el-form-item>
      <el-form-item label="父级分类">
        <el-select v-model="form.parentId" placeholder="无（顶级分类）" clearable style="width:100%">
          <el-option label="无（顶级分类）" :value="null" />
          <el-option v-for="opt in parentOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="handleSave">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { reactive, computed, watch } from 'vue'
import { addCategory } from '@/api/category'
import { ElMessage } from 'element-plus'

const props = defineProps({
  modelValue: Boolean,
  categoryTree: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const form = reactive({ name: '', code: '', parentId: null })

const parentOptions = computed(() => {
  const opts = []
  function walk(nodes, prefix = '') {
    for (const n of nodes) {
      opts.push({ value: n.id, label: prefix + n.name })
      if (n.children?.length) walk(n.children, prefix + ' ')
    }
  }
  walk(props.categoryTree)
  return opts
})

watch(visible, (val) => {
  if (val) Object.assign(form, { name: '', code: '', parentId: null })
})

async function handleSave() {
  if (!form.name || !form.code) {
    ElMessage.warning('请填写名称和编码')
    return
  }
  const res = await addCategory({ name: form.name.trim(), code: form.code.trim(), parentId: form.parentId || 0 })
  if (res.success) {
    ElMessage.success(res.message)
    visible.value = false
    emit('saved')
  } else {
    ElMessage.error(res.message)
  }
}
</script>
