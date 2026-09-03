# FAQ 智能问答机器人 v5.0 - 部署手册

## 目录

- [1. 概述](#1-概述)
- [2. 环境要求](#2-环境要求)
- [3. 部署包清单](#3-部署包清单)
- [4. 首次部署（全新环境）](#4-首次部署全新环境)
- [5. 镜像更新（已有旧版本）](#5-镜像更新已有旧版本)
- [6. 数据库表结构说明](#6-数据库表结构说明)
- [7. 系统配置说明](#7-系统配置说明)
- [8. 常用运维命令](#8-常用运维命令)
- [9. 故障排查](#9-故障排查)

---

## 1. 概述

FAQ 智能问答机器人是一个基于 Node.js 的智能客服系统，支持：

- **FAQ 知识库管理**：语义匹配、相似问扩展、分类管理
- **任务流程引擎**：多步骤任务编排、槽位提取、状态跟踪
- **多渠道接入**：Web / App / 小程序 / 钉钉等
- **运营管理**：聊天日志、数据分析、系统配置

**技术栈**：Node.js + Express + MySQL + Vue 3 + Docker

---

## 2. 环境要求

| 组件 | 最低版本 | 说明 |
|------|---------|------|
| Docker | 20.10+ | 容器运行时 |
| MySQL | 5.7+ / 8.0 | 数据库（本地或远程） |
| 内存 | 2GB+ | 语义模型占用约 400MB |
| 磁盘 | 2GB+ | 镜像约 700MB + 数据 |

**可选**：
- Docker Compose（推荐使用）
- Nginx（反向代理 / HTTPS）

---

## 3. 部署包清单

```
deploy/
├── README.md              # 本部署手册
├── init.sql               # 数据库初始化脚本（全量建表 + 默认配置）
├── .env.example           # 环境变量配置模板
├── docker-compose.yml     # Docker Compose 编排文件
├── deploy.sh              # 一键部署脚本（Linux）
└── faq-bot-v5.0.tar       # Docker 镜像文件（需单独准备）
```

**准备镜像文件**（在开发机上执行）：

```bash
# 导出镜像
docker save faq-bot:v5.0 -o faq-bot-v5.0.tar

# 将 tar 文件传到服务器
scp faq-bot-v5.0.tar root@your-server:/opt/deploy/
```

---

## 4. 首次部署（全新环境）

### 4.1 准备部署目录

```bash
# 创建部署目录
mkdir -p /opt/faq-bot
cd /opt/faq-bot

# 复制部署包文件到当前目录
# （确保 init.sql, .env.example, docker-compose.yml, deploy.sh, faq-bot-v5.0.tar 都在此目录）
```

### 4.2 初始化数据库

```bash
# 连接 MySQL
mysql -h <数据库地址> -u root -p

# 执行初始化脚本
source /opt/faq-bot/init.sql

# 验证
USE faqdb;
SHOW TABLES;
```

**预期输出**（12 张表）：

```
+-----------------+
| action_log      |
| answer_feedback |
| chat_log        |
| chat_session    |
| expand_audit    |
| faq             |
| faq_category    |
| faq_question    |
| suggest_cache   |
| sys_config      |
| task            |
| task_instance   |
+-----------------+
```

### 4.3 配置环境变量

```bash
# 复制配置模板
cp .env.example .env

# 编辑配置（必须修改以下项）
vi .env
```

**必须修改的配置**：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `DB_HOST` | 数据库地址 | `127.0.0.1` 或 RDS 地址 |
| `DB_PASSWORD` | 数据库密码 | `your_password` |
| `JWT_SECRET` | JWT 签名密钥（随机字符串） | `faq-bot-2024-secret-abc123` |
| `ADMIN_PASS` | 管理员登录密码 | `admin123` |

**完整配置说明**：

```ini
# 服务配置
PORT=3001                    # 服务端口
NODE_ENV=production          # 运行环境

# 数据库配置
DB_HOST=127.0.0.1           # 数据库地址
DB_PORT=3306                # 数据库端口
DB_USER=faqbot              # 数据库用户
DB_PASSWORD=xxx             # 数据库密码
DB_NAME=faqdb               # 数据库名称
DB_CONNECTION_LIMIT=10      # 连接池大小

# JWT 认证（必需）
JWT_SECRET=xxx              # 签名密钥，建议 32 位随机字符串
JWT_EXPIRES_IN=24h          # Token 有效期
ADMIN_USER=admin            # 管理员账号
ADMIN_PASS=xxx              # 管理员密码

# FAQ 引擎（可选，有默认值）
MIN_CONFIDENCE=0.5          # 最低匹配置信度
CLARIFY_THRESHOLD=0.65      # 追问确认阈值
TOP_K=5                     # 返回候选数量
```

### 4.4 一键部署

```bash
# 方式一：使用部署脚本（推荐）
chmod +x deploy.sh
./deploy.sh

# 方式二：手动执行
docker load -i faq-bot-v5.0.tar
mkdir -p uploads
docker-compose up -d
```

### 4.5 验证部署

```bash
# 查看容器状态
docker ps

# 查看日志
docker logs -f faq-bot

# 健康检查
curl http://localhost:3001/api/health
```

**预期响应**：

```json
{
  "status": "ok",
  "uptime": 42.5,
  "faqCount": 0,
  "database": "connected"
}
```

**访问地址**：

- 聊天界面：`http://your-server:3001`
- 管理后台：`http://your-server:3001/admin`
- 默认账号：`admin` / 你设置的 `ADMIN_PASS`

---

## 5. 镜像更新（已有旧版本）

### 5.1 增量更新流程

当只有前端/代码变更时，无需重新构建完整镜像：

```bash
# 1. 在开发机构建增量镜像（基于已有镜像，仅更新变更文件）
# Dockerfile.delta 示例：
#   FROM faq-bot:v5.0
#   COPY public/admin/ ./public/admin/
docker build -f Dockerfile.delta -t faq-bot:v5.0 .

# 2. 导出镜像
docker save faq-bot:v5.0 -o faq-bot-v5.0.tar

# 3. 传到服务器
scp faq-bot-v5.0.tar root@server:/opt/faq-bot/

# 4. 在服务器上更新
cd /opt/faq-bot
docker load -i faq-bot-v5.0.tar
docker stop faq-bot && docker rm faq-bot
docker-compose up -d
```

### 5.2 全量更新流程

当依赖或模型有变更时：

```bash
# 1. 在开发机构建完整镜像
docker build -t faq-bot:v5.0 .

# 2. 导出并传输
docker save faq-bot:v5.0 -o faq-bot-v5.0.tar
scp faq-bot-v5.0.tar root@server:/opt/faq-bot/

# 3. 在服务器上更新
cd /opt/faq-bot
docker load -i faq-bot-v5.0.tar
docker stop faq-bot && docker rm faq-bot
docker-compose up -d
```

### 5.3 数据库变更

如果新版本有数据库结构变更：

```bash
# 执行迁移脚本（幂等，可重复执行）
mysql -h <DB_HOST> -u <DB_USER> -p faqdb < migrate-vX.sql
```

> 注：v5.0 的迁移脚本为 `scripts/migrate-v5.js`，需在代码目录执行。

---

## 6. 数据库表结构说明

### 6.1 核心业务表

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `faq` | FAQ 知识库 | code, name, answer, rich_content, priority, category_id |
| `faq_question` | 相似问句 | faq_code, question, is_regex |
| `faq_category` | FAQ 分类 | name, code, parent_id, level |
| `chat_log` | 聊天日志 | session_id, channel_type, user_text, intent_code, confidence |
| `chat_session` | 会话持久化 | session_id, context_json, last_active |

### 6.2 任务流程表

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `task` | 任务定义 | code, name, steps, slots, trigger_keywords |
| `task_instance` | 任务实例 | session_id, task_code, status, slots, turn_count |
| `action_log` | 动作执行日志 | task_code, action, status, url, payload |

### 6.3 系统配置表

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `sys_config` | 系统配置 | config_key, config_value |
| `expand_audit` | 扩写审计 | user_text, faq_code, similarity, status |
| `answer_feedback` | 答案反馈 | user_text, answer, intent_code |
| `suggest_cache` | 表达挖掘缓存 | data_json, computed_at |

### 6.4 表关系图

```
faq_category (1) ──── (N) faq (1) ──── (N) faq_question
                          │
                          ▼
chat_log ─────────── chat_session
    │
    ▼
answer_feedback

task (1) ──── (N) task_instance
    │
    ▼
action_log

sys_config (独立)
expand_audit (独立)
suggest_cache (独立)
```

---

## 7. 系统配置说明

系统配置存储在 `sys_config` 表，首次启动时自动初始化默认值。

### 7.1 引擎参数配置

| 配置键 | 说明 | 默认值 |
|--------|------|--------|
| `min_confidence` | 最低匹配置信度 | 0.5 |
| `clarify_threshold` | 追问确认阈值 | 0.65 |
| `top_k` | 返回候选数量 | 5 |
| `meaningless_detection_mode` | 无意义检测模式 | rule |
| `task_session_ttl_minutes` | 任务会话超时（分钟） | 30 |

### 7.2 运营配置

| 配置键 | 说明 |
|--------|------|
| `reply_texts` | 固定回复话术 JSON |
| `match_vocab` | 匹配词表（取消词/路由选择词等） |
| `channel_types` | 渠道类型列表 |
| `feedback_trigger_words` | 答案反馈信号词 |
| `complaint_trigger_words` | 投诉情绪信号词 |

> 以上配置可在管理后台「系统配置」页面直接修改，无需重启服务。

---

## 8. 常用运维命令

### 8.1 容器管理

```bash
# 查看运行状态
docker ps

# 查看日志（实时）
docker logs -f faq-bot

# 查看最近 100 行日志
docker logs --tail 100 faq-bot

# 重启服务
docker restart faq-bot

# 停止服务
docker stop faq-bot

# 启动服务
docker start faq-bot

# 进入容器
docker exec -it faq-bot sh
```

### 8.2 健康检查

```bash
# API 健康检查
curl http://localhost:3001/api/health

# 查看 FAQ 数量
curl -s http://localhost:3001/api/health | jq .faqCount
```

### 8.3 数据备份

```bash
# 备份数据库
mysqldump -h <DB_HOST> -u <DB_USER> -p faqdb > faqdb_backup_$(date +%Y%m%d).sql

# 恢复数据库
mysql -h <DB_HOST> -u <DB_USER> -p faqdb < faqdb_backup_20240101.sql

# 备份上传文件
tar -czf uploads_backup_$(date +%Y%m%d).tar.gz uploads/
```

---

## 9. 故障排查

### 9.1 容器启动失败

```bash
# 查看容器状态和退出原因
docker ps -a

# 查看详细日志
docker logs faq-bot
```

**常见错误**：

| 错误 | 原因 | 解决 |
|------|------|------|
| `DB_PASSWORD 环境变量未设置` | .env 配置缺失 | 检查 .env 文件是否正确挂载 |
| `JWT_SECRET 环境变量未设置` | .env 配置缺失 | 补充 JWT_SECRET |
| `ECONNREFUSED` 数据库连接失败 | 数据库地址/密码错误 | 检查 DB_HOST 和 DB_PASSWORD |
| `Cannot find module` | 镜像构建不完整 | 重新构建完整镜像 |

### 9.2 数据库问题

```bash
# 检查表是否存在
mysql -h <DB_HOST> -u <DB_USER> -p -e "USE faqdb; SHOW TABLES;"

# 检查表结构
mysql -h <DB_HOST> -u <DB_USER> -p -e "USE faqdb; DESCRIBE faq;"

# 重新执行初始化（幂等，不会覆盖数据）
mysql -h <DB_HOST> -u <DB_USER> -p < init.sql
```

### 9.3 端口冲突

```bash
# 查看端口占用
netstat -tlnp | grep 3001

# 修改端口：编辑 .env 的 PORT 和 docker-compose.yml 的 ports
# 例如改为 8080:
# .env: PORT=8080
# docker-compose.yml: ports: - "8080:8080"
```

---

## 附录：快速部署命令汇总

```bash
# 一键部署（首次）
cd /opt/faq-bot
cp .env.example .env && vi .env
mysql -h <DB_HOST> -u <DB_USER> -p < init.sql
chmod +x deploy.sh && ./deploy.sh

# 一键更新（已有）
cd /opt/faq-bot
docker load -i faq-bot-v5.0.tar
docker stop faq-bot && docker rm faq-bot
docker-compose up -d
```

---

**版本**：v5.0  
**更新日期**：2024-09-03  
**维护者**：开发团队
