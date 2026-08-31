/**
 * NER 客户端 - 调用 Python NER 服务进行命名实体识别
 * 用于槽位提取（地址、人名、公司等）
 */
const NER_SERVICE_URL = process.env.NER_SERVICE_URL || 'http://127.0.0.1:8766'

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
   * 批量提取：一次调用提取所有实体，按槽位定义映射为 { slotKey: value }
   * @param {string} text - 用户输入
   * @param {Object} slotsSpec - 槽位定义 { key: { label, key, ... } }
   * @returns {Promise<{slots: Object, entities: Object}>}
   * 
   * @example
   * const result = await ner.extractBatch('我叫李明，住北京市朝阳区', {
   *   name: { key: 'name', label: '姓名' },
   *   address: { key: 'address', label: '地址' },
   *   phone: { key: 'phone', label: '电话' },
   * })
   * // result.slots = { name: '李明', address: '北京市朝阳区' }
   */
  async extractBatch(text, slotsSpec) {
    const { entities } = await this.extract(text)
    const slots = {}
    
    // 槽位 key → 实体类型映射
    const typeMap = {
      address: ['address'],
      name: ['name'],
      company: ['company'],
      organization: ['org', 'company'],
      phone: ['phone'],
      email: ['email'],
      date: ['date'],
      time: ['time'],
      position: ['position'],
      scene: ['scene'],
    }
    
    for (const [slotKey, slotDef] of Object.entries(slotsSpec)) {
      const entityTypes = typeMap[slotKey] || [slotKey]
      for (const type of entityTypes) {
        if (entities[type]?.length > 0 && !slots[slotKey]) {
          slots[slotKey] = entities[type][0]
        }
      }
    }
    
    return { slots, entities }
  }

  /**
   * 根据槽位定义提取对应类型的实体
   * @param {string} text - 用户输入
   * @param {Object} slotDef - 槽位定义 { key, type, ... }
   * @returns {Promise<string|null>}
   * 
   * @example
   * const value = await ner.extractSlot('我家住上海市嘉定区', { key: 'address' })
   * // value = '上海市嘉定区'
   */
  async extractSlot(text, slotDef) {
    const { slots } = await this.extractBatch(text, { [slotDef.key || slotDef.name]: slotDef })
    return slots[slotDef.key || slotDef.name] || null
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      const resp = await fetch(`${this.baseUrl}/health`)
      if (resp.ok) {
        const data = await resp.json()
        console.log('[NER] 服务正常:', data.model)
        this.enabled = true
        return true
      }
    } catch (e) {
      console.warn('[NER] 服务不可用')
    }
    this.enabled = false
    return false
  }
}

// 单例
const nerClient = new NERClient()

export default nerClient
