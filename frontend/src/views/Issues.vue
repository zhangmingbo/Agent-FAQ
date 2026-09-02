<template>
  <div>
    <!-- 子Tab切换 -->
    <div class="sub-tab-bar">
      <div class="sub-tab" :class="{ active: subTab === 'unmatched' }" @click="switchTab('unmatched')">❓ 未匹配问题</div>
      <div class="sub-tab" :class="{ active: subTab === 'lowConf' }" @click="switchTab('lowConf')">⚠️ 低置信度</div>
    </div>

    <!-- 未匹配问题 -->
    <div v-if="subTab === 'unmatched'">
      <div class="toolbar">
        <el-select v-model="unmatchedDate" placeholder="全部日期" clearable @change="loadUnmatched" style="width:180px">
          <el-option v-for="d in unmatchedDates" :key="d.date" :label="formatDateLabel(d)" :value="formatDateValue(d)" />
        </el-select>
        <el-input v-model="unmatchedKeyword" placeholder="搜索问题关键词..." clearable style="width:200px" @keyup.enter="loadUnmatched" />
        <el-button size="small" @click="loadUnmatched">🔍 搜索</el-button>
        <div style="flex:1"></div>
        <span style="font-size:12px;color:#888">共 {{ unmatchedTotal }} 个未匹配问题</span>
      </div>

      <!-- 批量操作工具栏 -->
      <div class="batch-toolbar">
        <span v-if="selectedRows.length > 0" style="margin-left:12px;color:#4361ee">已选 {{ selectedRows.length }} 项</span>
        <div style="flex:1"></div>
        <el-button size="small" type="success" :disabled="selectedRows.length === 0" @click="handleBatchIgnore">
          <el-icon><Check /></el-icon> 批量忽略
        </el-button>
      </div>

      <div class="table-wrap">
        <el-table ref="unmatchedTable" :data="unmatchedItems" stripe style="width:100%" @sort-change="handleUnmatchedSort" @selection-change="handleSelectionChange">
          <!-- 复选框列(最左边) -->
          <el-table-column type="selection" width="50" align="center" />
          <!-- 序号列 -->
          <el-table-column type="index" label="#" width="50" align="center" />
          <!-- 用户问题列 -->
          <el-table-column label="用户问题" min-width="200">
            <template #default="{ row }">
              <ExpandCell :text="row.text" :max-length="40" />
              <el-tag v-if="addedMap[row.text]" size="small" type="success" style="margin-left:6px">✓ 已添加</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="机器人回答" min-width="300">
            <template #default="{ row }">
              <ExpandCell :text="row.answer || ''" :max-length="50" empty-text="无回答" />
            </template>
          </el-table-column>
          <el-table-column prop="count" label="出现次数" sortable="custom" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" type="danger">{{ row.count }} 次</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="lastTime" label="最近出现" sortable="custom" width="160" />
          <el-table-column prop="firstTime" label="首次出现" width="160" />
          <el-table-column label="操作" width="200" align="center">
            <template #default="{ row }">
              <el-button size="small" type="success" @click="handleIgnore(row.text)">
                <el-icon><Check /></el-icon> 忽略
              </el-button>
              <el-button size="small" :type="addedMap[row.text] ? 'default' : 'primary'" @click="openSuggest(row.text)">+ 相似问</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="pagination">
        <div style="display:flex;align-items:center;gap:12px">
          <span>每页显示:</span>
          <el-select v-model="pageSize" size="small" style="width:100px" @change="handlePageSizeChange">
            <el-option label="20 条" :value="20" />
            <el-option label="50 条" :value="50" />
            <el-option label="100 条" :value="100" />
          </el-select>
        </div>
        <span>第 {{ unmatchedPage }}/{{ unmatchedTotalPages }} 页，共 {{ unmatchedTotal }} 条</span>
        <div style="display:flex;gap:6px">
          <el-button size="small" :disabled="unmatchedPage <= 1" @click="unmatchedPage--; loadUnmatched()">上一页</el-button>
          <el-button size="small" :disabled="unmatchedPage >= unmatchedTotalPages" @click="unmatchedPage++; loadUnmatched()">下一页</el-button>
        </div>
      </div>
    </div>

    <!-- 低置信度 -->
    <div v-if="subTab === 'lowConf'">
      <div class="toolbar">
        <el-select v-model="lowConfDate" placeholder="全部日期" clearable @change="loadLowConf" style="width:180px">
          <el-option v-for="d in lowConfDates" :key="d.date" :label="formatDateLabel(d)" :value="formatDateValue(d)" />
        </el-select>
        <el-input v-model="lowConfKeyword" placeholder="搜索问题关键词..." clearable style="width:200px" @keyup.enter="loadLowConf" />
        <el-button size="small" @click="loadLowConf">🔍 搜索</el-button>
        <div style="flex:1"></div>
        <span style="font-size:12px;color:#888">共 {{ lowConfTotal }} 条低置信度记录</span>
      </div>

      <!-- 批量操作工具栏 -->
      <div class="batch-toolbar">
        <span v-if="selectedRows.length > 0" style="margin-left:12px;color:#4361ee">已选 {{ selectedRows.length }} 项</span>
        <div style="flex:1"></div>
        <el-button size="small" type="success" :disabled="selectedRows.length === 0" @click="handleBatchIgnore">
          <el-icon><Check /></el-icon> 批量忽略
        </el-button>
      </div>

      <div class="table-wrap">
        <el-table ref="lowConfTable" :data="lowConfItems" stripe style="width:100%" @sort-change="handleLowConfSort" @selection-change="handleSelectionChange">
          <!-- 复选框列(最左边) -->
          <el-table-column type="selection" width="50" align="center" />
          <!-- 序号列 -->
          <el-table-column type="index" label="#" width="50" align="center" />
          <!-- 用户问题列 -->
          <el-table-column label="用户问题" min-width="200">
            <template #default="{ row }">
              <ExpandCell :text="row.text" :max-length="40" />
              <el-tag v-if="addedMap[row.text]" size="small" type="success" style="margin-left:6px">✓ 已添加</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="机器人回答" min-width="300">
            <template #default="{ row }">
              <ExpandCell :text="row.answer || ''" :max-length="50" empty-text="无回答" />
            </template>
          </el-table-column>
          <el-table-column prop="confidence" label="置信度" sortable="custom" width="100" align="center">
            <template #default="{ row }">
              <el-tag size="small" type="warning">{{ (row.confidence * 100).toFixed(1) }}%</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="intent" label="匹配到" sortable="custom" width="150">
            <template #default="{ row }">
              {{ store.getFaqName(row.intent) }}
            </template>
          </el-table-column>
          <el-table-column prop="time" label="时间" sortable="custom" width="160" />
          <el-table-column label="操作" width="200" align="center">
            <template #default="{ row }">
              <el-button size="small" type="success" @click="handleIgnore(row.text)">
                <el-icon><Check /></el-icon> 忽略
              </el-button>
              <el-button size="small" :type="addedMap[row.text] ? 'default' : 'primary'" @click="openSuggest(row.text)">+ 相似问</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="pagination">
        <div style="display:flex;align-items:center;gap:12px">
          <span>每页显示:</span>
          <el-select v-model="pageSize" size="small" style="width:100px" @change="handlePageSizeChange">
            <el-option label="20 条" :value="20" />
            <el-option label="50 条" :value="50" />
            <el-option label="100 条" :value="100" />
          </el-select>
        </div>
        <span>第 {{ lowConfPage }}/{{ lowConfTotalPages }} 页，共 {{ lowConfTotal }} 条</span>
        <div style="display:flex;gap:6px">
          <el-button size="small" :disabled="lowConfPage <= 1" @click="lowConfPage--; loadLowConf()">上一页</el-button>
          <el-button size="small" :disabled="lowConfPage >= lowConfTotalPages" @click="lowConfPage++; loadLowConf()">下一页</el-button>
        </div>
      </div>
    </div>

    <!-- 智能建议弹窗 -->
    <SuggestModal
      v-model="showSuggest"
      :question-text="suggestText"
      @create-new="handleCreateNew"
      @added="handleAdded"
    />

    <!-- FAQ编辑弹窗（从建议新建） -->
    <FaqEditModal
      v-model="showFaqEdit"
      :faq-code="''"
      :category-tree="store.categoryTree"
      :initial-questions="newQuestionText"
      @saved="handleFaqSaved"
    />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Check } from '@element-plus/icons-vue'
import { useFaqStore } from '@/stores/faq'
import { getUnmatched, getLowConfidence, getChatLogDates, getRecentDates } from '@/api/chatLog'
import { checkQuestions } from '@/api/analysis'
import ExpandCell from '@/components/ExpandCell.vue'
import SuggestModal from '@/components/SuggestModal.vue'
import FaqEditModal from '@/components/FaqEditModal.vue'

const store = useFaqStore()
const subTab = ref('unmatched')

// ===== 表格ref =====
const unmatchedTable = ref(null)
const lowConfTable = ref(null)

// ===== 共享状态 =====
const addedMap = ref({})
const showSuggest = ref(false)
const suggestText = ref('')
const showFaqEdit = ref(false)
const newQuestionText = ref('')

// ===== 批量选择状态 =====
const selectedRows = ref([])
const pageSize = ref(20) // 默认每页20条

// ===== 未匹配问题 =====
const unmatchedDate = ref('')
const unmatchedKeyword = ref('')
const unmatchedItems = ref([])
const unmatchedPage = ref(1)
const unmatchedTotal = ref(0)
const unmatchedTotalPages = ref(1)
const unmatchedDates = ref([])
const unmatchedSort = ref({ field: 'count', order: 'descending' })

async function loadUnmatchedDates() {
  try {
    unmatchedDates.value = await getChatLogDates('unmatched')
  } catch (e) {
    console.error('加载日期失败:', e)
  }
}

async function loadUnmatched() {
  try {
    const data = await getUnmatched({
      page: unmatchedPage.value,
      pageSize: pageSize.value,
      date: unmatchedDate.value || undefined,
      keyword: unmatchedKeyword.value || undefined,
      sortBy: unmatchedSort.value.field,
      sortOrder: unmatchedSort.value.order,
    })
    unmatchedItems.value = data.items || []
    unmatchedTotal.value = data.total || 0
    unmatchedPage.value = data.page || unmatchedPage.value
    unmatchedTotalPages.value = data.totalPages || 1

    // 批量检查已存在
    if (data.items.length > 0) {
      try {
        const texts = data.items.map(it => it.text)
        const checkRes = await checkQuestions(texts)
        addedMap.value = checkRes.results || {}
      } catch { /* ignore */ }
    }
  } catch (e) {
    console.error('加载未匹配问题失败:', e)
  }
}

function handleUnmatchedSort({ prop, order }) {
  if (prop) {
    unmatchedSort.value = { field: prop, order: order || 'descending' }
  }
  unmatchedPage.value = 1
  loadUnmatched()
}

// ===== 低置信度 =====
const lowConfDate = ref('')
const lowConfKeyword = ref('')
const lowConfItems = ref([])
const lowConfPage = ref(1)
const lowConfTotal = ref(0)
const lowConfTotalPages = ref(1)
const lowConfDates = ref([])
const lowConfSort = ref({ field: 'confidence', order: 'ascending' })

async function loadLowConfDates() {
  try {
    lowConfDates.value = await getChatLogDates('low-confidence')
  } catch (e) {
    console.error('加载日期失败:', e)
  }
}

async function loadLowConf() {
  try {
    const data = await getLowConfidence({
      page: lowConfPage.value,
      pageSize: pageSize.value,
      date: lowConfDate.value || undefined,
      keyword: lowConfKeyword.value || undefined,
      sortBy: lowConfSort.value.field,
      sortOrder: lowConfSort.value.order,
    })
    lowConfItems.value = data.items || []
    lowConfTotal.value = data.total || 0
    lowConfPage.value = data.page || lowConfPage.value
    lowConfTotalPages.value = data.totalPages || 1

    // 批量检查已存在
    if (data.items.length > 0) {
      try {
        const texts = data.items.map(it => it.text)
        const checkRes = await checkQuestions(texts)
        addedMap.value = { ...addedMap.value, ...(checkRes.results || {}) }
      } catch { /* ignore */ }
    }
  } catch (e) {
    console.error('加载低置信度问题失败:', e)
  }
}

function handleLowConfSort({ prop, order }) {
  if (prop) {
    lowConfSort.value = { field: prop, order: order || 'ascending' }
  }
  lowConfPage.value = 1
  loadLowConf()
}

// ===== 智能建议 =====
function openSuggest(text) {
  suggestText.value = text
  showSuggest.value = true
}

function handleCreateNew(text) {
  showSuggest.value = false
  newQuestionText.value = text
  showFaqEdit.value = true
}

function handleAdded() {
  // 刷新当前列表
  if (subTab.value === 'unmatched') loadUnmatched()
  else loadLowConf()
}

function handleFaqSaved() {
  store.loadData()
  if (subTab.value === 'unmatched') loadUnmatched()
  else loadLowConf()
}

// ===== Tab切换 =====
function switchTab(tab) {
  subTab.value = tab
  addedMap.value = {}
  // 重置选择状态
  selectedRows.value = []
  if (tab === 'unmatched') loadUnmatched()
  else loadLowConf()
}

// ===== 工具函数 =====
function formatDateLabel(d) {
  const ds = new Date(d.date).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
  return `${ds} (${d.count}条)`
}

function formatDateValue(d) {
  return new Date(d.date).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-')
}

// ===== 忽略功能 =====
async function handleIgnore(text) {
  try {
    const response = await fetch('/api/chat-log/ignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const result = await response.json()
    if (result.success) {
      ElMessage.success(result.message)
      if (subTab.value === 'unmatched') loadUnmatched()
      else loadLowConf()
    }
  } catch (error) {
    ElMessage.error('操作失败: ' + error.message)
  }
}

// ===== 批量选择 =====
// Element Plus内置selection列的选择变化回调
function handleSelectionChange(selection) {
  selectedRows.value = selection
}

// ===== 批量忽略 =====
async function handleBatchIgnore() {
  if (selectedRows.value.length === 0) {
    ElMessage.warning('请先选择要忽略的记录')
    return
  }
  
  let successCount = 0
  for (const row of selectedRows.value) {
    try {
      await handleIgnore(row.text)
      successCount++
    } catch (e) {
      console.error('忽略失败:', row.text, e)
    }
  }
  
  ElMessage.success(`成功忽略 ${successCount} 条记录`)
  // 清空选择状态（Element Plus表格会自动处理）
}

// ===== 分页大小切换 =====
function handlePageSizeChange() {
  unmatchedPage.value = 1
  lowConfPage.value = 1
  if (subTab.value === 'unmatched') loadUnmatched()
  else loadLowConf()
}

onMounted(() => {
  store.loadData()
  loadUnmatchedDates()
  loadLowConfDates()
  loadUnmatched()
})
</script>

<style scoped>
.sub-tab-bar {
  display: flex;
  gap: 0;
  margin-bottom: 20px;
  border-bottom: 2px solid #eee;
}
.sub-tab {
  padding: 10px 20px;
  cursor: pointer;
  font-size: 14px;
  color: #666;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: .2s;
}
.sub-tab:hover { color: #4361ee; }
.sub-tab.active { color: #4361ee; border-bottom-color: #4361ee; font-weight: 600; }
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.batch-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  background: #f5f7fa;
  border-radius: 8px;
  margin-bottom: 16px;
}
.table-wrap {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  overflow: visible; /* 改为visible以支持sticky定位 */
  padding: 16px;
}
.pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  font-size: 13px;
  color: #666;
}

/* 表头固定 + 居中 + 不换行 */
.table-wrap :deep(.el-table__header-wrapper) {
  position: sticky;
  top: 0;
  z-index: 10;
  background: #fff;
}

.table-wrap :deep(.el-table th .cell) {
  text-align: center !important;
  white-space: nowrap !important;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 复选框列居中 */
.table-wrap :deep(.el-table__selection-column .cell) {
  display: flex;
  justify-content: center;
}
</style>
