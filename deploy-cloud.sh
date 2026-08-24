#!/bin/bash
# FAQ 机器人云端增量构建 & 部署脚本
# 用法: ./deploy-cloud.sh v2.01

set -e

VERSION=$1
REGISTRY="localhost:5001"
IMAGE="faq-bot"
WORK_DIR="/tmp/faq-bot-${VERSION}"

if [ -z "$VERSION" ]; then
    echo "❌ 请指定版本号"
    echo "用法: $0 v2.01"
    exit 1
fi

echo ""
echo "========================================"
echo "  FAQ 机器人云端部署脚本"
echo "========================================"
echo ""
echo "📦 版本: ${VERSION}"
echo "🏗️  工作目录: ${WORK_DIR}"
echo ""

# 检查工作目录
if [ ! -d "$WORK_DIR" ]; then
    echo "❌ 工作目录不存在: $WORK_DIR"
    echo "请先上传 delta 包并解压到 $WORK_DIR"
    exit 1
fi

cd "$WORK_DIR"

# 检查必要文件
if [ ! -f "server.js" ]; then
    echo "❌ 缺少 server.js，请确认 delta 包已正确解压"
    exit 1
fi

echo "✅ 文件检查通过"
echo ""

# 创建增量 Dockerfile
echo "🔧 创建增量 Dockerfile..."
cat > Dockerfile.delta << EOF
FROM ${REGISTRY}/${IMAGE}:v2.0

# 复制 ${VERSION} 变更的文件
COPY server.js faq-engine.js db.js ecosystem.config.js .env.example /app/
COPY src/ /app/src/
COPY config/ /app/config/
COPY db/ /app/db/
COPY middleware/ /app/middleware/
COPY repositories/ /app/repositories/
COPY routes/ /app/routes/
COPY rules/ /app/rules/
COPY scripts/ /app/scripts/
COPY services/ /app/services/
COPY public/ /app/public/

LABEL version="${VERSION}"
EOF

echo "✅ Dockerfile.delta 创建完成"
echo ""

# 构建镜像
echo "🔨 构建镜像: ${REGISTRY}/${IMAGE}:${VERSION}"
docker build -f Dockerfile.delta -t ${REGISTRY}/${IMAGE}:${VERSION} .

if [ $? -ne 0 ]; then
    echo "❌ 构建失败"
    exit 1
fi

echo "✅ 构建成功"
echo ""

# 推送到 Registry
echo "📤 推送到 Registry..."
docker push ${REGISTRY}/${IMAGE}:${VERSION}

if [ $? -ne 0 ]; then
    echo "❌ 推送失败"
    exit 1
fi

echo "✅ 推送成功"
echo ""

# 停止旧容器
echo "🔄 停止旧容器..."
docker stop faq-bot 2>/dev/null || true
docker rm faq-bot 2>/dev/null || true

echo "✅ 旧容器已清理"
echo ""

# 启动新容器
echo "🚀 启动新容器..."
docker run -d \
  --name faq-bot \
  -p 3001:3001 \
  -e DB_HOST=rm-bp11ucz7dz696m6w5zo.mysql.rds.aliyuncs.com \
  -e DB_USER=aibot \
  -e DB_PASSWORD=myegoo@3466 \
  -e DB_NAME=faqdb \
  -v /data/faq-bot/uploads:/app/uploads \
  --restart unless-stopped \
  ${REGISTRY}/${IMAGE}:${VERSION}

if [ $? -ne 0 ]; then
    echo "❌ 启动失败"
    exit 1
fi

echo "✅ 容器启动成功"
echo ""

# 等待启动
echo "⏳ 等待服务启动..."
sleep 3

# 验证
echo ""
echo "========================================"
echo "  ✅ 部署完成！"
echo "========================================"
echo ""
echo "📊 容器状态:"
docker ps | grep faq-bot
echo ""
echo "📝 最近日志:"
docker logs --tail 10 faq-bot
echo ""
echo "🌐 访问地址: http://47.102.129.76:3001"
echo ""
echo "💡 常用命令:"
echo "   查看日志: docker logs -f faq-bot"
echo "   重启服务: docker restart faq-bot"
echo "   停止服务: docker stop faq-bot"
echo ""
