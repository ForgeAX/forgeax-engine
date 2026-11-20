# @forgeax/engine-shader

[English](README.md) · **简体中文**

Shader 提供运行时着色器发布、模块目录、材质程序契约和共享着色器输入。编译与反射由构建期编译器负责；运行时消费内容寻址的已编译产物。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整 WGSL 接口、代码示例、ABI 与恢复要求见[英文契约](README.md)。

## 材质主路径

材质沿 `paramSchema -> derive -> compile/reflect -> cook/load -> extract/record` 传递。坐标集、变换、物理 UV 尺度和绑定接口是公开 schema 与数据事实，不是应用自行补丁的字节偏移。

| 创作任务 | 完整契约 |
|:--|:--|
| 初次接入 | [规范材质路径](README.md#canonical-materialasset-path)与[材质、着色器路由](README.md#materialasset-and-shader-route) |
| Standard 表面 | [Surface 契约](README.md#standard-surface-contract)、[最小示例](README.md#minimal-authoring-shape)、[创作清单](README.md#surface-authoring-checklist) |
| 直接绘制程序 | [Direct 程序](README.md#direct-material-program-contract) |
| 场景索引程序 | [Scene-index 程序](README.md#scene-index-material-program-contract) |
| 内置光照 | [Standard 光照](README.md#standard-lit-shader-contract)、[PBR](README.md#built-in-pbr-contract) |
| 模块与派生 | [模块目录](README.md#shader-module-catalog)、[契约派生](README.md#contract-derivation) |

每个实际程序入口保留自己的反射读取依赖与 ABI 回执。元数据未知不能视为空依赖；不能用着色器名称白名单或手工维护的修订代替入口依赖。

## 按功能查 ABI

| 功能 | 完整契约 |
|:--|:--|
| 参数和资源 | [公开输入边界](README.md#public-shader-input-boundary)、[直接参数区域](README.md#direct-material-parameter-regions) |
| 标量纹理 | [Standard 标量贴图 ABI](README.md#standard-scalar-map-abi) |
| 位移 | [Standard 位移](README.md#standard-displacement-contract) |
| 裁剪与随机覆盖 | [共享裁剪](README.md#shared-clipping-coverage)、[Alpha Hash](README.md#hashed-alpha-coverage)、[LOD 覆盖](README.md#lod-coverage-abi) |
| 颜色输出 | [片元颜色输出](README.md#fragment-color-output) |
| 点与线 | [点线着色器](README.md#points-and-lines-shader-contract) |
| 光照通道 | [Surface 通道传输](README.md#surface-lighting-channel-transport) |
| 阴影 | [投射者投影](README.md#shadow-caster-projection) |
| 延迟光照 | [Standard 延迟光照](README.md#standard-deferred-lighting-contract) |
| 时域与运动模糊 | [Temporal-v1](README.md#temporal-v1-accessor)、[可移植运动模糊](README.md#portable-motion-blur) |
| 水面和单层介质 | [水体终端连续性](README.md#water-terminal-continuity)、[平面反射](README.md#single-layer-medium-planar-reflection) |
| 大气 | [物理大气表](README.md#physical-atmosphere-tables)、[大气传输](README.md#atmospheric-transport) |
| 环境辐照 | [恒定环境项](README.md#constant-environment-irradiance) |
| 光线表面 | [Ray Surface 上下文](README.md#ray-surface-reference-context) |
| 多阶段工具程序 | [可移植多阶段程序](README.md#portable-multi-stage-utility-programs) |

## 发布与恢复

发布元数据在同一次接纳中共享不可变事实；后续发布重新读取自己的源与事实。宿主显式提供编译器，Registry 按请求从 `7.0.0` 模板准备变体，也可从 `8.0.0` 清单读入项目已 Cook 的材质。编译后的 CPU 程序和 GPU 模块分别受 Registry 与设备生命周期管理。

错误按 `code`、结构化 `detail` 和 `hint` 恢复。修复 WGSL、schema 或生产者，再重新编译和构建；不要编辑缓存中的反射或在运行时猜测 ABI。具体流程见[错误恢复](README.md#error-recovery)。

相关包：[Shader Compiler](../shader-compiler/README.zh-CN.md)、[Vite 插件](../vite-plugin-shader/README.zh-CN.md)、[Types](../types/README.zh-CN.md)、[Render](../render/README.zh-CN.md)。
