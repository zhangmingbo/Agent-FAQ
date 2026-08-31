<template>
  <el-dialog v-model="visible" title="批量导入 FAQ" width="650px" destroy-on-close>
    <div style="margin-bottom:16px;padding:12px;background:#f8f9fa;border-radius:8px">
      <div style="font-size:13px;color:#555;margin-bottom:8px"><b>使用说明：</b></div>
      <ol style="font-size:12px;color:#666;padding-left:20px;line-height:1.8">
        <li>下载模板文件，按格式填写 FAQ 数据</li>
        <li><b>code</b>: 英文编码（唯一标识）</li>
        <li><b>name</b>: 中文名称</li>
        <li><b>questions</b>: 相似问（用换行分隔，CSV 中用引号包裹）</li>
        <li><b>answer</b>: 标准答案（可选）</li>
        <li>上传填写好的 CSV 文件</li>
      </ol>
    </div>
    <el-form label-width="100px">
      <el-form-item label="CSV 模板">
        <el-button @click="downloadTpl">📄 下载 CSV 模板</el-button>
      </el-form-item>
      <el-form-item label="上传 CSV">
        <el-upload :auto-upload="false" :limit="1" accept=".csv" :on-change="handleFileChange" :file-list="fileList">
          <el-button>选择文件</el-button>
        </el-upload>
      </el-form-item>
    </el-form>
    <div v-if="importResult" style="margin-top:16px;padding:12px;border-radius:8px;font-size:13px" :style="{ background: importResult.failCount > 0 ? '#fff3cd' : '#d4edda', color: importResult.failCount > 0 ? '#856404' : '#155724' }">
      <b>导入完成</b><br>
      总计: {{ importResult.total }} 条<br>
      成功: {{ importResult.successCount }} 条<br>
      失败: {{ importResult.failCount }} 条
      <template v-if="importResult.errors?.length">
        <br><br><b>失败详情：</b><br>
        <span v-for="e in importResult.errors" :key="e.index">第{{ e.index }}条 [{{ e.code }}]: {{ e.error }}<br></span>
      </template>
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="doImport" :loading="importing" :disabled="!selectedFile">开始导入</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { importFaqCsv, downloadTemplate } from '@/api/faq'
import { ElMessage } from 'element-plus'

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue', 'imported'])

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const selectedFile = ref(null)
const fileList = ref([])
const importing = ref(false)
const importResult = ref(null)

watch(visible, () => {
  selectedFile.value = null
  fileList.value = []
  importResult.value = null
})

function handleFileChange(file) {
  selectedFile.value = file.raw
}

function downloadTpl() {
  window.open(downloadTemplate(), '_blank')
}

async function doImport() {
  if (!selectedFile.value) return
  importing.value = true
  try {
    const text = await selectedFile.value.text()
    const result = await importFaqCsv(text)
    importResult.value = result
    if (result.successCount > 0) {
      setTimeout(() => emit('imported'), 1000)
    }
  } catch (e) {
    ElMessage.error('导入出错: ' + e.message)
  } finally {
    importing.value = false
  }
}
</script>
