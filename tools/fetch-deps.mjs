/**
 * 扫描 CMake 的 FetchContent 声明，把 github 依赖换成 codeload 直连下载。
 *
 * 为什么需要它：sherpa-onnx 的依赖链是级联的（sherpa → kaldi-decoder →
 * kaldifst → …），只有下载上一层之后才看得到下一层。手工一个个补太慢，
 * 而且 github.com 主域在本机不通、只有 codeload 子域可用 —— 每次都要换域名。
 *
 * 用法：node fetch-deps.mjs <项目根目录>
 * 产物落在 <项目根目录> 下，文件名按 FetchContent 的 possible_file_locations 推断。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(process.argv[2] ?? 'engine-onnx')
const depsDir = path.join(root, 'build', '_deps')

if (!fs.existsSync(depsDir)) {
  console.log('没有 build/_deps，先跑一次 cmake 配置')
  process.exit(0)
}

/** 递归收集所有 cmake 文件 */
function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(cmake|txt)$/i.test(e.name)) out.push(full)
  }
  return out
}

/**
 * 把 github 归档地址映射成 codeload 地址。
 *
 * 注意 `name` 只是**按 tag 推出的候选名**，不一定就是 FetchContent 想找的那个：
 * 上游 tag 常带 `v` 前缀（`v1.8.0`），而 `possible_file_locations` 里写的文件名
 * 往往不带（`kaldifst-1.8.0.tar.gz`）。真正落盘的名字由 expectedName() 从
 * cmake 原文里取 —— 早先直接用 `name` 判断「这个文件被需要吗」，
 * kaldifst 与 kaldi-decoder 就是这么被整包漏掉的。
 *
 * @returns {{url: string, name: string, repo: string} | null}
 */
function toCodeload(url) {
  // https://github.com/owner/repo/archive/refs/tags/v1.8.0.tar.gz
  let m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/refs\/tags\/(.+)\.(tar\.gz|zip)$/)
  if (m) {
    const [, owner, repo, tag, ext] = m
    return {
      url: `https://codeload.github.com/${owner}/${repo}/${ext === 'zip' ? 'zip' : 'tar.gz'}/refs/tags/${tag}`,
      name: `${repo}-${tag}.${ext}`,
      repo,
    }
  }
  // https://github.com/owner/repo/archive/<sha>.zip
  m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/([0-9a-f]{7,40})\.(tar\.gz|zip)$/)
  if (m) {
    const [, owner, repo, sha, ext] = m
    return {
      url: `https://codeload.github.com/${owner}/${repo}/${ext === 'zip' ? 'zip' : 'tar.gz'}/${sha}`,
      name: `${repo}-${sha}.${ext}`,
      repo,
    }
  }
  return null
}

/**
 * 从 cmake 原文的 `possible_file_locations` 里取出这个包**真正**的文件名。
 *
 * 优先取 `${CMAKE_SOURCE_DIR}/<文件名>` 那一行，因为 fetch-deps 的落盘位置就是
 * 项目根目录；找不到就退回该块里第一个 `<repo>-…` 形式的归档名。
 */
function expectedName(text, repo) {
  const block = text.match(/set\(\s*possible_file_locations([\s\S]*?)\)/)
  if (!block) return null
  const names = [...block[1].matchAll(/([\w.+-]+\.(?:tar\.gz|tgz|zip|tar\.bz2))/g)].map((m) => m[1])
  if (names.length === 0) return null
  if (text.includes(`\${CMAKE_SOURCE_DIR}/${repo}-`)) {
    const forSourceDir = names.find((n) => n.startsWith(`${repo}-`))
    if (forSourceDir) return forSourceDir
  }
  return names.find((n) => n.startsWith(`${repo}-`)) ?? null
}

const files = walk(depsDir)
const jobs = new Map()

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  // 同一个文件里，URL 变量名与 possible_file_locations 的文件名前缀能对上
  const urlRe = /set\(\s*([\w-]+)_URL\s+"(https:\/\/github\.com\/[^"]+)"\s*\)/g
  let hit
  while ((hit = urlRe.exec(text)) !== null) {
    const mapped = toCodeload(hit[2])
    if (!mapped) continue
    // 落盘名以 cmake 原文为准；推不出就退回按 tag 拼的那个
    const name = expectedName(text, mapped.repo) ?? mapped.name
    // 只有这个文件确实把该文件名列为候选时才需要（否则说明走的是别的分支）
    if (!text.includes(name)) continue
    jobs.set(name, mapped.url)
  }
}

if (jobs.size === 0) {
  console.log('本次扫描没有发现需要补的 github 依赖')
  process.exit(0)
}

let failed = 0
for (const [name, url] of jobs) {
  const target = path.join(root, name)
  if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
    console.log(`已存在  ${name}`)
    continue
  }
  process.stdout.write(`下载中  ${name} … `)
  try {
    execFileSync('curl', ['-sL', '--noproxy', '*', '--max-time', '300', '-o', target, url], {
      stdio: 'ignore',
    })
    const size = fs.statSync(target).size
    console.log(`${(size / 1024 / 1024).toFixed(1)} MB`)
  } catch {
    console.log('失败')
    failed++
  }
}

/**
 * onnxruntime macOS 预编译库（与 sherpa 真实 cmake 对齐，2026-11-08 验证）：
 *   资产是 csukuangfj/onnxruntime-libs 的 GitHub release .zip（不是源码归档，
 *   也不走 codeload 规则）：
 *     arm64  → onnxruntime-osx-arm64-1.28.2.zip
 *     x86_64 → onnxruntime-osx-x86_64-1.28.2.zip
 *   只有 darwin 上需要（Windows 开发机走 win-x64 静态包，不跑本块）。
 *
 * 两个架构都要下载：electron-builder 的 mac 块同时打 x64 与 arm64 的 dmg，
 * 打包机需要两个 zip 都在项目根。注意 dylib 必须在与它同架构的机器上
 * 编译/链接（x86_64 的 dylib 不能在没有 Rosetta 的 arm64 机器上直接链接）。
 * 落到项目根目录（mac 上默认 engine-onnx/，即 CMAKE_SOURCE_DIR）：
 * sherpa 的 cmake/onnxruntime-osx-arm64.cmake 的 possible_file_locations
 * 优先检查 ${CMAKE_SOURCE_DIR}/onnxruntime-osx-arm64-1.28.2.zip。
 * 下载后做 SHA256 校验，与 sherpa cmake 里的 onnxruntime_HASH 完全一致。
 */
if (process.platform === 'darwin') {
  const ORT_VERSION = '1.28.2' // 与 sherpa-onnx/cmake/onnxruntime-osx-*.cmake 对齐
  // 双架构：x64 与 arm64 都要，供打包机产出两种 dmg
  const ortArchs = ['arm64', 'x86_64']
  const ortHashes = {
    arm64: 'd9e5c0c79929e201f5b8eb095e6809a91ce78be9866a1bca0dfab7e20b40ae40',
    x86_64: 'cef42f2a4fca3b23dd16914ead36229adc7d5c119d563aaa12cc5d1e9177f93d',
  }
  for (const ortArch of ortArchs) {
    const ortZip = `onnxruntime-osx-${ortArch}-${ORT_VERSION}.zip`
    const ortHash = ortHashes[ortArch]
    const ortUrl = `https://github.com/csukuangfj/onnxruntime-libs/releases/download/v${ORT_VERSION}/${ortZip}`
    const ortTarget = path.join(root, ortZip)
    if (!fs.existsSync(ortTarget) || fs.statSync(ortTarget).size <= 1024) {
      process.stdout.write(`下载 onnxruntime  ${ortZip} … `)
      try {
        execFileSync('curl', ['-sL', '--noproxy', '*', '--max-time', '600', '-o', ortTarget, ortUrl], {
          stdio: 'ignore',
        })
        // SHA256 校验，与 sherpa cmake 的 URL_HASH 一致；不通过就删掉记失败
        const hashOut = execFileSync('sh', ['-c', `shasum -a 256 "${ortTarget}" | awk '{print $1}'`], {
          encoding: 'utf8',
        }).trim()
        if (hashOut !== ortHash) {
          throw new Error(`SHA256 不匹配：期望 ${ortHash}，实际 ${hashOut}`)
        }
        const size = fs.statSync(ortTarget).size
        console.log(`${(size / 1048576).toFixed(1)} MB（SHA256 校验通过）`)
      } catch (e) {
        console.log(`失败（${e instanceof Error ? e.message : e}）`)
        try { fs.rmSync(ortTarget, { force: true }) } catch {}
        failed++
      }
    }
  }
}

process.exit(failed === 0 ? 0 : 1)
