/**
 * 轻量安全表达式引擎（动作系统 v3 P2 判断能力）
 *
 * 用于分支条件 / 编排分支的表达式判断（source:'expr'）。
 * 安全实现：词法分析 + 递归下降解析 + AST 求值，**不使用 eval/Function**（防注入）。
 *
 * 支持：
 *   数字 123 / 1.5；字符串 'a' "b"；布尔 true/false；null
 *   变量：标识符 + 点路径（如 slot.phone、result.orderStatus、var.amount）
 *   算术：+ - * / %；比较：== != > >= < <=；逻辑：&& || !；括号 ( )
 *
 * 用法：evalExpr('slot.amount > 100 && result.status == "已受理"', env)
 *   env = { slot: {...}, var: {...}, result: {...} }
 */

// ========== 词法分析 ==========

function tokenize(src) {
  const tokens = []
  let i = 0
  const s = String(src || '')
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch)) { i++; continue }
    // 数字
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let j = i
      while (j < s.length && /[0-9.]/.test(s[j])) j++
      const num = s.slice(i, j)
      if (!/^\d+(\.\d+)?$/.test(num)) throw new Error(`非法数字: ${num}`)
      tokens.push({ type: 'num', value: parseFloat(num) })
      i = j
      continue
    }
    // 字符串
    if (ch === "'" || ch === '"') {
      let j = i + 1
      let str = ''
      while (j < s.length && s[j] !== ch) {
        if (s[j] === '\\' && j + 1 < s.length) { str += s[j + 1]; j += 2; continue }
        str += s[j]; j++
      }
      if (s[j] !== ch) throw new Error('字符串未闭合')
      tokens.push({ type: 'str', value: str })
      i = j + 1
      continue
    }
    // 标识符/点路径
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++
      let ident = s.slice(i, j)
      // 点路径：a.b.c
      while (s[j] === '.' && /[A-Za-z0-9_$]/.test(s[j + 1] || '')) {
        j++
        let k = j
        while (k < s.length && /[A-Za-z0-9_$]/.test(s[k])) k++
        ident += '.' + s.slice(j, k)
        j = k
      }
      tokens.push({ type: 'ident', value: ident })
      i = j
      continue
    }
    // 多字符运算符
    const two = s.slice(i, i + 2)
    if (two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '&&' || two === '||') {
      tokens.push({ type: 'op', value: two })
      i += 2
      continue
    }
    if ('+-*/%><!()'.includes(ch)) {
      tokens.push({ type: 'op', value: ch })
      i++
      continue
    }
    throw new Error(`无法识别的字符: ${ch}`)
  }
  tokens.push({ type: 'eof', value: '' })
  return tokens
}

// ========== 解析（递归下降） ==========

class Parser {
  constructor(tokens) {
    this.tokens = tokens
    this.pos = 0
  }
  peek() { return this.tokens[this.pos] }
  next() { return this.tokens[this.pos++] }
  expectOp(op) {
    const t = this.next()
    if (t.type !== 'op' || t.value !== op) throw new Error(`期望 ${op}`)
  }
  // expression → or
  parse() { const e = this.parseOr(); const t = this.peek(); if (t.type !== 'eof') throw new Error(`多余内容: ${t.value}`); return e }
  parseOr() {
    let left = this.parseAnd()
    while (this.peek().type === 'op' && this.peek().value === '||') {
      this.next()
      const right = this.parseAnd()
      left = { type: 'or', left, right }
    }
    return left
  }
  parseAnd() {
    let left = this.parseNot()
    while (this.peek().type === 'op' && this.peek().value === '&&') {
      this.next()
      const right = this.parseNot()
      left = { type: 'and', left, right }
    }
    return left
  }
  parseNot() {
    if (this.peek().type === 'op' && this.peek().value === '!') {
      this.next()
      return { type: 'not', arg: this.parseNot() }
    }
    return this.parseCompare()
  }
  parseCompare() {
    let left = this.parseAdd()
    while (this.peek().type === 'op' && ['==', '!=', '>', '>=', '<', '<='].includes(this.peek().value)) {
      const op = this.next().value
      const right = this.parseAdd()
      left = { type: 'compare', op, left, right }
    }
    return left
  }
  parseAdd() {
    let left = this.parseMul()
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value
      const right = this.parseMul()
      left = { type: 'arith', op, left, right }
    }
    return left
  }
  parseMul() {
    let left = this.parseUnary()
    while (this.peek().type === 'op' && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.next().value
      const right = this.parseUnary()
      left = { type: 'arith', op, left, right }
    }
    return left
  }
  parseUnary() {
    if (this.peek().type === 'op' && this.peek().value === '-') {
      this.next()
      return { type: 'neg', arg: this.parseUnary() }
    }
    return this.parsePrimary()
  }
  parsePrimary() {
    const t = this.next()
    if (t.type === 'num') return { type: 'num', value: t.value }
    if (t.type === 'str') return { type: 'str', value: t.value }
    if (t.type === 'ident') {
      if (t.value === 'true') return { type: 'bool', value: true }
      if (t.value === 'false') return { type: 'bool', value: false }
      if (t.value === 'null') return { type: 'null' }
      return { type: 'var', path: t.value.split('.') }
    }
    if (t.type === 'op' && t.value === '(') {
      const e = this.parseOr()
      this.expectOp(')')
      return e
    }
    throw new Error(`意外的 token: ${t.value || t.type}`)
  }
}

// ========== 求值 ==========

function getPath(env, path) {
  let cur = env
  for (const k of path) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[k]
  }
  return cur
}

function toNumber(v) {
  if (typeof v === 'number') return v
  const n = parseFloat(v)
  return Number.isNaN(n) ? NaN : n
}

function evalNode(node, env) {
  switch (node.type) {
    case 'num': return node.value
    case 'str': return node.value
    case 'bool': return node.value
    case 'null': return null
    case 'var': return getPath(env, node.path)
    case 'neg': return -toNumber(evalNode(node.arg, env))
    case 'not': return !truthy(evalNode(node.arg, env))
    case 'and': return truthy(evalNode(node.left, env)) && truthy(evalNode(node.right, env))
    case 'or': return truthy(evalNode(node.left, env)) || truthy(evalNode(node.right, env))
    case 'arith': {
      const a = toNumber(evalNode(node.left, env))
      const b = toNumber(evalNode(node.right, env))
      switch (node.op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        case '/': return b === 0 ? NaN : a / b
        case '%': return b === 0 ? NaN : a % b
      }
      return NaN
    }
    case 'compare': {
      const a = evalNode(node.left, env)
      const b = evalNode(node.right, env)
      switch (node.op) {
        case '==': return looseEq(a, b)
        case '!=': return !looseEq(a, b)
        case '>': return toNumber(a) > toNumber(b)
        case '>=': return toNumber(a) >= toNumber(b)
        case '<': return toNumber(a) < toNumber(b)
        case '<=': return toNumber(a) <= toNumber(b)
      }
      return false
    }
  }
  return null
}

function looseEq(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined || b === '' || b === 'null' || b === 'undefined'
  if (typeof a === 'number' || typeof b === 'number') {
    const na = toNumber(a), nb = toNumber(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb
  }
  return String(a) === String(b)
}

function truthy(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v !== '' && v !== 'false' && v !== 'null'
  return !!v
}

/** 求值表达式；失败返回 null（调用方决定兜底） */
export function evalExpr(src, env = {}) {
  try {
    const ast = new Parser(tokenize(src)).parse()
    return evalNode(ast, env)
  } catch (e) {
    return null
  }
}

export default { evalExpr }
