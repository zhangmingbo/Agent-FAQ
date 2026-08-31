import { ref, onMounted, onUnmounted } from 'vue'

export function useAutoRefresh(fetchFn, intervalMs = 5000) {
  const enabled = ref(true)
  const timer = ref(null)

  function start() {
    stop()
    if (!enabled.value) return
    timer.value = setInterval(fetchFn, intervalMs)
  }

  function stop() {
    if (timer.value) {
      clearInterval(timer.value)
      timer.value = null
    }
  }

  function toggle(val) {
    enabled.value = val
    if (val) start()
    else stop()
  }

  onMounted(() => { if (enabled.value) start() })
  onUnmounted(() => stop())

  return { enabled, start, stop, toggle }
}
