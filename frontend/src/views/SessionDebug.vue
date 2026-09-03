<template>
  <div class="session-debug">
    <!-- 左侧会话列表 -->
    <div class="sidebar">
      <div class="sidebar-header">
        <el-input
          v-model="searchKeyword"
          placeholder="搜索 Session ID..."
          clearable
          size="small"
          @input="handleSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <div class="sidebar-actions">
          <el-button size="small" @click="loadSessionList" :icon="Refresh">刷新</el-button>
          <el-popconfirm
            title="确定清空所有会话轨迹吗？"
            confirm-button-text="确定"
            cancel-button-text="取消"
            @confirm="handleClearAll"
          >
            <el-button size="small" type="danger" plain>清空</el-button>
          </el-popconfirm>
        </div>
      </div>

      <div class="session-list">
        <div
          v-for="session in filteredSessions"
          :key="session.sessionId"
          class="session-item"
          :class="{ active: selectedSessionId === session.sessionId }"
          @click="selectSession(session.sessionId)"
        >
          <div class="session-id">{{ session.sessionId }}</div>
          <div class="session-meta">
            <span class="turns">{{ session.turns }} 轮</span>
            <span class="time">{{ formatTime(session.lastActive) }}</span>
          </div>
          <div class="session-preview" v-if="session.lastInput">
            {{ truncate(session.lastInput, 30) }}
          </div>
        </div>
        <div v-if="filteredSessions.length === 0" class="empty-state">
          <p>暂无会话数据</p>
          <p style="font-size:12px;color:#999;margin-top:8px">请先在聊天窗口进行对话</p>
        </div>
      </div>
    </div>

    <!-- 右侧详情区域 -->
    <div class="main-content">
      <el-tabs v-model="activeTab" class="debug-tabs">
        <!-- Tab 1: 会话详情 -->
        <el-tab-pane label="会话详情" name="trace">
          <div v-if="!selectedSessionId" class="empty-hint">
            <el-empty description="请从左侧选择一个会话查看详情" />
          </div>
          <div v-else-if="loadingTrace" class="loading-hint">
            <el-skeleton :rows="5" animated />
          </div>
          <div v-else-if="sessionTrace.turns.length === 0" class="empty-hint">
            <el-empty description="该会话暂无轨迹数据" />
          </div>
          <div v-else class="trace-viewer">
            <div class="trace-header">
              <h3>Session: {{ sessionTrace.sessionId }}</h3>
              <el-tag type="info">{{ sessionTrace.turns.length }} 轮对话</el-tag>
            </div>
            <el-timeline>
              <el-timeline-item
                v-for="(turn, index) in sessionTrace.turns"
                :key="index"
                :timestamp="formatDateTime(turn.startedAt)"
                placement="top"
              >
                <div class="turn-card">
                  <div class="turn-header">
                    <span class="turn-number">第 {{ index + 1 }} 轮</span>
                    <span class="turn-duration">{{ turn.duration }}ms</span>
                  </div>
                  
                  <!-- 用户输入 -->
                  <div class="turn-input">
                    <el-tag size="small" type="primary">用户</el-tag>
                    <span class="text">{{ turn.input || '(空)' }}</span>
                  </div>

                  <!-- 处理步骤 -->
                  <div class="turn-steps" v-if="turn.steps && turn.steps.length > 0">
                    <div
                      v-for="(step, stepIndex) in turn.steps"
                      :key="stepIndex"
                      class="step-item"
                      :class="`level-${step.level}`"
                    >
                      <el-tag size="small" :type="getLevelTagType(step.level)">
                        {{ getLevelLabel(step.level) }}
                      </el-tag>
                      <span class="step-name">{{ step.step }}</span>
                      <el-collapse v-if="step.detail && Object.keys(step.detail).length > 0">
                        <el-collapse-item title="查看详情">
                          <pre class="detail-json">{{ JSON.stringify(step.detail, null, 2) }}</pre>
                        </el-collapse-item>
                      </el-collapse>
                    </div>
                  </div>

                  <!-- 机器人回复 -->
                  <div class="turn-output">
                    <el-tag size="small" type="success">机器人</el-tag>
                    <span class="text">{{ turn.output || '(无回复)' }}</span>
                  </div>
                </div>
              </el-timeline-item>
            </el-timeline>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Refresh } from '@element-plus/icons-vue'
import {
  getSessionList,
  getSessionTrace,
  clearAllTraces
} from '@/api/debug'

// ===== 状态管理 =====
const sessions = ref([])
const searchKeyword = ref('')
const selectedSessionId = ref(null)
const sessionTrace = ref({ sessionId: '', turns: [] })
const loadingTrace = ref(false)

const activeTab = ref('trace')

// ===== 计算属性 =====
const filteredSessions = computed(() => {
  if (!searchKeyword.value) return sessions.value
  const keyword = searchKeyword.value.toLowerCase()
  return sessions.value.filter(s =>
    s.sessionId.toLowerCase().includes(keyword)
  )
})

// ===== 方法 =====

// 加载会话列表
async function loadSessionList() {
  try {
    const res = await getSessionList(50)
    sessions.value = res.data?.data || []
  } catch (err) {
    ElMessage.error('加载会话列表失败: ' + err.message)
  }
}

// 选择会话
async function selectSession(sessionId) {
  selectedSessionId.value = sessionId
  loadingTrace.value = true
  
  try {
    const res = await getSessionTrace(sessionId)
    sessionTrace.value = res.data?.data || { sessionId, turns: [] }
  } catch (err) {
    ElMessage.error('加载会话轨迹失败: ' + err.message)
    sessionTrace.value = { sessionId, turns: [] }
  } finally {
    loadingTrace.value = false
  }
}

// 清空所有轨迹
async function handleClearAll() {
  try {
    await clearAllTraces()
    ElMessage.success('已清空所有会话轨迹')
    loadSessionList()
    if (selectedSessionId.value) {
      sessionTrace.value = { sessionId: selectedSessionId.value, turns: [] }
    }
  } catch (err) {
    ElMessage.error('清空失败: ' + err.message)
  }
}

// 搜索处理（防抖）
let searchTimer = null
function handleSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    // 搜索已在computed中处理，这里无需额外操作
  }, 300)
}

// ===== 工具函数 =====

function formatTime(timestamp) {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now - date
  
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatDateTime(timestamp) {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function truncate(text, maxLength) {
  if (!text) return ''
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text
}

function getLevelTagType(level) {
  const map = {
    info: '',
    warn: 'warning',
    error: 'danger',
    llm: '',
    rule: 'success',
    task: 'info'
  }
  return map[level] || ''
}

function getLevelLabel(level) {
  const map = {
    info: '信息',
    warn: '警告',
    error: '错误',
    llm: 'LLM',
    rule: '规则',
    task: '任务'
  }
  return map[level] || level
}

// ===== 生命周期 =====
onMounted(() => {
  loadSessionList()
})
</script>

<style scoped>
.session-debug {
  display: flex;
  height: calc(100vh - 120px);
  gap: 16px;
}

/* 左侧边栏 */
.sidebar {
  width: 320px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  padding: 12px;
  border-bottom: 1px solid #eee;
}

.sidebar-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.session-item {
  padding: 12px;
  margin-bottom: 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid transparent;
}

.session-item:hover {
  background: #f5f7fa;
}

.session-item.active {
  background: #ecf5ff;
  border-color: #409eff;
}

.session-id {
  font-family: monospace;
  font-size: 13px;
  font-weight: 600;
  color: #333;
  margin-bottom: 4px;
}

.session-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #999;
  margin-bottom: 4px;
}

.session-preview {
  font-size: 12px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: #999;
}

/* 右侧主内容 */
.main-content {
  flex: 1;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.debug-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.debug-tabs :deep(.el-tabs__header) {
  flex-shrink: 0;
  margin-bottom: 0;
}

.debug-tabs :deep(.el-tabs__content) {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  min-height: 0;
}

.empty-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.loading-hint {
  padding: 20px;
}

/* 轨迹查看器 */
.trace-viewer {
  max-width: 900px;
}

.trace-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 2px solid #eee;
}

.trace-header h3 {
  margin: 0;
  font-size: 16px;
  color: #333;
}

.turn-card {
  background: #fafafa;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}

.turn-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px dashed #ddd;
}

.turn-number {
  font-weight: 600;
  color: #333;
}

.turn-duration {
  font-size: 12px;
  color: #999;
}

.turn-input,
.turn-output {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px;
  background: #fff;
  border-radius: 4px;
}

.turn-input .text,
.turn-output .text {
  flex: 1;
  font-size: 14px;
  line-height: 1.6;
  color: #333;
}

.turn-steps {
  margin: 12px 0;
  padding-left: 8px;
}

.step-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  margin-bottom: 6px;
  background: #fff;
  border-radius: 4px;
  border-left: 3px solid #ddd;
}

.step-item.level-info {
  border-left-color: #409eff;
}

.step-item.level-warn {
  border-left-color: #e6a23c;
}

.step-item.level-error {
  border-left-color: #f56c6c;
}

.step-item.level-llm {
  border-left-color: #9c27b0;
  background: #f3e5f5;
}

.step-item.level-rule {
  border-left-color: #67c23a;
}

.step-item.level-task {
  border-left-color: #00bcd4;
}

.step-name {
  flex: 1;
  font-size: 13px;
  color: #333;
}

.detail-json {
  margin: 0;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  max-height: 300px;
}
</style>
