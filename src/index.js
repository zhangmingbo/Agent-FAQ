/**
 * intent-recognizer-sdk
 * 基于余弦相似度的意图识别SDK
 * 
 * 特点：
 * - 无需数据库，纯内存向量匹配
 * - 使用预训练 sentence-transformers 模型，无需训练
 * - 支持自定义模型、置信度阈值、Top K
 */
import IntentRecognizer from './recognizer.js'
import { cosineSimilarity, cosineSimilarities } from './similarity.js'

export default IntentRecognizer
export { IntentRecognizer, cosineSimilarity, cosineSimilarities }
