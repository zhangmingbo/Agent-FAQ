<template>
  <div class="llm-config">
    <div class="page-header">
      <h3>LLM 智能层 · 调用节点与提示词</h3>
    </div>

    <!-- 状态概览 -->
    <div class="status-bar" v-if="config">
      <el-tag :type="config.llmEnabled ? 'success' : 'info'" size="small">
        {{ config.llmEnabled ? '已启用' : '未启用' }}
      </el-tag>
      <span class="status-text">模型：{{ config.llmModel || '-' }} | 接口：{{ config.llmApiUrl || '-' }} | 理解模式：{{ config.nluMode || 'hybrid' }}</span>
    </div>

    <!-- 调用节点配置 -->
    <div class="section">
      <h4 class="section-title">LLM 调用节点</h4>
      <p class="section-desc">每个"要用 LLM 的环节"是一个节点：可独立开关、配置模型（留空=全局模型）、温度、最大 token。保存即生效；关闭的节点自动降级为规则/不调用。</p>
      <div class="nodes-grid">
        <div v-for="m in NODES_META" :key="m.key" class="node-card">
          <h4>{{ m.name }}</h4>
          <p class="node-desc">{{ m.desc }}</p>
          <el-checkbox v-model="nodesForm[m.key].enabled">启用此节点</el-checkbox>
          <div class="node-params">
            <div class="param-field">
              <label>温度</label>
              <el-input-number v-model="nodesForm[m.key].temperature" :min="0" :max="2" :step="0.1" :controls="false" size="small" style="width:80px" />
            </div>
            <div class="param-field">
              <label>最大 token</label>
              <el-input-number v-model="nodesForm[m.key].maxTokens" :min="1" :max="2000" :controls="false" size="small" style="width:80px" />
            </div>
          </div>
          <p class="node-hint">关闭=该环节不调 LLM，自动降级为规则。温度：0=稳定、越高越灵活（建议 0~0.7）。token：单次回复字数上限。</p>
        </div>
      </div>
      <div class="actions">
        <el-button type="primary" size="small" @click="saveNodes" :loading="savingNodes">保存节点配置</el-button>
        <span v-if="nodesMsg" class="save-msg">{{ nodesMsg }}</span>
      </div>
    </div>

    <!-- 提示词清单 -->
    <div class="section">
      <el-table :data="prompts" size="small" style="width:100%" v-loading="loadingPrompts">
        <el-table-column prop="name" label="提示词" width="220" />
        <el-table-column prop="desc" label="用途" min-width="200">
          <template #default="{ row }">
            <span style="font-size:12px;color:#888">{{ row.desc }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.isCustom ? 'success' : 'info'" size="small">
              {{ row.isCustom ? '已自定义' : '默认' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" align="center">
          <template #default="{ row }">
            <el-button size="small" text @click="editPrompt(row)">编辑</el-button>
            <el-button v-if="row.isCustom" size="small" text type="warning" @click="resetPrompt(row)">恢复默认</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="section-desc" style="margin-top:8px">提示词改动保存后立即生效（无需重启）；点"恢复默认"即回退内置模板。</p>
    </div>

    <!-- 提示词编辑弹窗 -->
    <el-dialog v-model="promptEditVisible" :title="promptEditData?.name || ''" width="min(94vw, 900px)">
      <p v-if="promptEditData?.desc" style="font-size:12px;color:#888;margin-bottom:8px">{{ promptEditData.desc }}</p>
      <div v-if="promptEditData?.placeholders?.length" style="font-size:12px;color:#999;margin-bottom:8px">
        可用占位符：<code v-for="(p, i) in promptEditData.placeholders" :key="i">{ {{ p }} }</code>
      </div>
      <el-input v-model="promptEditValue" type="textarea" :rows="9" style="font-family:monospace;font-size:12px" />
      <template #footer>
        <el-button @click="promptEditValue = promptEditData.default">恢复默认</el-button>
        <el-button @click="promptEditVisible = false">取消</el-button>
        <el-button type="primary" @click="savePrompt" :loading="savingPrompt">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { getConfig, saveConfig, getLlmPrompts, saveLlmPrompts } from '@/api/config'
import { ElMessage } from 'element-plus'

const NODES_META = [
  { key: 'trigger', name: '任务触发判定', desc: '规则触发词没命中时，LLM 判断是否口语触发了任务' },
  { key: 'extract', name: '槽位提取', desc: '规则提取不到时，LLM 从口语中抽取槽位（电话/姓名/地址等）' },
  { key: 'dialogue', name: '任务对话', desc: '任务对话轮次由 LLM 驱动（回复 + 提取 + 提问插话）' },
  { key: 'route', name: '意图路由兜底', desc: '任务/FAQ 拿不准时，LLM 三选一（继续 / 新任务 / 咨询）' },
  { key: 'meaningless', name: '无意义检测', desc: '判断闲聊/语气词是否无意义（无意义检测选 llm 模式时）' },
  { key: 'rerank', name: 'FAQ 意图重排', desc: 'FAQ 候选多且分数不高时，LLM 重排选最优' },
]

const config = ref(null)
const nodesForm = reactive({})
const savingNodes = ref(false)
const nodesMsg = ref('')
const prompts = ref([])
const loadingPrompts = ref(false)
const promptEditVisible = ref(false)
const promptEditData = ref(null)
const promptEditValue = ref('')
const savingPrompt = ref(false)

// 初始化节点表单
NODES_META.forEach(m => {
  nodesForm[m.key] = { enabled: true, temperature: 0, maxTokens: 100 }
})

async function loadConfig() {
  try {
    const cfg = await getConfig()
    config.value = cfg
    const nodes = cfg.llmNodes || {}
    NODES_META.forEach(m => {
      const n = nodes[m.key] || {}
      nodesForm[m.key] = {
        enabled: n.enabled !== false,
        temperature: n.temperature ?? 0,
        maxTokens: n.maxTokens ?? 100,
      }
    })
  } catch { /* ignore */ }
}

async function loadPrompts() {
  loadingPrompts.value = true
  try {
    const res = await getLlmPrompts()
    prompts.value = res.data || []
  } finally {
    loadingPrompts.value = false
  }
}

async function saveNodes() {
  savingNodes.value = true
  nodesMsg.value = ''
  try {
    const payload = {}
    NODES_META.forEach(m => {
      payload[m.key] = { ...nodesForm[m.key] }
    })
    const res = await saveConfig({ llmNodes: payload })
    if (res.success) {
      nodesMsg.value = '✓ 已保存并生效'
    } else {
      ElMessage.error('节点配置保存失败：' + (res.message || '未知错误'))
    }
  } finally {
    savingNodes.value = false
  }
}

function editPrompt(row) {
  promptEditData.value = row
  promptEditValue.value = row.value || ''
  promptEditVisible.value = true
}

async function savePrompt() {
  const val = promptEditValue.value.trim()
  savingPrompt.value = true
  try {
    const payload = {}
    payload[promptEditData.value.key] = val
    const res = await saveLlmPrompts(payload)
    if (res.success) {
      ElMessage.success('提示词已保存')
      promptEditVisible.value = false
      await loadPrompts()
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } finally {
    savingPrompt.value = false
  }
}

async function resetPrompt(row) {
  const payload = {}
  payload[row.key] = ''
  const res = await saveLlmPrompts(payload)
  if (res.success) await loadPrompts()
}

onMounted(() => { loadConfig(); loadPrompts() })
</script>

<style scoped>
.llm-config { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.page-header h3 { font-size: 15px; margin: 0 0 16px; }
.status-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
.status-text { font-size: 13px; color: #555; }
.section { margin-top: 24px; }
.section-title { font-size: 14px; color: #4361ee; margin: 0 0 6px; }
.section-desc { font-size: 12px; color: #999; margin-bottom: 12px; }
.nodes-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.node-card { border: 1px solid #e8ecff; border-radius: 8px; padding: 14px; background: #fafbff; }
.node-card h4 { font-size: 13px; margin: 0 0 4px; }
.node-desc { font-size: 12px; color: #888; margin: 0 0 8px; }
.node-params { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.param-field label { font-size: 12px; color: #888; display: block; margin-bottom: 2px; }
.node-hint { font-size: 11px; color: #999; margin: 8px 0 0; line-height: 1.6; }
.actions { margin-top: 14px; display: flex; align-items: center; gap: 10px; }
.save-msg { font-size: 12px; color: #2e7d32; }
</style>
