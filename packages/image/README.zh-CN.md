# @forgeax/engine-image

[English](README.md) · **简体中文**

Image 负责图片导入、像素数据、纹理描述符验证和图像编辑。它生成普通 `TextureAsset`、`EquirectAsset` 与构建产物；GPU 上传由运行时所属模块处理。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整 API、示例和错误表见[英文契约](README.md)。

## 从文件到资产

`imageImporter.capabilities.sourceFormats` 声明单输出源格式。PNG/JPEG 生成 Texture，HDR 生成 Equirect，Cube LUT、Basis/KTX2 和 `.texture.json` 生成 Texture。DevKit 使用相同声明注册来源，导入器也据此检查输出种类。注册不等于已解码或成功构建。

源 Meta 拥有 GUID 和导入设置；Cook 生产者拥有 `CookReceipt`；Catalog 发布包地址和可选回执地址。消费者组合这些事实形成 `AssetEvidence`，不能把目录条目本身当成构建成功证据。

| 工作 | 完整说明 |
|:--|:--|
| 首次接入 | [四步用法](README.md#four-step-recipe) |
| HDR 环境图 | [HDR 等距柱状图导入](README.md#hdr-equirect-import-path) |
| 选择压缩 | [compressionMode](README.md#compressionmode-sidecar-field)、[四种模式](README.md#four-mode-semantics)、[auto 推导](README.md#auto-derivation-rules-d-12) |
| 构建 Mip | [离线 Mip 约束](README.md#mip-offline-baking-constraint) |
| 查入口 | [包入口](README.md#entry-points) |

## 体积、数组与颜色

3D 密度源仍由 Image 生产标准 `TextureAsset`。`shape.viewDimension: '3d'`、`shape.extent.depth`、`colorSpace: 'linear'` 和显式 `mips` 必须同时存在；Meta 保持 GUID/sourceKey，Pack body 和回执提供 digest/generation 证据。

缺少伴随数据、布局或回执时返回结构化错误。修复同一 sourceKey 后重新导入和构建，不向运行时注入 1×1 占位纹理。

| 工作 | 完整说明 |
|:--|:--|
| 3D 密度描述符 | [3D 密度源](README.md#3d-density-source-contract) |
| 数组和体积布局 | [数组与体积契约](README.md#array-and-volume-source-contract) |
| 像素创作 | [PixelSurface](README.md#pixelsurface-authoring) |
| 颜色 LUT | [LUT 来源与恢复](README.md#color-lut-source-and-recovery) |
| 重复构建 | [确定性](README.md#determinism) |

## 运行时内容

`equirectContribution` 在源解码和同步编辑中使用相同的尺寸、格式、色彩空间与字节布局校验。Engine 负责安装；独立 `AssetRegistry` 在创建或编辑 Equirect 前必须安装对应解码器。无效写入保留当前内容和修订。

运行时 Texture 只保留一个字节源。`encoding: 'basis' | 'ktx2'` 表示完整编码图像，省略时表示原生纹素或块数据。`prepareRuntimeTexture` 同步验证源，不初始化 WASM，也不复制像素。编码图像支持完整替换；局部像素写入要求原生内容。详见[运行时图像](README.md#runtime-image-content)。

## 错误与恢复

| 状态 | 含义与处理 |
|:--|:--|
| `notCooked` | 缺少构建回执，先完成导入和构建 |
| `ready/current` | 回执输入指纹与当前源一致 |
| `ready/stale` | 输入已改变，需要重新构建 |
| `unknown` | 缺少来源、回执或运行时能力，不能推断就绪 |
| `notChecked` / `passed` / `failed` | 包和产物检查各自的实际结果 |

按错误修复源 Meta 或重新构建，再执行离线 `lookup/verify --guid --project --catalog --json`。完整错误、约束见[转换诊断](README.md#importer-conversion-diagnostics)、[基础错误](README.md#base-importer-errors-charter-p3-explicit-failure)、[不变量](README.md#invariants)。
