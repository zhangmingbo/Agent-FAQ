/**
 * NER 客户端 - 调用 Python NER 服务 + 正则后处理
 * 支持动态管理 NER 实体类型（内置模型类型 + 用户自定义正则类型）
 */

import * as configRepo from '../../repositories/configRepo.js'

const NER_SERVICE_URL = process.env.NER_SERVICE_URL || 'http://127.0.0.1:8766'

// 内置 NER 模型类型（Python 服务原生识别）
const BUILTIN_TYPES = [
  { type: 'address', label: '地址', source: 'model', enabled: true, regex: '' },
  { type: 'name', label: '姓名', source: 'model', enabled: true, regex: '' },
  { type: 'company', label: '公司', source: 'model', enabled: true, regex: '' },
  { type: 'organization', label: '机构', source: 'model', enabled: true, regex: '' },
  { type: 'government', label: '政府机构', source: 'model', enabled: true, regex: '' },
  { type: 'position', label: '职位', source: 'model', enabled: true, regex: '' },
  { type: 'scene', label: '场景', source: 'model', enabled: true, regex: '' },
  { type: 'phone', label: '电话', source: 'model', enabled: true, regex: '' },
  { type: 'email', label: '邮箱', source: 'model', enabled: true, regex: '' },
  { type: 'date', label: '日期', source: 'model', enabled: true, regex: '' },
  { type: 'time', label: '时间', source: 'model', enabled: true, regex: '' },
]

// 内置类型映射（NER 标签 → 槽位 key）
const BUILTIN_TYPE_MAP = {
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
    // 用户自定义正则类型（运行时内存，从 DB 加载）
    this._customTypes = []
    // 合并后的完整类型列表
    this._allTypes = [...BUILTIN_TYPES]
    // 合并后的 TYPE_MAP
    this._typeMap = { ...BUILTIN_TYPE_MAP }
  }

  /**
   * 从 DB 加载用户自定义 NER 类型
   */
  async loadCustomTypes() {
    try {
      const raw = await configRepo.get('ner_types')
      if (raw) {
        this._customTypes = JSON.parse(raw)
      } else {
        this._customTypes = []
      }
    } catch (e) {
      console.warn('[NER] 加载自定义类型失败:', e.message)
      this._customTypes = []
    }
    this._rebuildAllTypes()
  }

  /**
   * 重建合并后的类型列表和 TYPE_MAP
   */
  _rebuildAllTypes() {
    // 合并：内置 + 自定义（自定义不覆盖内置同 type）
    const customEnabled = this._customTypes.filter(c => c.enabled !== false)
    this._allTypes = [...BUILTIN_TYPES, ...customEnabled]

    // 重建 TYPE_MAP：内置 + 自定义 regex 类型
    this._typeMap = { ...BUILTIN_TYPE_MAP }
    for (const ct of customEnabled) {
      if (ct.source === 'regex' && ct.regex) {
        this._typeMap[ct.type] = [ct.type]
      }
    }
  }

  /**
   * 获取完整 NER 类型列表（内置 + 自定义，含禁用的自定义类型供管理页展示）
   */
  getTypes() {
    return [...BUILTIN_TYPES, ...this._customTypes]
  }

  /**
   * 保存用户自定义 NER 类型并刷新内存
   */
  async setCustomTypes(types) {
    this._customTypes = types || []
    await configRepo.set('ner_types', JSON.stringify(this._customTypes))
    this._rebuildAllTypes()
  }

  /**
   * 正则后处理提取
   * @param {string} text - 用户输入
   * @returns {Object} entities - { type: [values] }
   */
  _regexExtract(text) {
    const entities = {}
    for (const ct of this._customTypes) {
      if (!ct.enabled || ct.source !== 'regex' || !ct.regex) continue
      try {
        const re = new RegExp(ct.regex, 'g')
        const matches = []
        let m
        while ((m = re.exec(text)) !== null) {
          matches.push(m[0])
          if (matches.length >= 5) break // 最多取 5 个
        }
        if (matches.length > 0) {
          entities[ct.type] = matches
        }
      } catch (e) {
        console.warn(`[NER] 正则 "${ct.type}" 解析失败:`, e.message)
      }
    }
    return entities
  }

  /**
   * 从文本中提取命名实体（模型 + 正则后处理）
   * @param {string} text - 用户输入
   * @returns {Promise<{entities: Object, raw: Array}>}
   */
  async extract(text) {
    if (!this.enabled || !text?.trim()) return { entities: {}, raw: [] }

    const trimmed = text.trim()
    let entities = {}
    let raw = []

    // 1. 调用 Python NER 模型服务
    try {
      const resp = await fetch(`${this.baseUrl}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      })

      if (resp.ok) {
        const data = await resp.json()
        entities = data.entities || {}
        raw = data.raw || []
      } else {
        console.warn('[NER] 模型请求失败:', resp.status)
      }
    } catch (e) {
      if (!this._healthChecked) {
        console.warn('[NER] 服务不可用，已降级:', e.message)
        this._healthChecked = true
      }
    }

    // 2. 正则后处理（补充模型未覆盖的类型）
    const regexEntities = this._regexExtract(trimmed)
    for (const [type, values] of Object.entries(regexEntities)) {
      if (!entities[type]) {
        entities[type] = values
      }
    }

    return { entities, raw }
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

    // 查找匹配的实体类型（动态 TYPE_MAP）
    const possibleTypes = this._typeMap[nerType] || [nerType]
    for (const type of possibleTypes) {
      const values = entities[type]
      if (values && values.length > 0) {
        return values[0]
      }
    }

    return null
  }

  /**
   * 用正则类型测试文本匹配
   * @param {string} text - 测试文本
   * @returns {Array} [{ type, label, matches }]
   */
  testRegex(text) {
    if (!text?.trim()) return []
    const trimmed = text.trim()
    const results = []
    for (const ct of this._customTypes) {
      if (ct.source !== 'regex' || !ct.regex) continue
      try {
        const re = new RegExp(ct.regex, 'g')
        const matches = []
        let m
        while ((m = re.exec(trimmed)) !== null) {
          matches.push(m[0])
          if (matches.length >= 10) break
        }
        results.push({ type: ct.type, label: ct.label, matches, enabled: ct.enabled !== false })
      } catch (e) {
        results.push({ type: ct.type, label: ct.label, matches: [], error: e.message, enabled: ct.enabled !== false })
      }
    }
    return results
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

const client = new NERClient()

// 启动时异步加载自定义类型
client.loadCustomTypes().catch(e => console.warn('[NER] 初始加载自定义类型失败:', e.message))

export default client

