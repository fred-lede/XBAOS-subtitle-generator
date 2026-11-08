# 设计：XBAOS 字幕生成器 macOS 支持

日期：2026-11-08
状态：已获用户确认

## 目标

同一个 repo 能编译出 macOS 版「小包听幕」（.app / dmg），现有 Windows 构建不受影响。

## 已确认的决策

1. **识别引擎**：macOS 上两套引擎都支持
   - whisper.cpp → GGML 模型（ggml-*、Qwen GGUF），GPU 后端 **Metal**（Windows 上仍是 Vulkan，不变）
   - sherpa-onnx → SenseVoice 等 ONNX 模型
2. **模型分发**：不随安装包分发，继续走软件内下载或手动放进 `models/`（与 Windows 现状一致）
3. **分发**：先做**未签名 dmg**（本地/测试用），Developer ID 签名与公证后续再做，不阻塞本次交付
4. **whisper 引擎默认启用 Metal**：单个二进制带 Metal + CPU 双后端（与 Windows 的 Vulkan + CPU 单二进制方案对称）

## 架构与改动面

### 引擎 C++（engine/、engine-onnx/）

- 两个 CMakeLists.txt 目前 `if(NOT MSVC) FATAL_ERROR`，放宽为 AppleClang/Clang 分支：
  - 静态链接 C 运行时（Apple 系统库本身即静态链接到 libc++/libSystem，不需要 /MT 等价物）
  - `engine/`（whisper.cpp）：新增 `XBAOS_METAL=ON` 选项（macOS 默认 ON），设置 `GGML_METAL=ON`；关闭 AVX/AVX2/BMI2 等 x86 指令集开关（对 Apple Silicon 无效）
  - `engine-onnx/`：onnxruntime 改用官方 macOS 预编译静态/动态库（x86_64 + arm64），由 `tools/fetch-deps.mjs` 补齐；`CMAKE_VS_PLATFORM_NAME` 的 x64 判断在 macOS 上走不到（Ninja + Clang），保留但只对 MSVC 分支生效
  - 产物名：macOS 上不生成 `.exe`（`xbaos-engine`、`xbaos-engine-asr`），Windows 不变
- `engine/src/platform.hpp` 已有 `#else`（非 Windows）分支，无需改动
- 音频解码器（dr_libs / stb_vorbis / libopus）为跨平台 C，无需改动

### JS 主进程（electron/）

- `model-catalog.js`：`ARCH_INFO` 的 `exe` / `devExe` 按 `process.platform` 分叉：
  - win32：`xbaos-engine.exe`、`xbaos-engine-asr.exe`（现状不变）
  - darwin：`xbaos-engine`（metal 变体优先，cpu 兜底）、`xbaos-engine-asr`
- `main.js`：
  - Vulkan 注册表诊断（`readVulkanLayers`）、`GGML_DISABLE_VULKAN` 环境变量与 `vulkanDisabled` 设置只在 win32 生效；macOS 上 GPU 是 Metal 后端，该开关在 mac 上隐藏/不适用
  - `describeExitCode` 的 Windows 退出码翻译在 mac 上不适用（保留通用分支即可）
  - `isGlassSupported` 已有 `platform !== 'win32'` 短路，mac 上自动退回纯色
- `engine-client.js`：spawn 本身跨平台；`windowsHide` 只在 win32 传入（Node 在 mac 上会忽略未知选项，但为清晰起见按平台条件传）

### 打包（electron-builder.yml、package.json）

- `electron-builder.yml` 增加 `mac:` 段：
  - target: dmg（+ zip 可选），arch: [x64, arm64] 双架构
  - icon: `build/icon.icns`（由现有 build/icon-*.png 用 iconutil 生成，新增 `tools/make-icons.py` 的 icns 输出）
  - `electronLanguages` 保持 zh-CN / en-US 不变
  - `downloadAlternateFFmpeg: true` 保留
  - macOS 无 NSIS / fileAssociations（文件关联在 mac 上走 UTI，本次不做）
- `package.json` 增加脚本：
  - `dist:mac`: `npm run build:ui && electron-builder --mac`
  - `dist:mac:dir`: `npm run build:ui && electron-builder --mac --dir`
  - 现有 `dist` / `dist:dir`（Windows）不变

### 构建脚本（engine/build.sh、engine-onnx/build.sh）

- 按 `uname` 分叉：
  - Windows（Git Bash）：现状不变（MSVC / Ninja / env.sh）
  - macOS：系统 clang + CMake + Ninja（`brew install cmake ninja` 或系统自带）；Metal 随 Xcode 自带
- `tools/fetch-deps.mjs`：新增 onnxruntime macOS（x86_64 + arm64）静态包来源

### gitignore

- `models/` 已整体忽略，`*.gguf` 已忽略；确认 `*.onnx` 只放开 `resources/diarization/` 例外（现状已正确）
- 新增 `*.icns` 例外（build/icon.icns 需入库供打包机使用）

## 数据流 / 错误处理

- 引擎协议（行分隔 JSON）跨平台不变；路径 UTF-8 在 macOS 上 `std::filesystem::path` 原生支持
- 引擎缺失时（mac 上没编译出 xbaos-engine）主进程走现有 `source: 'missing'` 路径，界面上引擎标记为不可用，不影响其他功能
- 未签名 dmg 首次打开会被 Gatekeeper 拦截（「无法验证的开发者」），用户右键 → 打开绕过；这是未签名状态下的预期行为，文档注明

## 测试

- `npm run typecheck`（JS 改动）
- `npm run unit`（纯函数守门）
- macOS 上：`bash engine/build.sh metal` / `bash engine-onnx/build.sh` 编译出引擎
- `npm run dev` 在 mac 上跑通（Vite + Electron + 引擎 spawn）
- `npm run dist:mac` 产出 dmg，可双击打开（未签名，右键打开）

## 明确不做（YAGNI）

- 不配置 Developer ID 签名与 notarization（后续单独任务）
- 不做 macOS 文件关联（UTI）
- 不动 Windows 构建的任何默认行为
