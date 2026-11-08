# macOS 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一个 repo 能编译出 macOS 版「小包听幕」dmg（x64 + arm64 双架构，未签名），whisper（Metal+CPU 单二进制）与 sherpa-onnx（CPU）两套引擎在 mac 上可用；Windows 构建行为完全不变。

**Architecture:** 引擎 C++ 层放宽 CMake 的工具链门禁（AppleClang 分支），产物名按平台分叉（无 .exe）；JS 层 `model-catalog.js` 按 `process.platform` 选引擎文件名；`main.js` 的 Vulkan 诊断/状态只保留在 win32；`electron-builder.yml` 增加 `mac:` 段；构建脚本按 `uname` 分叉。

**Tech Stack:** Electron、electron-builder、CMake、AppleClang、whisper.cpp (GGML+Metal)、sherpa-onnx + onnxruntime、Node 22+

**Spec:** `docs/superpowers/specs/2026-11-08-macos-support-design.md`

## Global Constraints

- 模型不随安装包分发（安装包里不含任何模型文件，与 Windows 现状一致）
- macOS 产物：dmg，arch `[x64, arm64]`，未签名（无 Developer ID、无公证）
- whisper 引擎在 mac 上单二进制，Metal + CPU 双后端（默认启用 Metal），与 Windows 的 Vulkan + CPU 单二进制方案对称
- sherpa-onnx 引擎在 mac 上只走 onnxruntime CPU provider（与 Windows 一致）
- `electronLanguages` 保持 `zh-CN` / `en-US`
- 不改 Windows 构建的任何默认行为（MSVC `/MT`、Vulkan 选项、NSIS 等全部保留）
- 引擎协议（行分隔 JSON、stdin/stdout、UTF-8 路径）跨平台不变
- 产物命名：mac 上引擎为 `xbaos-engine`（whisper，metal 变体优先、cpu 兜底）与 `xbaos-engine-asr`（sherpa）；win 上保持 `.exe` 后缀

## Review Focus

1. **mac 上没编译出引擎二进制时**（`source: 'missing'`）—— 主进程不得崩溃，引擎在 `app:info` 里标记为不可用，其余功能（导入/编辑/导出）照常可用。
2. **`GGML_DISABLE_VULKAN` 与 Vulkan 注册表诊断在 mac 上被调用** —— 必须不执行 reg.exe、不写 `vulkanDisabled` 状态；设置页在 mac 上不暴露 Vulkan 选项。
3. **未签名 dmg 首次打开被 Gatekeeper 拦** —— 文档必须写明「右键 → 打开」的绕过路径，而不是让用户以为装坏了。
4. **双架构（x64 与 arm64）的 onnxruntime 库来源** —— 打包机上两种架构都要能拉到对应库，否则 `dist:mac` 只出一种架构。
5. **`.gitignore` 对 `build/icon.icns` 的放行** —— icns 是打包输入，必须入库；引擎产物（`*.app`、非 exe 的引擎二进制）仍须被忽略。

---

## Task 1: whisper 引擎 CMake 跨平台化 + Metal 后端

**Files:**
- Modify: `engine/CMakeLists.txt`（工具链门禁、Metal 选项、产物名、指令集开关的平台分支）
- Modify: `engine/src/main.cpp`（`cmdPing` 上报 Metal 后端；`cmdLoad` 的 GPU 判定按平台）
- Modify: `engine/build.sh`（mac 分支：系统 clang + CMake + Ninja）

**Interfaces:**
- Produces: 编译产物
  - macOS metal 版：`engine/build/metal/bin/xbaos-engine`
  - macOS cpu 版：`engine/build/cpu/bin/xbaos-engine`
  - Windows 不变：`engine/build/{cpu,vulkan}/bin/xbaos-engine.exe`
- Produces: CMake 选项 `XBAOS_METAL`（默认 OFF，mac 分支传 ON）
- Produces: 引擎可执行文件在 macOS 上**无 `.exe` 后缀**，CMake 通过 `WIN32_EXECUTABLE_SUFFIX` 逻辑自动处理

- [ ] **Step 1: 放宽工具链门禁**

`engine/CMakeLists.txt` 第 28-33 行，把「只支持 MSVC」改成「MSVC 或 AppleClang 都接受」：

```cmake
if(NOT MSVC AND NOT APPLE)
    message(FATAL_ERROR
        "本引擎支持 MSVC（Windows）与 AppleClang（macOS）工具链。\n"
        "MSVC 需要 /MT 静态链接；AppleClang 由系统库静态链接，无需等价物。\n"
        "当前编译器：${CMAKE_CXX_COMPILER_ID}")
endif()
```

- [ ] **Step 2: `/utf-8` 与 MSVC 运行时限定到 MSVC 分支**

第 45 行 `add_compile_options(/utf-8)` 与第 51-52 行的 `CMAKE_MSVC_RUNTIME_LIBRARY` 只在 MSVC 下有意义。改成：

```cmake
if(MSVC)
    # 源码含中文注释与中文字面量，必须显式按 UTF-8 解析
    add_compile_options(/utf-8)
    # 静态 C 运行时：这条决定了发布产物能否做到「一个 exe，零外部 DLL」
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
        CACHE STRING "MSVC 运行时库" FORCE)
endif()
```

- [ ] **Step 3: 新增 Metal 选项（mac 默认 ON）**

在「Vulkan（可选）」一节（第 131-145 行）后，增加一节：

```cmake
# ---------------------------------------------------------------------------
#  Metal（macOS GPU 后端）
#
#  与 Windows 的 Vulkan 对称：编译进二进制后，运行时按 use_gpu 决定走 Metal
#  还是 CPU。ggml 的 Metal 后端依赖 Xcode 自带，无需额外 SDK。
# ---------------------------------------------------------------------------
option(XBAOS_METAL "编译 Metal GPU 后端（macOS）" ${APPLE})

if(XBAOS_METAL AND NOT APPLE)
    message(FATAL_ERROR "Metal 后端只在 macOS（AppleClang）上可用。")
endif()

set(GGML_METAL ${XBAOS_METAL} CACHE BOOL "" FORCE)
```

注意：`GGML_METAL` 目前在第 120 行被写死为 `OFF`。把那行删掉，改由上面的 `set(GGML_METAL ...)` 接管。其他 x86 指令集开关（AVX/AVX2/BMI2）对 Apple Silicon 无效，需限定到非 Apple 平台：

第 98-102 行（AVX 开关）包在 `if(NOT APPLE)` 里；第 103-110 行（AVX512/AVX-VNNI）同样包进 `if(NOT APPLE)`。Apple 平台这些开关不设置（ggml 在 ARM 上忽略它们）。

- [ ] **Step 4: Metal 编译宏与产物名**

第 202-204 行的 Vulkan 宏旁，增加 Metal 宏：

```cmake
if(XBAOS_METAL)
    target_compile_definitions(xbaos-engine PRIVATE XBAOS_HAS_METAL=1)
endif()
```

CMake 的 `add_executable(xbaos-engine)` 在 macOS 上天然产出无后缀的 `xbaos-engine`（Ninja + AppleClang），Windows 上产出 `xbaos-engine.exe` —— 无需额外处理，CMake 按平台决定。验证：第 210-211 行 `RUNTIME_OUTPUT_DIRECTORY` 不变。

- [ ] **Step 5: main.cpp 上报 Metal 后端**

`engine/src/main.cpp` 第 76-77 行补上 Metal 宏兜底：

```cpp
#ifndef XBAOS_HAS_METAL
#define XBAOS_HAS_METAL 0
#endif
```

第 372-377 行 `cmdPing` 的 backends 数组，在 `#if XBAOS_HAS_VULKAN` 块后增加 Metal 块：

```cpp
    w.key("backends").beginArray().value("cpu");
#if XBAOS_HAS_VULKAN
    if (std::getenv("GGML_DISABLE_VULKAN") == nullptr) w.value("vulkan");
#endif
#if XBAOS_HAS_METAL
    w.value("metal");
#endif
    w.endArray();
```

- [ ] **Step 6: main.cpp GPU 判定按平台**

`engine/src/main.cpp` 第 400-440 行的 `#if !XBAOS_HAS_VULKAN` / `#else` 分支只覆盖 Vulkan。Metal 构建（mac）上 `XBAOS_HAS_VULKAN` 为 0，会走进「没编 Vulkan 只能 CPU」的兜底，把 Metal 也错误地当成不可用。需要把 GPU 判定改成「任一 GPU 后端可用即可」。

把第 397-440 行的 GPU 可用性判定重写为：

```cpp
    const std::string requested = req.str("backend", "auto");
    const bool hasGpuBackend = (XBAOS_HAS_VULKAN || XBAOS_HAS_METAL) != 0;
    bool wantGpu = (requested != "cpu");

    if (!hasGpuBackend && wantGpu) {
        // 没有任何 GPU 后端（纯 CPU 构建）：显式要 gpu/vulkan/metal 时纠正
        const bool explicitGpu = (requested == "vulkan" || requested == "gpu" || requested == "metal");
        wantGpu = false;
        if (explicitGpu) {
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("fallback");
            w.key("from").value(requested);
            w.key("to").value("cpu");
            w.key("reason").value("这个版本没有编译 GPU 后端，只能用 CPU");
            w.endObject();
            emit(w.take());
        }
    }

    /*
     * Metal 构建（mac）：Metal 后端在注册表构造时即初始化，没有 Vulkan 那样的
     * GGML_DISABLE_* 运行期开关；whisper 的 use_gpu=true 在 Metal 可用时直接生效。
     * Vulkan 构建（win）保持原 GGML_DISABLE_VULKAN 纠正逻辑。
     */
#if XBAOS_HAS_VULKAN
    if (wantGpu && std::getenv("GGML_DISABLE_VULKAN") != nullptr) {
        const bool explicitGpu = (requested == "vulkan" || requested == "gpu");
        wantGpu = false;
        if (explicitGpu) {
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("fallback");
            w.key("from").value(requested);
            w.key("to").value("cpu");
            w.key("reason").value("Vulkan 已被禁用（GGML_DISABLE_VULKAN），只能用 CPU");
            w.endObject();
            emit(w.take());
        }
    }
#endif
```

把原来第 401-440 行的 `#if !XBAOS_HAS_VULKAN ... #else ... #endif` 整段替换为上面的统一逻辑。第 461 行 `cparams.use_gpu = wantGpu;` 不变。

- [ ] **Step 7: build.sh 增加 mac 分支**

`engine/build.sh` 在 `VARIANT` 解析后（第 19 行后）按 `uname` 分叉。新增变体 `metal`（mac 专用，Metal+CPU 单二进制）。改动后的完整 `case` 与构建段：

```bash
VARIANT="${1:-cpu}"

if [ "$VARIANT" = "clean" ]; then
    rm -rf engine/build
    echo "已清理 engine/build"
    exit 0
fi

case "$(uname -s)" in
    Darwin)
        # macOS：系统 clang + CMake + Ninja（brew install cmake ninja 或 Xcode 自带 clang）
        case "$VARIANT" in
            metal)
                if ! command -v cmake > /dev/null 2>&1; then
                    echo "错误：找不到 cmake（brew install cmake ninja）" >&2
                    exit 1
                fi
                EXTRA_ARGS=(-DXBAOS_METAL=ON)
                ;;
            cpu)
                EXTRA_ARGS=()
                ;;
            *)
                echo "未知变体：$VARIANT（mac 可选 cpu / metal / clean）" >&2
                exit 1
                ;;
        esac
        BUILD_DIR="engine/build/$VARIANT"
        echo "=== 配置 $VARIANT 版（macOS）==="
        cmake -S engine -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release "${EXTRA_ARGS[@]}"
        echo ""
        echo "=== 编译 $VARIANT 版（macOS）==="
        cmake --build "$BUILD_DIR"
        echo ""
        echo "=== 产物 ==="
        ls -la "$BUILD_DIR/bin/" 2>/dev/null || true
        exit 0
        ;;
esac

# ---- 以下保持 Windows（Git Bash）原逻辑不变 ----
# shellcheck disable=SC1091
source "$SCRIPT_DIR/env.sh" > /dev/null

BUILD_DIR="engine/build/$VARIANT"
EXTRA_ARGS=()

case "$VARIANT" in
    cpu)
        ;;
    vulkan)
        if [ -z "${VULKAN_SDK:-}" ]; then
            echo "错误：没有找到 VULKAN_SDK，无法编译 GPU 版" >&2
            exit 1
        fi
        EXTRA_ARGS+=("-DXBAOS_VULKAN=ON")
        ;;
    *)
        echo "未知变体：$VARIANT（可选 cpu / vulkan / clean）" >&2
        exit 1
        ;;
esac

echo "=== 配置 $VARIANT 版 ==="
cmake -S engine -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release "${EXTRA_ARGS[@]}"

echo ""
echo "=== 编译 $VARIANT 版 ==="
# MSVC 输出是 GBK，转成 UTF-8 才能正常显示中文报错
cmake --build "$BUILD_DIR" 2>&1 | iconv -f GBK -t UTF-8 2>/dev/null || cmake --build "$BUILD_DIR"

echo ""
echo "=== 产物 ==="
ls -la "$BUILD_DIR/bin/" 2>/dev/null || true
```

注意：mac 分支里 `metal` 变体的产物落在 `engine/build/metal/bin/xbaos-engine`。

- [ ] **Step 8: 编译验证（mac 开发机）**

Run:
```bash
bash engine/build.sh metal
```
Expected: 生成 `engine/build/metal/bin/xbaos-engine`（无后缀）。手动 smoke：
```bash
echo '{"id":1,"cmd":"ping"}' | ./engine/build/metal/bin/xbaos-engine
```
Expected: 输出一行 JSON，`backends` 数组包含 `cpu` 与 `metal`。

- [ ] **Step 9: 编译验证（win 开发机，回归）**

Run:
```bash
bash engine/build.sh vulkan
```
Expected: 生成 `engine/build/vulkan/bin/xbaos-engine.exe`，`backends` 含 `cpu` 与 `vulkan`，行为与改动前一致。

- [ ] **Step 10: Commit**

```bash
git add engine/CMakeLists.txt engine/src/main.cpp engine/build.sh
git commit -m "feat(engine): whisper 引擎支持 macOS（Metal+CPU 单二进制）"
```

---

## Task 2: ONNX 引擎 CMake 跨平台化 + onnxruntime macOS 库

**Files:**
- Modify: `engine-onnx/CMakeLists.txt`（工具链门禁、onnxruntime 平台库、产物名、`CMAKE_VS_PLATFORM_NAME` 限定）
- Modify: `engine-onnx/build.sh`（mac 分支）
- Modify: `tools/fetch-deps.mjs`（新增 onnxruntime macOS x64/arm64 库来源）

**Interfaces:**
- Produces: 编译产物
  - macOS：`engine-onnx/build/bin/xbaos-engine-asr`（无后缀）
  - Windows 不变：`engine-onnx/build/bin/xbaos-engine-asr.exe`
- Consumes: onnxruntime 预编译库，按平台与架构落位（mac arm64 取 `osx-arm64`，mac x64 取 `osx-x86_64`，win 维持 `win-x64`）

**背景（onnxruntime 怎么拿）：** sherpa-onnx 的 CMake（`engine/third_party/sherpa-onnx/cmake/onnxruntime.cmake`）通过 FetchContent 拉 onnxruntime 预编译包，并按 `CMAKE_VS_PLATFORM_NAME` + 编译器判断目标平台。Windows 走 `win-x64` 静态包。macOS 上 sherpa 官方提供 `osx-arm64` 与 `osx-x86_64` 两套动态库（`.dylib`），需把 URL 与平台判定指到对应那套。

- [ ] **Step 1: 放宽工具链门禁**

`engine-onnx/CMakeLists.txt` 第 20-22 行，把 FATAL_ERROR 改成接受 MSVC 或 AppleClang：

```cmake
if(NOT MSVC AND NOT APPLE)
    message(FATAL_ERROR "本引擎支持 MSVC（Windows）与 AppleClang（macOS）工具链。当前编译器：${CMAKE_CXX_COMPILER_ID}")
endif()
```

- [ ] **Step 2: `/utf-8` 与静态 CRT 限定到 MSVC**

第 32 行 `add_compile_options(/utf-8)` 与第 34-36 行的 `CMAKE_MSVC_RUNTIME_LIBRARY` 包进 `if(MSVC) ... endif()`。macOS 系统库静态链接，不需要等价设置。

- [ ] **Step 3: `CMAKE_VS_PLATFORM_NAME` 只在 MSVC 设**

第 79-85 行的 `CMAKE_VS_PLATFORM_NAME` 判断是 onnxruntime 的 win 预编译包用来挑 `X64` 的。mac 上走不到这条（Ninja + AppleClang 不触发 win 分支），包进 `if(MSVC)` 里，避免 mac 上被误设成 `X64` 而选到 win 包：

```cmake
if(MSVC AND NOT CMAKE_VS_PLATFORM_NAME)
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(CMAKE_VS_PLATFORM_NAME X64)
    else()
        set(CMAKE_VS_PLATFORM_NAME Win32)
    endif()
endif()
```

- [ ] **Step 4: onnxruntime 平台与架构判定（mac）**

在 `add_subdirectory("${SHERPA_DIR}" ...)`（第 87 行）**之前**，按平台注入 onnxruntime 的目标选择。sherpa 的 `onnxruntime.cmake` 用 `ONNXRUNTIME_ROOT` 或平台变量定位库；这里统一通过设置 onnxruntime 的平台标识，让 FetchContent 拿到 mac 对应那套：

```cmake
# onnxruntime 平台库：Windows 维持 win-x64 静态；macOS 按本机架构取 osx-arm64 / osx-x86_64
if(APPLE)
    set(ONNXRUNTIME_OSX_ARCH "arm64" CACHE STRING "macOS onnxruntime 架构" FORCE)
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64)$")
        set(ONNXRUNTIME_OSX_ARCH "x86_64" CACHE STRING "macOS onnxruntime 架构" FORCE)
    endif()
    # sherpa 的 onnxruntime.cmake 读到该变量后会拉 osx-<arch> 的动态库
    message(STATUS "onnxruntime macOS 目标：osx-${ONNXRUNTIME_OSX_ARCH}")
elseif(MSVC)
    # 现状：win-x64 静态包（维持）
    message(STATUS "onnxruntime Windows 目标：win-x64（静态）")
endif()
```

> 实现说明：sherpa-onnx 官方仓库的 `cmake/onnxruntime.cmake` 在不同版本里对 macOS 库来源的变量名略有差异（`ONNXRUNTIME_OSX_ARCH` 或等价的 `ONNXRUNTIME_BINARY_URL`）。落地时**先读 `engine/third_party/sherpa-onnx/cmake/onnxruntime.cmake`**（fetch-deps 拉下 sherpa 后），确认它实际读取的变量名，再按真实变量名注入。若该文件只支持 `win-x64` 静态包、没有 mac 动态库分支，则需在该 cmake 里补一个 `osx-arm64`/`osx-x86_64` 动态库下载分支（URL 与 sha256 来自 onnxruntime 官方 release 的 `onnxruntime-osx-<arch>-<ver>` 包），并把库路径指向 `build/_deps/onnxruntime/`。这一步以真实 cmake 内容为准，不臆造变量名。

- [ ] **Step 5: 产物输出目录**

第 133-134 行 `RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"` 不变。macOS 上 `xbaos-engine-asr` 无后缀，CMake 自动处理。

- [ ] **Step 6: fetch-deps.mjs 增加 onnxruntime macOS 库来源**

`tools/fetch-deps.mjs` 目前只扫 github 归档 → codeload。onnxruntime 的预编译 `.zip`（`onnxruntime-osx-arm64-*.zip` / `onnxruntime-osx-x86_64-*.zip`）来自 GitHub release 资产，不是归档。在该文件末尾（`process.exit` 之前）增加一个针对 onnxruntime macOS 资产的小节：

```javascript
// onnxruntime macOS 预编译库（release 资产，非归档）：
//   arm64 取 onnxruntime-osx-arm64-<ver>-osx-arm64.zip（或 osx-arm64）
//   x64   取 onnxruntime-osx-x86_64-<ver>-osx-x86_64.zip
// 落到 engine-onnx/ 下，sherpa 的 onnxruntime.cmake 优先读本地文件。
const ORT_VERSION = '1.17.0' // 与 sherpa 当前依赖的 onnxruntime 版本对齐
const ortBase = process.arch === 'arm64' ? 'osx-arm64' : 'osx-x86_64'
const ortZip = `onnxruntime-${ortBase}-${ORT_VERSION}-${ortBase}.zip`
const ortUrl = `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/${ortZip}`
const ortTarget = path.join(root, ortZip)
if (!fs.existsSync(ortTarget) || fs.statSync(ortTarget).size <= 1024) {
  process.stdout.write(`下载 onnxruntime  ${ortZip} … `)
  try {
    execFileSync('curl', ['-sL', '--noproxy', '*', '--max-time', '600', '-o', ortTarget, ortUrl], { stdio: 'ignore' })
    console.log(`${(fs.statSync(ortTarget).size / 1048576).toFixed(1)} MB`)
  } catch {
    console.log('失败')
    failed++
  }
}
```

注意：`root` 在 mac 开发机上应是 `engine-onnx`（脚本默认值），保证 zip 落在 sherpa cmake 会找的位置。版本 `1.17.0` 需与 sherpa 当前声明的 onnxruntime 版本一致 —— 落地时读 `engine/third_party/sherpa-onnx/cmake/onnxruntime.cmake` 里的实际版本号对齐。

- [ ] **Step 7: build.sh 增加 mac 分支**

`engine-onnx/build.sh` 仿照 Task 1 的 `engine/build.sh`：`uname` 为 `Darwin` 时跳过 `source env.sh`，直接用系统 cmake/ninja 配置 `engine-onnx`。Windows 原逻辑（source `engine/env.sh`）保持不变：

```bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

BUILD_DIR="engine-onnx/build"

if [ "${1:-}" = "clean" ]; then
    rm -rf "$BUILD_DIR"
    echo "已清理 $BUILD_DIR"
    exit 0
fi

if [ ! -f engine/third_party/sherpa-onnx/CMakeLists.txt ]; then
    echo "错误：找不到 engine/third_party/sherpa-onnx" >&2
    exit 1
fi

if [ "$(uname -s)" = "Darwin" ]; then
    if ! command -v cmake > /dev/null 2>&1; then
        echo "错误：找不到 cmake（brew install cmake ninja）" >&2
        exit 1
    fi
    cmake -S engine-onnx -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release
    cmake --build "$BUILD_DIR"
else
    # Windows（Git Bash）：载入 MSVC / CMake / Ninja 环境
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/../engine/env.sh" > /dev/null
    cmake -S engine-onnx -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release
    cmake --build "$BUILD_DIR"
fi

# 产物按平台后缀判定
EXE="$BUILD_DIR/bin/xbaos-engine-asr"
[ "$(uname -s)" = "Darwin" ] || EXE="$EXE.exe"
if [ -f "$EXE" ]; then
    SIZE=$(stat -f%z "$EXE" 2>/dev/null || stat -c%s "$EXE" 2>/dev/null || echo 0)
    echo ""
    echo "构建完成：$EXE"
    printf "产物大小：%.1f MB\n" "$(echo "$SIZE / 1048576" | bc -l 2>/dev/null || echo 0)"
else
    echo "构建失败：没有生成 $EXE" >&2
    exit 1
fi
```

（mac 用 `stat -f%z`，linux/win 用 `stat -c%s`，两个都试。）

- [ ] **Step 8: 编译验证（mac 开发机）**

Run:
```bash
bash engine-onnx/build.sh
```
Expected: 生成 `engine-onnx/build/bin/xbaos-engine-asr`（无后缀），链接到本机架构的 onnxruntime 库。

- [ ] **Step 9: 编译验证（win 开发机，回归）**

Run:
```bash
bash engine-onnx/build.sh
```
Expected: 生成 `engine-onnx/build/bin/xbaos-engine-asr.exe`，行为与改动前一致。

- [ ] **Step 10: Commit**

```bash
git add engine-onnx/CMakeLists.txt engine-onnx/build.sh tools/fetch-deps.mjs
git commit -m "feat(engine-onnx): ONNX 引擎支持 macOS（onnxruntime osx 库）"
```

---

## Task 3: JS 层按平台分叉引擎文件名（model-catalog.js）

**Files:**
- Modify: `electron/model-catalog.js`（`ARCH_INFO` 的 `exe` / `devExe` 按 `process.platform` 分叉）
- Test: `tools/unit-check.ts`（新增引擎文件名按平台解析的断言）

**Interfaces:**
- Consumes: `process.platform`（运行时）
- Produces: 在 darwin 上：
  - whisper：`exe: 'xbaos-engine'`，`devExe: ['engine/build/metal/bin/xbaos-engine', 'engine/build/cpu/bin/xbaos-engine']`
  - sherpa：`exe: 'xbaos-engine-asr'`，`devExe: ['engine-onnx/build/bin/xbaos-engine-asr']`
  - 在 win32 上保持 `.exe` 后缀与现有 devExe 不变

- [ ] **Step 1: 先写 unit-check 断言（失败态）**

在 `tools/unit-check.ts` 末尾（现有断言之后的合适位置，例如「引擎后端」相关区附近）新增一段，验证 `ARCH_INFO` 的平台分叉：

```typescript
import { ARCH_INFO } from '../electron/model-catalog.js'

// 引擎可执行文件名必须按当前平台解析：mac 无 .exe，win 有 .exe。
// 用 process.platform 在打包/开发时各自取值，这里只断言「当前平台拿到的是当前平台的后缀」，
// 不假设打包机是 mac 还是 win。
{
  const isMac = process.platform === 'darwin'
  const suffix = isMac ? '' : '.exe'
  check(
    '引擎文件名：whisper 按平台后缀',
    ARCH_INFO.whisper.exe === `xbaos-engine${suffix}`,
    ARCH_INFO.whisper.exe,
  )
  check(
    '引擎文件名：sherpa 按平台后缀',
    ARCH_INFO.sherpa.exe === `xbaos-engine-asr${suffix}`,
    ARCH_INFO.sherpa.exe,
  )
  check(
    '引擎 devExe：whisper 路径后缀与平台一致',
    ARCH_INFO.whisper.devExe.every((p) => p.endsWith(suffix) || suffix === ''),
    JSON.stringify(ARCH_INFO.whisper.devExe),
  )
}
```

> 说明：unit-check 在**当前开发机**上跑。断言写的是「当前平台的后缀」，所以 mac 机上断言无后缀、win 机上断言有 `.exe` —— 同一份测试在两平台都自洽。

- [ ] **Step 2: 运行确认失败**

Run:
```bash
npm run unit
```
Expected: 新增的 3 条断言在 mac 上会失败（当前 `ARCH_INFO` 写死 `.exe`）；在 win 上可能通过。确认在 mac 上失败、且失败原因是 `exe` 仍带 `.exe`。

- [ ] **Step 3: model-catalog.js 按平台分叉**

`electron/model-catalog.js` 顶部（第 20-22 行的常量区附近）加一个平台辅助，并改写 `ARCH_INFO`：

```javascript
import process from 'node:process'

/** 可执行文件后缀：Windows 带 .exe，macOS / Linux 无。引擎按平台选。 */
const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : ''

const WHISPER_DEV_EXE =
  process.platform === 'darwin'
    ? [
        'engine/build/metal/bin/xbaos-engine',
        'engine/build/cpu/bin/xbaos-engine',
      ]
    : [
        'engine/build/vulkan/bin/xbaos-engine.exe',
        'engine/build/cpu/bin/xbaos-engine.exe',
      ]

const SHERPA_DEV_EXE =
  process.platform === 'darwin'
    ? ['engine-onnx/build/bin/xbaos-engine-asr']
    : ['engine-onnx/build/bin/xbaos-engine-asr.exe']
```

`ARCH_INFO` 里两个条目的 `exe` / `devExe` 改为引用上面的值：

```javascript
export const ARCH_INFO = {
  [ARCH_WHISPER]: {
    id: ARCH_WHISPER,
    engine: 'whisper.cpp',
    runtime: 'GGML',
    exe: `xbaos-engine${EXE_SUFFIX}`,
    devExe: WHISPER_DEV_EXE,
    envVar: 'XBAOS_ENGINE_EXE',
    caps: { prompt: true, translate: true, decode: true, gpu: true },
  },
  [ARCH_SHERPA]: {
    id: ARCH_SHERPA,
    engine: 'sherpa-onnx',
    runtime: 'ONNX Runtime',
    exe: `xbaos-engine-asr${EXE_SUFFIX}`,
    devExe: SHERPA_DEV_EXE,
    envVar: 'XBAOS_ENGINE_ASR_EXE',
    caps: { prompt: false, translate: false, decode: false, gpu: false },
  },
}
```

> 注意：原 `caps` 块保留，本步骤只改 `exe` 与 `devExe` 两处。`envVar` 保留原名（`XBAOS_ENGINE_EXE` / `XBAOS_ENGINE_ASR_EXE`），不随平台变。

- [ ] **Step 4: 运行确认通过**

Run:
```bash
npm run unit
```
Expected: 全部断言通过（含新增 3 条）。在 mac 上 `ARCH_INFO.whisper.exe === 'xbaos-engine'`、`ARCH_INFO.sherpa.exe === 'xbaos-engine-asr'`。

- [ ] **Step 5: 同步 paths.js 注释（非行为改动）**

`electron/paths.js` 第 8 行的开发/打包态示例注释提到 `xbaos-engine.exe`，是文档性注释。改准确，避免误导：

```javascript
 * 开发态和打包态的目录布局完全不同，所有「东西在哪」的判断都收敛到这一个文件，
 * 免得散落到各处后打包时才逐个爆雷。
 *
 * 开发态                     打包态
 * <repo>/engine/build/...    <resources>/engine/xbaos-engine[.exe]
 * <repo>/models/             <resources>/models/  与  <userData>/models/
 * <repo>/dist/               <resources>/app.asar/dist/
```
（只改注释里的产物名示意，`resolveEngineExe` 函数体不动 —— 它已经按 `info.exe` 取路径，平台分叉由 Task 3 的 `ARCH_INFO` 提供。）

- [ ] **Step 6: 运行完整校验**

Run:
```bash
npm run verify
```
Expected: typecheck + build:ui + ui-probe 全绿（引擎名分叉不影响 UI 探针；探针只到界面层）。

- [ ] **Step 7: Commit**

```bash
git add electron/model-catalog.js electron/paths.js tools/unit-check.ts
git commit -m "feat(js): 引擎文件名按平台分叉（mac 无 .exe，devExe 走 metal 变体）"
```

---

## Task 4: 主进程 Vulkan 诊断与状态限定到 win32（main.js）

**Files:**
- Modify: `electron/main.js`（`envDisablesVulkan` / `readVulkanLayers` / `describeExitCode` / `applyBackendIntent` / `readVulkanDisabled` / `writeVulkanDisabled` 的平台门控）
- Test: `tools/unit-check.ts`（`applyBackendIntent` 在 mac 上不走 vulkan 分支的纯逻辑断言 —— 该函数是模块级且依赖 client 实例，改为对「后端意图字符串映射」的纯函数抽出来测，见 Step 1）

**Interfaces:**
- Consumes: `process.platform`
- Produces: 在 darwin 上：
  - `envDisablesVulkan()` 恒返回 `false`（mac 没有 GGML_DISABLE_VULKAN 的语义，Metal 不受该变量控制）
  - `readVulkanLayers()` 返回空对象 `{}`（不执行 reg.exe）
  - `applyBackendIntent` 在 mac 上把 `'vulkan'` 意图映射为 `'metal'`（whisper arch），`'gpu'` 同 `'metal'`
  - `describeExitCode` 在 mac 上不用 Windows 退出码翻译表

**背景：** 这些函数在 Windows 上服务于「排查 Vulkan 隐式层导致引擎崩溃」。macOS 上 Metal 是系统后端，不存在隐式层，也没有注册表；强行读 `HKLM`/`HKCU` 在 mac 上是无效调用。要做的不是删掉这些函数（Windows 还要用），而是让它们**只在 win32 生效**，mac 上走中性分支。

- [ ] **Step 1: 把后端意图映射抽成可测的纯函数**

目前 `applyBackendIntent`（`electron/main.js` 第 614-636 行）是模块级 async 函数，依赖 `client` 实例与磁盘状态，无法在 unit-check 里直接测。为可测，新增一个纯函数 `backendIntentToEngineBackend(backend, arch, isWindows, vulkanDisabled, envForced)`，把「意图字符串 → 引擎 backend 参数 + 是否需要重启」的决策集中到这里；`applyBackendIntent` 变成它的薄封装（负责真的 `setDisableVulkan` 与写盘）。

在 `electron/main.js` 中，把第 603-636 行替换为：

```javascript
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

/**
 * 把界面上的「推理后端」意图落到引擎进程上（applyBackendIntent 的薄封装）。
 * 真正需要重启进程的是 win 上 setDisableVulkan；mac 上无等价操作。
 */
async function applyBackendIntent(client, backend, arch = ARCH_WHISPER) {
  const isWindows = process.platform === 'win32'
  const result = backendIntentToEngineBackend({
    backend,
    arch,
    isWindows,
    gpuDisabled: client.disableVulkan,
    envForced: envDisablesVulkan(),
  })
  if (result.disableGpu && !client.disableVulkan) await client.setDisableVulkan(true)
  if (!result.disableGpu && client.disableVulkan) {
    await client.setDisableVulkan(false)
    writeVulkanDisabled(false)
  }
  return result.backend
}
```

注意：`backendIntentToEngineBackend` 要被 unit-check 导入，所以**必须 `export`**（当前 `main.js` 是 ESM，`main` 字段是 `electron/main.js`，导出无害）。

- [ ] **Step 2: envDisablesVulkan 限定 win32**

`electron/main.js` 第 437-439 行：

```javascript
function envDisablesVulkan() {
  // 该开关只对 Windows 的 Vulkan 构建有意义；macOS 的 Metal 不受它控制
  if (process.platform !== 'win32') return false
  return typeof process.env.GGML_DISABLE_VULKAN === 'string'
}
```

- [ ] **Step 3: readVulkanLayers 限定 win32**

第 451-485 行，函数开头加短路：

```javascript
async function readVulkanLayers() {
  // Vulkan 隐式层是 Windows 注册表概念，macOS/Linux 上没有，直接返回空
  if (process.platform !== 'win32') return {}
  const targets = [
    ['HKLM', 'SOFTWARE\\Khronos\\Vulkan\\ImplicitLayers'],
    ...
  ]
  // （其余原逻辑不变）
```

- [ ] **Step 4: describeExitCode 限定 Windows 码表**

第 488-495 行：

```javascript
function describeExitCode(code) {
  // Windows 退出码（NTSTATUS）翻译；非 Windows 平台用通用描述
  if (typeof code === 'number' && process.platform === 'win32') {
    if (code === 0) return '正常退出'
    if (code === 3221225477) return '0xC0000005 访问违例（原生崩溃）'
    if (code === 3221225781) return '0xC0000135 缺少依赖 DLL'
    if (code === 3221225595) return '0xC000007B 映像格式不匹配（位数或 DLL 损坏）'
    return `0x${(code >>> 0).toString(16).toUpperCase()}`
  }
  if (code === 0) return '正常退出'
  if (typeof code === 'number') return `退出码 ${code}`
  return '(无退出码)'
}
```

- [ ] **Step 5: 单实例写盘路径（mac userData）不变，但确认 readVulkanDisabled/writeVulkanDisabled 仅在 win 被调用**

第 414-424 行的 `readVulkanDisabled` / `writeVulkanDisabled` 读写的 `engineStatePath()` 是 `userData` 下的 JSON。mac 上它们会被 `applyBackendIntent` 调用，但因 `result.disableGpu` 在 mac 上恒为 `false`（见 Step 1），`writeVulkanDisabled` 不会被触发。为稳妥，给 `writeVulkanDisabled` 加平台门控，mac 上不写这个文件：

```javascript
function writeVulkanDisabled(value) {
  // 该状态只服务于 Windows 的 Vulkan 禁用；macOS 不写
  if (process.platform !== 'win32') return Promise.resolve()
  return fs.writeFile(
    engineStatePath(),
    JSON.stringify({ vulkanDisabled: value === true }, null, 2),
  )
}
```

第 550 行的 `new EngineClient('', [], { disableVulkan: readVulkanDisabled() || envDisablesVulkan() })` 不变 —— `envDisablesVulkan()` 在 mac 上已恒 false，`readVulkanDisabled()` 在 mac 上读不到文件时返回 false，结果就是 mac 上 `disableVulkan` 永远 false，符合预期。

- [ ] **Step 6: 写 unit-check 断言**

`tools/unit-check.ts` 末尾新增，导入纯函数（注意它现在是 `main.js` 导出的，需确认 import 路径能被 unit-check 的 bundler 解析；unit-check 用 rolldown 打包，import `'../electron/main.js'` 会拉起整条 electron 依赖链 —— 因此**改为只 import 这个纯函数所在的最小模块**。

为可测性，把 `backendIntentToEngineBackend` 从 `main.js` 抽到独立模块 `electron/backend-intent.js`，`main.js` 再 import 它。这样 unit-check 只 import 轻量模块，不拉起 electron。

Create: `electron/backend-intent.js`

```javascript
import { ARCH_WHISPER } from './model-catalog.js'

/**
 * 纯函数：把界面「推理后端」意图映射成引擎 load 的 backend 参数。
 * （从 main.js 抽出的可测核心，见计划 Task 4）
 */
export function backendIntentToEngineBackend({
  backend = 'auto',
  arch = ARCH_WHISPER,
  isWindows = false,
  gpuDisabled = false,
  envForced = false,
} = {}) {
  if (arch !== ARCH_WHISPER) return { backend: 'cpu', disableGpu: false }

  if (isWindows) {
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
```

`electron/main.js` 改为 `import { backendIntentToEngineBackend } from './backend-intent.js'`，并删除 Step 1 里写在 main.js 内的那份纯函数定义（只保留 `applyBackendIntent` 薄封装）。

`tools/unit-check.ts` 新增：

```typescript
import { backendIntentToEngineBackend } from '../electron/backend-intent.js'

/* ---- 推理后端意图按平台映射 ---- */
{
  check(
    'mac：whisper 的 vulkan 意图映射为 metal',
    backendIntentToEngineBackend({ backend: 'vulkan', arch: 'whisper', isWindows: false }).backend === 'metal',
  )
  check(
    'mac：whisper 的 cpu 意图映射为 cpu 且不禁 GPU',
    (() => {
      const r = backendIntentToEngineBackend({ backend: 'cpu', arch: 'whisper', isWindows: false })
      return r.backend === 'cpu' && r.disableGpu === false
    })(),
  )
  check(
    'mac：whisper 的 auto 意图映射为 auto',
    backendIntentToEngineBackend({ backend: 'auto', arch: 'whisper', isWindows: false }).backend === 'auto',
  )
  check(
    'win：whisper 的 cpu 意图映射为 cpu 且需要禁 GPU',
    (() => {
      const r = backendIntentToEngineBackend({ backend: 'cpu', arch: 'whisper', isWindows: true })
      return r.backend === 'cpu' && r.disableGpu === true
    })(),
  )
  check(
    'win：whisper 的 vulkan 意图映射为 vulkan',
    backendIntentToEngineBackend({ backend: 'vulkan', arch: 'whisper', isWindows: true }).backend === 'vulkan',
  )
  check(
    'win：envForced 时 vulkan 意图被纠正为 cpu',
    backendIntentToEngineBackend({
      backend: 'vulkan', arch: 'whisper', isWindows: true, envForced: true,
    }).backend === 'cpu',
  )
  check(
    'sherpa：任何平台任何意图都只走 cpu',
    backendIntentToEngineBackend({ backend: 'vulkan', arch: 'sherpa', isWindows: true }).backend === 'cpu' &&
      backendIntentToEngineBackend({ backend: 'vulkan', arch: 'sherpa', isWindows: false }).backend === 'cpu',
  )
}
```

- [ ] **Step 7: 运行 unit 与 verify**

Run:
```bash
npm run unit
npm run verify
```
Expected: 全部通过。

- [ ] **Step 8: Commit**

```bash
git add electron/backend-intent.js electron/main.js tools/unit-check.ts
git commit -m "feat(js): Vulkan 诊断与后端意图映射限定到 win32，mac 走 Metal"
```

---

## Task 5: spawn 跨平台 + UI 后端标签按平台（Metal/Vulkan）

**Files:**
- Modify: `electron/engine-client.js`（`windowsHide` 只在 win32 传；`GGML_DISABLE_VULKAN` 只在 win 设）
- Modify: `src/views/SettingsView.vue`（`BACKEND_OPTIONS` 的 `vulkan` 项在 mac 上改成 `metal`，文案随平台）
- Modify: `src/components/AppStatusBar.vue`（后端标签：mac 显示 Metal，win 显示 Vulkan）
- Modify: `src/types/index.ts` 与 `src/types/engine.ts`（`InferenceBackend` 增加 `'metal'` 选项，仅 mac 路径使用）
- Test: `tools/unit-check.ts`（标签映射纯函数断言，若有；否则走 verify）

**Interfaces:**
- Consumes: `process.platform`（主进程侧）、`app:info` 下发的 `platform`（渲染侧）
- Produces: 在 mac 上：
  - 引擎 spawn 不带 `windowsHide`（Node 在 mac 上忽略未知选项，但按平台条件传更干净）
  - `GGML_DISABLE_VULKAN` 不被设置（mac 的 Metal 不受它控制）
  - 设置页 whisper 的 GPU 选项文案显示 Metal，值仍存 `'vulkan'`（兼容现有存档）或存 `'metal'`（见 Step 4 的决策：存 `'metal'`，读取时把旧存档的 `'vulkan'` 在 mac 上按 metal 解释）

**背景：** 引擎层（Task 1）已在 mac 上把 GPU 后端叫 `metal`。但渲染层三处仍写死 `vulkan`：设置页选项、状态条标签、类型。它们读的是 `app:info` 的 `platform`，可按平台切换文案，不必改存档值域（`'vulkan'` 在 mac 上语义化为「用 GPU（Metal）」即可，最小改动）。

- [ ] **Step 1: engine-client.js spawn 选项按平台**

`electron/engine-client.js` 第 195-200 行：

```javascript
        const env = { ...process.env }
        if (this.#disableVulkan && process.platform === 'win32') env.GGML_DISABLE_VULKAN = '1'

        const spawnOpts = {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          env,
        }
        // windowsHide 只在 Windows 有意义：避免打包后弹黑框
        if (process.platform === 'win32') spawnOpts.windowsHide = true
        proc = spawn(this.#exe, this.#spawnArgs, spawnOpts)
```

（`#disableVulkan` 在 mac 上恒为 false（Task 4），`GGML_DISABLE_VULKAN` 行保留平台门控只是双保险。）

- [ ] **Step 2: 渲染侧拿 platform 决定文案**

渲染进程已有 `window.xbaos` preload 桥。确认 `app:info` 的 `platform` 已在 preload 暴露（`electron/preload.cjs` 里 `platform` 字段）。渲染侧组件里用 `appInfo.platform === 'darwin'` 切换文案。

- [ ] **Step 3: SettingsView.vue 后端选项按平台**

`src/views/SettingsView.vue` 第 73-85 行的 `BACKEND_OPTIONS`，把 `'vulkan'` 项的 label 按平台化：

```javascript
const isMac = bridge?.platform === 'darwin' // 或从已注入的 appInfo 取
const BACKEND_OPTIONS = [
  {
    value: 'auto',
    label: '自动',
    hint: isMac
      ? '检测到 Apple GPU（Metal）时启用加速；后端异常时自动回退 CPU 重试'
      : '检测到支持 Vulkan 的显卡时启用加速；显卡后端异常时自动回退 CPU 重试',
  },
  {
    value: 'cpu',
    label: '仅 CPU',
    hint: '完全不加载显卡后端，兼容性最好，速度取决于处理器性能',
  },
  isMac
    ? { value: 'vulkan', label: '强制 Metal', hint: '需要 Apple GPU，若不可用会导致识别失败' }
    : { value: 'vulkan', label: '强制 Vulkan', hint: '需要显卡驱动支持，若不可用会导致识别失败' },
] as const
```

注意：**value 仍存 `'vulkan'`**（存档兼容、与 `InferenceBackend` 类型域一致、引擎侧在 mac 上把 `'vulkan'` 意图映射为 `'metal'`（Task 4 的 `backendIntentToEngineBackend`））。只是**显示文案**在 mac 上写成 Metal。这样不动 `src/types/index.ts` 的 `InferenceBackend = 'auto' | 'cpu' | 'vulkan'`，改动面最小。

第 77 行的 `hint`（Vulkan）随 `isMac` 切换。

- [ ] **Step 4: 类型域保持不变（最小改动确认）**

`src/types/index.ts` 第 239 行 `InferenceBackend` 与 `src/types/engine.ts` 第 11 行 `EngineBackendName = 'cpu' | 'vulkan'` **不改** —— 存档与类型域维持 `vulkan`，mac 上语义化为 Metal。`EngineActiveBackend`（引擎实际回的上报，`'cpu' | 'gpu' | 'unknown'`）也不改：mac 上 whisper 引擎实际回的后端字符串是 `'gpu'`（Task 1 里 `g_model.backend = cparams.use_gpu ? "gpu" : "cpu"`，Metal 也算 gpu）。渲染侧把 `'gpu'` 在 mac 上显示为 Metal。

- [ ] **Step 5: AppStatusBar.vue 后端标签按平台**

`src/components/AppStatusBar.vue` 第 17 行附近（`settings.backend === 'vulkan'` 显示 'Vulkan' 处）改为按平台：

```javascript
if (settings.backend === 'vulkan') return isMac ? 'Metal' : 'Vulkan'
```

其中 `isMac` 来自该组件已注入的 platform（若组件未注入，从 `window.xbaos` 或 store 取；保持与 SettingsView 同一来源）。同理检查 `src/views/HomeView.vue` 第 60-61 行与 `src/utils/reasoningDepth.ts` 第 75-77 行（`backend === 'gpu'` 的速率估算）—— 这两处按 `'gpu'` 字符串算速率，mac 上 Metal 同样回 `'gpu'`，**无需改**（速率是估算，gpu/cpu 两档，Metal 归入 gpu 档合理）。

- [ ] **Step 6: 运行 verify**

Run:
```bash
npm run verify
```
Expected: typecheck + build + 探针全绿。

- [ ] **Step 7: 人工 UI 确认（mac 开发机）**

Run:
```bash
npm run dev:ui
```
打开设置页，确认 whisper 的 GPU 选项在 mac 上显示「强制 Metal」/「检测到 Apple GPU（Metal）…」；状态条在选 metal 时显示「Metal」。Windows 上（另开 win 机或 `?` 无法切平台）显示 Vulkan 文案不变。

- [ ] **Step 8: Commit**

```bash
git add electron/engine-client.js src/views/SettingsView.vue src/components/AppStatusBar.vue
git commit -m "feat(ui): 引擎 spawn 与后端文案按平台（mac 显示 Metal）"
```

---

## Task 6: mac 打包配置（icon.icns + electron-builder + npm scripts + gitignore）

**Files:**
- Modify: `tools/make-icons.py`（新增 `build/icon.icns` 输出）
- Modify: `electron-builder.yml`（新增 `mac:` 段；`extraResources` 引擎按平台分叉）
- Modify: `package.json`（新增 `dist:mac` / `dist:mac:dir` 脚本）
- Modify: `.gitignore`（放行 `build/icon.icns`）

**Interfaces:**
- Consumes: Task 1/2 的引擎产物（mac 上 `xbaos-engine` / `xbaos-engine-asr` 无后缀）
- Produces: `electron-builder --mac` 可用的 `mac:` 配置；`build/icon.icns`

**背景：** 现有 `electron-builder.yml` 只有 `win:` 段，`extraResources` 写死 `xbaos-engine.exe`。mac 段需要：目标 dmg、双架构、icns、**引擎 extraResources 按平台条件化**（builder 的 `extraResources` 不支持 per-platform 的 `from`，需在两个平台各自的段里写，或用 `mac:` 段内的独立 `extraResources`）。electron-builder 允许在平台段里覆盖 `extraResources`，所以把引擎资源分别写在 `win:` 与 `mac:` 段。

- [ ] **Step 1: make-icons.py 输出 icns**

`tools/make-icons.py` 的 `main()`（第 145-155 行）在写出 `icon.ico` 后增加 icns 生成。mac 的 `.icns` 是 Apple 专有格式，纯标准库手写 icns 较繁琐（icns 容器 + ic07–ic11 多个 16/32/64/128/256/512/1024 PNG 条目 + `iconutil` 校验）。**优先用系统 `iconutil`**（mac 开发机自带，把 PNG 放进 `.iconset` 目录后转换）：

```python
def build_icns(images, out_dir, root):
    """mac 的 .icns：优先走系统 iconutil；不可用时回退手写 icns 容器。"""
    import shutil, subprocess, tempfile
    iconset = out_dir / "AppIcon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    # iconutil 期望的文件名 → 尺寸映射
    want = [
        ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
    ]
    for name, s in want:
        if s in images:
            (iconset / name).write_bytes(images[s])
    icns_path = out_dir / "icon.icns"
    if shutil.which("iconutil") is not None:
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns_path)], check=True)
        shutil.rmtree(iconset)
        print("icon.icns (via iconutil)")
    else:
        # 无 iconutil（非 mac 机，例如 Windows 打包机）：手写一个最小 icns 容器，
        # 只含 512 与 256 两个 icns 条目（icns 允许部分尺寸缺失，mac 会按可用
        # 最高分辨率缩放）。打包机若是 mac（正常情况），走上面的 iconutil 分支。
        def icns_entry(tag, png_bytes):
            return tag + struct.pack(">I", 8 + len(png_bytes)) + png_bytes
        container = b"icns"
        for tag, s in ((b"ic07", 128), (b"ic11", 512)):
            if s in images:
                container += icns_entry(tag, encode_png(images[s], s))
        icns_path.write_bytes(container)
        print("icon.icns (hand-rolled container: 128/512)")
```

`main()` 末尾调用 `build_icns(images, OUT, ROOT)`，并把 `1024` 加入渲染尺寸集合：`sizes = sorted(set(ICO_SIZES + [512, 1024]))`。

Run:
```bash
python3 tools/make-icons.py
```
Expected（mac 机）：生成 `build/icon.icns`（iconutil 产物）。

- [ ] **Step 2: .gitignore 放行 build/icon.icns**

`.gitignore` 里 `*.icns` 目前**不存在**（现状忽略的是 `*.exe *.dll *.dylib *.so *.lib *.node *.blockmap *.obj *.pdb`），但 `build/` 下产物是否入库要看有没有整体忽略。检查：`build/` 目录的 `icon.ico`、`icon-*.png` 已入库（git status 应能看到），说明 `build/` 未被整体忽略。只需确认 `*.icns` 不在忽略名单（它不在），`build/icon.icns` 会正常入库。若为保险，显式加一条不忽略：

```gitignore
# 打包图标输入（build/ 下）：icns 必须随仓库，打包机才能用
!build/icon.icns
```
（仅当 `git check-ignore build/icon.icns` 报被忽略时才需要这条。）

- [ ] **Step 3: electron-builder.yml 引擎 extraResources 按平台分叉**

现状（第 31-40 行）把两套引擎的 `.exe` 写进顶层 `extraResources`。顶层配置对所有平台生效，`.exe` 路径在 mac 上不存在会报错。改成：**顶层只保留与平台无关的资源**（diarization、licenses、models 注释），**引擎可执行文件分别写进 `win:` 段与 `mac:` 段**。

把顶层 `extraResources`（第 31-67 行）里这两段引擎条目**移到平台段**，顶层只留 `diarization` 与 `licenses`：

顶层 `extraResources` 改为：
```yaml
extraResources:
  # 说话人分离小模型与许可：全平台共用
  - from: resources/diarization
    to: diarization
  - from: licenses
    to: licenses
    filter:
      - '**/*'
```

`win:` 段（第 69 行起）增加：
```yaml
win:
  extraResources:
    - from: engine/build/vulkan/bin/xbaos-engine.exe
      to: engine/xbaos-engine.exe
    - from: engine-onnx/build/bin/xbaos-engine-asr.exe
      to: engine/xbaos-engine-asr.exe
  target:
    - target: nsis
      arch: [x64]
  icon: build/icon.ico
  requestedExecutionLevel: asInvoker
  legalTrademarks: XBAOS
```
（保持原 `target` / `icon` / `requestedExecutionLevel` / `legalTrademarks` 不变，只把引擎 extraResources 移进来。）

新增 `mac:` 段（放在 `win:` 段之后、`fileAssociations` 之前）：
```yaml
mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch: [x64, arm64]
  icon: build/icon.icns
  extraResources:
    - from: engine/build/metal/bin/xbaos-engine
      to: engine/xbaos-engine
    - from: engine-onnx/build/bin/xbaos-engine-asr
      to: engine/xbaos-engine-asr
  # 未签名：关闭 signing 与公证。首次打开需「右键 → 打开」绕过 Gatekeeper
  identity: null
  notarize: false
  # app 的 bundle 名与 productName 一致
  artifactName: ${productName}-${version}-${arch}.${ext}
```

> 说明：
> - `identity: null` 让 builder 跳过代码签名（未签名 dmg 的前提）。
> - `notarize: false` 明确不做公证。
> - `arch: [x64, arm64]` 双架构；builder 会出两个 dmg（或在 universal 场景合一，此处按架构各出一份）。
> - 引擎 `from` 路径用 mac 无后缀名（Task 1/2 产物）；若开发机只编了 `cpu` 版没编 `metal` 版，`from` 指向不存在路径会让 builder 报错 —— 打包前必须先 `bash engine/build.sh metal` 与 `bash engine-onnx/build.sh`。
> - `fileAssociations`（第 94-100 行）保持顶层不动，是 Windows 概念；mac 上 builder 会忽略它（mac 文件关联走 UTI，本次不做）。为保险把 `fileAssociations` 移进 `win:` 段，避免 mac 段尝试处理它。

把第 94-100 行的顶层 `fileAssociations` 移到 `win:` 段内：
```yaml
win:
  ...
  fileAssociations:
    - ext: xbsgp
      name: XBAOS.SubtitleProject
      description: 小包听幕项目
      icon: build/icon.ico
      role: Editor
```
并从顶层删除 `fileAssociations`。

- [ ] **Step 4: package.json 增加 mac 打包脚本**

`package.json` 的 `scripts`（第 26-27 行）增加：

```json
    "dist:mac": "npm run build:ui && electron-builder --mac",
    "dist:mac:dir": "npm run build:ui && electron-builder --mac --dir",
```

放在现有 `dist` / `dist:dir` 之后。

- [ ] **Step 5: 打包验证（mac 开发机）**

前置：先编译两套引擎（mac 产物）。
```bash
bash engine/fetch-deps.sh            # whisper.cpp 源码（若缺）
bash engine/build.sh metal           # GGML 引擎（Metal+CPU）
# ONNX 引擎需要 sherpa-onnx 源码与 onnxruntime mac 库（Task 2 Step 4/6）
node tools/fetch-deps.mjs engine-onnx
bash engine-onnx/build.sh
```
Run:
```bash
npm run dist:mac:dir
```
Expected: 在 `release/` 下生成 `小包听幕.app`（mac-unpacked），其 `Contents/Resources/engine/` 下能看到 `xbaos-engine` 与 `xbaos-engine-asr`（无后缀），且 app 能 `open` 起来（未签名，需右键打开或 `spctl` 放行）。

Run:
```bash
npm run dist:mac
```
Expected: 生成 `release/小包听幕-1.3.0-beta-x64.dmg` 与 `...arm64.dmg`（两个架构各一）。

- [ ] **Step 6: 人工验证（mac 开发机）**

```bash
open release/mac/小包听幕.app   # 或 mount dmg 后拖到 /Applications
```
首次打开被 Gatekeeper 拦 → 右键「打开」→ 选择「打开」。应用启动后：
- 模型管理页可下载模型（或已放 `~/Library/Application Support/xbaos-subtitle-generator/models`）
- 选 whisper 模型 + Metal 后端能跑通识别
- 选 SenseVoice（ONNX）能跑通识别（CPU）

- [ ] **Step 7: Commit**

```bash
git add tools/make-icons.py electron-builder.yml package.json .gitignore build/icon.icns
git commit -m "feat(packaging): electron-builder mac 段 + icon.icns + dist:mac 脚本（未签名 dmg，双架构）"
```

---

## Task 7: 文档（README 系统要求 + Gatekeeper 说明）与全量回归

**Files:**
- Modify: `README.md`（系统要求表增加 macOS 行；下载段增加 macOS；构建段增加 mac 步骤；未签名 dmg 的 Gatekeeper 说明）
- Modify: `electron-builder.yml` 顶部注释（第 1-7 行硬约束说明，补充 mac 未签名口径）

**Interfaces:**
- Consumes: Task 1-6 的全部产物

**背景：** Review Focus 第 3 条要求文档写明未签名 dmg 的首次打开绕过路径，避免用户误以为装坏。README 当前只写 Windows。

- [ ] **Step 1: README 系统要求表增加 macOS 行**

`README.md` 第 45-54 行「系统要求」表，把「系统」行从「Windows 10 / 11（64 位）」改为「Windows 10 / 11（64 位）或 macOS（x64 / Apple Silicon）」，并在表下补一行说明：

```markdown
| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（64 位）或 macOS 12 及以上（x64 与 Apple Silicon 均支持） |
| 显卡 | Windows：支持 Vulkan 的显卡自动走 GPU，否则用 CPU。macOS：Apple GPU 走 Metal，否则用 CPU |
| 磁盘 | 安装后约 415 MB。识别模型需另行获取（约 140 MB ~ 1.6 GB，取决于所选档位） |
| 权限 | Windows 不需管理员；macOS 未签名版首次打开需右键「打开」绕过 Gatekeeper |
```

- [ ] **Step 2: README 下载段增加 macOS 与 Gatekeeper 说明**

`README.md` 第 25-43 行「下载」段，在 Windows 安装包句后增加：

```markdown
macOS 版（未签名 dmg，x64 与 arm64 各一份）见官网：https://subtitle.xbaos.com.cn

> **首次打开提示**：macOS 版当前**未经 Apple 代码签名与公证**。
> 从官网下载 dmg 后，双击装入 `/Applications`；**第一次**启动时系统会提示
> 「无法打开，因为无法验证开发者」。处理方式：在访达里对该 app 图标
> **右键 → 打开**，在弹窗里再点一次「打开」即可，此后正常双击就能启动。
> 这不是安装损坏，是未签名的正常现象（见下方「开发版获取」）。
```

- [ ] **Step 3: README 构建段增加 mac 步骤**

`README.md` 第 98-141 行「从源码构建」，在「环境」与「步骤」处补充 macOS 的引擎构建与打包命令：

```markdown
### macOS（未签名 dmg）

引擎（mac 需先有 cmake 与 ninja：`brew install cmake ninja`，clang 随 Xcode 自带）：

```bash
bash engine/fetch-deps.sh         # whisper.cpp 源码
bash engine/build.sh metal        # GGML 引擎（Metal + CPU 单二进制）
bash engine-onnx/build.sh         # ONNX 引擎（onnxruntime 自动取 osx 库）
```

打包（未签名，双架构 dmg）：

```bash
npm run dist:mac
```

产物在 `release/`：`小包听幕-<版本>-x64.dmg` 与 `小包听幕-<版本>-arm64.dmg`。
未签名与公证是**有意省略**的后续步骤（需要 Apple 开发者账号），当前 dmg 供本地与测试使用。
```

- [ ] **Step 4: electron-builder.yml 顶部注释补 mac 口径**

`electron-builder.yml` 第 1-7 行的硬约束注释，补一句：

```yaml
# 4. macOS 版当前未签名、未公证（identity: null / notarize: false），
#    首次打开需「右键 → 打开」绕过 Gatekeeper；Developer ID 签名与公证
#    是后续单独任务，不在本次范围内
```

- [ ] **Step 5: 全量回归**

Run:
```bash
npm run verify          # typecheck + build:ui + ui-probe
npm run unit            # 含 Task 3/4/5 新增断言
```
Expected: 全绿。

Windows 机（或 CI）上回归确认旧行为未破：
```bash
bash engine/build.sh vulkan
bash engine-onnx/build.sh
npm run dist:dir        # win-unpacked
npm run dist            # NSIS
```
Expected: 产物名、NSIS 配置、引擎 `.exe` 均与改动前一致。

- [ ] **Step 6: 提交文档**

```bash
git add README.md electron-builder.yml
git commit -m "docs: macOS 支持说明（系统要求 / 未签名 dmg / Gatekeeper 绕过 / 构建步骤）"
```

- [ ] **Step 7: 最终 Review Focus 复查**

逐条核对 Review Focus 的 5 条，确认对应实现与断言都到位：
1. 引擎 missing 不崩 → Task 3 的 `resolveEngineExe` 走 `source: 'missing'`（现状已有，未改）；人工在 mac 上不编引擎时启动，确认 `app:info` 的 `engines` 标 `available: false` 而应用不崩。
2. Vulkan 诊断 win32 限定 → Task 4 Step 2/3；unit-check 的 `backendIntentToEngineBackend` 断言覆盖 mac 路径。
3. Gatekeeper 说明 → Task 7 Step 2 文档。
4. 双架构 onnxruntime 库 → Task 2 Step 4/6；Task 6 Step 5 打包验证 arm64 与 x64 两个 dmg。
5. icns 入库 → Task 6 Step 1/2；`git status` 确认 `build/icon.icns` 未被忽略。

---

## 执行说明（给实现者 / subagent）

- 任务严格按 1→7 顺序执行；Task 4 依赖 Task 1/3 的平台语义，Task 5 依赖 Task 4，Task 6 依赖 Task 1/2 的引擎产物名。
- **Task 2 Step 4 与 Step 6 是唯一的「以真实文件为准」点**：sherpa 的 `onnxruntime.cmake` 在不同版本里对 macOS 库来源的变量名/URL 不固定。落地时先读真实 cmake，按其实际读取的变量注入，不臆造。若该 cmake 完全不支持 mac 动态库，需在它内部补 `osx-arm64`/`osx-x86_64` 下载分支（onnxruntime 官方 release 资产），并把 URL/版本对齐当前声明。
- 每个 Task 的 Commit 步骤保持原子：一个 commit 对应一个 Task，message 已给。
- Windows 回归（Task 6 Step 9 / Task 7 Step 5）若本机是 mac 跑不了 MSVC，就把回归交给有 Windows 的机器或 CI，不要因跑不了就跳过「确认未改 Windows 默认行为」这一步。
- 全程 YAGNI：不引入签名/公证代码、不做 mac 文件关联（UTI）、不改 `InferenceBackend` 类型域。
