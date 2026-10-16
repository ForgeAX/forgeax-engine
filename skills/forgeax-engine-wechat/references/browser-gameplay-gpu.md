# Native Browser gameplay GPU elapsed diagnosis

Use this when ordinary gameplay has prompt rAF/timer callbacks and high CPU idle,
but native completion remains delayed. Fence age measures when completion becomes
observable, not GPU execution time. Preserve the same publication, viewport,
quality, gameplay contacts and App pacing policy; run this as a separate intrusive
diagnostic after host headroom is established. Timer queries can change the driver's
command-buffer boundaries. This run does not establish ordinary-loop FPS, even
when the JavaScript wrapper adds no explicit flush or wait.

The existing runner exposes this mode through `--trace gpu`; `--help` lists its
arguments without opening a browser or acquiring the GPU lease:

```sh
node skills/forgeax-engine-wechat/scripts/run_gameplay_benchmark.mjs --help
```

`scripts/browser_gameplay_gpu.mjs` installs a page-local API before the game loads.
The Browser benchmark Host passes the actual instantiated wgpu WASM through its
opt-in `project` seam. It copies exports into an ordinary object, preserving every
unwrapped function, memory and table identity; it never mutates frozen native
exports or rebuilds WASM. Without the installed global, the Host returns its normal
WASM instance unchanged.

```js
await page.addInitScript({ content: browserGameplayGpuSource({ capacity: 1024 }) });
// Load the ordinary Browser benchmark and qualify real gameplay first.
await page.evaluate(() => __forgeaxGameplayGpu.start());
// Run the existing measurement window and contacts without changing frame pacing.
await page.evaluate(() => __forgeaxGameplayGpu.stop());
// Use the benchmark's existing App pause/drain outside the window.
const report = await page.evaluate(() =>
  __forgeaxGameplayGpu.collect({ timeoutMs: 2000, pollIntervalMs: 16 }));
const cleanup = await page.evaluate(() => __forgeaxGameplayGpu.dispose());
```

Keep both report and cleanup even when drain fails. `snapshot()` reads retained
observations only; it never polls GL. `stop()` only closes recording. `collect()`
rejects while recording and performs bounded availability polling afterward.
`dispose()` releases all query objects, restores the projected exports, makes
previously cached wrappers passive and removes the installed global. Installation
is one-shot; use a fresh page for another window.

Two independent `EXT_disjoint_timer_query_webgl2` queries surround the actual
synchronous native operations:

| Operation | Included work | Not implied |
| --- | --- | --- |
| `rhiwgpuqueue_submit` | Pending GPU uploads, scene work, changed UI raster and final UI composition recorded in that submission | Pure shader execution or a separate UI submission |
| `rhiwgpusurfacetexture_present` | Surface transition submission and subsequent WebGL blit or sRGB draw | Browser compositor or physical display timing |

The second normal fence comes from
`wgpu-core::prepare_surface_texture_for_present` before the actual GLES present
blit/draw. Two fences therefore do not mean separate scene/UI submissions, and the
second fence does not cover every operation inside present. UI `paint_gpu` prepares
CPU data; `ui-raster-*` and `screen-ui-composite` are encoded into the ordinary
Renderer submission.

Each sample keeps its operation, bounded ordinal, native pointer, synchronous CPU
interval, original native throw indicator, GPU nanoseconds and result observation
time. `nativeThrew` describes the raw WASM boundary: generated glue can still throw
after a returned `Result::Err` tuple. A false value is not submission success;
retain the App's ordinary terminal and error evidence. The native pointer identifies
the binding object, not a stable cross-run resource or an App frame ticket. Samples
are not automatically paired into frames. Driver-reported query durations cannot
simply be added and called per-frame GPU busy time. They do not expose absolute
GPU start/end timestamps, so these scalars cannot establish whether command-buffer
execution/wait intervals overlap. Result availability delay and fence latency must
remain separate columns.

The JavaScript diagnostic adds no explicit flush, finish, fence, `getError`,
availability poll or timer inside the window. That does not constrain hidden
driver work: ANGLE Metal's query begin/end actively flush command buffers.
Each query is used once from a pool allocated before the window. The last query
end may become visible only after a later ordinary native flush; a bounded timeout
remains missing evidence rather than adding a flush to manufacture coverage.
Capacity bounds both queries and samples (default 1024, range 2–16384); overflow
counts native calls which still execute unchanged. Choose the bound before a
longer diagnostic; do not use pool exhaustion to throttle gameplay.

Missing extension, zero counter bits, foreign active queries, context loss,
disjoint, malformed results and collection timeout produce explicit unavailable
samples. Any observed context loss/disjoint invalidates the entire sampled window,
including results already read. Successful zero nanoseconds is retained as a
timer-resolution result; unavailable timing is `null`, never synthetic zero. More
than one native instance/surface is outside this tool's attribution contract and
is reported explicitly. Original native arguments, receiver, return and exception
identity are preserved; diagnostic GL failures are recorded separately.

RHI Debug is complementary: use a separate capture to inspect scene passes,
`ui-raster-*`, cached UI textures and `screen-ui-composite` work. Its per-pass replay
timings belong to the replay device. The production WebGL RHI still reports
`timestampQuery: false`; this diagnostic does not change that capability contract.

## ANGLE Metal timing granularity

The public Chromium `155.0.8059.40`
[DEPS pin](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.40/DEPS#352)
selects ANGLE `170484eea03a4255a388072add4232e1fadfbee4`. This is a
reported-browser-version to public source mapping, not independent proof of the
installed binary's build provenance. The inspected fixed source says:

- [QueryMtl.mm:56](https://chromium.googlesource.com/angle/angle/+/170484eea03a4255a388072add4232e1fadfbee4/src/libANGLE/renderer/metal/QueryMtl.mm#56)
  flushes the existing command buffer on elapsed-query begin, allocates an entry,
  and activates its ID. End flushes again before clearing the active ID.
- [mtl_command_buffer.mm:626](https://chromium.googlesource.com/angle/angle/+/170484eea03a4255a388072add4232e1fadfbee4/src/libANGLE/renderer/metal/mtl_command_buffer.mm#626)
  assigns each newly created Metal command buffer one active query ID. Its
  completion callback records `GPUEndTime - GPUStartTime` at line 698 and adds
  that duration to the query entry at line 825. This is command-buffer lifetime
  accumulation, not timestamps placed around individual draws.
- [ContextMtl.mm:1784](https://chromium.googlesource.com/angle/angle/+/170484eea03a4255a388072add4232e1fadfbee4/src/libANGLE/renderer/metal/ContextMtl.mm#1784)
  ends encoding and commits a ready command buffer when flushed.

The source does not assign the same command buffer to both query IDs. Similar
submit/present results alone therefore prove neither duplicate accounting nor
that the present copy is as expensive as the complete scene. Apple describes
[GPU start](https://developer.apple.com/documentation/metal/mtlcommandbuffer/gpustarttime)
and [end](https://developer.apple.com/documentation/metal/mtlcommandbuffer/gpuendtime)
as command-buffer execution timestamps; the query exposes only accumulated
differences, without the underlying interval bounds or resource-wait breakdown.

For unusually correlated results, calibrate separately on the same driver and
output extent. Precompile a controllably expensive draw to texture A and a fixed
present-like blit from A. Compare (1) an empty query, (2) separately queried draw
and immediately following blit, and (3) the identical draw and blit with a bounded
asynchronous fence drain between them. Vary only the draw workload. If the queried
blit scales with the preceding draw but falls after the explicit drain, it is not
an isolated copy-cost measurement. A dependent-resource interval or driver
scheduling effect still needs absolute GPU timestamps/counters to distinguish.
This calibration deliberately changes submission scheduling; neither its drains
nor its query timings belong in gameplay acceptance. An empty query should have
no command-buffer work in this implementation, possibly yielding zero at timer
resolution; nonzero values need further driver qualification.

Inspected source SHA-256 digests (2026-10-13):
`QueryMtl.mm` `37f49d1cd20e887ef2c1d813f6f1ec6c4d57e356131d2ec2831b14a4f5fbb19b`;
`mtl_command_buffer.mm` `0f3ef9ccc3d980b6e873283c8ba909ad71f11e57adddc5774b245df34c3a9b51`;
`ContextMtl.mm` `a717eec86824993a1ed47753943fe958d03cd74f3ffd14b062b68cb7f22ee770`.

## Focused regression

```sh
node --test skills/forgeax-engine-wechat/scripts/__tests__/browser-gameplay-gpu.test.mjs
FORGEAX_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
FORGEAX_GPU_WASM_PKG=/absolute/path/to/publisher-provenanced/wgpu/pkg \
node --test skills/forgeax-engine-wechat/scripts/__tests__/browser-gameplay-gpu-cdp.test.mjs
```

The Browser regression derives the native binding with the existing producer,
uses real published wgpu WASM, creates a real surface and checks submit/present,
pixel preservation, query results and unchanged native flush count. Chromium runs
with `chromiumSandbox: true` and explicitly selected SwiftShader. That software
backend proves the diagnostic contract, not hardware FPS or GPU cost. Optional
`FORGEAX_GAMEPLAY_GPU_EVIDENCE` writes its JSON evidence;
`FORGEAX_CHROMIUM_EXECUTABLE` selects a qualified local Chromium binary. The focused
fault tests cover return/exception identity, foreign queries, capability absence,
disjoint, context loss, overflow, timeout and cleanup.
