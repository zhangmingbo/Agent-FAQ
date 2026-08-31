# NLP智能问答平台 - 前端启动脚本 (PowerShell)
# 使用前请确保：
# 1. 已安装 Node.js 18+

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  NLP智能问答平台 - 前端启动" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 进入前端目录
Set-Location $PSScriptRoot

# 检查 Node.js
try {
    $nodeVersion = node --version 2>&1
    Write-Host "[OK] Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] 未找到 Node.js，请先安装 Node.js 18+" -ForegroundColor Red
    exit 1
}

# 安装依赖
if (-not (Test-Path "node_modules")) {
    Write-Host "[INFO] 安装前端依赖..." -ForegroundColor Yellow
    npm install
}

# 启动开发服务器
Write-Host "[INFO] 启动前端开发服务器 http://localhost:3000" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
npm run dev
