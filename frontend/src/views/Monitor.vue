<template>
  <div>
    <!-- 子Tab切换 -->
    <div class="sub-tab-bar">
      <div class="sub-tab" :class="{ active: subTab === 'overview' }" @click="switchTab('overview')">概览</div>
      <div class="sub-tab" :class="{ active: subTab === 'recent' }" @click="switchTab('recent')">最近咨询记录</div>
    </div>

    <!-- 概览面板 -->
    <div v-if="subTab === 'overview'">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="font-size:13px;color:#666">
          自动刷新: <span :style="{ color: autoRefresh.enabled.value ? '#10b981' : '#999' }">{{ autoRefresh.enabled.value ? '● 开启' : '○ 已暂停' }}</span> (每5秒)
        </div>
        <el-checkbox v-model="autoRefresh.enabled.value" @change="autoRefresh.toggle">启用</el-checkbox>
      </div>

      <!-- 统计卡片 -->
      <el-row :gutter="16" style="margin-bottom:24px">
        <el-col :span="5"><StatCard label="总请求数" :value="stats.totalRequests || '-'" sub="累计咨询量" /></el-col>
        <el-col :span="5"><StatCard label="今日请求" :value="stats.todayRequests || '-'" sub="今日咨询量" /></el-col>
        <el-col :span="5"><StatCard label="平均置信度" :value="stats.avgConfidence || '-'" sub="意图匹配准确度" /></el-col>
        <el-col :span="5"><StatCard label="直接解答率" :value="directRate" sub="无需追问直接回答" /></el-col>
        <el-col :span="4"><StatCard label="答案覆盖率" :value="(analysisData?.coverage?.answerRate ?? '-') + '%'" sub="有答案的FAQ占比" /></el-col>
      </el-row>

      <!-- 来源分布 + 热门问题 -->
      <el-row :gutter="20" style="margin-top:20px">
        <el-col :span="12">
          <h4 style="font-size:14px;margin-bottom:12px">来源分布</h4>
          <div class="log-list">
            <div v-if="sourceTotal > 0">
              <div class="source-bar">
                <div v-for="s in sourceBars" :key="s.key" class="source-bar-item" :style="{ width: Math.max(s.pct, 5) + '%', background: s.color }" :title="s.label + ': ' + s.count">{{ s.count }}</div>
              </div>
              <div style="margin-top:8px">
                <span v-for="s in sourceBars" :key="s.key" style="margin-right:16px;font-size:12px">
                  <span :style="{ display: 'inline-block', width: '12px', height: '12px', background: s.color, borderRadius: '2px', marginRight: '4px' }"></span>
                  {{ s.label }}: {{ s.count }}
                </span>
              </div>
            </div>
            <div v-else style="color:#aaa;text-align:center;padding:20px">暂无数据</div>
          </div>
        </el-col>
        <el-col :span="12">
          <h4 style="font-size:14px;margin-bottom:12px">热门问题 Top 50</h4>
          <div class="log-list hot-questions-scrollable">
            <div v-if="stats.topIntents?.length">
              <div v-for="(t, i) in stats.topIntents" :key="t.code" class="log-item" style="padding:6px 0;display:flex;justify-content:space-between">
                <span>{{ i + 1 }}. <b>{{ getIntentDisplayName(t.code) }}</b></span>
                <el-tag size="small" :type="isTaskCode(t.code) ? 'warning' : 'primary'">
                  {{ isTaskCode(t.code) ? '任务' : 'FAQ' }} · {{ t.count }} 次
                </el-tag>
              </div>
            </div>
            <div v-else style="color:#aaa;text-align:center;padding:20px">暂无数据</div>
          </div>
        </el-col>
      </el-row>
    </div>

    <!-- 最近咨询记录面板 -->
    <div v-if="subTab === 'recent'">
      <div class="toolbar">
        <el-select v-model="recentDate" placeholder="全部日期" clearable @change="loadRecent" style="width:180px">
          <el-option v-for="d in recentDates" :key="d.date" :label="formatDateLabel(d)" :value="formatDateValue(d)" />
        </el-select>
        <el-input v-model="recentKeyword" placeholder="搜索问题关键词..." clearable style="width:200px" @keyup.enter="loadRecent" />
        <el-button size="small" @click="loadRecent">🔍 搜索</el-button>
        <div style="flex:1"></div>
        <span style="font-size:12px;color:#888">{{ recentStatsText }}</span>
      </div>
      <div class="table-wrap">
        <el-table :data="recentItems" stripe style="width:100%" @sort-change="handleRecentSort">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column prop="userId" label="用户" sortable="custom" width="80">
            <template #default="{ row }">
              <span v-if="row.userId" style="font-size:12px;color:#666">{{ row.userId }}</span>
              <span v-else style="color:#ccc">-</span>
            </template>
          </el-table-column>
          <el-table-column label="用户问题" min-width="200">
            <template #default="{ row }">
              <ExpandCell :text="row.firstQuestion || row.text" :max-length="40" />
            </template>
          </el-table-column>
          <el-table-column label="机器人回答" min-width="250">
            <template #default="{ row }">
              <ExpandCell :text="row.lastAnswer || row.answer || ''" :max-length="50" empty-text="无回答" />
            </template>
          </el-table-column>
          <el-table-column label="消息数" sortable="custom" prop="msgCount" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" type="info">{{ row.msgCount || 1 }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="lastTime" label="最近时间" sortable="custom" width="150" />
        </el-table>
      </div>
      <div class="pagination">
        <span>第 {{ recentPage }}/{{ recentTotalPages }} 页，共 {{ recentTotal }} 条</span>
        <div style="display:flex;gap:6px">
          <el-button size="small" :disabled="recentPage <= 1" @click="recentPage--; loadRecent()">上一页</el-button>
          <el-button size="small" :disabled="recentPage >= recentTotalPages" @click="recentPage++; loadRecent()">下一页</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useFaqStore } from '@/stores/faq'
import { getStats } from '@/api/stats'
import { getRecentRecords, getRecentDates } from '@/api/chatLog'
import { getTasks } from '@/api/task'
import { getAnalysis } from '@/api/analysis'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import StatCard from '@/components/StatCard.vue'
import ExpandCell from '@/components/ExpandCell.vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const store = useFaqStore()
const subTab = ref('overview')

// ===== 概览数据 =====
const stats = ref({})
const analysisData = ref(null)
const taskNameMap = ref(new Map()) // code -> name (任务名称)

const directRate = computed(() => {
  const direct = stats.value.bySource?.direct || 0
  const total = stats.value.totalRequests || 1
  return ((direct / total) * 100).toFixed(1) + '%'
})

const sourceTotal = computed(() => stats.value.totalRequests || 0)

const sourceColors = { direct: '#4361ee', clarify: '#ffc107', fallback: '#6c757d', llm: '#28a745' }
const sourceLabels = { direct: '直接解答', clarify: '追问确认', fallback: '兜底回复', llm: '大模型' }

const sourceBars = computed(() => {
  const bySource = stats.value.bySource || {}
  const total = sourceTotal.value || 1
  return Object.entries(sourceColors).map(([key, color]) => ({
    key, color,
    label: sourceLabels[key],
    count: bySource[key] || 0,
    pct: ((bySource[key] || 0) / total) * 100,
  })).filter(s => s.count > 0)
})

async function loadMonitorData() {
  try {
    const [statsData, tasksRes, analysisRes] = await Promise.all([getStats(), getTasks(), getAnalysis()])
    stats.value = statsData
    analysisData.value = analysisRes
    // 构建任务名称映射
    const tMap = new Map()
    for (const t of (tasksRes.data || [])) tMap.set(t.code, t.name)
    taskNameMap.value = tMap
  } catch (e) {
    console.error('加载监控数据失败:', e)
  }
}

// 热门问题：判断是否为任务编码（支持 task:xxx 前缀）
function isTaskCode(code) {
  const raw = code.startsWith('task:') ? code.slice(5) : code
  return taskNameMap.value.has(raw)
}
// 热门问题：显示名称（优先任务名 > FAQ名 > 去除task:前缀后显示）
function getIntentDisplayName(code) {
  const raw = code.startsWith('task:') ? code.slice(5) : code
  if (taskNameMap.value.has(raw)) return taskNameMap.value.get(raw)
  const faqName = store.getFaqName(code)
  if (faqName !== code) return faqName
  // 未知任务：去掉 task: 前缀，用可读格式显示
  return code.startsWith('task:') ? raw.replace(/_/g, ' ') : code
}

const autoRefresh = useAutoRefresh(loadMonitorData, 5000)

// ===== 最近咨询记录 =====
const recentDate = ref('')
const recentKeyword = ref('')
const recentItems = ref([])
const recentPage = ref(1)
const recentTotal = ref(0)
const recentTotalPages = ref(1)
const recentDates = ref([])
const recentSort = ref({ field: 'time', order: 'descending' })

const recentStatsText = computed(() => `共 ${recentTotal.value} 条咨询记录`)

async function loadRecentDates() {
  try {
    recentDates.value = await getRecentDates()
  } catch (e) {
    console.error('加载日期列表失败:', e)
  }
}

async function loadRecent() {
  try {
    const data = await getRecentRecords({
      page: recentPage.value,
      pageSize: 20,
      date: recentDate.value || undefined,
      keyword: recentKeyword.value || undefined,
      sortBy: recentSort.value.field,
      sortOrder: recentSort.value.order,
    })
    recentItems.value = data.items || []
    recentTotal.value = data.total || 0
    recentPage.value = data.page || recentPage.value
    recentTotalPages.value = data.totalPages || 1
  } catch (e) {
    console.error('加载最近咨询记录失败:', e)
  }
}

function handleRecentSort({ prop, order }) {
  if (prop) {
    recentSort.value = { field: prop, order: order || 'descending' }
  }
  recentPage.value = 1
  loadRecent()
}

function getSourceLabel(source) {
  return sourceLabels[source] || source || '-'
}

function formatDateLabel(d) {
  const ds = new Date(d.date).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
  return `${ds} (${d.count}条)`
}

function formatDateValue(d) {
  return new Date(d.date).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-')
}

function switchTab(tab) {
  subTab.value = tab
  if (tab === 'overview') {
    autoRefresh.stop()
    loadMonitorData()
    autoRefresh.start()
  } else {
    autoRefresh.stop()
    loadRecentDates()
    loadRecent()
  }
}

onMounted(() => {
  store.loadData()
  loadMonitorData()
})

onUnmounted(() => {
  autoRefresh.stop()
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
.rule-stat-card {
  border-radius: 10px;
  padding: 20px;
}
.rule-stat-card .label { font-size: 13px; margin-bottom: 6px; }
.rule-stat-card .value { font-weight: 700; }
.rule-stat-card .sub { font-size: 12px; color: #aaa; margin-top: 4px; }
.rule-chart {
  height: 200px;
  display: flex;
  align-items: end;
  gap: 8px;
  padding: 10px 0;
}
.log-list {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  padding: 16px;
}
.log-item {
  padding: 10px 0;
  border-bottom: 1px solid #f5f5f5;
  font-size: 13px;
}
.log-item:last-child { border-bottom: none; }
.hot-questions-scrollable {
  max-height: 400px;
  overflow-y: auto;
}
.source-bar {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}
.source-bar-item {
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #fff;
  min-width: 30px;
}
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.table-wrap {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  overflow: hidden;
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
</style>
