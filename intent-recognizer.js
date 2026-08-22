/**
 * @deprecated 已被 src/recognizer.js 替代，仅 demo.js/test.js 引用
 * 
 * 意图识别 SDK - 旧版调用入口
 * 新版使用 src/recognizer.js + 数据库驱动
 */
import IntentRecognizer from './src/index.js'
import { intents, sdkConfig } from './intents-library.js'

// 全局识别器实例（懒初始化）
let recognizerInstance = null
let initPromise = null

/**
 * 初始化识别器（加载模型 + 编码所有意图）
 * 重复调用不会重复初始化
 * @returns {Promise<IntentRecognizer>}
 */
export async function initRecognizer() {
  if (recognizerInstance) return recognizerInstance
  if (initPromise) return initPromise

  initPromise = (async () => {
    console.log('[SDK] 正在初始化意图识别器...')

    recognizerInstance = new IntentRecognizer({
      minConfidence: sdkConfig.minConfidence,
      topK: sdkConfig.topK,
    })

    await recognizerInstance.addIntents(intents)

    console.log(`[SDK] 初始化完成，已加载 ${recognizerInstance.getIntentCount()} 个意图`)
    return recognizerInstance
  })()

  return initPromise
}

/**
 * 识别用户输入的意图（核心方法）
 * 
 * @param {string} text - 用户输入文本
 * @returns {Promise<{
 *   matched: boolean,
 *   intent_code: string,
 *   intent_name: string,
 *   confidence: number,
 *   top_results: Array<{intentCode: string, intentName: string, questionText: string, similarity: number}>
 * >}
 * 
 * @example
 *   const result = await recognize('我想查一下余额')
 *   if (result.matched) {
 *     console.log(`匹配到意图: ${result.intent_name} (${result.intent_code})`)
 *     console.log(`置信度: ${result.confidence}`)
 *   }
 */
export async function recognize(text) {
  const recognizer = await initRecognizer()
  return recognizer.recognize(text)
}

/**
 * 获取识别器实例（用于调用更多方法）
 * 如果未初始化会自动初始化
 * @returns {Promise<IntentRecognizer>}
 */
export async function getRecognizer() {
  return initRecognizer()
}

/**
 * 获取所有意图列表
 * @returns {Promise<Array<{code: string, name: string, questionCount: number}>>}
 */
export async function listIntents() {
  const recognizer = await initRecognizer()
  return recognizer.listIntents()
}

// 默认导出 recognize 函数
export default recognize
