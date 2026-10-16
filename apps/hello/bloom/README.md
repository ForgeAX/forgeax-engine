# hello-bloom

> Bloom post-processing opt-in exemplar. Press Space to toggle the ten-pass declarative Bloom pipeline at runtime.

(feat-20260531-bloom-first-declarative-render-graph-pass / M4 / w18)

## What is demonstrated

- **Ten-pass declarative render graph chain**: five downsample passes -> four tent upsample passes -> Bloom composite, all in linear HDR.
- **Camera bloom columns**: `bloom`, `bloomThreshold`, `bloomIntensity`, `bloomSoftKnee`, and `bloomScatter` configured per-Camera alongside `tonemap`/`antialias`.
- **Zero-overhead default**: bloom=0 (BLOOM_DISABLED) allocates no Bloom textures, binds no Bloom pipelines, and performs no Bloom uploads or encodes.
- **Runtime toggle**: Space-key press-edge system swaps Camera.bloom between BLOOM_ENABLED and BLOOM_DISABLED via world.set. DOM HUD overlay mirrors state as text; the carrier smoke verifies on -> off -> resize -> on surface reconfiguration.
- **HDR+Reinhard pipeline**: Camera.tonemap=Reinhard-Extended enables the HDR path required by Bloom; continuous HDR extraction uses bloomThreshold (1.0) from the scene-linear target.

Game-facing imports use the public umbrella route:

```ts
import { BLOOM_ENABLED, Camera, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine/render';
```

## Run

```bash
pnpm dev                        # vite dev server -> localhost:5173
pnpm build                      # production bundle -> dist/
pnpm --filter @forgeax/hello-bloom smoke   # Dawn 60-frame lifecycle + readback
pnpm --filter @forgeax/hello-bloom smoke:odd-dawn # real HDR odd-extent oracle
pnpm --filter @forgeax/hello-bloom smoke:quality-dawn # real HDR radial/DC/intensity/motion/extent evidence
pnpm --filter @forgeax/hello-bloom smoke:performance # receipt-bound per-pass GPU timing evidence
pnpm --filter @forgeax/hello-bloom smoke:browser # Browser WebGPU lifecycle + PNG readback
pnpm --filter @forgeax/hello-bloom smoke:browser-device-loss # Browser GPU loss -> Renderer.recover()
pnpm --filter @forgeax/hello-bloom smoke:falsify # expected red Bloom contribution control
pnpm --filter @forgeax/hello-bloom smoke:all # complete Dawn + Browser carrier gate
```

Ordinary CI retains the initial 60-frame lifecycle receipt and every resize/recovery pixel check, but uses eight post-resize frames with `FORGEAX_DAWN_LIGHTWEIGHT=1` or `FORGEAX_BROWSER_CI_LIGHTWEIGHT=1`. GPU timing mode and full local runs retain sixty post-resize frames.

The standalone extraction and quality Dawn carriers destroy their device, drain
completion callbacks, verify the destruction notification and release their GPU
instance through the shared Dawn teardown owner before reporting acceptance.
A passing image receipt followed by a native process crash is a failed smoke.

## Scene

An emissive sphere (baseColor=[1.0,0.85,0.55], emissive=[1.0,0.7,0.3], emissiveIntensity=2.0) on the left and a non-emissive reference cube on the right, under a slant directional light. The sphere's > 1.0 HDR pixels feed Bloom extraction; the cube stays below the threshold as a visual anchor.

## Keybind

| Key | Action |
|:--|:--|
| <kbd>Space</kbd> | Toggle bloom on/off |

## Smoke gate

`scripts/smoke-dawn.mjs` runs a real dawn-node headless smoke with at least 60
successful Renderer submits. It records the on -> off -> resize -> re-enabled
-> surface-reconfigure phases, detached Bloom inspection, graph roster, structured errors,
and `copyTextureToBuffer` readback. Between off and re-enabled it also drives
the `bloomIntensity === 0` / `BLOOM_ENABLED` exact-zero case. The contribution
oracle uses numeric RGB
readback and rejects an all-black enabled output; hashes are diagnostic only.
`smoke:falsify` removes every scene radiance source with the same camera, graph,
and frame schedule and must make that oracle fail. `smoke:odd-dawn` runs the
cooked production downsample shader against an independent CPU extraction
oracle: 100 threshold/knee/RGB/HDR cases, the odd-extent coverage cases, the
per-texel-before-average falsifier, and threshold-adjacent continuity sweeps
that reject a legacy whole-RGB switch. Its evidence records the binary16
subnormal quantum used for the unavoidable `rgba16float` near-zero absolute
error boundary; references above `2^-24 / 0.01` retain the 1% normalized gate,
while smaller positive references use one binary16 quantum as the absolute
decoded-error gate. It does not clamp the production shader or hide non-finite
values. `smoke:quality-dawn` binds the same cooked production modules for
matched-contribution `r90`, constant-field DC, tone-free intensity, alpha,
small/odd extents, and a 60-frame energy-constant subpixel trajectory whose
energy is summed over the entire D0 footprint; its radial metric is reported
in output-pixel coordinates and is accepted only when the complete D0 edge
decodes to zero. The motion trajectory uses the same full-D0 boundary rule;
its PNG files are viewed evidence only. `smoke:performance` opts into the existing
Renderer receipt-bound timestamp route and fails closed if 60 stable Bloom
frames cannot produce complete ten-pass timing facts, or if the active Bloom
resource signature drifts during the sample window. The carrier also intercepts
the real Dawn `GPUDevice` lifecycle for `bloom-*` textures, parameter buffers,
bind groups, layouts, samplers, and pipelines: stable-frame create/destroy
deltas must be zero, while probe-observed live payload and resize-overlap
peaks are recorded at every intercepted create boundary and frame snapshot.
`residentChildBytes` reports active logical Bloom texture bytes; parameter
buffers, labeled native resources, and in-flight retirement are reported
separately in the performance artifact. `measurement.status` admits timing completeness and resource stability only;
`budget.status` is `not-evaluated` because this carrier declares no elapsed-time
budget or physical-adapter admission. The ten-pass sum is a diagnostic with
repeated interval coverage, never exclusive Bloom cost, frame latency or FPS.
Summing individual pass p95 values is retained only as a non-percentile diagnostic. WebGPU does not expose driver-private
pipeline memory or allocator alignment, so those remain explicitly unavailable.

`scripts/smoke-browser.mjs` runs the same lifecycle on a real Browser WebGPU
canvas, waits for 60 submitted-frame events, captures PNGs, decodes their
pixels, and stores the inspection/readback contract in `evidence/`. It also
checks the enum-on/intensity-zero exact-zero state. Its
surface-reconfigure stage is separate from device-loss recovery. The dev
server uses an ephemeral port and allows the shader-heavy startup up to 120s;
set `FORGEAX_BLOOM_SERVER_START_TIMEOUT_MS` to adjust that bound.
`scripts/smoke-browser-device-loss.mjs` uses the real `Browser.crashGpuProcess`
driver action, waits for `device-lost -> recovering -> alive`, calls the public
`renderer.recover()`, and verifies the ten-pass Bloom graph plus visible PNG
restoration on the replacement device generation. `smoke:all` includes the
receipt-bound performance carrier, so the aggregate gate covers every listed
Bloom evidence class.

## Recovery and evidence

Bloom is authored by `Camera.bloom` and remains inside the Standard post
graph. The disabled value is an exact zero-overhead path: no bloom resources,
passes, uploads, or counters are created. Call `renderer.inspect()` after a
failure, branch on the structured error `code` and typed `detail`, repair the
named owner, and retry the same draw request. The carrier never owns a second
post topology or accesses device handles.

The smoke manifest records current source/build provenance, backend, runner,
frame identity, and the on -> off -> resize -> re-enabled -> surface-reconfigure receipt sequence. Structural
roster evidence and real PNG/readback evidence are distinct; a historical
oracle cannot substitute for either one.
