/**
 * Download the platform engine binary from GitHub Releases into `bin/`.
 *
 * Runs as a best-effort postinstall hook (never fails the install) and can be
 * invoked manually via `npm run install:engine`. Local cargo builds take
 * precedence at runtime; this exists for users who install the plugin without
 * a Rust toolchain.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

const TRIPLE_BY_PLATFORM = {
  'win32|x64': 'x86_64-pc-windows-msvc',
  'darwin|arm64': 'aarch64-apple-darwin',
  'darwin|x64': 'x86_64-apple-darwin',
  'linux|x64': 'x86_64-unknown-linux-musl',
}

function repoSlugFromPackageJson() {
  const url = pkg.repository?.url ?? ''
  const match = /github\.com[/:]([^/]+)\/([^/?#]+)/.exec(url)
  if (match === null) return undefined
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`
}

function skip(reason) {
  console.warn(`[install-engine] 跳过下载：${reason}`)
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const exe = process.platform === 'win32' ? 'github-first.exe' : 'github-first'
  const triple = TRIPLE_BY_PLATFORM[`${process.platform}|${process.arch}`]

  if (triple === undefined) {
    return skip(`不支持的平台 ${process.platform}|${process.arch}（可在本机 cargo build 后设 DSH_GITHUB_FIRST_SEARCH_BIN）`)
  }
  if (process.env.DSH_SKIP_ENGINE_DOWNLOAD === '1' || process.env.CI === 'true') {
    return skip('环境变量要求跳过（DSH_SKIP_ENGINE_DOWNLOAD / CI）')
  }
  if (existsSync(path.join(root, 'engine', 'target', 'release', exe))) {
    return skip('检测到本地 cargo 构建，运行时会优先使用它')
  }

  const slug = repoSlugFromPackageJson()
  if (slug === undefined || slug.toUpperCase().includes('YOUR_ACCOUNT')) {
    return skip('package.json 的 repository 尚未指向真实 GitHub 仓库（发布并打 tag 后即可自动下载）')
  }

  const headers = {
    'User-Agent': 'dsh-github-first-search-installer',
    Accept: 'application/vnd.github+json',
  }
  const releaseResponse = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, { headers })
  if (!releaseResponse.ok) {
    return skip(`无法查询 Releases（HTTP ${releaseResponse.status}）——仓库可能还没有发布过 Release`)
  }
  const release = await releaseResponse.json()
  const assetName = `github-first-${triple}.tar.gz`
  const asset = (release.assets ?? []).find(entry => entry.name === assetName)
  if (asset === undefined) {
    return skip(`Release ${release.tag_name ?? 'latest'} 中没有 ${assetName}`)
  }

  console.warn(`[install-engine] 下载 ${slug} @ ${release.tag_name}: ${assetName} …`)
  const downloadResponse = await fetch(asset.browser_download_url, { headers })
  if (!downloadResponse.ok) {
    return skip(`下载失败（HTTP ${downloadResponse.status}）`)
  }
  const archive = Buffer.from(await downloadResponse.arrayBuffer())

  const binDir = path.join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const archivePath = path.join(binDir, assetName)
  writeFileSync(archivePath, archive)
  const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', binDir], { encoding: 'utf8' })
  rmSync(archivePath, { force: true })
  if (extracted.status !== 0 || !existsSync(path.join(binDir, exe))) {
    return skip(`解压失败${extracted.stderr ? `: ${String(extracted.stderr).trim().slice(0, 200)}` : ''}——可手动运行 npm run install:engine 重试`)
  }
  if (process.platform !== 'win32') chmodSync(path.join(binDir, exe), 0o755)
  console.warn(`[install-engine] 完成：${path.join(binDir, exe)}（${assetName}）`)
}

main().catch(error => {
  console.warn(`[install-engine] 下载中断（不影响安装）：${error instanceof Error ? error.message : String(error)}`)
})
