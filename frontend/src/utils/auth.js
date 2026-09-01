/**
 * 前端认证工具
 * 
 * - token 存取（localStorage）
 * - 登录/登出方法
 */

const TOKEN_KEY = 'faq_admin_token'

/** 获取 token */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

/** 设置 token */
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}

/** 清除 token */
export function removeToken() {
  localStorage.removeItem(TOKEN_KEY)
}

/** 是否已登录 */
export function isLoggedIn() {
  return !!getToken()
}

/** 登录 */
export async function login(username, password) {
  // 登录接口不需要 token，直接用原生 fetch
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(r => r.json())
  if (res.token) {
    setToken(res.token)
    return res
  }
  throw new Error(res.message || '登录失败')
}

/** 登出 */
export function logout() {
  removeToken()
}
