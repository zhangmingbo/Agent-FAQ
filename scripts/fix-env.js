import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  const cmd = `echo 'JWT_SECRET=faq-bot-secret-key-change-in-production' >> /opt/Agent-FAQ/.env && echo 'ADMIN_PASS=admin123' >> /opt/Agent-FAQ/.env && echo '--- updated .env ---' && cat /opt/Agent-FAQ/.env`
  c.exec(cmd, (err, stream) => {
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => { console.log(out); c.end() })
  })
})
c.connect({ host: '47.102.129.76', port: 22, username: 'root', password: 'myegoo@3466', readyTimeout: 10000 })
