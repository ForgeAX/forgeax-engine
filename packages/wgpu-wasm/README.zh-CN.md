# @forgeax/engine-wgpu-wasm

[English](README.md) · **简体中文**

本包将 wgpu 30 RHI 和 Naga 30 编译能力打包成一份 WASM。普通 Engine 用户通过运行时或编译器入口使用这些能力；原始绑定供 `@forgeax/engine-rhi-wgpu` 和 `@forgeax/engine-naga` 薄层消费。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整方法、ABI、来源校验和资源生命周期见[英文契约](README.md)。

## 包的边界

`rhi.rs` 提供 wgpu 资源、设备、队列与命令绑定；`naga.rs` 提供解析、验证和反射。两者共用同一份 wgpu/Naga 源依赖和 WASM 生产链，避免重复维护原生实现。设计约束见[渐进披露与统一抽象](README.md#charter-propositions-progressive-disclosure-and-consistent-abstractions)。

浏览器原生 WebGPU 路径不需要为该后端下载 WASM；非浏览器或显式选择对应路径时再延迟加载。普通用户不应直接调用 raw bindings，原因见[隐藏原始接口的边界](README.md#why-it-is-hidden-from-ai-engine-users)。

## 构建、获取与来源

```sh
bash packages/wgpu-wasm/build.sh
pnpm -F @forgeax/engine-wgpu-wasm fetch-wasm
```

两条命令分别对应本地 Rust 构建与获取预构建产物，按实际场景选择；不是必须顺序执行。步骤见[构建或获取 pkg](README.md#building-or-fetching-pkg)。

`third_party/wgpu` gitlink 拥有维护中的 wgpu 30 源码。Cargo 使用该源码和唯一的 Naga 实例；来源指纹覆盖其源树及当前 crate。贡献者初始化相应依赖，SDK 源分发携带精确展开的源码与许可证。

`ensureReady()` 统一加载并校验 WASM、glue 与编译器指纹。`getCompilerFingerprint()` 只公开成功初始化且验证通过的原生所有者身份；不能仅凭磁盘元数据推断正在执行的编译器。

浏览器可把来源清单和 glue 资源内联为 data URL，加载器直接解码嵌入字节，同时保留与外部 fetch 相同的完整性校验。不能为绕过 CSP 而取消来源验证。

## 原生宿主

仅 Node 可用的 `./native-build` 导出 `buildNativeWgpu({ out })`：拒绝覆盖现有输出，先验证规范 WASM/glue，再从已验证 bindgen ABI 派生原生模块和声明。此转换使用发布产物，不要求本地 Rust 源码。

`initializeNativeWgpu(host)` 通过 `./native-host` 消费不可变打包字节、原生实例化和实际借用画布。相同宿主共享一个 Promise；最终化前失败可重试，Rust start 失败要求新 realm；成功初始化后不能更换宿主。

原生接纳保留真实 WebGL2 限制，不臆造缺失能力，也不替换全局构造器、fetch 或 WebAssembly。外部图像复制、分辨率与输出声明的完整约束见[原生宿主绑定](README.md#native-host-binding)。

## 按资源查方法

| 主题 | 完整契约 |
|:--|:--|
| Instance 与适配器 | [Instance](README.md#instance)、[RhiWgpuAdapter](README.md#rhiwgpuadapter) |
| 设备与资源创建 | [RhiWgpuDevice](README.md#rhiwgpudevice) |
| 缓冲区映射 | [映射生命周期](README.md#rhiwgpubuffer-mapping) |
| 命令与 Pass | [CommandEncoder](README.md#rhiwgpucommandencoder)、[RenderPass](README.md#rhiwgpurenderpass) |
| 队列提交 | [Queue](README.md#rhiwgpuqueue) |
| 显示表面 | [Surface](README.md#rhiwgpusurface)、[SurfaceTexture](README.md#rhiwgpusurfacetexture) |
| 句柄 | [不透明句柄](README.md#opaque-handle-types-14-total) |
| Render Bundle | [Bundle 生命周期](README.md#render-bundle-lifetime) |
| 编译器资源预算 | [源编译预算](README.md#source-compiler-execution-budget) |
| 每帧命令 | [每帧命令生命周期](README.md#per-frame-command-lifetime) |
| 绑定资源 | [绑定资源生命周期](README.md#binding-resource-lifetime) |

## 验证边界

产物体积、源匹配与资源生命周期遵循[体积契约](README.md#bundle-size-contract)及上述所属章节。模拟器完成 RHI 初始化或清屏不代表完整游戏集成通过；真实 Browser、Dawn、原生宿主和游戏路径分别保留自己的证据要求。
