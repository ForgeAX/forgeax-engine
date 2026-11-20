# @forgeax/engine-water

Water contains durable water payload admission and per-Scene lifecycle state. ForgeAX Pack sources use meters, XZ-horizontal and +Y-up directly.

## Start with a lake

The [Lake Starter](examples/lake/) is a complete, opt-in `test-experimental`
Water scene. Use it when a task needs a simulated water body. Copy the example
from the installed `@forgeax/engine-water` package or from
`source/engine/packages/water/examples/lake` in the SDK source tree.

1. Create a disposable project outside the SDK with
   `forgeax project new /path/to/projects/lake-preview --template game-3d`.
2. Copy the example's [`forge.json`](examples/lake/forge.json) over the new project's
   manifest and its [`assets/lake/` directory](examples/lake/assets/lake/) under
   the new project's `assets/`. The example manifest selects that directory
   and mounts the lake scene. Template assets outside that root stay inactive.
3. From the new project root, run `forgeax project check` to check the setup,
   then `forgeax project capture --headless true --backend hardware --output lake.png --json`
   to cook the Pack and capture a completed browser frame. Open the image and
   check that the water surface covers the lake bed. A successful setup check
   alone leaves scene visibility unverified.

The [Pack](examples/lake/assets/lake/lake.pack.ts) keeps the Lake, WaterZone,
wave set and scene in one place. It references the stock lake materials from
Engine Content. Start by editing the XZ shoreline corners, wave amplitudes or
base height. Keep the Body and WaveSet's `maxWaveHeightM` in sync when
increasing amplitude. Keep the opaque bed below the lowest wave and size the
zone to cover the shoreline.
When copying into an existing game, keep its manifest and camera, include the
Pack in its asset roots and add the water actors to the scene it already mounts.
Use a distinct Package ID for each independently authored copy in one project.

Add interactions once the initial scene renders. Read [surface queries](#wave-and-query-contracts)
for height, normal and depth, [buoyancy](#synchronous-buoyancy-and-basic-di)
for floating bodies, and [local fluid](#local-fluid-simulation) for simulated
fluid around moving objects.

Water owns `WATER_SYSTEM_RESOURCE`, `WATER_BUOYANCY_RESOURCE` and
`WATER_VISUAL_CONTACTS_RESOURCE`. Runtime installs those exact ECS tokens;
Render and game consumers import the same tokens to read their typed facts.
Their names are diagnostic labels, and a same-named independent token does not
select or replace Water state. Runtime keeps its scene status token and schedule
assembly; Physics owns the fixed sync, simulation and completed writeback phases.

Immutable mesh dependencies retain their selected storage and typed-array kind
metadata. The internal `waterDependencyMeshView` admits triangle ranges and
exposes position/color windows over that frozen backing. WaterInfo, GPU WaterMesh
and component bounds share these windows; runtime interleaved layout declarations
are never treated as populated channels or expanded into channel mirrors.

`createWaterCapabilityReport` combines explicit RHI, Render and Physics facts
for the selected configuration. Report version 2 describes runtime support and
requirements. An absent CPU mesh publication is `unavailable`; registration does
not establish a completed mesh publication.

## Local Fluid Simulation

`WaterFluidSimulation` binds a Scene-local Body to a saved `water-simulation-recipe`
with `system: 'fluid-simulation'`. `WaterSystem.fluid` owns source admission,
generation and submitted history; Render owns its persistent graph targets.
The field affects water materials only; CPU Body queries and buoyancy retain
their existing authoritative inputs.

Render's shared frame graph owns WaterInfo work and persistent history for every
view, independently of fluid enablement or terrain mode. World, view, Zone and
device identities stay separate; views import their own outputs and the fluid
solver executes once per renderer frame. Reordering views cannot move retained
WaterInfo history between graph owners.

`configurationVersion: 1` selects the built-in kernels: Ripple, the four Shallow stages, the selected
solver's normal pass and optional WaveFoam. The recipe owns their numeric
parameters and target descriptors. `materialGuids` and `textureGuids` must be
empty; nonempty overrides fail source admission. `impulseNoiseGuid` is the
explicit, consumed texture input. The separate `water-advanced` recipe retains
its existing source contract.

`waveFoam: { resolution, gridExtentM }` is a separate square capture domain.
The Scene component's explicit world-space `waveFoamCenterM` can move without
changing the recipe or resetting the solver. Each submitted outer frame retains
its current, previous and second-previous WaveFoam centers, independently of
fixed solver callbacks. These are explicit Scene author inputs.
The Wave pass retains the material's normalized-UV Shallow height sample.
Active BeachFoam derives its center, extent, resolution and sampling from the
same-generation producer tuple, including its independent linear-clamp amount
and linear-wrap height reads. Authors do not repeat this mapping in materials.
Disabling WaveFoam restores the existing static/no-simulation material path.

- Each outer frame draws its force field against the pre-movement grid center.
  Fixed callbacks then move the grid and run Ripple or the four Shallow stages;
  catch-up steps reuse that force image. Zero-step frames retain the solver center.
  Normal and optional WaveFoam passes run once per outer frame;
  `foamFadePerFrame` and `foamWetFadePerFrame` apply once at that cadence.
- Ripple solver inputs clamp at edges. Normal passes and Shallow solver inputs
  retain their source texture addressing; repeat targets wrap. Moving the grid
  reuses both height histories without clearing newly exposed strips.
- `enqueueImpulse` accepts the default impulse parent's metre-domain height and
  radius, dimensionless foam multiplier, and outer-frame lifetime. Direct records
  keep constant strength; splash records skip drawing before their start offset
  and use `pow(clamp(age / lifetime, 0, 1), power)` afterward. A zero-lifetime
  direct impulse draws once even when that frame has no solver callback. Splash
  lifetimes must be positive; nonfinite and negative lifetimes are rejected.
- Queued inputs become active only after complete graph submission. Every active
  outer frame redraws all current records, then ages them by the full outer delta,
  retaining only `lifetime > elapsed - startOffset`. Catch-up never ages per step.
- Disabling removes material bindings and submitted RT history. Accepted queued
  inputs retain their sequence and payload; active records freeze. Re-enable
  clears new-generation targets and resumes both; solver/recipe edits also retain
  them while Body identity/generation and reset revision match. Explicit reset,
  Body replacement and instance removal clear both. New inputs are rejected while disabled.
- Persistent CPU/GPU history belongs to `World.identity` and the Scene-local
  simulation identity. Current composition indices route assets and material rows
  only. Within a device generation, complete submissions require a strictly newer
  source frame number, including equal-time zero-step frames; older and duplicate
  acknowledgments fail. Device or receiver-session replacement rebuilds history
  through its existing generation boundary.
- The default producer uses the recipe's ordinary `impulseNoiseGuid` dependency.
  ForceRT R is metres; G is source numeric foam computed from centimetre-domain
  strength, so a -1 m impulse with unit foam strength can produce G=99.75. Limits
  bound the authored multiplier, not the resulting G. B stays zero and A stays one.
  `velocityForces` is not a physical impulse API or a default Shallow input.
  Component, skelmesh and author-override force materials are outside this API.

## Optional terminal surface continuity

An authored River can opt into `transitionContinuity: { target: 'ocean', endpoint: 'end', reachM, blendWidthM }`.
Both lengths are finite positive meters and `reachM > blendWidthM`. The endpoint
comes from the accepted spline transformed by the Body's Scene matrix. This is
rendered-surface policy; native query, collision, depth and flow remain authored.
Omission retains the existing transition velocity mask and source height.

The CPU WaterMesh producer intersects actual current-generation River/Ocean
coverage edges. Inside the endpoint's inner reach it closes all three vertices
of every intersected rendered grid triangle to the target plane and target
Gerstner waves. The surrounding numeric support blends within `blendWidthM`
and stops at the outer reach; upstream source elevation is retained. It does
not fade tile perimeters. Adjacent ordinary patches of the same River receive
the same support and generation-qualified target wave row, so partitioning at
the Ocean footprint cannot split their shared deformation. Their River material
and native flow remain source-owned. Paired coverage requires the same grid, LOD morph,
observer-relative coordinates and one Ocean generation. Numeric support projects
production morph in the same order: clamp the distance ramp, add the packed
first-level height morph, then clamp their sum. Incompatible paired
grids return a structured source failure rather than snapping geometry.

Tile payload v8 retains its 96-byte stride. Byte 92 stores four far-side bits
and a 28-bit draw-local word offset into the existing coverage payload. A `WCN1`
block contains a count and `(quadsPerEdge + 1)^2` row-major f32 weights. The
receipt hashes both payloads; uploads validate ranges/counts/finite weights and
retain detached previous frames. Vertex and fragment consume the same original
grid triangle weights. No binding or Surface/deformation ABI is added. The
material producer identity is `material-pack-cooker/7`; durable `material-cook/5`
is unchanged and older composed material bytes must be recooked.

The supported reference is the stock Gerstner/height-mapping path with shared
WaterInfo depth, or equal fixed depth. Independent Baked depth is rejected.
Additional authored displacement still needs its own continuity contract; this
policy does not establish continuity for independent shallow/FFT fields or
custom deformation. GPU WaterMesh traversal currently does not produce this
optional numeric support and rejects the opt-in, without changing its default
path. Require actual Dawn execution and paired pixels before claiming a seam
has been fixed in an application.

## Optional GPU WaterMesh

The saved Zone `gpuMesh` field selects static-mesh rasterization, mip reduction,
per-view GPU traversal, material counting/prefix/scatter and indirect draws.
Omitting it selects the CPU quadtree. The GPU path never uploads a CPU occupancy
tree or a CPU-selected tile list. `supersampling` is an integer from 1 to 8,
`msaaSamples` is 1 or 4, and `occlusion` is `disabled`, `hzb`, `precise`, or
`hzb-precise`. The ordinary Render graph owns the current-view depth inputs.

CPU mesh completion retains the exact Scene-owned candidate submitted by that
frame. Camera movement may prepare another candidate before completion; it does
not invalidate the submitted candidate. Completion still requires matching World,
Zone and Body generations and never replaces a newer accepted publication.

One `WaterZoneViewWindow` supplies snapped mesh/capture coordinates to both
paths. Static geometry comes from accepted, version-qualified visible meshes;
Custom bodies require their existing explicit WaterMesh opt-in. The raster
packs at most 127 intersecting bodies and eight ascending priority slots;
additional priority values share slot seven. A 128th body returns a structured
source failure. Compute, storage buffers, indirect drawing and actual device
resource limits are required. Unsupported configurations remain observable
failures rather than silently selecting another mesh path. See the
[Render ABI](../render/README.md#gpu-water-mesh).

Far mesh keeps fixed Zone bounds by default. Explicit
`farMeshBoundary: 'view-window'` positions its lower flat ring around the current local Ocean
mesh window on both CPU and GPU paths. This Engine authoring extension requires
an active visible Ocean, `waterInfo.localTessellation`, `farExtentM` and
`farMaterialGuid`; an unavailable view window fails source planning. Mesh and
WaterInfo retain one generation-qualified mapping. Preserve the authored
WaterInfo texel density when enlarging the window. Visual coverage does not
enlarge the Body's finite query or collision domain.

## Advanced Simulation Entry

An explicit OceanPatch `algorithm: 'mode-projected-gravity/1'` selects the
geometry-driven linear gravity model. Its saved reference depth,
world domain, source slabs, native geometry budget and boundary policy are
required inputs. It shares the World OceanPatch owner, native completed-step
clock and ordinary submitted output lifecycle. Bind `materialGrid`,
`materialNormal`, `foam` and `mapping` through the shallow material slots with
`waterShallowSimulation` and `waterShallowAdditive`; this model supplies residual
height/normal/foam only. Terrain depth and Body flow remain authoritative.
`configureOceanPatchQueries` explicitly binds one current flat Ocean/Lake Body
generation and World identity to this model. Runtime requests a bounded source-cell
tile from resolved pontoons and contact probes. Up to three actual GPU readbacks
remain reserved through completion, including invalidated old requests. Queries
with `IncludeWaves` compose completed local height and its normal once. Inside
the patch, `localResidual` is a nested `Result`: `ok` contains the completed
sample provenance; `err` reports `query-data-unavailable` for unavailable,
future, expired or uncovered data while preserving all valid base-water fields.
Outside the original patch, or without the opt-in source, `localResidual` is absent.
The query's `nativePhysics` time/step is independent of the Gerstner scene clock;
paused wave time does not age a newly completed native observation. Worker
Snapshot/3 carries the same bounded detached source and lifecycle identity.
Native buoyancy qualifies residual queries with the receiving entity and native
generation. Render evolves the external-source field separately: the complete
field remains visible, while a receiver cannot amplify its own source through
buoyancy. Missing or retired receiver data reports `receiver-unavailable` and
preserves the valid base-water query. One bounded receipt carries the complete
plane and up to 32 receiver planes; receiver lifetime follows enabled native
participants. Background waves remain independent inputs.
`OceanPatch.enqueueWaveImpulse` adds a physical local vertical-velocity
impulse to the same gravity-wave field. Supply world `positionXZ`, Gaussian
`radiusM`, signed `velocityImpulseMps` and native `timeSeconds`; the radius must
be positive in f32 and at most one eighth of the domain. The analytic Fourier
projection retains the supplied radius and momentum; a coarse grid omits
unresolved high-frequency modes instead of widening the physical footprint.
Its Laplacian profile adds
zero net water volume. The Engine evolves displacement, normals and foam from
that field; it does not choose an impact appearance or derive incident energy.
The caller owns the momentum budget. Optional `sourceReceiver` excludes the
impulse from that native receiver's force field while retaining visible and
external waves. Up to 64 detached inputs remain queued until their complete
frame is submitted; discard retries them, pause holds them, and reset/retirement
clears them. Future inputs wait for their native time. This linear approximation
does not establish nonlinear impact, cavity or breaking-wave fidelity.

`WaterShallowCollider.dispersiveMotion` explicitly selects full entry displacement
or conservative facing-boundary transport; see the [Scene source contract](../scene/README.md#saved-water-displacement-source).
The optional recipe `entryWaveMultiplier` defaults to 1. A finite nonnegative
value scales full-displacement source changes before wave evolution, including
the external receiver fields used by buoyancy. It leaves surface transport,
native collision geometry and pontoon forces unchanged. Values above 1 are an
artistic amplification rather than physical displaced-volume equivalence;
zero disables entry waves while preserving the independent sailing source.
The independent `surfaceTransportMultiplier` defaults to 1 and accepts finite
nonnegative f32 values. It scales the conservative facing-boundary transport
source in both visible and external receiver fields; zero disables that source.
Values above 1 are an artistic wave gain. Source geometry, horizontal velocity,
entry waves and elapsed-time dissipation retain their existing inputs.
Free local waves always dissipate: `waveDampingPerSecond` defaults to 0.35/s
and an override must remain positive. Height and vertical velocity of nonzero
Fourier modes decay by `exp(-rate * elapsedSeconds)` in both the visible and
receiver-excluded fields. The mean displaced water is conserved. This is a
phenomenological energy loss, separate from absorbing boundaries and background
Gerstner forcing; stopping a source no longer leaves an undamped wave train.
Foam remains coverage history with independent emission and decay. A surviving
wave above `foam.slopeThreshold` can emit fresh coverage until its slope decays.
See the model and acceptance contract.

`WaterAdvancedSimulationSource` is the closed `water-advanced` Pack recipe
union. `configurationVersion: 1` keeps both existing OceanPatch algorithms;
version 2 admits only `mode-projected-gravity/1` with the required visual FFT
child described below. Load the ordinary `water-simulation-recipe` asset before
creating an owner; `WaterSystem` owns the lifecycle and Render owns GPU resources.

- `createAdvancedSimulation(recipe, bodyGuid)` binds shallow simulation to the
  current mounted Body generation. Its WaterBody/River stage profiles, impacts,
  source/sink boxes, frame inputs and capture requests belong to that owner.
- `prepareWaterRiverBake` consumes a completed current River capture and creates
  ordinary recipe plus grid and direct solver-normal texture Pack outputs. The
  `/2` recipe includes both texture GUIDs in its ordinary closure and identifies
  the normal basis as `lattice-axis0-axis1-up/1`; its flat normal is `(0,0,1)`.
  Publish and persist the complete output set through the Runtime Pack owner,
  then load the recipe and both textures through the ordinary Runtime asset
  owner. `decodeWaterRiverBake` requires each loaded texture's owning handle,
  GUID, actual AssetRegistry revision and loaded value. A live `/2` capture binds
  both pixel payloads to its source Body GUID and generation,
  complete Scene matrix, collision-geometry projection hash and original
  `sourceFrame` to the completed producer frame. A cold durable `/2` Bake must
  match the current Body GUID, collision-geometry projection and complete Scene
  matrix; its historical source Body generation may differ after a generation
  bump when that geometry and matrix are unchanged. `/1` remains decodable but
  cannot authorize cold publication. Failed replacement retains the accepted
  source.
- `requestOceanPatch(recipe)` owns one FFT recipe version per World, independent
  of Bodies. `setPaused` retains its accepted output; `reset`, `setEnabled` and
  `removeOceanPatch` govern generation-qualified resource lifetime.

Bind outputs through `waterAdvancedOutputNames` or `waterOceanPatchOutputNames`
with the owning `World.identity` and Render's `renderFeatureTextureSource`.
Shallow output names require recipe GUID, Body identity and World identity.
Material static switches
`waterShallowSimulation` and `waterOceanPatch` select their independent consumers;
River Baked queries do not enable either material switch. Optional Ocean
`gridMesh` emits a flat centered `(N+1)^2` grid with its own authored extent;
it does not displace vertices with the FFT field or attach a visible Scene mesh.

`configurationVersion: 2` opts only `mode-projected-gravity/1` into the closed
`visualNormalDetailFft` child. Its nested noise GUID must also be in the recipe's
ordinary `textureGuids` list. The World OceanPatch RenderFeature publishes the
separate named `visualNormal` texture: signed +Y-up normal RGB and raw visual
height A. The child noise revision, output validity and completion identity are
separate from residual/query history. Pausing retains an accepted target; a new
noise revision or parent-generation change invalidates it until its own full
FFT roster is submitted and completed. This output is material data only; it
does not feed CPU queries, WaterInfo, foam, collision or buoyancy. See the
v2 producer and lifecycle contract.

Live fluid and spectral height, normal and foam fields remain material inputs. Their default
paths do not feed CPU Body queries or native buoyancy; the explicit
`mode-projected-gravity/1` query binding described above is the local residual
exception. Durable River Bake publication remains a separate explicit source.
See the feedback boundary.
Stage captures report `water-advanced-readback-unavailable` when actual GPU bytes
are unavailable; River capture/publication errors use
`water-advanced-bake-unavailable`.
Published Worker frames deliver completion to the source owner, but feature
texture bytes remain receiver-local. Worker Stage readbacks and River Bake
texture publication return the structured unavailable errors above. Ordinary Worker completion requires no readback.
Ocean acknowledgments retain issued frame identity across later extractions.
Render consumes reset, source reseed and capture revisions only after the complete
planned work submits; an older acknowledgment cannot consume a newer request.
Stage readbacks pair their completion with the original `sourceFrame` sequence,
generation and time. Same-generation input refusal retains the last accepted
receipt and readbacks as history while the owner reports unavailable.

`debug.enabled` gates Prep Debug; `debug.writers` selects composable,
profile-qualified writers in `WATER_ADVANCED_DEBUG_WRITER_ORDER`, independently
of author list order. `debug.foamEmission` is the River Foam writer's separate
gate. Cell-speed and WaterInfo-speed are different inputs. Body state speed
scaling and `normalFoamRange` are explicit authored values.
`startFadeSeconds` is also required explicitly. WaterBody multiplies its
origin-relative height by `smoothstep(0, startFadeSeconds,
secondsUntilDestroyed)` before each substep's depth solve; River has no Fade
module. The follow-pawn lifetime is 15 seconds after water contact ends.
This changes solver height/depth, not material opacity, normals or Foam.
`deltaLimit: { kind: 'source-default' }` is unsupported and fails creation with `water-advanced-source-parameter-unavailable`. An explicit
positive `application-cap` enables the implemented solver; no zero cap is guessed.

Enabled `rigidMeshCollisions` consumes saved `WaterShallowCollider` participants
and accepted native Physics geometry. `accurate` selects center-soft or four-corner
area integration; the default is false. The explicit
`useWaterHeightForCollision` option defaults false in the source; when true it
only clears overlap volume below `1e-7 m` depth, independently of occupancy.
Rigid collision runs before NDC impacts. Both retain the source velocity
multiplier `1` and minimum `-0.01 m/s` (`-1 cm/s`), so zero speed passes.
Update Velocity consumes collision velocity as an absolute lerp target.

WaterSystem binds the simulation to its existing `queryBody` authority. Each
input update freezes the `ComputeLocation` surface result and its Body/source
generation; Gerstner waves are not requested. Missing or stale query input is
`waiting-water-surface`, retaining accepted output. Native component selection
uses the patch's full XZ extent, identity rotation and full Y size
`rigidMeshCollisions.overlapThicknessCells * extentM[0] / gridResolution[0]`
at that queried surface height. Enabled rigid branches require the finite,
nonnegative authored thickness coefficient; no implicit zero or one is supplied.
The overlap size is the coefficient times X-axis cell size. Physics converts the full
size to native half extents once. Selection retains every accepted filtered
element of a selected component, including individually nonoverlapping elements.
Only an originally empty aggregate may use held MeshAsset local bounds. Its
component-bounds identity includes the Body generation and mesh handle/revision,
separately from native collider identities. The distance-field path uses the
held geometric field's full inverse transform and minimum-axis distance scale;
an absent field retains the accepted primitive/bounds path.

Render captures committed Physics poses at the accepted step's end. Surface
velocity differences the same projected primitive point against the previous
submitted capture, using their elapsed capture time and one common grid origin.
Abort, reset and native/mesh replacement cannot advance or reuse stale history.
Capture uses end-of-step fraction `1`, independently of solver substeps.

The Engine Feature explicitly publishes ordinary simulation RTs for its material
consumer. Body normals use the last Compute Normals writer's
RGB normal/A clamped-foam layout; Beauty later replaces A with height. River
normals use RGB normal/A zero. Debug writers overwrite their source target in
source order; the River Foam debug writer later replaces SimGridRT with
speed/curvature/vorticity criteria and WaterHeight in A.

Bind `materialGrid` and `materialNormal` to the shallow material textures.
Each W-by-2H atlas contains current in its upper half and previous in its lower
half, clamped within that frame. Canonical `grid`/`normal` and stage captures
remain W-by-H source RTs. Mapping is 2x2: row 0 is current, row 1 is previous.
Render copies accepted Grid,
Normal and Mapping before a shallow writer, and the RGBA normal/height before
an Ocean writer. Ocean's `materialNormal` is a separate N-by-2N frame atlas;
its canonical `normal` remains N-by-N. Initialization/reset seeds previous from the completed current
writer; paused or held rendered frames converge previous to current. Both
deformation frames sample their own mapping and normal, including opposite
sides of a moving patch boundary. Explicit Ocean displacement combined with
Gerstner adds their normal offsets as an Engine material adapter policy.

Use the [simulation project](../../apps/water/r7-advanced-shallow-bake-fft/README.md) for
the authored timestep and foam settings.

## Synchronous Buoyancy and Basic DI

`WaterPontoonSet` is a saved Scene root component (`configurationVersion: 1`).
Its radius array defines pontoon count (1 to 32); `anchorsM` has three values per
pontoon. Relative mode forbids socket references. Socket mode requires one live
descendant entity per pontoon and interprets anchors as world socket offsets.
The runtime resolves local socket hierarchy against the current native root
pose on the fixed timeline, independent of render interpolation. Radii are
world meters. `enabledPontoons` is empty (all enabled) or one 0/1
per point. Unknown old placeholder fields fail normal Scene schema admission;
there is no legacy Body selection or nearest-water fallback.

The water Scene plugin installs `waterBuoyancy` between `physicsSyncBackend`
and `physicsStepSimulation`. It consumes the previous completed root sensor
roster, current accepted dynamics and fixed wave time. Collision/Scene revisions
must resolve exactly; non-water and stale candidates remain visible in traces.
Candidate queries use bottom-minus-1 m and select the first maximum immersion.
Sprung fractions, speed ramp, signed vertical damping and pre-fraction force
cap precede native sphere-center point force. The default relative-center sprung
calculation subtracts local COM in both relative-center transformations.
The two-support and aligned-axis branches retain source thresholds in meters,
double intermediates and float-stored coefficients. A singular one-axis helper
retains its source fallback and succeeds with `coefficientSolve.diagnostics`, without
renormalizing fractions. General singular support and negative stored fractions
fail with a structured source error.
Synchronous River uses only the configured velocity pontoon; its acceleration
and horizontal drag multiply accepted body mass, while angular acceleration
multiplies the actual world inertia tensor. Async shore-push logic is separate.

Read runtime `WaterBuoyancy` for current full per-point numerical traces and
admitted `forceEvents`. `splashWakeEvents` publishes only after the named step
completes writeback/collision synchronization; VFX consumes it subsequently.
Each immutable event retains the query time, fixed delta, root generation and
selected Body generation from that force snapshot. `positionM` is the pontoon
center. Its closed `contact` value either explains why no water-plane contact
exists or supplies the plane-intersection position, circle radius and velocity
relative to the selected water flow. The velocity includes the root's angular
motion at that contact point. Tangent, wholly submerged, above-surface and exit
samples do not manufacture a contact footprint. Consumers add their World
identity when extracting the event; they must not join a later mutable trace.
The pure `stepWaterBuoyancy` owner requires an explicit
`WaterBuoyancyCoefficientCache` per admitted configuration. Runtime retains one
cache per participant and native root generation. Enabled masks reuse their
first solve, including its original COM and socket-parent-local inputs; animated
sockets, COM motion and force-setting edits do not invalidate it. Component
recreation or authored geometry changes reinitialize the cache. Complete solve
evidence records invocation status, branch, attempted weights and actual inputs.
Nonfinite coefficient positions or native COM reject before solver invocation or
cache reuse, including the single-support branch.
Mask zero is an inactive step without queries or force submissions. Disabled
points retain their last enabled wet sample, so re-enabling compares against
that sample. An enabled participant without Physics returns a structured error.

### Async Solver Buoyancy

Async Water requires the backend's Worker solver results, global
`WaterBuoyancy.asyncEnabled`, and the root's saved `useAsyncPath`. Otherwise that
root uses the synchronous force path. Runtime submits immutable Water POD bytes
at the accepted root generation/source-step fence. The actual solver Worker
rebinds pontoon centers to its native pose, queries the captured Water snapshot
and Terrain collision roster, applies native point forces/torques, then integrates
that exact step. Solver-safe queries exclude Baked data, authored exclusion
volumes and game-thread query callbacks; River depth retains its spline source.

The versioned byte codec rejects malformed, nonfinite, oversized and stale input
or output before native access. Configuration, root, Water, collision and ground
generation changes invalidate affected tasks. Cancelled inputs remain retained
until the native reader acknowledges them. Completed outputs retain separate
wave reference time and solver timestamp. A bounded timeline reports current,
next and alpha against the Physics results clock; current pontoon state is copied,
not blended. Only completed, still-current identities publish splash/wake events.
Solver input is `forgeax-water-solver/3`, including local residual query fields; output is
`forgeax-water-solver-output/2`, including the detached contact snapshot. The
decoder rejects output version 1 and inconsistent event/trace identity, time or
contact geometry before publishing any events.
See [Physics solver participants](../physics/README.md#solver-participants) and the
[async buoyancy app](../../apps/water/r5-gpu-mesh-async-pontoons/README.md).

`queryWaterParticle` implements the basic CPU DI pins with an explicit
`WaterParticleQueryInstance`. Tick the instance with the system position and exact
Body generation/time, then query particle positions with ExecuteQuery,
IncludeDepth, IncludeWaves and SimpleWaves pins (all default true). System depth
is evaluated once per tick by default; the Engine `depthQueryMode` adapter can
select particle depth. IncludeDepth=false always outputs zero, even if actual
waves implicitly compute raw query depth. The plane normal remains independent
of the full-wave surface normal. ExecuteQuery=false or an absent component
returns invalid default outputs; GPU requests return
`water-gpu-particle-query-unsupported`. See the
CPU DI guide.

`WaterFoamMaterialInput` keeps independent static maps, dynamic producer and
Baked references/generations. Disabling one producer removes only its binding.
The renderer's actual `meshMaterialBindings[].waterFoamInputs` inspection derives
static references/versions, effective switches, reflected FoamRT consumption and
no-simulation initialization from the accepted material closure and view graph.
Effective switches come from the resolved material snapshot, including inherited
values and explicit child overrides. When Baked is enabled, `bakedSource` reports
`provenance-unavailable` when the inspection boundary has no grid binding identity.
A BeachFoam consumer without simulation uses the graph-owned `(0,0,0,1)` target.

## Pack input boundary

> [!IMPORTANT]
> `.pack.ts` water sources are authored in meters, XZ-horizontal and +Y-up. `buildWaterPackOutputs` validates/freezes and emits runtime payloads without unit conversion.

| Pack source | Water payload contract |
|:--|:--|
| `.pack.ts` schema `2.0.0` | Authors ForgeAX m/XZ/+Y payloads; water producer validates and freezes them. |
| Editable `.pack.json` schema `3.0.0` | Carries the same ForgeAX m/XZ/+Y coordinate convention. |

Both source forms use the Pack v2 transport envelope. Its transport version is independent from the authoring schema version.

Author spline interpolation as `water-spline/2`, shallow stages as
`water-body-shallow/2` or `river-shallow/2`, and the standalone spectral algorithm
as `ocean-spectrum-fft/2`. Admission translates supported earlier saved labels
without mutating caller data. Existing geometry digest version 1 keeps its
original projection; unknown labels and modified geometry still fail validation.
The capability report, its device/renderer facts and Brush Terrain manifest
publish version 2; the Water Pack producer identity is `water-runtime/2`.

## Scene and material status

`WaterBodyInstance` and `WaterZoneInstance` are reconciled from live Scene entities. A body snapshot is keyed by Scene entity identity and records its source asset GUID separately, along with the world matrix in meters. Body spline points remain actor-local. A Zone asset GUID may have only one live Zone actor; duplicates are reported as ambiguous and do not bind.

Runtime pairs collision-enable changes on a live source-owned River with the matching Native collision publication. A saved disable stages an empty collision candidate and commits the new Water source only after Native publishes its empty receipt; a failed preparation or admission keeps the accepted River source and collision intact for retry. Re-enabling follows the same pair-before-commit rule. Material-only or source-version reloads retain the accepted Bake and Native receipt when the collision geometry and full Scene matrix are unchanged. To replace a source-owned River with another Water Body kind, remove its `WaterBodyInstance`, wait for Native source retirement, then mount the replacement; a direct kind replacement is refused while the River owns Native collision.

Spline metadata has four independent curve defaults: width `20.48 m`, depth `1.5 m`, velocity `1.28 m/s`, and audio intensity `1`. Authored sources may persist `spline.metadataDefaults`; omitted defaults resolve to these engine defaults. Interior metadata insertion uses stable curve interpolation. Geometry insertion preserves the existing Hermite path by splitting endpoint tangents across each new key span. Append inherits the last point, while fixup fills absent curve values from their corresponding defaults, clamps width/depth to a `0.000001 m` floor, and assigns sequential input keys. Changing a default propagates only to points nearly equal to the old default (length-curve tolerance expressed in meters); nearly equal old/new defaults are a no-op. `migrateLegacyWaterSplineMetadataDefaults(..., '2.0.0')` is the explicit schema-2 migration path: it records the four defaults and repairs the legacy width `0.008 m` and zero-depth sentinels. Ordinary source validation does not apply this migration and requires each spline input key to equal its point index.

Spline interpolation has an explicit compatibility boundary. Unversioned legacy sources keep their authored Hermite tangents. `spline.interpolationVersion: 'water-spline/2'` selects versioned spline evaluation: supported point modes are `linear`, `curve` (the default), `curve-clamped`, and `curve-custom-tangent`; absent per-point modes resolve to `curve`. Versioned sources carry normalized engine-basis XYZW rotation quaternion keys, plus quaternion controls for custom-tangent points. The quaternion is the single orientation authority: the required `up` field must mirror its rotated engine Up axis, and `rollAngle` must be zero because authored Up/Roll have been baked into the quaternion. Contradictory orientation data is rejected. River reparameterization uses five-point Legendre-Gauss segment integral, then linearly inverts the ten-step table; the table length and 5 cm adaptive polyline error use the Body world matrix's linear transform when available, while emitted positions remain body-local. Unsupported point modes and incomplete versioned orientation data are rejected at source validation. Water metadata curves remain linear between keys. River WaterInfo/brush/query uses the evaluated rotation's Up vector to calculate a horizontal lateral; the traditional visible spline mesh and its collision use the component's fixed Y-up, zero-roll frame. River vertex flow angle is body-local and a Scene consumer must add actor yaw before interpreting it in world space. Closed final segments continue to input key `n` before wrapping to the first point.

## Wave and Query Contracts

`queryWaterBodySnapshot` operates on one accepted Body snapshot. `ComputeDepth` and `ComputeImmersionDepth` imply location; `IncludeWaves` requires a location/normal/depth/immersion companion and `SimpleWaves` requires `IncludeWaves`. The flags are rejected at the ForgeAX entry when these combinations are invalid. A valid wave set on a wave-supporting body adds location and depth; without actual waves, `IncludeWaves` stays set and does not add those fields. River has no Gerstner query waves. Requested/implicit values are listed in the result's `valid` set; exclusion returns an input-height plane with zero immersion/velocity. If `IncludeWaves` is requested, `waveInfo` remains readable with default values, but no wave sample is evaluated; callers must treat water surface data as invalid when excluded.

`WaterSystem.queryBody` accepts query parameters only; caller-supplied `input.baked` is rejected. Baked query data must first be accepted with `publishBakedQueryGrid` for the current mounted Body generation, and the system supplies that published closure internally. Publishing requires `enabled`, `componentValid`, and `dataValid` to be true plus a finite, dimensionally valid grid; a disabled source is not a publishable value. Disable it with `clearBakedQueryGrid(guid, bodyGeneration)`, which removes the source only for the current generation in that owning `WaterSystem` and reports whether a source was present. Missing Bodies and stale generations return structured errors; a stale source is not used by queries for a newer generation. The Scene-local Body owner scopes the source, so no Zone binding is required for a standalone Body query. The standalone `queryWaterBodySnapshot` helper continues to accept explicit baked data for pure algorithm checks.

The admitted query route produces only `WaterQueryBodySnapshot`; it does not construct output statuses, receipts or dirty-set observations. `WaterTerrainQueryResolver` receives this query projection with a newly resolved, detached Zone binding. Full `snapshot()` observations remain independent, and held query projections retain their accepted Body and Zone values after later updates.

CPU full Gerstner evaluation keeps the input XZ fixed for the query and uses a two-sample horizontal-displacement zero crossing per wave; the simple path sums only `A*cos(phi)` and leaves the base normal unchanged. CPU horizontal `Q = steepness/k` (meters) and GPU `q = steepness/(A*k)` (unitless) remain distinct. GPU LWC phase uses the 20,971.52 m tile split and a 4 m edge blend. WaterMesh tile schema v8 uses a 96-byte record: the 80-byte tile/transition/coverage record adds CPU double-computed observer-relative tile XZ, `maxMorphLod` at byte 88, and `flatFarBoundaryMask` in the low four bits of byte 92 and an optional draw-local continuity word offset in the upper 28 bits. Morph and coverage stay in tile-local meters, and wave phase adds the target-relative tile offset without subtracting large world coordinates. At frame upload, a transition target's generation-qualified WaterBody row replaces its temporary render index. The source Body supplies material height, depth and velocity; the target supplies wave phase, time and wave range. This material split is independent of the tile/base-height and morph selection. Each near tile's body footprint is clipped in tile-local double precision; tile-local meter rings are tested with even-odd fill after LOD morphing, preserving partial leaves and holes without comparing large absolute `f32` positions. River uses its cooked spline query footprint for tile selection and clipping. Custom WaterMesh opt-in projects only triangle-list/triangle-strip triangles from the resolved Cooked override mesh into local XZ and unions those projections into digest-verified rings; query and collision footprints never substitute for that product. Candidate bodies are partitioned in effective-priority order; River transition tiles split into disjoint river-only, river/target intersection, and target-only geometry regions, each with its matching body/material. The layout receipt hashes both fixed records and coverage bytes. Flat-XZ WaterMesh surfaces accept Body translation, yaw and scale, and reject Body pitch/roll because the current tile ABI stores one water Y per tile. Ocean far tiles retain the original owning Ocean `baseHeightM - maxWaveHeightM` placement and its separate conservative wave envelope for culling. View-window selection does not automatically override this saved lower-plane design. They bypass WaterInfo height mapping and Gerstner displacement. The near quadtree uses the snapped Zone center and per-axis power-of-two half extents, while the eight far tiles retain the static Zone bounds as their inner edge. A no-Ocean Zone must pair Zone-local `farWaterLevelM` with `farOwnerBodyGuid`; the latter is a deferred source GUID reference that is not a Pack dependency edge because the owning Body points back to its Zone. At publication time it must resolve case-insensitively to exactly one visible, bound, WaterMesh-participating Body instance in the Zone; the Body supplies the render route only, and its height is not used. Each unique WaveSet asset is uploaded once per view and shared by referencing bodies across Worlds; it is limited to 4,096 waves. Distinct WaveSet assets may exceed 4,096 combined, subject to device storage-buffer limits. Upload fails without truncating ranges. Baked samples use strict interior grid coordinates; points outside that interior yield a zero sample. A valid Baked source supplies its selected fields without an additional Terrain query; flat Lake/Ocean surface height and normal remain based on the body plane.

Stock Water deformation retains near waves at far boundaries. It does not blend
current/previous positions or fragment normals toward a mean plane. The existing
four-bit adjacency metadata remains in the versioned tile payload; it does not
authorize automatic flattening. Explicit saved no-Ocean levels remain authoritative.

WaterMesh LOD selection uses nearest node AABB distance. `RawLOD = treeDepth - node.depth` denotes spatial tile size, `LogicalLOD` is the first eligible ancestor level at the distance threshold, and `DensityDelta = LogicalLOD - RawLOD` selects `max(2, NumQuadsLOD0 >> DensityDelta)` quads per edge. The density is capped at the available grid levels; morphing stops at `maxMorphLod`, the lesser of the spatial tree limit and that density limit. Height morph contributes only to the first selected level. Morphing continues through the remaining available levels when each preceding factor has reached one, so mixed-LOD edges remain continuous at the valid minimum `lodScale` of 0.5. This extension stores one maximum level per tile, needs no neighbor table, exits as soon as a stage is incomplete, and samples Gerstner waves only after the final morphed XZ is known.

> [!IMPORTANT]
> Rendered WaterInfo is published through versioned graph targets per view, device generation, and format. Extraction prepares generation-qualified rows against a candidate target; only the frame submission callback promotes it. When the source digest, format, dimensions, layer count, and slice assignments are unchanged, the submitted target and its content receipt are reused without rebuilding raster geometry or dispatching raster, merge, blur, finalize, or clear passes; only the graph retention edges remain. An aborted or rejected candidate leaves the prior publication and target mapping active, and the next extraction retries changed source data. Candidate writes use a distinct physical target, while previous target views remain sampled and keep the same storage/sample usage signature through graph replacement. The compiled graph retains matching allocations and retires replaced generations only after their queue fence. Previous rows, wave closures, and targets remain available exactly while the per-view committed WaterMesh proxy roster references their stable World/body/Zone generations; deletion, detach, or proxy retirement drops those references. Retained wave closures continue advancing Time/PrevTime until their proxy is replaced.

WaterInfo `waterYMinM` and `waterYMaxM` come only from bound Bodies with `affectsWaterInfo: true`, using their accepted WaterInfo mesh bounds plus the authored wave extent. Other bound Bodies still receive current WaterInfo descriptor rows and fixed-height wave inputs, but their height and wave bounds do not widen a participating Zone's range. A Zone with bound Bodies but no WaterInfo participants submits an empty-water capture so fixed-height rows are current and prior water/dilation pixels do not survive. Its synthetic `waterYMaxM` is at least the Terrain `groundMax`, which lets ground A round-trip high terrain while B remains zero because there is no water or dilation geometry; without Terrain, the empty interval remains `[0, 0]`. An empty Zone publishes no capture. Ground A uses the shared `waterYMaxM` normalization and decoding formula. When a participating water range lies below `groundYMinM`, the encoded ground value clamps to its representable range. With no Terrain, the ground minimum is `waterYMinM - 30 m`, preserving the fallback ground sentinel. Dirty or unaccepted participant geometry continues to defer the Zone capture and retain its last submitted publication until current geometry is accepted.

For local tessellation, the view center snaps to the Zone `tileSizeM` in world meters, including the Zone's horizontal transform scale. The same snapped center and transformed Zone extent feed both raster coordinates and the material descriptor; both are part of the source digest. Blur neighborhoods clamp to the image edge, matching clamp-to-edge sampling and preventing out-of-range zero loads from entering the flow average.

The CPU query blends the base normal and the computed full-wave normal with the depth attenuation factor and does not normalize the Lerp result; height attenuation is applied separately at the caller. Lake and Ocean base normals are transformed body Up (`[0, 1, 0]`); River and Custom use evaluated spline Up.

WaterInfo material sampling clamps world-to-UV to the normalized image bounds, then bilinearly reconstructs the four neighboring texels at their centers with clamp-to-edge behavior. Cosine UV weighting is disabled. Material height, depth and wave attenuation decode raw bilinear B, including empty texels. For GPU vertex height mapping, B=0 is excluded from that interpolation and the remaining B weights are normalized before decoding; an all-zero neighborhood keeps the tile base height. RG/A retain ordinary bilinear filtering. This prevents empty WaterInfo texels from pulling a River shore toward `waterYMinM`. The encoded B=0 sentinel intentionally remains ambiguous with a valid sample exactly at `waterYMinM`: the decode treats both as no water and returns ground height minus 2.56 m. GPU height interpolation excludes the empty sentinel.

> [!IMPORTANT]
> Migrating an unversioned spline to `water-spline/2` requires baking its complete rotation (tangent alignment plus authored roll) into each normalized `rotationQuat`, then deriving `up` by rotating engine Up `[0, 1, 0]` by that quaternion and setting `rollAngle` to `0`. For example, a 30 degree roll around engine Forward `[1, 0, 0]` uses quaternion `[sin(15*pi/180), 0, 0, cos(15*pi/180)]` in XYZW order, with `up = [0, cos(30*pi/180), sin(30*pi/180)]`. Do not copy an unversioned `up` vector and retain a separate nonzero roll in a versioned spline.

Ocean geometry triangulates only the island AABB extended by `0.01 m` and stitches its annulus to the visible extent with eight welded quads. `oceanExtentM` describes the visible surface; collision uses separate world-axis half extents. `centerOnWaterZone` defaults to `true`. A Zone-bound Ocean in that mode must persist `savedZoneLocationWorldXZ` and provide its frozen Pack `bodyWorldTransformsM[sourceKey]`; Pack inverse-transforms the saved world point and publishes only the derived cooked `oceanCenterM`. When the Zone is unloaded, the saved location remains authoritative. `centerOnWaterZone: false` explicitly selects body-local zero. Source authors cannot provide `oceanCenterM` or `geometryAuthoringWorldMatrixM`.

Lake visible bounds and WaterInfo CDT products remain separate; bounds include Hermite curve extrema, not only authored control points. Lake's visible static mesh is cooked as a world XZ AABB at its Pack authoring transform, then inverse-transformed into body-local vertices so Scene applies the full actor transform exactly once. Cooked Lake/Ocean payloads retain `geometryAuthoringWorldMatrixM`. A Scene transform change that would invalidate this world-dependent geometry reports `requires-recook` and keeps the prior accepted transform, mesh, query and Physics state until a new Pack publication arrives. Lake translation remains valid because it translates the already world-aligned local mesh without changing its bounds; rotation, scale or shear requires recooking.

Pack outputs mark this contract with `waterGeometryVersion: 2`; cooked bodies without the field use the explicit legacy path and may omit the dilation GUID. V2 WaterInfo bodies require the undilated mesh and, when ShapeDilation is positive, a separate `dilatedWaterInfoMeshGuid` for the dilated product. River's product contains only the side dilation bands and terminal cap extension, carries no River flow overlay, and derives vertex normals from the emitted triangles; Lake and Ocean products contain the complete polygon after a `ShapeDilationM / 2` offset and CDT. The polygon offset uses Clipper2 Miter joins with a 2.0 limit for sharp outer corners. The color and dilation passes consume separate assets. Footprint and topology unit fixtures cover straight and tilted River, square and concave Lake, and island Ocean cases.

For V2 dilation admission, the separate dilation GUID requirement applies to River, Lake, and Ocean products. Custom opt-in WaterInfo remains undilated-only and has no dilation GUID.

## Material Family

`buildWaterMaterialFamily` authors ordinary root/child MaterialAssets; the
mounted Engine Content library exposes their GUIDs through
`EngineContent.water.materials`. `waterMaterialFamilySlots` derives the Body's
surface, WaterInfo, LOD and underwater references, plus River transitions.
Assets Runtime owns inherited parameters, static switches and atomic material
publication. Zone `farMaterialGuid` uses the same dependency loader and parent
closure.

The stock underside graph uses ordinary inherited `criticalAngleDot` (default
`0.225`) and `refractionBottomAmount` (default `1`) independently of `specular`.
Changing surface specular does not move the critical-angle threshold; bottom
amount blends the underside refraction input from `1` before the lip response.

`waterVertexMapping` controls vertex height mapping independently of fragment
WaterInfo/Baked/fixed-height reads and Gerstner waves. It defaults to true for
authored roots. The stock root/near/transition family enables it; Custom,
every LOD, far and HLOD disable it. Far directly inherits the root, disables
waves and WaterInfo, and selects fixed height/depth; HLOD inherits far.
Custom LOD is the Engine extension and inherits Custom.

`waterDynamicBoundsClip` is a separate author choice, default false for
arbitrary roots. The stock root and River/Lake/Ocean LOD branches enable it;
Custom, Custom LOD, far and HLOD bypass it. The selected branch uses
`WaterBodyData.dynamicBoundsCenterExtentXZ` and post-WPO fragment position.
Its optional center/full-extent tuple comes from the exact bound Zone generation
and the same per-view camera snap used by WaterInfo capture. Actual submitted
capture bounds take precedence and remain with retained Body closures. A Body
without a bound Zone omits the tuple; its encoded zero extents bypass clipping.
Bounds publication requires no WaterInfo descriptor or texture. The 128-byte
Body row appends the tuple at byte 112 and preserves every preceding field.
With WaterInfo enabled it rejects points outside the inclusive bounds; with
WaterInfo disabled it rejects the strict interior. Both branches retain the
boundary. Neither mapping nor the material's family name selects this behavior.

A Body surface may use a published Forward Standard, single-layer-medium or
single-layer-water Surface ABI. Canonical Water deformation and Water system
inputs are independently optional; a Surface that only reads WaterInfo does
not need a deformation declaration. The compiler's entrypoint reflection owns
the actual binding subset and stage visibility.

Every accepted Body can publish generation-qualified fixed/Baked GPU inputs
without a Zone or texture. Real submitted WaterInfo rows take precedence for
their owners. A material that requires WaterInfo still needs its real same-view
descriptor and target; an independent source never creates a placeholder
texture. Previous wave time advances only after the consuming submission.

Every GPU Body row retains its fixed height, depth and horizontal velocity even
when its source mode selects WaterInfo or Baked data. Fixed depth uses spline
key zero's nonzero depth, otherwise Body `fixedWaterDepthM` (default `5.12 m`).
These are fallback inputs, not the effective sampled values. Pack validates and
preserves the optional Body field; material parameters do not own that default.
CPU terrain and query depth rules remain independent. WaterInfo feature-input
wire v6 carries the fixed inputs in every source mode, detached GPU mesh sources
with flat-far boundary masks and exact owner-qualified
WaterInfo source availability. The dependency snapshot derives pending and
failed states from the Runtime loader's current request. Only an in-flight
dependency defers prepared Water; missing, failed or incompatible inputs remain
explicit failures. Availability metadata never creates a descriptor or target,
and older WaterInfo input versions are rejected. `waterGeometryVersion: 2`
continues to version geometry products only.

Material static switches select Baked, WaterInfo and fixed data independently
of resource availability. `waterBakedSimulation` defaults to false; publishing
a Baked grid does not enable it. A submitted WaterInfo Body retains its real
Baked grid in the same generation-qualified publication when one is available.
`waterFixedVelocity`, `waterFixedHeight` and `waterFixedDepth` override only their
own field. Without fixed velocity, Baked or WaterInfo, a surface reads its
vertex flow rather than the Body's key-zero velocity.

The stock/shared family enables WaterInfo and disables all three fixed
switches. River/Lake/Ocean LOD children disable WaterInfo and retain those
fixed choices. Custom surface and Custom underwater disable WaterInfo,
enable fixed height/depth, and leave fixed velocity disabled; Custom LOD is
a ForgeAX extension inheriting the Custom surface choices. Every default
family branch leaves Baked simulation disabled. Underwater's no-Info velocity
decodes white fullscreen vertex color: maximum flow magnitude and angle
`2*pi`, independent of the Body's fixed velocity.

Root flow defaults are `flowmapDepthBiasM=0.64`,
`flowmapDepthDensityPerM=0.3` and `flowmapSpeed=0.003`; River and its inherited
transition/LOD branches use `0.96`, `0.5` and `0.002`. River's connected flow
normal UV denominator is `riverNormalTilingM` (root `5.12 m`, River `15.36 m`).
Ocean BeachFoam independently uses `foamTilingM=15.36 m`, including on the
River-to-Ocean branch. `simulationFoamContrast` stores root `0` and Lake `0.2`;
the native simulation-foam path is disconnected and these values have no live
shader consumer in this contract.

`waveVelocityMaskThresholdMPerSec` is the transition wave-mask divisor, default
`1 m/s`. It remains an ordinary inherited material value and can be overridden
independently of the maximum decoded vertex-flow speed. Selected default
transition deformation requires its `f32` declaration; vertex-flow fallback
also requires `maximumFlowVelocityMPerSec: f32` unless fixed/Baked velocity
statically takes precedence. The compiler rejects an incomplete contract before
shader compilation rather than supplying a zero flow.

The Water-only Surface ABI carries `pixelDepthM`, the original pre-WPO normal
and position, pre-Water scene depth, decoded vertex flow and `wavePhaseXZ`.
The stock deformation recomputes the complete Gerstner normal per fragment:
phase and source depth use no-WPO coordinates, while transition velocity masking
uses post-WPO position. Target Body rows select waves and time; source Body rows
select depth and velocity. WaterMesh phase derives from small interpolated
morphed coverage plus CPU target-relative tile offsets before wrapping; custom
deformation and far tiles retain their own normal. Refraction uses
dimensionless `refractionPixelNormalStrength` and `refractionDepthBias`;
`physicalIor` is a separate Specular/F0-derived optical input. Generic medium
Surface and Water deformation ABIs keep their independent authorities.

The connected Ocean foam branch reads static foam/normal textures, genuine
3D volume noise, and the graph-owned FoamRT. A scene without simulation selects the
`no-simulation` graph input, which initializes a 512x512 linear `rgba16float`
target to `(0,0,0,1)` before sampled reads with the renderer's linear/repeat
height sampler and linear/clamp foam-amount sampler. It has one mip and no simulation solver. Simulation producers supply the same semantic target through the existing graph input and lifetime.
The graph initializes the target before material draws. With no producer, R is zero.

SLW reuses the normal-oriented Skylight diffuse input. Volume ambient consumes
that E/pi input times one quarter before the scattering integral; surface AO
uses the existing Standard receiver and does not attenuate volume ambient.
Precomputed bent-normal visibility needs its own existing lighting producer;
the current renderer has no such producer and uses unoccluded sky visibility.

Generated River segment meshes carry the same RG flow encoding as their
WaterInfo product, sampled from evaluated spline direction and linear metadata
at each longitudinal section. The Water wrapper decodes and transforms that
local flow before interpolation, and preserves raw `vertexColor` alongside the
decoded `vertexFlowXZ` Water input. The material's
`maximumFlowVelocityMPerSec` scales the interpolated flow (default `10.24`).
The ordinary mesh color layout and cooked color variant supply that stream.

`lodMaterialGuid` supplies the ordinary `materialSlots[].defaultMaterial` on
Pack-generated River segment, Lake and Ocean visible static meshes. Only an
omitted LOD slot derives `surfaceMaterialGuid`; a failed explicit reference
follows ordinary asset availability and last-good handling. The shared
WaterMesh uses the Body surface material, Custom override meshes use their
surface route, and the Zone far material remains independent. Runtime scenes
attach the generated meshes through ordinary MeshFilter/MeshRenderer entities.

`Camera.postProcessing` defaults to true. When false, Water resets view
selection, intersection, visual intent and immersion to the outside sentinel
`-0.01 m` before physics sweeps. The runtime Update consumer derives audio
edges from the stored view state; rendering does not emit gameplay events.
Visual underwater intent, intersection and audio immersion remain separate
facts. Source intent survives pending GPU/material preparation.

Custom sources default `affectsWaterInfo` and `affectsWaterMesh` to false and produce no shared WaterInfo or WaterMesh outputs. As an explicit ForgeAX extension, `affectsWaterInfo: true` with a `customMeshOverride` produces only the undilated WaterInfo mesh. Custom has no dilated mesh product, so it must not publish a dilation GUID or derive dilation from its query/collision footprint. `affectsWaterMesh: true` is also opt-in, requires `customMeshOverrideGuid`, and uses the Cooked override triangle projection as its WaterMesh footprint. A Custom body without a mesh override has no visible water geometry.

The optional Brush manifest applies priority/name sorting only to Bodies. Island actors follow afterward in the frozen `orderedActors` registration order. Reordering Island registration is a semantic input and changes the recipe digest. The manifest describes capture inputs: water bodies consume a separately planned TerrainProvider and do not automatically sculpt or republish Terrain.

For optional Render Brush capture, a Body source is frozen as canonical UTF-8 JSON bytes of its Pack `WaterBodyAsset` payload. The capture owner parses and runtime-validates those bytes and uses that decoded asset as its only Body source. `actorInputDigests[actorId]` is SHA-256 of the canonical capture projection, which omits the composite-only `shapeDilationM` and its derived `dilatedWaterInfoMeshGuid`; `captureProvenance.sourcePayloadDigest` binds the complete Pack JSON bytes. The raw payload digest is excluded from the actor capture cache key, while dilation remains part of the composite input/key. Mesh inputs use exact Pack mesh binary bytes plus the frozen reference table; Geometry decodes the MeshAsset from those bytes before capture.

Cooked Ocean geometry publishes a digest-verified query footprint with island and exclusion holes, independently of collision enablement. Enabled Ocean collision uses its separate finite 3D descriptor and world-axis extents; the Physics candidate subtracts intersecting exclusion volumes as convex differences. Runtime reconciles that accepted collision generation through the ordinary Physics owner. Query, visible surface and collision footprints remain separate products.
