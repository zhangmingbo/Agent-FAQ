<template>
  <div class="ner-manage">
    <div class="page-header">
      <h3>NER 实体类型管理</h3>
      <el-button type="primary" size="small" @click="showEditModal(null)">+ 新增类型</el-button>
    </div>
    <p class="desc">管理 NER 实体类型。内置类型由 NER 模型识别，正则类型通过正则表达式后处理提取。保存后立即生效。</p>

    <el-table :data="nerTypes" size="small" style="width:100%" v-loading="loading">
      <el-table-column prop="type" label="类型标识" width="120">
        <template #default="{ row }"><b>{{ row.type }}</b></template>
      </el-table-column>
      <el-table-column prop="label" label="中文名称" width="100" />
      <el-table-column label="来源" width="80">
        <template #default="{ row }">
          <el-tag :type="row.source === 'model' ? 'success' : 'info'" size="small">
            {{ row.source === 'model' ? 'NER模型' : '正则' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="正则表达式" min-width="200">
        <template #default="{ row }">
          <code v-if="row.regex" class="regex-code">{{ row.regex }}</code>
          <span v-else style="color:#ccc">—</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="70" align="center">
        <template #default="{ row }">
          <el-tag :type="row.enabled !== false ? 'success' : 'info'" size="small">
            {{ row.enabled !== false ? '已启用' : '已禁用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" align="center">
        <template #default="{ row }">
          <el-button size="small" text @click="showEditModal(row)">编辑</el-button>
          <el-button v-if="row.source !== 'model'" size="small" text type="danger" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 正则匹配测试 -->
    <div class="test-area">
      <h5>正则匹配测试</h5>
      <div class="test-row">
        <el-input v-model="testText" placeholder="输入测试文本..." size="small" style="flex:1" />
        <el-button type="primary" size="small" @click="handleTest" :loading="testing">测试</el-button>
      </div>
      <div v-if="testResults.length" class="test-results">
        <div v-for="item in testResults" :key="item.type" class="test-item">
          <span class="test-label">{{ item.label }}</span>
          <template v-if="item.matches.length">
            <b v-for="(m, i) in item.matches" :key="i" class="match-text">{{ m }}</b>
          </template>
          <span v-else style="color:#ccc">无匹配</span>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <el-dialog v-model="editVisible" :title="editIsNew ? '新增 NER 类型' : '编辑 NER 类型'" width="520px">
      <el-form :model="editForm" label-width="110px" size="small">
        <el-form-item label="类型标识">
          <el-input v-model="editForm.type" placeholder="如 order_no" :disabled="!editIsNew" />
        </el-form-item>
        <el-form-item label="中文名称">
          <el-input v-model="editForm.label" placeholder="如 订单号" />
        </el-form-item>
        <el-form-item label="正则表达式">
          <el-input v-model="editForm.regex" placeholder="如 \d{10,20}" style="font-family:monospace" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="editForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSaveEdit" :loading="saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getNerTypes, saveNerTypes, testNerRegex } from '@/api/config'
import { ElMessage, ElMessageBox } from 'element-plus'

const loading = ref(false)
const nerTypes = ref([])
const testText = ref('')
const testing = ref(false)
const testResults = ref([])
const editVisible = ref(false)
const editIsNew = ref(false)
const saving = ref(false)
const editForm = ref({ type: '', label: '', regex: '', enabled: true })

async function loadTypes() {
  loading.value = true
  try {
    const res = await getNerTypes()
    nerTypes.value = res.data || []
  } catch (e) {
    ElMessage.error('加载失败')
  } finally {
    loading.value = false
  }
}

function showEditModal(row) {
  editIsNew.value = !row
  editForm.value = row
    ? { ...row }
    : { type: '', label: '', regex: '', enabled: true }
  editVisible.value = true
}

async function handleSaveEdit() {
  const f = editForm.value
  if (!f.type.trim() || !f.label.trim()) {
    ElMessage.warning('类型标识和中文名称不能为空')
    return
  }
  if (f.regex) {
    try { new RegExp(f.regex) } catch (e) {
      ElMessage.error('正则表达式有误：' + e.message)
      return
    }
  }
  saving.value = true
  try {
    let types = [...nerTypes.value]
    if (editIsNew.value) {
      if (types.find(t => t.type === f.type)) {
        ElMessage.error('类型标识已存在')
        saving.value = false
        return
      }
      types.push({ type: f.type, label: f.label, regex: f.regex, source: 'regex', enabled: f.enabled })
    } else {
      types = types.map(t => t.type === f.type ? { ...t, label: f.label, regex: f.regex, enabled: f.enabled } : t)
    }
    const res = await saveNerTypes(types)
    if (res.success) {
      ElMessage.success('已保存')
      editVisible.value = false
      await loadTypes()
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } finally {
    saving.value = false
  }
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(`确认删除类型「${row.type}」？`, '确认')
    const types = nerTypes.value.filter(t => t.type !== row.type)
    const res = await saveNerTypes(types)
    if (res.success) {
      ElMessage.success('已删除')
      await loadTypes()
    }
  } catch { /* cancelled */ }
}

async function handleTest() {
  if (!testText.value.trim()) {
    testResults.value = []
    return
  }
  testing.value = true
  try {
    const res = await testNerRegex(testText.value)
    testResults.value = res.data || []
  } finally {
    testing.value = false
  }
}

onMounted(loadTypes)
</script>

<style scoped>
.ner-manage { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.page-header h3 { font-size: 15px; margin: 0; }
.desc { font-size: 12px; color: #888; margin-bottom: 16px; }
.regex-code { font-size: 11px; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
.test-area { margin-top: 20px; border-top: 1px solid #eee; padding-top: 16px; }
.test-area h5 { font-size: 13px; margin: 0 0 8px; }
.test-row { display: flex; gap: 8px; align-items: center; }
.test-results { margin-top: 8px; font-size: 12px; color: #666; }
.test-item { margin-bottom: 4px; }
.test-label { display: inline-block; width: 80px; font-weight: 600; }
.match-text { color: #4361ee; }
</style>
