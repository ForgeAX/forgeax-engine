# @forgeax/engine-devkit

[English](README.md) · **简体中文**

DevKit 负责项目构建、资产生产、开发宿主、运行观察和工具集成。游戏内容与运行事实仍由对应的 Engine 模块拥有；View 和 CLI 消费同一组公开操作。

> [!NOTE]
> 这是面向人的中文阅读入口，不是逐段译文。完整 API、参数、生命周期和证据要求见[英文契约](README.md)；以下索引直接指向对应章节。

## 从任务开始

| 任务 | 入口与边界 |
|:--|:--|
| 创建、检查和构建项目 | [CLI 与目录](README.md#cli-and-catalog)：通过项目声明的构建根生产资产，保持源 GUID 和 sourceKey 稳定 |
| 启动独立后端 | [后端启动](README.md#independent-backend-startup)：后端工作区与游戏项目身份分开，启动回执不等于项目或画面就绪 |
| 修改 Pack 参数 | [创作会话](README.md#pack-authoring-sessions)：运行时字段立即预览，生成字段等待显式生成；保存写回原始源 |
| 创建行为资产 | [行为资产](README.md#create-behavior-assets)：通过原生插件程序与项目根组合能力 |
| 查询资产与来源 | [有界资产发现](README.md#bounded-asset-discovery)：先发现再精确查询，保留分页、身份和来源证据 |
| 生成运行时内容 | [运行时 Pack](README.md#runtime-pack-capability)：复用资产所有者的生成、修改与持久化契约 |
| 编排游戏与捕获 | [脚本化游玩](README.md#scripted-playthrough-project-play)与[持续捕获](README.md#persistent-playthrough-capture)：按执行目标和完成回执获取证据 |
| 复盘操作 | [持久操作历史](README.md#persistent-operation-history)：记录已验证的命令回执和 PNG 资产；观察与修改仍分离 |

## 项目构建与生产

自定义构建宿主从包根读取 `readProjectFacts`，通过 `@forgeax/engine-devkit/plugin-build` 的 `loadProjectCookers` 执行所选项目声明的构建根。返回会话拥有 cooker 和被观察的源文件；关闭或启动失败时由其所属宿主释放。

官方本地 Engine 绑定为创作源执行选择公开 `@forgeax/engine` 包。元数据扫描、插件启动、延迟 Pack 构建、交互生成器和 Vite production 使用同一个显式包根；没有本地绑定时，仍按源文件位置进行 npm 解析。所选包的 exports 是权威，缺失导出不能回退到游戏里较旧的安装。Pack Worker 不自行读取 DevKit 绑定。

项目可用 `devkitAppOptions.renderFeatures` 声明模块、导出名和纯数据配置。各本地、执行 Worker 与渲染 realm 分别构造贡献，再创建 Renderer。不要跨 Renderer 共享 GPU 对象，也不要把 GPU 资源创建藏进 World。

项目根、生成的 Vite 根和 Engine 着色器生产工作区各有自己的所有权。临时项目不能替代共享着色器库存的生产根。

Play 和生产构建交付同一套 Engine 源模板，运行时按实际需求准备内置变体。项目材质继续由 Pack Cook 发布。

| 生产任务 | 完整说明 |
|:--|:--|
| 生成资产宿主与 Catalog | [生成资产宿主](README.md#generated-asset-host) |
| 创作参数、保存与撤销 | [Pack 创作操作](README.md#pack-authoring-operations) |
| 玩家资产包 | [资产分包](README.md#player-asset-bundles) |
| 压缩传输 | [压缩交付文档](README.md#compressed-delivery-documents) |
| 游戏管线准备 | [收集和准备游戏管线](README.md#collect-and-prepare-gameplay-pipelines) |
| GPU 纹理呈现 | [GPU 纹理资源呈现](README.md#gpu-texture-resource-presentation) |

## 宿主、平台与生命周期

内置加载与失败界面默认使用英文。在构建根设置 `devkitAppOptions.loadingLabels = { lang: 'zh-CN' }` 可启用完整简体中文文案，项目仍可覆盖个别字段；省略字段继承所选语言。微信早期启动和分包加载失败弹窗使用同一配置。原始错误码、异常原因和堆栈保留原文。

分离后端的默认 V8 堆预算不超过已接纳主机或容器内存的四分之一，上限 8 GiB；构建子进程继承同一预算。调用方显式设置的堆上限优先。

浏览器页面在 `pagehide` 时先撤销该连接的结果准入，再断开套接字。刷新后的页面独立鉴权，并推进同一项目会话的浏览器 generation。旧页面的迟到结果不能让替代页面失败或重新接纳；传输退休也不能证明原生清理成功。

| 集成场景 | 完整说明 |
|:--|:--|
| Worker 选择 | [生产 Worker](README.md#production-worker-selection) |
| 微信小游戏 | [微信小游戏集成](README.md#wechat-mini-game) |
| 平台 SDK | [平台适配](README.md#platform-sdk-adaptation)与[造化生命周期示例](README.md#minimal-zaohua-lifecycle-example) |
| 启动与故障画面 | [启动诊断](README.md#startup-diagnostics)、[游戏启动生命周期](README.md#generated-game-startup-lifecycle)、[项目加载与失败画面](README.md#project-owned-loading-and-failure-screens) |
| 绑定本地 Engine 源码 | [Engine 源绑定](README.md#engine-source-binding) |
| 选择 View 工具源 | [工具源码与 SDK 运行时](README.md#selected-tool-sources-and-sdk-runtime) |

## View 与观察工具

Engine 保留项目、会话、资产、场景、运行与捕获的权威；View 负责窗口资源、标签页绑定和呈现。借用显示载体不转移 Engine 的生命周期所有权。功能激活属于插件，不应在宿主中另设业务开关或并行注册表。

| 工作流 | 完整说明 |
|:--|:--|
| 项目身份与切换 | [项目权威](README.md#project-authority) |
| 借用显示资源 | [显示载体](README.md#borrowed-display-carrier)与[宿主组合](README.md#borrowed-host-composition) |
| 工具接入 | [工作区提供者](README.md#engine-workspace-provider) |
| 资产预览 | [创作预览](README.md#authoring-preview)与[渐进缩略图](README.md#progressive-asset-thumbnails) |
| 建模渲染 | [建模渲染与回放](README.md#modeling-render-and-replay) |
| GPU 捕获分析 | [RHI Debug 操作](README.md#rhi-debug-operations)与[ArtifactRef](README.md#artifactref) |
| 浏览器合成捕获 | [合成捕获](README.md#browser-compositor-capture) |
| 操作发现 | [操作命名与实时发现](README.md#operation-naming-and-live-discovery) |

## 失败与证据

按结构化错误的 `code`、`hint` 和所属模块修复输入，然后重试原操作。保留精确项目、目标、generation 与源修订；过期结果不能证明新目标就绪。

CPU 检查、页面存活、启动 URL 与真实渲染完成是不同证据。GPU 时间、像素和捕获分别遵循[GPU 计时](README.md#opt-in-gpu-timing-in-a-generated-host)、[捕获策略](README.md#capture-policy-regression)和对应运行路径的验收要求。

相关包：[Pack](../pack/README.zh-CN.md)、[Import](../import/README.zh-CN.md)、[Render](../render/README.zh-CN.md)。
