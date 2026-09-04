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
        stream.on('close', code => {
          if (code !== 0 && errOut) console.error('  ⚠️', errOut.trim())
          resolve(out.trim())
        })
      })
    })
  }

  // 1. 清理容器内的旧文件和错误子目录
  console.log('🧹 清理容器内旧文件...')
  await run('docker exec faq-bot sh -c "rm -rf /app/public/admin/*"')

  // 2. 在宿主机创建干净目录并放入 dist 子目录中的新文件
  console.log('📂 整理文件...')
  await run('mkdir -p /tmp/admin-clean/assets')
  await run('cp /tmp/admin-update/dist/index.html /tmp/admin-clean/index.html 2>/dev/null; cp /tmp/admin-update/index.html /tmp/admin-clean/index.html 2>/dev/null')
  // 从 dist 子目录复制（之前用户上传的）
  await run('cp -rf /tmp/admin-update/dist/assets/* /tmp/admin-clean/assets/ 2>/dev/null')
  // 也从根 assets 复制（以防有些在根目录）
  await run('cp -rf /tmp/admin-update/assets/* /tmp/admin-clean/assets/ 2>/dev/null')

  // 3. 复制到容器
  console.log('📤 复制新文件到容器...')
  const result = await run('docker cp /tmp/admin-clean/. faq-bot:/app/public/admin/')
  console.log('  结果:', result || 'OK')

  // 4. 重启容器
  console.log('🔄 重启容器...')
  await run('docker restart faq-bot')

  // 5. 等待启动
  await new Promise(r => setTimeout(r, 5000))

  // 6. 验证
  const html = await run('docker exec faq-bot cat /app/public/admin/index.html')
  console.log('\n📄 容器内 index.html:')
  console.log(html)

  const health = await run('curl -s http://localhost:3001/api/health')
  console.log('\n🏥 健康检查:', health)

  // 7. 清理
  await run('rm -rf /tmp/admin-clean /tmp/admin-update')

  c.end()
  console.log('\n🎉 完成！')
})
c.connect({ host: '47.102.129.76', port: 22, username: 'root', password: 'myegoo@3466', readyTimeout: 10000 })
