/**
 * LLM 提示词注册表（运营配置，管理后台可编辑）
 *
 * 设计原则（松耦合：运营配置与底层逻辑分离）：
 *   - 所有 LLM 调用点的提示词集中在此定义，默认值内置兜底（不配置也能跑）
 *   - 运营在管理后台「LLM 智能层」页面覆盖提示词，存 sys_config（键 llm_prompt.<环节>.<部分>）
 *   - 底层逻辑只负责"取模板 + 填占位符 + 调 LLM"，不写业务文案
 *
 * 用法：
 *   await initPrompts()           启动时加载（幂等）
 *   get('extract_slots.user', {taskName, slotDesc, text})  取模板并填充占位符
 *   getAll()                      返回全部调用点（含默认值/是否自定义/占位符说明）
 *   updatePrompts({key: value})   保存自定义提示词（空值=恢复默认）
 */

import * as configRepo from '../repositories/configRepo.js'

/**
 * 提示词定义表
 * key: 环节.部分
 *   default:    内置默认值（兜底）
 *   name:       管理后台显示名
 *   desc:       用途说明
 *   placeholders: 模板占位符（管理后台提示用）
 */
const PROMPT_DEFS = {
  'extract_slots.system': {
    name: '槽位提取 · 系统提示词',
    desc: '指导 LLM 如何从用户话术中提取槽位（含枚举归一化、不编造约束）',
    default: '你是客服信息提取助手。只根据用户话术提取指定字段，返回严格 JSON 对象，不要任何解释、前后缀或 markdown 代码块。提取不到的字段不要出现。如果用户输入中没有明确提供某个字段的信息，绝对不要编造，也不要重复用户输入的整句话作为字段值——该字段直接省略。枚举字段（可选值已列出）请把用户说法映射到最接近的选项，无法归类时选"其他"，绝不编造选项之外的值。',
  },
  'extract_slots.user': {
    name: '槽位提取 · 用户模板',
    desc: '每次提取时发给 LLM 的用户消息模板，{占位符} 由系统填充',
    placeholders: ['taskName', 'examples', 'slotDesc', 'filledDesc', 'text'],
    default: '任务：{taskName}{examples}\n需提取字段：{slotDesc}\n{filledDesc}用户输入："{text}"\n请返回 JSON：',
  },
  'judge_trigger.system': {
    name: '触发判定 · 系统提示词',
    desc: '判断用户输入是否意图办理某个业务任务（而非咨询/闲聊）',
    default: '你是客服意图判定器。判断用户输入是否意图办理某个业务任务（而非单纯咨询/闲聊）。只返回任务 code 或 null，不要任何其他文字。',
  },
  'judge_trigger.user': {
    name: '触发判定 · 用户模板',
    placeholders: ['taskDesc', 'text'],
    default: '可选任务：\n{taskDesc}\n用户输入："{text}"\n请返回触发的任务 code（未触发返回 null）：',
  },
  'llm_rerank.system': {
    name: 'FAQ 意图重排 · 系统提示词',
    desc: 'FAQ 置信度低时，从 top-5 候选意图中选出最符合用户问题的',
    default: '你是客服意图判定器。从候选列表中选出最符合用户问题的那个，只返回数字序号，不要其他文字。',
  },
  'llm_rerank.user': {
    name: 'FAQ 意图重排 · 用户模板',
    placeholders: ['list', 'text'],
    default: '候选：\n{list}\n用户问题："{text}"\n请返回序号：',
  },
  'faq_answer.system': {
    name: 'FAQ 兜底回答 · 系统提示词',
    desc: '知识库未命中时，作为智能客服生成回答',
    default: '你是一个智能客服助手，请根据用户的问题提供准确、友好的回答。',
  },
  'meaningless.system': {
    name: '无意义判断 · 系统提示词',
    desc: '判断用户输入是否是有意义的咨询问题（llm 无意义模式启用时）',
    default: '你是一个对话质量判断器。判断用户输入是否是有意义的咨询问题（不是闲聊、语气词、无意义输入）。只返回 true 或 false，不要其他内容。',
  },
}

/** 当前生效的提示词缓存（key -> value，DB 覆盖后与默认值合并） */
let cache = null
let initPromise = null

/** 从数据库加载自定义提示词（幂等，可多次调用） */
export function initPrompts() {
  if (!initPromise) {
    initPromise = (async () => {
      cache = {}
      let db = {}
      try {
        db = await configRepo.getAll()
      } catch (e) {
        console.warn('[PromptRegistry] 配置读取失败，使用默认提示词:', e.message)
      }
      for (const key of Object.keys(PROMPT_DEFS)) {
        cache[key] = db['llm_prompt.' + key] || PROMPT_DEFS[key].default
      }
    })()
  }
  return initPromise
}

/** 取模板并填充占位符（未加载时先用默认值，不阻塞） */
export function get(key, vars = {}) {
  if (!cache) {
    // 未初始化：直接用默认值（启动早期兜底）
    return _fill(PROMPT_DEFS[key]?.default || '', vars)
  }
  return _fill((cache[key] ?? PROMPT_DEFS[key]?.default) || '', vars)
}

/** 返回全部调用点（供管理后台展示与编辑） */
export async function getAll() {
  await initPrompts()
  return Object.entries(PROMPT_DEFS).map(([key, def]) => ({
    key,
    name: def.name,
    desc: def.desc || '',
    placeholders: def.placeholders || [],
    value: cache[key],
    default: def.default,
    isCustom: cache[key] !== def.default,
  }))
}

/**
 * 保存自定义提示词
 * @param {Object} prompts - { key: value }；value 为空字符串/null 表示恢复默认
 */
export async function updatePrompts(prompts) {
  await initPrompts()
  for (const [key, value] of Object.entries(prompts)) {
    if (!PROMPT_DEFS[key]) continue
    if (value === null || value === '' || value === undefined) {
      try { await configRepo.remove(['llm_prompt.' + key]) } catch { /* ignore */ }
      cache[key] = PROMPT_DEFS[key].default
    } else {
      await configRepo.set('llm_prompt.' + key, String(value))
      cache[key] = String(value)
    }
  }
}

/** 填充占位符 {xxx} */
function _fill(template, vars) {
  let t = template
  for (const [k, v] of Object.entries(vars || {})) {
    t = t.split(`{${k}}`).join(v ?? '')
  }
  return t
}

export default { initPrompts, get, getAll, updatePrompts }
