/**
 * 渠道类型注册表（运营可配）
 *
 * 职责：管理聊天接入渠道列表。
 * 存储：sys_config 表 `channel_types` 键（JSON 数组），管理后台编辑。
 * 默认值仅在系统未配置时兜底。
 */

export const DEFAULT_CHANNEL_TYPES = [
  { value: 'web', label: '网页' },
  { value: 'wechat', label: '微信公众号' },
  { value: 'mp', label: '小程序' },
  { value: 'app', label: 'APP' },
  { value: 'api', label: 'API' },
]

/** 当前生效渠道列表（内存态） */
let current = [...DEFAULT_CHANNEL_TYPES]

/** 从 sys_config 初始化（server.js 启动时调用） */
export function initChannelTypes(dbConfig = {}) {
  if (dbConfig.channel_types) {
    try {
      const parsed = JSON.parse(dbConfig.channel_types)
      if (Array.isArray(parsed) && parsed.length) {
        current = parsed
      }
    } catch (e) {
      console.warn('[ChannelTypes] 解析 channel_types 失败，使用默认值:', e.message)
    }
  }
}

/** 热更新（管理后台保存后调用） */
export function setChannelTypes(arr) {
  if (Array.isArray(arr) && arr.length) {
    current = arr
  }
}

/** 获取全部渠道类型（管理后台编辑用） */
export function getAllChannelTypes() {
  return [...current]
}

/** 获取所有渠道 value 列表（校验用） */
export function getChannelValues() {
  return current.map(c => c.value)
}

/** 根据 value 获取 label */
export function getChannelLabel(value) {
  const ch = current.find(c => c.value === value)
  return ch ? ch.label : value
}
