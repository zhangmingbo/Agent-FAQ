<template>
  <div class="faq-layout">
    <!-- 左侧分类树 -->
    <CategoryTree
      :tree-data="store.categoryTree"
      :model-value="currentCategoryId"
      @update:model-value="handleCategorySelect"
      @add-category="showCategoryModal = true"
      @delete-category="handleDeleteCategory"
    />

    <!-- 右侧 FAQ 列表 -->
    <div class="faq-content">
      <div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
        <el-input v-model="searchKey" placeholder="搜索FAQ..." clearable style="width:260px" @input="filterFAQ" />
        <div style="display:flex;gap:8px">
          <el-button @click="showImportModal = true">📥 批量导入</el-button>
          <el-button type="primary" @click="openAddModal">+ 新增 FAQ</el-button>
        </div>
      </div>

      <div class="faq-table-wrap">
        <el-table :data="displayList" stripe style="width:100%" @sort-change="handleSortChange">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column prop="code" label="编码" sortable="custom" min-width="120">
            <template #default="{ row }"><code>{{ row.code }}</code></template>
          </el-table-column>
          <el-table-column prop="name" label="名称" sortable="custom" min-width="160" />
          <el-table-column label="分类" sortable="custom" prop="category" width="120">
            <template #default="{ row }">
              <el-tag size="small" type="primary">{{ store.getCategoryName(row.categoryId) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="questionCount" label="相似问数" sortable="custom" width="90" align="center" />
          <el-table-column label="答案预览" min-width="200">
            <template #default="{ row }">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block">{{ row.answerPreview || '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="140" align="center" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="editFaq(row.code)">编辑</el-button>
              <el-button size="small" type="danger" @click="handleDelete(row.code)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- 弹窗 -->
    <FaqEditModal
      v-model="showEditModal"
      :faq-code="editingCode"
      :category-tree="store.categoryTree"
      :category-id="currentCategoryId"
      @saved="handleSaved"
    />
    <CategoryModal
      v-model="showCategoryModal"
      :category-tree="store.categoryTree"
      @saved="handleSaved"
    />
    <ImportModal
      v-model="showImportModal"
      @imported="handleSaved"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useFaqStore } from '@/stores/faq'
import { deleteFaq, getFaqDetail } from '@/api/faq'
import { getCategoryFaqs, deleteCategory } from '@/api/category'
import CategoryTree from '@/components/CategoryTree.vue'
import FaqEditModal from '@/components/FaqEditModal.vue'
import CategoryModal from '@/components/CategoryModal.vue'
import ImportModal from '@/components/ImportModal.vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const store = useFaqStore()

const searchKey = ref('')
const currentCategoryId = ref(null)
const categoryFaqList = ref(null) // null = all, array = filtered by category

const showEditModal = ref(false)
const showCategoryModal = ref(false)
const showImportModal = ref(false)
const editingCode = ref('')

const sortState = ref({ field: null, order: null })

const baseList = computed(() => categoryFaqList.value || store.faqList)

const displayList = computed(() => {
  let list = [...baseList.value]
  // search filter
  if (searchKey.value) {
    const q = searchKey.value.toLowerCase()
    list = list.filter(f => f.code.includes(q) || f.name.includes(q))
  }
  // sort
  if (sortState.value.field && sortState.value.order) {
    const { field, order } = sortState.value
    list.sort((a, b) => {
      let va = a[field], vb = b[field]
      if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb || '').toLowerCase() }
      if (va < vb) return order === 'ascending' ? -1 : 1
      if (va > vb) return order === 'ascending' ? 1 : -1
      return 0
    })
  }
  return list
})

function filterFAQ() {
  // computed handles it
}

function handleSortChange({ prop, order }) {
  sortState.value = { field: prop, order }
}

function handleCategorySelect(id) {
  currentCategoryId.value = id
  if (id === null) {
    categoryFaqList.value = null
  } else {
    getCategoryFaqs(id).then(data => {
      categoryFaqList.value = data
    })
  }
}

function openAddModal() {
  editingCode.value = ''
  showEditModal.value = true
}

function editFaq(code) {
  editingCode.value = code
  showEditModal.value = true
}

async function handleDelete(code) {
  try {
    await ElMessageBox.confirm(`确定删除 FAQ "${code}" 吗？`, '确认删除', { type: 'warning' })
    await deleteFaq(code)
    ElMessage.success('已删除')
    
    // 刷新全局数据
    store.loadData()
    
    // 如果当前选中了分类，同时刷新该分类的FAQ列表
    if (currentCategoryId.value) {
      const data = await getCategoryFaqs(currentCategoryId.value)
      categoryFaqList.value = data
    }
  } catch {
    // cancelled
  }
}

function handleSaved() {
  store.loadData()
  // refresh category filter if active
  if (currentCategoryId.value) {
    getCategoryFaqs(currentCategoryId.value).then(data => {
      categoryFaqList.value = data
    })
  }
}

async function handleDeleteCategory(data) {
  try {
    await ElMessageBox.confirm(`确定删除分类「${data.name}」吗？`, '确认删除', { type: 'warning' })
    const res = await deleteCategory(data.id)
    if (res.success) {
      ElMessage.success('分类已删除')
      if (currentCategoryId.value === data.id) {
        currentCategoryId.value = null
        categoryFaqList.value = null
      }
      store.loadData()
    } else {
      // 显示后端返回的错误信息
      ElMessage.error(res.message || '删除失败')
    }
  } catch (error) {
    // 如果是用户取消，不显示错误
    if (error !== 'cancel') {
      // 显示后端返回的验证错误（子目录或FAQ存在）
      const errorMsg = error?.response?.data?.message || error?.message || '删除失败'
      ElMessage.error(errorMsg)
    }
  }
}

onMounted(() => {
  store.loadData()
})
</script>

<style scoped>
.faq-layout {
  display: flex;
  gap: 20px;
}
.faq-content {
  flex: 1;
  min-width: 0;
}
.faq-table-wrap {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  overflow: hidden;
  padding: 16px;
}
</style>
