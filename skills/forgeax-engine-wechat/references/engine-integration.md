# Engine integration decisions

Read the actual owner contracts and exported types before writing a consumer. The
platform foundation is distinct from a qualified complete WeChat game target. This
reference gives implementation and diagnosis routes; it does not declare all of the
following capabilities implemented.

| Concern | Authority and invariant |
|:--|:--|
| Host facts | `packages/platform`, `platform-browser`, `platform-wechat`: monotonic milliseconds, native callback/cancel, display and lifecycle |
| Game execution | [App](../../../packages/app/README.md) owns pacing/backpressure; World owns game time; platform callbacks do not count completed frames |
| Graphics | [Runtime](../../../packages/runtime/README.md) assembles the existing RHI; use actual native canvas/context and device capabilities |
| Input | [Input](../../../packages/input/README.md) freezes one frame-start snapshot; map native touches into that owner |
| Resources | [Assets](../../forgeax-engine-assets/SKILL.md) routes GUID/Catalog/publication and producer-owned recovery |
| WASM | Each module owner keeps its generated glue, imports, provenance and retry semantics |
| Build and SDK | [SDK](../../forgeax-engine-sdk/SKILL.md) routes ordinary public project/source closure; DevKit owns target generation |
| UI | [UI](../../../packages/ui/README.md) owns UiAsset/mount; browser DOM is the reference for portable HTML/CSS/TS behavior |

For startup failures, distinguish [publication reads](#publication-capture-and-resident-bytes),
[canonical sky admission](#canonical-environment-source-closure),
[scene readiness](#separate-graphics-readiness-from-scene-admission) and
[missing runtime globals](#native-runtime-import-restrictions). Once the scene is
admitted, unexplained wrong pixels go to [native RHI capture](#capturing-native-rendering-failures).

## Clock and display

The official Mini Game `Performance.now()` contract is **microseconds**. Normalize
once at the wx platform boundary; Engine host time is finite monotonic milliseconds
and World consumes seconds. The qualified DevTools game runtime reports milliseconds:
use its explicit `getDeviceInfo().platform === "devtools"` fact for that adapter
branch, and retain independent target measurements. Do not fall back to wall time or infer the unit from
sample magnitude. Preserve invalid/backward clock errors and test actual native
observations against elapsed time in the target simulator/device.

Retain the main canvas identity from native creation. Canvas count is not display
identity. Logical window size, safe area, DPR and actual drawing buffer dimensions
are separate facts. Retain opaque native frame handles without numeric coercion (DevTools can return an
object token). Test cancellation including ID zero, late callbacks, hide/show,
resize, subscriber disposal and partial startup failure. A borrowed platform outlives
an App; App releases only its leases. Native teardown must attempt all acquired
resources and retain original failures.

`createWechatInputBackend(wx, platform)` supplies native touch samples through the
existing InputBackend contract. Use it with the normal input plugin/frame-start scan.
Coordinates map from native logical pixels to measured drawing-buffer dimensions;
using DPR alone fails when the rendering resolution differs. Verify short down/up
sequences between scans and stale move/up after hide, resize or UI revocation. The
current gameplay adapter advertises touch only. UI editors use the
[native string keyboard provider](../../../packages/platform-wechat/README.md),
which has no selection-range or IME-composition events. Gestures, virtual joysticks
and physical editing require their own implementation or qualification.

## WeChat graphics and WASM

The design's present baseline is the existing wgpu WASM/WebGL2 path. Do not assume
`wgpu` means native WebGPU or select a backend merely because `navigator.gpu` exists.
Qualify actual context/device acquisition, extensions, limits, formats, submission,
pixels and completion. Compute/storage/indirect capability remains with RHI and
algorithm owners; do not add a separate WeChat renderer to evade a missing feature.

wx path-based WASM loading needs an explicit seam in each generated module owner.
Keep wasm-bindgen/Emscripten/Rapier protocols intact, resolve the emitted file from
the producer's inventory, and check WASM/glue/provenance identity. Global WebAssembly
interception, fabricated WebGL constructors or a fake full browser DOM are not the
production bridge. Preserve native standard objects where their semantics qualify.
Unknown modules, corrupt bytes and transient reads need distinct recoverable errors.

## Resources, UI and native services

`@forgeax/engine-wgpu-wasm/native-build` exports the build-only `buildNativeWgpu`
producer. It verifies the published canonical WASM/glue receipt, replaces only the
browser initialization tail, and records the native generator/glue identities.
The generated binding's `initializeNativeWgpu` accepts the owner-defined native
host contract. `createWechatWgpuHost` binds packaged byte reads and
`WXWebAssembly.instantiate` to the same immutable relative path. Load its declared
subpackage first. The initializer checks SHA-256, admits exact native Canvas and
WebGL2 context identities, shares initialization for the same host, and refuses
host replacement. A WASM start failure requires a fresh realm; a pre-start read
failure can retry. It never installs fake browser constructors.

`createWechatWasmHost` accepts an explicit `.wasm.br` path. It obtains decompressed
bytes with `readCompressedFile({ compressionAlgorithm: 'br' })` for the domain's
integrity check, then instantiates the same compressed package path through
`WXWebAssembly`. A missing decompressed reader is an unavailable capability, not
permission to skip digest verification. Glue and provenance still describe the
uncompressed WASM identity; compressed transport bytes have their own build inventory.

`createWechatPackageFetcher` with `{ root, baseUrl, encoding: 'br' }` maps a logical
publication URL to `<root>/<relative-path>.br` and returns decompressed bytes through
the existing PackageResponse. Asset digests and byte lengths remain producer facts.
Shader text uses that same fetcher followed by `.text()`. Cancellation fences late
native callbacks, and corrupt compressed bytes retain their native failure.

The wgpu RHI queue completes through the native wgpu queue callback and a bounded
JavaScript polling driver. Keep synchronous native polls on a catchable JS stack:
a WASM trap during a Rust async task can otherwise leave its Promise pending.
Completion requests share ordering for the same native queue; prior buffer-map
callbacks must become observable before queue completion. A separate raw GL fence
can signal while wgpu's internal submission resources remain retained, so it is
not a substitute for this callback. Missing completion primitives reject.

The WeChat host adapts an unsignaled `SYNC_STATUS` query by making a zero-time
`clientWaitSync(sync, 0, 0)` and reading status again. It reports completion only
for native signaled/satisfied results; timeout or failure cannot become success.
This addresses observed native-host progress behavior without blocking the CPU
or changing generic browser WebGL. See
[fence and resource diagnosis](android-device.md#native-fence-retirement-and-resource-growth)
for the limits of same-call and long-run observations.

Package/subpackage/remote/cache reads feed the existing resource pipeline. Preserve
HTTP non-success status even when a native success callback fires. Cancellation,
publication generation, digest mismatch and partial-file recovery cannot be hidden
by a cache hit. Fonts and images referenced by UI must be in the same publication
closure, with author source bases and declared reachable references.

Portable UI uses the same HTML/CSS/TS as browser UI. Qualify the selected Blitz
maintenance revision, dependencies, ABI, paint backend and actual full game-3d UI;
a static raster or alternate simplified form cannot establish that contract. Any
cross-WASM pixel buffer crossing needs explicit ownership, stride, alpha/color and
copy/upload lifetime. Startup/fatal UI must survive 3D failure without introducing a
second frame owner. See [Verification](verification.md) before declaring adoption.

Native audio, network and keyboard adapters implement their domain contracts.
The generated Host composes the lazy native AudioBackend with the existing audio
plugins and destroys it after App retirement; see [native services](native-services.md)
for Context requirements and qualified decode/control paths. Platform sockets do not
own NetSession reconnect/ACK policy. Clear touches on hide/cancel, fence stale async
results after stop/rebuild, and verify UI focus prevents gameplay input leakage.
Worker and open-data realms qualify independently; unqualified automatic policy
uses the known local path and explicit unsupported requests return structured errors.

### Publication capture and resident bytes

If ordinary runtime activation stalls while retaining an asset closure, inspect
`captureAssetPublication` and the package read trace before increasing the startup
timeout. The [Assets Runtime contract](../../../packages/assets-runtime/README.md)
and [capture regression](../../../packages/assets-runtime/src/__tests__/capture-publication.integration.test.ts)
own these distinctions:

| Boundary | Required behavior |
|:--|:--|
| Immutable capture | Freeze the selected publication and its bound transport before awaiting reads; later source replacement cannot change the captured closure. |
| Resident identity artifact | Copy the ordinary loader's cached bytes, then verify length and integrity against the frozen descriptor again. A cache hit is not new integrity evidence. |
| Encoded artifact | Retain the original stored bytes through the bound transport. Decoded domain bytes cannot replace a compressed publication body. |
| Complete closure | Read in batches of at most eight, check every attachment, and report descriptor failures in authored order. Shared paths join one byte request. |
| Retry | Evict failed body requests so the existing bounded transport policy can retry; retain non-success status and original read failures. |

This is reuse within immutable publication capture, not a WeChat persistent-disk
cache. Regression cases cover identity reuse, tampered resident bytes, original zstd
bodies, complete bounded reads, and transient HTTP/network retry. A faster capture
does not establish that activation, scene submission or gameplay succeeded.

### Canonical environment source closure

Missing canonical sky files and `preview-kit-source-mismatch` errors belong to
Preview/SDK source closure. The canonical kit publishes `sky.hdr`, `sky.hdr.meta.json` and
`cook-receipt.json` together; replacing the HDR or sidecar under an old receipt is
invalid even if a cached package build succeeded. The ordinary build's
[staging gate](../../../scripts/build.mjs) delegates missing kit generation to
[Preview's producer](../../../packages/preview/scripts/build-canonical-kit.mjs).
Reuse a valid unchanged kit; repair the producer/inventory when it is incomplete.

The public SDK must carry its generated fallback or use a project-owned source,
without requiring the private contributor asset submodule. The
[canonical admission regression](../../../packages/devkit/src/__tests__/canonical-kit-integrity.integration.test.ts)
exercises ordinary build/serve against that fallback and rejects tampered source
bytes. Keep this distinct from a valid admitted environment whose cube data is
missing in an RHI tape: that follows the
[seed/readback route](rhi-capture.md#inspect-seed-data-and-ordinary-ui-work), not a
new sky asset or shader workaround.

### Separate graphics readiness from scene admission

Native startup needs the App's sole loop while the game root is still activating.
Renderer shader initialization completing does not mean the World has its Camera.
Retain whether `render-system-no-camera` happened before root activation, after a
successful activation, or during failed-root cleanup; the same code has different
causes in those intervals. Preserve activation failure as the primary cause and
retain observed App/cleanup errors alongside it.

Route early extraction to App/Renderer scene admission. Do not suppress the error,
create a placeholder Camera, or add another frame loop. Full-screen opaque UI alone
cannot be the admission signal: the shared loading UI stays opaque until a matching
scene-ready completion starts its fade, while UI-only receipts remain pending.
Keep that receipt contract when fixing startup, and preserve the no-camera failure
for an admitted scene that actually lacks its camera.

The Host now derives `drawSource` from its activation lease: `null` keeps screen
UI submitting while activation is pending or failed; `undefined` admits the
primary World. App preserves the next scene's temporal reset across UI-only frames.
Wire startup input as `enabled => input.setInputAllowed?.(enabled)`: the shared
controller accepts a callback, not an InputBackend object. UI receives native
touches while gameplay is gated. A runtime failure after entry must restore Fatal,
Diagnostics and Reload as well as revoke scene/game input; a hidden failed state
is not recovery.

## Native runtime import restrictions

| Failure | Owning route |
|:--|:--|
| AJV `makeValidate is not a function` | Pack/Profiler generate standalone validators during build; runtime never compiles schemas |
| Importing codec requires an unavailable module URL | Basis glue/WASM URL resolution belongs inside the requested transcoder initializer |
| `structuredClone` absent | Install the fixed standard bootstrap before the game module; preserve typed-buffer identities and cycles |
| RuntimePack generation fails with `URL is not defined` | The realm bootstrap installs missing WHATWG `URL`/`URLSearchParams` from the same pinned `core-js-pure` used by native transport; preserve native constructors and keep ordinary producer/Catalog URL resolution unchanged |
| Shader manifest needs browser fetch or Web Crypto | Supply the ShaderRegistry text reader; the shader owner verifies the same SHA-256 through its portable implementation |
| Registry assembly eagerly binds missing fetch | Construct the assembly without reading transport; package-bound readers remain the resource authority |

A 60-frame startup pass does not prove that optional runtime-generated objects
exist. Inspect their existing game read projection and correlate the returned
GUID/entity with Renderer geometry. On Android, the missing vase reached
`runtime-pack-execution-failed` before producing a mesh because the global URL
constructor was absent; the native package fetcher already had its own portable
URL dependency, which did not supply the rest of the realm. The regression uses
the actual bootstrap, static native program Host, RuntimePackProducer, publication
validation and Catalog loader without native URL globals, and loads two changed
mesh generations. It does not replace failed geometry in the demo.

The simulator App camera fixture completed 61 Renderer receipts with zero in-flight
work and GL error 0 on 2026-10-10. Its linear clear `[0.1, 0.4, 0.7, 1]` produced
encoded bytes `[89, 170, 218, 255]` through the normal output transform. This qualifies
the basic App/Renderer/surface path, not Catalog assets, physics, UI or phone gameplay.

The native App cube fixture additionally rendered a real indexed mesh, completed
more than 60 receipts, and moved its World transform from x=0 to x=0.8 through
the official `automation_game_action` touch operation. Its center pixel was
`[187,188,187,255]` before the move. This remains a bounded Engine fixture;
ordinary DevKit project, physics and portable UI adoption need separate evidence.

## Capturing native rendering failures

Use the Engine RHI Debug recorder at the actual backend seam. Preserve its live
surface presentation proof, bind the App-owned frame driver, and write the exact
capture bytes with the native filesystem. Keep digest and selected work indices.
Node views of tape blobs may be unaligned; decode integers with `DataView` rather
than assuming a blob's byte offset is a multiple of four.

For depth diagnosis, use RHI Debug's depth output/readback on the original tape.
Its independent load-only shader reads 2D/array layers and mip levels as one f32
per texel; depth-stencil textures require an explicit aspect. Check both a known
positive region and cleared zero before trusting the image. An all-zero result
can be a broken readback, and depth comparison searches cannot distinguish exact
zero from tiny positive values. Keep raw values alongside any displayed range.
The shared wgpu GLSL/GLES repair supports these unfiltered depth loads; mixed
depth loading and sampling in one shader still fails explicitly. See the
[RHI contract](../../../packages/rhi-wgpu/README.md#depth-texture-loads-on-webgl2).
This qualifies replay inspection separately from live simulator/device pixels
and preserves the original scene when investigating backend depth differences.

When adjacent depth values diverge between WebGL and WebGPU, inspect the actual
`EXT_clip_control` lease and generated vertex shader before changing scene depth
policy. The shared wgpu owner uses zero-to-one clip depth when supported, retains
the Y flip, and restores native clip state for each command buffer. Without the
extension it keeps the original conversion. Qualify both paths, including an
external clip-state change; this repair does not imply whole-frame parity after
post-processing.

| Observed failure | Qualified owner repair |
|:--|:--|
| Native surface has no `getConfiguration`/`unconfigure` | RHI retains an accepted configuration with original device identity; native unconfigure frees the actual WASM surface and later configure creates a new one |
| Recorder reports incomplete surface proof | Forward the live proof through the recorder, not an acquisition-time object spread |
| Snapshot fails because `crypto` is absent | RHI Debug hashes with its portable SHA-256 implementation, yielding between large chunks |
| Indexed mesh renders but captured indices are all zero | The pinned wgpu WebGL buffer-copy repair preserves index-to-staging bytes; never infer missing geometry from the former zero-filled readback |
| First combined scene/UI submit reports a destroyed Surface Texture | Check the RHI canvas acquisition lease: repeated reads in one record/submit stack must return the same texture, with one presentation after that stack; a second read must not present the first pass's attachment |

The repaired simulator tape contains the cube's actual 36 indices and two work
items (indexed material draw, output transform). Depth/stencil and surface seeds
are unseeded; their passes clear them before use. Read `unseededResources` on every
capture and retain whether each relevant input was omitted or initialized in-frame.

## Explicit App and package reads

- Use `@forgeax/engine/app` with `{ platform, renderer, world }` for native assembly.
  Browser Canvas construction is isolated in `@forgeax/engine/app/browser`.
- `createWechatPackageFetcher` maps a declared package URL base to a native package
  directory. Wire it into the existing Catalog/Registry; never install a fake global
  Fetch/Response or create a second catalog. Downloaded content needs its own qualified
  transport and cache owner.
- Package body responses belong to `pack/runtime`; the protocol belongs to `types`.
  Artifact SHA-256 retains verification when WebCrypto is missing.
- Run `pnpm exec vitest run --project @forgeax/engine-platform-wechat
  packages/platform-wechat/src/__tests__/package-fetch.test.ts` for the native binary
  Mesh path, tampering, cancellation, retry and namespace checks. These are deterministic
  host contracts, not simulator or phone game acceptance.
