/**
 * 取消关键词注册表（运营可配）
 *
 * 职责：任务取消触发词列表。
 * 存储：sys_config 表 `cancel_words` 键（JSON 数组），管理后台编辑。
 * 默认值仅在系统未配置时兜底（启动时若库中无该键会自动落库）。
 */

export const DEFAULT_CANCEL_WORDS = ['取消', '算了', '不办了', '不需要了', '退出', '停止', '不弄了', '放弃', '不用了']

/** 当前生效词表（内存态） */
let current = [...DEFAULT_CANCEL_WORDS]

/** 从 sys_config 初始化（server.js 启动时调用） */
export function initCancelWords(dbConfig = {}) {
  if (dbConfig.cancel_words) {
    try {
      const parsed = JSON.parse(dbConfig.cancel_words)
      if (Array.isArray(parsed) && parsed.length) {
        current = parsed
      }
    } catch (e) {
      console.warn('[CancelWords] 解析 cancel_words 失败，使用默认值:', e.message)
    }
  }
}

/** 热更新（管理后台保存后调用） */
export function setCancelWords(arr) {
  if (Array.isArray(arr) && arr.length) {
    current = arr
  }
}

/** 获取全部取消词（管理后台编辑用） */
export function getAllCancelWords() {
  return [...current]
}

/** 检测文本是否命中取消词 */
export function isCancelText(text) {
  const t = (text || '').trim()
  return current.some(w => t.includes(w))
}
