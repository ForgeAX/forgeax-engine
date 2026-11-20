# @forgeax/engine-import

[English](README.md) · **简体中文**

Import 是构建期资产生产边界：读取创作源，经已注册导入器生成标准 Engine 资产、二进制产物和来源证据。运行时加载由独立资产消费者负责。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整生产协议、参数和示例以[英文契约](README.md)为准。

## 所有权与主路径

导入器通过 `capabilities.sourceFormats` 声明源格式、输出种类、语义 sourceKey 和默认设置。工具使用这些声明，不再维护第二套格式注册表。注册不替代原生源验证，也不证明产物已生成。

| 主题 | 完整说明 |
|:--|:--|
| 依赖方向 | [依赖反转结构](README.md#the-dip-dependency-inversion-principle-shape)与[架构不变量](README.md#three-iron-laws-architecture-invariants) |
| 导入和加载 | [生产与消费分离](README.md#the-importload-split) |
| 插件装配 | [注入方式](README.md#injection-shape) |
| ScriptablePack | [构建生成](README.md#scriptablepack-build-generation)与[构建桥接](README.md#scriptablepack-build-bridge) |
| 源包生命周期 | [索引化源包](README.md#indexed-source-package-lifecycle) |
| 运行时生成 | [运行时 Pack 与持久内容](README.md#runtime-pack-production-and-durable-content) |

## 按内容查生产者

| 内容 | 完整说明 |
|:--|:--|
| 光照资产、IES | [光照生产入口](README.md#lighting-asset-producer-entry-points) |
| 网格二进制 | [网格二进制生产](README.md#mesh-binary-producer-contract) |
| LOD | [源格式 LOD 适配](README.md#source-format-lod-adapters)、[归一化与恢复](README.md#mesh-lod-normalization-and-recovery)、[自动 LOD](README.md#automatic-mesh-lod-production)、[Pack 请求](README.md#pack-mesh-lod-requests) |
| 光照贴图 UV | [UV 验证](README.md#lightmap-uv-validation) |
| 网格距离场 | [可选距离场构建](README.md#optional-mesh-distance-field-cooking) |
| 网格 Card | [可选 Card 布局构建](README.md#optional-mesh-card-layout-cooking) |
| 静态网格交换 | [交换格式生产者](README.md#static-mesh-interchange-producers) |
| 插件程序 | [插件输出](README.md#plugin-output-producer) |
| 导航 | [静态导航生产](README.md#static-navigation-production) |
| 音频流 | [流式音频导入](README.md#streamed-audio-import) |
| 碰撞数据 | [网格碰撞构建](README.md#mesh-collision-cooking) |
| 玩家分包 | [玩家资产包](README.md#player-asset-bundles) |

## 传输、失败与证据

保持源身份、生产者配置、输出清单和 CookReceipt 一致。源包的失败必须向消费者传播；修复源、导入设置或生产者后重新构建，而不是替换运行时占位内容。

| 需要确认的事实 | 完整说明 |
|:--|:--|
| 错误分类和恢复 | [错误模型](README.md#error-model)与[源包失败传播](README.md#source-package-failure-propagation) |
| 两种传输形式 | [双形态传输](README.md#dual-form-transport-m4) |
| 质量与来源比较 | [G6 生产验证](README.md#g6-production-and-validation-evidence)、[源比较](README.md#source-comparison)、[质量回归证据](README.md#quality-and-regression-evidence) |
| 成本与交付 | [实测成本](README.md#measured-production-and-rendering-cost)、[交付检查](README.md#delivery-checks) |

CPU 构建成功只证明生产路径完成。可见质量、像素差异与真实 GPU 成本必须通过对应消费者的实际运行验证。

相关包：[Image](../image/README.zh-CN.md)、[Pack](../pack/README.zh-CN.md)、[Types](../types/README.zh-CN.md)、[DevKit](../devkit/README.zh-CN.md)。
