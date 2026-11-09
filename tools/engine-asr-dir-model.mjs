/**
 * ONNX 引擎「目录型模型」加载冒烟测试（跨平台，用后即弃的开发脚本）。
 *
 * 回归目标：目录型模型（sensevoice-small/，含 model.int8.onnx + tokens.txt）
 * 在 macOS/Linux 上必须能 load 成功。
 *
 * 历史 bug（2026-11-08）：resolveModelFiles 用 fopen 判断「传进来的是文件还是目录」，
 * 但 POSIX 上 fopen 对目录也能打开成功，目录型模型被误判成文件，dir 被推成父目录，
 * 于是报「模型目录里没有 tokens.txt」。该 bug 只在 macOS/Linux 暴露（Windows 上
 * fopen 目录会失败）。修复后这里应稳定打印 "loaded ok"。
 *
 * 用法（项目根目录）：
 *   node tools/engine-asr-dir-model.mjs [模型目录路径]
 * 不传参数时，自动扫 userData/models 与仓库 models/ 下的第一个目录型模型。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

/** 引擎可执行文件：mac/linux 无后缀，win 带 .exe */
const EXE =
  process.platform === 'win32'
    ? path.join(repoRoot, 'engine-onnx/build/bin/xbaos-engine-asr.exe')
    : path.join(repoRoot, 'engine-onnx/build/bin/xbaos-engine-asr')

if (!existsSync(EXE)) {
  console.error('缺少 ONNX 引擎：先跑 bash engine-onnx/build.sh')
  process.exit(1)
}

/** 找第一个「目录型模型」：目录里同时有 model.onnx/model.int8.onnx 与 tokens.txt */
function findDirModel(explicit) {
  if (explicit) return explicit
  const candidates = [
    // 仓库内开发态模型
    path.join(repoRoot, 'models'),
    // 用户目录（mac）
    path.join(process.env.HOME ?? '', 'Library/Application Support/xbaos-subtitle-generator/models'),
  ]
  for (const base of candidates) {
    let entries
    try {
      entries = readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(base, e.name)
      const names = new Set(readdirSync(full))
      if (names.has('tokens.txt') && (names.has('model.int8.onnx') || names.has('model.onnx'))) {
        return full
      }
    }
  }
  return null
}

const modelDir = findDirModel(process.argv[2])
if (!modelDir) {
  console.error('找不到目录型模型（含 tokens.txt + model*.onnx）。可显式传路径。')
  process.exit(1)
}

console.log('模型目录：', modelDir)

const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
let loadSent = false

// 引擎只在收到「ping」后才回 pong 并进入命令循环；启动后先探活一次
function send(o) {
  proc.stdin.write(JSON.stringify(o) + '\n')
}

proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk) => {
  buf += chunk
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      continue
    }
    if (msg.type === 'pong') {
      if (!loadSent) {
        loadSent = true
        send({ id: 1, cmd: 'load', model: modelDir, backend: 'cpu' })
      }
    } else if (msg.id === 1) {
      if (msg.type === 'loaded') {
        console.log(`loaded ok  model=${msg.model}  backend=${msg.backend}`)
        console.log('PASS')
        proc.kill()
        process.exit(0)
      } else if (msg.type === 'error') {
        console.error(`FAILED  引擎报错：${msg.message}`)
        console.log('FAIL')
        proc.kill()
        process.exit(1)
      }
    }
  }
})

// 启动后探活；若 3s 内引擎没回 pong（可能它要 stdin 才有反应），再补一次
setTimeout(() => send({ id: 0, cmd: 'ping' }), 1500)

proc.on('exit', (code) => {
  // 兜底：引擎自行退出（未收到 loaded）时判失败
  console.error(`引擎退出 code=${code}（未收到 loaded）`)
  process.exit(1)
})

// 5 分钟仍未 loaded 就判失败（目录型模型 load 正常应在数秒内完成）
setTimeout(() => {
  if (!proc.killed) {
    console.error('FAIL  超时：5 分钟内未收到 loaded')
    proc.kill()
    process.exit(1)
  }
}, 300_000).unref()
