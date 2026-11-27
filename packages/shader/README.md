<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# @forgeax/engine-shader

## Source-template publications

`programTemplateInspection()` returns preparation counters without listing programs.
Pass `{ includePrograms: true }` to inspect the already selected program identifiers
and canonical definition keys for reproducing a workload. This detached inspection
never compiles an additional selection; equivalent aliases share one row.

`ShaderRegistry` owns source recipes, selected CPU programs and reflection. A
`7.0.0` manifest publishes a `shader-template-library/1`: verified shared source
modules, program inputs and feature axes. Admission initializes the host-supplied
portable compiler but compiles no program. `materialShaderAxes` and
`findVariantByKey` select declarations without expanding source. Reading the
selected source prepares its immutable program once; GPU modules remain device-local.

| Boundary | Contract |
|:--|:--|
| `installProgramTemplates(library)` | Atomically verify source references and compiler inputs; no GPU objects |
| `resolveProgramTemplate(id, selection)` | Exact complete selection, structured failures, shared CPU program/reflection |
| `installMaterialManifestTemplate(id, key)` | Admit the material schema and selected declaration without composition |
| `materialArtifactDeclaration(id)` | Inspect ready, byte-backed or native-template state without preparing it |
| `prepareProgramCompiler` | Explicit host service; the Registry never imports file discovery or Node cookers |
| `forkForDevice(device)` | Reuse prepared CPU programs and create fresh device modules |

Engine recipes own their parameter schema. A family borrows that schema rather
than publishing a second interface. Stock Engine identifiers reject a changed
parameter layout with a canonical receipt. Material values and render state do
not enter the feature selection. Template identity never masquerades as the
content digest of final WGSL.

`buildEngineShaderTemplateManifest()` in the shader tool package produces this
source format without composing a Cartesian product. Existing precompiled
publication versions remain readable. Their producer and consumption contract
is described below; source templates do not change those wire versions.

A project can also publish an `8.0.0` manifest with `templates` and `cooked`
sections. The Registry verifies both sections before publishing any row and
rejects overlapping entry hashes or material identifiers. Device recovery
reuses the verified cooked rows and reconstructs device-local template readers.

## Native Grade and Final kernels

`forgeax::standard-output-v2` is one source recipe with four finite Grade entries
(plain, LUT, Bloom, LUT plus Bloom) and two Final entries (with or without FXAA).
Continuous effect controls use `STANDARD_OUTPUT_V2_PARAMS_LAYOUT`, a 160-byte
uniform block. Grade keeps scene HDR until grading, then stores display-encoded
UNORM8; Final filters that encoded image. Pointwise-only output can finish inside
Grade while retaining the same UNORM8 rounding boundary. Coverage alpha is preserved.
The legacy 32-byte tone ABI remains independent. These kernels are prepared for
native graph integration; they do not yet change the default frame graph.

## Fragment coverage specialization

The fixed Engine Standard PBR receipt factory publishes generation 6 with the
`standard-gbuffer/2` writer contract and a matching receipt identity. Its vertex
layout remains contract 5. Generic/custom receipt construction grants no GBuffer
version; its actual producer must certify that output through material cook.

Builtin Unlit color and surface-data programs select alpha-mask and camera
clipping axes from actual material and view demand. Skinned Standard programs
use the same camera-clipping axis as rigid Standard. Genuine material-local
clipping remains independent. Unlit coverage helpers return rejection; fragment
entry points own alpha `discard`, preserving cutoff and hash comparisons without
introducing another nested-discard path. Temporal keeps its existing exact
coverage contract independently of the opaque color selection.

Rigid and skinned Forward entries prepare Surface samples and derivatives once,
then own view/alpha rejection before direct and environment lighting. Pure
coverage predicates preserve plane counts, union/intersection and alpha boundaries;
helper-only passes retain their shared coverage wrapper. Arbitrary authored
Surface side effects and independent local/LOD coverage remain intact. Native
acceptance uses the actual explicit binding layout and full cooked PBR program,
because an automatic-layout shader probe can miss a Metal compilation failure.

Selected-entry native effects travel with the same immutable program as binding
reads. Registry transfer and device forks retain them. A matching native
publication may enrich legacy reads that omitted effects; later legacy input
cannot erase known facts. Contradictory effects for identical source are rejected.

## Forward vertex height fog

The shared fog module separates the height integral from blend composition.
Stock Standard, skinned Standard, Unlit, Sprite, lit Sprite, MSDF and point/line
vertices carry scalar transmittance in an existing normal or position varying's
fourth component. Ordinary height fog has a constant view source, so fragments
recover its in-scatter from that scalar without another varying location.
Straight, premultiplied, additive and fogged-transmission composition share one
owner. Full atmosphere retains its RGB transport.

`View.fogSky.y` selects the native vertex-height route for ordinary Forward
display views. `View.fogSky.z` carries camera-height density computed once per
view. Full Atmosphere, Deferred and capture views retain their screen transport.
Data-only and `fog:false` draws use the existing disabled View slot.

Material programs declare `forwardFog: 'height-vertex/1'`. Native stock producers
publish it automatically; custom WGSL declares it in `MaterialAsset.program`
and applies `vertex_height_fog` / `forward_fog` before blending, or explicitly
opts out with `renderState.fog: false`. Cooked ABI, templates and byte-backed
registrations preserve the contract. Ordinary Forward rejects an undeclared
color writer instead of silently omitting fog or restoring a screen pass.

## Direct-light components

The internal `DirectLobes` result carries reflected diffuse, non-SSS specular
(including diffuse transmission), and the combined radiance in its original
arithmetic order. Point, spot, additional directional, sun and LTC rectangle
lights own each evaluation once. Range, cone, cookies, projectors, IES and shadow
factors apply to the same components before one Cluster traversal accumulates them.

Deferred SSS reads diffuse directly instead of shading a second zero-albedo
material and subtracting HDR values. Forward and existing vector shader imports
project combined radiance from the same evaluator; unused component outputs can
be eliminated without additional feature axes, bindings or material variants.
This transient shader result is not an asset, serialized program IR or CPU cache.
Direct and environment multiple scattering retain their existing models.

## Volume integration work

The production integrator retains its 96 midpoint schedule, depth clipping,
local-light refinement and multi-volume overlap. It stops an interval once depth
clipping leaves a zero-length segment. Single-volume ray and optical invariants
are computed once per output ray; overlapping volumes keep their per-owner path.
Adjacent visibility channels reuse one filtered RGBA sample until they cross a
packed layer boundary. Paired and individual light producers use explicit control
flow so WGSL `select` does not evaluate both. These are work-reuse rules, not
quality settings. The production GPU stage readbacks exercise source templates
and prepare only the three volume kernels they actually dispatch.

## Screen-space ambient occlusion kernels

Standard SSAO shares a reduced furthest HZB and uses a fixed 4x4 rotation
pattern with view-temporal phase. Forward reconstructs depth normals. Deferred
adds depth and normal weighted setup and reconstruction for coarse levels.

GTAO shares horizon search and the projected-normal integral between native
compute and raster. The spatial filter projects each depth tap onto the
receiver's depth plane. Temporal filtering uses a separate submitted view
history, and the resolve publishes the minimum of four bilinear samples.

Publication metadata shares immutable facts within one admission. Lossless JSON
row children are coalesced before recursive interning; signed zero, sparse arrays,
optional values and nonstandard prototypes retain the original structural path.
Accessors retain the ordinary admission route without being invoked by the
sharing preflight. All source digests and reflection validation remain required.

## Conservative surface intersection

`SDF_SURFACE_INTERSECTION_WGSL` owns binding-free canonical-f32 triangle and slab
interval queries. `SDF_SURFACE_LOCAL_RAY_WGSL` derives the complete module plus
raw-affine local-ray construction from that same authority; consumers include
only the latter when they need both. Callers supply forward-derived residual
certificates for the stored inverse. Its single `SdfSurfaceRay` input preserves
world-space origin/direction intervals and original parameters. Those intervals
must already enclose upstream arithmetic; endpoint subtraction must use interval
operations and must not normalize away the original segment parameter.
Unsupported words or arithmetic remain unavailable. Only a primitive hit
certifies intersection, and slab pruning requires its separate certificate.

Private surface pool V4 keeps complete shared Mesh geometry separate from
placement-owned coverage. Explicit row records describe opaque, unknown or
shared partial primitive bits; absent or corrupt records remain unavailable.
An unknown primitive intersection blocks a later or equal hit, while a proven
miss does not poison another section. Asset V5 and the 144-byte Instance stay
unchanged. Coverage changes rebuild the retained pool before publication;
ordinary material values and poses do not rewrite shared coverage payloads.

`SDF_SCENE_TEXTURE_READ_WGSL` adapts a canonical integer texture to the pool
decoder's word-fetch functions. Its private header snapshot lasts one invocation.
The allocation capacity stays distinct from `sdfSceneRowLimit()`, the candidate
traversal upper bound; neither fetch transport nor packet metadata qualifies geometry.
Call `sdfSceneView()` explicitly before any word or count query and reject its
invalid state. It initializes the invocation's snapshot once; word functions read
only that snapshot and expose zero before initialization. Bindings and expected
facts must stay unchanged for the invocation.

> [!IMPORTANT]
> Supply `sdfSceneExpected()` from the canonical source owner: instance words,
> field words, row limit and nonzero epoch. Never derive it from the sampled
> texture. Complete projection before reads, and keep bindings and expected
> facts immutable during an invocation. Invalid metadata exposes no source words.

## Physical atmosphere tables

`atmosphere-table-kernels.wgsl` owns transmittance, multiple-scattering and Sky
View texel arithmetic. Compute and fragment entry points wrap those same functions;
only invocation addressing and storage/render-target I/O differ. The shader plugin
publishes both bundles. Full Atmosphere uses native compute volumes or fragment
producers with half-packed RGB aerial transport in the existing integer Cluster
texture. Both preserve the same optical integration budget, distant illumination
and surface transport. The explicit background-only option remains separate;
runtime selects a published plan without compiling or rewriting shader source.
See the [render contract](../render/README.md#atmosphere-and-aerial-perspective).
The advanced Water material mapping distinguishes full shallow fields from
residual-only fields. The latter contribute height, normals and foam while
preserving the ordinary Terrain depth and Body flow. Frame-atlas sampling uses
the producer's cell-center convention and clamps within each current/previous
half before interpolation. See the [Water entry](../water/README.md#advanced-simulation-entry).
Residual-only and shared contact foam are bounded surface coverage. Their
opacity and scattering retain the authored foam texture and do not enter the
legacy height power, boost or threshold. They compose with the ordinary foam
response by maximum, so contact capture preserves an independent local-wave
field. The world-space response reserves room for local fluid foam only while
that Body has an active local foam field.

Display and cube rays retain atmospheric scattering up to a planet intersection.
Ground reflection belongs to `atmosphere_multiple_scattering_texel`; the display
background adds no Lambertian planet surface. Keep the default ground albedo
independent of authored terrain materials and Skylight tint.
## Water terminal continuity

`water_transition_continuity` consumes WaterMesh v8 `WCN1` numeric support from
actual paired coverage. Vertex lookup and fragment triangle interpolation use
original unit-grid coordinates, before horizontal displacement. Full support
selects the target mean plane and unmasked target Gerstner phase/current and
previous clocks; source depth/flow remain source-owned. Outside support the
existing deformation is unchanged. Intermediate normals use the actual
rendered triangle derivative, evaluated uniformly before selection. There is no
per-fragment polygon/ring-distance loop and no extra inter-stage location.
See the [Water policy and limitations](../water/README.md#optional-terminal-surface-continuity).

The bounded plain storage-forward publication domain admits `LEAN_LIGHTING`
independently of `DIRECTIONAL_SHADOW_SIMPLE`. Lean lighting excludes only modifiers
proven absent by the accepted View; general receivers preserve every authored
shadow profile. Runtime selects the published artifact and does not rewrite WGSL.

## Public shader input boundary

Directional PCSS uses one bounded loop with ordered blocker and comparison
phases, sharing disk addressing instead of duplicating it in native pipeline
compilation. The comparison phase starts only after blocker accumulation and
preserves the disk order, receiver-plane correction and cascade blend.

Medium retains 8 raw plus 16 comparison taps; high retains 16 plus 32. Read-only
disk points are one module `const` table indexed at the single tap site; a
`var<private>` table would be initialized by every Standard fragment, including
those whose profile never reaches PCSS.

Direct text admission compacts fragments and computes its complete source identity
once. Equal content reuses the Registry's canonical source; device forks borrow
that admitted source without rehashing it. No expanded body is memoized.

The build manifest is the single published shader input catalog. The plugin
composes engine WGSL modules and material rows once; runtime resolves the
content-addressed result through `ShaderRegistry`. The shared View module is
identified by `forgeax_view::common`; its typed ABI describes offsets and
binding metadata only, never a device or GPU handle. Fog and temporal fields
are transported through this existing module/reflection path rather than a
second manifest or registry.

The plugin publishes schema `5.0.0`: one fragment table, content-addressed source
references and shared ABI receipt and entry-read tables. Equal entry-read arrays
are published once; direct entries, materials and variants retain their exact
`entryPointsIndex`. Missing facts remain distinct from an empty read set. The
reader validates every reference and owns one immutable copy per table row.
After detaching reflection facts, admission shares structurally equal immutable
subtrees within that publication. The temporary pool is discarded after admission;
separate publications remain independent. Explicit `ownedReflections` transfers a
fresh private JSON tree without cloning it; full immediate validation remains the
default, independently of deferred validation. Borrowed inputs retain detached
snapshots. Complete values, own field order,
optional absence, array multiplicity and signed zero remain distinct. Non-plain
or cyclic extension data retains the ordinary detached-copy route. This changes
neither the wire format nor reference/variant validation.
The Registry's owned JSON route shares the same complete facts without a second
clone; row validation remains deferred until first read. Accessors and non-plain
facts retain the ordinary deferred path rather than acquiring shared identity.
The ordered-fragment source digest remains v4 because source identity is unchanged. `ShaderRegistry.loadManifest()`
hashes each pooled UTF-8 fragment once, then checks each source's domain-separated
digest of its ordered fragment hashes before validating every entry, variant and
receipt for atomic admission. It never joins complete sources for verification;
composed strings are borrowed only when a consumer requests them. Selected sources
share one publication-local lazy owner per digest without memoizing expanded bodies.
Rows retain detached enumerable getter capabilities; source ownership does not retain
other selected sources through a publication-wide closure. ABI receipts are shared immutable facts.
Failed validation leaves the registry unchanged. Precompiled-publication consumers do not compile WGSL. Source-template
consumers resolve only selected programs through the host service. Digest verification runs in bounded batches and never skips unselected
sources. Older compact profiles must be rebuilt by their producer.

Compiler-produced `entryPoints` remain immutable facts of each exact composed
variant. Material receipts, private publication, manifest admission and device
forks preserve them without loading unselected source strings. Runtime consumers
may compare only fields read by the selected entries; a source without these
facts uses conservative invalidation; inspecting precompiled metadata never
invokes the compiler.

Native hosts supply `ShaderRegistryOptions.readText`; App/Renderer forward it as
`BundlerOptions.readShaderManifest`. The reader returns complete text or rejects.
Device forks retain that reader and the same verified CPU publication. Browser
reads keep HTTP status checks; native reads do not require a global fetch shim.
SHA-256 uses Web Crypto when present and the same digest contract through
`@noble/hashes` otherwise. LTC table provenance uses the same SHA-256 library
synchronously over the supplied table byte view.

Material module alias matching compares the admitted fragments directly against
the selected source. It preserves complete string equality, including fragment
boundaries, without expanding or caching unselected variant strings. Pattern
inspection temporarily composes one complete source and leaves the selected-source
cache untouched; a pattern can span any fragment boundary. Literal
source rows use the same equality rule.

Registries that fetch byte-identical manifest text from the same URL share one
verified expansion and its read-only lookup indexes. The registry publishes
the indexes only after the complete document passes validation. A failed
replacement leaves the previous admission reusable. The cache holds the
indexes weakly, and each device still owns its compiled modules. The cache
keeps a SHA-256 identity of the complete
text, formed from ordered SHA-256 chunk digests, instead of retaining the wire
JSON beside the admitted facts. Each 128 Ki-code-unit chunk uses ASCII bytes when
possible, otherwise exact UTF-16, including unpaired surrogates. The root digest
binds the encoding of every chunk. One 256 KiB working buffer is reused; widening
a chunk may copy its bounded ASCII prefix (at most 128 KiB). Character reads avoid
encoding a complete second text. Chunk hashing uses Web Crypto when available and
the same fallback as source admission. No full encoded text or additional cache
is retained. Published source identities and wire bytes are
unchanged. Each registry still reads the input; changed text is parsed and
verified again. GPU prewarm may subsequently demand device-reachable variants;
the admission memory budget does not claim that a complete renderer or GPU uses
the same memory.

`ShaderRegistry.materialProgram(source)` admits one immutable program description
per composed source within the registry lifetime. The description owns a source reference,
its identity, vertex UV count, group-2 contract, ProbeBlend requirement and whether
the material uniform is referenced anywhere in the module. A declaration-only uniform keeps
the shared layout without making scene-index commands depend on frame-local
material offsets. Unknown declarations and references in any helper or entry
retain the ordinary offset. The description also retains the literal group-1
binding slots from this same cold source admission. Layout and recording can omit
an undeclared backdrop sampler from single-source registrations, including content-hash
program names; unknown binding expressions and shared variant layouts keep their
conservative binding policy. Registrations, selected
variants and material passes share it; `forkForDevice()` retains these CPU facts
while GPU modules are rebuilt. Reflected entry reads can complete a warmed description
without rescanning its source. The registry owns that detached immutable contract;
conflicting reads for the same source are rejected before a prepared shader is returned, including
contradictions between explicit reads and an ABI receipt. New source selects a new description. The runtime
description retains the sampled user-region texture names too. Staged registration
reuses these exact-source facts, while every schema still passes admission and
the undeclared-texture check. No GPU work, failed schema or caller-supplied metadata
can authorize a material registration. The runtime `MaterialShaderArtifact.program`
carries this description instead of independent
WGSL, identity and optional binding-decision fields. Synthetic producers use
`createMaterialShaderProgram()` when constructing an artifact, never while drawing.

Cooked material programs use `installMaterialArtifactBytes()`. Container readers
own byte integrity validation; the Material loader closes the publication tuple
and complete program set. Shader admission takes one private byte snapshot and
admits schemas and ABI/read metadata, rejecting same-key conflicts without
preparing WGSL. Later reuse of the caller's input buffer cannot change that
snapshot. `materialArtifactDeclaration()` inspects the declaration without
preparing it. First `materialArtifact()` / `findMaterialArtifact()` lookup decodes
that source and performs the same source analysis and sampled-texture/schema
checks as direct registration. A failed source never becomes ready. Direct
`installMaterialArtifact()` stays eager for authored source.

Cooked entries may declare immutable `variantReferences`: boolean selections
pointing to existing program keys. The Registry projects these owners into its
ordinary material manifest without decoding source or retaining another Registry.
Every referenced program must be present in an atomic adoption or already held by
the receiver; conflicting schemas, axes or key metadata reject the publication.

Selected sources retain their complete decoded WGSL without runtime fragmentation.
Byte owners
weakly share pure CPU sources and descriptions across registries;
registry adoption and device recovery preserve pending declarations without creating
GPU objects. This does not defer artifact loading, decompression or digest validation,
reduce delivered variants, or change the existing GPU pipeline compilation policy.

An owned WGSL snapshot delivered in a compressed frame may retain its exact
private frame with weak decoded views. A cold synchronous byte read restores the
member window with the initialized decoder. Copy provenance requires exact bytes;
it does not authorize or skip container, tuple or ABI admission, and there is no
realm-wide digest admission ledger. Held private views remain stable; forks and
device recovery share the existing CPU owners. Selected sources retain complete
decoded WGSL without runtime fragmentation. Initial decode and complete source
admission stay eager; all variants and GPU compilation policy remain. There is no
runtime compression, network read or per-frame decode added by this storage.
`MaterialArtifactRegistry.inspect()` reads logical lengths without restoring
programs. `storageStats()` deduplicates retained compressed-frame instances and
reports a storage recipe budget, not live RAM.

`shaderSource()` admits material, utility and VFX text into the same CPU owner.
`MaterialShaderProgram.sourceReference` retains immutable source text; `.source`
borrows the complete string. Runtime raw text is not split, copied or pooled as
fragments. Build-produced manifest fragment references remain supported; their
publication format and integrity checks are unchanged. Vertex entry locations, fragment/temporal presence and
storage use are program facts, so managed pipeline validation does not rescan WGSL.

Registered programs and their source owners follow the existing Registry
lifetime. Forks share these CPU facts and adoption validates the whole batch before
publication. There is no cumulative source-byte or registration-count quota added
by this storage change. `sourceInspection()` reports unique logical UTF-16 bytes,
source/program counts and schema projections; these are not retained heap bytes.
Utility module adapters retain sources with their device-generation owner and do
not append them to a cross-generation Registry history. Input verification and
per-action pipeline-library export limits retain their own existing boundaries.

Canonical Standard pipeline and Sprite schemas enter the existing
`ParamSchemaProjectionOwner` once at module initialization. Their immutable
interfaces are reused by fallback extraction and recording; registered program
schemas retain their own ShaderRegistry admission.

`ShaderRegistry.materialArtifact(identifier)` returns the current immutable
registered entry or `undefined` for an ordinary optional miss, without constructing
a failure diagnostic. It observes later registrations directly. Required lookups
retain `findMaterialArtifact(identifier)` and its structured Result/error.

Manifest publication admission snapshots and recursively freezes each pooled ABI
receipt once before source verification yields. All variants referring to that
receipt share its immutable type facts; caller edits and later publications
remain independent. Material keys do not clone the same reflected type tree.
Freshly parsed owned reflection tables share identical immutable subtrees at
admission while each selected row retains its deferred schema validation. The
short-lived sharing pool does not survive admission or join publications.

Material registration owns a detached, recursively frozen ABI receipt alongside
the admitted schema and program. `installMaterialArtifactsFrom(sourceRegistry)`
accepts only another registry's private registrations, optionally a named subset: it checks every identifier
and retained schema conflict before installing any entry, then shares pending byte owners or validated
CPU facts without reparsing WGSL or deriving the interface again. Each receiving
registry retains its own schema projections and GPU lifetime. Publication callers
validate the complete batch in a temporary registry before this commit; no author
object or string key grants admission.

The published ray diffuse composite and Standard environment lighting share
`standardDiffuseWeight` in `forgeax_pbr::ibl_shared`. The traced input is
unit-receiver `D = E/pi`; the composite applies the G-buffer receiver color,
metallic/Fresnel response and material occlusion once, then adds only RGB to the
existing linear HDR target. It preserves direct lighting, emission and coverage.

## Atmospheric transport

`forgeax_atmosphere::optics` owns spherical bounds, densities, normalized phases,
solar transmission and segment integration. Sky View, finite-depth aerial
perspective and capture/direct rays share this kernel. Local geometry/cloud
visibility multiplies the single-scattering source only. A separate low-frequency
multiple-scattering LUT supplies the high-order approximation. Radiance LUTs
use unit-white-sun values; consumers apply solar colour and lux once. RGB
transmittance is independent of alpha. The homogeneous far endpoint preserves
view-ray direction at orbital coordinates and supports infinite far planes.

The 1,280-byte View carries six medium vectors and one control vector after the
existing fog lanes. Material capability `storage-buffer-atmosphere` selects the
cooked atmosphere bindings; the receiving device must admit the full texture
budget. Utility program defines are build-time inputs too. Precompiled publications stay compiler-free, including cloud transport/resolve
and custom Surface material programs.

`view_fog` composes extra height fog over physical AP. Straight alpha uses `TC+L`,
premultiplied alpha uses `TC+alpha*L`, and additive uses `TC`. Transmission keeps
its already-fogged backdrop separate: `T*C_local + k*B + (1-k)*L`, where `k` is
the final RGB transmission weight. No second fog pass follows translucency.

Skin capability derives from the admitted pair of `skinIndex` and `skinWeight`
vertex semantics. Cook rejects an incomplete pair; receipts and prepared draws
carry no duplicate palette-address flag. Physical buffers remain part of the
actual reflected binding contract. Receipt generation 4 separates this shape
from the old redundant metadata and requires re-cooking consumers.

## LOD coverage ABI

Rigid Standard keeps at most fifteen user varyings beside `front_facing`.
Water alone carries coverage/grid coordinates and derives NDC from its
interpolated world position; ordinary variants retain interpolated NDC.
The final object-basis element shares world position's fourth lane.

Scene-index vertex stages use `@builtin(instance_index)` only to address the
bound visible-item buffer. It may include the indirect first-instance offset;
stable scene and material identities come from the selected visible item.

The GPU-driven cull selects the LOD level and signed coverage per view and
writes them into the visible item `vec4<u32>`: `x` is the GpuScene instance
row, `y` the scene material row, `z` the view candidate row for every deformation,
and `w` the bitcast signed coverage (zero keeps all samples). Skin entries read
both palettes from `sceneInstances[visible.x].customDataStart`; the world-space
palette receives no additional entity transform. Scene-index vertex
stages resolve world, previous-world, temporal flags and probe identity through
`forgeax_view::common::sceneIndexDraw(visible.x)`; there is no per-batch Mesh
row. Standard's flat material-address varying carries coverage in its fourth
lane, and ShadowCaster carries it beside the material row. Forward, Deferred,
rigid LOD temporal data, and ShadowCaster call the shared
`forgeax_view::common::applyLodCoverage` predicate before committing fragments.
`LOD_DITHER` and `CLIPPING_PLANES` are independent compile-time selections.
Ordinary non-fading writers carry neither rejection; scene-index cross-fade
writers select LOD coverage without introducing camera clipping. Visible-surface,
masked and temporal writers use the same demand rather than forcing both sources.
Shadow pipeline preparation selects LOD coverage from the same batch capability
as live recording, independently of the receiving camera's `clipShadows` flag.
The pair uses the same stable pixel-space noise and opposite sides of one
threshold. Encoding the pair as `+t` / `-t` keeps that threshold identical
after float32 upload, including near rounding boundaries. This keeps opaque
depth writes and material alpha masks intact.

`sceneIndexDraw` uses the primitive's current and previous root matrices directly
when the instance names reserved transform row 0. GPU Scene keeps that row as
identity through initialization, growth, slot reuse and rebuild. Explicit
`Instances` always own nonzero local rows and retain root × local composition,
including explicit identity matrices; no shader variant or binding changes.

> [!IMPORTANT]
> Migration: a cooked scene-index material must not read `Mesh` rows or treat
> `visible.x` as a batch-local index. `visible.x` is the scene instance row;
> call `sceneIndexDraw(visible.x)` and take coverage from
> `bitcast<f32>(visible.w)`.

## Canonical MaterialAsset Path

`paramSchema -> derive -> compile/reflect -> cook/load -> extract/record`
spans shader and material. The WGSL producer declares only schema-matched fields.
Texture slots carry `coordinateSet`, transform and `physicalUvScale`; after cooking,
`layoutIdentity` binds the shader artifact. If identity becomes invalid, repair
source or cook inputs, then recook/load.

> [!IMPORTANT]
> Runtime resolves only published content-addressed artifacts. Recovery follows
> producer, cook and catalog ownership; apps never duplicate shader artifacts.

## Standard Surface contract

Standard material authors only need to `#import`
[`surface_v1.wgsl`](./src/surface_v1.wgsl) and implement
`evaluate_surface(SurfaceInput) -> SurfaceData`. `SurfaceData` supplies inputs
to the Standard BRDF rather than a final color. The Engine-owned Standard pass
family handles vertices, lighting, shadows, Forward/Deferred, G-buffer, fog and
output. Built-in defaults live in
[`default_standard_surface.wgsl`](./src/default_standard_surface.wgsl)。

### Minimal authoring shape

`SurfaceInput` exposes `uv0` through `uv7`, matching the geometry coordinate
inputs. Every texture slot selects its own set, scale, rotation and offset.
The default Surface evaluator is shared by CPU, GPU scene-index and shadow
passes; no shadow-only sampling formula may discard those authored coordinates.
Changes to the engine-owned input ABI require re-cooking authored materials.

`SurfaceData` is deliberately base-only. Its frozen field order is:

| Order | Field | Meaning |
|:--:|:--|:--|
| 1 | `baseColor: vec3<f32>` | Base reflectance color |
| 2 | `normalWS: vec3<f32>` | World-space shading normal |
| 3 | `metallic: f32` | Metallic factor |
| 4 | `roughness: f32` | Roughness factor |
| 5 | `emissive: vec3<f32>` | Emissive contribution |
| 6 | `occlusion: f32` | Ambient occlusion factor |
| 7 | `opacity: f32` | Surface opacity |
| 8 | `alphaClipThreshold: f32` | Alpha-test threshold |
| 9 | `reactive: f32` | Temporal responsiveness in [0, 1] (Responsive AA); 0 keeps the default history. Read on the deferred G-buffer lane |

```wgsl
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}

fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(
    vec3<f32>(0.45, 0.18, 0.06), input.vertexNormalWS, 0.8, 0.42,
    vec3<f32>(0.0), 1.0, 1.0, 0.5, 0.0,
  );
}
```

The matching TypeScript entry is also import-first: the caller names the
compiled Surface module and supplies only its parameters and values. The
Engine still owns stage entry points, bindings, BRDF composition, and pass
projection.

```ts
import { Materials } from '@forgeax/engine-render';

const rustedIron = Materials.standard({
  surfaceModule: 'game_3d::rusted_iron_surface',
  parameters: [
    { name: 'ironColor', type: 'color' },
    { name: 'rustDark', type: 'color' },
    { name: 'rustBright', type: 'color' },
    { name: 'noiseScale', type: 'f32', default: 1.85 },
  ],
  values: {
    ironColor: [0.4, 0.45, 0.47, 1],
    rustDark: [0.42, 0.085, 0.018, 1],
    rustBright: [0.95, 0.34, 0.055, 1],
    noiseScale: 1.85,
  },
});
```

For the complete source-to-runtime example, see the
[`game-3d` rusted-iron fixture](../../templates/game-3d/docs/guide.md#import-first-surface-material-example).

> [!CAUTION]
> Surface is a base-facts function only. Do not add `clearcoat`,
> `clearcoatRoughness`, other physical-layer fields, stage entries, resource
> bindings, Engine entry points, or vertex-position mutation. Physical layers
> and pass admission remain Engine-owned.

Progressive navigation: `Materials.standard()` → `moduleSlots.surface` → build-time
`#import` composition / reflection → Pack cook → runtime GUID readiness。
Surface source declares no stage entries, `@group/@binding` or vertex mutations.
Parameter resources derive from the same `MaterialAsset.parameters` contract.
On compile or cook failure, read `code`, `detail` and `hint`, repair authored
source or the producer and recook; never load raw WGSL or create app-local artifacts at runtime.

> [!IMPORTANT]
> A custom material starts as WGSL source plus one `MaterialAsset` contract. The build manifest publishes the composed module and the material cook publishes the resolved record, artifact bytes, references, and receipt. Runtime resolves those facts from the catalog; application code does not install or duplicate shader artifacts. The recovery route is always source or cook repair.

### Direct material program contract

A cooked `MaterialProgramAbi` always names its direct vertex entry. Its optional
`sceneIndexEntry` exists only when the producer compiled that entry. Direct-only
Unlit programs publish their actual schema-aligned row, reflected vertex inputs
and skin palette address. Cook publishes plain/color and mesh/skinned programs
under the same GUID; Render selects the exact resident geometry contract. Their
absence of a scene entry keeps these programs on the ordinary submission lane.

### Scene-index material program contract

An authored full-custom program may opt into the indirect lane only through the
compiler-controlled scene-index contract. Its WGSL must expose both `vs_main`
and `vs_scene_index`, import `forgeax_material::parameters` (or declare an
equivalent producer-owned row), and use the visible-item/material index in the
scene entry. The compiler validates the selected entries and publishes one
`MaterialProgramAbi` containing the direct/scene-index entries, reflected
resources, vertex inputs, and schema-derived row fields. Custom rows are packed
into the canonical Standard GPU Scene row; schemas larger than that page fail at cook
time and stay on their authored/specialized lane.

Render requests `address: 'scene-index'` for an indirect draw and
`address: 'direct'` for the ordinary path. The runtime never reconstructs a
receipt from a shader name and never silently substitutes the direct entry when
the scene-index pair is absent. Engine Standard passes sharing one Surface
automatically
provide that opacity (including Alpha Mask) to their default ShadowCaster.
The compiler publishes its scene-index ABI while preserving authored pass
membership, winding and culling; a program without a shadow pass stays shadowless.
An explicit shadow implementation remains authoritative.
Full-custom materials can select `forgeax::default-shadow-caster` for native
opaque coverage. The compiler publishes its direct/scene-index pair from the
custom root schema and limits its vertex inputs to position plus any selected
skin attributes; clipping and LOD coverage remain native. Custom deformation or
cutout coverage requires an authored shadow program or explicit Surface; the
compiler never infers those semantics. ShadowCaster is selected independently,
so a custom shadow program may own different coverage while sharing the same
material schema and resource provenance.

For an AI inspection, resolve the published artifact and branch on the
structured result before preparing a draw. The renderer-facing adapter selects
the concrete pass/address variant internally; the contract is the selected
artifact and receipt being one producer publication:

```ts
const published = shaderRegistry.findMaterialArtifact(materialShaderId);
if (!published.ok) {
  report(published.error.code, published.error.detail, published.error.hint);
  return;
}
const receipt = published.value.receipt;
if (receipt === undefined) {
  report('material-receipt-missing');
  return;
}
```

Application code must not fabricate a receipt from a shader identifier. A
direct-only custom artifact, including the `hello/custom-shader` fixture,
remains valid for the ordinary path but is intentionally absent from
GPU-driven admission.

## Standard lit shader contract

`standard-gbuffer.wgsl` owns packed material encoding and decoding for rigid,
skinned and custom Standard Surfaces. The deferred attachment contract lives in
[Render](../render/README.md#ssr-admission-and-bounded-inspection): geometry
initializes the existing HDR SceneColor with emissive/opacity and writes four
integer material targets. Deferred lighting adds RGB while preserving alpha.
SSAO and SSR decode the shared packed normal before spatial reconstruction.

The Standard lit and skinned PBR shaders consume one
`forgeax_standard::cluster::evaluateStandardClusterLights` accessor. The
accessor decodes the shared `DirectLightSlot` and delegates punctual BRDF evaluation;
Forward and Deferred differ only in graph topology. Unlit and fog consumers do
not import this accessor. The canonical source is `src/standard-cluster.wgsl`;
all Standard lit variants compose this one module, so there is no second
implementation to maintain.

Object-level shadow receiving uses the shared Mesh flag encoding. Storage variants
read temporal flags; uniform fallback reads the no-receive bit in `Mesh.surface.w`.
The same word's bit 0 independently selects a draw-local Sprite atlas rectangle;
Sprite consumers mask that bit explicitly. Both rigid and skinned Standard
receivers honor the flag; shadow casting remains a separate source decision.

Shadow reception is a per-draw value, not a pipeline constant: there is no
reception override, and receiving and non-receiving draws share one pipeline. The
flag does not change shadow casting, bind-group layouts or material values.

The Standard lighting paths combine screen visibility with material AO at the
indirect diffuse and environment reflection consumers. Screen reflection hits
retain the material response.

`src/standard-surface.wgsl` owns the Standard material/fragment evaluation shared
by ordinary Mesh and the VFX Mesh vertex adapter. Geometry adapters supply world
position, normal, tangent, UVs and color; they do not fork BRDF, shadow reception
or IBL formulas. Render supplies the corresponding lighting resources. The
single-level BRDF LUT uses explicit-LOD sampling, including when per-particle
surface factors make fragment control flow non-uniform.

Geometric specular anti-aliasing is part of that shared evaluation, not a material
parameter or render setting. `src/specular-aa.wgsl`
(`forgeax_pbr::specular_aa`) widens GGX roughness by the pixel's normal spread: the
three.js `getGeometryRoughness` measure at half weight (UE
`NormalCurvatureToRoughness` and Tokuyoshi-Kaplanyan filter the same screen
derivatives), taken on both the interpolated normal and the material's shading
normal and keeping the larger. The shading term is what catches normal maps and
procedural normals on flat receivers, where the interpolated normal has no spread
and a glossy lobe under a punctual light otherwise turns single pixels into
fireflies. Forward direct and IBL lighting, clearcoat, and the roughness
packed into the Deferred G-buffer all consume the filtered value, so both render
paths agree. The spread is sampled at the top of each fragment entry because
derivatives need uniform control flow. Flat surfaces without a perturbed shading
normal are unchanged bit for bit.
`packages/runtime/src/__tests__/specular-aa.dawn.test.ts` gates the effect against
an 8x supersampled truth rendered without the filter. It also replays the captured
Deferred G-buffer on a fresh device with and without the filter.

Environment reflection sampling follows Three r184's dominant direction:
`normalize(mix(reflect(-V, N), N, roughness⁴))`. Skylight and ReflectionProbe
share this direction before rotation and optional box projection, including
clearcoat callers. At full roughness the broad lobe follows the normal.
The HDR comparison uses top-to-bottom scanlines and Three HDRLoader's
`flipY=true` convention. A bare DataTexture defaults to `flipY=false`; that
input mismatch must not be diagnosed as an Engine cube-orientation defect.

The GGX environment prefilter keeps 1024 Hammersley samples for every nonzero
roughness. At exactly zero roughness, all half-vectors and reflected directions
coincide and the source mip is zero, so the normalized weighted sum reduces to
one sample. Cubemap orientation, filtering, mip policy and every rough layer
retain the same contract. `src/__tests__/ibl-prefilter.dawn.test.ts` compares the
shipped entry to the frozen 1024-sample predecessor over all six cube faces,
oblique directions, camera-cube orientation and roughness endpoints on a real
GPU. A one-sample falsifier at nonzero roughness must fail that radiance oracle.

The fixed 256-square, 1024-sample BRDF bake evaluates Schlick's fifth power with
products and reuses its view/half-vector dot product and pixel roughness squared.
Its sample domain and binding contract stay with `src/ibl-brdf-lut.wgsl`.

Specular IBL conserves rough-metal energy with the table-free multiple-scattering
term of Fdez-Aguera (JCGT 2019), the same form as three.js
`computeMultiscattering` and UE `EnvBRDF` energy compensation. The existing split-sum
LUT supplies `A`/`B`; `specularEnvironmentAlbedo` in `src/ibl-sampling.wgsl`
returns `FssEss + Fms·Ems` with `Ems = 1 − A − B` and
`Favg = F0 + (1 − F0)/21`. Every consumer (Standard Surface, Deferred lighting,
clearcoat, single-layer media, skinned PBR) reaches it through
`projectSpecularRadiance`; diffuse `kD` is unchanged. A white metal in a
uniform radiance-one furnace returns one at every roughness, while colored
metals gain only the missing bounce share. Two Dawn gates pin this:
`packages/render/src/__tests__/ibl-multiscatter-furnace.dawn.test.ts` probes the
kernel against the baked LUT, and `packages/runtime/src/__tests__/ibl-furnace.dawn.test.ts`
renders roughness 0→1 spheres on both paths. It replays the captured shading draw
with and without the term. A single-scatter build of the same manifest is the
falsifier. Ordinary CI omits repeated pass-cost sampling without a performance bound.

Direct-light multiscattering defaults to the table-free Lazarov fit used by
Unreal `EnvBRDFApproxLazarov`. The reference is the knowledge-base checkout at
`71fe36aac5a8df5ccd66c763ffc902b29b6a9c43`, `Engine/Shaders/Private/BRDF.ush:610–639`
(blob `253eb4d459645cd815f2ad4d66275bc4550ba425`), verified against the user-supplied
archive. The formula is also published in Epic's
[Physically Based Shading on Mobile](https://www.unrealengine.com/en-US/blog/physically-based-shading-on-mobile).
Inputs are perceptual roughness and the normal cosine. Engine preserves the
fit's total energy `A+B=1−0.55·roughness` while projecting its bias into `[0,A+B]`
so both channels stay nonnegative. Existing Engine F90 and Favg² compensation
remain unchanged; the Unreal green-channel F90 heuristic and fully-rough diffuse
transfer are not imported.

`Materials.standard({ baseColor: [1,1,1,1], directMultiscattering: 'lut' })`
explicitly selects the higher-quality Three r184 16×16 RG16F texture. Its 1024
original bytes are uploaded once per DeviceScope and shared across materials,
independently of Skylight and IBL readiness. Texture filtering uses native linear,
clamp-to-edge sampling at mip zero; no runtime shader contains the former 256-word
array. A declared `directMultiscatteringLut:u32` parameter owns this capability:
zero evaluates the fit and nonzero samples the texture. Default materials omit
the parameter and the resource. Declaring the capability reserves one more
sampled texture; insufficient device limits remain a structured failure.

The two models are intentionally different. Against the original texture on a
1025² parameter grid, the bounded fit's maximum absolute A/B errors are
0.409864/0.147950; at roughness 1 and grazing view, total-energy error is about
49.94%. The fit is a mobile cost/quality choice, not Three r184 numerical parity.
The exact texture retains its source data, but native half-float filtering can
round differently from the former high-precision manual interpolation. GPU gates
compare the production texture against an independently uploaded source texture
using the same native filtering; they retain exact texel-center equality and
`<2e-6` sampled error. Separate fit gates compare both compute and fragments to
an independent analytic oracle and preserve `specular:0`.

Mixed materials carry their selection through G-buffer receiver data and the
ray/card material ABI. The receiver-only packed normal uses 12+11 octahedral bits,
bit 23 carries the DFG choice, and the full eight terrain shadow-layer bits are
retained. The shading normal remains 12+12 bits and receiver storage remains
RG32uint. Its GPU regression bounds receiver-normal angular error to 0.003 radians
and checks mode and terrain-layer independence.

The real WebGL regression inspects the GLSL actually submitted to the driver,
checks both providers numerically, and rejects reintroduced shader arrays or
texture bindings on the default path. Simulator performance and delivery evidence
are in the platform verification report.

## MaterialAsset and shader route

The recovery route is to inspect the structured code, detail, and hint, then
repair the source or cook input before retrying the catalog load.

Declare `passes[].program.module`, `parameters`, `values`, and optional `parent` on the same
MaterialAsset. A texture value keeps its own `coordinates.set` and
`coordinates.transform`, so every slot remains explicit from glTF import to
fragment sampling. The root contract is inherited by child materials; a child
only supplies values it owns.

Unlit selects native UV0–UV7 and applies the existing per-slot TRS through the
shared coordinate kernel. Color, alpha coverage in shadow draws and temporal
coverage use the same vertex coordinate. Matcap retains its view-derived lookup.
This does not change the native transform convention or add an affine matrix.

```ts
assets.configurePackIndex('/pack-index.json');
const result = await assets.load(materialGuid, 'material');
if (!result.ok) {
  report(result.error.code, result.error.detail, result.error.hint);
  return;
}
const materialHandle = result.value;
// Bind directly to MeshRenderer.materials; release the caller reference after binding.
const content = assets.read(materialHandle).unwrap(); // detached inspection only
```

The custom-shader demo is the executable reference: [`apps/hello/custom-shader`](../../apps/hello/custom-shader). It loads the root and derived GUIDs, validates their cooked records, checks the manifest artifact, and only then draws.

## GPU-driven PBR / shadow / skin navigation

This package is the producer entry: author `paramSchema` and WGSL, then inspect
the cooked receipt before the render owner admits a draw. The consumer route is
[`packages/render/README.md`](../render/README.md#gpu-driven-pbr--shadow--skin-navigation); host
assembly and recovery are documented in
[`packages/runtime/README.md`](../runtime/README.md#gpu-driven-pbr--shadow--skin-navigation).
An Alpha Mask cutoff, texture/sampler slot, or skin palette mismatch is a
structured producer failure, not a CPU duplicate-draw request.

Offline recovery is always `inspect -> repair this producer -> retry`:

```text
shader source/schema -> cook + reflection receipt -> runtime catalog -> render prepare
```

## Shader module catalog

`ShaderRegistry` owns the content-addressed build manifest. It is a runtime
lookup boundary, not an authoring store.

| Entry | Shape | Description |
|:--|:--|:--|
| `ShaderRegistry.loadManifest()` | `() => Promise<Result<void, ShaderError>>` | Load and validate the manifest |
| `ShaderRegistry.forkForDevice(device)` | `(ShaderRegistryDevice) => ShaderRegistry` | Fork validated CPU manifest inputs into an independent registry with an empty GPU cache; device-specific material variants are prepared on the candidate |
| `ShaderRegistry.get(hash)` | `(string) => Result<ShaderModule, RhiError \| ShaderError>` | Resolve an engine module by content hash |
| `ShaderRegistry.entries()` | `() => IterableIterator<ManifestEntry>` | Enumerate published content-addressed modules in manifest order |
| `ShaderRegistry.materialShaderManifestEntries()` | `() => IterableIterator<MaterialShaderManifestEntry>` | Enumerate validated material shader manifest rows |
| `ShaderRegistry.materialShaderManifestEntry(id)` | `(string) => MaterialShaderManifestEntry \| undefined` | Resolve one validated material row by identifier from the same ordered publication |
| `ShaderRegistry.findMaterialArtifact(id)` | `(string) => Result<MaterialArtifact, ShaderError>` | Find the published module selected by a cooked material |
| `ShaderRegistry.materialShaderIdentifiers()` | `() => IterableIterator<string>` | Enumerate published material module identifiers |

`loadManifest()` validates the complete document before publication. A malformed
entry or material shader row returns one `manifest-malformed` error and leaves
`entries()`, material manifest lookup and iteration, and lazy `get()` resolution
unchanged. Repair the same source and retry on the same registry; a successful
load publishes rows in source order and a later call is idempotent.

Material manifest rows have one identifier-keyed store. Runtime artifact requests
resolve a row directly and reuse their existing entry/manifest identity cache;
lookup does not rescan the roster or retain a second manifest index.

Device recovery uses `forkForDevice` to retain the admitted, validated CPU
manifest without another network request or JSON parse. The candidate has
independent registration maps and an empty module cache; candidate preparation
selects the material shader variant for the replacement device. After prepare,
the recovery transaction carries over user-installed artifacts and registrations
that were admitted while the candidate was being built. A shader-preparation
failure or timeout never reaches that carryover; later candidate failures discard
the candidate without publication, and it cannot return a lost-device handle.
An unloaded or failed source registry stays unloaded in its fork, so the original
validation and source-failure behavior still applies.

The WGSL-level module and the RHI GPU handle are different concepts. This
package owns the former; `@forgeax/engine-rhi` owns the latter.

## Contract derivation

The compiler derives binding layout, uniform offsets, texture field names, and
the injection boundary from the material parameter contract. WGSL reflection
must agree with that derived shape before a record is published. Per-slot
texture coordinates are data in `MaterialTextureValue`, not a global shader
switch.

`isEngineMaterial()` recognizes materials that can reuse the shipped program
without cooking. Nonempty `staticSwitches` require their own cooked publication,
including explicit `false` selections; an Engine module name alone does not
establish specialization readiness.

Standard texture availability comes from authored parameter declarations. A
declared texture remains enabled while its GPU resource is recovering. The
canonical UBO schema is shared by Direct and GPU Scene draws.

- Built-in Standard non-transmissive Forward draws specialize the admitted
  source template on first use of the resource shape. The selected vertex and
  fragment binding reads determine the material layout. Changing scalar shading
  factors or replacing a texture with the same sampling relationship reuses
  the pipeline. Precompiled publications without source templates use their
  existing published layout and pipeline overrides.
- An authored Surface declares its own textures and sampling code in the
  material contract. Cooked programs omit unavailable declarations. The
  Surface decodes any channel packing into `SurfaceData` for Standard lighting.

`standardTextureMask()` derives `STANDARD_TEXTURE_MASK_OVERRIDE` from the
canonical texture-field order. The renderer includes the mask in pipeline
identity alongside the packed ORM selector.
The override's low 20 bits retain presence; the higher bits select an earlier
sample for each independent metallic, roughness, or alpha input when texture,
sampler, and coordinates match. The selector is zero when that input needs its
own sample. In projected Forward programs, shared ORM also supplies occlusion
through the metallic–roughness sample, so the separate AO binding is omitted.
Bits 29 and 30 (`STANDARD_TRIPLANAR_PROJECTION_BIT`,
`STANDARD_OBJECT_SPACE_NORMAL_BIT`) are projection selectors that
`standardProjectionMask()` derives from the effective `triplanarSpace` and
`normalMapSpace` values. The WGSL reads them through
`standardUsesTriplanarProjection()` / `standardUsesObjectSpaceNormal()`, so
every texture sample stays in uniform control flow; a per-row value never
gates a sample. The ray entry is unspecialized, which is why ray admission
refuses those values.

## Error recovery

Material and shader errors are closed. Switch on `error.code`, then use the
code-specific `detail` and `hint`:

| Code | Meaning | Recovery |
|:--|:--|:--|
| `material-contract-program-mismatch` | A pass does not satisfy the root contract | Align the pass module and re-cook |
| `material-reflection-binding-mismatch` | Reflection differs from the derived bindings | Fix WGSL or parameters, then re-cook |
| `shader-module-not-found` | The published module is absent | Add it to the build source catalog and rebuild |
| `material-specialization-not-cooked` | No runtime artifact exists for the selection | Run the cook path and publish its record |
| `material-specialization-stale-generation` | A dependency changed after cooking | Wait for dependencies to settle and re-cook |
| `material-surface-slot-missing` | Standard pass has no `surface` module slot | Add the slot to the authored pass and re-cook |
| `material-surface-abi-mismatch` | Surface export does not match the ABI required by the selected material model | Repair the producer-reported expected signature and re-cook; Standard uses `surface_v1`, while single-layer medium uses `single_layer_medium_surface_v1` |
| `material-surface-forbidden-interface` | Surface declares a stage, resource, or vertex mutation | Remove the forbidden interface and re-cook |
| `material-parallax-contract-invalid` | `displacementMode` parallax lacks `normalTexture` or sets an independent `metallicTexture` (`detail.field`) | Provide `normalTexture`, or use packed `metallicRoughnessTexture`; see the `displacementMode` constraint list |
| `material-physical-contract-invalid` | A root physical layer is incomplete or unsupported | Repair the root parameter fragment before composing or cooking |

Single-layer medium frame resources use the same declared shader ABI at 1x and
4x. Render resolves 4x opaque and nearest-water inputs by selecting the nearest
depth sample and the color from that exact sample. The composed medium shader
therefore reads two single-sample `r32float` depth facts; it does not read a
multisampled depth attachment or an averaged color resolve. Unsupported sample
counts fail at RenderGraph admission before this shader is recorded.

At an undisplaced refraction coordinate, the medium shader uses `textureLoad`
for the paired color texel. A neighborhood filter there would average across a
thin foreground or shoreline and undo the color/depth association. A displaced
rough-refraction footprint may average only after the complete color/depth
neighborhood passes the shared validity test. The executable 1x/4x linear-HDR
edge oracle and its strict direct/GPU receipt path are documented in the
[Render single-layer medium contract](../render/README.md#linear-hdr-optical-oracle).

Never hide one of these errors by creating an app-local artifact or changing a
demo's material shape.

For the canonical error detail and executable recovery fields, use
[`material/errors.ts`](../types/src/material/errors.ts). The producer recovery
path is `inspect -> repair authored source -> cold-cook -> verify publication`;
runtime does not reinterpret a Surface error.

## Temporal-v1 accessor

`forgeax_scene_temporal` is the single WGSL accessor ABI for the
`forgeax::scene-data::temporal-v1` sampled data. Standard PBR producers pack
the shared `SceneTemporalV1` record, and TAA resolve samples it through the
same accessors. Consumers must not add a private velocity or G-buffer unpack,
or import compiler, Naga, or backend policy into runtime shader code.

The public render route supplies the semantic target; this package supplies the
stable shader module `forgeax_scene_temporal`. Layout,
clear values, invalid-depth handling, and reactive fallback remain owned by the
shared accessor source.

## Portable Motion Blur

`motion-blur.wgsl` is the sole built-in raster Motion Blur producer. It samples
the shared `forgeax_scene_temporal` accessor, derives a target-rate-scaled and
clamped motion vector, probes a fixed eight-neighbour candidate set, and then
performs a depth-aware symmetric gather of at most 16 color taps while
preserving alpha. Invalid interval, reactive, reset, subpixel, and
depth-rejected samples return the current color; the shader never reads or
writes a private velocity buffer, G-buffer, storage texture, or TAA history.
Runtime code selects the pass through the typed render plan; shader lookup
remains a published content-addressed artifact and never imports compiler,
Naga, or backend policy.

## Points and Lines shader contract

Points and Lines use the engine-owned `forgeax::points-lines` material shader
manifest row. The row is a content-addressed runtime artifact selected by the
same `MaterialAsset` and `Materials.unlit` route as other built-in materials.
The Standard renderer binds the Points/Lines view at group 0, binding 10, then
uses the prepared expansion geometry in the active main geometry pass.

The runtime contract is compiler-free: it loads a published artifact and never
imports Naga, a shader compiler, or WGSL authoring helpers. `paramSchema`
remains the single source for derived layout and uniform shape. Manifest
validation is atomic; a malformed or stale row leaves the prior published
catalog unchanged and returns a structured error.

| Evidence | Meaning |
|:--|:--|
| shader manifest row | `forgeax::points-lines` is published and content-addressed |
| runtime isolation triple | no Naga in dist, no runtime shader compiler dependency, and no compiler import |
| graph contract | points-lines uses the existing Standard main pass and material binding path |
| lane contract | direct WebGPU is the focused runtime route; clustered unlit and WebGL2 restrictions are structural contracts unless a lane-specific runtime probe is available |

When lookup or reflection fails, inspect `.code`, `.expected`, `.hint`, and the
code-specific `.detail`; repair the source or cook input and republish through
the build-time producer. Do not create an app-local WGSL module, bypass the
manifest, or add a backend-specific shader branch. The same retained/prepared
state supplies render inspection and recovery evidence.

## Built-in PBR contract

The built-in PBR shader has named coordinate records for base color, metallic
roughness, normal, specular weight/color, emissive, occlusion, transmission,
and the declared physical texture slots. Each record carries offset, scale,
rotation, coordinate set, and physical extent metadata. The render package
projects the records into the UBO; the shader selects the declared vertex
coordinate input per slot. `specular`/`specularColor` replace the removed
The former specular-tint vocabulary was removed in one cut; no compatibility alias is supported.

Physical layer declarations are lowered from the Standard root contract. The
compiler appends only authored physical resources after the engine-owned IBL
and transmission region, so a base-only root has no physical binding or sample
and retains its Deferred pass. The five glTF extensions use the same schema and
the same Forward physical evaluator; runtime never compiles or patches this
layout.

Clearcoat's direct and environment radiance already includes the coat BRDF's
Fresnel term. Layer composition multiplies that radiance by clearcoat coverage
once; the view Fresnel term separately attenuates the underlying material.
Multiplying the reflected radiance by Fresnel again suppresses ordinary coat
highlights and is not an energy-conserving layer composition.

The diffuse-transmission layer (`DIFFUSE_TRANSMISSION_AVAILABLE`) adds a back-hemisphere
Lambert lobe to every Standard light evaluator and samples irradiance along `-N`. The factor
splits energy rather than adding it: the front diffuse albedo is scaled by `1 - factor` before the
transmitted albedo `factor · (1 - metallic) · tint` is formed (render README §Diffuse transmission). The
irradiance cube has one mip, so `sampleIblDiffuse` uses an explicit level 0, which keeps
the lookup legal inside the non-uniform `frontFacing`-dependent transmission branch.

The IBL region has six bindings: irradiance texture/sampler, prefilter
texture/sampler, BRDF lookup texture, and skylight uniform. BRDF lookup uses
the irradiance linear-clamp sampler; the separate prefilter sampler permits
per-draw reflection-probe selection. Re-cook authored Standard roots after
a binding-contract change so runtime and shader layouts agree.

## References

- [`@forgeax/engine-types` MaterialAsset](../types/README.md#materialasset-route)
- [`@forgeax/engine-pack` cook contract](../pack/README.md#materialasset-cook-contract)
- `MaterialAsset migration`

## Surface authoring checklist

- [x] Import `forgeax_material::surface_v1` and return the nine-field `SurfaceData`.
- [x] Read generated material parameters through `forgeax_material::parameters`.
- [x] Keep vertex, light, BRDF, pass, binding, and output ownership in Engine modules.
- [x] Let the root parameter contract determine physical layers and pass admission.
- [ ] Add an engine entry point or resource binding to a Surface module.

The final unchecked item is intentionally forbidden. If an effect needs its own
entry points or render targets, declare an explicit full-custom material and
publish its pass/lane provenance instead of disguising it as a Standard Surface.

### Metadata-only source catalogs

`new ShaderRegistry({ manifestUrl })` loads manifest and material metadata without acquiring a
GPU device. GPU module lookup returns `rhi-not-available` until a device-backed
registry is used. Render Worker source asset loading uses this catalog; the
receiver installs immutable artifacts into its existing device-backed registry.

## Standard deferred lighting contract

`decodeStandardGBufferReflectance` reconstructs mixed F0 with
`mix(dielectricF0, baseColor, metallic)` from decoded independent fields.
Deferred lighting and diffuse GI share this decoder. Material AO remains
`response.a`; independent dielectric F90 remains `dielectricSpecular.a`.
No inverse near metallic=1 or F90 inference is required. The current complete
GBuffer writer still retains its redundant mixed RGB until the versioned layout
migration; this reader change alone does not reduce attachment allocation.

Standard and custom base Surface programs exchange `SurfaceData` with the
Engine's rigid or skinned material entry. `standard-gbuffer.wgsl` encodes that
result once; `standard-deferred-lighting.wgsl` resolves its lighting without
calling Surface or replaying receiver geometry. Alpha clipping happens before
any G-buffer output. Physical/medium Surface admission continues to select its
explicit Forward lane when the base deferred schema cannot represent its lobes.

The shared base BRDF/IBL callsites live in `standard-lighting.wgsl`. Its helpers
accept textures and material facts, so Forward and Deferred share light semantics
without sharing a material bind-group layout. The cooked utility manifest entry
is `forgeax::engine-standard-deferred-lighting`; it is an Engine utility, not a
runtime material publication. Clustered and unclustered sources are prewarmed
with the same device capability axes as Standard.
On the no-storage Standard Forward variant, the same local-light BRDF reads the
complete Cluster records and membership from capability-selected integer textures.

See [the Render G-buffer contract](../render/README.md#ssr-admission-and-bounded-inspection)
for attachment formats, packing, resource limits and SSR outputs.

## Shared clipping coverage

`forgeax_clipping::planes` owns `clippedByPlanes`, `applyLocalClipping`, and
`applyViewClipping`. World-space negative signed distance is discarded. View
coefficients occupy the shared View ABI from byte 1024; fog, atmosphere and
sky-fog lanes complete the 1296-byte View bound range. Local lights use the complete Cluster transport selected from device capabilities.
Color, shadow and temporal geometry must use
the same transformed world position. Material presence is derived from the root
parameter declaration during cook; runtime does not add feature defines.

## Hashed alpha coverage

`alpha-hash.wgsl` owns the derivative-scaled object-space threshold shared by
Standard Surface, Unlit and temporal coverage. `alphaHash` is a default-zero
`f32` material value (`Materials` projects its boolean option to 0/1). Its
Standard schema slot occupies the alignment gap before `specularColor`, so
existing subsequent uniform offsets remain unchanged. The shader producer
includes the helper in the source closure; runtime never cooks this source.
Sparse authored Standard contracts derive `ALPHA_HASH_AVAILABLE` from the
`alphaHash` declaration, so omitted fields produce disabled coverage without
adding hidden parameters.

Likewise, `ALPHA_CLIPPING_AVAILABLE` follows the selected `alphaCutoff`
declaration. Canonical Engine Standard schemas retain it. An explicit
`staticSwitches.alphaClipping: false` removes the field and supplies zero
cutoff to Standard Surface and temporal coverage. With alpha hash and
displacement also explicitly disabled, the known Standard shadow selects
opaque coverage with position and vertex-normal bias inputs; material maps,
view/local clipping and LOD retain their selected contracts.

See [Alpha Hash authoring and verification](../render/README.md#alpha-hash).

### Standard scalar map ABI

The default Surface evaluates independent metallic, roughness and alpha maps
with per-slot UV data and R/G/B/A selectors. Its contract is documented in
[Render](../render/README.md#independent-standard-scalar-maps). The canonical
schema generates scalar layout, coordinate records and texture-presence bits;
Forward, Deferred, skinned and ShadowCaster share the Surface implementation.

Physical-map bindings start at `STANDARD_PHYSICAL_BINDING_START`, after the
reserved scene-material and global-prefilter slots. Compiler lowering and
renderer BGL/BG assembly consume that same constant, keeping expanded base-map
and IBL bindings disjoint. Re-cook materials after this ABI change.

### Single-layer medium planar reflection

The medium template keeps the empty authored parameter prefix and renderer-owned
IBL/backdrop/depth injections. Bindings 15 and 16 carry the linear 2D planar
reflection and a 96-byte uniform (capture view-projection, normalized world plane,
enabled flag). No capture uses the existing environment term. Valid matching
plane samples replace only that reflection term, leaving Fresnel, foam and
transmission integration unchanged. Producer and sampler run through Render's
existing target/frame lifecycle; the shader owns no capture scheduling.

## Standard displacement contract

`standard-displacement.wgsl` owns the normalized-height vertex formula and
triangle normal reconstruction. Standard rigid/skin, temporal and shadow
entries call the same level-zero sampling kernel. The existing Standard
parameter schema owns `displacementTexture`, `displacementScale` and
`displacementBias`; texture coordinates remain per-slot. Material
specialization constants apply to both vertex and fragment stages.
Caster slope bias uses the transformed source vertex normal before material
position displacement, matching UE WPO ordering. Displaced triangle normals are
reconstructed in fragments for lighting. The depth oracle retains source normals;
the independent face-normal oracle remains the lighting reference.

See [Standard vertex displacement](../render/README.md#standard-vertex-displacement)
for authoring, density and bounds behavior. Pack cooking validates both rigid
and skinned color/shadow programs in
`shader-compiler/src/material/__tests__/standard-displacement.integration.test.ts`.

### Ray Surface reference context

The ordinary Engine manifest publishes query, path-tracing and raster-source
utility programs. The path tracer uses the manifest identifier
`forgeax::engine-ray-path-tracer` and retains `forgeax_ray::path_tracer` as its
WGSL source module name; the engine utility prefix keeps it out of material boot.
Query and transport share `ray-traversal.wgsl`, including their triangle/node
storage bindings. The build owns composition and reflection; runtime consumes
published WGSL and the material artifacts below. These programs alone do not
install a per-frame GI pass in Renderer.

The Standard `SurfaceInput` ABI includes `uvFootprint0/1`, eight conservative UV
diameters. Raster adapters supply zero and continue to use implicit derivatives;
the build-only ray context selects explicit mip levels from the hit's ray-cone
footprint. Custom Surface modules can consume the same input and shared sampling
helper. The reference admits opaque and MASK coverage; shared Standard opacity
`<= alphaClipThreshold` rejects a candidate only when the threshold is positive.
Surface status 3 means rejected coverage, while status 2 means invalid output.
`geometricNormalWS` describes
triangle orientation; `vertexNormalWS` is the interpolated normal used by Standard
and custom Surface shading. Authored normal maps use that vertex/tangent frame.
Raster adapters derive geometry from position derivatives; exact hits and cards
derive it from the indexed triangle, correcting mirrored winding.

`RaySurfaceProgram` carries build-produced WGSL, the derived parameter schema and
the resolved asset contract. `admitRayMaterial(asset, material, context)` shares
build/runtime admission, defaulting to `ray-hit`. `card-capture` additionally
requires the canonical Standard Surface; its restriction does not narrow ray
qualification. The ordinary material product publishes both eligible contexts;
runtime selects immutable artifacts without importing a compiler. The Standard direct-light BRDF and opaque ray BSDF share
one evaluator; sampling reports the full cosine/GGX-NDF mixture density and
explicit null events, including finite mapped/smoothed normals across the geometric
hemisphere. Surface admission validates values; BSDF value/PDF own directional
hemisphere clipping. Existing Standard energy conventions remain unchanged.

The shader delivery audit
records publication, variant and memory evidence for the public Engine package.

## Direct material parameter regions

A producer receipt records the actual aligned parameter region. A direct program
with no parameter fields has `materialRow: { byteLength: 0, fields: [] }`; this
records the absence of a uniform region and does not allocate a placeholder row.
A scene-index program requires a positive aligned GPU Scene row. The shared ABI
validator rejects a zero-byte row with fields or a scene-index entry. Every cooked
raster selection carries its reflected direct entry, geometry inputs and ABI,
including custom programs combined with the Engine default shadow wrapper.

## Surface lighting-channel transport

Standard rigid/skin and Deferred share `common.wgsl::lightingChannelsMatch`.
`evaluateStandardDirect` and `evaluateStandardClusterLights` accept the receiver
u32 mask explicitly. `View.lightingChannels` occupies the directional padding
word (byte 76). `DirectLightSlot.channels.x` is the surface mask in row 5 of the
96-byte local-light ABI; volume consumers preserve this stride and do not apply
surface policy. `Mesh.surface` is an integer tail: x/y carry visible-surface
row/count, z carries receiver channels. Scene-index variants read the same
`GpuScenePrimitive.lightingChannels` and transport it flat to fragments.
`GBufferOutput.receiver_geometry` is `vec2<u32>` (packed normal/family, mask).
Do not transport masks through UNORM encoding or numerical f32 conversion.
See the [Render channel contract](../render/README.md#surface-direct-light-channels)
for author validation, support and shadow/GI boundaries.

## Fragment color output

`tone-mapping.wgsl` owns the parameterized tone curves used by both the fullscreen
Output Transform and opted-in material output. `output-encoding.wgsl` remains the
single transfer/gamut implementation. The default Standard and Unlit programs
retain linear output until the normal fullscreen post chain.

A cooked Standard or Unlit root can declare `fragmentOutput: vec4` to select output
at the fragment write: `[toneMode, exposure, encode, gamut]`. Tone modes reuse
`TONEMAP_SHADER_MODE`; encode is 0 for working-space values and 1 for output
encoding; gamut is 0 for sRGB and 1 for Display P3. Mode 0 is identity and ignores
exposure. Data shaders use `[0, 1, 0, 0]`; a color material with tone mapping disabled
still uses encode 1 for a display destination. This optional contract is compiled
from the authored parameter schema and never expands the default material ABI.

The selected graph must match these writes: encoded attachments blend encoded
values and use raw presentation once. Fragment output is after native surface/fog
evaluation; a producer with a different fog, dithering or premultiplication order
must explicitly compose that order before claiming compatibility. The current Three
adapter still rejects those unimplemented combinations and ordinary render targets.

## Three r184 sampling contracts

`fxaa.wgsl` follows the pinned Three WebGPU FXAA luminance, thresholds, six-step
edge search and subpixel blend. Fractional luma search remains explicit bilinear
texel sampling for backend stability. Endpoint comparisons allow four f32 rounding
units scaled by local luminance, so mathematically equal endpoints terminate
consistently across axes and backends. Output encoding belongs to the graph.

Vogel PCF samples the original UV footprint with sampler edge clamping; receiver
slope correction uses the actual half-texel clamped location. Bloom retains its
normalized tent pyramid and threshold-subtracting extraction. See the
[Render contract](../render/README.md#three-r184-post-processing-comparison)
for parameter semantics and the live comparison.

## Constant environment irradiance

The Standard environment uniform ends with `ambientIrradiance: vec4` (RGB plus
padding), making its host size 80 bytes. Forward and Deferred share the same
Lambert conversion and diffuse material response, before occlusion and physical
layer composition. Probe-mode uniforms retain this independent global input.
The default is zero and Unlit/data shaders do not consume it.

## Shadow caster projection

Standard, Unlit and mesh-particle casters share
`forgeax_shadow::surface::projectShadowPosition(worldPosition, worldNormal)`.
Automatic orthographic CSM clamps Reverse-Z near depth before applying a
bounded, texel-sized caster bias. Host culling admits upstream blockers while
retaining side/far planes. Point/spot perspective views and explicit shadow
matrices keep ordinary clipping. The existing header carries the per-view policy
without changing its byte layout or invariant vertex-position contract.

`forgeax_view::common::directionalShadowCasterBias` owns the automatic budget.
The half-texel constant grows by two texels per unit of actual tangent slope,
then caps at 6.25 texels. It does not saturate at 45 degrees: that excessive
intermediate-angle displacement erased centimeter-scale blockers.
Directional receivers compensate authored-normal overlap and apply bounded,
one-sided plane correction at each filtered texel. PCF quality and authored
radius remain separate. Directional variance moments retain native Reverse-Z depth through
both RG16F passes and comparison; perspective spots and constant-bias cameras retain forward-depth moments.
The existing raw-depth capability selects point loads for per-texel comparisons;
other profiles use the comparison-sampler fallback with the same references.
See the Render README for units and acceptance.

Surface cascade blending uses one filter call site in a uniform loop bounded
to two layers. This preserves the current/next samples and blend weight while
avoiding duplicated native filter code that crashes Metal compilation in
composed single-layer medium shaders. The Surface Browser and isolated Dawn
runtime tests retain their original pixel oracles for this path.

## Portable multi-stage utility programs

Hi-Z and SSR share package-owned WGSL evaluation functions between finite compute
and `PORTABLE_FRAGMENT` variants. Native barriers/storage declarations never enter
the fragment module. Fragment variants have distinct publication IDs even when
they originate in the same source file. Their selected entry bindings and MRT
outputs remain reflected facts of that exact composed variant.
SSR traversal keeps one 64/1024-step counter across candidate yields. Tangent-plane
validation runs outside the inner march to bound native compiler control-flow
expansion; rejected candidates resume the same ray state. Traversal order, depth
crossing refinement, geometric fallback and coverage checks remain shared by
opaque and Water entry points.
Standard Forward generates the additional unit-radiance reflection response only
when `REFLECTION_FALLBACK_AVAILABLE` admits the SSR outputs, including clearcoat
response sampling. Ordinary material variants omit that response work.

Auto exposure keeps its public native source export and adds the fragment source.
Both embed `auto-exposure-common.wgsl` at build time; native and fragment entry
files own only transport and execution. Shared classification and adaptation retain
the V1 histogram semantics. Raw WGSL files are embedded by the package build;
runtime imports neither a file loader nor the build-time compiler.

TSR embeds package-owned analysis and reconstruction functions into both compute
and fragment programs. Compute keeps its cooperative tile caches and exact row
reductions; fragment gathers the same neighborhoods directly and returns three
MRT outputs. One reconstruction coordinate tuple feeds both cache population and
evaluation, including f32 phase boundaries. No workgroup memory, barriers, atomics
or storage-texture declarations enter the fragment modules. Runtime selects the
execution lane without interpreting macros or importing a compiler.

## Shared reflection publication

Manifest `6.0.0` separates shader source identity from compiler ABI facts and render
state. `reflectionBindings` stores each bound global once; reflection rows retain
ordered `bindingIndices` and reference the ordinary `entryPoints` table through
an optional `entryPointsIndex`. A missing field remains different from an empty
read set. This transport does not change `shader-reflection/3`, source digests,
material identities, variant selection or pipeline descriptors.

Admission snapshots borrowed facts before verification yields, rejects invalid or
unused references, and shares immutable bindings and entry reads. Owned JSON keeps
selected reflection validation lazy; a malformed selected ABI still fails before
use. The runtime can read existing `5.0.0` publications. Build-time shared/prepared
inputs must match the current producer version and rebuild obsolete publications.
