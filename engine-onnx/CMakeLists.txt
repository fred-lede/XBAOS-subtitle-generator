# ============================================================================
#  XBAOS 字幕生成器 —— ONNX 识别引擎
#
#  产物：
#     · Windows：xbaos-engine-asr.exe（/MT 静态链接 C 运行时，onnxruntime 静态链接，发布包零外部 DLL）
#     · macOS  ：xbaos-engine-asr（无后缀，AppleClang + 系统库，onnxruntime 官方 osx 动态库）
#     · 与 whisper 引擎并列的第二套识别后端（sherpa-onnx + SenseVoice 等）
#     · 复用 ../engine/src 下的音频解码、VAD 与 JSON 工具，不重复造轮子
#
#  用法（在项目根目录执行）：
#      bash engine-onnx/build.sh
# ============================================================================

cmake_minimum_required(VERSION 3.20)

project(xbaos-engine-asr
    VERSION 0.1.0
    DESCRIPTION "XBAOS 字幕生成器 ONNX 识别引擎"
    LANGUAGES C CXX)

if(NOT MSVC AND NOT APPLE)
    message(FATAL_ERROR "本引擎支持 MSVC（Windows）与 AppleClang（macOS）工具链。当前编译器：${CMAKE_CXX_COMPILER_ID}")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型" FORCE)
endif()

if(MSVC)
    add_compile_options(/utf-8)

    # 静态 C 运行时：与 whisper 引擎同一条硬约束
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
        CACHE STRING "MSVC 运行时库" FORCE)
endif()

# ---------------------------------------------------------------------------
#  sherpa-onnx 源码与依赖
#
#  依赖包（*.tar.gz / *.tar.bz2）预置在源码根目录时，sherpa 的 cmake 会直接
#  使用它们而不联网下载 —— 国内直连 github 往往不通，这是构建能否成功的关键。
# ---------------------------------------------------------------------------

set(SHERPA_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../engine/third_party/sherpa-onnx")
if(NOT EXISTS "${SHERPA_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "找不到 sherpa-onnx 源码：${SHERPA_DIR}\n"
        "请按 docs/BUILD-ENGINE.md 的说明把源码放到 engine/third_party/sherpa-onnx")
endif()

# 库形态：MSVC 走 win-x64 静态包（SHERPA 决定，缺一不可，保持静态）；
# APPLE 必须保持 BUILD_SHARED_LIBS=ON —— 但 sherpa 顶层 CMakeLists 的
# `option(BUILD_SHARED_LIBS ... OFF)` 会把缓存变量默认成 OFF，导致它的
# cmake/onnxruntime-osx-arm64.cmake 直接 FATAL_ERROR（该分支只认动态库）。
# 所以这里显式缓存为 ON；mac 的 onnxruntime 官方包也只以 .dylib 发布。
# 两条路都由 sherpa 的 cmake/onnxruntime.cmake 分发。
if(MSVC)
    set(BUILD_SHARED_LIBS               OFF CACHE BOOL "" FORCE)
    set(SHERPA_ONNX_USE_STATIC_CRT      ON  CACHE BOOL "" FORCE)
endif()
if(APPLE)
    set(BUILD_SHARED_LIBS               ON  CACHE BOOL "" FORCE)
endif()

# 只要 C API，其余全部关掉：体积与编译时间都省下来
set(SHERPA_ONNX_ENABLE_C_API            ON  CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_BINARY           OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_PYTHON           OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_TESTS            OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_CHECK            OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_PORTAUDIO        OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_JNI              OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_WEBSOCKET        OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_TTS              OFF CACHE BOOL "" FORCE)
# 说话人分离：靠 pyannote 分割 + 声纹聚类，与识别模型无关，两套引擎共用同一份
# 输出。打开它才能用 SherpaOnnxOfflineSpeakerDiarization* 这一组 C API（默认关着
# 时这些函数只有一句「not enabled」的桩），代价是引擎体积增加约 1 MB。
set(SHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION ON CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_GPU              OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_DIRECTML         OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_AISHELL           OFF CACHE BOOL "" FORCE)

# 依赖包已预置在源码根目录，禁止再去网上找（找不到就直接失败，别静默等待）
set(FETCHCONTENT_FULLY_DISCONNECTED     OFF CACHE BOOL "" FORCE)

# Ninja 不会设置 CMAKE_VS_PLATFORM_NAME，而 onnxruntime 的预编译包靠它判断是否为
# x64 静态包；不补这一项，配置阶段会直接 FATAL_ERROR。只影响这套判断，不改编译器。
# 仅 MSVC 需要：mac（Ninja + AppleClang）不走 win 分支，误设 X64 会选到 win 包。
if(MSVC AND NOT CMAKE_VS_PLATFORM_NAME)
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(CMAKE_VS_PLATFORM_NAME X64)
    else()
        set(CMAKE_VS_PLATFORM_NAME Win32)
    endif()
endif()

# onnxruntime 平台库分发（2026-11-08 与真实 sherpa cmake 对齐）：
# - APPLE：不需要注入任何变量。sherpa 的 cmake/onnxruntime.cmake Darwin 分支
#   原生按 CMAKE_SYSTEM_PROCESSOR（必要时辅以 CMAKE_OSX_ARCHITECTURES）分发：
#   arm64 mac → onnxruntime-osx-arm64.cmake（osx-arm64 动态库），
#   x86_64 mac → onnxruntime-osx-x86_64.cmake（osx-x86_64 动态库）。
#   此前注入的 `ONNXRUNTIME_OSX_ARCH` 变量在 sherpa cmake 中并不存在，已删除。
#   离线预置时把 zip 放到 engine-onnx/（即 CMAKE_SOURCE_DIR）或 ~/Downloads/，
#   sherpa 的 possible_file_locations 会优先读本地文件（见 tools/fetch-deps.mjs）。
if(APPLE)
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64)$")
        message(STATUS "onnxruntime macOS 目标：osx-x86_64（动态库，由 sherpa cmake 分发）")
    else()
        message(STATUS "onnxruntime macOS 目标：osx-arm64（动态库，由 sherpa cmake 分发）")
    endif()
elseif(MSVC)
    # 现状：win-x64 静态包（维持）
    message(STATUS "onnxruntime Windows 目标：win-x64（静态）")
endif()

add_subdirectory("${SHERPA_DIR}" "${CMAKE_BINARY_DIR}/sherpa-onnx" EXCLUDE_FROM_ALL)

# ---------------------------------------------------------------------------
#  libopus（可选，与 whisper 引擎共用同一份源码）
# ---------------------------------------------------------------------------

set(XBAOS_OPUS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../engine/third_party/opus")
if(EXISTS "${XBAOS_OPUS_DIR}/CMakeLists.txt")
    set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
    set(OPUS_BUILD_TESTING       OFF CACHE BOOL "" FORCE)
    set(OPUS_BUILD_PROGRAMS      OFF CACHE BOOL "" FORCE)
    set(OPUS_INSTALL_PKG         OFF CACHE BOOL "" FORCE)
    if(MSVC)
        set(OPUS_STATIC_RUNTIME    ON  CACHE BOOL "" FORCE)
    endif()
    set(OPUS_DISABLE_INTRINSICS  ON  CACHE BOOL "" FORCE)
    add_subdirectory("${XBAOS_OPUS_DIR}" "${CMAKE_BINARY_DIR}/opus" EXCLUDE_FROM_ALL)
    set(XBAOS_HAS_OPUS 1)
else()
    set(XBAOS_HAS_OPUS 0)
endif()

# ---------------------------------------------------------------------------
#  引擎可执行文件
# ---------------------------------------------------------------------------

set(SHARED_SRC "${CMAKE_CURRENT_SOURCE_DIR}/../engine/src")

add_executable(xbaos-engine-asr
    src/main.cpp
    "${SHARED_SRC}/decoders/decoders.cpp"
    "${SHARED_SRC}/decoders/oggopus.cpp")

target_include_directories(xbaos-engine-asr PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${SHARED_SRC}"
    "${SHARED_SRC}/decoders"
    "${SHERPA_DIR}")

target_link_libraries(xbaos-engine-asr PRIVATE sherpa-onnx-c-api)

if(XBAOS_HAS_OPUS)
    target_link_libraries(xbaos-engine-asr PRIVATE opus)
    target_include_directories(xbaos-engine-asr PRIVATE "${XBAOS_OPUS_DIR}/include")
endif()

target_compile_definitions(xbaos-engine-asr PRIVATE XBAOS_HAS_OPUS=${XBAOS_HAS_OPUS})

set_target_properties(xbaos-engine-asr PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

message(STATUS "")
message(STATUS "============== xbaos-engine-asr 配置 ==============")
message(STATUS "  构建类型    : ${CMAKE_BUILD_TYPE}")
if(MSVC)
    message(STATUS "  MSVC 运行时 : ${CMAKE_MSVC_RUNTIME_LIBRARY}")
endif()
message(STATUS "  sherpa-onnx : ${SHERPA_DIR}")
message(STATUS "  Opus 解码   : ${XBAOS_HAS_OPUS}")
message(STATUS "==================================================")
message(STATUS "")
