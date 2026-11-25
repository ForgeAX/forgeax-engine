**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`，示例命令与代码保留原文。

# forgeax-engine-rhi-debug

> [!IMPORTANT]
> 复杂或不明渲染问题先从这里开始，在猜测性 shader/material 编辑或广泛埋点之前，捕获真实失败帧，用 GPU work/resource 证据选择修复 owner。明确 startup/asset/schema 错误可直接交给指名 owner。
>
> 用于已观察到的渲染失败，或优化 GPU-bound 帧，见[从捕获分析 GPU 性能](#gpu-performance-from-a-capture)。它不是交付验收步骤：截图和 dev verify 通过时无需录 tape。
>
> rhi inspect/read 返回 replay-backend-unavailable（例如宿主无原生 replay）时保留 tape 和 rhi summary 结构，转用真实后端的 dev capture 截图、dev eval 状态、debug draw。不要重试 replay 或因此阻塞交付。
>
> Node GPU 工具使用可选的上游 Dawn 预编译包。需要回放时，在游戏中安装 `upstream-webgpu@npm:webgpu@0.6.2`，并使用游戏自己的 CLI。`rhi summary`（含 `--passes` / `--label`）及默认 `pipeline` / `bindings` 的 `rhi inspect` 只读取 tape。`pixels`、`outputs`、`rhi read` 和 `rhi timing` 会回放。

| 症状 | 首先检查 |
|:--|:--|
| 某 target 缺对象/效果 | `rhi summary --passes --json` 列每个 pass 的 label、target label/size/format、draw/dispatch 数、pipeline label；找到写该 target 的 pass，确认对象 pipeline label 与 draw 存在。`--label <regex>` 按名找 texture/buffer，无需 replay device。 |
| Canvas 白/透明，HUD 正常 | dev capture --json、project play report 或 `__forgeaxGameInspection.renderer().rendererError` 的 rendererError；GPU validation/submit 错误会拒绝每帧 submit，捕获后检查消息指名资源。 |

包契约：[RHI Debug README](../../packages/rhi-debug/README.md)。已安装游戏读 node_modules/@forgeax/engine-rhi-debug/README.md 或 SDK source/engine/packages/rhi-debug/README.md。

pending multi-view receipt 要检查 tape 是否含 sibling scene/compositor draws。组合视图共享该帧 preparation barrier；一个 sibling ready 时不能在另一个 native PSO pending 时写部分画面。此类违规归 Render graph seal/physical frame submit，保留真实 tape 和原 Browser readiness bound。

资源 byte/count 分布和 captured pipeline/usage graph 使用同 tape 的[性能 GPU workbench](../forgeax-engine-performance/SKILL.zh-CN.md#gpu-capture-workbench)。明确请求 GPU resource inspection 时，即使画面正确也可捕获。独立 viewer 保留 resource ID/workIndex，导出 image/HTML/AI JSON，结构检查无需 replay device。

## 诊断并证明修复

1. 在真实 browser/backend、相同 scene state 复现，保留截图、错误、复现命令。浏览器独有失败即使 Dawn smoke 通过仍需 browser 路径。跨设备 pipeline miss 保留选定 render path、attachment count/byte budget、sampled-texture/storage limits、完整 recipe；默认设备通过不能证明其他设备路径。renderer archive warmup 省略可证明不兼容的 color-target recipe，skippedRenderTargetRecipes 不计作完成准备；其他 descriptor failure 仍是失败。受限真实设备请求须保留 native compilation 证据，mock limits 不算验收。parity-bench 失败保留 per-target pixel-parity report/失败截图；host/World 启动后的 pixel-readback hook timeout 不等于像素不匹配或 Chromium launch 失败，可能还无 completed frame，先保留启动事实再选 shader owner。Windows 黑 compositor capture 记录 process session：Session 0 service 可离屏渲染但 DXGI swapchain 返回 0x887A0022，应在已登录桌面复现后再归因 Engine shader，page/compositor 截图仍为视觉关卡。
2. CI-only 失败把 fixture 有界 evidence directory 放入现有 failure upload，单截图不保留 replay input。通过下文 host 路径捕获有界失败帧，原样保留 tape、digest、复现输入。
3. 推导 FrameModel，选择 workIndex，检查 pipeline、bindings、resource descriptor/data、支持的 target readback。resource label 在 resources[].descriptor.desc.label，pipeline label 在 works[].pipeline.descriptor.desc.label，据此找 producer draw。ray/compute records 用 producer layout 和 rhi.inspect buffer 输入或 inspectBufferRecords，见[有界 buffer 契约](../../packages/rhi-debug/README.md#structured-compute-and-ray-query-buffers)。rhi.read records 选择 binding bound window 内行，读 source buffer，不读 mappable staging copy（readback-unsupported）。ray-query tape 仅在 contributor checkout 构建 native addon 后以 FORGEAX_WEBGPU_NODE=wgpu-native 重放，Dawn 返回 replay-backend-unavailable。

   GI probe/card atlas、SDF slice、HDR storage buffer 用 `forgeax rhi read` 或 session.readAtWorks + bindingReadRequest 在一次 replay 读取多个 bindings/works，再以 readbackImage/extractTile/imageStats（含 NaN count）解码，每 tile 写 PNG，见[批量读取与图像](../../packages/rhi-debug/README.md#images-atlases-and-hdr-texels)。

   compute dispatch、depth-only/shadow pass 用 outputs inspect field 或 workOutputs(work)，读取产生的 color<N>、depth、可写 @group(G)@binding(B)。单项示例：`{"output":"depth","workIndex":N,"image":{"depth":{"near":0.1,"far":100,"reverseZ":true},"range":"auto","png":"shadow.png"}}`。depthImage 线性化 depth，layer view 读取自身 array layer。每 texel 返回一个 f32。WebGPU/native wgpu 对显式 depth32float + COPY_SRC 直接复制；WebGL2/Null/其他格式保留独立 unfiltered load shader。保留 cached-depth Dawn layer/mip、fresh replay 检查；depth-stencil 明确选择 aspect。验证 positive control/cleared zero，保留 raw 值，对比共用 display range；全零图片或单独 comparison-sampling 搜索不能证明精确 depth 内容。

   慢帧用 forgeax rhi timing 或 session.benchmarkPasses() 按 replay-device GPU time 排序，见[逐 pass timing](../../packages/rhi-debug/README.md#per-pass-gpu-timing)。沿 lineage 查第一个错误 producer/consumer。预期 draw/dispatch 缺失时向上查 extraction、culling、asset readiness；不存在 work 也是证据。
4. 将失败路径写为最小有用 regression gate，先确认红，再按事实修 owning subsystem。按证据加载 material/shader/render-pipeline/assets/RHI 技能。通用 RHI Debug 不混入 workload 专用 lighting/shadow/post 策略；只有 capture/replay 契约被证明有错才改它。mipmap 后跨 texture 调色板/alpha 损坏，运行 WebGL2 fallback roster 的 mipmap-upload-isolation.browser-no-webgpu.test.ts；保留连续 upload，readback/queue drain 可能掩盖问题。
5. 跑 regression、再次捕获，验证同 scene/backend 和原始可见症状。before/after artifact 明确区分；replay 只补充必要 browser/Dawn/smoke。直接保存 recorder 已有 compressed container，fixture transport 不可为存证解码重压 raw/gzip 混合 blobs。texture snapshot mapping 在 device buffer limit 内跨 mip/layer 共享 staging，保留所有 subresource copy，用 WebGL2 roster 的 texture-readback-staging.browser-no-webgpu.test.ts 验证全 face/mip bytes。Three oracle 可借 file-owned upstream GPUDevice，但每图保留 fresh Renderer/node state，Engine capture/fresh-device replay 独立。Three 完整进程与其他 GPU group 并行超时，保留 process spans/replay milestones，调整 admission 前先单独验证完整 owner，cases/frames/deadlines 不变。完整 Three case timeout 先查 three-render-phase、three-render-replay receipts，再选 performance owner。无可用 WebGPU adapter 的 recorder fallback 走 [Browser without WebGPU](../../scripts/ci/README.md#browser-without-webgpu)，Worker、60 帧、decoded-tape 检查保留在 Browser owner。

capture/replay/readback 受阻时保留命令、结构化失败、capability result，按下表恢复，继续已有结构证据和定向 browser/live 检查。报告未验证项，不能拿 mock 成功替代 GPU 证据，也不能在游戏/演示隐藏 Engine 缺口。

<a id="game-cli-entry"></a>
## 游戏 CLI 入口

游戏根目录发现安装契约：

```bash
pnpm exec forgeax help rhi --tree --json
pnpm exec forgeax help dev start --json
pnpm exec forgeax dev start --rhi-capture true --json
pnpm exec forgeax rhi capture --json
```

dev status 报告 rhiCapture；recorder 在创建设备时附加，运行中不能开启。false 时 rhi capture 返回 capture-unavailable 和精确 restart 命令；dev start --rhi-capture true 退役旧 owner、启动新 owner。capture 返回 host 帧 frameId、frameIdSource、capturedAt，间隔捕获应是不同帧。保留失败 backend/execution tier，复现目标状态再捕获。CLI 调 live recorder 并存一份 .rhitape，保留返回路径/digest。需要 ready 且启用 recorder 的 App，不自动启动。embedded host 用 [CLI live bridge](../forgeax-engine-cli/SKILL.zh-CN.md#rhicapture-single-frame-capture)，持久化 capture.value.bytes 及 digest，只有 digest 无法检查。

使用返回路径及 summary.works[].workIndex：

```bash
pnpm exec forgeax rhi summary --artifact <path> --passes --json
pnpm exec forgeax rhi summary --artifact <path> --passes --label particle --json
pnpm exec forgeax rhi summary --artifact <path> --json
pnpm exec forgeax rhi inspect --artifact <path> --work-index <workIndex> --json
pnpm exec forgeax rhi read --artifact <path> --reads '[{"binding":{"group":0,"binding":2},"workIndex":<workIndex>,"image":{"format":"rgba16float","width":256,"height":256,"tile":{"tileWidth":8,"tileHeight":8,"index":0,"border":1},"png":"probe0.png"}}]' --json
pnpm exec forgeax rhi timing <path>
```

rhi timing 默认 warmup 3 次（丢弃）再 repeat 20 次，连续 replay 并以 GPU copy 恢复状态。表格包含 whole-frame union p50/95% interval、drift、top passes、无 timestamp passes、preflight；--json 单位 ns。tile GPU pass interval 可能重叠，应报告 union。--ci-ms X 延长 repeat 直至 interval <= X ms。--skip '<regex>'、--skip-passes '[i]'、--skip-works '[w]' 增加交错 variant、paired delta、significant verdict；跳过 pass 留下旧 target，后续仍读取，因此只是成本估计，不是正确图像。--isolate 在每 pass 前后 submit/wait，isolated sum >= real frame。INVALID（GPU busy/量化 timestamp）不是有效测量；在 host perf slot 内运行。见 [replay GPU benchmark](../../packages/rhi-debug/README.md#replay-gpu-benchmark)。

summary/inspect/只读 Viewer 使用同 ArtifactRef，不重新捕获或猜 input pair。可选字段查 CLI help，精确操作契约见 [DevKit](../../packages/devkit/README.md#rhi-debug-operations)。compact summary 省略重复 shader source。CLI 从文件计算 SHA-256，可选 --digest sha256:... 在 replay 前拒绝不匹配；recorder/CLI 共用 tapeDigest。

信任像素前检查 summary.unseededResources/FrameModel.unseededResources；这些 retained buffer/texture 无初始 bytes，replay 从零开始。确认帧在读取前初始化它们，否则重捕 producer。空诊断不能替代 live/replay 图像比较。depth32float seed 含全部 layers/mips，其他 depth/stencil 和 multisampled contents 仍需 producing work。

资源释放检查用 FrameModel.resourceLifecycle、resources[].destroyEventIndex；bootstrap creation index 为 null。通过 work bindings/attachments 找消费者。descriptor bytes/recorded destroy 不能证明 driver allocation/retirement timing。

GPU UI 见 [GPU UI 工作与保留内容](../../packages/rhi-debug/README.md#gpu-ui-work-and-retained-contents)：选 ui-raster-*、screen-ui-composite pipeline labels，查 layer reads/writes，捕获 changed/cached UI 帧。clear-only pass 在 pass events，不在 draw works；cached frame 必须 seed UI texture 才能用 replay pixels qualify。

<a id="gpu-performance-from-a-capture"></a>

## 从捕获分析 GPU 性能

tape 类似 RenderDoc replay profiling，是确定性 GPU benchmark；同一候选用同设备重放同命令。

```bash
pnpm exec forgeax dev start --rhi-capture true --json   # recorder must attach at device creation
pnpm exec forgeax rhi capture --json                    # steady-state frame, after warm-up
pnpm exec forgeax rhi summary --artifact <path> --passes --json
pnpm exec forgeax rhi timing <path>                     # table; --json for the full result
pnpm exec forgeax rhi timing <path> --skip 'shadow'     # paired cost delta + verdict
pnpm exec forgeax rhi timing <after> --compare <before> # interleaved A/B, after minus before
```

- 首行须 VALID；INVALID 给出前后 GPU busy、timestamp quantized 等原因，丢弃；--require-idle 拒绝 busy GPU。
- 看 union p50/95% interval、trend，stable 表示时钟稳定。--ci-ms 0.05 重放至该精度或 max-repeat。
- 按表排序 pass；summary --passes 映射 targets/pipelines，无 timestamp pass 不计 union。
- skip 系列提供 paired delta/bootstrap interval；significant 表示区间不含 0。仍只是成本估计，消费者继续读取旧 target，shadow sampling 等 shader 工作保留。
- 构建对比须相同 scene state 重新捕获，再 --compare；两 tape 在各自 device 上交替 chunks，verdict 取 candidate-minus-baseline union。
- replay 持续 GPU 时钟，因此 ms 比 live 低，如 r2-searchlight 11.3 ms replay、17.2 ms live；只比较 replay 与 replay。收益声明必须来自 live presented-frame rate/live timing，见[从捕获优化 GPU 帧](../forgeax-engine-performance/SKILL.zh-CN.md#optimize-gpu-frames-from-a-capture)。

## 大型捕获

GI 帧 tape 可近 1 GB。用 app.rhiCapture.upload(artifact, { runId }) 或 @forgeax/engine-rhi-debug/browser 的 uploadTape，以 16 MiB digest-checked chunk 流式上传，失败用同 runId 恢复，server 只发布完整验证文件。不要在 page 访问 artifact.bytes，避免连续复制。captureFrame({ seed: { maxResourceBytes } }) 可缩小捕获；超大资源进入 unseededResources[]、omitted: true，replay 从零开始。证据依赖该资源时取消限制重捕。见[大捕获流式处理](../../packages/rhi-debug/README.md#streaming-large-captures)。

## 心智模型

| 概念 | 用途 |
|:--|:--|
| .rhitape | 唯一规范 v7 artifact，包含 frame events/binary blobs。 |
| EventSemantics | method-event 与 handle-lifecycle 映射。 |
| TapeIndex | 派生 event/resource/work 查找。 |
| FrameModel | 所有 inspector 共用 works[].workIndex 序列。 |
| ReplaySession | fresh backend、类型化资源、readback、dispose。 |

每项职责只有一个 artifact/owner，不能另造 tape、selection key、resource registry、host replay model。

## 最短流程

1. 在 Runtime 到 App 边界，把 recorder 附到真实 RHI backend。
2. 捕获一帧，保留 artifact 的 kind、byteLength、chunks、惰性 digest/bytes。
3. 用严格 v7 decoder 解码。
4. 构建 FrameModel，选 works[].workIndex。
5. 用创建 fresh backend 的 factory 打开 replay session。
6. 检查 work，即使失败也 dispose session。

```ts
const captured = await app.rhiCapture?.captureFrame();
if (!captured?.ok) return captured;
const tape = decodeTape(captured.value.bytes);
if (!tape.ok) return tape;
const model = buildFrameModel(tape.value);
const replay = await openReplay(tape.value, await createFreshBackend(tape.value));
if (!replay.ok) return replay;
try {
  return await replay.value.inspectWork(model.works[0].workIndex, ['pipeline', 'bindings', 'pixels']);
} finally {
  await replay.value.dispose();
}
```

works[].bindings 包含 static bufferOffset 和该 draw 的 setBindGroup dynamicOffset（static 时 null）。有效偏移为 (bufferOffset ?? 0) + (dynamicOffset ?? 0)，据此证明读取哪个 uniform slot，如 per-composition View copy。bindingReadRequest(work, group, binding) 应用同规则生成请求。

multisampled pass 读 works[i].attachments.colorResolveViewHandleIds 的 1x target，按 attachment 顺序，single-sample 为 null，不能读 4x color view。weighted blended OIT 表现为 fs_oit/fs_oit_premultiplied accumulate，再一个 fs_oit_composite。在最后 accumulate work 用 readResourceAtWork 读 accum rgba16float、weight r16float，及 composite 前后 scene color，区分 accumulation 与 composite 故障。

## 协议与生命周期规则

- 仅接受 RHITAPE、formatVersion: 7。
- replay 前验证 canonical JSON、digest、typed array、handles、blobs、cardinality、create/dispose history。
- 明确拒绝 2 至 6 版。
- EventBrowser/PipelineState/TextureViewer/ResourceInspector/DevKit inspect 共用 workIndex。
- ResourceTable 验证 generation、拥有 disposal。
- BLAS/TLAS 是普通 bootstrap acceleration-structure，按最后 pre-capture build 重建；帧内 build 是 command event。ray-query work 先读 binding.accelerationStructure 的 status、instanceCount、blasHandleIds；unbuilt/错误实例数是 build producer 问题，不是 traversal shader。用 replayDeviceRequest(tape, ...) 打开设备，AS tape 要 Ray Query（native wgpu、@forgeax/engine-rhi-wgpu-native）。
- 使用声明的 readback format matrix，不猜转换；返回结构化 unsupported/failed。

## 结构化恢复

预期失败为带 RhiDebugError 的 Result。按 error.code 分支，让 TypeScript 缩窄 error.detail，不解析 hint/message 决定控制流。

| 失败 | 首要动作 |
|:--|:--|
| capture-unavailable | 真实 live host 启用 recorder，调用其 rhiCapture root；无帧则保留启动错误。 |
| capture-snapshot-failed / capture-timeout | 保留原 cause/detail.progress，区分 queue drain 与具名资源 readback 再选 owner。 |
| tape-invalid | 保留原始 bytes，源过时时重新捕获。 |
| tape-version-unsupported | 换 v7 producer，旧格式不是兼容输入。 |
| replay-capability-mismatch | fresh backend 满足录制能力或重录；BLAS/TLAS 要 caps.rayQuery.supported 为 true。 |
| replay-position-invalid | 从当前 FrameModel 选 workIndex。 |
| readback-unsupported | 保留结构证据，报告缺失 format capability；先试 outputs 再判定无可读内容。 |
| browser-capture-upload-failed | 看 detail.stage/offset/serverCode，同 runId 重传缺失 chunks。 |
| readback-failed | 保留 detail stage，dispose replay session。 |

## Viewer 证据

Viewer 拥有 fresh replay device。替换/关闭 tape 时先 drain session，再仅 dispose device 一次；拒绝准入/清理失败也须释放。用 viewer-replay-lifecycle.test.ts 检查所有权，再验证真实 captured-frame replay/pixels。lifecycle unit pass 不能推断 device-loss 原因。

Viewer 只读，加载一份 .rhitape，经 workIndex 联动四视图；无 WebGPU 仍提供结构模型。像素检查是 capability-gated 增强，不能因此替换 tape 或创建 browser-only model。AI 交接包含 digest、workIndex、event anchor、存在时的结构化 error detail、backend capability result、精确命令或 browser path。

## 平台边界

| 平台 | 职责 |
|:--|:--|
| Browser | DOM 选文件、WebGPU backend 构造、raw tape transfer。 |
| Node / DevKit | 文件访问、operation discovery、host 拥有 fresh backend 创建。 |
| Dawn | Native backend、像素证据。 |
| Core package | protocol/recorder/index/model/replay/readback 契约。 |

Core 不得导入 DOM、Node filesystem、PNG encoder、Viewer state。Vite bridge 仅开发期提供一份 raw tape。

## Screen Probe Dawn 交接证据

完整薄墙支持测试在 Dawn 独占的 `screen-probe-support` owner 中运行。lane 失败时，`dawn-screen-probe-failure-*` artifact 会在条件满足时保留 handoff JSON 与 GPU 原始 readback，包括尚未生成 motion capture 的失败。

| 文件 | 证据 |
|:--|:--|
| `handoff-result.json` | 测试状态、已完成控制项、GPU errors 与 phase 时间 |
| `handoff-raw-<side>-<mode>.bin` | 已完成 side/mode 控制项的原始 Screen/World ray 和 receiver readback |
| `motion-captures.json` 与 `*.rhitape` | 已生成的 Renderer motion 与 inspection capture |

读取 `handoff-result.json` 中的时间和状态字段。`jq '.controls | keys' handoff-result.json` 列出已完成的控制项。依据 `screen-probe-support.dawn.test.ts` 的 readback 布局检查对应 raw 文件；JSON 也保留后续 production-support 结果。保留 180 秒 case deadline 和全部原始控制项。见 [CI artifact 契约](../../scripts/ci/README.md#screen-probe-dawn-failure-evidence)。

## 验证

native Node 分歧用 [native-ray-query.yml](../../.github/workflows/native-ray-query.yml) 的 native-node-gi roster，设 FORGEAX_WEBGPU_NODE=wgpu-native、FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1。foundation 覆盖真实 auto-exposure histogram/readback，gather 覆盖 captured screen-probe depth-pyramid barrier regression。记录真实 adapter，native captures 与完整 Dawn evidence 分开保留。

```bash
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm exec tsc -b packages/rhi-debug/tsconfig.json --pretty false
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm --filter @forgeax/engine-rhi-debug exec vitest run --config vitest.config.ts src/__tests__
pnpm test:browser
pnpm test:dawn
```

使用受改动影响的 package/host gates，保留 artifact/命令输出。未运行的 browser/Dawn 不能标绿。
