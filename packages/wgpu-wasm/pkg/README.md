# @forgeax/engine-wgpu-wasm

## Native host binding

The Node-only `./native-build` entry exports `buildNativeWgpu({ out })`. It refuses
existing output, verifies the canonical WASM/glue against the publisher's provenance, and
derives a native module from the qualified bindgen ABI. The generated module keeps
the raw ABI wrappers and finalizer, replaces the browser loader, and records the
canonical receipt plus generator, initializer, derived-glue and declaration digests.
The generated `wgpu-native.d.mts` retains the raw classes and exposes the typed
native initializer without the browser loader. This build-only conversion needs
the published artifact, not a local Rust checkout. Source builds separately require
`verify-current.mjs` to match the current complete source closure.
Generated runtime and declaration imports use the public
`@forgeax/engine/wgpu-wasm/native-host` entry, whose SHA-256 export resolves the
integrity dependency inside the complete Engine package. Consumers need only
the umbrella installation; no transitive hash package is required beside output.

The `third_party/wgpu` gitlink owns the maintained wgpu 30 source shared with native hosts, including
the WebGL index/non-index buffer-copy repair. Cargo uses that source and one Naga
instance; `content-key.mjs` fingerprints its source tree as well as this crate.
Contributor setup initializes this dependency; SDK source includes the exact
expanded source and licenses. See [Third-party source](../../third_party/README.md).

Its `initializeNativeWgpu(host)` uses the realm-neutral `./native-host` contract:
immutable packaged byte reads, native instantiation, and the actual borrowed
canvases. It verifies WASM SHA-256 and admits those canvases and their returned
WebGL2 context identities when native hosts lack browser constructors. Existing
browser constructor checks remain valid, including real 2D canvases supplied to
`copyExternalImageToTexture` outside the presentation surface list. Plain lookalike
objects remain rejected; no global constructors, fetch or WebAssembly interception
is involved. The same
host shares one Promise. Pre-finalization failures can retry, while a failed Rust
start requires a new realm. Successful initialization cannot replace its host.

External image copying retains wgpu's WebGL downlevel restrictions: OffscreenCanvas
sources, nonzero source origins and non-sRGB destinations require the unavailable
`UNRESTRICTED_EXTERNAL_TEXTURE_COPIES` flag. ImageBitmap copies additionally require
`flipY: false` and `premultipliedAlpha: false`. Native admission never invents those
capabilities.

`RhiWgpuAdapter.requestDevice` retains downlevel WebGL2 resource requirements and
uses the adapter's reported texture resolution limits. This admits high-DPR
presentation surfaces such as 2532×1170 when supported, without replacing actual
hardware validation with the downlevel 2048 baseline. A surface beyond the granted
maximum still fails through the existing structured configuration error.

The native binding is an additional target artifact derived from the same canonical
WASM; it does not alter the browser or Node artifact. Its output and actual bundled
dependency closure must enter the target publication inventory. Simulator RHI
initialization and clear pixels have passed; a complete DevKit game remains a
separate integration gate.

> Merged wgpu 30 + naga 30 wasm-bindgen crate. **AI 用户不应 import 此包** —— 仅对 `@forgeax/engine-rhi-wgpu` + `@forgeax/engine-naga` 两薄壳暴露 raw bindings。

## 命题（charter 命题 1 渐进披露 + 命题 5 一致抽象）

本包是 wgpu RHI + naga 三段 shader pipeline 的物理底层 — 一份 wasm artefact 同时持两条独立的 wasm-bindgen surface：

- `rhi.rs` → wgpu 30 RHI raw bindings（14 opaque handle + 17 描述符 + factory 入口 + queue / command-encoder 段）；上层由 `@forgeax/engine-rhi-wgpu` TS 薄壳包装为 `@forgeax/engine-rhi` 接口形态。
- `naga.rs` → naga 三段函数（parse / validate / emit_reflection）；上层由 `@forgeax/engine-naga` TS 薄壳包装为 `Result<T, ShaderError>` 形态，再由 `@forgeax/engine-shader-compiler` 在 build-time 消费。

`getCompilerFingerprint()` exposes the existing provenance fingerprint of the
successfully initialized native owner. It shares the `ensureReady()` load and
integrity checks; it does not infer an executing compiler identity from disk
metadata alone. Build consumers use the Naga wrapper's Result form. A failed
verification or initialization exposes no identity and remains retryable.

合并的工程理由（research F-3）：两侧底层共享 wgpu 与 naga（Cargo dedup 保证同版本 naga 唯一实例），合并后单 wasm 体积估算 0.66–0.9 MB gzip，相对独立两包总和小 10–15%。AI 引擎用户在主路径（`navigator.gpu` 探测成功）下根本不下载这份 wasm（rhi-webgpu thin shim 直传 navigator.gpu），lazy-load 仅在非浏览器场景或显式 escape hatch 触发。

## 不向 AI 用户暴露的理由

AI 引擎用户的工程模型是「`Engine.create({ canvas })` → `world.spawn(5 component)` → `renderer.draw(world)`」三步串联，对 wasm raw bindings 一无所知也应正常工作（charter 命题 1 渐进披露 + 命题 5 一致抽象红线）。本包的 `wasm.requestAdapter() / wasm.parse(source)` 等顶层符号是 thin shell 的实现细节，不进 AGENTS.md `## Packages` 表的发现入口（feat-20260511-naga-rhi-wgpu-merge 兑现）。

## Implemented Methods

### Instance

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `RhiWgpuInstance.create()` | -- | `RhiWgpuInstance` | stable |
| `requestAdapter()` | -- | `JsValue` (adapter or null) | stable |
| `requestAdapterWithCanvas(canvas)` | `HtmlCanvasElement` | `JsValue` (adapter or null) | stable |
| `createSurface(canvas)` | `HtmlCanvasElement` | `Result<RhiWgpuSurface, JsValue>` | stable |

### RhiWgpuAdapter

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `features` | -- | JS `Set<string>` of advertised feature names | stable |
| `requestDevice(options?)` | Optional `{ requiredFeatures: string[] }` | `Result<RhiWgpuDevice, JsValue>` | stable |

Feature requests are forwarded to wgpu, including `depth32float-stencil8` for
Engine Reverse-Z targets. Unknown names reject at this boundary; unsupported
features reject during device creation. No request silently drops required
features.

### RhiWgpuDevice

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `features` | -- | JS `Set<string>` of features actually enabled on the device | stable |
| `get queue` (getter) | -- | `RhiWgpuQueue` | stable |
| `createBuffer(desc)` | `BufferDescriptorJs` | `RhiWgpuBuffer` | stable |
| `createTexture(desc)` | `TextureDescriptorJs` | `Result<RhiWgpuTexture, JsValue>` | stable |
| `createSampler(desc)` | `SamplerDescriptorJs` | `Result<RhiWgpuSampler, JsValue>` | stable |
| `createBindGroupLayout(desc)` | `BindGroupLayoutDescriptorJs` | `Result<RhiWgpuBindGroupLayout, JsValue>` | stable |
| `createPipelineLayout(desc)` | `PipelineLayoutDescriptorJs` | `Result<RhiWgpuPipelineLayout, JsValue>` | stable |
| `createBindGroup(desc)` | `BindGroupDescriptorJs` | `Result<RhiWgpuBindGroup, JsValue>` | stable |
| `createRenderPipeline(desc)` | `RenderPipelineDescriptorJs` | `Result<RhiWgpuRenderPipeline, JsValue>` | stable |
| `createComputePipeline(desc)` | `ComputePipelineDescriptorJs` | `Result<RhiWgpuComputePipeline, JsValue>` | stable |
| `createShaderModule(code)` | `&str` (WGSL source) | `RhiWgpuShaderModule` | stable |
| `createCommandEncoder(desc)` | `CommandEncoderDescriptorJs` | `Result<RhiWgpuCommandEncoder, JsValue>` | stable |
| `createQuerySet(desc)` | `QuerySetDescriptorJs` | `Result<RhiWgpuQuerySet, JsValue>` | stable |
| `createRenderBundleEncoder(desc)` | `RenderBundleEncoderDescriptorJs` | `Result<RhiWgpuRenderBundleEncoder, JsValue>` | stable |
| `createBuffer2(desc)` | `BufferDescriptorJs` (Result-returning variant) | `Result<RhiWgpuBuffer, JsValue>` | stable |

### RhiWgpuBuffer mapping

`mapState` follows one native mapping lifetime. `getMappedRange(offset?, size?)`
returns a JavaScript copy retained only until unmap or destruction. Creation
mapping and `mapAsync(WRITE)` commit each disjoint returned range at unmap;
`mapAsync(READ)` discards edits. Pending-map cancellation cannot complete a later
mapping, and invalid or overlapping ranges reject before entering wgpu's
panicking slice API. Repeated unmap is a no-op.

Returned copies detach through host `ArrayBuffer.transfer` or transferable
`structuredClone` when available. Without either primitive, they remain inert
ordinary arrays after retirement; byte-length detachment is the explicit host
limitation. No mapping bytes persist in a parallel buffer catalogue.

### RhiWgpuCommandEncoder

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `beginRenderPass(desc)` | `RenderPassDescriptorJs` | `Result<RhiWgpuRenderPass, JsValue>` | stable |
| `finish()` | -- | `RhiWgpuCommandBuffer` | stable |

### RhiWgpuRenderPass

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `setPipeline(pipeline)` | `&RhiWgpuRenderPipeline` | -- | stable |
| `setVertexBuffer(slot, buffer, offset, size)` | `u32, &RhiWgpuBuffer, u64, Option<u64>` | -- | stable |
| `draw(vertexCount, instanceCount, firstVertex, firstInstance)` | `u32, Option<u32>, u32, u32` | -- | stable |
| `drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance)` | `u32, Option<u32>, u32, i32, u32` | -- | stable |
| `end()` | -- | -- | stable |

### RhiWgpuQueue

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `submit(commandBuffers)` | `js_sys::Array` of `CommandBuffer` | `Result<(), JsValue>` | stable |
| `writeBuffer(buffer, offset, data, dataOffset, size)` | `&RhiWgpuBuffer, u64, &[u8], Option<u32>, Option<u32>` | `Result<(), JsValue>` | stable |
| `onSubmittedWorkDone(driver)` | private RHI completion driver | `Result<Promise, JsValue>` | stable |

### RhiWgpuSurface

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `configure(desc)` | `SurfaceConfigurationJs` | `Result<(), JsValue>` | stable |
| `getCurrentTexture()` | -- | `Result<RhiWgpuSurfaceTexture, JsValue>` | stable |

### RhiWgpuSurfaceTexture

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `getTexture()` | -- | `RhiWgpuTexture` | stable |

### Opaque handle types (14 total)

`RhiWgpuInstance`, `RhiWgpuAdapter`, `RhiWgpuDevice`, `RhiWgpuQueue`, `RhiWgpuBuffer`, `RhiWgpuTexture`, `RhiWgpuSampler`, `RhiWgpuBindGroupLayout`, `RhiWgpuPipelineLayout`, `RhiWgpuBindGroup`, `RhiWgpuRenderPipeline`, `RhiWgpuComputePipeline`, `RhiWgpuShaderModule`, `RhiWgpuCommandEncoder`, `RhiWgpuRenderPass`, `RhiWgpuQuerySet`, `RhiWgpuRenderBundleEncoder`, `RhiWgpuCommandBuffer`, `RhiWgpuSurface`, `RhiWgpuSurfaceTexture`

## 构建 / 获取 pkg/

`pkg/`（`wgpu_wasm_bg.wasm` + `wgpu_wasm.js` glue + 两个 `.d.ts` + `package.json`）是 wasm-pack 产物，**不入 git**（ufbx 式 release，对齐 `packages/fbx/`）。两条获取路径：

包的 `files` 明确列出这组产物及 README、provenance。wasm-pack 生成的
`pkg/.gitignore` 会排除整个目录；只声明 `"pkg"` 无法保证 npm 发布或独立运行快照
包含绑定。逐文件声明保持原生成目录和忽略规则，同时交付完整的 JS/WASM 闭包。

```bash
# A. 有 Rust 工具链 —— 本地构建（首次或 src/*.rs / Cargo.* 改动后）
bash packages/wgpu-wasm/build.sh            # 或 pnpm -F @forgeax/engine-wgpu-wasm build:wasm

# B. 无 Rust 工具链 —— 从 wasm-artifacts release 拉预构建 bundle
pnpm -F @forgeax/engine-wgpu-wasm fetch-wasm
```

路径 A 需 Rust ≥ 1.93 + `wasm32-unknown-unknown` target + `wasm-pack`（详见 [CONTRIBUTING.md](../../CONTRIBUTING.md) §Rust toolchain）。`rust-toolchain.toml` 在本目录 pin 1.93，rustup 通常自动应用；若未生效，跑 `rustup show` 检查。

路径 B 由根 `postinstall` 在 `pkg/` 缺失时**非致命**自动执行（离线 / 私仓无 `GITHUB_TOKEN` / bundle 未发布时仅告警，不阻断 `pnpm install`）。共享下载器先用 Node `fetch`，握手失败时依次尝试 `gh` 和平台原生 `curl`（Windows 为 `curl.exe`）；所有路径仍锁定当前仓库、`wasm-artifacts` tag 和 content-keyed asset。release 资产按内容 hash 命名（`scripts/content-key.mjs` 覆盖 `src/**/*.rs` + `Cargo.{toml,lock}` + `rust-toolchain.toml` + `build.sh`），CI `publish-wgpu-wasm-release` job 在 main push 时打包发布——源码改一次，asset 名随之变，**旧 stale `pkg/` 无从被服务**（根治 `.d.ts` 与 `rhi.rs` 漂移）。

> `pnpm -F @forgeax/engine-wgpu-wasm build`（无 `:wasm`）只跑 `tsc -b` + tsup，围绕已存在的 `pkg/` 重建 JS shim；不生成 `pkg/`——先经路径 A 或 B 备好。

## 体积承诺

`forgeax.metrics.bundle-size` 阈值 5 MB（gzip），与 `@forgeax/engine-rhi-wgpu` 旧 baseline 同源（feat-20260511-rhi-wgpu-impl 实测 0.51 MB → 本闭环合并 naga 后预计 0.66–0.9 MB；超 1 MB 触发 RK-3 评审 wasm-opt -Oz override，超 5 MB 触发 fail-fast block）。

## Render bundle lifetime

`RhiWgpuRenderBundleEncoder` retains native command resources until `finish`, then
creates one immutable `RhiWgpuRenderBundle`. Executing bundles reads their live
registry identities without consuming the JS objects. Dropping a bundle removes its
registry entry; submitted native work retains its own resource references. Encoder
descriptors and temporary commands are released after finish instead of being leaked.

The WebGL2 `mapAsync` path polls the buffer's own device and yields between pending
polls. This completes readback even after the final submission and delivers mapping
errors through the existing Promise/Result boundary. It does not poll other devices.
The native mapping callback also wakes its existing request immediately, preserving
the required mapping-before-queue Promise order when another operation polls the
device. Cancellation still checks the same mapping identity before state adoption.

The producer-derived native binding admits ASTC only through the host's actual
profile query. Some WeChat devices expose the extension object without
`getSupportedProfiles`; the pinned import ABI returns `None` in that case, so
wgpu declines both LDR and HDR ASTC capabilities. Available queries retain the
generated externref encoding, native receiver and original failures. No native
object or browser global is changed.

## Source compiler execution budget

The release Rust profile optimizes execution at level 3. Full Engine source
production repeatedly parses and composes real Naga modules, so size-only
optimization consumed the original build deadline. The existing 5 MiB gzip
metric remains unchanged. Source code, validation and the complete variant fleet
remain the same; generated bundles keep their source key, byte hashes and
compiler fingerprint. See the [measured source compiler recovery](../../scripts/ci/README.md#failure-recovery).

## Per-frame command lifetime

Command-encoder and render-pass labels are borrowed only while wgpu creates the
command. The decoded pass descriptor owns temporary color, resolve, and
depth/stencil view clones; wgpu retains the submitted work's own references.
Temporary attachment arrays and view clones are released when `beginRenderPass`
returns, including descriptor failure paths. `RenderPass::forget_lifetime` keeps
wgpu's runtime encoder lock while the JS pass remains active.

Queue submission consumes each JS command-buffer handle once and drops its
emptied Rust wrapper. Invalid, repeated, or same-batch duplicate command buffers
return `queue-submit-failed`; fresh submissions remain usable afterward.

The raw queue's `onSubmittedWorkDone(driver)` gives the RHI-private JavaScript
driver a synchronous registration closure and the previous queue Promise. The
closure registers with the native wgpu submission and returns one
`RhiWgpuCompletionRequest`; its synchronous `poll()` checks context loss, polls
the same device and reads the actual completion callback flag. It reuses the submission's
HAL fence and lets wgpu retire completed resources; no second WebGL fence or
flush is added for a receipt. All queue wrappers obtained from one device share
the same FIFO promise chain. Context loss, failed device polling and bounded
polling exhaustion reject. Native polling stays outside Rust futures so a thrown
host call or WASM trap cannot strand the Promise and all later FIFO requests.
The driver explicitly frees each ticket; a native abort that prevents release
reports both failures and requires retiring that realm. This carrier explicitly selects the GL backend;
browser WebGPU remains with `rhi-webgpu`. App frame credits and surface
presentation keep their existing owners.

The real WebGL regression repeats 180 completed submissions with color and
depth/stencil passes and pixel readbacks. Large labels amplify temporary leaks
within bounded 60-frame batches; the assertion bounds WASM linear-arena growth
after warmup. It is not a scene memory benchmark, a driver-memory measurement, or
a claim about persistent token-registry retirement.

## Binding resource lifetime

Texture-view, sampler and bind-group-layout tokens are valid only while their
WASM wrappers are alive. Dropping a wrapper removes its registry entry; already
created native bind groups and pipeline layouts retain their own references.
Descriptor lookup borrows tokens and never consumes the source JS handles or
reads their raw pointers. A cached token cannot re-admit a retired wrapper.

Bind-group descriptors own temporary resource clones and borrow their label,
layout and entries only through native creation. Texture-view and sampler labels,
and bind-group-layout entries and labels, follow the same scope. Parsing and
native validation failures release those temporaries before returning the error;
they do not leave an uncaptured validation error for the next submission.

`native-binding-lifetime.browser.test.ts` measures identical completed 60-frame
batches of view, bind-group, sampler and layout creation/release, including labels
and descriptor failures. It permits at most four WASM pages of growth after
warmup, and verifies sampled pixels after releasing the source wrappers. These
bounded allocator regressions do not claim that other registries, JS memory or
driver memory are fully retired.
