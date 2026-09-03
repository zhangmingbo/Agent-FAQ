<template>
  <div class="config-panel">
    <h3 style="font-size:15px;margin-bottom:20px">识别参数</h3>

    <el-form label-width="160px" style="max-width:500px">
      <el-form-item label="最低置信度阈值">
        <el-input-number v-model="form.minConfidence" :min="0" :max="1" :step="0.05" :precision="2" style="width:140px" />
        <div class="desc">低于此值视为未匹配，触发兜底回复</div>
      </el-form-item>

      <el-form-item label="追问确认阈值">
        <el-input-number v-model="form.clarifyThreshold" :min="0" :max="1" :step="0.05" :precision="2" style="width:140px" />
        <div class="desc">在此区间内会追问用户确认意图</div>
      </el-form-item>

      <el-form-item label="Top K 结果数">
        <el-input-number v-model="form.topK" :min="1" :max="10" style="width:140px" />
      </el-form-item>

      <el-form-item label="无意义输入检测模式">
        <el-select v-model="form.meaninglessDetectionMode" style="width:220px">
          <el-option label="规则过滤（快速、免费）" value="rule" />
          <el-option label="大模型判断（精准、需配置大模型）" value="llm" />
        </el-select>
        <div class="desc">
          规则模式：用关键词+正则过滤无意义输入，无需大模型<br>
          大模型模式：调用大模型语义判断，更精准但每次判断有成本
        </div>
      </el-form-item>

      <el-form-item label="会话超时时间（分钟）">
        <el-input-number v-model="form.sessionTimeoutMinutes" :min="5" :max="120" style="width:140px" />
        <div class="desc">超过此时间无活动，会话将自动过期</div>
      </el-form-item>

      <el-form-item label="任务取消关键词">
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          <el-tag v-for="(w, idx) in cancelWords" :key="idx" closable size="default" @close="cancelWords.splice(idx, 1)">{{ w }}</el-tag>
          <el-input v-model="newCancelWord" placeholder="输入后回车添加" size="small" style="width:140px" @keyup.enter="addCancelWord" />
        </div>
        <div class="desc">用户说包含这些词的话时，当前任务会被取消。回车添加，点击标签删除</div>
      </el-form-item>

      <el-form-item label="否定句防护词表">
        <div class="desc" style="margin-bottom:6px">否定词（间隔匹配：否定词 + 0~4字 + 业务意图动词 → "不用换滤芯"）</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          <el-tag v-for="(w, idx) in negWords" :key="'n' + idx" closable size="default" @close="negWords.splice(idx, 1)">{{ w }}</el-tag>
          <el-input v-model="newNegWord" placeholder="输入后回车添加" size="small" style="width:140px" @keyup.enter="addWord(negWords, newNegWord, 'newNegWord')" />
        </div>
        <div class="desc" style="margin:8px 0 6px">症状/状态词（紧贴匹配：没 + 症状词 → "没坏/没问题/没必要"）</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          <el-tag v-for="(w, idx) in symWords" :key="'s' + idx" closable size="default" @close="symWords.splice(idx, 1)">{{ w }}</el-tag>
          <el-input v-model="newSymWord" placeholder="输入后回车添加" size="small" style="width:140px" @keyup.enter="addWord(symWords, newSymWord, 'newSymWord')" />
        </div>
        <div class="desc" style="margin:8px 0 6px">业务意图动词（"换/装/修/预约/办理"等）</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          <el-tag v-for="(w, idx) in verbWords" :key="'v' + idx" closable size="default" @close="verbWords.splice(idx, 1)">{{ w }}</el-tag>
          <el-input v-model="newVerbWord" placeholder="输入后回车添加" size="small" style="width:140px" @keyup.enter="addWord(verbWords, newVerbWord, 'newVerbWord')" />
        </div>
        <div class="desc">防止"我没说要换表 / 不用换滤芯"误触发任务。回车添加，点击标签删除</div>
      </el-form-item>

      <el-form-item label="接入渠道管理">
        <div class="desc" style="margin-bottom:8px">配置系统支持的接入渠道，用于区分不同客户来源</div>
        <el-table :data="channelTypes" size="small" style="width:100%" max-height="250">
          <el-table-column label="渠道编码" width="140">
            <template #default="{ row }">
              <el-input v-model="row.value" size="small" placeholder="如: web" />
            </template>
          </el-table-column>
          <el-table-column label="渠道名称" width="160">
            <template #default="{ row }">
              <el-input v-model="row.label" size="small" placeholder="如: 网页" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80" align="center">
            <template #default="{ $index }">
              <el-button type="danger" link size="small" @click="channelTypes.splice($index, 1)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
          <el-input v-model="newChannelValue" size="small" placeholder="编码" style="width:120px" />
          <el-input v-model="newChannelLabel" size="small" placeholder="名称" style="width:120px" />
          <el-button size="small" @click="addChannel">添加渠道</el-button>
        </div>
        <div class="desc">编码用于接口传参（如 web/wechat/mp/app），名称用于后台显示</div>
      </el-form-item>

      <el-form-item>
        <el-button type="primary" @click="handleSave" :loading="saving">保存配置</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { getConfig, saveConfig } from '@/api/config'
import { ElMessage } from 'element-plus'

const form = reactive({
  minConfidence: 0.5,
  clarifyThreshold: 0.65,
  topK: 5,
  meaninglessDetectionMode: 'rule',
  sessionTimeoutMinutes: 30,
})

const saving = ref(false)
const cancelWords = ref([])
const newCancelWord = ref('')
const negWords = ref([])
const symWords = ref([])
const verbWords = ref([])
const newNegWord = ref('')
const newSymWord = ref('')
const newVerbWord = ref('')
const channelTypes = ref([])
const newChannelValue = ref('')
const newChannelLabel = ref('')

function addCancelWord() {
  const w = newCancelWord.value.trim()
  if (w && !cancelWords.value.includes(w)) {
    cancelWords.value.push(w)
  }
  newCancelWord.value = ''
}

function addWord(list, input, inputRef) {
  const w = input.value.trim()
  if (w && !list.value.includes(w)) {
    list.value.push(w)
  }
  input.value = ''
}

function addChannel() {
  const value = newChannelValue.value.trim()
  const label = newChannelLabel.value.trim()
  if (!value) {
    ElMessage.warning('请输入渠道编码')
    return
  }
  if (channelTypes.value.some(c => c.value === value)) {
    ElMessage.warning('该渠道编码已存在')
    return
  }
  channelTypes.value.push({ value, label: label || value })
  newChannelValue.value = ''
  newChannelLabel.value = ''
}

async function loadConfig() {
  try {
    const config = await getConfig()
    if (config.minConfidence != null) form.minConfidence = config.minConfidence
    if (config.clarifyThreshold != null) form.clarifyThreshold = config.clarifyThreshold
    if (config.topK != null) form.topK = config.topK
    if (config.meaninglessDetectionMode) form.meaninglessDetectionMode = config.meaninglessDetectionMode
    if (config.sessionTimeout != null) form.sessionTimeoutMinutes = Math.round(config.sessionTimeout / 60000)
    if (Array.isArray(config.cancelWords)) cancelWords.value = [...config.cancelWords]
    if (config.negationWords) {
      if (Array.isArray(config.negationWords.negWords)) negWords.value = [...config.negationWords.negWords]
      if (Array.isArray(config.negationWords.symptomWords)) symWords.value = [...config.negationWords.symptomWords]
      if (Array.isArray(config.negationWords.intentVerbs)) verbWords.value = [...config.negationWords.intentVerbs]
    }
    if (Array.isArray(config.channelTypes)) channelTypes.value = config.channelTypes.map(c => ({ ...c }))
  } catch (e) {
    console.error('加载配置失败:', e)
  }
}

async function handleSave() {
  saving.value = true
  try {
    const res = await saveConfig({
      minConfidence: form.minConfidence,
      clarifyThreshold: form.clarifyThreshold,
      topK: form.topK,
      meaninglessDetectionMode: form.meaninglessDetectionMode,
      sessionTimeout: form.sessionTimeoutMinutes * 60000,
      cancelWords: cancelWords.value,
      negationWords: { negWords: negWords.value, symptomWords: symWords.value, intentVerbs: verbWords.value },
      channelTypes: channelTypes.value,
    })
    if (res.success) {
      ElMessage.success('配置已保存')
    } else {
      ElMessage.error('保存失败')
    }
  } catch (e) {
    ElMessage.error('保存失败: ' + e.message)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadConfig()
})
</script>

<style scoped>
.config-panel {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  max-width: 600px;
}
.desc {
  font-size: 12px;
  color: #aaa;
  margin-top: 2px;
  line-height: 1.6;
}
</style>
