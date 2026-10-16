# WeChat platform

The Platform and packaged WASM Host share one native clock adapter. It converts
`wx.getPerformance().now()` from device microseconds to milliseconds, preserves
the qualified DevTools millisecond unit, and rejects non-finite or regressing
samples. `createWechatWasmHost().now()` passes that explicit clock to native
physics without creating a browser `performance` global. Its lifetime belongs
to the WASM Host, so replacing a Platform instance does not invalidate the
realm-local physics module's clock.

## Bootstrap standards and published text

Load `@forgeax/engine/platform-wechat/standards` in the generated bootstrap and call
`installWechatStandards()` before the game module. Missing `TextEncoder` and
`TextDecoder` are supplied by exact-pinned `@exodus/bytes`, bundled through the
package's neutral build so its browser shortcuts cannot require absent native
encoders. UTF-8 streaming, fatal errors, BOM handling and bounded `encodeInto`
retain standard semantics, including replacement of malformed Unicode.
Missing `structuredClone` is supplied by exact-pinned `core-js-pure`; existing
native implementations are preserved. Cycles, typed-view buffer identity, numeric values and Map/Set retain
standard clone semantics. Unsupported transfer primitives fail instead of pretending
to detach. The installation belongs to the realm and survives individual App disposal.
The same existing dependency supplies missing `URL` and `URLSearchParams` before
ordinary RuntimePack/Catalog consumers resolve generated package and artifact paths.
Relative paths, percent encoding and live query parameters retain WHATWG semantics;
an available native constructor keeps its identity.

`createWechatTextReader(wx)` adapts native UTF-8 file reads to owner text contracts,
including `BundlerOptions.readShaderManifest`. It preserves native read failures and
rejects a non-text result. The build owner supplies the packaged path; loading a
subpackage precedes any read from it.

## Packaged native graphics initialization

`createWechatWgpuHost(source, path, surfaces)` implements the native contract owned
by `wgpu-wasm/native-host`. `source` provides actual wx filesystem operations and
WXWebAssembly; `path` is an immutable package-relative `.wasm` or `.wasm.br` path.
For Brotli, `readCompressedFile` supplies decompressed integrity bytes while
WXWebAssembly instantiates the exact compressed path. The adapter refuses this
mode when the native decompressed reader is absent. The same path
feeds integrity reads and native instantiation. Declare/load any containing
subpackage before initialization. The generated binding validates bytes and
native context identity. No browser constructor or WebAssembly global is installed.

At this platform's WASM import boundary, `getProgramParameter(..., LINK_STATUS)`
normalizes exact numeric `0`/`1` to boolean `false`/`true`. An observed Android
host returned numeric `1` to the actual Engine consumer, while WebGL and Glow
require a boolean. Original booleans, other values, other queries and native
exceptions are preserved; the canvas, context and their methods remain untouched.
The same boundary advances `getSyncParameter(..., SYNC_STATUS)` observation with
one native `clientWaitSync(sync, 0, 0)` only when the original query returns
`UNSIGNALED`. Exact `ALREADY_SIGNALED` or `CONDITION_SATISFIED` results become
`SIGNALED`; timeout, failure and unknown values retain the original query result.
The wait never blocks or adds a fence. Other parameters, already completed queries
and original native exceptions retain their behavior. This adapts the admitted
WASM import without replacing a context method or browser global. Phone observations
showed persistent wgpu fence accumulation and retirement progressing during bounded
nonblocking-wait probes; this candidate still requires the same-phone A/B run to
qualify long-running game stability.

The [generated-binding regression](src/__tests__/webgl-status-consumer.test.ts)
checks the real imports, wasm-bindgen's strict boolean conversion, delayed fence
status refresh, completion enums and preservation of unrelated values and failures.

Generate the binding through `wgpu-wasm/native-build`; do not edit wasm-bindgen
output in game code. Simulator initialization, native fence completion and pixels
have been exercised. This boundary alone does not qualify full game/asset/UI boot.
The [WASM consumer regression](src/__tests__/wasm-consumer.test.ts) drives actual
Blitz initialization through disk-backed compressed reads, rejects damaged/partial
files, and keeps shared initialization usable after one consumer cancels.

Native Mini Game host binding for [Platform](../platform/README.md). This package
provides the clock, display, native frame and lifecycle seam; it does not establish
complete Engine/RHI/UI or phone support.

## Execution scope

The generated ordinary game runs App, World and Renderer in the main game realm.
Official-simulator scene/UI presentation and the observed native input operations
are separate from target-device qualification.

| Capability | Current scope |
| --- | --- |
| Main game realm | Native canvas, clock, frame/lifecycle facts, packaged resources, touch and whole-string keyboard adapters |
| Workers and other realms | No WeChat Worker, Worker V2 or open-data-domain transport/entry; the same-realm message fallback below does not supply them |
| Multiplayer transport | Task-local `wx.connectSocket` implements the existing NetEndpointConnector with bounded binary queues; socket mechanics retain NetSession ownership of recovery |
| Audio | Lazy `wx.createWebAudioContext` binding reuses the existing Web Audio graph for decoded clip bytes; simulator decode/play/control/disposal verified, streamed PCM transport and phones remain separate qualification |
| Remote resources and persistence | Explicit HTTPS PackageFetcher, native download cancellation, optional bounded publication-scoped disk cache and restart recovery; CDN permissions and phone behavior need target qualification |
| Phones and lifecycle matrix | Separate Android/iOS, orientation, background/foreground and mode qualification remains required; simulator success does not cover it |

```ts
import { createWechatPlatform } from '@forgeax/engine/platform-wechat';
const platform = createWechatPlatform({
  wx,
  requestAnimationFrame: callback => requestAnimationFrame(callback),
  cancelAnimationFrame,
}).unwrap();
```

Call before creating auxiliary canvases, or pass the already-owned main native canvas
as the second argument. Canvas identity is retained without a DOM constructor check.
The narrow consumed native shape is defined in [native.ts](src/native.ts).

| Boundary | Behavior |
|:--|:--|
| Clock | Official device microseconds normalized to Engine milliseconds; explicitly identified DevTools uses its measured millisecond contract |
| Display | Window/safe-area/DPR plus actual canvas drawing dimensions, validated before subscriptions |
| Frame | Native opaque request/cancel tokens and late-callback fencing; synchronous callbacks are rejected |
| Lifecycle | Native show/hide/resize/orientation; memory warning when both subscribe/unsubscribe exist |
| Failure | Original native cause, reverse startup rollback and all-resource teardown |
| Subscribers | Independent leases; one throwing observer cannot suppress delivery to later live subscribers |
| Input | `createWechatInputBackend(wx, platform)` implements the existing InputBackend; native down/move/up/cancel events retain contact identity and frame edges |

Window resize and device orientation notifications share the same validated
`getWindowInfo()` projection. A successful native orientation change can emit
`onDeviceOrientationChange` without `onWindowResize`; subscribers must still receive
the new logical dimensions, DPR and safe area. Actual drawing dimensions remain the
borrowed canvas's measured values. The generated Host consumes the existing display
event to resize its canvas and UI; the Platform does not rewrite the canvas or derive
dimensions from the orientation label. Both native subscriptions participate in the
same startup rollback and disposal, including late-event fencing.

The input adapter borrows its Platform and owns native touch listener leases. Logical
touch coordinates map to actual drawing-buffer pixels, independently of DPR. It
clears acquisition on visibility/display changes and `setInputAllowed(false)`;
revoked contacts cannot re-enter on stale move/up events. `detach()` fences late
callbacks and releases every listener once. Native touch does not synthesize gameplay mouse buttons, pointer lock or gamepad support.
Pass `{ ui: blitzUi.input, keyboard: wx, onError }` to `createWechatInputBackend`
to route UI input before gameplay acquisition. UI focus/contacts revoke previous
gameplay contacts; the independent `setInputAllowed` startup policy never disables
UI controls. Logical coordinates feed UI hit testing while drawing coordinates feed
gameplay. Hide, resize and detach cancel UI contacts and the current editor.
Gameplay contacts are revoked before UI cancellation runs. A failing UI cancel
still leaves no held gameplay input, and detach attempts every native release
while retaining cleanup failures.
Keyboard retirement fences old callbacks before releasing listeners. If a native
unsubscribe fails, it still attempts to hide the keyboard; detach likewise releases
the focus, edit-request and native editor leases before reporting cleanup failures.

Native memory warnings reach the ordinary local App's existing AssetRegistry,
which releases completed raw artifact reads without cancelling pending loads or
retiring adopted resources. Audio publication caches and Pack metadata retain
their existing ownership; disk-cache deletion is not a response to RAM pressure.

The optional native keyboard opens only on an accepted input or associated-label
tap through `subscribeTextEdit`; programmatic focus and constraint validation do
not open it. Input supplies whole string replacements, confirmation runs the
document's form default, and completion commits a pending change and closes the
native edit session while retaining DOM focus and invalid feedback. Another tap
can reopen the same focused control. Focus changes, disabled or detached editors
retire the lease; late callbacks cannot edit the next focused control. Native
failures retain their cause through `onError`. The native provider
reports neither selection ranges nor IME composition phases; Chinese strings can
be delivered, but selection/composition behavior is not claimed. HTML's absent
`maxlength` (`-1`) maps to the finite signed-32-bit maximum, `2147483647`; explicit
nonnegative limits remain unchanged. Mini Game's [keyboard contract](https://developers.weixin.qq.com/minigame/dev/api/device/keyboard/wx.showKeyboard.html)
does not define the HTML sentinel, and passing it emptied the initial value in the
qualified simulator. An unchanged completion preserves the value; a real empty edit
still clears it. All editors request `keyboardType: 'text'`, including HTML number
controls, so decimal points, signs and exponent text reach HTML validation intact.
On the qualified Android 16 phone, WeChat's `'number'` editor reported
`inputType=0x2` (integer-only): real taps entered `3.5` as `35`, `.75` as `75`,
and rejected `-`, although the IME displayed those keys. A visible key or an
injected whole-string callback does not prove that native editing accepts it.

The native input bar and keyboard placement belong to WeChat. Mini Game's
`showKeyboard` exposes no input rectangle, input-bar visibility, or
`adjustPosition` option. Its [height event](https://developers.weixin.qq.com/minigame/dev/api/device/keyboard/wx.onKeyboardHeightChange.html)
reports only a height, not the bounds of a floating keyboard. The adapter does not
infer a covered rectangle or move the game UI from that value. `adjust-position`
and `cursor-spacing` belong to the separate Mini Program `input` component.
See [keyboard contracts](src/__tests__/keyboard.test.ts), the
[real-WASM form journey](src/__tests__/keyboard-wasm.test.ts), and
[input contracts](src/__tests__/input.test.ts).

[Unit contracts](src/__tests__/platform.test.ts) test partial initialization,
cancellation, listener failure, display and disposal. The
[native host probe](__tests__/native-host-probe.ts) is a simulator fixture: its 2D
pixels and callback counts are explicitly not Renderer/game acceptance evidence.
The fixture also runs the real World/InputFrameStartScan path and logs normalized
input events. Its ongoing host loop keeps input observable after the 120-callback
checkpoint; that checkpoint remains distinct from Renderer completion.
Use [forgeax-engine-wechat](../../skills/forgeax-engine-wechat/SKILL.md) for official
tooling, login and full representative-game verification requirements.

## Native multiplayer transport

`createWechatSocketConnector(wx, url, options?)` creates the existing
[`NetEndpointConnector`](../net/README.md) over native
[`SocketTask`](https://developers.weixin.qq.com/minigame/dev/api/network/websocket/SocketTask.html).
It uses task-local callbacks; it installs no browser WebSocket global and owns no
session, reconnect timer, ACK ledger or gameplay protocol.

```ts
import { createWechatSocketConnector } from '@forgeax/engine/platform-wechat';

const connector = createWechatSocketConnector(wx, 'wss://game.example/socket');
const result = await connector.connect(abortSignal);
if (!result.ok) throw result.error;
const endpoint = result.value; // Pass to the existing NetSession owner.
```

`header` and `protocols` forward native connection options. The host enforces its
configured server domains and concurrent socket limit. Aborting a pending attempt
closes its task, fences callbacks and closes any late open; an accepted endpoint
outlives that attempt's signal. Each replacement receives a new transport `PeerId`.
Visibility does not independently retire or reconnect the session: the game/Session
owner chooses that policy using ordinary Platform lifecycle observations.

Incoming binary messages preserve order and owned bytes. Sending copies exactly the
provided `Uint8Array` view, so later caller mutation cannot alter an in-flight frame.
Text messages and incoming overflow fail the attachment explicitly, retaining
accepted events followed by one `peer-disconnected`. `maxQueuedEvents` defaults to
1024 and bounds both unpolled events and, independently, pending native sends;
`maxQueuedBytes` and `maxBufferedBytes` each default to 8 MiB. Outgoing backpressure
returns `send-failed` without closing, allowing retry after native completions.

`disconnect(peerId)` retires that attachment, queues one terminal event and closes
its SocketTask without affecting another endpoint or its listener. An unknown
peer returns `peer-not-found`; an already disconnected peer returns
`connection-closed`. Accepted incoming events precede the terminal event and late
native callbacks cannot publish further messages.

`send()` success means the native API accepted the request. A later native failure
closes the attachment and queues its disconnect; the next `send()` retains the
structured error and original native `errMsg`. Synchronous failures return that
error immediately. Local `close()` clears queued payloads and rejects later work;
repeated close returns `already-closed`, including a native close failure if one
arrived. Task callbacks have no documented `off` API, so closed attachments fence
late events and callbacks without registering global socket listeners.

The [network contracts](src/__tests__/network.test.ts) cover native callbacks,
cancellation, failure, queue bounds and a real local binary socket journey with two
attachments. That local journey supplies the SocketTask call shape around a real
socket; official-simulator and phone behavior require their own native observation.

## Realm standards

Call `installWechatStandards()` from the explicit `/standards` entry before
loading consumers that require TextEncoder/TextDecoder, URL/URLSearchParams, structuredClone, DOMException, Event/EventTarget
or AbortController/AbortSignal. Installation preserves existing native identities,
rejects an incomplete native controller/signal pair, and rolls back partial
installation. These globals belong to the realm and outlive individual Apps.
The cancellation fallback retains reasons, synchronous dependent abort propagation,
timeouts and idempotent cancellation. Background active-time timeout behavior and
cross-realm native signal composition are not yet qualified.

## Packaged Catalog and binary assets

`createWechatPackageFetcher(wx, { root, baseUrl })` maps one published URL namespace
to package files. It uses native binary reads, checks cancellation through response adoption,
rejects writes and escaped/outside paths, and preserves native failures. The
producer chooses `root` and `baseUrl`; load the containing subpackage first.
Remote download/cache support is a separate owner and is not implied by this reader.

The generated WeChat target uses the same reader for Blitz companion resources.
It publishes the exact Noto Sans SC stylesheet, WOFF2 files and OFL license, seeds
the Latin fallback, and passes the published URL root into Blitz before parsing.
CSS/font/image requests retain native file errors and disposal cancellation; UI
JavaScript does not scan or rewrite author CSS URLs. See [Blitz resources](../ui-blitz/README.md#published-fonts-and-companion-resources).

The regression suite loads a producer-generated binary Mesh through the ordinary
Catalog/AssetRegistry with Fetch, Request, Response, Headers and WebCrypto absent.
It rejects same-size corrupt and truncated bytes, then reloads repaired files through
the same Registry, for both plain and Brotli packages. This proves the native resource boundary;
it does not establish complete game or UI startup in a device.

## Remote publications and disposable disk cache

`createWechatRemotePackageFetcher(wx, options)` returns `{ fetch, dispose }`.
Pass `fetch` to the existing Catalog/Registry or UI resource reader. `baseUrl`
selects one HTTPS directory; credentials, query/fragment URLs, escaped paths and
non-GET requests are rejected before native work. Configure its download domain
in the WeChat project. Native download failures preserve their cause, and HTTP
failure status remains a failed response even when `wx.downloadFile` calls success.
The native download timeout defaults to 30 seconds and is configurable.

Required `directory` selects a dedicated child of `wx.env.USER_DATA_PATH`, even
when caching is disabled. Every `wx.downloadFile` receives an explicit owned
`filePath`; the returned destination is validated, read and removed. WeChat-managed
temporary paths are not deletable application files. Existing directories are
opened before creation because native recursive `mkdir` rejects existing paths.

Optional `cache` requires the producer's immutable `publicationDigest` and
`maxBytes`. The Host owns one reader per directory and disposes it through its
existing lifecycle. Cache keys
derive from the publication digest and resolved URL. GUIDs, Pack publication
adoption and asset integrity remain with Catalog/AssetRegistry.

| Disk operation | Behavior |
|:--|:--|
| Store | Owned body bytes plus SHA-256 checksum, staged write and rename; no parallel GUID index |
| Restart | Rebuild the disposable file inventory, delete interrupted staging files and enforce the byte budget |
| Read | Verify stored length/checksum; discard corrupt copies and download again |
| Capacity | Evict least recently read files in the current Host; restart orders by native modification time; oversized responses remain uncached |
| Active resources | Responses own copied bytes; deleting a cache file does not retire adopted resources or invalidate an outstanding response |
| Recovery | `{ cache: 'reload' }` bypasses and replaces the cached copy after producer repair; `{ cache: 'no-store' }` bypasses both read and write |

The required nonthrowing `onError` callback receives recoverable cache failures
and late native cleanup failures. Valid downloaded bytes remain usable after
cache quota/write failure. The cache checksum detects storage corruption; it
does not replace the producer's artifact digest. An upstream response that fails
Catalog validation requires producer repair and `reload`, or a new publication.

Caller cancellation promptly rejects the request, aborts an active download and
prevents later adoption. Native filesystem calls have no cancellation API: an
already-started file operation and the download's terminal callback drain before
`dispose()` releases the directory lease.
Disposal is idempotent, rejects new reads, and cleans temporary download files.
It does not erase completed cache files. Native callbacks must complete; a host
that never calls a terminal callback remains an unresolved host failure.

The [resource regression](src/__tests__/remote-fetch.test.ts) uses actual disk
files and the ordinary produced Mesh/Catalog path with browser Fetch/WebCrypto
removed. It covers tampering, restart, eviction, quota failure, cancellation and
late callbacks. These deterministic results do not establish CDN permissions,
background downloads or filesystem behavior on Android/iOS.

## Native audio

`createWechatAudioBackend(wx, platform, { onError })` returns the existing
`AudioBackend`. The generated ordinary WeChat Host installs it through
`audioBackendPlugin(audio)` and `audioPlugin()`, then destroys it after App
retirement. Custom Hosts use that same composition and lifecycle.

No native Context or audio subscriptions are created until a clip, listener or
other audio operation needs native nodes. The platform binding owns the Context,
touch-resume, visibility and available interruption subscriptions; the existing
[Web Audio owner](../audio-webaudio/README.md) owns decoding, cache, buses and
source/panner/gain nodes. Destroy removes subscriptions, retires those owners and
closes the native Context. Native failures preserve their cause through `onError`;
pending transitions are fenced after disposal. A failed resume can be retried by
a later native touch, while `AudioState.lastError` retains its diagnostic history.

The native Context must expose the consumed Web Audio methods and modern
AudioParam listener coordinates. Missing methods, legacy numeric listener
coordinates and incomplete interruption subscription pairs fail at first demand
with `context-creation-failed`; a silent game does not fail eager audio startup.
This is a native Context binding, with no browser AudioContext global or
InnerAudio substitution.

On the official simulator, ordinary WAV bytes decoded to 48,000 mono frames at
48 kHz, reused one decode across two plays, projected a spatial panner, and passed
pause/seek/playback-rate controls. Injected Host visibility and interruption events
exercised the real native suspend/resume methods. Destroy left the actual native
Context closed and retained no subscriptions, active sources, cached bytes or
pending plays. Browser regressions separately retain native spatial PCM checks.
These results do not qualify audible device output, physical background events,
phone codecs or Android/iOS lifecycle behavior. Streamed PCM still requires the
audio owner's HTTP Range/streaming-body/digest transport and is not qualified by
the complete-byte PackageFetcher or this native binding.

## Same-realm message channels

When both native `MessageChannel` and `MessagePort` are absent,
`installWechatStandards` supplies the standard same-realm pair plus a missing
`MessageEvent`. The ordinary Host/UI protocol uses these ports directly. Posting
clones synchronously, delivery uses asynchronous FIFO tasks, `start()` enables the
queue, assigning `onmessage` starts it, and `close()` cancels pending receiving
work. Native constructors are retained; an incomplete native pair is rejected.

This fallback does not support transferring buffers/ports or crossing Workers and
realms. A nonempty transfer list throws `DataCloneError` without detaching the
caller's data. It is a reusable host standard, not a second game protocol. The
native Worker/Host transport must provide cross-realm delivery separately.
