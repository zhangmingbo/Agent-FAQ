import { Client } from 'ssh2'
const c = new Client()
c.on('ready', async () => {
  console.log('✅ SSH 连接成功')

  function run(cmd) {
    return new Promise((resolve, reject) => {
      c.exec(cmd, (err, stream) => {
        if (err) return reject(err)
        let out = '', errOut = ''
        stream.on('data', d => out += d.toString())
        stream.stderr.on('data', d => errOut += d.toString())
        stream.on('close', code => resolve({ code, out: out.trim(), errOut: errOut.trim() }))
      })
    })
  }

  // 1. 检查文件是否上传完成
  const ls = await run('ls -lh /opt/faq-bot-v5.0.tar 2>/dev/null || echo "NOT_FOUND"')
  console.log('📦 检查镜像文件:', ls.out)

  if (ls.out.includes('NOT_FOUND')) {
    console.log('❌ 文件不存在，上传可能未完成')
    c.end()
    return
  }

  // 2. 加载镜像
  console.log('📥 加载镜像（需要一些时间）...')
  const load = await run('docker load -i /opt/faq-bot-v5.0.tar')
  console.log('✅', load.out || '镜像加载完成')

  // 3. 停止并删除旧容器
  console.log('🛑 停止旧容器...')
  await run('docker stop faq-bot 2>/dev/null; docker rm faq-bot 2>/dev/null')

  // 4. 启动新容器
  console.log('🚀 启动新容器...')
  const start = await run('docker run -d --name faq-bot --restart always -p 3001:3001 -v /opt/Agent-FAQ/.env:/app/.env:ro -v /opt/Agent-FAQ/uploads:/app/uploads faq-bot:v5.0')
  console.log('  容器ID:', start.out)

  // 5. 等待启动
  console.log('⏳ 等待服务启动...')
  await new Promise(r => setTimeout(r, 6000))

  // 6. 验证
  const health = await run('curl -s http://localhost:3001/api/health')
  console.log('\n🏥 健康检查:', health.out)

  const html = await run('docker exec faq-bot cat /app/public/admin/index.html')
  console.log('\n📄 index.html 版本:')
  console.log(html.out)

  // 7. 清理
  await run('rm -f /opt/faq-bot-v5.0.tar')
  console.log('\n🧹 临时文件已清理')

  c.end()
  console.log('\n🎉 部署完成！')
})
c.connect({ host: '47.102.129.76', port: 22, username: 'root', password: 'myegoo@3466', readyTimeout: 30000 })
