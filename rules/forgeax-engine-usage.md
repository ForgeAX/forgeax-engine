# forgeax-engine 使用手册：路由层

## MaterialAsset route

Material authoring with `passes`, `values`, `parent`, and `coordinates`, plus
cook, catalog loading, and structured recovery share one
entry point. Route material work through the material and shader skills before
adding a new package surface.

> 你是 forgeax 引擎的**主用户**（AGENTS.md §Core rule）。本 rule 是**常驻路由**——按任务名挑一个 `forgeax-engine-*` skill load 其正文；它**不教 API**，API 教学在各 skill 正文。

> [!IMPORTANT]
> **不要预先 load 全 15 个 skill。** 上下文有限。任务来时按下表选 1 个 load；自然跨域才 load 第 2 个。skill 名字+description 已常驻。

## 任务 → skill 索引

| 任务 | skill |
|:--|:--|
| 复杂或原因不明的渲染问题：黑屏/缺物体、光照/阴影、闪烁、后处理、浏览器/后端分歧 | **先读 `forgeax-engine-rhi-debug`**：真实失败帧 → work/binding/resource/像素证据 → owning subsystem；再按证据加载领域 skill |
| WeChat Mini Game / official AI DevTools / simulator / login QR / native host | `forgeax-engine-wechat` |
| Profile CPU/GPU costs, optimize preparation/material/shadow work, compare fixed workloads or contribute reusable performance tools | `forgeax-engine-performance` |
| 引导 app / 跑游戏循环 / 读输入快照 | `forgeax-engine-app` |
| 定义组件 / 写查询与系统 / 关系 / 反射 | `forgeax-engine-ecs` |
| `NetSession` / replication / protocol-v2 / reconnect / resync / ACK / `SessionId` vs `PeerId` | `@forgeax/engine-net`（见 `packages/net/README.md`） |
| WebSocket endpoint / browser 或 Node connector / binary frame | `@forgeax/engine-net-websocket`（见 `packages/net-websocket/README.md`） |
| multiplayer Snake consumer / reconnect browser journey / visual falsifier evidence | `forgeax-visual` + `apps/multiplayer-snake/README.md` |
| 场景身份 / hierarchy / Transform propagation / `scenePlugin` | `@forgeax/engine-scene`（见 `packages/scene/README.md`） |
| Skin / joint binding / skeletal errors | `@forgeax/engine-skinning`（见 `packages/skinning/README.md`） |
| Animation graph / player / property tracks / IK / skeletal retargeting | `@forgeax/engine-animation`（见 `packages/animation/README.md`） |
| Spring bone secondary motion / authored physical rig / partial skeletal blend | `forgeax-engine-physics` → `packages/animation/README.md` Managed skeletal motion; use fixed animation and ordinary saved Pack configuration |
| Render vocabulary / frame stages / Renderer construction | `@forgeax/engine/render` + `forgeax-engine-app`（物理 owner 为 `packages/render/`，见 `packages/render/README.md`） |
| 让东西可见：MeshFilter + MeshRenderer + Material + 灯光（含 `forgeax::sprite-lit` per-light forward） | `forgeax-engine-material` |
| 写自定义 WGSL + cooked MaterialAsset module | `forgeax-engine-shader` |
| 加 pass / 后处理 / tonemap / bloom / fxaa / skybox | `forgeax-engine-render-pipeline` |
| Assemble a renderer, diagnose backend selection, or recover a lost renderer | `forgeax-engine-app` + `packages/runtime/README.md` assembly owner |
| Vec/Mat/Quat/Color / 从 mat4 读 pose / screenToRay | `forgeax-engine-math` |
| authored package → cook/catalog → assets.load（glTF .glb/.gltf / FBX .fbx）| `forgeax-engine-assets` |
| Procedural asset / generator delivery review, Scriptable Pack / Runtime Pack provenance, parameters, cold recovery | `forgeax-scriptable-pack-review` |
| Code-first GPU VFX source / WGSL hooks and imports / Pack v2 cook and GUID load / `ParticleEffectPlayer` / persistent GPU billboard or mesh output | `forgeax-engine-vfx`; add `forgeax-engine-assets` when changing shared Pack/catalog transport and `forgeax-engine-render-pipeline` when changing the generic RenderFeature graph seam |
| inspector (JSON-RPC WS) / kubectl 式 CLI 子命令 | `forgeax-engine-cli` |
| Saved Catmull-Rom paths / world-distance motion / camera rails / patrols / physics desired poses | `forgeax-engine-ecs` → `packages/path/README.md`; use `forgeax-engine-assets` for Pack/GUID delivery |
| Graph/grid routes / static NavMesh baking and projection / local avoidance / physical character following | `forgeax-engine-navigation` |
| RigidBody / Collider / PhysicsWorld (rapier 2D/3D) | `forgeax-engine-physics` |
| AudioSource / AudioListener / bus 拓扑 | `forgeax-engine-audio` |
| immediate-mode 调试可视化：line / sphere / aabb / frustum / arrow / axes | `forgeax-engine-debug-draw` |
| 物体平移 / 旋转 / 缩放操纵器：约束拖拽、吸附、取消与实体呈现 | `@forgeax/engine/interaction`（见 `packages/interaction/README.md`） |
| 拾取 ray/pick：屏幕→实体 `pick` / 顶点级 `pickVertex` / tile-cell `pickTile` / `PickError` | `@forgeax/engine-picking`（无独立 skill,见 `packages/picking/README.md`) |
| 纯逻辑图形附属：字形布局/烘焙 `layoutGlyphText`/`bakeGlyphMesh` / 图块位编解码 `encodeTileBits`/`decodeTileBits` / 视频 `VideoPlayer`/`VideoElementProvider`/`videoLoader`/`probeVideoHighPerfUpload` | `@forgeax/engine-graphics-extras`（无独立 skill,见 `packages/graphics-extras/README.md`；系统入口 `tilemapChunkExtractSystem`/`glyphTextLayoutSystem` 仍在 runtime） |
| 状态机 / defineState / setNextState / 状态 scoped 实体 / OnEnter/OnExit | `forgeax-engine-state` |
| 底层后端（贡献者）：opaque handle / capability / 双实现 | `forgeax-engine-rhi` |
| 明确错误 / 测试 / CI 出错 — 症状索引与 owner 路由 | `forgeax-engine-debug`；复杂渲染问题优先上面的 RHI Debug 路径 |
| Slow/flaky CI, changed-source focused reruns, or missing CI artifacts | `forgeax-engine-debug` → `scripts/ci/README.md` |
| RHI 录帧 / replay / 离线 per-draw inspect (capture→inspect→dispose) — 查 bindings+drawCall+RT PNG 定位渲染症状 | `forgeax-engine-rhi-debug` |

聚合非 1:1 对包：`input` 折进 `app`,`pack` 折进 `assets`,`geometry` 折进 `material`。包名册全表：`AGENTS.md §Packages`。

API 签名 / error 码 / capability 全表 SSOT 在 `packages/<pkg>/src/` 与 `packages/<pkg>/README.md`,skill 正文不复述,顺其"深入"锚点跳。

## feat / bug 合入后维护

任何对 AI 用户面的影响（公共 API 重命名、入口参数变化、`*ErrorCode` 增删、pack schema 变化、内置组件/系统默认行为变化、新增 `@forgeax/engine-*` 包、反复踩中的坑）必须在 finalize 前同步对应 skill。plan 阶段加 milestone `M-N: 同步 forgeax-engine-<cluster> skill`,与代码同 PR。direct-edit 也算。

基线：commit [`5c8c90f1`](https://github.com/ForgeaX-Games/forgeax-engine/commit/5c8c90f1) (2026-06-03, #297) 一次性产出 11 skill;累积偏离显著时再统一 bump。
