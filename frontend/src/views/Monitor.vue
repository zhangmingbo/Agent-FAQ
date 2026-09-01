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
        <el-col :span="6"><StatCard label="总请求数" :value="stats.totalRequests || '-'" sub="累计咨询量" /></el-col>
        <el-col :span="6"><StatCard label="今日请求" :value="stats.todayRequests || '-'" sub="今日咨询量" /></el-col>
        <el-col :span="6"><StatCard label="平均置信度" :value="stats.avgConfidence || '-'" sub="意图匹配准确度" /></el-col>
        <el-col :span="6"><StatCard label="直接解答率" :value="directRate" sub="无需追问直接回答" /></el-col>
      </el-row>

      <!-- 规则命中率 -->
      <div style="margin-top:24px">
        <h4 style="font-size:14px;margin-bottom:12px">📊 规则命中率趋势（Phase 2）</h4>
        <el-row :gutter="16" style="margin-bottom:16px">
          <el-col :span="8">
            <div class="rule-stat-card" style="background:#f0fdf4;border:1px solid #86efac">
              <div class="label" style="color:#166534">确认词命中率</div>
              <div class="value" style="color:#166534;font-size:24px">{{ ruleStats.confirmRate ?? '-' }}%</div>
              <div class="sub">用户回复确认词的比例</div>
            </div>
          </el-col>
          <el-col :span="8">
            <div class="rule-stat-card" style="background:#fef2f2;border:1px solid #fca5a5">
              <div class="label" style="color:#991b1b">否认词命中率</div>
              <div class="value" style="color:#991b1b;font-size:24px">{{ ruleStats.denyRate ?? '-' }}%</div>
              <div class="sub">用户回复否认词的比例</div>
            </div>
          </el-col>
          <el-col :span="8">
            <div class="rule-stat-card" style="background:#fffbeb;border:1px solid #fcd34d">
              <div class="label" style="color:#92400e">无意义输入率</div>
              <div class="value" style="color:#92400e;font-size:24px">{{ ruleStats.meaninglessRate ?? '-' }}%</div>
              <div class="sub">被过滤的无意义输入比例</div>
            </div>
          </el-col>
        </el-row>
        <div style="background:#fff;padding:16px;border-radius:8px;border:1px solid #eee">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="font-size:13px;color:#666">总检查次数: <strong>{{ ruleStats.totalChecks?.toLocaleString() || 0 }}</strong></div>
            <el-button size="small" @click="handleResetRuleStats">重置统计</el-button>
          </div>
          <div class="rule-chart">
            <div v-for="bar in ruleChartBars" :key="bar.label" style="flex:1;display:flex;flex-direction:column;align-items:center">
              <div :style="{ height: bar.height + 'px', background: bar.color, borderRadius: '4px 4px 0 0', width: '60px', transition: 'height 0.3s' }"></div>
              <div style="margin-top:8px;font-size:12px;color:#333">{{ bar.value }}</div>
            </div>
          </div>
          <div style="display:flex;justify-content:space-around;margin-top:8px;font-size:12px;color:#666">
            <span>🟢 确认命中</span>
            <span>🔴 否认命中</span>
            <span>🟡 无意义命中</span>
          </div>
        </div>
      </div>

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
          <h4 style="font-size:14px;margin-bottom:12px">热门问题 Top 10</h4>
          <div class="log-list">
            <div v-if="stats.topIntents?.length">
              <div v-for="(t, i) in stats.topIntents" :key="t.code" class="log-item" style="padding:6px 0;display:flex;justify-content:space-between">
                <span>{{ i + 1 }}. <b>{{ store.getFaqName(t.code) }}</b></span>
                <el-tag size="small" type="primary">{{ t.count }} 次</el-tag>
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
              <ExpandCell :text="row.text" :max-length="40" />
            </template>
          </el-table-column>
          <el-table-column label="机器人回答" min-width="250">
            <template #default="{ row }">
              <ExpandCell :text="row.answer || ''" :max-length="50" empty-text="无回答" />
            </template>
          </el-table-column>
          <el-table-column prop="intent" label="匹配意图" sortable="custom" width="120">
            <template #default="{ row }">
              <span v-if="row.intent">{{ store.getFaqName(row.intent) }}</span>
              <span v-else style="color:#aaa">未匹配</span>
            </template>
          </el-table-column>
          <el-table-column prop="confidence" label="置信度" sortable="custom" width="90" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.confidence" size="small" :type="row.confidence >= 0.65 ? 'primary' : 'warning'">{{ (row.confidence * 100).toFixed(1) }}%</el-tag>
              <span v-else style="color:#aaa">-</span>
            </template>
          </el-table-column>
          <el-table-column prop="source" label="来源" sortable="custom" width="100">
            <template #default="{ row }">
              <el-tag size="small" type="primary">{{ getSourceLabel(row.source) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="time" label="时间" sortable="custom" width="150" />
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
import { getRuleStats, resetRuleStats } from '@/api/dialogueRules'
import { getRecentRecords, getRecentDates } from '@/api/chatLog'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import StatCard from '@/components/StatCard.vue'
import ExpandCell from '@/components/ExpandCell.vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const store = useFaqStore()
const subTab = ref('overview')

// ===== 概览数据 =====
const stats = ref({})
const ruleStats = ref({})

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

const ruleChartBars = computed(() => {
  const maxVal = Math.max(ruleStats.value.confirmHits || 0, ruleStats.value.denyHits || 0, ruleStats.value.meaninglessHits || 0, 1)
  return [
    { label: '确认', value: ruleStats.value.confirmHits || 0, height: Math.round(((ruleStats.value.confirmHits || 0) / maxVal) * 160), color: '#10b981' },
    { label: '否认', value: ruleStats.value.denyHits || 0, height: Math.round(((ruleStats.value.denyHits || 0) / maxVal) * 160), color: '#ef4444' },
    { label: '无意义', value: ruleStats.value.meaninglessHits || 0, height: Math.round(((ruleStats.value.meaninglessHits || 0) / maxVal) * 160), color: '#f59e0b' },
  ]
})

async function loadMonitorData() {
  try {
    const [statsData, ruleData] = await Promise.all([getStats(), getRuleStats()])
    stats.value = statsData
    ruleStats.value = ruleData
  } catch (e) {
    console.error('加载监控数据失败:', e)
  }
}

async function handleResetRuleStats() {
  try {
    await ElMessageBox.confirm('确定要重置规则命中率统计吗？', '确认', { type: 'warning' })
    const res = await resetRuleStats()
    if (res.success) {
      ElMessage.success('统计数据已重置')
      ruleStats.value = await getRuleStats()
    } else {
      ElMessage.error('重置失败: ' + res.message)
    }
  } catch { /* cancelled */ }
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
