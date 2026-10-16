# Ray-query foundation verification

The first implementation milestone establishes opaque scene/query correctness
and diagnostics. It is one of five coarse capability milestones (query/debug,
shared material/PT, SDF/cards, diffuse GI, reuse/reflections), **not 20% measured
Lumen parity or an effort estimate**. The shared-material/PT reference is described below; a bounded ordinary Renderer diffuse reference lane is also available below.

## Reproduce

```bash
pnpm build:engine
FORGEAX_RAY_EVIDENCE=/tmp/ray-evidence pnpm ci:graphics --probe dawn -- \
  pnpm exec vitest run --project dawn packages/render/src/__tests__/raytracing/query.dawn.test.ts
cargo test --manifest-path packages/rhi-wgpu-native/Cargo.toml --features reference
```

`ci:graphics` is explicitly the Linux software diagnostic lane. On a qualified
hardware machine run the same tests without that wrapper. Hardware Ray Query
requires a qualified native adapter; unsupported is a failure to qualify, never
an implicit pass. On that machine:

```bash
cargo run --release --manifest-path packages/rhi-wgpu-native/Cargo.toml \
  --features reference --bin ray-reference < native-input.json > native-result.json
```

Bring `native-result.json` back to the producer of `reference.rhitape`, then run:

```bash
node scripts/raytracing/compare-native.mjs /tmp/ray-evidence native-result.json
```

The Dawn fixture generates `native-input.json` from buffers read back at tape
work 0 and `portable-hits.bin` from its output. These are derived execution inputs
and readbacks; `reference.rhitape` is the canonical capture. The comparison emits
an adapter-qualified report, bounded first divergences and two GPU hit
visualizations. Images show barycentric queries, not material, PT or GI quality.
All identities and face values compare exactly; t/u/v use relative/absolute
`1e-4`. The CPU oracle is independently checked in the fixture.

## Inspect one query

`forgeax rhi inspect --artifact reference.rhitape --work-index 0 --json`
returns the bound resource IDs. Binding 2 is the ray input; binding 3 is the hit
output. Pass its ID to the same command with this `--buffer` JSON (replace the ID):

```json
{
  "resourceId": "buffer:REPLACE",
  "first": 0,
  "count": 8,
  "layout": {
    "stride": 32,
    "fields": [
      { "name": "identity", "offset": 0, "type": "u32", "components": 4 },
      { "name": "t_u_v_frontFace", "offset": 16, "type": "f32", "components": 4 }
    ]
  }
}
```

| Buffer | Stride | Byte offsets |
|:--|--:|:--|
| Triangles | 80 | 0/16/32: world xyz + pad; 48: instance/geometry/primitive/material u32; 64: mask + zero padding |
| BVH nodes | 48 | 0: min xyz; 12: escape index; 16: max xyz; 28: first triangle; 32: count; 36–44: zero padding |
| Rays | 48 | 0: origin xyz + tMin; 16: direction xyz + tMax; 32: mask + zero padding |
| Hits | 32 | 0: four u32 identities; 16: t/u/v/front-face f32 |

The regression corpus covers near/far overlap, intervals, offscreen geometry,
mask rejection, non-unit/parallel rays, rotations, negative/nonuniform scale,
multiple primitives, source mutation, empty scenes and explicit disposal. It
also overwrites the same output in work 1: all masks become zero. Inspecting work
0 must still recover the original hits, after the producer resources were disposed.
This is the falsifier against final-state or process-local replay shortcuts.

## Boundaries

- Opaque snapshot batches are opt-in Render internals, not a production Renderer feature.
- Native world-space AS rebuild is scene re-execution; native command capture, incremental
  AS update/lifetime replay and generic RHI hardware query support remain open.
- The query-only carrier does not evaluate materials or light transport. The separate
  shared-material path reference below adds those bounded capabilities; Lumen lighting remains open. MASK support belongs to the path reference below. The SDF/card milestone below adds unlit material capture.
- Device timings are not collected; shared-machine correctness runs are not benchmarks.

## Shared material and path reference

After `pnpm build:engine`, run the new carrier through the same backend routes:

```bash
FORGEAX_RAY_EVIDENCE=/tmp/ray-pt-evidence pnpm ci:graphics --probe dawn -- \
  node node_modules/vitest/vitest.mjs run --project dawn \
  packages/render/src/__tests__/raytracing/path-tracer.dawn.test.ts
node scripts/raytracing/visualize-path.mjs /tmp/ray-pt-evidence
```

The browser command prepares WGSL on Node through the compiler, then transfers
only cooked fixtures. The shared carrier compares texture/UV1/vertex-color
Surface values across raster and compute. The raster probe uses interpolated UVs
and an 8x4 `rgba32float` target: each row carries one Surface vec4, preserving
all 16 float lanes without fragment storage writes or elevated attachment limits.
The carrier also checks minified mip selection including rotated
anisotropic authored/physical UV scales, BSDF mixture
mass including null events, quadrature, one/two-bounce environment estimates,
analytic shadow falsifiers, indirect emitter hits and fresh replay. Dawn also
writes a 64×64, 128-spp gallery. PNGs use Reinhard plus sRGB solely for viewing;
`gallery-accumulation.bin` retains raw HDR, M2 and AOVs. Inspect the images before
making visual claims. No performance or UE quality parity is implied.

The warm capture contains two samples, with an ordered reset between them.
For one material and two bounces, work 1 is the first trace, work 2 its Surface,
work 7 the first accumulation (count 4), and work 15 the post-reset accumulation
(count 1). Original buffers are destroyed before replay; both outputs must match
the captured live bytes. The same CLI `--buffer` inspection used above applies:

| Buffer | Stride | Important byte offsets |
|:--|--:|:--|
| Hit input | 224 | 16: world xyz/t; 32: geometric normal/front; 64: outgoing/cone; 80–143: UV0–7; 144: vertex color; 160–191: UV footprints; 192: vertex normal; 208: material/valid/bounce/triangle u32 |
| Surface | 96 | 0: albedo/opacity; 16: normal/roughness; 32: emission/metallic; 48: F0/occlusion; 64: admission status u32; 80: oriented geometric normal |
| Path | 80 | 0: origin/cone; 16: direction/spread; 32: throughput/previous PDF; 48: radiance/error; 64: active/depth/RNG u32 |
| Accumulation | 80 | 0: HDR mean RGB; 12: sample count u32; 16: M2 RGB; 28: error u32; 32: albedo; 48: normal/depth; 64: identity u32 |

M2 divided by `count - 1` estimates sample variance; AOVs describe the most recent
primary sample, not a separately accumulated denoiser guide. The reference is
frozen per batch. Material/texture edits require a new batch, preventing stale
history; there is no hidden per-frame material export or automatic invalidation.

## SDF and material cards

```bash
FORGEAX_RAY_EVIDENCE=/tmp/ray-sdf-evidence pnpm ci:graphics --probe dawn -- \
  node node_modules/vitest/vitest.mjs run --project dawn \
  packages/render/src/__tests__/raytracing/sdf-cards.dawn.test.ts
node scripts/raytracing/visualize-sdf.mjs /tmp/ray-sdf-evidence
```

`SDF` here is software compute traversal on RHI, including on a physical Metal
GPU. It does not use hardware Ray Query. Cards use real mesh rasterization for
unlit material capture; this carrier does not produce direct or indirect lighting.

The cube fixture tape has six raster works, SDF work 6 and lookup work 7. Fresh replay checks
all four atlas planes and both outputs after producer disposal. A prefix falsifier
requires the sixth card to remain clear at work 0, then contain valid material at
work 5. Use the existing CLI summary/inspect with those work indices:

| Resource | Binding / layout |
|:--|:--|
| SDF hits at work 6 | Binding 3, stride 64: offset 0 u32 status/instance/geometry/material; 16 f32 t/world allowance/steps/pad; 32 world position; 48 normal. |
| Lookup at work 7 | Binding 2, `CARD_LOOKUP_STRIDE` (112 bytes): offset 0 u32 lookup status/SDF status/card/instance; 16/32/48/64 albedo-roughness, decoded shading normal-depth, emission-metallic, F0; 80 four u32 atlas texels; 96 four normalized f32 weights. Zero-weight slots have texel `0xffffffff`; unmapped/stale results have no support. |
| Card planes at work 7 | Bindings 3–6, depth32float at 7; each is a 48×32 atlas in the default cube fixture. Flattened order is +X, −X, +Y, −Y, +Z, −Z; derive columns from atlas width / card resolution. |

The corpus includes 1,024 diagnostic rays plus hit/miss/inside cases, transforms,
masks, missing fields, step exhaustion, nearest-instance removal, stale capture
keys, an enclosed cavity captured by multiple depth layers, and UV1/vertex-color parity
with ray-hit Surface. CPU tests cover thin-solid rejection/recovery and cooked
artifact/LKG integrity. None of these replaces full Browser/Dawn/300-frame smokes.

The same suite verifies open sheets, both sides of a thin sheet, shared MASK
discard, mixed per-source card counts and empty atlas padding. Geometry layouts
are explicit cook inputs; ordinary Catalog publication and Sponza SDF admission
are still separate work.

For a frozen imported scene, `gltf/prepare.mjs <input> <gltf> --cards` adds
offline layouts and shared capture programs. With the existing diagnostic Vite
server and dedicated browser configured through `FORGEAX_RASTER_CDP` and
`FORGEAX_RASTER_REPLAY_URL`, run:

```bash
node scripts/raytracing/gltf/check-cards.mjs <input> <output> [resolution=32] [sdf-probes]
node scripts/raytracing/gltf/check-cards.mjs <input> <identity-output> [resolution=32] --identity
node scripts/raytracing/gltf/replay-cards.mjs <output>
node scripts/raytracing/gltf/check-card-cost.mjs <input> <output>/cost.json [sdf-probes] [resolutions=32,64]
```

Capture saves the tape in bounded transfer chunks before independent-page
replay. Replay compares all material/depth bytes and checks no-work/prefix
falsifiers. Whole-mesh layouts use the ordinary glTF card producer; each material
section competes in every card's depth attachment. Cost records complete static
recapture timestamps with recording disabled, separately from CPU submission;
it is neither incremental-cache cost nor frame FPS.

`--identity` instruments the cooked Card shader to record the actual raster
triangle. It replaces `emissionMetallic` RGB with three little-endian bytes of
the section-local primitive index; alpha is the one-based index into
`capture.json#identitySections` (zero means no coverage). Integer channels are
exact in f16. This diagnostic refuses `sdf-probes`: its rewritten attachment
must not feed lighting. It requires exactly one occurrence of each shader edit
site, captures all five attachments, and compares every byte on fresh-device
replay. `capture.json#artifacts` hashes the tape and raw attachments. Compare the
four untouched attachments against the original capture before attributing a
boundary difference to primitive selection; matching depth alone is insufficient.

Capture accepts 8..512 pixels per card under the existing 256 MiB attachment
budget; owned buffers are additional. The cost resolution list runs forward
then in reverse order, with three warmups and 12 samples per batch. For example,
`64,256` compares two explicit scales without changing the default capture.

Optional `sdf-probes` is a directory produced by the SDF probe preparation route
(`probes.json` plus its frozen rays and fields). Capture appends each production
SDF query and Card lookup after raster capture. It saves `chain-<section>-hits.bin`
and `chain-<section>-lookup.bin`, records their resource/work identities, destroys
the source device and requires byte-exact fresh-device replay. `replay-cards.mjs`
still verifies the atlas planes separately. Cost runs the same chain with recording
disabled and reports query and lookup pass timestamps independently from raster
recapture; none of these pass durations is complete-frame cost.

`bun scripts/raytracing/gltf/inspect-card-chain.mjs <capture-output>` checks the
production lookup shader, tape/work identities, per-card texel bounds, material
validity and normalized support, then independently reconstructs weighted material
channels from the actual atlas. It reads projection/settings from immutable tape
seeds and checks the selected taps against silhouette, geometric normal and depth
constraints, then reconstructs the weighted shading normal and depth independently.
Its `lookup-inspection.json` preserves every ray's four indices/weights, world-space
depth errors, tolerance components and separately reported f32 boundary slack.
Each tap's `samplePosition` reconstructs its world position from the actual atlas
texel center and raster depth; `geometry.samplePosition` is their weighted
centroid. Compare these with an independent first-hit reference to locate wrong
surface associations. The centroid may lie between surfaces and does not prove
material identity. Neither the query position nor a green mapping count provides
that correspondence check.
Passing means the selected support satisfies the current sampler policy; coarse
Cards can still admit a different surface. It does not establish candidate-selection,
geometric first-hit or GI correctness. Run the inspector fault controls with
`pnpm exec vitest run --config scripts/vitest.fx.config.ts scripts/__tests__/raytracing-card-support.test.ts`.
The three-case Browser/Dawn sampling fixture uses actual raster texels and known
surface positions to isolate a red/blue seam, missing geometry and separated
depth. An adjacent green atlas tile detects cross-card sampling. This is filtering
within one selected card; multi-card radiance weighting remains a separate step.

The Browser/Dawn `visibility-cards.fixture.ts` and its Metal carrier reduce the
zero-allowance lookup failure to one asymmetric card. Nine real sampled SDF hits
must map; injected silhouette, depth and orientation faults must stay unmapped.
This protects the raster/query/lookup seam without relaxing the distance policy.

For one rigid imported mesh instance, use the ordinary raster capture with
`surfaces=1` and `replay-raster.mjs --stages` to qualify primary visibility,
including fragments that survive the material's alpha test:

```bash
bun scripts/raytracing/gltf/inspect-raster-card-coverage.mjs <input> <card-output> <raster-output> <diagnostic-output> [frame=baseline]
bun scripts/raytracing/gltf/inspect-raster-card-coverage.mjs <input> <card-output> <raster-output> <control-output> [frame=baseline] --no-cards
```

The inspector checks the frame's retained draw ranges, source geometry and
geometric normals, material/capture keys, atlas-plane digests and fresh-device
replay. It samples the real GPU atlas on CPU, publishes separate MASK counts,
and writes per-pixel mesh/primitive/card provenance with the last candidate
capture `workIndex`. The report lists every section draw touching each card;
that last-work replay boundary does not identify the winning material at every
texel. Pipeline labels retain mesh, section index range and material identity. Removing all
cards must leave the same raster coverage and zero mapped pixels. The explicit
single-mesh join rejects other scene shapes; it is an offline diagnostic, not
a general Renderer scene correspondence or SDF/GI coverage gate. Use separate
output directories for views, resolutions and controls.

Add `--bilinear` to compare four taps within each card against the default nearest
sample. Only valid, normal/depth-qualified tap weights are normalized; the original
thresholds and card choice remain fixed. This isolates a sampling difference from
UE's `SampleLumenCard`, not its full radiance policy. The report includes linear
albedo error on mapped receivers; primary footprint/quantization differences and
unmapped pixels prevent treating that number as GI accuracy. Keep the raw atlas
and nearest result alongside any filtered view.

Images: `sdf-slice.png` shows signed local distance (warm inside, blue outside,
yellow surface); `sdf-status.png` shows miss/band diagnostics; `card-mapping.png`
uses green mapped and magenta unmapped. Card plane PNGs visualize raw unlit data,
with oct-normal decoding and emission tonemapping only for display. Preserve `.bin`
and `.rhitape` bytes for quantitative inspection.

## Diffuse GI

The opt-in frozen carrier uses the same Standard material in real primary raster,
material cards and the separate exact-hit PT reference. It needs cooked kernel
WGSL and material programs; the test command prepares them on Node and transfers
only data/programs to the browser. After `pnpm build:engine`:

```bash
FORGEAX_RAY_EVIDENCE=/tmp/ray-gi-evidence node scripts/ci/local-graphics.mjs --probe dawn -- \
  node node_modules/vitest/vitest.mjs run --project=dawn \
  packages/render/src/__tests__/raytracing/diffuse-gi.dawn.test.ts
node scripts/raytracing/visualize-gi.mjs /tmp/ray-gi-evidence
```

| Buffer | Byte layout |
|:--|:--|
| `field`, `reference` | Stride 80: direct vec4 at 0, D at 16, visible Rd at 32, linear beauty at 48, u32 status/gather-kind/iteration/pad at 64 (gather-kind 1 probes, 0 local tracing). Status 0 background, 1 complete, 2 incomplete, 3 invalidMaterial. |
| `surface` | Stride 64: seed at 0, transport rho at 16, outgoing radiance at 32, u32 status/iteration/pad/pad at 48. This is the final finite generation, not a convergence assertion. |
| `probes` | Stride 32: radiance plus ray distance at 0; u32 completeness/SDF-state/instance/pad at 16. |

The last two GPU works produce field/reference, binding 7. At those works,
binding 4 is the consumed surface generation and binding 6 the world samples.
Use `forgeax rhi summary/inspect` to obtain actual work indices; never
hard-code indices across scene sizes/iteration counts. The carrier verifies
four buffers after producer disposal on a fresh device and proves the field
buffer is still zero immediately before its gather. Raw bytes are authoritative;
PNG uses display mapping, and magenta explicitly marks incomplete/invalid data.

The offscreen red reflector is outside the raster view, and the visible wall has
zero analytic direct lighting. The 512 spp exact-triangle PT bypasses SDF, cards
and probes. Constant environment, pure metal, light toggles, camera crop,
point/spot shadow, a closed partition and missing representations are separate
gates. Complex enclosed feedback is a diagnostic failure corpus, not product GI
acceptance. None replaces full Browser/Dawn and the 300-frame hello/learn roster.

## Normal frame and normal-map regression

The path-tracer Browser/Dawn suite also runs a mirrored smooth-normal mesh with
an authored normal map and omitted `normalScale` (canonical default `[1, 1]`).
It requires 64 primary hits, geometry-only origin offsets, two mapped SDF/card
hits despite strongly tilted shading normals, and stale capture after a normal
edit. Missing authored normals/tangents must refuse normal-map admission.

`normal-frame.rhitape` contains 14 works: PT 0–4, cards 5–10, SDF 11, lookup 12,
and stale lookup 13. After producer disposal, fresh replay compares input, Surface,
path and lookup bytes. Depth at work 5 must be clear in the later +Z tile, and
written at work 10. The shared Surface probe independently checks decoded normal
values, tangent handedness, explicit scale, minification and transformed UVs.
BSDF quadrature checks tilted/grazing frames and keeps rejected hemisphere samples
as null probability; these are opaque radiance-mode checks, not adjoint transport.

## Runnable GI scene

After `pnpm build:engine`, prepare once and open the interactive scene:

```bash
bun scripts/raytracing/scene/prepare.mjs artifacts/ray-gi-scene
node scripts/raytracing/scene/serve.mjs artifacts/ray-gi-scene
# Open http://127.0.0.1:5196/ in a WebGPU browser.
```

The controls rebuild one complete snapshot. Direct-only, GI and independent PT
share all scene inputs and the Engine output transform. The GI image uses a
raster primary view and SDF visibility; it is not a path-traced beauty. PT uses
exact triangles, two bounces and the same authored Standard materials. Both
include one indirect surface reflection in this fixture. Indirect-only and
coverage stay separate. Pink coverage means incomplete; a plausible beauty
pixel is not evidence that its representation is complete.

| Evidence | Command / output |
|:--|:--|
| Dawn images, raw HDR and fresh-device byte equality | `node scripts/ci/local-graphics.mjs --probe dawn -- node scripts/raytracing/scene/run.mjs artifacts/ray-gi-scene '{"resolution":256,"samples":128}'` |
| Browser controls and fresh replay, with the server above running | `node scripts/ci/local-graphics.mjs --probe browser -- node scripts/raytracing/scene/check-browser.mjs artifacts/ray-gi-scene-browser` |
| Capture | Browser download button or `scene.rhitape`; `report.json` records digest and actual work count |
| Reproduction | `prepared.json`, raw `.bin` files, `report.json` and `replay.json`; PNGs contain GPU display readback |

This is a seven-instance room to expose lighting behavior. It does not close
full Sponza integration, MASK, screen traces, reflection, incremental scene
updates or production Renderer/RenderGraph ownership. SDF bias, contact errors,
remaining unmapped samples and probe/local fallback seams remain visible and
measurable. Local software GPU results establish correctness, not hardware FPS.

## Complete imported Sponza reference

The reference now records its transport stages through `addSampleToGraph` by
default. `renderGltf(..., { graphOwned: false }, ...)` retains the same stage
sequence as a direct-encoder comparison. Both are frozen reference inputs, not
the ordinary raster Renderer GI route.

With the prepared-data server running, `gltf/check-graph.mjs <evidence-dir>`
connects through `FORGEAX_RASTER_CDP` and loads `FORGEAX_GLTF_URL`. It compares
all raw accumulation and display bytes for one/two-bounce Sponza, replays both
buffers and displays on a fresh device, and checks that light-off is zero.
The report retains the graph declarations, real images, tape digest and serial
sample timings. Four samples at 64 squared are a correctness workload; the last
sample is captured. These timings are not production frame performance.
Large tapes use lossless gzip/base64 only during transfer, and the decoded tape
must match the recorder digest before replay evidence is accepted.

```bash
pnpm build:engine
bun scripts/raytracing/gltf/prepare.mjs artifacts/ray-sponza
node scripts/ci/local-graphics.mjs --probe dawn -- \
  node scripts/raytracing/gltf/run.mjs artifacts/ray-sponza \
  '{"resolution":128,"samples":2}'
node scripts/raytracing/gltf/serve.mjs artifacts/ray-sponza
# Open http://127.0.0.1:5197/ in a WebGPU browser.
node scripts/ci/local-graphics.mjs --probe browser -- \
  node scripts/raytracing/gltf/check-browser.mjs artifacts/ray-sponza-browser
```

The file carrier uses the glTF mesh/material producers and original images,
including full mip chains. It retains all 103 instances, 262,267 triangles, 25
materials and 69 images; three materials use MASK. One zero-area triangle remains
inactive, and the importer repairs 26 undefined tangent vertices. Source and image
hashes plus texture GUIDs live in `prepared.json`. The optional third prepare
argument selects another external-image glTF with its existing Meta; unsupported
deformation, instancing and sparse UV slots fail explicitly.

Both images trace exact triangles: one bounce gives direct lighting, two add one
indirect surface bounce. Same camera, materials, lights and exposure; neither
image is SDF/probe GI, hardware Ray Query or the ordinary Renderer. Sampling noise
and finite bounce bias remain visible. The portable reference is limited to
262,144 pixels, so use resolutions up to 512. These are admission bounds, not a frame-time guarantee.

`report.json` requires zero invalid/incomplete samples. `sponza.rhitape` captures
the last sample over seeded warm accumulation; `replay.json` compares the final
two GPU display readbacks after destroying the producer device. Four unseeded
staging buffers are destinations of captured readback copies, not missing scene
inputs. PNGs are Engine display readbacks; `.bin` files retain HDR/count/error/AOV
records. The browser checks both views, fresh replay, zero radiance with sun/sky
off, and rebuilding the same full scene from the side aisle.

MASK candidate order is `(distance, ordered triangle index)`, never a tMin epsilon
step. Up to 64 candidates cover primary/secondary/shadow rays; exhaustion is an
invalid sample. The GPU regression includes cutoff equality, coplanar/near layers,
secondary holes, shadow holes and deliberate exhaustion. Coverage buffer binding 9
has stride 384: saved input at 0, saved Surface at 224, origin at 320, direction at
336, contribution/cursor distance at 352, and u32 state/triangle/light at 368.

Sponza attribution: Crytek / Frank Meinl, Morgan McGuire, Alexandre Pestana and
Khronos Group, CC BY 3.0. See the source asset `ATTRIBUTION.md`.

### Stage gates before integrated GI

The product route uses the existing raster primary view, direct lighting and
shadows, then adds traced indirect lighting/reflections. The reference above
traces the whole image only to test query/material contracts; its beauty is not
acceptance for that product route. Surface-cache lighting may use traced
visibility internally without replacing the visible pixel's raster direct light.

```bash
node scripts/ci/local-graphics.mjs --probe dawn -- \
  node scripts/raytracing/gltf/inspect-stages.mjs artifacts/ray-sponza
```

The inspector derives work indices from the tape and replays generation, resolved
primary candidates/Surface, analytic shadow begin/end and primary AOV stages on a
fresh device. It checks normalized rays, hit-position reconstruction, original
material/triangle IDs, valid unit Surface normals, visibility-gated radiance deltas
and background identity. `stages.json` and `stage-*.bin` retain selected raw data;
the tape remains authoritative. A dedicated MASK-to-background regression refuses
stale triangle IDs even when the beauty is already black.

Advance the product gates separately: (1) Sponza raster color/direct-shadow/depth/
normal/material baseline, (2) sparse GI ray inputs, (3) hit/coverage and shared
material parity, (4) one indirect contribution with known blockers and light-off
counterfactuals, (5) indirect-only then additive composition. Screen continuation,
SDF/hardware alternatives, caches, probes and history follow those gates. Small
reference passes and a complete PT image do not close these product stages.

### Sponza raster and sparse receiver gates

The ordinary App/Pack/GUID route has a separate direct-light baseline:

```bash
FORGEAX_SHARED_APP_INPUTS_MANIFEST="$PWD/shared-build-inputs/manifest.json" \
  node scripts/raytracing/gltf/serve-raster.mjs
node scripts/raytracing/gltf/check-raster.mjs artifacts/sponza-raster/controls-384 384 --controls
node scripts/raytracing/gltf/replay-raster.mjs artifacts/sponza-raster/controls-384 baseline --stages
node scripts/raytracing/gltf/replay-raster.mjs artifacts/sponza-raster/controls-384 shadows-off --stages
node scripts/raytracing/gltf/compare-raster.mjs artifacts/sponza-raster/controls-384 --stages
```

The receiver frame is Standard Deferred with IBL/AO disabled. Original glTF
materials now provide their Deferred and ShadowCaster passes. The capture
contains the actual shadow producers, five G-buffer attachments, lighting and
output. Raw `Renderer.observe` bytes bind the HDR/display checks to the exact
App-owned frame receipt. Canvas PNG export changes premultiplied-alpha bytes and
is a visual artifact, not the byte-equality oracle.

| Gate | Required evidence |
|:--|:--|
| Raster visibility/materials | Work-index-selected depth, normal, reflectance, emission and view UBO; lighting reads the same attachments |
| Direct-light ownership | Sun off gives exact zero HDR; shadows off changes light while preserving every material/depth attachment; restoring inputs restores HDR exactly |
| Replay | Fresh browser HDR/display byte equality; each unseeded resource has a captured initializing clear/write/copy before consumption |
| Sparse rays | Captured depth-to-world-to-pixel round trip, explicit rejected samples, independent f64 hit checks and fresh replay despite later output overwrite |
| Hit materials | External initial rays use the existing Standard Surface, 64-candidate MASK resolution, normal maps, original textures and explicit cone footprints |

After preparing the original scene, continue one stage at a time:

```bash
bun scripts/raytracing/gltf/prepare.mjs artifacts/sponza-hybrid
node scripts/ci/local-graphics.mjs --probe dawn -- \
  node scripts/raytracing/gltf/sparse-raster-rays.mjs
node scripts/ci/local-graphics.mjs --probe dawn -- \
  node scripts/raytracing/gltf/trace-raster-rays.mjs
```

The sparse gate initially reports opaque MASK **candidates**, not resolved
surfaces. Receiver validation retains raster primary coverage. Its offline
triangle/depth witness models the measured SwiftShader 1/16-pixel vertex grid;
it is a diagnostic for these captured frames, not a production visibility
buffer or a backend-independent raster rule. The narrow geometry query and
rare CPU witness search must eventually be replaced by Renderer-owned visible
surface identity before claiming production integration. Secondary and shadow
rays still evaluate the shared MASK material normally. Keep those boundaries
explicit when publishing images or progressing to dense gather.

### One indirect contribution and additive composition

The reference tracer also accepts an exclusive `settings.rays` source instead
of a camera. Each immutable ray carries origin, unit direction, cone width /
spread and activity. Inactive directions contribute zero while retaining their
sample probability. Input bytes are frozen before asynchronous shader creation;
reset and sample generation remain ordered GPU work.

For denser diagnostics, use the same captured frame with a six-pixel grid and
16 cosine directions (at most 65,536 opaque query rays):

```bash
node scripts/ci/local-graphics.mjs --probe dawn -- \
  node scripts/raytracing/gltf/sparse-raster-rays.mjs \
  artifacts/sponza-raster/controls-384 artifacts/sponza-hybrid artifacts/sponza-hybrid/dense-rays 6 16
node scripts/ci/local-graphics.mjs --probe dawn -- \
  node scripts/raytracing/gltf/trace-raster-rays.mjs \
  artifacts/sponza-hybrid artifacts/sponza-hybrid/dense-rays artifacts/sponza-hybrid/dense-hit
node scripts/ci/local-graphics.mjs --probe dawn -- \
  node scripts/raytracing/gltf/gather-raster.mjs \
  artifacts/sponza-raster/controls-384 artifacts/sponza-hybrid \
  artifacts/sponza-hybrid/dense-rays artifacts/sponza-hybrid/dense-hit artifacts/sponza-hybrid/gather
```

`gather-raster` is an offline GPU carrier, not a Renderer feature. One output
pixel represents one selected raster pixel, with no interpolation or denoising.
It decodes the G-buffer's sqrt-encoded albedo and linear metallic, and applies
the shared Standard Lambert term: `indirect = (1-metallic)*baseColor*mean(Li)`.
The cosine PDF cancels `pi`; null directions stay in the denominator. This
qualifies diffuse transport only, with no extra receiver Fresnel attenuation,
AO, specular bounce, environment or light-cache feedback.

Direct HDR remains byte-identical throughout gather controls. GI-off, black
receiver and hit-light-off each remove the indirect contribution; restoring the
inputs restores all raw and displayed bytes. `hit-light-off` changes secondary
lighting only, retaining the frozen raster baseline. Every gather and display
is replayed by work index on a fresh device after the producer is destroyed.
`direct`, `indirect` and `gi` PNGs share the existing Reinhard/output transform at
exposure one. Raw linear values, not PNG subtraction, validate additivity.

`coverage.png` marks qualified receivers green, rejected depth edges magenta,
unresolved triangle witnesses yellow and background black. Unresolved receivers
remain explicit missing indirect coverage and retain raster direct lighting;
their rays must be inactive with zero contribution. A near-origin hit is accepted
only when it belongs to a different triangle and independent f64 intersection
confirms its identity/distance. These diagnostics do not qualify the missing
screen trace, SDF/hardware continuation, cache, temporal or production ownership.

### Visible-surface diagnostics

Enable `surfaces=1` on the ordinary glTF raster page. The capture contains the
receipt-bound `visible-surface` native bytes and matching 64-byte identity rows.
`node scripts/raytracing/visualize-surfaces.mjs <raw> <width> <height>` generates
row, draw-local primitive, geometric-normal and front/back coverage panels plus
a raw digest and coverage census. These are surface diagnostics, not GI images.

`check-raster.mjs` accepts `FORGEAX_RASTER_URL` and an optional
`FORGEAX_RASTER_CDP` for an existing owned browser. `--observe-only` isolates
Renderer readback without a tape; it cannot establish replay correctness.
`--benchmark` requires `timings=1` and retains partial GPU observations alongside
serial step-to-completion samples. The default still captures a full tape;
remote capture uploads it through the existing raw-tape Vite endpoint.
The upload uses a Blob, matching DevKit's capture path; passing a large raw
typed array as the Fetch body crashed Chrome during a 411 MiB Sponza transfer.
`replay-raster.mjs --stages` accepts the same owned `FORGEAX_RASTER_CDP` and
`FORGEAX_RASTER_REPLAY_URL`. It reads each G-buffer attachment at its producing
work and requires exact live/replay equality for HDR, display, and the optional
visible-surface target. Resource labels in the tape retain the producer's names.

### Visible-surface history and debug cost

The ordinary Renderer fixture in `packages/runtime/src/__tests__/visible-surface-replay.fixture.ts`
checks independent normals, shared MASK, instance removal/reseeding/motion/stop,
material edits, analytic camera motion, submit retry, recovery and loss during a
real mapped observation. Its motion tape replays the submitted previous-frame
inputs on a fresh device; a new device does not inherit live history.

For serial frame-cost comparison, launch `gltf/serve-raster.mjs` with
`FORGEAX_RASTER_RHI_DEBUG=0` to omit the recorder/plugin, on a separate
`FORGEAX_RASTER_PORT`. The default installs it. Run `gltf/check-raster.mjs`
with `--observe-only --benchmark`, selecting the server and `surfaces=0/1`
through `FORGEAX_RASTER_URL`. Measurement happens before any capture readback;
the report records recorder presence and Renderer observation allocation/map
counts. Without `timings=1`, only submission-to-completion latency is measured
and GPU timing is `not-requested`; with it, retain complete/partial GPU statuses.
Compare matched scene, device, resolution, warmup and samples. This serial
latency is not production FPS, and recorder cost is separate from surface cost.

### GPU raster receiver diagnostics

The internal `createRasterRayGenerator` records receiver generation from actual
single-sample depth, packed Standard shading normal and visible
identity attachments. The caller supplies the matching View uniform and exact
64-byte frame-row range; spare buffer capacity is excluded. Output is one
80-byte initial PathState per texel, directly consumable by the reference
transport as unit-receiver `D = E/pi`. Receiver albedo is deliberately absent;
apply material response once after D filtering. All resources and command submission stay with the caller. This is
a qualified low-level producer, not yet an ordinary Renderer GI installation.

The Browser/Dawn `raster-source` fixture writes eight receivers with a real MRT
draw. It checks background, stale-row capacity, primitive bounds, flags,
geometric-hemisphere null events and invalid depth. Colored and metallic
receivers both preserve `D = L` under constant incident radiance.
A second dispatch deliberately binds the wrong output extent. The actual
transport must reject invalid input without advancing the accepted sample count;
background/null retain their defined zero contribution. Metal
receiver response becomes zero only in the later material composite. Fresh-device RHI
Debug replay checks the attachment bindings, producer rows and accumulation.

```bash
FORGEAX_RAY_EVIDENCE=artifacts/raster-source \
  pnpm exec vitest run --project=dawn --retry=0 \
  packages/render/src/__tests__/raytracing/raster-source.dawn.test.ts
node scripts/raytracing/visualize-receivers.mjs artifacts/raster-source 8 1
```

Use the CI/local-graphics environment preparation documented in the CI guide
when a software backend is needed. `receivers.png` has three rows: producer
reason, direction XYZ mapped from [-1,1], and unit-receiver throughput [0,1]. The
JSON retains the exact palette, counts, bounded selected rays, input digest,
tape digest and work/resource identities. Green means active, blue a valid
hemisphere null, magenta invalid row/primitive, yellow invalid flags, orange
invalid depth/position, white extent mismatch and dark grey background. This
view displays captured data; it does not generate a second receiver solution.

### Accepted texture lifetime

The `submitted-textures` GPU fixture retains accepted texture allocations, replaces
residency during asynchronous shader preparation, and releases the old allocation
after tracked GPU completion. It also exercises duplicate leases, partial preparation
failure and eviction. The original 2-pixel MASK response remains `[0, lit]`,
`[lit, lit]`, `[0, lit]` as cutoff changes `0.5 -> 0 -> 0.5`.

```bash
FORGEAX_RAY_EVIDENCE=artifacts/submitted-textures \
  pnpm exec vitest run --project=dawn --retry=0 \
  packages/render/src/__tests__/raytracing/submitted-textures.dawn.test.ts
node scripts/raytracing/inspect-submitted-textures.mjs artifacts/submitted-textures
```

The inspector follows actual Surface texture bindings to their backing textures,
checks captured destroy ordering after submission, and verifies complete captured
initialization. `lifetime.json` retains exact work/event IDs, radiance and the tape
digest. `mask-readback.png` scales the raw two-pixel, three-state output; it is a
linear diagnostic clipped to `[0,1]`, not a scene image. Driver allocation and
retirement scheduling are not inferred from tape events. Browser/Dawn fresh-device
replay and live completion assertions provide the complementary runtime proof.

## Ordinary Renderer diffuse GI

The Standard `diffuseGi` profile installs the shared raw-D transport in the ordinary
frame graph. Direct lighting remains rasterized; no scene-specific material or
application render pass is involved. See the Render package contract for admission
limits and preparation/error behavior.

```bash
pnpm build:engine
pnpm ci:graphics --probe dawn -- pnpm exec vitest run --project=dawn \
  packages/runtime/src/__tests__/renderer-diffuse.dawn.test.ts --maxWorkers=1
```

The Browser fixture explicitly skips without `primitive-index`; that outcome is
not GPU acceptance. The fixture saves real direct/indirect/source-off HDR, raw D,
a canonical tape and fresh-device replay inspection. It exercises offscreen
emission, removal, black receiver, failed submit, accepted content changing before
submission, resize, delayed retirement and host-injected device replacement.

For Sponza use the existing `gltf/serve-raster.mjs` host and a dedicated qualified
browser. Set `FORGEAX_RASTER_CDP` and optionally `FORGEAX_RASTER_URL`, then run
`node scripts/raytracing/gltf/check-diffuse.mjs <output> [--capture-tape]`.
It records paired controls and 2 warmup + 10 serial App-step-to-GPU-completion
samples per mode. This latency is not isolated GPU timing or steady-state FPS.
The default 64² image is a staged diagnostic, not a production quality target.

### Diffuse reconstruction diagnostics

`diffuseGi.reconstruction` selects `spatial`, `temporal` or `combined`; omission
retains raw D. The raw ray budget and sample/error rows remain unchanged. The
ordinary Renderer fixture covers both raw and combined modes; the independent
`diffuse-reconstruction` Browser/Dawn fixture exercises hard tap rejection,
valid zeros, moments, bounded weights and a missing-history replay falsifier.

`gltf/check-reconstruction.mjs <output>` uses the same Sponza App and records
Renderer-owned raw, temporal/display and diagnostic buffers after completed
submissions. `--quick` records 24 combined frames for transport diagnosis; it is
not quality acceptance. The full run fixes four 64-frame trial seeds and two
disjoint 512-sample raw references. Use the report's predeclared MSE/bias criteria;
readback timing is excluded from performance measurements.

Use `scene=room` in `FORGEAX_RASTER_URL` for the independent authored room;
it uses the same glTF importer, Standard materials and Renderer as Sponza.
`--motion` records a 64-frame translation/rotation, large movement and return
sequence, including poses and selected canvas images. It is separate from the
static quality measurement. Run `gltf/compare-reconstruction.mjs <output>` on a
full static run to enforce equal raw inputs and the predeclared MSE/bias limits.
When changing only reconstruction, `--reuse-raw <prior-output>` reuses measured
reference/control streams after matching camera, light, scene and extent;
the comparator still requires every new reconstructed raw frame to match its
original control byte for byte. Retain both source snapshots and the reuse receipt.

After capturing a reconstructed ordinary frame, `gltf/inspect-diffuse.mjs` reads
the production raw/temporal/display signal, moments, history weights and rejection
bits at the captured work bindings. A portable Dawn route is:

```bash
pnpm ci:graphics --probe dawn -- node scripts/raytracing/gltf/inspect-reconstruction.mjs \
  <capture.rhitape> <output>
```

It emits raw buffers, per-view PNGs and an inspection JSON with resource/work IDs.
Views include previous history, raw, temporal, display, weight, support, rejection
and luminance deviation. Stage energy and valid-pixel counts expose dark bias even
when support and history weights look healthy.
D views use `D/(1+D)` and gamma 2.2 for inspection, not the scene's beauty transform.
Weight white means 16 effective history frames; support white means 25 admitted
spatial taps. Rejection colors are green for historical support, red for a valid
current sample without historical support, blue for invalid current input; bit
counts retain all causes. Read initialization lineage and live/replay equality
alongside these images before judging them.

For hardware cost use the same raster host with `timings=1`: its explicit
2048-pass budget covers the exact-query reference graph. Only `complete` timing
may be summed; App-step completion latency and GPU pass cost remain distinct.
Start the host with `FORGEAX_RASTER_RHI_DEBUG=0` and run
`gltf/check-reconstruction-cost.mjs <output>` against `resolution=384&surfaces=1&timings=1`.
It requires the recorder to be absent, measures raw/combined in ABBA order with
2 warmup plus 20 samples per batch, retains every pass and checks the declared
5 ms reconstruction / 15% median App-step / 256 bytes-per-texel bounds. These are
acceptance targets; a completed script without a passing report is not acceptance.

### Lite reflections

`diffuseGi.reflections` adds a dedicated world-traced specular ray per texel and
composes it before SSR. The ordinary-frame Dawn fixture covers raw and combined
modes:

```bash
pnpm ci:graphics --probe dawn -- pnpm exec vitest run --project=dawn \
  packages/runtime/src/__tests__/renderer-reflections.dawn.test.ts --maxWorkers=1
```

It checks that a mirror sees an emitter behind the camera at the path-tracer radiance
times a quadrature GGX albedo, that glossy and rough receivers spread the band, that a
matte occluder removes it (leak falsifier), that SSR misses keep the same value, and
that the composite equals the SSR fallback (single count). It also records
`ray-*` GPU pass timings, the tape, and replay equality with a missing-composite
falsifier. Evidence goes to `FORGEAX_RAY_EVIDENCE` (default
`artifacts/raytracing/lite-reflections/dawn`).

### Distance-field admission audit

Run `bun scripts/raytracing/gltf/audit-distance-fields.mjs <source.gltf> <output>`
to cook each parsed triangle section at resolution 24 using its source material's
`doubleSided` policy. The report retains every rejection, CPU cook time, bytes,
field digest and 64 distance samples checked by exhaustive triangle distance.
Successful fields round-trip through the checked binary decoder. No rejection
is converted into a two-sided proxy. This is a CPU representation audit; it does
not establish GPU world coverage, alpha-qualified geometry or GI quality.

The `sdf-cards` Dawn/Browser tests also query a loaded zero-thickness field from
both sides, map actual material cards, and compare hit/lookup bytes on a fresh
RHI Debug replay device. `FORGEAX_RAY_EVIDENCE=<dir>` on Dawn retains
`two-sided.rhitape`, the raw outputs and measured error/status counts.

For imported geometry on a qualified browser, reuse the prepared `cards.json`
and admitted field directory. Geometry digests must match; the script never
substitutes a field from a different mesh. Set `FORGEAX_RASTER_CDP` and
`FORGEAX_RASTER_REPLAY_URL` to the dedicated browser and served replay page.

```bash
bun scripts/raytracing/gltf/prepare-sdf-probes.mjs <cards.json> <field-directory> <probes>
node scripts/raytracing/gltf/check-sdf-probes.mjs <probes> <gpu-output> 256
bun scripts/raytracing/gltf/inspect-sdf-probes.mjs <cards.json> <probes> <gpu-output>
```

The query command's optional final argument is `clearance` (default) or
`ray-distance`. Use both on the same frozen inputs to measure the diffuse versus
reflection expansion tradeoff. The report and captured settings retain the
choice; neither choice changes geometry, caller origins or the step budget.

To isolate an unexpected first hit, select up to eight ray indices from one
prepared probe row and its frozen 64-byte hit rows:

```bash
node scripts/raytracing/gltf/trace-sdf-prefixes.mjs <probes>/section-0.json <gpu-output>/section-0-hits.bin <new-output> 12,24 512 clearance
```

This runs the production shader unchanged and varies only its existing step
budget. The full-budget result must equal the frozen bytes before capture;
the final optional argument selects the same expansion policy as that capture.
every prefix is then read back and replayed on a fresh device. Input hashes,
work indices, tapes, raw outputs and native validation errors stay with the
report. The output directory must be new, preserving failed runs. A budget-stop
position identifies the next sample; a hit position already includes pullback.
These prefixes explain traversal, not geometric correctness or performance.
Compare them with field samples and the independent triangle reference before
changing bias, expansion or coverage policy. Shader instrumentation can change
floating-point behavior and must prove equivalence before replacing this method.

Each admitted section has six 32-square views and a zero-mask control. The
inspector compares exact triangle intersections and world-space surface distance,
retains expanded-only occlusion separately, and rejects missed intersections,
out-of-band hits or unresolved normal-budget rays. `status.png` uses green for
exact-hit coverage, orange for expanded-only hits, purple for incomplete queries
and red for missed exact intersections. `distance.png` shows distance divided by
the returned band. These are isolated-section geometry diagnostics, without
alpha testing, inter-section visibility or GI qualification.

RHI Debug saves one tape, per-work output IDs, exact fresh-device replay and a
zero-work control. An independent device measures 24 samples after three warmups
with recorder disabled; GPU times sum dispatches only. A one-step query must
expose budget exhaustion. The optional step argument defaults to 128 and accepts
the Engine's existing 1..1024 range; increasing it is an experiment, not a change
to the Engine default or permission to widen the surface band. Retain failed
budget runs alongside successful ones. CPU zero-time samples remain below timer
resolution, and variable GPU maxima are not a frame-rate guarantee.

## World distance-field composition

The internal producer composes known local mesh fields and retains missing
bounds in one frozen world region. It is a software compute pass, including on
Metal. It does not perform hardware Ray Query or produce a lighting image.

```bash
FORGEAX_RAY_EVIDENCE=/tmp/global-sdf pnpm ci:graphics --probe dawn -- \
  node node_modules/vitest/vitest.mjs run --project dawn \
  packages/render/src/__tests__/raytracing/global-sdf.dawn.test.ts
bun scripts/raytracing/gltf/prepare-global-sdf.mjs <cards.json> <field-audit-directory> <input> 0.5
node scripts/raytracing/gltf/check-global-sdf.mjs <input> <output>
bun scripts/raytracing/gltf/inspect-global-sdf.mjs <input> <output>
```

The imported-scene commands reuse the existing raster replay server/CDP variables
and built package outputs. `cards.json` supplies geometry IDs and transforms;
the field audit must cover every input geometry. Only digest-checked, decoded
field artifacts enter the producer. Refused fields keep their actual bounds.
The available-only and zero-mask cases are explicit controls, not a production
fallback. The grid must fit 128 centers per axis; use an explicit coarser spacing
if necessary. Cost reports use 3 warmups, 24 timestamp samples and a separate
recorder-free device; they are composition-pass costs, never full-frame FPS.

To trace the composed buffers, generate an additional fixed world-probe cohort:

```bash
bun scripts/raytracing/gltf/prepare-global-sdf-query.mjs <cards.json> <input> <query-input> [original-receiver.json]
node scripts/raytracing/gltf/check-global-sdf.mjs <query-input> <query-output>
bun scripts/raytracing/gltf/inspect-global-sdf.mjs <query-input> <query-output>
bun scripts/raytracing/gltf/inspect-global-sdf-query.mjs <query-input> <query-output>
```

This retains 64 world centers with 64 equal-area, texel-center directions each,
zero `tMin`, no jitter and no relocation. Negative starts remain in the cohort.
The optional original receiver file is copied byte-for-byte into a separate case;
its probes and exact distances are never replaced. The mathematical distribution
follows Clarberg's equal-area square-to-sphere mapping, used by UE's Radiance Cache
IF path. No UE implementation is bundled.

The runner records composition followed by query, reads both buffers, verifies
zero-before outputs, destroys the producer and replays every output on a fresh
device. Timestamp samples separately identify each work, so composition cost does
not impersonate query cost. The query inspector checks captured ray/settings bytes,
shared composition bindings, dispatch size, first sample against captured voxels,
all incomplete states and geometry-oracle discrepancies. Successful inspection
qualifies execution/provenance only; `query-inspection.json` retains each ray and
all quality failures. Region exits are incomplete, including in the empty control.
See the [query result contract](../../packages/render/README.md#querying-the-composed-region).

`check-global-sdf.mjs <query-input> <query-output> [min-step-factor]` can isolate
minimum advance from expansion. The internal factor defaults to 1; a lower f32
fraction changes sampling density, not source fields, ray intervals or budgets.
It does not guarantee thin-surface coverage. Compare unchanged full cohorts,
negative starts and masked controls before considering a different default.

```bash
node scripts/raytracing/gltf/trace-global-sdf-prefixes.mjs <query-input> <frozen-output> receiver <new-output> 753,1297 [min-step-factor]
node scripts/raytracing/gltf/falsify-global-sdf-prefixes.mjs <query-input> <frozen-output> receiver <new-output> 753,1297 [min-step-factor]
```

Prefix diagnosis first reproduces the frozen composition and full-cohort query
byte-for-byte, then changes only `maxSteps`. Each prefix retains every input ray;
selected indices only bound the captured step history. After releasing the
producer, RHI Debug creates one fresh device and replays all prefixes on it. Nonterminal positions are sampled positions; terminal
hits include pullback. Both commands require a new output directory. The
falsifier changes a grid byte and a non-selected ray result independently; each
must fail whole-cohort admission before a capture is accepted.

For a query produced by an ordinary Renderer frame, use its original RHI Debug
capture and the frozen `readResourceAtWork` files. `query-work` is a FrameModel
work index; `frozen-resource-prefix` names four files ending in `-voxels.bin`,
`-grid.bin`, `-rays.bin`, and `-hits.bin`:

```bash
node scripts/raytracing/gltf/trace-global-sdf-prefixes.mjs --capture <frame.rhitape> <query-work> <frozen-resource-prefix> <new-output> <ray-indices>
node scripts/raytracing/gltf/falsify-global-sdf-prefixes.mjs --capture <frame.rhitape> <query-work> <frozen-resource-prefix> <new-output> <ray-indices>
```

The capture entry checks the exact current query WGSL, replays the original tape
on a fresh device, and resolves every buffer through that work's actual binding
range. All four frozen files must match those readbacks. Settings come from
binding 4 of the same work; there is no separate native step/factor override.
The original whole cohort is reproduced before the shared prefix loop, and the
final control restores the original 16 setting bytes and all hit records.
Replay on that fresh device checks each complete hit buffer and all 16 settings bytes;
only the maxSteps word changes. Observed indices bound intermediate history and
never filter the ray buffer. The capture falsifier independently corrupts a
voxel and an unobserved ray result; both must fail source admission.

`FORGEAX_RASTER_CDP` selects an existing browser and
`FORGEAX_RASTER_REPLAY_URL` selects the diagnostic page. When that browser is on
another host, `FORGEAX_RASTER_RELAY=1` relays only the page origin's HTTP and
WebSocket traffic through the runner. The command closes its own page and relay
connections, retaining existing browser targets. Reported times measure
wall-clock diagnostic transfer/readback/replay overhead, not product GPU or
frame performance. Failed runs retain `failure.json`; they are not passes.

| RHI Debug selection | Meaning |
|:--|:--|
| Binding 0 | Frozen inverse transforms and mesh-field descriptors, stride 144. |
| Binding 1 | Shared local f32 distance samples; the inspector verifies seed hashes against decoded artifacts. |
| Binding 2 | Physical bounds and axis/minimum scale, stride 48. |
| Binding 3 | 48-byte grid settings: origin/spacing, u32 dimensions/source count, distance/coverage ranges. |
| Binding 4 | X-contiguous 16-byte voxels: distance f32, coverage f32, availability status u32, nearest known instance u32. |

The test corpus includes cube, sheet, mixed sidedness, empty/masked inputs,
missing solid and flat bounds, preserved known distance under missing inputs,
ties, 65 instances, nonuniform and mirrored scale. It checks every voxel, native
validation errors, zero output before dispatch, then destroys the producer device
and requires byte-exact fresh-device replay of every dispatch. Mirrored geometry
uses a 1e-6 distance tolerance because trilinear summation order reverses; its
coverage/status/identity remain exact. Source/grid mutation during preparation,
invalid precision/shear/budgets, failure cleanup and repeated disposal have unit gates.

The offline inspector ties dispatch/bindings, field/settings/zero-output seeds,
live output hashes and replay results to one tape. Its CPU world-distance check
uses a 1e-4 tolerance and reports samples on the coverage decision boundary
separately. Material opacity, hit precision, Card association, clipmaps and GI
need their own later consumer gates; composition availability cannot prove them.

### Sampled visibility in whole imported geometry

Use the same source geometry and section culling that generated the material
cards. This recipe does not split geometry by material ID. Every original input
is reported; rejected fields remain explicit in world composition.

```bash
bun scripts/raytracing/gltf/prepare-visibility-fields.mjs <cards.json> <fields> 0.5
bun scripts/raytracing/gltf/prepare-sdf-probes.mjs <cards.json> <fields> <probes> 64
node scripts/raytracing/gltf/check-sdf-probes.mjs <probes> <query-output>
bun scripts/raytracing/gltf/inspect-sdf-probes.mjs <cards.json> <probes> <query-output>
bun scripts/raytracing/gltf/prepare-global-sdf.mjs <cards.json> <fields> <world-input> 0.5
node scripts/raytracing/gltf/check-global-sdf.mjs <world-input> <world-output>
bun scripts/raytracing/gltf/inspect-global-sdf.mjs <world-input> <world-output>
```

The first `0.5` targets half-metre world voxels (source spacing uses the
largest transform axis across instances sharing a geometry). The later spacing controls the frozen world grid.
The probe size is per orthographic view, constrained by the Engine's 65,536-ray
batch bound. Run GPU scripts against the qualified machine's existing CDP and
replay host, using the same `FORGEAX_RASTER_CDP` and
`FORGEAX_RASTER_REPLAY_URL` overrides as above.

| Evidence | Meaning |
|:--|:--|
| `visibilityHit` | Approximate occlusion, with no geometric distance bound. Six-view triangle coverage does not qualify material alpha or GI. |
| Status image | Green: reference hit covered; amber: extra occlusion; red: reference hit missed; purple: incomplete state. |
| Distance image | Sampled policy: hit-to-triangle distance / world voxel size. Geometric policy: distance / declared bound. |
| First intersections | `first-intersections.json` joins each actual GPU hit to the exact first triangle, signed longitudinal error and normal dot. The report counts immediate hits and errors over 0.25/0.5/1/5 m; orientation counts are limited to pairs within 0.25 m. These measurements are not acceptance thresholds. |
| Tape inspection | Actual shader, instance/field/ray/settings seeds, zero-before-work output and byte-exact fresh-device replay. |
| Timing | 3 warmups and 24 timestamp samples without capture. Dispatch cost is not full-frame FPS; preserve hardware identity separately. |

Version-3 field artifacts require recooking v1/v2 inputs. Historical evidence
must be replayed with its pinned source version. New sampled-visibility data is
explicitly refused by the existing bounded diffuse GI consumer until transport
and Card coverage have their own qualification.

### Global hit to Card association

Run the same prepared world/receiver cohorts through the bounded object candidate
and shared Card sampler. The previous query capture is required for inspection:
all query bytes and composition inputs must remain identical.

```bash
node scripts/raytracing/gltf/check-global-cards.mjs <world-input> <association-output> <card-input-directory> 64
node scripts/raytracing/gltf/inspect-global-cards.mjs <association-output> <previous-world-output>
```

`card-input-directory` contains the existing `prepared.json`, `cards.json` and
texture payloads. The script retains `complete-roster` and optional original
`receiver` cohorts; it does not resample them. Card raster images are produced
before the association capture and enter its RHI tape as complete initial
texture bytes. The separate candidate/sample works each retain zero-before
outputs and exact fresh-device replay. GPU timestamps measure composition,
query, candidate selection and Card sampling; Card production is excluded.

The inspector reconstructs the object candidates from captured local-field
buffers and joins mapped samples back to captured atlas texels and weights.
`inspection.json` retains every ray, including incomplete, unmapped, stale and
multi-candidate results. This proves execution/provenance, not correct first-hit
material correspondence or GI quality. No candidate is promoted to a final
material identity; the four independent samples remain explicit.

To distinguish Card coverage from approximate-hit displacement, run the offline
projection diagnosis after that inspector:

```bash
node scripts/raytracing/gltf/diagnose-global-cards.mjs <cards.json> <world-input> <association-output>
node scripts/raytracing/gltf/audit-card-import.mjs <source.gltf> <import-output> 32 64
```

`gap-diagnosis.json` retains each ray's exact triangle/section identity, rejection
stage, nearest depth-rejected Card/texel and reconstructed world position. It
re-evaluates captured Cards at both the original Global hit and exact geometric
hit, using zero margin and the original association margin separately. Exit 0
requires the GPU and CPU to select the same mapped state, Card and contributing
texels, with normalized weight differences below `1e-4`. The report is written
before comparison failure so a failing decision remains inspectable. Run the
preceding inspector first; refused candidate rosters require their dedicated
control fixture. The exact oracle is unculled geometry and does not evaluate
MASK opacity; source-section identity is not fully shaded material truth.

The import audit's optional final arguments select **geometry-fit resolution**
and **maximum Card count** (defaults `16 24`); atlas pixel resolution belongs to
the separate GPU capture command. The audit uses the real glTF importer,
package finalizer, HTTP Catalog, runtime loader and mesh-byte round trip.
Settings are explicit experimental inputs; these commands do not change source
Meta or Engine defaults. Preserve the same original rays, fields, lookup rules
and atlas pixels when comparing layouts. Higher mapped counts alone do not
qualify first-hit material correspondence or GI.

### Shared-material correspondence

```bash
node scripts/raytracing/gltf/check-material-rays.mjs <prepared-dir> <cohorts.json> <material-reference-output>
node scripts/raytracing/gltf/inspect-card-correspondence.mjs <cards.json> <association-output> <material-reference-output> [raster-grid=0] [report.json]
node scripts/raytracing/gltf/falsify-card-correspondence.mjs <cards.json> <association-output> <material-reference-output> <report.json>
```

The cohort array contains `{ name, rays }`, with the existing reference-ray
origin/direction/tMin/tMax/mask fields and optional cone width/spread. The shared
material tracer evaluates one bounce with no lights and black environment; it
retains authored sidedness and MASK opacity. Unsupported intervals or masks
fail instead of changing the rays. Captured initial rays, settings, triangle
identities and hit positions are checked; inputs, surfaces and accumulation
must replay byte-exact. `gpu.json` seals every output and the original cohort.
The correspondence inspector checks those hashes and requires the same query
bytes in the association capture.

Card witnesses intentionally trace geometry without alpha, matching the cache
proxy policy. The inspector reports per-candidate material agreement and
normalized support weights, both-opaque versus MASK-involved comparisons, and
unresolved raster witnesses. `geometricDistance` retains the analytic texel-center
ray distance separately from captured raster depth: subpixel raster snapping
can change the latter. The optional report path preserves a frozen earlier
diagnosis. Candidate weights normalize independently; their
sums are **candidate equivalents**, not final blend weights or radiance.
A matching material ID does not prove the same surface or shading. Multiple
object candidates are not a resolved material, and a MASK-involved mismatch
does not establish its cause. Each support texel reports `distanceToGlobalHit`
and `distanceToReference` in world units. The per-ray and summary
`maxSupportDistanceToGlobalHit` / `maxSupportDistanceToReference` retain their
separate populations: a reference miss can still have local Card support.
These are maximum contributing texel-center separations, not weighted-center
errors. Global positions must match query readback, whose hash is recorded;
Card positions must match captured projection/depth. A locally nearby Card
does not prove that the approximate ray stopped at the correct surface.

The default raster grid uses geometric center depth. An explicit grid requires
independent measurement on the recorded backend; `256` was measured on Metal
for these fixtures, not specified as a portable capability or Engine tolerance.
Shared-edge or coplanar identity ambiguity remains visible. Inspect both the
Global-hit-to-reference separation and Card support before choosing a repair
owner. The six falsifiers mutate only private copies: material bytes, re-sealed
cohort rays, replay coverage, source validation, Global position and Card
position. They must fail for their
specific missing invariant; successful diagnostics do not admit cache GI.

## Near-field and Global continuation

The frozen `createSoftwareSdfQuery` composes existing detail and Global queries through
one GPU interval handoff. It preserves complete source identity and incomplete outcomes;
it is not an ordinary Renderer GI route. Run the shared Browser/Dawn
`software-sdf-query` fixture for non-unit rays, near hits, inside starts, missing fields,
budget exhaustion, repeated recording, exact replay and three omitted-work controls.

For Sponza or another archived composition/query fixture:

```bash
bun scripts/raytracing/gltf/inspect-software-sdf-query.mjs <input> <captured-output>
bun scripts/raytracing/gltf/inspect-software-sdf-query.mjs <input> <captured-output> --report <separate-report.json>
bun scripts/raytracing/gltf/inspect-software-sdf-query.mjs <input> <captured-output> --falsify-continuation
```

Use `--report` to preserve a frozen capture directory; its parent directory must
already exist. Without it, the report is written inside the capture directory.
The last command must fail at the continuation-byte comparison; it changes only an
in-memory readback copy. The first verifies source/field seeds, original and clipped
rays, work/resource lineage and every continuation byte. It publishes per-ray near
state, negative-start metadata, selected route, interval, Global state, geometric
reference discrepancy and per-work GPU timing samples. Disabled Global results never
count as final scene misses. Its archived fixture uses 128 detail and 256 Global steps,
clearance expansion (or explicit `--ray-distance`) and a unit Global minimum-step factor; other configurations need
an explicit inspector contract update, not silently assumed defaults.

### Thin sheets and open gaps

This independent fixture qualifies visibility before Card or lighting integration.
It cooks finite two-sided sheets through `buildVisibilityDistanceField`; every
triangle reference is cross-checked against analytic rectangle intersections.
No Sponza material, alpha, or signed-interior assumption enters this fixture.
The primary pnpm CI job runs `node --test scripts/raytracing/gltf/__tests__/*.test.mjs`,
including the fixed-ray regression across voxel spacing and foreground depth.
It installs the `.bun-version` runtime required by the source producer explicitly.

```bash
bun scripts/raytracing/gltf/prepare-thin-gap-sdf.mjs artifacts/thin-gap/input
# Capture the same manifest with both production detail expansion settings.
bun scripts/raytracing/gltf/inspect-thin-gap-sdf.mjs \
  artifacts/thin-gap/input artifacts/thin-gap/clearance \
  artifacts/thin-gap/ray-distance artifacts/thin-gap/comparison
```

| Controlled input | Values |
|:--|:--|
| Voxel spacing / gap width | 5 and 10 cm / 5 and 20 cm |
| Foreground sheet depth | 20 and 22.5 cm; outer mesh bounds remain fixed |
| Caller | World origin at 35 cm height; receiver origin at 0.1 mm height |
| Rays | 64 by 24 per caller; zero TMin, fixed direction distribution per scene; one masked-source control |

The capture host records composition, detail, continuation and Global for each
manifest row with a 1 m detail interval. It saves the canonical tape, named buffer
readbacks and `gpu.json`, including fresh-device replay differences and recorder-off
timestamps. The paired inspector invokes the existing continuation inspector for
both settings, writing each derived inspection into the comparison directory so
even a rejected comparison leaves the captures unchanged. It verifies identical
shaders, all other seeds and composition
outputs. It checks source geometry against the field identity and recomputes every
reference before reporting foreground misses, blocked gaps, closest-surface
identity and geometric proximity. `analysis.json` retains every ray;
`summary.json` retains denominators, tape hashes and stage timing medians.

`blockedOpenGap` counts a back-wall reference reported at or before 1 mm behind the
foreground sheet. This diagnostic threshold is separate from nearest-surface
distance. A nearby surface does not prove correct first-surface or material
correspondence. This fixture exposes failure regions; a completed run is not GI
quality acceptance. See the Harness thin-gap report for frozen captures and its
standalone capture host.

## Raw Card atlas display

The offline display consumes the five tightly packed readbacks from a Card capture,
including the native Renderer path before surface lighting exists:

```bash
node scripts/raytracing/visualize-card-atlas.mjs <prefix> <width> <height> [scale=1]
# Example: cold-cards.albedoRoughness.bin, cold-cards.normals.bin, etc.
node scripts/raytracing/visualize-card-atlas.mjs artifacts/cold-cards 48 32 4
```

Supply the extent from the captured texture descriptor. Inputs are four
`rgba16float` planes (`albedoRoughness`, `normals`, `emissionMetallic`, `f0Validity`)
and one `depth32float` plane (`depth`), each named `<prefix>.<plane>.bin`. Output
`<prefix>.atlas.png` is a nearest-neighbor 3 by 3 contact sheet:

| Left | Middle | Right |
|:--|:--|:--|
| Albedo, linear to sRGB | Roughness, linear gray | Shading normal, decoded oct XY |
| Geometric normal, decoded oct ZW | Emission, Reinhard then sRGB | Metallic, linear gray |
| F0, linear RGB | Validity status | Depth, linear gray |

`<prefix>.atlas.json` records source SHA-256, byte counts, raw ranges, extent,
scaling, status counts and display transforms. Normal XY and ZW are two separately
encoded vectors; the first three raw lanes are not XYZ. Black F0/emission is a
valid material value, not empty coverage. Validity colors are dark for empty,
green for admitted, orange for unsupported and magenta for coverage rejected;
non-admitted attribute panels carry that status color. Wrong byte layout,
nonfinite texels and unknown status values fail explicitly.

This tool displays captured material data. It does not validate geometry-to-Card
correspondence, full scene coverage, ray support, radiance or GI. Keep the original
readbacks and tape alongside the images and run the applicable per-work replay.
