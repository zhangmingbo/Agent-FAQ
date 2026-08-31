import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getConfig, saveConfig as saveConfigApi } from '@/api/config'

export const useConfigStore = defineStore('config', () => {
  const minConfidence = ref(0.5)
  const clarifyThreshold = ref(0.65)
  const topK = ref(5)
  const meaninglessDetectionMode = ref('rule')
  const sessionTimeout = ref(30) // 分钟

  async function load() {
    const config = await getConfig()
    minConfidence.value = config.minConfidence ?? 0.5
    clarifyThreshold.value = config.clarifyThreshold ?? 0.65
    topK.value = config.topK ?? 5
    meaninglessDetectionMode.value = config.meaninglessDetectionMode || 'rule'
    // 后端返回毫秒，转分钟
    if (config.sessionTimeout) {
      sessionTimeout.value = Math.round(config.sessionTimeout / 60000)
    }
  }

  async function save() {
    const result = await saveConfigApi({
      minConfidence: minConfidence.value,
      clarifyThreshold: clarifyThreshold.value,
      topK: topK.value,
      meaninglessDetectionMode: meaninglessDetectionMode.value,
      sessionTimeout: sessionTimeout.value * 60000, // 分钟转毫秒
    })
    return result.success
  }

  return {
    minConfidence, clarifyThreshold, topK,
    meaninglessDetectionMode, sessionTimeout,
    load, save,
  }
})
