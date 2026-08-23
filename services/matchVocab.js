/**
 * 匹配词表注册表（运营可配）
 *
 * 职责：触发词近义扩展表 + 路由澄清关键词表（"办理/咨询"）。
 * 存储：sys_config 表 `match_vocab` 键（JSON），管理后台「固定话术」分区编辑。
 * 默认值仅在系统未配置时兜底（启动时若库中无该键会自动落库）。
 */

export const DEFAULT_MATCH_VOCAB = {
  // 触发词近义扩展表（确定性模糊匹配，覆盖口语化表达）
  triggerSynonyms: {
    '报修': ['报修', '维修', '修理', '修一下', '坏了', '故障', '出问题', '出毛病', '异常', '失灵', '不工作', '有问题', '报修单'],
    '维修': ['维修', '修理', '修一下', '报修', '坏了', '故障', '出问题', '出毛病', '异常', '失灵', '不工作', '找人修', '来修'],
    '坏了': ['坏了', '故障', '出问题', '出毛病', '异常', '失灵', '不工作', '不动了', '不走', '不准', '有问题', '坏了'],
    '故障': ['故障', '坏了', '出问题', '出毛病', '异常', '失灵', '不工作', '有问题', '故障'],
    '修': ['修', '维修', '修理', '修一下', '找人修', '来修', '维修一下'],
    '安装': ['安装', '装', '预约', '上门', '约时间', '装机', '装一下'],
    '预约': ['预约', '约', '预约上门', '上门', '约个时间'],
    '上门': ['上门', '上门服务', '到家里', '来家里'],
    '开通': ['开通', '开户', '新装', '办新'],
    '注销': ['注销', '销户', '停用', '拆除'],
    '查询': ['查询', '查一下', '看看', '帮我查'],
    '缴费': ['缴费', '交费', '充值', '付款', '付费'],
    '报装': ['报装', '申请安装', '预约安装'],
  },
  // 路由澄清：用户回复"办理还是咨询"时的关键词（数字选项 1/2 固定）
  routeChoiceTask: ['办理', '预约', '要办', '想办', '登记', '办业务', '继续办理', '继续办', '申请', '办一下'],
  routeChoiceFaq: ['咨询', '了解', '问问', '查询', '不需要', '不用了', '其他', '别的', '不是', '算了', '看看'],
}

/** 当前生效词表（内存态） */
let current = {
  triggerSynonyms: { ...DEFAULT_MATCH_VOCAB.triggerSynonyms },
  routeChoiceTask: [...DEFAULT_MATCH_VOCAB.routeChoiceTask],
  routeChoiceFaq: [...DEFAULT_MATCH_VOCAB.routeChoiceFaq],
}

function _mergeInto(target, src) {
  if (!src || typeof src !== 'object') return
  if (src.triggerSynonyms && typeof src.triggerSynonyms === 'object') {
    for (const [k, v] of Object.entries(src.triggerSynonyms)) {
      if (Array.isArray(v)) target.triggerSynonyms[k] = v
    }
  }
  if (Array.isArray(src.routeChoiceTask) && src.routeChoiceTask.length) target.routeChoiceTask = src.routeChoiceTask
  if (Array.isArray(src.routeChoiceFaq) && src.routeChoiceFaq.length) target.routeChoiceFaq = src.routeChoiceFaq
}

/** 从 sys_config 初始化（server.js 启动时调用） */
export function initMatchVocab(dbConfig = {}) {
  if (dbConfig.match_vocab) {
    try {
      _mergeInto(current, JSON.parse(dbConfig.match_vocab))
    } catch (e) {
      console.warn('[MatchVocab] 解析 match_vocab 失败，使用默认值:', e.message)
    }
  }
}

/** 热更新（管理后台保存后调用） */
export function setMatchVocab(obj) {
  _mergeInto(current, obj)
}

/** 获取全部词表（管理后台编辑用） */
export function getAllMatchVocab() {
  return {
    triggerSynonyms: { ...current.triggerSynonyms },
    routeChoiceTask: [...current.routeChoiceTask],
    routeChoiceFaq: [...current.routeChoiceFaq],
  }
}

/** 触发词近义扩展表 */
export function getTriggerSynonyms() {
  return current.triggerSynonyms
}

/** 路由澄清关键词（办理/咨询） */
export function getRouteChoiceWords() {
  return { task: current.routeChoiceTask, faq: current.routeChoiceFaq }
}
