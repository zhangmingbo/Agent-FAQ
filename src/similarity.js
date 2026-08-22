/**
 * 余弦相似度计算模块
 */

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} vecA - 向量A
 * @param {number[]} vecB - 向量B
 * @returns {number} 相似度值，范围 [0, 1]（向量已归一化时）
 */
export function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) {
    throw new Error(`向量维度不匹配: ${vecA.length} vs ${vecB.length}`)
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

/**
 * 计算查询向量与多个候选向量的相似度
 * @param {number[]} queryVector - 查询向量
 * @param {number[][]} candidateVectors - 候选向量列表
 * @returns {number[]} 相似度列表
 */
export function cosineSimilarities(queryVector, candidateVectors) {
  return candidateVectors.map(vec => cosineSimilarity(queryVector, vec))
}
