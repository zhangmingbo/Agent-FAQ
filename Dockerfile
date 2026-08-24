FROM docker.1ms.run/library/node:18-slim

WORKDIR /app

# 复制依赖和模型（Windows 版 node_modules，后面替换原生模块）
COPY node_modules/ ./node_modules/
COPY model_cache/ ./model_cache/

# 复制所有应用文件
COPY package.json ecosystem.config.js ./
COPY src/ ./src/
COPY config/ ./config/
COPY db/ ./db/
COPY middleware/ ./middleware/
COPY repositories/ ./repositories/
COPY routes/ ./routes/
COPY rules/ ./rules/
COPY scripts/ ./scripts/
COPY public/ ./public/
COPY db.js faq-library.js faq-engine.js server.js intent-recognizer.js intents-library.js .env.example ./

# 替换为 Linux 版原生模块（sharp、mysql2）
RUN npm install --os=linux --cpu=x64 sharp mysql2

# 创建上传目录
RUN mkdir -p /app/uploads
VOLUME /app/uploads

# 配置模型缓存路径
ENV HF_CACHE_DIR=/app/model_cache

EXPOSE 3001

CMD ["node", "server.js"]
