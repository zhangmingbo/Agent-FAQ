/**
 * 槽位答案验证器
 * 根据前端配置的 answer_validation 规则验证用户输入
 */

class SlotAnswerValidator {
  /**
   * 验证文本是否符合槽位的答案规则
   * @param {string} text - 用户输入
   * @param {Object} validation - 前端配置的验证规则
   * @returns {boolean} - 是否通过验证
   */
  static validate(text, validation) {
    if (!validation || !validation.rules || validation.rules.length === 0) {
      return true  // 没有配置规则，一律放行
    }

    const t = String(text || '').trim()
    if (!t) return false

    const logic = validation.logic || 'OR'  // 默认 OR 逻辑
    const results = validation.rules.map(rule => this._checkRule(t, rule))

    if (logic === 'AND') {
      // 必须满足所有规则
      return results.every(r => r)
    } else {
      // 满足任一规则即可
      return results.some(r => r)
    }
  }

  /**
   * 检查单条规则
   */
  static _checkRule(text, rule) {
    const { type, value } = rule

    switch (type) {
      case 'min_length':
        return text.length >= value

      case 'max_length':
        return text.length <= value

      case 'has_digit':
        return /\d/.test(text)

      case 'has_chinese':
        return /[\u4e00-\u9fa5]/.test(text)

      case 'contains_any':
        return Array.isArray(value) && value.some(kw => text.includes(kw))

      case 'contains_all':
        return Array.isArray(value) && value.every(kw => text.includes(kw))

      case 'regex':
        try {
          const regex = new RegExp(value)
          return regex.test(text)
        } catch (e) {
          console.warn(`[WARN] 无效的正则表达式: ${value}`, e.message)
          return false
        }

      case 'not_contains':
        return Array.isArray(value) && !value.some(kw => text.includes(kw))

      default:
        console.warn(`[WARN] 未知的验证规则类型: ${type}`)
        return true  // 未知规则，放行
    }
  }
}

export default SlotAnswerValidator
