/**
 * 通用槽位提取引擎
 * 根据前端配置的 extraction 规则执行提取
 */

import nerClient from './nerClient.js'

class SlotExtractor {
  /**
   * 根据配置提取槽位值
   * @param {string} text - 用户输入
   * @param {Object} extraction - 前端配置的提取规则
   * @param {string} slotKey - 槽位 key（用于日志）
   * @returns {Object|null} - { value, method } 或 null
   */
  static async extract(text, extraction, slotKey) {
    if (!extraction || !extraction.method) {
      return null
    }

    const t = String(text || '').trim()
    if (!t) return null

    const method = extraction.method

    try {
      switch (method) {
        case 'ner':
          return await this._extractByNer(t, extraction, slotKey)

        case 'regex':
          return this._extractByRegex(t, extraction, slotKey)

        case 'enum':
          return this._extractByEnum(t, extraction, slotKey)

        case 'text':
          return this._extractByText(t, extraction, slotKey)

        default:
          console.warn(`[WARN] 未知的提取方法: ${method}`)
          return null
      }
    } catch (e) {
      console.error(`[ERROR] 槽位提取失败 (${slotKey}):`, e.message)
      return null
    }
  }

  /**
   * NER 提取
   */
  static async _extractByNer(text, extraction, slotKey) {
    const nerType = extraction.ner_type
    if (!nerType) {
      console.warn(`[WARN] NER 提取缺少 ner_type 配置 (${slotKey})`)
      return null
    }

    const entities = await nerClient.extract(text, nerType)
    if (entities && entities.length > 0) {
      return {
        value: entities[0].value,
        method: 'ner',
        confidence: entities[0].confidence || 1.0
      }
    }

    // NER 未命中，是否回退到纯文本？
    if (extraction.fallback_to_text) {
      return {
        value: text,
        method: 'text_fallback',
        confidence: 0.5
      }
    }

    return null
  }

  /**
   * 正则提取
   */
  static _extractByRegex(text, extraction, slotKey) {
    const pattern = extraction.regex_pattern
    if (!pattern) {
      console.warn(`[WARN] 正则提取缺少 regex_pattern 配置 (${slotKey})`)
      return null
    }

    try {
      const regex = new RegExp(pattern)
      const match = text.match(regex)
      if (match && match[1]) {
        return {
          value: match[1],
          method: 'regex',
          confidence: 1.0
        }
      }
    } catch (e) {
      console.error(`[ERROR] 正则表达式错误 (${slotKey}):`, e.message)
    }

    return null
  }

  /**
   * 枚举提取（完全匹配或模糊匹配）
   */
  static _extractByEnum(text, extraction, slotKey) {
    const values = extraction.enum_values
    if (!Array.isArray(values) || values.length === 0) {
      console.warn(`[WARN] 枚举提取缺少 enum_values 配置 (${slotKey})`)
      return null
    }

    // 精确匹配
    const exactMatch = values.find(v => v === text)
    if (exactMatch) {
      return {
        value: exactMatch,
        method: 'enum_exact',
        confidence: 1.0
      }
    }

    // 模糊匹配（包含）
    const fuzzyMatch = values.find(v => text.includes(v))
    if (fuzzyMatch) {
      return {
        value: fuzzyMatch,
        method: 'enum_fuzzy',
        confidence: 0.8
      }
    }

    return null
  }

  /**
   * 纯文本提取（兜底）
   */
  static _extractByText(text, extraction, slotKey) {
    return {
      value: text,
      method: 'text',
      confidence: 0.6
    }
  }
}

export default SlotExtractor
