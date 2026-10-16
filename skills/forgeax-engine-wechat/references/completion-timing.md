# Frame and completion timing

For short receipts but slow frame supply, inspect [Host request timing](#host-request-timing-when-receipts-are-prompt).

Use the browser recorder below when ordinary game submissions/completions arrive
in batches and a CPU profile cannot distinguish GL status visibility, timer
wakeups and App delivery.
The [passive recorder](../scripts/browser_completion_timing.mjs) observes existing
calls. It issues no GL command, extra status query, timer, rAF, flush or blocking
wait, and does not change frame credits. Keep this diagnostic separate from
uninstrumented FPS acceptance: wrappers and clock reads still have overhead.

## Native phone or simulator completion diagnosis

Use the opt-in native probe when receipt delivery is slow and WebGL has no
hardware timestamp queries. It observes the real native completion driver and
its original 0/1 ms timers, existing sync-import/clientWaitSync calls, and the
ordinary Platform request/callback path. It never changes the poll policy, adds
a query, flushes GL, changes frame credits, or substitutes the driver's returned
Promise. These wrappers and CPU clock reads are intrusive diagnostics, not clean
FPS acceptance. Keep native debug state unchanged.

Build a fresh publication with the existing benchmark builder and explicit
`--target phone --phone-mode cpu --cpu-frames 120 --completion-timing` (or
`--phone-mode timed` without CPU profiling). Supply the ordinary publication,
source provenance, tool dependency root, new output directory, control URL and
run ID as described in [gameplay performance](gameplay-performance.md#run-on-an-android-phone).
The builder finds the native Host and completion driver by AST structure,
requires one known driver seam, updates artifact hashes, and preserves unrelated
assets/WASM bytes. It rejects unknown/duplicate driver ABIs and incompatible
modes. The same native package can qualify the tool in the official simulator;
that does not substitute for phone performance evidence.

A phone's debug/domain behavior does not establish a new simulator project's
loopback network admission. In an actual simulator attempt, the first socket
error was `url not in domain list`; the later headline was `Socket close event
unconfirmed`, and CPU capture remained `not-started`. Inspect the earliest native
socket event and original console before diagnosing a close timeout. Preserve the
saved partial report with its hash and verify the simulator's documented local
development domain-check configuration before starting a fresh diagnostic realm.

The [completion probe](../scripts/phone_completion_timing.mjs) composes the
[Platform probe](../scripts/gameplay_frame_timing.mjs) on the inner observer,
before its public spread facade is created. Install the inner frame hooks first,
then capture them in the outer completion wrapper: saving the older `arm/drain`
functions bypasses frame recording. Draining returns both captures and restores
each owned method; a failed installation rolls back its hooks. Foreign changes
are retained and reported. Storage is bounded; overflow, failed hooks, clock
regression, unknown ABI or restoration failure make the observation ineligible.

```sh
node skills/forgeax-engine-wechat/scripts/analyze_phone_completion.mjs \
  /private/report.json /private/new-analysis.json 2
```

The final `2` must be the actual App credit cap of the captured source. Omit it
when unknown; the analyzer still checks all clocks/windows and frame coverage,
but does not infer credit state. The analyzer preserves boundary tickets with
null missing intervals, rejects failed report/drain/CPU coverage, and omits
summaries for ineligible evidence. A partial result caused only by valid window
boundaries may retain complete interior statistics; check `completeCoverage`
and `errors`, not just the status word. Source output uses an explicit identity
whitelist and report SHA-256; device/run identifiers are not copied.

| Observation | What it establishes |
| --- | --- |
| Requested delay versus timer schedule/fire | Excess timer wake delay, separately from the requested 0/1 ms wait |
| Original `poll() === false` | The native request was incomplete at that poll; not GPU hardware duration |
| Ready poll to original driver Promise resolution | FIFO/delivery delay; not the private Rust callback timestamp |
| Original zero-timeout `clientWaitSync` status | Native GL status at an existing call; raw import returns remain uninterpreted because they can be externref indices |
| Completion to next submitting Platform callback | Same-clock callback handoff under the explicitly supplied credit cap |
| Submission location relative to callbacks | Strictly inside, equal-time boundary ambiguity, definitely outside, and incomplete-endpoint coverage are counted separately; their sum equals total submissions. Cause remains unknown, including possible future credit-wake submissions |
| Adjacent CPU frame end → one intervening receipt → next CPU frame start | Same-clock temporal gap decomposition, including frames outside Host callbacks; neither private wake causality nor GPU/idle time |

`callbacksWithStrictInsideSubmission` counts every callback with a definite
inside submission. `creditQualifiedSubmittingCallbacks` is the narrower set
admitted to credit timing after callback-boundary ambiguity checks.

Do not label a submission outside merely because its timestamp equals callback
entry or exit: separate recorders cannot order those same-tick observations. A
callback with only one captured endpoint leaves its possible window unknown;
a pending request with neither endpoint does not imply missing execution.

Distinct calls can share a clock tick: pair poll enter/return by event order,
never by finding the first equal timestamp. Check the documented shared Platform
clock contract and equal capture windows before joins. The CPU profiler adapter
uses `Math.floor(platformMilliseconds * 1000)`, matching the engine profiler's
integer-microsecond schema. Fractional Platform values previously produced a
`profile-artifact-invalid` capture in the simulator; such a report is partial and
cannot qualify joint timing. Rounding is an encoding repair, not a speedup.

### CPU frame gaps, including submissions outside Host callbacks

The same CLI also emits `cpuFrameTiming` when a qualified raw CPU capture is
present. It requires no new hook, dependency, build or explicit credit cap. With
no CPU capture, an unknown producer/clock contract or ineligible report, that
section is explicitly `unavailable` with a reason and no summary. The existing
report/CPU/clock/drop/drain gates still apply. Inspect this section's own status
and unknown counts; top-level `completeCoverage` does not mean every temporal
association is knowable.

Submitted/completed identities must be contiguous and cannot imply negative
outstanding work or completion of a not-yet-submitted frame, even when no credit
cap is supplied. Only the upper bound requires the explicit cap; a receipt for
work already pending at the capture's beginning remains valid.

The [phone CPU producer](../scripts/phone_gameplay_cpu.mjs) supplies the same
Platform clock using `Math.floor(milliseconds * 1000)`, recorded under
`forgeax-phone-gameplay-cpu/1` and the Profiler's `1.0` capture schema. Analysis
uses that identical integer conversion for App events, rejects unsafe values,
and compares quantized timestamps. Equal integer microseconds cannot establish
event order. This is encoding precision, not a claim that the underlying phone
or simulator clock resolves one microsecond. Retain the original publication and
diagnostic source identities; a different clock producer cannot be aligned by
guessing a constant offset.

[App](../../../packages/app/src/internal/frame-loop.ts) restarts the profiler's
local frame ID at each capture. It is **not** a Renderer submission ID. An
`onSubmitted` observation occurs synchronously inside the profiled
`renderer-draw` / `frame-total` phase. The analyzer therefore maps a CPU frame to
a submitted frame only when exactly one submission is strictly inside its
complete nonoverlapping CPU interval, with no additional endpoint candidate.
Equal-time endpoints, multiple submissions, missing roots and out-of-window
frames remain unknown; there is no fixed ID offset or nearest-frame fallback.
If a root is missing or duplicated, its interval is unbounded: the other CPU
frames and gaps also receive `incomplete-cpu-frame-coverage`, rather than gaining
false uniqueness after the malformed root is discarded. The original per-frame
reason is retained. Ordinary known window boundaries remain bounded information.

CPU gap timing is independent of that submission mapping. For consecutive local
CPU frame IDs, `gaps` retains the elapsed interval from the previous
`frame-total` end to the next start. Missing IDs are never bridged; incomplete,
overlapping or unordered roots cannot produce an elapsed interval. When exactly
one receipt is strictly inside that gap and none touches its endpoints, the row
records `previousCpuEndToCompletionMs` and `completionToNextCpuStartMs`; the two
sum to the quantized gap. No receipt, multiple receipts and equal-time endpoints
retain candidate receipt IDs and an unknown reason, without selecting a split.
Summary distributions include only qualified intervals and retain unknown counts.

The selected receipt is a **temporal neighbor**, not an inferred wake cause. Its
actual Renderer frame ID is preserved; `completedCpuFrameId` is present only
when that submission independently has a unique CPU association. With two
in-flight frames the intervening receipt can belong to an older frame, and the
previous CPU frame's own receipt may finish after the next CPU frame starts.
Do not force it into a negative split or discard an otherwise valid CPU gap
because a submission shares a quantized CPU endpoint.

This metric covers a resumed frame outside a Host callback. The earlier
`creditToSubmittingCallbackDistinct` still measures a later **Host callback**;
it does not become wake latency for the resumed frame. CPU gaps include scheduling
and other elapsed work: they establish neither idle CPU nor GPU hardware time.
CPU diagnostic mode also does not establish native `wx.enableDebug`: inspect
the original before/after debug observations separately. Compare the same phone,
scene, extent, native bytes, instrumentation and debug state, then qualify ordinary
completed-frame performance without these intrusive probes.

### Qualified phone credit-wake comparison

The 2026-10-14 Android A/B/A comparison preserved the scene, extent, native
payloads, debug state and cap 2. All 360 CPU frames and 357 adjacent gaps had
unique associations; returning to the baseline restored the callback wait:

| Eight-second stationary diagnostic | Baseline | App credit-wake | Baseline return |
| --- | ---: | ---: | ---: |
| Completed frames/s | 26.750 | 53.250 | 27.375 |
| Receipt to next CPU start, mean ms | 12.486 | 0.024 | 11.694 |
| CPU frame-total, mean ms | 19.132 | 10.728 | 17.484 |

This establishes a reversible scheduling effect, not a GPU-duration result or
stable 60 FPS. The additional CPU reduction has not been isolated from execution
context, frequency or preemption. The candidate's 65.133 ms longest completion
interval occurred after its 120-frame CPU capture ended: do not explain an
out-of-window long frame using earlier CPU phases.

Inspect generator suspension when summing phase coverage. Here `render:record`
measured active generator steps; shared presentation/encoder finish/submission
ran between two steps. That interval accounts for 2.582 ms of the candidate's
4.377 ms mean unassigned renderer-draw time. It includes several owners and is
not itself UI or GPU time. Measure those existing submission boundaries before
adding individual draw-call instrumentation.

The Render Profiler now exposes `submission/presentation`, `submission/finish`
and `submission/submit` at that shared barrier. Each is recorded once for the
whole view roster under the current outer phase; active `record` segments remain
separate. The final phase includes synchronous completion registration, not the
lifetime of its Promise. Check that these phases exist in the actual published
JavaScript and new capture; older recordings cannot acquire them retrospectively.

Original reviewed phone images, relative frame/phase data and source hashes
retain the diagnostic limits and all samples. Repository access is required.

### Controlled official game-realm fixture

Build the actual checkout's native driver into a standalone, Node-free bundle:

```sh
node skills/forgeax-engine-wechat/scripts/build_completion_timing_fixture.mjs \
  --engine-source /absolute/engine-checkout \
  --tool-root /absolute/engine-dependencies --out /private/new-fixture
```

Place the generated `game.js` into a **new, separate temporary MiniGame project**
with `compileType: game`, and open it through the official tools. The builder
creates no AppID or project configuration and never changes the ordinary game.
Its entry runs automatically, recording `running`, then `passed` or `failed` in
`globalThis.__forgeaxControlledCompletionResult`. This independent project has no
actual App, GPU or gameplay. Read the result through official automation only:

```js
GameGlobal.__gameContextWindow.__forgeaxControlledCompletionResult
```

In the tested DevTools, `automation_evaluate` executes in the driver realm.
Running the bundle there is not proof of game-realm execution; an attempted
`g.Function(...)` bridge also failed. Load source through the static MiniGame
entry instead of `eval` or `Function`. Retain the actual official result, fixture
manifest and driver source hash. If the game-context bridge is unavailable,
retain that failure rather than substituting a driver-realm result.

`completion-fixture.js` remains a library for offline `vm` or a separately
verified static realm setup. Its explicit `gamePaused:true` flag acknowledges an
independently observed paused state; it does not pause an App. The automatic
`game.js` entry uses private fixture timers and needs no live App. Node tests run
both outputs, including the automatic entry, without Node APIs in their realm.

Its shared controlled scenarios distinguish a late original timer, two false
polls, and an already-ready request waiting on its FIFO predecessor. They assert
original Promise identity, exact timer/poll/free counts, combined frame capture
and restoration. All timers and Platform callbacks are private fixture data;
the game globals and real driver policy are unchanged. This proves tool
correctness on the official runtime, not native GPU throughput or game FPS.

```sh
FORGEAX_TOOL_ROOT=/absolute/engine-dependencies node --test \
  skills/forgeax-engine-wechat/scripts/__tests__/phone-completion-timing.test.mjs \
  skills/forgeax-engine-wechat/scripts/__tests__/phone-completion-analysis.test.mjs \
  skills/forgeax-engine-wechat/scripts/__tests__/phone-gameplay-build.test.mjs
```

## Install and collect

Transfer only `scripts/browser_completion_timing.mjs` to the machine driving the
owned browser. It has no dependency or build step. Inject before game scripts so
native functions have not already been cached:

Installing on an already-running game cannot intercept a previously cached
original rAF/timer/GL function, or observe a callback registered through it.
`callsThroughPreviouslyCachedMethods` and pre-install work remain unknown;
zero recorded rAF events is not evidence that its Host stopped requesting frames.

```js
import { browserCompletionTimingSource } from './browser_completion_timing.mjs';

await page.addInitScript({
  content: browserCompletionTimingSource({
    capacity: 32768,
    globalName: '__forgeaxCompletionTiming',
  }),
});
// Navigate/load the ordinary game and finish its normal qualification.
await page.evaluate(() => globalThis.__forgeaxCompletionTiming.start());
// Arm the existing gameplay observer and run the agreed four-second window.
// Keep its original submitted/completed callbacks and input delivery unchanged.
const timing = await page.evaluate(() => {
  const recorder = globalThis.__forgeaxCompletionTiming;
  recorder.stop();
  return recorder.restore();
});
```

Alternatively pass the exported `installBrowserCompletionTiming` function
directly to `page.addInitScript(function, options)`. It is self-contained and
preserves strict receiver semantics when serialized.

`start()` resets event storage and returns its clock/start/coverage summary.
`stop()` freezes and exports the capture. `snapshot()` exports without stopping;
avoid repeatedly exporting during measurement. `restore()` stops if necessary,
restores original property descriptors, removes its own global, and returns the
final capture. Pending application callbacks still run. A method changed by
another owner after installation is preserved and reported as a restore conflict.
Hold the returned recorder if a later snapshot is needed after global removal.

The recorder schedules no automatic stop. The caller owns the four-second game
window and `finally` cleanup. Recording before observer arm also includes its
lead-in; filter by the original observer's start/end when analyzing the window.

## Evidence contract

Output schema: `forgeax-browser-completion-timing/1`. All `atMs`, `endMs`,
`scheduledAtMs`, `startMs` and `stopMs` use this realm's `performance.now`.
Browser Platform game callbacks use the same clock. For a native simulator Host,
establish its Platform-clock offset explicitly before aligning a different clock;
matching unit names alone is insufficient. The rAF argument is retained separately
as `rafTimestampMs`, not substituted for the observed callback time.

| Event kind | Evidence |
| --- | --- |
| `fenceSync` | Receiver `contextId`, resulting `syncId`, original numeric condition/flags and call entry/return |
| `getSyncParameter` | Context/sync IDs, numeric `pname`, original numeric returned `value`, call entry/return |
| `flush`, `deleteSync` | Existing call entry/return, context and applicable sync ID |
| `timer-schedule` | Trace `id`, native return ID, numeric requested `delayMs`, extra argument count |
| `timer-fire` | Same trace ID, original schedule time, observed callback wake time |
| `timer-cancel` | Matched trace ID when known; original native cancellation still runs |
| `raf-schedule`, `raf-fire`, `raf-cancel` | Independent trace IDs, native IDs and actual callback argument |

`threw` records a synchronous native-call exception without reading, wrapping or
replacing the thrown value. Callback exceptions propagate through the browser's
normal error path; retain the runner's existing page/console error collection.
The recorder forwards original receivers, scheduling arguments, extra callback
arguments and return values. It never coerces a delay object a second time.
Non-numeric delay/result metadata is `null`, meaning unavailable, not zero.

Timer and rAF native numbers can collide; correlate the globally unique trace
`id` and event kind. Sync identities survive deletion for later error attribution;
they are stored in WeakMaps and do not retain native objects. Multiple GL
receivers have separate `contextId` values; do not merge unrelated contexts.

The event buffer is preallocated and append-only, default 32,768 events
(10 float64 fields per slot; about 2.5 MiB), configurable from 8 to 262,144.
When full it preserves the beginning and reports dropped count plus first/last
dropped timestamps. It does not overwrite earlier evidence. Pending timer/rAF
metadata is separately bounded by the same capacity. Each original scheduled
function needs a forwarding callback; no additional native task is created.

Inspect `coverage`, `overflow`, `pendingAtStart` and `pendingAtStop` before drawing
conclusions. Missing/unreplaceable hooks, clock/observation errors, untracked
sync arguments and unknown cancellations remain explicit. Native string timer
handlers are forwarded unchanged to preserve evaluation/CSP behavior; their wake
cannot be observed. `unsupportedTimerCallbacks` and `pendingTrackingOverflow`
count since installation, including work before `start`, because that missing
boundary information cannot be recovered by clearing the event buffer. Work
scheduled before installation is unknown. A pending callback at stop is not
automatically a lost callback; it may be due after the recorded window.

## Interpret without inventing GPU time

Correlate the saved ordinary App submission/completion frame IDs with sync and
timer events on the same clock. A delayed wake followed by an already-signaled
query bounds readiness; it does not reveal exactly when GPU work finished. An
early signaled result followed by a late App completion points to a later
observation/delivery boundary. Prompt wakes with continued unsignaled results
still combine GPU execution, command transport and WebGL status visibility.
The recorder cannot see private wgpu completion-ticket/FIFO boundaries and makes
no claim about them. Only add such instrumentation or supported GPU timing if
the remaining ambiguity requires it. Never relabel V8 idle samples as GPU time.

## Host request timing when receipts are prompt

Join ordinary App submitted/completed callbacks by frame identity before blaming
the in-flight limit. After the [UBO service-cost repair](gpu-process-cpu.md#close-the-loop-without-merging-evidence-types),
one 40-second official-simulator window had 12.7 ms median receipt latency but
41.525 completions/second; two receipts were outstanding for only 0.15% of the
window. Zero outstanding for 41.42% does not mean CPU/GPU idle: it also includes
preparation before submission. These callback-derived occupancies identify a
different question from GPU duration. The final input-release ACK failed, so this
window is diagnostic evidence, not accepted gameplay performance.

Observe the actual Platform instance's `requestFrame` through a diagnostic
fixture before App startup; a separately wrapped global rAF can miss a cached
native function. Record request, callback entry/exit and cancellation with one
request identity and the same normalized `Platform.now` clock used by App
observation. Use bounded preallocated storage, forward receivers/arguments/errors,
and restore the method afterward. Schedule no extra callback/timer and issue no
poll or GL operation.
Arm and drain with the existing gameplay observer; keep this instrumented run
separate from ordinary acceptance.

On 2026-10-13, a four-second official-simulator diagnostic
retained 169 complete callback pairs and 169 submissions: every callback submitted
exactly once. Its 507 events had no overflow or clock/observation errors, and the
wrapper restored.

| Same-clock interval | Mean | Median | p95 |
| --- | ---: | ---: | ---: |
| Request → callback entry | 18.183 ms | 17.900 ms | 20.500 ms |
| Callback entry → exit | 5.489 ms | 5.300 ms | 8.300 ms |
| Consecutive callback entries | 23.655 ms | 23.100 ms | 27.000 ms |

The next request coincided with the previous callback's exit (median/max delta
0 ms; minimum −0.2 ms from clock granularity). This proves that synchronous work
and the observed request-relative wait were serialized. It does not identify a
private DevTools timer implementation. The 42.25 observed completions/second and
failed terminal input ACK again do not qualify acceptance.

The [App repair](../../../packages/app/src/internal/frame-loop.ts), committed in
[`23535e7ad`](https://github.com/ForgeaX-Games/forgeax-engine/commit/23535e7adbae8ee84e563c129cfd46b0e950b409),
clears the current handle and reserves the sole successor at callback entry,
before synchronous World/render work. Preserve these lifecycle invariants:

- `pause`, `stop` and `setStopped` cancel the reservation; synchronous pause/resume
  owns one replacement, with no trailing second request.
- Scheduling failure pauses and reports the error before updating World.
- Clock failure cancels the reservation **before** state/error callbacks, which
  may synchronously resume and create a replacement.

The [real frame-loop regression](../../../packages/app/src/__tests__/frame-loop-request-pacing.unit.test.ts)
reproduced draw starts `[16, 38, 60]` for a 16 ms request-relative Host plus 6 ms
work; the repair yields `[16, 32, 48]`. It also caught two pending callbacks after
synchronous pause/resume and a stale reservation during clock-error recovery.
The final focused run passed six files / 39 tests, including elapsed-time,
two-receipt, device-loss and pause coverage, plus App typecheck/build. No receipt
credit, World time policy, render quality or native payload changed.

### Verify ordering and remaining limits on the actual target

The later paced official-simulator trace
verifies the repair: 218 complete callback pairs, with the next request issued
0.001835 ms after entry on average (maximum 0.100 ms), before synchronous work
finishes. Mean callback period is 18.347 ms; request-to-entry wait remains
18.335 ms. All callback rows, statistics and receipt joins were independently
recomputed from the 654 original events, with zero coverage/overflow errors.
The earlier 23.655 ms period and this result are separate single diagnostics at
different times, with different source/input candidates and machine conditions;
they establish the ordering change, not an isolated FPS effect size.

Of 218 callbacks, 207 submitted and all 11 remaining callbacks entered with two
receipts pending. The 206 receipt pairs with both endpoints in the window have
22.525 ms mean age. That is CPU-observed receipt latency, not GPU execution time.
The new average callback work of 5.751 ms includes those 11 credit skips;
submitting callbacks reached submission after 6.043 ms on average. Preserve the
two-receipt bound and follow the remaining completion owner when skips persist.

The traced run acknowledged 241/241 inputs, retained neutral grounded controls
and drained receipts; it observed 51.75 completions/second, with a 46-completion
rolling minimum. Its explicit-contact input candidate separately
failed the 40-second terminal ACK,
so the short success did not qualify a general input repair. Retain
`nativeContactsReleased: null` when no direct post-timing native probe exists;
earlier native qualification and a later player witness answer different questions.

The combined-change ordinary Mac workload
completed at 58.975 FPS with all 2,401 inputs acknowledged, confirmed release and
drain. Rolling minimum 55, p99 29.765 ms and maximum 50.820 ms still miss stable
60 FPS. The small difference from the earlier 58.875 FPS sample is not a proven
App-pacing speedup. Preserve base-plus-source-closure and publication hashes;
these prepared sources are not a complete checkout of the later merged HEAD.

A paused callback-only control
read the actual Host function using `setTimeout` with `_fpsInterval` or
`_fpsInterval + 1`, without reading or changing that interval. It observed
239 callbacks in five seconds while App submissions/completions stayed fixed.
Its 47.8 callbacks/second is lower than an active game's short diagnostic:
**it is not a simulator ceiling**. Workload state differs; idle timer coalescing
is a hypothesis, not a measured cause. Keep callback controls, active-game traces
and ordinary workload acceptance distinct.

### Check the public FPS preference before changing pacing

The [official `wx.setPreferredFramesPerSecond` contract](https://developers.weixin.qq.com/minigame/dev/api/render/frame/wx.setPreferredFramesPerSecond.html)
specifies default 60 and valid range 1–60; it changes rAF callback frequency but
does not promise exact wake times. When a stale preference is plausible, compare
the initial state with explicit 60 in the same paused, drained callback-only
control. A legal 30 positive control followed by restoring 60 can establish that
the setter reaches the actual pacing owner. Keep App submissions/completions
fixed; this diagnostic does not measure gameplay FPS. A restored 60 phase is not
a second measurement of the unmodified initial state.

The 2026-10-13 public-setter control
retained these five-second phases:

| Phase | Callbacks | Callbacks/s | Mean entry period |
| --- | ---: | ---: | ---: |
| Initial state | 219 | 43.8 | 22.737 ms |
| Explicit 60 | 221 | 44.2 | 22.533 ms |
| Positive control 30 | 123 | 24.6 | 40.476 ms |
| Restored 60 | 222 | 44.4 | 22.533 ms |

Read-only loaded-script evidence showed `_fpsInterval = 16` at initialization
and `_fpsInterval = Math.floor(1000 / fps)` in the public setter: explicit 60
also gives 16, while 30 gives 33. The Host requests `_fpsInterval` or
`_fpsInterval + 1` through `setTimeout`. Preserve the minimal source slice, line
numbers and full-script SHA-256; a public function's `toString()` may expose only
a bridge wrapper. Complete private DevTools scripts need not be redistributed.

The small initial/60 difference is not an established improvement and supplies
no reason to add a default setter to the engine. The observed waits exceed the
requested delays; the random `+1` alone cannot explain them. Same-window CPU
samples showed substantial aggregate idle, while GPU interval deltas showed
WindowServer and wallpaper work, so this was not an exclusive-device experiment.
Neither roughly 44 callbacks/s here nor 47.8/s in the earlier paused control is a
simulator ceiling. Diagnose active-game callback/submission/receipt timing on its
own window; only a demonstrated public-preference improvement warrants a new
ordinary gameplay comparison.

## Browser recorder verification

The unit suite checks argument/receiver/error preservation, native ID collisions,
cancellation, bounded loss, restart and non-destructive restoration. The CDP suite
runs actual sandboxed Chromium with software WebGL2 only as an API contract
fixture, compares underlying native call counts, and verifies callbacks still run
after restoration. It is not hardware/gameplay performance evidence.

```sh
node --test skills/forgeax-engine-wechat/scripts/__tests__/browser-completion-timing.test.mjs
FORGEAX_PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs \
  node --test skills/forgeax-engine-wechat/scripts/__tests__/browser-completion-timing-cdp.test.mjs
```

Optionally set `FORGEAX_CHROMIUM_EXECUTABLE` and
`FORGEAX_COMPLETION_TIMING_EVIDENCE` (output JSON path). Without the Playwright
module variable the CDP test is explicitly skipped; that is not runtime evidence.
