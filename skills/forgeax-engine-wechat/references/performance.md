# Performance diagnosis

Confirm spare capacity on the machine running DevTools before any performance
test. Keep functional evidence, contention observations, profiling runs and final
performance acceptance distinct. A simulator result describes the simulator;
measure an Android/iOS budget on that actual device.

Start with the cheapest path that reproduces the failure, then qualify the
requested delivery target. A Mac owner fixture can shorten iteration; it does not
make every task require a new browser → simulator → phone sequence. Reuse still
applicable checks and unchanged cooked assets, WASM and publication inputs. A
device-only failure needs that device's evidence; an unchanged simulator run does
not resolve it.

| Question | Start here |
|:--|:--|
| What does a stable gameplay FPS claim cover? | [Workload contract](#qualify-the-workload-before-measuring) and [mobile input](mobile-game.md) |
| Is another process consuming capacity? | [Host capacity](#host-capacity-first) |
| Which game subsystem is slow? | [Game owner](#measure-the-game-owner), then [CPU attribution](#reuse-cpu-owner-attribution) |
| Are Android GPU queries unavailable, or does the native phone loop need independent scheduling evidence? | [Android Perfetto](android-perfetto.md) for CPU scheduling, SurfaceView swaps and fence waits |
| Are receipts late despite prompt page callbacks or high aggregate CPU idle? | [GPU-process CPU investigation](gpu-process-cpu.md) |
| Are receipts prompt but new frames arrive slowly? | [Host request timing](completion-timing.md#host-request-timing-when-receipts-are-prompt) |
| Are browser and simulator results comparable? | [Same publication across hosts](#compare-the-same-publication-across-hosts) |
| Is active UI raster or final composition expensive? | [UI benchmark](#ui-raster-and-final-composition-benchmark) and [paired workload](#pair-the-browser-and-official-simulator-workload) |
| Which actual frame work matters? | [GPU UI capture](#gpu-ui-capture-and-replay), then [aligned draw omission](#causal-draw-omission-on-an-aligned-live-frame) |
| Does a shader change explain the gain? | [Equivalent shader A/B/A](#equivalent-shader-aba-after-work-isolation) and [actual source collection](shader-sources.md) |
| What is the current DFG path? | [Default fit and explicit LUT](#dfg-fit-and-opt-in-texture-verification) |

## Qualify the workload before measuring

Use the maintained [gameplay benchmark](gameplay-performance.md) for continuous
walk, run, jump and camera rotation. It supplies one shared contact timeline,
ordinary App completion observation and offline analysis for Browser and simulator
hosts; the [Android driver](android-continuous-input.md) reuses that timeline.
Check each driver's current qualification before treating a successful tool run
as evidence for the requested platform.

Freeze the ordinary SDK/publication identity, complete frontend, scene and native
payloads, actual drawing-buffer extent/DPR, effects and material choices, including
DFG fit versus LUT. Record the camera path and input schedule as part of the
workload: rotating away from visible geometry or leaving the scene can change
cost without improving the renderer. An isolated UI or shader benchmark retains
its own scope even when it uses the same resolution.

For a walking/running/jumping case with continuous camera rotation, keep the
ordinary physics, animation, UI feedback and rendering active. Reuse the
[mobile probe's](../../../templates/game-3d/scripts/mobile-controls-probe.mjs)
live control rectangles and independent contact identities, but define a fixed
timed sequence for the measured window. Its functional assertions, screenshots,
viewport changes and inspector polling are not a performance loop. Preserve
movement, Run, airborne/landing, camera and final-release witnesses separately.
The installed simulator's single-contact tool cannot establish this simultaneous
workload; qualify native multi-touch on the actual target. See
[input ownership and temporal alignment](mobile-game.md).

Declare warmup, duration, repetitions, frame budget and allowed tail behavior
before comparing candidates. Report completed-frame throughput, interval
median/p95/p99/max and the count over that budget, with the actual sample count
and elapsed time. Derive throughput from that count rather than assuming a
60-frame window. A historical 30-FPS floor or a 60-frame functional pass cannot
satisfy a new stable-60-FPS requirement.

Timestamp inside the ordinary Host's [public App](../../../packages/app/src/types.ts)
`onFrameCompleted` callback,
using the same Platform's normalized monotonic clock. That callback follows a
successful receipt completion; reading `renderer().completed` on RAF or through
remote polling cannot reconstruct its intervals. A diagnostic fixture can
compose bounded observation with the existing `onFrameSubmitted`/`onFrameCompleted`
handlers while preserving startup, generation guards, the complete frontend and
the App loop. Retain scene-ready presentation and World/device/frame identity,
record overflow as incomplete, and export after sampling. Keep in-flight bounds
and drain receipts; the existing
[receipt analyzer](../scripts/analyze_frame_receipts.mjs) owns those checks.
App completion is CPU-observed completion, not display scanout or GPU duration.

Keep final sampling lightweight. Capture/replay, GL wrappers, WASM-memory hooks,
CPU profiling, GPU queries and synchronous readback belong to separate diagnostic
runs. A long-run capacity plateau or a presentation-count total does not establish
FPS or interval tails. Retain simultaneous host/device capacity and thermal facts.
Record the driver of each measured host/context independently: Linux SwiftShader
replay, another Chrome's Metal adapter, or a GPU-helper process name cannot
identify the official simulator's driver. Unknown stays unknown; software-driver
tool verification is not hardware performance acceptance.

## Host capacity first

For a physical Android run, use [android_headroom.py](../scripts/android_headroom.py)
with the explicitly observed game PID, selected serial and absolute ADB path.
Run it on the ADB machine when possible; `--config` can reuse the SSH transport.
`--duration 50 --interval 5 --out /private/new-headroom` covers a 40-second
workload only when the recorded start/end timestamps actually enclose it.
The read-only collector retains timed raw `/proc` CPU/process/memory counters,
battery and thermal-service observations, including unavailable reads. It stops
on a missing device and never reconnects, opens applications or changes power state.
Use the post-first-sample intervals: `processMachineCpuPercent` is the process's
share of **all logical CPUs**, not `top`'s per-core percentage. PID start-time
changes invalidate attribution. RSS includes file-backed pages; VM swap capacity
and a thermal status of zero do not prove zero active paging or no frequency
limitation. Command spans retain the monitor's collection overhead.

Keep Android battery and thermal-service sensor readings separate when they
differ. On the observed Android 16 / Adreno 830 target, CPU and process counters
were readable but GPU busy/frequency sysfs files returned permission denied.
Preserve unavailable GPU counters; do not attempt privileged access or infer GPU
headroom from idle CPU. Use an independently qualified GPU query or trace for
graphics attribution, and keep that diagnostic separate from clean FPS sampling.

Run these read-only observations on the DevTools machine, not on the SSH client:

```sh
sysctl hw.logicalcpu hw.physicalcpu hw.memsize
vm_stat
top -l 4 -s 5 -n 0
memory_pressure -Q
sysctl kern.memorystatus_vm_pressure_level vm.swapusage
pmset -g therm
vm_stat
ps -axo pid=,ppid=,etime=,%cpu=,rss=,comm=
```

Use the interval CPU samples after the first `top` snapshot. Compare the two
`vm_stat` readings: cumulative swap totals do not prove current paging. Retain CPU
idle, unused memory, memory pressure, swap/pageout deltas and thermal/power status
with timestamps. Process CPU can exceed 100% on a multicore host. Summed process
RSS includes shared pages and is not unique physical memory freed.

[mac_headroom.py](../scripts/mac_headroom.py) captures those exact observations
with one start/end interval. It uses the existing private machine configuration
and `wechatide.transport` for SSH; it does not close applications. Complete and
inspect a fresh capture before testing. Start a separate capture before the
measured run, then verify that its timestamps cover the actual sample. A preceding
resource report or a monitor that ends early is not simultaneous headroom evidence.
Use `--duration 45` (5–300 seconds, rounded up to five-second CPU intervals) when
the experiment exceeds the default 15-second window. Start it asynchronously
before the operation and inspect the actual start/end timestamps afterward.

The helper also samples IORegistry GPU utilization alongside the CPU interval,
using `AGXAccelerator` with an `IOAccelerator` fallback. It retains only the
Device/Renderer/Tiler utilization counters, timestamps and structured unavailable
results; it needs no administrator permission. Record background GPU utilization
before opening the test game, then utilization during the same measured operation.
High CPU idle does not establish GPU headroom. A busy GPU during a game does not
identify which process owns the load; compare after closing only the task-owned
game and retain other applications' remaining activity.

For a busy shared Mac, add `--gpu-owners` to this same collector. It reads
`AGXDeviceUserClient` ownership and `AppUsage.accumulatedGPUTime` from IORegistry
without administrator access or pausing applications. The `-l` flag in
`ioreg -a -r -c AGXAccelerator -l` is required for child-client properties.
Each interval compares the same registry client, PID and API-entry count, then
groups positive and zero
counter increments by process. New, retired, replaced or reset clients produce
`status: partial` and `unmatchedClients`; missing attribution is never zero work.
The report retains raw driver counter deltas and a monotonic elapsed interval,
not a portable percentage or GPU timestamp for one game. Match the process's
parent and browser profile to identify the owning application; a shared Chrome
GPU process can serve several tabs and Workers.

This identified the active Chrome GPU helper as the principal source of a
94–97% busy Mac on 2026-10-12, while the old WeChat IDE clients had zero increments.
Closing two confirmed old blank Chrome instances did not remove the load.
Process age, CPU percentage and a simulator's mere presence are insufficient
attribution. Concurrently opened previews also invalidate a page-isolation
comparison; retain the process sample and re-admit before a game benchmark.

Avoid `Page.setWebLifecycleState` as a default shared-browser diagnostic. A
page freeze does not prove its Worker or other tabs stopped submitting, and
restoring `active` alone does not prove the original focus/visibility state was
restored. This experimental CDP route produced changed visibility/focus in the
shared Chrome investigation. Prefer read-only client counters and an owned
App's normal pause/dispose control, with actual completion counters, when a
bounded isolation experiment is necessary. Do not close active shared previews
based only on an old browser root process.

When the user's existing authorization permits closing old Chrome work, qualify
the actual page with its exact target ID, URL path, `performance.timeOrigin`,
visibility and focus. An old shared browser can contain a newly opened preview.
Close only the qualified target and confirm it disappears from a subsequent
target list: `Target.closeTarget` returning success can precede retirement.
Do not export URL queries, change focus or pause the page to collect these facts.
Read the existing browser's `SystemInfo.getInfo` to distinguish hardware
ANGLE/Metal from a software backend without opening a new graphics context.

In the same 2026-10-12 investigation, three unfocused background game pages were
84–85 minutes old while another preview in their browser was under three minutes
old. The existing age-based authorization covered those three targets; they were
closed and their disappearance verified. GPU utilization remained 99–100%, with
work from the retained preview, a newly started Chrome instance, WindowServer
and Wallpaper. The concurrent new instance prevents a controlled cleanup-speedup
claim. The Mac was also locked; a retained browser's `visible` page state does not
prove an unlocked desktop. Idle WeChat clients again had zero GPU counter
increments. Preserve this as contention evidence and keep hardware timing on
hold; don't infer that every old client is consuming GPU or kill system display
services to make admission pass.

Close confirmed task-owned historical projects through the official CLI. If a
project list omits a window, use its existing runtime/window identity to establish
ownership before closing it. A missing runtime and a failed close are different
results. Keep one game simulator active during the measured operation; serialize
other simulator gates, previews and heavy builds on that machine.

The imported-project catalogue alone cannot identify old open simulators. If the
current authorized CDP endpoint is unavailable, do not enable a new one solely
for cleanup. On a Mac with the relevant existing access, read window metadata
with `CGWindowListCopyWindowInfo`, filter by the verified IDE root PID, and match
titles to exact catalogue project paths. Correlate process age, current CPU work,
project file timestamps and known session ownership before applying the user's
cleanup scope. Close the exact project through the official CLI, retain its
returned window ID, and confirm retirement. A shared IDE process/GPU helper is
not itself proof of an abandoned game. Keep post-close settling samples that fail
capacity admission; a later passing sample never erases the failed observation.

For unrelated applications, honor the user's exact cleanup authorization. An
authorization to close Chrome processes older than one hour does not cover newer
ones. Recheck PID, executable and elapsed age before signaling; allow graceful
browser shutdown before escalating only matching old processes. Do not terminate
all WebKit/Chromium processes or disable system indexing from a CPU snapshot.

On 2026-10-11, removing old Chrome processes and closing 14 historical task-owned
DevTools windows left 55.61%, 62.17% and 65.21% CPU idle across three intervals on
a 12-core/64-GiB Mac, about 22 GiB unused memory, normal pressure, no new swaps or
pageouts and no reported thermal warning. This established capacity for a bounded
single-simulator diagnosis, not a universal numeric gate or a game performance
pass. Recheck conditions during the actual sample and retain changed contention.

## Measure the game owner

The original Blitz integration used `anyrender_vello_cpu` to rasterize HTML/CSS
into RGBA and the Engine Renderer to composite that texture. GPU composition is
not GPU rasterization. The GPU route uses portable Vello sparse-strip preparation:
`ui.paintGpu(time)` produces owned data and `RendererOptions.ui` with
`kind: 'sparse-strips'` supplies that data plus `gpuShaders` to the existing RHI
device. Renderer records five raster pipelines before final composition in its
existing submission and completion receipt. No second context/device, compute,
storage resource or cross-WASM pointer is introduced.

Keep the implementation layers distinct when diagnosing failures:

| Evidence | Owner and next step |
| --- | --- |
| Native scene preparation rejects a paint/filter | `packages/ui-blitz/rust/gpu.rs`; preserve its explicit unsupported diagnostic. |
| Actual WGSL cannot compile in Engine Naga/WebGL2 | Run `scripts/dev-verify/verify-ui-gpu-shaders.mjs`, then the real `gpu-ui-webgl2.browser.test.ts`; generation uses the pinned portable Vello shader ABI. |
| Layer/clip/text pixels differ after successful compilation | Run the shared `gpu-ui-parity.fixture.ts` through Dawn, WebGPU and WebGL2. Inspect the first differing real pass/resource before changing the producer or executor. |
| Pixels agree but input remains slow | Measure the full authored UI at the same physical extent with actual GPU completions; exclude correctness readbacks and CPU reference work from throughput. |

Vendor only the supported source closure. The optional upstream hardware
self-probe and its PNG/RGBA baselines are not used by Engine portable preparation;
they are omitted together with their feature declarations and exports. Keep the
upstream archive hashes and licenses, and run
`node scripts/grep/check-no-binary-assets.mjs` before committing a vendor update.
A source fingerprint includes the chosen files; it is not a reason to import
unused binaries or force ignored images into the repository.

The native source fingerprint includes the package-local Vello vendor sources.
Use the normal `build:wasm`/provenance path to regenerate bindings; do not edit
generated declarations or transplant an older WASM to satisfy a build. Pipeline
compilation and small synthetic readbacks do not qualify full scene parity,
ordinary game startup or the dynamic 30–60 FPS budget.

When CPU samples identify sparse-strip preparation, first check whether generic
`Shape -> BezPath` conversion erased exact rectangle identity. The maintained
Vello owner recovers one four-corner fill/clip contour, including Blitz's implicit
closing edge, and reuses its existing rectangle admission. Keep curved, compound,
degenerate and any transformed path with a nonzero off-axis coefficient on the
normal path pipeline; never
apply this fill rule to strokes or approximate a near-rectangle. A near-zero angle is still a path: the direct Rect API admits small rotations
by bounding-box approximation, which failed the pixel threshold for an 800 x 400
rectangle at 0.01 degrees. The focused
`portable` target is `vendor/vello_gpu/__tests__/rect_paths.rs`; run it with
`cargo +1.99.0 test --locked --manifest-path vendor/vello_gpu/Cargo.toml
--no-default-features --features portable --test rect_paths` from
`packages/ui-blitz/`. Reuse `gpu-ui-parity.fixture.ts` on WebGL2/WebGPU/Dawn for
fractional edges, nested clipping, affine fallback and DPR 3 before adoption.

The 2026-10-12 rectangle performance comparison is withdrawn. A supposedly
layout-only baseline binary contained the rectangle-path optimization despite its
source receipt naming the earlier source. Concurrent isolated checkouts reused
one Cargo target, so source hashing alone did not bind the compiler output consumed
by bindgen. The functional tests remain observations of their exact binaries;
they do not establish a source-correct build or rectangle-only performance gain.
Requalify baseline and candidate with isolated compiler outputs before publishing
CPU, instance-count or upload reductions. Do not reuse the former percentages.
The repaired production generator partitions `CARGO_TARGET_DIR` by source digest
and passes that exact directory to both Cargo and bindgen. Relative cache roots
resolve from `packages/ui-blitz/`. Keep the recipe in the hashed manifest/scripts;
external Rust flags, compiler wrappers and profile overrides are rejected. Use
immutable source snapshots for A/B builds, retain their original provenance, and
verify the intended native difference in the actual binaries before timing. The
production-entry concurrency regression is
`packages/ui-blitz/scripts/__tests__/build-wasm.test.mjs`.

The fresh source-isolated pair `190f39bc` / `eaf3b49c` (WASM `75320712` /
`4eb7528d`) qualified the intended rectangle difference. In the original DPR 3
workload, actual untimed WebGL calls submitted 4,980 / 4,104 instances and
119,520 / 98,496 instance-buffer bytes. Every one of the 60 timed frames saved
21,024 instance bytes, and the return baseline restored all 60 original counts.
Distinguish this 17.6% instance reduction from total upload traffic: texture
uploads stayed at 196,648 bytes, so total observed uploads fell from 316,200 to
295,176 bytes (6.65%). CPU paint medians were 5.8 / 5.0 / 6.6 ms; the return
baseline drift prevents a single CPU speedup claim. These Linux SwiftShader
observations do not qualify Mac, simulator or device FPS. Remaining confirmed
paint samples were dominated by strip generation, especially glyphs and rounded
rectangle strokes; use those actual call stacks to choose the next owner.

The next isolated candidate specializes exactly vertical in-tile edges in
`vello_common` as signed rectangle coverage. Nonvertical and off-tile edges keep
the original algorithm; no atlas/cache, shader, upload or resource protocol changes.
Against accepted source `eaf3b49c` / WASM `4eb7528d`, source `7f03267f` / WASM
`e45f7cfb` passed 5,020 original-versus-modified strip cases on native and scalar
WASM. All 20 actual Dawn GPU images were byte-identical to the frozen original,
independently of the modified CPU reference; WebGL2/WebGPU parity and 51 native
WASM tests also passed. The sole exclusive full-UI A/B/A batch measured paint
medians **5.0 / 4.7 / 5.0 ms** and P95 **5.8 / 5.3 / 5.8 ms**. This is about
0.3 ms, or 6%, less CPU preparation for that Linux workload, not a hardware or
WeChat FPS claim. All 60 instance-byte counts, actual GL calls/uploads and the
three UI checkpoint screenshots stayed identical. These are isolated-candidate
results; final source composition still requires ordinary-game target verification.
See local `artifacts/cross-platform-host-ui/design-resumed/
ui-native-cpu-profile-linux/vertical-strip-report.md` for immutable input and
output identities. Preserve original baseline outputs when changing this shared
kernel; testing two paths that both use the same changed code is not an independent
correctness oracle.

Record the exact publication, generation, scene-ready state, framebuffer extent,
DPR, active render features and backend. Screenshot dimensions can differ from the
drawing buffer: one observed 794 x 368 simulator image represented a 2532 x 1170
target. Do not silently change resolution, shadows or UI to improve the baseline.

Use successful Renderer completion/presentation deltas over the same game-clock
interval. Native vConsole `RT-FPS` and host rAF rates are not Engine FPS. Keep rAF
callback duration separate from scheduling intervals and completed frame rate.
Inspect opt-in App/Render Profiler and RHI Debug capabilities first; retain a
structured unavailable result when the publication does not expose them.

### Ordinary simulator throughput

Use [measure_game_throughput.py](../scripts/measure_game_throughput.py) with the
project path on the DevTools machine, its published `forgeax-dist.json` SHA-256,
and a new output directory. Start with that project window closed. The script
checks the official CLI status, captures and qualifies fresh Mac headroom,
verifies every declared publication file, owns a new window, and requires the
existing 120-second / 60-presented-frame readiness gate. It observes three
10-second game-clock counter windows without frame or GL hooks.

```sh
python3 skills/forgeax-engine-wechat/scripts/measure_game_throughput.py \
  --config "$FORGEAX_MACHINE_CONFIG" --project "$FORGEAX_SIMULATOR_PROJECT" \
  --manifest-sha "$FORGEAX_MANIFEST_SHA256" \
  --publication "$FORGEAX_UNTOUCHED_PUBLICATION" --out "$FORGEAX_THROUGHPUT_OUTPUT"
```

The optional `--headroom-before` reuses a collector result at most five minutes
old. The automatic preflight defaults to at least 40% interval CPU idle, at most
50% background GPU utilization, normal memory pressure, at least 10% free memory,
zero swap/pageout deltas and no recorded thermal warning. These are explicit
preflight policy values, not universal hardware performance thresholds. The CPU
and GPU limits have named command options and are retained with the observation;
do not lower them solely to obtain a passing result. A failed preflight opens no
project and closes no background applications. `--skill-version` must match the
installed official skill (the qualified default is `0.3.11`).

Version `0.3.11` rejects the removed `automation_evaluate --args` option with
`INPUT_ERROR` / `deprecated_args`. Use a parameterless `--fn-source` function;
the throughput owner embeds only its fixed interaction boolean in that source.
This is a tool invocation failure, not a game startup or rendering failure.

`--publication` points to the untouched local output directory. Its complete
manifest is checked before the remote files. Additive IDE configuration metadata
is compared against those original bytes; a changed existing value or changed
runtime payload fails. Without the original publication, every remote file must
match its declared digest exactly. No cache or project configuration is rewritten.

Add `--interaction game-3d` for one complete actual-input run: idle, changing
joystick, changing camera look, and repeated editor open/close. Each phase owns
three counter windows and a concurrent 55-second Mac monitor; every monitor must
cover all its windows. The qualified coordinate map is deliberately limited to
the reviewed 794×368 simulator image and 2532×1170 framebuffer. A changed extent
stops for calibration rather than moving controls or lowering resolution. The
script checks actual World movement, camera change, contact release and editor
input isolation, records every official operation and its actual cadence, and
captures the resulting game and opened form outside timing. It uses the qualified
discrete touch route; it does not retry a timed-out swipe or call internal handlers.

Movement uses small 7-image-pixel joystick pulses around the starting position.
Each `touchstart` is followed immediately by `touchend`; only afterward does the
tool read World state and choose a return direction. There is no state read,
screenshot or monitor wait while movement remains held. A pulse whose complete
CLI envelope exceeds four seconds fails after release. Every state must retain a
grounded player within 2.5 horizontal units and 0.35 height units of the start.
These are explicit bounds for this unchanged scene, not a replacement collision
system or a simulated input path.

The first low-cadence circular-gesture experiment moved the player off the ground:
its height fell from 0.96 to -560.53 during the first window, then continued to
fall. The empty-scene screenshot explained its misleading higher FPS. Retain the
preceding idle windows separately; none of the subsequent movement, look or form
windows from that run qualifies full-scene performance. Completed frames alone
cannot establish that the intended workload remained visible.

The bounded-pulse rerun of non-recording publication `89ad67b994ba` (source
`63e7ee483`, UI WASM `8e1f615a…`) retained the scene in all five reviewed images.
Its 12 windows ranged from 33.30 to 36.39 completed FPS, with 0.45–0.82 official
operations/second during interaction. Nine pulses stayed grounded within 1.531
units of the start; all phase monitors covered their samples. This qualifies that
whole-game workload at its recorded cadence, not continuous UI updates or p95,
and does not transfer to a later UI payload without the relevant owner check.

One generation, clock origin and canvas extent must survive the whole run. The
script rechecks publication bytes, releases any attempted held touch on failure,
and closes only its `newopen` window, checking the close acknowledgement identity.
Existing windows are preserved; ambiguous selectors fail. A final Mac observation
is after the close acknowledgement, not proof that every shared IDE GPU process
has retired. `result.json` retains primary failures, monitoring failures and cleanup.

Read `completedThroughputAtLeast30` separately from `success`: success means the
measurement and cleanup finished. Sparse CLI operations can leave cached UI frames
between changes. Their rate is `nativeOperationsPerSecond`; aggregate completion
counters do **not** prove a continuously changing UI's 30–60 FPS or frame-interval
p95. `continuousUiFrameBudget` therefore remains explicitly `not-measured`.
Recorder-enabled publications are rejected for these uninstrumented windows.
The report retains the ordinary Host's RHI/Profiler capability observations; use
the separate [GPU UI capture path](#gpu-ui-capture-and-replay) for attribution.

The normal WeChat producer also supports `FORGEAX_ENGINE_RHI_DEBUG=1`. In that
Host, an available `rhiCapture` means a recorder backend and instrumentation were
attached during App assembly, even when no capture is in progress. A successful
ordinary build is therefore not necessarily an uninstrumented build. Produce the
performance publication with this variable unset or `0`, retaining the same
authored assets, shaders, native payloads and resolution. Reuse their unchanged
build outputs; keep the diagnostic package's manifest separately. Do not remove
the recorder guard or interpret its screenshot HUD as a benchmark.

Offline orchestration checks (not simulator or performance evidence):
`python3 -m unittest test_measure_game_throughput.py` from this skill's `scripts/`.

### Compare the same publication across hosts

A browser comparison needs the same complete World and frontend UI. An older
scene without Blitz cannot isolate simulator overhead. Freeze the ordinary
publication and native payloads, adapt only its Host seams, and record those
changes explicitly. Reusing the published module graph avoids accidentally
mixing newer package `dist` files into an older game. Preserve original publication
bytes, verify both deliveries before and after, and use the same existing
completion-counter calculation, physical extent and UI state on both hosts.

The 2026-10-12 MG32a comparison used source `32a18b8fd`, publication
`81268f503ab3`, wgpu WASM `4a423372…` and UI WASM `3c8462ff…`, with complete
3D content and Blitz GPU UI at 2532×1170 / DPR 3. Browser / official simulator /
Browser measured **27.59 / 34.71 / 25.82** weighted completed/presented FPS over
three ordinary counter windows per arm. Every simulator window exceeded every
browser window; this run does not support an extra simulator throughput penalty.
The return browser drifted −6.41%, which remains part of the result.

Browser was sandboxed headless Chrome 154 on ANGLE Metal / Apple M4 Pro;
the official simulator used its own visible host. All arms reported
`wgpu-webgl2`, but this run did not query the simulator's driver string. Shared
device GPU samples covered every window, with fresh admission and no new paging,
memory pressure or recorded thermal warning. These observations do not establish
an intrinsic host ranking, exclusive GPU cost, continuous changed-UI p95, stable
60 FPS or phone performance. Screenshots and headroom failures were retained;
the six actual Mac images were reviewed and owned windows were closed.

The local evidence is in `artifacts/cross-platform-host-ui/design-resumed/
mg32a-browser-blitz-01/mac-ab-a-01/`: `comparison-analysis.json`, its offline
analyzer, `image-review.json` and `README.md`. The frozen counterpart/archive
remained unchanged after measurement. A credit-limit experiment, if needed,
is a separate change with real completion, queue bounds and latency evidence;
these host measurements alone do not justify increasing the default limit.

Require the actual input witness before accepting an experiment's success flag.
An early credit-limit runner reported success although all three returned
`airborne: false`: its asynchronous wait result was never asserted. Preserve
that run as incomplete input verification. For asynchronous Host inspection,
poll awaited `page.evaluate` snapshots with a deadline and assert the observed
airborne state, subsequent landing and released control. A returned wait handle,
completed frame counters or a final standing-player screenshot cannot replace
those observations. Qualify the repaired collector before timing candidates.

The repaired Mac 2/3/2 experiment on that same complete publication measured
24.48 / 31.27 / 24.77 completed FPS (60 measured completions per arm), with
submission-to-completion callback medians 63.65 / 83.26 / 62.80 ms. The candidate
beats the better control by 26.26%, versus 1.16% control drift, but adds about
20 ms of completion latency; its completion-interval p95 is still 36.00 ms.
The default remains two pending frames. Increasing the allowed queue can raise
throughput while worsening responsiveness; callback delay is not GPU time or
input-to-display latency. Keep the actual queue high-water mark, matching/drained
receipts, input witnesses and resource lifetime alongside FPS before adopting
such a change. This run matches all 183 identities and all 368 deployed files,
with fresh admission, whole-run CPU/GPU monitoring and six reviewed images.
Shared GPU samples cannot isolate competing work. Evidence and owned-process
cleanup: `artifacts/cross-platform-host-ui/design-resumed/mg32a-credit-01/`.

When the official profiling API does not yield usable output, a DevTools instance
with an already-authorized debugging endpoint can expose V8 CPU profiling. Select
the exact current game's target without logging unrelated target URLs or tokens.
Use a bounded sample and stop profiling on all exits. Record profiler overhead;
do not use an instrumented run as the final frame budget result.

Use [profile_game_cpu.mjs](../scripts/profile_game_cpu.mjs) with Node 22+ on the
DevTools machine. Supply the owned window and its local publication. It matches
the qualified `/game/<window>/_sessionId/simulator-app-session-<window>/gamePage.html`
pathname exactly; override `--target-path` only for an observed version change.
It reads one existing endpoint without opening or reconfiguring the IDE or
attaching to neighbouring targets to identify them.

```sh
node skills/forgeax-engine-wechat/scripts/profile_game_cpu.mjs \
  --endpoint http://127.0.0.1:9422 --window "$FORGEAX_SIMULATOR_WINDOW" \
  --project "$FORGEAX_SIMULATOR_PROJECT" --manifest-sha "$FORGEAX_MANIFEST_SHA256" \
  --duration-ms 15000 --out "$FORGEAX_CPU_PROFILE_OUTPUT"
```

Wait for the `sampling-started` JSON line before the intended touch sequence.
`profile.cpuprofile` and `summary.json` preserve the sample, game generation and
counters, inspection keys, and stop/disable/socket cleanup. Identity checks cover
local `forgeax-dist.json`/`game.js` bytes and the caller-owned window path, not
bytes of already-executed JavaScript. This remains CPU attribution with profiler
overhead, separate from exclusive GPU timing and an uninstrumented frame budget.
Offline checks: `node --test scripts/test_profile_game_cpu.mjs` from this skill.

The current shared Nightly instance returned connection refused at the previously
qualified endpoint. The helper preserves `endpoint-unavailable`, verifies the
local publication first, and produces no CPU profile. That result does not
identify the CPU owner. Do not restart a shared IDE or inspect other games to
recover profiling. The CLI entrypoint is tested through real file and directory
symlinks, including the macOS `/tmp` to `/private/tmp` path distinction; an empty
exit-zero run without `summary.json` is not a sampling result.

When the shared IDE endpoint is unavailable, use an independently owned Chrome
with the existing complete Browser World assembly. The prepared scene runner
[run_game_scene_profile.mjs](../scripts/run_game_scene_profile.mjs) verifies its
complete file manifest, uses the ordinary App `resume`/completion/`pause` loop for
60-frame controls around a CDP CPU sample, and retains the profiler's overhead.
Do not replace that control with manually scheduled rAF or stepped-frame FPS:
App scheduling and completion credit can be the limiting owner. A scene-only
assembly excludes the frontend UI and cannot qualify whole-game WeChat FPS.
For tool changes, `--tool-verification` uses five real completion frames per
window after the unchanged 60-frame scene warmup; it verifies collection and
cleanup without publishing FPS. `--software` requires that explicit mode. The
default hardware measurement keeps every window at 60 completed frames.

If ordinary FPS is low while CPU sampling shows mostly idle time, use the same
runner's explicit `--mode receipts`. Its prepared entry must support
`runFrames(count, observeReceipts = false)`: run disabled/enabled/disabled windows
through the existing App loop, record `performance.now()` in the existing
`onFrameSubmitted` callback only when enabled, and retain the ordinary completion
callback's timestamp. Record `app.execution.report().frame` only at window start,
pause and after draining; the report clones its data and does not belong in a
per-frame probe. Bound submission storage to the measured window plus in-flight
receipts. Preserve partial evidence on failure and clear the observer on pause.

[The receipt analyzer](../scripts/analyze_frame_receipts.mjs) matches Device
generation, frame ID and World identity; it rejects missing/duplicate callbacks,
backward clocks and inconsistent pending/submitted/completed counters. Drained
receipts validate accounting but stay outside the 60-frame duration statistics.
The before/after disabled windows show observation sensitivity; because the World
advances, their difference is not an isolated hook-overhead measurement. Submission
callbacks follow synchronous Renderer submission, and completion callbacks follow
its successful receipt: their delta is CPU-clock completion latency, not GPU time
or display scanout. Tool-verification mode publishes no duration/FPS statistics.

Use these facts to select the next owner. A large `throttledTicks` delta with two
in-flight frames points to exhausted completion credit; first distinguish GPU work
from fence/notification delay. Few throttled ticks plus long submission intervals
instead require host frame-scheduling evidence. Never raise the credit limit,
replace the frame loop, or mark a fence complete to conceal unexplained waiting.

The separate [native submission timer](../scripts/measure_webgl_submission.mjs)
uses one actual WebGL `TIME_ELAPSED` query around one synchronous paused-App
submission, with no draw wrappers. It checks counter bits, existing query
ownership, disjoint state, context loss and bounded asynchronous availability;
missing capability or invalid results never become zero GPU time. Its interval
includes command-stream gaps and is not exclusive shader time. This different
scheduling mode cannot be subtracted from ordinary-loop CPU/control wall time.
In the wgpu WebGL surface path, `rhi-wgpu` schedules `Surface.present()` in a
microtask after the synchronous submission. Its fullscreen presentation draw or
framebuffer blit therefore lies outside this query. Report the measurement as a
synchronous scene-submission interval, never the entire displayed GPU frame;
a short interval does not rule out presentation cost or driver queueing.
Keep the real RHI timestamp capability result even when this native extension is
available. Do not enable developer extensions merely to obtain timing.

[analyze_game_scene_profile.mjs](../scripts/analyze_game_scene_profile.mjs)
summarizes retained receipts and V8 stacks without rerunning the scene. Optional
source mapping requires the measured manifest's exact map hash and the existing
`@jridgewell/trace-mapping` module path. Program/idle samples remain unclassified;
they are not GPU time. The root operator owns fresh host-headroom admission and
review of both local scene images. A software-driver tool check is functionality
evidence only; it does not close the hardware or simulator performance gap.

Instrument the actual canvas/context if native call timing is needed. Zero hits
on a prototype wrapper that the game never calls cannot rule out GPU work.
JavaScript time spent invoking GL is CPU submission cost, not GPU duration; a
small native-call sum alone does not qualify GPU performance. Avoid speculative
shader changes until real samples identify the costly owner. Restore every
temporary wrapper and prove the game continues afterward.

For a slow WebGL completion, record actual fence creation, poll times and native
statuses before changing scheduling. Timely polling with repeated
`TIMEOUT_EXPIRED` can reflect GPU work or delayed driver/browser status visibility.
Use `EXT_disjoint_timer_query_webgl2` when available: retain GPU elapsed time,
result-availability wall time and disjoint state separately. A disjoint sample is
invalid. `getSyncParameter` and `clientWaitSync` can share Chromium's cached state;
neither a second state query nor a fast `gl.finish()` proves the GPU is idle.
Chromium 136's public WebGL `finish()` [only flushes](https://github.com/chromium/chromium/blob/136.0.7103.177/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc#L3105).
This source observation does not establish the exact DevTools Chromium patch.

A real 2026-10-11 profile after host cleanup attributed 97.17% of sampled self
time to Blitz WASM, predominantly scalar Vello alpha compositing and slice copies.
The unchanged game still completed about 0.97 FPS. This prompted a real-WASM
reproducer: an infinite loading animation under a `display: none` ancestor kept
the entire UI dirty after loading completed. Keep hidden-animation scheduling,
visible-animation behavior and dynamic interaction performance as separate
regressions; a cached static frame does not qualify active gameplay.

The hidden-animation repair passed native, real-WASM and Chromium semantic
regressions. On a qualified Mac at 2532 x 1170 / DPR 3, 60 static callbacks then
produced zero rasters (`paint` median 0.20 ms). The same-source dynamic joystick
still took 41.28 seconds for 60 real updates: about 1.45 FPS, raster median
684.5 ms and p95 710.6 ms, input median 0.8 ms. This is a UI fixture measurement,
not complete 3D game acceptance. It establishes that dynamic CPU raster remains
a bottleneck even after correct animation invalidation.

That UI-owner investigation used a **30 completed UI FPS** floor and **60 FPS**
target, not a universal game acceptance threshold. Its Mac dynamic fixture kept
60 actual joystick updates, a frozen extent/DPR and operation sequence, and a
frame-interval p95 budget of 33.34 ms (16.67 ms for its 60-FPS target). New work
must declare its own [workload contract](#qualify-the-workload-before-measuring).
Observe real completion receipts. Keep synchronous pixel readback and the CPU
image oracle in a separate correctness run so those operations do not serialize
the GPU during performance measurement. Phone and whole-game results still need
their actual target environment and display size.

Before predicting a GPU improvement, separate style/layout, scene preparation,
fine raster/blending and copies/upload using actual call ancestry. A copy function
name alone cannot identify which stage owns it. If fraction `p` is replaceable,
`1 / ((1 - p) + p / speedup)` is an estimate under those assumptions; the infinite
GPU-speed limit is only an ideal upper bound. Upload, synchronization and retained
CPU work must be measured in the implemented path before claiming the gain.

## UI raster and final composition benchmark

The portable owner fixture uses the original startup, guide HTML/CSS and controls
at 2532 x 1170 / DPR 3. Build it with the existing WASM and licensed font; no Cook
is needed. Its default path verifies raster only. Add `--include-composite` to
run the production `ui-compositor` against the actual RHI canvas surface:

```sh
node skills/forgeax-engine-wechat/scripts/build_ui_gpu_benchmark.mjs \
  --engine-root /absolute/engine --out /new/ui-benchmark \
  --font /existing/font.bin --font-license /existing/FONT-LICENSE.txt \
  --backend wgpu-webgl2
node /new/ui-benchmark/run.mjs \
  --root /new/ui-benchmark --out /new/ui-results --backend wgpu-webgl2 \
  --playwright /absolute/playwright/index.mjs --chrome /absolute/chrome \
  --include-composite
```

The three correctness checkpoints compare final idle, active-joystick and vase-form
pixels to an independent CPU document composited over RGB `(32, 48, 64)` with the
existing maximum error of 0.05. Transparent and translucent pixel samples also
verify attachment load and premultiplied-alpha blending. WebGL surfaces expose
only `RENDER_ATTACHMENT`; their diagnostic readback reads the real presented
canvas before the browser discards its buffer, restoring GL bindings and pack
state. WebGPU uses a copy in the same submission. Screenshots, CPU reference work
and readback remain outside all timed loops. `--skip-cpu-reference` preserves the
screenshots but cannot establish CPU parity or those semantic pixel checks.

Before the first comparison, both independently initialized startup documents
must expose the same original FPS text and display state. The fixture polls for
at most two seconds without changing either startup, its clock or its timer. This
avoids comparing `FPS --` with `FPS 0.0` when only one original one-second timer
has fired. `facts.initialStateSync` records the before/after states and wait;
non-convergence stops initialization with `ui-benchmark-startup-state-timeout`
and retains the differing states. The wait is outside performance timing. The
real-WASM regression uses the original startup source and package `dist`; with
the current UI package built, run
`node --test skills/forgeax-engine-wechat/fixtures/ui-gpu-benchmark/__tests__/*.test.mjs`.

By default, the runner stops after those three checkpoints and disposes its
resources. Only add `--performance` after qualifying host headroom and arranging
concurrent monitoring. Composition performance reports three separate
60-completion phases: changed joystick UI,
cached UI with zero raster work and one final composite per frame, and a surface
clear control. The last phase omits UI solely to characterize the diagnostic
background cost; it is no quality or gameplay result. Do not subtract asynchronous
completion wall latencies and call the difference GPU time. One untimed raw-GL
sample per phase records actual draw/upload/presentation calls, and the changed
sample retains the producer's texture extents and instance byte counts. Wrappers
are restored before timing. No render feature, resolution or authored UI is
reduced to improve a comparison.

Retain `inputs.json`, actual backend/driver, timestamp capabilities, result receipts
and three screenshots. A software WebGL2 run can qualify owner correctness and
command structure; it cannot predict Mac GPU cost. This fixture contains no 3D
scene or simulator bridge, so even a passing UI budget cannot replace ordinary
game FPS, simulator or phone acceptance.

Before rebuilding, inspect the builder's actual `moduleInputs`: UI, native glue,
Render raster/compositor, RHI-wgpu and guide/controller inputs are aliased to
source, while some shared owners enter through existing `dist`. Refresh only
proven-stale imported outputs, then audit the new metafile and freeze its native
receipt and file hashes. A branch name or an earlier WASM result does not identify
the executed bundle. Later source edits do not retroactively update that fixture.

The 2026-10-12 Mac run with UI WASM `6b752f9d...`, clean Blitz fork `84a0d766...`
and native source digest `2e971ca1...` used the real M4 Pro ANGLE Metal backend:

| Phase | Completed FPS | Completion interval p95 | Raster / composite passes |
| --- | ---: | ---: | ---: |
| 60 continuous joystick updates | 60.23 | 18.10 ms | 60 / 60 |
| 60 cached frames | 60.01 | 25.20 ms | 0 / 60 |
| 60 background controls | 59.16 | Not reported | 0 / 0 |

All three reviewed images had maximum CPU-reference channel error 3/255, with
zero channels beyond 0.05. The continuous phase meets the 30 FPS / 33.34 ms bound;
near-60 throughput does not meet the stricter 16.67 ms p95 target. Its measured
synchronous CPU stages total 5.84 ms on average, including 4.96 ms in `paintGpu`
(84.96% of those stages). That is native CPU preparation, not GPU elapsed time;
internal style/layout versus sparse-strip preparation was not separately profiled.
The one untimed changed sample has two draws (strips and composite) plus present;
the cached sample has only composite plus present. Do not replace those facts
with the fixture's unwired `FPS 0.0` game label.

An initial busy-GPU preflight was rejected. After authorized old-Chrome cleanup,
the fresh preflight had 42-46% background GPU use. A separate monitor covered all
three timed phases, observing 51-57% GPU use and a 89.76%-idle overlapping CPU
interval, with no paging or thermal warning. Final process evidence had no new
Chrome PIDs beyond the qualified preflight. These coarse host observations and
approximately one-second phases are not per-process GPU timing or a thermal soak.
Further optimization needs an identified target bottleneck: the Mac owner already
runs near its 60 Hz callback cadence. To isolate simulator overhead, adapt the same
shared fixture to that host; comparing UI-only FPS with full-game FPS is not an
equivalent-workload comparison.

### Pair the browser and official simulator workload

Use the same `fixtures/ui-gpu-benchmark/benchmark.js` and `guide.js` on both hosts.
The host seam supplies canvas, resources, native WASM initialization and the
millisecond clock; the pixel oracle, actions and completion algorithm stay shared.
WeChat uses `createWechatPlatform`, `createWechatWasmHost` and
`createWechatWgpuHost`, with the first native canvas retained as the visible
surface. It installs the ordinary native standards before importing the workload.
It does not install `document`, `window`, `fetch` or `WebAssembly` shims.

Build both hosts from one verified existing browser fixture:

```sh
node skills/forgeax-engine-wechat/scripts/build_ui_gpu_benchmark.mjs \
  --engine-root "$FORGEAX_ENGINE_ROOT" --out "$FORGEAX_BROWSER_BENCHMARK" \
  --backend wgpu-webgl2 --reference "$FORGEAX_FROZEN_UI_REFERENCE"
node skills/forgeax-engine-wechat/scripts/build_ui_gpu_benchmark.mjs \
  --engine-root "$FORGEAX_ENGINE_ROOT" --out "$FORGEAX_WECHAT_BENCHMARK" \
  --backend wgpu-webgl2 --reference "$FORGEAX_FROZEN_UI_REFERENCE" \
  --host wechat --appid "$FORGEAX_APPID"
node skills/forgeax-engine-wechat/scripts/verify_ui_benchmark_pair.mjs \
  --browser "$FORGEAX_BROWSER_BENCHMARK" --wechat "$FORGEAX_WECHAT_BENCHMARK" \
  --out "$FORGEAX_NEW_PAIR_REPORT"
```

`--reference` freezes that fixture's generated startup, UI WASM and licensed font,
verifies its complete inventory, and requires matching current native glue and
wgpu payloads. It does **not** select later startup edits automatically. The
builder regenerates only JavaScript bindings/bundles and Brotli wrappers; no
Rust/WASM build or Cook runs. `inputs.json` retains `workloadIdentity`, all output
hashes, actual module hashes and each module's `bytesInOutput`. An included
metafile input with zero contributed bytes is not an executed stale dependency.

The native bundle uses `neutral` plus `forgeax-native` resolution. Browser package
conditions can select eager browser-only imports before standards installation.
The CPU oracle also shares a module with a PNG fixture: its unused decode must
tree-shake, rather than requiring an `atob` shim just to import the comparator.
The pair verifier executes the actual generated native bootstrap and cleanup in
a realm without browser globals, asserting no packaged read or WASM instance
before measurement starts. Its `renderingVerified: false` is intentional; it
does not create a GPU or qualify simulator output.

Run the paired browser artifact with the runner above and `--include-composite`
before importing the native project. Use a new owned simulator window and the
official `automation_evaluate` with parameterless `--fn-source` functions:

```js
() => GameGlobal.__gameContextWindow.__forgeaxUiBenchmark.read()
() => GameGlobal.__gameContextWindow.__forgeaxUiBenchmark.startNext()
() => GameGlobal.__gameContextWindow.__forgeaxUiBenchmark.readStep('initialize')
() => GameGlobal.__gameContextWindow.__forgeaxUiBenchmark.readFacts()
() => GameGlobal.__gameContextWindow.__forgeaxUiBenchmark.dispose()
```

Compare the returned identity to the local inventory first. `startNext()` returns
immediately; poll `read()` until `ready`, `failed` or `complete`, then retain the
original `readStep(method)` result. Steps are `initialize`, `active`, `form`,
then explicit `dispose`. The driver defaults to `mode: 'correctness'`; even an
extra `startNext()` after `form` can only dispose, never start a timed phase.
Capture and inspect an official screenshot after each of the first three steps,
before advancing. If host headroom has not qualified, retain these correctness
results and dispose. For a performance run, first qualify fresh headroom and
start a monitor, then explicitly call the following after `form` and before disposal:

```js
() => GameGlobal.__gameContextWindow.__forgeaxUiBenchmark.startPerformance()
```

This switches to `mode: 'performance'` and starts `performance`; subsequent
`startNext()` calls run `cachedPerformance`, `backgroundControl`, then disposal.
The monitor must cover the UTC start/end times of all three timed steps.
`startPerformance()` cannot skip any correctness checkpoint. Keep an external deadline per step;
repeating `startNext()` does not restart a pending or failed step. If execution is
stuck, save the state and close only the owned window, leaving the shared IDE.

Read final facts separately after cleanup; `read()` intentionally stays small.
`readFacts()` omits the three timed-phase objects already exported by `readStep`,
so it does not repeat 180 receipts in one CLI envelope. Keep each phase in its
own result file; the qualified official envelope limit is 65,536 characters.
`accepted` always requires successful cleanup and all steps required by `mode`:
the three pixel checkpoints for correctness, or all six steps with passing
timed-phase contracts for performance. A correctness acceptance makes no timing
claim. Early disposal cannot qualify an unexecuted workload. Keep
the 2532x1170 drawing buffer, CPU parity threshold, receipts and authored content
unchanged. This is an equivalent UI-only host comparison; ordinary game, native
input, phone and 3D performance remain their own acceptance paths.

## GPU UI capture and replay

Use the existing [RHI Debug route](../../forgeax-engine-rhi-debug/SKILL.md)
and [GPU UI inspection contract](../../../packages/rhi-debug/README.md#gpu-ui-work-and-retained-contents).
Retain one changed frame and one cached frame, inspect their selected work indices,
and compare live/replay images. The Renderer owns UI raster and scene composition
in the same tape; no separate UI recorder is needed.

The actual Dawn regression captured six raster works plus one composite for a
changed UI, then only one composite for its cached state. The cached UI texture
had nonempty initial data; both fresh-device replays had zero RGBA error. The
same tapes passed the ordinary CLI summary and pipeline/binding/pixel inspection.
This establishes useful UI inspection on that backend, not native WeChat capture
or performance. If the current Mini Game publication exposes no recorder,
preserve that unavailable result and qualify the shared owner on a capture-enabled
host; do not describe that tape as a simulator or phone capture.

For a native diagnostic candidate, build the ordinary project with
`FORGEAX_ENGINE_RHI_DEBUG=1 forgeax project build --target wechat --appid <appid>`.
The generated Host attaches the recorder after native wgpu initialization and
exposes the existing App capability at `__forgeaxGameInspection.rhiCapture`.
Omitting that build flag removes recorder imports, construction and inspection
fields from the generated Host. Preserve diagnostic and performance publications
as distinct artifacts; capture snapshots and resource readback affect timing.

After importing that candidate and reproducing the actual scene, use the
[native window capture workflow](rhi-capture.md). `capture_rhi.py --native-file
--native-root <explicit-sandbox-subtree>` exports one original artifact through
bounded copied/verified/acknowledged windows. It publishes the local `.rhitape`
only after whole-file SHA-256 verification and releases the temporary state.
Keep the project open until transfer and release finish. Small captures without
host filesystem access can explicitly use the existing 16 KiB JSON mode.

Wait for `renderer().phase === 'ready'`, `state === 'alive'`, `presented > 0`,
an available `rhiCapture.captureFrame`, and no active export. A 30-second official
call budget and separate 120-second readiness window accommodate startup without
requiring another 60-frame acceptance gate before diagnosis. Capture has its own
120-second snapshot bound. Inspect `error.detail.progress` on failure: resource
readback and `resource-hash` are separate stages, and a completed buffer mapping
does not establish that hashing or the entire snapshot finished.

A separate `--seed-max-resource-bytes 0` capture can obtain work, shader, binding
and resource structure without historical readback. It still needs the next real
Renderer frame. Retain `unseededResources`; cached textures cannot qualify replay
pixels until seeded or proven fully initialized before every recorded read.
Reproduce a visible UI change separately if changed-UI work is needed; an idle
frame containing only `screen-ui-composite` is not a missing-raster failure.

The initial full-native-file transfer successfully copied a 1,066,376-byte
structural tape. A later 16-MiB-per-resource seeded capture passed snapshotting
but exceeded native file-storage quota during append. This motivates the bounded
window transfer; it does not justify deleting caches or treating a partial file
as a tape. The seed cap is per resource, not a total snapshot budget. Follow
RHI Debug initialization/lineage evidence when selecting it.

The first successful structural frame had 538 commands, nine passes and 81 works:
56 shadow draws, 21 main-scene draws, one skybox, two postprocessing draws and one
`screen-ui-composite`. It contained no UI raster draw or UI clear-only pass.
Full shader sources, attachment extents and binding lineage survived omitted
seeds. The retained `ui-target:0` was unseeded; its replay pixels and replay-device
timings cannot qualify the live simulator. This is a useful diagnostic branch:
if idle UI has no raster work, inspect the actual scene/composite work and GPU
completion path before attributing the slowdown to Blitz painting.

Do not assume a non-disjoint elapsed query is a nonperturbing per-draw timer.
The actual simulator experiment wrapped 88 draw/clear operations with separate
queries. All 81 draws matched the tape's order, arguments and viewport, but
query durations summed to 30.90 seconds while all results were available within
2.69 seconds. Instrumentation itself consumed 934.5 ms. Those samples cannot
rank GPU hotspots or be added as frame cost. Some ANGLE Metal implementations
flush command buffers at elapsed-query boundaries; verify the target version
before attributing that behavior to it. Prefer one bounded query range per
ordinary frame, collect pipeline metadata separately, and retain a no-query
control plus actual Renderer receipts. A query result is not a FrameReceipt.

Check additivity even when queries cover whole passes instead of individual
draws. On the Mac, 54 of 60 total/segmented/total triplets failed closure:
segmented sums had a 24.345-ms median while adjacent complete ranges measured
12.484/12.656 ms. Those pass samples do not identify normal-frame hotspots.
Prefer at most one timed interval per frame and test a suspected optimization
with ordinary, query-free App A/B/A windows. Preserve presentation, fences,
credits and polling: adding a post-present `flush` in a timer can itself change
execution. Verify unchanged pixels and exact completion identities separately
before admitting throughput measurements on an idle host. A busy-host functional
pass, or Linux backed only by a software renderer, cannot establish that gain.

A subsequent query-free post-present `flush()` A/B/A on the same Mac Chrome
WebGL2 whole-game scene (without frontend UI) found no repeatable improvement:
60 completed frames per window measured 27.43 / 29.24 / 29.22 FPS; the treatment
beat the better control by only 0.10%, while the controls drifted 6.49%.
Completion callback medians stayed 56.84 / 56.67 / 57.02 ms. All 183 completion
and presentation identities, including drains, matched; output pixels matched.
Pre-run background GPU samples were 42–43% after permitted idle-browser cleanup.
This rejects that flush change for the measured path. It does not qualify the
newer ordinary publication, its UI, the simulator or a phone, and it does not
establish which GPU stage causes the delay. Reuse the same published scene,
backend, drawing-buffer extent and native packages for the next comparison.

To isolate hashing without graphics, run `build_digest_probe.mjs --engine-root
PATH --out NEW_DIRECTORY --appid LOCAL_APPID`. It bundles the actual
`digestBytesAsync` source and records its digest; no App, Renderer or canvas is
created. In that separate Mini Game, official automation calls
`GameGlobal.__gameContextWindow.__forgeaxDigestProbe.start()` once, then `read()`
until complete. Each 64-byte / 1-MiB case reports native provider selection,
completion/timeout, elapsed milliseconds and equality to a Node-produced hash;
forced fallback calls the same owner with crypto temporarily shadowed and
immediately restored. Each case has a two-second timer budget. Keep an external
15-second observation deadline and stop that probe afterward. This diagnoses the
digest owner; it does not measure game rendering or exercise the fallback's
multi-chunk yield, which starts only above 1 MiB.

## Causal draw omission on an aligned live frame

Use [draw_omission.mjs](../scripts/draw_omission.mjs) when completed frames are
slow and timer queries cannot isolate GPU work. It prepares one configurable
observer from an already verified RHI-to-GL alignment; it does not open a project
or own another capture/replay model. Select existing `FrameModel.workIndex`
values from the [RHI Debug](../../forgeax-engine-rhi-debug/SKILL.md) pipeline/pass
inspection. A groups JSON is an array of `{ "name": "control", "workIndices": [] }`
followed by named groups whose `workIndices` identify the draws to omit.

```sh
node skills/forgeax-engine-wechat/scripts/draw_omission.mjs \
  --alignment "$MATCHED_ALIGNMENT" --tape "$RHI_TAPE" \
  --publication "$WECHAT_DIST" --groups "$GROUP_SELECTIONS" \
  --out "$DIAGNOSTIC_OUTPUT"
```

`--publication` is the actual `forgeax-dist.json` inventory, not a shader
manifest. Preparation requires an independently verified alignment, unique work/event
indices, full bounded argument values and an unmodified first group. It writes
`plan.json` and the function expression `install.js` to a new directory. The plan
retains the alignment, tape and publication filenames, byte counts and SHA-256
identities. It validates the supplied alignment projection, but does not decode
the tape or repeat shader/pipeline mapping verification; the hashes provide
provenance for that prior inspection. It is valid only for that publication and matching scene structure;
these file identities do not independently verify the currently open project.
Re-align after changing the build, camera, assets or work roster.

Evaluate the generated function in the actual simulator realm, passing the
explicit canvas and native receipt reader with the parsed plan:

```js
// install = function expression in install.js; plan = parsed plan.json.
install({ canvas, plan, readReceipt: () => g.__forgeaxGameInspection.renderer() });
// Read until phase === 'done', saving the result before release:
globalThis.__forgeaxDrawOmissionProbe.report();
globalThis.__forgeaxDrawOmissionProbe.release();
```

Every group uses five natural submissions. The first two completed frame IDs
are marked for exclusion because prior submissions may still be in flight;
the final three provide up to two completion-observation intervals. The 10ms
native receipt reader retains raw frame IDs, observation times and coalesced
jumps. A shared observation is not several exact completion timestamps. The
observer never calls GPU query/state getters, schedules a frame, changes scene
configuration or suppresses a clear/state/resource operation. Only selected void
draw calls are omitted. Original receivers, arguments, results and exceptions
are forwarded for other calls.

Each frame starts at the first exact operation of the aligned sequence. Only
preceding presentation blits are forwarded and logged outside that frame; every
operation inside it must match its method and complete argument values before
any omission. Cross-realm typed arrays are compared by their elements, without
constructor identity. Matching draw arguments does not prove unchanged uniforms,
textures, viewport or pixels; retain the publication and actual scene state.
A mismatch aborts and restores the methods. Group skip/forward counts derive
from selected work indices, so no scene-specific event ranges live in the script.

The final sample fence restores methods immediately. Completion then requires a
native ready frame ID newer than the final sample. Generation/device replacement,
exceptions, cancellation, a replaced method wrapper and the 30-second overall
deadline also stop the probe. Polling checks wrapper ownership through JavaScript
property descriptors, without GL state queries.
Check `methodsRestored` and terminal status. `cancel()` preserves evidence;
`release()` removes the temporary API. Failed cleanup is reported explicitly.

`report()` always returns a small summary with `paged: true`. Read each listed
collection (`groups`, `samples`, `receiptObservations`, `prefixExclusions`) using
`read(collection, offset, 4)` until `nextOffset === total`; honor `retryCount` if
a page is too large. The page budget includes the official pretty-printed
`automation_evaluate` envelope, another escaped JSON layer and 4 KiB of reserve,
with a 32 KiB ceiling. Measuring only compact JSON was insufficient: a real
split-material run reached the 65,536-byte stdout cut despite passing that old
check. The regression reproduces this exact wrapping/truncation failure before
verifying complete paged reconstruction. Keep the failed run and its already
complete responses; do not claim all samples were recovered. Evidence limits
abort explicitly rather than silently dropping rows.

Omission deliberately changes pixels and is a diagnostic experiment, never an
optimization or visual acceptance result. On the 2026-10-11 matched simulator
frame, omitting UI retained approximately 0.94-second completion intervals,
while omitting all draws reduced later intervals to 11–31ms and restoration
returned to roughly one second. A separate four-group run retained 914–937ms
for normal, no-shadow and no-post, but no-main reached 25.8/25.6ms. All groups
retained the original 88-operation/81-draw input structure and all clears. This
supports inspecting the main-scene work; it does not identify one shader or
establish that timer values are additive. Keep the raw reports and distinguish
subsequent material/pipeline isolation from any eventual owning fix.

The extracted tool then completed all 20 actual frames of a material-group run:
normal 932.3/939.7 ms; omitting 13 main draws 707.7/702.8 ms; omitting works
57–60 858.4/862.6 ms; omitting works 65, 71–73 289.4/284.0 ms. Every retained
completion was observed at its exact frame ID, without coalescing. Restoration
and subsequent ordinary ready frames passed, and before/after images were
reviewed. The same-run 45-second monitor covered all groups: CPU idle
89.48–95.65%, GPU mostly 99–100% during drawing; preceding GPU load was 36–72%.
This narrows the next causal comparison to the last four works while retaining
shared-host contention and possible depth/occlusion effects as interpretation
limits. It does not justify removing those draws from the game.

Validate helper changes with `node --test scripts/test_draw_omission.mjs` from
this skill directory. To exercise a prepared target plan in the controlled
harness, set `FORGEAX_DRAW_OMISSION_PLAN` to its `plan.json`; this adds structural
verification, not real GPU evidence.

## Equivalent shader A/B/A after work isolation

After draw omission identifies a candidate, use the
[actual shader collector](shader-sources.md) to obtain its complete compiler input
and retain the program-to-RHI mapping. Prepare one minimal change with original,
candidate and publication hashes; prove the unchanged table bytes, read/write
sites and valid index range. Keep this source proof separate from actual driver
correctness and performance; it does not identify a driver optimization.

1. Validate on Mac first: compile/link the **complete original and candidate
   vertex/fragment programs**, then compare the extracted affected kernel against
   an independent numerical oracle and a deliberately broken falsifier. Preserve
   raw output and full original/candidate pixel comparison. Keep CPU half decode,
   `texelFetch` plus explicit high-precision interpolation, and native half-float
   `LINEAR` filtering as separate reference paths. A representation pass must not
   erase a failed stricter native-filtering gate or relax its tolerance.
2. Apply an experiment-specific bootstrap only while its project is closed.
   Guard both the publication digest and the current bootstrap against the known
   original/control/candidate bytes; refuse a newer owner, atomically replace,
   and read back the result. Reuse the remaining payload/WASM/assets unchanged.
   Match the **entire captured source** at initial `shaderSource`, forward the
   exact control or candidate, then restore wrappers immediately. Never relink a
   live program: wgpu has already cached its uniform locations. `forwarded` alone
   is insufficient; re-collect the actual ready program and verify its source SHA.
3. Run A/B/A with the existing aligned receipt observer and **empty omission
   selections**, retaining every draw/clear/state call. Require exact frame IDs,
   no coalescing, matched arguments and successful wrapper restoration. Keep
   source collection, screenshots, paging, GPU queries and GL getters outside
   timing. Use the same extent, scene and predeclared warm-up/exclusion rules.
   A final return to A distinguishes a repeatable direction from a one-way change
   in host conditions.
4. Release probes, close the candidate context, restore the original bootstrap
   with the same guards, and verify normal startup/source identity in a fresh
   context. Restoring JavaScript wrappers does not retire an already compiled
   candidate program. Preserve failure and restoration receipts separately.

Collect driver-translated source only outside timing. The Mac Chrome experiment
changed emitted MSL from thread-local table initialization to a constant
representation. That proves the observed translation; it does **not** prove
register allocation, spill, or physical copying of the 1 KiB table per invocation.
The official simulator returned empty translated source, so it cannot inherit
Mac Chrome's MSL mechanism. Require evidence from the actual driver before
assigning the speedup to a lowering detail.

Inspect the headroom monitor's **time coverage and values**, not only its exit
code. The observed shared-project GPU baseline was roughly 40–46%; sample-time
GPU activity was mostly 99–100%, despite high CPU idle and no paging/thermal
warning. This supports a bounded contention-aware comparison, not spare GPU
capacity or an isolated performance ceiling. Do not close unrelated shared
projects to improve the number. Receipt polling measures observed natural-frame
intervals, including scheduling/queue/driver effects; it is not exclusive shader
GPU time. Keep all eligible samples, including outliers, and distinguish a few
correlated intervals from independent repetitions or a tail-latency distribution.

The 2026-10-12 packed-DFG experiment inserted only `const ` into the actual GLSL.
Mac complete-program compilation, explicit interpolation oracle, bit parity and
falsifier passed; native RG16F `LINEAR` precision retained `combinedPass: false`
at the original 2e-6 tolerance (maximum error 0.000244140625). Simulator A/B/A
forwarded all 88 operations / 81 draws: A **945.5/945.8/940.9/2103.5 ms**,
B **400.5/362.2/365.1/356.2 ms**, A2 **932.1/942.6/934.5/933.7 ms**. Each phase
used two five-frame groups, discarded the first two completions per group, and
retained four within-group intervals. Medians of 945.65/363.65/934.10 ms support
an approximately 2.6× directional improvement, without a precise stable multiplier,
production 30–60 FPS, or phone acceptance. Reusable experiment assets and proof
are under `artifacts/cross-platform-host-ui/design-resumed/shader-const-diagnostic/`:
`prepared/proof.json`, `apply_bootstrap.py`, `webgl2/mac-02/`, the three
`simulator-{control-02,const-01,control-return-01}/` runs and `read-only-analysis.md`.

The subsequent shared-WGSL repair was measured again in an ordinary publication,
with all affected materials updated and no frame/GL hooks. At 2532×1170, three
game-clock counter windows measured 34.44, 31.26 and 35.15 completed/presented FPS
(1,147 frames / 34.12215 seconds overall). Bind all windows to the same game
generation, `GameGlobal.__gameContextWindow.performance` clock and canvas extent;
retain finite timestamps plus a Mac UTC anchor. Verify the actual GPU sample
timestamps cover those windows, rather than using the headroom script's later
exit time. Keep screenshots outside timing and recheck publication/bootstrap
identity afterward. The result qualifies these observed windows, not active
input, a frame-time distribution, stable 60 FPS or a phone budget. See the
[verification report](../../../packages/platform/VERIFICATION.md) for the
publication, machine conditions and retained cleanup recovery.

## Recorded CPU/GPU comparison: Mac, 2026-10-11

A bounded 10.05-second CDP profile of the repaired CPU joystick fixture contained
6,645 samples. Classification used the full call ancestry and mutually exclusive
self time: fine raster/blending 50.814%, copies **inside raster** 37.752%, strip
preparation 0.444%, scene preparation 0.030%, style/layout 0.091%, JS/native 0.670%,
GC 0.030%, and missing WASM parent stacks 10.168%. Contextual occurrences placed
10.081 percentage points of the orphan helper symbols exclusively below raster;
that last attribution is an inference. The confirmed replaceable 88.566% yields
an ideal 8.75× bound (78.27 ms residual from the 684.5-ms baseline); including the
symbol inference yields approximately 73.9× (9.26 ms). Both assume zero GPU,
upload and synchronization cost and are not measured GPU gains. The profile run
itself had 665.5-ms median raster time; retain 684.5 ms as the unprofiled baseline.

The implemented GPU route was then measured from Engine source `0a4ea48177dadd12`
with matched WASM SHA-256
`63cd0d037e68ee3c48f1d570df01ea472915908007931ebf0b2e27a030de3202`.
Two Documents consumed the same actual startup/guide HTML, CSS, font and control
code at **2532 × 1170 / DPR 3**. Idle, active joystick and open vase form all
passed full premultiplied RGBA comparison: maximum channel difference **2/255**,
zero channels outside ε=0.05. The three actual Mac screenshots were reviewed.
Share the initialized WASM host object across both Documents; separate host
objects correctly fail with `ui-wasm-host-mismatch`. Never call CPU `paint` and
`paintGpu` on one Document for a comparison: the first consumes its dirty state.

After eight untimed GPU warm-up updates, **60 real joystick updates emitted 60
movement intents and completed 60 GPU submissions in 1003.8 ms: 59.77 completed
FPS**. Each update changed the authored joystick and generated its actual sparse
strips. Completion came from `device.queue.onSubmittedWorkDone()`; the hot loop
performed no CPU reference rendering, pixel readback or per-frame completion wait.

| Measured phase | Median | p95 |
| --- | ---: | ---: |
| Input dispatch | 0.4 ms | 0.5 ms |
| `paintGpu` CPU preparation | 5.0 ms | 5.3 ms |
| RHI resource preparation | 0.2 ms | 0.3 ms |
| Command encoding | 0.0 ms | 0.1 ms |
| CPU `submit` call | 0.0 ms | 0.1 ms |
| Submission-to-completion wall latency | 1.3 ms | 1.5 ms |
| Completed-frame interval | 16.6 ms | 19.4 ms |
| rAF callback interval | 16.7 ms | 19.0 ms |

Zeroes reflect timer resolution, not absence of work. The completion wall latency
includes queue, driver and notification overhead; it is **not** a GPU timestamp
measurement. This passes the ≥30-FPS / p95≤33.34-ms UI-owner budget and averages
near 60 FPS; p95 19.4 ms does not meet the 16.67-ms target. It does not qualify a
complete 3D game, the official WeChat simulator or a phone.

Fresh headroom at 08:17:45–08:18:01 UTC showed 95.18%, 95.23% and 98.13% CPU
idle and 35 GiB unused memory after authorized old-Chrome cleanup. The separate
08:18:09.718–08:18:25.224 UTC monitor covered the entire valid benchmark
(08:18:09.865–08:18:20.353): interval idle 83.87%, 88.50%, 96.61%, 34–35 GiB
unused, normal pressure, no new swaps and no thermal/performance warning. An
earlier failed attempt stopped at the mismatched WASM host before measurement;
its failure remains separate from this result.

The same authored UI also passed the Mac `wgpu-webgl2` minimum through the reusable
runner: 60 intents and 60 completions at **59.78 FPS**, completion interval p95
**21.2 ms**, CPU preparation median 4.5 ms and submit-to-completion wall median
4.6 ms. The physical extent and DPR were unchanged. CPU reference painting was
explicitly skipped; the three GPU images were reviewed, without claiming a new
full-image numeric comparison. The same-run GPU sample reported 32% Device /
Renderer utilization; interval CPU idle was 68.43%, with no new paging or thermal
warning. This remains a UI-owner result. The separate ordinary browser scene with
DOM UI completed 228 frames in 10,004.45 ms (22.79 FPS); neither result qualifies
the much slower official simulator game.

## Reuse CPU owner attribution

Use the same lightweight UI benchmark with explicit `--cpu-profile` to capture
V8 CPU samples. This diagnostic mode is mutually exclusive with `--performance`:
its successful result requires the same 60 completed dynamic raster frames and
movement intents, but does not grant an FPS acceptance pass. The ordinary
uninstrumented acceptance mode and its full three-phase roster are unchanged.
Qualify host capacity and pause other heavy work before collecting a comparison.

```sh
node skills/forgeax-engine-wechat/scripts/run_ui_gpu_benchmark.mjs \
  --root "$UI_BENCHMARK_OUTPUT" --out "$UI_CPU_PROFILE_OUTPUT" \
  --playwright "$PLAYWRIGHT_ENTRY" --chrome "$CHROME_EXECUTABLE" \
  --backend wgpu-webgl2 --include-composite --cpu-profile
python3 skills/forgeax-engine-wechat/scripts/analyze_ui_cpu_profile.py \
  "$UI_CPU_PROFILE_OUTPUT"
```

The runner preserves input hashes, source provenance and its own script digest.
It records `profile.cpuprofile` around the existing dynamic method, including its
warmup and one GL observation; the three correctness captures occur before
sampling. A failed method still attempts to save `failed-profile.cpuprofile`,
disables profiling and closes the owned browser. The analyzer writes
`cpu-attribution.json` and `paint-sample-stacks.json`. Only actual `paint_gpu`
ancestry enters the paint denominator; generic type names do not establish a
layout call. Missing native ancestry is reported as unavailable rather than
attributed to a guessed owner. The profile's `(program)` samples are not GPU time.
Keep direct stage timings alongside sampled attribution; 1 ms samples and
inlining limit small-stage precision.

`frameStageSamples` also tracks the full JS input and `paintGpu` call ancestry,
including document resolution before native `paint_gpu`. Its child values are
inclusive subsets of each stage, not separate costs to add. Compare the analyzer's
per-frame `inputPlusPaintMs`, including P95 and maximum, when changing input or
layout scheduling. For example, honoring `touch-action:none` removed a redundant
scroll attempt, but the same pending layout then ran during paint: input median
fell from 1.3 to 0.6 ms while paint rose from 4.3 to 5.0 ms, and their per-frame
sum stayed near 5.6 ms. This is a functional correction, not a measured CPU or
FPS improvement. The analyzer can derive this distinction from retained profiles
and receipts without another run.

Retain one planned A/B/A batch and the original profiles. Compare identical
workload/module inputs, actual GL facts and original GPU pixels before reporting
a source-specific speedup. Do not repeat a batch to select better numbers. The
analyzer can reprocess existing files without rendering or rerunning a benchmark.

For native strip-kernel changes, inspect generated WASM as well as source. A
finite-bound clamp can remove redundant NaN handling and memory spills while
LLVM unrolls more arithmetic, so fewer total static instructions is not the
acceptance criterion. Preserve exceptional-value semantics and compare the same
geometry corpus on scalar WASM, diagnostic SIMD128 and native fallback/SIMD
before checking the complete UI. Kernel gains do not imply equal UI or FPS gains.
If a tail receipt remains slow, inspect its retained sample neighborhood for
input parsing, JS collection and GC; keep the original P95 and maximum even when
the native kernel is faster. Sample order is not calibrated GC wall time.

When `/tmp` is full, place compiler and browser temporary files on a volume with
space. Chrome's Unix `SingletonSocket` also needs a short `TMPDIR` path; a deeply
nested artifact directory can fail before page launch. Use a caller-owned short
directory on the spacious volume rather than disabling the sandbox.

### CPU cluster-membership allocation: Android, 2026-10-13

The ordinary phone's `wgpu-webgl2` path reported one admitted local light,
3,456 clusters and 2,160 emitted membership indices. Its `cpu-texture` lighting
transport means CPU-generated light membership consumed by GPU shaders; it does
not mean that the scene is rasterized on the CPU.

The [membership producer](../../../packages/render/src/pipeline/standard-lighting/membership.ts)
allocated its full 1,048,576-index GPU capacity on every frame. Each light can
occur at most once per cluster, so commit `459a4ae6c` bounds the CPU backing array
by `min(GPU capacity, cluster count × local-light count)`. GPU layout, complete
cluster-major membership and the overflow limit stay unchanged. This scene's
backing allocation drops from 4 MiB to 13.5 KiB per frame; uploaded index data
remains 8,640 bytes. Across 120 frames this avoids 478.418 MiB of cumulative
allocation, not retained memory or a measured amount of GC time. Zero-light,
mixed-light ordering and overflow regressions exercise the same producer.

One intrusive stationary A/B/A batch used identical CPU controller, adapter and
completion-observer bytes, with debug enabled throughout. A0 preceded B by
46.356 minutes; A1 reran the unchanged baseline 3.487 minutes after B. All three
captured 120 complete App/Renderer CPU frames and 10,320 events without drops or
failures. Display (3,203 × 1,440), camera, admitted lights and render profile
matched; animation phase was not synchronized. Means below are inclusive
`Platform.now` elapsed wall durations, not OS scheduled CPU time. Repeated phase
occurrences are summed within each frame before deriving distributions.

| Metric | A0 baseline | B bounded allocation | A1 repeated baseline |
| --- | ---: | ---: | ---: |
| App mean ms | 19.497 | 15.729 | 17.159 |
| Renderer mean ms | 15.509 | 12.118 | 13.739 |
| World mean ms | 3.952 | 3.573 | 3.392 |
| Lighting-prep mean ms | 2.231 | 0.485 | 2.518 |
| Lighting-prep p95 ms, nearest rank | 5.624 | 2.191 | 5.383 |
| Completions in eight seconds | 211 | 220 | 212 |
| Diagnostic completions/s | 26.375 | 27.500 | 26.500 |
| Completion interval p95 ms, nearest rank | 51.082 | 51.459 | 51.953 |

The lighting-prep reduction repeats against both baselines (78.3% and 80.7%).
App elapsed improves 19.3% against A0 and 8.3% against A1; A1 itself is faster
than A0, and B's World/extract phases are slower than A1. Do not attribute every
changed phase to allocation or turn 120 correlated frames into a confidence
claim. The remaining roughly 27 completions/s requires separate scheduling/GPU
evidence; a shorter App phase is not a clean-FPS or 60-FPS acceptance result.

The candidate retained the frozen source base plus 23 existing owner overlays
and this membership change, rather than a complete current-HEAD checkout.
Raw report SHA-256 identities, in A0/B/A1 order, are:

```text
ffcaf93f744e6bbec3fc37c9b3cff7f5b895cfb3584a33e53001826178c2c8b4
f35898b8b0d9f1cf48ad88a074f71fa22a95c4b51280c2a976792b443dcf32d7
04d7937092b9ed8017627a95b6b735be2ee61fcb00d23824b6216de65a0969a5
```

Both baseline HTTP bodies match their declared lengths/digests and successful
saved responses. B's local receiver retained the report without its raw HTTP
envelope. A1's overall headroom collector overlaps only 5.330 of the observer's
eight seconds; its last actual CPU-counter read ends earlier still. Distinguish
CPU/process read spans from the collector's later memory/thermal completion.
Thermal status was zero while the GPU cooling-device value remained 2; neither
that vendor state nor idle CPU proves unrestricted GPU frequency. Preserve the
partial coverage and uncalibrated cross-device clock offset; do not admit this
batch as whole-window headroom or final performance acceptance.

## Reuse the lightweight owner benchmark

The production-composite variant also passed on Mac on 2026-10-11. With actual
ANGLE Metal / Apple M4 Pro WebGL2, the same UI and 2532x1170/DPR3 completed 60
changed updates at **60.23 FPS**, interval p95 **19.0 ms**. Cached composition
completed 59.92 FPS, p95 24.9 ms; the separate surface-clear control completed
59.22 FPS. All three correctness states had maximum CPU/GPU pixel error 2/255,
and their screenshots were reviewed. This run included the real final composite
and no timed readbacks. A simultaneous monitor covered the whole run: interval
CPU idle 80.27–89.24%, GPU 48–56% during timed phases, no new paging or thermal
warning; shared-host GPU baseline was approximately 42%. Untimed startup briefly
reached 94% GPU. These results qualify the UI owner on that host, not the full
3D scene or the slower official simulator. Retain the exact run's `inputs.json`
projection inside `result.json` rather than inheriting this historical pass.

[build_ui_gpu_benchmark.mjs](../scripts/build_ui_gpu_benchmark.mjs) bundles the
selected checkout's actual UI/guide/startup sources and copies its already-built
matched WASM. It uses the checkout's existing bundler, writes a new output
directory and records byte hashes plus kernel provenance; it does not Cook or
build a WeChat publication. Supply the same licensed font for comparisons.

```sh
node skills/forgeax-engine-wechat/scripts/build_ui_gpu_benchmark.mjs \
  --engine-root "$FORGEAX_ENGINE" --out "$UI_BENCHMARK_OUTPUT" --backend webgpu \
  --font "$UI_BENCHMARK_FONT" --font-license "$UI_BENCHMARK_FONT_LICENSE"
python3 skills/forgeax-engine-wechat/scripts/mac_headroom.py \
  --config "$FORGEAX_MACHINE_CONFIG" --out headroom-before.json
```

Inspect headroom, transfer the generated directory through the established
machine transport, then run its copied runner **on the Mac** with the existing
Node, Playwright and Chrome installations. Start a second headroom capture
concurrently and retain both reports. No machine addresses or credentials are
embedded in the scripts.

```sh
node "$UI_BENCHMARK_REMOTE/run.mjs" \
  --backend webgpu --performance \
  --root "$UI_BENCHMARK_REMOTE" --out "$UI_BENCHMARK_RESULTS" \
  --playwright "$PLAYWRIGHT_ENTRY" --chrome "$CHROME_EXECUTABLE"
```

Choose `--backend wgpu-webgl2` in both commands for that actual RHI path; the
builder includes and verifies its matched native inputs. When reusing applicable
reference evidence, `--skip-cpu-reference` omits CPU painting and records that the
run has no new numeric parity result. GPU screenshots remain outside the timed loop.

The [runner](../scripts/run_ui_gpu_benchmark.mjs) launches sandboxed Chromium,
performs three correctness comparisons/screenshots and cleanup by default.
The explicit `--performance` flag enables the fixed 60-update performance
sequence after those comparisons. Its `result.json` records `mode`; performance
receipts and timings are present only when that sequence runs. It closes its
browser/server on exit. The WebGPU measurement above
used the original diagnostic artifact; the WebGL2 measurement used this extracted
runner. Use generated `inputs.json` and the recorded actual backend to identify
each run rather than inheriting either historical pass.

After the owning fix, repeat the original operation and acceptance bounds on the
same package conditions. Preserve the original failure; a late eventual frame does
not turn a timed-out gate into a pass. Use the [verification contract](verification.md)
for completed frames, lifecycle, package identity and final evidence.

### DFG fit and opt-in texture verification

The packed-array `const` experiment above is a historical performance baseline.
The follow-up Standard contract uses the UE Lazarov analytic DFG fit by default;
`directMultiscattering: 'lut'` explicitly requests the shared GPU texture. See
[the shader contract](../../../packages/shader/README.md) for the approximation,
source pin, numeric differences and native-filtering precision. Do not describe
this work as removing per-frame BRDF integration: integration was already offline;
the original problem involved repeated private-array initialization and lookup.

Verify a release through the ordinary material cook and host build. Reject stale
`three_r184_dfg_lut` arrays in the emitted manifest and actual driver GLSL. A
fit-only material must have no DFG texture binding; an opted-in material must use
the original 1024-byte RG16F resource, uploaded once per DeviceScope. Shader
source text alone cannot establish that the selected material or device received
the intended variant. Keep the publication manifest and completed-frame evidence.

Include the actual Renderer boot registry in publication regressions. A compiled
manifest can contain valid fit/LUT programs yet fail before the first scene frame
if an internal compute utility is registered as a material. The DFG iteration
reproduced this with a ray-kernel identifier outside the existing
`forgeax::engine-*` namespace: boot added material admission axes that the kernel
did not declare. Fix the producer/consumer identity together and retain a boot
regression; changing WGSL math or clearing the IDE cache cannot repair this error.

Before reporting a speedup, use the same game, framebuffer extent and input state,
qualify Mac CPU/GPU capacity, and collect resource samples over the measurement
window. Normal game counters supply aggregate throughput; interval tails require
the bounded [completion observer](#qualify-the-workload-before-measuring).
A fitted-vs-LUT comparison also changes the shading approximation; show the
target's result and label that quality tradeoff rather than claiming
pixel-identical optimization. Run the relevant compute and real WebGL shader
gates, then qualify the requested delivery target, reusing unchanged host checks.

The corrected ordinary publication `51fc5ad9b4d6` was verified in the official
simulator at 2532x1170: 119 completed / 95 presented frames at readiness, then
34.98 / 35.67 / 35.39 FPS across three unhooked windows (35.34 aggregate).
Both screenshots were reviewed and simultaneous capacity observations cover all
samples. This is close to the prior 33.61-FPS const-table checkpoint; it does not
establish sustained 60 FPS or phone performance. See the
[verification record](../../../packages/platform/VERIFICATION.md#direct-light-dfg)
for build identities, GPU/CPU observations and the approximation tradeoff.

For a simulator-versus-browser question, use the
[native WebGPU DFG experiment](../../../packages/render/scripts/README.md#direct-dfg-on-native-webgpu)
before attributing the problem to WeChat. It composes the actual old and current
shaders, reports GPU timestamps separately from submission wall time, and checks
native filtering against an independently extracted historical texture. The
original strict array/filter comparison remains visible even when it fails;
do not silently relax it or present the fit as pixel-equivalent. The
[Mac result](../../../packages/platform/VERIFICATION.md#direct-light-dfg)
confirms benefits outside WeChat, while also showing texture slightly faster
than fit on that adapter. A subsecond kernel result and one-second utilization
samples cannot establish sustained game FPS or per-phase absence of contention.

The KB Unreal checkout was recovered from a user-supplied ZIP into the root
Its HEAD is `71fe36aac5a8df5ccd66c763ffc902b29b6a9c43`; `BRDF.ush` matches tree blob
`253eb4d459645cd815f2ad4d66275bc4550ba425`. This is a sparse/partial Git checkout:
other missing files can trigger a fetch to a currently unavailable private remote.
Inspect local file/blob availability before expanding the sparse set, and retain
private source locally instead of copying it into Engine commits.
