/**
 * 全局错误处理中间件
 * 
 * 统一捕获所有未处理异常，返回标准 JSON 格式
 * 开发环境返回堆栈信息，生产环境只返回错误消息
 */

/**
 * 异步路由包装器 —— 消除路由中重复的 try/catch
 * 用法: router.get('/path', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/**
 * 全局错误处理中间件（必须注册在所有路由之后）
 */
export function errorHandler(err, req, res, _next) {
  // 日志记录
  console.error(`[ERROR] ${req.method} ${req.url}:`, err.message)

  // 状态码
  const status = err.statusCode || err.status || 500

  // 响应体
  const body = {
    success: false,
    message: err.message || '服务器内部错误',
  }

  // 开发环境返回堆栈信息
  if (process.env.NODE_ENV !== 'production') {
    body.stack = err.stack
  }

  res.status(status).json(body)
}

/**
 * 404 处理中间件
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: `接口不存在: ${req.method} ${req.url}`,
  })
}
