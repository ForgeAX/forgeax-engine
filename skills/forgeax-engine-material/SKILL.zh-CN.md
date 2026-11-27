**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。示例代码保留原文。

# forgeax-engine-material

可选 River transitionContinuity 使用已验收末端 spline position、真实当前 generation Ocean coverage adjacency。创作有限米制 reach/blend width；完整共享 triangle 在 inner reach 内闭合，support 外保留 upstream height。派生 support 包含同 River 邻接普通 patch，共享 target wave row 而不改材质。source flow/depth 仍为 native/query 权威。WaterMesh v8 保留96字节记录，byte92 增 WCN1 numeric support offset，vertex/fragment 共用 original-grid policy。material-pack-cooker/7 重新 cook，durable material-cook/5 不变。初始契约不含 GPU traversal、独立 Baked depth/custom deformation/advanced displacement。见 [Water](../../packages/water/README.md#optional-terminal-surface-continuity)，像素验收前执行最近 production Dawn gate。

## 契约索引

## Water 材质入口

海岸集成用 [R8](../../apps/water/r8-integration-acceptance/README.md)。Mesh storage 改后缺水，检查真实 WaterInfo work、accepted immutable dependency。runtime attribute array 是 layout declaration，Water consumer 从 Water snapshot owner 读 canonical position/color windows。R8 Browser surface gate 保留普通 CI：真实 Pack publication、60 completed frames、current WaterInfo/draw receipts、ocean pixels。

共享 material publication program 必须保留完整 Pack-owned compiler context key，artifact bytes 相同不标识 pipeline selection。capability support 不证明 assembled branch/reference parity。Q0、appearance replacement、可选 R6 simulation 独立，缺 contact foam 不授权换 mesh/开启其他 branch。WaterMesh source revision 下同 Body 可同时出现在 retained/current WaterInfo targets，material binding 按 accepted draw key 解析完整 cohort，不能仅按 Body identity 选 instance range。

仅当 completed receipts 与当前 Body/Zone、WaterInfo、mesh、graph generations 一致才接受 mode。current Renderer state 与 last submitted inspection 分读，保留 recovery failure。River spline 编辑须完整 recook geometry closure，经 Assets 替换 accepted payload，不 patch cooked spline fields。mounted source-owned River 的 saved collision disable/re-enable 必须与匹配 Native receipt 同提交，empty retirement 失败保留 accepted Water source/collision 供同 saved change 重试。collision geometry/full Scene matrix 未变的 material/source-version rebind 保留 Bake/Native receipt。换其他 Body kind 要先 unmount，等待 Native source retirement，再 mount replacement。

shallow/spectral simulation 从 [Water advanced entry](../../packages/water/README.md#advanced-simulation-entry) 开始。opt-in mode-projected-gravity/1 World OceanPatch 经 additive shallow slots 使用 materialGrid/materialNormal/foam/mapping，mapping 标 residual-only，保留 Terrain depth/Body flow；uniform linear-wave depth 不是 Terrain sample。真实 domain/grid/slab/depth/velocity/time configuration 均须 qualify。

显式选择 saved WaterShallowCollider.dispersiveMotion：entry object 用 full displacement，floating hull motion 用 surface transport。surface transport 按 native horizontal velocity，从当前 submerged union 的迎面 boundary 输出水量，保守 flux 产生 bow/side waves；stern retreat/passive buoyancy heave 不是 entry wave。证明 source location、双向传播、停止后衰减，不能只看非零 height/foam。native receiver identity 仅从自身 buoyancy 排除自身 source，完整 visual field/其他 entry wave 保留。读 Scene source contract，证明默认 scene 实际 idle/entry/sailing，source-off control 不算验收。

夸张 entry diagnostic 用 finite nonnegative recipe entryWaveMultiplier，默认1，同时缩放 visible/external buoyancy full-displacement source，独立于 sailing transport，测力不能换为材质 height/normal gain。增强 sailing wave 用独立 surfaceTransportMultiplier，finite nonnegative 默认1，在演化前缩放 visible/external receiver conservative bow/side transport。对比 gain 保留 source velocity/geometry/stopped decay，foam 为独立 emitted history。local free wave 在 Engine solver 内耗散，receiver field 也一样。

局部 momentum input 用 OceanPatch.enqueueWaveImpulse，world XZ、cell-resolved radius、signed vertical velocity、native time。同 gravity field 拥有 displacement/normal/foam，impulse 零净体积。author 校准 incident energy；sourceReceiver 排除自身 buoyancy、保留其他 receiver。完整 submission 消费 queue，discard/pause 保留，reset 清除。按 Water 契约在 background wave 存在时验真实传播；线性输入不代表非线性 impact solver。

可选正 waveDampingPerSecond 默认0.35/s，scene recipe 可调；按 elapsed time 衰减非零 Fourier mode，守恒 mean displaced water。foam coverage 独立 decay，残留 slope 可再发 foam，调 lifetime 前同时查 wave energy/emission。background Gerstner crest foam 独立，改 material power/boost/local foam 前检查 submitted compression minimum/range 与真实 wave distribution。

cold GPU preparation 保留最新 visual-probe contact state，不将每个 stationary native step 累积 pending foam queue。held-frame sample/source acknowledgement/discrete Physics entry event 保留。同 native root/generation 有显式 hull contact-probe 时优先于 implicit pontoon foam，pontoon force/geometry wave field 不变，无 probe root 保留 foam fallback。

shared contact/residual-wave foam 是 bounded coverage，材质响应保留 authored foam texture 空隙，在 material amount/depth fade 前受 coverage 限制。旧 height power/boost 仅属 legacy response，不能调 demo 弥补混用语义。

使用普通加载 water-advanced recipes：mounted Body 拥有 shallow simulation，一个 World 一个 OceanPatch。material texture values 用 renderFeatureTextureSource 绑 output name，waterShallowSimulation/waterOceanPatch 静态开关独立。River Bake 先发布普通 Pack recipe/texture，当前 Body 再接受 query grid。texture preview/stage name 不证明 completed GPU bytes；[R7](../../apps/water/r7-advanced-shallow-bake-fft/README.md) 提供内置 default、创作 configuration、支持 input。

shallow materialGrid/materialNormal 绑 frame atlas、2x2 Mapping（current row0、previous row1），atlas 先 current 后 previous；canonical RT/stage capture 原尺寸不变。deformation 在每 frame 内 clamp 后再加 atlas offset。Render 拥有 GPU history copy/reset seed。WaterBody Fade 是 depth solver 的显式 startFadeSeconds，不是 material fade/River stage。

geometry visual detail 仅用 configurationVersion:2 的 mode-projected-gravity/1，必须闭合 visualNormalDetailFft block，其 noise GUID 纳入普通 recipe textureGuids closure。同 World visualNormal 绑可见 River material NormalDetailTex，world XZ projection 配 authored WPOWaveScale/BakedWaterSimSize。RGB 为 signed +Y-up normal，A 为 raw visual height；二者不能进入 CPU query/WaterInfo/foam/collision/buoyancy。runtime acceptance 要 submitted visible-draw receipt/paired pixels。

R4 foam 检真实 meshMaterialBindings[].waterFoamInputs，配对 accepted static-map GUID/version、effective switches、view graph reflected FoamRT consumer/initializer。Static BeachFoam map、可选 fluid RT、Baked refs 是独立输入。关 R6 producer 保留默认 no-simulation semantic target/static maps。

用 EngineContent.water.materials GUID 或 buildWaterMaterialFamily 普通 root/child。Body slot、独立 deformation/system-input 契约见 [Water material](../../packages/water/README.md#material-family)。Standard、single-layer-medium、single-layer-water Forward Surface 均可用于 Body。deformation 可选，不按 shader name 推断。shared-root/单 Body child 编辑归已有 Asset publication，失败 replacement 保留完整 accepted closure。

generated River/Lake/Ocean static mesh 经普通 defaults 消费 Body LOD slot；WaterMesh/Custom override 消费 surface routes。Body fixed fallback depth 属 Body payload，不是 material value。Baked availability 不自动启 waterBakedSimulation；fixed velocity/height/depth 各独立开关，无 Info 的 velocity 否则读真实 vertex flow。River LOD mesh 经普通 color stream/material color variant 传 flow。

waterVertexMapping 独立控制 vertex height，默认 true，不禁 fragment Info/Baked/wave；stock Custom/LOD/far/HLOD 关闭 mapping。waterDynamicBoundsClip 对任意 root 默认 false，stock root/三个 native LOD 启用，Custom/far/HLOD 绕过。这些 author choices 独立，用当前 producer recook，不按 family name 猜。

River flow normal 用 riverNormalTilingM，Ocean BeachFoam 用独立 foamTilingM，River-to-Ocean 两字段均保留。transition mask 用继承 waveVelocityMaskThresholdMPerSec，默认1m/s，默认 deformation 要 f32 声明；除 fixed/Baked velocity 胜出外，vertex fallback 另要 maximumFlowVelocityMPerSec:f32。结构化 cook rejection 指字段，修后 recook。

stock Water 每 fragment 重算完整 Gerstner normal；source Body 拥有 height/depth/velocity，transition target 拥有 phase/time/range。far Ocean tile 保留 Ocean 原 baseHeightM-maxWaveHeightM placement，saved level/conservative cull bounds 独立，view-window 不能自动移到 mean plane。phase/depth 不含 WPO，pixel transition velocity 用 post-WPO；custom normal 保持权威。Custom default 为 fixed height/depth、vertex velocity，fullscreen underwater fallback 解码真实白 post-process VertexColor。Ocean foam 用 Content 3D volume/graph-owned FoamRT，不用 static replacement；no-sim initialization/channel/lifetime 见 Water README。

## 光照资产入口

1. RectAreaLight 是单面矩形光，width/height 定尺寸。sourceTexture 接任意尺寸2D TextureAsset：rgba8/bgra8 sRGB/linear、r8、裁到[0,1]的rgba16float/rgba32float 走 CPU projection；KTX2 BC/ETC2/ASTC 从 level0 GPU 重采样，需 compute/匹配 compression feature，否则一次 feature-not-enabled 并 white slice。像 Unreal SourceTexture 影响 diffuse/specular。u 沿 local +X，无 handle 为 uniform emission。发光 quad 图像需自行显示，light 不画自身。
2. Point/Spot/Rect 都可绑 iesProfile。Point/Rect 取 Transform orientation（+Z polar、+X向+Y azimuth），Rect 按 center-to-receiver 调制 LTC。Spot 保留 direction/rollDeg/可选 cookie TextureAsset。IES 形状独立于遮挡阴影，可让 pedestal lamp 向下 emission 为零。格式/capacity/limits 见 [IES](../../packages/render/README.md#ies-directional-emission)。
3. LightProbe 声明27个 irradiance 值和 radius，GPU slots/LTC/probe registry 非 public API。

author/publish/admit/accept/verify 是证据阶段。IES build-time cook IesProfileAsset，runtime GUID load。按 code/detail/hint 回 producer rebuild，fallback 不算 verification。

只有一个 MaterialAsset subject/Pack publication，runtime bool/value、composed slots、closed compiler context 为输入，不能用 macro/define/runtime cook/app fallback。从 current 到 generation 追 materialContractDigest/sourceClosureDigest/layoutIdentity/programIdentity/cookIdentity/materialPublicationIdentity，修首个 divergence，同 GUID cold-cook，验 receipt/artifact/provenance。

> [!IMPORTANT]
> 可见物体为 MeshFilter+MeshRenderer+MaterialAsset。创作一个 payload、cook effective contract、GUID load、分配 World handle。结构化错误恢复，不造 app-local shader artifact、不在 demo 绕 Engine defect。

## Three 源码创作

根 UniformsUtils.clone/merge 保留原 r187 CPU 语义/constructor family，不启 GPU addon。自定义 Material.onBeforeCompile 以 three-migration-required/material UUID 拒绝：surface 迁到 cooked WGSL/MaterialAsset，lighting/pass 迁 native owner；普通默认 hook 准入。

@forgeax/engine/three 与其 public addon subpath 配合，CPU geometry/skeleton clone/surface sampling 共一 constructor family。88个 CPU addon 包括 rounded/parametric/convex/text geometry、Font/STL/PLY/XYZ parse、OBB/Octree/hull/capsule、noise/curve/SceneUtils，modifier、Decal/Teapot/ParametricFunctions、OBJ/MTL/HDR loader、OBJ/STL/PLY exporter、clip/CCD IK、camera/color/geometry util、Lut/helper，不导入 native renderer/cooked program。

parsed geometry 保留普通 material/topology admission。Points 经 native tint stream 消费 RGB/RGBA（含 normalized attribute/published color edit），Lines 仍拒 vertex color；Lines/Points UV、point-coordinate texture 仍拒绝。OBJ/MTL 留 CPU Phong，显式选支持 native material。HDR parse 不安装 environment/PMREM；modifier/exporter/IK/clip 显式调用。SimplifyModifier import 初始化内嵌 CPU WASM，await modify()；PLYExporter 可无 callback 返回。CPU OBB/Octree 不建 physics body。

另含 FBX/SVG/BVH/PCD/VTK/MDD/PDB/NRRD、TGA/DDS/KTX/EXR/IES、Cube/3DL LUT、NURBS/LoftGeometry/ConvexObjectBreaker、color-space/HSV/radix-sort。convex cut 是 nullable Mesh；radix sort 用 Uint32Array/调用者匹配 scratch。VTK/NRRD parse byte buffer；VTK 无 path 参数，保留旧 r187 sniff limit。NRRD segmentation 为显式 void setter，parser helper 私有。HSV 输出 h/s/v，复用 caller target；SVG 需 DOMParser。FBX mesh 显式选材质，CPU volume/LUT/IES/BVH 不装 native system，convex fragment 不建 body。compression 仍按 device gate。[Three 契约](../../packages/three/README.md) 拥有 supported input/shared-World lifetime；source-backed object 保留 source authority。Matcap alpha 用普通 UV 独立于 sphere lookup，经原 native alpha binding。

controls 还含 Arcball/Drag/FirstPerson/Fly/Map/PointerLock/Trackball/Transform，Fly/FirstPerson update 要 caller delta，均须 dispose。保留原 DOM listener/可选 Arcball inertia，不加 Engine frame driver。Transform gizmo 对非 finite renderOrder 仍拒，CPU attach/mode 不证明 native editable gizmo。SelectionHelper 接 DOM canvas，SelectionBox 为 CPU query。Collada/AMF/3MF 需 DOMParser；VOX parse 可 undefined/scene nullable，AMF 单位转 mm。AnimationPathHelper 用 UUID position tracks，可选 line/points。GLTFExporter 已验无纹理 JSON/GLB roundtrip，不等于 compressed texture export。SceneOptimizer 显式重写/dispose source mesh，用已有 CPU BatchedMesh expansion，不推断 GPU batching/FPS gain。

r187 canvas size/DPR/viewport/scissor 以 renderer.getCanvasTarget() 为准，setCanvasTarget 可换同 canvas target。保留 full viewport、full/disabled scissor。setRenderTarget(null,face,mip) 保留默认 framebuffer state metadata，face0..5、mip非负safe integer，省 selector 归零；非 null target 不支持。framebuffer texture 需 native attachment lease，不能当普通 image。StorageTexture/Array/3D 为 CPU descriptor，在 pending-image allocation 前拒。

显式 NodeLoader registry 保留原 node identity，scene 同材质准入。Node/material registry 接 constructor 无 cast，NodeLoader 加载单 Node。serialized node scene 的 IOR 用显式 iorNode，r187 不序列普通 IOR。IOR1.5 native transmission pixel gap 仍未 qualify，不能从 IOR1 fixture 推断普遍折射等价。TSL 从 three/tsl 或主 facade TSL namespace 导入，共 constructor family。

Basic/Lambert/Standard/Physical/line/point/Sprite NodeMaterial 的 colorNode/opacityNode 接原 UniformNode 或普通2D texture node，Lambert/Standard/Physical 另接 emissiveNode；Standard/Physical roughnessNode/metalnessNode 为 uniform。Physical 另投影 uniform clearcoat/roughness、sheen/roughness、specular intensity/color、IOR，替换普通 value/map，使用同 native parameter，bounds 见 README。另投影 uniform iridescence amount/IOR/absolute thickness、transmission/thickness/attenuation distance/color。transmission node 存在（即使零）选 sorted transparency/double passes。

SpriteNodeMaterial 接 uniform positionNode Vector3、rotation finite float、scale positive finite Vector2。scene override 继承 source position，rotation/scale 保持 override selection。LineDashed 接 uniform offset/dashScale/dashSize/gapSize，经 lineDistance 投影，dashSize>0、gap>=0、scale 可 signed/zero。transform-only edit 复用 material asset。anisotropyNode 因 captured native gap 仍拒。Normal/Matcap/未列 graph field 保持 null。无 callback/operator/ConstNode/Fn/custom UV/LOD/precision override/attachment sampling/runtime graph compile，固定值用普通 color。现 topology/material 边界不变，Physical texture recipe 用 effective selection，可能需显式 build-only cook；publication 前拒 unsupported。

精确 MaterialReferenceNode/TSL.materialReference leaf 可按 ASCII identifier 读单 direct material property，类型 float、Color/vec3、vec4，遵守同 surface fields/model/bounds/map replacement。无 explicit target 取当前 selected material/instance，有 target 替换 selection。独立 value 通过替换 instance property；不更新 source node cache/NodeFrame。Sprite pose 仍 UniformNode-only。path/array/texture/arbitrary graph/custom hook/missing/incompatible value 在 publication 前拒，无 reference JSON hydration。CPU Phong/Toon/SSS/Shadow/Volume/Line2、Basic/StandardNodeLibrary、Lighting、NodeMaterialObserver 仅原 CPU API，不加 native model/renderer；library.fromMaterial 不匹配返回 null。

精确 ReferenceNode/ReferenceBaseNode/UserDataNode leaf 可读显式 object/userData 的同 direct-property 契约，Object/Base 读 object，UserData 读 userData。替换 selector/value 无需更新旧缓存也可观察。shared store 共享参数，独立 material binding 可用独立 store。native system 可维护普通 object，不加 entity mirror/per-object material variant。implicit frame.object/userData、Sprite pose/path/array/buffer/texture/custom hook 仍拒。GLSLNodeParser/RTTNode/ReflectorNode/ToonOutlinePassNode 仅原 CPU parser/descriptor，target/view/cache/dispose 不增加 native RTT/reflection/outline execution，后三个 pass/texture leaves 拒绝。

NodeMaterialInstance 保留共享原 NodeMaterial definition/独立普通 instance values；初始 object value 共享，独立颜色要 new Color。node input 改 definition，graph shape 改后 needsUpdate，uniform value edit 不要新 graph。Basic/Standard/Sprite/dashed instance 用已有 projection/handles，Sprite sizeAttenuation 属 definition（原 instance 缺 prototype accessor）。不同 instance 作为 scene override 在 coverage projection 前拒。Physical instance/nested/custom definition/shader-hook/arbitrary materialReference graph 仍拒。CPU environment/viewport/pass/shadow/velocity descriptor 不提供 GPU execution。

## 阴影 receiver bias

阴面亮斑先 RHI Debug 捕失败帧，查 receiver/shadow depth/真实 light UBO，再改 roughness/emission/shader。Directional/Spot depthBias 为 normalized light-depth offset，默认0.00001，不是 Point 的米制 bias；大值随 cascade span 放大，可抹掉顶上遮挡。先 component default，再验证 occluded surface 和 direct-lit control 的 acne。见 [directional units](../../packages/render/README.md#directional-shadow-quality-author--inspect--recover)。

generated Standard/Unlit caster 保留 authored culling（默认back），map 保留 light-facing entry depth。仅 exit-face depth 可把 touching solid 内 receiver/filter sample 错认 lit。double-sided/custom ShadowCaster state 原样保留；point-face winding 另修。contact-gap 变化跑 cube-plane-shadow-contact Browser/Dawn，同时验中心接触带、暴露 ground/top controls、双 render paths，不能只接受单黑 pixel/zero bias。

## 颜色光照 parity 交接

direct-light material 问题从 [parity entry](../../apps/parity/color-lighting/README.md)及 status map 入手。SceneCase/CaseReport 为报告契约，修具名 material/producer，重跑同 case；缺 producer capture 就记缺失，不算 material pass。

## 直接光 parity 入口

direct-light parity case 先读固定 revision [three-r184-finite-range-authority.json](../../apps/parity/color-lighting/cases/direct-light/calibration/three-r184-finite-range-authority.json)及 executable authority test。Three revision/source hash、固定 config、完整 expected sample 匹配才 ready；缺字段为 blocked，恢复证据。

| 字段 | 公开含义 |
|:--|:--|
| DirectionalLight.intensity | 一 world unit=一米时为 Lux。 |
| PointLight.intensity | Candela，正米制 range 或无 cutoff。 |
| PointLight.decay | finite nonnegative f32 distance exponent，默认2，0只留 range window，支持1.4等小数。 |
| SpotLight.intensity | Candela、米制 range、KHR cone mapping。 |
| color | Linear RGB，无 global compensation。 |
| cosInner/cosOuter | 从 imported cone radians 推导 snapshot。 |
| direction | extract-normalized world direction，双管线消费。 |

runtime range factor 是 Three r184 的 clamp(1-(d/c)^4,0,1)^2，KHR 未平方曲线仅作 import/reference falsification，不能用于 Forge runtime。exposure 在 lighting 后 camera tone/output，不乘 material/light intensity。point decay 经同 light slot 到 surface/capture/volume/ray reference，保留既有 near-light safety floor，不代表 full-distance Three parity。见 [Render](../../packages/render/README.md#direct-light-parity-contract)。诊断跑 authority/light-snapshot，查 normalized snapshot/buffer projection，比较独立 browser WebGPU/Dawn。保留 provenance、named captures、raw hash、analytic/ROI metrics、verdict，不用 custom mesh/fallback shader/app-local light profile 替缺路径。

## 可选物理特性

root/child 用 staticSwitches:{feature:true} 开 clearcoat/sheen/anisotropy/iridescence/diffuse transmission，cook/load 所选。省略即关闭，scalar weight 为 runtime data，显式启用零 weight 保留动画代码。glTF 从 extension 推导选择。

## 透射/折射

Materials.standard 使用 transmission/IOR/thickness/attenuation/named texture。smooth/rough refraction、edge fallback、transparent ordering 由 renderer 拥有；inspect().transmission 看 detached capability/resource/lifecycle。GLTF transmission 经 source-Pack-GUID producer 修复，含结构化 BLEND rejection。

16 sampled-texture 设备上 transmission 共享 metallicTexture/roughnessTexture/alphaTexture slot，有 split map 会禁 refraction 并报 MaterialSampledTextureBudgetExceededError（detail.conflicts 列 map）；移除或目标21纹理设备。渲染前用 materialSampledTextureBudget(world,assets,handle) 或 asset.material.preview.sampledTextureBudget 检查，见 Render Standard sampled-texture budget。

## 漫反射透射：叶片、纸、薄布

薄面背光用 diffuseTransmission 0..1、diffuseTransmissionColor，可选 factor texture（alpha linear）、color texture（RGB sRGB），符合 KHR_materials_diffuse_transmission。它为 opaque light passing through，非 refraction，不用 transmission、不改 depth write、不复制 backdrop。

factor 是分配而非额外项：反射(1-factor)*baseColor、透射factor*tint，白天空白叶两面仍为1。factor1 为无损磨砂 diffuser，不是玻璃，可看穿用 transmission；叶片约0.3–0.6。Unreal two-sided foliage 把 SubsurfaceColor 加到完整 diffuse，白炉约2倍；转换 S=max(1,|Base|+|Sub|)，factor=|Sub|/(|Base|+|Sub|)，baseColor=Base/(S*(1-factor))，tint=Sub/(S*factor)，|c|为最大 channel，匹配 Unreal path-traced balance，不含其 GGX back-scatter peak。

1. Materials.standard 声明值，renderState.cullMode:none 让背面 rasterize。
2. 绑 cooked Standard alias root：module ID 含 ::standard-、五 canonical user-region texture、diffuse-transmission parameter names。内置 forgeax::default-standard-pbr 无此 layer，仅值无效。
3. 仅 Forward，Deferred GBuffer 不含。当前 alias root 在 per-entity CPU lane，编译去 clustered/rect-area light，dense foliage 按此预算。
4. apps/hello/foliage-transmission 背光 falsifier：opaque control 暗、factor0 必须失败；white furnace factors0/0.5/1 匹配 opaque white，FALSIFY=additive 必须失败；RHI Debug browser smoke 查 pipeline module、bindings68/69。

glTF extension 经同字段导入，越界为 gltf-material-physical-invalid。

## Opaque Standard 表面扩散

Pack 中 Materials.standard({baseColor,subsurfaceRadius:[9,6,3],subsurfaceWeight:1})，cook/GUID load，经 MeshRenderer 绑定。radius 为 presentation pixel 的 linear RGB support，每项 finite[0,12]，weight finite[0,1]。Deferred profile 选 subsurfaceQuality high/low，renderer 按各 view internal extent 缩放。radius/weight 零走普通路径，无扩散 pass/new target。

该 lane 扩散 direct/已有 environment diffuse，保留 specular/emissive。需 compute/storage texture、float32 HDR filtering/blending、texture-formats-tier2 read-write storage、32KiB workgroup storage，缺能力明确失败。初始支持 opaque single-sample Standard rigid/instanced/skinned，每 view 最多16 active quantized RGB profiles。正 demand 搭 Forward/MSAA/blend/禁 depth-write/single-layer medium/Diffuse GI/cube-planar capture/ray-reference 均失败，不静默改材质。thin diffuse transmission 是局部背光，不是 surface diffusion。

诊断见 [Render](../../packages/render/README.md#subsurface-surface-diffusion)、RHI Debug。改 author value 前查 published value、第二 lighting-context lane、separated diffuse carrier、cs_subsurface bindings。实现验收 ROI25，API 文档不等于实测质量/性能/完整CI receipt。

## 投影与非 PBR 材质

| 需求 | 入口 |
|:--|:--|
| 无可用 UV 的 rock/terrain/kitbash | Materials.standard 的 triplanar:{space:'world'或'object',scale,sharpness}。 |
| baked object-space normal | normalTexture、normalMapSpace:'object'。 |
| 平面 relief/trim/grout/panel line | normalTexture、displacementTexture/Scale/Bias、displacementMode:'parallax'；geometry/shadow/bounds 不变。要 normalTexture，忽略 bumpTexture；无 independent metallicTexture，用 metallicRoughnessTexture；transmission 预算不足退 normal mapping，budget 中报告。 |
| mirror/polished floor | Pack-cooked planarReflection:true，Camera PlanarReflection 同平面；target 不设由 Renderer 按 resolutionScale 管理。 |
| blurred glossy/brushed floor | 同上，generateMipmaps:true，roughness*(levels-1)选 mip，不是淡出。 |
| wet ground/ripple puddle | custom Standard Surface planarReflection:true，frameTime 生 ripple normalWS、pixel roughness 控湿度；camera distortion 为米制法线扭曲半径。 |
| diffuse 无 highlight | Materials.lambert({baseColor,...}) |
| 无灯雕塑/preview | Materials.matcap({texture,sampler}) |
| 调试 normal | Materials.normal() |

object space 随 mesh，world space 固定世界。triplanar 拒 alpha mask/不能投影 slot，object normal 拒 bumpTexture，错误 material-authoring-contract-invalid、detail.parameter。object normal 要蓝通道，RG-only rg8unorm/bc5-rg-unorm/eac-rg11unorm/Basis RG 以 asset-invalid-value、normal-texture-lacks-blue 拒绝，RG 留 tangent space。二者不能进入 ray reference（ray-material-unsupported）。Matcap/Normal unlit，无灯/shadow receipt。证据/falsifier 在 apps/hello/material-projection、Render Projection 章节。

## 顺序无关透明

默认 back-to-front 排序，交叉/环形层用 Camera.transparency=TRANSPARENCY_WEIGHTED_BLENDED，entity order/mesh 不改，无 per-material opt-in。

仅当 straight over（src-alpha/one-minus-src-alpha）或 premultiplied over（one/one-minus-src-alpha）、depth write off、unskinned built-in Standard/Unlit fs_main 且无 outputs 时 draw accumulate。其他 transparent draw 留 composite 后 sorted pass。inspect().transparency.ineligible 给 blend-not-eligible、depth-write-enabled、program-without-oit-output，修 render state 或接受 sorted，不解析 message。coverage 精确、颜色为 depth-weighted average，不是重叠层精确 over-operator。见 [OIT](../../packages/render/README.md#order-independent-transparency)。

## 心智模型

结构化错误后修 source/cook，只有一个 material surface。MaterialAsset 拥有 passes/parameters/values/可选 parent，root 拥有 effective contract，child 仅覆盖值。texture value 为结构化数据：

```ts
{
  texture: textureGuid,
  sampler: samplerGuid,
  coordinates: {
    set: 1,
    transform: { offset: [0.1, 0.2], scale: [2, 2], rotation: 0.25 },
  },
}
```

坐标 set/transform 跟随具名 slot，glTF/Pack/runtime extract/PBR 同数据。render target/probe 消费 Renderer 公开 RenderTargetTextureSource，精确 dimension/mip view 绑 slot，不是 asset handle/app texture registry。3d/2d-array target 对应 texture_3d/texture_2d_array；采 target 的材质不进入该 target 自身 capture。probe 用 renderer-selected probe、roughness mip、local box projection、Skylight irradiance fallback。matching FrameReceipt.completed resolve 后读 pixels。

mesh Three VideoTexture 映射为 material texture（baseColor/emissive/texture_external root param）上的 VideoAsset，同 renderable 加 VideoPlayer playing/loop。asset add assets/clip.mp4 支持 mp4/m4v/webm/ogv，container 流式不 inline，或 runtime create kind:video/url。DOM realm 安装 graphics-extras installDomVideoSourceProvider(world)，创建 muted inline video、跟随 Player。默认 Engine Worker 已装 installWorkerVideoSourceProvider，page 拥有 video，每 consumer 一 frame in-flight，传 VideoFrame。Worker 不调 DOM installer（video-dom-unavailable）；provider.status 查 autoplay-blocked/load-failed，手势调用 resume。

caller GPUTexture/video 用 renderer.importTexture，source 绑 assets.update(materialHandle,{values:{slot:source}})。普通 slot 复制 video frame，零复制用 texture_external root param。更新 loaded handle 或 assets.copy 保留 admitted program contract，从 detached payload 新建不能转 cooked projection。按 external-texture-invalid/state-invalid 的 detail.reason 分支，见 [external textures](../../packages/render/README.md#external-textures)。

Standard PBR Forward/Deferred/IBL/clearcoat 始终按 screen-space normal spread 做 geometric specular AA、增宽 roughness，不通过抬 author roughness/custom shader 藏 curved low-roughness sparkle，见 Shader Standard lit contract。specular IBL 多散射补偿，均匀 sky 下白 metal 各 roughness 能量匹配 sky，无需增加 baseColor/intensity/emissive 弥补已不存在的 split-sum darkening。

## 创作、cook、load

```ts
const material: MaterialAsset = {
  kind: 'material',
  parent: parentGuid,
  values: { baseColor: [0.2, 0.55, 0.95, 1] },
};

assets.configurePackIndex('/pack-index.json');
const loaded = await assets.load(materialGuid, 'material');
if (!loaded.ok) {
  report(loaded.error.code, loaded.error.detail, loaded.error.hint);
  return;
}
const handle = loaded.value;
// Bind directly to MeshRenderer.materials; release the caller reference after binding.
```

mount Content 的项目可加载 EngineContent.materials.default（mip checker Standard）或 EngineContent.meshes.*，其 Default slot 已默认该 material。项目 child parent 指它覆盖值。custom module 在 root passes[].program.module，shader build 发 module，material cook 发 record/artifact，App 仅 catalog load/readiness。

## Points 与 Lines 路线

1. 确认 MeshAsset topology 为 point-list/line-list/line-strip。
2. 恰好一个 Points 或 Lines，size/width finite positive，sizeUnits/widthUnits 默认pixels或world；Points.shape square/circle/soft，Lines.cap 默认butt或round端点/join。Points color 流逐点 tint，uv1.x 缩放尺寸。
3. 选 Materials.unlit，renderState 控 blend/depth，base-color texture 覆盖各 point sprite，原样用，无替 shader/mesh。
4. Standard extract/prepare/record retained expansion。
5. 需 source/derived/binding/draw 证据时 inspect/RHI capture。

admission 原子，unsupported topology、invalid style、lane conflict、缺 unlit forward material 均 structured refusal。读 code/expected/hint/narrowed detail，不从 message 猜支持，不静默替 generic mesh。direct WebGPU probe 是 runtime evidence；clustered unlit、WebGL2 限制、RhiNull 结构分行，Null 不证明 pixel/hardware time。恢复 inspect、修 source/producer、rebuild/cold-cook、重试同 retained/prepared owner，不加 CLI/RPC/registry/cache/ledger。

## 内置 PBR slot

baseColor/metallicRoughness/normal/specularTint/emissive/occlusion 各坐标 record 含 offset/scale/rotation/set/physical extent。vertex 按请求 set，仅 primitive 套数不足时 clamp。

## 恢复清单

| 症状 | 检查 | 恢复 |
|:--|:--|:--|
| 黑 Standard | DirectionalLight/effective pass/render error | 补所需 light 或修 pass，再 draw。 |
| material-parent-not-found | missingParent/chain | 修 GUID，recook child。 |
| material-circular-inheritance | chain | 去重复 parent，recook。 |
| material-value-unknown | parameter | root 声明或移 value。 |
| material-value-type-mismatch | expectedType/actualType | 改值、recook。 |
| material-specialization-not-cooked | material/selection | cook、发布 record/artifact。 |
| material-specialization-stale-generation | dependencies | source 稳定后 recook。 |
| gltf-material-uv-set-missing | slot/available sets | 补 source UV、reimport。 |

恢复始终读取 code/expected/hint/typed detail，保留 Engine resource。

## 路由

- 形式/错误联合：[Types](../../packages/types/README.md)。
- cook record：[Pack](../../packages/pack/README.md)。
- module/reflection：[Shader](../../packages/shader/README.md)。
- runtime catalog：[Assets Runtime](../../packages/assets-runtime/README.md)。
- 迁移。

## Visibility 属于 Render 边界，不是材质字段

ECS 创作 Visibility，Render inspect effective state，MaterialAsset 不改：

```ts
import { Visibility, VisibilityStateValue, resolveVisibility } from '@forgeax/engine/render';

world.spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } }).unwrap();
const snapshot = resolveVisibility(world);
```

| 问题 | 权威 | 恢复 |
|:--|:--|:--|
| 为何隐藏 | Visibility intent+resolveVisibility | 查 source/hierarchy diagnostics。 |
| material 为何失败 | material/shader structured errors | 修 cooked contract，再 retry。 |
| count 为何异常 | inspect().visibilityStats | 查 renderer candidate path。 |

缺 material/mesh/camera/visibility 在 owner 修，不加 demo stand-in。camera/picking/lifecycle/assets/VFX shadow 不归 Visibility，也不属本技能。

## 自定义多输出

passes[].outputs 声明有序具名 color outputs，含 format/可选 blend/writeMask。WGSL location(n)选第n项，cook 验所选 fragment interface，普通 GUID load。通过 [public MRT](../../packages/render/README.md#public-material-mrt) 绑匹配 graph targets，RHI Debug 查所有 attachments，不只验 color。

## Color write 与共面 overlay

colorWriteMask RGBA bits1/2/4/8，默认15。mask0+depth write 为 invisible occluder，用现有 queue 放在受影响 opaque 前。depthBias signed32 constant units、depthBiasSlopeScale、可选 clamp 控 polygon offset，默认零无需 enable。常规 less-depth 下负 bias 拉近，overlay 通常关 depth write。多输出与每 output.writeMask 求交。

generated shadow pass 保留 offset/cull，自有 depth write，禁 color 不禁 shadow。derived temporal attachment 写全 scene-data channels。解释 deferred/MRT mask 前读 [pass table/regression](../../packages/render/README.md#material-color-writes-and-polygon-depth-offset)，查 pipeline/live/fresh-replay pixels，包含 zero-bias/write-off control。

## Unlit 与 morph lane 准入

opaque rigid Materials.unlit（queue低于Transparent、声明program）像Standard走GPU-driven color/shadow；skinned/blend/Transparent-Overlay/program-less走CPU并保 direct order。Mesh morphTargets+MorphWeights 经 renderer compute stream 在任意 material program 下 deform，拥有自己 batch，作者不加 morph variant/shader。真实 lane/reason 看 inspect().gpuDriven，不猜。

## 材质与点光默认行为

Standard roughness/emissiveIntensity/sheenRoughness 默认1，黑 emissive/sheen 仍关贡献，physical sheen 另要 static switch，显式零 intensity 保留零。emissive scene-linear 经 exposure/tone，ACES 下大面>约1.5趋白丢色，panel/window 用0.8–1.5，小 bloom source 才3–10。

glow beam/pillar 增光用 emission-only Surface：forgeax_material::surface_v1 的 surfaceEmissionOnly(input,color,opacity) 清 sun Fresnel glare/sky reflection，模板仍对 additive Surface lighting。color one/one、alpha zero/one（engine-render/authoring ADDITIVE_BLEND、UE BLEND_Additive）；Materials.unlit(color,{blendMode:'additive'}) 也关 depth write、用 Transparent、按 opacity 预乘。peak 低于 bloom threshold，renderState.fog:false 跳 scene fog（任意forward，deferred opaque仍雾），open tapered mesh 按高度衰 alpha。Surface 仅定义材质属性，无 sun/sky/camera；海用内置 single-layer-medium，见 Render Sea sun and sky。

Point/Spot 默认无 cutoff，多光场景显式 finite range 限 cluster/shading。无 cutoff 影响所有 camera cluster，光源在视锥外也如此。默认 Spot outer half-angle60°、inner0°，全 cone falloff，单改 outerConeDeg 可收窄。相等角为合法 hard cone，无论 shadow 开关，surface/volume 用 defined hard step。Spot shadow farPlane 仍独立 range。

## 捕获视面

RenderFeature.capture 默认 display-only，可 all 或 {faces:['planar'|'probe'|'cube']}，目前 planar、其余后续。GPU particle all，每 face 以 face resolution 增一次draw，可 createGpuParticleFeature({capture:'display-only'}) 退出，post 保持 display-only。见 VFX Render README。
