/**
 * 共享 axios 实例
 * 
 * 所有 API 模块统一使用此实例，确保请求自动携带 token、401 自动跳转登录。
 */

import axios from 'axios'
import { getToken, removeToken } from './auth'

const http = axios.create({
  baseURL: '',
  timeout: 15000,
})

// 请求拦截器：自动附加 Authorization
http.interceptors.request.use(config => {
  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截器：401 自动跳转登录
http.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      removeToken()
      if (window.location.hash !== '#/login') {
        window.location.hash = '#/login'
      }
    }
    return Promise.reject(err)
  }
)

export default http
