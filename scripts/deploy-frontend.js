/**
 * 增量更新：通过 SSH exec stdin 管道传输前端产物到服务器容器
 */
import { Client } from 'ssh2'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const HOST = '47.102.129.76'
const AUTH = { host: HOST, port: 22, username: 'root', password: 'myegoo@3466', readyTimeout: 10000 }
const CONTAINER = 'faq-bot'
const DIST_DIR = path.resolve('d:/New AI/frontend/dist')

function runCmd(c, cmd) {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = '', errOut = ''
      stream.on('data', d => out += d.toString())
      stream.stderr.on('data', d => errOut += d.toString())
      stream.on('close', code => resolve({ code, out, errOut }))
    })
  })
}

async function main() {
  // 1. 本地打 tar 包
  const tarPath = path.resolve('d:/New AI/frontend-dist.tar.gz')
  console.log('📦 打包前端文件...')
  execSync(`tar -czf "${tarPath}" -C "${DIST_DIR}" .`, { stdio: 'pipe' })
  const tarSize = (fs.statSync(tarPath).size / 1024).toFixed(0)
  console.log(`  包大小: ${tarSize} KB`)

  // 2. SSH 连接
  const c = new Client()
  c.on('ready', async () => {
    console.log('✅ SSH 连接成功')

    // 3. 通过 exec stdin 传输 tar 包
    console.log('📤 传输文件...')
    c.exec('cat > /tmp/frontend-dist.tar.gz', (err, stream) => {
      if (err) { console.error('❌', err.message); c.end(); return }

      const readStream = fs.createReadStream(tarPath)
      let uploaded = 0
      readStream.on('data', chunk => {
        uploaded += chunk.length
        process.stdout.write(`\r  已传输: ${(uploaded / 1024).toFixed(0)} KB`)
      })
      readStream.pipe(stream)

      stream.on('close', async () => {
        console.log('\n✅ 传输完成')

        // 4. 解压
        await runCmd(c, 'mkdir -p /tmp/admin-update')
        const extract = await runCmd(c, 'tar -xzf /tmp/frontend-dist.tar.gz -C /tmp/admin-update/ && echo OK')
        if (extract.out.trim() !== 'OK') {
          console.error('❌ 解压失败:', extract.errOut || extract.out)
          c.end(); return
        }
        console.log('✅ 解压完成')

        // 5. 复制到容器
        const copy = await runCmd(c, `docker cp /tmp/admin-update/. ${CONTAINER}:/app/public/admin/`)
        if (copy.code !== 0) {
          console.error('❌ docker cp 失败:', copy.errOut)
          c.end(); return
        }
        console.log('✅ 文件已复制到容器')

        // 6. 重启容器
        await runCmd(c, `docker restart ${CONTAINER}`)
        console.log('🔄 容器已重启')

        // 7. 清理
        await runCmd(c, 'rm -rf /tmp/admin-update /tmp/frontend-dist.tar.gz')

        // 8. 验证
        await new Promise(r => setTimeout(r, 4000))
        const health = await runCmd(c, 'curl -s http://localhost:3001/api/health')
        console.log('\n🏥 健康检查:', health.out)

        c.end()
        try { fs.unlinkSync(tarPath) } catch {}
        console.log('\n🎉 增量更新完成！')
      })
    })
  })
  c.connect(AUTH)
}

main().catch(e => console.error('❌', e.message))
