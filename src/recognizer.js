/**
 * 意图识别器：基于余弦相似度的意图匹配
 * 无需数据库，纯内存向量匹配
 */
import NLPEngine from './nlpEngine.js'
import { cosineSimilarity } from './similarity.js'

/**
 * @typedef {Object} IntentConfig
 * @property {string} code - 意图唯一标识
 * @property {string} name - 意图名称
 * @property {string[]} questions - 相似问列表（至少1条）
 * @property {number} [priority=0] - 优先级，用于相似度相同时排序
 */

/**
 * @typedef {Object} RecognizeResult
 * @property {boolean} matched - 是否匹配成功
 * @property {string} intentCode - 匹配到的意图code
 * @property {string} intentName - 匹配到的意图名称
 * @property {number} confidence - 置信度 (0-1)
 * @property {Array<{intentCode: string, intentName: string, questionText: string, similarity: number}>} topResults - Top K结果
 */

class IntentRecognizer {
  /**
   * 创建意图识别器实例
   * @param {Object} options - 配置选项
   * @param {string} [options.modelName] - 模型名称，默认 'paraphrase-multilingual-MiniLM-L12-v2'
   * @param {number} [options.minConfidence=0.5] - 最小置信度阈值
   * @param {number} [options.topK=3] - 返回的Top K结果数量
   * @param {number} [options.shortTextLen=4] - 短句防护：长度低于此值不走向量匹配
   * @param {number} [options.shortRegexHit=0.95] - 短句正则命中给的相似度
   * @param {number} [options.shortContainsHit=0.9] - 短句例句包含原词给的相似度
   */
  constructor(options = {}) {
    this.modelName = options.modelName || 'paraphrase-multilingual-MiniLM-L12-v2'
    this.minConfidence = options.minConfidence ?? 0.5
    this.topK = options.topK ?? 3
    this.shortTextLen = options.shortTextLen ?? 4
    this.shortRegexHit = options.shortRegexHit ?? 0.95
    this.shortContainsHit = options.shortContainsHit ?? 0.9

    this.nlpEngine = new NLPEngine(this.modelName)

    // 意图存储: Map<intentCode, {code, name, priority, questions: Array<{text, vector}>}>
    this.intents = new Map()

    // 所有样本的扁平化列表，用于批量检索
    this.allSamples = [] // [{intentCode, intentName, priority, questionText, vector}]
  }

  /**
   * 添加一个意图
   * @param {IntentConfig} config - 意图配置
   */
  async addIntent(config) {
    const { code, name, questions, priority = 0 } = config

    if (!code || !name) {
      throw new Error('意图必须包含 code 和 name')
    }
    if (!questions || questions.length === 0) {
      throw new Error(`意图 "${code}" 至少需要提供一条相似问`)
    }

    // ✅ 新增：分离普通文本和正则表达式
    const normalQuestions = []   // 普通文本列表
    const regexPatterns = []     // 正则表达式列表
    
    for (const q of questions) {
      // 判断是否为正则表达式（以 / 开头且以 / 结尾）
      if (q.startsWith('/') && q.endsWith('/') && q.length > 2) {
        // 正则表达式
        const pattern = q.slice(1, -1)  // 去除 /.../ 标记
        try {
          const regex = new RegExp(pattern, 'i')  // 创建正则对象（忽略大小写）
          regexPatterns.push({ pattern: regex, original: q })
        } catch (e) {
          console.warn(`[SDK] ⚠️ 正则表达式无效: ${q}`, e.message)
        }
      } else {
        // 普通文本
        normalQuestions.push(q)
      }
    }
    
    console.log(`[SDK] 意图 "${code}": ${normalQuestions.length} 条普通文本 + ${regexPatterns.length} 条正则表达式`)
    
    // 构建意图数据
    const intentData = {
      code,
      name,
      priority,
      questions: [],
    }
    
    // 只向量化普通文本
    if (normalQuestions.length > 0) {
      console.log(`[SDK] 正在编码 ${normalQuestions.length} 条普通文本相似问...`)
      const vectors = await this.nlpEngine.encodeTexts(normalQuestions)

      for (let i = 0; i < normalQuestions.length; i++) {
        const sample = {
          intentCode: code,
          intentName: name,
          priority,
          questionText: normalQuestions[i],
          vector: vectors[i],        // 存储768维向量
          isRegex: false,            // 标记：不是正则
        }
        this.allSamples.push(sample)
      }
    }
    
    // 正则表达式不向量化，直接存储正则对象
    for (const rp of regexPatterns) {
      const sample = {
        intentCode: code,
        intentName: name,
        priority,
        questionText: rp.original,   // 存储带 /.../ 的原始字符串
        regex: rp.pattern,           // 存储RegExp对象
        isRegex: true,               // 标记：是正则
      }
      this.allSamples.push(sample)
    }

    this.intents.set(code, intentData)
    console.log(`[SDK] 意图 "${code}" 添加成功 (${normalQuestions.length} 普通 + ${regexPatterns.length} 正则)`)
  }

  /**
   * 批量添加多个意图
   * @param {IntentConfig[]} configs - 意图配置列表
   */
  async addIntents(configs) {
    for (const config of configs) {
      await this.addIntent(config)
    }
  }

  /**
   * 清空所有意图（全量重建知识库前调用）
   */
  clear() {
    this.intents.clear()
    this.allSamples = []
  }

  /**
   * 删除一个意图
   * @param {string} intentCode - 意图code
   */
  removeIntent(intentCode) {
    const intent = this.intents.get(intentCode)
    if (!intent) return false

    // 从 allSamples 中移除该意图的所有样本
    this.allSamples = this.allSamples.filter(s => s.intentCode !== intentCode)
    this.intents.delete(intentCode)
    return true
  }

  /**
   * 识别用户输入的意图
   * @param {string} text - 用户输入文本
   * @returns {Promise<RecognizeResult>}
   */
  async recognize(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('输入文本不能为空')
    }
    if (this.allSamples.length === 0) {
      throw new Error('未添加任何意图，请先调用 addIntent() 添加')
    }

    // ===== [STEP 3.0] 短句防护 =====
    // 短句（<4字）向量匹配不可靠："习近平"(3字) vs "查明细"(3字) 相似度 0.826。
    // 短句只接受"例句包含原词"或正则命中（确定性），不做纯向量相似猜测——
    // 避免域外短词（人名/地名）被强行塞进最像的意图。
    const SHORT_TEXT_LEN = this.shortTextLen
    const isShort = text.trim().length < SHORT_TEXT_LEN
    if (isShort) {
      const t = text.trim()
      const exactHits = []
      for (const sample of this.allSamples) {
        // 正则命中
        if (sample.isRegex && sample.regex.test(t)) {
          exactHits.push({ ...sample, similarity: this.shortRegexHit, _exact: true })
        } else if (!sample.isRegex && sample.questionText && sample.questionText.includes(t)) {
          // 例句包含原词（"换芯"出现在例句"安排个上门换滤芯"里 → 确定匹配）
          exactHits.push({ ...sample, similarity: this.shortContainsHit, _exact: true })
        }
      }
      if (exactHits.length > 0) {
        exactHits.sort((a, b) => b.similarity - a.similarity)
        const best = exactHits[0]
        console.log(`[STEP 3.0] 短句 "${t}" 确定性匹配 → ${best.intentCode} (${best.intentName})`)
        return {
          matched: true,
          intent_code: best.intentCode,
          intent_name: best.intentName,
          confidence: best.similarity,
          top_results: exactHits.slice(0, this.topK).map(r => ({
            intentCode: r.intentCode,
            intentName: r.intentName,
            questionText: r.questionText,
            similarity: r.similarity,
          })),
        }
      }
      console.log(`[STEP 3.0] 短句 "${t}" 无确定性匹配，跳过向量（避免短词噪声误匹配）`)
      return {
        matched: false,
        intent_code: null,
        intent_name: null,
        confidence: 0,
        top_results: [],
      }
    }

    // ===== [STEP 3.1] 编码查询文本 =====
    console.log(`[STEP 3.1] 编码查询文本: "${text}"`)
    const queryVector = await this.nlpEngine.encodeQuery(text)
    console.log(`[STEP 3.1] ✅ 编码完成 (向量维度: ${queryVector.length})`)

    // ===== [STEP 3.2] 计算相似度 =====
    console.log(`[STEP 3.2] 开始计算与 ${this.allSamples.length} 个样本的相似度...`)
    const results = []
    
    for (const sample of this.allSamples) {
      let similarity = 0
      
      if (sample.isRegex) {
        // ✅ 新增：正则匹配
        if (sample.regex.test(text)) {
          similarity = 0.95  // 正则匹配给予高置信度
        }
      } else {
        // 原有逻辑：余弦相似度
        similarity = cosineSimilarity(queryVector, sample.vector)
      }
      
      results.push({
        intentCode: sample.intentCode,
        intentName: sample.intentName,
        questionText: sample.questionText,
        similarity,
        priority: sample.priority,
        isRegex: sample.isRegex,  // 保留标记用于调试
      })
    }
    console.log(`[STEP 3.2] ✅ 相似度计算完成`)

    // ===== [STEP 3.3] 排序并取Top K =====
    console.log('[STEP 3.3] 按相似度降序排序...')
    results.sort((a, b) => b.similarity - a.similarity)

    console.log(`[STEP 3.4] 取 Top ${this.topK} 结果...`)
    const topResults = results.slice(0, this.topK).map(r => ({
      intentCode: r.intentCode,
      intentName: r.intentName,
      questionText: r.questionText,
      similarity: Math.round(r.similarity * 10000) / 10000,
    }))
    
    // 打印Top 5结果
    console.log('[TOP-5 CANDIDATES]:')
    topResults.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.intentCode} (${r.intentName}): ${(r.similarity * 100).toFixed(2)}% | Sample: "${r.questionText.substring(0, 30)}..."`)
    })

    // ===== [STEP 3.5] 判断最佳匹配（考虑优先级加权）=====
    console.log('[STEP 3.5] 应用优先级加权，寻找最佳匹配...')
    let bestMatch = null
    let bestScore = 0

    for (const r of results) {
      const weightedScore = r.similarity + (r.priority * 0.01)
      if (weightedScore > bestScore) {
        bestScore = weightedScore
        bestMatch = r
      }
    }
    
    console.log(`[BEST MATCH] ${bestMatch?.intentCode || 'None'} (${bestMatch?.intentName || 'N/A'}): Score=${bestScore.toFixed(4)}, Threshold=${this.minConfidence}`)

    let matched = false
    let intentCode = ''
    let intentName = ''
    let confidence = 0

    if (bestMatch && bestScore >= this.minConfidence) {
      matched = true
      intentCode = bestMatch.intentCode
      intentName = bestMatch.intentName
      confidence = Math.round(bestScore * 10000) / 10000
      console.log(`[RESULT] ✅ 匹配成功! Intent: ${intentCode}, Confidence: ${(confidence * 100).toFixed(2)}%`)
    } else {
      console.log(`[RESULT] ❌ 未匹配 (Best Score: ${bestScore.toFixed(4)} < Threshold: ${this.minConfidence})`)
    }

    return {
      matched,
      intent_code: intentCode,
      intent_name: intentName,
      confidence,
      top_results: topResults,
    }
  }

  /**
   * 获取已添加的意图数量
   * @returns {number}
   */
  getIntentCount() {
    return this.intents.size
  }

  /**
   * 获取所有已添加的意图信息
   * @returns {Array<{code: string, name: string, questionCount: number}>}
   */
  listIntents() {
    const result = []
    for (const [code, intent] of this.intents) {
      result.push({
        code,
        name: intent.name,
        questionCount: intent.questions.length,
      })
    }
    return result
  }
}

export default IntentRecognizer
