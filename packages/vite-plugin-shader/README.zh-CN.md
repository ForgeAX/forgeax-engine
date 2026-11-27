# @forgeax/engine-vite-plugin-shader

[English](README.md) · **简体中文**

本包是 Shader Compiler 的 Vite 适配层。它安装 `load`、`transform`、`generateBundle`、`handleHotUpdate` 钩子，转发编译请求、发布清单、传播 HMR，并把结构化编译错误映射为 Vite/Rollup 诊断；不另行实现编译器。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整配置、发布格式和生命周期见[英文契约](README.md)。

## 接入与源码身份

在 `vite.config.ts` 中使用 `forgeaxShader`。配置和准确签名见[API 索引](README.md#api-index)。插件将 Worker 输出设为 ES 模块，使本地与 Worker 构建使用相同运行时模块并保留延迟加载。

包内材质程序在 `package.json#forgeax.materialPrograms` 声明资源接口，键为 `src/shaders` 下的 WGSL 文件名；值采用普通 MaterialProgram 字段并省略 `module`，模块身份由 WGSL 声明保留。生产者根据反射验证并发布与 Cook 相同的 ABI 回执。

源码回执与声明的目录布局一起迁移到临时项目。加载器校验回执旁的着色器产物路径、库存和生产摘要。预编译库存仍从生产工作区解析，外部项目通过 `workspaceRoot` 指定该工作区。详见[Engine 输入与 ABI 传输](README.md#engine-inputs-and-abi-transport)。

## 发布与缓存

生产和开发默认发布 `7.0.0` Engine 源模板。WGSL 模块共享一次，运行时按材质、几何和设备能力准备所选变体。项目若同时交付已 Cook 的材质程序，则使用 `8.0.0` 清单中的 `templates` 和 `cooked` 两节。Registry 验证源摘要与引用，同一标识符只有一个发布所有者。

## 编译与生命周期

`buildEngineShaderTemplateManifest` 生产内置模板，`buildProjectShaderTemplateManifest` 可附加声明的材质包。需要组合后 WGSL 的宿主可显式选用 `publication: 'compiled'`。旧版本继续由原有准入规则读取。完整说明见[默认源模板交付](README.md#native-source-delivery)。

编译工作池在槽位开始执行时才准备该任务的源和导入目录，结果保持原有顺序。任务完成后关闭消息端口并等待 Worker 正常退出，不以强制终止替代原生或 WASM 清理。任务错误优先于关闭错误。

源构建测试预算不是性能 SLA，也不允许扩大外层 CI 期限；测试证据与产品运行能力应分别报告。

## 环境与恢复

`virtual:forgeax/bundler` 的显式宿主输入由工具适配层提供，运行时模块不能自行猜测开发模式。字段和示例见[虚拟模块](README.md#virtualforgeaxbundler-virtual-module)。

按结构化编译错误修复 WGSL、材质声明或生产工作区，再重新生成发布。不要修改产物反射、复制模块目录，或绕过源摘要与 ABI 验证。规则见[不变量](README.md#invariants)。

相关包：[Shader Compiler](../shader-compiler/README.zh-CN.md)、[Shader](../shader/README.zh-CN.md)、[DevKit](../devkit/README.zh-CN.md)。
