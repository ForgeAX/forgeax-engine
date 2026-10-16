# @forgeax/engine-rhi-debug

The RHI debug package records one self-contained v7 frame tape, decodes it
strictly, and replays it on a fresh backend for deterministic inspection. The
artifact is one `.rhitape` file. The same artifact is the input to summary,
replay, readback, and the read-only Viewer.

> [!IMPORTANT]
> The shortest AI workflow is `captureFrame -> decodeTape -> buildFrameModel ->
> openReplay.inspectWork`. Keep the returned digest with the bytes. Do not
> infer a second artifact, a paired input, or a live inspection owner.

Capture requests arriving between frames start recording at the next snapshot
boundary. Work submitted before that boundary is excluded from the one-frame
tape. Hosts must keep rendering resources stable while `frameBoundary()` seeds
its snapshot; the Render Worker waits for that promise before consuming its next
publication.

## AI cold-start manifest

| Step | Input | Stable result | Next coordinate |
|:--|:--|:--|:--|
| Capture | one bounded frame | `EncodedTape` (`TapeArtifact`: `byteLength`, `chunks(n)`, lazy `digest`/`bytes`) | stream it with `uploadTape`, or keep digest and bytes |
| Decode | `.rhitape` bytes | `V7Tape` or `tape-*` error | `buildFrameModel(tape)` |
| Project | `V7Tape` | JSON-safe `FrameModel` arrays | choose `works[n].workIndex` |
| Inspect | same tape + fresh `ReplaySession` | pipeline, bindings, resources, or error | pass `workIndex` to panels |
| Readback | `resourceId` + optional subresource | typed pixels or `readback-*` error | display with provenance |
| Preview | selected raster shader facts | viewer-private `preview` or `preview-*` | never write canonical facts |

`FrameModel.works[].bindings` rows report each binding's static `bufferOffset` and
the `dynamicOffset` applied by the draw's latest `setBindGroup` (in layout binding
order; `null` for a static binding), so the effective slot is their sum. Each row's
`access` (`'read' | 'write' | 'read-write' | 'unknown'`) comes from the explicit
bind group layout entry, else from the pipeline's WGSL declaration (`auto`
layouts); `write`/`read-write` rows are the work's storage outputs.

The artifact identity is the digest of the one `.rhitape` byte sequence.
`FrameModel` is a plain-data projection safe for `JSON.stringify`. `ReplaySession`
is the sole fresh-device, replay, generation, readback, and disposal owner.
`workIndex` is the only cross-panel selection coordinate.

The Viewer Browser smoke emits a public cold-start transcript with explicit
inputs, outputs, codes, and recovery actions for the same ArtifactRef. The
transcript covers capture, summary, inspect, readback, preview, shader-error,
and layout-recovery. A recovery result is still useful structural evidence: it
must retain the artifact digest and coordinate while reporting the missing
capability or incomplete shader facts.

## Contract map

| Concept | Owner | Contract |
|:--|:--|:--|
| `.rhitape` | [`protocol/codec.ts`](src/protocol/codec.ts) | One canonical v7 container: preamble, JSON index (events, capabilities, blob table with per-blob SHA-256), then blob payloads. |
| `EventSemantics` | [`protocol/event-semantics.ts`](src/protocol/event-semantics.ts) | Maps each RHI method to its event kind, handle effects, and lifecycle rules. |
| `TapeIndex` | [`protocol/tape-index.ts`](src/protocol/tape-index.ts) | Derives event, resource, and work lookup from the decoded tape. |
| `FrameModel` | [`frame-model.ts`](src/frame-model.ts) | Derives one `workIndex` sequence for the Viewer and inspection clients. |
| `ReplaySession` | [`replay/session.ts`](src/replay/session.ts) | Owns fresh-backend replay, typed resources, readback, and disposal. |

The protocol, index, model, recorder, and replay layers each have one owner.
Recorder blob deduplication uses the same SHA-256 digest as the tape codec.
Short rolling hashes are not valid content identities: ordinary all-one half
float color and full float depth textures can collide, as can equally sized
buffer payloads. Blob keys remain opaque v7 references; a previously corrupted
capture must be recorded again because deduplication discarded its original
bytes. Dawn and browser capture/replay tests protect this boundary with two
distinct buffer payloads that collided under the former rolling hash.
Consumers receive derived views and never reconstruct event or resource state.
Captured buffer and texture descriptors retain their producer labels, including
bootstrap resources. Inspect them through `FrameModel.resources[].descriptor.desc.label`;
labels aid navigation while `resourceId` and `workIndex` remain the actual keys.
Render and compute pipelines keep their producer labels the same way, at
`FrameModel.works[].pipeline.descriptor.desc.label`, so a draw or dispatch maps back to
the producer that named it (for example one Card capture draw per instance/index range/material).
`buildResourceLifecycle(tape)` joins bootstrap ownership with recorded destruction.
`counts.peakLive`, `bytes.knownPeak`, and `bytes.unavailablePeak` update at each
observed creation/destruction boundary, including retained bootstrap resources.
They distinguish a candidate overlapping its previous allocation from steady
live payload and total bytes ever created. A short-lived allocation contributes
to the peak even when it is destroyed before the next work item. These peaks
cover only the captured resource closure; API destruction does not establish
driver retirement, and unknown descriptor/driver bytes remain unavailable.
Bootstrap rows have `createdEventIndex: null`; frame event indices are never shifted.
Counts and descriptor byte estimates describe the captured resource closure, not
allocations created during this frame or driver memory. Locate indirect consumers
through the selected work's `bindings`, vertex/index buffers and attachments;
`resources[].consumers` only lists direct event references.

## Capture and inspect

```ts
import { buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';

// App owns the recorder-enabled frame boundary. Retain the returned bytes and digest.
const captured = await app.rhiCapture?.captureFrame();
if (!captured?.ok) return captured;
const decoded = decodeTape(captured.value.bytes);
if (!decoded.ok) return decoded;
const model = buildFrameModel(decoded.value);
const backend = await createFreshBackend(decoded.value);
const replay = await openReplay(decoded.value, backend);
if (!replay.ok) return replay;
try {
  return await replay.value.inspectWork(model.works[0].workIndex, ['pipeline', 'bindings', 'pixels']);
} finally {
  await replay.value.dispose();
  // The host also releases its backend device.
}
```

The host supplies the real RHI backend and owns the file write. The package
owns recording, encoding, decoding, replay, and readback contracts. Expected
failures are `Result` values, not message-parsed exceptions.

Recorder attachment preserves both the asynchronous shader factory and an
optional `createShaderModuleImmediate` factory on the explicit RHI backend.
Pipeline handles retain native identity. Calls to `getBindGroupLayout(index)`
record the originating pipeline and index, so automatic layouts participate in
bootstrap dependency closure and are recovered from the recreated pipeline
during replay.

## File-first inspection

```sh
forgeax rhi capture --json
forgeax rhi summary --artifact frame.rhitape --json
forgeax rhi inspect --artifact frame.rhitape --work-index 22 --fields '["pipeline","bindings","pixels"]' --json
forgeax rhi read --artifact frame.rhitape --reads '[{"binding":{"group":1,"binding":3},"workIndex":22,"image":{"format":"rgba16float","width":512,"height":512,"tile":{"tileWidth":8,"tileHeight":8,"index":40,"border":1},"tonemap":"reinhard","png":"probe40.png"}}]' --json
forgeax rhi timing --artifact frame.rhitape --json
```

The CLI derives the artifact digest from the file. An optional `--digest
sha256:...` verifies expected identity and returns `artifact-digest-mismatch`
before replay if the file changed. Recorder and CLI use `tapeDigest` for the
same SHA-256 artifact identity.

`rhi.summary` returns `summary.works[]`: work/event/pass indices, draw or dispatch
kind, debug groups, pipeline identity, entry points and attachments. Shader
source stays in `rhi.inspect`; the summary does not repeat it per draw.
`summarizeFrame(buildFrameModel(tape))` exposes the same projection to library
callers without requiring a GPU.

> [!WARNING]
> `FrameModel.unseededResources` and `summary.unseededResources` list retained
> buffers/textures with no captured initial bytes. Replay starts them at zero.
> Pixel evidence requires a captured producer before the first read, or a new
> capture that includes the initial contents. A successful replay alone does
> not establish pixel fidelity. An empty list establishes only that no entire
> bootstrap buffer/texture seed is absent, not equivalence to the live image.

### GPU UI work and retained contents

GPU UI uses the ordinary Renderer submission and recorder. Select draws by
`works[].pipeline.descriptor.desc.label`; inspect the selected `workIndex` with
`pipeline`, `bindings` and, for the final composition, `pixels`.

| Producer label | Inspect |
|:--|:--|
| `ui-raster-strip`, `ui-raster-filter`, `ui-raster-blend`, `ui-raster-copy`, `ui-raster-clear` | Vertex layouts, shader sources, sampled inputs and layer attachments |
| `ui-clear-target-*` | Render-pass begin events and attachment clears; a clear-only pass has no draw work |
| `ui-target:*` | Intermediate layer textures and final retained UI content |
| `screen-ui-composite` | The UI texture read and final scene color write |

Resolve texture-view bindings to their source textures before comparing read/write
identities. Alpha, paint and filter data use `rgba32uint`, `sampleType: 'uint'`
and WGSL `texture_2d<u32>` / `textureLoad`; these are sampled read-only data,
not storage writes. Layer color is written through render attachments. Pass labels
and debug groups are separate evidence; an empty group stack does not erase labels.

Capture both a changed UI frame and an unchanged frame. An unchanged frame can
correctly have no raster draws and only `screen-ui-composite`; its `ui-target:0`
must have captured initial contents or a producer before its first read. Retain
all `unseededResources` diagnostics, including unrelated resources. Compare live
and fresh-device replay pixels before declaring the cached UI recoverable.

The actual Renderer regression is
[`gpu-ui-rhi-debug.dawn.test.ts`](../runtime/src/__tests__/gpu-ui-rhi-debug.dawn.test.ts).
Set `FORGEAX_GPU_UI_RHI_EVIDENCE` to retain its tapes, models, per-work inspection
and live/replay images; the same tapes are inputs to the existing CLI above.
This qualifies capture and replay on the tested backend; replay-device timings
do not measure the original WeChat device.

## Streaming large captures

A GI frame can carry close to a gigabyte of seeds. The capture path never holds
a second container-sized copy:

- `encodeTapeParts(tape)` returns the container as ordered parts: the
  preamble+index head, then each blob payload **borrowed** from the blob pool.
  `encodeTape` is the same bytes concatenated once.
- A captured `EncodedTape` is a `TapeArtifact`: `byteLength`, `chunks(n)`
  (container windows; views where a window lies inside one part), and lazy
  `digest` / `bytes`. The digest is SHA-256 of the whole container and is
  computed only on first access; `bytes` materializes one contiguous copy.
- `uploadTape(artifact, { endpoint, runId, chunkBytes?, chunkAttempts? })` from
  `@forgeax/engine-rhi-debug/browser` streams 16 MiB chunks as `Blob` bodies
  with two requests in flight. Each `PUT` carries `x-forgeax-chunk-digest`; the
  server holds verified chunks per `runId`, a `GET` lists them, and a retried or
  resumed upload sends only the missing ones. The final `POST .../commit`
  verifies the whole container and publishes it atomically. Transient 5xx
  answers are retried per chunk; failures report `stage: 'status' | 'chunk' |
  'commit'` with the server code.
- `decodeTapeContainerIndex(prefix, byteLength)` validates the index without
  touching payloads, so a server or tool can verify blob ranges and digests
  while streaming a file.

Identical payloads are stored once: recorder blobs are keyed by their SHA-256
content hash, so repeated uploads and identical resources share one blob, and
encoding reuses that hash as the blob digest instead of hashing again.

`CaptureFrameOptions.seed.maxResourceBytes` scopes initial contents. A resource
whose snapshot exceeds the bound is not read back; its bootstrap entry keeps the
descriptor with `seed: 'omitted'` and `FrameModel.unseededResources[]` reports
it with `omitted: true`. Replay starts it at zero, so only works whose evidence
does not depend on its initial bytes remain faithful. Use it to cut a huge
capture down to the passes under investigation, then recapture without the
bound when an omitted resource turns out to matter.

`node packages/rhi-debug/scripts/measure-large-capture.mjs` captures a synthetic
832 MiB frame in local headless Chromium and records renderer/GPU/driver memory
and per-stage time for the upload path.

## v7 tape rules

The decoder accepts only the current single-file format:

- the magic is `RHITAPE` and `formatVersion` is `7`;
- the JSON envelope is canonical and the digest covers the canonical payload;
- typed arrays, handle references, blob references, and lifecycle transitions
  are validated at the boundary;
- all referenced resources must have a valid create/dispose history;
- versions 2 through 6 are rejected explicitly, even when their payload looks
  compatible with v7.

Invalid cardinality, non-canonical JSON, digest mismatch, unknown event data,
or an invalid lifecycle transition returns a closed protocol error before
replay starts.

`header.rhiCaps` records the presentation surface as `canvasFormat` plus
`canvasColorSpace: 'srgb' | 'display-p3'`. Both are taken from the context's
`getConfiguration()` after `configure()`, so a requested space the surface did
not honour is recorded as `'srgb'`. Replay renders into offscreen textures, so
compare replay bytes with a live observation that has the same colour space
(the Render `final-display` observation carries it).

The header also preserves enabled device capabilities, including
`firstInstanceIndirect` and `rg11b10ufloatRenderable`. `replayDeviceRequest`
requests their corresponding features on a supporting fresh adapter. Replay
rejects an unsupported device when the tape uses indirect draws or RG11B10Float
render attachments; unrelated tapes do not require these capabilities. Indirect
arguments may be GPU-written, so admission preserves the recorded capability
without inferring `firstInstance` from initial buffer contents.

## One work index

`FrameModel.works` is the only selection vocabulary. Every work item has a
stable `workIndex`, event linkage, pipeline state, resource references, and
readback metadata. EventBrowser, PipelineState, TextureViewer, and
ResourceInspector consume that key, so selecting one work item keeps all four
views aligned.

## Replay and readback

`openReplay(tape, backend)` uses the caller's fresh device and shader factory.
`ResourceTable` owns replay resources and typed handle generations; stale
generations fail closed. Session disposal releases replay resources; the
supplied backend remains owned by its caller.

`inspectWork(..., ['pixels'])` reads the first color attachment's resolve target
when present, after finishing the selected work's pass. A work without color
reads its depth attachment instead (one subresource of the attached view, so a
shadow-array layer view reads that layer), and a compute dispatch reads its first
writable storage texture. Only a work with none of these returns
`readback-unsupported`.

`inspectWork(..., ['outputs'])` reads every resource the work wrote, after the
work: `color<N>` (the resolve target when the slot resolves; a 3D slice for a
`depthSlice` attachment), `depth`, and `@group(G)@binding(B)` for each writable
storage buffer or texture. `workOutputs(work)` lists the same names and requests
without a GPU. Each `WorkOutputRead` keeps its own `Result`, so one unsupported
format does not hide the others.

`depthImage(image, projection?)` maps a decoded depth plane to grey: without a
projection the raw `[0, 1]` value, with `{ near, far, reverseZ?, orthographic? }`
the view distance (`far: Infinity` is the infinite reversed-Z projection). Pair
it with `toRgba8(image, { range: 'auto' })`, which stretches the finite RGB
range, to make a shadow map legible. Direct reads of an
unresolved multisampled texture return `readback-unsupported` before any copy.
`works[].attachments.colorResolveViewHandleIds` lists each color attachment's
resolve view in attachment order (`null` for a single-sample attachment), so a
multisampled multi-target pass such as weighted blended OIT accumulation exposes
every readable 1x target id for `readResourceAtWork`.
Partial replay closes command and pass debug groups still open at the selected
work, deriving the scopes from the recorded prefix without running later draws.
For `2d` and `2d-array` sources, depth readback uses an unfiltered depth-to-color
pass and returns one `f32` per texel for every supported depth format, including
exact cleared zero. It binds the source range and selects the layer/mip explicitly
in the load shader, preserving array and mip semantics on GLES; depth-stencil textures
require an explicit aspect. The same path works on WebGPU and WebGL2 without
changing recorded depth comparisons or writes. Stencil-only copies retain the
backend's format restrictions and structured transfer failures.

The remaining readback matrix is explicit: supported color/depth formats use
the backend path, unsupported formats return `readback-unsupported`, and
transfer or map failures return `readback-failed`.
`r32uint` readback preserves the original four bytes per texel, including all
packed material and lighting-context bits; it does not normalize or convert
integer values through floating point. `rg32uint` preserves two words and
`rgba32uint` preserves four (8 and 16 bytes/texel). Use `readResourceAtWork` with the selected color
attachment handle to inspect a later MRT target; `inspectWork` previews the
first color attachment.
Fresh-device requests derive required WGSL features from captured `enable`
directives, including bootstrap shaders. Captured storage-texture layouts with
read-only/read-write access outside the core R32 formats require
`texture-formats-tier2` on the fresh device. This requirement comes from both
bootstrap and frame descriptors. Float32 render targets with blending also
require `float32-blendable`, derived from their captured pipeline descriptors.
Each requirement is retained even on an unsupported adapter,
so device admission fails instead of replaying weaker work. An unenabled required feature fails
with `replay-capability-mismatch` before replay resource creation.

Retained `depth32float` textures are snapshotted across every array layer and
mip level. Replay restores the exact floats through a depth-only raster pass,
so a cached shadow map remains valid even when its producer is absent from the
captured frame. Other depth/stencil and multisampled initial contents are not
seeded; their producing work must be included in the capture.
`readResource(resourceId, subresource)` reads the captured initial state.
`readResourceAtWork(resourceId, workIndex, subresource)` replays through the
selected work before reading, including compute storage outputs. Its
`provenance.selectedWorkIndex` identifies that post-work state. Use this form
when checking what a dispatch produced; initial bytes are not output evidence.

The single-buffer and single-texture helpers use the same staging, submission,
mapping and cleanup lifecycle as batch readback. Buffer failures remain structured
`readback-failed` results; the texture helper rejects with the cause after cleanup.
Queue and map promise rejection release staging as well as ordinary RHI failures.

### Batch readback

`session.readAtWorks(requests)` answers many `{ resourceId, workIndex?, subresource? }`
reads with one result per request, in request order; a failed read never fails
the batch. Requests at the same work share one replay. Works that can be split
share a single forward replay: at each requested work the open pass ends with its
attachments stored, queue uploads recorded before that submission are applied,
the reads run, and a fresh encoder resumes the pass with `loadOp: 'load'` and
the recorded pass state. A work that cannot be split without reordering GPU work
(active occlusion query, multi-buffer or intervening submits, or a later closure
copy into a requested resource) replays standalone, exactly as
`readResourceAtWork`. Bytes always equal the per-work reads. Omitting
`workIndex` reads the bootstrap state.

`bindingReadRequest(work, group, binding)` turns what a `FrameModel` work bound
at a slot into a request: the bound buffer window (static plus dynamic offset,
bound size) or the bound texture view. Use it instead of copying ids from
`inspectWork` bindings. An omitted static buffer offset means zero; it does not
discard an explicit bound size or dynamic offset.

Replay retains immutable objects (pipelines, shaders, layouts, samplers, and
resources no recorded event writes) across resets, so repeated reads on one
session re-create only mutable state. Measured costs live in
[`artifacts/replay-perf.json`](artifacts/replay-perf.json)
(`node scripts/measure-replay.mjs`).

### Images, atlases and HDR texels

GI data (probe irradiance atlases, card atlases, SDF slices) often lives in
storage buffers or HDR textures. `readbackImage(read, layout?)` decodes a
readback into a raw float RGBA `FloatImage`: textures default to their own
format and extent (depth planes as `r32float`, stencil as `r8uint`); a buffer
names `format`, `width`, `height` and optional `offset`/`bytesPerRow`.
`decodeImage(bytes, layout)` is the same decode over plain bytes. Every
uncompressed color format with a host texel reader decodes, including
`rgba16float`, `rgba32float`, `rg11b10ufloat`, `rgb9e5ufloat` and integer formats
(values stay raw, not normalized). Compressed formats return `readback-failed`.

- `extractTile(image, { tileWidth, tileHeight, index, border?, columns? })`
  crops one row-major atlas tile, e.g. one octahedral probe without its border.
- `imageStats(image)` returns per-channel `min`/`max`/`mean` over finite
  texels plus the `nonFinite` texel count, so NaN propagation is visible.
- `toRgba8(image, { exposure, range, tonemap })` maps HDR for display, and
  `encodePng(width, height, rgba)` writes a deterministic PNG without a canvas.

`rhi.read` / `forgeax rhi read` composes these: up to 64 reads, each by
`resourceId`, by `binding` plus `workIndex`, or by `output` (a `workOutputs`
name such as `depth`) plus `workIndex`, optionally with `records`
(typed struct rows) and `image` (layout, `depth: true | { near, far, reverseZ?,
orthographic? }`, `tile`, display mapping with `range: [min, max] | 'auto'`, and
a `png` output path). `rhi.inspect` with `fields: ["outputs"]` summarizes each
output by provenance, byte length and digest instead of returning raw bytes. Each result reports provenance, `byteLength`, a content `digest`,
records and image `stats`; per-read failures (`read-request-invalid`,
`readback-failed`, `replay-position-invalid`, `artifact-write-failed`) stay in
their slot.

### Per-pass GPU timing

`session.timePasses()` replays the whole frame once with replay-owned
begin/end timestamps on every closed render and compute pass and returns
`FrameTiming { passes: PassTiming[], totalGpuNanoseconds }`. Each
`PassTiming` carries `passIndex`, `kind`, `label`, its `workIndices` and
`gpuNanoseconds` (null when the pass never wrote both timestamps). Recorded
pass timestamps are replaced for that replay only, and later reads in the same
session are unaffected. `replayDeviceRequest` enables `timestamp-query`
whenever the adapter has it; a device without it returns
`replay-capability-mismatch`. `rhi.timing` / `forgeax rhi timing` is the
CLI form.

Times come from the replay device, not the capture device: use them to rank
passes and find the dominant GI stage. A software adapter such as lavapipe
emulates the GPU on the CPU, so its absolute numbers are not frame budgets.
`scripts/measure-replay.mjs --timing` records the slowest passes into JSON.

## Structured errors

The public operation boundary uses `RhiDebugError`. Consumers should narrow
`.detail` after switching on `.code` and keep the switch exhaustive:

```ts
function explain(error: RhiDebugError): string {
  switch (error.code) {
    case 'tape-invalid':
    case 'tape-version-unsupported':
    case 'replay-capability-mismatch':
    case 'replay-event-failed':
    case 'replay-position-invalid':
    case 'readback-failed':
    case 'readback-unsupported':
    case 'capture-unavailable':
    case 'capture-busy':
    case 'capture-snapshot-failed':
    case 'capture-timeout':
      return `${error.code}: ${error.hint}`;
  }
}
```

`.detail` is typed per code. `.expected` and `.hint` are display and recovery
fields; they are not substitutes for the discriminant.

| Code | Detail to inspect | Recovery action |
|:--|:--|:--|
| `tape-version-unsupported` | found and expected versions | capture or decode a v7 tape |
| `tape-invalid` | decode/validate stage and event | obtain complete canonical bytes |
| `replay-capability-mismatch` | replay cause | use a fresh device with recorded capabilities |
| `replay-event-failed` | event index, kind, stage, cause | inspect that event; later work is invalid |
| `replay-position-invalid` | requested and available work count | choose `FrameModel.works[].workIndex` |
| `readback-unsupported` | resource and format | select a supported readback target |
| `readback-failed` | copy/map phase and cause | retry on a fresh replay session |

The Viewer adds its own closed `preview-*` union. It is not added to
`RhiDebugErrorCode`; `preview-not-applicable` is the required branch for
compute, missing stage, incomplete facts, no WebGPU, or capability mismatch.
All error panels retain `.code`, `.detail`, `.expected`, and `.hint`, and never
classify failures with `startsWith`, regex, or free-form message parsing.

## Host and package boundaries

| Boundary | Allowed responsibility |
|:--|:--|
| RHI debug core | Pure tape protocol, recorder, index, model, replay, and readback contracts. |
| Browser host | DOM file input, WebGPU backend creation, and one `.rhitape` download/upload. |
| Node host / DevKit | File reads and writes, operation discovery, and fresh backend provisioning. |
| Dawn host | Native backend construction and pixel evidence. |
| Viewer | Read-only model and local no-WebGPU structural fallback. |

The core stays free of DOM, Node filesystem APIs, PNG packages, and Viewer
state. The Vite plugin is a serve-only transport for one raw tape artifact.

## Validation

```bash
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm exec tsc -b packages/rhi-debug/tsconfig.json --pretty false
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm --filter @forgeax/engine-rhi-debug exec vitest run --config vitest.config.ts src/__tests__
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm --filter @forgeax/engine-rhi-debug build
```

Browser and Dawn gates belong to the host and application packages. They must
exercise the same `.rhitape` bytes and the same `workIndex` used by offline
inspection.

### Timestamp-bearing frame capture

Render, compute and empty-compute pass timestamps retain their QuerySet handle
identity in v7 events. Capture closure includes a QuerySet created before the
capture window; validation and resource lineage treat it as a referenced
resource. Replay replaces its serialized descriptor object with the fresh
device's QuerySet while preserving beginning/end indices. A missing identity
is a structured replay failure, never a request to silently remove timestamps.

## Render bundle capture

Bundle commands are retained by the recorder when the bundle is created, even while no
frame is being captured. `executeBundles` expands those commands at each execution into
the canonical v7 event stream. Every draw retains the ordinary `workIndex`, pipeline,
binding and resource lineage; there is no parallel bundle inspector or replay registry.
`resetRenderState` marks native bundle boundaries and replays through `executeBundles([])`.
It clears pipeline, bind-group and vertex/index state while retaining pass dynamic state.
Foreign/unrecorded bundles fail explicitly instead of producing a tape with missing draws.

[Real Browser/Dawn fixture](../runtime/src/__tests__/render-bundle.fixture.ts) covers a
bundle created before capture, copied dynamic-offset slices, live uniform updates, direct
and indirect indexed/non-indexed draws, seeded resources and fresh-device pixel replay.

The [changing-scene stress fixture](../runtime/src/__tests__/render-bundle-stress.fixture.ts)
compares every frame against direct rendering and replays selected frames on a fresh
device. Coverage includes list churn, resource replacement, pass state, live buffer
data and eight simultaneous passes. Queue uploads to retained resources between a
selected draw and its command-buffer submission are included in replay: they precede
that draw on the GPU even when the draw was recorded first. Uploads after that
submission and subsequent draws are excluded from the selected work prefix.

Reverse-Z uses the ordinary v7 tape: native clear/comparison/bias state and
projection bytes are recorded without reinterpretation. `replayDeviceRequest`
derives `depth32float-stencil8` from bootstrap and frame texture descriptors,
so the fresh device enables that optional feature before recreating resources.

### Structured compute and ray-query buffers

`inspectBufferRecords(session, resourceId, workIndex, layout, { first, count })`
replays the selected work and decodes only the requested buffer range. A layout
contains a byte `stride` and named fields with byte `offset`, scalar `type`
(`u32`, `i32`, `f32`, or `f16`) and `components` (1–4); `f16` fields need
2-byte alignment, so packed half irradiance sits beside 32-bit ids. Calls accept at most 4,096 records,
64 fields, and 16 MiB. Invalid layouts/ranges return `readback-failed`; replay
and resource failures retain their existing codes.

The output retains resource/generation/work provenance and absolute record
indices. Integer identities remain integers; nonfinite floats become the JSON-safe
strings `NaN`, `+Infinity`, and `-Infinity`. `decodeBufferRecords` exposes the same
interpretation for an already-read exact range. The producer supplies the layout;
RHI Debug does not infer material/BSDF or ray semantics from buffer labels.

The existing `rhi.inspect` operation and `forgeax rhi inspect` command accept
an optional `buffer` object containing `resourceId`, `layout`, `first`, and `count`;
the response adds `bufferRecords`. For several buffers or works at once, use
`rhi.read` with `records`; it replays once. A read's `records` window is relative to
the selected bytes: rows `stride * [first, first + count)` inside a binding's bound
range or an explicit buffer `subresource` (`{offset, size}`), so a binding read
decodes any row range without restating the binding offset. Rows past that window, or
`records` on a texture subresource, return `read-request-invalid`. A mappable (`MAP_READ` /
`MAP_WRITE`) staging buffer cannot be a copy source, so reading one returns
`readback-unsupported`; read the buffer it was copied from.

`rhi.inspect` / `rhi.read` replay on Dawn by default. Dawn has no acceleration
structures, so a tape that builds them returns `replay-backend-unavailable`
(`detail.stage: 'provider'`) naming the native route: rerun with
`FORGEAX_WEBGPU_NODE=wgpu-native` from an Engine contributor checkout where
`@forgeax/engine-rhi-wgpu-native` is built, and replay uses its native wgpu device. Use `rhi.summary` / binding inspection to select
the resource and work, then pass `--buffer '{...}'`. The same v7 tape remains the
only capture artifact. See [ray-query verification](../../scripts/raytracing/README.md).

### Acceleration structures

On a device whose `caps.rayQuery.supported` is true, BLAS/TLAS creation, destruction,
`buildAccelerationStructures` and `accelerationStructure` bind-group entries are
recorded on the same v7 tape; there is no refusal path and no second artifact.

- BLAS/TLAS are bootstrap resources of kind `acceleration-structure`. Their create
  record carries the last build completed before the capture (`build.geometries` /
  `build.instances`, as buffer and BLAS handle ids plus the 3x4 transform). Replay
  recreates each one and re-encodes that build on the fresh device in topological
  order: geometry buffers are seeded first, then BLAS, then TLAS.
- An in-frame build is a `buildAccelerationStructures` command event replayed in
  order. It becomes bootstrap build state for the next capture only, so the current
  tape keeps its capture-start state.
- A bind group that binds a TLAS after an in-frame build stays in the frame stream
  instead of being hoisted into bootstrap, so it never binds a TLAS ahead of its build.
- Binding inspection (`inspectWork(i, ['bindings'])`, `FrameModel.works[i].bindings`)
  adds `accelerationStructure` to an AS entry: `tlasHandleId`, `label`,
  `status: 'built' | 'unbuilt'`, last-build `instanceCount` and the deduplicated
  `blasHandleIds`, evaluated at that work's position in the event stream.
- Replaying an AS tape on a device without ray query fails before any resource is
  created with `replay-capability-mismatch` (`detail.stage: 'replay'`, `cause` names
  the unsupported `caps.rayQuery` reason). `replayDeviceRequest` therefore requires
  `RAY_QUERY_FEATURE` (`'wgpu-ray-query'`) for any tape with BLAS/TLAS, without
  filtering on adapter support, so a WebGPU-shaped native wgpu replay device gets
  `caps.rayQuery` and an unsupported adapter fails admission.
- Each bootstrap BLAS/TLAS rebuild is submitted and settled
  (`queue.onSubmittedWorkDone`) before the next bootstrap resource and the frame. On
  Metal, wgpu-hal places no acceleration-structure barrier and TLAS instances reference
  their BLAS indirectly (untracked by Metal hazard tracking), so an unsettled rebuild can
  race the first traversal: the replay then misses every ray (an all-miss trace that
  diverged from the live frame by max 25-48/255). The live frame never sees this because
  it built its structures frames before the capture. With the settle, native wgpu replays
  GI ray-query tapes bit-exactly against the live frame on both lavapipe and Metal (no
  diverging buffer or texture in the following frame's bootstrap, final draw max 0).
- Replay reproduces the recorded build inputs, not the driver's BVH layout. An in-frame
  build replays in its recorded command position, so a traversal recorded in the same
  submission keeps whatever ordering the live backend gave it.

Limits: a bootstrap rebuild reads the geometry buffers' capture-start contents, so
vertex data rewritten (or a buffer destroyed) between the pre-capture build and the
capture diverges from the live structure. The browser WebGPU backend has no ray query,
so AS tapes replay on ray-query-capable RHI backends only.

### Capture memory and retry

Snapshot exceptions and timeouts preserve the same `detail.progress`: queue drain,
resource readback or resource SHA-256 hashing, resource counts, current
handle/kind/size, and elapsed time. A resource completes after its seed hash and
bytes are stored, not when GPU mapping alone finishes. Hash waits retain their
resource identity and use `snapshotStage: "resource-hash"`; their timeout is not
a GPU readback measurement. A queue rejection before readback has no current resource; do not attribute
it to a texture or shader. The original cause remains alongside this progress.
A rejection from a cancelled older generation omits progress from a newer capture.

`CaptureFrameOptions.byteBudget` bounds the uncompressed initial-resource payload,
derived from the same format/block, array-layer and mip layout used for readback.
Mappable scratch, multisample contents and unsupported depth/stencil seeds are excluded;
their existing unseeded-resource diagnostics remain authoritative. This budget is not a
bound on final tape size, total process memory or driver allocations.

Resource snapshots batch at most 32 resources and target at most 32 MiB of padded
staging allocations. A larger individual resource runs alone, so the staging bound is
`max(32 MiB, largest resource staging size)`. Full seed bytes and the encoded tape
still need CPU residency. Internal readback bytes transfer into the blob pool without
another copy; caller-owned queue uploads are copied, including the exact typed-array
view. Uncompressed encoding borrows those immutable bytes as container parts; the
recorder hands them to the captured artifact when it releases its pool, so the
upload streams the seeds themselves (see [Streaming large captures](#streaming-large-captures)).

Snapshot blobs use asynchronous native SHA-256 with the same content keys as
synchronous queue uploads. Hash completion rechecks capture generation before
publishing bytes or events; a cancelled digest cannot seed a later capture.
This also lets the existing snapshot deadline run while large seeds are hashed.

An aborted or lost generation cannot settle a later capture. The same attachment
supports retry after budget refusal or cancellation. The real Browser/Dawn regression
`snapshot-memory` captures three complete array/mip textures, asserts staging bytes,
and replays two draws after producer disposal, including a changed subarray upload.
It also holds a real native digest across cancellation and rearming, then verifies
that only the new generation can populate the blob pool.

## Engine source viewer

The optional integrated tool page lives in `tools/view-plugins/rhi-debug`. It reuses the
existing RHI viewer's work/resource inspection and replay operations. Generic View supplies
only the page and panel hosts; this package owns capture, model and replay semantics.
The page is an artifact page and can inspect a `.rhitape` without opening a game.
WebGPU capability and replay failures remain explicit; loading a tape does not prove replay.

## ???? pipeline ????CF ???

`RecorderAttachment.readPipelineReference(device, pipeline, captureGeneration)` ????? handleMap ??? createRenderPipeline ??????????? ID??? shader ???????? recording ???? recorder/device ???? pipeline ????? capture???/???device loss?dispose ??? device ??????RHI ???? destroyPipeline ?????????????????????

?? `{ captureGeneration, handleId }` ????????? pipeline ? tape work ?? shader module ? descriptor?????? source ????????? recorder ??? opaque texture ??????????Null canvas ???????????????????
