import { copyFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = resolve(__dirname, '..', 'public', 'admin')

// 清理目标目录
if (existsSync(target)) {
  rmSync(target, { recursive: true })
}
mkdirSync(target, { recursive: true })

// 复制 dist 内容到 sdk/public/admin/
const distDir = resolve(__dirname, 'dist')
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = resolve(src, entry.name)
    const destPath = resolve(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

copyDir(distDir, target)
console.log(`\n✅ 已部署到 ${target}`)
