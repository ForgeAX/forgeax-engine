# @forgeax/engine-shader-compiler

[English](README.md) · **简体中文**

Shader Compiler 是构建期 WGSL 组合、编译、入口校验和反射的所属模块。它生产供 Cook 和运行时发布使用的产物与 ABI 回执；运行时 Shader 包保持物理隔离。

> [!NOTE]
> 本文是中文阅读入口，不是逐段译文。完整 API、反射格式、示例与错误细节见[英文契约](README.md)。

## 从源码到回执

| 阶段 | 完整契约 |
|:--|:--|
| 选择源与导入闭包 | [定向源码检查](README.md#focused-source-checks)：`materialShaderSourceRoots()` 与 `reachableShaderImportIds()` 提供所属源根和传递导入依赖 |
| 调用编译 | [API 入口](README.md#layer-1--api-surface-what-you-call) |
| 组合模块 | [组合与 HMR](README.md#layer-2--composition--hmr-mechanics-how-it-works)、[Naga Oil](README.md#naga_oil-integration-path)、[模块命名](README.md#bevy-style-moduleid-naming) |
| 检查布局 | [反射 v3 与已验证 WGSL 回写](README.md#reflection-v3-and-checked-wgsl-writeback) |
| 发布材质 | [规范 MaterialAsset 路径](README.md#canonical-materialasset-path) |
| 管理长构建 | [程序编译生命周期](README.md#program-compilation-lifetime) |

自定义 raster 程序通过共享材质契约声明 `program.bindings`，需要深度接口时声明 `program.sceneDepth`。Cook 用编译器反射验证并发布不可变回执；运行时不通过 WGSL 名称推断含义。绑定接口与深度版本共同进入特化身份。

普通 `.pack.ts` 材质发布 `material-template/1`，携带解析后的材质契约和可达的 WGSL 源码模块。游戏运行时按 Render 请求的 pass、设备、顶点输入和提交路径编译程序，并使用相同的反射和 ABI 校验。Pack 生产者版本为 `material-pack-cooker/7`。已有的 `material-cook/5` 编译产物仍可加载。

自定义受光材质选择 `program.bindings: 'render-lit-material-and-scene-depth'` 和 `sceneDepth: 'before-pass'`，普通参数 schema 仍为权威。从 `forgeax_material::lighting_inputs` 导入 `skySh`、`irradianceSampler`、`prefilterMap`、`prefilterSampler`、`brdfLut` 和 `skylight`。cooker 根据该材质自己的派生参数 schema，在用户绑定区域之后生成 Engine-owned 模块；项目 WGSL 不得声明或猜测其槽位。发布验证生成资源身份，只接纳该模块实际保留的资源，继续拒绝无关、未声明或冒充的绑定。

显式声明 `sceneDepth: 'before-pass'` pass 的 Standard Surface 可导入 `forgeax_material::scene_depth::{sceneDepth}`。该 Engine-owned 单采样深度纹理位于 Standard View group 的 binding 1；所选模板只为该契约将它加入受信任依赖闭包。Surface 和项目 helper 仍不能声明资源绑定。Renderer 负责 pass 前深度解析，包括多重采样视图。

构建消费者通过 `getShaderCompilerFingerprint()` 获取公开编译器、原生适配代码和已验证原生载荷身份。无法验证时返回结构化失败，不根据磁盘元数据猜测正在执行的编译器。

## 材质与功能编译

| 功能 | 完整契约 |
|:--|:--|
| Engine 材质简写 | [Standard 与 Unlit 发布](README.md#engine-material-shorthand-publication)：省略 schema 的已知根可以补齐所属默认参数组；显式 schema 保持权威 |
| 采样纹理上限 | [纹理能力发布](README.md#sampled-texture-capability-publications)：分别保留 storage 与 uniform 路径的完整程序事实 |
| 自定义 Surface | [Standard Surface 组合](README.md#standard-surface-composition) |
| 多渲染目标 | [MRT 准入](README.md#material-mrt-admission) |
| 光线与 Card 程序 | [共享光线材质构建](README.md#shared-ray-material-cook) |
| 地形 | [地形 raster 上下文](README.md#terrain-raster-context) |
| 材质源发现 | [源码发现](README.md#material-source-discovery) |
| GPU 纹理生成 | [生成程序准备](README.md#texture-generator-program-preparation) |
| 跨文件热更新 | [HMR 传播](README.md#cross-file-hmr-propagation-forgeaxengine-vite-plugin-shader-t-16) |

## 布局、资源与失败

反射使用递归类型描述符保存标量宽度、向量与矩阵对齐、数组步长和结构体成员偏移。扁平字段必须与递归描述一致；过期或矛盾的元数据应重新生成，不能手动改字段绕过准入。

Naga 不透明句柄按所属生命周期释放。编译快照复制调用方容器，并深冻结所属输出；只复用同一所属模块已经验证的不可变事实，不能把任意冻结对象当作已接纳结果。

错误使用 `Result.err(ShaderError)` 与可判别 `detail`，不通过提示文本正则分支。见[闭合错误码](README.md#7-member-shadererrorcode)及[detail 示例](README.md#3-new-detail-variants--json-sample)。先修复 WGSL、参数 schema 或生产配置，再重建清单和 Cook 产物。

相关包：[Naga](../naga/README.zh-CN.md)、[Shader](../shader/README.zh-CN.md)、[Vite 插件](../vite-plugin-shader/README.zh-CN.md)。
