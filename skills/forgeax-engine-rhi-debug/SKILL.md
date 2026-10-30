---
name: forgeax-engine-rhi-debug
description: >-
  ForgeAX first-line capture, replay, and per-work diagnosis for difficult rendering failures.
  Use when output is black, missing, incorrectly lit or shadowed, flickering, divergent across backends, or unexplained.
---

# forgeax-engine-rhi-debug

> [!IMPORTANT]
> Start difficult or unexplained rendering investigations here, before speculative
> shader/material edits or broad instrumentation. Capture the real failing frame
> and use GPU work and resource evidence to choose the repair owner. A concrete
> startup, asset, or schema error can go directly to its named owner.
>
> Use it only for an observed rendering failure. It is not a delivery or acceptance
> step: when the screenshot and `dev verify` pass, record no tape.
>
> When `rhi inspect`/`rhi read` return `replay-backend-unavailable` (for example no
> native replay on the host), keep the tape and `rhi summary` structure, then continue
> with live evidence (`dev capture` screenshots, `dev eval` state, debug draw) on the
> real backend. Do not retry replay or block delivery on it.

| Symptom | First check |
|:--|:--|
| White/transparent canvas, HUD fine | `rendererError` in `dev capture --json` or the `project play` report (also `__forgeaxGameInspection.renderer().rendererError`): a GPU validation/submit error rejects every frame's submit, so capture the frame and inspect the resource the message names. |

The package contract is [`packages/rhi-debug/README.md`](../../packages/rhi-debug/README.md).
In an installed game, read `node_modules/@forgeax/engine-rhi-debug/README.md`
or the SDK's `source/engine/packages/rhi-debug/README.md`.

## Diagnose and prove the repair

1. Reproduce the symptom in its actual browser/backend and scene state. Preserve
   the screenshot, errors, and reproduction command; browser-only failures need
   the browser path even when Dawn smokes pass.
   On Windows, record the process session for a black compositor capture. A
   Session 0 service can render offscreen while DXGI rejects its swapchain with
   `0x887A0022`; reproduce from the signed-in desktop before treating that as an
   Engine shading failure. Keep page/compositor screenshots as the visual gate.
2. Capture a bounded failing frame using the host path below. Keep its tape,
   digest, and reproduction inputs unchanged as failure evidence.
3. Derive `FrameModel`, choose the relevant `workIndex`, and inspect pipeline,
   bindings, resource descriptors/data, and supported render-target readback.
   Producer labels survive on resources (`resources[].descriptor.desc.label`) and on
   pipelines (`works[].pipeline.descriptor.desc.label`); find a producer's draws by label.
   For ray/compute records, use the producer layout with `rhi.inspect`'s `buffer` input or `inspectBufferRecords`; follow the [bounded buffer contract](../../packages/rhi-debug/README.md#structured-compute-and-ray-query-buffers).
   `rhi.read` `records` select rows inside the binding's bound window; read the source buffer, not a mappable staging copy (`readback-unsupported`).
   A ray-query tape replays only with `FORGEAX_WEBGPU_NODE=wgpu-native` (contributor checkout, native addon built); Dawn returns `replay-backend-unavailable`.
   For GI data (probe/card atlases, SDF slices, HDR storage buffers), read many
   bindings and works in one replay with `forgeax rhi read` or
   `session.readAtWorks` + `bindingReadRequest`, then decode with
   `readbackImage`/`extractTile`/`imageStats` (NaN count included) and write a
   PNG per tile; see [batch reads and images](../../packages/rhi-debug/README.md#images-atlases-and-hdr-texels).
   For a compute dispatch or a depth-only/shadow pass, use the `outputs`
   inspect field (or `workOutputs(work)`): it reads every `color<N>`, `depth`
   and writable `@group(G)@binding(B)` the work produced. Read one with
   `{"output":"depth","workIndex":N,"image":{"depth":{"near":0.1,"far":100,"reverseZ":true},"range":"auto","png":"shadow.png"}}`;
   `depthImage` linearizes depth and a layer view reads its own array layer.
   Depth readback returns one f32 per texel through an independent unfiltered
   load shader, including on WebGL2. Select an explicit aspect for depth-stencil
   textures. Validate a positive control and cleared zero, retain raw values,
   and use a shared display range for comparisons; an all-zero image or a
   comparison-sampling search alone does not establish exact depth contents.
   For a slow frame, `forgeax rhi timing` (or `session.timePasses()`)
   ranks every pass by replay-device GPU time; see [per-pass timing](../../packages/rhi-debug/README.md#per-pass-gpu-timing).
   Trace the first incorrect producer or consumer through resource lineage.
   If the expected draw/dispatch is absent, follow extraction, culling, or asset
   readiness upstream; an absent work item is evidence too.
4. Encode the failing path as the smallest useful regression gate and confirm
   it fails, then fix the subsystem identified by those facts. Load material,
   shader, render-pipeline, assets, or RHI skills as the evidence requires. Keep generic
   RHI Debug free of workload-specific lighting, shadow, or post-effect policy;
   repair capture/replay itself only when its contract is the demonstrated fault.
5. Run the regression gate, capture again after the fix, and verify the same
   scene/backend and original visible symptom.
   Keep before/after artifacts explicit; replay evidence supplements the required
   browser, Dawn, and smoke gates for the changed implementation.
   For recorder fallback without a usable WebGPU adapter, use the
   [Browser without WebGPU route](../../scripts/ci/README.md#browser-without-webgpu).
   Keep its Worker, sixty-frame and decoded-tape checks in the Browser owner.

If capture, replay, or readback is blocked, preserve the attempted command,
structured failure, and capability result. Follow structured recovery below and
continue with available structural evidence and targeted browser/live checks.
Record what remains unverified; do not replace missing GPU evidence with a
successful mock or hide an Engine gap in game/demo code.

## Game CLI entry

From the game root, discover the installed command contract:

```bash
pnpm exec forgeax help rhi --tree --json
pnpm exec forgeax help dev start --json
pnpm exec forgeax dev start --rhi-capture true --json
pnpm exec forgeax rhi capture --json
```

If a live owner already exists, stop it before changing its capture options.
Preserve the failing backend and execution tier, reproduce the target state, then
capture. The CLI calls the live host's recorder and persists one `.rhitape`;
retain its returned path and digest. Capture requires a ready recorder-enabled
App; it does not start one automatically. For an embedded host, use the
[CLI live bridge](../forgeax-engine-cli/SKILL.md#rhicapture-single-frame-capture) and persist
`capture.value.bytes` with its digest; a digest-only result cannot be inspected.

Use the returned path and select `summary.works[].workIndex`:

```bash
pnpm exec forgeax rhi summary --artifact <path> --json
pnpm exec forgeax rhi inspect --artifact <path> --work-index <workIndex> --json
pnpm exec forgeax rhi read --artifact <path> --reads '[{"binding":{"group":0,"binding":2},"workIndex":<workIndex>,"image":{"format":"rgba16float","width":256,"height":256,"tile":{"tileWidth":8,"tileHeight":8,"index":0,"border":1},"png":"probe0.png"}}]' --json
pnpm exec forgeax rhi timing --artifact <path> --json
```

Summary, inspection, and the read-only Viewer consume the same `ArtifactRef`;
they do not recapture or infer an input pair. Discover optional inspection fields
through CLI help; precise operation contracts live in
[DevKit](../../packages/devkit/README.md#rhi-debug-operations).

Select `summary.works[].workIndex`; the compact summary omits repeated shader
source. The CLI computes SHA-256 from the file; optional `--digest sha256:...`
checks the expected bytes and rejects a mismatch before replay. Recorder and
CLI share the same `tapeDigest` implementation.

Inspect `summary.unseededResources` (or `FrameModel.unseededResources`) before
trusting pixels. These retained buffers/textures have no captured initial
bytes and replay begins at zero. Confirm the captured frame initializes them
before reading, or recapture the producer. Empty diagnostics do not replace a
live/replay image comparison. `depth32float` seeds include all layers and mips;
other depth/stencil and multisampled contents still require producing work.

For resource release checks, use `FrameModel.resourceLifecycle` and
`resources[].destroyEventIndex`; bootstrap resources have a null creation index.
Locate bound consumers through each work's bindings and attachments. Descriptor
bytes and recorded destruction do not prove driver allocation or retirement timing.

For GPU UI, follow [GPU UI work and retained contents](../../packages/rhi-debug/README.md#gpu-ui-work-and-retained-contents):
select `ui-raster-*` and `screen-ui-composite` pipeline labels, inspect layer
reads/writes, and capture both changed and cached UI frames. Clear-only passes
appear in pass events rather than draw works. A cached frame needs seeded UI
texture contents before replay pixels can qualify it.

## Large captures

A GI frame can produce close to a gigabyte of tape. Upload it with
`app.rhiCapture.upload(artifact, { runId })` (or `uploadTape` from
`@forgeax/engine-rhi-debug/browser`): it streams digest-checked 16 MiB chunks,
resumes by `runId` after a failure, and the server publishes only a verified
whole file. Avoid touching `artifact.bytes` in the page, which materializes one
contiguous copy. To shrink a capture, pass
`captureFrame({ seed: { maxResourceBytes } })`; oversized resources become
`unseededResources[]` with `omitted: true` and replay starts them at zero, so
recapture without the bound if the evidence depends on one. See
[streaming large captures](../../packages/rhi-debug/README.md#streaming-large-captures).

## Mental model

| Concept | Use |
|:--|:--|
| `.rhitape` | One canonical v7 artifact containing the frame events and binary blobs. |
| `EventSemantics` | The method-to-event and handle-lifecycle mapping. |
| `TapeIndex` | Derived event, resource, and work lookup. |
| `FrameModel` | One `works[].workIndex` sequence shared by all inspectors. |
| `ReplaySession` | Fresh backend creation, typed resources, readback, and disposal. |

There is one artifact and one owner per concern. Do not invent a second tape,
selection key, resource registry, or host-side replay model.

## Shortest workflow

1. Attach the recorder to the real RHI backend at the Runtime to App seam.
2. Capture one frame and retain its artifact (`kind`, `byteLength`, `chunks`, lazy `digest`/`bytes`).
3. Decode the bytes with the strict v7 decoder.
4. Build `FrameModel` and select a `works[].workIndex`.
5. Open a replay session with a factory that creates a fresh backend.
6. Inspect that work item, then dispose the session even on failure.

```ts
const captured = await app.rhiCapture?.captureFrame();
if (!captured?.ok) return captured;
const tape = decodeTape(captured.value.bytes);
if (!tape.ok) return tape;
const model = buildFrameModel(tape.value);
const replay = await openReplay(tape.value, await createFreshBackend(tape.value));
if (!replay.ok) return replay;
try {
  return await replay.value.inspectWork(model.works[0].workIndex, ['pipeline', 'bindings', 'pixels']);
} finally {
  await replay.value.dispose();
}
```

Each `works[].bindings` row carries its static `bufferOffset` and the
`setBindGroup` `dynamicOffset` in effect for that draw (`null` when static). The
effective offset of a buffer binding is `(bufferOffset ?? 0) + (dynamicOffset ?? 0)`;
use it to prove which uniform slot a draw read, such as a per-composition View copy.
`bindingReadRequest(work, group, binding)` applies that rule and returns a read request.

Multisampled passes: read the 1x targets named by
`works[i].attachments.colorResolveViewHandleIds` (attachment order, `null` when
single-sample) instead of the 4x color views. Weighted blended OIT shows up as
`fs_oit`/`fs_oit_premultiplied` accumulate works followed by one
`fs_oit_composite` work; `readResourceAtWork` on the accum (rgba16float) and
weight (r16float) ids at the last accumulate work, and on scene color before and
after the composite, separates an accumulation fault from a composite fault.

## Protocol and lifecycle rules

- Accept only `RHITAPE` with `formatVersion: 7`.
- Validate canonical JSON, digest, typed arrays, handles, blobs, cardinality,
  and create/dispose history before replay.
- Reject versions 2 through 6 explicitly.
- Use the same `workIndex` for EventBrowser, PipelineState, TextureViewer,
  ResourceInspector, and DevKit inspect.
- Let `ResourceTable` validate generations and own disposal.
- BLAS/TLAS are ordinary bootstrap resources (`acceleration-structure`) rebuilt
  from their last pre-capture build; in-frame builds are command events. For a
  ray-query work, read the binding's `accelerationStructure` (`status`,
  `instanceCount`, `blasHandleIds`) before suspecting the shader: `unbuilt` or a
  wrong instance count is a producer bug in the build, not in traversal. Open the
  replay device with `replayDeviceRequest(tape, ...)`: it requires the Ray Query
  feature for AS tapes (native wgpu via `@forgeax/engine-rhi-wgpu-native`).
- Use the declared readback format matrix; return structured unsupported or
  failed results instead of guessing a conversion.

## Structured recovery

Expected failures are `Result` values with `RhiDebugError`. Switch on
`error.code` and let TypeScript narrow `error.detail`; do not parse `.hint` or
message text to decide control flow.

| Failure | First action |
|:--|:--|
| `capture-unavailable` | Enable the recorder on the real live host and invoke its `rhiCapture` root; retain startup errors if no frame can run. |
| `capture-snapshot-failed` / `capture-timeout` | Preserve the original cause and `detail.progress`; distinguish queue drain from the named resource readback before choosing a repair owner. |
| `tape-invalid` | Preserve the original bytes and capture again if the source is stale. |
| `tape-version-unsupported` | Use a producer that emits v7; older formats are not compatibility inputs. |
| `replay-capability-mismatch` | Create a fresh backend with the recorded capabilities or record again; a tape with BLAS/TLAS needs a replay device whose `caps.rayQuery.supported` is true. |
| `replay-position-invalid` | Select a `workIndex` from the current `FrameModel`. |
| `readback-unsupported` | Keep structural evidence and report the missing backend format capability; try the `outputs` field before concluding a work has nothing readable. |
| `browser-capture-upload-failed` | Read `detail.stage`/`offset`/`serverCode`; rerun the upload with the same `runId` to send only the missing chunks. |
| `readback-failed` | Preserve the detail stage and dispose the replay session. |

## Viewer evidence

The Viewer owns its fresh replay device. Replacing or closing a tape drains the
session before disposing that device once; rejected admission and failed cleanup
must also release it. Check `viewer-replay-lifecycle.test.ts` for ownership, then
qualify real captured-frame replay and pixels. Do not infer a device-loss cause
from a lifecycle unit pass.

The Viewer is read-only. It loads one `.rhitape`, shows the four linked views
through the shared `workIndex`, and keeps the structural model available when
WebGPU is absent. Pixel inspection is a capability-gated enhancement, not a
reason to replace the tape or create a browser-only model.

For an AI handoff, include the artifact digest, selected `workIndex`, event
anchor, structured error detail when present, backend capability result, and
the exact command or browser path used.

## Platform boundaries

| Platform | Owns |
|:--|:--|
| Browser | DOM file selection, WebGPU backend construction, and raw tape transfer. |
| Node / DevKit | File access, operation discovery, and host-owned fresh backend creation. |
| Dawn | Native backend and pixel evidence. |
| Core package | Protocol, recorder, index, model, replay, and readback contracts. |

The core must not import DOM, Node filesystem APIs, PNG encoders, or Viewer
state. The Vite bridge serves one raw tape in development only.

## Verification

For native Node divergence, use the `native-node-gi` roster in
[native-ray-query.yml](../../.github/workflows/native-ray-query.yml) with
`FORGEAX_WEBGPU_NODE=wgpu-native` and `FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1`.
Foundation covers actual auto-exposure histogram/readback; gather covers the
captured screen-probe depth-pyramid barrier regression. Record the real adapter
and retain native captures separately from the complete Dawn evidence.

```bash
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm exec tsc -b packages/rhi-debug/tsconfig.json --pretty false
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm --filter @forgeax/engine-rhi-debug exec vitest run --config vitest.config.ts src/__tests__
pnpm test:browser
pnpm test:dawn
```

Use the package and host gates for the changed surface, then preserve the
artifact and its command output as evidence. Do not call an unrun browser or
Dawn gate green.
