# forgeax-rhi-wgpu-native

Private Rust native-wgpu owner for ForgeaX desktop hosts. The first consumer is
`apps/native-ray-query-triangle-tauri`, which proves platform-native Ray Query from a
packaged Tauri application.

## Boundary

The crate owns the native wgpu instance, adapter, device, queue, surface, acceleration structures,
Ray Query passes, readback, and structured failures. Consumers provide an owned raw-window-handle
source and call the narrow `RayQueryRenderer` lifecycle. They never receive a raw wgpu object.

This spike API is intentionally not a complete native RHI. The public TypeScript capability and
BLAS/TLAS vocabulary live in `@forgeax/engine-rhi` (§Hardware Ray Query); the crate-private
`acceleration` module mirrors it in Rust: `RayQueryCaps::from_device` derives `caps.rayQuery`
from device features and limits, `create_blas` / `create_tlas` /
`build_acceleration_structures` apply the same structural rules and lower to wgpu by field
rename. The `reference` transport builds its BLAS/TLAS through that module. The Node binding
(§Node binding) is the TypeScript consumer: a Renderer created over it in Node derives
`caps.rayQuery.supported === true` from the real adapter, so the automatic `ray-query` world
traversal runs on a GPU device, not only on RhiNull and this crate's parity tests.

Its GPU test traces an indexed two-instance scene (masks, scale, translation) from a compute
`ray_query` shader and compares hit, custom index, primitive index, and `t` with a CPU
Moller-Trumbore oracle, then refits moved geometry and instances on the same handles. It skips
without a Ray Query adapter unless `FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1`. Mesa lavapipe 25.2
exposes `VK_KHR_ray_query`, so CPU Vulkan runs it:
`cargo test --manifest-path packages/rhi-wgpu-native/Cargo.toml --features reference acceleration`
with that ICD selected.
wgpu 30 accepts `refit` (`ALLOW_UPDATE` + `PreferUpdate`) but still performs a full build.

The test-only `world_traversal_parity` module runs the render package's generated
world-trace kernels (`src/__tests__/fixtures/world-traversal/*.wgsl`, kept equal to
`worldTraversalWgsl` by `world-traversal.unit.test.ts`) on one scene through both
traversals. It composes the Global SDF with the production compose kernel, builds
BLAS/TLAS through `acceleration`, and checks: the `ray-query` fixtures validate only with
`Capabilities::RAY_QUERY`; Ray Query hits equal a CPU slab oracle exactly (status,
instance, `|dt| <= 1e-4 max(t,1)`, normal, Card radiance) for 1024 rays; the Global SDF
stays within stated tolerances (all hit, plane distance <= 1 voxel for >= 95 %,
`|dt|` <= 2 voxels for >= 95 %, radiance equal for >= 97 %); and a 0.02-thick wall
leaks no Ray Query ray while a masked-out wall leaks every admitted ray (falsifier):
`FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1 cargo test --manifest-path packages/rhi-wgpu-native/Cargo.toml world_traversal -- --nocapture`
with the lavapipe 25.2 ICD selected.

## Node binding (napi-rs)

`@forgeax/engine-rhi-wgpu-native` (this directory's `package.json`, TypeScript in `src/*.ts`)
gives Node a TypeScript RHI device over native wgpu 30.0.1 (DX12 on Windows, Vulkan on Linux, Metal on
macOS) with the Ray Query extension. The Rust half is the `cdylib` crate `node/` (napi-rs v3).

Why this crate and not an existing device:

| Candidate | Measured fact | Result |
|:--|:--|:--|
| Dawn-node `webgpu@0.4.0` | On Mesa 25.2.8 Lavapipe (which exposes `VK_KHR_ray_query` to wgpu here) the adapter reports 17 features, 0 named ray or acceleration | No Ray Query feature to request; Dawn reports `backend-has-no-ray-query` |
| `@forgeax/engine-wgpu-wasm` | wgpu 30, `default-features = false`, `webgl` only | No native backend in the WASM build |
| This crate | wgpu 30.0.1 native backends; BLAS/TLAS, compute Ray Query and the world-traversal kernels | Native owner with the capability; qualify each backend independently |

Shape. The addon does not grow a second RHI. `src/gpu.ts` + `src/encoder.ts` are a
W3C-WebGPU-shaped `GPU` (adapter, device, queue, resources, encoders, error scopes,
`uncapturederror`, `lost`) whose calls lower to the addon. `rhi` is the existing
`@forgeax/engine-rhi-webgpu` shim with adapters requested from that `GPU`, so validation,
error mapping, render-graph lowering and RHI Debug recording are the same code as the
browser and Dawn paths. An earlier design had a TypeScript shell implement `RhiDevice`
directly. That design was rejected: it would duplicate the rhi-webgpu shim, and the Dawn
test roster could not run unchanged over it.

- Objects cross as numeric table ids. A `FinalizationRegistry` drops collected entries, and
  `destroy()` drops them eagerly. Id 0 is the invalid object of a failed creation; its error
  already went through the device's error scopes.
- Descriptors cross as JSON.
- Command encoders and render bundles record in TypeScript and replay in one N-API call per
  `finish()`, so there are no per-draw crossings.
- `queue.submit` takes the finished ids.
- `mapAsync` and `onSubmittedWorkDone` resolve after a device poll.
- Uncaptured errors and device loss are drained on `setImmediate` after each mutating call.
- GPU objects serialize to `{}` like W3C objects, because RHI Debug snapshots descriptors
  with `JSON.stringify`.
- Ray Query is the wgpu extension shape that `@forgeax/engine-rhi-webgpu`'s
  `WebGpuAccelerationStructures` consumes:
  - device `createBlas` / `createTlas`, plus encoder `buildAccelerationStructures`;
  - the feature `wgpu-ray-query` (`RAY_QUERY_FEATURE`) and the four `RhiRayQueryLimits`
    limit names;
  - `caps.rayQuery` derived by `deriveRayQueryCaps`.

  The Renderer's device-feature admission requests that feature when the adapter offers it.
  On Metal, wgpu-hal places no barrier between an acceleration-structure build and a later
  traversal, and TLAS instances reference their BLAS outside Metal's hazard tracking. A
  consumer that builds and traverses in back-to-back submissions must settle the build
  (`onSubmittedWorkDone`) first; RHI Debug replay does this for every bootstrap rebuild.
  It is also the replay provider for ray-query tapes (`FORGEAX_WEBGPU_NODE=wgpu-native`).
- `executeBundles([])` executes one empty bundle of the pass layout. WebGPU resets pass
  state on every `executeBundles`; wgpu's empty list does not.
- `timestampPeriod` is exposed because wgpu does not normalize resolved timestamps.
  Raw counter integrity must be checked on the actual adapter. On the tested
  Apple M4 Pro/macOS 26.4.1, the original 30.0.1 Metal resolve returned zero or
  stale values even with actual GPU work. The Engine-pinned repair reserves
  sampling/resolve/continuation order and resolves after sampling completion.
  Empty or indirectly dispatched timestamped compute encoders without a nonzero
  direct dispatch use one side-effect-free kernel to materialize sample boundaries;
  its work is observer overhead, not free feature execution. The native owner
  regression verifies fresh raw pairs, attachment bytes, multiple resolves and
  one-row copies with omitted stride and nonzero offsets. Preserve failed raw
  values and reject qualification rather than substituting CPU time. The upstream
  investigation is [wgpu #9414](https://github.com/gfx-rs/wgpu/issues/9414).
  Render counters span
  vertex-stage start to fragment-stage end, while compute counters use encoder
  boundaries; attachment load/clear, resolve and store coverage is separate.
- `createNativeWindow` adds a same-process native presentation target. The host owns
  its window, the addon owns its Surface, and the ordinary TypeScript Renderer
  still owns World extraction, commands, submissions and completion (see below).

Delivery and failure. The addon is an opt-in local build. Nothing in `pnpm build:engine`, the
public SDK build or the default test roster compiles or requires it, and no `.node` binary
is committed (`native/` and `node/target/` are gitignored). Without the binary, every entry
returns `adapter-unavailable`, never a throw: `createGpu`, `createNativeWindow`, `installNavigatorGpu` and
`rhi.requestAdapter`. `nativeWgpuVersion()` returns `null`.

```sh
pnpm --filter @forgeax/engine-rhi-wgpu-native build:native   # cargo build --release -> native/*.node
```

### Portable prebuilt delivery contract

The Windows CI producer and `native:artifact pack|install` entry build and admit
source-matching artifacts. Relocated loading is checked on independent Node 22/24
CI runners, and physical DX12 tests run separately. Clean-machine distribution
qualification on a different CPU/GPU combination remains pending. CI artifacts
are diagnostic source-checkout transport, not a
published public SDK runtime. A release must be
portable between supported machines, not a copy of a workstation build cache:

- Identify artifacts by Engine/wgpu source identity, OS, CPU architecture,
  minimum supported OS and Node-API contract. The current addon targets Node-API
  8; Engine's supported Node range still applies. Pin the release Rust/MSVC/SDK
  producer inputs independently of whichever tools a developer has installed.
- Use the supported architecture baseline, never `target-cpu=native` or host-only
  instruction features. Exclude GPU/driver-specific shader and pipeline caches,
  local absolute paths, build directories and dependencies on the producer PATH.
- Admit the actual native import/dependency closure and verify every distributed
  file digest. The `static-dxc` build feature alone is not proof of a portable
  runtime closure. Any required runtime library must be shipped legally or named
  as a versioned runtime prerequisite; Rust, MSVC Build Tools and Windows SDK
  must not be required on consumer machines.
- Validate download, checksum, relocation, loading and real DX12 BLAS/TLAS plus
  Ray Query on a separate clean Windows x64 machine without the build toolchain,
  producer environment or source checkout. Cover a different CPU/GPU combination
  and every advertised Node compatibility lane. Unsupported adapters must report
  capability absence through the existing structured contract.

A build-host pass or a local `FORGEAX_RHI_WGPU_NATIVE_ADDON` override does not
qualify distribution. Automatic source rebuilding on the consumer is not a
recovery path for a missing or incompatible released artifact.

The [Windows prebuilt workflow](../../.github/workflows/native-ray-query-windows-prebuilt-nightly.yml)
is dispatched explicitly by maintainers in the native nightly lane, outside daily
PR/source initialization. It builds a generic x86-64, static CRT/DXC addon and admits normal and delay-load PE
imports, retains binary digests and canonical LF source identities, and loads the
relocated output on separate Node 22.13/24 runners with a Node-only child PATH.
When an adapter is available, the consumer must create a device, compile WGSL,
dispatch a compute kernel and read back the exact value 42 with an empty validation
error queue. This exercises the runtime compiler closure rather than only loading
the addon. Adapter absence is reported explicitly; it is not a compute pass.
Those probes explicitly report `hardwareQualified: false`; a hosted loading pass
cannot substitute for physical DX12 acceleration and Renderer evidence.

After downloading the trusted, source-matching CI artifact, install it explicitly:

```sh
pnpm --filter @forgeax/engine-rhi-wgpu-native native:artifact install <artifact-directory>
```

Admission checks the current Node/Rust source closure and pinned clean wgpu
source before replacing the local addon. Neither install nor source setup compiles
it automatically.

| Environment variable | Effect |
|:--|:--|
| `FORGEAX_WEBGPU_NODE=wgpu-native` | `config/vitest.setup-webgpu.ts` and `apps/hello/gi/scripts/gi-dawn.mjs` install this `GPU` as `navigator.gpu` instead of Dawn, so `*.dawn.test.ts` and the hello-gi scripts run unchanged on it. A missing addon fails setup with `wgpu-native-binding-failed`. |
| `FORGEAX_WGPU_NATIVE_RAY_QUERY=off` | Withholds `wgpu-ray-query` from the adapter. The same device then runs the Global SDF traversal for A/B comparison. |
| `FORGEAX_RHI_WGPU_NATIVE_ADDON=<path>` | Load the addon from `<path>` instead of `native/forgeax-rhi-wgpu-native.<platform>-<arch>.node`. |

Example run under Lavapipe (Mesa 25.2.8, Vulkan llvmpipe):

```sh
FORGEAX_WEBGPU_NODE=wgpu-native with-lavapipe pnpm exec vitest run --project @forgeax/engine-rhi-webgpu <file>.dawn.test.ts
FORGEAX_WEBGPU_NODE=wgpu-native with-lavapipe node apps/hello/gi/scripts/smoke-dawn.mjs
```

Known differences from Dawn are listed below. Each is visible as data, never as a crash:

- Dawn-specific live probes (`rgba16float-live-probe`,
  `rhi-wgpu dawn-texture-dimensions`) report their gate as unavailable.

## Native window and TypeScript Renderer

`createNativeWindow({ width, height, title? })` returns a `Result<NativeWindow,
RhiError>`. Call it on Node's main thread. It creates a real winit window and
wgpu Surface; `window.gpu` requests only Surface-compatible adapters and
`window.rhi` uses the existing WebGPU shim. Install `window.gpu` with
`installNavigatorGpu(window.gpu)` before constructing a Renderer over `window.canvas`.
The canvas is a small native context target, with no DOM identity, HTML canvas,
Rust World, per-draw async IPC or readback presentation.

Another same-process GUI host can construct the same Rust `NativeWindow` through
`unsafe NativeWindow::from_host(Box<dyn NativeWindowHost>)`, then pass that opaque
N-API object to `bindNativeWindow(native)`. The host supplies borrowed native
handles, display facts and event operations, and retains the drawable until RHI
releases its acquired frame and Surface. RHI owns the sole Surface/device path;
the external-host seam imports no Tauri/GTK, HTML/CSS or application message transport. `node/` also
builds an `rlib` for this native linking seam. The
[DevKit Tauri fixture](../devkit/scripts/fixtures/tauri-native-host/README.md)
uses it with an ordinary TypeScript World/Renderer and a real sibling WebView.

The native owner synchronously pumps one winit event loop shared by the process's
windows. `pollEvents()` returns bounded latest redraw/display/visibility facts,
close requests and surface loss. `facts()` reports actual physical size, native
scale and visibility; it is the window's display authority. The host calls
`requestRedraw()`, admits frames, handles `close-requested` and pauses on unavailable
extents. Polling or redraw does not advance World and proves no GPU completion.
`resize(width, height)` requests a native extent; subsequent facts confirm the
actual result. `window.canvas.width` and `.height` are read-only observed facts;
use `window.resize()` to request a native change. A changed extent reconfigures the acquired Surface on the next frame.

Each acquired texture belongs to one configured device. Only an accepted queue
submission referencing that image presents it. Unrelated uploads and empty submits
leave it acquired; native validation rejects failed/stale submissions. Presentation
expires the texture and retained views. Completion remains the existing GPU queue
fence and `FrameReceipt.completed`, never an event or presentation acknowledgement.
Device retirement unconfigures its surfaces; Renderer recovery may create a new
device for the same live native window. Close is idempotent and rejects late use;
close/recreate reuses the native event loop. Dispose the Renderer before closing
its host window. A raw `GPUCanvasContext` operation throws its normal error;
window entry/lifecycle operations expose `RhiError` Results.

The context advertises `supportedAlphaModes` directly from wgpu SurfaceCapabilities.
Renderer negotiates those facts; unsupported alpha, color space, usage or format is
rejected explicitly. This path currently admits standard sRGB presentation and
makes no claim of a transparent WebView overlay. The opt-in dependency is exact
`winit = 0.30.13`, `rwh_06` + `x11`, resolved in `node/Cargo.lock`; the existing
Engine-pinned wgpu source and release-build ownership remain unchanged.
Linux requires an X11 display and its Xlib/XCB/xkbcommon runtime libraries. The
Node addon is still contributor-only, opt-in, and absent from default/public SDK
builds; its binary is never committed or published by the package manifest.

```sh
pnpm --filter @forgeax/engine-rhi-wgpu-native build:native
pnpm --filter @forgeax/engine-rhi-wgpu-native build
# Reuse apps/hello/triangle/dist/shaders/manifest.json; build hello-triangle if absent.
node packages/rhi-wgpu-native/scripts/smoke-window.mjs
```

The fixture exercises the ordinary TypeScript World and public `createRenderer`,
60 completed frames, actual resize, invalid stale texture/view use, device
recovery, close and recreation. `NATIVE_WINDOW_EVIDENCE` selects its report
folder; `NATIVE_WINDOW_HOLD_MS` optionally holds visible checkpoints for an
external desktop capture. It never copies GPU readback into the window. Linux
X11/Vulkan evidence qualifies this Node seam only. The separate DevKit fixture
qualifies its Tauri loop, native Surface and WebView control transport on Linux;
application packaging, macOS/Windows Surface behavior and input/audio assembly
require their own actual consumers and evidence.

## Commands

```sh
cargo test --manifest-path packages/rhi-wgpu-native/Cargo.toml
cargo check --manifest-path packages/rhi-wgpu-native/Cargo.toml
cargo run --release --manifest-path packages/rhi-wgpu-native/Cargo.toml --features conformance --bin ray-query-conformance -- --profile core
```

The implementation uses the Engine-pinned `third_party/wgpu` source, initially
the unmodified wgpu `30.0.1` release. Contributor setup and SDK source delivery are
defined in [third-party source](../../third_party/README.md).
The crate compiles only Metal on macOS, DX12 on Windows and Vulkan on Linux; all lanes share the same
renderer, acceleration structures, shaders, readback, and verifier.

The non-default `conformance` feature owns the shared native case registry, structured GPU
observations, CPU oracle, report schema, stability profiles, and importers for packaged Tauri and
pinned upstream evidence. It remains outside the desktop product binary.

The explicit `performance` profile runs bounded grid scenes with 64 / 4,096 /
65,536 triangles and 4,096 / 65,536 / 262,144 shared parallel rays. Query timings
retain 5 warmups, 31 alternating pairs, raw GPU counters, every-ray oracles and
an empty-TLAS falsifier. Software BVH construction is CPU work and is labelled
separately; uploads and readbacks stay outside query timing. The compaction case
compares source and compacted query distributions. These native microbenchmarks
do not measure end-to-end Engine GI or frame performance.

An opt-in upstream diagnostic artifact can be executed without local C++ build
tools using `scripts/run-wgpu-upstream-prebuilt.mjs GPU_ARTIFACT NAGA_ARTIFACT
OUTPUT`. It retains upstream GPU test names and screenshot thresholds, admits
the actual Engine wgpu pin and rejects automatic screenshot re-baselining.
The upstream test binaries embed a source root; their diagnostic fixture bundle
is separate from the portable product addon. Naga's original compiler snapshots
run on the producer CPU lane, while GPU tests and examples run on the local
physical DX12 adapter. Neither entry is a basic initialization dependency.

### Windows DX12 qualification

Windows builds need Rust's MSVC toolchain, Visual Studio C++ Build Tools and a
Windows SDK. Select the x64/x86 MSVC tools, Windows 11 SDK and C++ ATL component
(`Microsoft.VisualStudio.Component.VC.ATL`): the static DXC link requires `atls.lib`.
These are source-producer inputs, not consumer runtime dependencies.
Both native manifests enable `dx12` and `static-dxc`; the compiler
is linked into the native artifact. An FXC-only device cannot expose this wgpu
Ray Query route, which requires DXR tier 1.1 and shader model 6.5 or later.
The native adapter must report `backend: "Dx12"`; a Vulkan, WARP or browser
fallback does not qualify the Windows hardware route.

Run the existing conformance, acceleration, world-traversal, timestamp and
Renderer GI gates on the actual adapter. `FORGEAX_WEBGPU_NODE=wgpu-native`
selects the Node carrier; `FORGEAX_WGPU_NATIVE_RAY_QUERY=off` retains the
same DX12 device for the Global SDF control. Preserve adapter facts, errors,
RHI tapes, raw readbacks and falsifiers. A source/configuration change or an
accepted Metal report is not Windows GPU acceptance.

Surface-based desktop smokes require a logged-in interactive user desktop on
Windows. A Session 0 service runner can fail during the initial surface
configuration even when offscreen DX12 Ray Query passes. Run the packaged Tauri
smoke in the user desktop and retain its lifecycle report; use offscreen
conformance for service runners. Missing presentation context is distinct from
missing adapter capability and does not require Graphics Tools.

### Optional DX12 hit-vertex-return diagnostics

The desktop native owner accepts Windows DX12 backend options and debugging flags
from wgpu's environment variables while retaining its required DX12 backend.
The optional SM 6.10 experiment uses an independent Agility device factory:
`WGPU_DX12_AGILITY_SDK_PATH`, `WGPU_DX12_AGILITY_SDK_VERSION=721`,
`WGPU_DX12_AGILITY_SDK_REQUIRE=1`,
`WGPU_DX12_EXPERIMENTAL_SHADER_MODELS=1`, and
`WGPU_DX12_COMPILER=dxc` with the official preview DXC DLLs on the process DLL
search path. Preview SDKs require Windows Developer Mode. DX12 reports the feature
only when both the device and compiler support SM 6.10; the default static DXC
and system-runtime route retains its own capability result.

Conformance RQ-08 reads back all candidate and committed vertex positions for
indexed and non-indexed triangles, checks source/index order and object space
under a translated TLAS, and rejects nonzero miss positions. Raw rows are retained
in the case JSON. The Node carrier's public extension remains Ray Query; this
experiment does not expand its admitted feature or descriptor vocabulary.

This is an explicit maintainer diagnostic. Preview SDK/DXC, Developer Mode,
Graphics Tools and Dawn are never prerequisites for the basic source setup,
build or unit-test flow. Graphics Tools supplies optional DXGI/D3D12 API validation;
missing validation components remain visible in the qualification evidence.

Windows 11 still provides the Graphics Tools capability. If Settings does not
list it, an administrator can discover its exact name and install it from an
elevated PowerShell session:

```powershell
Get-WindowsCapability -Online -Name 'Tools.Graphics.DirectX*' |
  Where-Object State -EQ NotPresent |
  ForEach-Object { Add-WindowsCapability -Online -Name $_.Name }
```

Check its state with `Get-WindowsCapability -Online -Name 'Tools.Graphics.DirectX*'`;
an unfinished download or a pending reboot is not an installed component.
For native API/GPU validation, explicitly set `WGPU_VALIDATION=1` and
`WGPU_GPU_BASED_VALIDATION=1`. `WGPU_DEBUG=1` only requests shader debug information.
Retain debug-layer messages as well as test results; an exit code alone cannot
establish that validation was available or free of errors. See Microsoft's
[Graphics Tools installation instructions](https://learn.microsoft.com/en-us/windows/ai/directml/dml-debug-layer).

The Windows Node instance reads the same validation and DX12 runtime environment
options as the desktop instance. After explicitly building the addon and installing
Graphics Tools, run `pnpm --filter @forgeax/engine-rhi-wgpu-native validate:dx12-debug <output-directory>`.
This opt-in integration regression creates real physical DX12 Ray Query devices in
separate processes with validation disabled and enabled, captures D3D12 startup
messages and loaded modules, and rejects a silently ignored GPU validation switch.
Its report qualifies device/validation admission only; run actual Renderer and
ray-query workloads separately to establish API/GPU validation success.

The collector follows only processes it creates and their descendants. A root
exit does not retire a still-running WebView child: the collector drains those
events before returning, keeps the original deadline, and terminates/detaches
its own remaining processes on failure or timeout. Its Windows process
regression runs in the optional prebuilt producer and checks consecutive
collections, late child output and timeout recovery. Event-owned process/thread
handles follow [Windows debugging-event ownership](https://learn.microsoft.com/en-us/windows/win32/debug/debugging-events).

An installed Graphics Tools capability does not prove that the system's
`D3D12Core.dll` and `d3d12SDKLayers.dll` have matching versions. A mismatched pair
can reject validation device creation with `0x887A002D`; retain that failure.
For an explicit maintainer diagnostic, select the core and layer from the same
official Agility package using `WGPU_DX12_AGILITY_SDK_PATH`, its matching
`WGPU_DX12_AGILITY_SDK_VERSION`, and `WGPU_DX12_AGILITY_SDK_REQUIRE=1`.
This does not replace system servicing or qualify the system-runtime lane.

The tested Agility 721 preview layer emits
`NON_RETAIL_SHADER_MODEL_WONT_VALIDATE` for SM 6.10 shaders: API/device validation
can be enabled while shader and PSO validation is skipped. Keep the SM 6.10
functional readbacks separate from stable-runtime GPU validation, and never
count the startup message alone as shader validation coverage.

## Opaque scene reference transport

The opt-in `reference` feature adds `reference::run_batch` and the `ray-reference`
stdin/stdout executable. It consumes the u32 words of the portable reference's
world-space triangle and ray buffers (80/48 bytes per record), creates a fresh
native device and opaque BLAS/TLAS, and returns 32-byte hit records plus adapter
facts. Limits are 1,024 instances, 65,536 triangles and 65,536 rays; malformed
records fail before GPU creation. An empty triangle list is supported.

This is a scene-level bridge for differential validation. It admits no BLAS build
transforms, dynamic query flags or custom candidate filtering, and claims no fix
for the pinned wgpu issues. It neither implements a generic native TypeScript RHI
nor records native AS commands in `.rhitape`. Keep it outside default production
and browser compilation; the portable shader requires no native WGSL extension.
See [reproduction and layouts](../../scripts/raytracing/README.md).

The TypeScript object model separates device/queue factories (`src/gpu.ts`),
command recording (`src/encoder.ts`) and native device children (`src/objects.ts`).
Both factories and encoders consume the same opaque objects; their shared resource
owner keeps finalization, mapping, borrowed texture expiry and retained references.
Its device dependency is type-only, so command recording has no runtime import
cycle with device construction.
