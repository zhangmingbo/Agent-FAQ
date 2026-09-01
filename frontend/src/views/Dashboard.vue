<template>
  <div>
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="stats-row">
      <el-col :span="6">
        <StatCard label="FAQ 总数" :value="store.faqCount" />
      </el-col>
      <el-col :span="6">
        <StatCard label="有标准答案" :value="store.answeredCount" />
      </el-col>
      <el-col :span="6">
        <StatCard label="有富内容" :value="store.richCount" />
      </el-col>
      <el-col :span="6">
        <StatCard label="分类数" :value="store.categoryMap.size" />
      </el-col>
    </el-row>

    <!-- FAQ 总览表格 -->
    <div class="faq-table">
      <el-table :data="store.faqList" stripe style="width: 100%">
        <el-table-column prop="code" label="编码" min-width="160">
          <template #default="{ row }">
            <code>{{ row.code }}</code>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="名称" min-width="200" />
        <el-table-column label="分类" width="120" align="center">
          <template #default="{ row }">
            <el-tag size="small" type="primary">{{ store.getCategoryName(row.categoryId) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="questionCount" label="相似问数" width="100" align="center" />
        <el-table-column label="答案" width="80" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.hasAnswer" size="small" type="success">有</el-tag>
            <el-tag v-else size="small" type="danger">无</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="富内容" width="80" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.hasRichContent" size="small" type="primary">有</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useFaqStore } from '@/stores/faq'
import StatCard from '@/components/StatCard.vue'

const store = useFaqStore()

onMounted(() => {
  store.loadData()
})
</script>

<style scoped>
.stats-row {
  margin-bottom: 24px;
}
.faq-table {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  overflow: hidden;
  padding: 16px;
}
</style>
