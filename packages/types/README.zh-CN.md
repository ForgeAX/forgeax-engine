# @forgeax/engine-types

[English](README.md) · **简体中文**

Types 保存跨包共享的资产、材质、纹理、生产者与错误数据契约。其他模块从这里消费同一份类型与 schema，不各自维护近似结构或错误码副本。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整类型、字段、约束与示例见[英文契约](README.md)。

## 主路径与入口

| 主题 | 完整契约 |
|:--|:--|
| 包入口与 API | [入口](README.md#entry-points)与[API 索引](README.md#api-index) |
| 数据形态 | [形态不变量](README.md#shape-invariants) |
| 生产者注册 | [资产生产者](README.md#asset-producer-contract) |
| 材质创作 | [规范路径](README.md#canonical-materialasset-path)、[材质路由](README.md#materialasset-route)、[MaterialAsset](README.md#materialasset) |
| 资产身份 | [AssetHandle](README.md#assethandle)与[AssetEvidence](README.md#assetevidence-schema) |
| 光照资产 | [光照与资产入口](README.md#lighting-and-asset-entry-points)、[扩展光照证据](README.md#extended-lighting-evidence-layers) |

`ImporterCapabilities.sourceFormats` 声明所属生产者的单输出扩展名、输出种类、语义 sourceKey 与默认设置。工具消费此事实，不建立第二套格式表。`PackSchemaDiagnostic` 保留可选 AJV keyword、schemaPath 和 params 以及字段路径和消息。

`AssetError` 与 `ImageErrorImpl` 构造共享资产错误封装。调用方按来源拥有的闭合错误码和可判别详情分支，不根据文案解析错误。

## 网格、纹理与内容

| 资产主题 | 完整契约 |
|:--|:--|
| 网格顶点色 | [顶点色契约](README.md#mesh-vertex-color-contract) |
| 网格材质槽位 | [材质槽位](README.md#meshasset-material-slots) |
| 网格 LOD | [LOD 契约](README.md#mesh-lod-contract)与[随机覆盖](README.md#standard-stochastic-coverage) |
| 体积雾 | [体积密度契约](README.md#volumetric-fog-mvd-contract) |
| 数组与体积纹理 | [texture2d_array / texture3d 示例](README.md#texture2d_array--texture3d-literal-recipe) |
| Mip 与布局 | [Mip 跳过](README.md#texture-mip-skip-opt-in)、[纹理布局验证](README.md#texture-layout-validation) |
| 运行时 GPU 纹理 | [GPU 纹理资产](README.md#runtime-gpu-texture-assets) |
| 地形 | [地形词汇](README.md#terrain-asset-vocabulary) |
| 音频 | [音频源发布](README.md#audio-source-publication) |
| 粒子效果 | [效果资产身份](README.md#particle-effect-asset-identity)与[粒子运行时边界](README.md#particle-runtime-boundary) |
| 导入输出 | [输出声明](README.md#imported-output-declarations) |

资产句柄是受管理身份，不能用路径、源索引、GPU handle 或任意数字替代。生产来源、构建回执、Catalog 与运行时句柄分别描述不同阶段，不可混用。

## 材质与光照字段

| 主题 | 完整契约 |
|:--|:--|
| Standard 标量纹理 | [标量输入](README.md#standard-scalar-texture-inputs) |
| 直接光照 DFG | [DFG 选择](README.md#standard-direct-light-dfg-selection) |
| 物理材质根 | [根投影](README.md#standard-physical-root-projection) |
| Pass 与状态 | [MaterialPass](README.md#materialpass-fields)、[MaterialRenderState](README.md#materialrenderstate-fields) |
| 片元输出 | [材质颜色输出](README.md#material-fragment-outputs) |
| 方向光方向 | [direction 字段语义](README.md#directionallightdirection-field-semantics) |

## 名称与恢复

共享类型、生产资产和运行时对象可能处在不同抽象层。见[三层名称消歧](README.md#name-disambiguation-three-layers)、[ShaderModule 消歧](README.md#shadermodule-naming-disambiguation)与[WebGPU 类型关系](README.md#relationship-with-webgputypes)。

恢复操作保留结构化错误、源身份与版本证据，详见[结构化恢复](README.md#structured-recovery)、[常见问题](README.md#faq)和[升级路径](README.md#upgrade-path)。
