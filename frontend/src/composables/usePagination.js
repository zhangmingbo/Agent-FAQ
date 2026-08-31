import { ref, computed } from 'vue'

export function usePagination(fetchFn, defaultPageSize = 20) {
  const page = ref(1)
  const pageSize = ref(defaultPageSize)
  const total = ref(0)
  const items = ref([])
  const loading = ref(false)

  const totalPages = computed(() => Math.ceil(total.value / pageSize.value) || 1)

  async function load() {
    loading.value = true
    try {
      const data = await fetchFn({
        page: page.value,
        pageSize: pageSize.value,
      })
      items.value = data.items || []
      total.value = data.total || 0
      page.value = data.page || page.value
    } finally {
      loading.value = false
    }
  }

  function goToPage(p) {
    page.value = p
    return load()
  }

  function prevPage() {
    if (page.value > 1) {
      page.value--
      return load()
    }
  }

  function nextPage() {
    if (page.value < totalPages.value) {
      page.value++
      return load()
    }
  }

  return {
    page, pageSize, total, items, loading, totalPages,
    load, goToPage, prevPage, nextPage,
  }
}
