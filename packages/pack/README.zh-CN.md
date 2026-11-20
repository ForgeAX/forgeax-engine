# @forgeax/engine-pack

[English](README.md) · **简体中文**

Pack 负责文本与脚本资产的身份、schema、依赖、生产结果和加载传输。`*.pack.ts` 在构建期执行；运行时按稳定 GUID 消费已构建资产。

> [!NOTE]
> 本文是面向人的中文阅读入口，不是逐段译文。完整 schema、命令、代码示例和失败分支见[英文契约](README.md)。

## 创作入口

| 内容 | 入口与边界 |
|:--|:--|
| 程序化资产 | [ScriptablePack 与 Pack 创作](README.md#scriptablepack-and-pack-authoring)、[30 秒示例](README.md#scriptablepack-in-30-seconds) |
| 可复制代码 | [快速开始](README.md#quick-start)与[ScriptablePack 源](README.md#scriptablepack-source-packts) |
| 外部文件 | [`.meta.json`](README.md#metajson----external-asset-package)：伴随元数据保存稳定身份与导入设置 |
| 声明资产 | [`.pack.json`](README.md#packjson----authored-pack-v3)：定义内容、引用、参数和实例 |
| 插件资产 | [原生代码程序](README.md#native-code-package-programs)与[插件创作和源码转移](README.md#plugin-authoring-and-source-transfer) |
| 复用内容库 | [Engine Content](README.md#engine-content-library) |
| 光照内容 | [光照 Pack/Catalog](README.md#lighting-packcatalog-entry-points) |

源文件、构建包、Catalog 和 DDC 各有自己的职责。修复应回到创作源并重新生产，不直接编辑构建缓存或给消费者注入替代内容。

ScriptablePack 运行时导入按原创作模块的 Node ESM 条件解析，再由迁移后的 Worker 导入规范文件 URL，不借用 Pack loader 安装的依赖。宿主可向元数据扫描和延迟生产传入 `packageBinding`，明确包名与目录；Node 按该包的 exports 解析主入口和子路径，缺失所选导出会在创作模块加载时失败。每个 Worker lease 重置该选择，显式选择不复用未绑定的元数据缓存。缺失模块错误在结构化 detail 和普通消息中都保留创作路径与 specifier。

## 材质、参数与运行时内容

材质沿 `paramSchema -> derive -> compile/reflect -> cook/load -> extract/record` 流转。共享材质程序、反射和不可变 ABI 回执由所属生产者发布，运行时不猜测字段偏移或绑定含义。

普通 `.pack.ts` 材质发布 `material-template/1` 契约及按内容寻址的 WGSL 源库。资产加载时验证源库。Render 根据实际 pass 和设备条件按需编译并缓存所选程序。已有的 `material-cook/5` 编译产物仍可加载。

| 内容 | 完整契约 |
|:--|:--|
| 材质 | [规范路径](README.md#canonical-materialasset-path)、[材质构建](README.md#materialasset-cook-contract)、[材质形态](README.md#materialasset-shape----pass-based-material-in-packjson) |
| 共享程序 | [共享材质程序传输](README.md#shared-material-program-transport) |
| 参数编辑 | [实时参数与创作草稿](README.md#optional-live-parameters-and-author-drafts)：运行时参数即时预览，生成参数等待显式生成；保存仍写原源文件 |
| 运行时验证 | [schema 验证](README.md#runtime-schema-validation) |
| 程序化插件 | [插件能力](README.md#procedural-plugin-capability) |
| VFX | [Pack v2 中的 VFX Program v3](README.md#vfx-program-v3-in-pack-v2) |
| GPU 纹理 | [运行时 GPU 纹理声明](README.md#runtime-gpu-texture-declarations) |

## 身份、产物与传输

| 主题 | 完整契约 |
|:--|:--|
| GUID | [AssetGuid API](README.md#assetguid-api) |
| 来源和拓扑 | [生产者来源与拓扑](README.md#producer-provenance-and-topology) |
| 网格二进制 | [网格边界](README.md#mesh-binary-boundary)与[产物契约](README.md#mesh-binary-artifact-contract) |
| LOD 关系 | [LOD 关系闭包](README.md#mesh-lod-relation-closure) |
| 发布清单 | [生产物与库存](README.md#owner-product-and-inventory-contract) |
| 程序字节 | [运行时程序产物](README.md#runtime-program-artifacts)与[二进制捕获](README.md#runtime-binary-data-capture) |
| 按需交付 | [延迟产物交付](README.md#deferred-artifact-delivery)与[不可变 Catalog 传输](README.md#immutable-build-catalog-transport) |
| 包入口 | [子路径](README.md#entry-subpaths) |

## 诊断与恢复

`AssetEvidence` 连接创作源、Meta、生产者、CookReceipt、Catalog 和实际产物。读取目录条目不能替代校验包或字节；源变化后旧回执不能证明当前内容有效。

先通过[统一资产命令](README.md#unified-asset-commands)发现、查找和验证，再沿[离线证据链](README.md#assetevidence-the-offline-proof-chain)定位缺失来源、过期回执或产物错误。[七步扫描链](README.md#scanner-7-step-validation-chain)与[闭合错误码](README.md#packerrorcode----13-member-closed-union)定义具体拒绝条件。

诊断路径和 JSON 指针用于定位源字段；不要仅根据提示字符串分支，也不要复制另一套错误码集合。详见[创作诊断与发现](README.md#authoring-diagnostics-and-discovery)。
