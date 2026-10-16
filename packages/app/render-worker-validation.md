# Render Worker validation

The Render Worker policy separates source simulation from the existing Renderer.
Worker selection follows the independent `execution.workers` policies in the
[App contract](README.md#worker-execution). The current
[support contract](../render/README.md#render-publication) includes the complete
publication surface. The pressure results below use the bounded two-slot policy;
earlier transport experiments are identified separately.

## Frame cooperation

The source seals N with synchronous postMessage, then may update and seal N+1
while the Render Worker consumes N. Host admission stops before N+2 until N's
completion returns. Each healthy-epoch frame is transferred and consumed in order;
there is no busy-path coalescing. Two numeric buffer sets and revision-scoped
Feature feedback retain ownership across the overlap.

The Render Worker submits N+1 without waiting for N's GPU receipt. Draws execute
serially on its CPU; receipt settlement proceeds separately and returns buffers
in publication order. The Host's same two-frame admission bound includes all
preparing, queued and submitted publications, so no additional GPU backlog is
introduced. Disposal drains both CPU submissions and their completion chain.

This follows the downstream backpressure principle described in Epic's
[Low Latency Frame Syncing](https://dev.epicgames.com/documentation/en-us/unreal-engine/low-latency-frame-syncing-in-unreal-engine):
synchronizing simulation only to CPU render progress can leave the GPU further
behind. Two frames is ForgeaX's chosen global bound, not a claim about Unreal's
default. The existing WebGPU queue remains ordered, and each normal draw still
submits its existing command buffer. CPU preparation overlaps queued GPU work;
this does not promise parallel execution of dependent GPU commands or physical
presentation/vsync timing from a completion receipt.

| Permanent regression | Evidence required |
|:--|:--|
| Pipelined Browser contract | Hold the first composite receipt after real GPU submission; require both GPU frames to finish while Host completion stays at zero and no third simulation frame starts; release, then prove ordered recycling and resumed progress |
| Two-flight pixel ownership | Submit distinct transforms and material values without waiting, resize with an older flight pending, and require receipt-owned linear output bytes to match direct rendering |
| VFX temporal state | Submit ticks 6 and 7 together, check the committed phase after each draw and compare queued pixel copies against the established prior-tick shadow oracle |
| Worker protocol retirement | Resolve the second receipt first; no completion or buffer return may overtake the first; disposal must wait for both |
| `render-worker-contract.browser.test.ts` | Three-second first-frame delay allows exactly two source frames; async source mutation cannot edit the second packet; Host remains responsive past the two-second admission timeout |
| Submitted context, both Worker tiers | Display picking succeeds using the receipt's camera/mapping and an unrelated live World |
| Graceful and forced disposal | An independent BroadcastChannel witnesses async plugin cleanup; a stalled cleanup returns the disposal deadline error |
| Structured failure | The original producer code, hint, detail and publication identity reach the Host without replacement; a failed successor stops admission even if older completion and timing observation are pending |
| Publication and VFX integration | A one-frame entity survives until consumed, identity reuse stays ordered, buffer storage is reused, and an early successor does not replay acknowledged ticks |

The 50k fixture compares bounded progress and completed rendering. Source updates
cannot outrun the two-slot contract, even when software rendering takes seconds.

The pipeline regression failed on the prior implementation with only frame 1
submitted. The injected completion hold proves scheduling and ownership, not
faster GPU execution. The historical measurements below predate pipelined
submission and must not be presented as its performance results. Target-hardware
A/B should preserve the scene, resolution and GPU work while reporting completed
throughput, input age and frame-interval tails; publication FPS is not display FPS.

The 2026-09-21 local pipeline checks passed on Chrome 155 / SwiftShader: all
10 Worker protocol tests, the seven-test real Worker contract, the receipt-owned
pixel/resize comparison, and all three VFX lighting/publication cases. The App
suite passed 393 tests with two existing skips. Complete Browser, Dawn and the
300-frame full hello/learn roster remain required at the delivered PR revision;
the PR's CI evidence is the authority for those full-run results.

## Responsiveness under pressure

The browser fixture creates 50,000 renderable entities and changes 500 transforms
per Update. Both tiers use the complete Renderer, the same scene and canvas, and
two completed warmup frames. A measured window sends serial Host-to-source-Worker
round-trip pings 25 ms apart until at least 100 samples and two more completed
render frames. This is message responsiveness, not input-to-display latency.

The 2026-09-20 local run used Chrome 155 / SwiftShader on the shared Linux test
machine, with other regression work active. It is software validation, not a
physical GPU benchmark or a universal latency guarantee.

| Measured quantity | Co-located Engine Worker | Separate Render Worker |
|:--|--:|--:|
| Observation window | 18.40 s | 23.83 s |
| Round-trip samples | 481 | 921 |
| Round-trip P95 | 0.8 ms | 0.9 ms |
| Maximum round trip | 5947.6 ms | 8.1 ms |
| Source updates in window | 2 | 2 |
| Actual delta publication CPU time | Not applicable | 4.6 / 2.7 ms |
| Synchronous draw submission | 5955.4 / 4836.4 ms | Runs in the child |

> [!IMPORTANT]
> P95 alone conceals rare long stalls: the co-located Worker was responsive while
> waiting for the GPU but blocked source messages during synchronous Renderer
> work. The split tier kept source messages responsive while its next simulation
> update waited for capacity. These windows do not establish a frame-rate improvement.

The final four-case recovery/pressure browser suite passed in 273.91 seconds.
Its queued successor message reached the child listener after 4.83-5.45 seconds
because that Worker was still executing synchronous Renderer work. This measures
queueing behind the previous frame, not empty-channel communication cost; the
source had already sealed the successor, and a third frame remained blocked.

An earlier 13.4 ms ping P95 included two avoidable synchronous costs. The test
system repeatedly resolved Cordis `ctx.world` for each entity; it now uses its
system argument. Scene propagation also drained changed GlobalTransform rows
through a complete-table iterator. Its native span drain preserves the same
observation cursor while avoiding that scan. The permanent 50k/100-change
regression failed with 100,008 query-graph reads before this fix and passes the
5,000-read bound afterward. Entity counts, writes and scheduling were preserved.

A follow-up probe timestamped each real draw immediately before `postMessage`
and at the Render Worker's message listener, using `performance.timeOrigin`
plus `performance.now()` in both realms. Three warmup deliveries took
0.3-0.6 ms; two steady deliveries took 0.2/0.3 ms. They include cloning, queueing
and receiver scheduling. The same run observed ping P95 0.5 ms, maximum 3.1 ms,
and two source publication intervals of 1.6/2.2 ms. Five deliveries do not
establish a tail-latency guarantee; they distinguish transport from source work.

Only actual `draw` sends count as publication samples; busy-credit no-ops are
recorded separately. Test-only probes cover World.update, gameplay, propagation,
and the entire update-to-simulation-complete publication interval, including
synchronous buffer transfer and local acceptance.

## Empty communication and GC

A separate Chrome 155 test uses two otherwise idle Workers, one outstanding
request, 200 warmups and ten batches of 10,000 round trips. Sampling storage is
a preallocated Float64Array. The message receiver only echoes `null`; the atomic
receiver observes one shared request integer and publishes its acknowledgment.
No World, renderer or GPU work runs in these Workers.

| Untraced local run | Batch mean round trip | Maximum among 100k exchanges |
|:--|--:|--:|
| `postMessage(null)` | 39.0-60.0 us | 6.175 ms |
| SharedArrayBuffer plus Atomics.wait/notify | 32.1-39.4 us | 3.235 ms |
| SharedArrayBuffer plus atomic polling | 0.924-1.053 us | 0.405 ms |

The polling mean comes from batch elapsed time; the browser's approximately
5 us timestamp granularity cannot resolve its individual exchanges accurately.
Polling keeps both participating cores busy. Wait/notify yields the CPU but
still pays scheduling and wakeup costs. These shared-machine samples are not
hard latency bounds, nor do counter exchanges measure full frame publication.

Minimal V8/GC tracing, with sampling still preallocated, reproduced a 5.440 ms
message round trip overlapping 5.301 ms of receiver MinorGC, and a 3.995 ms round
trip overlapping 3.904 ms of sender MinorGC. The receiver contains no application
allocation or sample array. The untraced control still had millisecond spikes.
An earlier untraced 3.920 ms outlier cannot be attributed retrospectively; these
traces establish a reproducible cause for the same class of stall. Other slow
samples without overlapping GC remain unattributed.

> [!WARNING]
> postMessage is not a strict low-tail-latency synchronization primitive. An
> idle receiver can pause for GC even with null payloads. Atomics avoids the
> per-exchange message/event path, but does not prevent a Worker's own rendering
> or simulation allocations from causing GC. Browsers expose no standard
> production API for scheduling an early collection between frames.

An attribution control removed per-exchange timing and temporary sample copies,
retaining only batch timing. Over 100k atomic exchanges, neither participating
Worker recorded GC in the measured window. Mean wait/notify round trips were
26.6-33.1 us; mean polling round trips were 0.23-0.35 us (230-350 ns). This control
shows that the communication loop can avoid GC-producing allocation. It does
not measure individual peaks, and polling still occupies the participating CPU
threads continuously. The earlier per-exchange atomic tracing did observe
small collections in the sampling Worker, so measurement allocation must not
be attributed to the shared-memory receiver.

A shared-memory frame channel deserves a separate full-publication comparison:
retain explicit ownership, accepted bases and restart epochs, encode the actual
numeric state, and keep low-frequency asset/control messages outside the hot
path. These counter results alone do not prove that changing the production
transport improves input-to-display latency or removes all allocations. The
current explicit tier uses postMessage and retains this documented limitation.
Local raw evidence is in `artifacts/render-worker/empty-channel*.json` and
`atomic-channel*.json`; trace runs are attribution evidence, not timing baselines.

## Transport selection

| Boundary | Transport | Reason |
|:--|:--|:--|
| Source to Render Worker | Two-slot `postMessage` with owned transferable numeric buffers | One transaction seals each frame; N+1 overlaps N, then Host admission waits for capacity without blocking messages. |
| Initialization, resource changes and recovery | `postMessage` | These operations need structured data, transfer ownership and asynchronous lifecycle handling. |
| Existing shared numeric kernels | Shared spans and Atomics completion | These kernels join within one source update and require bounded synchronization without copying their numeric data. |

The Render Worker does not busy-poll or synchronously wait for a frame. A
shared-memory frame path must improve measured publication and input-to-display
behavior, preserve the same acceptance/recovery contract, and include its CPU
and allocation costs. Counter timing alone does not establish that benefit.

## Initialization and recovery limits

The final measured 50k baseline took **2242 ms** on the source Worker. This synchronous
initialization work is excluded from the warmed measurements above. Replacing a
Render Worker needs another current baseline and can therefore pause simulation
while it is built. Keeping the World alive is not a promise of uninterrupted
source responsiveness during rebuilding.

The browser recovery cases terminate the actual child Worker and separately
call `GPUDevice.destroy()`. They require the same World identity, bounded progress before replacement,
a new epoch, a replacement host canvas, a completed GPU frame, nonblank pixels
before and after recovery, and no leaked Worker targets after disposal. A
heartbeat records source latency throughout replacement initialization and frame
completion; it does not conceal baseline stalls in the normal-operation P95.
The final 10k recovery run observed maxima of 790.8 ms after Worker termination
(611 samples) and 524.1 ms after GPU destruction (673 samples). Both completed
with the required pixels and Worker cleanup.

The first GPU-destruction attempt failed: its completion receipt reported
`device-operation-failed` with operation `complete-frame` and cause `disposed`,
while Renderer health still read `alive`. Recovery now recognizes the receipt's
device-loss fences as well as health. The real destroy case and structural
error regressions pass; deterministic producer errors remain terminal.

## Reproduction and evidence

```bash
pnpm ci:graphics --probe browser -- pnpm exec vitest run --project=browser \
  packages/app/__tests__/render-worker.browser.test.ts \
  packages/runtime/src/__tests__/render-publication.browser.test.ts
pnpm exec vitest run --project=@forgeax/engine-scene
```

The browser writes raw samples, phase timings and execution reports to
`artifacts/render-worker/`. These are local generated evidence. The regression
source and this measured summary are tracked; CI results must identify the
actual PR commit. Publication contracts additionally cover consecutive sealed updates,
identity reuse, stale epochs, malformed columns, asset changes and retirement,
program conflicts, rejected candidates, buffer recycling and temporal reset.
The pixel parity case compares the direct World renderer with transferred
publication input, including runtime edits and a cooked shader replacement.
