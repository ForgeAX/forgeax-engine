**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`，示例代码保持原文。

# forgeax-engine-app

挂载 HUD 的布局/action 见 [UI 契约](../../packages/ui/README.md)。mountUi 给百分比高度内容提供 host viewport height，scroll 留在创作元素。onAction delegation 读取 data-ui-action，不是任意 data-action。验证真实 click acknowledgement、可见 geometry，不能只看 HTML 文本存在。

## 配置路线

在提供 devkitAppOptions.configuration 的 build configuration plugin 声明项目设置，见 [App configuration](../../packages/app/README.md#engine-configuration) 和 [game-3d plugin](../../templates/game-3d/assets/project-configuration.ts)。bootstrap/native bindings 不放数据定义。configurationHost 提供真实 Host facts/storage，不猜 model name。preset/group 请求用 app.configuration.setQuality，检查 requested/applied plan、constraints、sources、submitted/completed revision。texture-residency 变化在任何 hot field 应用前返回 configuration-recreate-required，保留 pending restart intent。setter ACK 或 UI-only 图不是 ready-scene 证据。不能用 renderer.setProfile 绕过 managed App configuration。在真实 Browser/Worker frame 验证 A-B-A、replacement-realm adoption；native assembly 在构造 domain 前完成解析。

## 标准渲染路径

可选 host tools 经 App host adapter 提供。environment/HMR 解释留 DevKit/bundler adapter，App/Renderer/Animation 消费显式 capability/diagnostic subscription。新增 adapter 或边界 gate 失败见 [runtime boundary](../../scripts/ci/README.md#runtime-and-tool-boundary-contracts)。

内置 Water Scene plugin 在 backend sync/simulation 之间安装同步 WaterPontoonSet physics，仅 collision completion 后发布 splash/wake。完整数值证据读 runtime WaterBuoyancy，render tape 不证明力。saved relative/socket anchor、specified-body CPU particle DI 见 Water README。CPU DI 需要在系统位置 tick WaterParticleQueryInstance；particle query pins 独立选择 execution/depth/wave branches。检查导出 system/particle request position，不看 presentation transform。

Water 排序使用 Runtime 导出 WaterSceneReconcile、WaterContactProbes、WaterBuoyancy、WaterBuoyancyCompletion。fixed motion 两侧用 PhysicsSync/PhysicsSimulation，camera input 前用 InputFrameStartScan。注册/移除必须同 defineSystem token，diagnostic name 不标识 schedule edge。状态读 WATER_SCENE_STATUS_RESOURCE，Physics 读 PhysicsWorldResource，从 token 推导完整 owner types。

App host 遵循 RenderScene -> Standard Pipeline -> DeviceScope -> FrameReceipt。Feature texture completion 带 receipt frame/device/graph identity，最终返回 draw receipt 拥有 credit/retirement。保留 host completion holds，不要求跨边界对象身份相同。createApp 后 host 执行 attach/draw，基于返回 receipt inspect/observe/recover。domain producer 各自拥有 assets/input/audio/plugin。

## 恢复路线

恢复顺序 renderer.state() -> inspect() -> recover() -> FrameReceipt。Renderer 是唯一 recovery owner，App 只在 alive 准入帧。logic/render 同域时 device-lost/recovering 保留 Host/rAF heartbeat，但冻结 World update/submit。Render Worker 路径看 report.render：App 以新 epoch/baseline 替换 GPU owner，source World 身份不变，等 replacement ready 且有 publication capacity 再更新。

resident mesh 的确认 device loss，复用 source World 前等待 receiver 有界 disposal acknowledgement；cleanup failure/timeout/transport loss 仍 fatal、meshReleaseUnconfirmed，Worker termination 不证明 GPU 已释放。异步等待后再次同时检查 readiness/capacity，loss 会先清旧 queue。replacement 后重读 app.canvas，重绑调用者 DOM listeners。图像验收计数当前 canvas/World 上 presentation=ready 的 forgeax:frame-completed 事件；report.render.completedFrame 是 source publication ID，不能用 ID 相减计图片或排除 preparation。recover 为 single-flight，共享 Promise。faulted 必须 dispose/recreate，disposed 为终态。

按封闭 RenderError code 分支，读 expected/hint/typed detail，依指导等 active flight、显式 retry、修具名 producer/capability 或 rebuild Renderer。成功恢复后重试同请求，要求其 FrameReceipt/device generation 作 submit 证据。target/history 身份保留，但新 generation 内容到 receipt 前未初始化；fallback output 不是真 Browser/Dawn 证明。不能扫描 factory 找隐藏 retry loop、加 RecoveryManager、换后端、destroy 旧 device、加第二 submit path。

浏览器显示消费者用 subscribeBrowserFrameSubmitted(canvas, listener)，回调带 accepted frame/device/graph identity、深冻结 output mapping（含 identity distortion），用于 picking/world label。loss/retirement/zero-size output 时丢弃，现有 Renderer 恢复成功后再取 context。Worker frame-complete message 传相同可序列化事实。

> createApp 是 host adapter，不是第二 scheduler：测一次 native host delta，world.update(deltaSeconds)，再 draw。游戏行为属于 ECS Update/FixedUpdate。

## 一屏起步

```ts
import { createApp } from '@forgeax/engine/app/browser';
import { defineSystem, Time, Update } from '@forgeax/engine/ecs';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const result = await createApp(canvas, {}, forgeaxBundlerAdapter());
if (!result.ok) {
  console.error(result.error.code, result.error.hint);
  throw result.error;
}

const app = result.value;
app.world.addSystem(Update, defineSystem({
  name: 'move-player',
  queries: [],
  fn: (world) => {
    const delta = world.getResource(Time).delta;
    void delta;
  },
})).unwrap();
app.start().unwrap();
```

浏览器构造从 @forgeax/engine/app/browser 导入；根 app 入口要求显式借用 platform/renderer/world。browser entry 创建 World、renderer、default plugins、browser input backend、frame loop。factory Result 成功后 app.start() 才启动浏览器循环。

CSS-sized buffer 在 Android/iOS 默认短边720像素，保留 canvas aspect，不乘 DPR；桌面默认每 CSS pixel 一个 physical pixel。显式 canvasPixelRatio 覆盖，1 为 CSS resolution，window.devicePixelRatio 为设备分辨率。Render 创作 DynamicResolution 独立 opt-in；device texture limit 仍等比 clamp extent。

骨骼运动在 App assembly 选 animation:{cadence:'fixed'}。普通 DevKit 通过 forgeax dev start --animation '{"cadence":"fixed"}' 或 project build 同参数转发，public startLiveDev/buildCommand 原样接受。main/Worker 共用 App 安装的 animation owner，Pack behavior 消费它，不能再装其他 cadence 的 playback plugin。

## Worker 执行

```ts
const result = await createApp(canvas, {
  execution: {
    bootstrap: new URL('./game-bootstrap.mjs', import.meta.url),
    // Omitted policies are auto: enable every supported worker.
    workers: { engine: 'auto', render: 'auto', kernels: 'auto' },
  },
}, forgeaxBundlerAdapter());
if (!result.ok) throw result.error;
result.value.start().unwrap();
const report = result.value.execution.report();
```

| 需求 | 动作 |
|:--|:--|
| 默认并行 | 省略 workers，检查各 report.workers decision。 |
| 固定骨骼动画 | animation fixed、World fixed time；App 向 Host/Engine Worker（含 rebuild）转发 Animation POD，加 motion plugin，不重复 default animation。 |
| 必需 Worker | policy true，处理 app-execution-worker-unavailable。 |
| 关闭独立 render | render:false，配置同域 Renderer。 |
| 无 WebGPU adapter | 保持 auto，支持的 Worker WebGL2 仍可用；report.capabilities.workerWebGpu 看准入，report.render.capabilities.backendKind 看实际后端。 |
| Shared numeric kernels | kernels:auto，提供 COOP/COEP，检查真实 kernelDispatch。 |
| Host-only bootstrap | engine:false，依赖 policy 保持 auto/false。 |
| 不可变 native local carrier | engine:false 时传同 graph localBootstrap 保留 decoder/component 身份，bootstrap 仍为 Worker URL，见 [execution contract](../../packages/app/README.md#worker-execution)。 |
| Kernel 部分写入 | app.execution.rebuild()，改用新 World 身份。 |
| 固定呈现帧率，如30 | app.execution.setFrameRateLimit(30)，null 移除；仍基于 display callback 准入，World time 不变。 |

World/Assets 在 Engine Worker；render 开启时 child 拥有 Renderer/WebGPU，source plugin inject World/Assets，以 bootstrap configureRenderer 设置 GPU，Feature implementation 也经 bootstrap 声明。native Worker/Host display callback 共服务一个 frame demand，首 callback 取消另一 lease；Worker clock 延迟不挡 live Host clock，credit/input sampling/time 仍归 Host。独立渲染 Worker 的提交槽满时，运行正常的会话仍继续逻辑更新。关卡显隐及物理参与在获得画面提交额度的帧切换。下一张画面使用最新 World 状态并重置时域历史。

kernel workers 接 eligible shared numeric span，与 render placement 独立。初始化/module preflight 及首 source frame 继承 App startupTimeoutMs，后续 source admission 受 frameTimeoutMs，运行中的 kernel dispatch 有独立 deadline。无 isolation 仅禁 auto kernels。无 bootstrap 的 canvas/assemble 调用显式构造 local objects，保持 local。DevKit 自动为普通项目生成 bootstrap，两个模板默认 auto，roots.frontend 为 browser UI、roots.engine 为 Engine gameplay，roots.host 为 resident Node backend。placement/recovery/report schema 见 [App](../../packages/app/README.md#worker-execution)，kernel eligibility 见 [ECS](../forgeax-engine-ecs/SKILL.zh-CN.md)。

临时交 presentation surface 给其他 carrier（Play iframe/Tauri WebView）时，新 owner mount 前 await app.releaseSurfacePreserveWorld()，销毁后 await app.restoreSurface()，保留精确 Edit World/Renderer 身份。stop/dispose 不是 relocation API：stop 只停调帧，dispose drain plugin realm、释放 renderer。

## 无 GPU 的 CPU 诊断 stub

createApp(canvas,{gpuStub:profile}) 在 main capability probe 前装 rhi-webgpu stub，转发到 Engine/Render Worker，均在 Renderer 前安装。Worker WebGPU 计为可用，使拓扑与 GPU host 一致。generated host 把 ?forgeax-gpu-stub=1 映射到 DEFAULT_WEBGPU_STUB_PROFILE。仅用于 CPU attribution，见测量参考。

## 可选 CPU profiling

需要有界 CPU artifact 才把 @forgeax/engine-profiler 附到 App/Renderer assembly。默认关闭，无 profiler 就无 capture record/profiler event object。

```ts
import { createProfiler } from '@forgeax/engine/profiler';
import { createApp } from '@forgeax/engine/app';

const profiler = createProfiler();
const result = await createApp({ platform, renderer, world, profiler });
if (!result.ok) throw result.error;

const capture = profiler.startCapture({ frameLimit: 120, eventLimit: 1024 });
if (!capture.ok) throw capture.error;
// Drive the App, then call capture.value.finish() and validate the artifact.
```

profiler.phaseCatalog 提供 App/Render owner 关系；离线用 validateProfileCapture/buildProfileModel，不另造 phase list，不把该能力变成 ECS/GPU/UI/RPC surface。

## 加载时间线

默认以可忽略成本记录，无需附加。在任意 realm 从 @forgeax/engine/app 调 markLoadTimeline('home-ready')/('map-ready') 标记里程碑，await collectLoadTimeline() 或 globalThis.__forgeaxLoadTimeline.collect() 汇总所有 realm。record kinds/limits 见性能测量。

## Render 拥有的证据边界

Render inspection/profiling 是证据边界；App 暴露 inspect/observe 投影，转发 opt-in profiler，不定义 timing controller/timestamp vocabulary/membership option。gpuPassTiming 透明投影到 Runtime/Render，App 不准入 capability、不拥有 frameId/timing session/FrameReceipt，只保留既有 realm/worker gate。路线为 gpuPassTiming opt-in -> draw receipt -> observe(receipt,{include:['timings']}) -> status/code/hint。membership timing 属于特定 producer，不是通用已接受证据。新 diagnostic surface 前链接 Render contract/validator。

## Renderer Feature 装配

可选 render contribution 通过唯一 assembly seam。游戏导入 public umbrella @forgeax/engine/<package-directory>；物理 @forgeax/engine-* 是仓库包源码/测试所有权单位。RenderFeature/FrameData 来自 @forgeax/engine/render，createRenderer 来自 @forgeax/engine/runtime。

```ts
import { ok } from '@forgeax/engine/types';
import type { RenderFeature } from '@forgeax/engine/render';
import { createRenderer } from '@forgeax/engine/runtime';

type FrameData = { readonly visibleCount: number };
const feature = {
  identity: 'package.feature',
  extract: ({ owner }) => ok<FrameData>({ visibleCount: owner }),
  plan: (data, context) => {
    void data.visibleCount;
    void context;
    return ok({ resources: [], passes: [] });
  },
} satisfies RenderFeature<FrameData>;

const created = await createRenderer(canvas, { features: [feature] });
if (!created.ok) throw created.error;
const renderer = created.value;
```

createApp(canvas,{outputColorSpace:'display-p3'}) 原样转发（含 Worker），App 不拥有色彩策略。从 Renderer realm 的 inspect().output.colorSpace 读取协商结果或结构化 sRGB fallback。

### 声明式 graphics 与恢复

需要 graphics/compute 的 producer 在 plan 声明，导入依然按 render/runtime owner 划分。

```ts
import { ok } from '@forgeax/engine/types';
import type { RenderFeature } from '@forgeax/engine/render';
import { createRenderer } from '@forgeax/engine/runtime';
interface PreparedFrame {
  readonly visibleCount: number;
}

const frame: PreparedFrame = { visibleCount: 0 };
const feature = {
  identity: 'package.prepared-feature',
  extract: () => ok(frame),
  plan: (_data, context) => {
    return ok({
      resources: [{
        kind: 'graphics-program',
        name: 'package.pipeline',
        program: {
          shader: 'package.shader',
          vertexLayout: 'package.vertices',
          colorFormats: [context.targets[0]?.format ?? 'rgba8unorm-srgb'],
          sampleCount: 1,
          topology: 'triangle-list',
        },
      }],
      passes: [],
    });
  },
} satisfies RenderFeature<PreparedFrame>;

const created = await createRenderer(canvas, { features: [feature] });
if (!created.ok) throw created.error;
const renderer = created.value;
```

host 从声明推导 opaque GPU resource/graph access，producer 只拥有 extracted facts，拿不到 device/encoder/queue/submit callback。恢复使用 inspect() 与唯一 subscribe() stream，按封闭 RenderError/detail 分支，不解析 console 或导入 private assembly。device loss 调 recover，disposed 终态，dispose 幂等。术语/公开 context 见 [Render](../../packages/render/README.md)、[feature plan](../../packages/render/src/features/plan.ts)；host 见 [Runtime](../../packages/runtime/README.md)，GPU particle 见 [VFX Render](../../packages/vfx-render/README.md)。

## 帧循环契约

每帧唯一 host-owned 顺序：

```text
measured deltaSeconds -> world.update(deltaSeconds) -> renderer.draw({ source: lease })
```

createApp 只测一次 delta，World 拥有时间积分、fixed catch-up、Time/FixedTime。不能另加 callback list、App elapsed clock、App clamp、第二 rAF。World update/draw 失败经 app.onError 报告，不吞结构化错误。

带 screen UI 的 native startup Host 在既有 root activation transaction 提交前 sceneAdmission 返回 ui-only，shader 初始化后仍可提交 UI-only pending frame。返回 scene 才准入 primary source，失败时撤回；readiness 看返回值，不看 Camera 存在或 opaque UI pixels。同 App loop 保留 World update、UI、input、Reload。

```ts
const stopListening = app.onError((error) => {
  console.error(error.code, error.hint);
});

const started = app.start();
if (!started.ok) console.error(started.error.code, started.error.hint);

// Later: stopListening(); app.stop();
```

## 时间策略接线

canvas form 在创建 World 时配置，policy 属于 World：

```ts
const result = await createApp(canvas, {
  time: {
    fixedDeltaSeconds: 1 / 60,
    maxStepsPerUpdate: 4,
    maxDeltaSeconds: 0.1,
  },
});
```

Time.delta 为验证后的 variable delta，elapsed 为累计；FixedTime 提供 fixed delta/tick/truncation metrics，系统直接读取。droppedSeconds/droppedUpdates 表示 capped catch-up，不授权恢复 App clamp。assemble form 先由 host 创建 World，已有 policy 为权威：

```ts
import { World } from '@forgeax/engine/ecs';
import { createApp } from '@forgeax/engine/app';

const world = new World({ time: { fixedDeltaSeconds: 1 / 120, maxStepsPerUpdate: 8 } });
const result = await createApp({ platform, renderer, world, plugins: [myPlugin] });
if (!result.ok) throw result.error;
result.value.start().unwrap();
```

## 删除 callback 的迁移

旧 registerUpdate 已删除。每 callback 改具名 Update system，从 World 读时间并参与排序：

```ts
import { Time, Update, defineSystem } from '@forgeax/engine/ecs';

const AnimateHud = defineSystem({
  name: 'animate-hud',
  queries: [],
  fn: (world) => {
    const elapsed = world.getResource(Time).elapsed;
    updateHud(Math.sin(elapsed));
  },
});

app.world.addSystem(Update, AnimateHud).unwrap();
```

确定性模拟用 FixedUpdate，排序用 schedule edges/sets，不重建 App callback queue：

```ts
import { defineSystem, FixedUpdate } from '@forgeax/engine/ecs';

app.world.addSystem(FixedUpdate, defineSystem({
  name: 'step-combat',
  queries: [],
  fn: () => stepCombat(),
})).unwrap();
```

## 输入与插件接线

普通 gamepad dual-rumble 从 frozen reader 读 feedbackTarget/dualRumble，经 GAMEPAD_FEEDBACK_KEY 下可选 GamepadFeedback resource 发起。轮询有界结果，按 admission capacity 分支。Host input 拥有 actuator，App 经现有 Worker frame 传 POD。target fencing/replacement/cancel/native timeout 见 [Input](../../packages/input/README.md#gamepad-feedback)，API completion 不证明真实振动，需实物 controller。

canvas form 插入 input backend，在用户系统前的 Update 激活 scan。用户读 frozen InputSnapshot，不安装 gameplay DOM listener。

pointer-lock FPS/mouse look 参考 templates/game-3d/assets/camera/camera.pack.ts：

- Engine realm 经 gameHost.setPointerLockAllowed(allowed) 在变化时发 gate，如 phase===playing；Host 在下一 trusted canvas click 请求 lock，玩法不调 requestPointerLock/监听 DOM。
- gate 默认允许。cursor game（俯视/RTS/塔防/UI）在插件 apply 一次关闭；最新命令在 backend 创建、Worker startup、canvas replacement 后均为生效状态。
- 仅 input.mouse.pointerLocked 时消费 movementDelta/fire，取得 lock 的 click 不是 shot；已锁时左键开火安全，不失锁。
- pointerLocked false（Esc/blur/tab hide）视为 pause，resume 要新 click；Esc 后浏览器短时拒 relock，loss 后约一秒关 gate，不依赖拒绝。
- app-pointer-lock-failed 可恢复，游戏解锁继续，下一 click 重试，不能送 fatal handler。
- crosshair 也支持 touch gameplay，touch 不取 mouse lock。
- desktop 的 look pad/virtual stick 不能挡 cursor 下 canvas，否则吞锁定 click；最后 pointer 非 touch 时隐藏。

```ts
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { Update, defineSystem } from '@forgeax/engine/ecs';

const ReadInput = defineSystem({
  name: 'read-input',
  queries: [],
  fn: (world) => {
    const input = world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY);
    if (input.keyboard.down('KeyW')) moveForward();
  },
});
app.world.addSystem(Update, ReadInput).unwrap();
```

plugins 组合 physics/audio 等可选能力。原生 DeepSeek Cordis plugin 声明 inject/provide，可逆 side effect 全部经 ctx.effect，App pluginContext 拥有 Fiber。

```ts
import type { Plugin } from '@forgeax/engine/plugin';

const gameplay: Plugin = {
  name: 'gameplay',
  inject: ['world'],
  apply(ctx) {
    ctx.effect(() => installGameplaySystems(ctx.world));
  },
};

const fiber = await app.pluginContext.plugin(gameplay);
await fiber.dispose();
await app.dispose();
```

stop 仅停调帧；dispose 先 drain Cordis realm，再释放 simulation/Host/renderer。assemble host 显式提供 World/renderer/input backend/plugin set，App 仍拥有围绕它们装配的 Context。

## 边界

- createApp 返回 Result，start 前处理 ok/error.code/hint。
- createRenderer 是低层入口，直接使用的 host 自己驱动 World update/draw。
- App 拥有 browser lifecycle/error fan-out，World 拥有游戏调度/时间。
- 迁移后 demo 冻结说明 Engine/schedule integration 失败，应修集成，不加 demo callback/manual loop。

精确 options/Result/lifecycle/input/renderer 契约见 packages/app/README.md、src/types.ts、src/internal/frame-loop.ts。

## 模拟检查

传入已创建且 ready 的 simulation participants，App 注册到 World，仅暴露一份只读 summary。app.simulationInspection() 提供 participant/readiness、baseline、trace、report、tolerance、结构化 error，schema 在 packages/app/schema/simulation-inspection.schema.json。App 不定义 record/schema/component state/restore policy。Preview/Remote 仅经 read/eval 消费 summary；restore/replay action、raw World/Rapier/Web Audio 不进 transport。

## PluginAsset 创作

按功能建 Pack：同文件导出小原生行为，复杂实现拆普通 TS module。遵循 [Plugin](../../packages/plugin/README.md)：持久定义在 Pack，schema-v3 roots 选择 GUID。asset plugin inspect 检查 sourceKey/definitions，native Fiber state 确认激活。code/config 变化验证新会话；engine/frontend effect 分别拥有 scene/DOM cleanup。复用先读 help asset source import/clone，转移作者闭包。
