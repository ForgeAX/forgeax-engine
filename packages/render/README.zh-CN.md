# @forgeax/engine-render

[English](README.md) · **简体中文**

Render 把 World 的场景与资产事实投影为持久渲染场景，通过 Renderer 和 RenderGraph 提交画面。材质、相机、光照、视图、捕获和完成帧的观察都经过公开契约，应用不需要接触底层 GPU 句柄。

> [!NOTE]
> 这是面向人的中文阅读入口，不是逐段译文。[英文 README](README.md) 保留完整 API、算法边界、预算、恢复与验证要求；以下按工作流链接原章节。

## 第一帧与生命周期

| 任务 | 入口与约束 |
|:--|:--|
| 构造并提交画面 | [公开帧契约](README.md#public-frame-contract)与[常规渲染路径](README.md#render-happy-path) |
| 理解场景提取 | [持久渲染场景](README.md#persistent-render-scene)：Renderer 消费 World 的变化，避免另建场景权威 |
| 等待并观察结果 | [稳定场景提交](README.md#stable-scene-submissions)：完成回执对应特定帧，提交不等于 GPU 已完成 |
| 跨执行域传输 | [渲染发布](README.md#render-publication)：捕获精确资产版本，接纳后推进源游标 |
| 分析缺失物体 | [可见性契约](README.md#visibility-contract)与[语义场景数据](README.md#semantic-scene-data) |
| 读取完成帧材质事实 | [材质绘制观察](README.md#material-draw-observation-for-completed-frames) |
| 处理资源失效 | [提取与图事务所有权](README.md#extraction-and-graph-transaction-ownership)：旧 generation 的回执不能作为新设备的证据 |

质量设置是对已创作效果的工作预算投影，不会启用原本关闭的效果或回写场景组件。App 选择预设或设备建议，Render 在 `quality.ts` 拥有预算投影。具体边界见[质量预算](README.md#quality-budgets)。

## 材质与几何

材质通过统一 `MaterialAsset`、公开 Pass 与参数 schema 创作。Cook 发布反射和 ABI 回执，运行时消费已接纳的事实；应用不能通过猜测 WGSL 名字修补绑定。

自定义参数 schema 消费场景光照、Skylight IBL 和 pass 前深度快照时，使用原生 prepared/普通绘制契约 `render-lit-material-and-scene-depth`。它保留 cooked 参数布局，提供完整的 Renderer-owned View/灯光资源，并只在用户绑定区域之后追加已声明 IBL 输入。创作 WGSL 导入 compiler 生成的 `forgeax_material::lighting_inputs`；独立的 `render-standard-material-and-scene-depth` 仍保留固定 Standard 粒子参数前缀。自定义管线将 `topology.materialSceneDepth` 传给使用该契约的 `addTypedScenePass`；省略或为 false 时，保留普通附件与批处理路径。

| 主题 | 完整契约 |
|:--|:--|
| 材质入口 | [MaterialAsset 渲染契约](README.md#materialasset-render-contract)与[Standard 物理材质](README.md#standard-physical-material-authoring) |
| 自定义表面 | [Standard Surface](README.md#standard-surface-authoring)与[Standard 光照](README.md#standard-lighting-contract) |
| 顶点与视差位移 | [顶点位移](README.md#standard-vertex-displacement)、[视差位移](README.md#standard-parallax-displacement) |
| 材质槽位与颜色 | [网格材质绑定](README.md#mesh-material-binding-resolution)、[工厂颜色输入](README.md#materials-factory-color-inputs) |
| 点、线与实例 | [点线创作](README.md#points-and-lines-authoring)、[点线运行时](README.md#points-and-lines-runtime-contract)、[World 实例与 CPU 包围体](README.md#world-owned-instances-and-cpu-bounds) |
| 网格与 LOD | [动态网格候选](README.md#standard-dynamic-meshasset-candidates)、[普通网格与 LOD 组合](README.md#ordinary-meshasset--lod-composition)、[相邻 LOD 覆盖](README.md#adjacent-lod-coverage) |
| 透明 | [顺序无关透明](README.md#order-independent-transparency)、[Alpha Hash](README.md#alpha-hash) |
| 折射与薄片 | [透射与折射](README.md#transmission-and-refraction-route)、[薄叶漫透射](README.md#diffuse-transmission-thin-foliage)、[次表面扩散](README.md#subsurface-surface-diffusion) |
| 扩展输出 | [材质 MRT](README.md#public-material-mrt)、[颜色写入与深度偏移](README.md#material-color-writes-and-polygon-depth-offset)、[输出与阴影投影](README.md#material-output-and-shadow-projection) |
| 地形、文字与贴花 | [地形提交](README.md#landscape-terrain-submission)、[GlyphText](README.md#native-glyphtext-assets)、[投射贴花](README.md#projected-decals) |

## 光照、阴影与环境

| 主题 | 完整契约 |
|:--|:--|
| 光照入口 | [光照索引](README.md#lighting-entry-points)与[扩展光照](README.md#extended-lighting-consumer-route) |
| IES | [方向发光分布](README.md#ies-directional-emission) |
| 方向光阴影 | [创作、检查与恢复](README.md#directional-shadow-quality-author--inspect--recover)、[地形 PCF](README.md#terrain-directional-pcf-families) |
| 点光源、聚光灯阴影 | [阴影创作与视图检查](README.md#point-and-spot-shadow-authoring--view-inspection) |
| 接触与角色阴影 | [屏幕空间接触阴影](README.md#screen-space-contact-shadows)、[胶囊角色阴影](README.md#capsule-character-shadows) |
| 大气、雾与云 | [大气与空气透视](README.md#atmosphere-and-aerial-perspective)、[体积雾](README.md#volumetricfog-authoring-world-time-and-recovery)、[体积云](README.md#volumetric-cloud-authoring-and-transport) |
| 环境项 | [恒定环境辐照](README.md#constant-ambient-irradiance)、[半球环境光](README.md#hemisphere-ambient) |
| 全局光照 | [辐照场漫反射 GI](README.md#irradiance-field-diffuse-gi-lumen-lite)、[烘焙辐照体积](README.md#baked-irradiance-volume-build-time-light-bake)、[屏幕探针 GI](README.md#screen-probe-diffuse-gi) |
| 反射 | [SSR 准入与检查](README.md#ssr-admission-and-bounded-inspection)、[动态反射探针](README.md#dynamic-reflection-probes)、[平面反射](README.md#planar-reflection-capture)、[轻量世界反射](README.md#lite-reflections-world-traced-specular-indirect) |
| 距离场与光线查询 | [世界遍历](README.md#world-traversal-seam-global-sdf-or-hardware-ray-query)、[有界距离场组合](README.md#bounded-world-distance-field-composition) |

局部、屏幕空间、世界空间与烘焙技术各有准入和回退边界。不能从某条参考路径的通过推断另一条路径已完成；优先读取所选功能的检查结果和对应真实帧证据。

## 相机、输出与后处理

| 主题 | 完整契约 |
|:--|:--|
| 几何层与辅助显示 | [相机几何层](README.md#camera-geometry-layers)、[编辑器辅助](README.md#editor-assistance) |
| 视图与立体输出 | [多相机视口合成](README.md#multi-camera-viewports-and-composition)、[镜头偏移](README.md#camera-lens-offsets)、[非 XR 立体输出](README.md#stereo-output-non-xr) |
| 深度与裁剪 | [Reverse-Z](README.md#reverse-z-depth)、[裁剪平面](README.md#public-clipping-planes) |
| 输出颜色 | [色调映射](README.md#tone-mapping-output-contract)、[Display-P3](README.md#display-p3-output-colour-space)、[自动曝光与 3D LUT](README.md#auto-exposure-and-3d-lut-authoring) |
| 抗锯齿与缩放 | [SMAA](README.md#smaa)、[时域超分辨率](README.md#temporal-super-resolution)、[TAA](README.md#taa-accumulation-and-private-stability)、[动态分辨率](README.md#adaptive-dynamic-resolution) |
| 遮蔽 | [屏幕空间环境光遮蔽](README.md#screen-space-ambient-occlusion) |
| 镜头效果 | [运动模糊](README.md#motion-blur-temporal-consumer)、[Bloom](README.md#multiscale-hdr-bloom)、[耀斑](README.md#camera-lens-flare)、[景深](README.md#camera-depth-of-field)、[桶形畸变](README.md#standard-camera-barrel-distortion) |
| 选择反馈 | [选择轮廓](README.md#selection-outline)、[距离场轮廓](README.md#camera-distance-field-outlines) |

## 资源、捕获与扩展

| 任务 | 完整契约 |
|:--|:--|
| 渲染目标、立方体相机与探针 | [目标和探针生命周期](README.md#target-and-probe-lifecycle-index) |
| 区域快照与分层目标 | [帧缓冲区域快照](README.md#framebuffer-region-snapshot)、[3D 与数组目标](README.md#layered-targets-3d-and-2d-array) |
| 纹理准入与驻留 | [静态纹理准入](README.md#static-textureasset-admission)、[纹理 Mip 跳过](README.md#texture-mip-skip)、[显式 CPU 纹理驻留](README.md#explicit-cpu-texture-residency) |
| 外部、画布与 GPU 纹理 | [画布纹理](README.md#canvas-textures)、[外部纹理](README.md#external-textures)、[运行时 GPU 纹理生成](README.md#runtime-gpu-texture-generation) |
| GPU 水面 | [GPU Water Mesh](README.md#gpu-water-mesh)与[高级水体生产入口](README.md#advanced-water-producer-entry) |
| 新增渲染贡献 | [RenderFeature 扩展契约](README.md#renderfeature-the-producer-seam)：依赖、资源和生命周期仍由既有图所有者管理 |
| VFX | [粒子贡献边界](README.md#particle-feature-boundary) |
| 性能与故障检查 | [GPU Pass 计时](README.md#gpu-pass-timing-opt-in-draw-observe-branch-on-status)、[CPU 分析](README.md#optional-cpu-profiling)、[离线检查与恢复](README.md#offline-inspect--repair-owner--retry) |

## 恢复与验证

先读取 `renderer.inspect()` 与结构化错误，沿所属模块修复源输入，再提交并检查新的完成回执。保持设备、图、帧和资产 generation 对齐；不要把旧回执、缺失 PNG、RhiNull 结果或 CPU 时间当作新画面的 GPU 证据。

相关包：[Types](../types/README.zh-CN.md)、[Shader](../shader/README.zh-CN.md)、[RHI](../rhi/README.zh-CN.md)、[DevKit](../devkit/README.zh-CN.md)。
