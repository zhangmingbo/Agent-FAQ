import { Client } from 'ssh2'
import fs from 'fs'

const TAR_PATH = 'd:/New AI/faq-bot-v5.0.tar'
const HOST = '47.102.129.76'
const AUTH = { host: HOST, port: 22, username: 'root', password: 'myegoo@3466', readyTimeout: 30000 }

const c = new Client()
const fileSize = fs.statSync(TAR_PATH).size
console.log(`📦 镜像大小: ${(fileSize / 1024 / 1024).toFixed(0)} MB`)

c.on('ready', () => {
  console.log('✅ SSH 连接成功，开始上传...')
  const startTime = Date.now()

  c.exec('cat > /opt/faq-bot-v5.0.tar', (err, stream) => {
    if (err) { console.error('❌', err.message); c.end(); return }

    const readStream = fs.createReadStream(TAR_PATH)
    let uploaded = 0
    let lastPct = 0

    readStream.on('data', chunk => {
      uploaded += chunk.length
      const pct = Math.floor(uploaded / fileSize * 100)
      if (pct !== lastPct && pct % 5 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        const speed = (uploaded / 1024 / 1024 / (elapsed || 1)).toFixed(1)
        process.stdout.write(`\r  上传进度: ${pct}% (${(uploaded/1024/1024).toFixed(0)}/${(fileSize/1024/1024).toFixed(0)} MB) ${speed} MB/s`)
        lastPct = pct
      }
    })

    readStream.pipe(stream)

    stream.on('close', async () => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`\n✅ 上传完成！耗时 ${elapsed}s`)

      // 加载镜像并重启
      console.log('📥 加载镜像...')
      c.exec('docker load -i /opt/faq-bot-v5.0.tar', (err, stream) => {
        let out = ''
        stream.on('data', d => out += d.toString())
        stream.stderr.on('data', d => out += d.toString())
        stream.on('close', async () => {
          console.log('✅ 镜像加载完成')

          // 停止旧容器
          console.log('🛑 停止旧容器...')
          c.exec('docker stop faq-bot && docker rm faq-bot', (err, stream) => {
            stream.on('close', async () => {
              // 启动新容器
              console.log('🚀 启动新容器...')
              c.exec('docker run -d --name faq-bot --restart always -p 3001:3001 -v /opt/Agent-FAQ/.env:/app/.env:ro -v /opt/Agent-FAQ/uploads:/app/uploads faq-bot:v5.0', (err, stream) => {
                stream.on('close', async () => {
                  await new Promise(r => setTimeout(r, 5000))
                  // 验证
                  c.exec('curl -s http://localhost:3001/api/health', (err, stream) => {
                    let out = ''
                    stream.on('data', d => out += d.toString())
                    stream.on('close', () => {
                      console.log('\n🏥 健康检查:', out)
                      // 清理 tar
                      c.exec('rm -f /opt/faq-bot-v5.0.tar', () => {
                        c.end()
                        console.log('🎉 部署完成！')
                      })
                    })
                  })
                })
              })
            })
          })
        })
      })
    })
  })
})
c.connect(AUTH)
