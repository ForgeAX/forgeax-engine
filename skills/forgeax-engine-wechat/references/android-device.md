# Android phone preview and evidence

Use [Setup](setup.md) and [Tooling](tooling.md) for the existing DevTools machine
and official Tencent CLI. USB ADB authorization, DevTools login, client consent,
and the phone account's access to the AppID are independent states.

## USB connection

Find `adb` on the machine physically connected to the phone. If absent, obtain
[Google's official Platform Tools](https://developer.android.com/tools/releases/platform-tools)
for that machine's OS; a dedicated user-owned directory avoids replacing an
existing SDK. macOS's official archive is
`https://dl.google.com/android/repository/platform-tools-latest-darwin.zip`.
Record the downloaded archive hash and actual `adb version`.

The read-only helper accepts the same private SSH machine config as `wechatide.py`:

```bash
python3 skills/forgeax-engine-wechat/scripts/android_device.py \
  --config /private/wechat-machine.json \
  --adb /absolute/path/on/connected-machine/platform-tools/adb \
  --out /private/run/android-discovery
```

Omit `--config` when running on the connected machine. Each output directory must
be new. With multiple phones, select the intended serial using `--serial`; the
private result retains device identities while stdout reports only states and
version facts. The helper does not install tools, authorize USB, open WeChat,
capture personal screens, or claim game readiness.

| ADB state | Action |
|:--|:--|
| `unauthorized` | Immediately notify the user to unlock the phone and accept **Allow USB debugging** for the connected machine. Do not bypass the prompt. |
| `device` | Read model/Android API/ABI and the installed `com.tencent.mm` version; proceed to official preview. |
| `offline` | Preserve the result; check the cable/USB connection and phone state before retrying. |
| No device | Check USB connection and developer-mode USB debugging on the phone. |
| Multiple devices | Select the user's intended phone explicitly. |

The helper exits 0 for an authorized device with WeChat installed, 3 for pending
USB authorization, and 1 for unavailable tools/devices or other failures.

If the user takes the phone away, stop phone input, launch and capture immediately;
do not start a reconnect watcher. Keep the last package and results. When the user
says the phone is available again, rerun discovery and retain existing USB
authorization if still valid. Reopen the existing preview when available; a new
source package or expired preview needs a new official preview result.

A replacement phone is a new target. Rediscover its serial, authorization,
installed browser/WeChat and foreground package before launching anything. If it
is shared with another session, preserve that session's foreground and debugging
connections. A phone without WeChat can qualify browser WebGL only when available
for that work; it cannot qualify native Mini Game APIs or reuse the previous
phone's pass. Do not install WeChat or transfer the removed phone's launch/input
commands to the replacement implicitly.

Installed WeChat does not establish a logged-in account. On the replacement
Android 16 / WeChat 8.0.76 target, the ordinary launcher opened
`com.tencent.mm/.plugin.account.ui.WelcomeActivity`; native game validation could
not proceed. `uiautomator dump` returned exit 0 with `ERROR: could not get idle
state.` and no XML, so check both output and actual activity before parsing.
Retain the failure and restore the prior launcher when that welcome screen is
still foreground. Do not send an account-based preview to discover which phone
will receive it; the previously used phone may no longer be available.

## Official preview

Start from the selected ordinary game and verified publication, reusing still
applicable host evidence without requiring an unchanged simulator detour.
Preserve the source revision, original manifest hash, archive hash, AppID/config
provenance and native payload identities. A source repair creates a new candidate;
it does not inherit the previous package's pass for an affected target.

Follow the installed official skill's previewer scene: `auto_preview` is the
default phone-preview action and can push a rebuilt game without a new QR scan.
The qualified Android journey used this route repeatedly, including after
reopening WeChat. Confirm that the intended phone is logged into the expected
developer account with access to the AppID; USB authorization and an installed
WeChat do not establish that account. The push targets the account, not the ADB
serial, so do not use it to locate a replacement phone or interrupt a shared one.
For a scan workflow use its documented
`create_preview_qrcode` tool; request an image output when a remote user must see
it. Consult installed help for the actual flags. A preview is separate from
`upload`; do not publish a release or experience version as a substitute.

When a scan is needed, show the original returned QR image and send an explicit input
notification when available. State which action is needed: scan with the intended
WeChat account, confirm on the phone, or approve in DevTools. A progress image
alone may not notify the user. Keep `pendingTask` and follow the official polling
rules in Tooling; preview confirmation is not a login/auth polling loop. Neither
a generated QR nor a successful push proves that the phone opened the game.

For a remote user, the official `create_preview_qrcode` tool supports
`--qr-format image --qr-output /private/preview.jpg`; the output path belongs to
the DevTools machine. In DevTools 2.02.2610092 / skill 0.3.11, its stdout image
array was truncated at 65,536 bytes. Retain that protocol failure, copy the intact
file produced by `--qr-output`, and verify/open its actual image bytes before
showing it. The observed file was JPEG even with a `.png` output name. Do not
recover a QR by guessing missing stdout bytes or infer runtime success from it.

An authorized USB connection can leave Android's USB settings in the foreground
after a successful preview push. Inspect the foreground before capture. One guarded
Back from that transient page can restore the existing game or return to the
launcher. Inspect the result before further input. Reuse the authorized preview and
ordinary reopening flow; do not request another scan merely because USB settings
covered the game. Do not capture the launcher or personal WeChat pages as evidence.

The official `automation_viewport_action --action remote --auto` action is documented
under Mini Program automation. On 2026-10-11, invoking it for this Mini Game created
a Remote Debug webview and a new phone AppBrand task without another scan, but
returned `timeout waiting for automator response`; the phone remained on its native
loading screen. This is an observed launch with failed debugging, not a qualified
Mini Game automation route. Inspect the existing device/DevTools state before
repeating an action after timeout. An empty remote appservice context with neither
`wx` nor `GameGlobal` is not the game's execution realm and cannot establish its
runtime capabilities. Keep ordinary preview and remote-debug results separate.

On 2026-10-11, DevTools 2.02.2610092 / official skill 0.3.11 rejected the ordinary
game's 22,101 KB source package through `auto_preview`:

```text
code 10: source size 22101KB exceed max limit 20MB
```

This is a pre-launch delivery failure. The [build budget](build.md) now follows
the observed 20 MiB preview limit. All fonts and non-JavaScript resources were
already Brotli-compressed. The owning production fix shares byte-identical
ScriptablePack artifacts by SHA-256 while retaining every GUID, local artifact
key, descriptor, shader variant and decoded-byte integrity check. Preserve the
content required by the representative game. If pruning is needed, derive the
reachable closure at its owning producer; an edited immutable archive or an
unreviewed remote asset domain does not establish the repaired publication.

The smaller candidate passed size admission but the same DevTools preview
compiler then rejected `basis-native-factory` at an optional chain with
`SyntaxError: Unexpected token .`. The producer had disabled `es6`; its simulator
accepted the modern bundle. The installed official project-config scene requires
`es6` and `enhance` to be enabled together. With both enabled, preview compilation
advanced to the renderer bundle and rejected logical assignment (`||=`) with
`SyntaxError: Unexpected token =`. An ES2020 bundle then failed at another
optional chain; changing the first reported file did not prove a syntax was
accepted. The effective common config retained both flags and no private config
overrode them. The producer now uses Vite's `chrome70` syntax capabilities for
WeChat, lowering optional chains and newer syntax while retaining native BigInt;
this setting does not describe the phone's browser version. The next official
preview succeeded with a 19,769,430-byte compiled package (91,470-byte main,
19,677,960-byte payload). The phone entered the Mini Game loading page. That is
compiler and launch evidence only; no Engine scene or input pass was observed
before the phone became unavailable. Preserve each original compiler result.

A subsequent simulator candidate with the same enabled compiler flags failed
before its first frame: `wgpu-native-initialization-failed`, caused by
`Cannot read properties of undefined (reading 'surfaces')` inside the officially
transformed native initializer. The official Babel pass had hoisted a loop-local context variable over the
captured Host parameter. Vite now owns syntax lowering and minification;
the generated config disables both `es6` and `enhance` as well as `minified`.
Keep the earlier phone preview result attached to its original package and
configuration; it does not qualify a later candidate's native startup.

The first instrumented device startup on 2026-10-11 exposed
`TextDecoder is not defined` before the Host could start. The phone reported
`globalThis` and `GameGlobal` as objects, native `WeakRef` and `queueMicrotask`
as functions, and both
`TextEncoder` and `TextDecoder` as undefined (base library 3.17.4). The simulator
had those encoding APIs.
A diagnostic-only clone prepended early error hooks and one native facts dialog;
its original payload and manifest stayed unchanged. An ordinary startup error
named this platform standards gap; do not attribute the loading screen to graphics
or infer phone capabilities from the desktop remote-debug appservice context.

After the encoding repair, the next ordinary phone preview advanced through
`platform`, `ui-wasm-and-fonts`, `wgpu` and `graphics`, then remained black.
Native vConsole exposed `getSupportedProfiles is not a function` in the actual
wgpu WASM adapter enumeration: the device returned an ASTC extension object
without that query method. The native binding owner now treats the absent query
as unavailable ASTC profiles. For the pinned wasm-bindgen ABI this is numeric
`0` (`None`), not a JavaScript array; available queries retain their original
externref encoding, receiver and exceptions. See the
[native binding contract](../../../packages/wgpu-wasm/README.md#render-bundle-lifetime).
Preserve the actual phone error and qualify the next ordinary publication;
neither a passing binding regression nor the runtime's `RT-FPS` overlay proves
that Engine frames have completed.

Create that isolated diagnostic with the reusable helper:

```bash
python3 skills/forgeax-engine-wechat/scripts/diagnose_phone_startup.py \
  --source /private/verified-wechat-publication \
  --out /private/new-startup-diagnostic
```

It validates the source against its manifest and changes only the copied root
`game.js`, before any original entry code. `startup-diagnostic.json` records the
original manifest and both entry hashes. The original manifest remains unchanged
and intentionally does not qualify this modified entry. Transfer the clone and
run official preview separately. The probe enables native vConsole and displays
API facts; dismiss a covering startup error to inspect the facts dialog. Open
vConsole on the phone for the original module stack. The observed failure occurred
while importing `renderer-host`, after standards installation. Fix that owner,
then build and qualify an ordinary publication without this diagnostic prefix.

For a bounded phone frame observation, add `--observe-frames` and optionally
`--show-frame-result`; `--frame-timeout 150` bounds startup plus observation.
The probe waits for the ready scene's first Renderer presentation, then records
completed/presented receipt deltas over an independent 10-second `Date.now`
window. Native vConsole receives one `[forgeax.phone.frames]` JSON result with
source hashes, generation, actual elapsed time and both FPS values. Startup
dialogs are suppressed in this mode; the optional result dialog appears only
after observation ends. Errors, host hiding, generation changes, leaving the
ready/alive state and regressing counters invalidate the window without FPS.
This measures a diagnostic clone's scene receipts, not `requestAnimationFrame`,
the native `RT-FPS` overlay or per-frame latency percentiles; it does not qualify
the unchanged distribution by itself.

### Retrieve structured startup errors

When the game reaches a named startup failure but native vConsole cannot expand
its nested `detail`, use `--observe-startup` on that same verified publication.
The [startup collector](../scripts/phone_startup_report_prefix.js) polls the actual
`globalThis.__forgeaxGameInspection.renderer()` used by the frame observer. It
retains `startupError`, `lastError`, phase, generation and receipt facts, including
non-enumerable `Error.message`, `stack`, `cause` and structured `detail.appErrors`.
For example, `plugin-startup-failed` after `scene` is an activation-owner failure;
do not infer a shader or GPU failure from the black canvas.

```bash
python3 skills/forgeax-engine-wechat/scripts/diagnose_phone_startup.py \
  --source /private/verified-wechat-publication \
  --out /private/new-startup-report-diagnostic --observe-startup \
  --minimum-scene-frames 60 \
  --inspection-read game-3d.runtime-vase --inspection-read game-3d.player \
  --report-url http://127.0.0.1:19143/forgeax-startup-UNIQUE_RUN
```

Use the [owned USB transport below](#retrieve-a-gl-report-when-vconsole-is-unreadable),
but explicitly select the startup kind and this run's exact path:

```bash
python3 skills/forgeax-engine-wechat/scripts/receive_phone_gl_report.py \
  --kind forgeax-phone-startup \
  --port 19143 --path /forgeax-startup-UNIQUE_RUN \
  --out /private/new-phone-startup-report \
  --manifest-sha256 ORIGINAL_MANIFEST_SHA256 \
  --entry-sha256 ORIGINAL_ENTRY_SHA256 --deadline 180
```

Both expected hashes come from `startup-diagnostic.json`; they identify the
original publication and entry, not the changed clone entry. When running the
receiver on a different machine, copy both `receive_phone_gl_report.py` and its
URL-validator dependency `diagnose_phone_startup.py`. Clone preparation bundles
the checkout's existing SHA-256 and portable UTF-8 owners before device startup;
use `--engine-root` when preparing it from an installed skill. No SDK, native
WASM or ordinary publication rebuild is needed for this diagnostic.

The receiver validates the explicitly selected kind, source identity, exact UTF-8
bytes/hash and bounded terminal shape. It rejects startup reports over 2 MiB,
and cannot accept a GL report as startup evidence or infer the mode from a body.
Read `observation.renderer.startupError` and `lastError`, then their
`cause`/`detail`; a World update failure can be observed before the outer plugin
activation promise assigns `startupError`. Native error events are retained under
`observation.event`. The terminal reason distinguishes
`startup-failed`, `wx.onError`, `wx.onUnhandledRejection`, `inspection-failed`,
`host-stopped`, `host-hidden`, `deadline` and `inspection-unavailable`.
`--minimum-scene-frames` defaults to 1. Set 60 for completed-frame acceptance:
the collector takes the first ready/alive Host counter baseline, then requires
60 new `presented` receipts in the same inspection owner, Host generation and
device generation. `sceneFrames` retains the baseline/end counters, their
observed difference, minimum and `passed` result. Earlier frames, repeated polls
and loading/UI-only completions do not count. The final completion must itself
be `presentation: ready`. Errors, hiding, leaving ready/alive, owner/device
replacement or counter regression terminate without a pass; their reasons also
include `generation-changed`, `scene-left-ready`, `invalid-frame-counters` and
`frame-counters-regressed`. This is completed-frame evidence, not visual or
performance qualification.

Optional `--inspection-read ID` calls the game's existing read projection once
after the required scene completions. Up to eight explicit IDs are allowed;
each has a five-second bound. Results are in `observation.reads` with
`fulfilled`, `failed`, `unavailable` or `timed-out` status. The run continues
checking the same Host while reads are pending. `readContext` identifies the
Host generation and completion preceding the request; it is not a per-frame
GPU capture or temporal sample. For a missing procedural vase, retain
`game-3d.runtime-vase` and correlate its entity/GUID/generation/vertex count/AABB
with the same report's Renderer geometry and material observations. The report
also records whether that owner exposes `rhiCapture`; `recorder-not-enabled`
means a debug candidate is needed before a real frame capture can be obtained.

This mode registers only removable native callbacks, adds no facts/error modal,
and changes no game state, native result, shader, retry or error handler. It
records at most 64 observed phase/generation transitions and stops timers and
owned callbacks at its first terminal. It cannot combine with the frame/GL
observation modes. Without `--report-url`, it retains
`globalThis.__forgeaxPhoneStartupReport` and attempts a private native file only.
The shared transport sends that same serialized snapshot once after cleanup;
artifact/transfer status appears under `[forgeax.phone.startup.artifact]` and
`[forgeax.phone.startup.transfer]`. Transfer failure never changes the game result.

The serializer reads data descriptors without invoking application getters or
`toJSON`. It retains complete ordinary nested errors within explicit bounds:
24 levels, 4096 nodes, 256 properties per object, 65536 characters per string and
262144 total characters. Cycles, accessors, oversized values and unavailable
inspection have `$forgeaxDiagnostic` markers and `serialization.issues`; a marker
is missing/truncated evidence, not an empty original error. Keep those markers
when handing the failure to its owner. The same original error object remains
untouched. The bundled observer-to-Python path is covered by a real loopback HTTP
test; native phone adoption remains a separate, source-bound observation.

### Retrieve the original Rust panic

When RHI reports only `unreachable`, preserve the failing process's original
vConsole/logcat evidence first. A WASM offset inside `std::panicking::panic_with_hook`
identifies the abort path, not the graphics operation that caused it. Match the
exact WASM SHA-256 before mapping its caller offsets through the module's name
section. Missing recording remains `recorder-not-enabled`; this report is not an
RHI frame capture.

If the original panic is unavailable, prepare another diagnostic clone with the
same `diagnose_phone_startup.py --observe-startup` and USB receiver arguments
above. No WASM or product rebuild is required. The early observer now intercepts
the installed `console_error_panic_hook` format: one `console.error` string with
`panicked at ...`, then `\n\nStack:\n\n` and the original stack. Inspect the
returned `report.rustPanics.records[0]` for the first panic's `text` and
`wasmStack`; retain its `truncated` and `redacted` facts. Descriptor labels,
dimensions and WASM offsets remain available. Ordinary console messages,
additional arguments and JS stack lines are not collected; recognized
credential/input key values and private URLs are redacted. Keep the report
private and preserve these focused fields when preparing a sanitized handoff.

The observer temporarily raises the existing numeric `Error.stackTraceLimit` to
64 before game startup; an already higher limit is preserved. Its own descriptor
is inspected without invoking getters or creating an unsupported property.
`report.rustPanics.stackTraceLimit` records the requested/effective depth and
original descriptor/value (`Infinity` is serialized explicitly as a string).
The status is `installed` while owned, `restored` after cleanup,
`already-sufficient` when no change was needed, `replaced` if another owner
changed the constructor/value/descriptor, or `unavailable`/`restore-failed`.
Capability failures carry a bounded reason such as `unsupported`,
`accessor-unavailable` or `property-write-failed`. The exact original descriptor
is restored before terminal serialization only while this observer still owns
the change. If the first panic ends after roughly ten frames with no collector
truncation, inspect this depth capability rather than assuming the complete
caller chain was captured.

The observer retains the first 16 matching messages, with at most 2048 characters
of panic text and 16384 characters of original WASM stack lines per record, and
65536 characters across all records (`retainedChars`). It inspects at most
65536 characters of each message and records per-field and total truncation,
plus the number of overflow records in `dropped`. These limits are independent of the
ordinary error serializer so a large Renderer report cannot evict the first
cause. `hook` reports `installed` while active, `restored` after owned cleanup,
`replaced` if another owner changed it, or `unavailable`/`restore-failed`.
An empty `records` array does not prove that no Rust panic occurred.

`Parking not supported on this platform` can be a secondary failure: a JavaScript
exception during a native GL call exits WASM without running Rust guard destructors.
The following `writeBuffer` then blocks on the still-held `pending_writes` mutex.
The [native GL observer](../scripts/phone_native_gl_errors.js), included by the same
startup collector with no additional flag, preserves `nativeGlErrors.first` before
later panic messages replace the visible error. It records only the method, time,
bounded message, and `callerWasmStack` captured inside the catch while the WASM
callers remain active. This is an observation stack, not the thrown Error's original
stack. `originalStackStatus` records whether the latter was safely available;
application accessors and `toJSON` are never invoked. No GL arguments, upload bytes,
or general console data are collected. Native return values, receivers, argument
identities and thrown objects remain unchanged.

The GL observer follows at most four canvases and four WebGL2 contexts returned by
`wx.createCanvas`/`getContext`, enumerates at most 1024 properties over eight
prototype levels and wraps at most 256 existing data-method properties per context.
It retains one message of 2048 characters and one WASM stack of 8192 characters;
later failures increment `laterThrows`. Context records expose discovery bounds,
installed/restored/replaced/unavailable counts and up to 16 capability failures.
Cleanup restores exact descriptors or removes owned inherited-method overrides;
later owners' replacements remain intact. Accessors, GL extension objects and
exceptions thrown in generated glue before entering the GL method are outside this
observer's coverage. A missing first error is not proof that no earlier exception
occurred. The probe wraps hot GL calls and is not a performance measurement.

Each context also keeps bounded `fenceResults` counts for the first 256
`getSyncParameter(SYNC_STATUS)` and `clientWaitSync` results: primitive type and
numeric/boolean value only. Sync handles and payloads are not retained. These
startup-window counts cannot describe retirement throughout a long run, and
Engine completion receipts may use different fences from wgpu's resource queue.

If their relationship is unclear, explicitly add `--probe-fence-status` to an
`--observe-startup` clone. After scene readiness and progress, at most eight
observations (at least 100 ms apart) pair `getSyncParameter`,
`clientWaitSync(sync, 0, 0)` and another query on the **same** native sync.
`fenceProbe.pairs` retains the original primitive values and failed observations.
To sample older fences, add `--fence-probe-delay-ms 10000
--fence-probe-interval-ms 1000`. The delay starts at the first verified ready
baseline (`sceneFrames.startedAt`), and new completed scene progress is still
required. Delay accepts 0–300,000 ms; interval accepts 100–60,000 ms. Both flags
require `--probe-fence-status`; their defaults remain 0 and 100 ms. These settings
change when an ordinary qualifying query is paired, and schedule no extra query
or asynchronous sync retention.

Each pair records numeric `submitDepth` (0 outside the intercepted synchronous
WASM submit, greater than 0 inside), or an explicit unavailable status. Depth
tracking for a probe alone does not enable passive lifetime counters. A per-context
WeakMap assigns local `observationId` values 1–8 to the at most eight sampled sync
objects, storing no strong key reference or pointer. A repeated ID proves the
same observed JavaScript sync object was queried again; compare it only within
the same context and run. Non-object keys or unavailable WeakMap support have an
explicit `observationIdStatus`. Cleanup releases the identity map with the hooks.
This adds native calls and is an intervention: it cannot qualify the unchanged
publication or establish normal performance. Ordinary diagnostics do not enable
it. Preserve the non-intervening run alongside the paired result.

Use the [real WebGL regression](../scripts/verify_phone_native_gl_errors_webgl.mjs)
from the Engine checkout, with the existing canonical WASM and Playwright/Chrome:

```bash
node skills/forgeax-engine-wechat/scripts/verify_phone_native_gl_errors_webgl.mjs . /tmp/forgeax-native-gl-check.json
```

It tests normal write/submit/write, then injects one `bufferSubData` exception on a
fresh page, verifies that the observer retains that exact first cause before the
subsequent Rust panic, and checks restoration of all installed real GL methods.
Chromium sandboxing stays enabled; `FORGEAX_CHROME_CHANNEL` selects an installed
channel (default `chrome-beta`). An injected reproducer proves the lock-leak
mechanism only. Preserve the phone's first native failure before choosing its fix.

The original console receives the same arguments and receiver exactly once;
its return value and thrown error remain unchanged. The observer restores the
original property descriptor before terminal serialization/transfer, without
overwriting a later owner's replacement. Existing native error events and
scene-frame acceptance remain authoritative. For a late failure, select a
`--minimum-scene-frames` and `--frame-timeout` that cover the known trigger:
the usual 60-frame acceptance ends observation too early for a crash after
thousands of frames. A longer diagnostic that reaches its deadline is still
`deadline`, not a scene or performance pass.

### First WASM export failure

An `unreachable` can precede both the first GL exception and the Rust panic hook.
The same startup clone includes [the WASM observer](../scripts/phone_native_wasm_errors.js)
to retain `nativeWasmErrors.first`: export operation, original bounded error stack,
message, timestamp and native memory size. Inspect `stackStatus`, truncation and
capability fields before mapping an offset. The collector reads data properties
or the verified native Error stack getter; it does not invoke arbitrary accessors.
Later throws cannot replace the first one.

Only the existing wgpu `WXWebAssembly.instantiate` import namespace is selected.
The observer projects the initializer's `{ instance.exports, module }` contract
with function wrappers; the immutable native exports object is untouched. Native
memory, table and module identities remain unchanged, and calls preserve receiver,
arguments, return values and thrown objects. Cleanup restores owned functions
and the instantiate method, retaining later owners' replacements. Coverage and
restoration counts remain in `nativeWasmErrors.instances` and `.factory`.

By default, memory is sampled twice: `initialMemory` at initialization and `first.memory`
at the first throw. `byteLength` is the WASM linear-memory high-water extent,
not live allocations, process, JavaScript or GPU memory. Freeing allocations or
running GC need not shrink it. This host API does not expose its declared maximum;
`maximumStatus: 'not-exposed'` must not be interpreted as unbounded memory.
Growth alone does not prove out-of-memory. There is no per-frame memory sampler.
The clone wraps hot WASM calls and cannot qualify performance.

For a long-running failure, explicitly add `--observe-wasm-lifetime` to the same
startup clone. It requires `--observe-startup` and uses that observer's existing
terminal conditions and deadline. For example, from this skill's directory:

```bash
python3 scripts/diagnose_phone_startup.py \
  --source /private/published-wechat --out /private/wasm-lifetime-clone \
  --observe-startup --observe-wasm-lifetime \
  --minimum-scene-frames 12000 --frame-timeout 600 \
  --report-url http://127.0.0.1:19143/startup-test
```

Use the already selected publication and a new private clone directory. The
optional report URL requires the existing explicit receiver/ADB reverse setup;
omitting it retains the normal local report path. Preparation only prepends
`game.js`: no native/Engine rebuild or business-source change is needed.

`nativeWasmErrors.lifetime` records the `FinalizationRegistry` constructor's
data-property type, diagnostic-only qualification and sample limits. Each admitted
instance's `.lifetime.exports` accumulates `calls` and synchronous `throws` by
native export name for create, begin-pass, finish, end, submit, destroy and wrapper
free operations. Both device `createTextureView` and texture `createView` are
covered. These are **call attempts**, not successful operations: the observer
never reads return values, wasm-bindgen `Result::Err` flags or Promise outcomes.
Do not interpret `calls - throws` as success or create/free differences as live
physical allocations.

For `__wbg_*_free`, `.freeArguments` counts second argument `0` as `explicit`, `1`
as `finalizer`, and separately `missing`/`other`. This matches the generated
wasm-bindgen glue; verify the source binding if its ABI changes. The first argument
is only classified as `ptrZero`, `ptrNonzero` (nonzero integers in
`[-2^31, 2^32-1]`, accepting signed-i32 and unsigned-u32 expressions), or
`ptrOther`. Negative finalizer arguments can be valid wasm32 addresses above
2 GiB; neither a signed value nor the `ptrOther` bin alone proves pointer
corruption. Pointer values, object references and arguments are never retained. Finalizer capability
alone does not prove callbacks ran; the second-argument counts are the observation.

Each `.lifetime.samples` row contains a timestamp, memory extent, derived
cumulative operation counts and free-source counts. Sampling starts at admission,
then runs approximately every 1,000 ms; scheduling delays remain visible in the
timestamps. Only the latest 600 rows per instance are retained, with
`droppedSamples` counting evictions; the original `initialMemory` remains available.
The existing limits still admit at most two instances and 256 exports each, and
counters saturate at `Number.MAX_SAFE_INTEGER`. The terminal report keeps final
export counters; its last timer sample may precede the terminal by a sampling
interval. Cleanup stops owned timers, releases the memory sampling reference and
restores owned hooks while preserving later replacements. Check `.sampler` and
memory status fields for unavailable sampling. These observations **do not qualify
FPS or performance**, even if the requested completed-frame count is reached.

The same flag also enables `.nativeGlErrors.lifetime`. Each context's `.lifetime`
keeps cumulative `insideSubmit`, `outsideSubmit` and `unknownSubmitDepth` counters
for the whole observation, rather than stopping at the legacy first 256 results.
The WASM observer shares only a numeric synchronous `rhiwgpuqueue_submit` depth;
nested calls increment it and `finally` restores it on return or throw. Returning
a Promise ends that synchronous boundary. Check WASM projection/installation
coverage before attributing outside-submit activity; this is the boundary of
intercepted exports, not every possible native submission path.
Native presentation can also submit internally through HAL without passing this
WASM export, so outside-submit fences are not necessarily App receipt fences.

GL call entries are classified before the native call. `fenceSync` records
`nonNull`/`null`/`other` returns; `deleteSync` records call attempts and synchronous
throws. `getSyncParameter` counts only `SYNC_STATUS` (`0x9114`) into `signaled`
(`0x9119`), `unsignaled` (`0x9118`) and `other`. Passive `clientWaitSync` counts
`alreadySignaled` (`37146`), `timeoutExpired` (`37147`), `conditionSatisfied`
(`37148`), `waitFailed` (`37149`) and `other`. Every method retains its call/throw
counts, never a sync reference or arbitrary result. In particular,
`TIMEOUT_EXPIRED` must not be reported as `CONDITION_SATISFIED`. No extra query,
wait or maintenance call is made by lifetime mode. The separate
`--probe-fence-status` option remains an explicitly requested intervention.

GL samples copy those numeric counters every 1,000 ms and keep at most 120 recent
rows per admitted context (at most four), with `droppedSamples` and `.sampler`
status. Final cumulative counts survive history eviction and cleanup. At terminal
serialization, the startup owner may trim older GL/WASM samples further to fit
the existing 2 MiB receiver envelope while preserving final counters and original
error evidence. `lifetimeSerialization` records its byte limit, status and number
of size-evicted samples; per-series `droppedSamples` includes those evictions.
These counts distinguish where observed fence calls occur; they do not identify
individual fences, prove a native resource was retired, or qualify performance.

For sustained growth, use equal completed-frame windows through the **same
ordinary App/World/Catalog**. Preserve the failing publication, native and UI WASM
identities and framebuffer extent; record any Browser Host, CSS/DPR or driver
differences. A smaller fixture or older UI package is only a control. Reuse the
same diagnostic tool and input closure across Mac and simulator when possible.

### Native fence retirement and resource growth

Use [Memory diagnosis](memory-diagnosis.md) to analyze an existing report and
separate Host GL status, native queue retirement and binding ownership. It owns
the counter interpretation, steady-state comparison, real WebGL lifecycle
regression and final 2026-10-13 observations. Keep collector setup here and
interpretation there so a later repair does not leave two diagnostic recipes.

For this collector's explicit query/wait/query intervention, weak observation IDs
identify the sync within each pair; different IDs do not establish repeated
observation of one old sync. Compare passive samples before, during and after the
intervention. A same-turn unsignaled result cannot establish the later state.

The real WebGL regression above also verifies this export boundary with the
canonical WASM: normal write/submit/write succeeds; an injected native upload
exception is retained at submit before the later parking failure at write.
[Focused tests](../scripts/test_phone_native_wasm_errors.mjs) include a real WASM
`unreachable`, original throw identity, immutable exports, bounded lifetime
samples/free bins, disabled defaults and owned restoration. The startup and clone
tests also cover opt-in wiring, report transfer and unchanged publication payloads.
These qualify the observer; the actual phone's first trap still determines the
repair owner.

The native startup route was verified on Xiaomi / Android 16 / WeChat 8.0.78 on
2026-10-12 against ordinary source `2c7388a35`, manifest `a659fd9442b9`.
Official preview and an owned ADB reverse delivered 20,333 bytes, SHA-256
`f44bf7207a24fd1f5442e38a3f520ceb5ba5a34a96087f8b53682b19b2518226`,
then removed that mapping. The Renderer was alive at phase `scene`, with ten
completed receipts and zero scene presentations. `startupError` was still
undefined, but `lastError.detail.cause.detail.fault` identified
`system:physicsStepSimulation`: its `DerivedPhysicsError` reported
`derived-backend-failed` with reason `unreachable`, poisoning the World after a
possible partial write. This identifies the native fixed-step boundary; it does
not yet identify the failing WASM instruction or qualify physics/gameplay.
The original report remains in the private artifact archive under
`design-resumed/phone-resumed-20261012/startup-cause-2c-02/report.json`.
Do not retry a poisoned World or infer a fresh GPU pipeline failure from the
resulting startup overlay.

A second startup report records native clock availability without installing
globals: `clockBeforeStartup` and `clockAtTerminal` contain the global clock
descriptors and finite samples from `wx.getPerformance().now()`. On the same
phone, both observations show `globalThis.performance` absent and the WeChat
clock available. The report is 21,400 bytes, SHA-256
`ccb2741c6fb0270f3d109cc82a40618a287419b9519c4407c9fce209d13c3b35`,
under `startup-clock-2c-02/report.json` in the same private archive. It retains
the native fixed-step trap with twelve completed receipts and zero scene
presentations. A real Rapier WASM regression independently reproduces that trap
when the browser global clock is absent. Connect the native consumer to the
explicit host clock; do not change the physics delta or install browser globals
to conceal the dependency. Successful gameplay still requires the repaired
ordinary package on the phone.

The preceding `startup-clock-2c-01` attempt timed out before any report arrived.
Its observed AppBrand process displayed a white screen and logged
`sync_merge` / `Too many open files`, with file descriptors near its limit;
even native log-file opens failed. This is retained host failure evidence, not
a clock-probe or physics result. After leaving that observed game, Android's
`am kill --user USER com.tencent.mm` retired processes safe to kill in the
background; the old AppBrand PID was confirmed gone. Opening the installed
WeChat launcher and running official preview again recovered the expected game
startup UI and the report above without a scan, logout or data deletion.
Check ownership and foreground before recovery, preserve process-scoped logs,
and do not treat an `auto_preview` success or AppBrand activity alone as proof
that the intended game loaded. Close the observed failing game after collection
instead of leaving an unqualified render loop running. The source of native
file-descriptor exhaustion remains a separate investigation.

### Parameter interaction receipts

The stock startup collector reads once when its scene-frame gate passes. That
does not wait for a later UI operation. A private game-3d diagnostic with a fixed
two-minute delay captured the accepted Height change before the subsequent Sides
edit; its healthy report could not qualify the later 255-vertex screenshot.
Finishing the gate also restores its observers, so a later interaction cannot be
recovered by rereading that terminal report. Choose the operation-specific end
condition before launch; increasing frame count alone is not evidence for an edit.

For such an interaction, adapt the diagnostic observation to the actual goal:
read the existing `game-3d.runtime-vase` projection for an initial baseline, then
poll that same read until the requested parameter tuple is accepted with
`busy: false` and no error. The qualified phone run polled at most once per
second, kept the existing five-second read bound, total deadline, minimum 60 new
scene presentations and Host/device/hidden/error checks, and sent one terminal
report through the existing USB receiver. Retain both reads and their completion
contexts in that report. This is a private diagnostic recipe, not an additional
`diagnose_phone_startup.py` CLI mode; no new RPC, game registry or graphics host
is needed. Preserve the original publication and record the diagnostic entry
hash. Restore the verified ordinary preview after observation.

Read the collector's retained range and dropped count before making temporal
claims. A later 250 ms observer kept at most 96 changed samples; small grounded
Y corrections exhausted that list at 82.626 seconds and 267 later changes were
dropped. Its independent `lastPlayer`/`lastContext` and vase-generation changes
continued to update, so the terminal released state and later accepted edits
remained observable. They cannot reconstruct the missing movement history or
prove continuous smoothness. Match action and observation order without treating
their separate host/phone clocks as calibrated input latency.

For the current template, the smallest useful shape change is Height `3.5` and
Sides `16`, keeping Radius `0.75`. Compare with its default `2.4 / 0.75 / 32`:

| Observation | Expected result |
| --- | --- |
| GUID and entity | Same values in the two reads from the same live World. |
| `generation` | The accepted Pack publication generation changes; this is not a frame number. |
| `vertexCount` | `15 × (sides + 1)`: 495 becomes 255. |
| `aabb` | Local bounds change from `[-0.75, 0, -0.75, 0.75, 2.4, 0.75]` to `[-0.75, 0, -0.75, 0.75, 3.5, 0.75]`, allowing float32 error. |
| Renderer binding | In the same `worldIdentity`, match `meshMaterialBindings[].entityKey` to the vase entity; its single `renderer-override` slot is `ready` with no diagnostics. |

These values derive from the template's [generator](../../../templates/game-3d/assets/runtime-vase/vase.program.mjs)
and [World binding](../../../templates/game-3d/assets/runtime-vase/vase.pack.ts).
The vase replaces an ordinary `MeshAsset` through `MeshFilter`; it does not call
the Render `DynamicGeometry` API. Zero `dynamicGeometry` counts are therefore
valid, and its device generation/revision must not be compared with the Pack
publication generation. A material binding handle is also not an asset GUID.

Review the actual generated shape and the reopened/closed controls separately.
The observations above are asynchronous state projections, not proof of a
particular draw or GPU pixels. If generation and residency succeed but the vase
is still missing or incorrectly lit, follow [RHI Debug](../../forgeax-engine-rhi-debug/SKILL.md)
on the actual failing frame; retain `recorder-not-enabled` when capture is absent.
Neither the longer interaction window nor its FPS overlay qualifies performance.

### Observe original native GL status

For an empty native pipeline link error, use `--observe-gl-link` on the same
verified publication, adding `--engine-root /path/to/engine-checkout` when the skill
is installed outside the source checkout. This mode bundles the checkout's existing
SHA-256 and portable UTF-8 dependencies into the prefix; it needs Node and installed
Engine dependencies while preparing the clone, and no imports or encoding globals
on the device. It hooks only the clone's `wx.createCanvas`, returned
canvas `getContext` and original WebGL2 context `linkProgram` / `getProgramParameter`; every original
receiver, argument, result and exception is preserved. `[forgeax.phone.gl-link]`
records raw `LINK_STATUS` values and types, attached shaders' `COMPILE_STATUS`
values/types, info logs, capabilities and context-loss state. Every available
`getShaderSource` body has its UTF-8 byte count and SHA-256 in the link record.
Complete original GLSL bodies are deduplicated by hash in the retained report;
these are not driver-translated sources. An
empty info log alone cannot distinguish a false native link result from a
non-boolean result rejected by glow's `as_bool()` boundary. Hook failures are
explicit; unavailable/non-writable methods never qualify an observation.
The `link` row is a proactive query immediately after native linking. The probe
calls the original query directly so its own observation cannot masquerade as
Engine consumption. `consumer-link-status` records the first subsequent actual
`getProgramParameter(program, LINK_STATUS)` result or exception for that same
context/program, linked to the original `context` and `link` indices. This matters
because wgpu checks status after deleting the attached shader objects; the two
query points need not be assumed equivalent. Other parameters and untracked
programs pass through without consumer records. No program handles enter JSON.

The probe makes no shader substitutions or covering dialogs. A non-`true`
proactive status now waits for the actual consumer query before cleanup and
transfer. If no matching query occurs, the bounded report records
`consumer-link-status-unavailable` with `no-subsequent-query`; do not infer what
Engine consumed. Hooks are restored after a thrown link/query, a matching query
when either status was non-`true`, a failed hook, 32 links or the configured
deadline. Original native exceptions survive observation. Later wrapper owners
are never overwritten.

`globalThis.__forgeaxPhoneGlLinkReport` retains plain data, without GL handles,
after hook cleanup. At termination the probe also tries to create a new private
directory under `wx.env.USER_DATA_PATH` and writes its complete `report.json`.
`[forgeax.phone.gl-link.artifact]` records the exact path, byte count and SHA-256,
or an explicit unavailable/write failure. Console logs alone may be truncated;
retrieve this file through the available device transport before closing the game,
or read the retained report through authorized evaluation. Do not request the whole
report in a size-limited evaluation: read metadata first and source text in pages
of at most 2048 UTF-16 code units, then verify the advertised UTF-8 SHA-256 on the
host. Preserve the device/publication identity and only delete the returned private
file/directory after verifying its transferred bytes.

Sources are bounded to 2 MiB each and 16 MiB total; info logs retain up to 65536
characters with explicit truncation metadata. Missing getters, oversized bodies,
hook conflicts and file failures remain visible and never qualify complete evidence.
The tool does not replace statuses or install standards on the game global.
It is diagnostic only, not a performance sample or an ordinary-publication pass.

### Retrieve a GL report when vConsole is unreadable

Use the optional loopback transfer when the actual phone has no usable console
evaluation or AppBrand CDP socket. Prepare a new private path and port on the ADB
machine, then start the standard-library receiver there. Both hashes come from
the diagnostic clone's `startup-diagnostic.json`, not from its modified entry:

```bash
python3 skills/forgeax-engine-wechat/scripts/receive_phone_gl_report.py \
  --port 19143 --path /forgeax-gl-link-UNIQUE_RUN \
  --out /private/new-phone-gl-report \
  --manifest-sha256 ORIGINAL_MANIFEST_SHA256 \
  --entry-sha256 ORIGINAL_ENTRY_SHA256 --deadline 180
```

Wait for its `listening` JSON. On that same machine inspect the selected device's
existing reverse mappings with `adb -s SERIAL reverse --list`, choose an unused
port, and install only the owned mapping:

```bash
adb -s SERIAL reverse --no-rebind tcp:19143 tcp:19143
```

Prepare the diagnostic clone with the existing build helper, adding
`--observe-gl-link --report-url http://127.0.0.1:19143/forgeax-gl-link-UNIQUE_RUN`.
Run official preview and confirm that exact diagnostic identity. The URL must
use `http://127.0.0.1:<port>/<explicit-path>`; path segments accept letters,
digits, underscore and dash. Queries, fragments, credentials, alternate hosts
and root-only paths are rejected. The helper does not install reverse mappings,
change request-domain settings, or open the phone automatically.

After hook cleanup and the native-file save attempt, the probe makes one
`wx.request` POST containing the exact serialized report, including original
manifest/entry identity and all retained sources. `X-Forgeax-Report-Bytes` and
`X-Forgeax-Report-Sha256` identify the complete UTF-8 body; the receiver verifies
them, the expected publication, every source digest/size and available-source
references before writing `report.json` (0600) in its new directory (0700).
It rejects bodies over 24 MiB without saving a partial report, binds only
127.0.0.1, accepts one submission at the fixed path, and exits by its deadline,
including when a request stalls. `result.json` records saved/rejected/timeout.

The report's in-memory `transfer` and `[forgeax.phone.gl-link.transfer]` record
`pending`, verified `sent`, `failed`, `timeout` or native-request `unavailable`.
HTTP error responses and mismatched acknowledgment hashes are failures. The
10-second native timeout plus an owned watchdog bound the single request; there
is no retry. Transfer failure preserves the retained report, native-file result,
raw GL return and original game exception. The saved/transmitted report is the
immutable snapshot before transfer, so its own byte hash cannot contain a later
acknowledgment. A receiver timeout alone does not identify which phone-side stage
failed. Keep native request-domain errors explicit if that transport is denied.

After checking the receiver receipt and copying the private evidence, remove
only this run's mapping with `adb -s SERIAL reverse --remove tcp:19143`.
Do not use `--remove-all` on a shared device. This is diagnostic export only;
the altered clone still does not qualify an ordinary publication.

This route was verified with native `wx.request` on Xiaomi / Android 16 /
WeChat 8.0.78 on 2026-10-12: official preview plus the owned ADB reverse delivered
one 36,074-byte report with SHA-256
`740f7da409463df05eb7f4f2e155e0ef477c809727caf0f9a6e5f1dcb6d57f8a`.
The receiver verified the original manifest/entry identities and two complete
GLSL sources (6,410 and 25,080 UTF-8 bytes); the owned reverse was removed after
collection. Its proactive `LINK_STATUS` was number `1`, both `COMPILE_STATUS`
values were boolean `true`, both logs were empty and the context was alive.
That first report predates consumer-query observation: it proves successful
native transfer and the proactive raw value, not the later Engine query. Use
the separate consumer record to establish that boundary before a host repair.

The second native run used the same original manifest/entry and byte-identical
GLSL, with consumer observation enabled. Its 36,661-byte report has SHA-256
`8cd2f6cde4e32ea0607e023f51bd508e36a53d44b0f1f36c338aabb7bd7aae23`.
`consumer-link-status` at `context: 1, link: 1` explicitly records
`{"type":"number","value":1}`. This confirms the actual subsequent native
query result as well as the proactive result; it does not qualify a repaired
Engine or successful game frame.

Both reports remain in the main workspace's private artifact archive (outside
the feature worktree), under
`artifacts/cross-platform-host-ui/design-resumed/phone-resumed-20261012/`:
`usb-report-received/report.json` is the proactive-only first stage;
`usb-consumer-query-01/report.json` is the actual-consumer confirmation. Verify
the byte counts and hashes above when reusing these local files. They are
diagnostic evidence, not assets to ship with a game or the public skill.

Validate changes to this collector without operating a phone:

```bash
node --test skills/forgeax-engine-wechat/scripts/test_phone_gl_link.mjs
python3 -m unittest discover -s skills/forgeax-engine-wechat/scripts -p 'test_*phone*py'
node skills/forgeax-engine-wechat/scripts/verify_phone_gl_link_browser.mjs \
  --out /private/new-gl-link-tool-check
```

The browser command uses sandboxed Chrome Beta and real WebGL2 to observe a valid
program followed by a deliberately mismatched varying. It verifies original
status, compile logs, shader hashes, hook restoration and the complete report
sent through a browser request adapter to the actual Python receiver. It does
not qualify native `wx.request`, the Engine UI pipeline, a simulator publication
or Android rendering.

A successful `auto_preview` can leave WeChat's main page in front. On this device,
opening the observed developer game from WeChat's recent Mini Programs restored
it without a user scan: verify the WeChat root, pull down the recent panel, identify
the intended developer game, tap its actual tile, then check the new AppBrand task.
Use the visible UI and current coordinates; do not invent private launch extras or
assume every AppBrand task contains the intended game. Retain the diagnostic marker
or actual runtime identity to establish which preview started.

On 2026-10-12, reconnecting the same observed serial and opening that developer
tile restored the same task without another preview. The native menu's
"Re-enter; native label U+91CD U+65B0 U+8FDB U+5165" restarted it, but vConsole remained blank, UIAutomator exposed only
one root node, and no AppBrand WebView CDP socket was available. An empty console
in that state is missing evidence, not absence of errors. Also inspect the
captured image: an incoming-call overlay can cover the game while its activity
still appears as the selected foreground. Dismiss or wait out that unrelated
overlay before accepting game screenshots.

## Actual phone evidence

Record the phone's model, OS/API, WeChat version, package identity and actual
startup result separately from simulator results. An authorized Android 16
Xiaomi device with WeChat 8.0.78 was observed on 2026-10-11; that discovery alone
does not qualify game rendering or input.

Once the game is visibly open, capture the device framebuffer with ADB
`exec-out screencap -p` into private artifacts. Verify the target is the game
before collecting screenshots or scoped logs. Keep original screenshots, compare
them to the authored flow, and apply the task's required human/parent image review.
Simulator screenshots and desktop QR images are not phone screenshots.

The reusable capture helper takes the **observed** resumed activity and the
selected device from discovery. It checks the foreground before and after the
capture, derives the activity's PID, preserves the original PNG and records its
actual orientation. The AppBrand component identifies the native container, not
which Mini Game is inside it: establish the intended game from the current preview
and visible screen first. `selectedManifestSha256` links the supplied publication;
it is not a runtime hash attestation.

```bash
python3 skills/forgeax-engine-wechat/scripts/android_game_capture.py \
  --config /private/wechat-machine.json \
  --adb /absolute/path/on/connected-machine/platform-tools/adb \
  --serial DEVICE_SERIAL \
  --activity com.tencent.mm/.plugin.appbrand.ui.AppBrandUI1 \
  --manifest /private/verified-package/forgeax-dist.json \
  --out /private/run/phone-ready
```

For logs, add `--since 'MM-DD HH:MM:SS.mmm'` using the phone clock at this run's
start, and optionally `--log-lines 500`. The helper reads only that activity's
current PID and retains a bounded tail in private `game-process.log`; no logs are
collected without `--since`. A PID or activity change starts a separate evidence
segment. It never clears system logs, starts apps or sends input.

The helper resolves the process from the exact resumed ActivityRecord, Android user,
component and task's own Hist record, and compares that full identity again after
capture and logs. `dumpsys activity top` omitted this active game on the observed
Android 16 phone and is not its PID authority. The complete helper was validated
on that phone on 2026-10-11: a 3200 x 1440 PNG and current-process logs were captured
while the game remained on its loading screen. This qualifies capture only.
Its serial is kept in the private receipt and omitted from the printed summary.
Use `--for-input` for the stronger preparation described below; ordinary capture
does not qualify a target for input.

## Resume the phone journey

Use coordinates from the actual phone screenshot, whose landscape width/height
can be the reverse of `adb shell wm size`. Do not reuse simulator coordinates.

Prepare with `android_game_capture.py --for-input` using the same arguments as
the capture example and a new `--out` directory. This mode requires an unlocked,
focused game, and binds the PNG to the exact serial, activity/PID and active
default-display viewport/rotation. Read its `result.json` and review `screen.png`
before choosing coordinates. A previous receipt without `displayId`/`rotation`
must be replaced by a fresh input-prepared capture; width and height alone cannot
detect a 180-degree rotation. A capture's manifest is a supplied publication
identity, so continue to establish the actual game from its visible/current run.

Before each input, inspect `dumpsys window` (`mCurrentFocus`, `mFocusedApp`,
`mTopFocusedDisplayId`) and the resumed activities per display from
`dumpsys activity activities`. A check only at the beginning of a batch can go
stale. The observed phone briefly exposed both WeChat and another app as resumed;
selecting the first line would have hidden that ambiguity. If the actual focused
app is outside the intended Mini Game, stop input and preview/reopening attempts
until device availability is established. Preserve the original `host-hidden`
result instead of attributing an interrupted run to an Engine failure.

The [single-action helper](../scripts/android_game_input.py) performs those checks
through the capture helper's same ActivityRecord/Hist/PID parser before **each**
tap, swipe or named editing key. It requires the current serial, identity, focus,
default display, rotation and dimensions to match the prepared capture. Unknown
dump formats, ambiguous resumed activities and missing lock state fail before
input; preserve the result rather than bypassing the guard. These observations
narrow the check/input race but are not an atomic device lease. Stop whenever
another session/user takes the phone; the script does not acquire ownership.
The reusable helper's regression tests are offline; extracting a previously used
guarded-input recipe does not qualify the new wrapper on every Android dump format.
Retain the first native run's actual receipt and result when using it on a phone.

For native keyboard editing, first tap the original field and confirm the
keyboard and current value in a fresh screenshot, then replace text and use the
observed Done control. A keyboard may appear asynchronously or move; its old
collapse coordinates can instead hit the Mini Game's native close capsule.
In the qualified game-3d journey, Done submitted the original form and regenerated
the vase, so do not assume it only dismisses the editor. Read the resulting
accepted state, then close the panel through its own button and check that game
controls return. See [parameter interaction receipts](#parameter-interaction-receipts)
for the numeric proof.

Qualify numeric characters with actual taps on the visible IME keys. On Android 16,
`wx.showKeyboard({ keyboardType: 'number' })` created a WeChat editor with
`inputType=0x2` and filtered decimal points and signs: `3` → `.` → `5` became `35`,
`.75` became `75`, and `-` left an empty value, despite visible `.` and `-` keys.
The Engine therefore requests `'text'` for HTML number controls and leaves numeric
validation to HTML. Whole-string callback injection or `adb input text` cannot
qualify the physical keyboard path. Read only the current WeChat editor's
`dumpsys input_method` attributes when native filtering needs diagnosis.
Distinguish a keyboard layout with no visible decimal/minus key from a present
key whose character is filtered. For the latter, retain the before value, actual
key tap, after value and editor input type; a successful injected string is not
that control. The later text-mode phone journey accepted Height `3.5` from native
IME taps and regenerated the vase. It did not qualify negative entry or every
IME layout, so retain those as separate untested paths.

The white Mini Game input bar and a floating IME are separate native surfaces.
The documented `showKeyboard` API has no input rectangle or `adjustPosition`, and
keyboard-height events do not provide floating bounds. An authorized one-time
expand/restore comparison moved the bar with the IME height; returning to floating
mode retained the expanded bar height. Preserve both screenshots, restore the
original mode, and report the host layout limitation separately from character
entry. Changing the user's keyboard mode is not an Engine layout fix.

For one authorized action, run from the controller (omit `--config` for local ADB):

```bash
python3 skills/forgeax-engine-wechat/scripts/android_game_input.py \
  --config /private/wechat-machine.json \
  --adb /absolute/path/on/connected-machine/platform-tools/adb \
  --serial DEVICE_SERIAL \
  --capture-result /private/run/phone-input-ready/result.json \
  --out /private/run/one-tap tap X Y
```

Replace the final action with `swipe X Y END_X END_Y --duration-ms 800` or
`keyevent DEL` when editing the reviewed native field. A zero-distance swipe can
hold one button; durations are bounded to 1–5000 ms. The key allowlist also includes
FORWARD_DEL, MOVE_HOME, MOVE_END, DPAD_LEFT, DPAD_RIGHT and ENTER; ENTER can submit
the form. The helper accepts no text injection, arbitrary keycodes, shell string,
unlock/login operation or action batch. Reacquire/review a capture after layout,
keyboard, orientation or task changes instead of reusing stale coordinates.

Each new `--out` receives a private, bounded action receipt. `dispatched` means the
native command returned, not that a control changed or a frame completed. Input
failure/timeout records that execution may have occurred and never retries;
inspect the phone before another command. Device serial stays in the private
receipt, not stdout/public evidence. Capture the actual game consequence separately.
The sequential ADB/dumpsys round trips make this a sparse control tool, unsuitable
for driving 60 Hz gestures or measuring input latency. Use the already qualified
browser/official/scrcpy input path for a continuous test, with its own observation.

A swipe ends with release, so it cannot prove `touchcancel` or simultaneous contacts.
Use the [official scrcpy control-only route](android-multitouch.md) to prepare
independent native contacts. Its connection handshake has been qualified; actual
gameplay still needs the observations below. ADB input remains useful for single
contact operations.

| Phone operation | Required observation |
|:--|:--|
| Startup | Loading page advances to the ordinary scene/HUD; collect actual device completion/failure receipts if available. |
| Move, then release | Real player translation while held; movement and walking state cease after release. |
| Look | Camera yaw/pitch changes without injecting translation; release stops look updates. |
| Jump | The real physics body leaves the floor and returns, with no repeated jump from a released contact. |
| Run plus movement | Hold both with actual separate contacts; compare displacement over the same duration, then release Run while movement continues. A standalone Run hold only checks its contact lifetime. |
| Cancel | Interrupt a held gesture through the native lifecycle or a validated native cancel event; verify no retained movement/look/run/jump. An ordinary release is a separate result. |
| Editor and keyboard | A real tap opens the form, resets gameplay contacts and hides the controls; native keyboard editing and Generate update the same vase identity. |
| Hide/show | Use normal Home/app switching, then reopen the same preview. Distinguish a retained realm from a fresh bootstrap; neither may replay old input. Do not use force-stop as a hide test. |
| Resize/orientation | Follow the game's declared orientation; verify control placement and reset after an actual resize. A fixed-landscape declaration does not qualify portrait rendering. |
| Reload | Capture the new generation and fresh startup result; no old contacts or unresolved failures cross the transition. |

Keep screenshots and scoped logs under separate operation directories. Send every
functional screenshot to the required reviewer and maintain the complete list;
an unreviewed capture is still an artifact, not an accepted visual result.

Exercise the ordinary [mobile controls](mobile-game.md), native keyboard,
generation/recovery and lifecycle paths actually required by the task. Preserve
runtime completion receipts and structured failures when the official device
debugging context exposes them. The simulator's evaluation context cannot
silently stand in for phone receipts. Report unobserved counters or unavailable
debugging explicitly; a picture alone proves only the visible frame.

## Restore the ordinary package and retire owned tools

After diagnostic collection, retain the original report and its exact instrumented
entry hash. Restore the matched ordinary publication through official preview and
confirm its visible run; removing a report file does not remove a diagnostic prefix.
If the phone is gone or ownership changed, record restoration as pending without
reopening it. A normal-package check and the earlier instrumented check are separate.

Retire only this run's observers, collector listener, exact ADB reverse/forward
mapping and scrcpy SCID/JAR. Preserve another session's sockets, foreground and
processes; no blanket `kill-server`, force-stop or `forward --remove-all`. For the
Mac simulator, close only the window tied to this run's `newopen` receipt and verify
its `winId`. If an existing project window has no owned receipt, report the
simulator unavailable for this run instead of opening a second one or taking it over.
