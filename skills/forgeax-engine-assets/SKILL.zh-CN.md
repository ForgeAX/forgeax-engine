**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。

# forgeax-engine-assets

## Engine Content 纹理

程序化纹理使用普通 ScriptablePack 返回 TextureAsset，参考 Content checker texture。固定 seed/source parameters 拥有 pixels，标准 Pack producer 拥有 cook、content identity、cache、publication，Water texture 同路。Pack source/imported source module 经普通 Content source closure 发布。

修改 texture field 保留声明 GUID/dimension/color space/mip policy/sampler contract，经普通 Pack cook 审阅外观与 decoded pixel 变化。不能引入 Water 专用 prebuild generator、raw-image staging、SDK resource whitelist、fallback loader。见 [Content](../../packages/content/README.md)。

## River Bake 发布

prepareWaterRiverBake 从 completed current GPU capture 派生普通 Pack recipe/texture。当前 Body generation 的 query grid 解码发布前，先 admit/replace 并持久化完整 Runtime Pack publication。stable sourceKey/GUID、content identity、失败替换保留、cold-reload recovery 留现有 asset owner。见 [Water](../../packages/water/README.md#advanced-simulation-entry)。

## 程序化内容

有限同 kind startup roster 用 assets.loadMany(guids,kind,{signal})，保留串行 admission，但操作内共享 Pack verification；read scope 在成功/失败/cancel 结束。每返回 handle grant 都归调用者，重复条目也分别持有。独立读继续 load。长 cached roster 可用 await 的 onProgress(completed,total) 作有界 host task yield，在 publication/cancel message 推进期间保持 read scope。不能为反复解析一 Pack 加全局 document cache 或提高 decode concurrency。

按内容何时已知选择 owner，而非如何计算：

| 已知时点 | Owner | 引用 | 变化 |
|:--|:--|:--|:--|
| build time：prop/level mesh/material/seed variant | .pack.ts build 调 geometry factory，parameters 如 seed 选变体 | AssetGuid.derive(packageId,sourceKey)，assets.load(guid,kind) | 编辑 source/parameter values，由 producer recook/cache。 |
| play time：debris/growth/deforming water | plugin 内 assets.create(meshAsset)，无 Pack/GUID/saved file | 返回 handle，ECS 绑定取得自身引用后释放调用者引用 | 每帧 writeRange 保持 vertex/index count；replace 改 topology。 |

- Pack build 是 source/values 的纯函数。用 @forgeax/engine/math 的 rng.create(seed)，不用 Math.random/Date.now；runtime generation 也取 gameplay seed 使游玩测试可重现。
- 自定义 geometry 用 createMeshBuilder，派生 packed layout/bounds、补齐缺省 triangle surface channels。factory/meshFromInterleaved 也提供 stock material 要求的 vec4 tangent，见 [MeshBuilder](../../packages/geometry/README.md#meshbuilder)。
- 创作输入携带完整匹配 channels；runtime admission/decoding 仅保留 attributeStorage:'interleaved' 的 vertices 和空 typed layout declarations。零复制 CPU 读用 meshAttributeWindow，count 从窗口或 canonical stride 得。copyMeshAttribute/未缓存 meshAttributeChannels 是显式临时转换，非 retained mirror。验证好的 packed rows 可用 interleavedMesh 或构造 marked form，不能 unpack 后又丢 channels。validation/mixed integer skin lanes 见 Geometry README。
- 紧凑 Standard terrain 用 packMeshTangentFrame32(validatedMesh) 把 normal/tangent 替为 uint32，保留 UV bits，raster 直接读 packed rows。meshAttributeWindow(mesh,'tangentFrame') 暴露物理 word；copyMeshAttribute(mesh,'normal'|'tangent') 显式临时解码。版本格式/custom-entry 要求见 Geometry README。
- runtime mesh 可用 Pack material，material values 编辑不移动顶点。
- runtime GPU texture 从 pack/source 用 gpuTextureOutputs(packageId,name,recipe) 声明 texture-generator 和独立 gpu-texture（GpuTextureAsset）。build 准备 programs，Renderer 生成 pixels/mips。Runtime Pack 复用 prepared programs，不 cook raw WGSL、不隐式回读 pixels。两种 kind 都可在 View 原生 texture preview 打开。见 [Pack](../../packages/pack/README.md#runtime-gpu-texture-declarations)。
- 增量 vertex batch 共用全局 index space，遵循 MeshBuilder append contract，不能假设隐式 index rebasing。
- 完整配方见程序化道具与 runtime mesh。

获准把复制 author source 适配到不同 SDK 时，保留不可变原件，在 active asset root 外工作。更新真实 dependency/API，用包管理器重建 lock，对目标 SDK compile/cook，再导出导入验证过的 source closure/identity/provenance。locked-version 拒绝不证明无法适配，只改版本标签或 clone GUID 不算迁移。

## 收集的 pipeline recipe

version1 recipe 经 build root pipelineLibrary/backgroundPipelineLibrary 输入。DevKit cook 时拥有 compute entry projection、精确 content dedup（含已投影输入），保留首次顺序、重排 dependency index、原 source alias。startup overlap 仅从 background 移除，同时移除剩余 recipe/alias 不用的 startup-owned deps 并重写 index，无关 unused row 保留。不能加 game-side identity/cache owner，不能按 label 丢不同 state variant。这是机器无关准备，最终 native compilation 仍归 target device。见[收集契约](../../packages/devkit/README.md#collect-and-prepare-gameplay-pipelines)。

## View Pack 参数

View 参数请求编辑所选 Pack parameters array。从 Inspector → Expose 开始，取得 project、exact target、source、reflected type、current value、resolved apply path。无选字段时 Pack panel 的 Add parameter with Agent 提供 source context。forgeax project engine status --root <project> --json 解析选定 Engine，用该安装；另一 CLI schema 可能不同。支持情况以当前实现/命令结果为准，设计提案或可见控件不证明支持。

| 效果 | 声明 | 应用 |
|:--|:--|:--|
| 改 generated geometry/image/topology | name/type/default，build 读 context.values | Generate。 |
| 调 owner 允许的已有 field | 同 descriptor 加 apply:{asset,path} | 立即应用，Save 持久化。 |

Sun intensity 在现有 array 增加：

```ts
{ name: 'sunIntensity', type: 'f32', default: 3.2,
  apply: { asset: 'scene/showcase', path: ['entities', 'sun', 'components', 'DirectionalLight', 'intensity'] } }
```

把原 authored intensity 移入 default，删除原 leaf assignment，保留 DirectionalLight 容器与无关代码。minimum/maximum 可设数值边界。descriptor 保持 literal；packageId 可为 literal UUID、definePackageId('…')、file-local const alias。imported/computed identity 可 build，但 View 保存 default 前要静态可读身份。

编辑前后用 forgeax asset inspect assets/scene.pack.ts --parameters-only --json，项目外加 --root。返回 generation/runtime mode、type/default/bounds/binding、1-based source location，只读当前文件，不 import、不扫 sibling、不 generate/cook。它不证明 generated target 存在、domain 可写或 preview 应用；普通 asset inspect inventory/JSON 不变。

View 自动发现外部声明变化。在同 preview 验 live edit，Save 前 source bytes 不变，Save 后 reopen。generation input 变则 Generate。新 generation-dependent 行为走既有 producer，普通 parameter 无需字段专属 View control/component/runtime handler。保留未保存 source/draft。

## Runtime 身份与内容

使用 App/Engine assets owner。create/load 返回调用者 AssetHandle，直接绑 ECS asset(kind) field。独立 World 用 new World({assets})。assets.read 返回 detached content，视为 immutable，修改经 update/replace/writeRange，revision 交 runtime。绑定成功后 release 调用者引用，ECS 自持。

内置 kind 用 mesh/material/scene literal，自定义 decoder/load 共享 defineAssetKind<P>('kind') token；runtime write 还要同步 prepare。重复 load 保留同 live identity/gameplay edits。source/sourceOf 看 adopted provenance；显式 reload(handle,{conflict:'reject'|'overwrite'}) 采用新 source closure，Catalog 改变不自动覆盖 runtime content。见 [runtime contract](../../packages/assets-runtime/README.md#runtime-content)。

游玩中 debris、逐波船、重 seed 城镇无需 Pack：inject assets 的 plugin 对 geometry/Materials output 调 create，generator effect yield release/despawn。编辑已有 handle，不逐帧创建。static switches/identity/Worker publication/tangent 见[游玩中生成内容](../../packages/assets-runtime/README.md#content-created-during-play)。

## Engine Content 库

同 mount 经 EngineContent.water 发布普通 Water root/child material family 与 texture source。Body slot GUID 由 waterMaterialFamilySlots 提供，Zone far material 为 Zone dependency，不复制为 Body state。见 [Water material](../../packages/water/README.md#material-family)。Pack/helper source 按 Content Apache-2.0 分发。

local fluid recipe 同普通闭包，impulseNoiseGuid 是必需 texture ref，含冷 Pack/Catalog 加载。默认用 EngineContent.water.textures['impulse-noise']。普通 Pack 生 seeded grayscale、gamma/brightness、完整 packed mip chain TextureAsset，Content test 覆盖 pixel hash/mip contract。见 [GUID](../../packages/content/README.md#guids)。

基础 cube/sphere/cylinder/cone/torus/capsule/plane/quad/nine-slice-quad/triangle、mip checker texture/sampler、默认 Standard material 都是 @forgeax/engine-content 普通 Pack。两 SDK 模板通过 forge.json assetLibraries:["@forgeax/engine/content"] mount，asset list 显示 @forgeax/engine/content/<file>.pack.ts。从 @forgeax/engine/content 导入 EngineContent GUID，像项目资产加载。删 mount 就没有这些资产；库 source 只读，需编辑先复制到 asset root。unresolved 用 project-asset-library-unresolved（install/bind Engine、修 specifier），invalid 表示包无 forgeax.library.assetRoot。代码 createPrimitiveMesh(kind)+assets.create 仍为未注册 runtime mesh。见 Content 契约。

## 体积云资产

VolumetricCloudLayer 使用加载的 cloud-material、可选 cloud-material-instance。ScriptablePack 各 cloud output 返回 execution:'cooked' 和 authored source，普通 DevKit dev/build 注册 producers、提供 compiler/renderer modules。program model WGSL 与 Pack 相邻，编辑触发 recook。project check dry-cook authored JSON cloud rows，ScriptablePack 保留正常 build validation。起点为[可复制 cloud Pack/WGSL](../forgeax-engine-render-pipeline/SKILL.zh-CN.md#volumetric-clouds)。uniform samples/program parameters/instances/runtime bounds 见 [cloud contract](../../packages/render/README.md#volumetric-cloud-authoring-and-transport)。

## 光照资产路线

1. 通过已有 render ECS schema 创作 RectAreaLight/LightProbe。
2. SpotLight.iesProfile 绑 build-time cooked IesProfileAsset；SpotLight.cookie/RectAreaLight.sourceTexture 绑普通 TextureAsset。每 handle 一个共享 light-texture slice；未压缩 source CPU 投影，BC/ETC2/ASTC KTX2 在启用匹配压缩 feature 时从 level0 GPU 重采样；rollDeg 仅方向。
3. inspect 读 subject/execution/lifecycle/lastKnownGood/sourceKey，再 owner rebuild/cold-cook。

IES 无 runtime source parser，cookie 用已有 registry。Catalog 为投影、DDC 为 cache evidence、Pack/Meta 为 author authority；无 accepted/verified 不能称 ready。

build/live dev Meta 启动慢，开启 FORGEAX_WORKSPACE_TIMING=1，查 owner log 的 forgeax.pack-ddc.timing。改 cache policy 前从 adapter 追 shared source-package production。Meta publication 用 DdcEntryInput 从 staging capture 推导 receipt digest；DDC lifecycle 在普通 lease/head fence 前验证 staged publication。不能传 unchecked readback token 或跳 artifact closure。两路径同 [Pack product DDC](../../packages/import/README.md)。

未变 live Meta publication 用 readImportPublication，按 restored Catalog revision 服务返回的 Pack/artifact bytes，为精确 restored bodies 准备 HTTP compression。完整 artifact/output-digest 一致及 DDC head fence 必需，product hit 不够。miss/corrupt/change/active writer 走普通 publication，不能用 rollback restoreImportPublication 作 warm read。

live resource transport 每 HTTP request 一个 fresh source fence，dispatch 前复查 scope identity/generation/session state/authority。只复用该 request 已完成 fence，不跨请求共享、不弱化 integrity。scope degraded 时 accepted-byte recovery 与新 production 分开。Catalog 投影保留每 producer 对该 response/canonical source path 的共享 publication envelope，逐 row copy 会令 wire validation/JSON 重复整个 closure。current/LKG locator 保持 scoped，receipt/failure fields 完整；新 projection/binding 自建 scoped envelope。

> [!IMPORTANT]
> MaterialAsset 只有同一 Catalog 路线：authored passes/values -> cook record/artifact -> load(guid,'material') -> runtime handle。parent/texture refs/module ID/各 slot coordinates 同一 package graph。恢复先修 producer/cook，再 retry load 或显式 reload 已有 handle。

## M5 资产权威索引

先读 [asset-authority schema](../../schemas/asset-authority.schema.json)和 [audit gate](../../scripts/forgeax/check-asset-authority-audit.mjs)。Pack 或 external source+Meta 为 author authority；Import/native cook 产 verified output；DDC 可丢 cache、Catalog 投影、runtime 仅读验证投影；Editor 写经 asset-authoring gateway。

每类先 inspect subject/execution/lifecycle/lastKnownGood/sourceKey 再选恢复。AI 路径 inspect -> rebuild/cold-cook；preview-LKG 只读，override/promote/stop-publish 是显式 gateway/publication 操作。身份从字段取，不从后缀/path/cache hit/message 猜。

重复 Meta import 在提新 cache 前看 sealed producer identity/已有 Pack DDC。遵循 [Import cache boundary](../../packages/import/README.md)：verified hit 跳 import/native Cook，source/sibling bytes/Meta settings/producer identity 变必须 miss。cold/warm regression 保留 importer/Cooker call count，cache restore 后验证当前 publication。

### 透射/折射

GLTF parse、Pack cook、GUID catalog、runtime inspection 全程保留相同 Standard values。sourceKey 是 producer identity，不是 file path。输出 stale/invalid 通过 rebuild producer/cold-cook 同 GUID 修复。

### 心智模型

恢复由 producer 拥有：验证 MaterialAsset、cook specialization、发布 record/artifact、按 GUID load。Catalog row/DDC evidence 不替 author authority。

### 显示名投影

Catalog build 用 deriveAssetName，经 catalogEntry(guid)/enumeration 读 CatalogEntry.name。producer storedName 为 authored entry 权威，不随 package 单/多成员改变。无 storedName 时 packaged asset 用 package basename，无 package 为空字符串。投影在 Pack owner，Editor/其他 consumer 调用，不重复 cardinality 规则。

### Catalog source 与证据

CatalogSource 是 runtime navigation 边界，发 added/changed/removed CatalogDelta，不证明 payload cooked/current。先 register、subscribeCatalog，再 enumerateCatalog，避免 initial snapshot/live subscription 之间漏更新。snapshot/delta 按 GUID 合并，随 host dispose subscription。

```ts
const stop = assets.subscribeCatalog((delta) => mergeRowsByGuid(delta));
const snapshot = await assets.enumerateCatalog();
if (snapshot.ok) mergeRowsByGuid(snapshot.value);
```

Vite import/HMR 后 reloadAssetHost() 刷 source，static build 同样导航 Pack v2 rows。未配置 source 保留结构化失败，不编 fallback row。Vite 边界一个 producer/一个 Catalog projection：pluginPack 发 scoped dev/build result，createCatalogHotSubscription 订阅 dev delta，enumerateCatalog() 读取初始快照。runtimeBinding 带 active scope/generation，旧 host late publication 被拒。sourceKey 为语义 source identity，不是 URL/filename/GUID fallback。

AssetEvidence 只读连接 source declaration、Catalog packageUrl/cookReceiptUrl、producer receipt freshness、Pack verification。用 lookup/verify --guid --project --catalog --json 或 injected inspection 区分 notCooked、ready/current、ready/stale、unknown；unknown 不通过。notCooked/stale 修 producer/recook 后重跑。单 catalog locator 不能把缺失/失败证据升 ready。

## 按 producer 恢复

image/cubemap/glTF/font/material/native cooked asset 同五步：

1. Inspect source+Meta、Catalog、DDC lifecycle、receipt、artifact verification，以数据读 code/detail/expected/hint。
2. Repair 具名 importer/native cooker/source/Meta，source package+Meta 为 author authority，producer 拥有 output。
3. 经 producer rebuild/cold-cook；删无效 DDC 只能作为其 recovery，generated Pack product 保留 producer 发出形式。
4. Verify GUID closure、receipt freshness、DDC integrity、Pack artifacts、Catalog lifecycle。
5. 验后 retry 同 GUID。LKG 只读 preview，unknown 不通过。

readiness 属于 Host。before-consume 在 load 前注册全部 importer/cooker；on-demand 要 producer route/明确 dev transport。runtime 不 import source、不写 DDC、不解析 log、不用 custom mesh/material 替缺 Engine asset。

## ScriptablePack 创作路线

交付验收用 [Scriptable Pack 审阅](../forgeax-scriptable-pack-review/SKILL.zh-CN.md)，区分 fixed/public generator，检查 provenance/closure/正式消费/参数/runtime recovery。

两种创作实体分清：ScriptablePack 是可执行 *.pack.ts，从 pack/source 导入 definePack，一个 stable packageId，可选非空 parameters，build(context) 返回完整 sourceKey->Asset map。Pack 为 editable *.pack.json，direct 保存 assets[sourceKey]，instance 保存自己的 packageId/parent/sparse values。source 不声明 per-output GUID/externalAssets，build 边界从 (packageId,sourceKey) 推导 GUID。build-time instance 由 source producer 解析 parent chain。runtime 仅读验证 Pack v2，load(guid,kind)；可选 runtime generation 归已有 Import producer，在 asset loading/ECS frame 外。

| 动作 | 命令/owner |
|:--|:--|
| 检查 identity/topology | forgeax asset inspect <source.pack.ts> --json |
| 读外部内容 | build 内 context.readByGuid(guid) |
| 序列化/cook output kind | 已注册 AssetOutputProducerRegistry producer |
| 重建 | Vite/CLI producer lifecycle |
| runtime load | 已有 Catalog+assets.load，content 用 assets.read(handle) |
| 启动后 admit/generate | App runtimePacks/Import RuntimePackProducer，见 [runtime contract](../../packages/import/README.md#runtime-pack-production-and-durable-content) |
| 准备 JS/TS | preparePackProgram 解析封存 JS，不执行/转换；devkit/plugin-build prepareRuntimePackProgram 转 TS 保留 source |
| 保留继承 | resolvePackParameterInheritance 后 prepareRuntimePackAnchor，effective values 转 default，instance 同 anchor+稀疏值 |
| 保存恢复 | Host 存 snapshot()/版本化 exportSource()，restore() 在新 scope 重新准入 fixed content |

> [!IMPORTANT]
> build 纯函数：不创建 GUID、不写 source、不发布 package、不改 live World。缺/多 output key、undeclared read/ref GUID、unused external declaration、kind mismatch 是结构化失败；修 source contract、同身份重建。

> [!NOTE]
> filesystem gateway 的 asset.inspect(source path) 返回 identity/revision。加 sourceKey 检 direct .pack.json output authored payload，展示前把返回 GUID 对 Catalog GUID。instance 返回该 output 继承 effectiveValues。ScriptablePack source inspection 不执行 build 派生 payload。

runtime generator 声明所有 runtime.dependencies（含非默认分支）。admission 不执行，保留 verified JS/fixed deps。清 cache 前存原 Pack/program/instance closure；DDC 不是 save store。recovery 可 replay generator，不安装 Fiber。View 同 Engine operation，source 写仍经 gateway。Browser static archive delivery 与 runtime-authored recovery 分别 qualify。

material producer cache 还要 Naga/WASM owner 已验证 executing compiler fingerprint，单 JS/WGSL bytes 不够，缺/无效 Native provenance 不复用旧 product。generated material/mesh 在 Vite host 注册 import 的 materialAssetOutputProducer/meshAssetOutputProducer。自包含 build 可省 assetSource；reader.readByGuid 前提供 host snapshot source。

外部 Pack 和 Meta 依赖由构建宿主将当前 inventory declarations、native cookers 和可用 GUID 传给 `@forgeax/engine-import` 的 `createDeclaredPackAssetSnapshotSource`。

## MaterialAsset Catalog 恢复

root/derived 都用 configurePackIndex('/pack-index.json')、load(guid,'material')。成功 handle content 有 resolved passes/values/coordinates、完整 refs、cooked artifact/receipt，parent inheritance 在 admission 展平。失败按 code/detail/hint 修 producer/cook，再 retry。不能用 custom mesh/app-local shader artifact 替缺 Engine resource。

## 契约路由

player packaging 把完整 WGSL programs 分组到有界 Zstd stream，不删 backend/capability variants。byteRange 定位组，可选 decodedRange 在解压后定位原 bytes；单项 length/hash 仍权威。普通 build/package/load/verify 保留 program identity/source bytes。

| 任务 | 参考 |
|:--|:--|
| Catalog subscribe/ref/package identity/compression | catalog-and-import |
| custom importer/sidecar/source resolution/decode | custom importer |
| Mesh UV/recovery | runtime-and-mesh |
| LOD lightmap UV/baked identity/stale | [Import UV](../../packages/import/README.md#lightmap-uv-validation)、[Render bake](../../packages/render/README.md#baked-lighting-identity-and-staleness) |
| runtime load/VFX/handle/video/nested scene | runtime API |
| scene writeback/new kind/custom loader/evidence | scene/custom kinds |

## Plugin 资产

从 feature Pack 开始，小行为用 .pack.ts named Plugin exports，大实现用普通 TS module。读 [Plugin](../../packages/plugin/README.md)，通过 CLI help 发现 asset plugin create/inspect、project root set。Pack 拥有 configuration，project roots 选 execution，读 definition 不激活。新 runtime plugin 同 module/config lowering 和 startPluginAsset native Fiber。inline toolContract 用既有声明，须提供 executor closure。完整 fixed publication 保留所有 siblings 和各 build target program/tool attachments；每 Context 只安装本 target qualified definitions，空 tool contract 仍记 installation eligibility。完整 capture 每 plugin sibling 至少一个 prepared target。restore 可把 foreign definition 暴露为 metadata，但不在当前 target tools map 中不可 mount。

### Runtime Pack 验证

在自己拥有的 Xvfb display 下跑 pnpm --filter @forgeax/engine-devkit test:runtime-browser，实测 Worker JS/TS × dev/build；同 gate 属 test:browser/Actions shard1。完整 hello/learn 60帧 smoke/Dawn roster 不变，Node producer test 不证明 browser module delivery/native plugin execution。

## 缓存资产缩略图

engine.assets.thumbnails 使用当前 project ID、最多32 GUID。订 workspace thumbnailEpoch 获取 queued/cooking/ready 渐进状态。Engine queue 复用普通 resource/SceneAsset preview、一个 retained renderer，不加 View loader/renderer/cache。透明 PNG 为可丢 DDC output，source publication deps、Preview preset、producer bytes 决定失效。retry owner 前读失败行结构化 error。见 [thumbnail contract](../../packages/devkit/README.md#progressive-asset-thumbnails)。

compiler filesystem analysis 要 imports 时，使用捕获 source snapshot 的 imports(path,{includeTypeOnly:true}) fact。inventory 拥有 runtime import filtering，compiler policy 保留 conservative raw-import 解释。publication 始终验证当前 bytes/resolution。
