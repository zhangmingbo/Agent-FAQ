FROM docker.1ms.run/library/node:18-slim

WORKDIR /app

# 复制依赖清单（在容器内安装 Linux 原生依赖）
COPY package.json package-lock.json ./

# 安装生产依赖（Linux 原生模块）
RUN npm ci --omit=dev

# 复制语义模型（ONNX 格式，运行时必需）
COPY model_cache/ ./model_cache/

# 复制应用代码（仅生产必需文件）
COPY ecosystem.config.js ./
COPY src/ ./src/
COPY config/ ./config/
COPY db/ ./db/
COPY middleware/ ./middleware/
COPY repositories/ ./repositories/
COPY routes/ ./routes/
COPY rules/ ./rules/
COPY services/ ./services/
COPY public/ ./public/
COPY faq-engine.js server.js ./

# 创建上传目录
RUN mkdir -p /app/uploads
VOLUME /app/uploads

# 配置模型缓存路径
ENV HF_CACHE_DIR=/app/model_cache

EXPOSE 3001

CMD ["node", "server.js"]
