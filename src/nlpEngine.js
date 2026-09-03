/**
 * NLP引擎：基于 @huggingface/transformers 的文本向量化
 * 使用预训练的 sentence-transformers 模型，无需训练
 * 
 * 支持两种模式：
 * - 离线模式：从本地 model_cache 目录加载（生产环境推荐）
 * - 在线模式：从 HuggingFace 或镜像站下载（开发环境）
 */
import { pipeline, env } from '@huggingface/transformers'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 默认模型名称
const DEFAULT_MODEL = 'bge-base-zh-v1.5'

// 本地模型缓存目录（与 SDK 同级的 model_cache 目录）
const LOCAL_MODEL_DIR = join(__dirname, '..', 'model_cache')

// 配置 transformers 环境
env.allowLocalModels = true      // 允许加载本地模型
env.allowRemoteModels = true     // 允许远程下载（本地不存在时回退）
env.remoteHost = 'https://hf-mirror.com/'  // 国内镜像

class NLPEngine {
  constructor(modelName = DEFAULT_MODEL) {
    this.modelName = modelName
    this.embedder = null
  }

  /**
   * 获取模型加载路径
   * 优先使用本地缓存，不存在则回退到远程下载
   */
  getModelPath() {
    const localPath = join(LOCAL_MODEL_DIR, this.modelName)
    if (existsSync(localPath)) {
      console.log(`[NLP] 使用本地模型: ${localPath}`)
      return localPath
    }
    console.log(`[NLP] 本地模型不存在，将从远程下载: ${this.modelName}`)
    return `Xenova/${this.modelName}`
  }

  /**
   * 懒加载模型，首次调用时自动加载
   * @returns {Promise<object>}
   */
  async getModel() {
    if (!this.embedder) {
      const modelPath = this.getModelPath()
      console.log(`[NLP] 正在加载模型: ${modelPath} ...`)
      this.embedder = await pipeline('feature-extraction', modelPath)
      console.log('[NLP] 模型加载完成')
    }
    return this.embedder
  }

  /**
   * 将文本列表转换为向量列表
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async encodeTexts(texts) {
    const model = await this.getModel()
    const output = await model(texts, { pooling: 'mean', normalize: true })
    const vectors = []
    for (let i = 0; i < texts.length; i++) {
      vectors.push(Array.from(output[i].data))
    }
    return vectors
  }

  /**
   * 将单条文本转换为向量
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async encodeQuery(text) {
    const vectors = await this.encodeTexts([text])
    return vectors[0]
  }
}

export default NLPEngine
