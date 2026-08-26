/**
 * 固定话术注册表（运营可配）
 *
 * 原则：所有用户可见的对话文案不允许硬编码在业务逻辑里，统一从这里取。
 * 存储：sys_config 表 `reply_texts` 键（JSON），管理后台「固定话术」分区编辑。
 * 默认值仅在系统未配置时兜底（启动时若库中无该键会自动落库，之后以库为准）。
 *
 * 模板语法：{变量名}，如 getReply('continue_task', { taskName: '预约上门服务', hint: '还需要：电话' })
 */

export const DEFAULT_REPLY_TEXTS = {
  // ===== 兜底 / 域外 =====
  domain_fallback: '我是净水器售后客服，主要帮您处理安装预约、滤芯更换、报修、费用咨询等净水器相关问题。您刚才的问题超出了我的服务范围～\n\n您可以试试：\n1. 描述具体的净水器问题（如"滤芯多久换"、"机器不出水"）\n2. 输入"转人工"联系人工客服',
  meaningless: '抱歉，我没有理解您的意思。您可以尝试描述您遇到的问题，或输入"转人工"联系人工客服。',
  no_answer: '抱歉，没有找到相关答案。',
  // 投诉情绪兜底：命中投诉词 → 安抚 + 转人工事件（运营可配 complaint_trigger_words 信号词）
  complaint_soothe: '非常抱歉给您带来不好的体验！您反映的问题我已记录并为您转接人工客服专员，请稍候～\n客服热线：400-123-4567',

  // ===== 澄清 / 进度 =====
  continue_task: '好的，我们继续「{taskName}」～{hint}',
  progress_needed: '还需要：{labels}',
  progress_all_filled: '信息已齐全，请确认',
  ask_business: '好的，请问您需要办理什么业务呢？',
  stashed_hint: '（您之前正在进行「{taskName}」，回复"继续"可接着办理）\n\n',
  suspended_hint: '\n\n———\n● 您正在进行「{taskName}」，回复"继续"可接着办理。',
  task_faq_progress: '\n\n———\n● 您正在进行「{taskName}」，还需要：{labels}',
  clarify_options: '您的问题可能属于以下几种，请回复序号（1/2/3）选择：\n{options}',
  clarify_yes_no: '您是想咨询"{intentName}"吗？请回复"是"或"不是"',
  route_clarify_repeat_prefix: '抱歉，我没有理解您的选择。\n',

  // ===== 任务对话（规则版） =====
  slot_prompt_fallback: '请提供{label}',
  modify_prompt: '好的，请告诉我新的{label}：',
  direct_input: '请直接输入新的{label}：',
  guidance_header: '目前还需要以下信息：\n',
  guidance_item: '  {label}：❓ 待提供\n',
  guidance_filled_hint: '\n您可以直接回复对应内容，或说"修改XX"来更改已填信息。',
  confirm_prompt: '请确认以上信息，回复"确认"提交，或说"修改XX"更正。',
  confirm_summary_header: '\n☑ 请确认以下信息：',
  confirm_summary_item: '  {label}：{value}',
  slot_updated: '好的，{label}已更新为「{value}」。\n',
  submitting: '好的，正在为您提交。\n',
  modify_reask: '好的，请重新提供需要修改的信息。\n',
  action_fail_rule: '操作未能完成：{message}\n您可以回复"重试"，或"取消"结束。',
  cancel_done: '好的，已为您取消操作。',

  // ===== 任务对话（LLM 版） =====
  modify_prompt_llm: '好的，请告诉我需要修改的内容。',
  action_fail_llm: '操作未能完成：{message}\n您可以回复"确认"重试，或回复"取消"。',
  complete_fallback: '已为您完成{taskName}。',
  // 动作承诺校验：LLM 在非完成轮次声称"已转接/已提交"等未执行动作时，追加的澄清
  claim_clarify_suffix: '\n（提醒：以上操作需要您确认后才会正式执行，目前尚未提交。）',

  // ===== 动作完成 =====
  repair_order_done: '已为您提交报修工单（单号 #{orderId}），我们会尽快处理。',
  transfer_human: '好的，正在为您转接人工客服，请稍候...\n客服热线：400-123-4567',
  meter_replace_done: '已为您登记换表申请（单号 #{orderId}），师傅会尽快联系您确认上门时间。',
  service_appointment_done: '已为您预约{serviceType}服务（单号 #{orderId}），售后会在24小时内联系您，请保持电话畅通。',
  // 任务「调用接口」完成动作的默认话术（任务里可配 successMessage 覆盖）
  api_action_done: '已为您提交成功。',
  api_action_fail: '提交失败，请稍后重试。',

  // ===== 槽位校验提示 =====
  validate_required: '请提供{label}',
  validate_len_min: '长度不能少于{n}个字符',
  validate_len_max: '长度不能超过{n}个字符',
  validate_number: '请输入数字',
  validate_phone: '请输入正确的11位手机号',
  validate_enum: '请输入：{options}',
  validate_format: '输入格式不正确',
}

/** 当前生效的话术（内存态，启动时从 sys_config 合并加载，保存即热更新） */
let current = { ...DEFAULT_REPLY_TEXTS }

function _mergeInto(target, src) {
  if (!src || typeof src !== 'object') return
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string' && v !== '') target[k] = v
  }
}

/** 从 sys_config 初始化（server.js 启动时调用） */
export function initReplyTexts(dbConfig = {}) {
  if (dbConfig.reply_texts) {
    try {
      _mergeInto(current, JSON.parse(dbConfig.reply_texts))
    } catch (e) {
      console.warn('[ReplyTexts] 解析 reply_texts 失败，使用默认值:', e.message)
    }
  }
}

/** 热更新（管理后台保存后调用） */
export function setReplyTexts(obj) {
  _mergeInto(current, obj)
}

/** 获取全部话术（管理后台编辑用） */
export function getAllReplyTexts() {
  return { ...current }
}

/** 取话术模板并做变量插值 */
export function getReply(key, vars = {}) {
  let tpl = current[key]
  if (tpl === undefined || tpl === null) tpl = DEFAULT_REPLY_TEXTS[key] ?? ''
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined || v === null) continue
    tpl = tpl.split(`{${k}}`).join(String(v))
  }
  return tpl
}
