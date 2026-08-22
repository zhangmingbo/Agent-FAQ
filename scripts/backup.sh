#!/bin/bash
# MySQL 数据库备份脚本
# 
# 用法: bash scripts/backup.sh
# 建议添加到 crontab: 0 2 * * * /path/to/scripts/backup.sh
# （每天凌晨2点执行）

# 配置（与 config/index.js 保持一致）
DB_HOST="${DB_HOST:-rm-bp11ucz7dz696m6w5zo.mysql.rds.aliyuncs.com}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-aibot}"
DB_PASS="${DB_PASSWORD:-myegoo@3466}"
DB_NAME="${DB_NAME:-faqdb}"

# 备份目录
BACKUP_DIR="./backups"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/faqdb_${DATE}.sql"

# 保留最近7天的备份
KEEP_DAYS=7

# 创建备份目录
mkdir -p "${BACKUP_DIR}"

echo "[$(date)] 开始备份数据库 ${DB_NAME}..."

# 执行备份
mysqldump -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USER}" -p"${DB_PASS}" \
  --single-transaction --routines --triggers \
  "${DB_NAME}" > "${BACKUP_FILE}"

if [ $? -eq 0 ]; then
  SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
  echo "[$(date)] 备份成功: ${BACKUP_FILE} (${SIZE})"
else
  echo "[$(date)] 备份失败!"
  exit 1
fi

# 清理过期备份
echo "[$(date)] 清理 ${KEEP_DAYS} 天前的备份..."
find "${BACKUP_DIR}" -name "faqdb_*.sql" -mtime +${KEEP_DAYS} -delete
REMAINING=$(ls -1 "${BACKUP_DIR}"/faqdb_*.sql 2>/dev/null | wc -l)
echo "[$(date)] 当前保留 ${REMAINING} 个备份文件"

echo "[$(date)] 备份任务完成"
