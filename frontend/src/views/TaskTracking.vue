<template>
  <div>
    <!-- 统计卡片 -->
    <div class="stat-row">
      <StatCard label="进行中" :value="stats.active" sub="收集中/确认中/执行中/挂起" class="stat-active" />
      <StatCard label="已完成" :value="stats.done" class="stat-done" />
      <StatCard label="已取消" :value="stats.cancelled" class="stat-cancelled" />
      <StatCard label="今日触发" :value="stats.todayTotal" class="stat-today" />
    </div>

    <!-- 筛选栏 -->
    <div class="toolbar">
      <el-select v-model="filter.status" placeholder="全部状态" clearable style="width:140px" @change="reload">
        <el-option label="进行中" value="active" />
        <el-option label="收集中" value="collecting" />
        <el-option label="确认中" value="confirming" />
        <el-option label="执行中" value="executing" />
        <el-option label="挂起" value="suspended" />
        <el-option label="已完成" value="done" />
        <el-option label="已取消" value="cancelled" />
        <el-option label="已转人工" value="transferred" />
      </el-select>
      <el-select v-model="filter.taskCode" placeholder="全部任务" clearable style="width:160px" @change="reload">
        <el-option v-for="t in taskList" :key="t.code" :label="t.name" :value="t.code" />
      </el-select>
      <el-date-picker
        v-model="filter.date"
        type="date"
        placeholder="选择日期"
        format="YYYY-MM-DD"
        value-format="YYYY-MM-DD"
        clearable
        style="width:150px"
        @change="reload"
      />
      <el-input v-model="filter.keyword" placeholder="搜索触发原文/任务名/会话ID..." clearable style="width:240px" @keyup.enter="reload" />
      <el-button size="small" @click="reload">搜索</el-button>
      <div style="flex:1"></div>
      <span style="font-size:12px;color:#888">共 {{ total }} 条记录</span>
    </div>

    <!-- 表格 -->
    <div class="table-wrap">
      <el-table :data="items" stripe style="width:100%" v-loading="loading">
        <el-table-column type="index" label="#" width="50" />
        <el-table-column label="任务名称" width="12%">
          <template #default="{ row }">
            <span class="task-name">{{ row.task_name }}</span>
            <div class="task-code">{{ row.task_code }}</div>
          </template>
        </el-table-column>
        <el-table-column label="触发原文" min-width="18%">
          <template #default="{ row }">
            <ExpandCell :text="row.trigger_text || '-'" :max-length="50" />
          </template>
        </el-table-column>
        <el-table-column label="状态" width="9%" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small" effect="light">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="当前步骤" width="12%">
          <template #default="{ row }">
            <span>{{ row.current_step || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="轮次" width="6%" align="center">
          <template #default="{ row }">
            <span>{{ row.turn_count }}</span>
          </template>
        </el-table-column>
        <el-table-column label="会话ID" width="14%">
          <template #default="{ row }">
            <span class="session-id" :title="row.session_id">{{ row.session_id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="开始时间" width="14%" prop="started_at" />
        <el-table-column label="操作" width="8%" align="center">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 分页 -->
    <div class="pagination">
      <span>第 {{ page }}/{{ totalPages }} 页，共 {{ total }} 条</span>
      <div style="display:flex;gap:6px">
        <el-button size="small" :disabled="page <= 1" @click="page--; loadData()">上一页</el-button>
        <el-button size="small" :disabled="page >= totalPages" @click="page++; loadData()">下一页</el-button>
      </div>
    </div>

    <!-- 详情弹窗 -->
    <el-dialog v-model="showDetail" title="任务实例详情" width="600px" destroy-on-close>
      <div v-if="detail" class="detail-content">
        <div class="detail-section">
          <h4>基本信息</h4>
          <div class="detail-grid">
            <div class="detail-item"><span class="label">任务名称</span><span>{{ detail.task_name }} ({{ detail.task_code }})</span></div>
            <div class="detail-item"><span class="label">状态</span>
              <el-tag :type="statusTagType(detail.status)" size="small">{{ statusLabel(detail.status) }}</el-tag>
            </div>
            <div class="detail-item"><span class="label">会话ID</span><span class="session-id">{{ detail.session_id }}</span></div>
            <div class="detail-item"><span class="label">用户ID</span><span>{{ detail.user_id || '-' }}</span></div>
            <div class="detail-item"><span class="label">触发原文</span><span>{{ detail.trigger_text || '-' }}</span></div>
            <div class="detail-item"><span class="label">当前步骤</span><span>{{ detail.current_step || '-' }}</span></div>
            <div class="detail-item"><span class="label">对话轮次</span><span>{{ detail.turn_count }}</span></div>
            <div class="detail-item"><span class="label">开始时间</span><span>{{ detail.started_at }}</span></div>
            <div class="detail-item"><span class="label">最后更新</span><span>{{ detail.updated_at }}</span></div>
            <div class="detail-item" v-if="detail.finished_at"><span class="label">结束时间</span><span>{{ detail.finished_at }}</span></div>
          </div>
        </div>

        <div class="detail-section" v-if="detail.slots && Object.keys(detail.slots).length > 0">
          <h4>槽位信息</h4>
          <el-table :data="slotRows" stripe size="small" style="width:100%">
            <el-table-column prop="key" label="字段" width="100" />
            <el-table-column prop="label" label="标签" width="120" />
            <el-table-column label="值" min-width="150">
              <template #default="{ row }">
                <span :class="{ 'slot-empty': !row.filled }">{{ row.filled ? row.value : '(未填写)' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="80" align="center">
              <template #default="{ row }">
                <el-tag :type="row.filled ? 'success' : 'info'" size="small">{{ row.filled ? '已填' : '待填' }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import StatCard from '@/components/StatCard.vue'
import ExpandCell from '@/components/ExpandCell.vue'
import { getTaskInstances, getTaskInstanceStats, getTaskInstanceDetail } from '@/api/taskInstance'

// 任务列表（从任务定义 API 加载，供筛选下拉）
const taskList = ref([])

async function loadTaskList() {
  try {
    const res = await fetch('/api/tasks').then(r => r.json())
    if (res.success) taskList.value = res.data || []
  } catch { /* ignore */ }
}

// 统计
const stats = ref({ active: 0, done: 0, cancelled: 0, todayTotal: 0 })

async function loadStats() {
  try {
    const res = await getTaskInstanceStats()
    if (res.success) stats.value = res.data
  } catch (e) {
    console.error('加载统计失败:', e)
  }
}

// 列表
const filter = ref({ status: '', taskCode: '', date: '', keyword: '' })
const items = ref([])
const page = ref(1)
const total = ref(0)
const totalPages = ref(1)
const loading = ref(false)

async function loadData() {
  loading.value = true
  try {
    const res = await getTaskInstances({
      status: filter.value.status || undefined,
      taskCode: filter.value.taskCode || undefined,
      date: filter.value.date || undefined,
      keyword: filter.value.keyword || undefined,
      page: page.value,
      pageSize: 20,
    })
    if (res.success) {
      items.value = res.data.items || []
      total.value = res.data.total || 0
      totalPages.value = res.data.totalPages || 1
      page.value = res.data.page || page.value
    }
  } catch (e) {
    console.error('加载列表失败:', e)
  } finally {
    loading.value = false
  }
}

function reload() {
  page.value = 1
  loadData()
  loadStats()
}

// 详情
const showDetail = ref(false)
const detail = ref(null)

const slotRows = computed(() => {
  if (!detail.value?.slots) return []
  return Object.entries(detail.value.slots).map(([key, s]) => ({
    key,
    label: s.label || key,
    value: s.value ?? '-',
    filled: !!s.filled,
  }))
})

async function openDetail(row) {
  try {
    const res = await getTaskInstanceDetail(row.id)
    if (res.success) {
      detail.value = res.data
      showDetail.value = true
    }
  } catch (e) {
    console.error('加载详情失败:', e)
  }
}

// 状态显示
const STATUS_MAP = {
  collecting: { label: '收集中', type: 'primary' },
  confirming: { label: '确认中', type: 'warning' },
  executing: { label: '执行中', type: '' },
  suspended: { label: '挂起', type: 'info' },
  done: { label: '已完成', type: 'success' },
  cancelled: { label: '已取消', type: 'danger' },
  transferred: { label: '已转人工', type: 'warning' },
}

function statusLabel(status) {
  return STATUS_MAP[status]?.label || status
}

function statusTagType(status) {
  return STATUS_MAP[status]?.type || 'info'
}

onMounted(() => {
  loadTaskList()
  loadStats()
  loadData()
})
</script>

<style scoped>
.stat-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}
.stat-active { border-left: 4px solid #4361ee; }
.stat-done { border-left: 4px solid #2ecc71; }
.stat-cancelled { border-left: 4px solid #e74c3c; }
.stat-today { border-left: 4px solid #f39c12; }

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

.task-name {
  font-weight: 500;
  color: #333;
}
.task-code {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
}

.session-id {
  font-family: monospace;
  font-size: 12px;
  color: #888;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
  display: inline-block;
}

.pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  font-size: 13px;
  color: #666;
}

/* 详情弹窗 */
.detail-content {
  max-height: 60vh;
  overflow-y: auto;
}
.detail-section {
  margin-bottom: 20px;
}
.detail-section h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: #333;
  border-bottom: 1px solid #eee;
  padding-bottom: 8px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.detail-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.detail-item .label {
  font-size: 12px;
  color: #999;
}
.slot-empty {
  color: #ccc;
  font-style: italic;
}
</style>
