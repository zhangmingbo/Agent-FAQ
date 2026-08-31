/**
 * 否定句防护词表（运营可配）
 *
 * 职责：任务触发前的否定句检测（"我没说要换表啊"、"不用换滤芯"不触发任务）。
 * 存储：sys_config 表 `negation_words` 键（JSON 对象 { negWords, symptomWords, intentVerbs }），管理后台编辑。
 * 默认值仅在系统未配置时兜底（启动时若库中无该键会自动落库）。
 *
 * 匹配规则（与旧版硬编码正则等价，现由词表动态生成）：
 *   1) 紧贴模式：没(有)?(症状词)      —— "没坏 / 没问题 / 没必要"
 *   2) 间隔模式：(否定词)[^标点]{0,4}(业务意图动词) —— "不用换滤芯 / 不想预约 / 别安排了"
 */

/** 否定词（间隔模式前缀） */
export const DEFAULT_NEGATION_WORDS = ['没', '不', '别', '无需', '不用', '不是', '不要', '不想', '没说', '没要', '没有', '没必要']

/** 症状/状态词（紧贴模式，仅"没(有)?"前缀） */
export const DEFAULT_SYMPTOM_WORDS = ['坏', '问题', '故障', '事', '毛病', '必要']

/** 业务意图动词（间隔模式后缀：否定词 + 0~4 个任意字符 + 本词） */
export const DEFAULT_INTENT_VERBS = ['要', '说', '想', '打算', '预约', '办理', '申请', '安排', '换', '装', '修', '拆', '移', '检测', '保养', '报修', '上门']

/** 当前生效词表（内存态） */
let current = {
  negWords: [...DEFAULT_NEGATION_WORDS],
  symptomWords: [...DEFAULT_SYMPTOM_WORDS],
  intentVerbs: [...DEFAULT_INTENT_VERBS],
}

/** 当前编译好的否定正则（词表更新时重建） */
let compiledRe = null

/** 由词表重建否定正则 */
function buildRe() {
  const esc = (arr) => (arr || []).filter(w => typeof w === 'string' && w).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const sym = esc(current.symptomWords)
  const neg = esc(current.negWords)
  const verb = esc(current.intentVerbs)
  // 与旧版两套正则（NEGATION_RE + _isNegation）合并等价：
  //   紧贴：没(有)?(症状词)         （含"没必要"→ 症状词含"必要"）
  //   间隔：(否定词)[^标点]{0,4}(业务动词)
  compiledRe = new RegExp(`(没(有)?(${sym})|(${neg})[^，。！？!?、]{0,4}(${verb}))`)
}

/** 从 sys_config 初始化（server.js 启动时调用） */
export function initNegationWords(dbConfig = {}) {
  if (dbConfig.negation_words) {
    try {
      const parsed = JSON.parse(dbConfig.negation_words)
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.negWords) && parsed.negWords.length) current.negWords = parsed.negWords
        if (Array.isArray(parsed.symptomWords) && parsed.symptomWords.length) current.symptomWords = parsed.symptomWords
        if (Array.isArray(parsed.intentVerbs) && parsed.intentVerbs.length) current.intentVerbs = parsed.intentVerbs
      }
    } catch (e) {
      console.warn('[NegationWords] 解析 negation_words 失败，使用默认值:', e.message)
    }
  }
  buildRe()
}

/** 热更新（管理后台保存后调用） */
export function setNegationWords(obj = {}) {
  if (Array.isArray(obj.negWords) && obj.negWords.length) current.negWords = obj.negWords
  if (Array.isArray(obj.symptomWords) && obj.symptomWords.length) current.symptomWords = obj.symptomWords
  if (Array.isArray(obj.intentVerbs) && obj.intentVerbs.length) current.intentVerbs = obj.intentVerbs
  buildRe()
}

/** 获取全部词表（管理后台编辑用） */
export function getAllNegationWords() {
  return {
    negWords: [...current.negWords],
    symptomWords: [...current.symptomWords],
    intentVerbs: [...current.intentVerbs],
  }
}

/** 检测文本是否是否定句（内部转小写） */
export function isNegation(text) {
  if (!compiledRe) buildRe()
  const t = (text || '').trim().toLowerCase()
  if (!t) return false
  return compiledRe.test(t)
}
