**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具使用英文 `SKILL.md`。标识符、错误码和执行命令保持原样。

# forgeax-engine-shader

可选 River `transitionContinuity` 使用已验收的末端样条位置及真实当前 generation Ocean coverage 邻接关系。创作有限的米制 reach 与 blend width；完整共享三角形在 inner reach 内闭合，支持范围外保留上游高度。源码 flow/depth 仍由 native/query 拥有。WaterMesh v8 保持 96 字节记录，在 byte 92 增加 `WCN1` 数值 support offset；顶点与片元共享其 original-grid 策略。用 `material-pack-cooker/7` 重新 cook，编译产物使用 `material-cook/5`。初始连续性契约不包含 GPU 遍历、独立 Baked depth、自定义 deformation 或独立高级 displacement。见 [Water 契约](../../packages/water/README.md#optional-terminal-surface-continuity)，声称像素验收前运行最近的生产 Dawn 关卡。

## 契约索引

普通 `.pack.ts` 材质发布已解析的源模板和 WGSL 依赖。先确认资产加载成功，再按真实渲染 pass、几何和设备检查编译出的程序。用 GPU 捕获核对反射与像素。

带纹理的单层 medium Surface 在材质 parameters 声明纹理，采样生成的 texture/sampler 符号。编译器与 Render 一起推导 author region 并重定位原生光学资源；禁止把固定 IBL、backdrop、depth、planar bindings 复制到游戏着色器。

Water 使用根拥有的 `water-deformation/1` 声明与 Types 的规范输入布局；cook receipt 覆盖 color、depth、shadow、velocity。仅 Surface 的 WaterInfo reader 可省略 deformation。反射的 `water-frame/3` 入口 bindings 决定实际 Water 资源子集、可见性和 dynamic-offset 顺序。Fixed/Baked Body 输入无需纹理；WaterInfo reader 必须有真实同视图 target。见 [Water 材质契约](../../packages/water/README.md#material-family)。每个 Body GPU 行独立保留已验收固定回退常量，不能随采样源模式丢失；禁用 WaterInfo 必须保留此 buffer 路径。

Water 专用输入 ABI 传递原始 `vertexColor` 和顶点解码的 `vertexFlowXZ`；解码与 actor 方向变换必须先于插值。Static Baked/fixed 开关显式选择来源，同一 Body publication 保留其实际可访问的 WaterInfo/Baked 资源。`waterVertexMapping` 独立降级到顶点高度可用性，不裁掉片元读取或波浪。`waterDynamicBoundsClip` 独立于 mapping/Info 降级为 `WATER_DYNAMIC_BOUNDS_CLIP`，默认 false。内置消费者用 WPO 后片元位置及 generation 校验后的 Body 行 `dynamicBoundsCenterExtentXZ`，无需 Info 纹理；无 bounds 时绕过裁剪。用 `material-pack-cooker/7` 使旧派生字节失效，编译产物使用 `material-cook/5`。

`WATER_TRANSITION_AVAILABLE` 由关闭普通 waves 且启用 transition 推导。默认 deformation 要求创作的 `f32` wave-mask speed；可选 vertex flow 时还要求 `f32` 最大解码 flow speed。字段缺失在编译前拒绝；仅 Info 开关不能排除 Body 运行时 vertex-flow 回退。

Water Surface 输入保留 WPO 前 normal/position 与 Water 前 scene depth。追加的 `wavePhaseXZ` 从小尺度 morph 后 WaterMesh coverage 和 target-relative tile offsets 推导，再 wrapping；不要插值已经 wrapping 的 phase，也不要对大绝对 `f32` 位置做减法。仅解析为内置默认 deformation 时启用完整片元 Gerstner normal 计算。source depth 用 no-WPO position，transition velocity 用 post-WPO position，target 行选择 waves/time。`refractionPixelNormalStrength`、`refractionDepthBias` 无量纲，`physicalIor` 独立。普通继承的 `criticalAngleDot`、`refractionBottomAmount` 独立于 `specular` 控制水面下方响应。Water SSR 命中 motion 只有在 FP16 log-depth 精度内匹配精确 opaque depth texel 后才能替换矩阵重投影；粗略 traced ray depth 不是层身份。

内置 Water 在远边界保留近处 waves 当前/上一帧 deformation 及片元 normal；保留的版本化邻接 bits 不会自动把表面压平到平均平面。保留远材质独立 wave 开关与保存的高度权威。

connected foam 分支的 graph-owned texture 及不同 clamp/wrap samplers 跟随现有 medium physical tail；仅实际声明该分支才准入、绑定。它不是创作纹理参数，不改变通用 medium Surface ABI。共享 contact foam 与 additive shallow-wave foam 保持独立，用现有最大值操作合并采样响应；有效 contact capture domain 不能遮掉更强 wave 来源。共享 contact 与 residual-only mapping 发布有界 foam coverage，乘以创作 opacity/scattering 纹理采样，不使用旧 height power、boost、threshold。保留材质 amount、depth fade、normal、optics。

SLW volume 在 surface AO 前使用共享 diffuse-indirect sky 输入，以四分之一系数把 E/pi 转为各向同性 ambient。现有 receiver AO 只用于 surface diffuse；没有 lighting owner 生产者就不能使用预计算 bent-normal lighting。

着色器编译器只在构建期运行：组合真实模块 slot，反射封闭 compiler context，记录真实 WASM provenance。材质身份分为 `materialContractDigest`、`sourceClosureDigest`、`layoutIdentity`、`programIdentity`、`cookIdentity`、`materialPublicationIdentity`；运行时只接收 Pack 投影，不能 compile、cook、解释 feature macro。

Standard raster 接口为 `front_facing` 保留一个默认设备 inter-stage input。片元 position/NDC 从 builtin position 和 inverse view projection 重建。Water coverage/grid 输入保留自己的 lane，wave mask 共享 Water normal 第四分量。vertex color、全部八套 UV、object basis、scene indexing 必须放进剩余十五个 locations；修改模板后重建 cooked profiles。

> [!IMPORTANT]
> 创作路径是 WGSL 源码加一个 MaterialAsset 契约。构建期 composition/reflection 发布 module manifest entry；material cook 发布 artifact 与 receipt；运行时通过 catalog 解析二者。App 不能安装或复制 shader artifact。恢复方式为修复 source 或 cook。

CI manifest transport 在原生 Node 直接加载 publication TypeScript 源码。该源码边界必须原生可解析，不经 bundler 验证；只跑 bundle 包测试不能覆盖此路径。

发布共享 source fragments 和 ABI receipts。Registry 准入在原子采用前验证每份 source/variant，仅在消费时保留组合 WGSL。用源码生产者重建过时 prepared/shared profiles，不能跳过 digest 检查或删 capability variant 来缩小 manifest。反复 prepared-build publication 成本先检查 pooled-fact serialization；不可变对象身份的驻留仅限同次 publication，保留规范值去重、全部 variants、精确输出字节及后续构建的新事实。

分离的 reflection facts 可在同次 publication 共享相同不可变子树。pool 限于 admission；保留完整值与顺序语义，同时测量冷 admission 成本与保留存储。借来的可变 descriptor 不能进入按身份复用路径。

## 颜色与光照对齐交接

parity report 指出 shader 或输出域偏差时，先看 [parity README](../../apps/parity/color-lighting/README.md)，再按状态恢复表选择 owner。对比相同 `SceneCase`、`CaseReport`；只有源码名称一致而无独立生产者证据不能通过。

## 路径

在首次 draw 前检查结构化错误并修复 source/cook。每个 slot 的 `coordinates` 留在材质 texture value 上。

1. 为 WGSL 源码声明包拥有的 `#define_import_path`。
2. 导入 `forgeax_view::common`、`forgeax_pbr::brdf` 等 Engine 模块。
3. 在根 MaterialAsset `parameters`、可选 `parent`、`values` 声明一致字段；模块身份使用 `passes[].program.module`。
4. 执行构建 composition、reflection、material cook。
5. 按 GUID 加载 MaterialAsset，首次 draw 前检查结构化 readiness 错误。

```ts
assets.configurePackIndex('/pack-index.json');
const result = await assets.load(materialGuid, 'material');
if (!result.ok) {
  report(result.error.code, result.error.detail, result.error.hint);
  return;
}
const materialHandle = result.value;
// Bind directly to MeshRenderer.materials; release the caller reference after binding.
const content = assets.read(materialHandle).unwrap(); // detached inspection only
```

## 外部视频纹理

`{ name: 'videoTexture', type: 'texture_external' }` 反射为 WGSL `texture_external` binding 与 `videoTexture_sampler`，推导 `externalTexture` layout entry。从 `forgeax_material::parameters` 导入二者，用 `textureSampleBaseClampToEdge(videoTexture, videoTexture_sampler, uv)` 采样，无 mip，不用 `textureSample`。同一 slot 接受零复制视频帧、`caps.externalTexture` 为 false 时的复制帧、导入的 `GPUTexture`，一个 shader 服务所有后端。保持源方向：`uv.y = 0` 为图像顶部，不翻转。

## 混合自定义材质与雾

带 blend state 的自定义 WGSL 材质导入 `forgeax_view::fog::{translucent_fog}`，最终颜色返回 `translucent_fog(view, worldPos, color, alpha)`，每个 writer 只应用一次。Renderer 按 blend state 选择 straight、premultiplied、additive 合成，opaque draw 绑定无雾 View，同一程序可服务两者。clip-space 生产者用 `ndc_world` 重建 `worldPos`。

## 坐标输入

自定义 Standard Surface coverage 使用根已有静态选择：`alphaClipping` 选择 Surface 输出阈值，`alphaHash` 启用 hash coverage。自定义 Surface 的 `Materials.standard` 默认关闭二者；`alphaClip` 发布的是 `alphaClipping`，不是 pass tag。JSON roots 同样使用这些开关。不能从内置参数名或旧 `alphaMask` receipt 推断自定义 coverage，该组合描述内置输入而非入口副作用。保留作者 discard 与独立 LOD/view/local clipping；声称 opaque entry 前验证 cooked direct、scene-index programs。

内置 Unlit、skinned Standard 独立选择 camera clipping 与材质局部 planes。Unlit color/depth 使用明确 alpha-mask lane，时间 coverage 保持精确。Alpha helper 返回拒绝值，片元入口拥有 discard；不能扩展 nested-discard allowlist 接纳新 helper。

内置与自定义路径都使用命名 texture values：`coordinates.set` 选择顶点坐标输入，`coordinates.transform` 应用 offset、scale、rotation。不要增加全局材质坐标选择器，它不能表示不同 slot 使用不同输入的 glTF 材质。

## 内置色调映射

`forgeax::tonemap` 是全屏输出 shader，不是 MaterialAsset shader。公开 mode ID 从 `@forgeax/engine-shader` 的 `TONEMAP_SHADER_MODE` 导出；`@forgeax/engine-render` Camera 常量消费此类型化 binding 契约。

命名曲线为 `linear`、`reinhard`、`cineon`、`aces-filmic`、`agx`、`neutral`，匹配 Three r184。`reinhard-extended` 为独立 ForgeAX 亮度域曲线；`ue-filmic` 为 Unreal 默认 Filmic 曲线与配置。每个活动 mode 接收 linear HDR 与 exposure，输出 linear LDR，显示 attachment 完成最终编码。WGSL 公式在 [`src/tonemap.wgsl`](../../packages/shader/src/tonemap.wgsl)，不能复制到材质、app 或其他 shader module。

变更需经正常构建 composition 编译，并将最终 capture 与 Three r184 解析 oracle 比较。源码名称一致但公式或输出域不一致不能通过。

## GPU 驱动 scene-index 材质

组合 scene-index 顶点入口遵循 [LOD coverage ABI](../../packages/shader/README.md#lod-coverage-abi)。Skin palette 寻址从 `forgeax_view::common` 导入 `sceneInstances`，读取 `sceneInstances[visible.x].customDataStart`。GPU cull 拥有 LOD 选择，材质仅应用已发布 coverage。

> [!IMPORTANT]
> 迁移时，cooked scene-index 材质不得读取 `Mesh` 行或把 `visible.x` 当作 batch 内索引。通过 `forgeax_view::common` 的 `sceneIndexDraw(visible.x)` 解析变换、时间标志、probe 身份，向 `applyLodCoverage` 传递 `bitcast<f32>(visible.w)`。

Scene-index Morph 在 world transformation/skinning 前使用 common module 的 position/normal/tangent accessors。紧凑 target records 与 channel mask 来自 Render 生产者，不能假设 target stride 只有 position。规范 tangent delta 为四分量；导入 glTF delta 的 W 为零且保留 handedness，不能以 XYZ stride 读取四分量流。

## 契约与反射

编译器从 MaterialAsset 参数契约推导 uniform layout、sampler/texture bindings、注入 slots。WGSL reflection 必须匹配推导布局；不一致属于构建或 cook 失败，在源码边界修复。

原生 selected-entry `effects` 与 binding reads 同行。旧数据缺失 effects 表示未知；不能从参数名、源码文本、模块其他入口推断无副作用。考虑 position-only prepass 时保留 depth/sample-mask/storage effects 与 pipeline alpha-to-coverage。同一源码原生事实矛盾须修复生产者。

## 恢复

| 错误码 | 恢复方式 |
|:--|:--|
| `shader-module-id-missing` | 增加编译器原生模块标识。 |
| `shader-module-id-duplicate` | 模块 id 只保留一个源码。 |
| `shader-module-not-found` | 加入构建源码目录。 |
| `shader-module-namespace-reserved` | 使用用户拥有的命名空间。 |
| `material-reflection-binding-mismatch` | WGSL bindings 对齐根契约后重新 cook。 |
| `material-specialization-not-cooked` | 为请求的 selection 执行 cook。 |
| `material-specialization-stale-generation` | 依赖源码变化稳定后重新 cook。 |

每次失败都按 `error.code` 分支，读取 `error.detail`、`error.hint`。演示失败交给 Engine 或 cook 边界，不能通过改演示材质数据绕过。

## 路由

外部 Vite 源码消费者先构建 Engine 包，再在 Engine 检出运行 `node scripts/forgeax/prepare-shader-release-inputs.mjs --build --profile base-ssao`。App 保留 `forgeaxShader()`；检查解析插件的 profile/source 诊断，缺行或过时 compiler facts 应转为源码编译。不带 `--build` 打包要求当前生产者 receipt 与 payload digest。准备和复用见插件 README。

Engine 贡献者检出中的独立 Dawn fixture 若使用创作材质包，通过 `buildEngineShaderManifest` 和 CI 准入共享输入复用 built-in rows，同时自定义材质仍从源码编译。point-shadow 请求要求对应 source profile。修改准备过程前查阅 [shader 插件契约](../../packages/vite-plugin-shader/README.md)及 [CI 操作指南](../../scripts/ci/README.md)。独立 Dawn 测试复用已有 `shaderManifestUrl` fixture，序列化 `publishShaderManifest(entries, materialShaders)`；不要 percent-encode 展开的 builder result。

- 材质形式：[材质技能](../forgeax-engine-material/SKILL.zh-CN.md)。
- 资产目录与 Pack roots：[资产技能](../forgeax-engine-assets/SKILL.zh-CN.md)。
- Shader 包：[`packages/shader/README.md`](../../packages/shader/README.md)。
- 迁移指南。

## 运行时源码所有权

`MaterialShaderProgram` 拥有不可变 CPU facts 与 `sourceReference`，`.source` 从不可变 source owner 借用完整 WGSL。运行时原始字符串保持完整：接收 library/material 时不能重建 fragment pool。继续支持构建生成的 manifest references 与完整性检查。Registry lookup 索引同一 program，不另设 facts cache。托管 module factory 保留 source owner，使 prewarm/runtime 命中不再次展开或哈希。pipeline 复用仍由完整 descriptor/state 相等及设备本地 native completion 决定。

Registry `sourceLimits` 限制新动态 source bytes 与 registration/schema/module alias slots，包括失败 schema 的保留量。固定 startup/background source inputs 是受有限输入安全约束的封闭构造快照，不是运行时 static 标志。fork/adoption 保留已用配额；拒绝 admission 不影响旧 artifact 可用性。真实所有权和默认值见 `sourceInspection()` 与 [Shader README](../../packages/shader/README.md)。source quota 不是 GPU/VRAM 容量。

## Cooked 材质 CPU 准备

Cooked program 通过 `installMaterialArtifactBytes` 进入 ShaderRegistry，验证 byte digest、schema、ABI/read metadata。用 `materialArtifactDeclaration` 或 `materialShaderIdentifiers` 检查可用性；普通 `materialArtifact` / `findMaterialArtifact` 查找会准备所选 WGSL。Worker publication 和 device recovery 保持 declaration/adoption 路径，不能解码所有 variant。返回 prepared program 前仍执行 source-dependent validation。artifact 加载/解压和 GPU 编译时间点保持原样，不增加运行时编译器。

## Three Surface 表达式配方

原生 r187 Standard/Basic NodeMaterial 表达式使用 [Three 契约](../../packages/three/README.md#cooked-surface-expressions)的显式 `cookThreeSurface` 构建入口及 `bindThreeSurface` player binding。admission 与 lowering 使用同一私有类型化 DAG，布局和发布通过 native cook/reflection。保留普通材质快速路径与明确 rebind 边界。超出文档子集的输入以类型化 source path 拒绝；独立验证各 stage 消费者。player 不能调用 NodeMaterial.build、NodeBuilder、GLSL 翻译或编译器。

现有普通 map slot 可与独立 expression roots 一起绑定已完成的 native 2D target。cook slot membership，等待 target write；这不代表准入 render-target TextureNodes 或依赖 framebuffer 的图。
