import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getFaqList } from '@/api/faq'
import { getCategories } from '@/api/category'

export const useFaqStore = defineStore('faq', () => {
  const faqList = ref([])
  const categoryTree = ref([])
  const categoryMap = ref(new Map())  // id -> name
  const faqNameMap = ref(new Map())  // code -> name

  // 兜底名称映射
  const fallbackNames = {
    complaint: '客户投诉', other: '其他', greeting: '问候',
    open_account: '开户', account_transfer: '过户', ignition_failure: '点火失败',
    lost_card: '补卡', invoice_query: '发票查询', query_balance: '余额查询',
    meter_fault: '表具故障', gas_price: '气价查询',
  }

  const faqCount = computed(() => faqList.value.length)
  const answeredCount = computed(() => faqList.value.filter(f => f.hasAnswer).length)
  const richCount = computed(() => faqList.value.filter(f => f.hasRichContent).length)

  function buildCategoryMap(nodes) {
    const map = new Map()
    function walk(list) {
      for (const n of list) {
        map.set(n.id, n.name)
        if (n.children?.length) walk(n.children)
      }
    }
    walk(nodes)
    return map
  }

  async function loadData() {
    const [faqs, cats] = await Promise.all([getFaqList(), getCategories()])
    faqList.value = faqs
    categoryTree.value = cats
    categoryMap.value = buildCategoryMap(cats)

    const nameMap = new Map()
    for (const f of faqs) nameMap.set(f.code, f.name)
    for (const [code, name] of Object.entries(fallbackNames)) {
      if (!nameMap.has(code)) nameMap.set(code, name)
    }
    faqNameMap.value = nameMap
  }

  function getCategoryName(id) {
    return categoryMap.value.get(id) || '未分类'
  }

  function getFaqName(code) {
    return faqNameMap.value.get(code) || code
  }

  return {
    faqList, categoryTree, categoryMap, faqNameMap,
    faqCount, answeredCount, richCount,
    loadData, getCategoryName, getFaqName,
  }
})
