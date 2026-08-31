/**
 * 槽位值提取器
 *
 * 支持提取方法：text / regex / number / enum / keyword（含标签的显式提供，如“地址是XX”）
 * 策略：先精确（regex/enum/number/keyword），后文本兜底
 */

class Extractor {
  constructor() {}

  /**
   * 从用户输入中提取槽位值
   * @param {string} text - 用户输入
   * @param {Object} slot - 槽位定义
   * @param {Object} ctx - 上下文（可选）
   * @param {Object} opts - 选项
   * @param {boolean} opts.labelOnly - 仅做显式标签提取（首轮/文本已被占用时）
   * @returns {Promise<string|null>}
   */
  async extract(text, slot, ctx = {}, opts = {}) {
    if (!text || !slot) return null

    const method = slot.extract?.method || 'text'
    let value = null

    // 1) 关键词/标签显式提供优先（如"地址是XX""电话 138..."）
    if (slot.label || (slot.aliases && slot.aliases.length)) {
      value = this._extractByLabel(text, slot)
    }

    // 2) 结构化提取（labelOnly 模式下跳过）
    if (value === null && !opts.labelOnly) {
      switch (method) {
        case 'regex':
          value = this._extractRegex(text, slot.extract?.rule)
          break
        case 'number':
          value = this._extractNumber(text)
          break
        case 'enum':
          value = this._extractEnum(text, slot.extract?.enum || slot.extract?.rule)
          break
        case 'text':
        default:
          value = this._extractText(text, slot)
      }
    }

    return value
  }

  /** 显式标签提供：识别"地址是XX""地址改成XX""电话 138..."（含别名） */
  _extractByLabel(text, slot) {
    const names = [slot.label, ...(slot.aliases || [])].filter(Boolean)
    if (names.length === 0) return null
    for (const name of names) {
      // 模式1："地址是X"/"地址：X"/"地址 X"（是/为后可不带分隔符，值截断到标点）
      const patterns = [
        new RegExp(`${name}(?:[是为][:：\\s]*|[:：\\s]+)([^，。；;！？!?]+)`),
        new RegExp(`(?:修改|改成|换成|改为|变更|改一下)${name}[是为]?[:：\\s]*([^，。；;！？!?]+)`),
      ]
      for (const re of patterns) {
        const m = text.match(re)
        if (m && m[1] && m[1].trim()) {
          const v = m[1].trim().replace(/[。！!？?，,]$/, '')
          if (v.length >= 1) return v
        }
      }
    }
    return null
  }

  _extractRegex(text, rule) {
    if (!rule) return text.trim()
    try {
      // 兼容数据库存储时可能的双重转义
      let pattern = rule
      if (pattern.includes('\\\\')) pattern = pattern.replace(/\\\\/g, '\\')
      const regex = new RegExp(pattern, 'i')
      const match = text.match(regex)
      return match ? (match[1] || match[0]) : null
    } catch {
      return null
    }
  }

  _extractNumber(text) {
    const num = text.match(/\d+\.?\d*/)
    return num ? num[0] : null
  }

  _extractEnum(text, enumDef) {
    if (!enumDef) return null
    const options = Array.isArray(enumDef) ? enumDef : String(enumDef).split(',').map(s => s.trim())
    const lowerText = text.trim().toLowerCase()
    for (const opt of options) {
      if (lowerText.includes(opt.toLowerCase())) return opt
    }
    return null
  }

  /** 文本提取：至少 2 字符、非纯触发词、非疑问句 */
  _extractText(text, slot) {
    const t = text.trim()
    if (t.length < 2) return null
    if (this._isQuestion(t)) return null
    if (this._isTriggerOnly(t, slot)) return null
    return t
  }

  /**
   * 判断文本是否为疑问句（供校验逻辑复用）
   */
  isQuestion(text) {
    return this._isQuestion(text)
  }

  /** 判断是否疑问句（疑问句不作为文本槽位值） */
  _isQuestion(text) {
    const t = text.trim()
    if (t.includes('？') || t.includes('?')) return true
    const questionWords = ['怎么', '如何', '怎样', '什么', '哪里', '哪儿', '多少', '几个', '为什么',
      '能不能', '可以吗', '是否', '有没有', '多久', '几时', '请问', '想知道',
      '怎么办', '好不好', '行不行', '是不是', '呢', '吗']
    return questionWords.some(w => t.includes(w))
  }

  /** 判断是否只包含触发词（无有效信息） */
  _isTriggerOnly(text, slot) {
    const triggers = slot._triggers || []
    if (triggers.length === 0) return false
    let stripped = text.toLowerCase()
    for (const kw of triggers) {
      const kwStr = typeof kw === 'string' ? kw : (kw.regex || '')
      if (kwStr) stripped = stripped.replace(kwStr.toLowerCase(), '')
    }
    return stripped.trim().length < 2
  }
}

export default new Extractor()
