/**
 * NER 客户端 - 调用 Python NER 服务进行命名实体识别
 * 用于槽位提取（地址、人名、公司、电话、邮箱、日期、时间等）
 */

const NER_SERVICE_URL = process.env.NER_SERVICE_URL || 'http://127.0.0.1:8766'

// 实体类型映射（NER 标签 → 槽位 key）
const TYPE_MAP = {
  address: ['address'],
  name: ['name'],
  company: ['company'],
  organization: ['organization'],
  government: ['government'],
  position: ['position'],
  scene: ['scene'],
  phone: ['phone'],
  email: ['email'],
  date: ['date'],
  time: ['time'],
}

class NERClient {
  constructor() {
    this.baseUrl = NER_SERVICE_URL
    this.enabled = true
    this._healthChecked = false
  }

  /**
   * 从文本中提取命名实体
   * @param {string} text - 用户输入
   * @returns {Promise<{entities: Object, raw: Array}>}
   *
   * @example
   * const result = await ner.extract('我家住上海市嘉定区')
   * // result.entities = { address: ['上海市嘉定区'] }
   */
  async extract(text) {
    if (!this.enabled || !text?.trim()) return { entities: {}, raw: [] }

    try {
      const resp = await fetch(`${this.baseUrl}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      })

      if (!resp.ok) {
        console.warn('[NER] 请求失败:', resp.status)
        return { entities: {}, raw: [] }
      }

      const data = await resp.json()
      return {
        entities: data.entities || {},
        raw: data.raw || [],
      }
    } catch (e) {
      // 服务不可用时静默降级
      if (!this._healthChecked) {
        console.warn('[NER] 服务不可用，已降级:', e.message)
        this._healthChecked = true
      }
      return { entities: {}, raw: [] }
    }
  }

  /**
   * 根据槽位定义提取特定类型的实体
   * @param {string} text - 用户输入
   * @param {Object} slot - 槽位定义（需包含 extract.ner_type）
   * @returns {Promise<string|null>}
   */
  async extractForSlot(text, slot) {
    const nerType = slot?.extract?.ner_type
    if (!nerType) return null

    const result = await this.extract(text)
    const entities = result.entities

    // 查找匹配的实体类型
    const possibleTypes = TYPE_MAP[nerType] || [nerType]
    for (const type of possibleTypes) {
      const values = entities[type]
      if (values && values.length > 0) {
        return values[0]  // 返回第一个匹配
      }
    }

    return null
  }

  /**
   * 健康检查
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
      })
      return resp.ok
    } catch {
      return false
    }
  }
}

export default new NERClient()
