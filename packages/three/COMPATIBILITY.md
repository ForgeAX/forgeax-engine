# Three r184 WebGPU compatibility

The target is **Three.js 0.184.0 WebGPURenderer with its WebGPU backend**.
WebGL, WebGL fallback and their exclusive interfaces are excluded. Addon expansion
is deferred. Native Skylight deliberately owns both diffuse environment lighting
and reflections, following Forgeax's design.

This package reuses Three's CPU authoring objects and projects them into native
World, Geometry, Material, Skin and managed assets. The native Renderer owns every
GPU submission and resource lifetime. Exporting a class does not establish GPU
support. This is a bounded compatibility implementation, not full conformance.

## Defaults and opening a feature

| Setting | r184 WebGPU default | Adapter behavior / activation |
| --- | --- | --- |
| Camera | Perspective: fov 50 degrees, near 0.1, far 2000 | Same upstream constructor; cached projection changes on `updateProjectionMatrix()`. Units are application units, not inherently metres. |
| Backend | WebGPU, with upstream fallback machinery | WebGPU only; initialization errors are reported. |
| Alpha / depth / stencil | true / true / false | Same defaults. Opaque canvas configuration (`alpha:false`) remains rejected. |
| Clear | transparent black; autoClear and three attachment flags true | Same full-clear defaults. Partial/no-clear sequences require native attachment state. |
| Antialias | false; samples 0 | Same; `antialias:true` selects 4. Mutable `samples` supports 0, 1, 4. |
| Intermediate output | HalfFloatType | Same; UnsignedByteType can be selected at construction. |
| Tone / exposure / encoding | NoToneMapping / 1 / SRGBColorSpace | Same; NoToneMapping ignores exposure. Linear, Reinhard, Cineon, ACES, AgX and Neutral project to native modes. Positive exposure only when active; Display P3 output is available. |
| Shadows | `shadowMap.enabled=false`, PCFShadowMap | Same defaults. Set `shadowMap.enabled`, light `castShadow` and mesh cast/receive flags; the authored light shadow camera controls coverage. Native CSM policy is unchanged. |
| Post-processing / AO / Bloom | No effect chain; none of these enabled by the renderer | None injected. GTAO and other node/addon effect APIs remain outside this delivery. There is no universal “Three default GTAO parameter set” in an ordinary renderer. |
| Material | Upstream constructors and values | Ordinary Basic, Standard, Lambert, Matcap, Physical and primitive families below; unsupported GPU behavior raises a compatibility error. |
| Sorting | `sortObjects=true`, opaque/transparent true | Transparent group order, object renderOrder and camera-space depth are projected. Per-draw opaque/custom ordering remains a native boundary. |
| Environment/background | null; intensities 1; rotations 0 | Equirectangular radiance projects into Skylight/SkyboxBackground. Lighting and background intensity/rotation are independent. |

## Source features reviewed, from basic to complex

“Verified” below names the actual tested path. It does not claim every possible
combination of options, all GPU formats or performance equivalence.

| Feature | Implementation and evidence | Remaining boundary |
| --- | --- | --- |
| CPU API and package identity | All Three.Core runtime exports; one constructor family shared by facade, existing OrbitControls and GLTFLoader; no upstream GPU renderer in emitted chunks. | TSL/NodeMaterial and other GPU exports are not implied by CPU reuse. |
| World matrices and cameras | Cached/manual/frozen world matrices, external camera-parent cache, affine shear, mirrored winding, perspective/orthographic, near=0 for orthographic, film/view offsets and reverse depth. Browser/source coverage. | Singular transforms, arbitrary/projective/non-rigid views, infinite/custom/log depth and XR need native representations. |
| Visibility, layers and LOD | Visibility/layers precede admission, LOD automatic/manual source selection, material.visible per used group, empty/missing/unused material slots, frustumCulled=false. Source regression and browser cases. | Arbitrary draw callbacks and custom opaque ordering are not pre-frame source operations. |
| Geometry | Indexed/non-indexed and interleaved/normalized source values, drawRange/groups, incomplete final primitive handling, selected vertex colors and missing attributes. Shared geometry remains source-owned. | GPU-only attributes and unknown rendered attribute semantics need their owning native contract. Unused author attributes are ignored. |
| UVs and samplers | UV0–UV3, missing UVs read zero; TRS uses native coordinates, affine shear is projected into ordinary native UV streams (up to eight total). Samplers follow WebGPU filtering/anisotropy rules. Browser pixels and replay. | More than eight simultaneously required streams; projective UVs; Matcap-generated UV transforms need native sampling input. |
| Image/data textures | Byte/half/float Red/RG/RGBA, rows/alignment, Texture.version, authored/generated mip behavior, premultiplyAlpha conversion, image and sampler sharing, update/dispose/reuse. Pending images render with zero placeholders or retained bytes; loader errors stay on the loader path. Updates and onUpdate follow version admission. Byte/half formats, async success/failure, dataReady and mip falsifiers use real GPU comparisons. | Unsupported GPU storage/sampling formats and color spaces are rejected; float filtering remains device-dependent. |
| Compressed textures | BC, ETC/EAC and ASTC source blocks map to native formats/mip layout; native device admission remains authoritative. BC upload, edit, disposal and replay tested. | Other families were structurally checked, not hardware-tested here. Compressed flipY and unavailable device formats are rejected. |
| Borrowed GPU/video textures | Renderer-owned import leases, source changes, disposal/readmission, native generation/ownership. GPU textures tested with replay; sRGB VideoTexture tested live across a seek and disposal. | Video requires sRGB and flipY=true. External-image RHI events cannot yet be self-contained in a replay tape. |
| Basic/Standard/Lambert | Native material factories and source scalar/map projection; missing vertex color/normal defaults and normal-map precedence over bump maps. Independent alpha maps (red channel, matching r184 WebGPU MaterialNode), strict alphaTest, opaque output alpha, alphaHash and alpha-to-coverage use the native shader contract. Browser/replay. | Basic AO/env/light maps require additional native sampling inputs. |
| Matcap | Authored Matcap and default procedural ramp, color, missing normals/flat triangles including morph deformation. Browser/replay. | Normal/bump/displacement, separate color/alpha map, generated-UV transform inputs remain native gaps. |
| Physical | Scalar layers plus exact cooked texture variants through native Cook/loader/AssetRegistry. Clearcoat texture and a five-map combination have browser pixels, updates and replay. Additional exact recipes use the build API below. | Automatic arbitrary runtime recipe compilation differs from Three; dispersion, two-axis clearcoat-normal scale, native sampler budget remain boundaries. Cook admission is not proof of every layer's BRDF fidelity. |
| ClippingGroup | Nested union/intersection sets; factor a complete shared set into native camera clipping and retain the residual material predicate. Browser/replay. | Unshared simultaneous local union/intersection predicates and smooth coverage need native support. |
| Render state | Depth compare/write, color write, polygon offset, static stencil compare/ops/reference, Normal/Additive/Custom blending, premultiplied output including Subtractive/Multiply, output alpha and double-sided transparent draws. Browser/replay. | Non-premultiplied Subtractive/Multiply are rejected like r184 WebGPU. Blend constants belong to the excluded WebGL surface. Smooth geometric clipping remains separate from alpha-to-coverage. |
| Lines/Points/Sprites | Native simple lines, cumulative affine dash distances, points size/attenuation, Basic wireframe. Sprites project camera-facing quads, center/rotation/scale/UVs. Browser mutations/replay. | Native line/point writers lack varying color/UV/point coordinates; line styles are per component. Lit wireframe and arbitrary per-endpoint dash laws remain gaps. |
| Morph and skin | Position/normal relative or absolute morphs; Three r184 WebGPU ignores color morphs, as does the adapter. Native Basic skinning; lit skin projects current CPU pose before native shading. Browser pose edits/replay. | CPU lit-skin preparation costs differ from Three's GPU path. No performance equivalence claimed. |
| InstancedMesh/BatchedMesh | Native simple instances; source expansion for instance colors/morphs, batch geometry ranges, holes, visibility and ID reuse; updates/disposal retained. Browser/replay. | Expanded paths cost CPU/upload memory and do not promise native multi-draw performance. |
| Lights | Ambient sum, directional/point/spot and rectangular area-light projection; target, visibility/layers, range/power, rect orientation/size. Real WebGPU light comparisons. | Spot projector/non-default decay, global SH probes and hemisphere law need native lighting contracts. |
| Shadows | Authored directional/spot cameras, point cube views, rectangular maps, Basic/five-tap Vogel/PCFSoft/VSM, intensity, bias, normal bias, radius, shadowSide, caster layers and texture-only alpha coverage. Manual updates retain submitted depth across graph reconstruction and capture. | Point VSM selects Vogel as upstream. Transmitted-color shadow maps and custom shadow/filter nodes remain outside this implementation. VSM requires the native extended sampled-texture budget. Frozen map dimensions are retained; the upstream live-size filter footprint is not reproduced after resizing a frozen map. |
| Background/environment | Equirectangular RGBA radiance, independent intensity and rotation, shared input image without rewriting the source. Separate dielectric/metal scattering, diffuse conservation and Physical specular color/intensity share Forward/Deferred evaluation; furnace, material mutation and replay probes cover the response. | Cube/refraction/per-material overrides, background blur/LOD and depth-fog laws remain native gaps. |
| Renderer lifecycle and callbacks | Async init, ordered render/renderAsync, animation loop, source Scene before/after callbacks at the matrix/projection boundary, sizing/pixel ratio/full viewport, full clear, disposal/capture exclusion. Source and browser coverage. | Object/Material per-draw callbacks, nested renderer re-entry, custom sort callbacks and GPU readiness/compilation helpers need their original scheduling contract. |
| Capture and diagnostics | Actual native RHI frame, source UUID/entity mapping, immutable receipt and fresh-device replay; replay and oracle both check WebGPU validation scopes. | Diagnostic `captureFrame()` is an extension; it is not Three render-target readback. |

## Physical texture recipes without engine changes

Native Cook generates code from **declared texture membership**. A wider recipe
would sample absent maps; choosing the first superset is incorrect. The adapter
therefore selects an exact texture set and never silently disables a map or layer.
Numeric factors remain mutable within a recipe, including transitions through zero.

Bundled recipes are: no maps, `map`, `clearcoatMap`, and
`map + normalMap + roughnessMap + metalnessMap + clearcoatMap`.
Other combinations can be prepared by the public build-only entry. This closes
the peripheral program-publication path without a player compiler or a copied
Standard shader:

```ts
// Build script, run in Node before the application build.
import { writeFile } from 'node:fs/promises';
import { cookPhysicalMaterials } from '@forgeax/engine/three/build';
const programs = await cookPhysicalMaterials([
  ['normalMap', 'roughnessMap', 'clearcoatMap'],
  ['roughnessMap', 'clearcoatMap'], // application can later remove the normal map
]);
await writeFile('src/physical-programs.json', JSON.stringify(programs));
```

```ts
// Player: this import is data, not a compiler.
import programs from './physical-programs.json';
const renderer = new THREE.WebGPURenderer({
  canvas, forgeax: { materialPrograms: [programs] },
});
```

The source-to-slot list is shared with `material.ts`; all code comes from native
Cook and is validated by the native publication loader. The package test compiles
and admits an extra exact recipe and rejects a missing variant. Authored normal
maps take precedence over bump maps in recipe selection as in r184.

This configuration is a remaining **setup difference** from Three's automatic
NodeBuilder path. Runtime-loaded assets must have their possible map sets cooked
before publication. Eliminating this setup needs native runtime specialization or
a producer connection, not an exponential library of precompiled combinations.
A recipe still has to fit the native device sampler/texture layout: the rejected
all-map experiment required **23 fragment samplers versus the device limit 16**.
Cook success alone is not GPU admission or a rendering fidelity certificate.

## Native boundaries, with priorities

These are specific missing facts/semantics, not conclusions drawn merely from an
adapter rejection. Implementing a second renderer or copying native shaders into
this package is outside this architecture.

| Priority | Work for the native owner | Evidence / reason |
| --- | --- | --- |
| P0 | Target-only submission and readback of an already submitted target | [Camera roles](../render/src/render-system-extract.ts) distinguish auxiliary targets from display cameras. [CameraView submission](../render/src/assembly/camera-views.ts) supports a 2D target but still invokes the screen compositor; [compositor](../render/src/assembly/view-compositor.ts) clears the surface even with no screen views. Using that path for `setRenderTarget().render()` changes the canvas. [Readback tickets](../render/src/targets/contracts.ts) attach to a future matching frame; Three's read call must read the last target contents without an extra scene render. Existing create/resize/texture-source APIs do exist. |
| P0 | Attachment/target command semantics | Partial clear, autoClear=false, preserved depth/stencil, custom clear values, subregions, MRT, selected mip/face/layer and ordered copies need native per-command load/store and target selection. Existing auxiliary captures are not a substitute. |
| P0 | Ordered draw facts | Opaque renderOrder/custom sorting, per-object/per-material callbacks and mutation between groups require actual native draw boundaries. Source Scene callbacks are already handled here. |
| P1 | Material families and sampling | Phong/Toon/Depth/Distance/Shadow, Basic AO/light/environment maps, additional Matcap inputs, line/point varyings, per-material environment and global SH need native evaluation inputs. Physical dispersion and clearcoat-normal XY scale are not representable by current fields. |
| P1 | Physical program and resource admission | Exact recipes can now be supplied externally. Automatic arbitrary membership changes and higher map counts need native specialization plus sampler/layout admission; do not weaken WebGPU validation or silently drop a map. |
| P1 | Fog and environment | Three Fog/FogExp2 use depth laws different from native height fog. Cubemap/refraction/material-local environment and background blur need native source/roughness contracts. |
| P2 | Renderer/scene special cases | Zero active exposure is rejected by native Camera (requires >0); alpha=false opaque surface, logarithmic/infinite/custom views, XR and arbitrary projective UVs need native representation. |
| P2 | GPU utility methods and texture kinds | Compile/prewarm readiness, eager asset texture upload, GPU copy/storage/MRT/node APIs, depth/array/3D material sampling and performance/info queries need truthful native observations/operations. Constant stub results are not implementations. |
| P2 | Self-contained live-video replay | Live sRGB video rendering works; captured `copyExternalImageToTexture` fails replay with `external image sources are not self-contained`. The tape owner must serialize source content. |
| Deferred | Addons and effect graph API | Existing OrbitControls/GLTFLoader remain. PostProcessing/TSL/GTAO and expanded addons require their separate authoring/runtime surface; none are silently enabled. |

## Measurements and independent reference

Each image comparison is 128×128 RGBA8 against a separate original r184 renderer,
asserting `backend.isWebGPUBackend === true`. Both devices check validation errors.
Normal acceptance thresholds remain normalized MAE ≤0.05 and at most 3% of
channels differing by more than 0.05. Initial feature cases complete 60 ready
frames; mutations reuse the same native renderer. Edited frames replay on a fresh
device, except the explicitly diagnosed external-video serialization boundary.
Skin, morph, instance-morph and batch cases additionally require silhouette
intersection over union of at least 0.9, so empty background cannot dilute a
deformation error.

The former partially metallic IBL and AlphaHash output-alpha discrepancies now
have RGBA comparison regressions. Environment tests exercise dielectric, metal,
intermediate metalness and Physical specular controls; output tests include
Normal encoding, opacity, mapped coverage, premultiplication and blending.
Shadow fixtures compare directional/point/spot receivers, filter selections,
cast/receive flags, caster-only camera layers and retained manual updates. Each
published measurement names its fixture, reference, pixel threshold and replay.

Reference limitations are explicit: r184 can retain invalid GPU views when a live shadow map is resized; resize-while-frozen tests restore the admitted dimensions before requesting an update, while fresh rectangular maps are tested independently.  r184 can retain stale Texture.channel nodes,
so references are independently initialized per authored configuration. SkinnedMesh
copies share their source Skeleton, while r184's SkinningNode caches frame IDs
globally by Skeleton. The oracle therefore gives each renderer an independent
palette and remaps its bones to the copied scene; otherwise a new renderer's
frame 1 can retain an earlier pose. BatchedMesh
copy omits some state; the oracle preserves source batch inputs without sharing
its index buffer. r184 promotes Uint16 indices on first upload after computing
batch byte offsets, so the oracle warms once before reading a batch. These are
upstream reference conditions, not native fixes or performance comparisons.

`artifacts/three-compat/` contains lossless actual/reference readbacks and RHI tapes.
The PR publishes comparison images, per-case metrics and a runnable preview.
`node packages/three/scripts/audit-api.mjs --output <path>` derives the complete
runtime/type/member inventory from r184. Its full-surface `--check` remains red
because native-dependent interfaces above are missing. Export counts and shared
CPU implementation are not a meaningful percentage of rendering compatibility.
