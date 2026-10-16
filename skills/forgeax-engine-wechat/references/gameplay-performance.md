# Gameplay completion benchmark

Use [run_simulator_gameplay_benchmark.mjs](../scripts/run_simulator_gameplay_benchmark.mjs)
for a fixed walking, running, jumping and camera workload in one existing official
WeChat DevTools simulator. It first qualifies CDP contacts through public
`wx.onTouch*` events and actual ordinary-game controls, then measures ready scene
completions while the natural App loop runs. Offline tests qualify the tool;
actual simulator input, images and performance still need target evidence.

The caller owns official login, project import/open, the returned window identity,
the authorized CDP endpoint, capacity observations and final image review. Use the
installed official skill for those operations and [simulator ownership](simulator.md)
for the game realm. This runner opens no project, changes no viewport or emulation,
and closes only its own CDP socket. It neither navigates nor restarts another
session's target. After collection the observed App remains paused for receipt
drain; close the owned simulator when finished.

## Freeze the prepared native publication

Reuse an existing matching preparation when its observer provides `status`,
`arm`, `abort` and `drain`. Otherwise use the shared
[builder](../scripts/build_gameplay_benchmark.mjs) once:

```sh
node skills/forgeax-engine-wechat/scripts/build_gameplay_benchmark.mjs \
  --target native \
  --publication /absolute/ordinary-wechat-publication \
  --tool-root /absolute/engine-tool-checkout \
  --source-commit FULL_40_HEX_SOURCE_COMMIT \
  --manifest-sha256 ORDINARY_MANIFEST_SHA256 \
  --out /absolute/new-frozen-native-benchmark
```

The native preparation retains the full ordinary publication and composes its
existing App submitted/completed callbacks. It preserves the native Platform,
Host execution strategy and matched WASM/glue; it does not create a replacement
simulation loop. `assembly-differences.json`, `ordinary-forgeax-dist.json` and
`benchmark-manifest.json` record the exact adaptation and source. The original
publication stays unchanged. Reuse its assets and Cook output.

Keep this preparation immutable and import a separate copy into DevTools. The
runner's `--manifest-sha256` is the **prepared diagnostic** `forgeax-dist.json`
digest, not the original ordinary digest. Pass the frozen preparation as
`--publication` and the imported copy as `--project`:

```sh
node skills/forgeax-engine-wechat/scripts/run_simulator_gameplay_benchmark.mjs \
  --endpoint http://127.0.0.1:PORT \
  --window sN \
  --target-path /game/sN/EXACT_SESSION_PATH/gamePage.html \
  --project /absolute/IDE-project-copy \
  --publication /absolute/frozen-native-benchmark \
  --manifest-sha256 DIAGNOSTIC_MANIFEST_SHA256 \
  --canvas-selector 'canvas#myCanvas' \
  --phase-ms 10000 \
  --capacity-status unverified \
  --out /absolute/new-private-result
```

Run with Node 22+ on the DevTools machine. Discover the exact path from the owned
window's official receipt and CDP target metadata; never probe unrelated targets
to guess it. Missing endpoints, ambiguous paths or a different socket origin
fail before contact delivery. Do not create an endpoint or bypass official login
as an implicit consequence of running this command.

Before and after collection, the runner verifies the frozen manifest, every
inventoried byte and the original source digest. It verifies the IDE copy against
that same inventory. DevTools may reformat `project.config.json` and add object
fields; only those additions are admitted against the independently verified
frozen original. Removing or changing an existing value, changing an array,
changing any other inventoried file, or escaping through a symlink fails.
The report retains declared/actual config digests and added JSON paths. It never
rewrites digests or ignores the whole config. Without `--publication`, the
`--project` directory itself must remain byte-exact.

This verifies disk bytes, the selected target and callback identities. It does
not independently attest the already executing JavaScript bytes. Keep the
official import/open receipt with the result to establish which copy was loaded.

## Run on an Android phone

The phone controller never changes native debug state. It records actual
`getAppBaseInfo()` values before and after capture and marks every run
`diagnosticOnly: true`, `cleanFpsEvidence: false`. Debug-enabled results support
attribution and comparisons under the same conditions. They cannot establish
clean FPS acceptance. A separate real-phone lifetime check showed that a single
`setEnableDebug(false)` call ended the game; details below.

The tested recovery prepares debug in a separate launch, exits that preparation,
then re-enters the intended diagnostic and observes its actual state. Sampling
still leaves debug unchanged; see the recovery evidence below.

The [phone controller](../scripts/phone_gameplay_observer.mjs) reuses the same
App observer and four-phase timeline. Prepare `--target phone` with the native
builder arguments above, plus an explicit `--phone-url
http://127.0.0.1:PORT/PRIVATE_RUN_PATH` and `--run-id UNIQUE_RUN_ID` (16–96 letters,
digits, underscores or hyphens). For a baseline made from a recorded source
closure, pass `--source-provenance /absolute/prior/benchmark-manifest.json`;
the builder verifies the ordinary manifest and base commit, and retains that
closure instead of calling the package current main.

The phone prefix uses the ordinary Chrome 70 bundling target and checks its
actual AST for unsupported optional-chain, nullish and logical-assignment
syntax. Keep this gate on the phone prefix; changing DevTools private compiler
settings or applying a narrower language version to the whole publication is
not a substitute for compiling the diagnostic at its owning boundary.

Configure the selected phone's ADB reverse explicitly. Start the listener before
official preview with `--await-capture`, naming two future files that do not exist.
The controller retries failed connections only before sending readiness, after
confirming the previous socket closed; an ambiguous readiness or arm is never
replayed. Transfer the frozen Node `ws` carrier bundle beside the Python runner
and keep the frozen publication on the ADB machine:

```sh
python3 skills/forgeax-engine-wechat/scripts/run_phone_gameplay_benchmark.py \
  --adb /absolute/adb --serial EXPLICIT_DEVICE --cache /absolute/scrcpy-cache \
  --await-capture \
  --capture-result /absolute/future-reviewed-capture/result.json \
  --screenshot /absolute/future-reviewed-capture/screen.png \
  --manifest /absolute/frozen-phone/forgeax-dist.json \
  --publication /absolute/frozen-phone --node /absolute/node \
  --ws-host /absolute/tools/phone_gameplay_ws_host.bundle.mjs \
  --phase-ms 1000 --out /absolute/new-private-phone-result
```

Require the printed `listening` receipt before opening official preview. Capture
with `android_game_capture.py --for-input` into a separate staging directory,
review the actual image, then publish the reviewed PNG to `--screenshot` and
atomically rename its matching result to `--capture-result` last. File publication
is the explicit review handoff; the runner neither captures nor reviews images.
Wait for each transfer process to exit successfully before renaming: a returned
background session ID is not a completed copy. A phone qualification attempt
missed this boundary, renamed before its temporary file existed, and expired
without sending native contacts. Its failed result was retained; a fresh realm
with sequential completed transfers passed. Do not replay an expired handshake.
It rejects pre-existing destination files, malformed handoffs, and the combination
of `--await-capture` with `--transport-only`. The original mode without this option
still accepts an already reviewed pair before starting its listener.

The phone allows 120 seconds for the pre-arm ready exchange. The host reserves
two seconds for delivery, allowing 118 seconds from readiness for input setup: image transfer, source/display checks,
scrcpy setup and the foreground guard all share that interval. `awaiting-reviewed-capture`
prints the remaining host time. Missing files, cancellation or late setup fail
with zero native contacts and never rearm that realm. Review may start as soon as
the visible game is ready; do not wait for the readiness message to start capture.
Stage files on the ADB host to keep the final publication cheap. A longer runner
`--deadline` only extends waiting for initial readiness/report; it does not extend
the phone exchange. Only ready forwarding uses a 125-second carrier limit; other
control stages retain their existing deadlines, and the arm still schedules input
with the same two-second clock lead-in. This waiting period prepares the test; it
is outside the unchanged sampling window. If review cannot finish within this
bound, keep the original
failure and prepare a separate explicit launch; do not use an old Activity capture
or silently replay the wire protocol.

A native run with listener-before-preview reached readiness, but the earlier
18-second host / 20-second phone limits expired while its current full-scene image
was being reviewed and transferred between machines. The host closed about
18.057 seconds after receiving ready and recorded zero attempted input. This
observed preparation failure motivated the explicit 120/118-second limits; it was
not a game-frame or GPU measurement. The actual source, foreground guard, clock
uncertainty and walk/run/jump acceptance remain required.

This short invocation runs four one-second phases for diagnosis; use
`--phase-ms 10000` for the original 40-second workload. The source-bound WebSocket
carries only `ready`, `armed` and `release`; replies select arm, acceptance and release. The final
report uses the existing hashed POST. The reviewed screenshot, selected publication, foreground and
display must match before native contacts are sent. The ordinary game must have
60 ready completions, healthy vase geometry and a neutral grounded player.
Actual native control rectangles generate device-pixel coordinates through the
shared timeline. The input driver prepares scrcpy and its foreground guard before
the phone arms. Readiness includes the observed debug state and the manifest
requires `debugPolicy: unchanged`; the runner rejects the old toggle protocol.
The Node carrier forwards fixed messages to the same-host private Python
controller, which remains the input and timing owner. Its monotonic send/receive
timestamps bound the phone clock, including the local forwarding cost in the
mapping; `synchronization.json` retains the start interval and uncertainty.
The default maximum uncertainty is 25 ms; a missed lead-in or larger uncertainty
stops the run before input. This is a bound, not exact cross-device clock equality.

The runner defaults Jump and Run to the centers of the current Blitz control
rectangles. Native overlays are outside that inspection, and a vConsole button
inside the same AppBrand does not change the foreground guard's target. On the
tested phone, it covered Jump's center. A guarded native swipe succeeded as an
input operation but before/after screenshots showed the floating button had not
moved. Native repositioning may be attempted, but requires screenshot confirmation;
a successful swipe does not establish that the game control is unobstructed.

When another interior point is visibly clear, add an explicit option to the phone
runner, for example:

```sh
--button-points '{"jump":{"u":0.5,"v":0.85}}'
```

Only `run` and `jump` are accepted, with both normalized coordinates strictly
between zero and one; omitted buttons retain their centers. The tested screenshot
left Jump's lower interior visible, motivating this particular point. Derive and
review the choice for each actual phone rather than treating it as a universal
coordinate. The shared timeline converts the current native UI rectangle to
device pixels, applies the point and rejects coordinates that round onto or beyond
its edges. It changes neither the real rectangle nor the game's UI/input handling.
`timeline.json` retains resolved `buttonPoints` and every actual contact coordinate;
`ready.json` retains the native rectangles. Keep debug unchanged and take a fresh
reviewed `--for-input` capture. Freeze updated host tools separately; this option
does not require rebuilding the phone publication. Successful packet dispatch
still needs the native action qualification described below.

No inspection, socket message or report serialization runs in the timed
diagnostic window; the socket remains idle. The entire controller, including
failure cleanup and export, makes no debug toggle. Complete reports require
unchanged observed debug state and reject any debug receipt or socket event in
the interval. After input release,
the original App continues until the player is
neutral and grounded, then the observer pauses and drains the actual last receipt.
The ordinary two-receipt cap, native Platform, scene, UI and matched WASM remain
unchanged. `phone-report.json` retains every callback event; `input-result.json`,
`timeline.json`, `analysis.json` and `analysis.md` retain the schedule, release
limits and interval statistics. Transport validates the complete report digest
and exact source/run identity, writes private files and returns a matching receipt.
Failures preserve partial captures and never rearm the same realm.

`result.json.success` means collection and socket dispatch completed. Action
semantics still require a separate native diagnostic run, and temperature,
headroom and reviewed images remain external evidence. The shared analyzer
therefore retains `semantics-unproven` for this diagnostic collection; it
cannot declare strict-60 or hardware acceptance from packet dispatch alone.

Use a separately prepared `--phone-mode qualification` run to observe the actual
public player projection at most 10 Hz. `qualification.json` retains each sampled
position, grounded state, run controls, camera yaw and read cost. Its per-phase
evidence includes traveled distance, median/maximum speed, airborne samples and
yaw travel. Walking must move; running must enable its actual control and exceed
walking median speed by 10%; both jump phases must become airborne and rise more
than 0.1 world units above the initial ground height; every phase must rotate the
camera. Missing projection, fewer than five samples per phase, or gaps above
500 ms remain a failure. These are explicit input qualification criteria, not
frame-time tolerances. This mode is intrusive and never supplies clean FPS.

Start native input qualification with `--phone-mode qualification` and the runner's
`--phase-ms 2000`: four phases over eight seconds. Review its actual movement,
run speed, rising jumps and camera evidence before the longer workload. Then use
a separately frozen `--phone-mode timed` publication and a fresh run ID/output
with `--phase-ms 10000` for forty seconds. Keep the successful qualification as
separate evidence for the same source and native controls; the timed report does
not automatically import it. Both runs remain diagnostic while debug is enabled.

The 2026-10-14 native qualification completed all four phases with the listener
started before official preview, unchanged observed debug state, a reviewed
`--for-input` image, and the staged PNG/result handoff above. The receiver took
58.155 seconds from ready receipt to its arm reply, including preparation; the
120/118-second limits admitted this work without changing the eight-second
sampling interval. The subsequent clock exchange had 12.347 ms uncertainty,
inside the existing 25 ms bound. No control message occurred inside the sample.

| Phase | Median speed (world units/s) | Airborne samples | Camera yaw travel (radians) |
| --- | ---: | ---: | ---: |
| Walk | 4.770 | 0 | 1.025 |
| Run | 8.078 | 0 | 1.045 |
| Jump | 0.000 | 14 | 1.046 |
| Run and jump | 8.149 | 16 | 1.058 |

Running was 1.693 times walking speed. Both jump phases rose above the required
height, all phases changed camera yaw, and the largest sample gap was 142.033 ms.
All 481 scheduled contact snapshots were dispatched, none dropped; maximum
lateness was 12.707 ms, with all contacts released and the player grounded and
neutral afterward. The final submitted receipt drained completely. The operator
reviewed the final native screenshot and confirmed the complete scene, vase,
character and controls with visibly changed player/camera positions.

This establishes native action qualification for that frozen source and input
geometry. It is not clean FPS: debug stayed enabled and player inspection was
active. The eight-second diagnostic recorded 209 completions (26.125 per second),
53.922 ms p95 completion interval and a worst rolling second of 22 completions.
Those callback measurements neither prove physical presentation rate nor a
performance gain, and they do not satisfy the 60 FPS target. Keep the successful
action evidence with the exact frozen tool/publication hashes; performance work
needs its own repeatable workload and attribution.

A later App credit-wake comparison on the same phone completed **25.2 → 46.6
frames/s** over separate forty-second input runs. A fresh eight-second candidate
qualification independently passed all six checks (80 observations, run/walk
median speed ratio 1.62546). Keep these runs separate: open-loop controls do not
produce identical trajectories or views, and the timed run did not sample action
semantics. Phase averages declined while measured GPU temperatures decreased;
that does not identify thermal throttling or a particular action cost. Check the
actual overlap of each headroom series with the measured window; starting a
50-second monitor before preview does not guarantee forty-second coverage.
Relative timing, semantic observations and original reviewed phone images
retain the source/debug/coverage limits. Stable 60 FPS remains unmet.

For separate attribution, prepare `--phone-mode cpu --cpu-frames 120` (or `240`)
or `--phone-mode gpu`, each with its own run/path and output. CPU passes one
Profiler instance to the existing Renderer and App, starts at the timeline origin
and captures the selected number of actual CPU frames. `cpu.json` preserves the
owner capture, phase catalog, raw records, partial/overflow state and summaries.
`diagnosticWindow` records actual relative timing and how many sampled frames
began in each timeline phase: a short CPU sample does not cover all 40 seconds.
Inclusive parent/child CPU phases overlap and must not be added.

GPU mode observes at most the first four seconds through the existing native
submit/present exports and `EXT_disjoint_timer_query_webgl2`. It stops queries
before post-window inspection, collects only after App receipt drain, and keeps
capability absence, disjoint/overflow and disposal evidence in `gpu.json`.
It does not enable the RHI timestamp capability or add flush/finish calls. Both
modes carry `diagnostic` and `cleanFpsEvidence: false`; their clocks, query ages
and inclusive CPU durations are not physical display presentation times.

### Stationary CPU/completion diagnosis

Use `--stationary-diagnostic ARM_FILE` for an eight-second stationary capture
without native input. Prepare the ordinary frozen publication with
`--phone-mode cpu --cpu-frames 120 --completion-timing`; other diagnostic modes
are rejected by this entry. This mode isolates CPU/completion attribution while
retaining the real App, scene, native binaries and pacing. It does not qualify
walk/run/jump or clean FPS, and `--phase-ms` does not change its fixed duration.

```sh
python3 skills/forgeax-engine-wechat/scripts/run_phone_gameplay_benchmark.py \
  --stationary-diagnostic /absolute/new-run/arm.json \
  --publication /absolute/frozen-phone --node /absolute/node \
  --ws-host /absolute/tools/phone_gameplay_ws_host.bundle.mjs \
  --out /absolute/new-private-stationary-result --deadline 240
```

Start the listener before official preview. No ADB, scrcpy or input capture is
created by this mode. The operator still owns the selected phone's explicit
reverse, actual image review and simultaneous headroom collection. When the
phone reports a neutral grounded player, the runner prints `awaiting-arm` with
the exact run ID, diagnostic manifest SHA and remaining readiness time. Check
the actual visible game and current process, start headroom collection, then
atomically publish a new regular file at `ARM_FILE` containing exactly:

```json
{"runId":"EXACT_RUN_ID","diagnosticManifestSha256":"DIAGNOSTIC_MANIFEST_SHA256"}
```

Use the values printed by this invocation. The marker must not exist before
`awaiting-arm`; pre-existing files, symlinks, oversized input, extra properties
and mismatched source/run values fail without arming. Its parent directory must
already exist. Publish a same-directory temporary file with an atomic rename.
The original 118-second host / 120-second phone readiness deadline remains in
force; increasing `--deadline` does not extend it. Keep a timed-out result and
use a fresh realm, result directory and marker for another explicit attempt.

This entry reuses `GameplayControl`, its two-second lead-in and clock uncertainty
bound, unchanged-debug checks, release/landing/drain and exact report digest
validation. No contact is started; `input-result.json` records
`attempted: false` and `releaseStatus: no-contact-started`. The marker is saved as
`arm-marker.json`. Do not operate the phone, poll its UI or take screenshots
during the eight-second sample. `phone-report.json` retains original complete or
partial bytes, while `cpu.json` and `result.json` retain collection status and
cleanup failure separately. Success also requires CPU `complete`, successful
validation, complete App/Renderer coverage and no `cpuError`: the phone's top-level
`complete` can describe a drained App despite failure in its later CPU read.
Receipt of a report alone does not qualify a sample.

The four-phase gameplay analyzer is intentionally not run for this workload.
Use [completion timing analysis](completion-timing.md) with the actual App credit
cap, and compare only matching source, debug, scene and headroom conditions.
`--transport-only` remains an unarmed `observe-only` exchange. It and
`--await-capture` cannot be combined with `--stationary-diagnostic`.

### Diagnose a missing phone report

Keep the first failure, frozen source and receiver output. The controller retains
its first native `wx.request` error (including `errMsg`, `errno` and `errCode`),
the already observed renderer/player/vase/UI values, and a private first-failure
checkpoint. A terminal report is serialized once; bounded delivery retries reuse
those exact bytes and SHA-256 for at most 60 attempts and two minutes. They never
rearm the same observer or overwrite the original failure.

For an unreadable failure, prepare with explicit `--transport-diagnostic` and
start the receiver before preview, using `--transport-only --publication ...
--node ... --out ...`. This receiver creates no scrcpy session and sends no input;
it answers readiness with `observe-only`, then saves the terminal report. The
explicit phone option displays at most one native diagnostic modal before arming,
with the original native error or an early readiness error. Its full evidence
remains in the private report. Never enable this modal during FPS acceptance.
Do not infer a domain-policy or debug-mode cause merely from an empty receiver:
obtain the actual native error first.

The 2026-10-13 phone probe retained the original native failure
`request:fail url not in domain list:127.0.0.1` after a debug-disable API call. For that
run, loopback HTTP was blocked by domain validation. Repeating HTTP readiness
cannot prove that debug was successfully disabled before host input.

Use a separate `--phone-mode transport-probe --transport-diagnostic` publication
to test an existing WebSocket across the official debug transition. The
[probe](../scripts/phone_gameplay_transport_probe.mjs) waits for 60 ordinary
completions and the healthy scene/player/UI, then requires official
`wx.setEnableDebug(true)` success before connecting. Its fixed source/run-bound
protocol requires official `false` success, sends `debug-closed`, receives an
`arm` message marked `probeOnly: true`, and completes a final exchange and socket
close. It never arms the observer, pauses the App, captures performance or sends
native input. It enables debug again only to export the retained report through
the shared immutable delivery path. Every debug API receipt and socket event is
retained, including original failures; the explicit modal is diagnostic only.

The [receiver](../scripts/run_phone_transport_probe.mjs) uses the installed `ws`
package. Transfer its frozen Node bundle with `ws` included when the Mac has no
dependency checkout; no package installation is needed there. Start it before
preview and use a fresh output directory:

```sh
node /absolute/tools/run_phone_transport_probe.bundle.mjs \
  --publication /absolute/frozen-transport-probe \
  --out /absolute/new-transport-probe-result --timeout 180
```

On macOS, `/tmp` resolves to `/private/tmp`. The first frozen receiver compared
the resolved module URL with the unresolved command path, so invoking it through
`/tmp` exited successfully without starting the receiver or printing anything.
Keep those frozen bytes intact and invoke that bundle by its `/private/tmp/...`
path. The current source canonicalizes its CLI path, with a directory-symlink
regression. In either case, require the printed `listening` record and matching
`receiver.json` before opening the phone preview; exit code zero alone is not a
listening receipt.

`phone-report.json`, `report-receipt.json`, `transport-events.json` and
`probe-summary.json` preserve both sides of the exchange. The real phone did
return all three successful receipts and a post-disable round trip: its report
was 86,634 bytes, SHA-256
`3ad3d3ca3584cbf25ae4d66da00b4237574cdd0fa876695b974816e35e464b20`.
That short result did not establish continued game lifetime. Android subsequently
showed `wm_finish_activity` at 21:46:51.363, about 7 ms after the `false` success
at 21:46:51.356, and Activity destruction about one second later. The same process
remained alive without a crash-buffer entry. The preceding `true` success at
21:46:51.305 also means this record alone cannot isolate which transition caused
the asynchronous exit.

The official [setEnableDebug contract](https://developers.weixin.qq.com/minigame/dev/api/base/debug/wx.setEnableDebug.html)
defines success as API-call success. It states neither a required restart nor a
guarantee that the current realm stays alive. The official
[getAppBaseInfo contract](https://developers.weixin.qq.com/minigame/dev/api/base/system/wx.getAppBaseInfo.html)
exposes `enableDebug` as the current debug state. The separate lifetime experiment
therefore began already enabled and retained streamed completion, visibility and
debug observations across a single `false` call, with a five-second observation
target. This isolated the transition and preserved evidence after the Activity
exited. It supplied no FPS acceptance; a brief socket success was insufficient.

The follow-up isolated that transition: the realm began with
`getAppBaseInfo().enableDebug === true`, established its socket without calling
`true`, then called `false` once. Four samples at roughly 250 ms intervals still
reported debug enabled and visible, with completed frame IDs advancing from 96
to 135. About 1.1 seconds later the socket closed with code 1000 and the original
reason `destory wcwss`, and the game returned to the launcher. The five-second
lifetime result remained partial. This establishes an asynchronous exit after
the isolated `false` call on the tested phone/runtime; the successful callback
did not establish that debug had already changed in that realm. It does not
establish the behavior of every WeChat version. Keep the experiment as historical
diagnostic evidence; gameplay setup, sampling, failure cleanup and export must
all leave debug unchanged.

The installed official `auto_preview --help` exposes only `--project`,
`--page-path`, `--query` and `--scene`; it has no debug-state argument. The public
[CLI](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html),
[project configuration](https://developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.html),
[CI preview](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html)
and [game.json](https://developers.weixin.qq.com/minigame/dev/reference/configuration/app.html)
contracts provide no documented `enableDebug:false` launch option. CLI `--debug`
controls tool logging, and project `debugOptions` hides Sources content; neither
is the phone runtime switch. Application query parameters are not documented
native debug controls. These facts do not prove that auto-preview forces debug
on. Reopening an observed developer tile may restore retained execution; it does
not establish a new realm or the debug state of a cold start. Read the actual
state only after establishing which entry executed. Clean offline capture and
later report export require separate evidence; successful recovery of saved bytes
does not establish clean sampling or strict-60 acceptance.

### Observed debug recovery and native report retrieval

On the tested WeChat 8.0.79 / base library 3.17.4 phone, a separate preparation
entry called `setEnableDebug(true)` without starting the Engine or sampling.
After that preparation exited, re-entry into the stationary CPU diagnostic
produced a complete report. Its initial and final native observations both read
`enableDebug: true`, and `debugTransitions` was empty. This is an observed route
for this runtime, not a promise that an API callback alone preserves the current
realm or that every later entry inherits the same state.

The eight-second stationary window contained 211 submitted and 211 completed
App frames: 26.375 completion callbacks per second. The CPU owner captured 120
App and Renderer frames with complete owner coverage. The retained report was
2,630,014 bytes, SHA-256
`ffcaf93f744e6bbec3fc37c9b3cff7f5b895cfb3584a33e53001826178c2c8b4`.
No native input was sent. This establishes actual stationary CPU collection and
receipt drain with debug unchanged, not walking/jumping qualification, physical
display FPS or clean performance acceptance.

The root marker diagnostic displayed its entry marker and the
delayed native summary. With `enableDebug: false`, that summary showed a report
saved in the native filesystem while HTTP transfer retained
`request:fail url not in domain list:127.0.0.1`. An empty receiver in this case
was a transport failure, not proof that entry, sampling, timers or persistence
had failed. Preserve the exact saved path, byte count and digest for recovery.

The separate [report recovery entry](../scripts/phone_report_recovery.mjs)
(`c9dd7c542`) later ran under the same AppID after an independent debug-enabled
start. It read the specified known path from `wx.env.USER_DATA_PATH`, verified
the original bytes and SHA-256, and sent those bytes through the existing HTTP
receipt protocol. It accepts only one to four explicit owned report paths,
bounded to 24 MiB total, and does not enumerate, rewrite or reserialize reports.
The actual receiver accepted 151,746 bytes with SHA-256
`978205b5d409f8b50cb262e50599a4d68eeed3f8f667c7df6ff50ddf0898c1f5`,
matching the marker summary. This recovery entry loads no Engine: its black
background and native summary are the expected tool UI, not a failed game render.

Those recovered GPU bytes remained `partial`, with
`timer-extension-unavailable`: `EXT_disjoint_timer_query_webgl2` was absent,
counter bits were zero, and no queries were allocated. The collector observed
104 submit and 104 present calls; all 208 timing samples were unavailable.
Their native CPU durations are not substitute GPU elapsed times. Successful
report delivery does not turn this capability failure into a GPU timing pass.

This proves recovery of a previously saved report across separate entries.
It supports a future clean-capture design of save first, prepare debug separately,
re-enter a recovery-only tool, and export the original bytes. The current tools
have not completed clean-sampling behavior acceptance; neither this recovery nor
the debug-enabled CPU result establishes strict 60 FPS.

### Establish which phone entry executed

Official preview success, a changed Android Activity/task, a returned `onShow`,
and an unchanged screenshot cannot attest fresh JavaScript execution. Earlier
CPU, GPU and delayed-export attempts returned byte-identical screenshots,
including the same FPS readout, despite changing Activities; receivers remained
empty and the delayed native modal was not observed. Those facts alone left both
retained execution and a stalled callback path open. The frozen publication
hash establishes disk bytes, not the bytes already executing on the phone.

For a separate startup diagnostic, place a source/run-specific native marker
at the root `game.js` entry, before loading the game modules or scheduling a
timer. Retain the frozen entry hash and the actual device observation together.
A matching observed marker establishes that this entry reached the marker;
it does not establish later App readiness, receipt completion or performance.
An absent marker alone cannot distinguish a retained package/realm from failure
to reach or display the marker. Keep this intrusive check outside timed capture.

The official lifecycle and cache contracts set the following boundaries:

- [`getLaunchOptionsSync`](https://developers.weixin.qq.com/minigame/dev/api/base/app/life-cycle/wx.getLaunchOptionsSync.html)
  reports cold-start parameters; [`getEnterOptionsSync`](https://developers.weixin.qq.com/minigame/dev/api/base/app/life-cycle/wx.getEnterOptionsSync.html)
  covers cold and hot entries. Entry parameters and foreground callbacks do not
  by themselves establish a new JS realm.
- [`restartMiniProgram`](https://developers.weixin.qq.com/minigame/dev/api/navigate/wx.restartMiniProgram.html)
  (base library 2.22.1) restarts the current Mini Game through callbacks and an
  optional path; its contract does not promise code-cache eviction.
  [`exitMiniProgram`](https://developers.weixin.qq.com/minigame/dev/api/navigate/wx.exitMiniProgram.html)
  (2.17.3) likewise does not promise fresh code when later reopened.
- The Mini Game [code-package guide](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/code-package.html)
  describes cached offline packages and one local developer package per developer.
  It explicitly says deleting a Mini Game from the history list clears its code
  package, while deleting it from the pull-down task bar does not. This describes
  cache behavior; it is not an automatic cleanup step. The guide's QR delivery
  wording does not invalidate the installed official account-push preview route.
- The general **Mini Program** [operating guide](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/operating-mechanism.html)
  describes retained warm starts and background suspension after roughly five
  seconds. Its [published-version update guide](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/update-mechanism.html)
  allows a current cold start to use an older package while an update downloads.
  Neither proves Mini Game developer `auto_preview` semantics on this phone.

The existing [Android observations](android-device.md)
show that reopening a developer tile can restore the same task. Native
"Re-enter" was observed to restart the target, but no JS entry identity was
captured, so that result is not fresh-source proof.

Only after a matching entry marker should a missing report be attributed further.
The shared [observer](../scripts/fixtures/gameplay-benchmark/observer.mjs) pauses
the App, races the actual last receipt against a ten-second timer, and then
inspects the Renderer; the [phone observer](../scripts/phone_gameplay_observer.mjs)
awaits that drain before finalization and persistence. A static last image plus
an empty receiver is compatible with waiting in that path, but does not prove
it. There is no evidence here that `App.pause()` universally stops native timers.

If official preview repeats a compiler error whose exact source fragment differs
from the hash-verified Host on disk, retain both identities and the official
failure. A headless project can reject `cleanCompileCache` with `GUI project
window not found`. A fresh import directory provides a scoped comparison without
changing compiler options or overwriting the prior project; an old cached error
is not evidence that the newly verified bundle still contains the offending token.
This is DevTools compile-cache diagnosis, separate from phone package caching
and the identity of an already running JS realm.

## Run the same gameplay in a Mac browser

The shared [browser runner](../scripts/run_gameplay_benchmark.mjs) provides a
hardware Browser comparison and a cheaper tool qualification path. It retains
the full published game, scene, frontend and native payloads while the
[builder](../scripts/build_gameplay_benchmark.mjs) declares its Browser Host
adaptations. DOM touch qualification does not prove the simulator's public wx
bridge. Prepare once from the same frozen ordinary publication and its matching
Engine source:

```sh
node skills/forgeax-engine-wechat/scripts/build_gameplay_benchmark.mjs \
  --target browser \
  --publication /absolute/ordinary-wechat-publication \
  --engine-source /absolute/matching-frozen-engine-source \
  --tool-root /absolute/engine-tool-checkout \
  --source-commit FULL_40_HEX_SOURCE_COMMIT \
  --manifest-sha256 ORDINARY_MANIFEST_SHA256 \
  --width 844 --height 390 --dpr 3 \
  --out /absolute/new-frozen-browser-benchmark
```

The builder records `browser-manifest.json` and `assembly-differences.json`.
Its exact Host seam checks must pass; do not silently replace a mismatched source
or weaken those checks. A frozen `7c90ac2b04c69b50b3d662c63fe5b417cbcc6b92`
publication is an **old7c baseline**, even if today's runner or builder prepares
it. It does not include the render/runtime optimizations from PR #3870. Its
result cannot describe current Engine behavior or those optimizations' effect. To measure current code,
use an ordinary publication produced from the intended current commit and record
its own manifest and payload identities. Reuse only build/Cook inputs that still
match; changing tool files alone does not update the game being measured.

With a full checkout on the Mac, the CLI acquires the repository's local GPU
lease and starts its own sandboxed Chromium:

```sh
node skills/forgeax-engine-wechat/scripts/run_gameplay_benchmark.mjs \
  --root /absolute/frozen-browser-benchmark \
  --out /absolute/new-browser-result \
  --playwright /absolute/tools/node_modules/playwright-core/index.mjs \
  --chrome '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --phase-ms 1000 --max-lateness-ms 100 --tool-verification
```

When the Mac has only the transferred script tree and frozen benchmark, use the
existing exported function; the CLI's checkout-local GPU lease module is not
present there. From the transferred scripts directory, the actual invocation
shape is:

```sh
/opt/homebrew/bin/node --input-type=module <<'JS'
import { runGameplayBenchmark } from './run_gameplay_benchmark.mjs';
const report = await runGameplayBenchmark({
  root: '/absolute/frozen-browser-benchmark',
  out: '/absolute/new-browser-result',
  playwright: '/absolute/tools/node_modules/playwright-core/index.mjs',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  software: false,
  toolVerification: true,
  phaseMs: 1000,
  maxLatenessMs: 100,
});
console.log(JSON.stringify({ success: report.success, failure: report.failure,
  analysis: report.analysis?.status, toolVerification: report.toolVerification }));
if (!report.success || report.analysis?.status !== 'complete') process.exitCode = 1;
JS
```

This function includes no GPU lease or host-capacity admission. Its caller must
own machine scheduling, fresh and simultaneous `mac_headroom.py` evidence and
cleanup of only task-owned browser activity. Keep Chromium sandboxing enabled;
do not add launch flags to bypass it. `software: false` requires an actual
hardware WebGL renderer, but `toolVerification: true` still labels this short
four-second run as tool qualification. Freeze the intended measurement duration
and set `toolVerification: false` only for a separately qualified performance
sample. Neither option supplies capacity evidence or simulator acceptance.

For separate CPU attribution, use `cpuProfile: true` (CLI `--cpu-profile`) in a
new run. This records the actual game's V8 samples in `profile.cpuprofile` with
its digest, duration and sample count. Sampling includes the arm lead-in and
stops before landing inspection; failures retain any available profile. The
report marks `diagnostic: 'cpu-profile'`, which excludes both strict-60 and
hardware acceptance even when the measured cadence appears fast. Keep idle,
program and unclassified samples separate; they do not identify GPU duration.

For passive event attribution, run `trace: 'completion'` or `trace: 'input'`
(CLI `--trace completion|input`) separately from CPU sampling. The former records
existing GL fences, polls, flushes, timers and rAF through the
[completion collector](completion-timing.md). The latter records trusted pointer
events and actual player-control messages through the
[input collector](browser-gameplay-input.md). Both install before game scripts load,
start after control qualification, and stop before landing inspection. Their
JSON artifacts retain overflow, missing coverage, original timestamps and
restoration results; the run is explicitly diagnostic and cannot pass FPS
acceptance. They add no gameplay messages, GL queries or completion polls.

For actual GPU elapsed intervals, use `trace: 'gpu'` (CLI `--trace gpu`) with a
Browser preparation built from the optional Host seam described in
[GPU diagnosis](browser-gameplay-gpu.md). This separately brackets native queue
submit and surface present. UI raster/composite belongs to the scene submission;
the second fence is not a separate UI frame. Present's transition fence also
precedes its final blit/draw, so fence age cannot substitute for GPU timing.
Queries are bounded and collected only after the existing App drain. No extra
flush, finish, or query-result polling runs in the measured window. This mode is
instrumented diagnosis, excludes FPS acceptance, and preserves unavailable,
disjoint, overflow and cleanup evidence in `gpu-trace.json`. Rebuild only this
Browser fixture to add the seam; reuse the ordinary game, assets and WASM bytes.

## Qualify input and keep timing clean

Review a current image of the owned game before invocation. The runner also saves
`controls.png` before input, plus `before.png` and `after.png` around timing. The
ordinary scene and frontend must be ready for at least 60 scene completions,
with healthy runtime vase geometry and no RHI recorder attached.

Control rectangles come from the actual untruncated Blitz inspection. Native
window extent/DPR, canvas drawing-buffer size, the canvas DOM rectangle and CDP
viewport are recorded independently. The runner maps native logical controls
through the actual canvas rectangle into **CSS pixel** input coordinates; it
does not multiply CDP coordinates by DPR. Missing or ambiguous native display,
canvas, controls or WebGL2 driver evidence is a structured failure.

The temporary observer subscribes to public `wx.onTouchStart/Move/End/Cancel`
without replacing handlers or calling game input internals. It verifies bounded
native event batches, independent active contacts, native coordinate agreement
and stable IDs. Native IDs may differ from CDP IDs. A moving finger must survive
adding and independently releasing Run. All four phases must show actual
movement/run state where applicable, new fixed ticks and scene completions,
camera rotation, airborne jump and landing. After release, movement and camera
must stop. An acknowledged CDP command alone cannot qualify the native bridge.

The [shared timeline](../scripts/fixtures/gameplay-benchmark/timeline.mjs) defines
four equal phases: walk, run, stationary jump, then run plus jump. This route
design alternates forward/backward every 250 ms at the ordinary game speed to
limit travel while retaining movement, Run and jump work.
The timeline and report identify this route as `shuttle-250ms/1`. Each phase uses
repeated forward camera sweeps; look briefly lifts and recenters once per second
instead of reversing yaw. Move/look/run/jump have separate stable contact IDs.
The final event releases every contact. The default is four 10-second phases;
`--phase-ms` permits 1–30 seconds per phase. Freeze this duration and actual
geometry before comparing candidates.

For this ordinary game-3d fixture, the runner requires a neutral grounded start
with `|x|, |z| <= 8`, leaving room inside its 28-unit ground. The final grounded
position must remain within 13.59 units per axis, accounting for the capsule and
contact offset. A 40-second numerical input model helps choose the route but
does not prove collision behavior: qualify actual movement and landing first.
Use actual short-run numeric state and complete images to confirm the path stays
on the platform before a longer sample. Short tool qualification is not stable-60
acceptance. An older forward-only run left the platform while the CDP driver also
released the wrong contacts; it cannot isolate the behavior of correctly driven
forward movement or establish a performance comparison with this route.

After qualification the public wx probe is removed. The
[shared App observer](../scripts/fixtures/gameplay-benchmark/observer.mjs) arms one
bounded window using the existing Platform clock. CDP request-midpoint alignment
records its uncertainty; an uncertainty over the declared input lateness budget
fails. During the timed window, only the shared CDP contact schedule runs: no
inspector polling, screenshots, profiles, capture/replay, GL hooks, GPU queries
or synchronous pixel readback. The original game App continues to pace itself.

The arm receipt also retains a host UTC bracket; Browser runs include
`performance.timeOrigin`. Use these anchors with the concurrent headroom sample
times. Reports made before these fields existed cannot precisely align a short
frame window to UTC; do not count their later idle cleanup as measurement headroom.

The shared input driver sends contact snapshots at their scheduled times. Its
default pending bound is the largest number of snapshots in the permitted
dispatch-lateness window (seven at 60 Hz with 100 ms), with a hard limit of 16.
It records sends,
acknowledgements, lateness, peak pending work and incomplete events. A slow ACK
does not serialize the producer to that ACK rate. Backlog, interruption or more
than `--max-lateness-ms` (default 100, maximum 100) of dispatch lateness stops the
input; overdue gestures are never compressed into catch-up delivery.

CDP `touchEnd` with explicit points names the contacts to end; an empty list ends
all. The shared driver derives removed contacts from complete caller snapshots.
The [real CDP regression](../scripts/__tests__/gameplay-cdp.test.mjs) reproduced
the inverse-list bug in Linux Chromium 141.0.7390.37 with two, three and four
fingers, then passed after the correction. The same semantics were observed in
Mac Chrome 155.0.8059.40 and official DevTools Nightly 2.02.2610092, where trusted
DOM and public wx events agreed. This is an input-tool correction, not a production
game fix. Earlier captures made with the inverse list do not prove the declared
workload even when all 2401 CDP commands were acknowledged; retain them as faulty
input observations and requalify before comparing gameplay timing.

Normal qualification release uses the complete empty contact snapshot
`dispatch([])`, which emits the ordinary all-up `touchEnd` when contacts are held.
Do not substitute the emergency `release()`/`touchCancel` path. On 2026-10-13,
official DevTools Nightly 2.02.2610092 acknowledged that Cancel after correctly
ending Run id 3, but the subscribed public wx stream contained no subsequent
Cancel or End for the remaining Move id 1. The player stayed at vertical input 1,
left the platform, and timed out at `independent.final.released`. The report
correctly retained `releaseConfirmed: true` alongside
`contactsReleased: false` and `nativeContactsReleased: false`. This is an observed
CDP-to-DevTools forwarding limitation for that attempt, not evidence of a WeChat
phone `onTouchCancel` defect. The
[focused simulator regression](../scripts/__tests__/simulator-gameplay-benchmark.test.mjs)
models an acknowledged Cancel with no native event and requires normal
qualification to end contacts without invoking emergency cancellation.

Cleanup reuses this driver's acknowledged contact state. If its latest wire
command is a confirmed all-up and no later command was issued, `release()` sends
nothing. Otherwise it cancels contacts even if an earlier DOWN acknowledgement
was lost. A second empty native cancel can itself be rejected; never hide that
error or use that rejection alone to justify skipping an unconfirmed release. The simulator records
the final `inputCleanup` wire counters and release confirmation separately from
the timed input report.

### Diagnose a missing terminal ACK

Add `--native-release-witness` to a **separate simulator diagnostic** when the
terminal all-up ACK is missing. The
[bounded public wx fixture](../scripts/fixtures/gameplay-benchmark/native-release-witness.mjs)
installs after qualification, subscribes to Start/End/Cancel only, tracks at most
eight native IDs, and retains the latest 16 callbacks. It validates the actual
`event.touches` list against the observed changes; native IDs need not equal CDP
IDs. Ring eviction is reported and does not invalidate the current active list.
Invalid batches, missing Start, or replaced realm/API/inspection owners cannot
prove release. The existing qualification observer is still removed before timing.

The diagnostic performs at most two compact reads after the upper bound of the
timed window; it never evaluates the game during that window. It records
`terminalNativeRelease.samples` and one `outcome`. Only a native End/Cancel with
zero remaining contacts **matched to the actual terminal all-up send**, a Start
observed by this run, unchanged World/device/Host,
strict neutral controls, `grounded === true`, and zero pending wire commands can
skip the **second** emergency cancel in the runner's final cleanup. The shared
scheduler's original cleanup attempt and any native rejection remain in the report.
The observer removes only its own public listeners after App drain.

The original arm request also samples the observer page's `performance.now()`;
its runner send/return bracket calibrates that clock independently of the
Platform and completion-recorder clock origins. The actual all-up wire send
records runner monotonic time. `terminalTiming` retains its mapped earliest/latest
page times, with a conservative 1 ms clock-quantization allowance. The native
event must occur after the latest possible send time and before the witness
sample, and the input report must show that the terminal snapshot was sent.
A later gameplay command invalidates an earlier all-up candidate. An event
inside the uncertainty interval cannot prove release. No native event timestamp
with an uncalibrated origin is used for this decision.

On October 13, one diagnostic's last public End with zero contacts preceded its
terminal send by approximately 1.948 seconds; subsequent native events were
missing. Its neutral player sample and old zero were insufficient. The regression
retains that distinction: a latest zero can describe earlier state while the
terminal delivery remains unproven. Do not infer final release from it.

Another maintained 40-second run on October 13 retained 2400/2401 ACKs and
`partial`, but its native stream became permanently invalid at
`native-release-duplicate-start` after 59 accepted callbacks; the last retained
callback was about 23 seconds into the window. That capture omitted the offending
payload and its time; the previous event ring cannot
establish why the duplicate occurred. Preserve this evidence gap rather than
reconstructing the missing callback or relaxing duplicate validation.

The maintained observer now retains `firstAnomaly`: the original touch identifier
and coordinate fields from `changedTouches` and `touches`, prior active IDs,
phase and both observed/native times. Each list stores at most eight points,
with original lengths and truncation flags; oversized strings retain a bounded
prefix and original length. Non-primitive fields retain their type. Later events
never replace this first anomaly, and invalid input never becomes accepted history.
`nativeReleaseObserver.released` and `cleanup.nativeReleaseObserverReleased`
report actual listener removal independently of `failure`. Successful removal
does not repair invalid native evidence or promote an incomplete input run.

Read `native-released-ack-unconfirmed` as independent evidence that contacts and
game controls released, **not** acknowledgement of the missing input command.
`inputDispatch`, `inputCleanup.releaseConfirmed: false`, legacy
`cleanup.contactsReleased: false`, the input failure, and `analysis.status: partial`
remain unchanged. `cleanup.nativeContactsReleased: true` explains why that legacy
ACK result does not establish stuck controls. `native-start-not-observed` means
this observer saw no native delivery; neutral player state or the native error
“Must send a TouchStart first” cannot substitute for input evidence. Other
incomplete evidence remains `native-release-unproven` or `native-evidence-invalid`.

The run is tagged `diagnostic: 'native-release-witness'` and cannot qualify strict
60 FPS or hardware performance, even if collection otherwise succeeds. Existing
ordinary benchmark packages can be reused; this is a runner-side public
subscription, not a publication or Chromium modification. Offline
[fixture](../scripts/__tests__/native-release-witness.test.mjs) and
[runner](../scripts/__tests__/simulator-gameplay-benchmark.test.mjs) regressions
cover release, lost ACK, no native delivery, stale owners, pending commands,
bounded storage and listener cleanup. They are tool evidence, not a new device run.

After the window, the App continues until the release is consumed and the player
lands. The release witness is the resolved player sample whose controls are
neutral and whose `grounded` value is exactly `true`; an async predicate's Promise
is not a witness. Only then does `drain()` pause the actual App and await its latest actual
receipt, verifying zero pending completions and matching final frame IDs. Each
observer realm can arm once. Repeat through a fresh ordinary realm; do not clear
old evidence or resume a drained realm as if it were a new sample.

## Read the result and handle incomplete runs

`report.json` retains raw submitted/completed events, World/device/Host identity,
semantic witnesses, extent/driver, images, input timing, publication checks and
cleanup status. `timeline.json`, `analysis.json` and `analysis.md` retain the
exact workload and derived statistics. The output directory is private (0700),
with result files 0600; sanitize source paths, account metadata and images before
publishing an evidence package.

The [analyzer](../scripts/analyze_gameplay_performance.mjs) reports completed-frame
throughput using each explicit window's duration, interval p50/p95/p99/max,
counts above 16.667/33.333 ms, rolling one-second minimum completions and boundary
silence. The strict 60 cadence policy has no rounding tolerance: each phase must
reach 60 mean completions/second, every contained rolling second must have at
least 60, and p99/maximum intervals must be at most 1000/60 ms. Frame-ID gaps and
estimated missed 60-Hz slots are not measured display dropped-frame counts.
App completion timestamps are neither GPU execution time nor physical scanout.

`success: true` means complete collection, not stable 60 FPS acceptance. Image
review must confirm the ordinary scene remains present along the camera path;
grounded player state alone does not prove comparable visible rendering work.
Keep fresh and simultaneous [capacity observations](performance.md#host-capacity-first)
and thermal facts with each sample. `--capacity-status` only accepts `unverified`
or `contended`; this runner cannot promote capacity or image evidence into a
hardware pass. A contended or locked-desktop observation retains its context and
cannot establish the final stable-60 target. Browser hardware results and phone
results retain their own host scope; the final simulator target requires actual
official simulator evidence.

Failure releases through the shared confirmed-contact logic, removes only the
owned wx subscriptions, and closes its CDP socket. Native CDP error messages and
details remain available for diagnosis. If arming was attempted, even if
its ACK was lost, failure aborts observation and attempts actual App drain. An
abort, missing contacts, target replacement, overflow, incomplete input, missing
completion evidence or cleanup failure remains failed/partial. Preserve the
structured error and raw available events. If the target disappears, a successful
socket close does not prove contacts or the App drained; inspect the owned target
through the official recovery path before retrying.

Offline contracts run without a device or GPU:

```sh
node --test skills/forgeax-engine-wechat/scripts/__tests__/simulator-gameplay-benchmark.test.mjs
```
