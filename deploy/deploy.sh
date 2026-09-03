#!/bin/bash
# ============================================================
# FAQ 智能问答机器人 - 一键部署脚本
#
# 使用方法:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# 前提条件:
#   - Docker 已安装并运行
#   - MySQL 5.7+ 或 8.0 已准备好
#   - faq-bot-v5.0.tar 镜像文件在当前目录
# ============================================================

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo ""
echo "=========================================="
echo "  FAQ 智能问答机器人 v5.0 - 部署脚本"
echo "=========================================="
echo ""

# ---------- 1. 检查 Docker ----------
echo -e "${YELLOW}[1/6] 检查 Docker 环境...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker 未安装，请先安装 Docker${NC}"
    echo "   安装指南: https://docs.docker.com/engine/install/"
    exit 1
fi
echo -e "${GREEN}   ✅ Docker 已安装: $(docker --version)${NC}"

# ---------- 2. 检查镜像文件 ----------
echo -e "${YELLOW}[2/6] 检查镜像文件...${NC}"
IMAGE_FILE="faq-bot-v5.0.tar"
if [ ! -f "$IMAGE_FILE" ]; then
    echo -e "${RED}❌ 未找到 $IMAGE_FILE${NC}"
    echo "   请将镜像文件放在当前目录"
    exit 1
fi
echo -e "${GREEN}   ✅ 镜像文件存在 ($(du -h $IMAGE_FILE | cut -f1))${NC}"

# ---------- 3. 加载镜像 ----------
echo -e "${YELLOW}[3/6] 加载 Docker 镜像...${NC}"
docker load -i "$IMAGE_FILE"
echo -e "${GREEN}   ✅ 镜像加载完成${NC}"

# ---------- 4. 配置 .env ----------
echo -e "${YELLOW}[4/6] 检查环境配置...${NC}"
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo -e "${YELLOW}   ⚠️  已从 .env.example 创建 .env${NC}"
        echo -e "${YELLOW}   ⚠️  请编辑 .env 文件，填入实际配置后重新运行此脚本${NC}"
        echo ""
        echo "   必须修改的配置项:"
        echo "   - DB_HOST: 数据库地址"
        echo "   - DB_PASSWORD: 数据库密码"
        echo "   - JWT_SECRET: JWT 签名密钥（随机字符串）"
        echo "   - ADMIN_PASS: 管理员密码"
        echo ""
        exit 0
    else
        echo -e "${RED}❌ 未找到 .env.example${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}   ✅ .env 配置文件已存在${NC}"
fi

# ---------- 5. 初始化数据库（可选）----------
echo -e "${YELLOW}[5/6] 数据库初始化（跳过，请确保已手动执行 init.sql）${NC}"
echo "   如未初始化数据库，请执行:"
echo "   mysql -h <DB_HOST> -u <DB_USER> -p < init.sql"

# ---------- 6. 启动服务 ----------
echo -e "${YELLOW}[6/6] 启动服务...${NC}"

# 停止旧容器（如果存在）
if docker ps -a --format '{{.Names}}' | grep -q "^faq-bot$"; then
    echo "   停止旧容器..."
    docker stop faq-bot 2>/dev/null || true
    docker rm faq-bot 2>/dev/null || true
fi

# 创建 uploads 目录
mkdir -p uploads

# 使用 docker-compose 启动
if command -v docker-compose &> /dev/null; then
    docker-compose up -d
elif docker compose version &> /dev/null; then
    docker compose up -d
else
    # 回退到 docker run
    echo "   使用 docker run 启动..."
    docker run -d \
        --name faq-bot \
        --restart always \
        -p 3001:3001 \
        --env-file .env \
        -v $(pwd)/uploads:/app/uploads \
        faq-bot:v5.0
fi

echo -e "${GREEN}   ✅ 服务已启动${NC}"

# ---------- 验证 ----------
echo ""
echo -e "${YELLOW}等待服务启动...${NC}"
sleep 5

# 健康检查
if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
    HEALTH=$(curl -s http://localhost:3001/api/health)
    echo -e "${GREEN}✅ 服务启动成功！${NC}"
    echo ""
    echo "📊 健康检查: $HEALTH"
    echo ""
    echo "🌐 访问地址: http://localhost:3001"
    echo "🔧 管理后台: http://localhost:3001/admin"
    echo ""
    echo "📝 查看日志: docker logs -f faq-bot"
    echo "🔄 重启服务: docker restart faq-bot"
    echo "🛑 停止服务: docker stop faq-bot"
else
    echo -e "${YELLOW}⚠️  服务可能还在启动中，请稍等几秒后检查:${NC}"
    echo "   docker logs faq-bot"
    echo "   curl http://localhost:3001/api/health"
fi

echo ""
echo "=========================================="
echo -e "${GREEN}  部署完成！${NC}"
echo "=========================================="
echo ""
