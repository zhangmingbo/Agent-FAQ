<template>
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div style="font-size:13px;color:#666">基于聊天日志数据，发现知识库优化点</div>
      <div style="display:flex;gap:8px;align-items:center">
        <el-checkbox v-model="autoRefreshEnabled" @change="toggleAutoRefresh">自动刷新 (10秒)</el-checkbox>
        <el-button size="small" type="primary" @click="loadData">🔄 立即刷新</el-button>
      </div>
    </div>

    <!-- 覆盖率概览 -->
    <el-row :gutter="16" style="margin-bottom:20px">
      <el-col :span="6"><StatCard label="FAQ 总数" :value="data?.coverage?.totalFaq || '-'" sub="知识库规模" /></el-col>
      <el-col :span="6"><StatCard label="答案覆盖率" :value="(data?.coverage?.answerRate ?? '-') + '%'" sub="有答案的 FAQ 占比" /></el-col>
      <el-col :span="6"><StatCard label="富媒体率" :value="(data?.coverage?.richRate ?? '-') + '%'" sub="含富媒体的 FAQ 占比" /></el-col>
      <el-col :span="6"><StatCard label="相关推荐率" :value="(data?.coverage?.relatedRate ?? '-') + '%'" sub="含相关推荐的 FAQ 占比" /></el-col>
    </el-row>

    <!-- 7天趋势 -->
    <div class="card">
      <h4 style="font-size:14px;margin-bottom:12px">📅 近 7 天趋势</h4>
      <div v-if="data?.trend?.length" class="trend-chart">
        <div v-for="t in data.trend" :key="t.date" class="trend-item">
          <div style="font-size:11px;color:#666">{{ getMatchRate(t) }}%</div>
          <div class="trend-bar" :style="{ height: getBarHeight(t) + 'px' }"></div>
          <div style="font-size:11px;color:#999">{{ t.total }}</div>
          <div style="font-size:11px;color:#aaa;margin-top:2px">{{ formatTrendDate(t.date) }}</div>
        </div>
      </div>
      <div v-else style="color:#aaa;padding:20px;text-align:center">近 7 天暂无数据</div>
    </div>

    <!-- 高频问题 + 相似问不足 -->
    <el-row :gutter="20" style="margin-top:20px">
      <el-col :span="12">
        <div class="card">
          <h4 style="font-size:14px;margin-bottom:12px">🔥 高频问题 Top 10</h4>
          <div style="max-height:300px;overflow-y:auto">
            <div v-if="data?.topQuestions?.length">
              <div v-for="(t, i) in data.topQuestions.slice(0, 10)" :key="t.text" class="log-item">
                <div>
                  <div style="font-size:13px">{{ i + 1 }}. {{ t.text }}</div>
                  <div style="font-size:11px;color:#aaa">{{ store.getFaqName(t.intent) }} · 平均置信度 {{ (t.avgConfidence * 100).toFixed(0) }}%</div>
                </div>
                <el-tag size="small" type="primary">{{ t.count }} 次</el-tag>
              </div>
            </div>
            <div v-else style="color:#aaa;text-align:center;padding:20px">暂无数据</div>
          </div>
        </div>
      </el-col>
      <el-col :span="12">
        <div class="card">
          <h4 style="font-size:14px;margin-bottom:12px">📝 相似问不足 <span style="color:#f59e0b;font-size:12px">（少于 5 条）</span></h4>
          <div style="max-height:300px;overflow-y:auto">
            <div v-if="data?.coverage?.lowQuestionFaqs?.length">
              <div v-for="q in data.coverage.lowQuestionFaqs" :key="q.code" class="log-item" style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:13px">{{ q.name || q.code }}</span>
                <el-tag size="small" type="warning">仅 {{ q.count }} 条相似问</el-tag>
              </div>
            </div>
            <div v-else style="color:#aaa;text-align:center;padding:20px">所有 FAQ 相似问均充足 ✅</div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useFaqStore } from '@/stores/faq'
import { getAnalysis } from '@/api/analysis'
import StatCard from '@/components/StatCard.vue'

const store = useFaqStore()
const data = ref(null)
const autoRefreshEnabled = ref(true)
let refreshTimer = null

async function loadData() {
  try {
    data.value = await getAnalysis()
  } catch (e) {
    console.error('加载分析数据失败:', e)
  }
}

function toggleAutoRefresh(val) {
  stopAutoRefresh()
  if (val) startAutoRefresh()
}

function startAutoRefresh() {
  stopAutoRefresh()
  refreshTimer = setInterval(loadData, 10000)
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

function getMatchRate(t) {
  return t.total > 0 ? ((t.matched / t.total) * 100).toFixed(0) : 0
}

function getBarHeight(t) {
  if (!data.value?.trend?.length) return 4
  const maxTotal = Math.max(...data.value.trend.map(x => x.total), 1)
  return Math.max((t.total / maxTotal) * 80, 4)
}

function formatTrendDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

onMounted(() => {
  store.loadData()
  loadData()
  if (autoRefreshEnabled.value) startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>

<style scoped>
.card {
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08);
}
.trend-chart {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 8px;
  text-align: center;
}
.trend-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.trend-bar {
  background: linear-gradient(to top, #10b981, #34d399);
  border-radius: 4px;
  margin: 4px auto;
  width: 80%;
  transition: height 0.3s;
}
.log-item {
  padding: 6px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #f5f5f5;
}
.log-item:last-child { border-bottom: none; }
</style>
