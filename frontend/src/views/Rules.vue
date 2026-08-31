<template>
  <div class="config-panel">
    <h3 style="font-size:15px;margin-bottom:20px">对话规则配置（v2.0 - 支持正则表达式）</h3>

    <!-- 确认词规则 -->
    <div class="rule-section">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:600">追问确认词规则</span>
        <el-button size="small" @click="addRule('confirmWords')">+ 添加</el-button>
      </div>
      <div style="font-size:12px;color:#888;margin-bottom:8px">用户回复这些词时视为确认意图。支持正则，权重0.0-1.0</div>
      <div class="rule-table-wrap">
        <el-table :data="rules.confirmWords" size="small" style="width:100%">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column label="模式" min-width="55%">
            <template #default="{ row }">
              <el-input v-model="row.pattern" size="small" placeholder="输入模式..." />
            </template>
          </el-table-column>
          <el-table-column label="正则" width="8%" align="center">
            <template #default="{ row }">
              <el-checkbox v-model="row.isRegex" />
            </template>
          </el-table-column>
          <el-table-column label="权重" width="12%" align="center">
            <template #default="{ row }">
              <el-input-number v-model="row.weight" size="small" :min="0" :max="1" :step="0.1" :controls="false" style="width:60px" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="10%" align="center">
            <template #default="{ $index }">
              <el-button size="small" type="danger" text @click="removeRule('confirmWords', $index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- 否认词规则 -->
    <div class="rule-section">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:600">追问否认词规则</span>
        <el-button size="small" @click="addRule('denyWords')">+ 添加</el-button>
      </div>
      <div style="font-size:12px;color:#888;margin-bottom:8px">用户回复这些词时视为否认意图。支持正则，权重0.0-1.0</div>
      <div class="rule-table-wrap">
        <el-table :data="rules.denyWords" size="small" style="width:100%">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column label="模式" min-width="55%">
            <template #default="{ row }">
              <el-input v-model="row.pattern" size="small" placeholder="输入模式..." />
            </template>
          </el-table-column>
          <el-table-column label="正则" width="8%" align="center">
            <template #default="{ row }">
              <el-checkbox v-model="row.isRegex" />
            </template>
          </el-table-column>
          <el-table-column label="权重" width="12%" align="center">
            <template #default="{ row }">
              <el-input-number v-model="row.weight" size="small" :min="0" :max="1" :step="0.1" :controls="false" style="width:60px" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="10%" align="center">
            <template #default="{ $index }">
              <el-button size="small" type="danger" text @click="removeRule('denyWords', $index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- 无意义词规则 -->
    <div class="rule-section">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:600">无意义输入规则</span>
        <el-button size="small" @click="addRule('meaninglessWords')">+ 添加</el-button>
      </div>
      <div style="font-size:12px;color:#888;margin-bottom:8px">标记为无意义的输入。建议用正则匹配重复字符、纯标点等</div>
      <div class="rule-table-wrap">
        <el-table :data="rules.meaninglessWords" size="small" style="width:100%">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column label="模式" min-width="55%">
            <template #default="{ row }">
              <el-input v-model="row.pattern" size="small" placeholder="输入模式..." />
            </template>
          </el-table-column>
          <el-table-column label="正则" width="8%" align="center">
            <template #default="{ row }">
              <el-checkbox v-model="row.isRegex" />
            </template>
          </el-table-column>
          <el-table-column label="权重" width="12%" align="center">
            <template #default="{ row }">
              <el-input-number v-model="row.weight" size="small" :min="0" :max="1" :step="0.1" :controls="false" style="width:60px" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="10%" align="center">
            <template #default="{ $index }">
              <el-button size="small" type="danger" text @click="removeRule('meaninglessWords', $index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div style="display:flex;gap:12px;margin-top:16px">
      <el-button type="primary" @click="handleSave" :loading="saving">保存规则配置</el-button>
      <el-button @click="handleReset">重置为默认</el-button>
      <el-button @click="handleExport">导出配置</el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import {
  getDialogueRules, saveDialogueRules, resetDialogueRules, exportDialogueRules
} from '@/api/dialogueRules'
import { ElMessage, ElMessageBox } from 'element-plus'

const rules = reactive({
  confirmWords: [],
  denyWords: [],
  meaninglessWords: [],
})

const saving = ref(false)

function normalizeRule(rule) {
  if (typeof rule === 'string') {
    return { pattern: rule, isRegex: false, weight: 1.0 }
  }
  return { pattern: rule.pattern || '', isRegex: rule.isRegex || false, weight: rule.weight ?? 1.0 }
}

async function loadRules() {
  try {
    const data = await getDialogueRules()
    rules.confirmWords = (data.confirmWords || []).map(normalizeRule)
    rules.denyWords = (data.denyWords || []).map(normalizeRule)
    rules.meaninglessWords = (data.meaninglessWords || []).map(normalizeRule)
  } catch (e) {
    console.error('加载规则失败:', e)
  }
}

function addRule(type) {
  rules[type].push({ pattern: '', isRegex: false, weight: 1.0 })
}

function removeRule(type, index) {
  rules[type].splice(index, 1)
}

async function handleSave() {
  saving.value = true
  try {
    const filterEmpty = (arr) => arr.filter(r => r.pattern && r.pattern.trim())
    const payload = {
      confirmWords: filterEmpty(rules.confirmWords),
      denyWords: filterEmpty(rules.denyWords),
      meaninglessWords: filterEmpty(rules.meaninglessWords),
    }
    const res = await saveDialogueRules(payload)
    if (res.success) {
      ElMessage.success(`规则配置已保存 (v${res.version})\n确认词:${payload.confirmWords.length}条 | 否认词:${payload.denyWords.length}条 | 无意义词:${payload.meaninglessWords.length}条`)
      loadRules()
    } else {
      ElMessage.error('保存失败: ' + res.message)
    }
  } catch (e) {
    ElMessage.error('保存失败: ' + e.message)
  } finally {
    saving.value = false
  }
}

async function handleReset() {
  try {
    await ElMessageBox.confirm('确定要重置为默认规则吗？', '确认', { type: 'warning' })
    const res = await resetDialogueRules()
    if (res.success) {
      ElMessage.success('已重置为默认规则')
      loadRules()
    } else {
      ElMessage.error('重置失败: ' + res.message)
    }
  } catch { /* cancelled */ }
}

function handleExport() {
  window.open(exportDialogueRules(), '_blank')
}

onMounted(() => {
  loadRules()
})
</script>

<style scoped>
.config-panel {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  max-width: 800px;
}
.rule-section {
  margin-bottom: 24px;
}
.rule-table-wrap {
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid #eee;
  border-radius: 6px;
  background: #fafbfc;
}
</style>
