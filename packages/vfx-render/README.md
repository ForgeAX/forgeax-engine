# @forgeax/engine-vfx-render

Production RenderFeature and host for persistent GPU particle simulation and indirect billboard, mesh, ribbon, trail, and beam drawing.

## Host recipe

```ts
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { createRenderer } from '@forgeax/engine-runtime';

const vfx = createVfxRuntimeHost({
  camera: {
    read: world => readActiveParticleCamera(world),
  },
  maxQueuedTicks: 8,
});

const attached = await vfx.attachWorld({ world, assets });
if (!attached.ok) return attached;

const created = await createRenderer(canvas, { features: [vfx.feature] });
if (!created.ok) throw created.error;
const renderer = created.value;
```

Create the host before the Renderer and pass `host.feature` at Renderer
construction. `attachWorld` installs the VFX asset decoder and one Update intent producer;
`detachWorld` releases both. The asset owner resolves Material/Mesh dependencies at effect
admission. The Host borrows those accepted handles and owns no GUID loader or asset cache.

The stock host captures each material reference once per synchronous World extraction,
sharing that frame's values and admitted program projection across particle Players.
The next candidate reads current accepted values after a managed edit or replacement.
Custom projection methods and accessors keep their per-use observation and error behavior.
Direct feature providers can opt into this frame capture with `material.captureFrame`.

Particle context selection remembers validation for frozen primitive contexts and
deeply frozen plain-data subtrees. Weak membership does not retain materials;
a frozen parent with mutable children or a cycle still uses per-publication
inspection. Mutable program metadata, render state and runtime values remain
current, including enumerable accessors and non-cloneable values.

An explicitly authored mesh source `{ source: 'player' }` reads the Player entity's
`MeshFilter` through the asset owner. Extraction captures each Player's current Mesh in the
same publication used across Render Workers. The published dependency is a runtime handle;
planning resolves it from the accepted resource scope. Shared effect Mesh references and
Player-local Mesh references use that same transport, without duplicate mesh payload on
stable frames. Distinct custom provider meshes
remain inline, preserving their captured values and unmanaged edits on later frames.
The normal feature geometry cache and Renderer submission fences own GPU upload,
replacement and retirement. A source upload/preparation is not a draw receipt.

An explicitly unlit mesh renderer without an authored `particle-mesh` pass
selects a dedicated built-in unlit entry. It keeps the material interface,
base/emissive textures, alpha and fog while omitting discarded Standard lighting;
lit meshes and authored particle programs retain their original paths.

## Frame path

| Stage | Work |
|:--|:--|
| Extract | Synchronize Player lifecycle through VFX, including zero-time admission, then read the explicit simulation camera, complete view roster, and ordered GPU intents once per attached World |
| Plan | Declare shared frame simulation and independent view projection work in one plan |
| Record | Produce requested simulation scene inputs, execute each queued tick and trail-history write once, then copy the completed state through native buffer-copy passes into each updating view before sorting, projection, and indirect draws |
| Recover | Drop generation-owned GPU state and reconstruct retained active players from committed tick inputs |

Published frame data names each emitter by the source asset identity, its fixed revision,
and emitter ID. WGSL and reflection travel once in the publication's fixed-version rows;
ordinary current-asset updates cannot redirect queued ticks. Planning resolves the held
version during its normal work traversal. Same-reference replacement, discarded candidates,
two outstanding frames, delayed ACK and receiver recovery preserve the exact program without
a receiver World or a consumer-created asset identity.

Loaded and code-created effects use the same immutable definition capture. Emitters without
data interfaces or force fields share prepared logical compute bindings and stateless programs;
particle storage, event buffers, history, uploads and execution state remain per Player.
Each actual preparation request participates in shared program readiness. A definition edit
starts a new play cycle at the next update while already queued ticks retain the previous version.
Unchanged material Cook records stay resident when a values-only asset patch is published.

The explicit simulation camera provider receives `read(world, views)`, where
`views` is the existing extracted display roster. Hosts may select a submitted
view's `selectedView` directly without rescanning World camera state or deriving
a second set of matrices. An author-supplied camera remains independent of the
display roster when the effect requires it.
| Dispose | Release feature-owned state; the Renderer resolver destroys RHI resources exactly once |

The generic render seam accepts persistent compute programs/buffers/bindings, native buffer copies, external GPU vertex buffers, and indirect draw commands. Renderer code does not enumerate VFX kinds.
At first use, the feature declares compute entrypoints for authored renderer
topologies plus simulation, event, custom stage, and unknown extension kernels.
Compaction prepares inter-block offsets only above one workgroup's capacity;
sorting prepares a pipeline only when an authored renderer uses it. These choices
share the dispatch predicates. A disabled renderer remains authored so visibility
changes, retained players, and replay can resume without a different program
contract. Capacity or sorting changes update the descriptor through the existing
prepared-program cache, and device recovery rebuilds the same required set.

One Renderer owns one feature instance and one source acknowledgement transaction.
All enabled views contribute to emitter visibility using their final viewport
projection, including views holding their last image because of update cadence.
Submitted source feedback updates runtime visibility even when no tick was queued;
this lets a paused emitter resume after camera reentry. Extraction does not mutate
visibility from authored camera aspect. Worker transport can add one frame of
visibility feedback latency. An updating view owns its camera basis,
sorted indices, projection counters, indirect commands, trail-offset scratch,
and output instances. Sorting or mesh projection in one view cannot mutate
another view or the shared simulation. View order and cadence do not change
the number of ticks consumed.

A view plan includes only the shared resources its own declarations reference;
per-tick simulation inputs stay in the frame graph. An emitter retains the tick slots of its largest admitted batch; fewer or zero queued ticks disable the unused simulation/history passes and omit their uploads. Fixed/render cadence changes do not rebuild that topology, and only submitted active ticks advance the source acknowledgement. View visibility toggles
execution of retained copy/projection/raster declarations through `enabled`.
Camera motion and display cadence therefore do not invalidate view topology;
resource replacement, capacity changes and emitter lifetime still follow
Renderer admission and fences. Emitter declarations use stable resource-identity
order, so switching between queued and retained state does not shift another
emitter's resource evidence. Resource sorting is separate from pass construction:
passes preserve original queued/retained group order, with ticks and
history writes ordered within each emitter. Transparent premultiplied-alpha
passes remain ordered writes to their scene attachment; sorting resource
declarations cannot reorder their blending. Optional GPU particle-depth sorting
still orders particles within each renderer, not across emitter passes.

Adjacent color draws within the opaque or blended phase share one raster pass
when their loaded/stored attachments and sampled targets match.
The merged pass retains every draw in its original order, with its own program,
bindings, geometry and indirect command. Per-emitter visibility becomes draw
`enabled`, keeping the merged topology stable; an entirely hidden run disables
the pass. Hidden draws never replay retained indirect commands or enter submission
counts. Depth sampling differences, clear/discard operations and phase boundaries
keep separate passes. Simulation, projection, shadows, source acknowledgement and
resource retirement continue through their existing owners.

A tick with zero scheduled spawns retains its spawn declaration with a
zero workgroup count. Renderer validates the full declaration and resources,
then omits that empty GPU command while preserving graph identity and resource
lifetime. Particle updates, custom stages, compaction, events, and trail history
still run in their original order; an event may spawn particles independently
of the scheduled count.

Each updating renderer copies its shared alive indices, counters and indirect
commands in one managed compute pass; trails include history in that same pass.
The three-pair and four-pair programs derive WGSL and binding layout together
and use at most eight storage bindings. Destination buffers remain private to
each view, and each copy checks its own source and destination extent before
sorting or projection. This reduces copy passes without changing simulation,
view cadence, source acknowledgement or Device recovery.

The host's `camera.read(world)` explicitly supplies the simulation camera.
Its snapshot survives source publication and supplies these reflected inputs
without requiring a game to allocate GPU resources:

| Data interface | Default producer | Scope |
|:--|:--|:--|
| Camera | A 64-byte uniform containing the explicit simulation view-projection matrix | Shared by that World's emitters |
| Scene depth | Renderer captures opaque scene coverage from the same simulation camera at the outer surface extent | One requested capture per World and frame, independent of display views |
| Noise | Renderer owns the generation-resident noise texture | Shared by all emitters |
| Scene SDF | Renderer composes checked geometric fields from its complete retained scene | Shared by matching requests for the same World, range and accepted source |

Only reflected inputs acquire resources. Display camera order, viewport extent,
and update cadence do not select simulation inputs or repeat simulation.
Scene depth uses the composed scene, including geometry outside every display
frustum. Its producer completes before shared simulation; each updating view
then projects the same completed particle state.

Explicit resident `dataInterfaces` provider resources retain their typed binding
and generation checks. An absent provider or resident payload uses the default
producer. Explicit unavailability, stale resources, wrong types, and duplicate
providers defer the affected emitter stream. The feature only advances its
submission ledger after all declared frame passes appear in the submission
receipt; source feedback is acknowledged once after the Renderer submits.

## Managed scene SDF collision

Import `forgeax_vfx::data::scene_sdf` in a schema-v3 update module and supply
`createVfxRuntimeHost({ camera, sceneSdf: { read(world) } })`. The reader returns
[`RenderFeatureSceneSdfDescriptor`](../render/src/features/scene-sdf.ts): a fixed
world-space origin, dimensions, spacing, distance band and explicit instance/field
byte budgets. A missing reader rejects an emitter requiring this input. Effects
without the import allocate no field. The range reader supplies no GPU buffer;
existing explicit provider resources retain their type and generation barriers.

```wgsl
#import forgeax_vfx::data::scene_sdf
// Inside vfx_update, after applying forces:
let hit = vfx_sdf_collide((*particle).position, (*particle).velocity,
                        ctx.delta, 0.02, 0.7, 0.1);
(*particle).position = hit.position;
(*particle).velocity = hit.velocity;
```

Radius and distance use world units. Restitution is the retained normal-speed
fraction and friction removes a fraction of tangential speed, both in `[0,1]`.
The result exposes contact, outside coverage, exhausted work, unknown gradient
and invalid parameters separately. The bounded helper and numeric statuses are
defined once in the [compiler kernel](../vfx-compiler/src/scene-sdf.ts).
It performs at most 64 field samples and four contacts per tick. Distance,
gradient and the bounded cubic ray prefix derive from the same eight corners. A contact
projects in gradient units beyond the threshold by a two-epsilon margin; this
does not change voxel spacing or geometric contact expansion. The original
88-query acceptance ceiling remains unchanged, and diagnostic counts report
actual queries. A diagnostic result is not proof of a completed trajectory.

Static Mesh assets need the ordinary checked geometric field artifact described
in [Import](../import/README.md#optional-mesh-distance-field-cooking). Sampled
visibility fields, deformation and coverage that the producer cannot represent
reject the entire requested scene. Signed-solid and explicit two-sided fields
retain their geometric approximation error. Contact expansion includes the
transformed local error and one world-grid cell diagonal, so the spacing and
local-field resolution directly affect premature contact.

The field does not depend on GI, display frusta or view cadence. Renderer records
composition before shared tick simulation in the same graph/submission.
Matching consumers share the same physical buffer; hot unchanged requests omit
composition. Accepted replacement, failed preparation, rejected submission,
detach and device recovery use the Renderer transaction and submission fence.
There is no CPU particle mirror or per-frame particle readback. The ordinary
Pack example is [`boss-lightning/sdf.html`](../../apps/hello/boss-lightning/sdf.html).
The [collision evidence report](reports/scene-sdf-collision/README.md) retains
captured-input repairs, paired images, raw tapes, prior failures and the
remaining delivery acceptance boundaries.

## Depth convention

Camera providers supply the same Reverse-Z view-projection as the Engine camera.
Built-in billboard depth tests and soft-particle fading use larger raw depths
for nearer surfaces; zero denotes empty background and does not fade particles.
`softParticle.fadeDistance` retains its normalized depth-buffer units.
GPU view-depth sorting orders smaller depths first for back-to-front blending;
world-distance and custom sorting keep their existing keys.

## GPU state

| Buffer | Lifetime | CPU traffic |
|:--|:--|:--|
| Particle state | Emitter instance | Initial clear only |
| Alive flags, scan scratch, stable indices | Emitter instance | Initial clear only |
| Shared indirect counts | Emitter instance | Compaction owns instance counts |
| View indices, counters, indirect commands, trail scratch | View and renderer instance | GPU copy from shared state before view sorting and projection |
| Tick uniforms | Bounded ring | One small write per tick |
| Program v3 Parameters | Emitter instance | One snapshot write per tick when declared |
| Program v3 Custom | Emitter instance | GPU-persistent; no per-particle CPU mirror |
| Renderer projection instances | View and renderer instance | None after allocation |
| Mesh geometry/index data | Prepared graphics cache | Initial upload |
| Ribbon strip resources | Ribbon renderer | Initial allocation; GPU indirect count |
| Trail history resources | Trail renderer | Initial allocation; GPU history updates |
| Beam endpoint resources | Beam renderer | Initial allocation; GPU endpoint projection |

There is no steady-state particle readback or CPU particle upload.

Material particle inputs use up to four vec4 lanes. The highest selected lane
determines the input region size; selecting lane 3 alone still reserves four
lanes. VFX projects the cooked values on GPU and forwards that lane count in the
graphics program declaration. Render derives the matching multi-stream layout
and includes its complete stride/attributes in pipeline identity.

| Adapter | Core instance bytes | First material-input shader location |
|:--|--:|--:|
| Billboard | 124 | 9 |
| Ribbon / Trail / Beam | 48 | 4 |
| Mesh | 72 | 10 |

Each selected input occupies its declared lane at `coreBytes + lane * 16`;
instance stride is `coreBytes + (highestLane + 1) * 16`. Missing or stale material
declarations fail with structured input errors rather than silently substituting
zero-valued inputs. Four-lane and sparse-lane support is exercised through the
cooked five-topology Dawn fixture, not only synthetic buffer uploads.

Bindings retained by an attached player keep their transitive buffers alive. When a player,
emitter, or World disappears, untouched GPU resources leave the live cache immediately and their
buffers are destroyed only after the submitted queue work completes. Renderer recovery and dispose
use the same owner path.

## Rendering

- Billboard projection uses camera right/up, particle width/height, and the v3 `sprite_rotation`; color and HDR material values are packed per renderer on GPU.
- Mesh renderers consume the explicitly selected `MeshAsset` submesh geometry/index data and one independent projected instance stream per renderer.
- Program v3 Mesh projection writes world-space center and Quaternion/Scale3 basis
  data. The built-in Mesh adapter supplies geometry inputs to the same Standard
  surface evaluator as scene Mesh. Render owns lighting preparation, topology
  variants, effective material values, Skylight inputs, and Cluster bindings;
  particles do not allocate a second lighting system or scene Mesh/Instance tables.
  Negative/non-uniform scale uses an inverse-transpose normal basis and preserves
  tangent handedness. Mesh `castShadows` contributes the same GPU instance/index/
  indirect data to Standard light views through a `shadow-caster` plan pass.
  The shared Dawn/WebGPU acceptance fixture proves directional/point/spot casting,
  camera-culled casters, Point receiving and authored bias, and four roughness/
  metallic combinations against ordinary Mesh under a real HDR equirect.
  Current-depth-dependent simulation consumes its dedicated opaque scene capture
  before display views project particles and render shadows. Render-only frames
  retain simulation state without advancing it; a catch-up submission exposes
  its final tick to every updating view. The indirect buffer is never
  reinitialized per tick.
- Multiple renderers on one emitter receive independent material values and indirect command offsets.
- A material pass named `particle-billboard` or `particle-mesh` selects the published
  cooked program for the receiving renderer's context and its render state. The
  material projection travels with the extracted snapshot. The VFX host omits stock asset
  registry projections containing only ordinary forward, deferred, and shadow-caster passes; custom
  providers and particle-pass projections retain their existing publication behavior. Source
  module names are not aliases for cooked specialization keys. Without a matching particle pass, the package-owned
  built-in shader supplies the particle vertex adapter. Mesh preserves the ordinary
  `Forward` material render state; the other renderers use their particle defaults.
- The selected particle program's declared, compiler-validated ABI binding contract controls whether it receives the
  standard material bind group at group 1. An ordinary material's parameters never add an
  undeclared group to the built-in billboard shader. Numeric parameters use the shader-schema UBO layout;
  texture parameters resolve their authored TextureAsset and optional SamplerAsset through the
  attached World and the renderer's shared GPU residency store. Shaders without material bindings keep
  the original group-0-only contract.
- Custom material programs explicitly declare `bindings` and a `sceneDepth`
  version when sampling scene depth; see the [shared contract](../types/README.md).
  `read-only` forbids depth writes. A material that needs both soft intersection
  sampling and depth writes declares `before-pass`; Render owns the independent
  snapshot and write order. Such snapshot passes remain separate when adjacent
  particle draws are batched. Transparent energy layers should author their
  intended occlusion policy rather than relying on automatic depth-write changes.

Package-owned programs use `package.json#forgeax.materialPrograms` for the same
declarations. Built-in billboards select `before-pass` so opaque-cutout and
authored depth-writing passes keep their writes; blended defaults still disable
depth writes. Feature planning receives the binding interface and depth version
together from the published receipt. It never overwrites the authored write flag.
- The renderer owns bind-group resource leases. Per-preparation material UBOs are destroyed exactly
  once when the prepared graphics generation retires or recovers; texture and sampler residency
  remains owned by the shared GPU resource store.
- Billboard blend is explicit: `additive`, premultiplied `alpha`, or `opaque-cutout`.
- Scene color/depth target formats and sample counts derive from RenderFeature targets.
- Each view completes particle projection and opaque color coverage before blended
  particle color. The resolved material render state owns this classification;
  Player spawn order never lets later opaque smoke overwrite an earlier flash.
  Order within each group and each renderer's GPU particle sorting stay unchanged.
- Fixed bounds suppress the main-camera raster when culled, not an enabled Mesh
  shadow contribution. Simulation follows the source culling policy.
- Camera-frustum results publish through `setEmitterCameraVisibility`; session mute/isolate
  and Player render consumption independently suppress simulation and retained color,
  shadow, and projection work while retaining prepared bindings as warm state. A paused
  player can therefore be isolated and restored without a new simulation intent or
  GPU-resource reallocation. Camera culling alone still allows enabled mesh shadows.
- WGSL runtime time is the effect-relative `phaseTick`; the world-global tick remains an internal ring-selection and correlation clock. Replay and deterministic seek therefore restart shader time as well as CPU scheduling.

Billboard texture sheets, pivot, and soft-particle depth sampling execute from
the reflected renderer contract. Mesh and billboard sorting use the managed GPU
sort pass before instance projection, independently of indexed draw offsets.
Emitter resource identity uses the complete emitter ID within its World,
attachment, player and generation; display-name truncation never keys storage.

Mesh geometry projects declared source attributes into one 72-byte stream:
position, normal, UV0, tangent, UV1 and RGBA. Geometry owns packing; Render maps
color/UV1 to locations 14/15, leaving 4..9 for instances and 10..13 for up to four
material-input lanes. Missing color defaults to white and missing UV1 to zero;
source colors multiply particle colors. This applies with or without custom
material inputs. Index uploads are four-byte aligned without changing authored
indices, draw counts or firstIndex. Ribbon, trail, and beam use
independent resource plans and shader entry points. Parent variants and CPU
counterparts remain outside this runtime boundary.

Material texture and sampler bindings remain executable for particle materials;
the advanced renderer fields augment that shared material path.

## Runtime inspection

`host.inspect(world)` returns one immutable aggregate for the attached world:

| Field | Meaning |
|:--|:--|
| `generation` | Host attachment generation; changes when a new World realm is attached |
| `players[]` | Keyed per-player snapshots, including every emitter rather than one latest intent |
| `diagnostics[]` | Runtime-owned structured diagnostics for the same world |

The aggregate is `undefined` for an unattached World. A freshly attached empty
World returns an explicit empty aggregate, which lets tools distinguish “ready,
no player” from “not attached.” Realm-local entity handles are never reused as
cross-World identity; consumers must pair them with the host generation and
asset GUID.

`host.acquireControl(world)` is the command-side counterpart to inspection. It
returns a generation-bound lease for replay and runtime-only emitter session
masks, so product hosts do not reach through the public host into
`VFX_GPU_RUNTIME_RESOURCE_KEY`. Every command revalidates the attachment
generation, runtime resource and live `ParticleEffectPlayer`; detach,
reattach, or player destruction therefore returns a structured
`VfxRuntimeHostControlError` instead of mutating a stale realm. Acquire a new
lease after any host generation change. These controls are transient runtime
intent and do not modify authored `ParticleEffectPlayer` data.

The same generation-bound lease exposes `patchPlayerParameters` and
`submitChannel` for the bounded runtime control surface. Parameter patches
return the host generation, parameter generation, and pending patch count;
channel submissions retain the existing typed channel/event/sub-emitter path.
Missing players, invalid instance input, stale generations, and detached
worlds all return the closed `VfxRuntimeHostControlError` union. There is no
open Data Interface or second channel registry.

The render feature also exposes `feature.inspect()` as a bounded
`VfxRenderObservation`. `frameNumber`, `dispatches`, `indirectDraws`, and
`subjectOutputs` describe the VFX commands admitted in the last submitted
frame. `subjectOutputs` counts admitted subject raster commands; it is not a
particle-instance readback and must not be interpreted as proof that an
indirect draw had a non-zero instance count. Preview tools combine this receipt
with the existing owner inspection, PNG, and RHI-tape artifacts.
`dispatches` counts resolved submitted compute commands, excluding zero-work
direct dispatches; it does not count declaration slots or GPU invocations.

`createVfxRenderInspectSnapshot` and `topologyRecoveryHint` expose structured
readiness and recovery evidence. Device loss or a stale generation discards the
affected topology resources. The first submitted replacement-device frame
reconstructs active retained GPU state from the runtime's deterministic
committed tick inputs; rejected candidate frames do not publish that
generation or replay World-facing events.

Same-program replay, seed changes and stop/play restarts retain the player/emitter's
particle buffers, programs and bindings. Reset copies execute immediately before
their tick in the submitted command stream; preparing or abandoning a frame
never clears accepted GPU state. One immutable zero buffer serves all emitters,
with a small indirect-argument template per emitter. Ordinary ticks retain one
compute chain; only an actual mid-batch reset introduces an additional boundary.
Changing the cooked program or attachment keeps independent storage. Queued
program changes execute complete reset/simulation/history ticks in source sequence
order; only the final admitted program owns view projection and drawing. Device
recovery reconstructs committed state before a queued continuation, including
when a later reset of that program shares the batch.

## Capabilities and recovery

The feature requires RHI `compute` and `indirectDrawing`. Capability absence disables registration through the standard RenderFeature capability error; it never guesses a backend by package name and never silently falls back to CPU.

Expected first-use pipeline preparation may report bounded `render-feature-preparation-failed` warm-up. Persistent preparation errors, WebGPU validation errors, or any later `render-feature-stage-failed` are failures. Renderer recovery creates a fresh resource generation and invokes the feature recovery hook before rendering resumes.

A missing registered particle shader is a `material-shader-not-found` failure,
not asynchronous pipeline warm-up. Inspect the renderer error cause and repair
the material publication before retrying.

## Verification oracle

`apps/hello/boss-lightning` is the production path:

| Gate | Proof |
|:--|:--|
| `smoke:browser` | Dev Pack/import transport, Browser WebGPU validation, loader, runtime, camera readiness |
| `smoke` | Dawn 60 frames, billboard and mesh pixel energy, readiness deadline, explicit recovery |
| `smoke:falsify` | Disable-VFX, zero-emitter, missing-depth, and topology-fallback modes produce explicit structured failures |
| `scripts/bench/vfx-batch-b.mjs` | Exact 10K/100K/1M total capacity, 30 warm-up plus 60 sampled frames, zero particle readback, and per-adapter p95 budget |

```sh
pnpm --filter @forgeax/hello-boss-lightning smoke:browser
pnpm --filter @forgeax/hello-boss-lightning smoke
pnpm --filter @forgeax/hello-boss-lightning smoke:falsify
node apps/hello/boss-lightning/scripts/smoke-public-only.mjs
node scripts/bench/vfx-batch-b.mjs
```

The hardware product target is p95 <= 33.34 ms. CI's forced lavapipe adapter is
a software correctness reference, not evidence of hardware GPU throughput, so
its p95 is recorded but is not treated as an FPS gate. Reports include
`adapterClass`, `performanceGated`, the hardware target, and
`allocatedCapacity`. A hardware run must satisfy the target, and every tier
must allocate exactly the declared total capacity.

Null/backend unit tests prove graph and resource structure; they do not replace Browser or Dawn execution.

## Managed field residency

Asset admission binds vector-field textures to runtime references and the effect
holds those dependencies. Each actual update captures their exact owner
versions; already queued ticks and retained recovery inputs keep their own leases.
The source publishes each `(asset, revision)` once through the existing asset
version table. Tick messages carry only those references, including across Workers;
unchanged frames do not transfer sample arrays again.

The receiving feature validates and packs from those fixed versions. Multiple
queued versions share the particle state but bind distinct read-only field buffers
at binding 17 in dispatch order. The cache retains each used version tuple, so
abort/retry and same-submit old/new inputs do not evict each other. Render's normal
resource generation and submission lifetime own uploads and retirement. Accepted
unchanged input performs zero GPU uploads; recovery uploads the retained input.

Capture checks at most eight declared field references per actual emitter work.
A new tuple packs at most 16 MiB of metadata and samples. A proven range edit
reuses the previous GPU field buffer and uploads only changed sample ranges;
initial upload and recovery copy metadata and sample slices in one ordered
copy pass. Shared destinations have one graph access declaration. Asset snapshot budgets bound retained
source versions, and last tick acknowledgement, Player removal, restart and Host
detach release their leases. There is no texture-to-Player reverse fanout.

During an explicit asynchronous Texture reload, the Host keeps the admitted field
until the asset owner commits the replacement. Failed reload and source removal
preserve adopted runtime content. An initially unavailable or released runtime
reference reports its structured missing-asset error; no zero field is substituted.

Field sampling runs in shared frame simulation, independently of private view cadence. Stopped/removed players, World detach and renderer disposal reuse the existing lifecycle authority. The field owner has no independent queue submit, device handle registry, runtime compiler or per-particle CPU mirror. SDF collision remains a separate capability and binding.
