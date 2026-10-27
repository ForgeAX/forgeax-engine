# `@forgeax/engine-render`

GPU Scene keeps each live source slot's primitive address stable while its
instance, transform and material ranges resize independently. A prepared GPU
resource frame resolves its actual Mesh/material demands during preparation;
assembly seals that read domain after main/shadow preparation and before
submission. Sealed frames reject further lookups;
submission and abort retain the existing completion/release ownership. The
source fence still rejects an outdated native Scene, including capture-only
submission. Sealing does not turn mutable World input into a historical snapshot.

Persistent material adoption retains authored override groups and shared member
roots. It does not discover or refresh their consumers. The real Pass/caster
query resolves the required geometry variants through the composition-owned
factory and derives its exact material demand before temporal/culling reads and
GPU Scene synchronization. The query validates the whole source domain before
publishing work or prepared binding facts; recursive queries and source writes
are rejected. Quiet queries and parameter-only changes retain completed work.
Old accepted frames keep their captured material versions and GPU read leases.

`samplerContribution` and `renderPipelineContribution` provide synchronous owner
preparation for runtime `create`, `update` and `replace`, sharing source admission
rules. Engine installs them; standalone asset owners install the contributions
explicitly. Samplers require ordered nonnegative LOD bounds, integer anisotropy
in [1, 16], and linear mag/min/mip filters when anisotropy exceeds 1. Pipeline
configuration reuses the renderer's SSAO parameter validation. Invalid candidates
never replace accepted content or emit a change.
Persistent SSAO noise and static shadow arrays own their sampled and layer
views. Typed SSAO and fullscreen depth reads declare views in the render graph,
so physical resource replacement also replaces those views. Main SSAO lighting
bindings follow mesh, light-buffer and resolved-view identity; analytic fog
bindings follow its resolved depth and View buffer. Lighting selection never
evicts the membership producer's binding merely because a prewarm call omits
the lighting topology. Its writer still validates device, layout and buffer
identity before reuse. Failed creations publish no reusable handle.

## Preparing hidden loadout pipelines

Set `MeshRenderer.preparePipelines: true` on the finite mesh roster that this
session can select, including meshes with hidden `Visibility`. The renderer
requests their authored color and active ShadowCaster PSOs through the same
selection used for visible draws. Preparation neither changes visibility nor
encodes a draw. CPU asset loading and shader-program registration remain
separate prerequisites.

Ordinary hidden entities keep their persistent Scene and GPU Scene records but
do not enter raster batches or request their pipelines. Only explicit
`MeshRenderer.preparePipelines` or candidate preparation requests prepare hidden
PSOs; making an entity visible updates its ordinary batch membership.

| Receipt | Meaning |
| --- | --- |
| `FrameReceipt.presentation === 'pending'` | At least one requested pipeline is still being prepared |
| `FrameReceipt.presentation === 'ready'` | The current frame's required pipeline requests and existing presentation checks succeeded |

A preparation barrier leaves the canvas surface untouched and does not publish
a partially rendered scene or update shadow/temporal history. The receipt stays
`pending`; this is not evidence that gameplay rendering continues.

For a specific pending variant, inspect `pipelineLibrary.pending` through the
existing Renderer inspection (or `execution.inspectRenderer` across Workers).
It exposes every recorded live native request with semantic identity, shader
digests, entry points, attachment/vertex formats, specialization constants and
complete recipe state. `preload` distinguishes a missing exact recipe from an
in-progress library index or an entry already declared for startup/background
warmup. The frame's `presentationPendingReason` remains the first
producer blocker, not a complete compilation roster. Hidden preparation retains
its admitted materials until its final preparation membership retires.
An explicit `inspect({runtimeRequests:true})` includes supported bounded
runtime-request history, omitting the legacy full pending list to avoid uncached source
hashing. Default Renderer inspection never materializes that history.
Keep request outcomes/library-local timestamps separate from current pending state;
historical compilation does not establish the cause of a later stalled frame.

When the backend exposes `RhiDevice.createRenderPipelineAsync`, explicit
preparation waits for native pipeline compilation completion. WebGPU forwards
`GPUDevice.createRenderPipelineAsync`; a pending or failed result never becomes
a ready PSO, and the visible draw reuses the completed handle. Ordinary pipelines
without preparation intent retain their existing creation path. Backends without
this optional operation retain synchronous creation semantics; they do not provide
the stronger compilation-completion guarantee. Device retirement and source or
layout replacement reject stale completions.

Readiness follows the actual view, attachment formats, authored state and device
cache; it is not a fixed frame delay. Keep the intent while these inputs may
change, or clear it after a matching ready receipt when the application owns
that transition. This flag does not provide a Source Worker acknowledgment for
switching a new mid-session loadout; retaining the previous selection until
such acknowledgment is a separate game transition responsibility. It does not
prepare an asset library that has not been requested.

An imported pipeline library also prepares CPU material-program facts for the
shader sources referenced by its graphics recipes, after native preparation
succeeds. The existing ShaderRegistry owns those source analyses across passes
and device recovery. Compute-only sources remain outside material analysis;
uncaptured graphics sources still prepare on their first ordinary use.

Boot material pipelines read the admitted program's UV count, with the existing
manifest reflection as fallback. Geometry's existing vertex layout derivation aliases
missing UV sets onto the last supplied set; startup never assumes that every
built-in material consumes only UV0. The qualified layout also owns the prewarm
cache key across attachment formats and device recovery.

## Explicit material resources and depth versions

Cooked material ABI receipts select the declared binding interface. Render never
uses WGSL variable names to choose the interface; see the
[shared declarations](../types/README.md). Scene-depth layouts permit vertex and
fragment reads. `View.viewportWidth` and `View.viewportHeight` provide the current
render extent without requiring a depth texture just to call `textureDimensions`.
They occupy the existing padding at float offsets 23 and 27; the View size and
all existing member offsets stay unchanged.

A feature raster pass that samples and writes the same depth target must declare
`sceneDepth: 'before-pass'`. Graph projection copies the single-sample depth into
a separately leased texture, binds that snapshot for sampling, then keeps the
original attachment writable for this pass and subsequent consumers. Undeclared
or `read-only` writers fail with `resource-descriptor-invalid`; multisampled
feedback also fails until a separate snapshot producer exists. Read-only depth
sampling keeps the original attachment read-only. VFX cannot coalesce explicit
snapshot boundaries into a single draw pass.

Uniform-only direct mesh/material bindings use bounded physical pages in the existing
per-view grow owner. The logical mesh/material slot order and shader binding windows
stay unchanged; one resolver supplies each page handle and its dynamic byte offset to
color, sprite, skin and shadow recording. Mesh windows can overlap page boundaries, so
the upload owner writes every intersecting page tail. Clustered materials retain the
complete lighting bindings and the current SSAO view when selecting a mesh page.
Pages remain at most 16 KiB
(and within the device uniform binding limit), append without rotating live handles,
and follow the existing DeviceScope generation and allocation rollback lifetime.
Storage-capable devices retain shared arenas and whole-buffer GPU Scene bindings;
mesh rows and interned material slots have independent capacities and growth demands.
Each stream uses its own stride and binding window to enforce device limits; growing
one stream retains the other stream's physical handles. Growth publishes atomically,
and failed allocation keeps both prior capacities. Complete draw rows are bounded by
both capacities on degradation. Independent CPU shadow transforms still occupy mesh
rows even when their materials share the main table. This bounds driver-side uniform
layout conversion without changing shaders or RHI semantics.

Material numeric storage is keyed by shared asset root. Accepting a material frame
allocates and releases only roots in its persistent change set. An actual draw
prepares its selected immutable version and exact texture/sampler tuple once;
probe or view binding classes reuse the same numeric slot. One submission pins
the immutable versions and texture/sampler tuples its draws actually use; simultaneous old/new versions
fork that root slot until queue acceptance, while ordinary consecutive frames
retain ordered writes to the same slot. Unused materials and
unrelated texture edits trigger no packing. Physical buffer/page write evidence
keeps fixed older frames correct and retries failed writes without publishing success.

Mesh defaults and complete authored override tuples form shared Pass expressions.
Material adoption replaces only its fixed source and Pass roots; it does not visit
Mesh expressions or their instance members. A changed Mesh compiles only that
Mesh's distinct authored bindings into actual Pass work and demand counts. The
cost follows those bindings and produced Passes, not the number of instances or
unrelated meshes. Actual draw traversal merges member order; a completed traversal
retains that order on its fixed work root for subsequent draws and scalar edits.
This costs one binding reference per consumed Pass member until that work and
its retained frames retire; partial queries never precompute the remaining work.
Binding preparation selects programs once per shared Mesh, authored tuple and
geometry context, including vertex-color availability from the fixed layout.
Rigid and skinned instances can share a Mesh without sharing an incompatible
program. Worker asset rows carry the accepted material context table when it
changes; scalar rows reuse it and previously published program artifacts. The
receiver binds that fixed table to its admitted payload, never the latest GUID
entry, so old frames and later Mesh layout changes preserve the same source.

Mesh rows contain only instance facts: current/previous transforms, temporal and
surface metadata, and an optional Sprite region. A real draw stages its selected
source row; the submission boundary coalesces those dirty addresses. Material
value or flip changes never repack mesh rows. Sprite flip belongs to the shared
material, while `SpriteRegionOverride` stays in the draw row (176-byte storage
layout, 96-byte uniform layout, both using aligned 256-byte direct addresses).

Renderer startup prewarms seven common unlit/output pipeline specs. Standard PBR
uses the material pipeline cache keyed by admitted geometry, lighting, render
state and attachments. Recovery acquires and validates the replacement device,
surface and environment roots before publication (20-second deadline); the
first ordinary frame after publication prepares pipelines through this cache.
The separate generic Standard bootstrap matrix and unused
`PipelineState.standardPipeline` handle are removed.

Deferred lighting keeps immutable pipeline/layout variants in their live device
scope across graph replacement. Device, view layout, complete cooked shader,
cluster/LUT contract, fragment entry and ordered target formats determine reuse.
Graph texture views and bind groups remain local to each graph. Scope retirement
clears the program references; failed creation stays retryable.

## Presentation transform authority

All render extraction reads Scene's `readPresentationWorldMatrix`: meshes,
skin joints, cameras, light/probe captures and terrain share one sampled
hierarchy. Each sampled joint world is one shared row in the renderer-owned input
arena; a joint edit updates that row only, with no joint-to-Skin fanout. Native
publications copy those same matrices and publish half-fixed-frame changes even
when the exact simulation root did not change. Static Skin membership (Skeleton
identity plus full ordered joint handles) is published separately and alone
determines rebinding. Deformation multiplies joint world by inverse bind only at
actual draw demand: GPU candidates claim, deduplicate and resolve transient
current/previous task output before culling, and Direct/uniform draws write
transient task buffers. No binding retains a pose palette across frames.
Physics keeps GlobalTransform.world; Render owns no interpolation history.

## Managed simulation scene SDF

Retained scene freshness uses the existing consumed asset closure and change journal. It does not inspect each entity, Mesh or Material to find asset edits. Fixed material and Mesh frames supply current bindings when an actual field projection is required; native Cards use that same source fence and device generation.

World attachment remains lease-owned: disposing the last `renderer.attach(world)`
lease detaches that World and retires its scene inputs after their last submission
completes. Another live lease keeps the attachment valid; disposed leases cannot
be drawn, and attaching the World again creates a fresh read lease.

`RenderFeatureSceneResource` can request `kind: 'scene-sdf'` for an explicit
composition World index and a
[`RenderFeatureSceneSdfDescriptor`](src/features/scene-sdf.ts). The producer
reads the full current retained CPU composition even when GPU Scene tables or
GI are absent. The actual recording RenderSystem passes its current retained
projection and resource scopes into preparation, including per-view recording
and recovery candidates; the shared field owner retains no inactive primary
scene callback. Display views do not choose its range or collider roster.
Every author-visible static Mesh in that World must carry a checked geometric
field; unsupported deformation or material coverage rejects the request.
The closed diagnostic owner is [`SceneSdfUnavailableError`](src/errors/scene-sdf.ts).

```mermaid
flowchart LR
    Mesh["Ordinary checked Mesh field"] --> Scene["Retained composition"]
    Scene --> Compose["Demand-scoped shared graph producer"]
    Compose -->|"same physical storage buffer"| Update["Fixed-tick VFX update"]
    Update --> Receipt["Renderer receipt and fence"]
```

The buffer has a 256-byte grid header and canonical 16-byte Global SDF voxels.
Composition writes the voxel range at offset 256; consumers bind the complete
buffer. Matching range/source requests share it without a texture copy. Initial
production is graph work even on a render-only frame; unchanged accepted fields
skip composition. Candidate replacement adopts only on accepted submission.
A source changing inside a transaction fails closed, rejected candidates retire,
and accepted resources survive their last consuming fence. World detach and
device recovery use the same lifetime owner. The particle helper and response
contract belong to [VFX](../vfx-render/README.md#managed-scene-sdf-collision).

> [!NOTE]
> This package-owner README contains physical `@forgeax/engine-render` imports
> in internal ownership examples. Game-facing code should use the public
> facade `@forgeax/engine/render`; the Bloom consumer route is documented in
> [hello-bloom](../../apps/hello/bloom/README.md).

> [!IMPORTANT]
> The Standard pipeline keeps dark-gradient color in `rgba16float` until one
> `outputTransform` reaches the `surface.storage.raw` endpoint; `inspect()` and
> `observe()` expose stable graph/backend identity facts, while pixel metrics
> belong exclusively to the Engine-owned hello-fxaa fixture report.

Skinned main-pass draws select their group(2) layout from each submesh's resolved
material pipeline contract. Direct skin and clustered skin may coexist on one
mesh; the binding cache includes the selected layout, and the uniform Skin task
address dynamic offset selects the draw's transient output. Pipeline preparation remains the admission authority;
recording does not probe a separate canonical skin program or infer bindings from
shader names.

## Adjacent LOD coverage

Resident rigid Standard PBR meshes (opaque or alpha-masked) use
complementary screen-door coverage in the GPU LOD lane. Author the usual
`MeshAsset.lods` and `lodHysteresis`; no second component or material alpha
animation is required. The existing fractional boundary band defaults to 0.08;
zero retains a hard switch. Outside the band, exactly one level is drawn.

For boundary $b$ and half-width $w$, the lower-detail coverage is
$t = 0.5 + (b - h) / (2w)$, where $h$ is projected screen height. Each band is
bounded by neighboring threshold midpoints so only adjacent levels overlap.
The same screen-space noise partitions the pair into complementary samples:
the outgoing level keeps $n \ge t$ and the incoming level keeps $n < t$.
Reversing or stopping the camera reverses or holds coverage without a timer,
random reseed, or per-object transition history. Camera teleports select the
new band directly; they do not enqueue intermediate levels.

| Path | Behavior |
|:--|:--|
| Standard Forward / Deferred / generated ShadowCaster | The selected pair uses the same signed coverage value; depth writes and authored alpha clipping remain enabled. |
| Standard temporal data for rigid LOD meshes | Reuses the selected geometry and coverage; transition samples reject stale color history. |
| Cached camera-only frame | Grouping, candidates and the filtered plan are retained across every band and threshold; the GPU cull recomputes height, level and coverage from the view camera. |
| Missing lower mesh or invalid projection | Resident fallback remains visible; a missing level never fades to an empty draw. |
| Skinned, transparent, or arbitrary custom shader | Existing single-level behavior; no uncontracted opacity or extra draw is injected. |
| CPU lane (no compute, storage or indirect, e.g. WebGL2) | Rigid, non-instanced indexed meshes hard-select the same level per camera from the same projected height, without crossfade; other shapes keep LOD0. Main and shadow recording consume the selected resident `first/count/baseVertex` range against the bound buffers. Source submeshes retain local geometry and material/claim identity. Meshes without resident ranges keep their source index range and zero base vertex. |

The GPU cull owns selection. Each candidate derives its projected height from
the GpuScene root transform and local bounds plus the view's
`LodViewConstants` (camera position, projection, height scale), then hard
selects a level or, for crossfade-capable batches, a coverage pair. LOD
distance uses the transformed local AABB center, so relocating the mesh-local
origin with a compensating entity transform preserves coverage and selection.
LOD members with an identical chain share one batch; the batch owns one indirect
command and one visible segment per level, so a level change moves an item
between segments without touching the plan. There is no CPU height payload.

Lower mesh levels become physically resident independently as their ordinary
Catalog payloads arrive. Missing levels retain their authored index without
substitute geometry; the selector falls back to the nearest finer resident
level. Later arrivals preserve resident levels and settle before validation
captures frame bindings and the residency epoch. Earlier submissions retain
their allocations through the existing submission lifetime.

Unchanged mesh submission and completion register or remove one pending fence
without visiting resident meshes. Fence storage is O(F), where F is the number
of unfinished submissions; a lease release or first retirement attaches those
fences in O(F). Later submissions do not extend a released caller's wait, while
delayed physical retirement captures work submitted before eviction. Already
retired meshes accept later uses only through explicit leases. App execution
constrains F through its existing render pipeline capacity; direct Renderer
calls have no cache-enforced hard limit.

Immutable meshes share vertex and index buffers by exact uploaded bytes and
physical usage until their last physical owners release them. At 64 KiB and above,
ordinary buffers compare exact bytes in 1 MiB SIMD chunks using a fixed 2 MiB
scratch allocation. Smaller buffers, shared memory and hosts without SIMD retain
the scalar scan. NaN payloads, view offsets and tails remain byte-exact; no result
or source reference survives a comparison. Index sharing
also matches format and retains zero padding and rebased LOD ranges.
Retiring one mesh preserves sharing through surviving meshes,
leases and submissions. Exclusive in-place writes remove the old immutable byte
identity before mutation; failed uploads acquire no shared allocation ownership.
The final physical release also drops the CPU comparison copy, even while an old
draw result retains the destroyed buffer wrapper. Exclusive writes drop that
obsolete copy when they leave immutable sharing.

Mesh residency changes retain unrelated prepared batches and static shadow
layers. Each resident mesh carries its last content epoch from the residency
owner's sequence, including in-place writes. Changed prepared primitives join
the existing GPU Scene content log, so shadow views consume their conservative
bounds independently through ordinary dynamic classification and partial updates.
Replacing a submission plan is a content change after physical source checks pass.
When a changed caster moves to the dynamic layer, its old and new bounds still
clear its retained static footprint; unavailable bounds require a full redraw.
Static layers observe scene changes only for members of their retained GPU plan;
removing a dynamic or unrelated caster cannot invalidate depth it never wrote.
New static members and removed or replaced static members still use the existing
plan comparison and old/new bounds, including slot reuse. Final layers retain
scene-wide change checks for their dynamic and CPU residual casters.
Shadow draw projections retain their topology and physical binding resources when
camera or caster motion invalidates depth, including source edits outside the view.
Each view checks its retained plan, meshes, physical bindings and shared execution;
an unrelated source-plan replacement does not discard every view's bindings.
Within one pending submission, views with the same source and candidate membership
share the candidate plan. Frusta, uploads and GPU buffers remain view-owned;
aborted or replaced views receive fresh projected candidate plans for re-upload.
After these shared binding checks, a changed plan retains individual projections
whose batch, first draw, material program and physical window remain unchanged.
Fresh equivalent artifact wrappers retain bindings; shifted visible windows do not.
Each existing projected shadow batch owns its prepared native command cache.
The cache observes current physical pipeline, view/material/mesh bindings,
vertex/index buffers, indirect ranges and LOD windows; changed buffer contents
alone do not change those commands. Batch retirement releases its cache references.
The view owns aggregate command hit/build/recorded-command counters. Depth reuse
is a separate decision: a final dynamic layer can redraw while its commands hit.
Shadow plan comparisons skip identical batch references and use the canonical
submission membership index for affected primitives and reordered membership,
without a second primitive-to-draw registry. Inspection reports successful view
hit/rebuild decisions, first rebuild reasons and actual retained-content comparison
work; those counters do not describe every preparation scan. Measured maintenance
and negative outcomes are preserved in the [controlled game report](reports/shadow-preparation-20261014.md).
Shadow selection uses the native view's ordered candidate ranges and its existing
slot/generation index. Material adoption changes shared execution rows; it does
not rebuild entity claims, shader maps or a consumer index. The actual submesh
queries its view selection only when recording a direct draw. A static selection
is usable after its retained depth was submitted, or after its raster completed
in the current recording; GPU culling to zero still owns that selected draw.
Shadow material validity derives from the selected compiler entry read sets and
the existing schema-driven uniform writer. A parameter edit compares changed
shared material roots and their read bytes; it never walks caster members.
Selected texture/sampler versions are captured during shared shadow preparation,
so a texture-only edit invalidates the affected depth while unrelated Catalog
activity does not. Unknown shader facts invalidate conservatively. Shared mesh
execution replacement retains candidate-array identity, including submesh growth;
physical material-address changes alone do not invalidate equal depth content.
A changed shadow-read asset redraws the full static layer, since geometry history
cannot bound a material-only change. A proved empty geometric region set keeps
its submitted depth and completes the current selection without caster work.
Main material binding caches retain their own asset versions and physical views,
with no global texture/catalog epoch. Internal `preparedMaterialTexture` resources
join this same binding/cache path; their producing renderer owner retains the GPU
lifetime, and they do not become author assets or public render targets.
`preparedMaterialParameters` supplies immutable numeric parameters at the same
recording boundary. Its identity joins the uniform version key, so replaying a
fixed Terrain plan may acquire current GPU addresses without changing its author
snapshot or overwriting earlier draws in the same submission. Capture and display
runtimes sharing one physical material buffer share its address allocator; replacing
the storage controller starts a fresh allocator for the recovered device.

The compiled GPU raster graph keys its captured vertex/index buffers and geometry
layout directly. Replacing an asset handle with another resident mesh sharing
both physical buffers keeps the graph, as do unrelated residency and in-place
content writes. Each asset residency and submitted-frame fence still owns its
allocation lifetime. Physical buffer, index format, layout, capacity, scene or
selected-program changes rebuild the graph.
The raster owner compares complete graph facts before retaining a short opaque
identity, so outer graph keys do not reserialize all raster classes each frame.
Replacement owners always receive distinct identities.
Within that projection, equal shader, vertex-layout and render-state inputs share
one lazy set of raster pipeline resolvers. Distinct physical mesh resources
still own separate declared graph buffers and index formats; triangle-list index
width does not split pipelines, while strip topology and Surface entry routing do.
Only successful format selections are retained, and failed admission retries on
the next use. This sharing ends with the compiled projection.
Within one main raster encode, rigid clustered batches resolve their shared
whole-scene transform and lighting binding only on first use. Each new encode
starts fresh; Skin task output still resolves separately, and pipeline transitions
still rebind group(2). This adds no cross-frame binding cache.
Raster class keys use the shared geometry, selected program and physical buffers.
Object-specific reflection-probe selections partition geometry independently of
material content. Probe texture generations retain those partitions; a changed
probe address or object selection publishes new binding classes.
Prepared batches compare their own selected producer artifact, so an unrelated
material entering or leaving the frame does not rebuild their admission facts.
Main and shadow programs are selected once per shared geometry/material binding
from the accepted material frame. Main raster binding addresses a shared material
and its physical resource class directly; shadow binding addresses the shared
material's resource scope. Neither path searches candidate entities for a material
representative. Surface admission and adapter construction use the selected artifacts. Unused publication entries and changes to the first
resident fallback do not invalidate the graph. Selected shader entries, receipts
and shadow programs still refresh pipelines and shadow bindings, including across
unsubmitted replacements and aborts.
The main material table also accepts GPU-only frames with no direct draw rows.
Its demand comes from the prepared batch partitions and its values from the fixed
material frame. Resource classes such as `probe:<index>` address the sorted,
possibly sparse probe table directly; an unfinished probe keeps the skylight
fallback. Material capacity cannot silently truncate that shared demand.
Native direct shadow work selects shared executions before visiting their members;
GPU and absent executions do not enumerate members. Selected submeshes retain their
authored draw indices and physical ranges, including non-indexed first vertices.
Nine-slice sprites share material-derived geometry and require a single source
submesh; a multi-submesh source fails with `rhi-descriptor-invalid` rather than
discarding its other draws.
Direct transform addresses belong to the retained Scene's source slot and
generation, not a pass's list position. The existing range allocator gives
ordinary, terrain-section and folded transforms independent addresses; Scene
removal/reset returns their ranges directly. Each view keeps its existing private
buffer, while its captures reuse those addresses. Folded identity and the ordinary
transform coexist, so a capture that disables folding still sees the source pose.
The next frame retires only the preceding frame's actual folded allocations before
reserving ordinary draws; an optional fold cannot occupy their capacity indefinitely.
If its extra identity slots exceed the budget, the frame records ordinary draws.
Sparse uploads coalesce changed physical addresses without compacting surviving
draws. Native submissions require capacity for their complete physical address set.
Material readiness observes the residency owner's accepted texture receipt and
mip count; source mip layouts are derived only when a texture is admitted.
Each synchronous presentation, inspection or submission projection observes a
shared material snapshot once per resource scope. Later phases and frames read
the owners again, so recovery and newly resident resources remain observable.
Snapshots without texture, sampler or video dependencies share the observation
by MaterialAsset handle within that scope; their numeric and color values do not
change resource readiness. Resource overrides retain snapshot-specific observations.
Cooked values-only children observe their accepted publication program owner;
the child GUID does not become a second program owner. Uncooked payloads and
actual program-owner failures retain their structured diagnostics.
Cloned snapshots sharing a texture payload validate its mip layout once within
that synchronous projection. The next projection validates live author data again;
GPU admission, material failures and video readiness retain their owner reads.
GPU residency indexes complete numeric handles within resource-scope tables.
Weak World tokens isolate equal handles without retaining their source World or
building strings on cache hits. Empty tables retire with their final mapping;
replaced allocations still drain through their existing submission leases.
Within one GPU artifact collection, an accepted target reuses vertex-color derivation
and admission for repeated draws with the same program, material/deformation, receipt
and immutable vertex-input table. Current program identities and entries are still
read for each draw. Changed inputs re-enter admission; a rejected draw never replaces
that target.
The retained scene shares canonical frozen prepared vertex-input tables, including
receiver-owned ShaderRegistry receipts, across entities. Extraction derives mesh input
tables once per immutable Geometry layout; an authored attribute-mask change selects
the new canonical layout before reuse. Borrowed tables are copied
into immutable owned values; each replacement snapshots their current values again.
Accessors and custom array methods retain the original copying/observation path.
Shadow admission retains matches by owned table and immutable shader requirements;
mutable or accessor-based requirements and borrowed geometry remain live observations.
Transform-only updates reuse those values. Mutable manifest receipt tables still
take the copying path until their producer owns immutable data.
Material pipeline selection queries the ShaderRegistry's manifest index directly.
Runtime-published programs without a manifest row remain ordinary missing lookups;
the renderer keeps no parallel manifest cache or per-draw publication scan.
CPU geometry recording prepares mesh-page bindings only after an actual submesh
survives GPU ownership, selected-pass and transparency filters. The skin binding
resolver runs for that selected skin consumer, without a closure per candidate.
The CPU directional atlas compares mesh identity and content epochs from the
existing complete caster validation, including off-camera casters; it does not
invalidate for a resource the caster set never consumes.
CPU shadow recording consumes the same fixed `MaterialFrame` as GPU preparation.
Each actual triangle submesh reads its accepted Pass list, bounds and material
slot. Multiple Shadow Passes remain direct; Forward transparency does not decide
Shadow admission. Hidden or non-casting objects leave the existing caster classes,
and point/line submeshes have no Shadow execution. Reflected and terrain receiver
raster state remains explicit at the consumption point.
The final layer observes the fixed material root whenever direct casters exist,
including morph and terrain geometry. A root change or leaving the direct lane
invalidates final depth; static GPU depth keeps its independent selected-batch
checks. This is conservative across direct materials and does not walk instances.
View-derived terrain materials join the same fixed root when their sections are
generated. Capsule geometry stays on the entity; its build and inspection consume
Shadow participation from the accepted material frame.
Within one GPU shadow recording, adjacent batches sharing the same immutable
material and shadow artifact reuse the material owner's accepted binding while its
residency epoch, uniform/scene buffers and pipeline resources remain unchanged.
Dynamic Canvas, video and target sources still visit their resource owner for
every batch. A later recording queries the artifact, schema and layout again,
so layout publication, recovery and failed binding retries remain observable.
Fallbacks from incomplete texture or sampler residency do not become accepted
bindings; the next batch still retries their owner.

Standard graph LightMode selectors share internal deeply frozen requests. The
matcher recognizes only those exact identities and reads each pass tag once,
without allocating selector entry tuples. Custom selectors retain eager
`Object.entries` observation, including accessor ordering and thrown values;
copies and proxies use the same custom path. No selector result is cached.

During a transition, GPU candidate/visible histograms count raster candidates,
including both levels. `geometryWork` exposes the extra work (`indirectDrawCount`
stays one row per level); `rootGeometryWork` counts the original candidate once. No extra material,
bind group, texture, render pass, or persistent transition-state table is added.

The regression fixtures are `lod-transition.unit.test.ts` in Render and the
shared `lod-transition.fixture.ts` Browser/Dawn journey in Runtime. The Dawn
journey saves real frame tapes, selected work indices, bindings, color/depth
readback, and live/fresh-device replay comparisons under
`artifacts/lod-transition/dawn/`.

References: [Three.js LOD](https://github.com/mrdoob/three.js/blob/dev/src/objects/LOD.js)
uses hysteretic single-object visibility; the contrasting coverage approach is
Unreal's [Dithered LOD Transition material option](https://dev.epicgames.com/documentation/en-us/unreal-engine/material-properties-in-unreal-engine).
The Unreal documentation endpoint was access-restricted during implementation;
this implementation uses its own deterministic coverage contract and tests.

Native presentation uses the same Renderer and frame receipts. A context's explicit
`supportedAlphaModes` controls composition selection: prefer premultiplied when
supported, otherwise opaque; an empty list fails before configuration. With no
capability fact, browser/WebGL2 defaults remain unchanged. Native windows do not
inherit transparency from their WebGPU backend name.

## Public frame contract

The built-in output transform has one registration owner after shader preparation.
An empty RhiNull manifest uses that same owner for its structural placeholder;
an unloaded registry cannot select the empty-manifest path. A missing canvas fails
before backend acquisition.

Initialization validates the boot pipelines, base Standard PBR/skin modules,
GPU-driven programs and producer-declared shader inputs, and waits for boot GPU
work before publishing the device generation. On backends with synchronous shader
module creation, unused Standard PBR/skin variants are created when their first
pipeline is requested. That first draw does not enqueue asynchronous module
warmup or omit the material. Async-only backends retain device-compatible variant
prewarming. Authored material and declared feature preparation is unchanged.
Boot module aliases and fallback module lookup compare complete source bytes
through the Shader owner's admitted fragments. Matching does not materialize
every unselected capability variant; byte-identical aliases retain their labels.
Point-shadow lane inspection reads complete WGSL temporarily without retaining
unselected variants in the Shader decode cache.
Prepared material and View-only depth programs share one View/scene-depth ABI
descriptor in `assembly/material-shader-policy`. Renderer derives its admitted
Atmosphere flag and retains ownership of native layouts and generation caches.

An unused malformed Standard variant therefore fails when selected, rather than
at initialization. Synchronous creation failures use the existing structured
material-pipeline error; native WebGPU validation reaches `Renderer.onError`.
Recovery builds fresh device-owned modules through the same preparation boundary.

Material graph projection and command recording consume the immutable
`MaterialShaderArtifact.program` published by ShaderRegistry. Camera motion,
graph replacement and material pass selection do not rescan shader source for
group-2 or ProbeBlend bindings and do not recompute program identity. Replacing
source replaces the complete program description; GPU recovery preserves the
CPU description through the registry fork.

GPU-driven material pipeline lookup uses the admitted geometry projection and
shader UV count directly. Cached pipelines do not reconstruct vertex descriptors;
custom material factories receive the original projection. Only a legacy pipeline
miss derives a GPU descriptor, including geometry-owned missing-UV aliases and
their stride adjustment. Empty projections still fail before cache lookup.

GPU raster graph classes retain physical mesh, layout, selected program, texture
specialization and render-state facts. Texture/sampler asset changes and alpha
cutoff admission keep their source batch boundaries but reuse the same compiled
class: encoding reads each live batch's material bind group and current material
rows. Shadow coverage still selects and invalidates through the shadow owner.
Material asset textures remain owned by residency rather than the raster graph.
Shadow recording also reuses the last successful pipeline for adjacent batches
with the same immutable program, layout and raster facts within one invocation.
Each batch still resolves its live material and draw bindings; a later view or
invocation starts a fresh lookup.

Material extraction and GPU Scene row packing also reuse the selected program's
admitted nonempty `paramSchema`. Native publication acceptance installs programs in
the receiving ShaderRegistry, then rebinds snapshot schemas with identical complete
content to that owner's schema before retaining scene rows. Multi-pass selection,
defaults and author metadata participate in that check; merged or distinct schemas
keep their own values. Stable frames reuse the admitted interface without repeated
shape checks or layout derivation. Unregistered programs and uncompiled custom Surfaces
retain their authored schema projection. Empty shader-manifest layouts retain
the authored or built-in Sprite fallback; the built-in Standard ABI remains canonical.
CPU uniform packing also selects the built-in shader's own parameter schema when
an authored material omits it. Unlit, Sprite and MSDF parameters must never inherit
Standard PBR byte offsets or defaults; numeric packing and texture-coordinate
projection share that schema selection.

\`Materials.standard({ baseColor, flatShading: true })\` and \`Materials.lambert\`
can select primitive geometric normals without changing mesh attributes. The
optional \`flatShading\` u32 material field selects smooth (0) or flat (nonzero)
shading in the same cooked program; omitting it retains the canonical ABI. The
stock Surface uses that basis for base normals, normal/bump maps and triplanar
projection. Rigid and skinned Forward/GBuffer suppress smooth-normal specular
broadening for flat faces; Forward clearcoat uses the same normalized, face-oriented basis.
Standard Forward/Deferred derive parallel orthographic view rays from the existing
View projection, so Fresnel and highlights do not vary with the camera position.
Shadow receiver geometry remains independent of the selected shading mode.

Material binding assembly retains resident texture/sampler handles across Worker
clones and numeric material edits. Dynamic sources, binding-source changes and
physical resource generations still invalidate it. The existing immutable-schema
projection also owns field lookup and texture order; recording does not scan the
schema for each texture or rebuild these lists on an assembly-cache hit. Only
owner-admitted schemas use that index. Unadmitted schemas retain Types' exact
shape validation and current per-field reads, including edits during target
resolution; array identity alone does not establish immutability.
Shared-layout compatibility uses Shader's admitted canonical user-region schema.
Admitted candidates retain their identity when no physical fields need exclusion;
raw or filtered schemas keep their original field observation and validation.
The material layout and recording paths both derive physical texture fields from
that schema: ordinary textures precede IBL and physical maps retain their fixed
slots. Cooked program digests and authored aliases use the same binding rule.
The layout and bind group also share the registry's cold source binding facts when
removing an undeclared backdrop sampler. A shared multi-variant layout, unknown
declarations and the fixed Surface medium ABI retain their existing binding policy.

GPU source topology groups World, source mesh/draw and shared material bindings,
including geometry whose current Forward pass is transparent. Main and shadow
executions prepare independently from the accepted material frame; changing a
Forward pass never removes a capable ShadowCaster pass. Binding preparation reads
shared geometry, program and residency facts without selecting a representative
entity or traversing candidates. Reflection-probe partitions depend only on object
selection and physical probe indices. Material edits preserve their membership.
Zero ShadowCaster passes select no execution; multiple passes remain direct, and
one pass independently checks the supported shadow raster state. A view with a
fixed geometry selection retains its candidate ranges when shared execution rows
change, including material descriptor replacement. Its depth invalidation does
not expand the material change into an instance list.

GPU execution batches capture a material descriptor address in the existing shared
input arena. Its two u32 words hold the payload start (16-byte material units) and
f32 displacement-radius bits; address zero explicitly selects zero values.
MaterialVersion owns that range and its payload through the existing reference
count. Resource mapping pages retain numeric addresses, while the prepared resource
frame pins the exact versions and input buffers. Material versions therefore do
not allocate primitive, instance or transform rows. Arena or payload growth keeps
its own physical-buffer replacement and invalidation policy. Shared Mesh versions
use seven u32 words in the same arena: bounds flags and min/max f32 bits. They
also allocate no primitive, instance or transform row. Material and Mesh addresses
are word offsets; resource mapping pages contain only these numbers. The original
versions retain reference-counted ownership, and sealed resource frames retain the
exact input buffer. Shared bounds update once without patching mesh consumers.

A prepared frame pins
the descriptor, packed material rows and current table buffers. Editing a pinned
material allocates a new descriptor and value range; changing its size or program
layout cannot overwrite the old frame. Each production owner permits one unfinished
preparation; submit or abort it before preparing another. Native views retain their
own production owners and share the Renderer submission. The physical submission
callback binds pins to that submission's completion before publication callbacks.
Aborting unsubmitted work releases immediately; aborting publication after physical
submission retains the pins until GPU completion. Freed ranges are
reused, and replaced table buffers retire after their last preparation and queued
work finish. At most 128 material frames may be retained per GPU Scene. Unpinned
values reuse storage and upload only changed rows. All this work scales with shared
material bindings and changed material bytes, not the number of objects using them.

Direct drawing queries the frame's shared GPU execution selection at the point
of consumption. It does not retain a per-entity ownership or validation table.
Requested submitted draw observations stream receipts from the same selection;
failed submissions do not commit geometry consumption. Shadow passes use the
same shared execution model. Capability fallback restores the complete Direct
caster roster, and independent captures retain both GPU and Direct casters.

Native source publications carry shadow pass ownership but cannot authorize
receiver GPU admission. After preparing local geometry and skin receipts, the
receiver derives each pass's CPU reason and eligibility through the same
predicate as local extraction. Source-side `unprepared` state therefore cannot
outlive successful receiver preparation; transparency, multiple passes,
unsupported render state, prepared contract mismatches and missing skin bounds
remain ineligible for GPU shadows. Receipt validation and structured preparation
failures are unchanged. Material edits and receiver recovery repeat that
derivation from current facts without a second admission cache.

Geometry admission includes the selected shader's clamp-to-last UV aliases from
the same Geometry descriptor used for recording. Aliases may only reuse the
resident vertex stride; they cannot manufacture missing UV storage, normals,
skin attributes or matching formats. Cooked receipts retain all reflected inputs.

When `caps.firstInstanceIndirect` is available, GPU-driven finalization writes
each batch/LOD visible base into the indirect command. Main and shadow draws
share a whole visible-buffer binding, including the late-occlusion mirror;
recording rebinds it only when the physical group or pipeline changes. Devices
without the feature retain aligned per-batch windows and zero first instance.
Visible rows, material and palette addresses, coverage, and draw ranges are
unchanged, and replacement buffers retire through the existing view owner.

GPU mesh preparation resolves each shared mesh once in its resource scope and
joins that residency directly to source batches. It neither scans Scene slots
nor overlays the CPU validation's per-entity mesh rows. Each batch checks its
shared mesh identity and content revision; an unrelated residency change cannot
trigger a member comparison. Shadow projections retain the observed shared mesh
revision, so an in-place write invalidates cached depth without per-primitive
invalidation fanout. Required missing program receipts refuse GPU preparation;
material semantics that need direct rendering retain their explicit direct route.
Both lease-based and published draw requests accept the optional
`geometryLane` diagnostic; omission or `'automatic'` preserves ordinary lane
selection. This request option does not change publication content or revisions.
The explicit `geometryLane: 'direct'` acceptance path keeps material/mesh admission,
recovery artifacts and submit hooks. Frames without Surface stop after admission:
they use the scene Material table and CPU draw receipts without filtering indirect
batches, projecting GPU LOD/visibility, uploading cull buffers or preparing raster
bindings. Retained GPU resources remain owned until graph replacement or disposal;
direct submissions do not report an unencoded GPU geometry generation as submitted.
Frames containing Surface retain the complete shared preparation and dynamic
page/frame/time/instance closure.
Its CPU shadow recorder consumes the validated caster roster without preparing a
GPU shadow plan or view. Previously active GPU shadow buffers retire after a
successful submission; returning to automatic after a failed direct frame cancels
that retirement through the existing shadow-view owner.
Scene passes prepare the indirect material-slot projection and clustered binding
callbacks only when they encode GPU-driven work. Direct Surface draws retain their
page/frame closure and scene Material table without rebuilding an unused indirect
material roster for each pass.
Main geometry recording and post-submit draw receipts consume the same GPU
selection. It indexes shared geometry/material bindings; a consuming draw queries
that selection directly. Source identity keeps sparse submeshes and dispatch
reordering independent of material/mesh slot order. Captures and direct graph
passes omit this main-view selection, and temporal draws retain their own
eligibility predicate. Native GPU preparation resolves shared geometry and
materials without expanding per-entity validation rows. Actual Direct graph
passes, shadow draws and explicit hidden pipeline preparation retain their own
validated geometry. TAA Direct preparation retains jitter-visible edge geometry.

Canonical Standard and default Unlit rows with the same pipeline, resource bindings,
material schema and route share a row-material batch. Each candidate reads numeric
parameters through its own GPU Scene material slot; the batch binds one held
material for its common pipeline and texture facts. Removing that material's last
row selects another held binding without changing the batch identity. Dynamic
texture/video sources and incompatible bindings keep their existing partitions.

| Accepted edit | Retained work |
|:--|:--|
| Numeric material values | Update the material row; no member reclassification |
| A material changes batch class | Reclassify only that material's rows; a sole-material group may re-key in place |
| A row swaps compatible materials | Keep its batch and update held membership |
| Visibility intent or membership changes | Capture only the World's changed entities into a persistent intent root; prior captures remain immutable |

Asset identity admission remains owned by AssetRegistry. Its default `maxAssets`
is 65,536; a 100,000-unique-material workload therefore requires an explicitly
configured larger registry budget before it can measure rendering cost. A budget
rejection remains `asset-budget-exceeded`; batching does not merge asset identities,
truncate the scene, or silently increase that limit.

Transmission and single-layer-medium topology demand belongs to the fixed
shared Material frame. Binding changes adjust group cardinality; a material
adoption adjusts its contribution once without enumerating users. Retained
frames keep their prior demand, and hidden sources contribute no active demand.

Scene preparation joins one shared geometry, resident mesh and accepted material
Pass. It stores no per-primitive material facts, admission map, draw-key set or
entity retention set. Visibility uses the scene's own source membership and
active-view publication independently of material adoption. Object binding
partitions keep their candidate ranges when a material or mesh changes; execution
preparation does not re-read or copy those ranges. Temporarily direct batches stay
in the GPU selector table with zero execution capacity. This preserves every other
batch's candidate address when transparency or Pass routing changes. The early
and late GPU kernels skip those inactive batches.

`gpuOwnedSnapshotsMaterialized` is zero for this preparation path;
`filteredPlanBuilds` counts main-view execution publications. The stock recorder
supplies immutable source and object-binding publications. Mutable alias observation
and the previous undefined-scope full-projection path are removed.

Within one GPU raster encode, unchanged physical material and mesh bind groups
keep their bindings. A program proven at registration to never reference its
material uniform binds offset zero: its numeric values come from GPU Scene, so
reordering the frame-local material table does not invalidate retained commands.
Custom programs with any uniform reference keep their material offset. Physical
material bindings and rigid/skin offset shapes remain part of the comparison,
and pipeline transitions reset both bindings. The
indirect buffer resolves once on the first admitted draw; every visible window,
LOD command and early/late region still records independently. No binding state
survives the encode invocation.

Each live Main batch retains its resolved visible-window bind groups by LOD and
early/late phase. Recording resolves only windows that actually draw, then reads
those handles directly across passes and unchanged frames. The existing batch
owner drops affected bindings when its visible buffer, scene tables, ProbeBlend
page or Surface buffers change; content-only writes preserve them. Graph reuse
still reads the current live batches after split/rejoin, and unused late windows
allocate no bind groups.

When the selected camera has no directional, point or spot shadow projection,
normal recording and recovery omit shadow artifacts and preparation. An empty
light-view roster retires active shadow views without scanning caster classes.
Re-enabling a light observes its current material and caster facts through the
same preparation.

Batch topology keeps each batch's identity and generation stable across
content edits. Source batches and retained filtered groups also own reusable,
aligned visible ranges and indirect command ranges. Removing or resizing one
batch does not compact surviving batches; a shadow subset keeps its source
windows and LOD strides. Removed ranges return to the same allocator, growth
replaces only the affected allocation, and a full owner reset clears its ranges.
GPU buffer capacities follow the maximum live window end independently of the
dense candidate and batch table sizes. Source `contentEpoch` tracks candidate
membership; material content and selected programs do not change that membership.
A 20-byte candidate contains primitive identity/generation, instance ordinal,
batch index and logical source slot. Its batch's 300-byte execution record contains
material address/deformation, draw commands, visible windows and up to eight LOD
rows. Changing a material address, its Pass route or the shared mesh content
does not re-encode, compare or upload candidate bytes. Color, roughness and other material row values update GpuScene without
rebuilding draw preparation or comparing entire material/schema records. Material storage starts at one 16-byte unit and grows with distinct accepted material ABIs, independently of entity capacity. Scene preparation is memoized per
batch by `(generation, contentEpoch)`; `preparedBatchBuilds` and
`filteredBatchBuilds` count the source and per-world batches re-prepared in
the last frame and are zero in steady motion. Prepared batches retain shared
program, physical LOD and raster identities. Geometry partitions retain only
source membership and object-binding facts. Freed windows return to the allocator;
excess fragmentation compacts windows without copying candidate membership.
Shadow projections retain their accepted program and native view selection. There is no per-batch mesh
projection: every GPU-driven raster and shadow draw binds the whole GpuScene
transform, instance and primitive tables, and the culler's visible item
`(instanceRow, materialIndex, customDataStart, lodFade)` names a scene instance
row directly. The vertex stage derives world and previous-world matrices,
reactive and motion-valid flags, and the probe identity from those rows, so a
moved entity costs only its dirty GpuScene rows. Surface frame inputs are keyed
by the same scene instance row.
`planRebuildBatches` and `planRebuildCandidates` count the submission-plan
shared batches and candidate records re-derived in the last frame. Material and
mesh preparation leaves `planRebuildCandidates` at zero, including Pass changes.
LOD selection of GPU-lane rows exists only inside the per-view GPU cull; a
camera move performs no CPU walk of LOD candidates.
`indirectDrawCount` counts indirect commands, one per LOD level of each
admitted batch. The existing
`sceneTableUploadBytes`, `candidateUploadBytes`,
`batchUploadBytes` and `paletteUploadBytes` are the per-frame upload counts at
their single write points. Mesh vertex/index residency uploads have no single
choke point on this path and are not reported.

Shadow ownership validation and CPU residual culling read world-space bounds
from the retained scene, including instance unions. Object transforms, instance
publications and mesh changes invalidate those bounds at the scene owner;
camera rotation does not. Each shadow view still intersects the bounds with its
own light-space planes. Unknown bounds and deformed geometry stay conservative.

Every accepted `FrameReceipt` with a submitted camera context carries an
immutable `barrelDistortion` mapping, including the exact identity mapping when
the camera has no active distortion. The optional property is a transport and
pre-first-frame shape: `undefined` means that no accepted submitted display
context exists. It is fail-closed, never an identity guess; display consumers
must wait for a new submitted frame.
The mapping is tied to the submitted output extent, camera matrices, device
generation, graph generation, and frame identity. Consumers must keep those
facts together; a mapping from a newer World edit cannot be applied to an older
picture. The renderer publishes the mapping only after queue submission, and a
candidate that fails validation keeps the previous accepted picture and
mapping. The public projection is deeply frozen and contains no device, graph,
texture, or mutable resource handle.

`renderer.inspect().barrelDistortion` projects the same accepted context as
`effectiveMapping`, `extent`, `frameId`, `deviceGeneration`,
`graphGeneration`, and `lastKnownGood`. Before the first accepted frame, after
surface retirement, or during device loss, `effectiveMapping` is unavailable;
display consumers must wait for a new submitted frame. An invalid authoring
value returns `barrel-distortion-invalid-parameter` with its field and bound.
Unsupported float attachment capability is reported only for an active plan;
an empty or zero-strength plan stays zero-work. A pending or failed disable
keeps the old nonzero mapping with its picture, while a successful disable
publishes identity and retires the old feature resources through the normal
in-flight fence.

`renderComponentsPlugin()` registers `Fog` for scene instantiation.

`Fog` provides distance fog. `mode` picks the law (`FogModeValue`):

| `mode` | Opacity | Three.js equivalent |
|:--|:--|:--|
| `exp` (default) | `maxOpacity * (1 - exp(-opticalDepth))` along the camera ray, with `heightFalloff` density | none |
| `exp2` | `maxOpacity * (1 - exp(-(density * depth)^2))` | `FogExp2(color, density)` |
| `linear` | `maxOpacity * smoothstep(near, far, depth)` | `Fog(color, near, far)` |

`exp2` and `linear` use camera view depth like Three.js, so the same numbers
transfer; `linear` leaves everything nearer than `near` unfogged, which keeps
an orthographic diorama board clear. `heightFalloff` applies to `exp` only and
must be 0 for the other modes; `linear` needs `0 <= near < far` and ignores
`density`. `color` is scene-linear and may exceed 1 (HDR), like a Three.js
`Color`. `color`, `maxOpacity` and the law fields are selected from the
frame's resource owner. Disabled fog (zero opacity, zero exponential density or
an empty linear range) records no fog pass; there is no 3D texture, froxel grid
or temporal history. The authored sky remains unchanged.
SMAA, FXAA, TAA and no-AA use single-sample depth; MSAA is rejected until a
matching depth resolve is available. Use `VolumetricFog` for spatial density and
lighting/scattering effects; the meadow-style distance haze needs only `Fog`.

### Fog and translucency

Fog composites depth-correctly with translucency (the Unreal
`CalculateHeightFog`-per-translucent model, not Three.js's per-material
`#include <fog_fragment>` mix toward fog color):

1. The `analytic-fog` raster pass fogs the opaque scene in place, after opaque
   and Deferred shading and before the transmission backdrop copy and every
   translucent draw. It reads `scene-depth` and the View uniform and writes
   `scene-color` directly; no extra color target is allocated.
2. Each blended writer fogs itself at its own depth with the shared WGSL
   `translucent_fog(view, worldPos, color, alpha)` from `forgeax_view::fog`.
   Built-in Standard, Unlit, sprite, text and point/line programs, plus every
   GPU particle topology (billboard, mesh, ribbon, trail, beam), call it;
   clip-space producers reconstruct `worldPos` with `ndc_world`.
3. The renderer binds a View copy whose `fogHeightOpacity.z` names the draw's
   blend composition, derived from its blend state: straight alpha adds
   `inscatter`, premultiplied adds `inscatter * alpha`, additive only
   attenuates by transmittance (it fades toward zero, never toward fog color).
   Opaque draws and frames without Fog bind the unfogged composition, so the
   same program is never fogged twice. `translucentViewOffset(composition)` is
   the byte offset of each copy inside the View buffer.

`renderState: { fog: false }` (Three `Material.fog = false`) skips fog per
material. Blended draws bind the unfogged composition. Opaque forward draws with
the flag leave `main` and record in a `main-unfogged` scene pass right after
`analytic-fog`, loading and depth-testing the fogged depth, so in front they
replace fogged pixels and behind they fail the depth test. The pass exists only
in frames that hold such a material and active fog, so default frames are
unchanged. Costs and limits: one extra render pass in those frames; fog:false
forward draws take the direct (CPU) route instead of GPU-driven batches (their
shadow casters stay batched); a `CloudLayer` composite, which draws before fog,
keeps them in `main` and fogged; deferred opaque always fogs.

Custom WGSL blended materials import `translucent_fog` and apply it to their
final color the same way; an opaque custom material needs nothing. Each
translucent layer is fogged as a single homogeneous-medium segment from the
camera; transmission/refraction samples the already-fogged backdrop, and the
integrated `VolumetricFog` volume is composited once after every translucent
writer (see Local volumetric fog).

`translucent-fog.dawn.test.ts` verifies live and fresh-device replay pixels on
both render paths with unlit and Standard panes, including the wrong-depth
falsifier. Ordinary CI omits repeated performance sampling without a cost bound;
receipt and timestamp correctness remain with the dedicated GPU timing gates.

### Local volumetric fog

Spawn one `VolumetricFog` per local medium in the rendered environment World.
Each owner selects its own light, 3D density texture, world-space bounds, and
optical coefficients. Up to `MAX_VOLUMETRIC_FOG_OWNERS` (11) owners share the
renderer-owned inject, integrate, temporal, and composite passes. Overlapping
media add coefficients before integration; removing one owner keeps the others.
Removing the last owner retires the volume graph resources.

The capacity follows the portable 16 sampled-texture budget: integration binds
five auxiliary textures plus eleven independent 3D density textures, including
when atmosphere or cloud shadows are disabled. At the 64-depth profile, eleven
owners use 176 froxel array layers, below the portable 256-layer limit. Each
density retains its own texels, normalized coordinates, filtering and generation;
no world-grid resampling or shared atlas changes local sampling.

`Renderer.setProfile()` accepts `volumetricFog: { quality, depth, tileSize }`.
The public `validateRenderProfile()` applies the same admission rules without a
GPU, allowing build hosts to reject invalid profiles before Renderer assembly.
The closed values are quality `low`/`high`, depth `48`/`64`, and tile size
`4`/`16`; all combinations are valid. Omission keeps the existing high,
64-depth, 4-tile default. The Renderer snapshots this nested configuration;
mutating the caller object cannot change an accepted profile. Invalid fields
fail with `frame-input-invalid` before resource admission. Tile size and depth
are budget choices; inspect the accepted volume extents and bytes after a
submitted frame rather than inferring them from the quality label.
Low quality reconstructs the center plus four axial neighbors (five taps);
high quality keeps the center plus eight neighbors (nine taps). The optional
two-neighbor shader specialization remains available internally but is not the
low-profile default after visible artifact feedback.

| Author field | Contract |
|:--|:--|
| `density` | Shared linear `TextureAsset`, `viewDimension: '3d'` |
| `sampling` | ECS enum: `VolumetricFogSamplingValue.noise` (default animated atmospheric grain), `.density` (local normalized bounds sample), or `.densityAlbedo` ([premultiplied RGBA](#volumetric-density-coordinates)) |
| `boundsMin`, `boundsMax` | Finite world coordinates, strictly increasing on each axis; not transformed by `Transform` |
| `extinction`, `albedo`, `emission` | Nonnegative RGB; albedo additionally at most 1 |
| `anisotropy`, `maxDistance` | Finite, respectively `(-1, 1)` and positive world units |
| `light`, `spotLight` | Same-World selected light and optional Point/Spot pair, as in the existing single-volume contract |

Pure `VolumetricFogAuthoring` validation uses the string sampling labels, not
the ECS numeric values. `extractVolumetricFog()` returns an available `fogs`
collection and validates every member atomically. Overflow returns
`volume-owner-conflict` with `detail.ownerCount`; invalid author parameters
retain the existing structured error contract.

Read `renderer.inspect().volumetricFog.ownerCount` after a completed frame for
the accepted collection, alongside status, pass count, memory, and generation.
It is not an echo of a rejected candidate. Light projectors retain the shared
renderer-selected projector contract; only its selected light samples the map.

> [!IMPORTANT]
> This is local-medium integration against opaque scene depth. The integrated
> volume holds one camera-to-opaque-depth integral per pixel, so it is
> composited after translucency: a translucent or VFX writer behind the medium
> (cloud deck, sky card, distant particle) is fogged exactly, and one inside the
> medium also receives the segment behind it. Composited before translucency,
> every blended writer would cut its own silhouette out of the lit medium.
> Translucent writers additionally receive the analytic `Fog` at their own depth. Software GPU readback is
> correctness evidence, not hardware performance evidence.

## 灯光最短入口

三条最短入口：

1. `RectAreaLight`：在现有 `Transform` 上声明单面矩形发光体，尺寸由 `width` 与 `height` 持有；可选 `sourceTexture`（任意尺寸的 2D `TextureAsset`：rgba8/bgra8 的 sRGB 或 linear、r8 灰度、rgba16float/rgba32float 截断到 [0,1] 走 CPU 投影；KTX2 块压缩格式 BC/ETC2/ASTC 由一次 compute 提交在 GPU 上从 level 0 重采样进共享 slice，需要 compute 与设备的压缩 feature，否则报一次 `feature-not-enabled` 并回退白色 slice）按 Unreal SourceTexture 方式调制漫反射与高光（LTC 平均方向投影到灯平面取 UV，按 footprint 选 mip），与 Spot `cookie` 共享同一 light-texture 数组并按 handle 去重；不支持的格式报结构化错误并回退为均匀发光。
2. `PointLight`、`SpotLight` 和 `RectAreaLight`：用 `iesProfile` 绑定配光资产。Spot 另有 `cookie` 和 `rollDeg`；缺席 handle 是乘法单位元。
3. `LightProbe`：声明 27 个 `irradiance` 值和唯一的 `radius`，位置与朝向仍来自 `Transform`。

这些是 authored/render 输入，不是 GPU slot、LTC、probe asset 或第二个 Renderer API。尺寸、半径和 `rollDeg` 在场景序列化中保留；资产 GUID 通过 Pack/Catalog 的 `refs` 往返，不能从 URL 或数组位置推断身份。

### Extended-lighting consumer route

Small public examples are `RectAreaLight(width, height, sourceTexture?, iesProfile?)`,
`PointLight(iesProfile?)`, `SpotLight(iesProfile, cookie, rollDeg)`, and
`LightProbe(irradiance, radius)`.
Probe diffuse uses `A={admitted && d<r}`, `c=1-(d/r)^2`, scaled finite `qhat`,
`alpha=q/Q`, `C=1-prod(1-c)`, and `S=1-C`; Sky is only
`S*E_sky(N)`. It never enters probe admission, `Q`, `alpha`, specular, or
`DirectLightSlot`. `recordByteLength=160` is the per-object ABI receipt.
The persistent scene materializes object positions only when local probes exist.
Without them, every surface reads Sky directly; cooked programs with an
always-present probe binding share its zero lane. Material edits never change
probe membership or allocate per-object sky residual records. The retained roster
follows scene revision and probe presence, including transitions without geometry changes.

Recovery is inspected as data: read `code`, `expected`, `hint`, and typed
`detail`; keep the current LKG until the replacement generation is accepted.
GPU, Browser, and Dawn evidence that cannot execute is `not-run` or
`unavailable`, never a verified structural substitute.

### IES directional emission

`PointLight.iesProfile`, `SpotLight.iesProfile`, and `RectAreaLight.iesProfile`
reference the same cooked `IesProfileAsset`. Import accepts LM-63 Type C with
`TILT=NONE`; peak-normalized samples are baked to a 256 × 128 `r16float` grid.
The profile multiplies `color * intensity`; it does not replace the light's
intensity with the file's absolute candela or normalize integrated flux.

Point and Rect use the companion Transform's frame: local **+Z** is polar
angle zero, **+X** is azimuth zero, and azimuth increases toward **+Y**.
Rotate that Transform to aim an asymmetric profile. Point covers the entire
sphere. Rect retains its one-sided +Z emission, width/height and LTC evaluation;
IES samples the direction from its center to the receiver and multiplies both
diffuse and specular, including transmission and `sourceTexture`. This is a
center-direction approximation; it does not integrate measured photometry
separately over each emitter point in the near field. Spot keeps its existing
`direction` and `rollDeg` frame and cone attenuation.

For a pedestal lamp, author zero intensity for directions below the emitter
and rotate the profile into place. This suppresses emitted direct light below
the lamp even with shadows disabled. Geometry shadows remain independent:
add `PointLightShadow` when other objects must occlude the point lamp.

Standard Forward/Deferred and their surface captures share this sampling path.
The local volume integration and VolumetricFog paths do not consume IES; the
opt-in ray reference explicitly refuses IES lights. Custom lighting shaders must
implement their own emission contract. The extended-lighting texture topology
is required; a topology without it retains identity modulation.

One composition admits 32 profile bindings, deduplicated per World/handle
across Point/Spot/Rect; handles from different Worlds cannot alias a GPU layer.
An invalid cooked shape or exhausted capacity reports `light-resource-unavailable`
and keeps that modifier at identity. Import/load failures retain their owning
error. Removing a profile restores ordinary emission immediately. The existing
96-byte light slot and 2 MiB IES array are reused, with no extra lighting pass;
each affected fragment/light adds one filtered profile lookup. Stable payloads
produce no texture writes or repeated payload hashes on the local World path.
Cooked profile bytes are immutable; replace the asset to change photometry.
The polar endpoints use texel centers, while the
azimuth axis wraps continuously.

The Feature Lab entry `lighting-shadows/ies-light-profiles` demonstrates a warm
point pedestal lamp and a cool rectangular lamp with an IES on/off toggle.
`ies-local-lights.{browser,dawn}.test.ts` checks HDR identity, hemisphere cuts,
rotation, poles, removal, transferred publications, shadow/texture composition,
and fresh-device RHI replay of the actual light table, profile array and HDR
attachment. Opt-in `IES_PERF=1` Dawn measurements use 60-frame alternating windows
at 1/32/256 lights; the matching Browser carrier requires the Vite definition
`import.meta.env.IES_PERF: '"1"'`.

The public frame vocabulary is intentionally small. `Camera` is the authoring
owner for tone, exposure, color grading, antialiasing, bloom, and `historyVersion`; `Atmosphere` and
`Fog` are independent ECS components. The renderer extracts these facts into
an immutable `FramePlan`, records one frame, and returns a `FrameReceipt`.
`FrameReceipt` is the only successful synchronous proof that the host submit
reached the queue. Use `Renderer.inspect()` for detached lifecycle and
capability facts, then `observe(receipt, request)` for receipt-bound evidence.

When optional `backgroundPipelineLibrary` preparation starts,
`inspect().backgroundPipelineLibraryState` remains `running` until both native
preparation and CPU material analysis settle. It reports `done` only for the
current device and `failed` on preparation failure or retirement. The nested
`pipelineLibrary.backgroundWarmup` counters describe the native RHI lane only;
its completion alone does not establish whole-Renderer preparation completion.

Request per-view GPU LOD facts explicitly with
`observe(receipt, { include: ['lod-occlusion'] })`. The returned
`lodOcclusion` value is a detached `complete` or `unavailable` observation. A
complete result contains the submitted display roster, each view's Camera
identity, attachment, `Camera.historyVersion`, own graph generation, rendered
state, and that RenderSystem's existing LOD inspection. It is receipt evidence,
not a projection of the current live `inspect()` state. The view generations
belong to their individual Cameras and need not match across Cameras.
The capture also retains each actual view, RenderSystem, graph incarnation, and
World lease. A selector readback may replace the inspection only when that
RenderSystem returns its frozen result after validating the same submit and
World map; the capture is revalidated after async work and on cached reuse.

LOD observation retains only the newest successful submit's bounded CPU capture.
Observe its completed receipt before the next successful submit; a later submit
supersedes the prior capture and yields the closed `unavailable` reason instead
of substituting newer rows. A held view, missing selector attribution, empty
telemetry without owner evidence, stale view/lease, unsupported lane, or exceeded
bound cannot produce `complete`. The whole `lodOcclusion` subtree is limited to
16 KiB and each existing LOD sample list remains bounded to 64. This observation
does not report physical mesh residency or prove a GPU backend's pixels.

`receipt.presentation` is `pending` while the visible scene still uses a readiness
fallback. Presentation checks validate current texture layouts, sampler residency and
video availability once after successful submission and geometry coverage checks,
without retaining unused material-detail rows. Selecting the display workset before
recording does not repeat material readiness or video checks. Material
binding inspection still publishes complete texture mip and sampler details;
this projection introduces no readiness cache or skipped resource admission.
 Authored image-based Skybox and Skylight sources require their resident
cube and completed IBL publication before it becomes `ready`; lazy projection
continues during pending submissions. A single display view without capture,
nonempty local Feature, or dynamic-resolution dependencies retains its
existing picture only after a successful display submission, while an authored image is pending, instead of queueing fallback
scene/shadow/post work behind IBL stages. The queue still accepts real submissions;
these do not commit scene transforms, temporal history, or post-processing submissions.
Graph-admitted post-process parameter buffers remain
owned by that graph when native pipeline preparation defers presentation; rejecting
the frame releases only buffers which were never admitted. Scene-depth Feature
consumers abort their batch while that input is pending, retaining queue completion
without publishing an unwritten capture or acknowledging source feedback.
First display still records the complete fallback graph; an offscreen capture does not qualify as a prior display. Once the image is resident, the complete graph resumes.
This path permits manual exposure without a LUT and excludes retained automatic
exposure or LUT state; those configurations keep their complete recording path.
LUT absence depends on its handle, independently of its default strength.
Picture retention requires an accepted output whose extent matches the current canvas,
including CameraView output. Resize or device recovery records the complete graph
until a matching display submission is accepted.
An installed Feature whose plans declare no resources and no passes does not
block retention; this includes the workspace VFX host with no active emitters.
Any declared Feature resource, pass, or fullscreen effect preserves the complete
recording path and its submission-sensitive consumption.
Other view/dependency combinations keep their ordinary complete recording path.

`createFullscreenRenderFeature({ stage: 'before-temporal', ... })` composes a
scene-linear HDR effect after scene composition and before TAA, on the same
internal pixel lattice as raw depth. The default `after-output` stage samples
display-encoded color. Depth-based geometry effects should use `before-temporal`;
reading jittered depth after TAA can reintroduce unstable edges. Stage is part of
the frozen declaration, Worker transport, and graph/cache identity. Scene effects
use separate color targets and require no copy of the input texture.

Dynamic geometry acceptance changes the RenderScene mesh identity. Its existing
`geometry-revision`, `new-slot`, and `generation-reuse` reactive projection rejects
affected surfaces locally; it must not reset the submitted camera or the entire
TAA history. Explicit pause/resume and device/session recovery retain their
global temporal cut semantics.

A solid-color Skylight or Atmosphere needs no image cube. Consumers requiring the ready picture must wait for a matching completed
`ready` receipt, rather than counting clear-only submissions as scene readiness.

A World without a display `Camera` is a valid clear/UI frame: no
`render-system-no-camera` error is emitted and no scene geometry is drawn. The
internal clear parameters do not create a World entity. Once initialization is
complete, an admitted camera-free World can return a completed `ready` receipt;
explicit scene-free startup/retirement UI remains `pending`. Adding or removing the
last camera uses the same Renderer lifetime and submission path.

CPU draw routing and submitted receipts query `GpuDrawSelection` against shared
geometry/material bindings and the current validated source. Successful submission
consumes actual draws; rejected submissions produce no presentation or geometry
receipt. Scene identity, World remapping and physical resource replacement remain
part of the native geometry contract.

Shadow readiness records the shadow views actually bound by scene receivers in
this frame. A later scene pass without shadow inputs, including Outline selection,
preserves that evidence. Recording resets the views at each frame start; a cached
shadow receiver still publishes its bound view even when no shadow raster pass runs.

### SMAA

Set `Camera.antialias` to `ANTIALIAS_SMAA` from `@forgeax/engine/render`.
It selects SMAA 1x Medium: spatial color-edge detection, eight two-pixel search
steps with the original area/search tables, then linear neighborhood blending.
It requires no jitter, motion vectors or history. The mode is exclusive with
FXAA, MSAA and TAA; `DynamicResolution` continues to require TAA.

| Stage | Input and output | Work |
|:--|:--|:--|
| `smaa-edges` | Linear LDR to RG8 edges | Threshold 0.1 and local contrast adaptation |
| `smaa-weights` | Edges and lookup tables to RGBA8 weights | Orthogonal searches, crossing-edge classification and area lookup |
| `smaa-blend` | Linear LDR and weights to RGBA16F | Blend the strongest adjacent edge, including alpha |

Standard runs SMAA at the output extent, after tone/LUT/Outline/BarrelDistortion
and before its single output encoding/dither. Forward and deferred share this
placement, including `tonemap: none`. Disabling SMAA removes all SMAA passes
and targets. The graph owns resize, replacement and fence-delayed retirement;
lookup uploads occur once per graph texture, with no external asset request.
Medium does not include the diagonal/corner detection of High/Ultra or T2x.

Inspect `renderer.inspect().perFramePassNames`, then capture with RHI Debug.
The permanent Browser/Dawn fixture under `packages/runtime/src/__tests__/smaa.*`
compares against a 4x-per-axis coverage reference, exercises 60 completed frames,
odd extents and disable/restore, reads every captured stage, compares live and
fresh-device replay, and removes the weight draw as a negative control.

The implementation references Three.js r184 `SMAANode.js` / `SMAAPass.js`
(commit `d3b629c0c2097cec664ad16369bb6eae3b10e335`) and Unreal's
`SubpixelMorphologicalAA.cpp` / `Shaders/Private/SMAA` at
`71fe36aac5a8df5ccd66c763ffc902b29b6a9c43` for pass and sampler ownership.
The WGSL adaptation and lookup data derive from Three.js and SMAA v2.8;
no Epic source is distributed. Redistribution terms are in
[src/features/smaa/LICENSE.txt](src/features/smaa/LICENSE.txt).

> Uses SMAA. Copyright (C) 2011 by Jorge Jimenez, Jose I. Echevarria,
> Tiago Sousa, Belen Masia, Fernando Navarro and Diego Gutierrez.

### AI cold-start route

An AI consumer can start with the public sequence `state -> inspect -> recover
-> FrameReceipt`. `Renderer.state()` is the closed lifecycle union: only
`alive` admits a frame; `device-lost` permits one explicit recovery flight;
`recovering` shares that flight; `faulted` requires a new Renderer; and
`disposed` is terminal. `inspect()` is detached POD evidence for the current
state, recovery attempt, and named output contract. After `recover()` succeeds, submit the current
draw input and use the new `FrameReceipt` as the proof for that generation.
An active device loss includes native `destroyed` notifications. Retired and
unpublished candidate generations are isolated from active health. Disposal
retires the loss observer, so late native loss or validation notifications cannot
change the disposed Renderer or report an active failure. Pending
dynamic geometry must be prepared again for the replacement generation before
admission. Explicit preparation between recovery and draw may upload its new
payload; the first-draw guard still rejects lazy cold uploads or pipeline builds
inside rendering. Preparation does not make an old-generation receipt current.
A Host that owns transferable presentation supplies `RendererOptions.resolveRecoveryCanvas`.
The existing recovery flight calls it once during `quiesce`, under the same total
deadline, and aborts an abandoned request. The candidate device and graph use the
returned canvas; only successful generation publication changes Render's active
canvas. Rejection keeps the renderer device-lost and its World leases intact.
A healthy renderer never requests a replacement surface.

If submission succeeds but its queue completion rejects, the current generation
becomes `faulted` (`health().reason: 'internal-fault'`). Its pending receipts fail
with the first completion error, preserving the native `Error.cause`; both public
and Host drawing stop. The failure does not prove hardware device loss and does
not immediately dispose the device scope. Dispose and recreate the Renderer.
An unaccepted submit failure remains retryable, and completion failures from a
disposed or replaced generation cannot fault the current generation.

Hosts may supply `RendererOptions.ui`, the shared `UiPaintSource` contract.
`kind: 'rgba'` returns tightly packed premultiplied sRGB RGBA8 at the physical
output size. `kind: 'sparse-strips'` supplies the matching shaders and owned
`UiGpuFrame` preparation. Both call `paint(timeMs, width, height)` once per
admitted frame and return `null` when unchanged. Renderer owns the five raster
pipelines, integer data textures, image residency and temporary layers; the UI
producer owns no device or rendering context. Sparse preparation requires four
bind groups and nine vertex attributes, with no compute or storage resources.

Renderer copies changed CPU pixels or accepts immutable GPU preparation, then
composites the UI after camera output processing in the same encoder, submission
and receipt. Final-display captures include the UI. Retirement follows the
submission fence; recovery reuploads retained pixels or rasterizes retained
preparation on the replacement device. Unchanged UI submits no new raster work.
On a surface without copy-source support, an observed frame composes camera
pictures and UI into one Renderer-owned display target, then presents the same
encoded pixels. Private camera selection and per-view targets remain unchanged.
The document and its lifecycle remain borrowed from the Host.

With UI configured, the internal renderer Host construction returns after the
graphics/UI surface is usable and exposes the existing scene `initialization`
promise. The Host starts its App before awaiting that promise. UI-only receipts
remain `presentation: 'pending'`; scene initialization failure leaves UI usable.
The public Runtime convenience constructor still awaits complete initialization.
Shader readiness and scene activation are independent. Until activation commits,
submit `{ leases: [], camera: null, environment: null }` through the same `draw`
boundary. This requires configured UI, remains `pending` even after shaders are
ready, and carries no previous scene's camera mapping or terrain projection.
Admitted scene requests still diagnose missing Camera normally. A failed Host
withdraws its scene through this same frame shape so Fatal and Reload keep drawing.

Recovery rebuilds no frame from the last submission. Publication clears derived
GPU state (`resetGpuForRecover`), and the next draw re-extracts the current World
through the same extraction, residency and preparation path as a cold start.
Skin snapshots retain CPU pose facts for both local and published sources; the
shared Skin root rebuilds from the receiver's complete current baseline and
previous-pose history is cut. Discarding a candidate leaves the active projection unchanged.
Standard and Skin module preparation deduplicates exact source bytes in bounded
batches, retains every reachable draw variant, and settles all started compilation
before rejecting a frame. Both direct and scene-index addressing remain
prepared for clustered, probe and skin draws, including backends without immediate
shader creation. The dedicated non-clustered GPU program does not cover those
combinations; each still uses its own matching pipeline layout.
Ordinary graph replacement retains the previous graph until submission settles,
using the same retirement boundary for resize and post-process changes.

`inspect().recovery` is always present. Its `phase` is `null` outside an active
attempt and otherwise follows `quiesce`, `acquire-adapter`, `acquire-device`,
`rehydrate`, `compile-graph`, `publish`, and `cleanup`. The projection also
reports the `fromGeneration`/`candidateGeneration` fence, monotonic `attempt`,
`lastOutcome`, committed `rehydratedRoots`, and bounded `staleLossEvents`.
These are detached facts; they never expose devices, graphs, textures, or
mutable resource collections.

During `device-lost` or `recovering`, the App keeps its host heartbeat but does
not advance the World or submit a frame. A failed `Result` is repaired from
`error.code`, `expected`, `hint`, and typed `detail`: wait for the shared
recovery flight, explicitly retry, repair the named owner, or create a new
Renderer according to the closed error. Do not parse `message`. Target and
history tokens retain logical identity, but their new-generation contents are
uninitialized until a successful receipt; a neutral target or last-known-good
fallback is not proof of real recovery. Public consumers never receive graph
nodes, devices, history textures, or prepared handles.

The current-source manifest and schema identify `source`, `build`, `backend`,
`runner`, and `frameIdentity`. Structural graph receipts, Browser/Dawn
readback or PNG evidence, and historical oracle data are separate evidence
classes. An unavailable backend is reported as unavailable.

Image-based environment preparation retains 38 bounded queue submissions and 43
draws. Face and prefilter uniforms are immutable slots written before submission;
queue order preserves the stage dependencies. One final BRDF completion fence
gates publication. Texture sizes and shader sample counts stay unchanged;
candidate outputs and bake counters publish only after that fence succeeds in
the same live DeviceScope generation. Rejected submission or retired generation
stops further stages and prevents publication.

### Renderer-wide graph allocation inspection

`renderer.inspect().renderGraphGenerationAllocation` is the renderer-owned
logical allocation receipt across active, volumetric candidate, retiring, and
detached recovery graph generations:

```ts
const allocation = renderer.inspect().renderGraphGenerationAllocation;
if (allocation?.availability === 'complete') {
  console.log(allocation.liveBytes, allocation.pendingRetirementBytes, allocation.peakBytes);
  for (const entry of allocation.entries) {
    console.log(entry.generation, entry.roles, entry.retirement, entry.allocation);
  }
}
```

`roles` identifies `active`, `candidate`, and `retiring` ownership; `retirement`
is `active`, `pending`, or `failed`. `liveBytes` and
`pendingRetirementBytes` are current logical bytes, while `peakBytes` is the
simultaneous logical high-water mark captured at compile, replacement, and
retirement events. `failedRetirementCount` and `failedRetirementBytes` keep a
destroy refusal, throw, or fence failure visible until its owner is repaired.
`availability` is `complete`, `partial`, or `unavailable`, with
`unavailableGenerationCount` explaining omitted graph facts. `unit` is
`engine-allocation-bytes` and `physicalResidency` is always `unknown`: imported
resources remain with their importing owner and logical byte size is not a VRAM
measurement. After a device-loss recovery, inspect the replacement generation
and retry the frame; a retained failed or pending row is recovery evidence.

Topology replacement shares exact-descriptor graph-created textures with the
live previous generation. Aggregate bytes deduplicate `physicalAllocationKey`;
a live lease takes precedence over a pending lease of the same allocation.
Per-generation lease totals can therefore sum to more than the aggregate.
Resize, descriptor change, device replacement, and failed candidate rollback
retain their existing validation and fence boundaries.

Compute program compilation is reused by exact WGSL, entry points, and binding
layout within one device/feature generation, with at most 64 retained programs.
Playback names keep independent references and buffers. Descriptor changes
still validate, and recovery compiles against the new device session.

## RenderFeature: the producer seam (first-read index)

### Material contract projection

Render consumes only the Pack-owned material publication projection. Its
inputs are runtime bool/value data, composed module slots, and the closed
compiler context; render never authors, cooks, writes DDC, or selects a
fallback material. The projection preserves `layoutIdentity`,
`programIdentity`, `cookIdentity`, and `materialPublicationIdentity` so a
stale draw can be traced to the first producer divergence.

Receiving devices select cooked storage programs by the same sampled-texture topology as
their View layout: `storage-buffer-minimum` below 21 slots, `storage-buffer-projector`
at 21-23, `storage-buffer` at 24-30, and `storage-buffer-atmosphere` at 31 or more.
Storage support alone never admits optional lighting bindings. Missing publications require
producer re-cook; runtime does not compile or rewrite the authored Surface to fit a device.

`SpriteInstances` selects the published `sprite-instances` geometry context.
Its material snapshots are isolated from ordinary mesh snapshots even when
entities share a material handle, including reuse across extraction frames.
A missing cooked context is a producer error requiring re-cook, not permission
to reinterpret a mesh buffer as a region-bearing instance buffer.

### Direct-light multiscattering quality

Image-based Skylight and SkyboxBackground residency includes the selected resource
scope and complete asset handle, so equal numeric handles in different Worlds
and different generations cannot reuse another image. Their baked irradiance,
prefilter and BRDF textures publish together after completion. The device cache
shares pipelines, not a last-image output. Distinct background and lighting
images both prepare; a shared source prepares once. Returning to solid Skylight
uses its constant environment even after an image has been rendered.
Managed edits to the same equirect handle invalidate only that source's scoped
cube and IBL, through the existing local or published asset-change stream. The
next use rebuilds once across views. Superseded async work cannot publish; its
child resources retire after their submitted readers complete. Pipeline reuse
and direct scope removal keep unchanged frames free of asset or consumer scans.

A solid-color Skylight represents constant environment radiance, including
specular reflections. Its BRDF response uses the checked Three r184 16x16 GGX
DFG data with the existing IBL sampling axes; roughness and view angle remain
physical inputs even without an image. Panorama BRDF integration reuses
Standard's correlated Smith visibility function. No Skylight means zero
environment contribution. See [the uniform-environment comparison](../../apps/parity/color-lighting/ENVIRONMENT_RESPONSE.md)
for the measured scope and remaining LUT differences.

`Materials.standard` uses the mobile-friendly DFG numerical fit by default.
`directMultiscattering: 'lut'` explicitly enables the engine's precomputed
direct-light DFG texture; this adds one sampled texture and reuses the existing
linear sampler. It is independent of Skylight and its IBL integration table.

```ts
const material = Materials.standard({
  baseColor: [0.8, 0.3, 0.1, 1],
  metallic: 1,
  roughness: 0.3,
  directMultiscattering: 'lut',
});
```

A custom Standard Surface opts in through its ordinary root contract:

```ts
const material = Materials.standard({
  surfaceModule: 'game::surface',
  parameters: [{ name: 'directMultiscatteringLut', type: 'u32', default: 1 }],
  values: { directMultiscatteringLut: 1 },
});
```

The declared `u32` is a real material uniform: zero selects the fit, nonzero
selects the LUT. A child can change the value without changing the root's
resource capability; clearing the value restores the declared default. The
texture is engine-owned, so authors provide no texture GUID, UVs, or sampler.
Default, canonical and glTF-imported materials do not declare this opt-in field.

The first LUT material uploads one immutable 16 × 16 RG16F texture (1 KiB) into
the current DeviceScope. Forward, Deferred and submitted ray transport share
that resource, independently of whether Skylight exists. Device recovery creates
one replacement upload; material changes and repeated frames do not re-upload it.
The additional sampled texture participates in the actual pipeline binding
budget. An unavailable budget rejects the requested LUT material with
`material-sampled-texture-budget-exceeded`; it does not substitute the fit.

Standalone ray transport, diffuse-GI diagnostics and irradiance baking accept
`kernelLut`, the build-time `DIRECT_DFG_LUT_AVAILABLE` kernel variant, alongside
the fitted `kernel`. A LUT material without that variant fails explicitly.
Standalone operations own and dispose their texture scope; an irradiance bake
shares one scope across its probe batches. The bake fingerprint includes the
selected kernel and the exact LUT texel bytes.

### Independent Standard scalar maps

`Materials.standard` accepts independent linear-data textures without a custom
Surface or repacking image channels. Each slot accepts a GUID or the existing
`{ texture, sampler?, coordinates? }` value, including its own UV set/transform.

| Input | Channel selector | Default | Evaluation |
|:--|:--|:--|:--|
| `metallicTexture` | `metallicChannel` | B (`2`) | Multiply the selected texel by `metallic` |
| `roughnessTexture` | `roughnessChannel` | G (`1`) | Multiply by `roughness`, then clamp to `[0.04, 1]` |
| `alphaTexture` | `alphaChannel` | G (`1`) | Multiply base-color, base-map and vertex opacity |

Selectors are integers `0..3` for R/G/B/A. The default channels and scalar
multiplication follow [Three.js MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html).
ForgeaX retains its `metallic` naming; Standard roughness defaults to `1`, matching Three r184.
The shared schema also defaults `emissiveIntensity` and `sheenRoughness` to `1`.
An emissive color therefore works without an additional intensity override; black remains the default color.
An independent metallic/roughness input replaces only its corresponding packed
`metallicRoughnessTexture` sample; absent independent inputs use the packed
sample, or neutral white when neither is authored. The two texture sources are
never multiplied together. Alpha preserves the existing `alphaCutoff` and
`renderState.blend` policy; assigning a texture does not enable blending.

The canonical Standard pipeline reuses an earlier texel sample when an
independent map resolves to the same texture and sampler with the same UV set,
transform, and physical UV scale. A different sampler or coordinate mapping
keeps its own sample. This specializes the shader's sampling work; the
material's stable texture bindings remain separate slots, so existing packed
maps and independently authored maps can coexist without repacking.

```ts
const material = Materials.standard({
  baseColor: [1, 1, 1, 1],
  metallic: 1,
  roughness: 1,
  metallicTexture: metalGuid,
  roughnessTexture: { texture: roughGuid, coordinates: { set: 1 } },
  roughnessChannel: 0,
  alphaTexture: opacityGuid,
  alphaCutoff: 0.5,
});
```

Import the scalar images as linear data. Pack publication preserves GUID edges,
channel values, sampler references and coordinates, including child-material
GUID shorthand. glTF keeps its standard packed metallic-roughness input;
independent overrides can be authored on the resulting Standard material.
Forward, Deferred, skinned and shadow templates consume the same Surface.
New independent slots are declared only when authored in a cooked root. The
shared runtime layout keeps the minimum 16-texture profile by omitting unused
transmission maps and the backdrop when transmission is unavailable. Standard
backdrop sampling reuses the IBL prefilter sampler, retaining the 16-sampler
ceiling. Dedicated transmission and extended-lighting topologies require 21 and 25
sampled textures respectively; device creation requests the admitted topology.
Below 21, transmission uses the shared-slot variant described in
[Standard sampled-texture budget](#standard-sampled-texture-budget).

The scalar-map GPU regression runs in both Dawn and Chromium. It reads Surface
outputs before lighting, captures each draw with RHI Debug, checks seeded texture
bindings, and compares fresh-device replay pixels with live readback. Dawn saves
its twelve tapes and work/event/digest receipts under
`artifacts/standard-independent-maps/`. These focused probes supplement the
full Browser, Dawn and 60-frame hello/learn smoke gates.

### Single-layer medium Surface

`MaterialAsset.surface` selects the Engine template and one imported Surface
implementation. A Standard Surface imports
`forgeax_material::surface_v1::{SurfaceInput, SurfaceData}` and exports
`evaluate_surface(SurfaceInput) -> SurfaceData`. A
`model: 'single-layer-medium'` Surface instead imports
`forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput,
SingleLayerMediumSurfaceData}` and exports that separate input/data ABI. The
Surface returns normal, roughness, coverage, foam, absorption, scattering, IOR,
and phase facts; Render performs the finite Beer-Lambert/single-scatter
integral, one Fresnel allocation, and consumes renderer-owned paired
color/depth frame facts. `maxDistanceMeters` is a finite authored upper bound
in metres for the sky-miss case. A valid value is carried through the Surface
ABI and Cook output, while invalid or absent input uses the conservative Engine
bound; it never turns an unavailable depth producer into a synthetic sample.
The Surface does not declare a stage, binding, attachment, BRDF, or vertex
displacement.

```ts
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok, type MaterialAsset } from '@forgeax/engine/types';

const packageId = definePackageId('01900000-0000-7000-8000-000000000001');

const material = {
  kind: 'material',
  surface: {
    model: 'single-layer-medium',
    module: 'game::water_surface_a',
    dynamicInput: {
      name: 'waterEvents',
      fields: [
        { name: 'position', type: 'vec3<f32>' },
        { name: 'time', type: 'f32' },
        { name: 'eventId', type: 'u32' },
      ],
      maxRecords: 64,
      maxDomains: 8,
      maxPageBytes: 2048,
      maxBindings: 1,
      maxEventsPerSample: 8,
    },
  },
  passes: [{ name: 'color', program: { module: 'forgeax::single-layer-medium' } }],
  parameters: [
    { name: 'coverage', type: 'f32' },
    { name: 'absorption', type: 'vec3' },
  ],
  values: { coverage: 0.85, absorption: [0.22, 0.07, 0.025] },
} satisfies MaterialAsset;

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  name: 'Water',
  build: () => ok({ 'material/water': material }),
});
```

The authored module reads that schema through the compiler-generated accessor;
parameter names are fields on `material`, not free uniforms or string lookups:

```wgsl
#define_import_path game::water_surface_a
#import forgeax_material::parameters::{material}
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}

fn evaluate_surface(input: SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  return SingleLayerMediumSurfaceData(
    normalize(input.geometricNormalWS),
    0.16,
    material.coverage,
    0.0,
    material.absorption,
    vec3<f32>(0.018, 0.04, 0.085),
    1.333,
    0.24,
    900.0,
  );
}
```

Cook validates this accessor against `parameters`, the Pack transport writes
the cooked material through JSON while preserving its GUID, and runtime loads
that GUID before allocating the `MaterialAsset` handle used by `MeshRenderer`.
The executable [LightProbe to ProbeBlend to Surface example](#lightprobe-to-probeblend-to-surface-example)
shows the `assets.load(guid, 'material')` → World → `MeshRenderer` → `draw` half of
the same route.

The generated dynamic page is a bounded, read-only storage record. Create one
`ReadonlyDynamicInputPage`, write only changed records, then reserve an explicit
`{ domain, recordStart, recordCount, instanceIndex, member }` range for each draw.
`member` is the stable public address
`{ worldIdentity: world.identity, entityKey, drawItemIndex, instanceOrdinal }`.
Its
`contentRevision`, `bufferGeneration`, and `deviceGeneration` are separate
facts; stale ranges and consumption before an upload return a structured error.
The page uses the existing instance bind group's free binding and never uses
skinning's `customDataStart`. Publish the page to the existing Renderer owner
before drawing:
`renderer.setSurfaceDynamicInput({ page, ranges, projectionRevision, frameTime })`.
Advance `projectionRevision` only when range membership or addresses change;
record values and World time keep the current revision so stable frames reuse
the retained validation and consumption projection.
Range order is irrelevant: Render joins each range to the admitted candidate by
`member` and rejects missing, duplicate, or non-admitted identities.

#### Sea sun and sky

A Surface only defines material properties; it receives no sun, sky or camera data
(`SurfaceInput` has no `light`). Sun glint, sky reflection and fog belong to the material
model. The stock `model: 'single-layer-medium'` water adds the main `DirectionalLight`
glint (Three.js `Water` specular, widened by the wave-normal footprint), reflects a
`GradientSky` along the reflection direction when one is present (else the Skylight
cubemap), and fogs its own light. The sky law rides the View atmosphere lanes
(`gradientSkyColor` in `forgeax_view::common`), which are unused while no Atmosphere is
active, so the View layout does not change.

#### Visible surface observation

Visible-surface demand uses the same submit-fenced scene history as temporal
camera effects. Instance replacement and material edits invalidate motion;
instance storage retains both current and previous revisions so stopping
settles velocity on the following accepted frame. Device recovery uses the
active profile to select the same material ABI as normal preparation.

`StandardProfile.visibleSurface: true` enables the deferred rigid-surface
attachment. The device must expose `primitive-index`, seven color attachments and
48 aligned attachment bytes/sample; this path is single-sample. It preserves
the ordinary color output and uses the same authored Standard material coverage.
The four unsigned words are a frame-local row, draw-local primitive, packed
geometric normal and coverage/front-face flags. Shading normals stay in the
existing packed G-buffer and motion stays with the shared temporal producer.
Skinned, morphed and LOD draws publish no rows yet: they write row 0 (uncovered)
and the projection skips their slots instead of failing the frame.

GPU-driven rigid draws keep transforms in the shared GPU Scene tables. An
optional view-owned `u32` table maps each candidate to its submitted receiver
row at group 3 binding 7; buffer replacement reseeds both topology and rows.
Disabling visible surfaces removes this allocation. Color and shadow vertices
share the visible stream at binding 2, leaving ProbeBlend binding 1
fragment-only so the complete skin layout fits the portable storage limit.

Arm `renderer.requestObservation(['visible-surface'])` before `draw`, then read
`renderer.observe(receipt, { include: ['visible-surface'] })` after completion.
The returned observation includes padded `rgba32uint` bytes and detached
`records`; `resolveVisibleSurface(observation, row, primitive)` resolves the
matching entity, instance generation, material and source element range. A row
is only meaningful with its own observation, never with the current scene.
`row === 0` is uncovered; the primitive starts at zero for each draw, including
nonzero source ranges. Background and MASK-discarded fragments remain invalid.

At most four unread frame observations are admitted. Read their receipts before
arming more; reads consume the captured copy once. Resize and later scene edits
do not reinterpret earlier copies. Armed receipts expose `observationDomains`,
the domains actually captured by that submission. A preparation barrier can
report an empty list; a pending partial frame can contain fewer domains than
requested. Retry drivers consume these actual pending captures before retrying,
while the ready receipt still requires the caller's complete requested domains.
Device loss, replacement and disposal reject old
receipts, including an observation whose asynchronous read crosses retirement. With no observation request there is no readback allocation, map or
copy; turning off the profile removes the extra attachment and temporal demand.
Current qualification is rigid base-LOD Standard geometry with unchunked
instances and local World leases. Skin/morph/LOD, storage-split instances,
shared publications and reflection-fallback combinations remain unqualified.

#### Linear HDR optical oracle

The physical oracle observes the real Pack → GUID → World → medium nearest/color
path before exposure, tone mapping, and anti-aliasing. Arm the next successful
submit with `renderer.requestObservation(['linear-hdr'])`, keep its `FrameReceipt`,
then call `renderer.observe(receipt, { include: ['linear-hdr'] })`. The returned
bytes are padded-row `rgba16float`; `frameId`, device and graph generations,
texture identity, and readback identity bind them to that exact completed frame.
When no observation is requested, the renderer does not copy, map, or synchronously
read this attachment.

> [!IMPORTANT]
> Compare optical math in this linear attachment. A canvas screenshot is an
> exposed, tone-mapped, anti-aliased presentation artifact and cannot prove the
> Beer-Lambert, scatter, or Fresnel contract.

The permanent fixture loads authored water through the Preview Pack, freezes the
camera, medium parameters, paired background, light, event time, and fixed ROI,
then compares the observed half-floats with an independent double-precision
screen-space reference. Its evidence also carries the actual nearest/color
program and resource generations plus the completed submission receipt.

Author 4x coverage through the Camera component. ECS fields retain their numeric
schema representation; `ANTIALIAS_MSAA` extracts to the public closed
`antialias: 'msaa'` render fact:

```ts
import { ANTIALIAS_MSAA, Camera, orthographic } from '@forgeax/engine/render';

world.spawn({
  component: Camera,
  data: {
    ...orthographic({ left: -3, right: 3, bottom: -2, top: 2 }),
    antialias: ANTIALIAS_MSAA,
  },
});
```

The edge oracle independently projects the authored rod, wall, shoreline, and
rough-water rectangles onto the canonical four sample positions. Fully covered
control regions calibrate each authored linear-HDR endpoint. For opaque edges,
the nearest depth sample selects its matching color before the full-coverage
water pass. For partial water coverage, the final hardware resolve averages the
independently predicted covered samples. The oracle rejects the opposite policy,
checks a small moving-camera interval, repeats after an 800-by-450 backing resize,
and keeps the physical maximum per-channel error at `0.05`. Its pure four-sample
counterexample separately proves why averaging color and then choosing the
nearest depth loses the color/depth pair.

```sh
FORGEAX_SURFACE_LANE_PARITY=1 pnpm exec vitest run --project=dawn --retry=0 \
  --maxWorkers=1 --no-file-parallelism \
  packages/runtime/src/__tests__/surface-standard-pipeline.dawn.test.ts

FORGEAX_SURFACE_LANE_PARITY=1 pnpm exec vitest run \
  --config vitest.browser.config.ts --project=browser --retry=0 \
  --maxWorkers=1 --no-file-parallelism \
  packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts

FORGEAX_SURFACE_MSAA4X=1 FORGEAX_SURFACE_LANE_PARITY=1 \
  pnpm exec vitest run --project=dawn --retry=0 --maxWorkers=1 \
  --no-file-parallelism \
  packages/runtime/src/__tests__/surface-standard-pipeline.dawn.test.ts

VITE_FORGEAX_SURFACE_MSAA4X=1 FORGEAX_SURFACE_LANE_PARITY=1 \
  pnpm exec vitest run --project=browser --retry=0 --maxWorkers=1 \
  --no-file-parallelism \
  packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts

# Public App lifecycle: World-time water events plus a cooked GPU splash.
VITE_FORGEAX_SURFACE_APP_LIFECYCLE_ONLY=1 pnpm exec vitest run --project=browser \
  --retry=0 --maxWorkers=1 --no-file-parallelism \
  packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts
```

The Dawn Surface gate also compares every output pixel between Forward and
Deferred, then toggles SH irradiance on base and Physical materials to reject a
shared missing-lighting implementation. Native WebGPU validation errors fail
the gate. Set `FORGEAX_SURFACE_RHI_CAPTURE_DIR=artifacts/surface-rhi` on the same
command to retain each paired `.rhitape` and its original `live.rgba8`. The
recorder follows device loss before recovery, so captures never mix generations.

The lifecycle gate enqueues two deduplicated impacts into one attached World.
Its Update system takes one `Time.elapsed` snapshot, stamps both Surface records,
and starts the matching `ParticleEffectPlayer` edges. The splash is the authored
`surface-water-splash.pack.json` asset: the Pack transport resolves its GUID,
`loadVfxGpuEffect` loads its cooked program, and `createVfxRuntimeHost` contributes
the production renderer feature. The gate rejects an effect without a renderer;
an intent-only program is not visible evidence.

Before each target submit, the gate arms the existing `linear-hdr` observation.
It reads pre-frozen 16-by-16 water-A, water-B, and above-water splash ROIs from
that completed receipt, and compares every pixel. The mask never depends on
brightness, medians, or observed error. Evidence carries the frame, device,
graph, texture, and readback identities. The active splash ROI must change and
return to its baseline after the effect expires; the VFX host must also retire
both players. `rgba16float` samples remain unclamped linear values, including
values above 1, and use the same maximum per-channel error of `0.05` at every
lifecycle stage. The oracle does not round them through an 8-bit domain.

A real wait while paused preserves World time, committed VFX state, receipt
count, and the exact active completed image: `paused` reuses the active receipt
and does not submit a zero-delta frame. `resume()` continues from retained World
time without adding the paused host interval or replaying either splash. The
later `stepFrame(0.05)` calls are explicit deterministic simulation steps used
to reach camera coverage and expiry; they advance World time and therefore are
not evidence that a paused App remains frozen. In Dawn only, a timer supplies
the missing host scheduling primitive; the same App remains the sole owner of
World update and Renderer draw.

### LightProbe to ProbeBlend to Surface example

The following scene uses one authored water material for two entities. Each
entity selects a different local `LightProbe` domain, while both consume the
same bounded dynamic-input page. The renderer derives `ProbeBlendRecord`, slot,
generation, and the direct or scene-index consumer lane from the attached
World; application code does not build a second probe table.

`drawProbeLitWater` receives an already-constructed Runtime `Renderer`.
Construct it at the Runtime boundary with `await createRenderer(canvas)`, check
the returned `Result` (`if (!result.ok) throw result.error`), and pass
`result.value` to this helper. Runtime completes renderer initialization before
returning that value, so the render helper does not own a second initialization
promise.

```ts
import { Time, World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  LightProbe,
  MeshFilter,
  MeshRenderer,
  ReadonlyDynamicInputPage,
  type Renderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { type AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetGuid, MaterialAsset } from '@forgeax/engine-types';

export async function drawProbeLitWater(
  renderer: Renderer,
  assets: AssetRegistry,
  waterGuid: AssetGuid,
) {
  // The Pack producer cooks the authored MaterialAsset and its Surface module;
  // runtime consumers load only the GUID-addressed publication.
  const loaded = await assets.load(waterGuid, 'material');
  if (!loaded.ok) throw loaded.error;
  const material = loaded.value;
  const water = assets.read(material).unwrap();
  const dynamicInput = water.surface?.dynamicInput;
  if (water.surface?.model !== 'single-layer-medium' || dynamicInput === undefined) {
    throw new Error('expected an authored single-layer-medium Surface');
  }

  const world = new World({ assets });
  const plane = createPlaneGeometry(1.8, 1.8).unwrap();
  const mesh = assets.create(plane).unwrap();
  const waterEntities = [-1.2, 1.2].map((x) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap(),
  );

  const red = new Float32Array(27);
  red[0] = 1.8;
  const blue = new Float32Array(27);
  blue[2] = 1.8;
  world.spawn(
    { component: Transform, data: { pos: [-1.2, 0, 0] } },
    { component: LightProbe, data: { irradiance: red, radius: 1 } },
  );
  world.spawn(
    { component: Transform, data: { pos: [1.2, 0, 0] } },
    { component: LightProbe, data: { irradiance: blue, radius: 1 } },
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 6] } },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 20 },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1 },
  });

  const page = ReadonlyDynamicInputPage.create({
    sourceId: 'water-events',
    pageId: 1,
    schema: dynamicInput,
  }).unwrap();
  const eventLifetimeSeconds = 0.45;
  const events = [
    { position: [-1.2, 0, 0] as const, time: 0, eventId: 1 },
    { position: [1.2, 0, 0] as const, time: 0, eventId: 2 },
  ] as const;
  let publishedEventCount = 0;
  let projectionRevision = 1;
  let publishedDeviceGeneration = renderer.inspect().frame.deviceGeneration;
  page.reconfigureDevice(publishedDeviceGeneration).unwrap();

  const reserveFreshRanges = () =>
    waterEntities.map((entityKey, index) =>
      page
        .reserveRange({
          domain: index === 0 ? 'water-left' : 'water-right',
          recordStart: index,
          recordCount: 1,
          instanceIndex: index,
          member: {
            worldIdentity: world.identity,
            entityKey,
            drawItemIndex: 0,
            instanceOrdinal: 0,
          },
        })
        .unwrap(),
    );
  let ranges = reserveFreshRanges();
  let deviceLost = renderer.state() === 'device-lost';

  const publishDynamicInput = (now: number): void => {
    const activeEvents = events.filter(
      (event) => now >= event.time && now - event.time < eventLifetimeSeconds,
    );
    const recordsToRewrite = Math.max(publishedEventCount, activeEvents.length);
    for (let index = 0; index < recordsToRewrite; index += 1) {
      page
        .writeRecord(
          index,
          activeEvents[index] ?? { position: [0, 0, 0], time: -1_000, eventId: 0 },
        )
        .unwrap();
    }
    publishedEventCount = activeEvents.length;
    renderer.setSurfaceDynamicInput({ page, ranges, projectionRevision, frameTime: now });
  };

  const recoverAndRepublish = async (): Promise<number> => {
    if (renderer.state() !== 'device-lost') {
      throw new Error('water recovery requires the Renderer device-lost state');
    }
    const recovered = await renderer.recover();
    if (!recovered.ok) throw recovered.error;
    const nextDeviceGeneration = renderer.inspect().frame.deviceGeneration;
    if (nextDeviceGeneration <= publishedDeviceGeneration) {
      throw new Error('water recovery did not publish a new device generation');
    }
    const previousRanges = ranges;
    page.reconfigureDevice(nextDeviceGeneration).unwrap();
    ranges = reserveFreshRanges();
    if (
      ranges.some(
        (range, index) =>
          range === previousRanges[index] ||
          range.deviceGeneration !== nextDeviceGeneration ||
          range.bufferGeneration === previousRanges[index]?.bufferGeneration,
      )
    ) {
      throw new Error('water recovery reused a pre-recovery dynamic range');
    }
    publishedDeviceGeneration = nextDeviceGeneration;
    projectionRevision += 1;
    publishDynamicInput(world.getResource(Time).elapsed);
    deviceLost = false;
    return nextDeviceGeneration;
  };

  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'state-changed' && event.current === 'device-lost') {
      deviceLost = true;
    }
  });
  try {
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const attached = attachment.value;
    publishDynamicInput(world.getResource(Time).elapsed);
    world.update(1 / 60).unwrap();
    const submitAndObserve = async () => {
      // The Renderer keeps this logical World lease valid across recovery;
      // retry the same lease after the page and ranges are revalidated.
      const submitted = renderer.draw({
        leases: [attached],
        camera: { lease: attached },
        environment: { lease: attached },
      });
      if (!submitted.ok) throw submitted.error;
      const completed = await submitted.value.completed;
      if (!completed.ok) throw completed.error;
      const observed = await renderer.observe(submitted.value, { include: ['draws'] });
      if (!observed.ok) throw observed.error;
      return submitted.value;
    };

    let submitted: Awaited<ReturnType<typeof submitAndObserve>>;
    try {
      submitted = await submitAndObserve();
    } catch (cause) {
      // A first frame can fail before it yields a receipt. Recover only when
      // the public lifecycle reports the actual device-lost state.
      if (renderer.state() !== 'device-lost') throw cause;
      await recoverAndRepublish();
      submitted = await submitAndObserve();
    }
    if (deviceLost || renderer.state() === 'device-lost') {
      await recoverAndRepublish();
      submitted = await submitAndObserve();
    }
    const inspection = renderer.inspect();
    if (submitted.deviceGeneration !== publishedDeviceGeneration) {
      throw new Error('water draw receipt does not match the published device generation');
    }
    return {
      world,
      attached,
      page,
      receipt: submitted,
      submission: inspection.renderScene.submission,
      deviceGeneration: inspection.frame.deviceGeneration,
    };
  } finally {
    unsubscribe();
  }
}
```

The repository exercises this route through real Pack/GUID publication and a
physical texture or compositor readback:

```bash
pnpm exec vitest run --project=dawn \
  packages/runtime/src/__tests__/surface-standard-pipeline.dawn.test.ts --retry=0
pnpm exec vitest run --config vitest.browser.config.ts --project=browser \
  packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts --retry=0

# Same material, scene, time, events, ProbeBlend domains, exposure, and ROI;
# cold direct -> GPU -> direct. The original 0.05 RGB oracle remains active.
FORGEAX_SURFACE_LANE_PARITY=1 FORGEAX_DAWN_LIGHTWEIGHT=1 \
  pnpm exec vitest run --project=dawn \
  packages/runtime/src/__tests__/surface-standard-pipeline.dawn.test.ts --retry=0
```

Direct medium draws use a dedicated group(3): ordinary instance transforms,
the retained ProbeBlend record, dynamic page, per-member frame rows, shared
frame time, and a producer-owned per-draw frame-base uniform. The vertex shader
addresses `frameBase + instance_index`; neither GUID order nor a scene-index
visible slot is used to infer that address. Missing member identity, page,
generation, or frame-base publication fails the draw through the structured
Render error path.

After a successful submission, `renderer.inspect().renderScene.gpuDriven.surfaceArtifact`
exposes the selected direct/scene-index entries and artifact/resource
generation. `renderer.inspect().renderScene.submission` separates
`requestedLane` from the command-derived `actualLane` and publishes only
nearest/color passes that encoded a real `draw*` or `draw*Indirect` command.
When the current forward Standard frame carries the reflection fallback MRT, the same
submission projection reports `actualLane: 'direct'` with
`actualLaneReason: 'reflection-fallback-mrt'`. Deferred writes that fallback in its
lighting pass, so its G-buffer keeps the GPU-driven lane. This is a pass-ownership
constraint, not a device-capability result; the reason is absent again when a
later frame resumes the ordinary GPU-driven lane.
Direct rows contain the actual command range (`firstInstance` remains `0`),
the producer's separate `surfaceFrameBase`, and the member identities bound by
that command. Every command reports the exact selected artifact's
`receiptIdentity`/`receiptGeneration`; `programEvidence: 'missing'` means the
recorder could not prove that producer identity. Indirect rows contain the
actual indirect buffer identity and byte offset. `status: 'completed'` is published only after the existing queue
completion fence resolves for the same device generation.

GPU member identity is opt-in because it requires readback. Call
`await renderer.observe(frameReceipt, { include: ['draws'] })` before reading
the inspection row. Until that call, an indirect pass reports
`memberEvidence: 'indirect-readback-required'` and omits members. The observe
path reuses the selector telemetry copy, reads its actual visible rows, and
then reports `indirect-visible-readback`. The readback carries its recording
sequence, frame/device/resource/view identity, and per-pass indirect ranges;
an older or reordered shared-buffer result is rejected even within one device
generation. Nearest and color share the same
visible member set because both consume the same submitted selector/indirect
projection; each pass still has its own encoded command receipt. CPU candidate
lists are never substituted for this GPU readback. The lane-parity gates pair
these command facts with completed fixed-ROI pixels at the unchanged `0.05`
RGB epsilon.

The public consumer sequence is `draw` -> `observe` -> `inspect`:

```ts
import type { SurfaceGpuIndirectParameters } from '@forgeax/engine/render';

const receipt = renderer.draw(frameInput);
if (!receipt.ok) throw receipt.error;
const observed = await renderer.observe(receipt.value, { include: ['draws'] });
if (!observed.ok) throw observed.error;
const inspection = renderer.inspect();
const completePasses = (inspection.renderScene.submission?.passes ?? []).filter(
  (pass) => pass.memberEvidence === 'indirect-visible-readback',
);
const indirectParameters: readonly SurfaceGpuIndirectParameters[] = completePasses.flatMap(
  (pass) => {
    if (pass.indirectParameters === undefined) throw new Error('complete GPU readback is missing');
    return pass.indirectParameters;
  },
);
void indirectParameters;
```

`pass.indirectParameters` appears only after the requested observation resolves
and the renderer accepts a complete matching GPU readback. A pass before
readback, with no complete identity match, reports
`memberEvidence: 'indirect-readback-required'` and has no parameters. A valid
readback whose bounded command sample is truncated reports
`memberEvidence: 'indirect-visible-readback-truncated'` and also has no
parameters; its saved and dropped counts remain diagnostic facts. GPU-byte
truncation, a stale/reordered copy, or an identity mismatch is rejected and
leaves the pass in `indirect-readback-required`. Only a complete valid copy
reports `memberEvidence: 'indirect-visible-readback'` with parameters. These
states are diagnostic facts and never proof when the required evidence is
absent. Each record is bound to the same
`sequence`, `frameId`, `deviceGeneration`, `resourceGeneration`, `viewIdentity`,
and Surface `pass` as the published submission, plus the exact indirect
`indirectBufferIdentity` and `indirectOffset`. For indexed commands, `count`,
`first`, `instanceCount`, signed `baseVertex`, and `firstInstance` decode the
five WebGPU indirect words. For non-indexed commands, `count`, `first`,
`instanceCount`, and `firstInstance` decode the four words and `baseVertex` is
zero by definition.

Each pass exposes `totalCommandCount`, bounded `savedCommandCount`,
`droppedCommandCount`, and `truncated`. A truncated indirect row is diagnostic
evidence, never a complete member set; a valid readback labels it
`indirect-visible-readback-truncated` and omits `indirectParameters`. A direct
row uses `direct-command-members-truncated` for the same bounded-sample limit.

The Render owner validates the cooked layout, source/page identity, generation,
range bounds, and device storage limit. It begins a detached upload and commits
the page revision only after every queue write succeeds; graph submission then
consumes the validated ranges. The same input is carried through GPU
preparation. In the scene-index lane, the renderer
maps each GPU-written visible member's stable candidate row to a frame row and
keeps each producer `instanceIndex` in the row; the atomic compact draw slot is
never used as a dynamic-input address.

On a device with compute, storage-buffer, and indirect-drawing capabilities,
GPU-driven preparation records the published Surface submission and binds the
Surface page and frame records through the existing GPU-driven instance owner.
The Standard Forward and Deferred graph owners allocate the two
`nearest-layer`/`color` targets and share the transmission backdrop producer.
The backdrop is the paired opaque color input. At 1x, both Standard paths copy
the completed depth into an `r32float` sampled target. At 4x MSAA, Render does
not use the hardware-averaged color resolve as the medium backdrop. A typed
fullscreen producer examines all four depth samples, selects the nearest
sample, and publishes both that depth and the color at the same sample index.
The nearest-water pass uses 4x color and depth attachments and the identical
paired rule before the color pass consumes it. Both resolved depth facts are
`r32float` with an unfilterable-float/non-filtering binding, so the color pass
never samples a depth attachment while writing scene depth. Inputs other than
the admitted 1x or paired 4x forms fail with `resource-descriptor-invalid`;
`addSingleLayerMediumPasses` never creates a synthetic depth value. This policy
is a nearest-sample coverage resolve, not an average of already-resolved color.
The color pass binds the copied depth, the preceding nearest-layer color/depth
pair, and the shared backdrop through the existing material bind-group owner.
GPU-driven recording reuses the existing Standard raster
dispatch with a Surface-family filter; devices without the required
capability use the existing CPU record lane and its structured admission
reason. These tests prove the owner boundary and fail-closed behavior;
Browser, Dawn, and physical GPU frame evidence remain separate gates. A
missing Surface ABI, pass, resource, or prepared generation is a
producer/preparation error. The public paired math and two example Surface
modules live in
[`src/examples/single-layer-medium-surface.ts`](src/examples/single-layer-medium-surface.ts).

The public route is one `RenderFeature<FrameData>` through the Standard
Pipeline and the active RenderGraph pass. In the examples below, `type FrameData`
is the producer-owned extracted value. A feature extracts one frame value,
then its mandatory `plan(data, context)` declares named resources and passes;
the host derives graph access, preparation, recording, and recovery from that
plan. Register it at construction with
`createRenderer(canvas, { features: [feature] })`. A feature never receives a
device, queue, encoder, staging builder, or submit callback.

One Renderer owns one feature host and one instance of each installed feature.
`extract` and `plan` run once per outer frame with the complete `context.views`
roster. Each view has a stable `identity` and `render` flag; a held low-frequency
view remains in the roster with `render: false`. Single-camera rendering uses the
same path with one view.

`RenderFeaturePlan.work` separates shared work from camera-dependent work:

| Scope | Resources and commands | Lifetime |
|:--|:--|:--|
| `'frame'` | Simulation, shared deformation, formation caches and reusable source buffers | One Renderer feature generation |
| `{ view: identity }` | Projection, sorting, view bindings and raster/post-processing | That view's feature resources and history |
| Full roster | Held views retain accepted pictures and histories; shared simulation continues | Renderer frame transaction |

A work scope owns its resource names. View work may read frame resources;
view-local resources cannot shadow frame resources. Different views may use the
same local name because their physical resources have distinct scope identities.
Each view receives its own logical targets and semantic scene-data catalog.
Shared declarations do not repeat simulation when another camera is added.

Frame work explicitly declares `scene-depth` with its simulation camera or
`scene-noise` when those inputs are needed. The Renderer allocates them lazily;
scene depth uses the ordinary typed scene-capture graph at the root render extent,
including objects outside every display camera. Capture completes before shared
simulation and every updating view in the same encoder. Held display views do not
pause simulation inputs. View graphs import those same resources, while each view
retains its own color, depth and temporal history. Resource replacement is committed
only after the outer queue submission; preparation, submission and device-recovery
failures cannot publish an incomplete input or acknowledge unrecorded simulation.

Prepared resources are an outer-frame transaction. A changed descriptor or
borrowed resource creates a candidate reference under the same logical name;
successful queue submission publishes it and retires the preceding allocation
after the completion fence. Failure discards candidate allocations and restores
the accepted resource indexes. Held graphics retain their shared buffer
dependencies. Replacing one view's resources invalidates that view's graph,
without resetting another view or shared simulation.

```mermaid
flowchart LR
  E["Extract complete view roster"]
  P["Plan shared and view work once"]
  D["Capture declared simulation scene inputs"]
  S["Record shared work"]
  V["Record each updating view"]
  C["Composite and submit once"]
  A["Commit histories and acknowledge source once"]
  E --> P
  P --> D
  D --> S
  S --> V
  V --> C
  C --> A
```

After successful outer submission, `onFrameSubmitted(data, receipt)` runs once.
`receipt.works` identifies each admitted scope and its named compute/raster
passes after prepared-resource resolution. Source-owned intent acknowledgment
runs once for accepted shared frame work. A record, finish or submit failure
aborts the entire feature transaction; it consumes no source intents and
commits no candidate view histories. Submission confirms admitted commands;
GPU pixels and indirect instance counts still require readback or RHI Debug.

`BarrelDistortion` is supplied by the ordinary ordered RenderFeature host. A
missing or zero-strength component produces no allocation, upload, or pass;
the feature still declares its shader for production validation. A positive
component adds one fullscreen pass after linear-LDR LUT output and before FXAA
and final encoding. There is no separate built-in registration path, so feature
ordering and retirement use the same graph and in-flight lifetime rules as
other post-process features.

Compute program compilation is reused by exact WGSL, entry points, and binding
layout within one device/feature generation, with at most 64 retained programs.
Playback names keep independent references and buffers. Descriptor changes
still validate, and recovery compiles against the new device session.

## RenderFeature: the producer seam (first-read index)

The public route is one `RenderFeature<FrameData>` through the active RenderGraph
and `Standard Pipeline`. Here `type FrameData` is the
producer-owned extracted value; `plan(data, context)` declares named resources and passes.
Register it with
`createRenderer(canvas, { features: [feature] })`. The renderer derives graph
access, preparation, recording, and recovery; the feature never receives a
device, queue, encoder, or submit callback. Each declaration becomes a
`RenderGraph pass` inside the active frame submit boundary.

### Material contract projection

Render consumes only the Pack-owned material publication projection. Its
inputs are runtime bool/value data, composed module slots, and the closed
compiler context; render never authors, cooks, writes DDC, or selects a
fallback material. The projection preserves `layoutIdentity`,
`programIdentity`, `cookIdentity`, and `materialPublicationIdentity` so a
stale draw can be traced to the first producer divergence.

### Directional shadow quality: author → inspect → recover

Set `DirectionalLight.castShadow: true` to enable the following shadow path.
The bare light defaults off; `game-3d` explicitly enables its sun.

`DirectionalLight` is the only authoring entry for directional shadow quality.
Set `shadowFilter` with the numeric constant for one of the six closed labels
below; it is an ECS enum field, not a label string. Do not invent a numeric
label or a compatibility alias. The default is `pcfVogel` (five rotated Vogel comparison samples, as in Three r184). The two PCSS fields
are read only when `shadowFilter` is `pcssMedium` or `pcssHigh`:

```ts
import { DirectionalLight, DirectionalShadowFilterValue } from '@forgeax/engine-render';

world.spawn({ component: DirectionalLight, data: {
  direction: [0.2, -0.98, 0],
  shadowFilter: DirectionalShadowFilterValue.pcssHigh,
  shadowAngularRadius: 0.00465,
  maxPenumbraTexels: 32,
} });
```

| Author field | Valid values / units | Default | Effective meaning |
|:--|:--|:--|:--|
| `shadowFilter` | `pcfVogel`, `pcf1`, `pcf3`, `pcf5`, `pcssMedium`, `pcssHigh` | `pcfVogel` | Requested directional filter profile |
| `shadowAngularRadius` | Radians, finite range `[0.0001, 0.05]` | `0.00465` | PCSS light angular radius |
| `maxPenumbraTexels` | Texels, finite integer range `[1, 64]` | `32` | PCSS penumbra ceiling |

The remaining CSM fields keep these public units and defaults: `cascadeCount`
is an integer in `[1, 4]` (default `3`), `splitLambda` is `[0, 1]` (default
`0.5`), `cascadeBlend` is `[0, 0.5]` (default `0.2`), `mapSize` is a positive
map resolution (default `2048`), `depthBias` is a depth value (default
`0.00001`, applied toward the light in normalized receiver depth), `normalBias` offsets the
surface receiver position along its world-space normal before projection (default `0.05`), and
`shadowDistance` is a positive world-unit cap (default `200`); coverage ends at
`min(camera.far, shadowDistance)`. Camera far still defaults to `2000`, so distant
visibility does not implicitly spread the default shadow maps across that whole
range. Set `shadowDistance` explicitly when a scene needs shorter or longer
coverage. A world unit represents a meter only when the scene uses that scale.
This coverage rule matches Three.js CSM, while the default cap intentionally
prioritizes nearby detail over Three.js's `maxFar: 100000`.
CSM defaults to three cascades and practical split lambda `0.5`. Cascade blend `0.2`,
receiver-plane depth correction and geometric-normal bias remain intentional stability features.
At a fixed camera range and map size, reducing split lambda gives the near cascade
more world-space coverage and larger texels. Centimeter-scale filter regressions
pin their original cascade distribution to keep that sampling footprint constant.

Normal offset and depth bias are independent: increasing the CSM depth span must
not magnify the world-space normal offset. Both PCF and PCSS project the offset
receiver; volumetric samples have no surface normal and use only depth bias.
Surface receivers get a per-cascade depth correction derived from a shadow
texel's world size and the raster triangle's slope along the light's image axes.
For integer PCF, the receiver bound covers the actual bilinear phase; Vogel
keeps a one-texel bound. Wider kernels compare each tap against the receiver
plane at that tap's offset;
scaling the common receiver bias by the full kernel radius erases close caster
shadows. Existing caster raster bias and authored state remain unchanged.
PCSS compares each raw and filtered tap at its exact texel-center plane depth,
and removes that plane offset before averaging blocker depths. Degenerate
grazing receivers retain the bounded radius-based bias.

These are finite raster approximations. A local plane does not reconstruct
arbitrary neighboring curvature or height changes. Real curved and continuous
fold controls retain failures at the original 2/255 threshold, including the
default PCF3 profile. An attempted full-radius receiver bound with added caster
slope improved some self-shadow controls but failed existing 8 cm/20 degree
near-caster and centimeter contact gates; that product experiment was withdrawn.
The reports and captures preserve both outcomes. This foundation provides the
Standard shadow path but does not establish complete curved-terrain shadow quality.
Cascade projections include their incoming blend band, and PCSS depth spans
match the actual projection, including toward-light caster reach. The normal
position offset follows the approach in
[Three.js shadowmap_vertex](https://github.com/mrdoob/three.js/blob/e45cbf7ff66df079cfa39d9699ccb42729934be1/src/renderers/shaders/ShaderChunk/shadowmap_vertex.glsl.js).
The real-render regression is
[`shadow-contact.fixture.ts`](../runtime/src/__tests__/shadow-contact.fixture.ts);
[`shadow-receiver-plane.dawn.test.ts`](../runtime/src/__tests__/shadow-receiver-plane.dawn.test.ts)
keeps PCF5 contact shadows in coarse cascades.

#### Terrain directional PCF families

> [!WARNING]
> The candidate Terrain repair is implemented but its real GPU, picture and performance acceptance is pending. The curved/folded failure evidence above remains authoritative until those same gates pass.

A Terrain root is a finite opaque height surface without holes or boundary walls. Its ordinary shadow pass admits both faces. Directional PCF receivers whose original outward triangle faces the light use a separate cascade family containing that root's back faces and every other ordinary caster; all other receivers and PCSS use the ordinary family. Forward chooses from unquantized primitive Ng. Deferred makes the same choice in its GBuffer writer and carries the physical layer base in the receiver-geometry high eight bits; the low 24-bit normal remains available for bias.

The typed graph derives families from World plus entity identity, including different entities reusing one asset, before view culling. For C cascades and R roots it admits C(1+R) layers against the device and eight-bit carrier limits. Changing roots, cascades or map resolution prevents a failed candidate from falling back to an incompatible accepted graph. Root families copy the complete current GPU-only static layer and then add the role-specific dynamic, CPU and feature casters; their scheduling follows that static producer on abort/retry. They never copy the composed ordinary depth or retain only partial dirty rectangles.

The detailed proof, finite-edge semantics, cost estimate and required falsifiers are in [the repair contract](../terrain/docs/material-id/terrain-self-shadow.md). The Standard WGSL helper `evalDirectionalShadowFactor(normal, worldPos, viewZ, layerBase)` requires the physical base; ordinary custom receivers pass `0u`. Root-family routing remains renderer-owned rather than an author-controlled material option.

#### Screen-space contact shadows

Cascade texels are centimeters to decimeters wide, so they cannot resolve the
occlusion where small geometry (grass blades, pebbles, feet) meets a surface.
`contactShadowLength` adds a short screen-space ray march toward the sun that
recovers this detail:

```ts
world.spawn({ component: DirectionalLight, data: {
  direction: [0.3, -0.6, 0.2],
  contactShadowLength: 0.25, // meters; 0 (default) disables the march
} });
```

| Author field | Valid values / units | Default | Effective meaning |
|:--|:--|:--|:--|
| `contactShadowLength` | Meters, finite `>= 0` | `0` | World length of the depth-buffer march toward the light |

- It runs inline in the Deferred Standard lighting pass. It adds no pass,
  render target, bind group or pipeline, and the frame topology is identical
  with the field on or off. The value travels in the View UBO lane
  `directionalShadowFilter.w`; `0` takes a uniform early-out.
- The Forward path ignores the field. Select `renderPath: 'deferred'` to use
  contact shadows.
- It is independent of `castShadow`. It multiplies the directional shadow
  factor, so it can supplement cascades or stand alone for a cheap sun
  occlusion term. Pixels already in full cascade shadow skip the march.
- Cost is bounded: 3–8 depth taps, about one per 4 px of the ray's projected
  length. Rays shorter than 1.5 px and back-facing pixels do no work.
- Noise uses interleaved gradient noise. It rotates per frame only when TAA
  accumulates, and stays static otherwise.
- The march only sees on-screen depth. Occluders outside the view or hidden
  behind nearer geometry cast no contact shadow. Keep the length short
  (typically `0.1`–`0.5` m); the cascades remain the long-range owner.
- `validateDirectionalLightData` returns `shadow-invalid-config` with
  `detail.field === 'contactShadowLength'` for negative or non-finite values.

The real-render regression and RHI Debug replay evidence is
[`contact-shadow.fixture.ts`](../runtime/src/__tests__/contact-shadow.fixture.ts).

#### Capsule character shadows

The Deferred prepare pass defines the complete capsule and tile buffers, clearing
unused tails even when the feature is disabled. RHI captures therefore require no
previous contents for these graph-declared storage inputs.

Skinned characters are the most expensive directional shadow casters: every
cascade re-rasterizes their deforming mesh every frame, and the dynamic layer
can never be cached. Tag a skinned entity with `CapsuleShadow` to cast its
directional shadow from the skeleton's shadow capsules instead, following
Unreal Engine's capsule shadows:

```ts
world.spawn(
  { component: MeshFilter, data: { assetHandle: mesh } },
  { component: MeshRenderer, data: { materials: [material] } },
  { component: Skin, data: { skeleton, joints } },
  { component: CapsuleShadow, data: {} },
);
```

- The capsules are `SkeletonAsset.shadowCapsules`: bind-space segments with
  a radius, each bound to one joint. glTF and FBX import fit them for every
  skeleton (`fitShadowCapsules` in `@forgeax/engine-skinning`); procedural
  skeletons author them directly. Loaders reject malformed sets and more than
  `MAX_SHADOW_CAPSULES_PER_SKELETON` capsules.
- Admission needs the Deferred path, a `castShadow` DirectionalLight, a
  ShadowCaster pass on the material, and capsules on the skeleton. An
  admitted entity leaves every directional cascade; spot and point shadows
  still rasterize its mesh. A non-admitted entity keeps its cascade shadow.
- Extraction poses capsules with `jointWorld x inverseBind`. The Deferred
  lighting prepare pass sorts them closest-first, keeps at most 1024 per view,
  and bins each light-swept bound into 16 px tiles (at most 32 per tile). The
  lighting pass evaluates only its tile's capsules: a cone-versus-sphere
  occlusion toward the sun with a soft end fade. There is no extra pass or
  render target.
- The cone half-angle is five times the PCSS `shadowAngularRadius`, clamped
  to [1 deg, 30 deg], so PCSS lights give matching softness. Capsule shadows
  are soft, blob-like body occlusion: they do not reproduce fingers, clothing,
  or other silhouette detail, and they self-shadow only through the capsules.
- Forward keeps the cascade shadow, so tagging changes nothing there.

After `draw`, `renderer.inspect().capsuleShadow` is `undefined` without any
tagged entity. Otherwise it reports `requested`, `admitted`, `capsuleCount`,
`droppedCapsules` (past the per-frame budget), `tileCount`, `tileOverflow`,
and `fallbacks` counted by `forward-path | not-skinned | no-shadow-capsules |
no-shadow-caster-pass | no-directional-shadow`.

The real-render regression and RHI Debug tile-table evidence is
[`capsule-shadow.fixture.ts`](../runtime/src/__tests__/capsule-shadow.fixture.ts).

After `draw`, read the single `renderer.inspect().directionalShadow` projection.
It is JSON-safe and bounded: `requested` is author intent, `effective` is the
admitted profile, `status` is `accepted | fallback | rejected`, and
`fallbackReason` explains `webgl2-unsupported`, `rhi-null-structural`, or
`candidate-failed`. `lastKnownGood` identifies retained output and
`pixelEvidence` distinguishes real pixel evidence from `not-available`.
`cascadeCount`, `mapSize`, `shadowMapBytes`, `writerPasses`, `blockerTaps`,
`filterTapUpperBound`, `seamTapUpperBound`, `deviceGeneration`, and
`graphGeneration` are inspection facts, not additional author controls.

`renderer.inspect().shadowRaster` reports the last submitted frame's shadow
raster work across directional, point, and spot views. `passCount` counts the
views that re-rastered and `drawCount` sums their draw commands. Each
`views[]` row carries its `identity`, `cache: 'hit' | 'miss'`, and `drawCount`;
a miss also carries the closed `ShadowViewInvalidationReason` (source in
[`inspection-types.ts`](src/inspection-types.ts)). A steady static scene reports
`passCount: 0`; a persistent miss names the input that keeps changing.
Each row also exposes `statistics`: committed decision, hit, rebuild and draw
counts plus counts by invalidation reason. These totals begin when the view
enters the active roster and retire when it leaves. Failed submissions do not
advance them, and a previously returned inspection remains immutable and
structured-cloneable. Native source identities used for revision admission stay
private. Automatic final shadow maps refresh on graph membership changes,
including removed feature casters; static layers keep their pool-proven cache,
and manual frozen maps retain their submitted depth. Spot map allocation and
raster viewport share the same admitted size, independent of directional maps.
`shadowMapBytes` counts the resident shadow array even when the graph imports it.

Without a spot shadow, the graph supplies an initialized 1×1 depth array with
the same four-layer binding shape. A nonzero spot-shadow count keeps the authored
map resolution. Light count belongs to graph identity, so entering or leaving
this state rebuilds and initializes the matching target.
Spot lights beyond the four-tile shadow budget retain direct illumination.
Their unallocated tiles do not hold `FrameReceipt.presentation` pending;
allocated shadow tiles retain the ordinary pipeline and resource readiness gates.

Shadow views stay cached under ordinary motion:

- Directional cascades fit a bounding sphere snapped to whole shadow pages.
  The last submitted matrix remains reusable across page boundaries while the
  receiver sphere, upstream caster reach, receiver normal bias, filter footprint
  and raster guard fit its existing coverage. Coverage loss, light-basis or
  projection-scale changes refit immediately; map resolution and extent retain
  their authored policy. Every shadow consumer uses the accepted projection.
- A retained view re-rasters only when a caster whose drawn content, view
  membership, or selected LOD level changed touches the retained frustum, judged
  by every world bound the caster occupied since the view last rastered. Any
  other change (an out-of-view move, add, remove, or class flip) adopts the
  new plan and stays a hit. A caster without a conservative bound
  misses every view; a mesh content change uses its affected caster bounds.
- An unchanged source sync still flushes committed temporal primitive flags.
  It uses the retained projection's bounds and instance-row resolvers, so this
  metadata upload proves an empty caster-change set and preserves static classes.
  Real source changes and resync retain their normal shadow invalidation.
- A light view with a matrix selects caster LOD by the caster's footprint in
  that light projection (`lodViewCameraFromMatrix`), never coarser than
  `SHADOW_LOD_COARSEST` (LOD1), so a wide cascade cannot drop a caster to a
  proxy that no longer matches its lit silhouette. The GPU cull applies the cap
  through the view's clamp-flagged `LodViewConstants` row. The selection
  depends on caster pose, mesh and light matrix only, so main-camera motion
  never invalidates a retained layer and needs no CPU LOD mirror. LOD1 is a
  conservative cap: for every main level it is no coarser than the former
  `mainLevel + 1` bound. Far casters can therefore use finer geometry than
  before; record their GPU work separately from the removed CPU projection.
- Caster classification consumes the scene's object-change journal and direct slot
  lookup; asset-only revisions do not enumerate objects. Initial attachment and
  explicit history loss rebuild the roster. Each settling caster owns one
  cancellable deadline, removed on replacement or removal, so quiet frames do not
  scan pending movers. Only due transitions rebuild class membership snapshots.
  One classifier marks each caster
  static or dynamic once per frame, and every directional, spot, and point-face
  view uses that same classification. Skinned and sprite casters are always
  dynamic. A caster whose entity declares `Mobility` static is static from its
  first frame (creation or gaining the declaration) with no observation window.
  Every other caster present at the renderer's first frame is the level and
  starts static. A caster created later starts dynamic and, if it has not
  changed since creation, becomes static after one 16-frame window, so
  short-lived spawns never touch the static layer; a caster that changed
  becomes static after 100 unchanged frames. Settled
  casters are promoted together on 16-frame windows so a static layer pays at
  most one membership refresh per window. A caster that changes again within its threshold of a promotion is
  a periodic mover: its threshold doubles (100, 200, 400, ... up to 1600) and
  halves back for every threshold it then stays static, so periodic movers stop
  flipping the static layer. A declared static caster that changes anyway is
  classified by the same observation (dynamic, then re-settled), so a violated
  declaration stays correct; `scenePlugin` reports it as `mobility-static-moved`.
  Undeclared spawns therefore never touch a static layer. `gpuDriven` inspection
  reports `shadowCasterFlips` (class changes of existing casters in the last
  frame) and `shadowCasterPendingPromotions`.
- Each layer draws per-batch subsets of the fixed source's member roots. A
  frame re-judges only slots whose class or caster-channel membership changed
  and the member paths of edited batches; a batch absent from the source keeps
  its subset dormant, so toggling a shadow Pass walks no members. Channel masks
  keep one membership per mask, patched from the scene journal. A GPU view
  holds its subset encodings in the shared scene input until its next accepted
  topology, so a successor re-encodes only changed paths. View preparation
  counters report `layerSlotVisits`, `layerBatchSelections` and
  `layerBatchPatches` (subsets holding a changed slot). Each view keeps a
  `layer: 'static'` companion identity for its settled casters. The final view
  copies the static layer and re-rasters only dynamic casters;
  `static-layer-changed` marks a final miss caused by its static layer. A view
  whose selected task draws skinned casters redraws as `skin-task-demand`;
  joint edits broadcast nothing to other views. A change to
  camera clipping with `clipShadows` invalidates every view. The static
  layer doubles shadow depth memory for directional, spot, and point maps.
- A static-layer miss caused only by changed content or membership, with
  an unchanged light matrix, target and graph, re-rasters only the dirty
  regions: every box the changed casters occupied since the retained revision
  projects through the light matrix into at most four merged rects, and each is
  scissored, depth-cleared and redrawn over the retained layer (`loadOp:
  'load'`). The raster row reports `dirtyRectCount`; more than four rects,
  over half of the map, an unproven box, a new matrix or a graph recompile
  fall back to a full clear-and-redraw.
- Orthographic (directional) views skip casters whose world extent across the
  shadow map is below one texel in every layer. Static/dynamic classification
  changes caching, never this visibility threshold. The view row reports `minCasterDiameter` in the pool inspection and the
  raster row reports `texelCulled`, read back after each submit that re-culled
  the view (Skin-task-only re-culls reuse the last count), so a retained layer
  keeps the count of the cull that produced it. Perspective views never
  texel-cull. Shadow observation decodes only the submitted batch cull counters
  through the same map and resource-generation checks as complete LOD
  observation; it does not reconstruct visible members or Surface records.

If author validation returns `error.code === 'shadow-invalid-config'`, do not
parse `error.message`. Read `error.expected`, `error.hint`,
`error.detail.field`, `error.detail.actual`, `error.detail.bound`, and
`error.detail.reason`; repair the named `DirectionalLight` field and retry the
same request. For a rejected candidate, retain `lastKnownGood` from inspection,
repair or rebuild the named producer, then call the existing `renderer.recover()`
boundary and retry. WebGL2 reports its explicit PCF lane; RhiNull reports
`rhi-null-structural` only, so neither is PCSS pixel evidence.
Missing or `not-run` Browser/Dawn/PNG/timing evidence remains missing or
`not-run`, never a pass. The authoritative labels and validation remain in
[`directional-light.ts`](src/components/directional-light.ts) and
[`light-helpers.ts`](src/components/light-helpers.ts); this section is an AI
index path, not a second schema.

```ts
import {
  ANTIALIAS_TAA,
  Atmosphere,
  BLOOM_DISABLED,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  Fog,
  type FramePlan,
  type Renderer,
} from '@forgeax/engine-render';

void ANTIALIAS_TAA;
void Atmosphere;
void Camera;
void Fog;
declare const renderer: Renderer;
declare const plan: FramePlan;
void renderer.inspect();
void plan;
```

Environment selection is a closed `none | image | atmosphere` fact. Multiple
environment owners or multiple fog owners return structured errors with a
code-specific `detail`; they do not create a second registry or silently pick
the first entity. Frame facts contain IDs, revisions, and POD values only, not
textures, buffers, devices, or other live GPU objects.

An Atmosphere also requires exactly one `DirectionalLight` sun. A direct render
extraction with no sun routes `SunCardinalityError` through the World-owned
error boundary (`console.error` with the structured error) before extraction
throws; that internal route is deliberately separate from `app.onError`.
`app.onError` receives errors returned by the App frame loop and renderer event
stream. Inspect `error.code` and `error.detail.value`, repair the owning World,
then retry the same extraction or the next frame. For zero suns, spawn one
`DirectionalLight`; for multiple suns, remove the extras so the Atmosphere has
one owner. The renderer does not manufacture a fallback sun or retain a
partially selected environment.

The Standard graph evaluates a spherical atmosphere in linear HDR. Authoring uses
metres and inverse metres; shaders convert once to kilometres. The Atmosphere
Transform is the ground reference point, with the planet centre one radius below
it on world -Y. Rayleigh and Mie density are exponential; the absorption layer is
a tent profile. `DirectionalLight.intensity` is outer-space illuminance in lux.
The same medium attenuates direct solar lighting, the visible disc and finite
camera-to-surface paths. Geometry and cloud visibility affect single scattering;
the multiple-scattering closure remains a low-frequency spherical approximation.

### Atmosphere and aerial perspective

For a surface radiance `C`, the camera receives `T * C + L`. Both `T` and `L`
are RGB; a scalar extinction approximation was rejected by the fixed-exposure
colour error gate. Sky and finite-depth surfaces use one transport kernel.
Far objects retain physically appropriate silhouettes instead of being forced
to match a fixed sky colour. Ordinary outdoor haze needs no additional `Fog`.

| Author input | Default | Meaning |
|:--|:--|:--|
| `planetRadius`, `atmosphereHeight` | 6,360,000 m; 60,000 m | Spherical bounds |
| `rayleighScattering`, `rayleighScaleHeight` | (5.802, 13.558, 33.100)e-6 /m; 8,000 m | Molecular scattering and density |
| `mieScattering`, `mieAbsorption`, `mieScaleHeight` | 3.996e-6 /m; 0.444e-6 /m; 1,200 m | Aerosol scattering, absorption and density |
| `mieAnisotropy` | 0.8 | Henyey-Greenstein phase asymmetry |
| `absorption`, `absorptionPeakHeight`, `absorptionHalfWidth` | (0.650, 1.881, 0.085)e-6 /m; 25,000 m; 15,000 m | Ozone-like absorption |
| `groundAlbedo`, `multipleScattering` | RGB 0.4; 1 | Ground bounce and high-order scattering scale |
| `sunAngularRadius` | 0.004675 rad | Disc radius; zero hides the disc |
| `aerialPerspectiveStart`, `aerialPerspectiveDistanceScale` | 0 m; 1 | Skipped prefix and optical-distance scale |

The component schema and extraction validation own supported ranges. Removed
empirical turbidity, colour-power and halo controls have no compatibility path.
Use fixed manual exposure and disable Bloom for comparisons; for the 100,000-lux
Earth fixture, exposure is 1/5,000 with ACES Filmic output.

| GPU result | Shape | Update dependency |
|:--|:--|:--|
| Transmittance | 256 x 64 RGBA16F | Medium geometry and density |
| Multiple scattering | 32 x 32 RGBA16F | Medium and ground albedo |
| Sky View | 192 x 208 RGBA16F | Observer, sun and local visibility |
| Aerial perspective | Two 32-cubed RGBA16F volumes | View, sun and local visibility |
| Distant sky illumination | 1 x 1 RGBA16F | Atmosphere and sun; fixed ground reference |

Radiance LUTs store unit-white-sun transport and consumers multiply the frozen
solar colour and illuminance once. This keeps 100,000-lux lighting within RGBA16F
range without clamping radiance. Cloud depth intermediates store kilometres;
cloud transmittance remains separate from presentation alpha.

AP uses quadratic distance slices with a view-derived range capped at 96 km.
The last stored centre transitions to direct integration at the finite endpoint;
out-of-range, orthographic and space-view paths use the same integrator.
The production step budget is 64. Independent 512-step comparisons measure
sampling error separately from the high-order scattering approximation.

The sky cube is an environment capture output, not the display sky authority.
An explicit asset-free Skylight consumes its irradiance and prefiltered radiance;
no Skylight means no global ambient contribution. The Skylight Transform selects
its capture position, defaulting to the atmosphere ground reference plus 1 m.
The solar disc is excluded from IBL. Captures retain their atmosphere generation
and solar snapshot until the scheduled faces and filtering finish. Environment
versions retire after GPU completion and the last capture lease; disabling the
source releases its owner lease. Each camera owns its Sky/AP resources while
medium tables are shared by the Renderer. All work uses its outer submission.

Atmosphere requires compute, filterable/storage RGBA16F, 3D sampling and a
31-sampled-texture device budget for the complete Standard material layout.
Missing capabilities return structured unavailable; there is no silent old-sky
fallback. The first delivery accepts single-sample scene depth; choose TAA,
FXAA or no AA. GPU observations name the `atmosphere-*` passes and report
unavailable timestamps explicitly.
The source lifecycle inspection and graph resource accounting describe different
owners: a source revision is not a claim that its GPU cube was submitted.

The reusable [Wave 1 recipe](../../scripts/dev-verify/wave1-rendering/README.md)
shows the public scene inputs and associated acceptance gates.

## Adaptive dynamic resolution

Add `DynamicResolution` to the active TAA camera. Renderer consumes completed
GPU timestamps and changes Standard's internal scene extent; the canvas, TAA
history, output, overlays, and observation images retain their output dimensions.
No App frame clock or World component is rewritten.

```ts
import { ANTIALIAS_TAA, Camera, DynamicResolution } from '@forgeax/engine/render';

world.set(camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
world.addComponent(camera, {
  component: DynamicResolution,
  data: { targetGpuMs: 16.67, minScale: 0.67, maxScale: 1 },
}).unwrap();
const resolution = renderer.inspect().dynamicResolution;
```

| Field | Default | Contract |
|:--|:--|:--|
| `targetGpuMs` | `16.67` | Positive finite GPU frame budget in milliseconds. |
| `minScale` | `0.67` | Minimum scale in `[0.5, 1]`, no greater than `maxScale`. |
| `maxScale` | `1` | Maximum scale in `[0.5, 1]`; equal bounds select fixed TAAU. |

The controller starts at `maxScale`, smooths completed frame intervals with an
EMA (weight 0.25), and evaluates every eight valid samples. The decision uses
the larger of that EMA and the midpoint between the window's minimum and
second-largest interval. This ignores one isolated high outlier and symmetric
near-budget noise, while retaining repeated expensive frames even when the
window ends cheaply. If a majority of that window misses the 105% bound, its
second-largest interval also contributes: a skewed high-cost cycle cannot appear feasible merely because
the window ends cheaply. Balanced noise and one isolated high outlier retain
their existing behavior. The window stores three extrema and one overrun count;
feedback retains its single query owner. It holds within
85–105% of the budget. Outside that band, a pixel-area estimate aims at 95% of
the budget. Before quantization, one decision limits the downward change to 1/16
or the upward change to 1/32 for ordinary pixel-area decisions. The result rounds to 1/32 steps within the authored
bounds, with 8-pixel internal-axis
alignment inherited from fixed TAAU. Very small surfaces retain their native
extent. Alignment may place the physical axis slightly below the nominal scale.
A quality increase is a measured headroom probe. If it exceeds the budget, the
controller returns to the preceding feasible scale and avoids repeating that
probe until filtered work at an unchanged held scale becomes at least 15%
cheaper than its baseline. That baseline starts at the least expensive sample
in the feasible eight-sample window and can only decrease while rollback work
settles, so a settling resize tail is not new workload headroom.
One budget-fitting window does not discard the probe: delayed overload still
returns to its preceding feasible scale.
Overloaded rollback samples lower the held boundary: a preceding extent that
also exceeds the budget is no longer feasible. Any subsequent extent change, including rejection of a quality probe,
clears the cost baseline;
the first completed window at that extent establishes it before recovery can
unlock the boundary. Lower-scale savings alone are not workload headroom. This
prevents repeated crossings of a nonlinear GPU cost boundary without retaining
a parallel timing history. A probe whose eight-sample minimum still rises by
more than 15% waits for another complete window before increasing quality again.

An increase in the authored GPU budget requests the same bounded maximum-quality
trial after eight fresh samples. It clears the old budget boundary, but the new
budget still owns acceptance or rollback. This prevents settling guards from
delaying explicitly requested quality recovery.

A decrease in the successfully submitted camera-visible candidate count is a
workload-change hint. It comes from the existing extraction culling facts, not
residency row length: GPU-owned culled candidates remain in the residency plan. Below `maxScale`, it invalidates old feedback and measures
eight complete GPU samples at the held extent before one `maxScale` trial. GPU
cost accepts that trial or returns to the saved extent; an unchanged roster does
not repeat a rejected trial. This maximum-quality recheck is distinct from the
ordinary bounded pixel-area steps. A sparse reduced view can be more expensive
than native, so row count never substitutes for timing or estimates cost. Fixed
bounds and unavailable timestamps cannot enter the trial; a failed submission
cannot publish the hint.

| Inspection status | Meaning |
|:--|:--|
| `fixed` | Equal authored bounds; DRS allocates no timing queries. |
| `warming` | Waiting for enough valid completed samples; a missing or failed sample is never headroom. |
| `adaptive` | Valid GPU feedback is active. `gpuMs` is the filtered interval, absent immediately after a scale change. |
| `unavailable` | The device lacks a trustworthy timestamp capability; rendering stays at `maxScale`. |

`extent` is the last successfully submitted extent, absent before the first
submit. Inspect `temporalTarget.descriptor` for the actual internal temporal
attachment and `temporal.coverage` for output history dimensions. Graph replacement
and history retirement retain their existing submit/fence ownership. A failed
submission cannot publish the candidate extent or contribute a timing sample.
Rejected TAA history outputs the current sample and zero stability directly,
preserving HDR rounding and temporal metadata while skipping unused history
neighborhood and clipping work.

At most one DRS readback is pending. Device generation, camera/World switch,
resize, removal, detach and recovery invalidate old feedback. Budget/range edits
clear filtered samples and clamp the current scale. DRS reuses requested GPU pass
or frame timing; it never overwrites producer timestamp writes, accepts partial
pass timing, or sums pass costs as frame latency. Without an existing timing
owner it captures the first-to-last raster/compute interval of the submitted graph.
The controller never waits for GPU readback on the draw path.

> [!NOTE]
> Renderer admits `timestamp-query` when the adapter supports it so a camera can
> enable DRS after startup. Admission alone allocates no query resources. GPU
> timestamp quantization, unsupported adapters, partial captures and non-pixel
> workloads can limit adaptation. CPU stalls alone do not trigger downscaling.
> DRS is a bounded quality adjustment, not a guarantee of meeting every budget.

Remove the component to restore native TAA. `antialias` must remain `taa` while
DRS is present; validation reports `dynamic-resolution-requires-taa` otherwise.
The Browser and Dawn `adaptive-drs` fixtures exercise late enable, overload,
headroom recovery and removal, preserving real RHI Debug tapes, output pixels,
fresh-device replay comparisons and a missing-output-draw falsifier.

### Three.js reference

Compared against Three.js commit
[`b745e6c`](https://github.com/mrdoob/three.js/tree/b745e6cb7b098e4b56bb9a3dbb1ab0b480f35aa2):

| Three.js source | Applied boundary |
|:--|:--|
| [`PassNode.setResolutionScale`](https://github.com/mrdoob/three.js/blob/b745e6cb7b098e4b56bb9a3dbb1ab0b480f35aa2/src/nodes/display/PassNode.js) | Scale internal scene attachments independently of the drawing buffer. |
| [`TAAUNode`](https://github.com/mrdoob/three.js/blob/b745e6cb7b098e4b56bb9a3dbb1ab0b480f35aa2/examples/jsm/tsl/display/TAAUNode.js) | Keep resolve/history at output size across internal scale changes. |
| [`WebGPUTimestampQueryPool`](https://github.com/mrdoob/three.js/blob/b745e6cb7b098e4b56bb9a3dbb1ab0b480f35aa2/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js) | Resolve GPU timestamps asynchronously with bounded pending readback. |

These sources supply scaling, reconstruction and timing primitives. The automatic
budget controller, smoothing thresholds and scale-step policy above are ForgeaX
choices. Existing ForgeaX TAAU retains its reconstruction and 8-pixel alignment;
Three.js floors each scaled axis. The GPU regression checks output-sized history
on every completed transition frame and verifies the actual TAAU texture bindings
in the captured RHI work.

### Shared Standard temporal raster

Deferred GBuffer can publish the existing `temporal-v1` target beside its material
facts when the device admits seven attachments and 40 bytes per sample.
The geometric receiver normal remains the sixth attachment. With visible-surface
demand, its seventh attachment stays in place; merged temporal uses the eighth
attachment and requires 56 bytes per sample.
Insufficient capacity retains the real independent temporal raster. Forward-only
surfaces fill their own temporal pixels while loading the merged target.
A loaded supplement is skipped only when both CPU material selection and the GPU
projection have no eligible work. `RenderPipelineGpuDrivenProjection.hasWork`
reads the live batches through the encoder's same family/temporal predicate; a
false result proves no indirect draw, while true may still be culled by the view.
The independent clear producer always runs, including an empty scene.

Both producers share motion validity, log view depth and the alpha-hash reactive
policy. Vertex-stage clip differences preserve exact zero motion for equal poses,
including equal skin palettes. GBuffer temporal coverage comes from the evaluated
Surface. Alpha hashing commits binary coverage and does not convert its fractional
sampling alpha into source reactivity. Output-sized TAAU coverage remains a separate
raster; this change adds no texture or history slot.

## GPU pass timing: opt in, draw, observe, branch on status

When App owns the draw loop, `renderer.subscribe` delivers the exact `receipt`
in each `frame-submitted` event. Pass that receipt to `observe`; do not construct
one from the frame number. Start observation promptly because retention is bounded.

GPU pass timing is disabled by default. Opt in once on `createRenderer`, keep the
returned `FrameReceipt`, and request facts only for that receipt. The pass
duration is a bounded GPU fact; it is not frame latency.

```ts
import { createRenderer } from '@forgeax/engine-runtime';

const created = await createRenderer(canvas, { gpuPassTiming: {} });
if (!created.ok) throw created.error;
const renderer = created.value;
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
const drawn = renderer.draw({
  leases: [attached.value],
  camera: { lease: attached.value },
  environment: { lease: attached.value },
});
if (!drawn.ok) throw drawn.error;

const observed = await renderer.observe(drawn.value, { include: ['timings'] });
if (!observed.ok) throw observed.error;
const timings = observed.value.timings;
if (timings === undefined) throw new Error('timings were not requested');
switch (timings.status) {
  case 'complete':
    console.log(timings.frame.passes);
    break;
  case 'partial':
    console.log(timings.reason.code, timings.frame.passes);
    break;
  case 'unavailable':
    console.log(timings.reason.code, timings.capability);
    break;
  case 'failed':
    console.log(timings.error.code, timings.latestKnownGood);
    break;
}
```

The [bounded fact contract](src/record/gpu-pass-timing/contract.ts),
[recovery errors](src/record/gpu-pass-timing/errors.ts), and
[validator](bench/gpu-pass-timing/validator.ts) are the source-linked
references for the four status branches and the fail-closed benchmark verdict.
A timing error exposes the closed `code` union plus `expected`, `hint`, and
`detail`; follow the producer-owned recovery action in the error before
observing a later receipt. `latestKnownGood` is a separate reference and never
changes the current status or completeness. Omitting `timings` from `include`
returns receipt metadata without materializing timing facts.

Run the paired real-GPU benchmark with the Dawn host:

```sh
FORGEAX_GPU_PASS_TIMING_HOST_MODULE="$PWD/packages/render/bench/gpu-pass-timing/dawn-host.ts" \
  pnpm gpu-pass-timing:bench -- --output=/tmp/forgeax-gpu-pass-timing.json
```

The command exits `0` only for a complete accepted report and exits `2` for a
blocked report. When an observation is `partial`, branch on
`timings.reason.code === 'timestamp-write-unavailable'`, retain the
unmeasured pass and its structured `detail.cause`, then observe the next
receipt after the producer-owned recovery action. Do not turn that pass into a
zero-duration sample or accept the benchmark until all paired windows are
complete.

An accepted report retains `frameFacts`: one complete on-path frame fact per paired
group, including the frame identity, raw decimal ticks, each measured pass duration,
and `measuredPassNanoseconds`. If a real run is blocked by partial observations, the
blocked JSON keeps the observed representative facts under `evidence.frameFacts` so
the measured values remain inspectable without weakening the verdict. If complete
windows fail the paired overhead gate, `evidence.windows` retains the raw samples and
`evidence.pairedOverhead` retains each group p95, group overhead, and reported median.

Measured entries expose `measurementSource`: raster and compute entries use
`pass-boundary`; copy entries use `copy-boundary-envelope`, the interval between
marker passes, including their dispatch and synchronization overhead, and must not
be read as exact copy duration. Each marker performs one invocation that writes
a session-owned four-byte storage buffer; this keeps the pass from being elided
and orders marker work. The pipeline/bind group/buffer are created on the first
copy, reused by all bounded slots, and retired with the session. Renderer assembly
supplies its active shader module factory; a standalone timing session needs the
same factory when it records copies. Timing-disabled and raster-only paths allocate
no marker resources.
Marker queries use a separate query set so a changed layout cannot read old
raster/compute timestamps as copy timing. Zero or unchanged marker writes
produce `unmeasured` with `timestamp-write-unavailable`, when a backend fails to publish the ordered marker timestamps. This does not remove
valid raster/compute observations. Pass intervals can overlap; neither their
sum nor cross-frame timestamp differences define GPU frame latency.

Engine-owned carriers can derive coverage with
`render/internal.summarizeGpuPassTimingIntervals(passes, timestampPeriodNanoseconds)`.
It validates raw decimal ticks through the same parser and returns a `Result` with
measured/unmeasured counts plus sum, union, envelope and repeated coverage in ns.
It does not turn missing queries into zero samples or remove copy marker overhead.
The envelope uses the earliest beginning and latest end across all selected passes,
including gaps; it is not an independent native outer query. `measuredPassNanoseconds`
retains its diagnostic sum semantics. Neither union nor envelope proves exclusive
feature cost: paired whole-submission measurements must retain their sampling protocol.
The legacy volume `frameMs`/`totalMs`/cloud `totalMs` also describe derived pass envelopes.

## Fog and point-shadow observations

`Fog` is a one-per-World environment input. Extract validates its parameters
before publication; an invalid update keeps the renderer's last-known-good
fog frame and exposes the structured failure through the existing inspection
path. There is no app-local fog state.

### VolumetricFog authoring, World time, and recovery

Each `VolumetricFog` authors one local medium backed by a linear 3D
`TextureAsset`; a view accepts up to eleven owners. The selected light must be a live same-World
`DirectionalLight`, `PointLight`, or `SpotLight`; Point/Spot selection also
requires the corresponding `Transform`. Validate the authoring POD before
spawning the component, then let the existing RenderSystem extract it. The
World `Time` resource is the only simulation clock: `world.update(delta)`
advances it, and the volume parameter block receives that elapsed value.

Local volumes compose into the linear scene color in both Standard Forward and
Deferred, including `Camera.tonemap = TONEMAP_NONE`. Tone mapping controls the
subsequent Output Transform; changing it does not disable the medium.

```ts
import { Time, World } from '@forgeax/engine-ecs';
import {
  Atmosphere,
  BLOOM_DISABLED,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  DirectionalLight,
  VolumetricFog,
  extractVolumetricFog,
  perspective,
  resolveSelectedVolumetricLight,
  validateVolumetricFog,
  type VolumetricFogAuthoring,
  type Renderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';

const world = new World();
const densityAsset: TextureAsset = {
  kind: 'texture',
  shape: { viewDimension: '3d', extent: { width: 4, height: 4, depth: 4 } },
  format: 'r8unorm',
  colorSpace: 'linear',
  mips: { kind: 'none' },
  data: new Uint8Array(4 * 4 * 4).fill(32),
};
const density = assets.create(densityAsset).unwrap();
// A production project normally obtains this TextureAsset from its existing
// Pack/Catalog load path and binds the returned asset handle.
// The inline payload keeps this authoring example executable and deterministic.
const camera = world.spawn(
  { component: Transform, data: { pos: [0, 0, 3] } },
  { component: Camera, data: {
    ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
    exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
    exposure: 1,
    bloom: BLOOM_DISABLED,
  } },
).unwrap();
const sun = world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -0.8, -0.3], castShadow: true },
}).unwrap();
const atmosphere = world.spawn({
  component: Atmosphere,
  data: { mieAnisotropy: 0.8, sunAngularRadius: 0.004675 },
}).unwrap();

const authored: VolumetricFogAuthoring = {
  light: sun,
  density: {
    guid: 'density-demo',
    generation: 1,
    shape: { viewDimension: '3d', extent: { width: 4, height: 4, depth: 4 } },
    format: 'r8unorm',
    colorSpace: 'linear',
  },
  bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  extinction: [0.2, 0.2, 0.2],
  albedo: [0.8, 0.8, 0.8],
  emission: [0, 0, 0],
  anisotropy: 0,
  maxDistance: 50,
};
const checked = validateVolumetricFog(authored);
if (!checked.ok) throw checked.error;
const extracted = extractVolumetricFog([checked.value]);
if (!extracted.ok) throw extracted.error;
const selected = resolveSelectedVolumetricLight(world, sun);
if (selected.status === 'unresolved') {
  throw new Error(`${selected.reason}: ${selected.hint}`);
}
world.spawn({
  component: VolumetricFog,
  data: {
    light: sun,
    density,
    boundsMin: authored.bounds.min,
    boundsMax: authored.bounds.max,
    extinction: authored.extinction,
    albedo: authored.albedo,
    emission: authored.emission,
    anisotropy: authored.anisotropy,
    maxDistance: authored.maxDistance,
  },
}).unwrap();

world.update(1 / 60).unwrap();
const elapsed = world.getResource(Time).elapsed; // the projected volume time
void camera;
void atmosphere;
void elapsed;
```

If validation fails, read its structured `code`, `expected`, `hint`, and typed
`detail`. If light resolution is unresolved, read its `reason`, `expected`,
`actual`, and `hint`; repair the owning authoring field, and extract again.
Do not manufacture a light or a density fallback. After a submitted frame,
`renderer.inspect().volumetricFog` reports `status`, `resourceStage`, the
selected-light facts, and candidate/LKG generations. For a renderer device
loss, wait for the host recovery boundary, call `await renderer.recover()`,
then submit the same World again and inspect the replacement generation:

```ts
import type { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';

// After the existing createRenderer(canvas) happy path returns a Renderer,
// call `await recoverAndDraw(renderer, world)` with the World above.
async function recoverAndDraw(renderer: Renderer, world: World): Promise<void> {
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  if (renderer.state() === 'device-lost') {
    const recovered = await renderer.recover();
    if (!recovered.ok) throw recovered.error;
  }
  const retry = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
  if (!retry.ok) throw retry.error;
  const completed = await retry.value.completed;
  if (!completed.ok) throw completed.error;
  const volume = renderer.inspect().volumetricFog;
  console.log(volume?.status, volume?.resourceStage, volume?.generation);
}
```

The recovery call rebuilds renderer-owned resources; it is not a second volume
clock or registry. Pausing the simulation means withholding `world.update`.
Equal time and normal monotonic World ticks up to 100 ms retain eligible
volume history. Clock rollback, a larger jump, or changed time availability
invalidates it. Camera, light, medium, size and resource changes still invalidate
history. Integration and shadow visibility use stable cell centers, so a reset
does not expose render-frame random noise. The ray uses 96 base intervals;
segments within four interval lengths of a selected punctual source use four
midpoints to resolve its inverse-square peak and spot cone. This local refinement
keeps the density expression and packed shadow resolution unchanged. A real GPU
punctual-scattering oracle protects spatial accuracy alongside the continuous-frame
browser check; homogeneous transmittance alone cannot detect light-band artifacts.
History is clipped to the current
neighborhood and its weight decays with elapsed World time (at most 0.875 per
frame, about 87 ms half-life at 60 Hz or slower), limiting trails from animated
density. `CloudLayer` is the renderer-owned procedural cloud route described
below; it does not change the volumetric fog component or add a second clock.

### CloudLayer authoring and derived transport

`CloudLayer` is a single World-authored component. Its schema keeps the seed,
layer bounds, noise scale, coverage, density, wind and quality as serializable
source facts. `renderComponentsPlugin()` registers it with the normal ECS
component lease. Cache bytes, light-space shadow projections, per-view history
and GPU handles remain Render-derived state and can be reconstructed from the
validated source key.

Coverage is monotonic: zero clears the layer and increasing it admits more of
its weather-shaped body. Detail erodes this body after altitude shaping; it
cannot create detached density outside the body. Formation cache version 5
uses the same integer hash and density composition as both analytic WGSL
paths, with center-aligned periodic interpolation. Layer thickness controls
the physical height of two vertical body cells; scale controls four horizontal
cells per world-space period. Choose comparable body dimensions for cumulus
rather than compressing a broad cloud into a thin layer. The broad field owns
85% of body shaping; attenuated high-frequency octaves and bounded subtractive
erosion preserve connected masses instead of dense detached fragments.

Install the producer through the existing RenderFeature seam when a scene uses
clouds:

```ts
import { World } from '@forgeax/engine-ecs';
import { createRenderer } from '@forgeax/engine-runtime';
import {
  Camera,
  CloudLayer,
  CloudQualityValue,
  DirectionalLight,
  createCloudLayerFeature,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const canvas = document.querySelector('canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas is required');
const world = new World();
const camera = world.spawn(
  { component: Transform, data: { pos: [0, 140, 240] } },
  { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) } },
).unwrap();
const sun = world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -0.8, -0.3], color: [1, 0.95, 0.9], intensity: 2 },
}).unwrap();
const cloud = world.spawn({
  component: CloudLayer,
  data: {
    seed: 1337,
    baseHeight: 120,
    thickness: 80,
    scale: 0.004,
    coverage: 0.48,
    density: 1,
    wind: [8, 0, 2],
    quality: CloudQualityValue.medium,
    shadowRange: 512,
  },
}).unwrap();
const created = await createRenderer(canvas, { features: [createCloudLayerFeature()] });
if (!created.ok) throw created.error;
const renderer = created.value;
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
world.update(1 / 60).unwrap();
const drawn = renderer.draw({
  leases: [attached.value],
  camera: { lease: attached.value },
  environment: { lease: attached.value },
});
if (!drawn.ok) throw drawn.error;
console.log(camera, sun, cloud, renderer.inspect().cloudLayer); // keyed by view identity

world.set(cloud, CloudLayer, { wind: [10, 0, 2] }).unwrap();
const changed = renderer.draw({
  leases: [attached.value],
  camera: { lease: attached.value },
  environment: { lease: attached.value },
});
if (!changed.ok) {
  console.error(renderer.state(), renderer.inspect().cloudLayer, changed.error);
  throw changed.error;
}
```

If the capability report does not admit the cloud lane, disable that feature at
assembly time and keep the rest of the renderer running:

```ts
const created = await createRenderer(canvas, {
  features: [createCloudLayerFeature({ enabled: false })],
});
```

The runtime `createRenderer()` result is returned after the renderer's internal
initialization barrier has completed, so the public `Renderer` can attach and
draw immediately after the `Result` check above. The `initialization` Promise
belongs to the lower-level internal construction seam.

`renderer.inspect().cloudLayer` maps renderer view identities to detached cloud
inspection records. `resourceStage` distinguishes a planned candidate from an
accepted picture; `temporalResets`, `lastTemporalReset` and history resource
facts come from receiver planning. Held views keep their accepted record. A
failed attempt cannot advance accepted history or reset counters. Worker
publication carries source facts; receiver planning owns temporal admission.

The feature extracts the authored component, World `Time`, and the selected
directional sun through the normal frame owner. It declares a bounded packed
`u32` 3D formation cache with three contiguous R8 planes (`weather`, `body`,
`erosion`; `ceil(3 * R8 texels / 4)` elements and `elements * 4` storage
bytes), then composites scene-linear HDR color with inverse-view-projection
rays, scene depth termination, bounded Beer extinction, solar-column
transmittance, and cloud-interior phase scattering. The same formation and
coverage contract is used by the CPU reference and the production WGSL path;
coverage, density and wind are evaluation inputs and do not rebuild the
reusable planes. The erosion plane repeats three times across the body period,
adding smaller boundary structure without increasing cache bytes or density
reads. Direct and approximate multiple scattering use the same light/phase unit
convention as the volume path and CPU optical reference; view and solar
sample limits are unchanged. The exported CPU helpers (`buildCloudDensityCache`,
`integrateCloudCameraPath`,
`integrateCloudSolarColumn`, `integrateCloudInterior`, and
`sampleCloudShadow`) remain deterministic reconstruction and recovery tools.

The cloud shadow target is a square, quality-derived `rgba16float` map whose
world-space projection is texel-snapped around the selected sun anchor. The
cloud view, shadow and interior consumers share that projection and attenuate
direct solar transport once. A cloud-enabled view opts into six additional
`rgba16float` temporal surfaces: radiance, transmittance and representative
cloud depth, each with current/previous ping-pong slots at `ceil(surface / 2)`
resolution. One half-resolution transport raster writes the three surfaces as
an MRT from the same camera integral. A full-resolution resolve upsamples those
fields, rejects history against the same wind-advected previous-frame world
point used to project its history UV, clamps radiance and transmittance to the
current four-neighbour transport envelope, and performs the one HDR composite. The
transport samples the world-space cloud-shadow cache for remaining solar
optical depth; invalid projection or out-of-range samples use the bounded
analytic column fallback. There is no second full-resolution raymarch solely
for cloud depth.

Temporal slots are created only when a view demands them; submit advances the
transaction from the resolve pass, while abort, resize, recovery and unload
retire the old generation through the normal queue-fence owner.

The shared `cloud-wind-history` Dawn/Browser regression uses the production
resolve shader and exact binary16 transport samples. It tests matching advected
history, misleading unadvected history, disocclusion, cuts and missing history;
RHI Debug captures and fresh-device replay must preserve the live pixels.
`node scripts/bench/post-processing-maturity.mjs` runs paired ABBA experiments
through the production Renderer at 1080p, 1440p and 4K, retaining 32 warmup and
60 measured completed frames per block, raw timestamps, CPU submission time,
completion latency and accepted resource inspection. `--capture` saves the
combined-effect tape and per-work replay attachments. The carrier requires each
requested effect to be admitted, including real SSR work on Standard materials;
fallback-only SSR cannot count as an enabled combination. `--quality` exercises
cloud light changes, static-medium stability, camera history cuts and odd-size
resize, then checks finite linear HDR highlights and the final fresh replay.
Run performance with an
exclusive physical-GPU lock. GPU pass sum, union and envelope are separate
facts; an envelope budget is not an outer full-frame query or an FPS result,
and descriptor-derived bytes are not driver-private allocation peaks.
Cloud `declaredHistoryBytes` uses the same ceil-half extent as the six actual
ping-pong texture allocations, including odd view dimensions; the temporal
signature still retains the full view extent for resize rejection.

Transparent geometry remains depth-read-only unless its authored render state
explicitly enables `depthWriteEnabled`; this keeps ordinary alpha smoke from
truncating later volume/cloud segments while allowing an intentional cutout or
water surface to publish its own depth. Use `inspectCloudLayer()` and the
renderer's normal feature inspection to read capability, generation,
temporal-reset and resource facts. Inspection distinguishes CPU cache bytes,
declared GPU target bytes, and measured GPU bytes; physical adapter timing and
residency are reported as unavailable until a prepared adapter submits those
receipts. Unavailable compute or storage support is data rather than a hidden
fallback texture.

Point shadows use one renderer-owned cube-array `ShadowAtlas`. The public
`SHADOW_ATLAS_DEFAULT_FACE_SIZE` and `SHADOW_ATLAS_DEFAULT_LAYERS` constants
are the only capacity owner; extract assigns `shadowAtlasLayer: -1` to
requests beyond that capacity while retaining them for inspection. After a
successful frame, `renderer.inspect().pointShadow` reports `requested`,
`admitted`, `shadowed`, `shadowAtlasOccupancy`, and `shadowAtlasCapacity`.
The App `pointShadowPlugin()` consumes that renderer capability and provides
structured preflight failures for missing-storage-buffer, invalid, or
over-budget requests. A World with no `PointLightShadow` remains `inactive`;
there is no pseudo-disabled shadow mode. When no loaded Standard shader
samples the cube atlas (the app did not enable `pointShadows`, below), the
status is `unavailable` with `admitted: 0` whatever the request count; the
renderer derives this from the composed WGSL, never from a build flag copy. Directional CSM remains a separate
shadow owner; PointLightShadow is not a second directional-light path.

The cube atlas uses negated world axes: cube lookup is `lightPos - worldPos`,
and each face camera looks opposite its cube axis with the corresponding face-up
vector. This matches WebGPU framebuffer V without reflecting clip-space Y or
changing authored front-face/culling state. Raster matrices and sampling must
change together; a standalone Z flip is not a valid conversion.

`PointLightShadow` receiver bias follows Bevy's point-light convention and is
scale-invariant. `depthBias` is in world meters (default `0.08`): the receiver's
largest-axis distance to the light shrinks by that amount before the depth
compare. `normalBias` is in cube texels (default `0.6`): the receiver moves
along its light-facing normal by that many texels at its own distance. The
default `pcfKernelSize: 3` uses five rotated Vogel hardware comparison samples,
matching Three r184 radius 1. Width 5 uses radius 2; width 1 uses one hardware
2x2 comparison. Point and Spot share this filter policy. Standard point-shadow sampling is compiled only when the app enables
`forgeaxShader({ engineEntries: { pointShadows: true } })` (DevKit game projects:
`package.json#forgeax.pointShadows: true`); the renderer also
needs `propagateTransforms` to publish the light position.

Camera-culled scene meshes remain shadow candidates when their bounds intersect
an admitted light frustum. Their projected dispatch contains only `ShadowCaster`,
never Forward/Deferred work. Persistent composition uses the merged light frame,
including lights from another World. `frustumStats.culled` continues to count
camera rejection even when the retained object casts a shadow. Draws owned by the
GPU raster lane are admitted without a CPU visit: the CPU camera test runs only on
residual CPU-drawn rows, and the frame stays uncompacted. `ExtractedFrame.gpuOwned`
exposes those residual rows; presentation verification, per-entity receipts and
dynamic-geometry consumption visit only them, while batch coverage stands as the
evidence for GPU-drawn rows and draw summaries are computed on `inspect()`.
A residual draw carries the Scene row it was selected from: its draw address,
shadow-cull bounds and GPU-lane ownership read that row rather than searching
by identity, and each recorded view resolves one pipeline per accepted material
version, Pass and geometry layout instead of one per draw.
`frustumStats` adds the owned-row counts lazily, on first read, so it reports the
same rejection as the CPU-culled path.

## Render happy path

`RenderScene -> Standard Pipeline -> DeviceScope -> FrameReceipt` is the only frame
model. A draw that reports a precise Renderer owner failure and then rejects submission
returns that same-call failure instead of hiding it behind a generic submit contract error.
A later draw never reuses an earlier failure. The host calls `createRenderer`, `attach(world)`, and `draw(request)`; diagnostics use
`inspect`, `observe(receipt, request)`, and `recover`. `FrameReceipt` is the synchronous proof that
submit completed. A failed `Result` carries `code`, `hint`, and `detail`; repair the named owner,
rebuild or cold-cook its source, then retry the same request.

```ts
const created = await createRenderer(canvas);
if (!created.ok) throw created.error;
const renderer = created.value;
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
const frame = renderer.draw({
  leases: [attached.value],
  camera: { lease: attached.value },
  environment: { lease: attached.value },
});
if (!frame.ok) throw frame.error;
const observation = await renderer.observe(frame.value, { include: ['timings'] });
```

The Standard pipeline uses the same Cluster membership for every local light on all devices
and keeps shadow, PBR, IBL, SSAO, bloom, tone, antialiasing, sky, material, VFX, and debug feature
ownership inside the same graph and submit boundary. CPU and WebGL2 remain capability lanes for the
Cluster membership producer and integer-texture transport, or for mesh/instance storage fallback; they do not reintroduce a
PointLight/SpotLight buffer or a fixed four-light ABI.
## SSR admission and bounded inspection

Coverage counters are `null` until GPU measurements are supplied; missing
measurements must not be interpreted as zero hits. The hello-ssr Browser smoke
captures a v7 RHI tape, reads trace/temporal/compose outputs at their producing
work indices, and requires positive confidence plus a measurable composition
delta. It also verifies that the composed resource reaches a later draw and
retains its pixels through that draw. Ordinary `hello-ssr` startup enables SSR.

Standard Deferred evaluates each admitted opaque Surface once in `fs_gbuffer`.
Rigid, skinned, direct and GPU-driven receivers use the same material layout;
GPU-claimed submeshes are excluded from the direct G-buffer loop.

| Location | Format | Content |
|:--|:--|:--|
| 0 | `rgba16float` | Existing SceneColor: linear HDR emissive, opacity |
| 1 | `r32uint` | Octahedral world normal (12 + 12 bits), perceptual roughness (8 bits) |
| 2 | `rg32uint` | R: mixed F0 RGB and material AO; G: dielectric F0 RGB and specular F90. RGB uses square-root encoding; each channel occupies 8 bits. |
| 3 | `r32uint` | Square-root encoded albedo RGB (8 bits/channel), linear metallic (8 bits) |
| 4 | `r32uint` | Reflection environment in high 8 bits, retained SH row in low 24 bits |
| 5 | `rg32uint` | R: camera-facing raster triangle normal (12 + 12 bit oct) and Terrain shadow-family bits; G: u32 receiver lighting channels |

Surface attachments cost 28 bytes/pixel. The existing 8-byte SceneColor makes
the geometry pass 36 bytes/sample, requiring more than WebGPU's default 32-byte attachment
budget. The former separate emissive texture is absent. Deferred requires storage buffers
and at least six color attachments; unsupported devices must select Forward.
The context reserves zero for Skylight/no local SH and supports 255 reflection
environments. SH records retain their existing renderer-owned storage lifetime.

Directional shadow receivers use the raster triangle plane for their world offset and
PCF footprint; BRDF, normal maps, Terrain BA gradients and decals keep the shading
normal. Forward freezes geometry before clipping/alpha discard. Deferred transports
that same source plane through location 5 with explicit 12-bit oct quantization; it
does not infer primitive geometry from neighboring depth. The additional target costs
4 bytes/pixel of graph-owned storage plus geometry writes and lighting reads per view.

`standard-gbuffer.wgsl` owns the shared encoder and decoder. Normal consumers
load integer texels and decode before any spatial reconstruction; packed bits
are never interpolated. Reflectance is normalized to [0, 1], with a square-root
transfer allocating more codes to dark albedo and dielectric F0; AO, metallic
and perceptual roughness remain linear UNORM8. Emissive is unrestricted linear
HDR in SceneColor. Background initializes SceneColor before geometry; geometry
replaces covered pixels with emissive/opacity, then lighting uses additive RGB
and preserves destination alpha. Lighting never samples its color attachment.

```mermaid
flowchart LR
    B["Background initializes SceneColor"] --> G["Geometry writes material facts and emissive SceneColor"]
    S["Standard / custom Surface"] --> G
    G --> A["SSAO"]
    G --> L["Fullscreen lighting adds radiance to SceneColor"]
    A --> L
    L --> R["SSR / fog / output / AA"]
    F["Forward-only physical and transparent materials"] --> R
```

`standard-lighting.wgsl` owns the base environment and direct-light evaluation
used by Forward rigid/skin and Deferred. The fullscreen resolve reconstructs
world position from depth, applies directional cascades, cluster lights,
Skylight/reflection environments, SH probes, material AO and screen AO. Emissive
already resides in SceneColor and is not fetched or accumulated a second time.
It submits one masked fullscreen triangle per resident reflection environment
(including Skylight), with no receiver vertex/index buffers or depth attachment.
Physical lobes that require Forward keep their existing material admission;
custom base Surface programs remain eligible for Deferred.

Environment lighting uses the split-sum DFG integral directly for single
scattering (`F0 * DFG.x + F90 * DFG.y`); an extra roughness Fresnel would count
it twice. Fdez-Aguera multiple scattering draws energy from diffuse irradiance,
including local SH, and diffuse loses the sum of single and multiple scattering.
Only directional single scattering belongs to the SSR replacement/fallback lane.
Irradiance textures already store E/pi, so there is no second pi division.

With live GI reflections, the same separation applies to transported light:
the diffuse gather supplies cosine-weighted multiple scattering, and the reflection
composite supplies directional single scattering. The existing Deferred response
texture carries single scattering times material AO in RGB and missing GGX energy
in alpha; the GI composite borrows it without allocating another texture or LUT.
Turning reflections off removes both specular lobes. Screen Probes and the field
share directional reflections, while their broad contribution follows their own
diffuse gather. SSR replaces only the directional fallback.

Image Skylights, ReflectionProbe and Atmosphere share Three r184 WebGPU's
CubeUV PMREM representation, progressive 512-sample GGX filtering and nonlinear
roughness-to-mip mapping. Seven lowest logical levels retain 16-pixel faces,
including their one-texel borders. A 128-pixel source produces ten logical levels
in a 384×512 atlas. This changes specular radiance, not Skylight's UE-style
ownership of diffuse and reflected environment light.
ForgeaX retains its image-environment BRDF LUT; Three uses a 16×16 DFG table,
also used by ForgeaX's solid environment. ForgeaX evaluates compensation on the blended
F0, whereas Three mixes dielectric and metallic compensation. Material-grid
appearance is therefore not claimed pixel-identical from the furnace gate.

When SSR needs them, the resolve also writes the exact environment fallback and
unit-radiance specular response. SSR applies one fullscreen additive delta:
`confidence * (filteredRadiance * specularResponse - fallback)`. Equal-depth
receiver overlap therefore cannot subtract the fallback more than once.
Resolved radiance has a confidence-weighted mip chain; composition samples
`roughness² * (mipCount - 1)` with trilinear reconstruction. Receiver admission
uses the current lighting coverage, compatible full-resolution normals, and
the shared View's enable/roughness cutoff. It does not clip the rough lobe to
the central mirror ray's hit confidence. Material roughness changes the
reflection's filter footprint, not just its opacity; confidence remains bounded
by the current receiver's roughness fade. Coarse mips are spatial approximations,
not separate roughness-dependent ray traces.

With DynamicResolution, the closest-depth hierarchy and all SSR trace,
resolved, radiance-history and surface-history textures follow the submitted
internal extent. Their full-resolution lattice matches the internal size;
TAAU color history and presentation retain output size. An internal-size change
resizes and resets the SSR history through its existing fence retirement path.

> [!IMPORTANT]
> SSR M0 is a consumer-only admission boundary. It reads detached producer,
> r32float format, and optional prior temporal receipts with one four-field
> integration identity. Missing required, stale, structural-only, or mismatched receipts stay
> `fallback-only` and emits zero SSR work. An admitted Standard frame then
> projects the renderer-owned M1 spatial chain and M2 history through
> `renderer.inspect().ssr`; paired Browser/Dawn pixel evidence is still the
> gate for calling the result SSR v1.

```mermaid
flowchart LR
  P["producer detached receipt"] --> A["admitSsrM0"]
  F["format stage receipt"] --> A
  T["optional prior temporal receipt"] -.-> A
  A -->|"all identity and verdict checks pass"| E["admitted: parent M1 may unlock"]
  A -->|"missing, stale, unavailable, or mismatched"| B["fallback-only: zero work"]
```

The inspection route is deliberately progressive:

| Layer | Read first | Owner action on failure |
|:--|:--|:--|
| Status | `status`, `failure.code`, `failure.expected` | branch on the closed failure code |
| Identity | `sourceHead`, `sourceTree`, `lockSha256`, `buildSha256` | rebuild the owner receipt for the current identity |
| Generation | producer `generation`, format `deviceGeneration`, temporal `generation` | discard stale completion and reinspect |
| Recovery | `failure.hint`, typed `detail.owner`, `detail.action` | use LKG/Skylight/neutral, recapture, rebuild, or retry through that owner |
| Work | attachment/pass/binding/resource/history/temporal counters | require exact zero on every blocked path |

```ts
const admission = admitSsrM0({ requested, identity, reflectionFallback, format, temporal });
if (admission.status === 'fallback-only') {
  // Read admission.failure.code and route recovery to its owner.
  console.log(admission.work); // every SSR counter is zero
}
```

After the ordinary frame, read the detached spatial projection without opening
the graph or a GPU handle:

```ts
const spatial = renderer.inspect().ssr;
switch (spatial.status) {
  case 'not-requested':
  case 'requested':
  case 'fallback-only':
    // Base probe / Skylight / neutral reflection remains visible.
    break;
  case 'structural-only':
    // The graph is admitted, but this run has no executable shader carrier.
    break;
  case 'admitted':
    // Inspect history, passRoster, fallbackSource, and coverage before evidence.
    break;
}
```

| `renderer.inspect().ssr.status` | Meaning | SSR work |
|:--|:--|:--|
| `not-requested` | Active camera has no `ScreenSpaceReflection` | Exact zero |
| `requested` | Authoring is present; M0/spatial facts are not yet complete | Exact zero |
| `fallback-only` | A closed config, lane, input, capability, or owner receipt failed | Exact zero |
| `structural-only` | Spatial admission and graph topology exist, but no executable shader source is bound | Topology only |
| `admitted` | Standard spatial path and shader manifest are bound | Inspect `history`, `passRoster`, `fallbackSource`, and coverage |

`history.state`, `history.bytes`, `history.resetCount`, `passRoster`, and
`fallbackSource` are bounded POD facts. They are evidence about the current
owner state, not an acceptance claim: M1/M2 remain an implementation checkpoint
until the paired Browser/Dawn 60-frame carrier, readback, falsifiers, and
performance gates are present.

SSR defaults are maxDistance `1`, thickness `0.1`, maxRoughness `1`, and full
internal resolution. Descriptor admission allows 128 MiB; default 1080p with
temporal history costs 116,119,892 bytes. Trace validation, confidence, roughness
filtering and temporal rejection retain their own contracts.

SSR temporal feedback and presentation use distinct coordinates without another
allocation. The persistent color/depth and oct-normal/confidence lanes use fixed,
unjittered full-resolution centers (`p + 0.5` in internal pixels).
Current trace samples are reconstructed onto that grid once; history reprojection
uses unjittered motion and validates depth/normal before interpolation. The
previous receiver depth uses perspective clip W or reconstructed orthographic
view distance; orthographic clip W is one and cannot validate history depth.
An empty receiver depth retires radiance and confidence without reconstructing
world position or sampling incompatible current/history footprints. The
separate resolved output stays on the current jittered raster grid for composition
and reflection mip generation. Never feed that presentation reconstruction back
into history: repeated jitter filtering loses reflected texture contrast.

Current trace confidence also controls history survival. A single miss keeps
at most 0.9 history weight so alternating thin coverage preserves its integrated
energy. Consecutive misses use at most 0.4 weight and retire unsupported confidence
within eight frames. A hit recovering from a miss interpolates that ceiling up to
0.9; ordinary fractional coverage retains the existing ceiling. The sign of the stored
history depth records the prior miss; rejection compares its absolute depth.
This bounded state uses the existing history alpha, with no depth precision loss.
Trace-owned source reactivity rejects invalid moving hits and reactive misses
independently of radiance confidence. When a reactive hit vanishes, the accepted
surface history propagates its last reactivity through the first miss; zero
current radiance cannot erase that producer evidence. Consecutive static misses
retire confidence within SSR; they do not reset TAA's stationary age.

The four-byte surface history stores presentation reactivity in R, canonical
GBuffer octahedral normal coordinates in GB (seven/eight bits), and fixed-grid
confidence in A. G's low bit retains the trace's fixed-grid source-reactive flag;
the presentation response is never fed back as a source flag. The current write
slot carries reconstructed source reactivity to the existing TAA secondary input.
Sampling loss and source motion remain distinct: a confidence-loss mask would
reset TAA's age at static silhouettes even when it carries only one UNORM code.
The accepted read slot stays intact on an aborted submission.
No texture, binding, history slot or pass is added.

Use `inspect -> owner recovery -> matching submit -> reinspect` as the complete
AI route. No returned field is a device, graph node, texture, buffer, encoder,
or other live handle. A stable generation keeps `resetCount`, `rebuildCount`,
and additional format probe work at zero; a changed generation must be
reinspected before admission can be considered again.

`inspect()` is a synchronous snapshot. Explicit `RendererOptions.ssrIdentity`
opts into one real format probe during initialization of each device generation;
initialization and recovery await it before the first synchronous draw. A renderer
without that option does not probe. Camera demand still controls all per-frame
SSR attachments, passes, history and uploads. An unavailable format stays
fallback-only; an absent previous temporal receipt does not block fresh spatial
SSR. Current-frame motion/coverage comes from the Standard graph. History is
read only after its normal successful-submit validation, never fabricated to
admit the first frame.

There are two action projections. `admission.failure.detail.action` is the coarse
M0 gate instruction (`retry` for demand/readiness and `rebuild` for a missing or
mismatched receipt). `reflectionFallbackInspection.recoveryAction` is the
producer's more specific source/recapture instruction. Neither is a second SSR
API; use the existing owner operation shown here, then submit and inspect again:

| Action field | Owner operation | Next observation |
|:--|:--|:--|
| `reflectionFallbackInspection.recoveryAction = use-LKG` | Keep the compatible probe row and draw the next frame | Read the committed row and matching temporal receipt |
| `reflectionFallbackInspection.recoveryAction = use-Skylight` / `use-neutral` | Change the World-owned probe/`Skylight` source, then draw | Confirm selected source and committed generation |
| `reflectionFallbackInspection.recoveryAction = recapture` / `rebuild` / `retry` | Draw again so the producer/RHI owner retries pending work | Await completion and inspect the owner receipt/failure |
| `admission.failure.detail.action = retry` / `rebuild` | Retry the consumer frame, or rebuild the named owner receipt | Reinspect required receipts and any supplied temporal receipt |
| device-loss recovery | `await renderer.recover()` before the next draw | Confirm the replacement `deviceGeneration` and its completed format probe |

SSR never invokes these operations or mutates producer/device state; this table
maps the typed action to the existing public World and Renderer seams.

### Shared view depth pyramid

`depth-pyramid/graph.ts` owns one per-view closest-depth hierarchy: an
`r32float` half-resolution mip chain of linear view depth (`+inf` = empty),
reduced with conservative floor/ceil footprints so odd extents never drop a
source texel. `addDepthPyramidPasses` records `depth-pyramid-seed` and
`depth-pyramid-reduce-chain` and returns the sampled `pyramid` view. The
pipeline adds it only when an admitted consumer reads it; a frame without a
consumer allocates nothing and records no pass. SSR trace is the current
consumer, and its admission budget counts the pyramid as `depthPyramidBytes`.
The seed/reduce sources prewarm as their own bundle
(`DEPTH_PYRAMID_SHADER_MODULES`) and install together with SSR sources.
Every reader and producer addresses a pyramid through the shared
`forgeax_depth_pyramid::sample` import: the empty sentinel, per-level extent
(`max(extent0 >> level, 1)`, portable for per-lane levels), cell lookup, and
the overlapping odd-boundary footprint. Consumers name their binding
`depthPyramid`; no consumer owns a private pyramid addressing copy.

`reduction: 'furthest'` projects the occlusion variant from the same owner:
`occlusion-depth-pyramid-seed` / `-reduce-chain` keep the farthest linear
distance per texel, and any uncovered sample makes the texel empty, so a texel
only hides geometry behind every surface it covers. It is a graph transient
sized to the view's internal depth extent; the GPU occlusion cull below is its
only consumer.

## Screen-space ambient occlusion

Enable AO through the same public Standard profile used at creation or by
`renderer.setProfile()`. It requires `renderPath: 'deferred'` for current-frame
depth and world normals; an incompatible profile returns a structured error.

The GLES fallback does not support the required raw-depth shader reads. It boots normally with AO disabled; requesting AO reports `feature-not-enabled` and requires WebGPU.

`AmbientOcclusion` is an opt-in camera companion. On a device with storage
buffers and enough deferred color attachments, its presence (or a
`ScreenSpaceReflection` request) derives the deferred Standard lane for that
selected view. The renderer's author profile remains unchanged. Each view owns
its effective configuration; removing the companion restores the installed
configuration, and display-only companions are omitted from capture-only views.
Invalid AO returns a structured `ssao-*` error without blocking an independently
authored SSR request. Incapable devices keep the base lane.

AO uses numeric closed tables: `algorithm` indexes `['ssao', 'gtao']` and
`quality` indexes `['low', 'medium', 'high']`. Radius, bias and intensity share
the existing SSAO validator. `directLightingStrength` is a finite value in
`[0, 1]`, defaulting to zero; it applies `mix(1, screenAo, strength)` to deferred
direct light, independently of material and environment occlusion. This camera
fact travels in the ordinary extracted POD across Worker boundaries.

The early SSAO upload and graph pass pack the same sampled camera projection,
its inverse and AO parameters. Camera jitter uses the same clip-space transform
as temporal projection and the View UBO, including stereo and capture lenses.
An early upload failure retains the required-upload frame abort.

The default Vite shader producer includes SSAO, so `StandardProfile.ssao` needs no build-time opt-in. A deliberately stripped manifest reports `post-process-not-found` when AO is requested; it must not silently render white AO.

```ts
const configured = renderer.setProfile({
  ...renderer.inspect().profile,
  renderPath: 'deferred',
  ssao: { algorithm: 'gtao', quality: 'high', radius: 0.25, thickness: 1, intensity: 1 },
});
if (!configured.ok) throw configured.error;
// Remove both AO passes and their per-frame upload work:
const disabled = renderer.setProfile({ ...renderer.inspect().profile, ssao: false });
if (!disabled.ok) throw disabled.error;
```

| Parameter | Contract |
|:--|:--|
| `algorithm` | `gtao` (default for both profile and companion) or explicit `ssao`; both share the depth, normal, filter and lighting route |
| `quality` | Default `high`. Hemisphere SSAO: 16 / 32 / 64 samples. GTAO: 3 slices with 2 / 4 / 6 steps per side = 12 / 24 / 36 depth candidates; high maps Three samples=16 to actual search work. |
| `radius` | Positive finite view-space distance; default `0.25` |
| `bias` | Non-negative finite view-space bias (GTAO rejects samples within this normal-plane distance); default `0` |
| `intensity` | Non-negative finite raw-visibility exponent, applied once before denoising (Three r184 `GTAONode.scale`); lighting multiplies the filtered visibility without reapplying it; default `1`; zero preserves the unoccluded image |
| `thickness` | GTAO view-space Z rejection distance, independent of normal-plane bias; default `1` |
| `distanceExponent` | GTAO radial sample distribution; non-negative finite, default `1` (linear) |
| `distanceFallOff` | GTAO horizon update attenuation in `[0,1]`, default `1`; candidate j uses mix(1, 2/(j+2), falloff) |
| `resolutionScale` | AO dimensions relative to internal scene size, `[0.25,1]`, default `1`; `0.5` opts into half resolution |
| `ssao: true` | Enables the same default parameter set |

AO runs at full resolution by default with a symmetric depth/normal-aware blur.
Compared with `resolutionScale: 0.5`, this allocates four times as many AO texels
and runs four times as many raw/filter pixels. The nominal sample setting is
not a performance equivalence claim; choose an explicit scale for the scene budget. The raw
AO target (`rgba8unorm`) carries visibility beside the center
octahedral world normal, so the 5x5 filter reads each tap's normal from that
texel instead of the full-resolution G-buffer; the blurred output stays
single-channel. Sampling
uses the raster projection, including camera jitter. Static, skinned, and
custom Standard surfaces multiply ambient illumination and the corresponding
SSR fallback by the same AO factor; direct lights remain unchanged. Material
occlusion is applied once. AO is reconstructed every frame and owns no temporal
history, so moved geometry cannot leave a retained AO image.

> [!NOTE]
> AO is a local screen-space approximation. Offscreen occluders are absent,
> and silhouettes can retain sampling artifacts, especially at reduced resolution. Use
> the plane-plus-cube example at `apps/learn-render/5.advanced-lighting/9.ssao`
> to compare contact, lift, quality, radius, and disabled behavior. GPU timings
> are opt-in via `gpuPassTiming` and receipt-bound `observe(..., { include: ['timings'] })`.

### GTAO references and accuracy boundary

| Primary reference | Used contract |
|:--|:--|
| [Jimenez et al., Practical Real-Time Strategies for Accurate Indirect Occlusion](https://research.activision.com/publications/archives/practical-real-time-strategies-for-accurate-indirect-occlusion) | Bidirectional horizon search and analytic cosine-weighted slice integration, including projected-normal length |
| [Three.js r184 GTAOShader](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/shaders/GTAOShader.js) and [GTAONode](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/tsl/display/GTAONode.js) | View-space sampling, independent quality/radius, spatial filtering without mandatory temporal history |

GTAO computes visibility from each slice's two horizons using the original
analytic integral of the blocked arcs, subtracting from the exact unoccluded
hemisphere value of one. Azimuth is uniform around the view ray, including
off-axis pixels. This avoids numerical baseline darkening on open slopes.
The normal projection retains its length; normalizing it
away biases sloped surfaces. Position reconstruction uses texel-centered native
`[0,1]` depth with top-left UVs, the current jittered projection, and parallel
view rays for orthographic cameras. Samples outside the viewport, background,
normal-plane bias, or thickness do not occlude. With default zero bias, the
normal-plane test also accounts for the bounded angular uncertainty of the
12-bit octahedral normal. Coplanar samples cannot become false occluders solely
because of normal quantization; authored bias remains unchanged. The radius places samples;
it is no longer an additional spherical rejection bound. Radial distribution,
Z thickness rejection, step-dependent horizon updates and the default 5x5
magic-square rotation (including RGBA8 quantization) follow Three r184. Static spatial noise introduces
no AO history or additional temporal reprojection owner.

The raw intensity exponent follows Three r184. The engine deliberately retains
its projected-length/open-integral correction, orthographic
rays, texel-centered reconstruction, viewport rejection and 5x5 depth/normal
filter. Three GPU returns raw AO and leaves denoising/composition to the caller;
Three GL GTAOPass installs a different Poisson denoiser. Neither is pixel-equivalent
to this filter. Unreal temporal filtering, bent normals and multibounce compensation
are not implemented by this AO path. It returns
scalar local visibility into the existing ambient-light route, not a full-image
multiply. The example accepts `?algorithm=gtao` and its algorithm selector
allows a live comparison with hemisphere SSAO at fixed lights and exposure.

Reproduce from a built contributor checkout (use the prepared shared-input
manifest when available):

```bash
pnpm --filter @forgeax/app-learn-render-5-advanced-lighting-9-ssao smoke:gtao
export FORGEAX_SHARED_APP_INPUTS_MANIFEST="$PWD/shared-build-inputs/manifest.json"
node apps/learn-render/5.advanced-lighting/9.ssao/scripts/smoke-gtao-browser.mjs
node apps/learn-render/5.advanced-lighting/9.ssao/scripts/smoke-gtao-browser.mjs --lifted
node apps/learn-render/5.advanced-lighting/9.ssao/scripts/smoke-gtao-browser.mjs --room
```

The browser checks publish a `.rhitape`, live/replay comparison, raw/filtered AO
PNGs and `gtao-verification.json`. They verify the recorded selector, current-frame
depth/normal producers, AO-to-filter-to-lighting bindings, fresh-device pixels,
and reversible scene changes. The lifted fixture requires exact white visibility
in both AO attachments. Production-shader Dawn tests independently check the
analytic integral against numerical quadrature and exercise perspective,
orthographic, jittered and odd-sized surfaces.

## Target and probe lifecycle index

The public target route is one Renderer owner: create a typed `RenderTarget`, create a
`RenderTargetTextureSource` for the material slot, initialize it through its camera writer,
request a readback ticket, draw, await `FrameReceipt.completed`, then call `observe(receipt, ...)`.
The submitted copy binds the ticket to that exact receipt; an unencoded request or another
receipt cannot consume it. Successful observation removes the ticket and releases its
staging buffer while the target remains alive. Failed encoding or submission leaves the request available to
retry. During resize, readback can still consume the accepted physical image until the
replacement writer completes. A selected `Camera.target` contributes
one capture into `Camera.targetLayer` (0 for a 2D target); `CubeCamera` contributes six real face views to the existing frame graph; a candidate becomes active only after its completed
receipt. Target captures omit material draws that sample the same target, preventing a GPU
read/write feedback loop; other submeshes remain eligible. Color captures draw opaque
surfaces followed by ordinary sorted transparency in linear target space; distance
sorting uses each capture's own camera. Each writer evaluates Fog at its surface
depth, and neither display tone mapping nor output conversion is baked into the
target. Transmission/backdrop media and depth-only feature inputs keep their
separate admission policies. `ReflectionProbe` adds bounded PMREM face/mip work, local box projection, and Skylight
irradiance fallback through the same Standard material binding path.

Use `inspect()` for bounded target/probe counts, pending work, and the last structured failure.
`inspection.reflectionProbes.selection` identifies the selected probe by `worldId` and `entityKey`,
or reports `{ kind: 'skylight' }` for the explicit fallback. `recover()` is meaningful only from `device-lost`; on a healthy renderer its structured
`renderer-state-invalid` result is a guard. Device recovery invalidates old generations and
rebuilds producer-owned physical resources, so old tickets and sources must not be reused.
For the SSR dependency producer, `inspection.reflectionProbes.reflectionFallbackInspection`
is the bounded recovery projection: its `receipt` is the committed source row selected for
the current lighting selection, while `failureStage`, `failureCode`, `expected`, and
`recoveryAction` describe the latest closed failure without exposing a texture, graph, or
device handle. `reflectionFallbackReadback` is the separate completed attachment fact; it
must match the committed row's frame and device generation before it is used as evidence.
The exact public names and stable consumer IDs are machine-readable in
`src/__tests__/render-target-public-schema.json`.

### Framebuffer region snapshot

`renderer.requestFramebufferSnapshot(target, { region, destination?, camera? })` arms a
one-shot copy of a rectangle of this frame's scene color into a 2D public target and
returns a `FramebufferSnapshotTicket`. The next submitted frame records the copy in its own
graph and submission, right after the linear-HDR scene color is final (after scene features,
before post-processing and tonemap). Pass the ticket through
`observe(receipt, { framebufferSnapshots: [ticket] })`: the result carries
`FramebufferSnapshotData` (frame, device generation, camera, region, destination and
source extent) only after `receipt.completed`. Sample the target through an ordinary
`createRenderTargetTextureSource`; it keeps the frame-N pixels until another writer
replaces them.

- **Color domain: linear-HDR `rgba16float` scene color**, a bit-exact
  `copyTextureToTexture`. The snapshot re-enters the scene as material input, so tonemap
  and output encoding apply once, on the later frame. A final-sRGB source would double
  tonemap and depend on the swapchain's `bgra`/`rgba` format. So the target must be
  `2d`, `rgba16float`, `sampleCount: 1`, `mipLevels: 1`.
- **Source selection**: with `camera` omitted, the source is the single-camera display frame.
  In a `CameraView` composite frame, name the view's camera entity key. Region and
  destination use the chosen scene color's internal pixel grid (see `sourceExtent`).
- **Visibility**: a first write into a staged or resized candidate is promoted after
  completion. An in-place write to an active target is visible to material sampling from
  frame N+1. Observation is one-shot.
- **Failures** are `framebuffer-snapshot-failed` with a closed `detail.reason`:
  - `request-invalid`
  - `target-incompatible`
  - `writer-conflict`: a second pending request, or a camera, capture or view writes the
    same target this frame
  - `source-unavailable`: no matching Standard linear-HDR scene color, for example MSAA
    or an unnamed composite
  - `source-out-of-bounds`
  - `destination-out-of-bounds`
  - `destination-invalidated`: a resize promoted a different physical before observation

  Device recovery and destroyed targets report `render-target-state-invalid` with
  operation `snapshot`. A frame that produced no receipt re-arms the request.
- **Worker publication**: renderer-local targets are snapshotted in publication-mode frames.
  Targets authored through `RenderPublicationTargetOwner.authoring` can't be named on the
  receiving Renderer, so they are not snapshot destinations.
- **Evidence**: `packages/runtime/src/__tests__/framebuffer-snapshot.browser.test.ts` asserts
  retention and RHI Debug replay. Its per-frame cost sampling is opt-in with
  `FORGEAX_SNAPSHOT_PERF=1`, which adds `perf` to `summary.dawn.json`.

### Layered targets: `3d` and `2d-array`

`RenderTargetShape` is the closed union `'2d' | 'cube' | '3d' | '2d-array'`. The layered
shapes name their slice or layer count in `depthOrArrayLayers`; `2d` and `cube` must omit
it, and `renderTargetLayerCount(descriptor)` is the one layer count every writer,
readback and source resolution indexes.

```ts
const volume = renderer.createRenderTarget({
  shape: '3d', width: 32, height: 32, depthOrArrayLayers: 4,
  format: 'rgba8unorm', mipLevels: 1, sampleCount: 1, sampled: true, readback: true,
}).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 1] } },
  { component: Camera, data: { ...perspective({ fov: 1, aspect: 1, near: 0.1, far: 40 }),
    target: world.allocSharedRef('RenderTarget', volume), targetLayer: 2 } },
);
const source = renderer.createRenderTargetTextureSource(volume, {
  aspect: 'color', dimension: '3d', mipLevel: 0,
}).unwrap(); // binds a `texture_3d` material parameter; `2d-array` binds `texture_2d_array`
const ticket = renderer.requestTargetReadback(volume, { mipLevel: 0, layer: 2 }).unwrap();
```

- **Admission** is structured: `3d` extent and slice count are checked against
  `maxTextureDimension3D`, `2d-array` layers against `maxTextureArrayLayers`, and every shape
  against `maxBytesPerTarget`: the full single-sample color mip chain, any additional
  MSAA color attachments, and one shared single-layer D32S8 depth attachment. The budget
  counts every admitted mip extent, including rectangular tails, and includes writer
  depth storage even when the descriptor omits `depth`. `3d` accepts only `sampleCount: 1`, and formats must be renderable.
- **Writers** select one layer with `Camera.targetLayer`. An out-of-range layer returns
  `render-target-layer-invalid` (`operation: 'write'`); two writers on the same layer are a
  `duplicate-target` rejection. The writer pass attaches a single-slice `2d` view for a
  `2d-array` layer, and the `3d` view with `depthSlice` for a volume slice. This mirrors
  Three.js r184 `RenderTarget3D` / `RenderTargetArray`, whose WebGPU backend maps
  `activeCubeFace` to `depthSlice` or `baseArrayLayer` in `_getRenderPassDescriptor`, and UE
  `UTextureRenderTargetVolume` / `UTextureRenderTarget2DArray`
  (UnrealEngine@71fe36a `TextureRenderTargetVolume.cpp`, `TextureRenderTarget2DArray.cpp`).
- **Budget:** the per-frame `Camera.target` budget counts targets, not writers. Every
  distinct-layer writer of the selected target records in the same frame. With the current
  budget of one target, a second layered target gets its capture in a frame where it is
  the only target with writers (selection is ordered by entity key and does not rotate).
  Each same-frame writer of one target owns its capture view uniform, so every layer
  records its own camera.
- **Sources** are dimension-exact: a `3d` or `2d-array` source binds only a parameter of
  the same dimension. Until the first write is promoted, the material samples a
  dimension-correct neutral fallback view.
- **Readback** copies one `layer` (the `3d` depth slice or the array layer), and the data
  echoes it. Resize, device recovery and generation invalidation follow the 2D rules above.
  Feedback exclusion also holds per target: a capture into any layer omits draws that
  sample the same target, so the other layers keep their content.
- **Evidence:** `packages/runtime/src/__tests__/render-target-layered.{dawn,browser}.test.ts`.
  They run 60 frames, check per-layer readbacks and material sampling, capture an RHI Debug
  tape, replay it on a fresh device, and apply a `depthSlice` falsifier.
  `render-target-layered-rhi.browser.test.ts` checks per-slice and per-layer attachment
  writes on both the `rhi-wgpu` and `rhi-webgpu` backends.

### Dynamic reflection probes

```ts
const probe = world.spawn(
  { component: Transform, data: { pos: [0, 1, 0] } },
  { component: ReflectionProbe, data: {
    halfExtents: [5, 3, 5], resolution: 128,
    updateIntent: REFLECTION_PROBE_UPDATE_ON_CHANGE,
  } },
).unwrap();
// Explicit invalidation also works for a once probe.
const current = world.get(probe, ReflectionProbe).unwrap();
world.set(probe, ReflectionProbe, {
  invalidationVersion: current.invalidationVersion + 1,
}).unwrap();
```

| Update intent | Trigger |
|:--|:--|
| `REFLECTION_PROBE_UPDATE_ONCE` | Initial capture, explicit invalidation, or probe movement |
| `REFLECTION_PROBE_UPDATE_ON_CHANGE` | Above, plus retained scene/material/geometry or light/environment changes |
| `REFLECTION_PROBE_UPDATE_CONTINUOUS` | Start another capture after the previous candidate completes |

The renderer shares **one capture face or one PMREM step per submitted
frame across all probes**, round-robin. A PMREM step filters two faces and copies
their tiles to the next level's input. A 64-pixel probe needs six raw faces plus
27 filtering steps (nine levels); the default 256-pixel probe needs 33 filtering
steps (eleven levels), for 39 completed submissions after pipeline readiness. Multiple probes
share that budget. This is amortized realtime updating, with visible latency;
it does not provide a fresh six-face snapshot every display frame. Changes
arriving during a cycle coalesce into the next cycle rather than starving
publication. Video and time-driven shader changes require continuous mode or
explicit invalidation when their producer does not update scene change evidence.

A complete candidate swaps atomically after successful GPU completion. Each
recording attempt settles its probe tickets, including early native preparation
barriers before submission. Failed submissions retry the same step, and stale
device-generation completions cannot publish. A moving probe uses Skylight fallback until a capture at its new center
is ready. Each face sees the retained authored scene, including objects outside
the display camera; authored hidden objects stay excluded. Probe specular keeps
the global Skylight diffuse color, intensity, and rotation. Shared materials
still select probes independently for each object.

Raw atmosphere faces evaluate the shared spherical transport kernel at the probe
centre, with a retained medium/solar generation. Their own camera and frozen sun
also drive capture lighting and directional CSM; a moving display sun cannot mix
new shadow matrices with old solar radiance. The display-only disc stays out of
probe IBL. Each in-flight cycle finishes before newer changes start a new one.
Other sources use the authored `SkyboxBackground` or Skylight environment.
Atmosphere changes invalidate `on-change` probes through the selected environment
signature; display-camera-only changes do not.
Environment asset readiness precedes capture. Camera-cube orientation is normalized during PMREM
production; runtime probe sampling does not apply the image-IBL Y conversion.
Place capture centers in empty space, away from the interior of opaque objects.

Fallback source receipts publish only after the actual graph output completes
on the GPU. Normal rendering performs no fallback pixel readback or hashing.
Set `captureReflectionFallbackReadback: true` on `createApp` / `createRenderer`
only for diagnostics that need `reflectionFallbackReadback`: this copies,
maps, validates and hashes the full HDR attachment each submitted frame.
Source receipts contain selection facts; the optional readback receipt contains
actual sampled pixel evidence. Submission failure preserves compatible LKG,
and stale device or source completions cannot publish either kind of receipt.

The selected probe is admitted per object, but its influence is evaluated per
shaded pixel. Pixels outside `halfExtents` use the global Skylight specular map;
the outer 10% of the box blends into that source. The global texture stays
resident alongside the local cube, including GPU-driven and custom Surface
materials. Changing either resource invalidates material binding reuse.

`boxProjection` defaults to `false`, as a general captured cubemap has no known
wall geometry. Set it to `true` only when `halfExtents` also describes a room's
reflection proxy. A small influence box around an outdoor object is not a room
proxy: forcing that correction can reflect the wrong surface even for an
otherwise valid ray. The SSR demo exposes independent SSR/probe controls and a
**Plane + cube** fixture; the Objects fixture keeps every object resting on its
floor and contains the probe receiver within the influence box.

Resolution is an actual power of two from 16 through 256. The 64 MiB admission
budget counts the raw cube, two filtered cubes, and depth attachments, with at
most 16 probes; at 256 pixels the byte budget admits five. Start at 64 or 128 for
frequent updates. `inspect().reflectionProbes.updates` reports intent, requested
and captured revision, active generation, pending work, and completion latency.
The SSR fallback source identity includes the active probe generation, so a
new environment invalidates stale SSR history. Probe capture, SSR ray tracing,
and SSR composition remain separate observable work.

## Stable inspection and dark-gradient evidence

Progressive disclosure is intentional: read Camera configuration first, then
the graph facts, backend facts, and finally the stable observation identity.
The JSON-safe `RenderInspection` projection keeps renderer lifecycle facts and
the output contract in separate named subtrees. Read `renderer.inspect().output`
for output facts; do not infer output state from renderer-level fields:

| Field | Meaning | Owner |
|:--|:--|:--|
| `output.outputTransform` | `forgeax::standard::output-transform` | Standard post chain |
| `output.displayEncoded` | final output is display encoded | Output Transform |
| `output.intermediateFormat` | linear intermediate format (`rgba16float`) | Standard target owner |
| `output.surfaceStorage` / `output.surfaceDisplay` | raw storage and display surface formats | surface adapter |
| `output.endpoint` | `surface.storage.raw` | backend adapter |
| `output.capability` / `output.error` | structured availability and recovery facts | RHI/render surface |
| `observation.observationId` / `frameId` | stable correlation refs | renderer observation owner |

### Auto exposure and 3D LUT authoring

Exposure is a Camera-owned closed union. Manual exposure is a positive
multiplier; auto exposure carries a fallback, EV compensation, bounded EV
range, and non-negative adaptation rates. The renderer owns the GPU receipt,
but the author owns the Camera input. `perspective()` / `orthographic()` project
the exposure union into the Camera's numeric SoA columns; `world.set` consumes
that POD, not the authoring union directly:

```ts
world.set(camera, Camera, perspective({
  fov: Math.PI / 3, aspect: 16 / 9,
  exposure: { kind: 'auto', fallback: 1, compensationEv: 0,
    rangeEv: [-4, 4], rates: [2, 1] },
})).unwrap();

const output = renderer.inspect().output;
if (output.autoExposure?.receipt.committed !== true) {
  throw new Error(output.error?.hint ?? 'auto exposure is not committed');
}
```

Color grading consumes an ordinary managed 3D `TextureAsset`. Create it through
`assets.create` or load it from Pack/Catalog, then bind its handle to the Camera.
Asset edits use the existing texture change and residency path. LUT bindings
reuse the accepted native texture; a replacement keeps any in-flight version alive.
Both standalone and fused tone/LUT passes read the current frame's accepted binding.
Changing texels reuses the graph and pipeline layout; changing LUT dimensions rebuilds
the graph's imported texture descriptor.

> [!NOTE]
> Render Workers resolve the LUT through the accepted asset publication.
> A source GUID is optional. Inspection reports its source key when supplied,
> otherwise the resource scope and handle identify the runtime-created LUT.

```ts
world.set(camera, Camera, {
  colorLut: lutHandle,
  colorLutStrength: 0.75,
}).unwrap();
const lut = renderer.inspect().output.standardLut;
// Match lut.sourceKey and lut.receipt.frameId to the submitted FrameReceipt.
```

`output.autoExposure`, `output.standardLut`, and `output.error` are detached
facts. A fallback or last-known-good row is a recovery observation, not proof
that a physical Browser/Dawn workload or timing gate completed.

`renderer.inspect()` and `renderer.observe()` never carry ROI pixels, scanlines,
brightness or level metrics. The hello-fxaa `hello-fxaa/dark-gradient/v1`
fixture report owns those fields and records the fixed camera, low-light scene,
800x600 resolution, 60-frame schedule, ROI, scanline, backend/lane, surface
formats, pixel hash, validation errors and mutation falsifiers.

The report gates are explicit: unique-color ratio $r_U \ge 0.75$, level ratio
$\ge 0.70$, mean absolute channel delta $\le 2/255$, parity $\ge 0.95$, and
non-black pixels with zero validation errors. The three local-only falsifiers
(`eight-bit-intermediate`, `missing-oetf`, `duplicate-oetf`) must each fail their
expected gate. Missing Browser, Dawn or WebGL2 evidence remains
`insufficient-evidence`; a screenshot, RhiNull topology result or M3 surface
contract is not a pixel proof.

## Direct-light parity contract

The direct-light proposition is: one public `DirectionalLight`/`PointLight`/
`SpotLight` semantic snapshot must produce the same analytic result in every
Standard capability lane. The authority is the revision-pinned
[`three-r184-finite-range-authority.json`](../../apps/parity/color-lighting/cases/direct-light/calibration/three-r184-finite-range-authority.json).
It is `ready` only when its Three revision, source hash, config, and expected
samples are present. Missing authority or paired GPU captures is `blocked`; do
not repair that state with a multiplier, a backend profile, or a demo asset.

Run the focused contract checks with:

```sh
pnpm exec vitest run apps/parity/color-lighting/src/analytic/__tests__/three-r184-finite-range.test.ts
pnpm exec vitest run apps/parity/color-lighting/src/integration/__tests__/light-snapshot.test.ts
```

The public mapping is deliberately small:

| Fact | Contract | Owner or evidence |
|:--|:--|:--|
| World scale | `1` world unit is `1` meter | Light components and glTF bridge |
| Exposure | `1` by default; applied after lighting at tone/output | Camera tone contract and paired capture |
| Intensity | Directional uses lux; point and spot use candela | `DirectionalLight`, `PointLight`, `SpotLight` |
| Color | Linear RGB; no hidden global multiplier | Light snapshot and buffer layout |
| Range and decay | Positive range is meters; `Infinity` means no cutoff; Point `decay` is a finite non-negative f32 exponent, default `2`; Spot remains inverse-square | Three r184 authority |
| Cone | KHR radians import to component degrees; snapshot stores `cosInner` and `cosOuter` | glTF bridge and extract |
| Direction | KHR local `-Z` after world rotation; extract normalizes once; downstream shaders consume the result | Extract snapshot and Standard shaders |

`PointLight.decay` controls the distance power independently of intensity and
range: `0` keeps only the finite-range window, `2` preserves the established
inverse-square response, and fractional values such as `1.4` are supported.
World extraction validates before f32 projection; publication admission rejects
invalid exponents. The same Point slot drives Forward, Deferred, flat receivers,
scene captures, volumes and ray reference. Changing decay invalidates selected
volume-light history. Default `2` retains the existing division path and each
consumer's safety floor (`1e-4` squared distance for surfaces, `1e-5` for local
volume integration); these near-light clamps are not Three's `0.01` denominator.

The runtime finite-range factor is the Three r184 squared window:
`clamp(1 - (d / c)^4, 0, 1)^2`. The KHR
[`three-r184-khr-calibration.json`](../../apps/parity/color-lighting/cases/direct-light/calibration/three-r184-khr-calibration.json)
curve is an explicit unsquared import/reference curve only; it is not a
substitute for the runtime authority. The squared and unsquared samples are
kept separate so a replacement remains a visible falsification.

For a blocked case, inspect the authority fixture first, then the normalized
light snapshot and the independent Forge/Three captures. The parity report
must retain `provenance`, `captures`, `raw hash`, `analyticMax`, `roiMax`, and
`verdict` for each backend x pipeline x case. A same-canvas self-comparison or
analytic-only green result is not direct-light parity evidence.

## Transmission and refraction route

Standard material transmission is consumed through the existing renderer path. Ordinary transparency
and transmission share one sorted sequence: draw the prefix before its first transmitting material,
copy the backdrop (with optional rough mips), then draw the suffix. Explicit depth-write and blend
state remain authoritative; native transmission still defaults to depthWrite=false. An authored
`LightMode: TransmissionBack` pass requests a separate backdrop and all back draws before this
sequence, allowing double-sided transmission fronts to see their backs. Weighted OIT and single-layer
medium retain their existing composition. `renderer.inspect().transmission` describes the primary
front backdrop; the graph capture exposes additional back work and resources.
Use the returned `extent`, `format`, `mipCount`, `bytes`, capability, lifecycle, and recovery fields as
the evidence source; do not create an app-local backdrop or parse diagnostic messages.

Smooth and rough refraction share the same Standard material contract. Roughness selects the renderer
owned mip path, while edge/TIR fallback resolves to environment and then unrefracted color. The direct
and clustered lanes consume the same topology and one submit.

## Layered texture mip generation

Generated mips of an authored `2d-array` texture cover every array layer in
eager upload, synchronous residency, and recovery preparation. Each layer keeps
its own mip chain and sRGB conversion. Residency uploads and managed texture
region edits record pending mip work before scene commands in the Renderer’s
single submission. Repeated edits coalesce per texture; a rejected submission
keeps that work for retry. Recovery retains its explicit submission boundary.
Packed mip uploads and `3d` mip-policy validation retain their existing paths.

## Standard sampled-texture budget

WebGPU guarantees 16 `maxSampledTexturesPerShaderStage`, counted per stage across
every bind group. An opaque Standard draw uses exactly that: 13 material textures
plus 3 View textures. The dedicated transmission layout adds transmission,
thickness, and backdrop textures and needs 21; the renderer selects it whenever the
device admits 21.

On a 16-texture device a transmissive Standard material compiles the
`TRANSMISSION_SHARED_SLOTS` variant instead. Transmission rebinds into the
`metallicTexture` pair, thickness into the `roughnessTexture` pair, and the
backdrop into the `alphaTexture` slot, so the layout and variant count stay the
same. A transmissive material that also authors one of those split scalar maps
cannot share them: it renders without refraction and the renderer reports
`MaterialSampledTextureBudgetExceededError` once per material per renderer, with
`detail.limit`, `detail.required`, and `detail.conflicts` naming the blocking
maps. Remove the named maps (packed metallic-roughness and base-color alpha still
work) or run on a device with 21 sampled textures.

`materialSampledTextureBudget(world, assets, handle, limit = 16)` resolves the
authored material passes and values with the recorder's texture-mask and transmission
admission kernels. This read-only query needs no Renderer, shader program selection
or compiler context, including for published cooked materials. It returns `{ limit, required,
transmission: 'none' | 'dedicated' | 'shared' | 'exceeded', conflicts }`, or
`undefined` for custom shaders, which own their layout. `asset.material.preview`
publishes the portable-limit result as `sampledTextureBudget` next to its oracle.

Known limitation: the shared-slot variant covers the runtime
`forgeax::default-standard-pbr` program only. A cooked Standard root with its own
program identity keeps its declared layout (the complete physical root needs 26)
and stays fail-closed at material pipeline admission below that limit.

The limit is a per-stage sum, so moving the backdrop into the View group would not
free a slot; the shared-slot variant is the whole low-limit answer.

## Subsurface surface diffusion

Opaque Standard materials author `subsurfaceRadius` as RGB support radii in presentation pixels
(each finite 0..12) and `subsurfaceWeight` as a finite 0..1 factor. The ordinary parameter schema,
MaterialAsset values, cook receipt, Catalog loading and render publication carry these values;
there is no separate profile registry. RGB radii are quantized to 12/255 pixels and weight to 1/255.
The submitted view accepts at most 16 distinct active RGB tuples; weights do not create profiles.
The existing cull query records each view's shared material selection. Later asset adoption
updates only changed paths in the fixed material tree and the selected profile counts; it never
rescans renderables to discover demand. Source captures, author-visible auxiliary captures and
the admitted display roster retain their own selection, including existing GPU-owned and
shadow-only admission. Earlier frames keep their original demand when a later edit is adopted.

```ts
const material = Materials.standard({
  baseColor: [1, 0.47, 0.32, 1],
  roughness: 0.3,
  subsurfaceRadius: [9, 6, 3],
  subsurfaceWeight: 1,
});
const selected = renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'deferred', subsurfaceQuality: 'high' });
if (!selected.ok) throw selected.error;
```

The Renderer derives demand from published material values. Zero effective radius or weight adds
no diffusion pass or target. Standard geometry stores the RGB profile and weight in a second uint
lane of the lighting-context attachment; its first lane retains the existing lighting identity.
Deferred lighting separates direct and environment diffuse from specular. One view-private compute
pass diffuses that carrier along both axes using workgroup scratch and adds its weighted difference
to RGBA32 linear HDR SceneColor before existing temporal/post work. Specular and emissive keep their
shading response. Active diffusion requires compute/storage textures, float32 HDR sampling and
blending, a write-only RGBA32F storage target, and 32 KiB workgroup storage; unsupported devices
report a structured capability error.
Its GBuffer retains receiver light channels and requires 48 bytes per sample, or 64 with visible-surface identity. Combined temporal
MRT requires 56/72 respectively; lower supported attachment capacity keeps the existing separate
temporal producer. The precision change uses the same SceneColor attachment and its actual format
for both CPU and GPU-driven geometry pipelines.

Support is single-sample opaque native Standard Deferred, including rigid/skinned and CPU/instanced
lanes. Forward, MSAA, blended materials, depth-write-disabled surfaces, GI and cube/planar capture
combinations fail explicitly. Positive demand also requires the existing Standard surface model;
unknown/custom and medium surfaces are refused. Other material shaders must publish the same
Standard root contract and Standard surface semantics.
Ordinary display and camera target views keep private depth, normal, profile and diffuse carriers.
The graph scales presentation radii by each internal/output dimension and owns fence retirement.

Neighbour taps must share the quantized RGB profile, have active coverage, agree within 0.8 normal
dot and max(0.001 m, 1% view distance) depth tolerance. Rejected taps use the centre radiance,
keeping a uniform field constant. High quality uses a normalized discrete Gaussian with sigma
radius/3 and bounded support. Low uses contiguous integer taps truncated at two sigma. The initial
alternate-offset candidate failed the impulse oracle; its raw failure remains in the
validation evidence. The revised quality/cost
curve still requires real backend acceptance.

The [ordinary resource example](../../scripts/dev-verify/roi-25-subsurface/project/assets/surfaces.pack.ts)
authors skin, wax and jade through public subpaths and procedural mesh/SceneAsset sources.
Validation contract and fixed source study records
units, budgets, oracle and unsupported combinations. Those contracts are not a backend PASS receipt.

## Diffuse transmission (thin foliage)

`diffuseTransmission`, `diffuseTransmissionColor`, and their two optional textures are a Standard
physical layer following `KHR_materials_diffuse_transmission`, the thin-surface model of the Three.js
diffuse-transmission ports. Light arriving at the back face
(`N·L < 0`) contributes `tint · max(-N·L, 0) / π` times the light radiance, and the environment adds
irradiance sampled along `-N`. Energy is split, not added: the front diffuse lobe keeps
`1 - factor` and the transmitted albedo is `factor · (1 - metallic) · tint`, so a leaf never outputs
more than its incident light. No backdrop copy, refraction, or extra pass is involved; the lobe runs
inline in the Forward and clustered Standard evaluators for directional, point, spot, rect-area, and
IBL lighting, and each light's shadow visibility scales the transmitted term too. Like every physical
layer it is Forward-only: the layer plan omits the `deferred` pass, so the Deferred resolve evaluates
zero transmission and never sees these materials.

The layer is selected by the cooked root contract. `Materials.standard({ diffuseTransmission, ... })`
authors the values, but the engine-owned `forgeax::default-standard-pbr` root is layer-free; bind the
material to a cooked Standard alias whose module id contains `::standard-` and whose parameters declare
the canonical five user-region textures plus the diffuse-transmission names. The alias compiles with
`DIFFUSE_TRANSMISSION_AVAILABLE`, and its authored physical textures take the compacted bindings from
68 upward. Author foliage with `renderState.cullMode: 'none'` so both sides rasterize.

Authored physical Standard roots use the canonical material cooker. Storage variants
publish direct and scene-index programs with reflected artifact receipts; skin roots
retain the Skin task ABI (binding 1 task output, binding 2 task address). Clustered lighting, Rect LTC and probe bindings follow the
selected program's contract. Opaque and MASK materials can use the GPU lane when
geometry, bounds and device limits admit it. Blend, backdrop transmission and
unsupported custom contracts retain their documented CPU paths. Color aliases may
compact their texture bindings; the default shadow writer uses the canonical Standard
material layout. Inspect lane admission and `shadowRaster` rather than inferring a lane
from the logical shader id.

### Factor semantics: a split, not an extra term

For a white-ish, non-metallic surface the factor partitions the diffuse energy that passes the specular
interface: reflected `(1 - factor) · baseColor`, transmitted `factor · tint`, absorbed the rest. In a
uniform white environment every side of a white leaf therefore returns the same radiance for any
factor. `factor = 1` is an ideal lossless diffuser (frosted paper, a lamp shade), not glass: it keeps no
image of what is behind it. See-through surfaces use the specular `transmission` layer
(`KHR_materials_transmission`) instead. Real leaves sit around `factor` 0.3-0.6 with a saturated tint.

Unreal's raster two-sided foliage (`TwoSidedBxDF`) and Subsurface models are additive instead: the full
front diffuse lobe stays and `SubsurfaceColor` transmission is added on top, so a white leaf under a
white sky outputs about twice its incident light. Unreal's path tracer corrects this by renormalizing
front and back albedo when their sum exceeds 1 (`AdjustPathTracingTwoSidedColorBalance`). To migrate an
Unreal foliage material to that balanced result, with `|c|` the largest channel of `c`:

```text
S         = max(1, |Base| + |Sub|)
factor    = |Sub| / (|Base| + |Sub|)
baseColor = Base / (S · (1 - factor))
tint      = Sub / (S · factor)
```

so that `(1 - factor) · baseColor = Base / S` and `factor · tint = Sub / S`. Unreal normalizes by the
largest channel of `Base + Sub`, which equals `S` whenever both colours peak in the same channel (green
leaves); otherwise clamp `baseColor` and `tint` to 1. Do not port its GGX back-scatter peak (`D_GGX(0.36, ·)`, about 2.46 at the
peak): it concentrates transmitted energy without a matching front-lobe loss. The directional term
stays Lambertian.

Evidence: `apps/hello/foliage-transmission` runs an opaque control, a uniform leaf, and a
texture-masked leaf with both lights behind them, then a white furnace: white panels at factors 0, 0.5,
and 1 under a uniform Skylight must match an opaque white control. Its Dawn smoke is falsified by
`FALSIFY=no-transmission` and by `FALSIFY=additive` (the Unreal composite), and its browser smoke checks from the RHI Debug tape that the bound pipeline
uses the diffuse-transmission module and the 68/69 layout, then compares live pixels with a fresh Dawn
replay. `pnpm --filter @forgeax/hello-foliage-transmission perf` pairs the factor-0 and factor-1 lanes
on the same alias against canonical Standard.

## Particle feature boundary

Particle rendering is provided by
[`@forgeax/engine-vfx-render`](../vfx-render/README.md). This package owns the
generic RenderFeature host, prepared graphics resolver, pipeline readiness
contract, and structured renderer errors; it does not own VFX simulation or
particle asset authoring.

The compiled feature graph retains topology and graph-imported buffers.
Material bind groups with frame-owned uniform buffers resolve from the accepted
plan at record time; their queue-fenced leases do not require a new graph.
Frame-owned vertex and index uploads are graph imports and still replace the
graph before the old allocation can retire.

## Deferred lighting evidence

Deferred lighting validation is consumer evidence, not a Render production
subsystem. The learn-render smoke exercises the Standard clustered path and
the profiler captures bounded CPU ownership evidence; the WebKit fallback
gate exercises the browser delivery path. Runtime inspection uses the public
`inspect` and `observe` projections, while any future timestamp benchmark
belongs in `packages/render/bench` and its dev-verify producer. Render does
not expose a timing controller or a second membership-specific API.

## TAA accumulation and private stability

Motion weighting follows Three r184 TRAA/TAAU: UV velocity converts to input
pixels, and 128 pixels of movement selects current color fully. Subpixel motion
uses the same fractional-pixel correction. Default current weights are 0.05
(TAA) and 0.025 (TAAU). The depth threshold remains in this engine's linear
view-distance units; Three's normalized-depth constant is not interchangeable.

TAA reconstructs unjittered current color, validates reprojected depth, and
accumulates HDR using luminance-preserving compressed-domain weights. Nine-tap
Catmull-Rom history reconstruction avoids repeated bilinear blur during camera
motion; accepted history still passes the current YCoCg neighborhood bounds. History
depth validation recognizes mixed current-depth coverage, following Three's
TRAA edge exception: background/geometry and depth-discontinuous 3x3 edges
may retain clipped history instead of alternating between accumulated and
raw current color. Uniform-depth disocclusion, absent current geometry,
out-of-bounds reprojection, invalid global history, motion and reactivity
retain their rejection or weighting behavior. The GPU coverage regression
executes the complete resolve, including the non-edge negative cases.
History clipping uses YCoCg bounds. After eight accepted stationary frames, its bounds
cover the texels supporting the reconstructed neighborhood; motion, rejection,
or reactivity resets that private age. The history still updates every frame:
this is not a frozen screenshot or an appearance acceptance claim.

At reduced internal resolution, Standard's existing output-domain coverage pass
writes `SceneTemporalV1` (`rgba16float`) instead of a binary mask. TAAU validates
geometry and reprojects motion/depth at output size, while radiance stays at
internal size. Its nearest-geometry footprint follows the actual aligned scale
and is bounded to radius three; unsupported output pixels reject history.
At every scale, the current radiance load selects the actual jittered sample
before temporal integration. Filtering current again adds another tent footprint
that broadens thin lines and attenuates textured detail. History remains filtered
for reprojection. Stability always addresses its output-sized texture. During the
first eight stationary samples after a TAA or TAAU stop, local age caps accumulation
weight, retaining one accepted prior sample on the first frame; an old global
frame index cannot retain 95% of the moving reconstruction. Moving and reactive
samples keep their existing weighting.

This changes the existing transient coverage color attachment from one to
eight bytes per output pixel, adding `7WH` descriptor bytes when TAAU is active
(55.371 MiB at 4K). It adds no pass or persistent history surface. The maturity
carrier compares all four scales against an independent 4x4 spatial HDR
integration, with local flicker, line energy, gradients and recovery gates:
`node apps/hello/taa/scripts/smoke-maturity.mjs quality|texture|motion|capture`.
Physical timing and overlap diagnostics use its `performance`, `hotspot` and
`resources` modes; prepare the canonical shared shader inputs first. Timing
results are workload dependent: an output-sized geometry gather costs more
than native TAA even when reduced scene work lowers the complete frame interval.

The private age continues to 128 accepted stationary frames without another
surface. History weight starts at 0.95 for TAA and 0.975 for TAAU through frame 64, then smoothly rises to
0.99 by frame 128 to reduce residual phase response. The eight-frame clipping
footprint remains unchanged. Clipping relaxation runs earlier, from accepted
frame 8 through frame 64, while the initial history weight still permits responsive
accumulation. Releasing it only after increasing history weight preserves a
biased clipped mean and causes prolonged static drift. Once settled, a single phase's unsupported
color does not erase accumulated subpixel coverage: clipping resumes only
after eight consecutive unsupported samples in the same signed dominant RGB
direction. Finding support or reversing direction breaks that streak.
Persistent unmarked color changes therefore restore color clipping within one
complete jitter cycle. This color correction preserves the accepted stationary
age and its reconstruction footprint; it must not collapse the next frame's
neighborhood from 5x5 to 3x3. Motion,
reactivity or rejection immediately reset
the age and restore fast recovery; this delay is necessary because zero
velocity alone does not establish settled radiance.

An optional secondary-source reactivity texture joins the scene reactive lane
before history weighting and stability counting. Standard forwards SSR's
existing hit-source mask through a typed sampled read; TAA takes a conservative
7x7 maximum at that texture's resolution. This covers the measured vacated
reflection edge missed by the former radius-one footprint; it is a bounded
dilation, not an arbitrary-speed reflected-motion guarantee. Reflected source motion can therefore
reset a stationary receiver without changing the receiver's velocity or depth.
The disabled path binds existing temporal data but does not sample it as a mask;
no extra texture or pass is allocated. The 658-frame Browser and Dawn feedback
variant checks secondary-motion reset and recovery; Dawn additionally verifies
a failing control that ignores the mask. Each cyclic input step checks the
Karis recurrence from the actual stored history against its adjacent FP16
values; an independent infinite-precision tail detects accumulated bias.
The premature high-weight counterexample must also fail. This does not establish visual
convergence or ghost-free SSR.

Color writeback stochastically selects adjacent representable FP16 values before
attachment conversion. This prevents consistently downward conversion from
accumulating a dark history bias without widening the history textures. Its
deterministic pixel/frame hash shares one RGB threshold, leaves alpha and
temporal metadata unchanged, and does not freeze the jitter sequence. Browser
and Dawn run the same 528-frame raster-feedback regression against an analytic
compressed-HDR recurrence; this precision gate is not visual acceptance.

| Ping-pong history | Format | Consumer |
|:--|:--|:--|
| Color | `rgba16float` | TAA and downstream HDR processing |
| Motion, depth, reactivity | `rgba16float` | Unchanged `temporal-v1` metadata, including Motion Blur |
| Stationary age and settled clipping streak | `r8unorm` | TAA only; never stored in the reactive lane |

The private byte uses codes 0–128 for stationary age and 129–170 for one
through seven unsupported samples in six signed RGB directions. The eighth
matching sample restores clipping while preserving stationary age. This is one encoded state,
not an additional attachment or a change to downstream temporal metadata.
Browser and Dawn raster-feedback tests cover phase-local coverage, unmarked
color steps, and a falsifier that permanently disables clipping.

These six surfaces share the existing successful-submit, abort, replacement,
and retirement lifecycle. Texture accounting is 34 bytes per output pixel;
`inspect().temporal.resources` includes active, candidate, and retiring states.
Fullscreen pipeline targets come from the declared attachment format list,
not from inspecting shader source text for a particular output structure.

## Motion Blur temporal consumer

The Standard camera enables Motion Blur by carrying the presence-enabled
component. Authoring stays bounded and validated at the component boundary:

```ts
import { MotionBlur } from '@forgeax/engine-render';

const result = world.addComponent(cameraEntity, {
  component: MotionBlur,
  data: { shutterAngle: 180, maxRadiusPixels: 32, sampleCount: 8, targetFps: 60 },
});
if (!result.ok) throw result.error;
```

| Input / state | Contract |
|:--|:--|
| Parameters | `shutterAngle ∈ [0, 360]`, `maxRadiusPixels ∈ [0, 64]`, integer `sampleCount ∈ [4, 16]`, integer `targetFps ∈ [0, 240]`; zero shutter/radius is zero work. |
| Temporal source | One renderer-owned `scene-data-temporal` sampled target. Motion validity and color reactivity are separate fields. |
| Post order | TAA resolve → Motion Blur → auto exposure/Bloom/tone output. Motion Blur never writes TAA history. |
| WebGPU/native lane | One 16×16 tile summary dispatch plus one fused reconstruction dispatch. Long vectors use an even-pixel half-resolution source lattice with depth guidance. |
| Bounded work | Effective color tiers are exactly `0|4|8|16`; metadata probes are fixed and color work is linear in the tier. There is no radius-squared neighborhood, per-pixel scatter, or atomic accumulation. |
| WebGL2 fallback | One directional raster gather, explicitly reported as `raster-limited`; it does not claim compute quality or timing parity. |

The authored integer sample count maps to one of the four execution tiers:
`4..7 → 4`, `8..15 → 8`, and `16 → 16`; a zero-work bypass is `0`. The
selected tier is the total color budget for every direction, including a
bounded fallback when all candidates are rejected. There is no implicit
center tap added to the budget.

For an uncovered moving support, accepted foreground coverage reconstructs a
bounded portion of an opaque silhouette edge rather than averaging rejected
support as black. The matching empty-background trail is attenuated by the
same fixed factor, so the correction redistributes energy and does not add
another sample. If no source is accepted, the receiver's center color remains
the conservative fallback. A recovered midpoint anchor is still only partial
evidence. Compute and raster-limited lanes share the rule without an extra
pass or radius-sized neighborhood.

Reset and recovery remain observable through the existing temporal owner:

```ts
const inspection = renderer.inspect();
if (
  inspection.motionBlur?.status === 'reset' &&
  inspection.motionBlur.resetReason === 'time-discontinuity' &&
  inspection.temporal.resetReason === 'time-discontinuity'
) {
  // The next successful draw commits the new baseline; retry the same renderer.
  renderer.draw(frameInput());
}
```

After a rejected graph or queue submit, `motionBlur.lastFailure` is
`'submit-failure'` while the previous successful temporal view remains the
baseline. A `'scene-data-unavailable'` failure means the shared
`standard-scene-data` producer or its `rgba16float` capability was not
admitted; repair that producer/capability and retry the same frame. It never
creates a private Motion Blur history target.

The renderer carries the raw host render sample timestamp through App/Worker
and accepts it only after a successful submit. A gap greater than `100 ms`
creates a `time-discontinuity` reset; a normal `30 Hz` interval remains valid,
and a failed submit cannot advance the accepted temporal clock. Pause/resume
also marks the next frame as a new baseline. Instance pose updates preserve
the last submitted transform. Collection replacement mints new identity
generations by default; a producer that keeps an instance through compaction
or reorder can pass its prior generation tokens in the new order, allowing the
record stage to pair each current transform with the real prior transform.

`renderer.inspect().motionBlur` exposes detached POD facts: status (`off`,
`active`, `reset`, `limited`, or `invalid`), selected lane, effective tier,
pass count, reset reason, last failure, and `historyWrites: 0`. Invalid public
parameters return `MotionBlurValidationError` with code
`motion-blur-invalid-params`; repair the named component field or capability
and retry the same frame. The typed cause is preserved by the public draw
result, so a caller can repair the named field without parsing `Error.message`:

```ts
const result = renderer.draw(frameInput);
if (!result.ok && result.error.code === 'motion-blur-invalid-params') {
  console.error(result.error.detail.field, result.error.detail.value);
  // Repair the component field, then retry the same frame.
}
```

The hello-taa carrier contains the Dawn, Browser, WebGL2, RhiNull, performance,
and source-level falsifier paths.

## Multiscale HDR Bloom

Bloom is a Camera-owned Standard post feature. `bloom` selects the enabled
path, while `bloomIntensity` is bounded to `[0, 8]`, `bloomThreshold` to
`[0, 65504]`, `bloomSmoothWidth` to `[0, 1]`, and `bloomRadius` to `[0, 1]`.
The defaults bloom only highlights: threshold `1` (above-white scene-linear
luminance), intensity `0.5`, smooth width `0.01`, and radius `0`. Three r184
WebGPU BloomNode instead defaults to threshold `0` and intensity `1`, which
blooms the whole frame; pass those values explicitly to reproduce it. Bloom is
off by default; the disabled value and intensity `0` are exact zero-work cases.
Enabling Bloom creates the HDR chain even with `TONEMAP_NONE`.

Migration: `bloomSoftKnee` becomes the absolute `bloomSmoothWidth`, and
`bloomScatter` becomes `bloomRadius`. Their meanings changed with the filter;
retune explicitly authored effects rather than copying the old numbers.

Game authors import this contract through the public umbrella facade:

```ts
import {
  BLOOM_ENABLED,
  Camera,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine/render';
```

The physical `@forgeax/engine-render` package remains the repository ownership
unit; it is not the recommended consumer import path.

An enabled frame stays in linear HDR and uses five progressively ceil-halved
levels, each with horizontal then vertical Gaussian filtering. The radii are
6/10/14/18/22, with sigma equal to radius/3, matching Three's truncated kernel.
The first horizontal pass fuses the half-resolution luminance highpass using
`smoothstep(threshold, threshold + smoothWidth, luminance)`. The composite
adds all five levels with weights 1/0.8/0.6/0.4/0.2; radius blends each weight
toward `1.2 - weight`. All five levels remain present even at tiny extents.
The chain has 11 passes and 11 targets, adds RGB bloom and preserves scene alpha.

The maintained comparison at `apps/parity/color-lighting/render-defaults.html`
checks production WGSL against pinned Three r184 WebGPU on the same HDR input,
including uniform gain, threshold ramps and radius 0/0.5/1. Gaussian truncation
means the uniform default gain is approximately 2.936, not exactly 3.

`renderer.inspect().bloom` is detached POD evidence from the compiled graph.
Its level dimensions, `targetBytes`, pass topology, and
`residentChildBytes` come from validated descriptors and active resource
ownership, not from an expected-size calculation. A missing, forged, or
invalid descriptor graph reports `invalid`; an off camera reports `empty` and
zero target/resident bytes. Candidate generations remain behind the existing
LKG fence and are released only after the submit fence; device recovery
rehydrates the same Bloom bundle before a new receipt is accepted.

## Camera lens flare

Add `LensFlare` to the active camera for an image-based flare: bright linear
HDR pixels are re-imaged as eight tinted, disc-blurred ghosts on the line
through the view center. The model and defaults follow Unreal Engine
`PostProcessLensFlares`; the mirrored placement matches Three.js `Lensflare`.
It needs no light entity or occlusion query, because every visible HDR pixel is
its own source.

| Field | Default | Contract |
|:--|--:|:--|
| `intensity` | 1 | Finite `[0, 64]`; 0 is the exact zero-work path |
| `threshold` | 8 | Finite `[0, 65504]` linear `r + g + b`; subtractive, so contribution fades in |
| `bokehSize` | 3 | Finite `[0.1, 10]`; disc diameter in percent of twice the view width (Unreal units) |
| `tint` | `[1, 1, 1]` | Three finite `[0, 64]` channels multiplying every ghost |
| `ghostTints` | Unreal tints | 24 finite `[0, 64]` values, one RGB triple per ghost |
| `ghostScales` | `7a - 3.5` for Unreal alphas | 8 finite `[-8, 8]`; a source at screen offset X images at `scale * X`, 0 disables the ghost |

```ts
import { Camera, LensFlare } from '@forgeax/engine/render';

world.addComponent(camera, { component: LensFlare, data: {} }).unwrap();
world.set(camera, LensFlare, { tint: [1, 0.6, 0.3], threshold: 20 }).unwrap();
```

The Standard order places `lens-flare` directly after Bloom and before
exposure, white balance and tone mapping. Three passes run per frame:
`standard-lens-flare-prefilter` thresholds and box-filters the scene into a
guard-band target covering 1.25 times the view at 1/8 density,
`standard-lens-flare-bokeh` gathers a 64-tap Vogel disc, and
`standard-lens-flare` adds the ghosts (border-masked by `DiscMask(P) *
DiscMask(0.8P)`) to the full-resolution HDR color. The gather replaces Unreal's
splat, so the guard band shrinks from 2 to 1.25 and the two low-resolution
passes touch about 2.4% of the output pixels. Alpha is preserved.
The composite interpolates four clamped bokeh texels in f32: small HDR sources
can amplify hardware filter-weight precision into visible ghost-energy errors.

The component requires the HDR chain (tone mapping or TAA) and `rgba16floatRenderable`. Absent components,
zero intensity, zero tint, or no live ghost declare no pass or target. Invalid
fields fail before graph admission with `lens-flare-invalid-parameter` and a
structured field/value/bounds detail. The shared `lens-flare.fixture.ts`
Browser/Dawn regression checks mirrored placement against a perpendicular
control, replays the composite on a fresh device against a CPU oracle, and
rejects a tape with the bokeh draw removed. Evidence is saved under
`artifacts/lens-flare/{browser,dawn}/`.
The replayed scene and bokeh inputs are retained as Float32 pixel arrays beside
the work descriptions, so oracle failures can be traced to the actual inputs.

> [!IMPORTANT]
> Render consumes the effective MaterialAsset snapshot produced by extract. Each texture slot carries its own coordinate set and transform into the built-in PBR binding layout; render records do not reinterpret authoring fields or manufacture shader artifacts. The effective `passes` are already validated.

## MaterialAsset render contract

`MaterialAsset` render input is an effective `passes` + `values` snapshot:
`parent` inheritance and texture `coordinates` resolve before `cook`; render
consumes validated cook output and returns structured `recovery` to its owner.

Material parameter slots are uploaded before graph execution so depth and color
passes consume the same frame's root storage. Each shadow submesh selects its
program entries, pipeline, material bind group, and slot offset together;
interleaving a canonical caster restores its canonical binding. Pending authored
pipelines do not fall back to a different caster, and an incomplete directional
shadow render is not admitted to the persistent shadow cache. Pipeline cache
identity includes authored entry selection while shader modules remain reusable.

Render owns this consumption route:

| Input | Render responsibility |
|:--|:--|
| `passes` and `values` | Consume the effective snapshot; do not reinterpret authoring data. |
| `parent` | Consume the already-resolved inheritance result. |
| texture `coordinates` | Bind the selected coordinate set and transform. |
| `cook` output | Record only validated shader artifacts. |
| `recovery` | Preserve the structured failure so the source contract or cooked module can be repaired. |

## Standard physical material authoring

`Materials.standard` is the public authoring entry point for the Standard
root. It emits one `MaterialAsset.parameters` contract; values and texture
coordinates are projections of that contract, not a second feature mask. A
base-only root keeps `forward + deferred + shadow`, while declaring any
second-stage layer or physical texture selects `forward + shadow`.

```ts
import { Materials } from '@forgeax/engine/render';

const material = Materials.standard({
  baseColor: [0.72, 0.48, 0.22, 1],
  metallic: 0,
  roughness: 0.34,
  clearcoat: 0.7,
  clearcoatRoughness: 0.18,
  anisotropyStrength: 0.35,
  anisotropyRotation: Math.PI / 2,
  sheenColor: [0.08, 0.03, 0.02],
  sheenRoughness: 0.25,
  iridescence: 0.5,
  iridescenceIor: 1.4,
  iridescenceThicknessMinimum: 120,
  iridescenceThicknessMaximum: 380,
  specular: 0.9,
  specularColor: [1, 0.92, 0.8],
  ior: 1.5,
});
```

The layer contract and texture semantics are fixed at the root:

| Layer / slot | Defaults | Texture facts | Pass / frame rule |
|:--|:--|:--|:--|
| `clearcoat`, `clearcoatRoughness` | `0`, `0` | `clearcoatTexture.R`, `clearcoatRoughnessTexture.G`, `clearcoatNormalTexture.RG` | coat normal needs `NORMAL + UV + tangent`; coat energy attenuates the base |
| `anisotropyStrength`, `anisotropyRotation` | `0`, `0` radians | `anisotropyTexture.RG` direction, `.B` strength | always needs a tangent frame; rotation changes the GGX highlight axis |
| `sheenColor`, `sheenRoughness` | `[0,0,0]`, `0` | color RGB is sRGB; roughness A is linear | Charlie lobe stays below clearcoat and uses existing IBL resources |
| `iridescence`, `iridescenceIor`, `iridescenceThickness*` | `0`, `1.3`, `100..400 nm` | strength R, thickness G; min may exceed max | bounded thin-film Fresnel modifies base reflection |
| `specular`, `specularColor`, `ior` | `1`, `[1,1,1]`, `1.5` | `specularTexture.A` and `specularColorTexture.RGB` (sRGB for color) | dielectric F0 uses valid IOR; metallic uses the base metal response |

> [!CAUTION]
> A missing or conflicting anisotropy tangent input returns the structured
> `material-tangent-required` error. Repair the mesh producer by supplying a
> finite `TANGENT : vec4` (including `.w` handedness), or by supplying
> `NORMAL`, the selected UV set, and triangle topology so the importer can
> generate and persist the frame. Do not substitute an identity or derivative
> fallback.

`Materials.standard({ normalScale: [x, y], bumpTexture, bumpScale })` uses
one default Surface for rigid/skinned Forward and Deferred rendering. Normal
scale defaults to `[1, 1]`; a negative Y accepts opposite green-channel
conventions. The existing tangent normal encoding uses RG and reconstructs
positive Z before scaling XY, preserving Z like Three r184's packed-normal
path. Supply linear textures and a valid tangent frame for normal mapping.

Bump samples the height texture's red channel with screen-space forward
differences and the Three r184/Mikkelsen surface gradient. Its finite signed
scale defaults to `1`; zero scale and constant height preserve the geometric
normal. Bump needs no tangent frame. Both maps retain independent UV sets,
transforms, sampler policy and physical texture extent. Normal takes priority
if both are authored, even when normal strength is zero. Back faces orient
the resulting normal consistently; vertex positions and silhouette do not change.

The glTF producer maps scalar `normalTexture.scale = s` to `[s, s]`.
`clearcoatNormalScale` remains the independent scalar coat control. Old scalar
Standard normal values migrate to two components and must be recooked. Only
authored texture slots enter an exact cooked Surface contract, so a missing
normal map cannot suppress an authored bump map. The canonical built-in shader
shares one GPU texture/sampler pair between normal and bump; their authored
presence bits and coordinate records remain independent. This preserves the
existing device resource budgets, including the 16-sampler limit.

For a texture, pass a `MaterialTextureValue` when the slot needs a sampler or
non-default coordinates; `coordinates.set` and `coordinates.transform` stay
with that slot. glTF authors use the same fields through the importer, which
preserves the chain `parse → MaterialAsset → cook → Pack refs → load`.

The public recovery path is:

```mermaid
flowchart LR
  A["inspect root and receipt"] --> B["branch on error.code"]
  B --> C["repair source, mesh, or root"]
  C --> D["re-import / re-cook"]
  D --> E["load the new generation and draw"]
```

### Standard vertex displacement

```ts
const material = Materials.standard({
  baseColor: [0.4, 0.3, 0.2, 1],
  displacementTexture: { texture: heightGuid, sampler: samplerGuid },
  displacementScale: 0.4,
  displacementBias: -0.2,
});
```

| Input | Meaning |
|:--|:--|
| `displacementTexture` | Linear red height, clamped to `[0, 1]`; sampled at mip zero with the slot's sampler, UV set, transform and physical extent. |
| `displacementScale` | Finite signed object-space amplitude; default `1`. |
| `displacementBias` | Finite signed object-space offset; default `0`. |

The shared vertex kernel applies `position + normalize(normal) * (height * scale + bias)`
before instance/world or skin transforms. This follows the
[Three.js r184 displacement formula](https://github.com/mrdoob/three.js/blob/r184/src/renderers/shaders/ShaderChunk/displacementmap_vertex.glsl.js)
for normalized heights. Color, GBuffer/depth, temporal coverage and
shadow casters sample the same level and use the same material specialization.
An absent map leaves geometry unchanged. Dynamic material changes follow the
ordinary material publication and snapshot lifetime.

Lighting normals are reconstructed from the actual displaced triangles before
normal/bump mapping. This deliberately follows mesh density, including on
curved and non-uniformly scaled meshes: it does not invent a smooth height
surface between sparse vertices. Provide enough mesh subdivisions for the
intended silhouette; a four-vertex plane cannot express an interior peak.
This feature does not tessellate meshes or move CPU mesh/picking vertices.

The extracted local AABB expands by `max(abs(bias), abs(scale + bias))` across
all materials before world/instance transforms. CPU visibility, GPU candidates
and shadow visibility consume that same detached bound; the shared MeshAsset
is never mutated. Unknown or unbounded inputs remain conservatively visible.
Displaced skins also remain conservatively visible because bind-pose bounds
cannot enclose arbitrary animated joint scale. Temporal history does not retain
previous height payloads. A material with nonzero displacement scale and a
runtime GPU/canvas/video displacement source therefore seeds current geometry
and marks motion invalid/reactive every frame, for both rigid and skinned
meshes. Mutating the source in place cannot silently claim zero deformation
velocity. A zero scale or an unrelated runtime color source keeps normal motion
admission. Static Pack heights retain ordinary transform motion; material
scale/bias changes use the existing material-revision rejection.

`displacement-temporal.dawn.test.ts` captures height, scale and bias mutations
after 60 completed frames each. It records the analytic expected height motion,
actual temporal rejection and final-image fresh-device replay together.

The regression journey is
`packages/runtime/src/__tests__/standard-displacement.{browser,dawn}.test.ts`.
It uses the production renderer, a CPU-displaced Three-formula oracle, 60
completed frames per case, and `.rhitape` capture/fresh-device pixel replay.
Artifacts are written under `artifacts/standard-displacement/{browser,dawn}`.

### Mesh material binding resolution

Render resolves one effective material table per logical mesh slot before
recording submesh draws. `MeshRenderer.materials[]` is a sparse per-instance
override vector: a missing entry or `0` inherits the corresponding
`MeshAsset.materialSlots[]` default. A slot without a declared mesh default
uses the neutral engine material.

> [!IMPORTANT]
> A declared mesh default is a required asset dependency. If it is unavailable,
> extract fails closed with the mesh GUID, slot index, and material GUID instead
> of silently painting the mesh gray. Invalid instance overrides fall back with
> a structured diagnostic; entries beyond the slot table are ignored and
> diagnosed.

The render path is `MaterialAsset` -> extract snapshot -> prepare resources -> record the per-slot `coordinates` and values. The effective `parent` is already resolved before extract. If a material contract or reflection binding fails, preserve the structured error and repair the source contract or cooked module before drawing again; that is the recovery route. The render package owns consumption, not material import or cook policy.

### Materials factory color inputs

The high-level `Materials.standard` and `Materials.unlit` factories normalize
authored colors at their boundary. Numeric RGB/RGBA tuples are linear-sRGB and
are copied unchanged; CSS/Hex strings and `0xRRGGBB` integers are sRGB inputs
and are decoded once. Use `Materials.srgb(tuple)` when a numeric tuple is known
to be sRGB. Generated assets carry `colorSpace: 'linear'`, so extraction does
not decode them a second time. The low-level `MaterialAsset` contract remains
authored-sRGB by default for serialized `type: 'color'` values; mark those
values `colorSpace: 'linear'` when they are already linear. Texture color space
continues to come from each texture asset and is not overridden by material
array metadata.

```ts
const linear = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
const css = Materials.standard({ baseColor: '#808080' });
const explicitSrgb = Materials.unlit(Materials.srgb([0.5, 0.5, 0.5, 1]));
```

### Projection and the non-PBR material family

`Materials.standard` projects its texture slots without UVs through
`triplanar: { space: 'world' | 'object', scale?, sharpness? }`: three planar
taps blended by `|n|^sharpness` (Unreal `WorldAlignedTexture`, Three.js TSL
`triplanarTexture`), with explicit position gradients per tap and whiteout
normal blending. `normalMapSpace: 'object'` decodes the normal map as an
object-space direction through `cofactor(objectToWorld)` (Three.js
`ObjectSpaceNormalMap`), exact under non-uniform scale and without tangents.

```ts
const rock = Materials.standard({ baseColor: [1, 1, 1, 1], baseColorTexture, normalTexture,
  triplanar: { space: 'world', scale: 0.5, sharpness: 4 } });
const baked = Materials.standard({ baseColor: [1, 1, 1, 1], normalTexture, normalMapSpace: 'object' });
const diffuse = Materials.lambert({ baseColor: '#c05a38' });
const clay = Materials.matcap({ texture: matcapImage, sampler });
const debug = Materials.normal();
```

| Factory | Program | Reference |
|:--|:--|:--|
| `Materials.lambert` | Standard with metallic 0, roughness 1, specular 0 (lights, shadows, IBL diffuse unchanged) | `MeshLambertMaterial` |
| `Materials.matcap` | Unlit `shading = 2`: the texture is indexed by the view normal in a view-aligned basis | `MeshMatcapMaterial` |
| `Materials.normal` | Unlit `shading = 1`: `0.5 * n_view + 0.5`, back faces flipped | `MeshNormalMaterial` |

Triplanar and object-space normals are pipeline specializations: override bits
`STANDARD_TRIPLANAR_PROJECTION_BIT` (29) and `STANDARD_OBJECT_SPACE_NORMAL_BIT`
(30) of `standardTextureMask`, so every other material keeps its UV program.
Triplanar refuses, with `material-authoring-contract-invalid` and `detail.parameter
'triplanar'`, alpha masking and the slots it cannot project (depth, shadow and
temporal coverage sample by UV); object-space normals refuse `bumpTexture`. The
ray reference refuses both with `ray-material-unsupported` rather than tracing
them by UV. Verify with `apps/hello/material-projection` (Dawn pixel gates with
five falsifiers, and an RHI Debug browser smoke that reads bits 29/30 from the
captured pipelines' fragment constants).

### Resident material observation

`renderer.inspect().meshMaterialBindings[]` is the detached observation of the
binding that the renderer actually consumed. Its `residency` projection records
`ready`, `pending`, `failed`, or `last-known-good`, plus the resolved sampler
handles, texture handles, mip counts, and the nearest structured preparation
failure when one exists. The observation is recomputed from the asset/runtime
owner during preparation; render does not keep a second readiness ledger,
infer state from URLs, or repair a producer failure. Aggregate counts are
derived from the observations, so an AI can inspect first, repair or recook the
producer, and retry without guessing at hidden renderer state.

### World-owned Instances and CPU bounds

`Instances.transforms` holds packed column-major mat4 values in World-managed
storage. Author the same field in keyed Scene assets, glTF imports, or ECS;
neither creation nor saving requires a Renderer.

```ts
const transforms = new Float32Array(20_000 * 16);
for (let index = 0; index < 20_000; index++) {
  const offset = index * 16;
  transforms[offset] = transforms[offset + 5] =
    transforms[offset + 10] = transforms[offset + 15] = 1;
  transforms[offset + 12] = (index % 100) * 2;
  transforms[offset + 14] = Math.floor(index / 100) * 2;
}
const entity = world.spawn(
  { component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: cube } },
  { component: MeshRenderer, data: {} },
  { component: Instances, data: { transforms } },
).unwrap();

// Move one instance: O(1) through projection, bounds and GPU Scene.
const matrix = transforms.subarray(0, 16).slice();
matrix[12] = 4;
world.setArrayRange(entity, Instances, 'transforms', 0, matrix).unwrap();

// Replace or resize the whole column: O(N).
world.set(entity, Instances, { transforms }).unwrap();
```

World copies external input and publishes changes through its normal component
write path. Mutating the input array after spawn/set does not edit the World.
Use `world.setArrayRange`, `world.set` or a declared writable query; do not
mutate inspection snapshots.

A row write keeps the per-frame cost proportional to the rows changed, not to
the collection size. The renderer reads the World's range evidence
(`readArrayRangesChangedSince`) and, for a proven window, validates and copies
only those rows into a detached revision that names its `dirtyRanges`. The
renderer keeps two alternating buffers per collection, so a holder must not
read revision `r` after `r + 2` has been projected. Instance CPU bounds live
in a 16-ary row-box hierarchy that refreshes only the dirty rows and their
ancestor chain; the result equals a full fold. GPU Scene visits only the
dirty transform rows, and the instance buffer uploads the dirty rows plus the
rows whose previous matrix is still stale from the prior revision. Anything
the evidence cannot prove (`world.set`, a resize, a revision gap, a new
device, a history overflow) takes the full path, whose output is identical.

| Boundary | Owner and invariant |
|:--|:--|
| Authoring and Scene save | World/Scene retains matrices, not renderer-local IDs. Saving and reopening preserves the layout. |
| Renderer projection | Current World change evidence drives the existing persistent RenderScene. Independent Renderers accept independently; stable matrices reuse the detached snapshot and revision. |
| CPU bounds and drawing | Mesh bounds, holder world transform and instance-local matrices feed one projection shared by direct, GPU-driven and capability fallback lanes. |
| Temporal identity | Ordinals retain identity across pose edits. Count changes seed new identities; previous matrices come from the last successful submission. |
| GPU lifetime | Record owns buffer capacity, upload revisions, internal chunks and device generation. No game-side collection manager is required. |
| Change evidence | An instance-only row update reports the moved rows' old and new world boxes in `GpuScene.changedSince`, so retained shadow/view caches invalidate only regions the rows crossed. Any other change reports the collection's union boxes. |

Render derives CPU union bounds from the mesh AABB and instance-local matrices,
then applies the holder's world transform. Bounds are not a second authored
field. A missing or invalid mesh AABB yields a conservative no-cull result;
repair the mesh producer and reload the same asset instead of inventing a
game-side bounds override.

Shadow cascades and Forward use the same renderer-owned instance buffer cache,
including capacity admission, dirty uploads, generation matching, and previous
transforms. A changed revision uploads once for those views; zero-count and
allocation-failure paths remain explicit.

An empty array means zero instances. Invalid stride reports
`instance-transforms-stride-mismatch`; non-finite values report
`instance-transforms-invalid` before rendering that entity. Repair the World or
source Scene data and retry. All-zero matrices are finite but have zero
homogeneous `w`; initialize valid transforms for visible geometry.

#### Instance inspection and recovery

`renderer.inspect().instanceCollections` reports detached runtime evidence.
Its `collectionId` is a private projection identity, not a Scene field or an
authoring handle. There is no public `renderer.instances` mutation API.

| Field | Meaning |
|:--|:--|
| `collectionId`, `count`, `revision` | Renderer-local projection identity, matrix count and accepted content revision. |
| `residentGeneration`, `lane` | Device generation and direct/chunked storage/uniform residency, or unresident/unavailable state. |
| `uploadRanges`, `uploadedBytes` | Upload work observed in the latest rendered frame; stable frames report zero. |
| `requestedBytes`, `supportedBytes`, `backend`, `owner` | Admission facts. The diagnostic owner label `renderer.instances` names internal residency, not a public API. |
| `error` | Structured record failure with `code`, `expected`, `hint` and `detail`. |

After `device-lost`, call `await renderer.recover()` and retry the same draw.
Recovery prepares new device resources from the retained CPU projection, without
rescanning World or reusing old GPU handles. Failed candidates release their
instance buffers. Writes made while the device is lost remain World-owned and
are observed on the next draw. Disposing the Renderer never deletes author data.

The large-instance smoke exercises the real Dawn path for all admitted sizes:

```bash
for count in 1500 10000 20000; do
  INSTANCE_COUNT=$count SMOKE_MIN_FRAMES=600 SMOKE_DURATION_MS=0 \
    pnpm --filter @forgeax/parity-instancing-static smoke
done
```

Each run must retain one logical collection, submit real work, upload on its
first resident frame, and report zero transform-upload bytes on unchanged
frames. Browser WebGPU acceptance additionally uses the browser/dev-server
transport through the same production fixture and parameterizes the same three
populations:

```bash
pnpm exec vitest run --config config/vitest.browser.config.ts --project=browser \
  apps/parity/instancing-static/src/__tests__/instances.browser.test.ts
```

The Browser test submits 600 frames for each population, asserts a real
`webgpu` backend, captures the first and stable `instanceCollections` upload
witnesses, reads the presented canvas through the browser compositor, and
requires visible spread at three or more grid samples with zero renderer/RHI
error events. Dawn structural evidence alone is not a browser validation.

## Points and Lines authoring

Points and Lines are first-class render components. Their geometry remains a
normal `MeshAsset`, and their material remains the engine-owned
`Materials.unlit` asset. The renderer validates the complete candidate before
any render publication; it does not add a second mesh, material, CLI, RPC, or
manifest authority.

```ts
import { Lines, Materials, PointShapeValue, Points, admitPointsLines } from '@forgeax/engine-render';
import { World } from '@forgeax/engine-ecs';
import type { MeshAsset } from '@forgeax/engine-types';

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
const pointMesh = {
  kind: 'mesh',
  vertices: positions,
  attributes: { position: positions },
  submeshes: [{
    indexOffset: 0,
    indexCount: 0,
    vertexCount: 3,
    topology: 'point-list',
    materialSlot: 0,
  }],
  materialSlots: [{ slotName: 'default' }],
} satisfies MeshAsset;
const material = Materials.unlit([1, 0.5, 0.25, 1]);
const world = new World();
const entity = world.spawn({
  component: Points,
  data: { size: 4, shape: PointShapeValue.circle },
}).unwrap();
const admitted = admitPointsLines({
  entity,
  points: { size: 4, shape: PointShapeValue.circle },
  mesh: pointMesh,
  material,
});
if (!admitted.ok) throw new Error(admitted.error.hint);

world.spawn({ component: Lines, data: { width: 2 } }).unwrap();
```

`Points.size` and `Lines.width` are measured in physical pixels by default. With
`sizeUnits: PointSizeUnitsValue.world` a point's size is its world-space diameter
(Three.js `PointsMaterial.sizeAttenuation`). Point sprites also take per-point data from
the mesh: the optional `color` stream (linear RGBA) multiplies the material colour, so
its alpha fades a point; the optional `uv1` stream's `u` scales the point's size; the
material's base-colour texture maps across each sprite (Three.js `PointsMaterial.map`).
Shape `soft` is a round sprite whose alpha falls to zero at the rim. The material's
render state supplies blending and depth writes, so an additive, non-depth-writing
unlit material gives Three.js `AdditiveBlending, depthWrite: false` points. Writing the
position/colour/`uv1` streams with `AssetRegistry.writeRange` moves points every frame:
a same-sized generation rewrites the expanded buffers in place and supersedes the old
expansion instead of allocating a new pair. Expansion runs on the CPU, so a few thousand
points per entity is the intended scale; GPU particle systems belong to VFX.

For Lines, with
`widthUnits: LineWidthUnitsValue.world` it is a world-space distance: each
endpoint's pixel radius derives from the camera projection and that endpoint's
depth, so perspective lines taper with distance and orthographic lines keep a
constant world width. Object scale never changes the width. Dash lengths and
offset use mesh-local units, so object scaling scales the pattern:

| Component | Field | Default | Accepted values |
|:--|:--|--:|:--|
| `Points` | `size` | `4` | finite number greater than `0` |
| `Points` | `sizeUnits` | `pixels` | `pixels` or `world` (diameter, attenuates with depth) |
| `Points` | `shape` | `square` | `square`, `circle` or `soft` (alpha fades to the rim) |
| `Lines` | `width` | `1` | finite number greater than `0` |
| `Lines` | `widthUnits` | `pixels` | `pixels` or `world` |
| `Lines` | `cap` | `butt` | `butt` or `round` |
| `Lines` | `dashSize` | `1` | finite number greater than `0` |
| `Lines` | `gapSize` | `0` | finite number at least `0`; zero renders solid |
| `Lines` | `dashOffset` | `0` | finite signed local distance; animatable |

Admission consumes one style component, one ordinary mesh topology, and one
unlit forward material. Indexed and non-indexed `point-list` meshes are valid
for `Points`; indexed and non-indexed `line-list` and `line-strip` meshes are valid
for `Lines`. A strip connects consecutive vertices in index order (or vertex order
without indices). Repeat the first vertex/index to close a boundary. Each submesh
starts a separate path; consecutive repeated positions are ignored. Native strip
primitive-restart indices are not part of this expanded mesh contract.

```ts
import { Transform } from '@forgeax/engine/scene';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';

const pathMesh: MeshAsset = {
  ...pointMesh,
  submeshes: pointMesh.submeshes.map(submesh => ({ ...submesh, topology: 'line-strip' })),
};
world.spawn(
  { component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: assets.create(pathMesh).unwrap() } },
  { component: MeshRenderer, data: { materials: [assets.create(material).unwrap()] } },
  { component: Lines, data: { width: 3, dashSize: 0.4, gapSize: 0.2, dashOffset: 0 } },
).unwrap();
// A 0.05-world-unit path with round ends and joins, as Three.js LineMaterial worldUnits.
world.spawn(
  { component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: assets.create(pathMesh).unwrap() } },
  { component: MeshRenderer, data: { materials: [assets.create(material).unwrap()] } },
  {
    component: Lines,
    data: { width: 0.05, widthUnits: LineWidthUnitsValue.world, cap: LineCapValue.round },
  },
).unwrap();
```

Import `Transform` from `@forgeax/engine/scene` and `MeshFilter`, `MeshRenderer`,
`Lines`, `LineWidthUnitsValue`, `LineCapValue`, and `Materials` from
`@forgeax/engine/render`. Use an unlit material;
points and lines never cast shadows, so admission ignores its ShadowCaster pass.
No application shader or custom render feature is needed.
Dashes accumulate local arc length across every corner of a strip and across
line-list pairs; spatial gaps between independent pairs do not add distance.
Each submesh resets the accumulation. This follows Three.js line-distance semantics. A closed path retains the authored period, so its closure may fall
inside a dash or gap. Changing style only updates the draw uniform; it does not
rebuild the mesh. Dash plus gap must fit finite f32.

With the default `butt` cap, open paths and independent pairs end flush at their
endpoints and strip corners share a miter bounded to four half-widths; extreme
turns shorten that miter rather than emitting unbounded spikes. With `round`,
open ends extend by half the width and every segment end beyond its
perpendicular is trimmed to the endpoint's circle, so ends are semicircles and
the same shared miter geometry becomes a round join without overlapping
fragments (translucent paths blend each pixel once). The end test lives in a
separate `fs_round` pipeline entry, so butt lines and points pay nothing for
it. Dashes stay butt; a round open end is drawn only where that end falls
inside a dash. A near-plane-clipped end receives no cap. Near-plane crossings clip before screen-space expansion. The
same canonical vertex layout carries endpoint, neighbor, corner and cumulative
distance through preparation, draw, capture and replay.

| Candidate | Result | Reason |
|:--|:--:|:--|
| `Points` + `point-list` + finite positive `size` + unlit forward material | supported | `square`, `circle` and `soft` shapes; optional `color` and `uv1` streams |
| `Lines` + paired `line-list` + finite positive `width` + unlit forward material | supported | each pair is one line segment |
| `Lines` with `widthUnits` `world` and/or `cap` `round` | supported | same expanded mesh; `round` selects the `fs_round` fragment entry, so butt draws never run the end test |
| `Lines` with an unknown `widthUnits` or `cap` label | refused | `points-lines-invalid-style` names the field |
| `Lines` + `line-strip` with at least two vertices | supported | joins and dash phase follow consecutive vertices |
| triangle topology, point/line mixtures, a one-vertex strip, or an odd line-list tail | refused | complete candidate admission is atomic |
| both `Points` and `Lines` on one candidate | refused | one entity has one style lane |
| `Materials.standard`, shadow-caster, deferred, or another shader module | refused for this Points/Lines lane | one engine-owned unlit forward pass is required here |
| candidate count over `maxPoints` or `maxSegments` | refused | bounded admission prevents partial publication |

When admission refuses a candidate, consume the structured result rather than
parsing its message. The result exposes `.code`, `.expected`, `.hint`, and a
code-specific `.detail` containing the relevant entity, component, mesh,
material, submesh, lane, generation, or stage facts:

```ts
const result = admitPointsLines({ entity, points: {}, mesh: pointMesh, material });
if (!result.ok) {
  console.error(result.error.code);
  console.error(result.error.expected);
  console.error(result.error.hint);
  console.error(result.error.detail);
}
```

## Standard lighting contract

`forgeax::standard` is the only built-in lighting identity. Every finite point
and spot light enters the shared Cluster membership path; `DirectionalLight`
remains global and does not consume local-light membership. `renderPath` only
selects Forward or Deferred graph topology. The derivation chain is
`LightFrame -> PreparedStandardLighting -> StandardClusterTransportPlan`, with
`packages/render/src/pipeline/standard-lighting/layout.ts` as the storage-size
and light-index budget SSOT.

Transport capability is explicit: compute/storage, CPU/storage, or CPU/integer-texture.
Raw-only surfaces retain receipt-bound `final-display` observations in a graph-owned
encoded texture and present those same pixels without a second color transform;
unobserved frames write directly to the surface.
Observation requests preserve the authored post-processing order and FXAA color
domain. When the ordinary combined output path has no linear-LDR target, a
`linear-ldr` request adds a separate tone-only readback branch; it does not replace
the displayed image's producer. Final-display capture follows the final output
and debug overlay.
Without storage buffers, one baseline `rgba32uint` texture retains the complete
96-byte light slots, cluster grid, and membership indices. It supports the same
256-light and index budgets; unsigned channel masks retain their original bits.
The renderer uploads only the rows occupied by this frame's corpus and retires
the texture with the device queue. This Forward capability lane has no SSAO
producer or unused SSAO texture binding, keeping the complete Standard material
and lighting layout within WebGL2's 16 sampled textures. Missing both usable
storage and integer-texture extent returns `standard-cluster-transport-unavailable`
with `requested` and `admitted` counts.

All transports consume the same complete CPU canonical corpus; the compute
lane materializes the GPU index list, while CPU lanes upload that list unchanged.
A Dawn readback that compares the GPU list with the canonical
corpus is the proof of GPU membership; until that readback runs, evidence is
`not-proven`, never a synthetic completion state.

Points/Lines use the existing main geometry pass with portable triangle expansion.
Native line rasterization, lit/shadow line materials, configurable cap/join styles,
and line-specific picking are outside this route.

Reference behavior is pinned to [Three.js r184 Line](https://github.com/mrdoob/three.js/blob/r184/src/objects/Line.js),
[LineSegments2](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/lines/LineSegments2.js),
and [LineMaterial](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/lines/LineMaterial.js).
Local cumulative distance, signed dash offset, positive-modulo periods,
perspective near-plane clipping and viewport-aware width follow those routes.
Engine computes distance during mesh preparation (including indexed geometry),
so authors do not call `computeLineDistances`. Solid strips use bounded miters
and butt ends rather than Line2's overlapping round caps. `gapSize: 0` selects
solid rendering without a separate dashed material or shader variant.

The shared `continuous-lines.fixture.ts` runs through Browser WebGPU and Dawn:
60 completed frames, solid and dashed paths, indexed closure, diagonal width,
negative phase updates, near-plane clipping, perspective distance, resize,
legacy points/lists, live pixels, RHI Debug v7 capture,
fresh-device replay equality and a missing-draw falsifier. Evidence is written to
`artifacts/continuous-lines/{browser,dawn}/`.

## Standard Surface authoring

`Materials.standard` is the import-first material entry for lit content. A
default call uses the built-in Surface; a custom call names one imported WGSL
Surface and provides only its root parameter contract:

```ts
import { Materials } from '@forgeax/engine-render';

const material = Materials.standard({
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

The helper publishes the complete Standard base declarations together with
the custom parameters on the returned root MaterialAsset. Compiler and loader
project that published contract without adding fields based on a Pass module.
Physical layer declarations remain sparse. A custom full-shader material does
not acquire Standard semantics by adding a shadow Pass or a `surface` slot.
When a producer also publishes `vs_main` and `vs_scene_index` for a controlled
full-custom program, the same prepared material can use the GPU-driven indirect
lane; ordinary custom WGSL without that ABI remains on its direct/specialized
lane.

The custom WGSL implements only `evaluate_surface`; it does not declare
stages, bindings, lighting, or output code. The Engine composes the result
with its Standard shader and derives the pass family: opaque base-only
materials receive Forward, Deferred, and ShadowCaster; a physical second
layer or transmission receives Forward and ShadowCaster; blending follows the
same forward-only policy. This section is about the Standard lane, not the
separate Points/Lines admission rule above. See the
[`shader Surface contract`](../shader/README.md#standard-surface-contract) and
the [`game-3d` import example](../../templates/game-3d/README.md#import-first-surface-material-example)
for the source and Pack route. Water and other participating media use the
separate [Single-layer medium Surface](#single-layer-medium-surface) ABI and
runtime route.

The compiler and renderer share one pure `StandardLayerPlan`:
`deriveStandardLayerPlan(effectiveParameters)`. It is the only derivation used
for the composed source closure, pass projection, and program identity, so a
consumer never re-infers physical layers from `SurfaceData`.

| Root contract | `StandardLayerPlan` result | Render projection |
|:--|:--|:--|
| base-only Standard | no second physical layer | Deferred plus Forward and ShadowCaster |
| Standard with a physical layer | physical layer present | Forward plus ShadowCaster |
| full-custom escape hatch | no Standard plan | authored custom pass contract; GPU-driven only with a published direct/scene-index ABI |

## Points and Lines runtime contract

The complete public closure is `MeshAsset` topology, one `Points` or `Lines`
component, `Materials.unlit`, and the Standard renderer. The owner retains the
source view, derives expanded geometry during prepare, and records the dedicated
points-lines pipeline in the active main geometry pass. Applications do not
create a second mesh, GPU buffer, shader module, cache, recovery ledger, or
backend branch.

| Surface | Supported contract | Refused or not claimed |
|:--|:--|:--|
| topology | indexed or non-indexed `point-list` and paired `line-list` | strips, triangles, mixed topology, and odd line tails |
| style | finite positive `Points.size` and `Lines.width`; square, circle or soft points; known `sizeUnits`/`widthUnits`/`cap` labels | negative, non-finite, or lane-conflicting values |
| material | engine-owned `Materials.unlit` forward material | standard/PBR, deferred, shadow-only, or custom runtime shader |
| capability lane | direct WebGPU runtime; clustered unlit preserves the same authoring contract | CPU and WebGL2 require their declared capability route; no pixel result is inferred from RhiNull |
| structural lane | RhiNull records retained projection, preparation, bindings, and draw shape | RhiNull is never hardware or pixel evidence |

Prepare and record remain one lifecycle. A failed result is an owner fact, not a
request to fall back to a generic mesh draw. Inspect the structured error and
repair the source or producer, then retry the same renderer:

```ts
const inspection = renderer.inspect();
const pointsLines = inspection.renderScene.pointsLines;
// Repair the named source or producer, then retry inspection and draw.
report(pointsLines);
```

Inspection reports source bytes, derived bytes, vertex/index counts, cache
state, upload state, draw count, lane, and the retained `lastKnownGood` state.
Recovery is `inspect -> producer rebuild or cold-cook -> prepare -> record`.
It never publishes a partial expansion and never hides a stale-generation or
missing-resource error.

For visual evidence, use the topology probe and retain its raw screenshot,
readback, source/derived byte counts, draw count, and validation errors. A
focused direct-WebGPU probe is evidence for that lane only. The repository-wide
`pnpm test:browser` gate was explicitly skipped by human override in this
milestone and must not be reported as passed; the controlled Dawn attempt
timed out during environment build before Dawn Vitest ran.

The M5 boundary does not include strip joins, caps, dashes, picking, a new CLI
or RPC operation, application-local WGSL, a second Geometry factory, or a
separate cache/recovery authority.

> [!IMPORTANT]
> Owner: render vocabulary and the extract → prepare → record frame boundary. Runtime selects concrete services and calls this package; it does not re-own these tokens.

```ts
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { createRenderer } from '@forgeax/engine/runtime';

const renderer = await createRenderer(canvas);
const attached = renderer.attach(world);
if (attached.ok) {
  world.update(1 / 60).unwrap();
  renderer.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
}
```

`attach` installs renderer-required derived-state systems once. Hosts built
with `createApp` get this wiring automatically. A custom loop attaches each
World before its first update, then keeps `draw` as a read-only consumer of the
state published by `World.update()`.

## Persistent render scene

Every attached World composition bootstraps one renderer-owned CPU projection,
then consumes each World's indexed membership and component write evidence without inspecting clean tables or blocks. One identity-based update
publication merges content, root transforms, and instance changes, including
when all occur in the same frame. Its GPU projection compares affected matrix
and metadata rows before uploading them. Shared material rows are packed once per
GPU synchronization; Primitive, DrawTemplate, and Material rows upload only when
their packed bytes change. Failed uploads retain their dirty rows for retry. An unchanged frame retains its existing
snapshot; unrelated gameplay component writes do not invalidate render state.
There is no exclusive transform/instance scene admission followed by a separate
rebuild implementation. Missing producer evidence causes conservative source
extraction into the same retained projection. World reordering and catalog
reconciliation preserve surviving slots and their submitted temporal history.

The Renderer owns one `SceneComposition`: local World extraction, publication
adoption, source rows, topology, material dispatch, Skin inputs and GPU Scene
preparation run once per Renderer frame or accepted publication. `SceneSlots`
is the unique row owner, with numeric pages over interned contents and a persistent
identity lookup; there is no write-only ECS row mirror. Each view holds a
`PersistentRenderScene` over those shared rows and retains its own camera admission,
residual roster, draw addresses, Skin recordings and successfully submitted history.
A view-specific pipeline change retires only that view's derived state. Held views
observe source changes without advancing their picture history; a new or lapsed
view catches up from the shared rows.

Live view asset consumers subscribe to the shared adoption owner for the view's
lifetime, so same-handle texture edits invalidate a sleeping view's private GI state
without waiting for it to catch up through row advances. Retirement unregisters the
consumer; reset and recovery preserve the live subscription. Changes have no replay
history, and consumer failures remain observable after sibling consumers are notified.
GPU completion still controls physical retirement. One accepted submission advances the shared GPU stamp once, independently
of how many views recorded it.

The ordinary `@forgeax/engine-ecs` Render World manages retained views, lights and
shadow views; its explicit `RenderPrepare` schedule never advances simulation time.
The publisher shrinks a column's storage once demand falls below 1/8 of a capacity
above 64 KiB, so steady deltas cross the Worker with change-sized buffers.
View transparency, Forward selection and OIT eligibility classify per Pass of
the shared material query and skip opaque Pass work unvisited. The
[change-propagation bench](bench/change-propagation/README.md) is the scale
falsifier (1M entities).

Lights are Render World entities too. The `render-lights` RenderPrepare system
reconciles each frame's extracted lights into one `RenderLight` entity per
source light: a new light spawns, a vanished one despawns, a changed one is
rewritten, and a steady frame compares in place and writes nothing. A
shadow-capable light holds its atlas layer (point cube or spot tile) for its
whole lifetime; each point face or spot view is a `ShadowView` entity linked by
`ShadowViewOf`, retaining its light-space matrix and culling planes, and
despawns with its light. Shadow view identities are `kind:layer:face`, so
another light's arrival or removal never moves or invalidates a retained
shadow. Record consumers read the retained roster (`RenderLights.current`),
whose arrays keep their identity until a light changes; each view adds only its
own directional cascade fit. A light beyond atlas capacity stays unshadowed
until a layer frees.

Shared material parameters and mesh buffers are edited through their owning
`AssetRegistry.update`, `writeRange`, or `replace`. Each write records its own
change evidence. The Renderer adopts shared resource roots without rewriting
their entity bindings; actual Pass and draw execution use fixed frame versions.
Each Renderer independently accepts changes and retains resources until its
submission completes. See the [asset contract](../assets-runtime/README.md).

Persistent CPU records use stable slot addresses, immutable 64-slot pages and
indexed identity/rank lookup. Known writes coalesce within each touched page;
removing or reusing one address never shifts surviving records. Capturing a
`SceneSlotFrame` or its raw/temporal `FrameList` does not expand all records.
Engine-owned consumers use `.at(index)` or iteration for actual queried work;
a transient view rank never becomes a source identity. Native arrays implement
the same readonly consumption interface for cold extraction and actual view
outputs.

A temporal frame captures its scene, submitted-scene, visibility, Mesh and
Material roots. Previous matrices borrow submitted immutable records. Lazy
material reads require an explicit accepted MaterialFrame; an absent accepted
version fails instead of reading a later live resource. Turning temporal work
off or resetting its baseline replaces the current memo root, while explicit
old frame readers retain their own roots and caches. Availability and probe
attachment likewise read captured roots. Diagnostic Mesh/material observations
are expanded only when inspection requests them and release their borrowed
roots on renderer disposal.

Source presence for Terrain, Glyph and Tilemap is maintained at known record
writes, rather than rediscovered by a whole-scene presence query. Ordinary
source-material selections retain their native dispatch owner/revision and Mesh
root; profile-only edits use changed shared materials. Culling may enumerate
actual visibility candidates and build a compact view output, but that work is
separate from persistent storage or change discovery. It compares/reuses
queried output during culling rather than expanding the source roster first.

These mechanisms do not establish a net performance or GC improvement. The
[change-driven audit](reports/change-driven-update-audit-20261019/README.md)
records the rejected source-only comparison and remaining rendering,
fragmentation, retirement and matched performance gates.

Camera, light, and environment facts refresh independently of geometry.
Initial attachment admits a complete baseline; later updates resolve only recorded changed identities through current entity storage. GPU dirty row addresses use fixed-width radix ordering before
adjacent ranges are coalesced. A failed GPU upload retires that resident; source
acceptance and submitted temporal history remain separate boundaries.

Instance collection revisions refresh only their consumers. Visibility and
parent changes refresh the affected subtree, and joint changes refresh the
retained skin consumers. Shadow pass facts belong to each retained renderable;
frame ownership is derived before camera culling so offscreen casters remain
available. CPU visibility and LOD consume this same projection on
every frame, including frames submitted through GPU-driven raster. No scene
classification enables a second extraction or visibility implementation.

When `RhiCaps.storageBuffer` is available, the same projection owns persistent
Primitive, Instance, Transform, and Material GPU tables. Independent stable
ranges retain instance-local transforms and prepared material records. Actual
draw and LOD inputs belong to the shared execution owner; no per-primitive
draw-template table duplicates them. The schema in `src/gpu-scene-schema.ts` derives byte offsets, signed
and unsigned scalar forms, strides, and WGSL declarations; dirty ranges become
coalesced `queue.writeBuffer` writes and no-change frames upload zero scene
bytes. Device recovery discards only device-owned tables and rebuilds them from
the retained CPU projection.

The typed render-graph evidence path imports those persistent tables without
transferring ownership, runs compute cull → compact → indirect args, and consumes
the result through a graph-owned raster pass. Companion Dawn and Chromium gates
also cover storage-buffer ping-pong, compute-generated indirect dispatch and draw
arguments, storage-texture sampling in raster, and per-mip HZB reduction. These
are real driver/pixel proofs for the GPU-driven boundary; they do not make
RhiNull a pixel backend or make the CPU projection cease to be the scene
authority.

Inspect the current path through `renderer.inspect()`. Its detached CPU snapshot exposes
full rebuilds, no-change and delta frames, transform/material/instance updates,
removals, the consumer-owned read version, projection cardinality, and the last resync
reason. The nested `gpu` status is one of `inactive`, `unsupported`, `resident`,
`rebuild-pending`, or `error`; resident state additionally reports capacity,
upload ranges and bytes, grows, clears, rebuilds, and no-change frames. The
`gpuDriven` inspection reports whether stable frames materialized or validated
GPU-owned rows and whether candidate or batch topology bytes were uploaded. Its
lifetime `residencyValidationScans` and `residencyValidationCacheHits` counters
make the CPU residency boundary auditable: an unchanged persistent frame should
reuse the producer rows, while mesh, device, pipeline, or catalog generations
force a new validation.

When the primary view has the same sources, order and renderable indices as
the retained validation projection, it reuses that producer array directly.
Frame setup reads the current GPU resource generation from its existing owner;
it does not construct the detached inspection snapshot to read that one value.

CPU culling reuses an immutable remapped dispatch entry when its source entry
at the same array position and its visible renderable index are unchanged.
Partial publications can replace the aggregate dispatch array without replacing
every draw. Changed material facts, source order or visible indices generate
new entries, so earlier in-flight frames keep their addresses. Private remapping
storage is bounded by the current source dispatch length and clears rejected
draws; it adds no global object pool or retired-source index.

`renderer.inspect().renderScene.frameCaches` exposes the lifetime hit/miss
counters of the other per-frame plan caches, each keyed on its real inputs rather
than the frame epoch. Rates come from deltas over a window; the lookup unit
differs per cache:

| Field | One lookup | Misses on |
|:--|:--|:--|
| `visibilityProjection` | one main-camera projection per frame | a changed stable-slot or draw revision, World sequence, camera view generation, or renderable/dispatch array (a new visible set or structure) |
| `temporalSnapshots` | one visible renderable's temporal snapshot per frame | a changed slot, source, submitted history or previous-visibility structure; transform-only motion rewrites the retained buffers and hits |
| `transparentSort` | one frame with at least two transparent entries | any adjacent pair of the previous order failing under this frame's keys; layer modes are camera-independent, `TransparentSort.distance` is camera-dependent and misses whenever an orbit swaps a pair |
| `renderBundles` | one drawing bundle segment per compiled scene pass per frame | a changed command in that segment, or its first bundle creation |

GPU main and shadow encoders retain each bound group across pipeline transitions.
Physical group identity and the full dynamic-offset shape still control replacement;
changing the pipeline alone does not reset logical RHI binding state. Bundle execution
retains its existing explicit state reset and self-contained segment preludes.

A static or orbiting camera over unchanged meshes should hit the visibility
projection and temporal snapshots; a persistently missing cache names the input
that keeps changing. Only transparent entries are sorted; opaque dispatch order is
never touched.

The retained direct phase qualifies camera-only DISTANCE motion against the
adjacent pairs of its existing sorted order. Their distance differences are
affine along each camera axis. Inside the qualified interval, later motion on
that same axis reuses the order and output without reading rows or evaluating
sort values. All values, including edited rows, keep one common reference eye
until that interval is left; switching axes, order crossings, invalid numeric
inputs and general multi-axis motion use the ordinary exact repair. Qualification
reads the sorted adjacent constraints once after their facts change; the
internal `DirectDrawPhase.work.orderConstraints` counter keeps that O(T) work
visible alongside `evaluated`. This reduces repeated maintenance for coherent
motion; it does not establish an O(changes) bound for arbitrary moving-camera
transparency. Global sorting across different geometry/pipeline bindings and
actual residual draw recording remain on the CPU path.

GPU and renderer contract errors arrive through the single `renderer.subscribe`
event stream (`event.kind === 'error'`); the renderer does not expose a second
error listener registry.

## Order-independent transparency

`Camera.transparency` selects how a view composites its transparent set. The
default `TRANSPARENCY_SORTED` (`0`) keeps the back-to-front `transparent` pass.
`TRANSPARENCY_WEIGHTED_BLENDED` (`1`) opts the view into weighted blended OIT
(McGuire-Bavoil 2013). Any other value throws `CameraError` with code
`camera-transparency-invalid` and `detail.field: 'transparency'`.

```ts
world.set(camera, Camera, { transparency: TRANSPARENCY_WEIGHTED_BLENDED }).unwrap();
// after a draw:
renderer.inspect().transparency;
// { requested, resolved, reason?, capability?, accumulatedDrawCount,
//   sortedDrawCount, ineligible: Record<OitIneligibleReason, number> }
```

### Method

- `oit-accumulate` draws every eligible transparent draw into two targets:
  - accum is `rgba16float`, cleared to `(0, 0, 0, 1)`;
  - weight is `r16float`, cleared to `0`.
- Both targets share one blend:
  - color `one + one` accumulates `rgb·a·w` and `a·w`;
  - alpha `zero + one-minus-src-alpha` accumulates revealage `∏(1 − a)`.
- Accumulation tests depth against the opaque depth and never writes it. Fragments with
  `a < 0.001` are discarded.
- `oit-composite` is a full-screen pass. It writes `(accum.rgb / max(w, 1e-5), 1 − revealage)`
  over scene color with straight-alpha over, and discards pixels whose revealage is `1`.
- The weight is `clamp(10 / (1e-5 + (d/5)² + (d/200)⁶), 0.01, 500)`, where `d` is the
  linear camera distance.
  - The CPU reference is `packages/render/src/oit/weight.ts`.
  - The WGSL constants in `packages/shader/src/oit.wgsl` are parity-tested against it.
- The built-in Standard PBR and Unlit programs expose the `fs_oit` (straight alpha) and
  `fs_oit_premultiplied` accumulation entries. Materials do not opt in.

### Approximation

| Contract | Result |
|:--|:--|
| Coverage `1 − ∏(1 − a)` | Exact, and independent of draw order. |
| Color | A depth-weighted average, not the exact over-operator. A single layer is exact; overlapping layers differ from sorted-over by content. |
| Draw order | No effect. The fixture's reversed-order delta is `0`. |

Measured with the cyclic three-layer fixture (red 0.6, green 0.5 and blue 0.4 interpenetrating
over gray `0.25`):
- Every backend gate holds the weighted result within `0.05` of its CPU reference. The Dawn
  `hello-oit` smoke measures a maximum delta of `2e-4`.
- The exact sorted-over reference at the left probe is `[0.63, 0.15, 0.19]`; WBOIT gives
  `[0.43, 0.28, 0.26]`.
- The sorted path changes by `0.42` between the two draw orders.

Use sorted transparency when exact layered color matters more than order independence.

### Eligibility

A transparent draw accumulates only if it satisfies all of the following. Otherwise it stays
in the sorted pass with one closed `OitIneligibleReason`:

| Reason | Kept sorted when |
|:--|:--|
| `blend-not-eligible` | Blend is neither straight over (`src-alpha / one-minus-src-alpha`) nor premultiplied over (`one / one-minus-src-alpha`). Additive and custom blends stay sorted because they have no transmittance. |
| `depth-write-enabled` | `renderState.depthWriteEnabled === true`. |
| `program-without-oit-output` | The draw is skinned, uses a non-built-in program, uses a `fragmentEntry` other than `fs_main`, or declares `renderState.outputs`. |

`classifyOitDraw` is the single classifier. Recording and inspection both call it.
View resolution looks up the validation producer's ascending renderable indices
directly (binary search for sparse rows). Camera projection and CPU LOD selection
preserve this ordering; dispatch ordering and repeated material passes are independent.

Transmission and single-layer-medium materials are not in the transparent set, so they keep
their own paths.

### Pass order and lane policy

When the view resolves to `weighted-blended` and at least one draw is eligible, the pass order is:
1. `oit-accumulate`;
2. `oit-composite`;
3. `transparent`, which holds only the ineligible residual and is present only when that
   residual exists.

Additive and effect draws therefore land over the OIT result. With no eligible draw, or under a
sorted view, the graph has no OIT pass, pipeline or target.

The sorted `transparent` pass also skips execution when its current CPU material selection is
empty. This removes an otherwise empty full-size color/depth load/store pass without changing
the compiled topology. The existing recorder selector owns that decision; adding a transparent
material resumes the pass on the next frame. A GPU-driven projection or attachment resolve
keeps the pass active, including an empty MSAA resolve. Clear-producing passes retain their
existing behavior. The Dawn gate `empty-transparency.dawn.test.ts` captures those transitions
and compares the restored pixels through Forward, Deferred and MSAA.

| Surface | Policy |
|:--|:--|
| Forward and Deferred | Both lanes share `addStandardTransparentPasses`, which runs after the opaque/deferred lighting result. |
| MSAA 4x | Accum and weight are 4x targets with 1x resolves. The composite reads the resolves and writes through the scene-color MSAA/resolve pair. |
| Memory | 10 B/px at 1x; 50 B/px under MSAA 4x (40 B/px multisampled plus 10 B/px resolve). The targets are render-graph leases and are counted in `renderGraphResourceAllocation.liveBytes`. |
| TAA | The composite is a transparent contributor with the same treatment as the `transparent` pass. |
| Fog, DoF, outline, post | Unchanged: they consume the composited scene color. DoF keeps `opaque-depth-approximation`. Outline keeps depth-write-off transparents as non-occluders. |
| Target captures (cube faces, planar reflection) | Stay sorted. |
| GPU-driven lane | Carries no transparent draws, so it is unaffected. |

### Capability and fallback

| Backend | Result |
|:--|:--|
| WebGPU (browser) | Forward, forward MSAA and deferred are pixel-tested. |
| Dawn | Forward, forward MSAA and deferred are pixel-tested, plus capture and replay. |
| rhi-wgpu (WebGL2) | Forward and forward MSAA are pixel-tested (`oit-webgl2.browser.test.ts`). Deferred is independently not admitted on WebGL2. |
| Any device with `caps.rgba16floatRenderable === false` | Resolves `sorted` with `reason: 'capability-absent'` and `capability: 'rgba16floatRenderable'`. |

The gate is capability data, never `backendKind`. The only view-level reason is
`capability-absent`. The shared-blend layout needs no independent-blend capability.

### Inspection and evidence route

- `renderer.inspect().transparency` gives the requested and resolved mode, any fallback
  reason, and draw counts per reason.
- `perFramePassNames` shows `oit-accumulate` and `oit-composite` only when they run.
- In an RHI Debug tape:
  - the accumulate works have fragment entry `fs_oit` (or `fs_oit_premultiplied`) and target
    formats `['rgba16float', 'r16float']`;
  - the composite work is `fs_oit_composite` and binds both accumulation views.
- Under MSAA, `WorkEntry.attachments.colorResolveViewHandleIds` names the resolved views.
  `readResourceAtWork` then reads accum, weight and scene color before and after the composite.

Permanent gates:
- `oit.dawn.test.ts`: pixel reference, order independence and the
  sorted falsifier.
- `oit-capture.dawn.test.ts`: capture, fresh-device replay and target readback.
- `oit-transparency.integration.test.ts`: fallback, reasons, lifecycle and device loss.
- `oit-weight.unit.test.ts`: weight parity and the classifier.
- `oit-webgl2.browser.test.ts`: the same pixel gates on rhi-wgpu WebGL2 (forward, 1x and MSAA).
- `apps/hello/oit`: 60-frame Dawn smoke.
- `bench/oit-transparency.bench.ts`: CPU cost of the transparent sort and OIT classification.
- `pnpm gpu-pass-timing:oit`: paired sorted and weighted-blended pass timings at 1920x1080 for
  low and high overdraw, with a NaN/Inf scan. The report records `realGpu`; software
  rasterizers can defer raster work outside a pass's timestamp pair, so on them compare the
  draw-to-completion wall time.

### Grounding

- **Unreal Engine.** Unreal ships SortedTriangles and SortedPixels (MLAB), not WBOIT.
  SortedPixels needs rasterizer-ordered views for deterministic results. WebGPU has none,
  so an MLAB or k-buffer port would depend on atomic order and break order independence.
  The forgeax design takes Unreal's view-level switch (`r.OIT.SortedPixels` is a project/view
  setting), its blend-mode eligibility table, and its front-to-back composite equation.
- **three.js r184.** It has no OIT. It sorts transparents with `reversePainterSortStable` and
  draws them in a double pass. The forgeax `sorted` default is that baseline. WBOIT is the
  opt-in path that removes the order dependence three.js leaves to authors.

## Alpha Hash

`Materials.standard({ baseColor: [0.2, 0.7, 0.1, 0.5], alphaHash: true })`
and `Materials.unlit([1, 1, 1, 0.5], { alphaHash: true })` enable stochastic
coverage for foliage, fences and object fades. The default is `false`.
Base-color texture alpha, vertex alpha and material alpha multiply before the
hash comparison; `alphaCutoff` remains an additional hard mask when authored.
Keep the ordinary opaque queue, blending disabled and depth writes enabled.
Surviving fragments write ordinary depth, so submission order does not require
transparent back-to-front sorting. This is a noisy coverage approximation.

| Path | Coverage contract |
|:--|:--|
| Standard Forward / Deferred / depth | Shared default Surface evaluates the hash before committing coverage. |
| Standard rigid / skin / GPU Scene shadow | The same Surface consumes object-space position and the selected material row. |
| Unlit color / shadow / temporal | One hash helper consumes the same position and effective alpha. |
| Temporal metadata | Hash discard precedes motion output; fractional stochastic opacity alone does not mark surviving samples reactive. |

The algorithm follows [Three.js r184 Alpha Hash](https://github.com/mrdoob/three.js/blob/r184/src/renderers/shaders/ShaderChunk/alphahash_pars_fragment.glsl.js):
object-space noise, derivative-selected adjacent logarithmic scales, CDF
correction and scale `0.05`. Degenerate derivatives and exact octave boundaries
remain finite. There is no frame seed. Camera TAA jitter changes the samples;
`Camera.antialias = 3` enables the existing TAA resolver.

> [!NOTE]
> Color and shadow cameras generally have different projections and texel
> footprints. They share the coverage rule and opacity, not an identical
> pixel mask at different resolutions. Coincident object-space surfaces can
> share noise; Alpha Hash is not exact order-independent alpha compositing.

The permanent `alpha-hash.dawn.test.ts` fixture
measures coverage and TAA through the Renderer. Dawn retains the v7 tape,
work indices, fresh-device replay inspection and raw readbacks under
`artifacts/alpha-hash/`. These targeted checks supplement the required core
Browser, Dawn and 60-frame hello/learn smoke gates.

## GPU-driven PBR / shadow / skin navigation

The shortest public declaration uses the same `Materials.standard` producer as
the runtime and imported-skin carriers. `alphaCutoff` is the Alpha Mask
contract, and the factory always publishes the matching ShadowCaster pass;
per-entity casting belongs to `ShadowParticipation`.

Frame preparation and device recovery share the material-artifact collector.
It indexes ShadowCaster dispatch once by renderable index and material handle;
the selected last matching dispatch owns both the program identity and its
vertex/fragment entries. Per-draw lookup does not rescan the dispatch roster,
and the index is rebuilt for each collection so replacement publications are
observed without a persistent cache.
Within a collection, the selected program request and entry projection are
resolved once across the visible and shadow receiver lists. Pass, skin,
vertex-color, logical material, scene-index program and entry selection remain
distinct; receipt and vertex-input admission still run for every receiver.
ProbeBlend binding decisions are reused only while their published source
matches the selected WGSL. Direct rendering, GPU Scene and recovery use this
same source check.

Fullscreen graph and pipeline signatures retain a content digest for each
unchanged source instead of serializing WGSL every frame. Parameters, default
bytes, resource reads, storage bindings and entry selection remain part of the
declaration identity. Source edits, including same-length replacements, rebuild
the digest. The weak cache retires with the declaration.

For real CPU submission and completed-frame measurements, use the
[repeated Dawn comparison](../../scripts/bench/standard-deferred.md). It covers
both Standard render paths without treating software GPU FPS as hardware FPS.

```ts
import { Materials } from '@forgeax/engine/render';

const material = Materials.standard({
  baseColor: [1, 1, 1, 1],
  alphaCutoff: 0.5,
});
const materialHandle = assets.create(material).unwrap();
void materialHandle;
```

| Candidate | Main GPU lane | Shadow GPU lane | Closed result |
|:--|:--:|:--:|:--|
| Standard opaque or Alpha Mask, finite resources | supported | supported | `gpu` |
| Standard skin with finite current-pose bounds derived from Mesh joint envelopes and the current shared joints | supported | supported | `gpu` |
| Active morph (`MorphWeights` over Mesh `morphTargets`), program whose scene-index vertex entry reads the GPU Scene morph inputs | supported (Mesh batch) | supported (Mesh batch) | `gpu` |
| Skin pose bounds unavailable (missing CPU attributes, non-finite inputs, or singular mesh transform) | refused | refused | `cpu-deformation` |
| Capable resource/pipeline not ready | refused | refused | `blocked` (`resource-not-ready`) |
| Blend, transmission, custom without a published ABI, or unsupported topology | refused | refused | `cpu-semantic` |
| ABI-backed custom Surface/full-custom row within the producer page | supported | supported when a ShadowCaster ABI is published | `gpu` |
| Engine Unlit, rigid, opaque queue (`< RenderQueue.Transparent`), declared material program | supported | supported (`vs_shadow` light projection) | `gpu` |
| Engine Unlit skinned, blended, `Transparent`/`Overlay` queue, or the program-less fallback snapshot | refused | refused | `cpu-semantic` |

Unlit admission is the producer receipt: only the rigid
`GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true` Unlit variant publishes a scene-index
entry, and its row is the schema-derived Unlit uniform layout. GPU batches encode
before the CPU list, so a later-queue pass such as an x-ray overlay keeps its
direct order.

Morph weights are GPU Scene row inputs. Each Mesh version's target deltas live
once in the shared input arena (`MeshGeometry.morph`); each morphed row owns a
`(vertexCount, targetCount, deltas, weights...)` descriptor named by its instance
row's `customDataStart` (0 = no morph). The arena uploads changed words only, so
a weight edit is one row-sized write and steady frames upload nothing. Standard,
Standard skin and shadow-caster scene-index vertex stages add the weighted deltas
to the position before skinning and transforms (`sceneIndexMorphPosition`, group 3
binding 8). Morphed rows therefore share one batch per Mesh, material and pass
(`morph` in the batch key and binding) and draw LOD0. A morph batch takes the GPU
route only when the selected program's reflected vertex reads include that
binding; otherwise it records directly. Direct draws (CPU lane, captures, direct
batches) bind a per-entity deformed stream from `GpuResidencyCache.morphGeometry`
(compute when available, else CPU). Extraction expands the authored bounds by the
weighted per-axis target deltas. Motion vectors follow the rigid transform only;
morph weights carry no previous-frame state.

Skin publishes one static ordered joint Binding and shared presentation matrices.
A joint edit changes one shared row without revisiting its Skin consumers. Actual
pre-cull work derives current-pose bounds from shared Mesh influence envelopes;
it does not retain a per-character vertex copy or synchronized palette. The
mesh-node transform is not applied a second time to world-space Skin results.

Cook certifies `MaterialProgramAbi.positionBounds: 'standard-input'` only for
trusted Engine vertex templates with their validated input/displacement and
linear Skin contract. Every selected Pass must carry that proof. Paired Skin
vertex inputs establish layout capability alone. Unknown custom vertex programs,
missing poses, active morphs and unsupported weights or arithmetic remain
uncullable; bind-pose bounds never substitute for missing proof. The former
`MeshRenderer.conservativeSkinBounds` option is removed with the exact/per-Skin
bounds owner.

This policy can admit extra invisible geometry. It preserves the original mesh, pose,
materials, shadows and animation; evaluate the extra culling admissions against the
saved CPU work for the target scene.

Authored bind-pose bounds cannot replace this current-pose enclosure. Each palette
receipt retains a detached bounds snapshot, including when its GPU allocation is reused.
When this projection is unavailable, the Skin remains conservatively visible on the
CPU admission path rather than falling back to the static Mesh envelope.

The custom row is deliberately about the published producer contract, not a
shader-name allowlist. A custom program is eligible only when its cooked receipt
contains matching direct/scene-index entries, reflected resources, vertex inputs,
and a schema-derived row no larger than the canonical Standard GPU Scene row. Custom
storage-buffer resources, renderer-local/video sources, and pass attachments that
have no corresponding prepared owner remain on their specialized lane until that
owner publishes the missing binding and recovery contract. The legacy
[`custom-shader` demo](../../apps/hello/custom-shader) is direct-only by design;
it does not publish `vs_scene_index`, so it is not evidence for the indirect lane.

Clustered local lights and SSAO use the same group-2 lighting bindings in direct
and scene-index programs, including custom Surface programs. These switches do
not disable GPU-driven admission. SSAO requires `renderPath: 'deferred'` to
produce depth and normals. SSR's fallback MRT selects the corresponding
scene-index fragment variant; background probe capture preserves the display
view's GPU submission. Each pass selects its own material slots and color
attachments. Shared materials at different local probes retain separate binding
classes so deduplication cannot substitute one object's reflection environment.

On devices without storage buffers, Standard Forward projects the complete prepared
Cluster membership and 96-byte local-light records through `rgba32uint` textures.
Point, Spot and Rect lights retain the same BRDF, shadows, modifiers and unsigned
lighting-channel predicate. Texture extent admission and the author-selected light
budget fail before upload when the complete payload cannot be represented; no light
is silently dropped and there is no separate four-point policy.

### Static TextureAsset admission

Static PBR and Alpha Mask resources are admitted only from registered shared
`TextureAsset` and `SamplerAsset` payloads. The resource-class identity is the
sorted handle-pair projection used by the prepared material; it is not an
array-position guess. Dynamic `RenderTargetTextureSource` and video sources
remain their own CPU semantic boundary and are never coerced into a static
GPU texture candidate.

The focused topology fixture allocates and resolves real static shared refs for
resource classes `1`, `16`, and `256`, then builds `100,000` candidates for each
class. It is structural admission evidence, not a physical-GPU benchmark:

```sh
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm exec vitest run --project=@forgeax/engine-render \
  packages/render/src/__tests__/gpu-driven-batch-topology-pbr.unit.test.ts \
  --no-file-parallelism --reporter=dot
```

### Point and Spot shadow authoring → view inspection

`PointLight` and `SpotLight` shadow views are public light facts, not a hidden
GPU slot API. A Spot author declares a companion `Transform`, outgoing
`direction`, cone angles in degrees, and the embedded shadow policy:

```ts
import { SpotLight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

world.spawn(
  { component: Transform, data: { pos: [0, 5, 0] } },
  {
    component: SpotLight,
    data: {
      direction: [0, -1, 0],
      range: 20,
      innerConeDeg: 15,
      outerConeDeg: 35,
      castShadow: true,
      mapSize: 1024,
      pcfKernelSize: 3,
    },
  },
);
```

| Author fact | Contract |
|:--|:--|
| `direction` / `Transform` | Outgoing direction plus the light position; both are required for a useful view |
| `range` | World units; default `Infinity` (no distance cutoff). Finite ranges bound cluster membership. |
| `innerConeDeg` / `outerConeDeg` | Degrees; `0 ≤ inner ≤ outer ≤ 90`, outer > 0, defaults `0` / `60` (KHR inner default: falloff spans the cone, so setting only `outerConeDeg` is always valid). Equal angles give Three's penumbra-0 hard cone. |
| `castShadow` | Defaults `false`; set `true` to request shadow maps |
| `nearPlane`, `farPlane` | Shadow projection defaults `0.5` / `500` for PointLightShadow and SpotLight. Positive finite light range replaces far; unlimited range uses far. Effective far must exceed near. |
| `mapSize`, `pcfKernelSize` | Shadow map resolution and odd PCF width; defaults `1024` / `3` |
| `cookie` / `projector` | Optional GUID-backed static texture facts; dynamic target/video sources stay outside GPU admission |

Spot `depthBias`, `normalBias` and `pcfKernelSize` are live per-frame values
with normalized reverse-Z depth bias (default 0.00001) and world-space
normal bias (default 0.05). Generated Unlit/Standard shadow passes reverse
single-sided color culling, as Three's non-VSM shadow side does; double-sided
materials retain both faces. Explicit custom ShadowCaster passes keep their
authored raster state.

RectAreaLight defaults to a 10 by 10 emitter with unlimited range (`Infinity`),
matching Three's unbounded area light. A finite positive range is an explicit
ForgeaX cutoff; color and intensity remain white and 1.

Bare-engine Directional and Spot lights default to `castShadow: false`; the
`game-3d` template explicitly enables its sun. Point lights still require the
`PointLightShadow` companion. No renderer-wide switch is needed. Meshes without
`ShadowParticipation` cast and receive once a light requests shadows; add the
component with `cast: false` / `receive: false` to opt out per mesh. This retains
a simpler participation contract than Three's renderer/light/mesh switches,
while matching its default absence of shadow-map work. Existing examples and
shadow fixtures explicitly enable their lights to preserve their scenes.

#### Surface direct-light channels

`MeshRenderer.lightingChannels` and `DirectionalLight` / `PointLight` /
`SpotLight` / `RectAreaLight.lightingChannels` author independent 32-bit masks.
A surface receives a light's direct diffuse/specular radiance exactly when
`(receiverMask & lightMask) !== 0`. The default is `LIGHTING_CHANNELS_DEFAULT`
(`0xffffffff`) on both sides; zero receives/emits no surface direct light.
Use `0x80000000` for channel 31: JavaScript's `1 << 31` is negative and invalid.
Camera visibility is independent. Each entity's mask applies to all its material
sections and authored `Instances`; separate entities sharing one GPU batch retain
separate masks. Standard opaque, alpha-clipped, physical, blended and skinned
writers and custom **Surface** programs composed into Standard use that same
matching predicate. A fully custom MaterialPass must consume the public shader
carrier and predicate explicitly; its lighting code remains the author's owner.

```ts
// Character fill and character receiver share channel 1.
world.set(fill, PointLight, { lightingChannels: 2 }).unwrap();
world.set(character, MeshRenderer, { lightingChannels: 2 }).unwrap();
world.set(environmentMesh, MeshRenderer, { lightingChannels: 1 }).unwrap();
```

Author fields use `f64` ECS storage to retain every u32 bit **and** invalid inputs
until validation. ECS rejects NaN through its existing
`component-numeric-value-invalid` write error. Render rejects fractional, negative,
infinite and overflowing values with `resource-invalid-value`, `detail.receivedKey: 'lightingChannels'`;
no signed wrapping, clamping or float rounding can turn an invalid input into a
valid channel. GPU storage is integer: directional View byte 76, local-light
96-byte slot byte 80, direct Mesh surface row byte 152 (uniform fallback byte 72),
and the unchanged 64-byte GPU Scene primitive byte 44. Runtime writes follow the
existing World change evidence and native publication; captures and independent
CameraViews read the same accepted scene projection.

Deferred location 5 is `rg32uint`: R retains the packed raster normal and Terrain
shadow-family bits, G stores the receiver mask without normalization. This adds
4 bytes/pixel to the prior G-buffer (24 bytes/pixel surface, 32 including SceneColor).
Forward keeps the existing 256-byte aligned Mesh slots; the shader storage row
now includes its 16-byte integer surface tail. There is no extra scene, light list,
render pass or queue submission per channel.

Channels change **receiving direct light**, not casting shadows. Every admitted
caster still enters its existing directional/spot/point producer regardless of
its receiver mask; `ShadowParticipation.cast` remains the independent author
switch. A matching light's direct term retains its ordinary shadow visibility;
`ShadowParticipation.receive: false` still skips that sampling. RectArea has no
shadow producer. Emissive, Skylight/IBL, baked lighting, GI, atmosphere/fog volume
scattering and the opt-in ray reference do not inherit channels. Sprite-lit and
VFX lighting do not consume the MeshRenderer receiver mask. Comparisons with the
ray reference must use all-match surface lighting.

#### Per-entity shadow participation

`ShadowParticipation { cast, receive }` is the single per-entity switch:
`Materials.standard` / `Materials.unlit` always emit a ShadowCaster pass and have
no casting option. It maps to Bevy `NotShadowCaster` / `NotShadowReceiver`. An
entity without it receives, and casts unless every material on it blends
(transparent or additive `renderState.blend`): blended-only meshes such as light
beams, glows and glass cast nothing by default, as with Three.js
`castShadow = false`; author `ShadowParticipation { cast: true }` to make one cast. `cast: false` removes the entity
from every directional, spot and point shadow map while it stays visible.
`receive: false` stops its own surface from sampling directional, contact,
capsule, spot and point shadows, and it keeps casting. Deferred carries the
receive flag in the GBuffer. The WebGL2 fallback always receives. Toggles are
ordinary `world.set` writes and apply on the next extracted frame.

After a successful `draw`, inspect the same renderer projection:

```ts
const channels = renderer.inspect().renderScene.gpuDriven.channels;
const spotViews = channels.filter((channel) => channel.viewPass === 'spot-shadow');
const pointFaces = channels.filter((channel) => channel.viewPass === 'point-shadow');
void spotViews; // lane, reason, drawCount, and viewIndex are bounded facts.
void pointFaces; // point views additionally expose the cube `face`.
```

The per-view cache is keyed by light identity and view parameters. A cache hit
does not dispatch or record a duplicate shadow view. The inspection labels and
identity helpers are anchored in
[`spot-light.ts`](src/components/spot-light.ts),
[`shadow-views.ts`](src/gpu-driven/shadow-views.ts), and
[`frame.ts`](src/record/frame.ts); repair the producer named by a structured
`failure.detail` before retrying the unchanged frame.

For offline recovery, read `renderer.inspect().renderScene.gpuDriven.channels`.
A blocked channel carries one bounded `failure` projection with the same
closed `code`, `detail.owner`, `detail.reason`, and `detail.recovery` that the
renderer error stream emits. Repair that owner, recook or republish its
producer artifact, and retry the identical frame; `hint` is explanatory text,
not a value to parse. A blocked capable candidate is not permission to issue a
duplicate CPU draw.

## GPU-driven view kernel

`BatchTopology` groups eligible rigid draw items by immutable geometry,
material, render-state, and command compatibility. One primitive can contribute
multiple submesh draw items, and each draw item uses a closed indexed or
non-indexed five-word indirect command. A per-view typed graph records
`reset -> frustum/compact -> finalize` over persistent candidate and batch
buffers. The compute path validates generation and active flags, composes the
primitive world transform with each ordinary instance-local transform, writes a
compact `(meshProjectionRow, materialOrPaletteRow)` stream, sets explicit
overflow flags, and emits indirect arguments with `firstInstance = 0`. The low
bit of the candidate admission word controls submission; its upper bits carry
the batch-local projected mesh row. Rigid rows address the generated material
table, while skin rows address the persistent palette through
`Instance.customDataStart`.

The Standard frame activates the production raster lane only when compute,
storage buffers, indirect drawing, and producer-owned Standard PBR artifacts
are all ready. It covers opaque and Alpha Mask rigid/skin candidates whose
geometry, resource class, reflection, palette address, and (for skin) finite
producer-authored bounds satisfy the prepared contract. Main and directional,
spot, or point shadow views consume the same scene and topology, but keep
view-local visibility and projection bindings. Ownership is per draw item and
view pass, so one draw can be GPU-owned in the main/shadow channels while an
unrelated semantic pass remains CPU-owned.

Indirect encode never classifies a batch against the camera: every live batch
keeps its commands and the GPU cull rejects its instances. Stock recording groups
live batches into stable-ID runs of 32; a run whose batches, physical buffers and
resolved material/pipeline/mesh groups are unchanged replays its retained bundle,
so a steady frame re-encodes only runs holding an edited batch. Only the Surface
`nearest-layer`/`color` passes, whose draws feed the in-order submission
observation, record directly.

The topology contributes each `(primitive, source draw, instance ordinal)` once.
Prepared draw facts prove resource admission once per source draw; ownership
combines these facts with the complete authored draw count times instance count.
Incomplete admission cannot claim all draws. This uses no candidate array copies,
per-instance eligibility strings, or repeated source draw resolution.

Transparent/blend, transmission, unsupported prepared variants, and
skin without a producer-authored conservative bound stay on an explicit CPU
semantic or CPU deformation lane. A producer-published custom Surface or
full-custom ABI follows the same GPU lane when its selected Pass passes the
prepared contract; an ordinary custom WGSL artifact without that ABI remains
CPU/specialized. WebGL2 selects capability
fallback from the same persistent projection; it does not emulate compute.
Missing capable-path artifacts and failed resource publication are structured
errors that block graph promotion rather than silently drawing the same item a
second time through CPU semantics.

Buffer capacities follow actual membership and the device's real limits.
Visible windows are sized in 64-entry units from each batch's members and grow
by 1.5x on relocation; a view's visible stream allocates its aligned
requirement plus 25% headroom and grows by 1.5x, with slack clamped to
`maxStorageBufferBindingSize`. Only views given an occlusion camera reserve
the late-phase mirror. The Skin demand hash/roster scale with
`min(candidates, joints)`; only the per-candidate reference column scales with
the task. GPU Scene row tables double up to the bindable row count. Device
admission requests the adapter's `maxBufferSize` and
`maxStorageBufferBindingSize` when they exceed the defaults. A requirement
beyond the bound is a structured `limit-exceeded` error; tables are not split
into multiple bindings (the 128-byte transform table is the first ceiling:
1,048,576 rows at the 128 MiB default).

> [!WARNING]
> A GPU selector overflow is fail-closed: `finalize` emits zero indirect
> instances for the affected batch and inspection reports `overflow=true`.
> The last-known-good resource generation remains authoritative until the
> producer can rebuild with sufficient capacity. Missing skin bounds are also
> intentionally conservative: they remain CPU deformation work; bind-pose
> bounds are never invented as animation bounds.

The bounded `gpuDriven.channels` inspection reports the selected lane and
closed reason for each view pass. Blocked promotion additionally exposes the
producer-owned `failure` (`code`, `expected`, `hint`, and typed `detail`) so an
AI caller can branch on owner/recovery without decoding an error string. The
same `GpuDrivenPreparationError` is delivered through the renderer error
stream. The inspection also reports topology revision, candidates,
batches, visible capacity, buffer capacities, update count, upload bytes,
rebuild count, overflow, retry count, and last-known-good generation. RhiNull
verifies graph dependency order and stable-frame zero work; local Dawn verifies
the command, binding, palette, shadow-view, and readback contracts. The
renderer-level integration also proves that the built-in Standard graph
contains the compute chain before `main`, with no GPU plus CPU duplicate draws.
The renderer retains one graph, one compile owner, one encoder, and one submit
route.

> [!NOTE]
> Non-rigid multi-World composition, skinned lanes, visibility/hierarchy
> changes, and unsupported render-relevant structural changes currently take
> an explicit reconcile path. The projection and GPU tables already define
> stable slot, generation, create, update, remove, grow, clear, and rebuild
> semantics; later coverage can make those changes entity-local without adding
> another scene authority.

### Two-phase HZB occlusion

Two-phase HZB is the only main-view occlusion owner. The main camera's GPU lane
adds it on top of the frustum cull for both the Deferred (`g-buffer`) and
Forward (`main`) Standard lanes, single-sampled or MSAA:

```text
early scene pass (last frame's visible items)
  -> occlusion-depth-pyramid-seed / -reduce-chain (furthest)
  -> gpu-driven.occlusion-cull -> gpu-driven.occlusion-finalize-indirect
  -> late scene pass (g-buffer-late / main-late: newly revealed items only)
```

The early phase draws only items whose per-instance visibility bit was set the
previous frame. The late cull tests every other frustum-visible item's
projected bounds against the pyramid level whose texels cover the footprint;
an item is hidden only when its nearest point lies behind the farthest depth
of every covered texel. A degenerate or non-finite footprint stays visible.
The late cull records this frame's bits and mirrors newly visible items into a
second region of the visible buffer, so late draws keep `firstInstance` 0 and
disocclusion never costs a frame. Under MSAA the pyramid seed takes the
farthest of every sample and treats a texel as empty when any sample is. The history is
keyed by camera identity, history version, and aspect; the first frame,
recovery, or a key change invalidates it, and the early phase then draws
everything. View buffer growth (a World joining the view) carries the bits
into the new counters; rows new to the bitmap take the late test.

> [!NOTE]
> This deliberately deviates from reprojecting last frame's pyramid: the
> previous visible set is exact for the current camera, so no reprojection
> error margin or history depth target exists.
> `RenderPipelineAsset.config.gpuOcclusion: false` keeps the single-phase
> frustum path; there is no CPU occlusion fallback.

#### Shadow casters against the camera pyramid

Under Deferred, shadow passes run after `g-buffer-late`, so each directional
cascade's and spot light's final-layer caster cull also tests the camera
pyramid. A shadow map only darkens receivers inside the caster's light-space
rectangle between depth 0 and the caster's nearest light depth (reversed Z). That
prism, widened by the receiver filter footprint (PCF/PCSS radius plus two
texels) and the normal offset, is split into eight depth slabs. Each slab is
unprojected through the inverse light view-projection, clipped at the camera
near plane, and tested against the pyramid. The test uses the main cull's
margin, but it reads a 4x4 texel footprint one level finer than the main cull's
2x2. A low camera sees slabs hugging the horizon, where the coarser level would
reach the sky above the occluders. A caster is skipped when every slab is
off-screen, beyond the far plane or behind the pyramid. No receiver it could
shadow is visible, so the final image is unchanged. The caster's own box lies
inside its prism, so a box the same 4x4 test cannot hide keeps the caster
before any slab is built, and the walk starts at the caster's own slab. A view
that sees most casters therefore pays about one pyramid test per caster.

The cull is off whenever anything other than the main camera reads the shadow maps. The graph binds the
pyramid only when there is no ray-diffuse, enabled volumetric fog, cube capture,
reflection probe work, planar reflection or feature scene input. Forward
lanes never bind it, because their main pass samples the maps before a
pyramid exists. It is also off for point lights, for static layers (whose
cache must stay camera-independent), and for a light matrix without a usable
inverse. Depth rastered under the cull is never reused. A view whose content
changes keeps culling every frame, and once it rests, the frame that would hit
the cache re-rasters every caster once without the cull
(`invalidationReason: 'camera-culled'`).
`renderer.inspect().shadowRaster.views[].cameraCulled` counts the skipped
casters. The count reaches the view's current record even when a re-culled
view has been replaced before its readback lands. The Dawn and browser gate `gpu-driven-view.*.test.ts` proves that hidden casters
are skipped, that a caster whose receivers sweep into view is kept, and that the
filter dilation keeps an edge caster. Its FALSIFY cases cull without dilation and cull
the side light once a wall hides every receiver.

`readLodSelection()` reports `occlusion: { culled, late }` for the late
phase, and `renderer.inspect().lodOcclusion`
(`forgeax::lod-occlusion-inspection::v3`) derives its `occluded` and
`visible` counts from that same GPU selection. The Dawn gate `gpu-driven-view.dawn.test.ts` proves a hidden item skips
both phases, returns through the late phase in the frame its occluder
disappears, and keeps a partially visible item; its FALSIFY case shrinks the
footprint and must wrongly cull that partial item.

### Offline inspect → repair owner → retry

Use the detached channel to identify the next owner without opening a browser
or reading live GPU objects:

```mermaid
flowchart LR
  A["inspect gpuDriven.channels"] --> B{"lane / reason"}
  B -->|"gpu / none"| C["record the same graph"]
  B -->|"blocked / resource-not-ready"| D["repair failure.detail.owner"]
  D --> E["recook or publish the receipt"]
  E --> F["retry the identical frame request"]
```

The three public navigation entries are [`shader`](../shader/README.md#gpu-driven-pbr--shadow--skin-navigation),
[`runtime`](../runtime/README.md#gpu-driven-pbr--shadow--skin-navigation), and
this render owner. The two executable carriers are
[`hello-skin`](../../apps/hello/skin/README.md#gpu-driven-skin-carrier) and
[`hello-fbx-skin`](../../apps/hello/fbx-skin/README.md#gpu-driven-fbx-carrier).
Their Dawn smoke commands remain independent evidence; RhiNull proves graph
ownership and deterministic lane facts only.

Features are supplied through the construction options (`features: [...]`) and
enter the same host-owned extract → plan → graph projection path. The public
`Renderer` intentionally has no install/uninstall methods: optional capability
lifetime belongs to the App host, while recovery re-runs the plan against the
replacement device generation.

| This package owns | Excluded concepts |
|:--|:--|
| Camera/light/mesh vocabulary, `Renderer`, render errors, documented pipeline operations | Backend selection, asset import, ECS scheduling, animation playback, optional text/tile/sprite authoring |

The stable surface is [`src/index.ts`](src/index.ts). `RenderError` is closed and carries actionable detail. Runtime alone owns host assembly and its `EngineEnvironmentError` rejection contract; render's construction seam is internal to that dependency path.

## Tone mapping output contract

The public mode names are the same names used by the Three r184 oracle:

| Mode | Public constant | Output behavior |
|:--|:--|:--|
| `linear` | `TONEMAP_LINEAR` | Exposure, then clamp to LDR |
| `reinhard` | `TONEMAP_REINHARD` | Per-channel Reinhard |
| `cineon` | `TONEMAP_CINEON` | Cineon filmic curve |
| `aces-filmic` | `TONEMAP_ACES_FILMIC` | ACES filmic curve |
| `agx` | `TONEMAP_AGX` | AgX curve |
| `neutral` | `TONEMAP_NEUTRAL` | Khronos neutral curve |

`TONEMAP_REINHARD_EXTENDED` is the existing ForgeaX luminance-domain curve. Its
separate `reinhard-extended` name is intentional: it is not a second formula
hidden behind the Three `reinhard` name.

Tone-enabled cameras use one output contract:

```text
linearHdr -- exposure + named tone curve --> linearLdr --> displayEncoded
```

The final capture is the encoded surface result. A linear capture, when a
parity adapter exposes one, remains a separate `linearHdr` or `linearLdr`
sample and must not be compared as if it were the final display capture. The
contract is available as `resolveToneOutputContract(camera.tonemap)` from the
render package. The camera remains the runtime entry point:

```ts
import { Camera, TONEMAP_AGX, perspective } from '@forgeax/engine-render';

world.spawn({
  component: Camera,
  data: {
    ...perspective({ fov: Math.PI / 4, aspect: 1 }),
    tonemap: TONEMAP_AGX,
    exposure: 1,
  },
}).unwrap();
```

The built-in Output Transform samples the linear scene target and writes the
display-encoded result before FXAA, post effects, and present. Shader source authority is
[`packages/shader/src/tonemap.wgsl`](../shader/src/tonemap.wgsl); the render
package does not duplicate those formulas.

`Camera.clearColor` is written into the linear scene target, so an opaque clear
goes through exposure and the tone curve like any surface. This differs from
Three.js, whose `scene.background` colour is display-referred. The default
`[0, 0, 0, 0]` is transparent: on a premultiplied surface (the WebGPU canvas)
the page behind the canvas shows through tone mapping, FXAA, TAA and bloom. A
[`GradientSky`](#gradient-sky-background) is the in-engine display-referred background
(the same composite, without page CSS). Analytic fog skips background pixels and tints
geometry only, except a GradientSky horizon. A surface without premultiplied alpha
presents opaque, where a transparent clear shows black.

### Gradient sky background

`GradientSky { zenith, horizon, ground, mid, midHeight, exponent, sunSize, sunGlow, fogBlend, toneMapped }`
is a procedural background with no geometry to build. Above the horizon the colour is
`mix(horizon, zenith, pow(h, exponent))` for the view ray's elevation sine `h`; below it,
`mix(horizon, ground, pow(-h, exponent))`. With `midHeight > 0` (default 0) the upper span
has a third stop: `mix(horizon, mid, pow(h / midHeight, exponent))` up to `midHeight`, then
`mix(mid, zenith, pow((h - midHeight) / (1 - midHeight), exponent))`. Two complementary
stops (orange and violet) pass through grey mauve; a middle stop keeps the hue saturated.
`exponent` below about 0.3 collapses the horizon colour into a thin line (0.13 is 59 %
zenith 1 degree up). `GradientSkyPresets` exports tuned `daylight`, `dusk` (three stops,
orange -> rose -> violet), `night` and `overcast` spawn data. The selected `DirectionalLight` places a disc
of angular radius `sunSize` toward `-direction` with an exponential `sunGlow` halo in the
light's hue; `sunSize: 0` or no light draws no disc. With an active `Fog`, the sky and
glow blend to the Fog colour at the Fog's `maxOpacity` at and below the horizon, fading
out by elevation sine `fogBlend` (0 never fogs the sky), so distant fogged geometry meets
the sky without a seam. The disc is drawn over the haze and hidden below the horizon.

A GradientSky replaces `Camera.clearColor`: the scene target clears transparent.

App installs its schema through `renderComponentsPlugin()`, so authored Scene
data can use `components: { GradientSky: { ... } }` before any runtime spawn.
A standalone World installs that plugin before creating or loading the Scene.

- `toneMapped: false` (default) is display-referred, like Three.js `scene.background`.
  The `gradient-sky-display` pass runs after every output stage (tone mapping, LUT,
  FXAA, encoded post effects) and fills the remaining transparent coverage of the
  encoded surface (`blend: one-minus-dst-alpha, one`), exactly as a CSS page colour shows
  behind the canvas. Linear colours are shown as set (clamped to [0, 1]); the disc is the
  light hue mixed half-way to white. The fogged horizon uses the Fog colour mapped
  through the camera's exposure and tone curve, which is how fogged geometry shows. The
  sky is outside the HDR scene, so bloom, SSR, planar reflection and transmission do not
  see it. The one exception is the sun disc under camera bloom: the `skybox` pass also adds
  the disc as scene radiance (light hue times `intensity * 4`, as a `toneMapped` sky draws
  it) with transparent alpha, so bloom spreads it exactly like the disc's specular
  reflection on water and the display sky shows that glow over itself. Without bloom
  nothing is added and the disc stays as authored.
- `toneMapped: true` is scene-referred radiance drawn by the `skybox` pass into the HDR
  scene before geometry, so exposure, the tone curve and bloom apply and screen-space
  consumers see it. The disc radiance is the light hue times `intensity * 4`, so a 3 lux
  sun reaches bloom thresholds.

At most one GradientSky contributes. A second one, one beside `Atmosphere` or a
`SkyboxBackground` (each draws the background), or an out-of-range field rejects the
frame selection with `environment-selection-invalid` naming the field
(`GradientSky.exponent` in [0.001, 64], `midHeight` in [0, 0.95], `sunSize` in [0, 0.5] radians, `sunGlow` in
[0, 16], `fogBlend` in [0, 1], colour channels finite and >= 0). The sky does not light
the scene; match `Skylight.color` / `groundColor` to it. Reflection probes and cube
captures do not render it.

A World containing only a Camera and GradientSky still renders the complete
gradient and sun disc; the camera View upload does not require a mesh draw.

### Material output and Forward graph composition

`createStandardForwardPipeline(output)` from `render/authoring` retains the native
Forward scene, light, shadow, transparent-draw and MSAA owners. The construction-time
contribution supplies the scene color `format` and `domain`, then declares its
finishing work through `build(context, topology, color, depth, surface)`. The callback
replaces the Standard post chain; it does not acquire a device, submit, or retain GPU
resources outside the graph. Its material writes and any contributed scene effects
must agree with the selected domain. Default Standard keeps linear scene blending.

An encoded-output producer can use the ordinary optional material parameter
`fragmentOutput` described in the [Shader contract](../shader/README.md#fragment-color-output),
choose `rgba8unorm` / `display-encoded`, and present through
`addTypedOutputTransformPass(..., { outputOnly: true, fragmentEntryPoint: 'fs_present' })`.
`addObservationCapturePass(graph, color, 'final-display')` captures the resolved,
graph-owned endpoint when the context requests that domain, including surfaces
whose native canvas cannot be copied. A normal visualization uses identity output;
ordinary colors apply their tone and transfer operation before attachment blending.

## Display-P3 output colour space

The working space stays linear Rec.709. The canvas output colour space is a closed
union `OutputColorSpace = 'srgb' | 'display-p3'` chosen at construction and
reconfigurable at runtime:

```ts
import { createRenderer } from '@forgeax/engine-runtime';
import { displayP3, Materials } from '@forgeax/engine-render';

const renderer = await createRenderer(canvas, { outputColorSpace: 'display-p3' });
const red = Materials.unlit(displayP3([1, 0, 0, 1])); // P3 red, outside Rec.709
const switched = renderer.setOutputColorSpace('srgb'); // takes effect at the next draw
if (!switched.ok) throw switched.error; // invalid value or disposed renderer
const report = renderer.inspect().output.colorSpace;
// { status: 'applied', requested, effective } | { status: 'fallback', ..., fallback }
```

- **Surface.** `'display-p3'` configures the canvas with `colorSpace: 'display-p3'`
  and then reads `getConfiguration()` back. Only an echoed `'display-p3'` counts as
  applied; `'srgb'` configures exactly as before (no `colorSpace` field).
- **Transform.** The Output Transform (the single OETF writer in `tonemap.wgsl`)
  converts linear Rec.709 → linear Display P3 with the D65 matrix derived from the
  primaries, then applies the shared sRGB transfer curve. This happens after tone
  mapping and before dithering. `TonemapParams.outputGamut` (offset 16 of the 32-byte
  layout `TONEMAP_PARAMS_LAYOUT`) is stamped at record time from `report.effective`,
  so a fallback always encodes sRGB.
  Sampling uses fragment pixel centers normalized by the graph-resolved destination
  view extent, including scaled and mip targets. FXAA uses its equal-size input
  pixel grid and pairs negative/positive edge neighbours with the signed step.
- **Exactness.** sRGB output is byte-identical to the previous path, and neutral
  greys encode the same in both spaces. Colours authored through `displayP3()`
  keep their negative Rec.709 components and re-encode to their authored P3 bytes
  (Dawn and Chrome evidence: within 1 LSB).
- **Out-of-range handling.** Linear-LDR is bounded in the *output* gamut: each P3
  channel clips to [0, 1] independently (per-channel clip, no gamut mapping). The
  sRGB output clips each Rec.709 channel instead, so a P3-only colour shifts hue on an
  sRGB surface.
- **Fallback is data.** `fallback.code` is `'canvas-color-space-unsupported'`.
  `fallback.detail.observed` is one of `'configure-rejected'`,
  `'configuration-absent'`, `'color-space-absent'` or `'color-space-mismatch'`, with
  `reported` carrying the backend error code or observed space. The renderer then
  reconfigures an sRGB surface and keeps drawing. Backend behaviour:
  - rhi-wgpu never forwards `colorSpace`.
  - rhi-null reports no configuration.
  - Offscreen hosts without `getConfiguration` report `'configuration-absent'`.
- **Observation.** The final-surface domain is `'final-display'`, and its observation carries `colorSpace: OutputColorSpace`, so
  readback bytes are never misread as sRGB.
- **SSOT.** Primaries live once in `@forgeax/engine-math` `color.RGB_PRIMARIES`.
  `color.LINEAR_SRGB_TO_LINEAR_DISPLAY_P3` is derived from them, and the WGSL block
  in `packages/shader/src/output-encoding.wgsl` is generated by
  `bun scripts/forgeax/generate-output-gamut-wgsl.ts`. A render unit test fails when
  the checked-in block drifts from the primaries.

Limits:
- `RenderTarget` views and the ray reference display always encode sRGB; only the
  canvas surface is widened.
- A Standard LUT samples a Rec.709 [0, 1] cube, so P3-only colours on that path are
  bounded by the LUT domain.
- Filmic tone curves produce Rec.709 output. P3 widens only colours that stay outside
  Rec.709 through `none`/`linear`.
- Wide-gamut content through the FXAA intermediate has not been verified.
- There is no automatic `matchMedia('(color-gamut: p3)')` selection; the caller
  chooses.
- After `setOutputColorSpace`, `inspect().output.colorSpace` stays stale until the
  next draw reconfigures the surface.
- The report lives in the realm that owns the Renderer (under App worker execution,
  that is the render worker).

## Optional CPU profiling

Render accepts the host-owned `Profiler` capability through App assembly. It writes bounded CPU
phase evidence only while a capture is active; it does not add GPU timestamps, ECS spans, a UI, or
a remote method. The artifact and its owner-declared catalog are documented by
[`@forgeax/engine-profiler`](../profiler/README.md).

```ts
import { createProfiler, type Profiler } from '@forgeax/engine-profiler';
import { createRenderer } from '@forgeax/engine-runtime';

const profiler: Profiler = createProfiler();
const renderer = await createRenderer(canvas, { profiler });
```

Use the package's `validateProfileCapture` and `buildProfileModel` entries for offline analysis.

The shared submission barrier records three synchronous CPU phases at every
capture detail level. Each reached phase runs once for the entire view roster:

| Phase | Covers |
|:--|:--|
| `submission/presentation` | Final presentation encoding, including configured screen UI and final-display observation |
| `submission/finish` | Optional timing-tail encoding and the shared command encoder's `finish()` |
| `submission/submit` | Pre-submit hook, generation guards, queue submission, synchronous completion registration and submitted-work callbacks |

These phases sit between the active segments of `record`; they belong to the
currently open outer frame phase, never to a suspended view's `record` span.
They retain the original queue and resource-fence ordering, close on failure,
and do not await completion Promises. Their elapsed times are CPU observations,
not GPU duration or receipt latency. UI preparation before scene extraction
remains outside these phases. Without an active capture, the same backend calls
run without profiler event records.

At `passes` detail and above, GPU-driven production preparation records
`record/gpu-driven-prepare` once per frame, nested under `record`, with three
children:

| Phase | Covers |
|:--|:--|
| `record/gpu-driven-prepare/plan` | Prepared-plan cache miss: material-artifact check and `prepareProductionPlan`; absent on a cache hit |
| `record/gpu-driven-prepare/filter` | LOD projection, main-view filtered plan and shadow ownership/filtered plan |
| `record/gpu-driven-prepare/shadow-views` | `ShadowCasterClassifier` and shadow-view projection update |

`BatchTopology.plan()` runs while the composition state is built, before the
record phase, so its cost is outside `record/gpu-driven-prepare/plan`. The
remainder of `record/gpu-driven-prepare` (uploads and bind-group work after the
children) is not split further. Without an attached profiler these wrappers
call the action directly.
The render package remains the owner of render vocabulary and extract/plan/record execution.

## RenderFeature: the producer seam

Register one producer-owned feature at the renderer assembly boundary. The
same `FrameData` type flows through `extract` and the mandatory `plan`; the
host derives preparation, graph access, recording, and lifecycle isolation
from that one plan. Both paths execute inside the active RenderGraph and the
frame's single execute/submit boundary.

Declared capabilities gate each nonempty work plan. Recovery retires prepared
resources and allows a fresh plan to be evaluated against the replacement
device; an empty optional feature cannot fail recovery merely because it
declares compute or another unused capability. A later active plan still
returns `render-feature-capability-missing` before admitting unsupported work.

The smallest feature returns a closed plan with named resources and passes.
Graph access is derived from those declarations; there is no staging object or
second contribution API:

```ts
plan: (frame, context) => ok({
  work: [{
    scope: 'frame',
    resources: [
      { kind: 'compute-program', name: 'compact.program', program },
      { kind: 'compute-bindings', name: 'compact.bindings', program: 'compact.program', entries },
    ],
    passes: [{
      kind: 'compute', name: 'compact', program: 'compact.program',
      bindings: 'compact.bindings', dispatches,
    }],
  }],
})
```

The plan contains cooked program descriptors, named buffers and bindings, logical
targets, and draw/dispatch commands. Graph buffer and texture access is derived
from those roles; producers never author a second `reads`/`writes` ledger and
never receive an encoder or submit authority. A view's signature and physical
imports include only the shared resources reached from its own declarations;
unrelated frame-only simulation inputs remain with the shared frame graph.

The host compares declarations while capturing a detached structural signature
snapshot, reusing the prior root and its resource array when unchanged. It does
not precede capture with another whole-plan comparison. Graph admission still
rechecks the producer's nested declarations against that snapshot. Immutable strings retain
their canonical tokens across equal-value observations, including rebuilt WGSL
descriptors. Inside a Host clone, a long immutable string may also reuse a token
that the original native JSON formatter has already produced earlier in that
same call. This table ends with the call and retains at most 64 values and 4 Mi
UTF-16 code units of value/token references. Unique strings and budget misses
keep the original serializer; there is no name lookup, prior-snapshot scan or
cross-frame token authority. Custom or replaced formatters use the original
path. This optimization assumes standard platform descriptor introspection.
The generic snapshot entry retains its original getter/Proxy observation and
failure order; Host admission performs one such capture. Resource declarations
are compared at their observed ordinals; the generic
checker does not speculatively read names from author getters or Proxies. Native
VFX keeps its own private resource declarations stable across queued/retained
churn without changing ordered passes. Declaration and pass order still belong
to topology. Mutable containers and inline bytes are inspected on
every admission; changed shader text, bindings, capacities, entry points, command order
and indirect offsets invalidate the snapshot. Buffer upload data, pass/draw `enabled` and
direct dispatch workgroup counts remain outside topology identity. Direct counts
are unsigned frame data; zero in any X/Y/Z dimension is legal. Preparation validates
the complete declaration before omitting a zero-work command, retaining its checked
resources and graph accesses so ordinary count changes reuse the compiled graph.
A disabled pass keeps its checked resources and ordering but performs no execution;
submission feedback lists only enabled passes and draws. A disabled draw retains
its binding and buffer accesses without encoding a command, including nonzero
indirect commands left by an earlier frame. Passes retain draw ordinals across
visibility changes. The next enabled frame reads the
current accepted execution projection, including current compute work. The
[signature benchmark](bench/README.md#feature-signature-admission) measures this
host/graph check separately from graph compilation and GPU execution.

Prepared feature materials resolve the same World content as ordinary materials,
and published readers consume that accepted projection. Feature publication uses
canonical material/mesh handles and preserves the base payload's GUID when
runtime content creates a new value object. Numeric World overrides preserve
the shared source's cooked Forward, ShadowCaster and scene-index program
selection, including when the Catalogue later replaces the same GUID. User material textures and samplers
are visible to both vertex and fragment stages, including displacement through
`textureSampleLevel`; engine-injected lighting bindings retain their own scopes.
Terminal DeviceScope children detach from their parent after cleanup; retiring
children remain owned until their in-flight work can release them.

Catalog changes refresh published material snapshots and GUID dependencies.
Already published World payloads without Catalog provenance are resent only
after explicit runtime-content or derived-mesh invalidation; an unrelated asset
load does not clone every retained hidden mesh again. First baselines and new
handles still carry their complete payload, and Catalog-owned assets retain
their existing reload behavior.
Runtime content observes per-component writes, changed owner handles and removal.
An unrelated component migration preserves the published mesh payload; sources
without runtime content allocate no temporary handle roster during this check.

Prepared material-input layouts accept `particleInputLanes` from 1 through 4
(omission selects the canonical one-lane layout). The count is valid only for a
material-input vertex layout. Render derives its instance stride and attributes
from the base layout and uses the same complete multi-stream descriptor in the
PipelineSpec cache identity. Invalid counts fail during resource preparation.

A prepared pipeline with empty `colorFormats` uses the depth-only route and
preserves its declared `depthFormat`, depth state and complete vertex streams.
A vertex-only shader needs no fragment entry. For a vertex-index-generated draw,
declare `vertexLayout: 'none'` on the draw and supply the prepared empty group
when the shader has no resources. This is depth-target rendering, not automatic
registration as a Standard light-view shadow caster.

For light-view participation, declare a `shadow-caster` plan pass with the same
draw vocabulary and a depth32float, zero-color graphics program. Standard owns
the light-view binding, atlas, viewport and pass replication; the feature owns
only geometry and instance inputs. It reuses the normal prepared draw encoder
and the same graph buffer imports. Active GPU casters disable static directional
atlas reuse because ECS mesh epochs do not describe GPU buffer contents.

The graph projects a feature's leading compute prefix before shadow views until
the first scene-target dependency or ordinary raster. Remaining work stays at
the normal scene contribution boundary. A caster whose projection is late reads
the prior submitted instance data (initially empty); it must not be described as
current-frame simulation. Owner-local pipeline implementations use
`contributeShadowFeatures` with `addTypedShadowPasses`; graph construction and
these helpers are not added to the public Render root.

### Five render terms

| Term | Meaning | Owner |
|:--|:--|:--|
| `RenderFeature` | Producer-owned extract/plan callbacks and frame data | Feature producer |
| `Standard Pipeline` | The single frame policy containing the supported capability/profile lanes | Render host |
| RenderGraph pass | One declared graph execution node in the active Standard Pipeline | Graph host |
| Material pass | One shader-facing pass in a `MaterialAsset` | Material asset |
| RenderFeaturePlan | One frame declaration containing scoped work and optional source feedback | Feature producer |
| RenderFeatureWorkPlan | Resources and commands inside one frame or view scope | Feature producer |

### Prepared compute resources

`RenderFeature` producers declare cooked compute pipelines, reflected name-based bindings,
uniform/storage buffers, and dispatches. The renderer prepares those declarations,
imports the persistent buffers into the render graph, and derives `uniform-read`,
`storage-read`, or `storage-read-write` access. Producers do not repeat a string `reads/writes`
ledger and do not receive an encoder.

A native `copy` pass declares buffer pairs with source/destination names,
byte size and optional byte offsets. The host resolves the existing owned buffer
references, checks four-byte alignment, bounds, distinct physical buffers and
copy usage, then derives `copy-src`/`copy-dst` graph accesses. Owned feature
buffers already allow upload destinations; sources declare `copy-src` usage.
Copies use the frame encoder through RenderGraph and require no shader or bind group.

Compute, copy and graphics passes use the same plan projection and submission boundary. The graph
owns `beginComputePass` / `end`; the plan records only named pipeline, bind group, and dispatch
commands. Persistent buffers retain device identity across frames,
rebuild with the feature-host generation, and retire only after queue completion. A storage buffer
may also be consumed as renderer-declared vertex data.

A prepared material that samples its own depth attachment while writing depth
receives a graph-owned single-sample snapshot taken immediately before its draw
pass. The snapshot retains the source allocation extent/format and retires with
the graph; the original attachment remains writable. Read-only depth consumers
retain their existing zero-copy path. Multisampled sampled-depth writers fail
with `resource-descriptor-invalid` before GPU recording until a separate MSAA
snapshot producer is available; material depth writes are never silently disabled.

The typed graph coalesces literally adjacent buffer-only compute passes from one
feature and prepared program when their physical buffer access roles agree. Copy,
raster, texture dependencies, selector gaps and shadow-hoist boundaries end a chain.
Every logical pass still reads its own current enabled state, bindings and dispatches;
errors identify the failing logical pass and submission feedback retains the logical
roster with resolved command counts. The physical graph pass uses the first logical
name. This removes repeated native compute-pass setup without reordering kernels,
collapsing tick uniforms or adding a second cache.

Feature contexts never expose raw GPU graphics state, a complete pipeline
context, submit authority, or a command encoder. They expose immutable
capabilities and logical targets for plan construction. The active RenderGraph
owns the frame boundary; do not cast a plan context to a backend object or
encoder. The executable contract examples live in the plan-focused tests under
`src/record/__tests__` and `src/features`.

### Failure and recovery

`RenderError` is a closed union. Switch on `error.code`, then read
`error.expected`, `error.hint`, and the code-specific `error.detail`.

Feature capability checks are based on `Readonly<RhiCaps>`, and recovery actions
consume the structured `error.detail` context.

| Diagnostic state or code | Recovery action |
|:--|:--|
| `active` | Continue the next frame |
| `failed` / `render-feature-stage-failed` | Correct producer data and retry on the next frame |
| `disabled` / `render-feature-capability-missing` | Provide the capability on a replacement device; after device-loss recovery call `await renderer.recover()`. On a live renderer, the public recovery boundary returns a structured renderer-state-invalid result, so rebuild on a capable device instead. |
| `render-feature-registration-conflict` | Fix identity/order at registration |
| `render-feature-pass-order-conflict` | Reorder the declared dependency and re-plan on the next frame |
| `render-feature-preparation-failed` | Repair the named prepared resource and retry on the action in `error.detail.recovery`; after device loss, verify that the feature's declared shader was included in the recovery prewarm set |
| `render-feature-prepared-state-mismatch` | Read the discriminated `error.detail.reason`, repair the generation/layout/format mismatch, and retry |
| `render-feature-draw-recording-failed` | Read `error.detail.backendReason`, then retry after the host reports renderer recovery |
| `disposed` | Terminal; create a new renderer/feature registration |

Use `renderer.inspect()` for a read-only snapshot. Call `renderer.dispose()`
once or repeatedly; disposal is idempotent. Feature plans are assembled once
and the Standard host owns graph replacement and last-known-good recovery.
Repeated recoverable preparation errors are reported at most once per 60 frames.
A changed stage exception name/message is reported immediately, retaining one
report record per feature/error owner. Normal asynchronous resource warm-up
remains silent.

For a temporary presentation-owner handoff, call `renderer.releaseSurface()`.
It unconfigures the canvas and makes `draw()` fail closed without disposing the
Renderer, AssetRegistry, or GPU declarations. After the temporary owner is
gone, `renderer.restoreSurface()` re-enables lazy surface configuration on the
next draw. Both calls are idempotent; `dispose()` remains the terminal path.

For the complete declaration shape, read
[`features/types.ts`](src/features/types.ts) and
[`features/plan.ts`](src/features/plan.ts). For Standard profile and lane
selection, read the internal pipeline implementation through the host seam;
there is no public full-pipeline registration API. The producer
asset contract is [`@forgeax/engine-vfx`](../vfx/README.md), while graph
ownership is [`@forgeax/engine-render-graph`](../render-graph/README.md).

> [!WARNING]
> Wave 2 delivered this generic prepared public seam. A downstream Wave 3 VFX
> integration owns visible particle draws; render must not gain a
> particle-kind switch or VFX production dependency. See the
> VFX Wave 3 handoff.

Dynamic consumers use the same boundary explicitly:

```ts
const { Camera, MeshFilter, MeshRenderer } = await import('@forgeax/engine/render');
```

`@forgeax/engine/runtime` remains the host assembly entry for `createRenderer` and backend policy. Import `Materials` from `@forgeax/engine/render`. Runtime is not a compatibility barrel for render components.

Optional text, tilemap, and sprite authoring is intentionally isolated from the
base vocabulary:

```ts
import {
  GlyphText,
  SpriteAnimation,
  Tilemap,
  TransparentSort,
} from '@forgeax/engine-render/authoring';
```

A `Tilemap` is one grid layer with `tileset: AssetHandle<'tileset'>`, `cols`,
`rows`, `tiles`, `tileSize` (default `[1, 1]`), `chunkSize` (default 16),
`layerOrder`, and `sortScope: TilemapSort.layer | TilemapSort.perCell`.
Compose multiple layers with ordinary `Transform` / `ChildOf` entities.
`world.set(entity, Tilemap, { tiles })` publishes author edits; asset edits use
`assets.update(tileset, patch)`. Neither path needs a dirty flag or derived World entities.

The Renderer accepts changed author rows once and partitions occupied cells into
chunks. Asset adoption replaces only the changed shared Tileset content; it never
walks maps or cells to propagate an update. Visible chunks resolve the selected
content and cache ordinary unlit meshes with half-texel atlas UVs. Whole layers
batch by chunk and atlas; per-cell layers retain transparent Y interleaving.
Exact post-flip bounds include custom pivots and multi-cell overhang. Generated
chunk caches are bounded to 32 MiB per Tileset content, and unchanged meshes
reuse GPU residency. Worker publications carry author cells and asset closure;
the receiver runs the same native source path without a receiver World.

`authoring` also owns the grouped transparent-bucket configuration values. A
consumer that composes sprites with an existing 3D game can call
`TransparentSort.configure(world, { mode: TransparentSort.layerY, yzAlpha: 1 })`;
it should not reach into `/internal`.

A submitted sprite fold attributes draw evidence to every validated source member,
so instancing does not leave non-head entities permanently pending. Rejected heads
publish no member evidence.

Eligible sprite buckets share one fold instance buffer across the typed transparent
geometry pass and the legacy sprite pass. Both consume the same head/skip plan;
10,000 equal-depth sprites remain one instanced draw rather than 10,000 submissions.
The sprite-atlas Dawn smoke checks this for 60 frames, and its browser probe
checks the instance count, typed upload payload and WebGPU validation.

The root barrel does not expose frame stores or extract/plan/record owners.
Applications contribute work through `RenderFeature` plans; the Standard
renderer owns graph compilation and submission.

The render package has one narrow construction seam owned by the host. It is
not an application API or a compatibility route. Standard profile and
capability lanes own MSAA target selection and resolve; applications do not
replace the frame topology.

```mermaid
flowchart LR
  World["World data"] --> Extract["extract"]
  Extract --> Prepare["prepare"]
  Prepare --> Record["record"]
Record --> Rhi["RHI submission"]
```

## Visibility contract

Quick start:

```ts
import { Visibility, VisibilityStateValue, resolveVisibility } from '@forgeax/engine-render';

world.spawn({
  component: Visibility,
  data: { state: VisibilityStateValue.hidden },
}).unwrap();
const snapshot = resolveVisibility(world);
```

| Stage | Truth | Diagnostic |
|:--|:--|:--|
| Author intent | `Visibility.state` is `inherited`, `hidden`, or `visible` | Read the ECS field or reflected `labels` |
| Effective state | `resolveVisibility(world).effective(entity)` applies valid scene parents | Inspect `snapshot.diagnostics` and `VisibilityResolution.source` |
| Render result | Render producers skip hidden candidates before material work | Read `renderer.inspect().visibilityStats`; it is not a frustum or picking metric |

If the state write returns an error, preserve `code`, `expected`, `hint`, and
`detail`, correct the enum value, and retry through `world.set`. If hierarchy
diagnostics are present, repair the scene relation and resolve again. Do not
hide the issue with a custom mesh, camera workaround, or material substitute.

Out of scope: camera frustum policy, picking, app lifecycle, asset import, and
VFX shadow behavior. `@forgeax/engine-vfx-render` remains the producer-owned
particle bridge and consumes the same effective visibility boundary.

## Semantic scene data

Temporal consumers request the producer-owned `forgeax::scene-data::temporal-v1`
schema through `createSceneDataCatalog`. The catalog returns an opaque,
sampled-read-only `SceneDataTarget`; consumers place that token in
the corresponding scoped work's `sampledTargets` and never author an attachment, raw GPU
handle, private velocity buffer, or parallel graph ledger.

```ts
const catalog = createSceneDataCatalog({
  featureIdentity: 'taa',
  generation: 1,
  planIdentity: 'taa:1',
  rgba16floatRenderable: true,
});
const temporal = catalog.require('forgeax::scene-data::temporal-v1');
```

`catalog.inspect()` is the bounded inspection surface. If the schema is not
available, `SceneDataUnavailableError` exposes the closed `reason`, missing
producer IDs (at most 32 plus an omission count), and explicit `recovery`.
Repair capability or producer coverage at its owner, then retry the next frame.

## AI-readable SSR fallback route

For the reflection fallback dependency evidence, call `renderer.inspect()` first
and run the paired fixture. The fixture writes the current Browser/Dawn manifests;
the collector then seals a fresh joint M0 guard for the current checkout:

```bash
pnpm --filter @forgeax/app-learn-render-6-pbr-4-render-target-reflection smoke:ssr-fallback
pnpm --filter @forgeax/app-learn-render-6-pbr-4-render-target-reflection smoke:browser
node scripts/forgeax/collect-ssr-dependency-report.mjs \
  --input artifacts/ssr-fallback/dawn/ssr-dependencies-input.json \
  --build-summary packages/render/dist/index.mjs \
  --output artifacts/ssr-fallback/ssr-dependency-report.json
```

Each smoke writes its own detached `ssr-dependencies-input.json` beside the lane
manifest; the command above uses the just-completed Dawn input (use the Browser
path when inspecting that lane separately). The collector signs the output with
the current source/tree/lock/build identity; it never promotes a stale
sibling-loop report or an authored manifest. Read identity, generation, evidence
level, and closed failure fields before following the named owner recovery action.
Submit the same consumer request and reinspect after recovery. The route returns
detached facts only: no live GPU handle, second owner, or second ledger is exposed.
Missing or mismatched receipts remain `fallback-only` with zero SSR work. The
current renderer may expose admitted structural depth-pyramid, trace, temporal, compose,
and history facts, but no single backend snapshot or non-black canvas is an SSR
v1 acceptance result; use paired Browser/Dawn readback and the closed-loop gates
before promoting that status.

The canonical paired carrier is `apps/hello/ssr`. It runs the same fixture at
`http://127.0.0.1:4173/?forgeax-evidence=ssr` and
`dawn://hello/ssr?forgeax-evidence=ssr`, records 60-frame identity-bound
readbacks, and keeps visual rows in the form `observed` / `verdict` /
`confidence`. Its performance lane derives the 1920x1080 descriptor and checks
it against `estimateSsrSpatialMemory`; timestamp or paired-lane absence remains
blocked.

## Standard dynamic MeshAsset candidates

The Renderer owns one bounded candidate lifecycle for geometry produced by an
external consumer. The payload is the existing `MeshAsset` contract, not a
voxel-specific asset kind. The consumer remains the World shared-reference
owner and publishes `MeshFilter` / `MeshRenderer` through the ordinary ECS
write barrier; the Renderer owns GPU residency, device generation, frame
receipt, and delayed retirement.

```ts
import type { MeshAsset } from '@forgeax/engine-types';
import { FixedTime, type World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import type { FrameCamera, FrameEnvironment, Renderer } from '@forgeax/engine-render';

declare const renderer: Renderer;
declare const world: World;
declare const mesh: MeshAsset;
declare const camera: FrameCamera;
declare const environment: FrameEnvironment;

// Attach first: the Renderer owns the lease/generation boundary, while the
// asset owner retains Mesh content and World owns scene bindings.
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
const meshHandle = assets.create(mesh).unwrap();
const entity = world
  .spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [] } },
  )
  .unwrap();
const fixedStep = world.getResource(FixedTime).tick;
const prepared = renderer.prepareDynamicGeometry({
  world,
  entity,
  meshHandle,
  // Must match a live material handle/source slot; this mesh uses its default.
  materialIdentity: 'default',
  revision: 4,
  topologyRevision: 2,
  // For paired physics use the admission example below, not this draw-only path.
});
if (!prepared.ok) {
  // Branch on prepared.error.code; the previous visible mesh is retained.
} else {
  // ECS FixedTime is the ordering proof for this render-only revision.
  const accepted = renderer.acceptDynamicGeometry(prepared.value, {
    world,
    fixedStep,
  });
  if (accepted.ok) {
    const frame = renderer.draw({
      leases: [attached.value],
      camera,
      environment,
      fixedStep,
    });
    if (frame.ok) {
      const geometryReceipt = renderer.dynamicGeometryReceipt(accepted.value);
      // geometryReceipt.frame.frameId === frame.value.frameId for this
      // generation; geometryReceipt.frame.completed fences GPU retirement.
      void geometryReceipt;
    }
  }
}
```

The entity must already carry `Transform`, a live `MeshFilter`, and a
`MeshRenderer` when the candidate is prepared and accepted; these are the same
ECS prerequisites used by the render extraction query. Preparation records the
old `MeshFilter.assetHandle` and stages the new standard handle without changing
the visible ECS binding. Acceptance is the one ECS write-barrier that swaps in
the candidate. If acceptance or GPU preparation fails, the old binding remains;
cancelling an accepted candidate swaps that old handle back, and refuses to
overwrite a newer external binding. The Renderer host reads
`World.FixedTime.tick` itself; a caller-supplied `{ world, fixedStep }` object
cannot bind an unrelated World or step. Preparation may precede acceptance by
multiple fixed steps; acceptance records the actual current tick. If
`physicsEntity` is supplied, acceptance requires that entity's active paired
`PhysicsWorld` admission to match the revision and current step. An already
published physics result is deliberately insufficient: it cannot roll back if
geometry now fails. A
candidate that is not present in the ECS render snapshot at the successful draw
is left accepted without a receipt; the receipt is issued only after the
submitted record stage consumed the live binding.

### Paired physics admission

Prepare both domain candidates invisibly, with matching revision and the geometry
candidate's `physicsEntity` naming the physical parent. Queue the physical candidate
with one synchronous geometry commit. The existing Physics fixed-step owner runs it
after native staging and before step/writeback/publication; no second clock or queue
is created. A refused geometry commit restores the old native state. Physics queries,
mutations and Renderer draw are refused during this borrowed admission interval.

```ts
import { err, ok } from '@forgeax/engine-types';
import { FixedTime } from '@forgeax/engine-ecs';

physics.admitDerivedShapeCandidate(physicsCandidate, () => {
  const admitted = renderer.acceptDynamicGeometry(geometryCandidate, {
    world,
    fixedStep: world.getResource(FixedTime).tick,
  });
  if (!admitted.ok) return err(admitted.error);
  acceptedGeometry = admitted.value;
  return ok(undefined);
}).unwrap();
// Normal World FixedUpdate performs admission, physics step and writeback.
// After World.update succeeds, inspect Physics publication/failure and draw.
```

For a group of physical bodies, pair `physics.admitDerivedShapeCandidates`
with `renderer.acceptDynamicGeometryCandidates`. The latter accepts one prepared
candidate per distinct render entity, all in the same attached World and fixed
step, using the existing candidate budget. It retains previous unpublished
credentials and GPU leases until every MeshFilter swap succeeds. A later-member
refusal restores earlier bindings; if restoration cannot be proven it throws so
the paired physics owner requires reconstruction. Topology history is invalidated
once after the whole successful group. Retain every returned accepted credential
and inspect its normal FrameReceipt; callback success alone is not a draw receipt.

```ts
physics.admitDerivedShapeCandidates(physicsCandidates, () => {
  const admitted = renderer.acceptDynamicGeometryCandidates(geometryCandidates, {
    world,
    fixedStep: world.getResource(FixedTime).tick,
  });
  if (!admitted.ok) return err(admitted.error);
  acceptedGeometries = admitted.value;
  return ok(undefined);
}).unwrap();
```

The commit must return immediately after its complete binding change, without
additional fallible work. On physical preparation/native failure it is not called;
cancel the still-prepared geometry using its normal owner. On a refused commit,
inspect `getDerivedFailure` and cancel that prepared geometry. Success publication
remains after physics writeback and the real Renderer submission, not callback return.

### CPU 批次接纳

`DynamicGeometryLifecycle.acceptCandidates(candidates, ordering)` 是无 GPU CPU 生命周期的唯一同步整批接纳入口。它只接纳已由同一 lifecycle `prepare` 并预留计数/字节预算的凭证；批次必须非空、属于同一 World，且每个 render entity 槽最多出现一次。`ordering` 必须指向同一 World 并携带非负整数 `fixedStep`。若候选准备时已记录 `fixedStep`，该步不能晚于接纳步。

入口会在写入前完整核对凭证标量、重复项、世代、输入及记录状态、history 过期、revision/topology 水位和现有预留预算。任何结构化拒绝都不消费凭证、不释放预算，也不改变 `inspect()`、旧记录或 history；新候选仍保持 prepared，持有原始凭证的 owner 可在外层逐项取消。成功时一次提交全部记录，返回与输入顺序一致的 accepted 凭证；`prepared` 减批次数、`accepted` 加批次数，`meshBytes` 不变。拓扑变化按各实体槽已有规则更新 history。

```ts
const preparedCandidates = [candidateA, candidateB] as const;
const admitted = lifecycle.acceptCandidates(preparedCandidates, { world, fixedStep });
if (admitted.ok) {
  const acceptedCandidates = admitted.value;
  // 后续配对的 owner 使用完整凭证继续执行发布流程。
} else {
  // 拒绝时仍使用原始 prepared 凭证清理本批新预留。
  for (const candidate of preparedCandidates) lifecycle.cancel(candidate);
}
```

旧 `accept(candidate, ordering?)` 仍是单项操作；逐项调用它不具备批次原子性，也不是该入口的实现方式。此 API 不创建事务令牌或第二套预算，不核验调用方 World 当前 tick 或 Physics admission；配对调用者需在进入前完成这些 owner 检查。返回值只证明 CPU lifecycle 接纳，不证明 ECS publication、Renderer draw、GPU 完成或 Physics fixed-step publication，也不创建 `DynamicGeometryReceipt`。CPU 测试不得调用 `publishFrame` 来制造 GPU 证据。

接纳将准备事务转为 World 常驻资源，accepted 与 published 均不占 transient slot；不可见、尚无 draw receipt 的常驻网格不会阻塞下一次准备。两种状态在资源释放前仍计入 mesh byte 预算；等待 cancel/retire fence 的终态记录重新占用暂存槽位，不预支未来回收量。

`meshHandle` is mandatory on the public Renderer path. The pure
`createDynamicGeometryLifecycle` helper may omit it for CPU-only validation, in
which case `gpuReady` is false and no Renderer receipt can be produced. The
attached Renderer uses the existing `GpuResidencyCache.ensureResident` path
before acceptance; its failure is `dynamic-geometry-gpu-failed`, while a
missing handle is the distinct `dynamic-geometry-gpu-not-ready` error. The
handle is never minted by the Renderer and no RHI buffer or queue escapes the
host. A supplied `materialIdentity` must match a live MeshRenderer slot or the
MeshAsset material-slot source key; otherwise the host returns structured
`dynamic-geometry-invalid`. The normal draw path consumes the accepted standard
handle from `MeshFilter`, so main, depth, shadow, and motion/history share one
committed geometry identity. The lifecycle also bounds aggregate typed-geometry
bytes (`inspect().meshBytes` / `maxMeshBytes`) in addition to candidate count.

```mermaid
stateDiagram-v2
  [*] --> prepared: prepare
  prepared --> accepted: accept
  prepared --> cancelled: cancel / generation loss
  accepted --> published: successful draw FrameReceipt
  published --> retired: receipt-safe retirement
  accepted --> cancelled: detach / World teardown
```

`DynamicGeometryCandidate` is a short-lived credential bound to the attached
World object, live ECS entity, lifecycle owner identity, candidate revision,
MeshAsset handle, material identity, and active device generation. It contains
no mesh payload or mutable geometry arrays. The physical preparation host keeps
one private MeshAsset snapshot per candidate, captured synchronously before
upload or any asynchronous capacity wait. Caller changes to the source arrays
therefore cannot alter the prepared upload. Acceptance returns only the frozen
credential and performs no geometry copies. The pure CPU lifecycle validates
inputs and reserves their existing typed-geometry byte charge without retaining
a duplicate mesh payload. Count or byte budget refusal precedes snapshot
allocation. A Renderer acceptance records the attached World's `FixedTime` ordering and performs the
binding swap; a candidate with `physicsEntity` also records that entity's
PhysicsWorld admission step. A frame publishes only candidates for the
drawn lease Worlds whose candidate step is no newer than the actual World
`FixedTime.tick`, and whose PhysicsWorld publication has the exact candidate
revision. The optional frame `fixedStep` is checked against that World tick; it
is an assertion, not a second clock. Thus a multi-fixed-step host frame can
issue one receipt for the latest submitted frame without dropping an accepted
candidate, while a successful draw for another World cannot publish an
arbitrary credential. The public attached-Renderer receipt carries
`recordStageConsumed: true` and the embedded `frame.completed` fence, making it
a real record/submit proof, not a non-empty handle or counter. The detached
`createDynamicGeometryLifecycle` helper may intentionally publish a CPU-only
receipt with `recordStageConsumed: false`; that helper is not a Renderer draw
path and must not be used as GPU evidence.

`dynamicGeometryReceipt(candidate)` is present only after the accepted candidate
is published by a successful `FrameReceipt`; it carries the same `frameId`,
`deviceGeneration`, preparation fixed step, and actual publication fixed step.
A topology revision invalidates lower-revision prepared/accepted candidates for the same entity and
marks older published history invalid, but retains each published receipt's
completion fence; an already-published credential remains until an explicit
retire can release its GPU owner after that fence resolves. Each later
record-stage consumption emits a refreshed receipt and adds its
`FrameReceipt.frame.completed` fence, so retirement waits for every observed
in-flight frame (resolved or rejected), not only the latest receipt. The
immutable candidate changes only on lifecycle transitions; repeated publication
retains its identity in both the lifecycle and attached host. The
attached host revalidates the live `(World, entity, MeshFilter)` binding for
each candidate, so a topology change on entity B does not suppress a real
record-stage use of still-live entity A; only the candidate/entity whose
binding changed is refused.
The shared `GpuResidencyCache` owns allocation leases and submission fences.
A lease captures the concrete GPU allocation, not a reusable World handle slot;
cancelling B cannot invalidate a resource still used by A. Every submitted
frame conservatively fences all resident meshes, including ordinary, shadow-only
and cached GPU-driven uses, independently of publication or history validity.
In-place mesh invalidation immediately allows a new upload while old submitted
buffers retire behind their own completion. An accepted topology change resets
the existing temporal history owner before the next draw. The candidate's World
reference is also retained through completion so its handle slot cannot be reused.
The detached inspection reports both history invalidation and concrete
candidate invalidation. Stale revisions, cross-World/lifecycle candidates, old
generations, invalid GPU readiness, invalid ordering, duplicate acceptance,
unknown retirement, and bounded transient count/total mesh byte overflow are structured
`DynamicGeometryError` results. Cancelling or invalidating work leaves the last
published candidate untouched, cleans candidate-only residency when no other
ECS entity or candidate shares the handle, and never releases a caller-owned
shared reference. Call `retireDynamicGeometry` only after the receipt-bound
consumer no longer needs the old geometry, then release the asset handle through its Registry. Retirement is a logical state transition
first: the attached host keeps the retired candidate in the transient count and
its typed mesh bytes in the total byte budget until all receipt fences resolve and the candidate's shared GPU
lease is released. If the candidate is still the live `MeshFilter`, retirement
returns `dynamic-geometry-invalid` without deleting its receipt or GPU owner;
swap the binding through ECS first so the completion fence can safely retire it.
The pure lifecycle exposes `finalizeRetirement` for its owner to release that
deferred count/byte reservation after cleanup. Published meshes do not consume
the 32 transient slots, but their bytes remain charged to the 64 MiB budget.

This seam intentionally does not add a second asset registry, Pack kind,
RenderFeature, worker, or frame clock. Asset ownership is SSOT: the producer
owns sourceKey/GUID and Cooked Pack payloads, Catalog is only the projection,
the runtime `AssetRegistry` resolves GUIDs and owns each `MeshAsset` handle.
ECS retains references through `asset<mesh>` columns. Renderer never mints assets. Provider/Catalog/GUID cold
loading therefore continues through the existing route; a producer that needs
a custom voxel artifact owns that schema and loader outside the Engine, while
its projected standard mesh enters this candidate path.

### Residency resource retirement

Scope-owned `GpuBuffer` and `GpuTexture` registrations end when their explicit
`destroy()` succeeds. Failed destruction keeps scope ownership for cleanup;
scope termination still cleans remaining resources in reverse adoption order.
Mesh retirement waits for outstanding submission and candidate leases before
releasing that registration, so repeated mesh replacement does not retain all
destroyed handles in the renderer generation. Caller-held handles retain their
existing observable state; resource disposal is distinct from JavaScript GC.

A released residency lease waits for submissions already registered at release.
Later frames reusing a live mesh binding do not prolong that candidate's cleanup
or retain its capacity reservation. The allocation itself remains protected by
all active leases and submissions, including those later frames. Once the last
evicting lease's release fence completes, its cache mapping retires so unrelated
future frames cannot keep it resident. A new lease cancels that eviction; native
destruction still waits for the complete allocation lifetime.

### Targeted spatial inspection

`renderer.bounds(world, entity)` returns a detached world-space AABB from the last extracted composition, including the existing instance-bound projection. It returns `undefined` for an absent World/entity or unknown/invalid producer bounds. This is renderer geometry evidence, not collision geometry or a synchronous update of authored World changes. A subsequent draw refreshes the projection; callers must not substitute an origin for an unavailable mesh bound. The query reuses culling ownership and retains no additional bounds cache.

### Volumetric density coordinates

`VolumetricFog.density` is a producer-owned linear 3D source tile. In the default
`noise` mode the integrator samples repeated world-space coordinates, combines the
same three scales used by the approved fog fixture, and uses World time for the
continuous advection term. The renderer keeps the source texture resident; it
does not rebuild noise data for each frame. Its source expression is mapped to a
signed density and clamped only at the optical-depth boundary so Beer-Lambert
extinction remains non-negative.

The local `density` mode samples normalized owner bounds directly. Each owner
retains its own texture and optics; overlap sums coefficients before integration.
For a spatially varying scattering color, use authoring `sampling: 'density-albedo'`
or component `VolumetricFogSamplingValue.densityAlbedo`. The same linear 3D
source is `rgba8unorm` or `rgba16float`, with **RGB = albedo × density, A = density**.
Density is non-negative and field albedo is in [0, 1]; empty texels store zero
in all channels. The sampler interpolates these premultiplied coefficients,
so a boundary with empty space retains its color without multiplying density
twice. This optical field clamps at its own edge texel centers, so the opposite
edge never wraps into its boundary. The component's `albedo` multiplies the field albedo; extinction and
emission use the alpha density. Set component albedo to [1, 1, 1] for the field's
authored colors. Other formats fail authoring validation with
`volume-invalid-parameters`, `detail.field: 'density.format'`.

Both local modes use the existing source residency, publication and retirement;
color adds no texture binding or extra volume owner. Replace the ordinary source
payload to update the field and remove its component to retire the volume.
Changing the sampling mode invalidates temporal history. Noise and scalar
`density` continue to consume the source's red channel.

Density integration partitions at owner entry/exit boundaries and uses 96
fixed midpoint steps per interval, including the clipped final segment.
Segments near a selected PointLight or SpotLight
receive four local midpoints to resolve the inverse-square peak without making
the whole ray uniformly expensive. Frame identity does not rotate density
samples. Shadow visibility uses matching froxel centers without per-frame XY
jitter or stochastic byte dithering; shared PCF shadow filtering remains in
effect.

## Camera Depth of Field

`DepthOfField` is the built-in Standard camera effect for ordinary meshes. Add it
only to the active perspective camera; component removal or
`maxRadiusPixels: 0` declares the exact zero-work path. The side and quality
fields use the closed numeric values exported by this package:

```ts
import {
  DepthOfField,
  DepthOfFieldQualityValue,
  DepthOfFieldSideValue,
} from '@forgeax/engine-render';

world.addComponent(camera, {
  component: DepthOfField,
  data: {
    focusDistance: 8,
    fStop: 1.4,
    sensorHeight: 0.024,
    maxRadiusPixels: 16,
    quality: DepthOfFieldQualityValue.medium,
    blurSide: DepthOfFieldSideValue.both,
  },
});
```

The near, far and both presets share one signed thin-lens CoC. `quality` changes
sampling density only, so it does not change the optical radius. The graph uses
the Standard `RenderExtent`: full-resolution CoC/composite targets follow the
current internal or output domain, and half-resolution targets use
`max(1, ceil(axis / 2))`. Current temporal-v1 depth validity and the resolved
multisampled depth binding remain the source of truth.

Near gather, far gather and background reconstruction share one source-disk
traversal, preserving their separate color, depth acceptance and coverage.
The both-side graph uses seven passes with three gather outputs; near-only
uses five passes with two outputs, and far-only uses five with one. Disabled
sides allocate no intermediate targets. Sampling density and optical radius
remain unchanged by this sharing.

Uncovered background (reverse-Z depth 0) is depth at the far plane, so a
defocused far silhouette spreads over the sky. Far acceptance is asymmetric: a
nearer far-field circle covers the background behind it, while a farther source
reaches a destination only inside that destination's own circle, so sharp
layers never gain a background halo.

After a real `draw()` submission, read `renderer.inspect().depthOfField` for the
requested component values, effective submitted values, graph/device
generations, extents, pass count and descriptor-derived bytes. `lastKnownGood`
and `effective` stay bound to the accepted submission; a failed candidate keeps
the prior accepted projection and reports its failure reason for recovery.
When the active camera has no `DepthOfField` component, the inspection remains
available with `status: 'off'` and zero DoF graph facts. Invalid fields and an
orthographic camera stay on the normal camera snapshot path with structured
`error.code`, `error.expected`, `error.hint`, and `error.detail`; they report
`status: 'invalid'` or `status: 'unsupported'` without admitting a DoF graph.
The Engine Preview/game capability lab uses this same component on its ordinary
mesh camera, and its settings control toggles component presence through the
normal World path.

## Standard camera lens effects

Add `LensEffects` to the active camera to combine vignette, directional chromatic
aberration and animated monochrome grain in one output-resolution pass. Each
intensity is independently adjustable through ordinary World writes; gameplay
systems own hit pulses, sprint ramps and fade timing.

| Field | Default | Contract |
|:--|--:|:--|
| `vignetteIntensity` | 0 | Finite `[0, 1]`; blend toward the tint at the viewport edge |
| `vignetteRadius` | 0.5 | Finite `[0, 1]`; unaffected inner radius, center 0 and corners 1 |
| `vignetteSoftness` | 0.5 | Finite `[0.001, 1]`; smooth transition width in normalized viewport radius |
| `vignetteColor` | `[0, 0, 0]` | Three finite linear RGB channels in `[0, 1]`; red supports hit feedback |
| `chromaticAberration` | 0 | Finite `[0, 32]` output pixels; offset per red/blue channel |
| `chromaticAberrationAngle` | 0 | Finite `[-pi, pi]` radians; counterclockwise sample direction, matching Three.js |
| `grainIntensity` | 0 | Finite `[0, 1]`; Three.js FilmShader multiplicative noise mix |
| `grainSize` | 1 | Finite `[1, 8]` output pixels per grain cell |

```ts
import { LensEffects } from '@forgeax/engine/render';

world.addComponent(camera, {
  component: LensEffects,
  data: { vignetteIntensity: 0.25, grainIntensity: 0.04 },
}).unwrap();

// Hit feedback; an ordinary gameplay system fades these values back down.
world.set(camera, LensEffects, {
  vignetteColor: [0.6, 0, 0], vignetteIntensity: 0.8,
  chromaticAberration: 3,
}).unwrap();

// Exact zero-work path, including after previously enabling the effect.
world.set(camera, LensEffects, {
  vignetteIntensity: 0, chromaticAberration: 0, grainIntensity: 0,
}).unwrap();
```

The Standard order is tone/LUT, outline, barrel distortion, FXAA, `lens-effects`,
then the single output encoding. Grain is added after antialiasing, so temporal
history and FXAA do not smear it. Chromatic aberration preserves the center
green/alpha sample; red/blue sample in opposite directions with clamped edges.
This does not replace the displayed geometry/picking mapping or transform DOM HUDs.
The reference is Three.js at [`b745e6c`](https://github.com/mrdoob/three.js/tree/b745e6cb7b098e4b56bb9a3dbb1ab0b480f35aa2/examples/jsm/shaders):

| Three.js reference | Engine adaptation |
|:--|:--|
| `VignetteShader` | Centered RGB tint blend; explicit radius/softness replace offset/darkness for hit feedback |
| `RGBShiftShader` | Same opposite R/B samples and center G/alpha; distance uses output pixels and Y follows top-left textures |
| `FilmShader` | Same `mix(base, base + base * clamp(0.1 + noise, 0, 1), intensity)`; black stays black and increasing intensity also brightens the image |

Grain uses output pixels and the captured renderer frame number, so a fresh-device
RHI Debug replay reproduces the same pattern without a wall clock or random texture. Its integer hash replaces Three.js's time-driven floating-point random function; grayscale conversion is outside this effect.

Absent components and three zero intensities declare no lens pass, intermediate
texture or GPU upload. Invalid fields fail before graph admission with
`lens-effects-invalid-parameter` and structured field/value/bounds. The existing
Renderer owns capability admission, graph replacement, in-flight retirement and
recovery; this effect needs `rgba16floatRenderable` just like the other Standard
linear-LDR companions.

Inspect `renderer.inspect().perFramePassNames` for the single `lens-effects`
pass. The shared `lens-effects.fixture.ts` Browser/Dawn regression captures live
frames, inspects the effect's bindings/work item, compares fresh replay pixels,
and rejects a tape with its draw removed. Evidence is saved under
`artifacts/lens-effects/{browser,dawn}/`.

## Standard camera barrel distortion

`BarrelDistortion` is the bounded output-space camera companion. Its
`strength` is finite in `[0, 0.35]`; `centerX` and `centerY` are finite fractions
in `[0, 1]` with a top-left origin. The Standard stage samples linear-LDR color
after LUT and before FXAA and the single output encoding. Positive strength uses
the automatic crop rule, so the fixed-FOV camera sees a narrower region. Missing
or zero strength preserves the exact zero-work path.

If a DOM or `OffscreenCanvas` drawing buffer is temporarily zero-sized (for
example while hidden or detached), `renderer.draw()` stops before configuring
or submitting a zero-sized swapchain texture. The public result is a structured
`device-operation-failed` whose nested cause is `rhi-not-available`; the last
accepted `FrameReceipt` remains the LKG and a later positive-size draw resumes
the same camera mapping without a GPU validation cascade.

```ts
import { BarrelDistortion } from '@forgeax/engine-render';

world.addComponent(camera, {
  component: BarrelDistortion,
  data: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
});
```

Invalid authoring is a closed error-code path. Narrow on `error.code` and read
the structured fields; do not parse `error.message`:

```ts
import { createBarrelDistortionMapping } from '@forgeax/engine-render';

const mapping = createBarrelDistortionMapping(1920, 1080, { strength: 0.4 });
if (!mapping.ok && mapping.error.code === 'barrel-distortion-invalid-parameter') {
  const error = mapping.error;
  const field = error.detail.field;
  const value = error.detail.value;
  const detailExpected = error.detail.expected;
  const expected = error.expected;
  const hint = error.hint;
  console.error({ field, value, detailExpected, expected, hint });
}
```

In the design language, `actual` and `bound` map to the public Barrel members
`error.detail.value` and `error.detail.expected`. Barrel errors do not expose
`error.detail.actual` or `error.detail.bound`; those member names remain owned by
`shadow-invalid-config` only.

`createBarrelDistortionMapping(outputWidth, outputHeight, data)` derives the
immutable effective mapping. Reuse the mapping attached to the submitted
`FrameReceipt` or the serialized worker frame signal. `mapDisplayToScene` and
`mapSceneToDisplay` write continuous output-viewport physical pixels through
out-parameters; inverse points cropped outside the display rectangle return
`false`. The public `@forgeax/engine-picking` display entrypoints use this
mapping once, while legacy picking continues to accept unwarped viewport
coordinates. DOM/ShadowRoot HUD layout remains unchanged; world labels and
vertex radius sorting must use the inverse mapping in display pixels.

## Render publication

`Renderer.bounds(source, entity)` reads detached culling bounds from the last
extracted projection. `source` is an attached World or the configured
`RenderPublicationIdentity`; unknown identities, old epochs, and unavailable
records return `undefined`. This permits on-demand Worker observation without
copying the render scene back into the source World.

`createRenderPublisher(world, assets, identity, capabilities, features, targets)` projects native
StateProjection and GlobalTransform change evidence. `prepare()` returns a
candidate: call `accept()` synchronously after successful `postMessage`, or
`discard()` if sending fails. The candidate's `message` (`RenderPublicationMessage`,
protocol 4) is the only form that crosses a realm and that `Renderer.draw({ publication })`
accepts: `{ source, epoch, revision, record, side? }`. `record` is one ArrayBuffer per
publication slot holding a 128-byte Float64 header (protocol, base, flags, time,
sample time, transparent sort, column counts) followed by the upsert, removed,
transform-identity and retired-joint u32 columns and the f32 transforms (16 per
identity). `side` exists only for non-empty low-frequency rows (materials, templates,
programs, features, targets, canvas/video frames, assets and patches) and for the
top-level frame metadata entries that differ from the receiver's last accepted
publication (`retiredMetadata` lists removed entries); an unchanged frame is a
header-only record with no `side`. A baseline, or a message encoded without accepted
metadata, carries complete metadata; recovery starts a new epoch and therefore a
complete baseline. Send `renderPublicationTransfers(message)` (exactly the record) with
`renderPublicationAssetTransfers(message)`. Return the record through `recycle()`
after the receiver's FrameReceipt completes. The asset transfers own independent mesh
copies, including aliased attribute buffers; these stay with receiver asset residency
and never return with frame storage. ECS and original asset storage remain owned by
the source. `renderPublicationBytes(message)` reports `{ columns, assets }`: the
record's logical bytes and the transferred asset buffers. The Render Worker attaches it
to every `frame-submitted` as `publicationBytes`. SharedArrayBuffer is deliberately not
used: Engine and Render Workers do not require cross-origin isolation, and one
transferred record per slot measures within noise of a SAB ring (see
`reports/unified-render-ecs-20261024/design.md` §10).

Programs are published once per accepted source key. On receipt, unknown programs
undergo full validation once; the consuming ShaderRegistry adopts those validated
facts after the complete batch passes. Already installed keys still compare source,
complete schema and receipt content, and runtime artifacts still compare actual
bytes regardless of digest. Program or target admission failure leaves the accepted
asset namespace, time and revision unchanged so a corrected packet can retry the
same revision. This is a publication admission optimization, not per-frame shader work.

`await renderer.preparePublishedMeshResidency({ source, epoch, meshHandle, mesh })`
prepares a standard Mesh in that same receiver resource namespace before its
first scene publication. The internal `pipelinePreparation` payload carries the
source candidate's real entity, transform, material template and unpublished
program closure; the receiver installs that closure through ordinary publication
admission and awaits the same candidate pipeline stage. Native cloning rebinds
material schemas to their admitted program owner. The optional third argument
`{ signal }` cancels outstanding preparation while still awaiting submitted upload
fences before releasing physical ownership. It resolves only after physical queue completion and
returns a device-generation lease with `isCurrent()`, fence-aware `release()`,
and `recordStageLane(frame, entity)`. Preparation does not admit a scene row or
make an unpublished asset a valid dependency. The next packet must publish the
same Mesh content under the same source handle; a conflict rejects the entire
packet before accepted state changes. Receiver-owned bytes include copies of
shared source buffers. World mutation, candidate budgets and fixed-step geometry
admission remain source responsibilities.

Lane queries accept only the exact current submitted FrameReceipt in the same
device generation. An old or copied receipt rejects structurally; a current
frame that did not draw the mesh returns `undefined`. Upload readiness alone
never produces draw evidence. Cancellation, retirement and receiver disposal
fence physical allocations against submitted GPU work, and late upload
completion cannot revive a retired lease. Direct World Renderer preparation
retains its existing synchronous contract.

`release(false)` transfers a prepared allocation to the accepted scene. If the
source World has bound the Mesh but its packet has not arrived, the receiver
retains the allocation and Mesh identity until actual packet acceptance.
`release(true)` upgrades a pending transfer to cancellation; receiver retirement
does the same, so shutdown never depends on a future source publication.

A prepare input may set `renderAttributes: 'packed-rows'`. For a static
raster-only triangle mesh (only float32 visual channels; no skin, morph, LODs,
surface cards or distance field), the Render realm then receives only the packed
interleaved `vertices`, `indices`, `aabb` and an empty layout key per channel,
marked `renderAttributeStorage: 'packed-rows'`. The layout, stride and digest
are unchanged, and the packed rows are still retained for re-upload after eviction.
The World MeshAsset keeps every channel, so picking, patches and recovery are
unaffected. Candidate `meshBytes` charges only the bytes held. Cold Render
readers (transport projection, probe cards, mesh particles) rebuild the exact
channels from the rows on first use. A patch that writes a channel without its
`vertices` rows fails loudly. The receiver validates the marker form explicitly.
Managed asset admission still requires complete channels and never accepts this
form. Ineligible meshes silently keep full channels.

`Renderer.prepareDynamicGeometry` and `prepareDynamicGeometryCandidates` retain
synchronous mesh-buffer preparation. A caller that also needs raster readiness
awaits `prepareDynamicGeometryPipelines(candidates, { signal })` on those same
prepared credentials before FixedUpdate acceptance. This stage extracts each
candidate's real rigid mesh layout, material bindings and selected programs without
changing its `MeshFilter`. It requests only the CPU/GPU color, depth/temporal and
shadow lanes selected by the current compiled view graphs, using the ordinary PSO
owner. Typed scene passes retain their declared GPU material lane even when the
current scene has no GPU batches; the existing scene owner's geometry-lane policy
still controls whether that lane is available. Shadow preparation uses the current
light projection roster, including a light with no visible caster yet.
GPU-selected submeshes do not also compile unused direct PSOs. Stable
candidate projections survive compilation waits; no temporary scene entity, GPU
Scene row, draw command or second pipeline cache is created.

Candidate compilation has a separate pending state, so current scene frames keep
submitting while native compilation is outstanding. A native PSO rejection returns
its original cause with `dynamic-geometry-gpu-not-ready`. No current view or no
applicable raster lane fails explicitly; stalled preparation is bounded to 30 seconds.
Skin, morph, terrain, sprite and expanded point/line candidates require their own
specialized preparation and are rejected by this rigid candidate path. Readiness
covers the captured current raster demand, not future camera or graph changes.
Changing the candidate mesh, generation or material binding invalidates preparation.
Supported numeric material changes that alter raster selection (including alpha
coverage, transmission lane or texture specialization) invalidate it; ordinary
uniform changes retain the compiled PSOs. Collective source currentness checks only
pending candidates, never the retained published terrain roster.

`AsyncDynamicGeometryHost` separates asynchronous physical preparation from
synchronous World admission. `createAsyncDynamicGeometryHost(renderer)` adapts
an actual local Renderer and awaits both mesh buffers and candidate pipelines;
App supplies the same contract for a split Render Worker. `currentGeneration()` is undefined before Render readiness. Consumers
use `isDynamicGeometryCurrent(candidate)` to query the original candidate and
physical owner, including source-session invalidation when a replacement
device reports the same numeric generation. Preparation
accepts an optional AbortSignal and holds the existing candidate byte budget
and World shared references while upload or pipeline compilation is pending. Cancellation and recovery
retain those references until physical release completes. Neither upload
completion nor a Promise continuation mutates ECS. Expected refusals use the
existing structured error unions; uncertain physical failures fault the paired
World owner and require recovery.

`prepareDynamicGeometryCandidates(inputs, options?)` declares a complete roster
of 1–4096 distinct entities in one World. It returns the existing candidate array;
only that exact complete group may be admitted together. Subsets, combined groups,
and singular admission of a multi-member group refuse before any binding changes.
The group occupies one retained preparation slot, while every member retains its
full mesh-byte charge. The source host prepares physical residency in bounded
concurrent windows; the residency port arbitrates shared credits across rosters
and standalone leases. Every started member settles before a failed roster is
cancelled; a held standalone lease never becomes an unbounded capacity wait.
A typed preparation refusal, abort,
detach or generation replacement cancels the entire preparation; native fences
still control when its bytes and World references can be released. After successful
preparation, consumers cancel or retire each returned candidate through the existing
methods. Publication still requires each member's actual consumed FrameReceipt.

The internal `createDynamicGeometrySourceHost` reuses the native candidate,
atomic batch acceptance, rollback and publication owner with a physical
residency port. All members of a declared roster capture their protected
mesh and material/program snapshots before its first upload window starts. A later snapshot-copy failure
cancels the staged roster and releases its references and byte reservations.
The port receives the private snapshot; consumer credentials carry no payload.
Worker transport still clones Mesh POD into receiver-owned bytes and never
transfers the caller or source owner buffers. Source FixedUpdate remains the
only admission boundary. Remote draw receipts require captured record-stage lanes, the native FrameReceipt
identity and the consumed source FixedTime tick; a missing tick cannot borrow
the newer simulation time. Standalone `prepareMeshResidency` uses the same
physical port and transfers residency only after a live World MeshFilter owns
the source handle.

Template deduplication compares material values. During one `prepare()`, shared
materials and their parameter snapshots serialize once, including parameters
referenced by multiple dispatch entries. Entity-owned skin, instance, sprite-instance
and points/lines payloads already carry unique source identities and skip template
deduplication. Equal templates share one dependency traversal, and each source
asset is resolved once for the packet. Meshes with only one changed row skip key
generation because no other template can share their mesh handle. The packet
retains the original snapshots; temporary value identifiers and serialized keys never cross preparations.

A Renderer constructed with `publicationSource: { source, epoch }` consumes
`draw({ publication })` through its existing PersistentRenderScene and full
prepare/record/submit path. It refuses local World leases. Source identity,
epoch, baseline, base revision, and numeric columns are checked before CPU
acceptance. CPU acceptance advances the publication revision; it is distinct
from successful GPU submission/completion. A failed consumer is replaced with
a fresh identity epoch and baseline by the App Render Worker owner.
Numeric validation scans the received Float32 columns and each skin matrix in
place before acceptance. It retains finite-value, shape and atomic rejection
checks without callback boxing or concatenating the two skin matrix arrays.

Temporal visibility belongs to the submitted scene slot and its generation.
Submission captures own a slot-to-generation map; commit copies that membership,
so a later capture, slot reuse or reset cannot mutate an earlier capture. Failed
submissions retain the previously committed visibility and transforms.

| Surface | Publication contract |
|:--|:--|
| Standard mesh/material/texture, camera and light facts | Baseline plus structural, resource, and transform deltas |
| Cooked material programs | Immutable shader metadata/artifacts installed in existing receiver registries |
| Managed Material / Mesh edits | Shared resource changes reach receiver residency without entity upserts |
| Source assets | Handle dependencies are published before use and retired after the last consumer |
| Skin, morph, instances, points/lines, sprites, LOD | CPU source facts cross; receiver allocates palettes and retains instance/history identity |
| Glyph text and tilemaps | Renderer native sources read shared Font/Tileset content during actual draw work; asset updates do not revisit entities |
| Video | `VideoSourceProvider` supplies native frames; publication clones the decoded backing and receiver releases its owned frame after synchronous upload |
| Environment, fog/cloud, camera LUT, light texture modifiers | Frame resource closure is published alongside metadata |
| Auxiliary/cube views and probes | Logical target descriptors/references remap to the receiver target owner; resize and recovery preserve logical identity |
| Declarative RenderFeatures | Source `extract`, cloneable frame data, receiver `plan`, receiver-local `onFrameSubmitted`, source `onSourceFrameSubmitted` acknowledgment |
| `createFullscreenRenderFeature` | Game-owned installation publishes its immutable declaration once; source `enabled(context)` selects an empty or active plan per frame, including late installation and plugin retirement |

The source retains identity and dependency indexes. The receiver owns the only
persistent RenderScene for this path and resolves assets through `AssetReader`.
Same-realm Renderer consumers keep their synchronous World path.

A publisher admits at most two outstanding revisions: one consuming frame and
one sealed successor. Feedback and returned storage are revision-scoped; recycling
is ordered, and returned buffers remain available across a drained pipeline.
`prepare()` refuses a third frame until capacity returns. Call `accept()` synchronously
after successful transfer so source change evidence cannot cross an asynchronous write.

Feature frame data and feedback must be structured-cloneable. The source keeps
its extracted facts immutable until submission acknowledgment. A receiver-owned
`inspection` projection may be replaced after planning and submission; the host
publishes that detached diagnostic value without changing source authoring facts. A feature's
`assetDependencies(data)` declares GUID roots or exact shared asset handles. GUID
closures, material programs and handle-selected immutable definitions use the same
accepted resource namespace as scene assets. `plan` reads exact definitions through
`context.resolveAsset(sourceWorldIndex, handle)` on either the local World or the
accepted publication. Stable dependencies are omitted from subsequent packets;
retirement and replacement epochs follow the existing publication lifecycle.
At extraction, the optional `context.referenceAsset(sourceWorldIndex, identity, captured)`
admits a captured payload only when it is the exact current World asset projection.
A feature may replace that inline value with the returned handle, declare the
handle in `assetDependencies`, and resolve it during planning. An absent callback
or an undefined result keeps the inline value authoritative, including distinct
custom provider payloads. Admission reuses the existing GUID/handle owner and
includes managed runtime-content projections; it introduces no second resource cache.
The receiver must construct matching feature implementations before drawing.
Unknown feature identities, stale/duplicate acknowledgments and foreign GPU
skin receipts are rejected. VFX uses this seam to preserve ordered fixed-tick
intents and reconstruct retained emitter state after receiver replacement. Device
recovery seeds the feature host with the last submitted publication data and the
accepted resource resolver; preparing a candidate never acknowledges source ticks.

`RenderPublicationTargetOwner.authoring` reuses target descriptor validation
without allocating a GPU object. Its receiver creates physical targets through
the normal Renderer target host. Direct publication users supply that owner to
the publisher; App assembles it automatically for the Render Worker tier.

### Extraction and graph transaction ownership

`extract/world-environment.ts` owns camera, light and environment facts before
renderable projection. Material and mesh traversal consume those facts instead
of sharing their local light validation and shadow construction state. The
shared snapshot contracts live in `render-system-extract.ts`; frame orchestration lives in `render-system-extract-tail.ts` and is imported directly. The facts and contract modules never import the orchestrator.

Every compiled graph replacement has one candidate and one complete previous
projection. Volume, DoF, barrel mapping, resize and ordinary topology changes
settle at the same frame submission barrier. Failure restores graph identity,
lookup projection, both generation counters and lighting signature together;
retirement remains fenced by in-flight GPU work.
## Public clipping planes

`ClippingPlanes` is an optional Camera companion. `withClipping(material,
options)` declares clipping on a Standard or Unlit root material before Pack
cooking. Both use world-space `[nx, ny, nz, constant]` coefficients and discard
where `dot(normal, positionWS) + constant < 0`. Coefficients are normalized
together; object transforms do not move these world-space planes.

```ts
const material = withClipping(Materials.standard({ baseColor: [1, 1, 1, 1] }), {
  planes: [[1, 0, 0, 0]],
  clipShadows: true,
});
// Publish/cook/load this material through the ordinary asset route.
world.addComponent(camera, {
  component: ClippingPlanes,
  data: clippingPlanesData({ planes: [[0, 1, 0, -2]], clipShadows: true }),
}).unwrap();
```

| Option | Semantics |
|:--|:--|
| `planes` | Zero to six finite nonzero-normal planes; an empty list disables clipping. |
| `intersection` | Default false discards any negative half-space; true discards only points negative to every plane. |
| `clipShadows` | Default false, matching Three.js local clipping. True applies the same predicate to directional, spot and point shadow writers. |
| Camera plus material | A fragment must survive both independently configured groups. |

Color, GBuffer/depth and temporal coverage share the world-position predicate.
Rigid, instanced, skinned and GPU Scene Standard geometry use their transformed
world positions. Plane clipping does not construct section caps or modify CPU
mesh bounds/picking. Expanded Points/Lines support camera planes and refuse local
material clipping with `points-lines-material-unsupported`. Custom shaders must
explicitly consume the public clipping shader module; custom RenderFeatures remain responsible for their coverage.

`CameraSnapshot.clipping` is the detached per-view contract for auxiliary target
captures. Planar reflection mirrors the display view, preserves its public
clipping planes in a separate snapshot, and sets `clipShadows: false` for the
capture. Its oblique near plane remains owned by the reflection camera. Future
refraction captures can use the same per-view boundary.
Shared shadow maps use the selected display camera's shadow policy plus each
material's policy. Auxiliary/cube/probe captures reuse those maps; their view
planes do not regenerate shadows. Capture-specific boundary planes therefore
use `clipShadows: false`.
No reflection-specific plane registry, global mutable renderer state, or second
capture graph is introduced.

The convention and opt-in shadow policy follow
[Three.js Material clipping](https://threejs.org/docs/pages/Material.html#clippingPlanes).

## Selection outline

`Outline` is an active-camera companion. Its `entities` are exact entity handles
in that camera's World; descendants are explicit members, and duplicate handles
collapse to one member. It renders the union silhouette (no internal seam between
selected objects). Selection is frame data and never changes the scene's visibility
or materials. The ordinary geometry coverage variants retain skinning, instancing
and alpha-cutout behavior.

```ts
import { Outline, OutlineOcclusionValue } from '@forgeax/engine/render';

world.addComponent(camera, {
  component: Outline,
  data: {
    entities: [target, pickup],
    visibleColor: [1, 0.5, 0],
    hiddenColor: [0.15, 0.05, 0.02],
    width: 2,
    occlusion: OutlineOcclusionValue.all,
  },
}).unwrap();
```

| Field | Contract |
|:--|:--|
| `entities` | Camera-World entity set; exact handles, no implicit hierarchy expansion |
| `visibleColor`, `hiddenColor` | Linear RGB in `[0, 1]`; defaults orange and dark brown |
| `width` | Integer output pixels in `[0, 8]`, default 2; square separable dilation |
| `occlusion` | `visible` (default), `hidden`, or `all` from `OutlineOcclusionValue` |

```mermaid
flowchart LR
  S["Selected material coverage"] --> D["Selected depth"]
  D --> M["Visible / hidden mask"]
  Z["Existing scene depth"] --> M
  M --> H["Horizontal dilation"] --> C["Vertical dilation + composite"]
  T["Tone + LUT"] --> C --> B["Barrel / FXAA / output encoding"]
```

The scene depth decides occlusion. Transparent surfaces with depth writes disabled
do not become occluders. Selected objects use their material coverage, not the
bounding box or an inflated copy. Width is measured before any authored barrel
warp. The effect adds no work when the component is absent, the set is empty, or
width is zero. Destroyed/hidden/non-renderable members contribute no coverage.
Colors and membership are read from the submitted frame, including Render Worker
publications. All targets retire through the existing RenderGraph lifecycle.
Installed feature shader readiness survives an empty frame plan; uninstall or
device-generation retirement releases the module. Re-enabling a selection is
therefore effective on its first submitted frame.

`outline-invalid-parameter` identifies invalid width, policy or color through
`detail.field` and `detail.value`. `renderer.inspect().perFramePassNames` exposes the five
`outline-*` passes for graph inspection. RHI Debug sees the same selection draw,
shared-depth classification, dilation and composition as normal rendering.
The permanent Dawn/browser acceptance captures v7 tapes, inspects composition
bindings and pixels on a fresh device, and removes the composite draw as a falsifier.

The reference is [Three.js OutlinePass](https://threejs.org/docs/pages/OutlinePass.html):
selection mask, depth visibility classification, edge expansion, then composition.
ForgeaX uses its existing depth and output chain. Glow, animated pulses and pattern
textures are separate effects and are not part of this component.

## Public material MRT

A root `MaterialAsset.passes[].outputs` declares an ordered fragment interface.
Array index is WGSL `@location(index)`; each output has a diagnostic `name`,
`format`, optional `blend`, and optional `writeMask`. Omitted per-output blend
means replacement, including integer IDs. It does not inherit pass-wide blend.
Materials without `outputs` retain their existing single-color or built-in pass contract.

```mermaid
flowchart LR
  A["MaterialPass.outputs + WGSL locations"] --> B["Cook: Naga selected-stage validation"]
  B --> C["Pack / GUID load / material dispatch"]
  C --> D["RenderGraph attachments / pipeline admission"]
  D --> E["One renderer submission / FrameReceipt.completed"]
  E --> F["RHI Debug capture / fresh-device replay / all attachment pixels"]
```

| Output | Example format | Use |
|:--|:--|:--|
| `color` | `rgba16float` | Linear color, optionally blended |
| `objectId` | `r32uint` | Exact integer identity; no blending |
| `mask` | `rgba8unorm` | Effect selection and channel write masks |
| `screenData` | `rgba16float` | Signed or HDR per-fragment data |

```ts
const outputs = [
  { name: 'color', format: 'rgba16float' },
  { name: 'objectId', format: 'r32uint' },
  { name: 'mask', format: 'rgba8unorm' },
] as const;
const material = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'game::mrt' }, outputs,
    renderState: { tags: { LightMode: 'Forward' } } }],
};
```

```wgsl
struct Outputs {
  @location(0) color: vec4<f32>,
  @location(1) objectId: u32,
  @location(2) mask: vec4<f32>,
}
@fragment fn fs_main() -> Outputs {
  return Outputs(vec4<f32>(0.2, 0.4, 0.8, 1.0), 123456789u, vec4<f32>(1.0));
}
```

The application cooks and loads the material through the ordinary asset route.
At renderer construction, `pipeline` accepts a `RenderPipeline` from
`@forgeax/engine/render/authoring`. Its build callback declares resources and
work in the existing renderer graph; it cannot submit or own a second frame loop.
Omitting `pipeline` selects Standard. `standardProfile` continues to configure
Standard policy and does not replace an explicitly supplied pipeline.

```ts
import {
  addTypedScenePass, addTypedOutputTransformPass,
  createRenderPipelineTarget, importRenderPipelineSurface,
  type RenderPipeline,
} from '@forgeax/engine/render/authoring';

const pipeline: RenderPipeline = {
  build({ graph, observationCaptureDomains }, topology) {
    const targets = outputs.map(output => createRenderPipelineTarget(graph,
      output.name, { format: output.format, size: 'surface' }).unwrap());
    const depth = createRenderPipelineTarget(graph, 'depth', {
      format: 'depth24plus-stencil8', size: 'surface',
    }).unwrap();
    const scene = addTypedScenePass(graph, {
      name: 'mrt', color: targets[0]!, colorTargets: targets, depth,
      selector: { LightMode: ['Forward'] },
      colorClearValues: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    });
    if (!scene.ok) return scene;
    // Additional passes use targets[1].view / targets[2].view with sampled-read.
    // Integer ID consumers use textureLoad with texture_2d<u32>.
    const surface = importRenderPipelineSurface(graph, topology);
    if (!surface.ok) return surface;
    // Forwarding the requested domains captures a final-display receipt here.
    return addTypedOutputTransformPass(graph, targets[0]!, surface.value.storage,
      { outputOnly: true, observationCaptureDomains });
  },
};
// createRenderer(canvas, { pipeline }) installs this composition once.
```

Attachments are matched by location and format, not by resource label. Keep all
shader outputs and attachment formats in the same order. `colorClearValues` and
`colorLoadOp` are per attachment; `RenderPipelineTarget.resolveTarget` projects an
explicit per-attachment MSAA resolve through normal graph accesses. Integer
attachments require a supported sample count; the device validates format-specific
limits. Graph compilation refuses more targets than `caps.maxColorAttachments`.
Downlevel hardware is not given a silent multipass substitute.

> [!IMPORTANT]
> RHI Debug evidence is per work item and per attachment. A color screenshot alone
> does not prove an ID or mask output. The MRT fixture loads an authored Pack over
> Vite HTTP, checks live pixels after the receipt, reads each replay attachment on
> a fresh device, resizes, and falsifies the result by removing the recorded draw.

Run `material-mrt.browser.test.ts` in its normal
Vitest projects. Artifacts are written to `artifacts/material-mrt/{dawn,browser}`.
Each report binds its tape digest, work index, event anchor and attachment IDs.
The focused gates supplement the full hello/learn-render 60-frame roster,
`pnpm test:browser`, and `pnpm test:dawn`.

Reference: Three.js [MRTNode](https://threejs.org/docs/pages/MRTNode.html) names
outputs and permits individual blend/clear policy; its
[post-processing guide](https://threejs.org/manual/pages/webgpu-postprocessing.html)
shows attachment format selection and downstream sampling. ForgeaX preserves
those result capabilities through MaterialAsset and RenderGraph instead of adding
a separate material node system.

## Material color writes and polygon depth offset

Author these values on the existing `renderState`; no additional material or
renderer mode is required. All pipeline builders use the same material-to-RHI
projection, and these fields participate in existing pipeline cache identities.

| Intent | `renderState` |
|:--|:--|
| Invisible depth occluder | `{ colorWriteMask: 0, depthWriteEnabled: true }` |
| Write red and blue only | `{ colorWriteMask: 5 }` |
| Coplanar overlay pulled toward the camera | `{ depthBias: -1, depthBiasSlopeScale: -1, depthWriteEnabled: false }` |
| Default behavior | Omit fields: RGBA writes enabled, all depth offsets zero |

For an occluder, submit it before the geometry it should hide (for example use
`queue: 1999` before the default opaque queue). A write mask preserves the
existing attachment contents; it cannot erase color already drawn. Polygon bias
changes fragment depth before comparison and depth writing, not vertex positions
or CPU bounds. Negative values pull forward with the engine's conventional
`less` depth convention. The units are format/backend dependent; do not assume
an identical metric offset across depth formats. Offsets require a depth
attachment and triangle rasterization; WebGPU requires zero bias for point and
line primitives.

| Pass | Color write mask | Polygon offset |
|:--|:--|:--|
| Forward, transparent, deferred/MRT, prepared color, GPU-driven | Intersected with each attachment's `outputs[].writeMask` when authored | Same authored depth bias |
| Explicit depth-only pass | No color attachment to mask | Same authored depth bias and depth-write/compare settings |
| Automatically generated Standard/Unlit shadow | No color output; independent depth-write/compare defaults | Shares culling, winding and polygon offset |
| Derived temporal/coverage | Writes all scene-data channels independently of material color mask | Preserves offset to match visible depth |

A partial mask in a deferred/MRT pass applies to its encoded attachments, not
only albedo. `outputs[].writeMask` may further restrict an individual target;
the material mask cannot re-enable a channel disabled there. Color-write suppression does not disable shadow casting: use
`ShadowParticipation { cast: false }` on the entity for that intent. Explicitly authored shadow passes retain
control of their own full `renderState`.

The [Three.js Material contract](https://threejs.org/docs/pages/Material.html)
provides the reference behavior: `colorWrite: false` maps to `colorWriteMask: 0`,
`polygonOffsetUnits` maps to `depthBias`, and `polygonOffsetFactor` maps to
`depthBiasSlopeScale`. The optional clamp follows WebGPU. Zero offsets disable
bias, so there is no duplicate enable switch. Constant units are an integer in
WebGPU; unlike WebGL, fractional constant units are not supported.

Verification lives in `material-raster-state.unit.test.ts` and the matching
Browser/Dawn tests under `src/__tests__`. Both GPU tests capture the actual
material pipeline, decode v7, inspect state, replay on a fresh device, and compare
live/replay pixels exactly. The Dawn test writes `.rhitape` and JSON receipts to
`artifacts/material-raster-state/`, including work/event indices, digest and
initial-content diagnostics. Run:

```bash
pnpm exec vitest run --project dawn packages/render/src/__tests__/material-raster-state.dawn.test.ts
```
## Planar reflection capture

`PlanarReflection` belongs to a display `Camera` and names its distinct sampled
2D reflection `target`. The owning camera supplies perspective/orthographic optics;
the renderer reflects its eye, forward and up, then applies an oblique near plane
in the RHI zero-to-one depth convention. Capture and water sampling share the
ordinary frame graph, encoder and submission.

| Field | Meaning | Default |
|:--|:--|:--|
| `normal`, `distance` | World plane `dot(normal, position) + distance = 0`; normal faces the retained half space | `[0, 1, 0]`, `0` |
| `clipBias` | Meters trimmed from the retained half space at its boundary | `0.001` |
| `updateIntervalFrames` | Minimum renderer frame interval between captures | `1` |
| `requestVersion` | Increment to refresh before the next scheduled interval | `0` |
| `PlanarReflection.target` | Distinct sampled 2D reflection output (`3d`/`2d-array` targets are rejected); width/height control capture resolution | Required |

```ts
const descriptor = {
  shape: '2d', width: 512, height: 512, format: 'rgba16float',
  mipLevels: 1, sampleCount: 1, sampled: true, readback: true,
} as const;
const created = renderer.createRenderTarget(descriptor);
if (!created.ok) throw created.error;
const target = created.value;
world.addComponent(displayCamera, {
  component: PlanarReflection,
  data: { target: world.allocSharedRef('RenderTarget', target), updateIntervalFrames: 2 },
}).unwrap();
// Keep the logical identity when changing quality.
renderer.resizeRenderTarget(target, { ...descriptor, width: 256, height: 256 }).unwrap();
```

```mermaid
flowchart LR
  A["Display camera and world plane"] --> B["Mirrored camera with oblique clipping"]
  B --> C["Forward capture into RenderTarget"]
  C --> D["Single-layer medium reflection sampling"]
  C --> E["Completed frame receipt"]
  E --> F["Retained texture and capture matrix"]
  F --> D
```

The built-in `single-layer-medium` template automatically samples the capture
for a matching planar surface, preserving its Fresnel energy split and existing
transmission. Misses use the existing environment reflection. Capture includes
retained offscreen opaque geometry and excludes media, UI and debug draws;
there is no recursive water capture. The public target texture source remains
available to authored mirror/floor materials.

The reflected camera keeps the display camera's public clipping coverage;
its copied plane data is detached and does not request a second shadow-map
render. The oblique water plane and public object-section planes compose in
the capture view.

Each display camera owns at most one planar capture, independent of the ordinary
auxiliary-camera budget. Multiple displays use distinct reflection targets; duplicate
writers, including a shared display/reflection output, are rejected before view
recording in both World and publication paths. The capture writes the public target
physical directly, so material sampling and target readback refer to the same image.
A resized target remains unpublished until its owning capture actually submits;
other views cannot promote an unwritten candidate or retire the retained image.
A camera on or behind
the plane, or looking away so its reflected frustum misses the retained half
space, does not capture. Component removal, a captured resize and device-generation replacement
invalidate the retained pairing; failed submission does not advance cadence.
The texture and projection used between updates come from the same capture
submission; completion receipts gate the next scheduled update. `planar-reflection-invalid`
identifies invalid planes, bias, interval or target admission. Keep targets linear (`rgba16float` or `rgba8unorm`).

Reference: [Three.js Reflector](https://threejs.org/docs/pages/Reflector.html).
The reflected camera construction follows its eye/forward/up method; the
oblique projection is adapted for WebGPU depth rather than copying GL's row
replacement. The Preview shoreline at `apps/preview/water.html` exposes capture
resolution and update interval. RHI Debug identifies capture work by
`planar-reflection-face.*`; inspect its color target and the water material's
bindings 15 (sampled reflection) and 16 (capture projection/plane).

The regression `packages/runtime/src/__tests__/planar-reflection.dawn.test.ts`
renders 60 completed frames, proves offscreen red geometry and half-space
clipping with a moved-object falsifier, compares capture and water pixels with
a fresh-device RHI Debug replay, and checks cadence, resize and removal.
`pnpm --filter @forgeax/preview smoke:planar-reflection` exercises the real
browser Pack transport and all quality controls, then saves the screenshot,
RHI tape and producer-to-water resource evidence under
`artifacts/planar-reflection/`. Prepare shared shader inputs first when using
`FORGEAX_SHARED_APP_INPUTS_MANIFEST`. These focused checks supplement the full
Engine smoke, browser and Dawn gates.

## Projected decals

`ProjectedDecal` is an optional render component installed by `renderPlugin`.
Its Transform maps the unit box `[-0.5, 0.5]` into world space; +Z faces the
receiving surface normal. It projects onto opaque Standard Deferred receivers
using their visible depth, before SSAO and lighting. It needs neither a
receiver mesh scan nor a coplanar overlay mesh.

```ts
import { ProjectedDecal, Materials } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';

const paint = assets.create(Materials.standard({
  baseColor: [0.8, 0.05, 0.02, 1],
  roughness: 0.7,
})).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 1, 0], scale: [2, 1, 0.2] } },
  { component: ProjectedDecal, data: { material: paint } },
).unwrap();
renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'deferred' }).unwrap();
```

| Field | Contract |
|:--|:--|
| `material` | Loaded base Standard MaterialAsset; ordinary asset parent/texture/sampler resolution applies. |
| `order` | Ascending integer; later decals cover earlier ones. Equal order sorts by attached World order, then entity identity. |
| `opacity` | Global blend weight `[0,1]`, default `1`; multiplied by base-color alpha. |
| `colorOpacity`, `normalOpacity`, `roughnessOpacity` | Independent channel weights `[0,1]`, default `1`; set unused channels to `0`. Normal has no effect without a normal texture. |
| `normalThreshold` | Receiver normal cosine against projector +Z, `[-1,1]`, default `0`. |

Supported inputs are baseColor/baseColorTexture, normalTexture/normalScale,
roughness/roughnessTexture/roughnessChannel and alphaCutoff. Static filterable
2D TextureAssets, authored SamplerAssets and per-slot UV transforms use the
existing asset contract. Projection supplies UV set 0; authored other UV sets,
video/render-target sources, alphaHash and other texture slots are rejected.
The receiver retains metallic fraction, dielectric reflectance, occlusion and
emissive. Custom Surface programs and physical layered receivers are outside
this initial Deferred decal contract. This lane currently applies to display
cameras; auxiliary render-target and cube captures do not include projected
decals. Mesh decals participate as ordinary geometry in those captures.
For tangent-space normal projection, author an orientation-preserving box
(positive scale on each axis); mirrored projector normal frames are outside
this initial contract.

The GPU draws each box's projected screen rectangle, reconstructs the world
position from the current (including jitter) inverse camera matrix, and rejects
pixels outside the box, behind the angle threshold or on the background. Three
`rgba16float` buffers accumulate color/normal/roughness; one pass composes them
into the canonical packed G-buffer. Lighting and SSAO/SSR consume the resulting
surface. Texture gradients are evaluated before rejection for mip filtering.
A box crossing the near plane conservatively covers the viewport. Overlap and
screen coverage determine GPU cost; this is not a promise of universal speedup.

This lane requires Standard Deferred and single-sample depth. Forward/MSAA
requests report `projected-decal-invalid`; mesh decals remain ordinary geometry
in those lanes. Up to 64 visible, nonzero decals are accepted across attached
Worlds. Visibility and zero opacity remove work. With none, the graph allocates
no decal targets or passes. Transforms, order and weights update frame values;
only count/texture shape changes require different decal topology. Textures use
scoped GPU residency and graph resources follow normal fence retirement.

A depth projection follows the currently visible surface within its volume;
it is not an attachment to a particular mesh or a permanent paint bake. Keep
volumes shallow to avoid affecting nearby objects. For persistent static or
rigid-object markings, use [mesh decals](../geometry/README.md#mesh-decals).

Verification owners: `packages/geometry/src/__tests__/decal.unit.test.ts`,
`packages/render/src/__tests__/projected-decals.unit.test.ts`, and the shared
Runtime `decals.fixture.ts` through Browser/Dawn. The latter saves real frame
tapes, work inspections and live/replay evidence under `artifacts/decals/`.

Rendered software-backend evidence is generated under `artifacts/decals/`.
The tiles show no decal, GPU color, GPU texture, occlusion, overlap order,
normal-only, roughness-only, and mesh texture.

Renderer generation defaults (builtin mesh buffers, view/mesh/material uniforms,
and fallback textures) are owned by the existing DeviceScope. Disposing a renderer
retires those defaults along with its frame graph and asset residency resources;
independent preview renderers must return native Buffer/Texture ownership counts
to baseline after close. Failed initialization also disposes its partial renderer.

### Canvas textures

Render target, external texture and canvas source owners use UUIDv7 identities.
Their copyable string tokens retain producer isolation in native realms without
Web Crypto; native resource lifetime stays with the original producer.

Interactive example: [Canvas in the world](../../apps/showcase/canvas-texture/README.md)
compares an editable 2D canvas with a real model, including live signs and telemetry.

`CanvasTexture` binds a caller-owned `HTMLCanvasElement` or `OffscreenCanvas` to
an ordinary 2D material texture slot. It uses the video upload store, with a
version per explicit update and a separate GPU texture per Renderer.

```ts
import { CanvasTexture, Materials } from '@forgeax/engine/render';

const canvas = document.createElement('canvas');
canvas.width = 512;
canvas.height = 256;
const ink = canvas.getContext('2d')!;
ink.fillStyle = '#18334a';
ink.fillRect(0, 0, canvas.width, canvas.height);
ink.fillStyle = 'white';
ink.font = '36px sans-serif';
ink.fillText('LIVE 42', 24, 64);

const display = new CanvasTexture(canvas);
const materialHandle = assets.create(Materials.unlit([1, 1, 1, 1], {
  baseColorTexture: { source: display.source },
})).unwrap();
// Put materialHandle in MeshRenderer.materials on the model.

ink.fillText('updated', 24, 120);
display.update();
// When the display is no longer needed:
// display.dispose();
// Release the material asset after removing its consumers.
```

The same source works in `Materials.standard` texture values and named 2D
texture fields of cooked custom materials. Samplers and UV transforms use the
explicit source binding (`{ source: display.source, sampler, coordinates }`).
The copied token preserves producer identity through asset reads, edits and Worker
publication; resolving a slot is one producer lookup, independent of consumer count.
The source is runtime content; do not serialize it into a Pack or treat it as a
TextureAsset GUID. Canvas objects stay in their authoring realm. The ordinary
Render Worker publication snapshots native frames and retains receiver-owned
keys, so no DOM object or source GPU handle crosses the Worker boundary.

| Event | Behavior |
|:--|:--|
| First use | Upload automatically; zero-sized canvases wait for drawable dimensions. |
| Painting | Call `update()` after drawing. Unchanged versions reuse one upload across models, slots and frames. |
| Resize | Redraw the resized canvas and call `update()`; commit a replacement texture only after allocation, view creation and copy succeed. |
| Color and UVs | sRGB RGBA with straight alpha. `flipY` defaults to `true`; use `new CanvasTexture(canvas, { flipY: false })` for top-left UVs such as `HANDLE_QUAD` or glTF. Orientation is immutable and survives publication/recovery; complete linear-light mip chains, with the existing trilinear material sampler policy. Canvas data maps requiring linear storage are outside this color-texture entry. |
| Failure | Publish the structured RHI error; failed allocation/copy retains the prior view. A failed frame leaves mip generation dirty and retries before any later consuming draw. |
| Device recovery | Discard old GPU state and upload the current canvas on the next consuming frame, without rebinding the material. Worker sources republish through their ordinary next frame. |
| Disposal | Idempotently release uploads; never clear or destroy the caller's canvas. `update()` after disposal does not resurrect it. Worker copies retire on the next accepted publication. |
| Renderer teardown | Release that Renderer's uploads and lifetime listeners even when the Canvas source remains alive; other Renderers retain their own uploads. |

The API follows [Three.js r184 CanvasTexture](https://github.com/mrdoob/three.js/blob/r184/src/textures/CanvasTexture.js):
first use is dirty and later author edits explicitly advance the texture version.
Actual material binding uploads enqueue mip work; no material or source scan
discovers changes. After recording, queued mip chains submit before scene consumers
in the same Renderer submission; only success acknowledges the encoded upload.
Idle mip preparation allocates nothing. Video uploads keep one level.
The browser checkerboard regression verifies linear-light minification (white/black
averages to sRGB 188), with a base-level-only sampling falsifier.
ForgeaX uses `update()` and managed material assets;
it does not add a second asset catalogue or mimic Three's entire Texture hierarchy.

Verification lives in `canvas-texture.browser.test.ts`,
`publication/__tests__/canvas.browser.test.ts`, and the dynamic store unit gate.
The browser test paints two models, checks sRGB, straight alpha and top/bottom orientation,
explicit update, resize, 60 completed frames, disposal, and host-signalled device
recovery on real WebGPU. Recovery injection proves the renderer lifecycle, not a
physical driver reset. RHI Debug retains both the external upload event and a
subsequent seeded consuming frame. v7 cannot replay an external-image event;
replay the seeded frame to inspect the actual Canvas texture and model draw on a
fresh device. Artifacts are under `artifacts/canvas-texture/`.

### External textures

`renderer.importTexture(input)` is the single external-source entry. The input
kind is the only difference between a caller GPU texture and a video:

```ts
type ExternalTextureInput =
  | { kind: 'gpu-texture'; texture: GPUTexture } // created on renderer.nativeDevice()
  | { kind: 'video'; source: HTMLVideoElement | VideoFrame };

const imported = await renderer.importTexture({ kind: 'video', source: video });
if (!imported.ok) throw imported.error; // structured: branch on imported.error.detail.reason
const handle = imported.value;
const source = { source: handle.source };
// Zero-copy slot: a cooked material whose paramSchema declares
// { name: 'videoTexture', type: 'texture_external' } (WGSL texture_external +
// textureSampleBaseClampToEdge). Update the loaded asset to retain its cooked program:
const material = (await assets.load(cookedGuid, 'material')).unwrap();
assets.update(material, { values: { videoTexture: source } }).unwrap();
// Ordinary 2D slots also accept the source (copied):
Materials.unlit([1, 1, 1, 1], { baseColorTexture: source });
await handle.replace({ kind: 'video', source: nextFrame }); // same source, rebinds next frame
handle.release(); // terminal; never destroys the caller's texture, element or frame
```

| Concern | Behavior |
|:--|:--|
| Admission | `gpu-texture`: filterable color format, single-sampled 2D with one layer, `TEXTURE_BINDING`, same device. `video`: an `HTMLVideoElement` or `VideoFrame`. Failures return `ExternalTextureInvalidError` (`external-texture-invalid`, `detail.reason` in `format`, `dimension`, `usage`, `device-mismatch`, `device-lost`, `source-unsupported`, `capability-absent`). |
| Binding | `texture_external` slots derive an `externalTexture` BGL entry from the one `paramSchema`. A video binds a fresh `GPUExternalTexture` each frame (memoized across slots within the frame); only bind groups containing such a slot are rebuilt per frame. A `gpu-texture` binds its view into either slot kind. |
| Capability absent | `caps.externalTexture === false` (Dawn node, rhi-wgpu) keeps the same layout and shader and binds a copied view (source orientation preserved in `texture_external` slots; ordinary slots flip to UV-up, like `CanvasTexture`). |
| State failures | `ExternalTextureStateInvalidError` (`external-texture-state-invalid`) is reported once on the error channel per state and the slot keeps its default: `released`, `stale-generation` (a `gpu-texture` after device recovery; `replace` with a texture from the new `nativeDevice()`), `source-expired` (closed `VideoFrame` or undecoded element), `foreign-renderer`. `replace`/`release` return the same error synchronously. |
| Ownership | The source is a copyable runtime token owned by the importing Renderer. Asset copies preserve it; another Renderer rejects it. Pack output rejects source bindings, and Worker publication rejects external imports as `unsupported`. |
| RHI Debug | The recorder CPU-snapshots each imported video frame into a recorded `rgba8unorm` texture and records its view in place of the external binding, so a tape replays the exact frame on a fresh device with no media object. Bind groups cached before capture with an external slot are patched to the snapshot view and replayed inside the frame. A borrowed `gpu-texture` enters the tape as `createTexture`; its bytes are seeded only when the caller granted `COPY_SRC`. |

Verification: `assembly/__tests__/external-texture-host.rhi-null.unit.test.ts`
(lifecycle, falsifiers, copy fallback), `runtime/src/__tests__/external-texture.browser.test.ts`
(real HTMLVideoElement and VideoFrame, 60 frames, pixel ε≤0.05, device loss,
expired frame, live-vs-replay pixels), `external-texture.dawn.test.ts` (GPUTexture
into `texture_external` with caps absent) and `external-texture-perf.browser.test.ts`.
The tests write evidence to the ignored `artifacts/pr-evidence/external-texture-video/`.

## Stable scene submissions

Each CameraView retains one `RenderBundleCache` per typed scene pass name and compatible attachment contract. The cache splits the pass
into segments at each `setPipeline` after a draw, after 128 draws under a shared pipeline,
at a recovered full-sized indirect boundary after a mismatch, and at every command
a bundle cannot hold. Each segment carries the
pipeline, bind-group and vertex/index state it inherits, so it stays self-contained under
the state reset that `executeBundles` performs. The first occurrence of a segment records
directly; a second matching occurrence creates a native bundle; further matches call
`executeBundles` without native per-draw recording, with consecutive bundles sharing one
call. The per-frame material/upload/extraction work remains active. This targets CPU
command submission cost, not GPU shading cost or every part of the frame.

A differing command invalidates only its own segment: that segment records directly this
frame and is re-admitted after one further matching frame, while the other segments keep
their bundles. The draw limit bounds invalidation when many meshes share one pipeline.
A pass whose drawing segments never repeat backs off to direct recording
for a bounded, growing window (4, 8, ... up to 64 frames) and then probes again, so churn
stops paying proxy comparison without disabling reuse for the rest of the view lifetime.
Dynamic-offset snapshots read only the selected slice and reuse equal snapshots; their
cost does not depend on the unused backing arena. Invalid slice arguments reach the
original backend overload unchanged, preserving native validation instead of silently
clamping them into valid bindings.

After a segment changes position, the actual indirect buffer and byte offset
locate its previous bundle; a direct-draw segment is located instead by its
pipeline run and its ordinal within that run. A pipeline run is one bin of the
view's retained direct phase (`record/direct-draw-phase.ts`), so a bin that gains
or loses whole segments leaves every other bin on the replay path. The complete
commands still decide reuse. Only
synthesized inherited setters overwritten before the first draw are omitted
from that comparison and from native bundle recording. Explicit setters remain
observable, and deleted batches can destroy their buffers without leaving dead
references in another batch's bundle. The ordinal comparison remains the steady
frame path; the indirect index is built only after a miss. That same index restores
the previous 128-draw segments' starting boundaries when earlier batches are inserted
or retired. Boundaries recover in their previous order, at most once each; ambiguous
buffer/offset starts cannot identify a boundary. Short segments remain eligible for
complete command matching but cannot introduce recovery boundaries, so repeated front
insertions do not accumulate one segment per new draw. Sparse offsets, interleaved
buffers and indexed/non-indexed indirect methods do not define additional partitions.

| Invalidation input | Behavior |
|:--|:--|
| Command kind/order/count, resource handle or dynamic offset changes inside one batch | Re-record that segment directly; re-admit it as a bundle after one more matching frame |
| No segment of the pass repeats for four drawing frames | Record the pass directly for a bounded backoff window, then probe again |
| Data updates through retained uniform, vertex or indirect buffers | Keep the bundle and consume current contents |
| GPU-driven batch bind groups (mesh/skin table plus lighting at group 2) | Cached device-scoped by their physical inputs, so an unchanged batch replays the same handle and keeps its bundle |
| Unrelated feature graph replacement | Keep the view-owned scene cache and compare current physical commands |
| Scene attachment format/sample/read-only changes | Replace only the incompatible pass cache |
| Device replacement | Clear the segments, bundles and backoff state, then evaluate the new device from a cold frame |
| Record/finish/execute failure | Clear the segments, bundles and backoff state so the next frame can recover |
| Mid-draw viewport/scissor/blend/stencil changes, query regions or explicit bundle execution | Close the open segment, flush pending bundles and preserve original command order; occlusion-query draws stay direct |
| Pass removal | Drop its cache after the next rendered view frame confirms absence |
| Device recovery and renderer disposal | Clear the view-owned caches |

The cache compares physical command inputs instead of introducing asset/World revision
counters. It retains one segment list per pass. RHI Debug expands each executed bundle into
ordinary draw events with explicit state-reset boundaries, including bundles created
before capture. Browser/Dawn tests compare direct, cached and fresh-replay pixels and
falsify stale reuse with empty draw commands.

The [native CPU benchmark](bench/render-bundle.ts) compares direct recording with this
cache at 64, 512 and 2,048 draws, including indexed draws with buffer bindings and dynamic
offsets. It retains every sample and reports p50/p95 for command encoding and synchronous
submission separately. First-frame, bundle-build and continuous-invalidation cases expose
the admission and one-time mismatch costs; volatile command lists return to the direct path
after that mismatch. GPU
completion is outside timing, so software-adapter results do not establish application FPS.

The [stress benchmark](bench/render-bundle-stress.ts) interleaves direct recording, an
explicit archived cache module, and the current cache in all six orders. It covers prefix,
suffix and sparse changes, list resizing/empty recovery/reordering, resource and offset
churn, shared offset arenas, live buffer writes, short stable bursts, mixed passes,
8,192-draw pressure, and a 300-frame resource-replacement soak. Encoding, finish and
submit timings are separate; checkpoint files preserve completed samples after a native
failure. Optional case-name and variant filters follow the output and archived-module
paths for failure isolation. Complete runs use the full roster.

Historical Render Bundle measurements and raw samples were removed from Engine
Git. Regenerate benchmark output under the ignored `artifacts/render-bundle/`
directory before making a current-source performance claim.

Regression coverage includes 1,000 changing frames over eight Null passes, real World
membership/culling/resize transitions, creation/finish/execution failure recovery, and
per-frame Browser/Dawn pixel comparisons with tapes from the same cached frame. RHI Debug
replays the captured frame after resource replacement on a fresh device. These checks
retain ordering, live-data reuse and validation behavior without per-scene admission
thresholds or a history of past sequences.

## Multi-camera viewports and composition

Add `CameraView` to each camera that should contribute simultaneously. One World
and one Renderer share model/material residency; each view owns its visibility,
mutable GPU bindings, depth, post-processing graph and temporal history. Shared
Feature simulation and source acknowledgment remain Renderer-owned. Renderer
encodes shared work, all views and the final composition into one scene encoder.
When lazy uploads require mips, one setup command buffer precedes it in the same submission.
A failed encode, finish or submit publishes none of the candidate histories.

| CameraView field | Meaning | Default |
|:--|:--|:--|
| `viewport` | Normalized `[x, y, width, height]`, with origin at the top left | Full screen |
| `order` | Ascending composition order; entity identity breaks ties | `0` |
| `resolutionScale` | Render resolution relative to the viewport; `(0, 1]` | `1` |
| `updateInterval` | Render once per this many draw calls; reuse the complete picture between updates | `1` |
| `enabled` | Participate in output | `true` |

```ts
import { Camera, CameraView, ANTIALIAS_TAA } from '@forgeax/engine/render';

// Add Transform with a different position/orientation to each entity.
world.addComponent(leftCamera, { component: CameraView,
  data: { viewport: [0, 0, 0.5, 1], order: 0 } }).unwrap();
world.addComponent(rightCamera, { component: CameraView,
  data: { viewport: [0.5, 0, 0.5, 1], order: 1 } }).unwrap();
world.set(leftCamera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
world.set(rightCamera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();

// A top-down orthographic Camera can overlay a cheaper minimap.
world.addComponent(mapCamera, { component: CameraView,
  data: { viewport: [0.75, 0, 0.25, 0.25], order: 10,
    resolutionScale: 0.5, updateInterval: 4 } }).unwrap();
```

When `Camera.autoAspect` is true, the view's physical extent determines perspective
aspect before frustum extraction. Orthographic bounds remain authored camera data.
The output rectangles replace their covered pixels in order; uncovered pixels are
opaque black. Every view clears its private color/depth before rendering, so one
camera cannot erase or depth-test against another. Resize forces a fresh render;
`Camera.historyVersion` cuts only that camera's history, while frame `temporalReset`
cuts all views. Removing or disabling a view retires its resources after GPU work.

A `CameraView` camera with `Camera.target` renders into the existing Renderer-owned
`RenderTarget` instead of a screen rectangle (2D, one mip, single-sample target;
the camera itself may use MSAA). Its target descriptor determines the
resolution; its update interval still applies. Create a material source with
`renderer.createRenderTargetTextureSource` and bind it through the ordinary runtime
material texture route. The target's completed publication remains the material's
picture authority. The compositor decodes the completed camera picture into linear
material values; an sRGB target re-encodes through its attachment format.
Other views sample the preceding completed target picture; a target update becomes
visible to those views on the next draw. This also bounds feedback between monitors.
Model/material assets are shared with the display cameras.

> [!NOTE]
> World extraction and Render Worker publication carry the same CameraSnapshot
> view configuration into one Renderer orchestration and Standard pipeline.
> The source owns World and asset identities; the receiver retains accepted scene
> facts, seeds newly enabled views, and applies every delta even when a view holds
> its picture for a later update. The single feature host plans shared simulation
> and per-view projection from the complete roster, then commits them together. CameraView selects views in the camera World. Without any
> CameraView components, the established ActiveCamera/FrameCamera path remains.
> With CameraView components present, disabled views contribute no work; disabling
> all of them clears the display. `inspect().views` reports each view's extent,
> rendered-frame count, pass roster, frustum counts and temporal identity.
> Single-camera display picking is unavailable for a composite receipt.
> `requestObservation(['final-display'])` reads the completed composite. Linear HDR/LDR
> are per-view domains and are inspected through their RHI Debug work items.

A camera with `Camera.target` and no `CameraView` is a capture view: a `RenderView`
entity (`capture: true`) with its own recorder, culling, phases and GPU-driven
indirect draws over the shared prepared scene. Its capture camera drops display-only
stages (temporal, post-processing, lens, outline, projected decals) and writes the
raw linear scene into the target; layers, clipping planes, shadows and atmosphere
are retained. Capture views encode before display views in the same submission, and
the target is promoted only after that submission is accepted. Removing the camera
or its target retires the view. Materials sampling a RenderTarget stay on the
direct lane so a capture never samples its own write.

Planar reflection keeps a separate physical reflection texture, projection and
completion receipt for each display view, including held views. Cube captures
use one Renderer scheduler per logical target; view order, cadence and removal
do not restart six-face progress. Optional GPU timing belongs to the outer
FrameReceipt and covers shared work, view passes and composition. View pass
facts carry `viewId`; DynamicResolution consumes only its own view interval.

The reference is [Three.js r184 multiple views](https://github.com/mrdoob/three.js/blob/r184/examples/webgl_multiple_views.html)
for viewport/scissor and per-region aspect, and [EffectComposer](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/postprocessing/EffectComposer.js)
for independent post-processing targets. ForgeaX's ECS CameraView declaration owns
these choices instead of mutable global viewport state. Rendering cost remains
proportional to repeated visible geometry and post-processing; reducing minimap
resolution and cadence reduces that work without changing shared asset identity.

The multi-camera Browser/Dawn fixtures exercise both World and transferred
publication inputs. The App browser fixture also replaces the actual Render Worker
while retaining the source World, then checks rebuilt camera targets and composition.
They exercise the production Renderer, retain v7
RHI tapes, compare live and fresh-device replay pixels, and falsify composition by
removing its draw. See `src/__tests__/multi-camera-submission.unit.test.ts` and
`../runtime/src/__tests__/multi-camera.fixture.ts`.

## Camera lens offsets

`Camera.projectionOffset` is a two-float additive NDC offset, default `[0, 0]`:
positive X moves the image right and positive Y moves it up; one unit is half
the viewport extent. Both `perspective` and `orthographic` factories accept it.
Non-finite or Float32-overflowing offsets fail with `CameraError`, code
`camera-projection-invalid`, field `projectionOffset`.

The native CameraSnapshot carries the same detached value through World and
Worker publication. The common lens projection supplies culling, draw matrices,
CSM fitting, temporal/volume/GI history and atmospheric view caches. Stereo eyes
add their derived convergence shift to this ordinary lens offset; eye identity
contains only the eye side. Auxiliary captures retain their selected lens.

## Stereo output (non-XR)

`StereoCamera` on a perspective `Camera` renders two eye views into the camera's
CameraView rectangle (full screen when the camera has no `CameraView`). Each eye is
an ordinary CameraView row: its own visibility, depth, post-processing graph, TAA
history and GPU bindings; both eyes share residency, the encoder and the single submit.

| StereoCamera field | Meaning | Default |
|:--|:--|:--|
| `eyeSeparation` | Interocular distance in world units, `>= 0` | `0.064` |
| `convergence` | Zero-parallax distance in front of the camera, `> Camera.near` | `10` |
| `layout` | `StereoLayoutValue`: `'side-by-side'`, `'top-bottom'` or `'anaglyph'` | side-by-side |
| `swapEyes` | Exchange eye placement (cross-eyed viewing; cyan-left anaglyph) | `false` |

```ts
import { Camera, StereoCamera, StereoLayoutValue } from '@forgeax/engine/render';

world.addComponent(camera, { component: StereoCamera, data: {
  eyeSeparation: 0.064, convergence: 5, layout: StereoLayoutValue['side-by-side'] } }).unwrap();
```

Each eye sits at `-/+ eyeSeparation / 2` along the camera's local X axis and uses the
Three.js r184 `StereoCamera` off-axis frustum: projection element `[8]` is
`+/- (eyeSeparation / 2) / (convergence * tan(fov / 2) * aspect)`, with `aspect` the
eye's physical aspect. A point at `convergence` has zero screen disparity; nearer
points have crossed (left image to the right) and farther points uncrossed disparity.
Side-by-side splits the rectangle horizontally (left eye in the left half), top-bottom
vertically (left eye on top). Anaglyph renders both eyes over the whole rectangle and
composites the left eye into red and the right eye into green and blue with
colour write masks; it costs no extra pass.

World extraction and Render Worker publication carry the same validated
`CameraSnapshot.stereo`; the receiver derives the eyes, so both paths render the same
pixels. Per-view work derives from the extracted eye camera through the shared lens
projection (`cameraLensProjection`): frustum culling, CSM cascade fitting, temporal
reprojection, debug draw and GPU-driven raster each see the eye's sheared frustum. Feature views are identified as
`camera:<entity>:<eye>`. The source-side publication feature projection derives both
eyes from the canvas aspect; the receiver's physical eye aspect governs rendering.

`inspect().views` reports one row per eye with `eye: 'left' | 'right'`, its physical
viewport and its temporal history. Validation throws `StereoCameraInvalidError`
(`code: 'stereo-camera-invalid'`, `detail.field`) for a negative or non-finite
`eyeSeparation`, `convergence <= Camera.near`, an unknown layout, an orthographic
Camera, a `Camera.target` camera or a Camera with `PlanarReflection`.

Picking: a stereo receipt is a composite receipt, so single-camera display picking is
unavailable, exactly as for other multi-view output. Cast rays from the mono Camera
(`screenToRay` with the full-screen aspect) for interaction; that ray passes between the
eyes and agrees with both images at the convergence distance.

DynamicResolution on a StereoCamera: each eye's controller consumes the combined GPU
interval of both eyes, because the eyes share the camera's timing `viewId`.

Evidence: `src/__tests__/stereo-camera.unit.test.ts` compares the projection with a
transcription of Three.js `StereoCamera.update`;
`../runtime/src/__tests__/stereo.fixture.ts` (Dawn and Browser, World and publication)
measures near/convergence/far disparity against the analytic value, falsifies with zero
separation and swapped eyes, inspects per-eye viewports and view uniforms in the RHI
tape and compares live against fresh-device replay pixels.

## Baked lighting identity and staleness

A baked lighting record is keyed by `BakeDataKey`, which is the persistent
`SceneEntityRef` (`sceneSourceKey`, `address`) plus `lod`. `lod` is a level
index, or `'shared'` for the LOD0 lightmap that all levels sample. Runtime-spawned
entities have no persistent address and are never baked.

`bakeFingerprint(input)` is a SHA-256 hex digest over mesh content (including
the lightmap UVs), the world transform, the diffuse and emissive material hash,
the baked light hashes (order-insensitive), the bake settings hash, and the
engine algorithm version. `resolveBakeData(records, current)` re-derives these
inputs and keeps only records whose fingerprint matches. A mismatched record,
or one whose inputs can no longer be derived, is dropped, and its entity is lit
in realtime. Stale data is never sampled. Dropped records are reported once
per scene as one `bake-data-stale` diagnostic that lists every stale key.

Material injections cover `shadow`, `ibl`, and `transmission`. The name
`lightmap` is reserved for this baked data.

## Reverse-Z depth

All camera, shadow and capture projections use WebGPU `[0,1]` Reverse-Z: near
is `1`, far and clear are `0`. Scene depth uses `depth32float-stencil8`; shadow
maps use `depth32float`. Device creation requires `depth32float-stencil8`, and
reports the existing structured device error if the capability is unavailable.

| Boundary | Contract |
| --- | --- |
| Material `depthCompare` | Remains a forward-distance comparison; pipeline creation reverses ordered comparisons once. |
| Material depth bias | Positive still pushes away; pipeline creation negates the native constant, slope and clamp. |
| Raw RHI/custom WGSL | Uses native Reverse-Z: clear `0`, nearer comparison `greater` or `greater-equal`. |
| Depth reconstruction | Perspective distance is `near / (depth + (1-depth) * near/far)`; orthographic distance is `far - depth * (far-near)`. |
| Empty and MSAA depth | Empty is exactly `0`; the nearest covered sample is the maximum raw depth. |
| SSR hierarchy | Seeds from maximum covered raw depth, then stores positive view distance for existing metre-based traversal. |
| RHI Debug | Captures native state and derives required floating-depth/stencil capability from replay descriptors. |

Custom shaders must preserve small positive depths; calculating `1 - forwardDepth`
after float32 storage loses the precision this convention provides. World-position
float precision remains independent. The Browser/Dawn fixture runs 60 production
frames with two surfaces 100 km away and 1 m apart, reads native depth, replays
on a fresh device, and falsifies the recorded clear value.

### Empty instance presentation

Zero-count `Instances` and `SpriteInstances` holders contribute no display work
and do not gate startup material residency or presented-submesh coverage. Changing
the count back to a positive value restores the ordinary presentation checks.

### Opaque ray reference foundation (experimental internal surface)

The ray tracing continuation report preserves the implementation, failed acceptance evidence and reproduction commands for PR #3561. Its design index routes the research documents. The takeover checkpoint retains the final-head native captures; the [delivery relay](https://github.com/ForgeaX-Games/forgeax-engine/pull/3561#issuecomment-5959950959) records the subsequent merge and remaining evidence requests.

`@forgeax/engine-render/internal` exports `buildRayReferenceScene`,
`createRayReferenceQuery`, `packReferenceRays`, and `traceReferenceRay`. This opt-in
correctness path is not installed in `Renderer` and does not imply a public
hardware ray-tracing RHI. The caller supplies indexed mesh instances, a shader
factory, the published query kernel, a device, and ray batches; the caller owns
command submission. Query and transport import the same build-owned traversal
module; runtime never assembles its source. The query entry is `queryTriangles`.

| Contract | Initial envelope |
|:--|:--|
| Scene | At most Portable: 1,024 instances / 327,680 triangles (zero-area primitives retain identity with mask zero); one geometry and material per instance; stable u32 instance, geometry, primitive and material IDs |
| Transform | Finite nonsingular affine column-major mat4; snapshot bakes vertices to world-space f32, including mirrored winding |
| Query | 1–65,536 finite nonzero rays, u8 masks, nonnegative ordered t interval; direction need not be normalized, so t is a ray parameter |
| Result | Closest triangle, original identities, t, barycentrics of vertices 1/2, front face; miss has all IDs `0xffffffff` and t `-1`; instance ID reserves that sentinel |
| Lifetime | Snapshot owns its arrays; query copies data into device-owned buffers. Replace the batch after scene changes; dispose only after submitted work completes. No retained-scene revision/cache is invented here |
| Algorithms | Portable binned-SAH BVH with ordered stack traversal (any-hit early exit for shadow/visibility) and triangle intersection; independent f64 plane/Gram-matrix CPU oracle; native wgpu re-executes the same world-space input using BLAS/TLAS |

The native query-only carrier retains its separate 65,536-triangle limit.

The named `ray-reference.*` storage buffers are ordinary RHI resources captured
in one v7 `.rhitape`. `rhi-debug.inspectBufferRecords` interprets mixed u32/f32
records at a selected `workIndex`; [the reproduction guide](../../scripts/raytracing/README.md)
provides record layouts and native comparison commands.

> [!IMPORTANT]
> This is a bounded reference profile, not production Lumen or a PT integrator.
> Exact edge/coincident tie identity, watertight intersection at extreme scales,
> alpha filtering, material evaluation, deformation, SDF, and GI are not qualified.
> A full snapshot rebuild deliberately precedes incremental scene integration.

### Shared-material path reference (experimental internal surface)

`buildRaySurfaceScene` and `createRayPathTracer` extend the opaque reference with
indexed UV0–7, linear vertex color, shared Standard Surface evaluation and a
bounded wavefront path integrator. They are opt-in internal APIs; the ordinary
Renderer allocates no PT resources. Supply build-cooked WGSL and the resolved
MaterialAsset snapshot, then encode `recordSample` and submit through the caller's
RHI device. `reset(encoder)` clears accumulation in command order. Replace the
batch after camera, geometry, light, texture or material edits; dispose after
submitted work completes. Texture views/samplers are borrowed.

Direct recording and RenderGraph recording derive the same compatible compute
batches once when the tracer is constructed. Every dispatch remains in its
original order; storage-to-indirect and uniform usage conflicts start a new
pass. This avoids one native compute encoder per dispatch in deep MASK paths
without changing samples, materials, coverage rounds or bounce count.
The offline irradiance bake submits one complete path sample at a time and awaits
its completion before the next sample. A smaller pass roster alone does not make
a large multi-sample native command reliable; the full Sponza reference retains
that negative control. Submission cadence never reduces the sampling budget.

`settings.receiver` selects the first-surface response: `'full'` (default)
evaluates the complete BSDF; `'diffuse'` replaces it with the raster diffuse-GI
composite term (`standardDiffuseWeight · albedo · AO` as a Lambert lobe), so a
reference indirect estimate is directly comparable with the diffuse GI lane. The
full receiver also counts receiver specular reflections of sky and walls, which
the diffuse lane never composites (Sponza: 0.67x vs 1.05x lane/reference).

`addSampleToGraph(graph, { label, buffers, textures, reset })` installs that same
sample sequence as named graph-owned compute passes and returns its accumulation
`GraphBuffer`. Only the optional reset is a copy pass. Supply the existing
producer graph handles for every borrowed ray buffer and material texture view;
missing inputs fail admission. Owned buffers are imported from their actual
allocation descriptors. Bound kernel resources have conservative accesses;
RHI Debug provides shader-entry and per-dispatch detail. Execution checks that
resolved handles still match the frozen bind groups and preserves a structured
cause when a buffer or texture generation changes. Retire the compiled graph
before disposing its transport. This primitive does not install GI in the
ordinary Renderer or implement retained scene replacement.

| Contract | Current reference profile |
|:--|:--|
| Materials | At most 32 rigid opaque or MASK Standard materials; separate geometric/vertex/shading normals, authored tangent-space normal maps; 2D textures with explicit conservative ray-cone LOD. Same asset/schema/Surface as raster; no RT-authored material export |
| Initial source | Exactly one `settings.camera`, CPU `settings.rays`, or borrowed GPU `settings.rayBuffer`. CPU rays are snapshotted. GPU input contains `width * height` 80-byte PathState rows and stays owned by its producer; encode producer work before each sample and retire the tracer before its source. Both external routes carry unit directions, cone footprints and activity, then reuse the same coverage/material/light transport. The GPU producer owns row validity; RHI owns handle/range validation |
| Integration | Additive Standard Lambert/GGX, full cosine/GGX-NDF mixture PDF including null events, analytic directional/point/spot visibility, uniform environment NEE/BSDF MIS, BSDF-only emissive hits, roulette after bounce 3 |
| Bounds | 1–262,144 rays per batch, 1–8 surface bounces, at most 32 analytic lights; existing scene bounds remain. Finite trace distance and scale-relative origin offset are explicit reference approximations |
| Output | Per-pixel raw HDR mean, count, Welford M2, error flag; last-sample primary albedo, normal/depth and instance/geometry/primitive/material IDs |
| Refusals | Blending, stochastic alpha, bump maps, physical layers, area lights and spot modifiers; missing material, required normal/tangent frame, UV or texture binding; changed cooked contract. GPU Surface admission flags nonfinite/unsupported outputs and excludes those samples |

The internal `raytracing/raster-source` producer records cosine-weighted diffuse
receivers from single-sample Standard depth/normal/identity attachments.
Use that frame's View and the exact 64-byte row range, excluding spare capacity.
The caller owns resources, ordering and submission; no readback supplies rays.
Unit-Lambert throughput produces receiver-independent `D = E/pi`; apply the
receiver material response once in the later composite, after any D filtering.
Albedo is not a ray-generator input, so black/metal receivers still have defined
incident D. Geometric-hemisphere null events and invalid-input rejection survive
the common transport. `PathState.state.w` records the producer
reason for inspection. The ordinary Renderer reference lane installs this producer;
[diagnostic reproduction](../../scripts/raytracing/README.md#gpu-raster-receiver-diagnostics)
retains real raster inputs, deliberate faults, raw bytes and fresh-device replay.

The published `forgeax_ray::diffuse_composite` consumes the matching raw D and
Standard G-buffer in a caller-owned linear HDR pass. `createRayDiffuseComposite`
uses additive RGB blending and preserves destination alpha. Its receiver weight
is shared with Standard environment lighting; material AO applies only to the
indirect contribution. Missing/error samples and mismatched extents add no light
and retain their producer diagnostics. This record-only consumer does not itself
install Renderer GI or introduce a second submission.

`raytracing/scene-projection` derives a frozen query scene from complete retained
RenderScene slots and their World/resource scopes. Draw ranges, base vertices,
instance transforms and the matching surface-row identities stay together;
material handles are scoped by World. Offscreen contributors remain present,
and absent geometry is rejected instead of becoming a miss. The existing reference bounds apply.
The ordinary Renderer retains this CPU projection through `RaySceneProjection`.
The existing `RowProjection` change evidence selects dirty rows; unchanged layouts
and primitive identities patch only those world-space triangle/attribute rows and
refit their BVH leaves and ancestors. Every candidate row is validated before any
accepted buffer changes. Membership, primitive-count, material-snapshot or surface
address changes retain the complete cold builder; a failed projection discards
derived cursors so the next preparation recovers from source.

> [!NOTE]
> Stable-shape edits retain transport buffers, pipelines and current texture
> leases, upload changed triangle/attribute rows and refitted nodes, and publish a
> new frame generation. Stale graph commits are fenced; diffuse and reflection
> histories restart at the new content. Changed device/profile/light inputs,
> stale texture leases and cold projection changes keep the complete preparation
> path. Shared Mesh-local BVHs, an instance-level top structure and local
> membership/material changes remain work. Repeated motion can also reduce the
> quality of the fixed SAH topology. These CPU refits and bounded uploads are not
> evidence of native/GPU acceleration-structure updates.

`raytracing/scene-field-projection.projectSceneFields` is a separate CPU-only
projection of those complete slots into whole-Mesh SDF instances. It preserves
Mesh local units and composes `world * instance`; every visible-by-author slot
contributes all instances, including offscreen sources. Multiple sections never
duplicate a field. GPU draw availability does not decide membership; present
draw ranges only check consistency with the actual Mesh sections.

| Boundary | Contract |
|:--|:--|
| Admission | All actual Mesh sections and their effective native Standard materials qualify together. Transparent/stochastic alpha, custom Surface, local clipping, displacement, deformation, LOD and shear are refused. Missing fields or unsupported contributors reject the complete result. |
| Budget | Caller supplies `maxInstances` (1–1,024) and `maxFieldBytes`. Each unique field's CPU brick table and values count once, before copying; no contributors are truncated. |
| Snapshot | Instances share one owned copy per actual field payload. Policy, artifact Integrity/Codec, transforms and coverage facts are copied; source Mesh/field/material/scope references remain identity witnesses for later caller fences. No geometry key substitutes for artifact identity, and this consumer does not rehash or recook admitted data. |
| Material proof | Ordinary World cooked/inherited materials and native receiver materials use existing owner provenance. A cooked receiver lacking the payload-to-native-material projection is explicitly unsupported even when shader artifacts arrived. `alphaCoverageOmitted` marks native MASK's geometry-only approximation; it grants no alpha visibility or Card/radiance qualification. |

Runtime vertex content removes the stale field and fails admission until a valid
base attachment is restored. This block installs no Renderer/GPU work, cache,
frame publication or GI. Camera clipping and submission-time source fences
remain the later frame caller's responsibility. A local Sponza CPU diagnostic
(103 sections, three instances) measured 26–49 ms per complete projection,
median 28 ms across ten samples. This is not a real-time frame budget. A future
caller must reuse existing retained-scene/content change evidence to rebuild
field snapshots and qualification only for relevant source changes, without
introducing another cache owner or validating and copying everything each frame.

Material extraction carries one optional `materialSurfacePrograms` mapping in
`MaterialSnapshot`. `ray-hit` selects `{ programKey, evaluateCoverage }`, while
`card-capture` selects `{ programKey }`; Card geometry coverage does not consume
the ray coverage flag. Both follow the accepted payload's publication through
World value edits and newer Catalog publications. RenderPublication forwards all
selected immutable artifacts through its existing program channel. An absent
context leaves the published raster and other derivative usable; its consumer
must report the missing context. Canonical Standard publishes both derivatives;
custom Surface qualification can publish ray alone. This product route does not
schedule native Card capture or allocate an atlas.
The GPU publication regression packs that submitted snapshot with the shared
material-row function, evaluates the published Surface entry, and replays every
parameter/output generation after the original resources retire.
`createSurfaceMaterialBindings` consumes that linear snapshot and reflected schema;
its caller resolves named textures to borrowed views/samplers. Reference material
inputs lower to the same binding path. Failed preparation releases its owned uniform
buffer; successful callers retire it after consuming work. The Renderer reference
lane supplies this lifecycle for its accepted snapshot.

`createSubmittedRayPathTracer` prepares the same frozen transport from accepted
snapshots and their immutable ShaderRegistry entries. Its required `generationFence`
uses the existing Renderer candidate-owner generation: check it before allocating
and after asynchronous preparation. A changed owner returns `ray-reference-stale`
and destroys candidate buffers without publication. The caller releases borrowed
texture leases and retries current inputs; the frame transaction must check the
same owner again before submission. This preparation fence does not implement
ordinary Renderer scheduling. The caller supplies dense material IDs and resolves
texture slots from its accepted resource scope; no author asset is reconstructed
or queried by GUID. Value edits recheck finite
inputs and unsupported alpha hash. Custom Surface coverage remains evaluated
even at zero Standard alpha cutoff. Culling, normal-frame/UV admission, material
binding, query, shading, accumulation and graph resource accesses share the
reference transport core. The publication regression checks every submitted
parameter row, Surface output and accumulated radiance through fresh-device
replay. The Renderer reference lane owns scheduling, texture leases and generation
replacement; standalone callers retain those responsibilities.

`prepareSurfaceMaterialTextures` consumes the selected artifact's parameter schema
and resolves the snapshot's static texture and sampler handles through its accepted resource scope and the existing `GpuResidencyCache`.
It returns `textures`, `track(completed)` and `release()`. The existing residency
lease keeps each concrete texture alive across async preparation, cache replacement
and tracked GPU submissions. Call `track` before `release`; release on cancellation,
replacement or disposal, and await its completion before retiring the device.
Failed preparation releases any partial leases. Eviction skips retained allocations;
replacement publishes a new entry immediately and retires the old allocation after
its last lease and GPU use end. Device teardown remains the final authority.
Missing authored resources and unqualified dynamic sources fail before tracing;
asset/residency errors are preserved. The GPU fixture replaces residency during
async shader preparation, exercises eviction and partial failure, toggles MASK,
and compares fresh-device replay after texture retirement. The Renderer lane also
checks this generation at its shared submission barrier.

### Ordinary Renderer raster probe placement

`renderer.setProfile({ ...profile, renderPath: 'deferred', probePlacement: { seeds: [
{ id: 1, generation: 1, position: [0, 0, -3], cellSize: 2, traced: true }
] } })` enables the existing 64-lane raster placement primitive and derives
`visibleSurface: true`. Omission performs no placement allocation or work.

> [!IMPORTANT]
> Seeds alone produce offsets and placement status. `traced` is caller-supplied
> eligibility. The optional `global` settings append fresh candidate rays, frozen-region
> Global SDF queries and origin/support diagnostics. Both modes preserve direct
> lighting and final color; neither gathers radiance or provides GI lighting.

| Boundary | Contract |
|:--|:--|
| Inputs | 1..4096 seeds, unique nonzero u32 IDs and generations, finite positions, cell size strictly between 1e-20 and 1e20; actual native Standard GBuffer, current View and the same 64-byte visible-surface rows used by raster |
| Admission | One perspective display view, rigid native Standard rows proven by the matching accepted material publication or native built-in source passes, with the built-in Standard Surface; multiple enabled CameraViews, Cube/reflection/auxiliary and scene-input capture views are rejected |
| State | RenderSystem owns accepted/candidate storage; each attempted graph execution resolves its current A/B roles; only successfully encoded, submitted and current work publishes |
| Reset | Seed identity/generation/geometry or camera identity changes stage a fresh zero-offset pair; failed replacements preserve published history. Extent/graph changes invalidate old attempts and retain offsets. Disable and device recovery retire the owner |
| Retirement | Physical queue completion is tracked before publication callbacks or generation rejection can retire storage; all allocations wait for their last submission |
| Diagnostics | `renderer.inspect().probePlacement` exposes preparation state, accepted generation, submitted frame count and requested seed count; `ready` requires the current pair to have published. RHI Debug sees `probe-placement.update` and native offsets/status buffers |

### Ordinary Renderer Global probe diagnostics

`probePlacement: { seeds, global: { grid, maxInstances, maxFieldBytes,
rayResolution, tMax, maxSteps?, minStepFactor?, cards? } }` adds one bounded diagnostic
chain to the same Renderer transaction:

```mermaid
flowchart LR
  F[Complete retained fields] --> C[One frozen Global region]
  G[Actual Standard GBuffer] --> P[Raster candidate]
  P --> E[Fresh rays]
  C --> Q[Global SDF query]
  E --> Q
  Q --> D[Raw origin and support diagnostics]
  P --> D
```

| Boundary | Contract |
|:--|:--|
| Region | `grid.maxDistance` bounds composition influence; `tMax` bounds each ray. No clipmaps or radiance gather. Rigid native Standard meshes need complete retained distance fields, including offscreen geometry; unsupported source content rejects the whole region |
| Reuse | Retained content plus mesh/field/material/publication identities key region preparation. Time/camera updates alone do not rebuild it. An explicit `setProfile` installs a new pipeline epoch and re-prepares the retained region. Producer-owned payload or field replacement invalidates it; arbitrary in-place array edits are not a publication contract |
| Freshness | Extracted World lease versions or the receiver's accepted revision fence each attempt. A mutation after extraction cannot bless stale geometry merely by capturing a newer lease before preparation |
| Publication | Placement, optional composition, emission, query and diagnostics must all encode, submit and remain current. Failed replacement preserves the accepted region; physically submitted allocations retire only after completion, even if publication rejects |
| Inspection | `renderer.inspect().probePlacement.global` reports source revision/count, voxel count, composition builds and physical composition state. RHI Debug exposes each pass and exact borrowed ranges |
| Output | Each 96-byte support row stores origin/raw distance; coverage/spacing/spacing-quarter/clearance; identity/emission; sample availability/safe-region flag; six separate query counts, masked count and unknown count. Unavailable zero distance is not a usable sample. Clearance is sampled SWRT evidence, never solid-exterior truth |

The same candidate GraphBuffer feeds emission and diagnostics. The query and
origin sampling share one WGSL sampling rule. Regression evidence includes
raster-first writers, cold/retained/reset frames, exact live/replay buffer equality
after device destruction, publication failures and unchanged direct HDR.

### Native Card support for Global probe hits

Card direct-light visibility shares the world traversal's `worldSurfaceOrigin` policy. Ray Query uses exact receiver precision rather than the field voxel clearance, preserving nearby blockers; Global SDF keeps its authored field bias. Point-light endpoint clearance derives from the actual origin displacement. Both ordinary probe lanes consume this same Card producer.

Set `global.cards: { resolution, maxCaptureBytes, budget }` to append unlit material
capture, bounded object association, Card sampling and support diagnostics. Resolution
is 8..512; the complete capture budget is positive and at most 256 MiB; `budget` is the
positive number of atlas tiles captured per frame. The setting is opt-in and leaves
scene color unchanged.

| Boundary | Contract |
|:--|:--|
| Sources | The complete retained whole-Mesh roster supplies cooked `cardLayout`, original triangle sections, actual material slots, UV/normal/tangent attributes and every instance transform, including offscreen contributors. Missing layouts or accepted `materialSurfacePrograms['card-capture']` reject region preparation |
| Material | The accepted Card artifact schema and linear `MaterialSnapshot` feed the same capture preparation and draw loop as the reference path. Static 2D texture and authored sampler payloads must remain current. Dynamic Canvas/video/target textures, unsupported shading and mismatched geometry/sidedness fail admission |
| Capture | One coherent four-plane rgba16float MRT plus depth32float atlas. Graph declares the borrowed geometry/material buffers and texture reads. Cold generated texture mips are graph raster writers; the native capture borrows that same submission and publishes residency only after it succeeds |
| Progress | The atlas is captured progressively by the same `CardCaptureScheduler` the irradiance field uses: the first frame clears the atlas and captures tiles `[0, budget)`, later frames load it and capture the next slice. Probes publish every frame; tiles not yet captured stay cleared (no support). `inspect().probePlacement.global.cards.captured` turns true once every tile is submitted |
| Reuse | A retained region reuses its physically captured atlas. Mesh, publication, material, texture or sampler payload replacement invalidates its source fence. Capture keys include geometry/pose, attribute content, accepted program/values/UVs and residency/sampler facts |
| Transaction | Capture, selection, sampling and support must all encode, physically submit and remain current before the candidate publishes. Failed finish/submit, source mutation and missing writers preserve accepted state; old atlases and texture leases wait for their last GPU use |
| Tooling | Graph names are `probe-card.capture`, optional `probe-card.material.*.mip-*`, `probe-card.selectCandidates`, `probe-card.sampleCards` and `probe-card.support`. RHI Debug identifies actual Card draws by `vs_card`/`fs_card`, their material bindings and coherent attachments; compute passes retain their labels. `inspect().probePlacement.global.cards` reports physical capture state, Card count and owned capture bytes |

Selection and sampling borrow the original Global hit buffers and retained field
inputs. The final 32-byte per-ray support record stores
`[kind, originalQueryStatus, candidateFlags, mappedCandidateMask]` followed by
`[hitT, TMin, TMax, firstSampleDistance]`. Masked rays stay masked; negative-start
and hits at/before TMin stay blocked; other hits require a mapped sample and no
association refusal flags. Unmapped opaque hits remain unsupported, true misses
remain environment-eligible, and budget/missing/outside outcomes remain unresolved.
Support does not inspect RGB: a valid black Surface is supported. This stage
neither evaluates environment radiance nor lights the Surface Cache.

### Rays from current probe candidates

`render/internal.createProbeRayRecorder(device, module)` records `PROBE_RAYS_WGSL`
into a caller-owned compute pass. It borrows exact 32-byte probe/current-candidate
rows, a 16-byte settings range (`tMax`, three reserved zeros), 48-byte ray output
rows and 16-byte emission diagnostics. It reads no accepted-history buffer and
owns no allocation, submission or Renderer publication.

Each probe emits a fixed row-major square of texel-center directions using the
Clarberg equal-area sphere mapping also used by UE Lumen. Resolution is 1..256;
`probeCount * resolution²` must fit 65,536 rays. Origins are base plus this attempt's
candidate offset, with zero TMin and mask 255. Reserved mask words stay zero.

Invalid identity, generation or numerical input and untraced eligibility overwrite
the whole probe interval with safe mask-zero rays. Diagnostics retain ID, generation,
emission status and count; these lanes must not be interpreted as traced misses.
No Global-field clearance or inside/coverage test prefilters rays: downstream query
keeps `negativeStart`, `missingField`, `outsideRegion` and step-budget results distinct.

The caller must order placement before emission and emission before query, using
the same candidate graph resource. The standalone recorder and its real GPU replay
tests do not yet connect this chain to ordinary Renderer or produce indirect light.

### Ordinary Renderer diffuse GI reference lane

Opt in through `renderer.setProfile({ ...profile, renderPath: 'deferred',
ibl: false, diffuseGi: { gather: 'exact', maxBounces: 1, maxDistance: 100,
environment: [0.25, 0.3, 0.4], seed: 47 } })`. Deferred PBR is required;
`visibleSurface` is derived on. Omit `diffuseGi` to disable and retire its resources.
This is an exact compute-query reference, not Lumen gather or a qualified hardware
Ray Query implementation. Its explicit constant environment does not consume or
replace Skylight/probe lighting. IBL must stay disabled to avoid double counting.

| Boundary | Contract |
|:--|:--|
| Inputs | Complete retained rigid scene and accepted material publication/texture residency; current view supplies G-buffer, surface identities and View uniform |
| Per frame | One cosine sample per internal texel, reset raw D, shared receiver response, additive RGB to existing direct/emissive HDR; destination alpha preserved |
| Lifetime | Preparation keyed by scene/material/resource/device/profile/extents; async and pre-submit fences reject stale content; failed submits do not advance sample count; old buffers/textures wait for GPU completion |
| Limits | 1..262144 internal texels; 1..8 bounces; positive finite f32 distance; nonnegative linear RGB; u32 seed; existing rigid/material/MASK/scene bounds apply |
| Diagnostics | `renderer.inspect().diffuseGi`: preparation state, generation, submitted frame count, pixel count and structured producer error; RHI Debug sees generate/transport/composite work and exact inputs |

The optional `diffuseGi.reconstruction` selects `spatial`, `temporal` or `combined`;
omission preserves raw output. Reconstruction consumes linear receiver-independent
D and existing visible-surface/motion/View inputs. Per-tap stable identity, normal,
plane and previous-view depth admission precedes bilinear weight normalization.
The temporal result alone enters next-frame history; spatial output is display-only.
Effective history weight (bounded to 16) never changes raw ray counts or errors.
Current invalid transport remains invalid and supplies no filter support.
Valid zero estimates participate normally. Static history is not clamped to a
noisy current neighborhood; known lighting/content changes reset its generation.

Reconstruction owns two 96-byte-per-texel histories, a 16-byte signal, 16-byte
diagnostics and one 48-byte uniform. The existing accepted-sample counter selects
ping-pong allocations. Content replacement, view/projection changes, cuts and
recovery reset history; only accepted submission publishes reuse/reset inspection.
RHI Debug reads raw/temporal/spatial values, moments, weights and rejection bits at
their actual work indices. This is a minimal pixel reconstruction reference, not
Screen Probe filtering or a claim of UE denoiser parity; quality and hardware cost
qualification remain in the iteration report.

A pending or failed preparation submits the normal direct frame without GI and exposes its state;
missing scene representation never becomes sky radiance. Runtime source textures,
shape deformation and LOD changes require their separately qualified representation.
A preparation rebuilds the frozen query scene; it is not a performance guarantee
for full-resolution production content. The [ordinary-frame tests and diagnostic
commands](../../scripts/raytracing/README.md#ordinary-renderer-diffuse-gi) distinguish
software GPU checks, actual hardware measurements and remaining limits.

### Irradiance-field diffuse GI (Lumen-Lite)

`diffuseGi.gather` is a closed union: `'exact'` (the reference lane above),
`'irradiance-field'`, the production lane, `'screen-probe'` and `'baked'` (a cooked volume, see
[Baked irradiance volume](#baked-irradiance-volume-build-time-light-bake)). Both feed the same additive
`fs_ray_diffuse_reconstructed` composite (`D * albedo * ao`, D = E/π), so the two lanes
never double count and never coexist.

```ts
renderer.setProfile({ ...profile, renderPath: 'deferred', ibl: false, diffuseGi: {
  gather: 'irradiance-field', maxDistance: 100, environment: [0.25, 0.3, 0.4],
  field: {
    region: { grid: { origin, dimensions, spacing, maxDistance, coverageDistance },
              maxInstances: 64, maxFieldBytes: 16 << 20 },
    probeSpacing: 1, raysPerProbe: 64, probeBudget: 64, hysteresis: 0.9,
    cards: { resolution: 32, maxCaptureBytes: 8 << 20, budget: 64 },
    resolution: 'half', radiosity: true,
  } } });
```

Meshes need the cooked distance field and Card layout (`MeshAsset.distanceField`,
`cardLayout`); the region and Cards reuse the probe-placement Global SDF owner.

| Graph pass (label) | Work |
|:--|:--|
| `irradiance-field.compose` | Global SDF composition: the whole grid once per generation, then only the voxel box an in-place edit touches |
| `irradiance-field.visibility` | Derive an `rg32float` 3D sampling texture from the composed distance/status buffer before live-field consumers; runs after each composition, including edits and failed-submit recovery |
| `irradiance-field.card.*` | Progressive Card atlas capture (albedo, normals, emission, validity, depth): up to `cards.budget` tiles per accepted frame into the retained atlas; material mips are built once on the first slice |
| `irradiance-field.card-surface` | Stale Card tiles only (a capture slice, or every tile after a light change or edit): texel world position plus world-traversal shadow mask for up to 32 lights. Skipped while captures, lights and scene are unchanged |
| `irradiance-field.card-lighting` | `albedo/π · Σ visible lights + emission` per texel, on the same frames as `card-surface` |
| `irradiance-field.place-probes` | Expands the scheduled probe list (exposed clipmap slabs, edit sweeps, per-level round-robin) into one trace origin per entry: lattice point plus the probe's relocation offset (zero for a FRESH clipmap slot). A separate pass keeps the trace kernel within WebGPU's 8 storage buffers per stage |
| `irradiance-field.trace-probes` | Traces `raysPerProbe` rotated spherical-Fibonacci rays from each placed origin through the world traversal; hits read Card radiance, misses read `environment`, backfaces record distance only, and a Global SDF negative start records its escape displacement (distance × gradient). The Global SDF trace's self-hit expansion shrinks with the start distance, so an origin closer than one SDF voxel to a surface steps through a sub-voxel wall behind it; a ray into that surface whose hit lies beyond the planar estimate plus one voxel (or misses) is retraced once from one voxel off the surface along the SDF gradient, with its distance referred back to the probe |
| `irradiance-field.update-probes` | `updateProbes`: one 8-thread workgroup per probe, each thread owning 8 texels, splats rays branch-free into the 8x8 octahedral radiance level (hysteresis authority) and distance moments; relocation and classification (see Probe placement). `deriveProbes` (same pass, same thread layout): the solid-angle-weighted cosine convolution of that radiance into the irradiance level, and the 4x4 radiance prefilter |
| `irradiance-field.radiosity` | Card texels add `albedo · field(n)` (one more bounce per frame) over the frame's tile range, one invocation per texel. With static lights and scene it re-gathers `1 / irradianceFieldRadiosityPeriod(plan)` of the tiles per frame (UE Lumen's radiosity fraction): 4, shortened so every tile re-gathers at least once per probe sweep; for four probe sweeps after any Card relight (capture, light change or edit) it re-gathers every budgeted tile, so multi-bounce light settles at full rate and a removed source leaves no ghost. Sharing one field sample across a 2x2 texel block was rejected: coplanar floor texels on both sides of a thin divider share the sample and leak light (hello-gi dark room 1.24 → 1.34 of the reference) |
| `irradiance-field.gather` / `.upsample` | Full or half-resolution field sample per pixel; half uses a depth/normal-aware upsample |
| `irradiance-field.composite` | The shared additive diffuse composite |

| Boundary | Contract |
|:--|:--|
| Lifetime | Generation keyed by device, catalog/material residency, World identities and the profile; a new generation allocates zeroed history (reset), lights and extent never discard the field. Scene content revisions are diffed against the field's owned rows instead (see Dynamic content) |
| Schedule | While capturing, card-surface/lighting/radiosity process exactly the fresh slice; after the last slice every tile is relit once. Afterwards Card direct light is a pure function of unchanged captures, lights and scene, so it is skipped until the next slice, light change or edit relights every tile in one frame, while radiosity keeps rotating over `min(cards.budget, ceil(tiles / period))` tiles per frame (every budgeted tile for four probe sweeps after a relight). Probe, tile, capture and frame offsets advance only after an accepted physical submit; any Card relight (capture, light change or edit) restarts the shared settling counter and blends the next four lattice sweeps with hysteresis `min(hysteresis, h)` for `h` in `IRRADIANCE_FIELD_RELIGHT_SWEEPS` (`[0.25, 0.25, 0.5, 0.5]`), so stale indirect light halves in about one sweep instead of two and reaches 90 % in about four instead of seven; steady-state hysteresis and noise are unchanged; a continuously relit Card keeps restarting the first sweep |
| Probe placement | DDGI-style relocation from the probe's own rays, bounded per update: inside (more than 25 % backface rays) with a Global SDF escape steps out along it plus `clearance`; inside with a measured backface steps through the closest one plus `clearance`; open-space probes keep their lattice point. The offset stays within `limit` per axis of the lattice point (`IRRADIANCE_FIELD_RELOCATION`: clearance 0.25, limit 0.45, restart 0.1 spacings, so a probe never crosses into a neighbor's cell). A move beyond `restart` restarts the probe's history from the new origin. Geometry thinner than a Global SDF voxel has no negative interior, so a probe centered inside it is not detected (Ray Query traversal sees its backfaces) |
| Angular sampling | D, 8x8 radiance, 4x4 prefilter and depth moments share four bilinear taps. Taps outside the interior reflect across octahedral edges, providing seam-continuous filtering without a stored border. Unsupported radiance taps provide neither color nor denominator; supported black taps participate normally. The mapping changes no probe allocation or trace/update budget |
| Validity | `IrradianceFieldProbeState` in meta: `untraced`, `active`, `inside` (still more than 25 % backfaces after relocation reached `limit`) and `relocated` (moved this update; history restarts). Only `active` probes contribute; probes behind the receiver plane never contribute; the side test and Chebyshev visibility (cubed) use the relocated position while trilinear weights stay on the lattice |
| Distance moments | The depth clamp encloses the biased receiver's cell corners including each probe's per-axis relocation: `ceil(sqrt(3) · (1 + limit))` spacings, scaled by the clipmap level. With the current relocation limit it is 3 spacings; a 2-spacing clamp wrongly rejects an open-space far corner. Diffuse and radiance-cache consumers share these moments and geometric weighting, admitting their queried angular support |
| Diagnostics | `renderer.inspect().diffuseGi` (`gather: 'irradiance-field'`): state, generation, submitted frames, pixel count, probe lattice/budget, Card `tiles`/`captured`/`perFrame` plus the last submitted frame's `relit` (direct-lit) and `radiated` tiles, `edits` (`IrradianceFieldEditStats`), `residency` (`resident`/`pending`/`evicted`, only when the scene exceeds the Card ceilings), `share` (this frame's `views`, `probes`, `captureTiles`, `relightTiles`), structured error; with CameraViews each view reports its own field under `inspect().views[i].diffuseGi`; GPU pass timings use the labels above |
| Recovery | Device loss rebuilds the field from zero history; disable retires buffers after submitted work completes |
| Sizing | Size `probeSpacing` from the region's geometric-mean extent (hello-gi: `cbrt(x·y·z) / 12`), not its longest axis: a longest-axis rule leaves flat rooms and tall atria only a few probe layers thick, which leaks light through thin dividers and under-represents bounce light (Sponza 0.82 → 0.96 of the path-traced indirect). Card texels must stay well below wall thickness plus the surface bias; 16-texel Cards bleed lit texels across a 4 cm divider, 32-texel Cards do not. `cards.maxCaptureBytes` is a ceiling, not an allocation (the tier default is the 256 MiB maximum); above it the field streams Card residency on either world traversal (see Card residency) |

Deliberate deviations from UE5 Lumen: an 8x8 interior octahedral map per probe
without the 1-texel border (bilinear fetch clamps at the edge), a single regular
world lattice instead of screen probes plus clipmapped world probes, linear
hysteresis blending of irradiance instead of UE's perceptual sqrt-space blend, Card
radiosity reads the probe field instead of tracing per-texel hemispheres, and a strict
backface rejection instead of a smooth normal bias weight. Probe relocation and
classification follow DDGI (per-probe offset from its own ray hits) rather than UE's
screen-probe placement, which has no persistent world probes to move. The world radiance
cache shares the probe lattice (and its clipmap) instead of UE's separate
clipmapped radiance-cache probes.

#### Dynamic content

A scene content revision does not rebuild the field. `SceneFieldRows` re-admits only
rows named by retained slot, Mesh, Material and asset evidence. Changed admitted
sources assemble a delta; `diffFieldEdit` compares only those sources against owned
rows, and adoption updates their exact identities without enumerating clean rows.
Identity is World, entity, slot, slot generation and instance generation; geometry
content is scope, mesh handle and asset revision, while material bindings retain
the accepted material resource/handle facts. Shared material values stay in their
existing root owner.

A source remains pending until its edit actually applies: asynchronous Card
preparation cannot discard an earlier move, removal or replacement. Slot reuse
removes the old identities and adds the new generation. Instance totals and unique
field-byte charges update from the same before/after receipt, and detached field
snapshots remain shared per asset version. Unchanged sources neither assemble nor
rebuild the adopted instance index. The SDF exterior proof counts adopted bounds
outside the region and updates only edited rows after its initial cold check.
Cold construction, recovery, unavailable row history and invalid/over-budget input
retain a complete projection; the original ordered validation failures still apply.
The explicit 1024-instance budget bounds admission, independently of incremental
maintenance. `edits.skippedProjections` reports revisions with no admitted change.

| Delta | Field response |
|:--|:--|
| Move of an owned instance | Rewrite its Global SDF inverse/scale rows, re-project its world-space Card geometry and lookup projections in place (same tiles, same atlas rectangles), clear and recapture **only its tiles**, recompose only the Global SDF voxel box covering old + new bounds plus `maxDistance + spacing`, relight every tile once, then sweep the probes within 2 lattice spacings three times with `min(hysteresis, 0.5)` |
| Removal | Mask its SDF row, turn its lookup tiles into holes, recompose its box; same relight and probe sweep. No light remains from it once the sweep finishes |
| Addition (new identity), mesh or distance-field change, LOD | In place when spare capacity fits: write SDF/bounds/field rows and Card projections, capture **only its new tiles**, recompose its Global SDF box, relight and sweep nearby probes. A mesh/field change is a removal plus an addition |
| Material-only change | Replace its Card draws in place (same tiles, same order) and recapture them; no SDF recompose |
| Flip of handedness, capacity overflow, a texture or scope not yet resident | New generation (reset + progressive full capture) |
| Light change | Never touches Cards or the SDF; every tile relights on the next frame |
| Skinned / morph source (`skin`, `skinPose`, `morph`, morph targets) | Excluded from the field: no SDF, no Cards, so it never occludes or bounces GI; it still receives GI and screen traces. Its animation is a no-op edit. Its deferred draw writes visible-surface row 0 (uncovered) through the skinned `fs_gbuffer_uncovered` entry, so the forced visible-surface target never invalidates its pipeline |

The field reserves spare capacity when it is built: atlas tiles `max(64, cardCount)`
(at most half the capture byte budget, 4096 tiles and an 8192-texel extent), Global SDF
rows `min(1024, maxInstances)`, field words up to `maxFieldBytes / 4` and Card
projection rows for every spare tile. One index allocator hands out tile runs and SDF
rows (freed runs first, then append); field words are append-only and identical fields
share one copy. Preparing a new Card program is asynchronous: the edit reports
`'deferred'` and keeps the current field until it is ready. Overflow or a failed
preparation rebuilds before anything is written. The Ray Query lane applies the same
deltas (moves/removals rebuild only the TLAS, an add builds one BLAS per new mesh, a
material change does no acceleration work; see World traversal seam), so edit statistics
and probe restarts match the Global SDF lane.

Card capture is one progressive scheduler (`CardCaptureScheduler`) shared with the
exact lane: each frame captures at most `cards.budget` tiles, the never-captured
frontier first and then edited tile runs, which clear their slice before recapture.
It advances only once the slice is submitted.

The probe field is never reset by an edit; the old lighting fades with fast
hysteresis while the edited Cards are relit. `edits` reports `applied`,
`movedInstances`, `removedInstances`, `addedInstances`, `rematerializedInstances`,
cumulative `recapturedTiles`, `pendingTiles`, `composedVoxels` of the last edit,
`priorityProbes` / `pendingPriorityUpdates` and `skippedProjections`.

#### Camera-following probe clipmap

`field.clipmap: { levels: 1..4, dimensions: [x, y, z] }` replaces the fixed lattice
with nested probe windows centred on the view camera (UE Lumen radiance-cache
clipmaps). Level `l` spaces probes `probeSpacing * 2^l` on a lattice anchored at
`region.origin + region.spacing`; each window snaps to its own spacing.

| Concern | Contract |
|:--|:--|
| Addressing | Toroidal: probe slot = `level * dims³ + (cell mod dims)`. A scroll never moves a still-covered probe; only the newly exposed slabs (at most two per axis) re-trace, flagged FRESH so their history restarts (meta count 1) |
| Schedule | One `ProbeClipmapScheduler` per field writes the per-frame probe list (`probe-list` storage buffer, flags in bits 31 FRESH / 30 FAST): exposed slab heads first, then one edit sweep at `min(hysteresis, 0.5)`, then per-level round-robin. Entries are unique per dispatch; the list advances only on an accepted submit |
| Budget | `probeBudget` is the frame total and splits over levels by `2^-l` (`levelBudgets`, each level at least 1); exposed slabs borrow it first, so a large jump spreads over several frames. Quality tiers own the level count (medium 2, high 3, epic 4) when the scene passes `clipmapDimensions` |
| Sampling | The finest level whose traced box holds the receiver, cross-faded over 2 cells at the box edge to the next coarser level (16 corners, shared by irradiance and radiance-cache lookups). Corners outside the traced (valid) box never contribute, so an untraced slab is invisible until it completes |
| Diagnostics | `inspect().diffuseGi.probes.clipmap`: `levels`, `levelBudgets`, `windows`, `valid` boxes, per-level `scrolls`, cumulative `exposedProbes`, `pendingExposedProbes` |

The Global SDF region and Cards stay fixed while the probes scroll: probes outside
the region trace only `environment`. Without `clipmap` the lattice is the single fixed
region and the output is unchanged.

#### Card residency

A field whose Cards exceed the atlas tiles or `cards.maxCaptureBytes` keeps the
highest-priority instances resident instead of failing. One `CardResidency` owner per
field serves both world traversals: residency writes only the Card lookup rows and the
`settings.z` pending flag that `worldCardRadiance` reads, so a Global SDF hit (instances
associated by distance) and a Ray Query hit (the committed triangle's instance, the only
candidate) shade pending instances identically. Non-resident instances stay in the Global
SDF and the TLAS, so they still occlude:

| Concern | Contract |
|:--|:--|
| Priority | `radius / max(distance, radius)` of the instance's world bounds from the nearest active view focus (every CameraView running a field); ties by ascending Global row, so the resident set is a pure function of the scene and the views |
| Streaming | Up to the frame's capture share of new tiles installs per frame; a resident is evicted only for a candidate that outranks it by `CARD_RESIDENCY_HYSTERESIS` (1.5), at most 8 per frame. Evicted lookup rows invalidate immediately and their buffers retire after the next tracked submission |
| No flicker | Installed rows stay pending until the scheduler covers their tiles with a submitted capture. While anything is pending, a probe ray hitting an instance without captured Cards returns ray status `unlit` (4) on either traversal: it shapes depth moments but adds no radiance, so probes keep their radiance history instead of reading black |
| Diagnostics | `diffuseGi.residency`: `resident`, `pending` (`resident + pending` = every Card instance), cumulative `evicted` |
| Evidence | `renderer-irradiance-field-residency.dawn.test.ts` streams under a byte ceiling on Dawn (Global SDF) and, under `FORGEAX_WEBGPU_NODE=wgpu-native`, on Ray Query; `world_traversal_parity.rs` (`pending_cards_are_unlit_on_ray_query_and_global_sdf`) proves pending hits read unlit on both traversals natively, with a black-without-flag falsifier |
| Limits | An instance whose own Cards exceed the atlas never installs |

#### Multi-view budgets

CameraViews that enable `diffuseGi` share one Renderer budget (`DiffuseGiBudget`).
Each view's field claims the Renderer frame before scheduling; the active roster is
every field that claimed this or the previous frame. `probeBudget`, the Card capture
budget and the Card relight budget each split as `floor(B / N)` per view, the
remainder rotating by frame, never below 1, so the frame total stays `B` (up to one per
view for a tiny budget) and no view starves. Residency ranks against every view's
focus. Each view still owns its field memory (probes, atlas, Global SDF); sharing one
field across views is not implemented.

Probe ray rotations advance with the existing per-probe accepted-update count,
not the Renderer frame number. A reduced budget therefore preserves each probe's
ray sequence instead of sampling a different subsequence. Fresh clipmap cells and
relocated probes restart that count with their lighting history.
The rotation parameters use a base-2/3/5 Halton sequence indexed by that count,
with a stable hashed shift per probe. This spreads early updates across rotation
space and avoids synchronizing neighbouring probes with equal update counts.
Placement carries the derived count beside the origin in one 32-byte transient
record; tracing retains the default eight-storage-buffer limit without another
metadata binding.

The two-room GPU regression records a 480-frame solo baseline first, then measures both
views through the entire permitted sharing deadline: at most 2.5 times the solo
settling frame, or 32 extra frames, whichever is larger. Both use the same solo
steady-energy target with 10% relative tolerance; their independent future means
must also agree within the original absolute tolerance. The test retains the
96-probe/32-Card budget checks and RHI Debug dispatch evidence.

#### Quality tiers

`resolveDiffuseGiTier(tier, scene, caps)` maps the closed ladder
`'low' | 'medium' | 'high' | 'epic'` (`DIFFUSE_GI_TIERS`, `parseDiffuseGiTier`) to the
profile fields a tier owns (`renderPath`, `pbr`, `ibl`, `ssao`, `diffuseGi`); the
caller owns the region framing (`DiffuseGiTierScene`). Budgets are the data in
`DIFFUSE_GI_TIER_BUDGETS`:

| Tier | Lane | Field rays / probes per frame / Card budget / resolution | Screen probes |
|:--|:--|:--|:--|
| `low` | `direct-ibl-ssao` (GI off) | - | - |
| `medium` | `irradiance-field` | 32 / 64 / 128 / half, no radiosity; 2 clipmap levels | - |
| `high` | `screen-probe` | 64 / 128 / 256 / half, radiosity; 3 clipmap levels | downsample 16, 1 filter pass |
| `epic` | `screen-probe` | 128 / 256 / 512 / full, radiosity; 4 clipmap levels | downsample 8, 2 filter passes |

Without compute storage buffers or on the WebGL2 backend a GI tier resolves to
`lane: 'direct-ibl'` with `fallback: { reason, hint }`
(`'compute-unavailable' | 'storage-buffer-unavailable' | 'webgl2-backend'`); capability
absence is data, never an exception. Measured per-tier GPU time is produced by
`apps/hello/gi/scripts/gi-budget.mjs` (see the hello-gi README).

Other consumers sample the field through the WGSL module
`forgeax_ray::irradiance_field_sample`: bind `@group(1)` b0 `IrradianceField` uniform
(256 bytes: origin+spacing, dimensions+count, biases+blend band, levels+per-level
count, then per level the window and traced `[validMin, validMax)` cell boxes), b1
probe block `array<vec4f>`,
b2 moments `array<vec2f>`, b3 probe meta `array<vec4u>` (x update count, y
`IrradianceFieldProbeState`, zw relocation offset as f16 xyz). Each probe owns one
144-texel (2304-byte) block in b1:

> [!IMPORTANT]
> Live-field utility artifacts enable the private `IRRADIANCE_FIELD_VISIBILITY`
> definition and additionally bind b4 (the existing 48-byte Global SDF grid uniform)
> and b5 (its derived, unfilterable `rg32float` 3D distance/status texture). Every
> positive-weight candidate must pass a bounded receiver-to-relocated-probe segment
> query after the existing bias. Occluded corners contribute exactly zero. Missing
> coverage, an unproven region exit, or exhausted traversal returns `w = -1` for the whole
> query; known corners cannot normalize an incomplete subset into valid cache or
> Screen Probe history. `w = 0` remains absent support and `w = 1` includes resolved
> black. Numeric f32 status avoids subnormal flushing. This projection adds no
> storage-buffer binding and is retired with the field generation. Baked-volume
> artifacts compile the same source without live visibility and keep four bindings;
> their entry points are `gatherBakedField` / `upsampleBakedField`.

Live sampling uses the full stored SDF sample box: distance interpolation needs no
gradient border. Each frame derives `IrradianceField.levels.w` from the adopted
scene's transformed trace bounds, including sources without field data. Only
when all those bounds fit the sample box may a segment clip to that box and treat
its exterior as empty. Moves, adds and removals change the proof through the
existing edit authority; there is no separate coverage history. Missing voxels
inside the box still invalidate the query. Screen Probe reuses the field's sample
bind group directly, so both consumers share the live binding contract.

| Texels | Level | Content |
|:--|:--|:--|
| `[0, 64)` | Irradiance 8x8 | `D = E/π`: the normalized cosine convolution of the written radiance texels, each weighted by its octahedral solid angle (∝ `1/|v|³`); derived every update, never blended |
| `[64, 128)` | Radiance 8x8 | Incident radiance `L`; the only hysteresis-blended level, `w = 1` once a ray wrote the texel |
| `[128, 144)` | Radiance 4x4 | Solid-angle-weighted 2x2 prefilter of the radiance level |

Moments stay 512 bytes and meta 16 bytes per probe (2832 bytes per probe in total,
previously 1552). Two entry points share one geometric weighting rule (trilinear,
normal-side test and Chebyshev visibility cubed at the relocated probe position,
active-state only), admitting only probes with support for the queried angular level:

- `sampleIrradianceField(position, normal, viewDir) -> vec4f`: rgb = D.
- `sampleRadianceCache(position, direction, coneAngle) -> vec4f`: rgb = radiance
  arriving along `direction`, prefiltered to a cone of half-angle `coneAngle` by
  interpolating the 8x8 level (≤ 0.25 rad), the 4x4 level (0.5 rad) and the
  cosine lobe (≥ 1.05 rad; irradiance level, `E/π`). `sampleRadianceCacheAt` adds the
  receiver normal/view for the same receiver-side weights;
  `radianceCacheConeAngle(roughness)` maps GGX roughness to a cone.

Both return w = 0 when no supported probe contributes or the current native
scene still has pending instances. A classified active probe
can still lack lit radiance directions while its non-resident Card hits have
updated depth moments. Bilinear taps exclude `w = 0` color and denominator,
renormalize the supported taps, and retain a physically resolved zero. Angular
interpolation requires every endpoint with positive blend weight to have support;
an endpoint with zero weight needs no data. If the finer neighborhood has no
support for that query, sampling falls back to the supported coarser level rather
than promoting unwritten or stale bytes to radiance. Diffuse and a wide-cone cache
lookup retain identical values and support for the same receiver.

The real-GPU `irradiance-field-sampling.dawn.test.ts` gate uses one retained
fine/coarse buffer set. It checks absent support, coarse fallback, resolved black,
individual angular-level absence, endpoint weights and partially supported taps
at seven cone half-angles, alongside the original convex seam, classification and
relocated-corner controls. These support checks do not establish segment visibility
through geometry or close the separate native wall-leak gate.

Live receiver-to-probe visibility samples the final covered point before
publishing a clear segment, including its distance and availability status.
A march step that crosses the endpoint clamps to it; it cannot infer transport
from the preceding sample. Otherwise a near-surface probe's admission alternates
with receiver position and creates ring artifacts. The real GPU
`irradiance-field-segment.dawn.test.ts` varies 33 receiver positions around one
endpoint, retains clear free-space controls and rejects unavailable endpoint
coverage. The bounded step count and conservative distance expansion remain
the same; the separate wall and whole-scene leak gates still apply.

MASK uses the shared Standard opacity/cutoff rule for primary, secondary and shadow rays.
A bounded 64-candidate `(distance, triangle)` cursor preserves coplanar and close-layer
hits; exhaustion flags an invalid sample. The exact lane resolves those candidates
in `RAY_COVERAGE_ROUNDS` (3) GPU-driven rounds per primary or shadow query, so its
dispatch count is independent of candidate depth: each round gathers the ordered
masked candidates of every pending ray (a cumulative window of 16/32/64) into one
shared pool of `rayCoveragePoolCapacity(pixels)` slots, runs only the masked
Surface programs over the pooled range, and resolves each chain nearest first.
Single-thread producers write the pooled and deferred counts into
`ray-path.dispatch-args`, and later rounds use `dispatchWorkgroupsIndirect`
(direct full-size dispatches when `caps.indirectDrawing` is false). A ray the full
pool turned away retries next round; one still pending after the last round is an
invalid sample counted in the coverage header `overflow` (u32 at byte 12), never an
unoccluded approximation. Exact `kind: 'view'` captures use the
same MASK discard. Material `kind: 'cards'` captures retain valid geometric proxy
texels, including cutout regions, from that same evaluated Surface; their validity
is cache data availability, not exact opacity. SDF geometry retains its separate
signed-solid/two-sided surface policy and does not evaluate MASK opacity.
The shared Surface preserves finite
unit shading normals even across the geometric hemisphere; BSDF direction tests
retain null events instead of rejecting those materials.

Geometric normals own culling, ray offsets and card matching; interpolated vertex
normals/tangents supply the Standard shading basis. The opaque radiance estimator
uses shading cosine and rejects either direction below either hemisphere. Rejected
samples remain null mass, without PDF renormalization. Adjoint/importance transport
and transmission are not qualified.

The existing Standard additive diffuse/specular energy convention is preserved;
this is not a new energy-conserving raster model. No denoiser, emitter NEE,
production retained-scene integration, native AS command consumer or Lumen gather
is delivered by this path reference. Eligible Standard ray programs use ordinary
Pack publication, but Renderer transport-scene preparation remains unfinished. This compute
reference running on a physical GPU is **not hardware Ray Query**.

RHI Debug uses ordinary named buffers in the existing v7 tape. Each sample has
`generate → trace/material(s)/shade per bounce → accumulate` works. Inspect an
explicit workIndex; later bounces overwrite hit/Surface buffers. See the
[reproduction and buffer layouts](../../scripts/raytracing/README.md#shared-material-and-path-reference).

### Baked irradiance volume (build-time light bake)

`diffuseGi: { gather: 'baked', volume: '<guid>', resolution: 'full' | 'half' }` gathers
a cooked `irradiance-volume` Catalog asset through the irradiance-field sampler, and
the frame traces nothing: no Card capture, Global SDF, probe trace or probe update ever
runs. Every receiver, static or dynamic (skinned, moving), samples the same baked
`D = E/π` through the shared `fs_ray_diffuse_reconstructed` composite, so `'baked'`,
`'exact'` and `'irradiance-field'` are mutually exclusive lanes of one closed union. The
equivalent UE feature is the precomputed volumetric lightmap gathered like
`r.Lumen.IrradianceFieldGather`; live-field blending is not part of this lane.

```ts
renderer.setProfile({ ...profile, renderPath: 'deferred', ibl: false,
  diffuseGi: { gather: 'baked', volume: '5b0e7c2a-9d14-4f3b-8a61-2c7e0d9f4b18', resolution: 'half' } });
```

**Bake (build time only).** `createIrradianceVolumeCooker()` (`@forgeax/engine-render/internal`)
is an explicit `NativeCooker` keyed `IRRADIANCE_VOLUME_KIND`. Its input is the exact ray
scene (`buildRaySurfaceScene`), its `RayPathMaterial`s, light snapshots, the probe
lattice and `{ raysPerProbe, samples, maxBounces = 7, seed, environment, maxDistance }`.
`bakeIrradianceVolume` traces each probe's spherical-Fibonacci directions through the
reference path integrator (`samples` converged paths, material face culling, the given
environment), then a two-sided first-hit pass for distance and backface status, and
integrates them on the CPU into the field layout: 8x8 octahedral `D` levels, a cos^16
distance-moment splat clamped at `2·spacing`, and per-probe meta
`[updates, valid, backfaces, traced]` (valid when `backfaces · 4 <= traced`). Use
the live field's lattice (`origin = grid.origin + grid.spacing`, `probeSpacing`) so baked
and live lanes sample one grid; bake `maxBounces` equals the reference's bounces after
the receiver's first vertex.

| Boundary | Contract |
|:--|:--|
| Identity | The GUID is caller-owned author identity; every rebake publishes under it (`runTransaction` generation advances), and a failed rebake keeps the last-known-good volume |
| Determinism | Equal inputs give byte-identical `.fxiv` bytes and digest; `irradianceBakeFingerprint` (geometry bytes, material contracts and values, lights, lattice, settings, kernel, format) is the cook's `inputFingerprint` |
| Artifact | One `volume` artifact, media type `IRRADIANCE_VOLUME_MEDIA_TYPE`, format `FXIV` v1 (64 B header, `D` levels, moments, meta); payload `{ artifact, digest, dimensions }`. Corrupt or truncated bytes fail with `irradiance-volume-corrupt` |
| Errors | `IrradianceVolumeErrorCode`: `irradiance-volume-invalid-lattice`, `-invalid-rays`, `-corrupt`; renderer preparation failures surface as `rhi-not-available` with `detail.error.code: 'baked-field-preparation'` |
| Residency | Runtime assembly installs `irradianceVolumeContribution`; the renderer holds the selected typed runtime handle and fixed content, uploads 2832 B per probe (field-stride `D` blocks, moments, meta), and retires them after submitted work. The generation follows device, selected volume content, GUID and resolution |
| Passes | `baked-field.gather`, `baked-field.upsample` (half), `baked-field.composite` |
| Diagnostics | `renderer.inspect().diffuseGi` (`gather: 'baked'`): state, generation, submitted frames, pixel count, `volume` `{ guid, digest, dimensions, probes, bytes }`, structured error |

Measured on hello-gi at 128 px against the 7-bounce, 1024-sample path-traced reference
(lavapipe; bake 128 rays x 256 paths per probe, 7 bounces):

| Scene | Probes | Bake | Artifact | Resident | Baked indirect ratio (relRMSE) | Live field ratio (relRMSE) | Baked GI GPU | Live field GI GPU |
|:--|--:|--:|--:|--:|--:|--:|--:|--:|
| cornell | 2197 | 180 s | 3.25 MiB | 5.9 MiB | 0.998 (0.209) | 1.008 (0.191) | 3.25 ms | 30.9 ms |
| leak | 2496 | 204 s | 3.69 MiB | 6.7 MiB | 1.005 (0.148) | 0.938 (0.231) | 2.12 ms | 35.6 ms |
| leak dark room | | | | | 1.019 | 1.118 | | |
| courtyard | 2527 | 198 s | 3.74 MiB | 6.8 MiB | 1.015 (0.071) | 0.963 (0.099) | 3.37 ms | 34.6 ms |

The baked GI GPU time is the half-resolution gather, upsample and composite only; the
lavapipe figures are relative, not hardware budgets. The [hello-gi smoke](../../apps/hello/gi/README.md#smoke)
gates bake determinism, Catalog-by-GUID loading, the absence of trace passes and the leak
accuracy band.

### Screen-probe diffuse GI

`gather: 'screen-probe'` is the screen-space probe final gather. It places probes on the
G-buffer and traces each probe through the previous frame's lit scene first and
the world second. It feeds the same additive `fs_ray_diffuse_reconstructed`
composite as the other lanes, so it never stacks with them. It consumes the
Renderer's single shared irradiance field (`field`, same contract as
`gather: 'irradiance-field'`) through `forgeax_ray::irradiance_field_sample`;
switching between the two lanes with an identical `field`, `maxDistance` and
`environment` keeps the field generation and its probe history. That field lights the Cards world rays read, and it is the fallback for every
direction and pixel the probes cannot resolve. Deferred PBR, IBL off and
compute are required. WebGL2 reports a structured `screen-probe-preparation`
failure and renders the direct frame.

```ts
diffuseGi: { gather: 'screen-probe', maxDistance: 100, environment, field,
  probes: { downsample: 16, adaptiveFraction: 0.5, importance: 'brdf',
    screenTrace: { maxSteps: 32, thickness: 0.02 }, filterPasses: 2,
    shortRangeAo: 0.5, maxFrames: 10 } }
```

| Pass (`screen-probe.*`) | Work |
|:--|:--|
| `place-uniform` / `place-adaptive` / `compact-adaptive` | One per-frame jittered probe per `downsample` tile on valid depth; half-tile candidates retain the original plane/normal agreement below 0.25. Per-workgroup counts and a bounded compaction pass assign pixel-order slots, admitting the earliest eligible receivers when the unchanged `adaptiveFraction` capacity is exhausted. GPU scheduling cannot change the admitted set or physical order |
| `generate-rays` | 8×8 world-space octahedron per probe; jitter is keyed by packed receiver pixel and frame, so adaptive allocation order cannot change the receiver's samples. `brdf` retains one ray for every positive-cosine texel, including small contributions from decoded normals, and spends the back-facing capacity on the highest cosine-times-luminance estimate from the covered shared radiance cache within the same 64-ray budget. Missing cache coverage keeps the original cosine rank. Supported black still retains its actual base ray; cached light guides refinement rather than replacing traced radiance |
| `trace-screen` | Closest-depth HZB march on the shared view pyramid; a hit returns the previous frame's lit HDR scene, reprojected through the previous view. A cell is free only when the whole ray segment is in front of its closest depth, and once the ray passes behind a surface the depth buffer proves nothing further: the march stops and rejects a later screen hit. A surface with no depth sample (thinner than a pixel, or edge-on to the view) is invisible to this march, so reuse also requires a fully covered clear segment from the shared live field between normal-biased endpoints. A blocked or unavailable segment leaves the original ray for world tracing |
| `trace-world` | Unresolved rays trace from the original normal-biased receiver through the selected world traversal to Card radiance; a miss returns `environment`. Global SDF uses field clearance, while Ray Query uses the exact raster/PT receiver precision bias `max(1e-4, max(abs(position)) * 1e-5)` so a voxel-sized offset cannot skip a nearby triangle. Shared field visibility retains its field clearance. Raster-empty cells cannot certify world-space visibility, so no HZB distance skips thin or edge-on world occluders |
| `resolve` | Averages each texel's rays and derives its closest used, resolved endpoint, including packed refined sub-rays; a texel no ray resolved samples the world radiance cache along its direction (0.25 rad cone, one 8x8 texel) with unknown endpoint |
| `probe-temporal` | Reprojects each receiver into four previous uniform probes before filtering. Plane/normal agreement, covered live-field visibility and directional hit parallax reject incompatible transport; supported unfiltered radiance is normalized and accumulated within its share of `maxFrames`. Each directional texel keeps its effective age; black radiance remains supported and missing current transport clears its retained age. Adaptive receivers read geometry-compatible uniform history instead of assuming adaptive slot identity |
| `filter-N` | `filterPasses` probe-space passes gather the same texel from neighbour probes, weighted by plane/normal agreement, covered live-field visibility and directional hit parallax. The neighbor hit distance is clamped to the receiver's closest resolved hit; its angular shift must fit the octahedral texel's solid-angle cone. Four lanes evaluate geometry and visibility once per probe; all lanes consume the resolve-owned endpoint records without reading or reducing rays again. Neighbour visibility queries stay bounded at four per pass; physical timing is measured separately |
| `integrate` | Per pixel: solid-angle-weighted cosine convolution of filtered radiance at the actual short-range bent normal, then bilinear uniform probes plus the tile's adaptive probe, multiplied once by short-range AO; with no admissible probe the irradiance field is sampled. Reuses the filtered radiance binding without a converted octahedron allocation or pass |
| `temporal` | Reprojects the previous accumulation through the last accepted view geometry; each of four bilinear taps is rejected on absent support, view-distance (2%) or normal (45°) disagreement, then valid tap weights are normalized. No valid tap cold-starts from the current estimate. The youngest contributing tap bounds effective history age; its share of `maxFrames` caps the count |
| `composite` | The shared additive diffuse composite |
| `scene-history` | Copies the lit HDR scene, including this frame's GI, as the next frame's screen-trace radiance, giving multi-bounce |

| Boundary | Contract |
|:--|:--|
| Lifetime | Probe/pixel history resets on device, profile, field generation and extent, and reprojection rejects every pixel and every screen-trace hit after a geometric temporal reset (camera cut, view switch, history version); a Transform teleport without a `Camera.historyVersion` bump is continuous motion and reprojects whatever the old view estimated. Probe and pixel history also restart while an in-place field edit (Card recapture or probe sweeps) is pending, so world lighting changes are not smeared over `maxFrames`; a sun, environment or fog change keeps the reprojection and converges through `maxFrames` instead of restarting. Resize replaces only per-extent buffers and keeps the field. A rejected submit neither flips ping-pong parity nor counts a frame. Disable retires the field after its submitted work completes. |
| Support | A resolved zero has directional support; an unresolved direction without an admissible retained cache does not. Probe filtering excludes missing neighbors and never fills a missing center. Cosine convolution rejects the actual receiver direction if any positively weighted input lacks support; directions outside that cosine lobe do not participate. Spatial probe interpolation retains that validity. Pixel integration falls back to the field, and without either source it clears pixel history and effective weight. Ray status retains the distinction between actual resolved rays and retained-cache reconstruction; the temporal count is an effective frame weight, not a ray sample count |
| Spatial transport | Normal/plane agreement cannot connect coplanar surfaces across a partition. Live-field spatial filtering and pixel interpolation also require a fully covered clear segment between normal-biased endpoints through the shared scene visibility projection. Occluded or unavailable segments contribute no interpolation weight; an unsupported pixel uses the existing field fallback. Placement remains a geometric decision. |
| Directional hit geometry | The existing 32-byte ray record carries resolved hit distance in its final 4 bytes. Screen hits measure their accepted world endpoint from the receiver; world hits measure the traced endpoint, misses use `maxDistance`, and an immediate blocker is zero. Negative means unavailable, including unresolved, incomplete or cache-only transport. Resolve reduces only used, resolved rays and keeps the minimum across sub-rays. Its internal 32-byte directional record carries RGB/support plus hit distance; the two radiance buffers and two probe histories use this record. History keeps effective age in place of support and retains the current resolved endpoint. Temporal reuse scales the youngest retained effective count by the fraction of geometrically supported weight surviving directional parallax before adding the one current resolved sample; RGB normalization cannot turn a small transport overlap into full historical confidence. Coincident or unknown endpoints retain the original age, support and cap. Both temporal reuse and spatial filtering share one parallax kernel. A known distance on either receiver constrains parallax; two unknown distances retain the existing geometric/support test. Supported black remains valid and unknown endpoints are never invented. The filter stage removes its ray-buffer read and 1,280-byte atomic workgroup reduction. No additional storage binding, buffer or author parameter is introduced, but extending the four existing radiance/history buffers adds 4,096 bytes per probe; allocation still checks every buffer against the device limit. Temporal still uses at most eight storage buffers with the complete field group, and filtering uses seven. |
| Probe interpolation | One shared eight-phase Hammersley offset places interior probes. Outermost rows and columns anchor to valid viewport-edge pixel centers, including partial final tiles, so jitter does not leave a screen border uncovered. Tap selection inverts these boundary intervals and uses the previous phase for history. Nominal tiles select the same four taps; supported, compatible taps use their actual placed world positions to derive nonnegative bilinear weights. A bounded six-step inverse solves a four-position patch; one-row/column grids project onto their edge. Incompatible, degenerate or unconverged patches retain covered nominal weights. Probe history uses the same position reconstruction before directional support and live visibility rejection. No missing support or dark radiance is invented. |
| Limits | `downsample` 4/8/16/32; `adaptiveFraction` and `shortRangeAo ≥ 0` finite; `screenTrace.maxSteps` 0..128 (0 = world only), `thickness` (0, 1]; `filterPasses` 0..4; `maxFrames ≥ 1`; every per-extent buffer within `maxStorageBufferBindingSize` |
| Reconstruction response | `maxFrames` is one response budget across probe and pixel history. With both enabled, probe cap is `max(1, floor(maxFrames / 2))` and pixel cap is `maxFrames - probeCap + 1`; their steady EMA mean ages sum to `maxFrames - 1`. A single enabled lane uses the full cap. Effective ages may be younger when geometric support is rejected; this bounds mean delay rather than promising a particular whole-scene convergence rate or counting ray samples |
| Independent controls | `probes.history` accepts optional `probe`, `pixel`, and `screen` booleans, each defaulting to true. Disable a lane to measure it independently; switching the profile retires and resets its histories. `maxFrames: 1` disables probe/pixel accumulation while leaving screen feedback independently selectable |
| Diagnostics | `renderer.inspect().diffuseGi` (`gather: 'screen-probe'`): state, generation, submitted frames, probe tiles/uniform/adaptive capacity and the shared field inspection; RHI Debug sees every kernel by entry point |

Deviations from UE: radiance is RGB octahedra in storage buffers, not atlases.
The shared field's radiance level stands in for UE's world probe radiance cache
and the Lumen scene fallback. Adaptive placement is one pass with four sub-tile
slots per uniform tile. Probe radiance history is retained before spatial filtering,
then per-pixel history follows integration; both use the same submission transaction. In this lane the shared field allocates no per-pixel diffuse gather; its
view extent holds only the Lite reflection records when `reflections` is set.

Angular jitter uses the existing eight-phase Hammersley sequence with a fixed
random rotation per receiver. A uniform tile keeps its sequence while its placed
pixel jitters; an adaptive receiver follows its packed pixel through compaction.
`screen-probe-ray-sequence.dawn.test.ts` checks all eight strata in both coordinates,
phase wrap, unit directions, the original 64-ray budget and adaptive slot invariance.
This changes neither storage bindings nor authored settings. Kernel stratification
is distinct from whole-scene noise, bias, motion and physical cost acceptance.

Refinement reads the field group already supplied to every probe kernel. Its
0.25-radian radiance query uses the same directional cache contract as unresolved
transport. `screen-probe-support.dawn.test.ts` checks real emitted rays with
untraced, constant, black and bright off-axis cache controls: every positive-cosine
direction survives, constant light preserves the original rank, and the bright
lobe receives four actual sub-rays. This allocation regression does not qualify
whole-scene motion, Sponza quality or physical cost.

The controlled production-kernel gate
`screen-probe-radiance-history.dawn.test.ts` covers supported bilinear history,
plane/normal/empty-tap rejection, black and constant radiance, missing and incomplete
current transport, youngest age, disabled history, shared response budget, geometric reset, out-of-view,
one-frame accumulation, cross-wall visibility, unavailable coverage, near/far endpoint parallax, supported black, zero-distance blockers and coincident receivers. The support suite independently verifies closest-endpoint reduction from actual packed/refined, unused, unresolved, unknown and incomplete rays. It requests
no elevated device limits. `screen-probe-reconstruction.dawn.test.ts` independently checks affine pixel and prior-probe reconstruction over all jitter phases, flat and tilted planes, the full viewport and non-square partial final tiles. Full-scene motion, thin-wall, Sponza and physical
performance acceptance are separate and remain required.

Dawn/lavapipe evidence at 32×32, downsample 8, 64 rays per probe
(`packages/runtime/src/__tests__/renderer-screen-probe.dawn.test.ts`,
artifacts in `artifacts/screen-probe/dawn/`):

| Check | Result |
|:--|:--|
| Lights off | Bit-identical to GI disabled |
| White furnace (albedo 1, L = 0.5) | mean 0.4977 (99.5%), max 0.4995; world-only trace 0.4992, screen vs world mean abs 0.0015 |
| Leak falsifier (emitter behind a wall) | field max 4.0 behind the wall; visible face 0.0024 = 0.19% of the unblocked 1.292, a flat radiance-cache floor (max = center) |
| Temporal | frame-to-frame change 0.0019 without history, 0.00024 converged, 0.00019 while the sun changes every frame |
| Camera motion | stale image error 0.062; first moved frame 0.031 on reprojected pixels (ideal warp of the old image 0.035) and 0.030 on disoccluded ones (stale 0.102); 0.014 after 8 frames |
| vs 4-bounce exact lane (indirect term) | mean abs 0.020 (6.7% relative), bias -0.014, max 0.16 |
| Emitter energy (sun off, emissive only) | 1.21× the 4-bounce exact lane; the irradiance-field lane reads 1.10× through the same world trace |
| Irradiance-field lane vs 1-bounce exact | mean abs 0.043 (18%) |
| hello-gi `leak` (128 px, vs 7-bounce path tracer, lavapipe) | lit-room indirect 0.94× (was 0.24× while the march extended free space behind occluders), whole-image indirect 1.01× (was 0.29×), relRMSE 0.48 (was 1.24); the dark room measures 0.0838 against a 0.0076 reference (11.1×; it was 4.06× while the broken march resolved almost nothing on screen). That excess is screen hits: the camera sits in the separator's plane, so the 4 cm wall covers about 0.4 px and has no depth sample, and screen rays from the dark room reach the lit room's pixels. With the screen trace off (`maxSteps: 0`) the same view measures 4.1×. With the camera moved 1.5 m sideways the wall rasterizes and the dark room measures 1.95× (2.97× while hits behind a surface were accepted; world only 1.72×). The hello-gi smoke gates the 64 px lit room in [0.7, 1.3] (measured 0.87, 0.30 before), the edge-on dark room below 0.22× of the lit room (measured 0.17–0.18×), and the sideways dark room at most 4.4× its reference (measured 3.84–3.95×, 4.99× with hits behind a surface accepted) |
| hello-gi `leak` camera cut into the dark room (128 px, mean over converged, lavapipe) | with `historyVersion` bumped: 0.98× on the first frame and 0.98× at frame 8 (cornell 0.98×, courtyard 0.996×). Teleported without it: 1.37× first, 1.19× at frame 8, 1.02× at frame 30, because the old view over-lights the dark room through the edge-on separator and that history passes the distance/normal test. The hello-gi smoke gates the cut at 128 px: first frame and frame 8 within 10% (measured 0.99× and 1.00×; the same move without the bump measures 1.40× and 1.22×). UE would not auto-cut this move either: `bIsLargeCameraMovement` needs 75° or 100 m, and the move turns about 4° over 5.6 m |
| RHI Debug | composite replayed on a fresh device is byte-equal, 29 works |

Median lavapipe GPU time per pass (microseconds, software rasterizer, not a hardware budget):
place 144+144, generate-rays 743, trace-screen 284, trace-world 916, resolve 488,
filter 181+188, convert 391, integrate 216, temporal 181, composite 223,
scene-history 173; the shared field adds trace-probes 22935 and update-probes 6508
(the pre-derivation kernel; see the reflection section for the current update cost)
at the test's `probeBudget: 512` (every probe every frame). Field cost scales
linearly with `probeBudget`: probes update round-robin, so `probeBudget: 64` on
the same 512-probe lattice dispatches one eighth of those rays per frame and
refreshes every probe each 8 submitted frames.

### Lite reflections (world-traced specular indirect)

Opt in on the same GI profile: `diffuseGi: { gather: 'exact', ..., reflections:
{ maxRoughnessToTrace: 0.4, roughnessFadeLength: 0.1 } }`. The field lives on the GI
lane because it consumes that lane's world radiance and lifetime (one profile field,
no second component). Defaults are UE `r.Lumen.Reflections.MaxRoughnessToTrace` /
`RoughnessFadeLength`. Omission keeps diffuse-only output. Every gather accepts
`reflections`; the lane is chosen by the gather:

| Gather | Rough (`alpha = 0`) | Traced (`alpha > 0`) | Smooth |
|:--|:--|:--|:--|
| `'exact'` | Cosine lobe through the exact transport | GGX lobe through the exact transport | SSR first, exact transport fills misses |
| `'irradiance-field'` / `'screen-probe'` | Radiance cache cosine lobe at the dominant direction (`E/π`, the same quantity the exact rough lobe estimates) | One GGX lobe sample per pixel and frame (`frameIndex`-seeded) through the Global SDF to lit Card radiance; misses/region exits read `environment`, backfaces/unmapped hits/step exhaustion read the cache at `radianceCacheConeAngle(r)` | SSR first, the traced field value fills misses; no exact transport |

`alpha = saturate((maxRoughnessToTrace - r) / roughnessFadeLength)` blends the two
columns, so each pixel's signal is `(1 - alpha)·rough + alpha·traced` once. The field
lanes add passes `irradiance-field.reflection-generate` (`generateFieldReflections`),
`.reflection-trace` (`traceReflections`) and `.reflection-composite`
(`fs_ray_reflection_field`), with the denoiser passes `.reflection-temporal`
(`accumulateFieldReflections`) and `.reflection-denoise` (`filterFieldReflections`)
between trace and composite. The composite reads the denoised signal and writes the
same `L × response` into scene color and the SSR fallback, as below.

| Denoiser stage | Contract |
|:--|:--|
| Hit distance | `traceReflections` returns the ray's hit distance in the ray record (`fallback.w`: > 0 hit, -1 miss/region exit, 0 unresolved) |
| Reprojection | Traced lobe (UE hit-distance reprojection): the virtual point `position + viewRay · d` with `d` the closest hit in the 3x3 neighborhood (UE ClosestHitDistance; a lone 1 spp miss beside a reflected object would otherwise reproject at infinity onto its stale image), or the view direction at infinity when the neighborhood only misses, through `temporalPreviousViewProj`. Rough lobe: the G-buffer motion vector. The two uvs blend by `alpha` |
| History rejection | Bilinear taps are admitted only on the same reflector: plane distance below `max(1e-3, 0.02 · viewDistance)`, normal dot > 0.9, roughness within 0.1. Rejected or off-screen pixels restart at 1 frame |
| Variance clamp | Admitted history is clamped to the current 3x3 `mean ± 1.5σ` |
| Accumulation | Running mean, at most 8 frames; near-mirror receivers (`r < 0.15`, smooth step from 0.05) keep the raw ray, as the exact lane does. The history limit and the spatial filter are scaled by `alpha`, so only the traced share is denoised and the deterministic rough column passes through unfiltered |
| Spatial filter | Edge-stopping tent on the same reflector test: 3x3, widened to 5x5 while history is younger than 4 frames |
| Memory | 48 B ray record + 16 B signal + 2 × 48 B history (ping-pong: radiance + age, normal + roughness, position + valid) + 16 B denoised = 176 B per pixel |

Moving reflectors and moving reflected objects reproject only through the static
virtual point; the clamp bounds the resulting lag.

Dawn/lavapipe evidence at 32×32 with `{ maxRoughnessToTrace: 0.4, roughnessFadeLength:
0.1 }`, IBL off (`packages/runtime/src/__tests__/renderer-radiance-cache.dawn.test.ts`,
`artifacts/radiance-cache/dawn/result.json`):

| Check | Result |
|:--|:--|
| Furnace, `environment` 0.5, metal r = 0.7 | GI without `reflections` adds exactly 0; field center 0.485 vs exact 0.500 (single-scatter GGX would be 0.349), no block above `L` |
| Metal wall facing a 4-intensity emissive slab, mean relative 8×8-block error vs exact (48 frames) | rough r = 0.7 cache 0.075 (gate 0.25); glossy r = 0.3 trace 0.246 after the test's 16-frame settle (gate 0.35) |
| Screen Probes vs irradiance field directional reflections | identical denoised radiance (gate 0.02); broad multiple scattering follows each gather's diffuse signal |
| Emitter moved behind the 0.25 m wall, probes behind it lit (max 4.0) | worst front block 0 for both roughnesses (gate 0.02 × visible mean) |
| RHI Debug | replayed `fs_ray_reflection_field` equals the captured frame bytes; scene equals the broad term plus directional fallback within 0.002; omitting both composites reproduces the unreflected frame |
| Historical GPU time (median, 16 frames, before separating GI multiple scattering) | generate 253 µs, trace 150 µs, composite 161 µs (exact lane `ray-reflection.*` ≈ 2.0 ms); not a measurement of the updated diffuse composite |
| Denoiser (`renderer-reflection-denoise.dawn.test.ts`, `artifacts/radiance-cache/denoise/result.json`) | per-pixel temporal stddev of the glossy traced lane over 16 static frames 1.103 raw vs 0.102 denoised (10.9x; means 1.328 / 1.294); a 1 m camera move gives a first-frame error of 0.107 against the converged view vs 0.440 for blending stale history without reprojection (9 restarted, 1015 reused pixels) |
| RHI Debug (denoiser) | replayed `.reflection-denoise` output equals the captured bytes, history age 8; replay timePasses (single sample, lavapipe) temporal 293 µs, denoise 1157 µs, trace 804 µs |
| Memory | probe block 1,179,648 B for 512 probes (was 524,288); reflection 176 B/px with the denoiser (64 B/px without) |

`update-probes` also derives the irradiance level and the prefilter (`deriveProbes`). With
8-thread workgroups owning 8 texels each, the pass costs a median 4.6 ms vs 28.0 ms for the
previous 64-thread splat + 64x64 convolution kernel (lavapipe, 512 probes per frame, 5
interleaved runs per arm on a shared host; the pre-derivation kernel was 6.5 ms; no hardware
measurement). The exact solid-angle convolution is kept: an order-2 SH projection was equally
fast but raised the rough block error from 0.113 to 0.139.

| Boundary | Contract |
|:--|:--|
| Rays | One dedicated ray per internal texel. With `alpha = saturate((maxRoughnessToTrace - r) / roughnessFadeLength)` it samples the GGX-reflected lobe, otherwise a cosine lobe around the dominant specular direction (rough fallback). Up to 4 attempts stay above the geometric hemisphere. |
| Transport | A second ordinary exact path transport (seed `seed ^ 0x9e3779b9`) traces the world scene, so off-screen and occluded emitters are resolved; there is no screen-space or probe interpolation leak. |
| Denoise | `diffuseGi.reconstruction` also reconstructs the reflection signal (`ray-reflection.temporal/spatial`, separate history). Near-mirror receivers (`r < 0.15`, smooth step from 0.05) keep the raw dedicated ray. |
| Composite | `ray-reflection.composite` adds directional single scattering times world radiance; the diffuse composite independently adds multiple scattering times cosine-weighted GI and removes the corresponding diffuse energy. Both share Deferred's DFG response and material AO. IBL stays disabled under GI, so no IBL specular is counted twice. |
| SSR | The same value is written to `reflection-fallback-linear-hdr`. SSR composition then replaces it by confidence (`c·ssr + (1-c)·world`), so a hit is used first and a miss keeps the world specular exactly once. Deferred SSR keeps the GPU-driven G-buffer lane, since only the lighting pass writes the fallback, and its scene-input admission accepts any opaque deferred-pass row (including cooked Standard programs, which exact GI requires). Forward SSR still requires the built-in Standard MRT program. |
| Diagnostics | `renderer.inspect().diffuseGi.reflectionReconstruction`; passes `ray-reflection.generate`, `ray-reflection.transport.*`, `ray-reflection.composite`; RHI Debug entry points `fs_ray_reflection` / `fs_ray_reflection_reconstructed`. |

Limits (exact gather): full internal resolution at 1 spp; the second transport duplicates the
frozen BVH/material buffers; temporal reprojection uses surface motion, not hit
parallax. Limits (field gathers): the traced lane is 1 spp; its denoiser trades
up to 8 frames of lag on moving reflectors for the noise drop above, and
near-mirror receivers stay raw; the cache resolves direction
only to its 8x8 octahedral texel per 1 m-class probe, so rough reflections of small
emitters are blurred; Card radiance is diffuse-only, so glossy-in-glossy
interreflection is missing.

### World traversal seam (Global SDF or hardware Ray Query)

The world-trace kernels (`irradiance-field.trace-probes`, the lite reflection trace
`.trace-reflections`, and the screen-probe `trace-world` pass) compose one traversal
module from `worldTraversalWgsl(traversal)` (`raytracing/world-traversal.ts`) and never
branch on the backend. Both kinds define the same WGSL seam in group-0 slots 0..4:
`traceWorld(ray, maxSteps, minStepFactor) -> Hit` (Global SDF `Hit` layout and
`GlobalSdfQueryStatus` codes) and `worldHitCandidates(hit) -> Candidates`; hit shading
is always `worldCardRadiance` (Card radiance only). `WORLD_TRAVERSAL_ROSTER` names the
slots each kind binds. Irradiance Field and Screen Probe world rays point-sample the lookup: they read only
the nearest supported texel, not the bilinear blend. A Card captures one instance, so a
bilinear footprint at a wall foot can straddle the wall and blend a sunlit texel behind it
into a shadowed hit; exact ray-query hits at the foot turned that into a measurable leak
(leak-scene excess 0.0025 -> -0.0004 against the 7-bounce reference). Probes integrate many
rotated rays over time, so the per-hit filter adds no quality there. Direct ray lookup and reflection, which view the hit directly, keep the bilinear filter.

| `WorldTraversal` | Slots | Hit |
|:--|:--|:--|
| `'global-sdf'` | voxels, grid, instances, fields, bounds | Sphere-traced Global SDF; instances associated by distance (approximate) |
| `'ray-query'` | `tlas`, `traversalInstances`, `faceNormals` | Exact committed triangle; its instance is the only Card candidate; complete coverage reports `miss` or `hit`; pending geometry reports `missingField` |

`'ray-query'` requires `caps.rayQuery.supported`: `createIrradianceFieldKernel` /
`createScreenProbeWorldKernel` and `createWorldAcceleration` return
`feature-not-enabled` otherwise (capability absence is data). `createWorldAcceleration(device,
{ maxInstances, maxTriangles, maxBlasBuildsPerFrame })` owns the TLAS, one BLAS per
`geometryId` built once (at most `maxBlasBuildsPerFrame` per `update`; instances of
pending geometry stay out of the TLAS and are counted in `pending`), the object-space
per-triangle `faceNormals` table, and rebuilds the TLAS only when the instance roster or a
transform changes (wgpu 30 has no true refit).

The fourth `faceNormals` word marks triangles that have exactly coincident
opposite windings in the same geometry. Their geometric coverage is two-sided;
the world-space normal faces the incoming ray independently of which tied
triangle the backend commits. This keeps triangle and AS identities intact and
uses no extra GPU table. Ordinary one-sided backs, same-winding duplicates,
degenerate triangles and any nonzero plane separation retain their original
normal semantics. No epsilon welding or global backface flip applies.

Lane selection is automatic and has no user knob. When a field generation is built, the
renderer derives one BLAS geometry per projected `geometryId` (static float32 triangle
meshes) and selects `'ray-query'` iff `caps.rayQuery.supported` and the scene fits
`maxTlasInstanceCount` / `maxBlasPrimitiveCount`; otherwise `'global-sdf'` with a closed
`traversalFallback` (`backend-has-no-ray-query`, `adapter-lacks-feature` or
`scene-exceeds-ray-query-limits`). The irradiance field then owns that generation's
`createWorldAcceleration`, sized from the projection plus the field's edit headroom
(TLAS instances up to the Global SDF row capacity, clamped to `maxTlasInstanceCount`;
`WORLD_ACCELERATION_TRIANGLE_HEADROOM` spare `faceNormals` rows). Its graph imports the TLAS
(`irradiance-field.world.tlas`) plus the `traversal-instances` / `face-normals` tables and
adds the copy pass `irradiance-field.world-acceleration` (an
`acceleration-structure-build`), so every trace (`card-surface`, `trace-probes`,
`trace-reflections`, screen-probe `trace-world`) orders after it. The pass builds at most
`WORLD_ACCELERATION_BLAS_BUILDS_PER_FRAME` (4) BLASes per frame and stops (`executeIf`)
once a physically submitted update left nothing pending. An encoded update whose submit
failed recreates the acceleration and retires the old one after in-flight work.
The owner recovers during frame-import resolution, before the Graph freezes the
TLAS and traversal-table handles; recovery during pass encoding is too late.
Screen-probe world kernels follow the field's traversal.

Row 0 of `traversalInstances` carries the encoded roster's pending instance count;
TLAS custom indices address instance rows starting at 1. Incomplete coverage
rejects both hit and miss estimates. The Graph's `world-coverage` copy derives
`IrradianceField.levels.z` from that same row before any field sample, so retained
bright probes cannot replace absent geometry. No extra binding or CPU coverage
ledger is added. Screen Probe rays keep an explicit `incomplete` status distinct
from cache fallback: any such required ray rejects the texel rather than
normalizing the successful subset. Scratch support carries missing geometry as
`-1` through directional filtering, convolution and spatial integration; this
rejects even an otherwise valid retained-cache fallback. Missing radiance remains
`0`, and complete transport (including resolved black) remains `1`. Without
complete probe or field support, pixel history is cleared. The real-native `world-acceleration-support` gate
checks budgeted cold builds, moves, additions, removal and failed-submit recovery
through the production Graph and traversal seam. Its real-GPU FALSIFY removes
only the coverage guard and must expose partial-world hits/misses on the same
scene. This coverage gate does not
prove receiver-to-probe segment visibility or close the native wall-leak gate.

Scene edits apply in place on both lanes (same generation, same Card capture schedule,
dirty SDF box and probe sweep; see Dynamic content). On the Ray Query lane the field also
hands each applied edit to `PreparedWorldAcceleration.edit({ moved, removed, added })`: a
move or removal replaces the roster and rebuilds only the TLAS, reusing every BLAS; an add
builds a BLAS only for a mesh not yet resident (BLASes are cached by mesh identity for the
generation, also across removals) and rebuilds the TLAS; a material-only change does no
acceleration work. An edit past the instance/triangle headroom or `maxBlasPrimitiveCount`
returns `ray-reference-limit` and the field rebuilds.

`inspect().diffuseGi` reports `traversal`, `traversalFallback`, and on the Ray Query lane
`acceleration: { instances, geometries, pending, settled, blasBuilt, tlasBuilt, bytesBuilt }`
(Screen Probe GI nests it under `diffuseGi.field`). The build counters accumulate over the
generation and count only physically submitted builds; `bytesBuilt` is build input bytes
(positions + uint32 indices per BLAS, 64 B per TLAS instance), not driver AS memory, which
wgpu 30 does not expose. Card light visibility (`irradiance-field.card-surface`) traces the
same `traceWorld` seam.

Status: browser and Dawn devices report `backend-has-no-ray-query`, so they always run
`'global-sdf'`. The Ray Query lane is exercised structurally on RhiNull
(`world-acceleration-lane.unit.test.ts`: selection, budget/settle, failed-submit
recovery, graph ordering) and on GPU natively: `packages/rhi-wgpu-native` runs the
generated kernels, including `card-surface` (fixtures kept in sync by
`world-traversal.unit.test.ts`; regenerate with
`FORGEAX_UPDATE_WORLD_TRAVERSAL_FIXTURES=1`), against a CPU oracle and the Global SDF on
Lavapipe Vulkan. Under `FORGEAX_WEBGPU_NODE=wgpu-native` the irradiance-field Dawn tests
(`renderer-irradiance-field{,-edit,-add,-residency}.dawn.test.ts`) select `'ray-query'` and assert
the in-place edit counters and Card residency streaming, including a bit-exact RHI Debug replay of the move frame
(its TLAS build in-frame, the reused BLASes as bootstrap builds);
`renderer-gi-coverage.dawn.test.ts` holds the in-place material edit (same generation,
one rematerialized instance, Card-only recapture) on the same lane. Remaining gaps: on the Ray Query lane the Global SDF compose still runs
(Cards and fallback queries consume it); Ray Query reports only `miss`/`hit` (a
backface start is a hit); wgpu 30 implements neither TLAS nor BLAS refit
(`PreferUpdate` rebuilds) and uploads TLAS instances from the CPU on every build, so a
move costs one full TLAS build of the roster; the exact `RayDiffuse` lane is not routed through the seam.

## Bounded SDF queries and unlit material cards

The opt-in `render/internal` snapshot APIs are `createSdfQuery`,
`createSurfaceCapture` and `createSdfCardLookup`. They own RHI buffers/textures and
consume cooked geometry/material programs. Ordinary Renderer allocation and
frame execution are unchanged; this is not retained-scene GI integration.

| Contract | Current snapshot behavior |
|:--|:--|
| SDF query | Up to 64 affine instances, 16 MiB of shared local samples and 1–1,024 steps. Non-unit rays and mirrored/nonuniform transforms preserve ray t. Error-aware stepping returns an approximate surface band, proven miss, inside start, exhausted budget or missing field separately. Only the surface-band state has a normal; other states store zero. Explicit two-sided fields admit zero-thickness bounds, return no inside-start state, and derive a gradient facing the approached side. Their band is an unsigned-distance approximation, not opacity or thickness. |
| Card capture | Consumes a checked offline `MeshCardLayout` per whole-mesh source, independent of SDF availability. Its contiguous `sections` cover all indexed triangles and supply their material/texture bindings. Every section draws into each shared card viewport/depth; material slots do not own separate card instances. Up to 1,024 sources, 1,024 sections per source, 4,096 cards and 65,536 section/card draws, 8–512 pixels per card (default 16), 256 MiB total resource budget. Resolution is explicit and uniform; attachment overflow rejects before texture allocation and owned buffers are admitted against the remaining byte budget. This is bounded capture, not adaptive residency. Rasterizes the actual indexed mesh through the same canonical Standard Surface and material bindings as ray-hit. Requires four renderable rgba16float targets. |
| Atlas | Flattened card order is the entry/projection order; columns are `ceil(sqrt(cardCount))`. Padding stays invalid. Local card bounds enclose sampled occupied depth cells with half-cell near/far margins; no fixed six-view indexing. |
| Planes | Albedo/roughness, oct-encoded shading and geometric normals, emission/metallic, F0/validity; depth uses the existing depth32float attachment. They contain unlit properties, never cached irradiance or final diffuse lighting. |
| Coverage | `cards` retain geometry-backed material texels through MASK holes; `view` applies authored cutout. F0/validity 1 means valid material data, 2 remains invalid material, and clear 0 means no geometry. Cache sampling does not prove opacity, visibility or correct thin-surface transport. No material values are rewritten. |
| Lookup | Within the best qualifying card, four bilinear texels pass validity, geometric-normal and depth checks independently. Valid weights normalize at f32 precision and stay inside that tile. The result retains their atlas indices and weights; diffuse cache lighting consumes that same support and remains incomplete if any contributing lighting texel is incomplete. Missing inner/concave coverage returns unmapped; changed source/material returns stale. Neither outcome is sky or black lighting. |
| Invalidation | Geometry/transform/material/UV/color/normal/tangent keys are frozen per batch. Textured captures additionally require a producer `textureContentKey`; changing borrowed texture bytes requires a new revision and capture. Material IDs are absent from SDF geometry/pose identity: the SDF hit carries instance/geometry, with its fourth state word reserved as `0xffffffff`. Capture keys additionally include ordered section ranges, material programs/values and texture revisions. Local SDFs survive rigid motion; world-space cards do not. |
| Lifetime | Caller keeps inputs stable during preparation, submits/completes work, disposes dependents before their query/card sources and retains borrowed textures until completion. Dispose is idempotent; partial preparation releases allocations. |

Card capture admits the existing opaque/MASK Standard subset with distinct geometric and
shading normals, normal maps, UV0–7 and vertex color. Normal maps require valid
authored vertex normals and xyzw tangents; missing frames are refused. It rejects absent required UVs, mismatched contexts,
custom/view-dependent surfaces and front-face culling. The cooked per-triangle sidedness digest
must match all section material back/none culling; a changed policy requires recooking.
Multiple depth layers cover enclosed room interiors, while sampled coverage and
card budgets can still leave holes. No global SDF/clipmap, streaming,
screen tracing, denoising or production GI is claimed by the capture API. The M4 experiment below adds surface lighting.
See [reproduction and layouts](../../scripts/raytracing/README.md#sdf-and-material-cards).

### Sampled-visibility query policy

`createSdfQuery` also accepts Geometry's explicit sampled-visibility fields.
A `visibilityHit` has status 5 and `metrics.y = 0`: it supplies no geometric
proximity bound. `metrics.w = 1` marks a negative first sample at the original
ray start; this is a sign heuristic, not a proved inside-solid state.
Geometric fields retain their `surfaceBand`/`insideStart` semantics. Missing
fields and exhausted steps remain distinct incomplete outcomes.

At upload, sampled-visibility values are rounded to signed 16-bit normalized
codes across their `distanceBand`, with exact zero. A 4³ brick table addresses
32-word payloads; identical payloads share storage after a complete code comparison,
including hash collisions. Every brick uses the same decode path. Edge padding
repeats the last valid sample without changing the lattice or interpolation weights.
Geometric fields retain
their exact f32 bits in the same pool. Shared fields are stored once, and the
16 MiB query limit counts the actual packed bytes. CPU samples retain exact f32
precision within the combined 32 MiB brick-table/payload storage budget.
The CPU producer now supplies a shared f32 brick table directly. Upload quantizes
each referenced payload and deduplicates equal SNORM16 blocks without rebuilding
a dense volume. Geometric fields project their exact f32 samples into the existing
linear GPU layout. The same-lattice GPU byte format and both shader decoders remain
unchanged; the new artifact version requires a producer rebuild.

The added scalar quantization error is at most `distanceBand / (2 * 32767)`, plus GPU
arithmetic roundoff. It is not a bound on first-hit position or normal: a small
sample change can alter traversal. RHI capture retains the encoded pool and each
instance's decode band; offline composition inspection evaluates those captured
samples. Negative starts, thin geometry and SDF/Card correspondence still need
their separate quality checks.

Its fifth argument is `SdfQueryOptions`: `maxSteps` defaults to 128 and
`visibilityExpansion` defaults to `'clearance'`. `'clearance'` grows expansion
from the maximum sampled distance to geometry; `'ray-distance'` grows it from
distance traveled since the supplied ray origin, including `tMin`. Ray length
and the instance inverse transform convert this distance into field units.
The diffuse shader selects ray distance; standalone queries choose explicitly
when they require that more conservative occlusion policy. It can preserve a
near thin blocker while increasing grazing or neighboring occlusion. It neither
repairs negative receiver starts nor qualifies sampled fields for GI.

The isotropic-lattice consumer uses this caller-owned surface expansion, a positive
minimum step, hit pullback and half-voxel normal differences. Its maximum
expansion is the voxel half-diagonal; applying UE's sparse-layout default
alone missed a sheet midway between samples in a captured GPU regression.
This explicit difference requires measured extra-occlusion and hit-position
errors. It is not numerical parity with UE's sparse representation.

Card lookup accepts these approximate hits through existing image/depth
checks. Points inside a card projection bypass edge-distance arithmetic, keeping
zero-allowance hits valid; outside points retain the geometric allowance test.
Material validity, geometric orientation and depth still gate every mapping. The bounded diffuse GI experiment currently refuses sampled-visibility
fields; the visibility query and composition do not qualify GI transport or
ordinary Renderer publication. They retain the existing RHI capture, bindings
and fresh-device replay surfaces.

## Bounded world distance-field composition

`render/internal.createGlobalSdfComposition` composes admitted mesh fields into
one frozen world grid. It preserves the existing 64-instance query/transport
limits; this separate composition accepts up to 1,024 instances and 16 MiB of
shared local samples. Each grid axis has 1–128 sample centers with a positive
uniform spacing and distinct finite f32 positions. It does not publish to the
Renderer or trace rays.

| Contract | Behavior |
|:--|:--|
| Coordinates | Orthogonal affine axes, including nonuniform and mirrored scale. Shear is refused. Distance uses the minimum axis scale; outside-box distance extends the clamped sample, and the box bounds negative distance. |
| Coverage | Separate from minimum distance: only two-sided influences within `coverageDistance` yield 0; any one-sided influence yields 1. This is coarse geometry coverage, not material opacity. |
| Missing source | A missing field, including a flat bound, marks every sample within its `maxDistance` influence as `missingField`. The known distance remains diagnostic and cannot imply usable visibility. Mask 0 removes an input; other masks are included without per-ray filtering. |
| Output | Binding 4, 16 bytes per voxel: f32 distance, f32 coverage, u32 status (`unwritten=0`, `complete=1`, `missingField=2`), u32 nearest known instance (`0xffffffff` when absent). X is contiguous. The nearest ID is diagnostic, not a Card/material association. |
| Lifetime | Input buffers, grid and source keys are copied before asynchronous compilation. The caller submits/completes work and disposes the five owned buffers. A partial expected preparation failure releases them. |

For caller-owned GPU resources, `render/internal.createGlobalSdfCompositionRecorder`
records `GLOBAL_SDF_COMPOSE_WGSL` into a borrowed compute pass. The reference helper
uses the same recorder and kernel. Exact buffer ranges carry the existing packed
instance/sample/grid ABI and a distinct voxel output; the recorder checks byte
alignment, aliases and device limits but cannot validate GPU-written contents.
The caller owns packing, initialization, dependencies, submission and retirement.
It opens no pass, uploads no data and publishes no Renderer state.

Sampled-visibility fields use their trace bounds and mostly-two-sided hint for
composition. The distance and coverage arithmetic follows UE's mesh-to-global composition;
this bounded version has no clipmap, sparse page/mip storage, quantization,
residency, dirty-region scheduler, page object grid or GI consumer. `complete`
means input availability for composition, not exact distance/opacity or a
qualified ray hit. See [reproduction and inspection](../../scripts/raytracing/README.md#world-distance-field-composition).

### Querying the composed region

`render/internal.createGlobalSdfQuery(device, compile, composition, rays, options)`
borrows that composition's voxel/grid buffers. Record composition before query,
complete submission, then dispose the query before the composition. The query
owns only its ray, hit and settings buffers; inputs are packed before asynchronous
compilation. It accepts 1–65,536 ordinary `ReferenceRay`s, masks 255 (the whole
composed union) or 0, and `maxSteps` in 1–1,024 (default 256).
`minStepFactor` selects a fraction in `(0, 1]` of half spacing (default 1).
Its world advance must remain normal f32. Reducing it samples narrow field
minima more densely; it does not improve the stored representation or guarantee
exact geometry hits. The same step budget and incomplete states still apply.

For GPU-generated rays, `render/internal.createGlobalSdfQueryRecorder(device, module)`
records the same `GLOBAL_SDF_QUERY_WGSL` into a caller-owned compute pass using exact
borrowed buffer ranges. The CPU factory delegates to this recorder. It checks range,
alignment, output alias and device limits; `record` may return an RHI error. The caller
owns initialization, ordering, submission and retirement; the recorder owns no buffers.

> [!IMPORTANT]
> The GPU producer must obey the [ray/grid/settings byte contract](src/raytracing/global-sdf-query.ts)
> and run before query. Validating CPU placeholder rays cannot validate later GPU writes.
> This seam does not yet connect ordinary Renderer placement, field validity or GI lighting.

The grid needs 4–128 centers per axis. One stored-sample border is reserved for
normal differences. The query refuses nonfinite f32 endpoints and zero/subnormal
direction lengths. A start outside the remaining region is immediately incomplete;
the query does not skip that unrepresented prefix. Leaving it before `tMax` is
also incomplete. Full requested intervals can return an **approximate** miss.

| Result | Meaning |
|:--|:--|
| `miss` | Disabled ray, or no sampled hit within the fully covered interval. No exact geometry/opacity guarantee. |
| `hit` | Approximate expanded surface; position and gradient normal, without triangle, instance or Card identity. A zero gradient yields a zero normal. |
| `negativeStart` | Negative first signed sample; neither proof of solid interior nor valid lighting. |
| `stepBudget` | Step limit or numerical stagnation prevented completion. |
| `missingField` | A contributing interpolation or normal sample is unavailable; the original voxel status is retained. |
| `outsideRegion` | The requested interval includes space outside this frozen region. Never an environment-light result. |

With half spacing `h`, clearance expansion is
`h * clamp(maxSampledDistance / (2*h), 0, 1)` and minimum world advance is
`h * minStepFactor`. Expansion and normal sampling still use `h`; the factor
changes only minimum advance. A different sample history can change expansion.
Non-unit directions preserve ray t. Every positive-weight trilinear contributor
must be available; normal differences use six half-spacing offsets and follow
the same rule. This is the bounded Global SDF part of the IF route, without
clipmaps, probe relocation, material evaluation, surface-cache lighting or Renderer
integration.

RHI Debug captures ordinary composition/query dispatches and their shared buffers.
Query binding 3 has a 64-byte result: u32x4 status/unavailable-voxel-status/steps/reserved,
f32x4 t/expansion/first-distance/coarse-coverage, f32x4 position and f32x4 normal.
`GlobalSdfQueryStatus` and `GLOBAL_SDF_HIT_STRIDE` define the internal layout.
The shared Dawn/Browser regression checks unwritten, missing and empty fields,
non-unit/boundary rays, interpolation/normal dependencies, zero-before outputs
and byte-exact fresh-device replay.

### Near-field traversal and Global continuation

`render/internal.createSoftwareSdfQuery(device, compile, composition, sources, rays,
{ detailDistance, detail?, global? })` records local mesh traversal, a GPU continuation
pass, then Global traversal. It borrows the composition and owns its two query stages;
record composition first, record the combined query, and retire the query before the
composition after submission. Its `detail` and `global` members expose the existing
buffers/results for inspection and downstream sampling, not separate lifecycle owners.

The entire frozen source roster must match the composition, including fields, pose,
mask and identity; omitted or changed sources reject. The existing detail limit is
64 sources. This initial complete-roster path does not claim culled candidate lists,
clipmaps, residency, or a new public Renderer GI mode.

`detailDistance` is positive finite normal f32 world distance after each original
`tMin`. The detail endpoint is rounded to f32 and clamped to the original `tMax`;
a distance too small to advance rejects. Origins, directions and full endpoints are
unchanged. No implicit normal offset or minimum distance skips a near segment.

| Detail outcome | Global behavior |
|:--|:--|
| Executed approximate miss, enabled ray, remaining interval | Resume at the exact detail endpoint; retain the full original `tMax`. |
| Hit, inside start, sampled negative-start heuristic, exhausted budget or missing field | Keep the detail result and disable Global work for that ray. |
| Disabled ray or detail covers the complete interval | No Global work; retain the original detail outcome. |
| Unwritten zero-filled result | No continuation: a real miss also carries the producer's sentinel identity. |

The Global ray buffer's mask identifies which result is applicable. A masked Global
`miss` is **not** a final scene miss. Detail results retain their geometric/sample
policy and inside-start metadata; a continuation miss is still approximate, not
proof of exact geometry or opacity clearance. This path does not qualify Card
correspondence, lighting, or near-surface self-intersection handling.

The continuation pass adds no buffer or result format: bindings 0/1 read detail
rays/hits, binding 2 writes the existing Global ray buffer. Repeated recording restores
the same intervals from immutable detail inputs while preserving full Global endpoints.
RHI Debug verifies these shared resources and can independently disable detail,
continuation or composition work. The formal inspector is documented in the
[raytracing guide](../../scripts/raytracing/README.md#near-field-and-global-continuation).

### Associating Global hits with captured Cards

`render/internal.createGlobalSdfCardLookup` takes the exact composition/query pair,
an offline Card capture and frozen expected material sources. It records two
ordinary compute passes and borrows those owners until submission completes.
Geometry/pose keys match the Card capture independently of SDF resolution.

| Stage | Contract |
|:--|:--|
| Candidate selection | Query the bounded object roster at hit position plus normal times half the global spacing. Admit local-field distances within three half-spacings, ordered by signed distance then instance ID. Retain four; record the full admitted count. No diagnostic voxel ID becomes material identity. |
| Refusal | Non-hit query states retain their original status. Missing local fields within the search influence, candidate overflow and zero normal are explicit flags; any flag prevents all material samples for that ray. |
| Card sampling | Four independent `CARD_LOOKUP_STRIDE` entries per ray use the original hit position, the shared material/depth/normal sampler and three half-spacings of projection margin. Each candidate can be mapped, unmapped or stale. Unused slots are unmapped for hits, notSurface otherwise. |
| Debug output | Binding 5 is 32 bytes per ray: retained count, refusal flags, original query status, admitted count, then four instance IDs. Binding 7 contains four 112-byte Card samples including selected Card, texels and normalized weights. Both outputs start at zero and replay on a fresh device. |

The search/projection margin is association support, **not geometric accuracy**.
This stage does not choose or blend a final material, invent a fallback across
stale candidates, or supply Surface Cache lighting. It scans at most the existing
1,024-object roster; it is not UE's spatial object grid or a production clipmap.
The caller must inspect every candidate/refusal before any future lighting resolve.

## Raster-driven probe placement

`render/internal.createRasterProbePlacement` records a perspective-camera
placement dispatch from borrowed native Standard depth, packed shading normals,
visible identities, exact row range and the matching View buffer range. The
caller must qualify the rows as lit Standard surfaces; coverage identity is not
a generic material eligibility test. No ordinary Renderer profile installs this
primitive yet.

Each identified probe supplies a base position, cell size and selected-for-update
flag. One 64-lane group samples a 16-pixel neighborhood, rejects invalid rows and
out-of-range candidates, then averages individually quantized offsets. The
viewport is explicit and can occupy a subrectangle of the attachments.

| Buffer | Ownership and result |
|:--|:--|
| Accepted offsets | Borrowed read-only state. The primitive never modifies it. The caller initializes or resets identities and offsets. |
| Candidate offsets | Separate borrowed output. Successful placement replaces the offset relative to the base; absent samples or rejected inputs copy the accepted bytes. |
| Diagnostics | One 16-byte record per probe retains identity, outcome and sample count. Inspect rejected outcomes before publishing a candidate. This is placement evidence, not field or lighting validity. |

The caller records graph dependencies, submits work, and publishes candidates
only after its submission transaction succeeds. Discarding recorded work leaves
accepted state unchanged. Field availability, destination revalidation, new
probe rays, persistent scene residency and GI gathering remain separate owners.
Source layouts and the closed diagnostic values are documented alongside
`RasterProbePlacementInputs`; the actual GPU tests cover raster attachment
lineage, nonzero View offsets, exact row bounds and fresh-device replay.

## Bounded diffuse GI experiment

`render/internal.createDiffuseGi` explicitly allocates one frozen GI generation;
ordinary Renderer construction does not install it. It rasterizes real primary
geometry through shared Standard Surface, seeds analytic/emissive surface lighting,
optionally applies 0–2 finite feedback iterations, traces world probes through the
shared mesh SDF, and writes IF and per-pixel cosine-gather outputs. Caller owns
record/submit/completion and destroys the batch only after its final GPU use.

| Signal | Contract |
|:--|:--|
| Surface lighting | Outgoing linear radiance; a hit never multiplies reflectance again. A bounded quadrature of the shared BSDF supplies the transport proxy, including metals. |
| Gather | Unit-reflectance `D=E/pi`; constant incident radiance remains constant. Visible Standard applies `Rd` once and excludes its analytic direct connection and own emission from D. |
| IF support | Fixed 2–4 probes per axis; cosine convolution, directional depth moments and strict local SDF segment rejection. Unavailable support falls back to local cosine tracing. Unresolved SDF/card/material data remains incomplete. |
| Outputs | Raw direct, D, receiver response, beauty and closed status per pixel; surface generation, directional probe distances and status remain inspectable. |
| Updates | New geometry/material/texture-key/light/view inputs require a new frozen generation. No temporal reuse, incremental scheduler, default-frame allocation or compiler enters the runtime. |

The initial limit is eight closed instances, 8–32 card pixels per side, an
8–512 square orthographic or perspective view, 16–256 directional samples and four analytic
lights. `diagnostics.bytes` counts owned buffers and textures, including capture
and double lighting buffers; borrowed textures and driver/pipeline storage are excluded.
The scene-derived SDF bias and trace interval are reported. Thin/contact geometry
and enclosed feedback can remain incomplete and require representation work.

This is an IF foundation with a per-pixel scene-gather diagnostic, not ordinary
Screen Probe Gather or UE Medium. Screen/HZB reuse, dedicated reflections,
hardware GI dispatch, persistent Renderer/RenderGraph integration and general
production content remain open. See [commands and AOV layouts](../../scripts/raytracing/README.md#diffuse-gi).

`render/internal.createGlobalSdfCardLookupRecorder(device, module)` records the
same `GLOBAL_SDF_CARD_LOOKUP_WGSL` kernels into caller-owned compute passes.
Call `record(pass, inputs, rayCount, 'selectCandidates')` after query, then
`record(pass, inputs, rayCount, 'sampleCards')` after selection and Card capture.
The producer supplies the existing packed ABI, matching texture views and source
validity; it owns dependencies, initialization, submission and retirement. The
recorder opens or ends no pass and allocates, uploads or releases no buffer/view.

`GlobalSdfCardLookupInputs` requires exact ranges for eight buffers. The existing
composition exposes its field pool as an opaque buffer, so `fields.size` alone may
be omitted for native whole-buffer binding; RHI then validates its actual tail
capacity and binding limit. Explicit ranges retain offset/alignment/device-limit
checks. Candidate and sample output allocations must not alias any other binding,
including a field pool with an unknown tail. GPU-written contents remain the
producer's responsibility. Recording preserves native `RhiError` failures; the
reference helper's `record` returns `RayReferenceError | RhiError` and closes its
passes on failure. It delegates both stages to this recorder while retaining its
existing four owned buffers, output bytes and disposal behavior. This seam does
not connect Cards to ordinary Renderer execution or accept GI transport.

### Runnable diffuse GI scene

The [scene lab](../../scripts/raytracing/README.md#runnable-gi-scene) presents
direct-only, GI and independent two-bounce PT under one camera, exposure and
Reinhard/sRGB transform. `createRayDisplay` records the shared display pass over
raw buffers; its target is a same-size `rgba8unorm` attachment. Coverage has its
own view and never changes beauty colors. This opt-in snapshot lab rebuilds a
complete generation for light/material/camera edits; it does not install a
retained Renderer feature or qualify Sponza, hardware tracing or performance.

Perspective capture accepts `{ camera: RayPathCamera, near, far }`; orthographic
cards keep their existing projection. Both capture and reconstruction derive
from one matrix, with per-pixel outgoing direction for perspective shading.
`field.state.y` reports the actual gather: 1 uses probes, 0 traces locally. A
successful local fallback is complete only when its own required data is valid;
failed cache RGB is not mixed in or promoted. This fallback can be expensive.

### Shadow configuration authority

Light components own shadow casting and filtering. `StandardProfile` has no
`shadows` field: the removed field never controlled rendering and is rejected by
`Renderer.setProfile`. Use `DirectionalLight.castShadow` / `SpotLight.castShadow`,
and remove `PointLightShadow` to disable their writers. Directional filtering uses
`DirectionalLight.shadowFilter`; it stays with the same light-owned quality
contract rather than a second profile policy.

## Landscape terrain submission

Render extracts one `Terrain` root and projects its subsection draws per view. Integer LODs share immutable grid vertex bytes with separate index buffers. Continuous screen-size LOD, coarser-neighbor edge morph and packed raw-f32 height atlas mips and seam-aware neighboring height normals use one vertex kernel across Standard color, GBuffer, depth, temporal and CSM writers. Terrain uses the direct scene lane; it does not claim GPU Scene, ray-reference or card support.

Layer Material and Texture changes enter their own renderer records. No reverse Terrain-root, section or instance list participates. Material rows reference stable image IDs; image versions own immutable RGBA8 CPU blocks and native RGBA8 GPU rectangles with repeated borders. Actual selected frame inputs derive four RGBA16F texture arrays at the largest selected source dimensions, with sRGB neighbors decoded before filtering. The fragment path uses four direct bilinear samples. Identical selections share only active arrays; changed selections GPU-copy their previous arrays and rebake changed layers when dimensions match. There is no per-fragment metadata table or CPU atlas mirror. Frame references retain exact inputs and GPU arrays, preserving mixed old/new submissions, eviction replay and recovery. Unchanged selected versions reuse the same frame even when an unrelated image changes. A source pixel edit uploads only changed pixels and affected repeated borders. The per-Terrain 128 MiB budget counts distinct active source bytes, independently of other Terrain roots. GPU preparation uses compute and RGBA16F storage textures; encoded images enter through the existing decoder before preparation and recovery publication.

`querySubmittedTerrainHeight(receipt, {worldId, entity, x, z, view?, expectedAsset?, expectedVersion?})` reconstructs canonical sampled triangles using the bytes, LOD, neighbors and pose retained by that completed submission. It does not promise bit-identical GPU floating point arithmetic. Multiple composed views require a view key; held views retain their actual surface. Eight receipts retain owned CPU height bytes. Pending, failed, unissued, stale-generation or expired receipts fail structurally. `expectedAsset` and `expectedVersion` fence the exact Terrain root and captured source version, so a held old view cannot release a replacement gameplay gate.

A normal Catalog replacement isolates incoherent terrain source extraction until the scene binds a complete candidate. `frame-submit-rejected` carries `accepted:false` only for a failed submission stage; accepted-work and completion errors keep their existing failure behavior. LOD/root changes reject deformation history and mark reactive coverage. See [Terrain](../terrain/README.md).

## 动态几何候选 CPU 容量

`createDynamicGeometryLifecycle(maxCandidates = 32, maxMeshBytes = 64 * 1024 * 1024, options?)` 分别限制独立候选的一次 `acceptCandidates` 批次数、暂存事务数和 mesh 字节。未提供 `options.maxRetainedCandidates` 时，它等于 `maxCandidates`，因此默认仍保留 32 个暂存事务槽位和 64 MiB 字节额度。单次 `prepare` 占一个槽位；`prepareCandidates` 声明的完整组占一个槽位，每项 mesh 字节仍分别计入原有总预算，且只能整组接纳。

`prepared` 与等待取消或退休完成栅栏的终态记录共用暂存额度。接纳后，`accepted` 与 `published` 均属于 World 常驻资源，不占暂存槽位；因此 CPU 裁剪或画面外的网格无需伪造 draw receipt，也不阻止后续爆破准备。常驻项的 mesh 字节、World 共享引用、GPU residency 与已有 fence 仍保留到真实 owner 清理完成；同实体替换会取消旧的未发布候选，离场则由 owner 取消或退休。清理入口不受暂存槽位上限拒绝；若大量常驻项同时进入待释放终态，新的准备须等其完成后再占用空槽。

例如，默认额度允许 33 个已接纳候选与 32 个独立准备候选并存；第 33 个独立准备事务会以 `dynamic-geometry-budget-exceeded` 拒绝，且不改变现有记录。`maxRetainedCandidates: 65` 允许 65 个暂存事务，独立候选的一次接纳仍不得超过 32 项。所有常驻项与暂存项共用 mesh 字节上限，接纳不会释放字节额度。容量配置必须为正安全整数，上限为 4096；完整声明组成员数上限同为 4096，mesh 字节上限为 512 MiB。公开 `validateDynamicGeometryMeshBudget(bytes)` 与生命周期、Renderer 构造共享此字节校验；构建工具可在分配 GPU 资源前验证项目配置。计数或字节拒绝的 `detail.reason` 分别为 `batch-count`、`retained-count` 或 `mesh-bytes`，并携带本次请求、已用额度、上限及等待 fence 的候选数。

候选几何的独占上传副本由上述 mesh 字节预算约束。Source Host 只额外保留资产及依赖的版本凭据，直到候选退休或取消；它不会为每个常驻地形体长期保留整份资产内容快照，也不占用普通 `assets.snapshot` 的 128 个默认槽位。网格写入、依赖替换与释放仍会让旧凭据失效，上传只移动独占副本，原始资产存储不会被转移。

`createRenderer(canvas, { dynamicGeometryMeshBudgetBytes })` 将显式字节额度透传到同一生命周期；省略仍为 64 MiB。`renderer.inspect().dynamicGeometry.maxMeshBytes` 给出实际额度，`meshBytes` 给出包含等待 fence 退休记录在内的已用额度。提高字节额度不改变独立准备的 32 项批次/暂存事务限制、拒绝条件、退休或设备恢复语义，也不保证帧率。完整声明组通过已有 4096 项硬上限约束其成员数。

这些是 CPU 生命周期额度，不表示 GPU 驻留、FrameReceipt 或物理提交已完成。跨 owner 的替换、恢复与资源释放仍由调用方通过实际组合路径验证。

## 普通 MeshAsset / LOD 组合

根网格是 LOD0；`lods` 中每项以受管 Mesh 句柄引用已准备的低模，
`screenCoverage` 是从近到远严格递减的绝对投影高度阈值。各层必须保持顶点布局、
索引模式、子网格数量，以及逐子网格的 `materialSlot` 和 `topology` 一致。
生产者负责生成这些普通 MeshAsset；Renderer 不解释其来源数据或生成策略。

```ts
import type { MeshAsset } from '@forgeax/engine/types';

const lod1Handle = assets.create(lod1).unwrap();
const lod2Handle = assets.create(lod2).unwrap();
const mesh: MeshAsset = {
  ...rootLod0,
  lods: [
    { mesh: lod1Handle, screenCoverage: 0.5 },
    { mesh: lod2Handle, screenCoverage: 0.2 },
  ],
  lodHysteresis: 0.08,
};
```

这里的 `assets` 是已绑定到当前 World 的 AssetRegistry，各层 MeshAsset 由调用方
提供；用 `assets.create(mesh)` 创建根网格句柄。调用方复用已附接 World 的 Renderer、现有 MeshRenderer 材质句柄和普通
MeshFilter 绑定；替换使用上文的动态几何准备、接纳、取消与退休流程。

每个视图通过自己的相机和 `LodViewConstants` 选择层级。同一实体可在不同视图
使用不同层级。低模必须先由该 Renderer 的 AssetRegistry 解析并达到可用状态；
未就绪层级回退到更精细的就绪层级，LOD0 是保底。`Visibility.hidden` 只控制渲染
参与，不释放受管资产句柄或 GPU 驻留。

一次替换若同时生成新低模，应先创建低模句柄，再使根网格候选引用它们。
取消候选后，仅失效它独占且尚未被活动根引用的资产；旧 GUID 在旧根退出且相关
Renderer 帧完成或退休后才可失效。实体的 `revision` 严格递增；`topologyRevision`
不得倒退，子网格或索引拓扑变化时递增。拒绝接纳保留现有 MeshFilter 绑定。

[LOD 样例](../../apps/hello/lod-occlusion/src/main.ts) 使用普通 glTF MeshAsset，
提供双 Camera、低模延迟准入、显隐和新旧 revision 反序到达的控制。
[Browser](../../apps/hello/lod-occlusion/scripts/smoke-browser.mjs) 与
[Dawn](../../apps/hello/lod-occlusion/scripts/smoke-dawn.mjs) 检查同次提交的逐视图
选择及每阶段完成帧；实际通过结果以对应源码版本的报告为准。
[增量输入说明](../../apps/hello/lod-occlusion/LOD-INCREMENTAL-INPUTS.md) 说明普通
Pack producer / Catalog 的准备方式。

## 完成帧的材质绘制观察

`Renderer.observe(issuedReceipt, { include: ['draws'] })` 返回该完成帧的实际直接
材质绘制：World、entity、submesh、已接纳材质 publication、pass/context/program，
以及 RHI capture 中的 pipeline 引用。它从实际 record 回调取证，不从 WGSL 名称
反推材质或用当前 extraction 代替已提交内容。

只有同次提交的完整来源与 capture 才返回 `complete`。未完成 presentation、held
view、失效的 lease/view/graph、缺失来源或 capture、不支持的绘制路径，以及超过
64 项或 16 KiB UTF-8 上限均返回明确的 `unavailable` 原因。当前支持直接材质
raster draw；其他路径不能被部分列表冒充为完整观察。

RHI Null 的记录只证明结构和生命周期；GPU 像素仍需实际后端的捕获与读回。

## Static Standard material switches

> [!IMPORTANT]
> `MaterialAsset.staticSwitches` selects a cooked feature graph. It is not a
> uniform value or a runtime shader branch. Root and child assets may author it;
> children inherit the parent choices and override only the specified keys.
> The root retains pass and pipeline-state authority; switches select feature
> code and resources within that contract. Physical layers require a compatible
> forward root when a child enables them.

```ts
const material = Materials.standard({
  baseColor: [0.8, 0.7, 0.6, 1],
  baseColorTexture: 'authored-map',
  clearcoat: 0.5,
  staticSwitches: { textures: false, clearcoat: false },
});
```

| Choice | Selected compilation |
| --- | --- |
| Optional physical layer omitted or `false` | remove its parameters, maps and evaluation code |
| Optional physical layer `true` | retain eligible authored declarations, including a zero runtime weight |
| Other switch omitted or `true` | retain the feature supported by the effective declarations |
| Other switch `false` | remove that feature's parameters and resource bindings before compilation |

Clearcoat, sheen, anisotropy, iridescence, and diffuse transmission require explicit `true` in `staticSwitches`. Authored
weights alone do not enable them. glTF import emits these choices from the
source extensions; hand-authored material sources must opt in before cooking.

The closed names are exported as `MATERIAL_STATIC_SWITCH_NAMES` from
`@forgeax/engine/types`. They cover textures, normal mapping, displacement,
clearcoat, sheen, anisotropy, iridescence, diffuse transmission, transmission,
subsurface diffusion, alpha clipping, alpha hash, triplanar projection, object-space normals,
and direct multiscattering LUT selection. `textures: false` removes authored
material maps, including their UV records, transforms, sampling and decoding.
Engine lighting resources such as shadows and IBL retain their own contracts.

For a known default Standard Surface, explicitly setting `alphaClipping: false`,
`alphaHash: false`, and `displacement: false` selects position-only shadow
coverage (plus skin inputs for skinned geometry). `alphaClipping: false` removes
`alphaCutoff` from the selected material ABI and gives Standard/temporal coverage
a zero cutoff. The color pass keeps its authored textures and normal mapping.
Shadow LOD, view clipping and local clipping remain active. Custom Surfaces and
explicit shadow overrides retain their own coverage; runtime zero values never
authorize this specialization.

`selectMaterialStaticContract` is the shared graph projection. Raster and ray
cooking consume its selected declarations; the existing schema and layer plan
then derive macros, layouts and program identities. The same selected contract
is published for forward, deferred, shadow and ray consumers. Authored values
remain in the source asset so another child can re-enable a feature. Disabled
maps are omitted from the variant's published texture and sampler references. A custom Surface must guard
any optional parameter access with the corresponding derived feature macro.

Stock Surfaces omit map-dependent scalar/channel fields when their maps are
absent; custom Surfaces retain their declarations. Flat color passes publish
only position/normal inputs (and color/skin inputs when selected). Their
standalone temporal helper omits disabled alpha-hash derivatives.

GPU Scene material selectors carry addresses in 16-byte units. Each selected
schema publishes its own aligned row stride. The allocator aligns each range
to that stride, and compiler lowering converts the address to the typed row.
CPU packing, reflection and the receipt derive the same ABI. Material capacity
grows independently; updates upload only changed 16-byte units. Renderer code
must consume the scene's actual material buffer size rather than multiplying
instance capacity by the canonical maximum row size.

Changing choices requires recooking and publishing the material. Unpublished
static materials fail with `material-specialization-not-cooked`, and a cooked
record that still contains disabled parameters is refused. Program artifacts
remain reusable when two choices produce identical compiled code; the material
contract receipt retains the authored static selection.

## Native GlyphText assets

`GlyphText` retains Font/text/size/color facts in the persistent scene. Font edits replace one shared fixed content root; publication and adoption never enumerate labels. View layout generates immutable geometry only when consumed, with equal Font/text/size reuse and tint-only material projection. No derived Mesh/Material asset identity or World component is created. Font atlas/sampler references remain in the existing asset closure across Workers. Picking consumes the same metric/layout kernel.

Generated layout buffers use the normal GPU residency owner with a bounded current cache and submission-fenced retirement. A previous fixed layout remains renderable after Font adoption or cache eviction. The renderer's internal `generatedMesh` input is mutually exclusive with an authored `assetHandle`; generated geometry never crosses publication as an asset.

Encoded Texture assets retain their Basis/KTX2 source bytes. Texture residency
lazily derives BC7, ASTC, ETC2, BC6H or the native fallback from device capabilities;
material readiness reports pending during initialization/transcode. Immutable
private source captures are selected by scope, handle and content revision, never
by a mutable borrowed object. The derivative cache retains at most 256 sources
and 256 MiB, and actual GPU allocations use the existing submission lifetime.
Old/new versions can be sampled in one submission. Source admission never visits
texture consumers. Recovery prepares only the textures in the previous submitted
draw work before publishing its device generation.
Surface dynamic-input field types and byte footprints have one Types authority.
The derived layout supplies CPU write widths and generated WGSL word loads;
vec3 alignment remains 16 bytes with 12 bytes of values, and u32 stays an integer
load. Page budgets, identities, atomic writes and GPU retirement keep their existing owners.

`MATERIAL_NUMERIC_LAYOUT` supplies numeric material byte size, alignment and WGSL
type for ABI derivation, parameter modules, reflection checks and GPU Scene rows.
The distinct color alias and vec3 payload/alignment rules remain explicit.

Material residency owns texture/sampler enumeration for both ordinary frame
readiness and device recovery. Reading a material resource list never imports
recovery construction or frame recording. These queries retain the texture
missing sentinel and sampler-zero semantics independently.

### Three r184 post-processing comparison

The [same-input browser comparison](../../apps/parity/color-lighting/README.md#render-defaults-comparison)
runs production FXAA/Bloom shaders against the pinned Three WebGPU nodes. FXAA
uses linear RGB luma `(0.3, 0.59, 0.11)`, thresholds `0.0312` / `0.063`, six
search steps and subpixel blend `1`; each existing graph still owns its color domain.

Bloom remains opt-in, with threshold `1`, soft knee `0.5`, scatter `0.7` and
intensity `1`. Its extraction subtracts the threshold and its tent pyramid is
normalized. Three WebGPU uses smoothstep extraction over `threshold..threshold+0.01`,
separable Gaussian kernels and five weighted mip contributions. At threshold `0`,
strength `1`, radius `0`, the r184 truncated kernels yield uniform gain about
`2.936`; ForgeaX yields `1`. Neither `scatter` nor `softKnee` is an alias for
Three's `radius` or `smoothWidth`. These are deliberate retained differences:
copying the threshold default or multiplying intensity cannot align the spatial
response and would change ordinary scene brightness.

## Constant ambient irradiance

`Skylight.ambientIrradiance` is an additive, linear RGB irradiance value, default
zero. It is independent of `color`, `intensity`, the image source and local
reflection probes. Standard Forward and Deferred apply the Lambert `1 / pi`
conversion to the surface's diffuse response before material/screen occlusion;
it supplies no specular environment. Physical layers retain their ordinary
composition after that response. Unlit/data materials do not consume it.

The native environment snapshot and 96-byte environment uniform carry this
value through retained frames and probe selection. Removing a Skylight clears
all uniform lanes. Pending image preparation cannot suppress this independent
irradiance. The Three adapter sums camera-visible AmbientLight author values
into this existing environment owner; it does not synthesize image assets.

## Hemisphere ambient

`Skylight.groundColor` makes the diffuse environment a hemisphere, like Three.js
`HemisphereLight`: the diffuse scale is `mix(groundColor, color, n.y * 0.5 + 0.5) *
intensity` for the world-space normal `n`, multiplied by the image or Atmosphere
irradiance when one is bound. Diffuse transmission samples the opposite
hemisphere with `-n`. The all-zero default writes a disabled lane, so shading is
exactly the uniform `color` path. The uniform's last lane carries
`groundColor * intensity` and an enable flag for the material, Deferred and local
reflection-probe environments; an unavailable diffuse source zeroes it with the
sky term. Specular environment and `ambientIrradiance` are unchanged. A Three
hemisphere of intensity `I` maps to `intensity = I / pi` (solid-colour Skylight
has no Lambert `1 / pi`).

### Affine model winding

Scene transforms can contain nonuniform scale, shear and reflection. Raster pipeline
selection derives front-face parity from the model matrix without changing the authored
material. Direct color/depth/temporal draws, prepared GPU batches and shadow casters
share that rule. Shadow-view reflection composes with model reflection. A transform-only
update that changes parity invalidates the raster batch; ordinary translation retains it.
This describes entity model transforms, not independently reflected matrices inside one
instance collection.

`ShadowInvalidConfigError` takes a structured `ShadowInvalidConfigBound`
(`range`, `lower-bound` or `allowed-values`) and an optional reason. Light
validation and extracted shadow projections use the same bound vocabulary.

Renderer lifecycle listeners dispatch against the roster present at the start of the event. A listener added during a callback receives the latest event once through immediate replay; removing the current listener does not skip the next listener. The retained event is also the replay-availability fact.

## Material output and shadow projection

Unlit and Standard accept `alphaMode` (`preserve`, `opaque`, `premultiplied`) and
`renderState.alphaToCoverageEnabled`. Coverage and hashing run before output
alpha conversion. A numeric vector value shorter than its schema slot keeps the
declared default for the omitted trailing components in every material row and
UBO writer, so an RGB `baseColor` keeps alpha 1 (Three's default `opacity`)
instead of presenting transparent on a premultiplied canvas. Alpha test discards
at equality; smooth coverage uses fragment derivatives. Independent Unlit `alphaTexture` uses `alphaChannel` (green/1 by
default); the Three r184 WebGPU adapter selects red/0, matching MaterialNode.
Unlit's declared schema owns its material layout, including boot, skin and shadow
pipelines. Normal visualization retains its raw-data default; `encoding: 'display'`
opts into inverse sRGB before the camera's display encoding.

`shadowAlphaMode: 'texture'` selects texture-only shadow coverage independently
of surface opacity, vertex alpha, alpha hashing and alpha-to-coverage. The native
default remains material coverage. Standard IBL evaluates dielectric and metallic
multiple scattering separately, then mixes the responses; diffuse energy
conservation and Physical specular F0/F90 use the same data in Forward and Deferred.

Directional/spot shadow projection can use an authored matrix instead of the
native fit. Point shadows retain their submitted origin when frozen. Per-light
caster masks intersect `ShadowParticipation.channels`; display-camera visibility
can be independent from casting. The renderer retains final depth and VSM moment
layers across graph rebuilds and captures, committing updates only with the
submission. Frozen captures import retained content and issue no caster draws.
VSM adds two separable RG16F blur passes for updated directional/spot views;
unused VSM allocates no moment targets. Native CSM fit, geometric receiver bias
and default shadow filter are unchanged.
