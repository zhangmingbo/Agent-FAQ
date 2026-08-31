<template>
  <el-dialog v-model="visible" :title="isEdit ? '编辑 FAQ' : '新增 FAQ'" width="640px" destroy-on-close>
    <el-form :model="form" label-width="100px" label-position="left">
      <el-form-item label="意图编码">
        <el-input v-model="form.code" :disabled="isEdit" placeholder="如: gas_price" />
      </el-form-item>
      <el-form-item label="意图名称">
        <el-input v-model="form.name" placeholder="如: 气价查询" />
      </el-form-item>
      <el-form-item label="所属分类">
        <el-select v-model="form.categoryId" placeholder="未分类" clearable style="width:100%">
          <el-option label="未分类" :value="null" />
          <el-option v-for="opt in categoryOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="相似问">
        <el-input v-model="form.questionsText" type="textarea" :rows="4" placeholder="每行一条相似问" />
      </el-form-item>
      <el-form-item label="标准答案">
        <el-input v-model="form.answer" type="textarea" :rows="4" placeholder="输入标准答案..." />
      </el-form-item>
      <el-form-item label="优先级">
        <el-input-number v-model="form.priority" :min="-100" :max="100" />
        <div style="font-size:12px;color:#999;margin-top:4px">
          加权得分 = 相似度 + (优先级 × 0.01)，紧急业务设正数，无意义输入设负数
        </div>
      </el-form-item>
      <el-form-item label="富媒体">
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <el-upload :show-file-list="false" accept="image/*" :before-upload="(f) => handleUpload(f, 'image')">
            <el-button size="small">📷 图片</el-button>
          </el-upload>
          <el-upload :show-file-list="false" accept="video/*" :before-upload="(f) => handleUpload(f, 'video')">
            <el-button size="small">🎬 视频</el-button>
          </el-upload>
          <el-upload :show-file-list="false" accept="audio/*,.mp3,.wav" :before-upload="(f) => handleUpload(f, 'audio')">
            <el-button size="small">🎵 音频</el-button>
          </el-upload>
          <el-upload :show-file-list="false" accept=".pdf" :before-upload="(f) => handleUpload(f, 'pdf')">
            <el-button size="small">📄 PDF</el-button>
          </el-upload>
        </div>
        <div v-if="mediaItems.length">
          <div v-for="(item, i) in mediaItems" :key="i" style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:#f8f9fa;border-radius:4px;margin-bottom:4px">
            <span>{{ { image:'📷', video:'🎬', audio:'🎵', pdf:'📄' }[item.type] || '📎' }}</span>
            <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ item.name }}</span>
            <span style="font-size:11px;color:#aaa">{{ (item.size / 1024).toFixed(1) }} KB</span>
            <el-button type="danger" size="small" link @click="mediaItems.splice(i, 1)">×</el-button>
          </div>
        </div>
        <div v-else style="color:#aaa;font-size:12px">暂无富媒体</div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="handleSave" :loading="saving">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, watch, computed } from 'vue'
import { getFaqDetail, addFaq } from '@/api/faq'
import { uploadFile } from '@/api/upload'
import { ElMessage } from 'element-plus'

const props = defineProps({
  modelValue: Boolean,
  faqCode: { type: String, default: '' },
  categoryTree: { type: Array, default: () => [] },
  categoryId: { type: [Number, null], default: null },
  initialQuestions: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const isEdit = computed(() => !!props.faqCode)
const saving = ref(false)
const mediaItems = ref([])

const form = reactive({
  code: '',
  name: '',
  categoryId: null,
  questionsText: '',
  answer: '',
  priority: 0,
})

// 构建分类选项（扁平化）
const categoryOptions = computed(() => {
  const opts = []
  function walk(nodes, prefix = '') {
    for (const n of nodes) {
      opts.push({ value: n.id, label: prefix + n.name })
      if (n.children?.length) walk(n.children, prefix + ' ')
    }
  }
  walk(props.categoryTree)
  return opts
})

// 监听弹窗打开
watch(visible, async (val) => {
  if (!val) return
  mediaItems.value = []
  if (props.faqCode) {
    // 编辑模式：加载数据
    const d = await getFaqDetail(props.faqCode)
    form.code = d.code
    form.name = d.name
    form.categoryId = d.category_id || null
    form.questionsText = (d.questions || []).join('\n')
    form.answer = d.answer || ''
    form.priority = d.priority || 0
    if (d.richContent) {
      const rc = typeof d.richContent === 'string' ? JSON.parse(d.richContent) : d.richContent
      if (rc.items) mediaItems.value = rc.items
    }
  } else {
    // 新增模式：重置
    Object.assign(form, { code: '', name: '', categoryId: props.categoryId, questionsText: props.initialQuestions || '', answer: '', priority: 0 })
  }
})

async function handleUpload(file, type) {
  if (file.size > 50 * 1024 * 1024) {
    ElMessage.warning('文件大小不能超过 50MB')
    return false
  }
  const reader = new FileReader()
  reader.onload = async (e) => {
    const base64 = e.target.result.split(',')[1]
    const result = await uploadFile(file.name, base64, file.type)
    if (result.success) {
      mediaItems.value.push({ type, url: result.url, name: result.originalName, size: result.size })
    }
  }
  reader.readAsDataURL(file)
  return false // 阻止默认上传
}

async function handleSave() {
  if (!form.code || !form.name) {
    ElMessage.warning('请填写编码和名称')
    return
  }
  const questions = form.questionsText.split('\n').map(s => s.trim()).filter(Boolean)
  if (!questions.length) {
    ElMessage.warning('请填写至少一条相似问')
    return
  }
  saving.value = true
  try {
    const payload = {
      code: form.code.trim(),
      name: form.name.trim(),
      questions,
      answer: form.answer.trim() || null,
      categoryId: form.categoryId ? parseInt(form.categoryId) : null,
      priority: form.priority || 0,
      richContent: mediaItems.value.length > 0 ? { items: mediaItems.value } : null,
    }
    const res = await addFaq(payload)
    if (res.success) {
      ElMessage.success(res.message)
      visible.value = false
      emit('saved')
    } else {
      ElMessage.error(res.message)
    }
  } finally {
    saving.value = false
  }
}
</script>
