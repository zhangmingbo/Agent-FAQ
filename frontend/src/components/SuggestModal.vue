<template>
  <el-dialog v-model="visible" width="520px" destroy-on-close>
    <template #header>
      <span>🧠 智能建议 — <span style="color:#2563eb">{{ questionText }}</span></span>
    </template>
    <div v-if="loading" style="text-align:center;padding:20px;color:#aaa">🧠 正在分析...</div>
    <div v-else-if="error" style="color:#ef4444;text-align:center;padding:20px">分析失败: {{ error }}</div>
    <div v-else>
      <!-- 建议加入已有 FAQ -->
      <template v-if="data?.recommendAction === 'add_question' && data.suggestions?.length > 0">
        <el-alert type="success" :closable="false" style="margin-bottom:12px">
          <template #title>建议加入已有 FAQ 的相似问</template>
          系统发现该问题与以下 FAQ 相似，点击即可加入
        </el-alert>
        <div v-for="s in uniqueSuggestions" :key="s.faqCode" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#f8f9fa;border-radius:8px;margin-bottom:8px">
          <div>
            <div style="font-size:14px;font-weight:500">{{ s.faqName }}</div>
            <div style="font-size:12px;color:#888">
              相似度 {{ (s.similarity * 100).toFixed(1) }}% · 当前 {{ s.questionCount }} 条相似问
              <span v-if="existingMap[s.faqCode]" style="color:#16a34a;font-weight:600"> · ✓ 已包含该相似问</span>
            </div>
          </div>
          <el-tag v-if="existingMap[s.faqCode]" type="success" size="small">✓ 已添加</el-tag>
          <el-button v-else type="primary" size="small" @click="addToFaq(s.faqCode)">+ 加入相似问</el-button>
        </div>
        <div style="text-align:center;margin-top:12px">
          <span style="font-size:12px;color:#aaa">或者</span>
          <el-button size="small" style="margin-left:8px" @click="$emit('createNew', questionText)">📝 新建 FAQ</el-button>
        </div>
      </template>
      <!-- 建议新建 -->
      <template v-else>
        <el-alert type="info" :closable="false" style="margin-bottom:16px">
          <template #title>💡 建议新建 FAQ</template>
          该问题与现有 FAQ 差异较大，建议作为新问题创建
        </el-alert>
        <el-button type="primary" @click="$emit('createNew', questionText)">📝 新建 FAQ</el-button>
      </template>
    </div>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { getSuggest, addQuestion, checkQuestions } from '@/api/analysis'
import { ElMessage } from 'element-plus'

const props = defineProps({
  modelValue: Boolean,
  questionText: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'createNew', 'added'])

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const loading = ref(false)
const error = ref('')
const data = ref(null)
const existingMap = ref({})

const uniqueSuggestions = computed(() => {
  if (!data.value?.suggestions) return []
  const seen = new Set()
  return data.value.suggestions.filter(s => {
    if (seen.has(s.faqCode)) return false
    seen.add(s.faqCode)
    return true
  })
})

watch(visible, async (val) => {
  if (!val || !props.questionText) return
  loading.value = true
  error.value = ''
  data.value = null
  existingMap.value = {}
  try {
    data.value = await getSuggest(props.questionText)
    // 检查是否已存在
    const checkRes = await checkQuestions([props.questionText])
    existingMap.value = checkRes.results || {}
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

async function addToFaq(faqCode) {
  try {
    const res = await addQuestion(faqCode, props.questionText)
    if (res.success) {
      ElMessage.success(res.message)
      existingMap.value[faqCode] = true
      emit('added')
    } else {
      ElMessage.warning(res.message)
    }
  } catch (e) {
    ElMessage.error('操作失败: ' + e.message)
  }
}
</script>
