/**
 * PM2 进程管理配置
 * 
 * 用法: pm2 start ecosystem.config.js
 * 或:   pm2 start server.js --name faq-bot
 */

module.exports = {
  apps: [
    {
      name: 'faq-bot',
      script: './server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      maxMemoryRestart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      // 日志
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
}
