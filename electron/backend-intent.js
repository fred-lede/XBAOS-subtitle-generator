/**
 * 后端意图映射（Task 4：从 main.js 抽出的可测核心）。
 *
 * main.js 里的 Vulkan 诊断/禁用逻辑只服务于 Windows；macOS 上是 Metal，
 * 没有 Vulkan 隐式层与注册表。把「界面意图字符串 → 引擎 backend 参数」的
 * 纯决策集中在这个独立模块，unit-check 可以直接 import 而不拉起 electron。
 */
import { ARCH_WHISPER } from './model-catalog.js'

/**
 * 纯函数：把界面「推理后端」意图映射成引擎 load 时的 backend 参数。
 *
 * 抽成纯函数是为了可在 node 里单测（不依赖 client 实例与磁盘）。
 * 返回值：
 *   backend    引擎 load 用的 backend 字符串（'cpu' | 'vulkan' | 'metal' | 'auto'）
 *   disableGpu 是否需要禁用 GPU 后端（win 上对应 setDisableVulkan；mac 上无对应）
 */
export function backendIntentToEngineBackend({
  backend = 'auto',
  arch = ARCH_WHISPER,
  isWindows = false,
  gpuDisabled = false,
  envForced = false,
} = {}) {
  // ONNX 引擎只有 CPU provider，与平台无关
  if (arch !== ARCH_WHISPER) return { backend: 'cpu', disableGpu: false }

  if (isWindows) {
    // Windows 现状逻辑（Vulkan）
    if (backend === 'cpu') return { backend: 'cpu', disableGpu: true }
    if (backend === 'vulkan' || backend === 'gpu') {
      if (envForced) return { backend: 'cpu', disableGpu: false }
      return { backend: 'vulkan', disableGpu: false }
    }
    return { backend: gpuDisabled ? 'cpu' : 'auto', disableGpu: false }
  }

  // macOS（Metal）
  if (backend === 'cpu') return { backend: 'cpu', disableGpu: false }
  if (backend === 'vulkan' || backend === 'gpu' || backend === 'metal') {
    return { backend: 'metal', disableGpu: false }
  }
  return { backend: 'auto', disableGpu: false }
}
