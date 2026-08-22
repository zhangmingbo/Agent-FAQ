#!/bin/bash
# FAQ Bot 一键部署脚本
# 用法: chmod +x deploy.sh && ./deploy.sh

set -e

IMAGE_NAME="faq-bot"
CONTAINER_NAME="faq-bot"
IMAGE_FILE="faq-bot-image.tar"
PORT=3001

echo "=== 1. 加载镜像 ==="
docker load -i "$IMAGE_FILE"

echo "=== 2. 停止并删除旧容器 ==="
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

echo "=== 3. 启动新容器 ==="
docker run -d \
  --name "$CONTAINER_NAME" \
  -p ${PORT}:${PORT} \
  -v /app/uploads:/app/uploads \
  --restart unless-stopped \
  "$IMAGE_NAME:latest"

echo "=== 4. 检查状态 ==="
docker ps | grep "$CONTAINER_NAME"
echo ""
echo "部署完成！访问 http://localhost:${PORT}/admin/"
