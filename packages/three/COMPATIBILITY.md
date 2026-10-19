# Three.js r184 compatibility contract and implementation status

## Acceptance scope

The target is complete public functionality at Three.js **0.184.0**, including
public properties, methods, overloads, return values, mutable state, defaults,
serialization, resource disposal and official addons. Applications must retain
their ordinary Three calls after changing imports. Custom GLSL, `onBeforeCompile`
and direct native WebGL access may require migration to native material/WGSL/RHI
APIs. An official feature implemented internally with ShaderMaterial is still
an ordinary feature: PMREM, post-processing, GPUComputationRenderer and other
shipped helpers are not automatically covered by the shader exception.

**This implementation does not yet meet that contract.** It is a working native
rendering path and a conformance workbench. Root export presence, successful
TypeScript compilation, engine feature coverage and a passing demonstration are
not evidence of complete compatibility. Missing ordinary behavior must remain a
reported gap, not a no-op, an upstream GPU-renderer fallback, or a migration
requirement disguised as support.

## Executable inventory

Run after building the package:

```sh
node packages/three/scripts/audit-api.mjs --output artifacts/three-compat/api-audit.json
node packages/three/scripts/audit-api.mjs --check
```

The inventory derives root runtime exports, declaration exports and public class
members from the pinned upstream package and declarations. It also derives addon
module paths from the upstream published files. It reports missing names,
incompatible property/method types and constructors, and unpackaged addons.
Method arguments are also checked in the caller-to-callee direction: TypeScript's
bivariant method assignment alone would accept a `render(Scene)` implementation
where upstream callers are allowed to pass any `Object3D`.
`--check` intentionally fails until the measured surface is complete. This is
an interface audit; it cannot establish default values, overload behavior,
callback ordering, pixels, GPU execution or lifetime correctness.

The current root forwards all 441 runtime exports. The declaration audit covers
676 symbols. Renderer methods and 413 of 415 addon module entry paths are still
missing. Additional upstream public entry families (`addons`, `webgpu`, `tsl`,
`examples/jsm`, fonts and source imports) must be accounted for before claiming
package-level compatibility; the current root/addon audit is not that claim.

## Native design boundary

Compatibility obligations describe observable Three behavior, not new native API
names. Source objects, mutable renderer state and callback interpretation belong
to this package. World owns component values and shared payloads; Render owns
ordered preparation, resource residency, submission and recovery. Native additions
must remain useful to native applications independently of this adapter.

The adapter retains source-to-entity identities, source version signatures and
resource leases, not a second copy of World component values or payloads. It compares
projected values with World storage at the native field precision before writing.
Resource preparation stages new leases; rejection releases them without replacing
accepted leases or scene components. Program selection reads current native material
readiness and parameter contracts; loader results and shader bytes are not retained
as a competing program catalogue. These are CPU preparation boundaries, not a second
GPU transaction or resource registry.

The existing native affine Transform, two-axis camera offset, winding selection
and output graph composition express general render facts. Per-object callbacks
remain unsupported. Future callback work must preserve upstream ordering and state
visibility through explicit native inputs; it must not place arbitrary Three
callbacks in ECS data or execute business code during GPU recording. Frame submission
or GPU completion notifications do not substitute for Three's per-draw callbacks.
Likewise, future target/viewport/clear calls must become ordered target and attachment
declarations, with source-side mutable state confined to the adapter. Same-sequence
read/write dependencies and synchronous readback still require their own proofs.

## Existing evidence

- Original Three CPU objects and the packaged OrbitControls/GLTFLoader use one
  constructor family. Distribution tests inspect emitted source maps to exclude
  upstream WebGLRenderer, WebGPURenderer and NodeBuilder implementations.
- Cached source world matrices and object changes enter ordinary native World/Scene components and shared
  assets. The native Renderer owns GPU allocation and submission. Static frames
  reuse references; reparenting, removal/re-addition, version changes and disposal
  have regression tests.
- Browser and Dawn fixtures import the built public `@forgeax/engine/three` entry
  and submit 60 completed ready frames. Source projection tests remain separate;
  real-device fixtures require only the transferred package outputs, not ignored
  intermediate material files from the producer checkout. Basic and Standard
  scenes compare with the independent original Three WebGL renderer. The original
  renderer is a test oracle only.
- Native material-readiness source tests also consume the packaged material
  publication; they do not depend on the producer's ignored Cook intermediate.
- A real RHI capture records the native submission, source UUID/entity mapping and
  native receipt. Replay uses a fresh RHI device and compares its output to the
  captured live frame. Capture cancellation, overlapping render/resize exclusion
  and disposal during initialization are tested.
- The material conformance fixture passes Normal, Lambert,
  textured Matcap and the Physical clearcoat reference cases. Clearcoat
  toggles retain the same admitted program, change actual pixels, survive source
  disposal/remove/re-add, and replay on a fresh device. These cases do not prove
  complete Physical material compatibility.
- Mixed Normal, Physical, untoned Basic and transparent Basic scenes pass the
  original thresholds with NoToneMapping, ACES exposure 1/2 and Reinhard exposure
  1/0, both single-sample and MSAA. The original Normal frame now matches every
  byte. Maximum measured whole-image MAE across these mixed cases is 0.000199;
  fresh-device replay and source `toneMapped` mutation also pass. This establishes
  those canvas cases, not target or post-processing output compatibility.
- AmbientLight is summed by source visibility and camera layers into native
  Skylight constant irradiance. Lambert with a color map, Standard and Physical
  pass original-renderer references for addition, hiding, layer changes, removal
  and restoration; a fresh-device replay covers the retained ambient frame.
  Standard/Lambert and Physical base-color texture programs are cooked with the
  package and selected by their actual parameter requirements.
- The pinned GitHub Rubik application is available through the
  [migration harness](migrations/rubiks-cube/README.md). Its original business
  source is preserved; host setup fixes the reference font-readiness conditions
  and exposes native capture separately.
- Unshadowed SpotLight uses the native light owner. Browser references cover
  power, finite range, target motion, zero penumbra and restoration; independent
  positive/negative controls and fresh-device replay also run on Dawn. Spot
  projector maps, shadows and non-default decay remain required owner work.

Failed material frames are preserved in `artifacts/three-compat/` as `.rhitape`,
actual `.rgba`, independent `.three.rgba`, and derived `.frame.json` files.
These are local diagnostic artifacts, not public assets or a new capture format.
Browser transfers use existing lossless RHI tape compression while retaining every
resource seed, event and pixel oracle; the frame roster and deadlines stay unchanged.

## Required owner work

| Area | Existing boundary and required work | Acceptance evidence |
| --- | --- | --- |
| Mutable scene graph | Native Transform now represents nonsingular affine matrices with TRS plus shear. Source projection preserves manual/frozen world matrices, ordinary Object3D roots and external camera-parent caches through flat native author transforms. Singular transforms, custom projective matrices, LOD and remaining visibility semantics still require work. Never overwrite derived GlobalTransform. | Matrix and hierarchy mutation against upstream, including shear and matrix-auto-update disabled. |
| Draw scheduling | Render owns ordered draw preparation. Three object/material callbacks must execute at their original draw boundary, including per-group and per-instance material changes. One pre-frame callback sweep cannot substitute for per-draw behavior. Sorting, renderOrder and disabled frustum culling require native inputs. | Interleaved callback log and pixels for shared-material mutations, nested render and custom comparators. |
| Geometry and deformation | Geometry owns canonical attributes and bounds; Skin owns palette bindings; Morph and native instance lanes own deformation. Preserve groups, drawRange, missing/default attributes, multiple UVs, morph-relative mode, Three bindMatrix/bind modes and InstancedMesh/BatchedMesh updates. | Independent animated poses, raycasts, vertex/instance edits, removal, reuse and capture identities. |
| Materials | Basic/Standard/Normal/Lambert/Matcap and untextured Physical clearcoat have passing reference cases. Remaining Physical combinations, Phong/Toon/Depth/Distance/Shadow, line/point/sprite materials and all render states remain required. | Each material family and option combination uses original Three as an oracle; negative controls must fail. |
| Physical program preparation | ShaderCompiler and the existing publication path own native specialization. The package now cooks and admits numeric and base-color Physical programs at startup, with enabled layers retained at zero weight. Other texture combinations and every remaining admitted combination still require program coverage, including runtime GLTFLoader results. Do not silently disable physical layers or move the compiler into the player. | Runtime creation and toggles after startup produce actual native draws, enabled-layer falsifiers, correct resource ABI and no missing-specialization diagnostics. |
| Texture coordinates and images | Three applies its UV matrix with rotation before nonuniform scaling; native slot TRS currently applies scaling before rotation. Extend the existing coordinate owner to represent the full affine mapping. Support data formats, compressed/cube/layered/depth/video textures, partial updates, pending loads, mipmaps, sampler state and shared-source mutations. | Off-center rotation plus unequal repeat, manual matrices, shared maps with different usages, asynchronous decode and format-specific readback. |
| Lighting and environment | Map all lights, shadow settings, environment/background, linear/exp2 fog, clipping and per-material flags. Native auto-fit directional CSM is not equivalent to an arbitrary Three shadow camera; extend the shadow owner. | Shadow-camera bounds/bias/filter mutations and all light/environment families, including camera layers and moving targets. |
| Render targets and framebuffer state | Render owns target generations, captures and readback. Implement target/mip/layer selection, MRT, depth/stencil, partial clear, viewport/scissor, copies, resize/dispose and target textures. Native linear-HDR framebuffer snapshots are not equivalent to every Three framebuffer copy. | Ordered multi-render sequences, target reuse in the same tick, subregions, depth/stencil preservation, all target shapes and old-generation failures. |
| Synchronous renderer methods | Three's synchronous constructor/render/readback APIs are observable. WebGPU device acquisition and buffer mapping are asynchronous; returning a Promise from `readRenderTargetPixels` is not compatible. A synchronous execution backend or a genuinely synchronous cross-thread bridge needs a proven browser/host design. Main-thread Atomics.wait is unavailable. The bounded-spin feasibility probe below works only after asynchronous Worker/device startup; a newly constructed Worker timed out while its caller spun. | An unchanged synchronous caller receives current bytes before returning, including immediate target render/readback and browser main-thread execution. |
| Output and post-processing | The shared native material output kernel and Forward graph contribution implement canvas tone/encoding before blending. Complete destination rules, fog order, premultiplication, dithering, post-processing buffers and official passes through the same Render graph. | Mixed normal/physical materials, active tone mapping and transparent overlap already pass; offscreen destinations and independent EffectComposer chains remain required. |
| Public helpers and addons | Package all public paths with one constructor family. CPU reuse is suitable for controls/loaders/math; GPU helpers, WebXR and ordinary WebGPU material APIs require native implementations. Builtin addon shaders are not user custom shaders. | Real addon usage and lifecycle, both path aliases, lazy imports, XR capability/error behavior and production bundle inspection. |
| Debug and recovery | Preserve one native RHI tape, exact work/resource lineage and source mapping. Rendering through this layer diagnoses Forgeax's adaptation, not the original Three renderer's internal WebGL execution. | Native/live/replayed frame identity, teardown, recovery, source mutation after capture and renderer-local resource isolation. |

## Native affine and lens contracts

Scene's authored `Transform.shear` extends its existing local TRS into `T * R * H * S`.
Math owns loss-preserving nonsingular affine decomposition; Scene propagation and
fixed-step interpolation consume the same author fields. The facade reads the
upstream world-matrix cache at the upstream update boundary and authors flat
native transforms. This preserves manual `matrix`, frozen `matrixWorld`, ordinary
Object3D roots and cameras whose external parent has not been updated, without
writing derived GlobalTransform or maintaining a second hierarchy. The active camera
uses its cached `matrixWorldInverse`, including independent manual edits and r184's
camera-scale removal. Non-rigid custom view matrices are explicitly unsupported until
the native camera owns that representation.

Render's `Camera.projectionOffset` generalizes the old stereo-only horizontal
projection shift into a two-axis lens input. Stereo eyes add their convergence
shift to that same value. Three view/film offsets are decoded from its cached
projection; source field edits remain stale until `updateProjectionMatrix()`.
Draw, culling, CSM, capture, publication and temporal consumers retain the input.
Mirrored model matrices also select the correct native front-face state. The regression
changes from ordinary affine to mirrored affine and back, compares normal-material pixels
with Three r184, and retains GPU capture/replay. Native batch and shadow tests cover
transform-only parity changes without mutating shared material state.

These changes do not complete synchronous startup/readback, per-draw callbacks,
render targets, arbitrary projection matrices or singular transform behavior.

## Concrete material findings

The browser fixture captures all failing cases before reporting its aggregate
failure; it retains the original pixel thresholds (MAE at most 0.05 and at most
3% of channels outside epsilon). It does not mark known failures as passing.

1. **Normal output (fixed for canvas reference cases):** upstream's normal shader writes encoded normal values
   directly and omits its tone/output conversion chunks. At the captured center,
   Three writes `[128,128,255,255]`; the original native final-display capture
   contained `[188,187,255,255]`. Its ordinary output-transform pass encoded data
   a second time. The shared material output operation now omits conversion for
   Normal, transforms ordinary color materials before blending, and presents the
   canvas values once. The corrected Normal frame has zero differing bytes.
   Mixed ACES/Reinhard, untoned color, transparent overlap and MSAA references
   pass without changing thresholds. The original failure remains in
   `artifacts/three-compat/before-fragment-output/`.
2. **Matcap orientation (fixed):** the native matcap lookup flips V for native image
   conventions while the adapter also applies Three's texture flipY. The captured
   source texture and center pixels differ. The adapter now projects usage-correct image
   coordinates while preserving a source texture shared between matcap and
   ordinary map slots. The corrected browser reference case passes; the source
   texture remains unchanged.
3. **Physical specialization and clearcoat (fixed for the reference cases):** the
   package build cooks the native numeric Physical contract through
   `createMaterialPackCooker`. The current numeric/base-color Unlit/Standard/Physical recipe's 252
   programs enter the Runtime host's existing
   material loader and AssetRegistry before the compatibility renderer becomes
   ready. Numeric layer switches stay compiled at zero weight; value edits use
   the same program and retain ordinary World/resource ownership. No compiler
   enters the player bundle. A supplied map without a compiled binding still
   reports a missing ordinary feature.

   Once the mesh drew, its captured material UBO matched the source values, but
   native clearcoat radiance was multiplied by Fresnel twice. The native physical
   layer now weights its already-evaluated coat radiance by coverage while
   attenuating the underlying material by view Fresnel. At clearcoat 0.6, the
   center is `[125,181,147,255]` in both renderers after the output fix; at zero,
   both are `[68,154,106,255]`. The original whole-image thresholds pass at
   clearcoat 0, 0.6 and 0.9. Positive draw, value-change, disposal/reuse and replay
   checks also pass on Dawn. Other physical lobes, texture combinations and
   Three's transmission depth-write/blending combinations remain incomplete.

## Build and program admission

`pnpm --filter @forgeax/engine-three build` generates the compressed native
material publication and then bundles it as a separate module. The generated
module is disposable; the authored Node recipe is `scripts/build-materials.mjs`.
A checked declaration describes its payload export so source typechecking can
run before generation on a clean checkout.
The workspace package graph orders the declared development compiler through
`forgeax.buildDependencies`; shader source bytes participate in dependency
fingerprints even when their JavaScript wrapper is unchanged. Production loading
only decompresses and validates cooked programs through the existing Codec,
Pack, material loader and AssetRegistry owners.

## Material output implementation boundary

The original Normal failure identified an output-order difference. The default
native Standard pipeline shades and blends in linear space, then
applies a single display transform. Three r184's WebGL material shaders can apply
tone mapping and output encoding before blending; its Normal shader omits both.
Inverting sRGB only for Normal would still fail when exposure, a non-invertible
tone curve or transparent overlap is present.

The implementation uses `createStandardForwardPipeline` from `render/authoring`
to contribute Three's color attachment and finishing graph. Render still
prepares, records, submits, observes and retires that graph. This contribution
shares native lighting and material evaluation; it neither copies Standard's
renderer nor introduces a second GPU resource registry.

Shader owns a reusable, parameterized tone/output kernel shared by fullscreen
output and material output. An authored `fragmentOutput` parameter selects the
optional operation at the final color write before blending. Physical's remaining
fog, premultiplied alpha and dithering must run after tone/output conversion.
Its fog color uses the destination's unlit uniform color space; native linear-space
fog cannot stand in for that step. These inputs remain rejected until implemented.
The adapter supplies the source material's `toneMapped` setting and the current
destination contract through ordinary material/view inputs. A data shader's
omission of output conversion is a separate source fact from `toneMapped=false`:
the latter still performs color-space conversion on an ordinary color material.

Destination rules must derive from pinned `WebGLPrograms.getParameters`: canvas
draws use `renderer.outputColorSpace`; ordinary render targets use the working
color space and omit material tone mapping; XR targets select their target color
space. A raw present pass then forwards already-encoded canvas values once. Clear
colors, background materials, transparent blending, MSAA and final-display receipt
capture must name the same destination; they cannot inherit an incompatible
linear-HDR post chain implicitly. Official OutputPass/EffectComposer supplies its
own ordered transform through that same graph.

The mixed canvas scene containing Normal, Physical and `toneMapped=false` color
materials, active ACES/Reinhard exposure and overlapping transparent geometry
passes against upstream and replays its native tape, including MSAA. The
offscreen-to-canvas sequence remains required. Default Standard retains its
existing linear blending and output contract.

## Completion order

First resolve the execution and native authoring contracts that cannot currently
express upstream behavior: synchronous calls, manual matrices, ordered draws,
physical program availability and material output. Then implement the complete
source projections and renderer methods against those contracts; expand official
addons after their underlying behavior is present. Each increment keeps its real
browser/Dawn regressions and the interface audit. Only complete, green interface
and behavioral matrices justify a full-compatibility release.

## Synchronous readback feasibility probe

`node packages/three/scripts/probe-sync-readback.mjs` runs a sandboxed Chromium
probe and writes `artifacts/three-compat/sync-readback-spike.json`. It clears a real
WebGPU texture in a Worker, maps the GPU readback there and publishes the bytes
through SharedArrayBuffer. The calling browser thread polls atomically without
an await or event-loop yield during the readback itself.

On Chromium 155 with SwiftShader and cross-origin isolation, the preinitialized
Worker returned `[64,128,191,255]` in about 90 ms (one observation, not a performance
promise). Starting a new Worker and immediately blocking its caller instead hit
the 20-second deadline. The successful probe awaits Worker/device initialization
before entering the synchronous call. It uses raw WebGPU solely to establish the
platform mechanism; it is not a replacement renderer, RHI backend or a working
implementation of `readRenderTargetPixels` in this package.

An integrated design must therefore establish the Worker before application
construction (for example during asynchronous module evaluation), preserve native
Renderer/publication ownership and order every target/copy/read command. It must
also address environments without SharedArrayBuffer, nested callbacks, errors,
timeouts, Worker retirement and the CPU cost of main-thread polling. Ordinary
`render()` should enqueue work without spinning; only genuinely synchronous
queries would fence it. The interface audit remains red until the actual unchanged
Three callers pass on that integrated path.

A material map added after its first draw requires the upstream
`material.needsUpdate = true` shader-invalidation step. The adapter currently
reprojects that map even without invalidation, while the r184 oracle retains its
old program; exact stale-program behavior remains a compatibility gap. The
Physical base-color mutation fixture follows the documented invalidation step.
