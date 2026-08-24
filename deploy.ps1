# FAQ 机器人自动化发布脚本
# 用法: .\deploy.ps1 -Version "v2.1"

param(
    [Parameter(Mandatory=$true)]
    [string]$Version,
    
    [string]$Registry = "47.102.129.76:5001",  # 阿里云服务器
    [string]$ImageName = "faq-bot"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  FAQ 机器人发布脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 Git 状态
Write-Host "🔍 检查 Git 状态..." -ForegroundColor Yellow
$gitStatus = git status --porcelain
if ($gitStatus) {
    Write-Host "⚠️  有未提交的更改，请先提交或暂存：" -ForegroundColor Red
    Write-Host $gitStatus
    $continue = Read-Host "是否继续发布？(y/N)"
    if ($continue -ne 'y' -and $continue -ne 'Y') {
        Write-Host "❌ 发布取消" -ForegroundColor Red
        exit 1
    }
}

# 构建镜像
$fullImageName = "${Registry}/${ImageName}:${Version}"
Write-Host ""
Write-Host "🔨 构建镜像: $fullImageName" -ForegroundColor Yellow
docker build -t $fullImageName .
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 构建失败" -ForegroundColor Red
    exit 1
}
Write-Host "✅ 构建成功" -ForegroundColor Green

# 打 latest 标签
Write-Host ""
Write-Host "🏷️  打 latest 标签..." -ForegroundColor Yellow
docker tag $fullImageName "${Registry}/${ImageName}:latest"
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 打标签失败" -ForegroundColor Red
    exit 1
}
Write-Host "✅ 标签完成" -ForegroundColor Green

# 推送到 Registry
Write-Host ""
Write-Host "📤 推送到 Registry..." -ForegroundColor Yellow
Write-Host "   版本: $Version" -ForegroundColor Gray
Write-Host "   地址: $Registry" -ForegroundColor Gray
Write-Host ""

docker push $fullImageName
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 推送版本失败" -ForegroundColor Red
    exit 1
}

docker push "${Registry}/${ImageName}:latest"
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 推送 latest 失败" -ForegroundColor Red
    exit 1
}

Write-Host "✅ 推送完成" -ForegroundColor Green

# 显示下一步操作
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ✅ 发布成功！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "📝 下一步操作：" -ForegroundColor Yellow
Write-Host ""
Write-Host "1️⃣  SSH 到云服务器：" -ForegroundColor White
Write-Host "   ssh user@你的服务器IP" -ForegroundColor Gray
Write-Host ""
Write-Host "2️⃣  拉取新版本：" -ForegroundColor White
Write-Host "   docker pull localhost:5000/${ImageName}:${Version}" -ForegroundColor Gray
Write-Host ""
Write-Host "3️⃣  停止旧容器：" -ForegroundColor White
Write-Host "   docker stop faq-bot" -ForegroundColor Gray
Write-Host "   docker rm faq-bot" -ForegroundColor Gray
Write-Host ""
Write-Host "4️⃣  启动新容器：" -ForegroundColor White
Write-Host "   docker run -d \" -ForegroundColor Gray
Write-Host "     --name faq-bot \" -ForegroundColor Gray
Write-Host "     -p 3001:3001 \" -ForegroundColor Gray
Write-Host "     -e DB_HOST=你的数据库地址 \" -ForegroundColor Gray
Write-Host "     -e DB_USER=aibot \" -ForegroundColor Gray
Write-Host "     -e DB_PASSWORD=你的密码 \" -ForegroundColor Gray
Write-Host "     -e DB_NAME=faqdb \" -ForegroundColor Gray
Write-Host "     -v /data/faq-bot/uploads:/app/uploads \" -ForegroundColor Gray
Write-Host "     --restart unless-stopped \" -ForegroundColor Gray
Write-Host "     localhost:5000/${ImageName}:${Version}" -ForegroundColor Gray
Write-Host ""
Write-Host "5️⃣  验证部署：" -ForegroundColor White
Write-Host "   docker ps | grep faq-bot" -ForegroundColor Gray
Write-Host "   docker logs faq-bot" -ForegroundColor Gray
Write-Host ""

# 更新 Git 标签
Write-Host "🏷️  更新 Git 标签..." -ForegroundColor Yellow
git tag -f $Version
git push origin $Version --force
Write-Host "✅ Git 标签已更新" -ForegroundColor Green

Write-Host ""
Write-Host "🎉 发布流程完成！" -ForegroundColor Green
Write-Host ""
