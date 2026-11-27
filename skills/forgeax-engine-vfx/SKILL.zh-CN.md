**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。代码、标识符和错误码保持原样。

# ForgeAX VFX

## 先选择实现路径

| 效果 | 路径 |
|:--|:--|
| 雨雪、火花、气泡、尘土或沙尘暴、火焰、烟雾、魔法光点；每个场数千个粒子以内，行为用游戏 TypeScript 编写 | 在 `point-list` 网格上使用 `Points` 精灵，每帧通过 `writeRange` 更新，见 particles-core。不需要着色器或 cook。 |
| 数万个粒子、GPU 场景碰撞、力场、条带、轨迹、光束、网格粒子、事件子发射器 | 使用下文的 cooked GPU VFX。 |

`Points` 支持世界尺寸（`sizeUnits: world`）或像素尺寸，正方形、圆形或 `soft` 径向光晕精灵，每点 `color`（含透明度衰减）和 `uv1.x` 尺寸流，以及覆盖每个精灵的材质纹理、材质混合和深度写入状态。这些能力覆盖 Three.js `Points`/`PointsMaterial` 的效果；不要用小网格池模拟粒子。当分析结果显示 CPU 循环或逐帧上传成为成本，或者行为需要 GPU 数据时，再切换到 GPU 路径。

## 标准渲染路径

VFX 在唯一的 `RenderScene -> Standard Pipeline -> DeviceScope -> FrameReceipt` 路径中生成封闭的 `RenderFeaturePlan`。宿主负责 `attach` 和 `draw`；诊断使用绑定到 receipt 的 `inspect`、`observe`、`recover`。VFX 不拥有 device、queue、encoder、finish 或 submit。

使用同一条路径：

1. 编写 schema-v3 发射器元数据：`program: { module }`、必需的固定包围盒、调度和渲染器 GUID。
2. 在 WGSL 中编写 `vfx_spawn` 和 `vfx_update`，通过 `#import` 导入 `forgeax_vfx::prelude` 及共享着色器模块。
3. 使用 `createParticleCodeNativeCooker(modules)` cook；以原子方式发布 payload，以及位于 `particle-effect/program.json` 的唯一 cooked GPU ABI `forgeax-vfx-program-5`。
4. 普通 DevKit 游戏已经为每个执行域安装一个 VFX 装配，直接使用。显式独立装配时，创建一个 `createVfxRuntimeHost({ camera })`，附加各个 `{ world, assets }`，并通过负责的 App/Renderer 装配注册 `host.feature`。SDK 游戏中不要再增加第二个宿主。
5. 用 `loadVfxGpuEffect` 按 GUID 加载，分配共享的 `ParticleEffectAsset` 引用，再生成 `ParticleEffectPlayer`。

作者 ABI 与生命周期见 [`packages/vfx/README.md`](../../packages/vfx/README.md)，反射和 cook 错误见 [`packages/vfx-compiler/README.md`](../../packages/vfx-compiler/README.md)，GPU/渲染所有权见 [`packages/vfx-render/README.md`](../../packages/vfx-render/README.md)。

一次性爆发（火花、命中闪光、敌人消散；Three.js 加法混合 `Points`/`Sprite`，Godot `GPUParticles3D.one_shot`）不需要额外 API：设置发射器 `schedule: { rate: 0, bursts: [{ time: 0, count }] }` 和 `blend: 'additive'` 的 billboard 渲染器，每次爆发生成一个 `ParticleEffectPlayer`（不同 `seed` 可产生变化），在最后一次调度出生及其粒子拖尾结束后销毁。复用效果保留其创作时的爆发时刻、循环和局部变换约定；资产名称不意味着只有短闪光。适配前检查时间线，游戏命中反馈仍须同步。经授权的源码或参数适配可以改变调度并重新 cook，但必须保留稳定身份和来源信息。完整文件见效果配方的配方 5。

Player 每个 World 帧只推进一次：`vfx-gpu-runtime` 的 Update 系统在 `FixedUpdate` 之后运行，以 `Time.delta * timeScale` 推进每个正在模拟的 Player，因此粒子按渲染帧率移动。使用 `TimePolicy.maxDeltaSeconds` 限制卡顿影响，不要为 VFX 另设时钟。每个 intent 记录 `delta`、`initialDelta` 和周期 `elapsed`；设备恢复在均匀步长上重放相同 dispatch 次数和周期时间。呈现退役必须使用与播放相同的帧时间和 `timeScale`；固定步工作被丢弃时，固定 tick 计数不能衡量 VFX 进度。

所有粒子拓扑通过共享的 `translucent_fog` 在自身深度应用雾：alpha 混合添加内散射，加法混合仅衰减。不需要效果侧雾项。

> [!IMPORTANT]
> 行为属于 WGSL 代码，不属于节点或算子图。不要增加 CPU 镜像、运行时编译、后端名称判断、直接 RHI 访问、粒子回读或演示侧渲染绕过方案。

按结构化错误码分支，使用 `detail` 和 `hint`。未知源码字段必须拒绝。Batch B 支持可执行的 billboard 高级字段，以及独立的 ribbon、trail、beam 拓扑；不增加 CPU 回退、运行时编译、原始作者 bindings、CPU 粒子镜像、游戏回读、图创作或 VFX RPC。

静态场景碰撞：导入 `forgeax_vfx::data::scene_sdf`，给 `createVfxRuntimeHost({ camera, sceneSdf: { read(world) } })` 提供固定 World 范围和明确预算。通过 Import 在普通 Mesh GUID 上 cook 几何场；采样可见性数据不能作为碰撞依据。Renderer 拥有保留的场景投影、共享、图生产及 fence 退役。受限响应、近似误差与结构化不可用结果遵循[宿主契约](../../packages/vfx-render/README.md#managed-scene-sdf-collision)。修改碰撞着色器前先用 RHI Debug 检查真实的生产者与消费者工作；单独重放成功不能证明碰撞质量。

编辑器或工具检查：用 `isVfxGpuEffectAsset` 缩窄 registry payload，再通过 `describeVfxGpuEffect` 投影。不可变描述符拥有发射器树、时间线、依赖及 executable/partial/unavailable 的真实能力状态，不暴露编译器对象或原始 WGSL 字节。

水驱动 GPU 粒子：声明 `waterGridEmission` 并导入 `forgeax_vfx::data::water_surface`。`scanCellCapacity` 限制检查的网格数量，`maximumEmissionPerCell` 和 `maxParticlesPerFrame` 限制网格追加路径；`maxParticlesPerFrame` 为零仍保留显式 schedule bursts。源码、WGSL 模块、材质、纹理应放在普通 Pack 中，参考 R8 [`coast.pack.ts`](../../apps/water/r8-integration-acceptance/assets/coast.pack.ts)。Render 绑定匹配且经过 generation 校验的 grid/solver-normal 对，拥有图和 fence 生命周期，见 [`water-surface` 契约](../../packages/vfx-render/README.md#water-surface-grid-emission)。

R8 半透明水球 billboard：使用 `shading: { kind: 'translucent-water-sphere' }`，并匹配当前四个 `materialInputs`：`subsurfaceGainOpacity`、`waterSphereShading`、`waterSphereFlattenSphere`、`waterSphereProjection`。噪声偏移 SphereMask 坐标；alpha 为 `Mask * 0.25 * ParticleAlpha`，法线细节共享 TexCoord4 噪声 UV。Engine UV 投影和稳定 id/seed 随机性属于适配，不保证与 Niagara 映射或序列一致。选中材质实例没有覆盖，继承 scale 1、strength 0.5。上述四个自定义通道的 `.x/.y/.z/.w` 编码共享随机偏移、padding、hardness 50 和 radius 0.5。UE 的 128x128 repeat 是 VF PseudoRandom 数学周期，不是伪随机纹理。见[完整作者契约](../../packages/vfx/README.md#water-grid-emission-and-translucent-sphere-billboards)；单有源码声明不能证明材质 cook 或运行时输出。

Engine Worker 请求 Feature 纹理回读时必须显式配置 `featureTextureReadbackBudgetBytes`；非空回读清单缺少总量上限会在预检失败。这一预算不限制 VFX 出生数量。

风、吸引力、涡旋运动：声明发射器 `forceFields`，导入 `forgeax_vfx::data::force_fields`，在创作的积分前调用 `vfx_apply_force_fields`。构建期使用 `@forgeax/engine/vfx-compiler` 的 `createVfxVectorFieldTexture` 生成保存的 constant/radial/vortex 纹理，发布普通纹理 GUID，并加载效果 GUID。变换、单位、采样、限制见[场契约](../../packages/vfx/README.md#managed-force-fields)。通过结构化 plan cause 和普通资产生产者诊断场失败。运行 `smoke:fields` 执行有界的独立轨迹/捕获探测；对准备好的 DEV/build 服务运行 `scripts/smoke-fields-browser.mjs` 验证传输和配对像素，使用维护中的各 owner GPU lease 入口。

用 `host.inspect(world)` 检查运行时。聚合以 host generation、player handle、asset GUID、emitter ID 为键；不要压缩成一个 latest intent，也不要把执行域局部句柄当作跨 World 身份。通过负责的 generation/LKG 路径恢复。资产变更运行 `node scripts/asset-cook-contract.mjs`；包内 scripts 路径无效。同 generation 的实时预览控制通过 `host.acquireControl(world)` 获取，使用类型化的 `patchPlayerParameters` 或 `submitChannel`。generation 和结构化错误是证据边界，不能越过 `VFX_GPU_RUNTIME_RESOURCE_KEY` 直接改实例。

验证命令：

```sh
pnpm --filter @forgeax/hello-boss-lightning smoke:browser
pnpm --filter @forgeax/hello-boss-lightning smoke
pnpm --filter @forgeax/hello-boss-lightning smoke:falsify
node apps/hello/boss-lightning/scripts/smoke-public-only.mjs
pnpm metrics:check
pnpm metrics:run
```

Browser 与 Dawn 都必须通过：Null 结构成功不能证明 compute 验证、拓扑绘制或像素。视觉证据为 `advanced-renderers-visible`、`live-patch-continuity`、`event-sub-emitter-visible`、`hmr-last-known-good-visible`，每项包含 PNG 和证伪结果。Program v3 自定义 billboard 排序仅在源码声明一个类型化 `VfxCustom` 排序字段时可执行；编译器和托管 GPU pass 拒绝歧义，不会静默退回发射器顺序。

## 时间、参数与带纹理的自定义 billboard

- 时间：`ctx.time` 为 Player 已运行时间，遵守 `timeScale`/暂停；`ctx.time_whole` + `ctx.time_fract` 提供精确拆分；`ctx.world_time*` 为世界时钟，另有 `ctx.delta`。循环使用 `vfx_loop_phase(ctx.time_whole, ctx.time_fract, rate, offset)`；永久粒子使用 `lifetime = vfx_forever()`。不要只爆发一次后设 `lifetime = 1e9` 并从 `particle.age` 推导生命进度：f32 age 长时间运行会失去精度。
- 参数：在效果源码声明 `parameters: { name: { type: 'vec4<f32>', default: [...] } }`，任何发射器通过 `vfx_parameters().name` 读取；每个 Player 使用 `parameters: vfxPlayerParameters({ name: [...] })` 覆盖（JSON 字符串字段，也适用于 scene 和 pack）。同一效果可用于多个位置，不要通过 `Player.seed` 偷传位置或缩放。错误为 `vfx-parameters-invalid`；`validateVfxPlayerParameters(json, fields)` 可离线检查，`fields` 是声明的 `{ name, type }[]`。参数类型接受 `vec4<f32>` 或 `vec4`，最多 32 个。诊断读取 `world.getResource(VFX_GPU_RUNTIME_RESOURCE_KEY).diagnostics()`；辅助函数包括 `vfx_loop_phase` 和 `vfx_loop_angle`（弧度）。
- `loadVfxGpuEffect(assets, guid)` 接受 GUID 字符串或 `AssetGuid`。

带纹理的自定义 `particle-billboard` 材质（烟雾精灵）需要三个文件：

1. `smoke.wgsl`：声明 `#define_import_path game::smoke`，导入 `forgeax_view::common::{View, view}`、`forgeax_view::fog::{translucent_fog, ndc_world}`、`forgeax_material::parameters::{material, smokeTexture, smokeTexture_sampler}`；`vs_main`/`fs_main` 读取粒子顶点输入 `position`、`right`、`up`、`color`。
2. `smoke.wgsl.meta.json`：importer 为 `shader`，`importSettings.materialShaderIdentifier` 为 `game::smoke`，`paramSchema` 包含 `{ "name": "smokeTexture", "type": "texture" }`。
3. Pack 中 kind 为 `material`，pass 为 `name: "particle-billboard"`；`program: { module: "game::smoke", vertexEntry: "vs_main", fragmentEntry: "fs_main", bindings: "render-material" }`；`renderState` 设置 `cullMode: "none"`、`depthWriteEnabled: false`、预乘混合（`one` / `one-minus-src-alpha`）；设置 `parameters: [{ name: "baseColor", type: "color" }, { name: "smokeTexture", type: "texture" }]` 和 `values: { baseColor: [1,1,1,1], smokeTexture: "<texture guid>" }`，纹理 GUID 也列入资产 `refs`。

材质参数类型为 `bool`、`f32`、`i32`、`u32`、`vec2`、`vec3`、`vec4`、`color`、`texture`、`texture_2d_array`、`texture_3d`、`texture_cube`、`texture_external`。类型拼写是 `texture`，不是 `texture2d`；纹理值是裸 GUID 字符串或纹理描述对象；向量和颜色为数字数组。`material-value-type-mismatch` 的 hint 列出这些形式。

## 捕获视面

哪些 Feature 录入捕获视面（目前为平面镜；probe/cube 后续支持）由每个 Feature 的 `RenderFeature.capture` 指定：`'display-only'`（默认）、`'all'`，或 `{ faces: ['planar' | 'probe' | 'cube'] }`。GPU 粒子声明 `'all'`，会在每个录制视面再绘制一次，成本为每个视面按其分辨率增加一次粒子 draw。可通过 `createGpuParticleFeature({ capture: 'display-only' })` 退出。后处理保持 display-only。见 `packages/vfx-render/README.md`。
