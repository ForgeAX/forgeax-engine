# @forgeax/engine-vfx

Runtime-safe contract for code-first GPU particle effects. Authors write emitter metadata plus two WGSL functions; the engine owns allocation, scheduling, compaction, indirect drawing, recovery, and asset transport.

> [!IMPORTANT]
> Particle behavior is code, not an operator or node graph. Runtime players consume cooked programs and never compile WGSL.

## Ownership

Cooked stage reflection derives its source metadata from `ParticleStageSource`; renderer reflection derives shared source fields and makes normalized defaults required. GPU program and asset contracts inherit the portable runtime payload, retaining only fields that cooking narrows or adds.

The machine-readable asset boundary is
[`schemas/asset-authority.schema.json`](../../schemas/asset-authority.schema.json). Author source
and its WGSL module are authoritative; native cook produces the Pack payload and
asset-local program artifact, while Catalog and runtime state are derived
projections. Lifecycle evidence therefore runs from source validation through a
successful cook receipt and runtime fingerprint check. A stale or missing
artifact must be cold-cooked instead of being treated as current.

| Package | Owns |
|:--|:--|
| `@forgeax/engine-vfx` | Source validation, cooked asset loading, `ParticleEffectPlayer`, per-frame Update intents, deterministic spawn scheduling |
| `@forgeax/engine-vfx-compiler` | WGSL composition, import resolution, Naga validation, reflection, deterministic cook |
| `@forgeax/engine-vfx-render` | Persistent GPU state, compute passes, fixed-bounds culling, billboard/mesh projection, indirect draws |

`AssetRegistry.load` and `create` return the reference bound to `ParticleEffectPlayer.effect`.
The asset owner retains exact definition versions for Players, queued ticks and submitted
emitters. A managed definition edit is adopted at the next update: playback starts a
new cycle and rebuilds its reflected instance. Existing queued ticks retain their previous
definition and parameter bytes until acknowledgement. Unchanged paused Players retain their
accepted definition without polling assets; resume, replay, or an explicit Player change adopts
the current definition at the next update and keeps a pending reset for the next dispatch.

Queue acknowledgement transfers or releases a version lease directly. Replaced emitter IDs
leave retained state while their queued ticks remain ordered. Recovery, Player removal and
plugin disposal release the corresponding leases; there is no scan to infer live definitions
and no consumer-created asset identity. Render publication sends each held `(asset, revision)`
once, separately from current asset rows, and retires it after its last queued or retained use.
Code-created and loaded effects have the same capture and lifetime rules. At admission,
renderer Material/Mesh and vector-field Texture references resolve to this asset owner's handles;
the effect holds those dependencies through updates and replacement. Player-local Mesh sources
remain an explicit instance binding. Writes to creator input or public copies do not change
playback; use managed updates or replacement. The installed decoder synchronously validates
`assets.create`, `update` and `replace`, links references, and derives emitter summaries and
program/layout fingerprints; callers never maintain those derived fields. Source loading first
checks cooked artifact integrity through `prepareVfxGpuEffect`, then uses the same admission.
Admission checks descriptor consistency against canonical compiler-produced WGSL, including
complete reflected binding coverage; it does not compile or prove arbitrary authored shader
semantics. WGSL compilation stays build-time, and native GPU preparation validates execution.
Runtime caches source digests and declaration scans within
128 entries / 16 MiB, so numeric edits process metadata without rehashing unchanged WGSL.

Player membership and controls use World change evidence. Unchanged paused updates do not
query Players or asset versions; active Players read their selected definition during simulation.
The intent queue indexes sequences by Player, so capacity checks, replay and removal never walk
other Players' queued work. Acknowledgement directly removes the named sequences; an explicit
prefix acknowledgement consumes only that ordered prefix.

## Author source

```ts
import { defineParticleEffectSourceV3 } from '@forgeax/engine-vfx';

export const sparks = defineParticleEffectSourceV3({
  schemaVersion: 3,
  emitters: [{
    id: 'sparks',
    capacity: 100_000,
    backend: { required: 'gpu' },
    space: 'world',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 12 },
    schedule: { rate: 20_000, bursts: [{ time: 0, count: 2_000 }] },
    program: { module: 'sparks.vfx.wgsl' },
    renderers: [{ kind: 'billboard', material: SPARK_MATERIAL, blend: 'additive' }],
    simulationWhenCulled: 'continue',
  }],
});
```

The parser rejects unknown fields. This Batch A slice is GPU-only and requires
`backend: { required: 'gpu' }`; missing GPU capability fails structurally rather
than selecting a hidden backend. CPU fallback, runtime compilation, raw author
bindings, and CPU particle mirrors are not accepted. Batch B renderer metadata is
executable: billboard advanced fields, ribbon strips, trail history, and beam
endpoints each produce reflected resources and an indirect topology draw.

Optional GPU collision imports `forgeax_vfx::data::scene_sdf` in the update
module. Cooking reflects its closed `vfx:scene-sdf` requirement; the
[VFX Render host](../vfx-render/README.md#managed-scene-sdf-collision) supplies
the World range and Renderer owns the field. The player and update contract
remain realm-neutral: no field bytes, RHI objects or CPU particle mirror enter ECS.

New authoring tools may use `PARTICLE_CODE_DEFAULT_MODULE_ID` as an immediately
cookable seed. The compiler owns that minimal WGSL module; advanced effects name
game-authored `.vfx.wgsl` modules and remain code-first.

A mesh renderer selects exactly one draw surface with `submesh` (default `0`):
`{ kind: 'mesh', mesh, material, submesh: 2 }`. An out-of-range index fails
preparation instead of silently drawing another submesh.

For geometry produced by the World, author `mesh: { source: 'player' }` and put
the existing `MeshFilter` on the `ParticleEffectPlayer` entity. The filter's
runtime Mesh reference is the geometry authority; different Players can bind
different meshes to the same immutable cooked effect. `assets.writeRange`
updates use the ordinary asset projection. A missing filter or unresolved handle
fails extraction with the owning component/asset error. The authored bounds must
enclose the selected geometry, and `submesh` retains its usual meaning.
Only the material is a static GUID dependency for this source. Do not add
`MeshRenderer` unless a separate ordinary Scene draw is intended.

`schedule.warmupSeconds` optionally pre-rolls an emitter on the GPU before its
first visible state. It accepts 0..10 seconds and uses ordinary managed compute
ticks at no more than 1/60 second per tick. Pre-roll retains the actual cooked
definition, parameters and device recovery path. It neither advances World time
nor repeats external channel inputs, and it does not create CPU particles.
Warmup ticks have a separate bounded reservation from normal pending-frame ticks.
Effect elapsed time includes this simulation pre-roll; World elapsed time does not.

`schedule.randomness` optionally jitters rate slots by a fraction in [0,1].
Emission times derive from Player seed, emitter identity and spawn ordinal, so
crossed counts are independent of frame partition and remain deterministic on
replay. With randomness zero, the original rate/remainder behavior is unchanged.
Bursts may declare `spreadSeconds` to distribute their count over a finite window;
when a loop is declared this window must fit inside one loop. Omitted or zero
spread preserves an instantaneous burst. Only spawn scheduling runs on the CPU;
all particle state and motion remain GPU-owned.

## Program v3 data plane

## Schema v3 authoring data plane

`defineParticleEffectSourceV3` keeps the authoring schema at version 3. Its sole
cooked GPU ABI is `forgeax-vfx-program-5`; there is no Program 4 compatibility
reader. Recook older payloads before publication.

The minimum-fidelity slice exposes a schema-driven authoring boundary through
`defineParticleEffectSourceV3`. Its fixed Core record is 112 bytes
(`VfxParticle`); effect snapshot values live in `VfxParameters`, while optional
`VfxCustom` values use a persistent GPU storage record capped at four
`vec4`-equivalent lanes. The compiler derives the WGSL declarations, reflection,
host stride, and renderer projections from these schemas. Reflected member
offsets preserve authored WGSL declaration order. Custom storage array stride
uses the struct's natural WGSL alignment; the vec4 lane count is a budget,
not an extra padding requirement (one scalar has a 4-byte stride).

```ts
import { defineParticleEffectSourceV3 } from '@forgeax/engine-vfx';

export const effect = defineParticleEffectSourceV3({
  schemaVersion: 3,
  emitters: [{
    id: 'embers', capacity: 4096, backend: { required: 'gpu' }, space: 'world',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 8 },
    schedule: { rate: 120 }, program: { module: 'embers.vfx.wgsl' },
    renderers: [{
      kind: 'billboard', material: 'ember-material', sorting: 'view-depth',
      materialInputs: ['heat'],
    }],
  }],
});
```

Schema-v3 source keeps the existing bounded `channels`/`events` and sub-emitter
path. The unused `vfx:channel` Data Interface token is not part of the v3
vocabulary; `camera`, single-sample `scene-depth`, and `noise` are
generation-owned resources and must be supplied by the renderer host.
Scene-depth is intentionally accepted only with `sampleCount: 1`; no implicit
MSAA resolve is performed.

`resolveVfxDataInterfaces` returns the accepted generation and resources on
`Result.ok`. Missing, mismatched or stale providers return the structured error
branch; there is no additional readiness flag on a successful resolution.

Mesh renderers expose semantic Quaternion/Scale3 attributes and Standard
lighting/shadow intent. Mesh and billboard both support `none`, `view-depth`,
`view-distance`, `custom-ascending`, and `custom-descending` sorting; custom
sorting requires an explicit scalar `attributes.sort` from `VfxCustom`.
Stable `timeScale: 0` players emit no simulation intents. Reset, replay,
visibility restart, parameter patches and channel inputs still execute at zero delta. Billboard, Ribbon, Trail, and Beam retain their
topology-specific projection paths. Invalid or missing semantic/material input
references fail at cook time, and undeclared Parameters, Custom, and data
interface resources do not allocate a GPU binding.

## Batch B renderers and control

```ts
renderers: [
  {
    kind: 'billboard', material: SPARK_MATERIAL, blend: 'additive',
    capacity: 4096, overflow: 'drop-oldest',
    textureSheet: { columns: 4, rows: 4, frameRate: 12 },
    pivot: [0.5, 0.25], softParticle: { fadeDistance: 0.4 }, sorting: 'view-depth',
  },
  { kind: 'ribbon', stripKey: 'alive-index', capacity: 1024, overflow: 'drop-newest', width: 0.2 },
  { kind: 'trail', historyLength: 8, capacity: 1024, overflow: 'drop-oldest', width: 0.15 },
  { kind: 'beam', endpointField: 'velocity', capacity: 256, overflow: 'drop-newest', width: 0.08 },
]
```

`ribbon`, `trail`, and `beam` have independent capacities, resource plans,
shader entry points, and indirect draws. A renderer is never silently changed to
a billboard. `textureSheet`, `pivot`, `softParticle`, and `sorting` are reflected
into the billboard GPU path; soft particles require the explicitly registered
scene-depth provider. Capacity overflow is reported through inspection.

## Author WGSL

```wgsl
#import forgeax_vfx::prelude::{
  VfxParticle,
  VfxSpawnContext,
  VfxUpdateContext,
  vfx_integrate,
  vfx_random_spawn,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  (*particle).velocity = vec3<f32>(cos(angle), 2.0, sin(angle));
  (*particle).lifetime = 1.5;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity.y -= 9.8 * ctx.delta;
  (*particle).sprite_rotation += ctx.delta * 2.0;
  vfx_integrate(ctx, particle);
}
```

The managed shell exposes this stable particle surface:

| Field | Meaning |
|:--|:--|
| `position` | Emitter-local or world position |
| `velocity` | Velocity used by `vfx_integrate` |
| `color` | Linear HDR color and alpha |
| `sprite_size` | Billboard width/height |
| `sprite_rotation` | Billboard rotation in radians |
| `mesh_orientation` / `mesh_scale` | Mesh Quaternion (x, y, z, w) and Scale3 |
| `material_random` | Stable material random scalar |
| `age`, `lifetime` | Engine advances age and kills at `age >= lifetime` |
| `alive` | Set to `0u` for explicit death |
| `id` | Stable spawn identity for addressable random |

Author modules must define exactly `vfx_spawn` and `vfx_update`. They must not declare shader stages, bind groups, bindings, or `forgeax_vfx_*` symbols. Reuse behavior with ordinary shader `#import`; imports are composed and validated at cook time.

## Time and instance parameters

Both `VfxSpawnContext` and `VfxUpdateContext` carry time, so a program never
needs to reconstruct it from `particle.age`:

| Field | Meaning |
|:--|:--|
| `ctx.time` | Player elapsed seconds (f32). Respects `timeScale` and pause. |
| `ctx.time_whole`, `ctx.time_fract` | The same elapsed time split into a `u32` whole-second part and an `f32` fraction. |
| `ctx.world_time`, `ctx.world_time_whole`, `ctx.world_time_fract` | World-clock seconds advanced by unscaled frame time. It keeps running while the Player is paused or scaled. |
| `ctx.delta` | Step delta. |

Precision: the host keeps elapsed time in f64 and uploads the split pair, so the
fraction stays exact for hours. Use `ctx.time` for short effects. For looping
visuals use `vfx_loop_phase(ctx.time_whole, ctx.time_fract, rate, offset)`
(cycles per second, result in [0, 1)); it multiplies the whole seconds in wrapping
u32 fixed point and loses no frame resolution after long sessions. A particle
that never expires uses `lifetime = vfx_forever()` instead of an arbitrary
huge literal.

Instance parameters are typed values declared once on the effect and read in any
emitter through `vfx_parameters()`:

```ts
defineParticleEffectSourceV3({
  schemaVersion: 3,
  parameters: {
    at: { type: 'vec4<f32>', default: [0, 0, 0, 1] }, // xyz position, w scale
    opacity: { type: 'f32', default: 0.4 },
  },
  emitters: [/* ... */],
});
```

```wgsl
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vfx_parameters().at.xyz;
}
```

Supported types are the scalar and vector types reflected for `VfxParameters`.
Types may be spelled `vec4<f32>` or the material-style `vec4` (likewise `vec2`, `vec3`); both mean the f32 vector. Names must be identifiers and at most 32 parameters (`VFX_PARAMETER_MAX`) are allowed. An emitter that
declares its own `VfxParameters` struct together with an effect `parameters`
table fails with a compile error; use one or the other.

Override per Player at runtime or in scene/pack authoring with the string field
`ParticleEffectPlayer.parameters`, a JSON object of name to value:

```ts
world.spawn({
  component: ParticleEffectPlayer,
  data: { effect, playing: true, parameters: vfxPlayerParameters({ at: [-138.5, -5, 36.2, 9.5] }) },
});
```

An unknown name, a wrong type or a non-finite value is reported through the
`vfx-parameters-invalid` diagnostic and the Player keeps the effect defaults.
`validateVfxPlayerParameters(json, fields)` performs the same check offline, for
example in a pack or scene validator; `fields` is the effect's declared parameter list
(`{ name, type }[]`). A change on a paused Player is validated and applied immediately,
and takes visible effect when it plays. The unknown-name error carries `detail.parameter`
(the offending name) and `detail.validNames`.

Diagnostics are read from the runtime resource:
`world.getResource(VFX_GPU_RUNTIME_RESOURCE_KEY).diagnostics()` returns every active `vfx-*` code with
its `detail`. Nothing else surfaces them yet, so poll it in tests and tools after
`world.update`. Parameters changed on a live Player are
applied on the next frame without restarting it.
## Water-grid emission and translucent sphere billboards

`waterGridEmission` plus `#import forgeax_vfx::data::water_surface` opts a
schema-v3 emitter into Water-grid GPU emission. `scanCellCapacity` bounds
examined cells and must fit the accepted domain; `maximumEmissionPerCell` is
the per-cell limit and `maxParticlesPerFrame` the total append limit. Zero
`maxParticlesPerFrame` disables only grid appends; scheduled rate and explicit
bursts remain independent. The Render host binds one generation-qualified
grid/solver-normal pair (see the
[`water-surface` owner](../vfx-render/README.md#water-surface-grid-emission)).

R8's `iron-ball-entry` effect is a separate Pack particle effect for the
cannonball water-impact response. Its source is declared in
[`coast.pack.ts`](../../apps/water/r8-integration-acceptance/assets/coast.pack.ts)
and its update module is
[`iron-ball-entry.vfx.wgsl`](../../apps/water/r8-integration-acceptance/assets/vfx/iron-ball-entry.vfx.wgsl).
The splash billboard opts into `shading: { kind: 'translucent-water-sphere' }`
to use the dedicated Engine shader. Its material input declarations are in
[`water-entry-splash-material-inputs.ts`](../../apps/water/r8-integration-acceptance/assets/vfx/water-entry-splash-material-inputs.ts).
This impact-driven effect does not exercise Water-grid emission. Material
declarations must match the current fragment-`vec4<f32>` inputs:
`subsurfaceGainOpacity`, `waterSphereShading`,
`waterSphereFlattenSphere`, and `waterSphereProjection`.

The Engine opacity adaptation computes `uvNoise = TexCoord4 * scale + ParticleRandom`,
`N = noise.r`, and `uvMask = TexCoord3 + vec2((N - 0.7) * strength)`, then
uses `SphereMask(uvMask, (0.5, 0.5))` and `Mask * 0.25 * ParticleAlpha`
before soft-particle fading. Scale and strength are conceptual Niagara pins,
not Engine field names; normal detail samples the same `uvNoise`. Engine
declares normalized-quad TexCoord3 and texture-sheet TexCoord4 projections;
Niagara UV3/UV4 tiling is unknown, and this adds no UV-editor contract. Engine
broadcasts one stable id/seed spawn scalar to both axes. UE's 128x128 repeat
pattern comes from the VF PseudoRandom math cycle, not a random texture.
The selected material instance has no overrides (inherited scale 1, strength
0.5). Engine-authored radius `0.5` and hardness `50` occupy
`waterSphereProjection.zw` in hardness-then-radius order; `.x` is the shared
random offset and `.y` is reserved. The four custom lanes are
`subsurfaceGainOpacity`, `waterSphereShading`, `waterSphereFlattenSphere`, and
`waterSphereProjection`. Source declarations alone do not prove
material cooking or runtime output.

## Load and play

```ts
import { loadVfxGpuEffect, ParticleEffectPlayer } from '@forgeax/engine-vfx';

const loaded = await loadVfxGpuEffect(assets, EFFECT_GUID); // string or AssetGuid
if (!loaded.ok) return loaded;

const effect = loaded.value;
world.spawn({
  component: ParticleEffectPlayer,
  data: { effect, playing: true, seed: 42, timeScale: 1 },
});
```

Install `createVfxRuntimeHost` from `@forgeax/engine-vfx-render`, attach each World once, and register `host.feature` with the Renderer. The host installs the decoder and the Update intent producer. Successful ECS binding retains its own reference; release the caller grant with `assets.release(effect)`.

## Authoring projection

Runtime-safe tools can inspect the cooked effect without importing the build-time
compiler or duplicating renderer schemas:

```ts
import {
  describeVfxGpuEffect,
  isVfxGpuEffectAsset,
} from '@forgeax/engine-vfx';

const payload = assets.lookup(EFFECT_GUID);
if (!isVfxGpuEffectAsset(payload)) return;

const descriptor = describeVfxGpuEffect(payload);
// descriptor.emitters: stable tree of program/stage/channel/event/renderer nodes
// descriptor.timeline: rate, bursts and loop duration by emitter
// descriptor.dependencies: module, asset and data-interface identities
// descriptor.capabilities: executable / partial / unavailable truth
```

The descriptor is immutable, UI-neutral and versioned. It preserves the authored
WGSL module ID in each cooked emitter, but intentionally omits WGSL bytes and
compiler objects. `isVfxGpuEffectAsset` owns the stable cooked discriminator at
the producer boundary; detailed artifact validation remains the asset decoder's
responsibility.

> [!IMPORTANT]
> The descriptor is an inspection/read-model contract, not a second authoring
> language. Schema-v3 source plus `.vfx.wgsl` is authoritative; the runtime
> accepts the Program 5 cooked ABI. Older payloads are rejected at the loader
> boundary and must be cold-cooked before publication.

## Runtime invariants

- The World frame is the simulation clock. The `vfx-gpu-runtime` Update system runs after `FixedUpdate` and advances every simulating player once by `Time.delta` times its `timeScale`; render frames consume ordered tick intents. `Time.delta` is already bounded by `TimePolicy.maxDeltaSeconds`, so a hitch cannot queue an unbounded interval. A zero-delta frame with no reset, patch or channel input queues nothing.
- A newly rendered Player admits its time-zero state with zero delta before its first update. This uses the same native spawn preparation without advancing World time, firing a rate interval, or consuming an existing Player's pending patch/replay.
- GPU particle buffers remain persistent and are never read back for ordinary simulation or drawing.
- Time-zero bursts fire once per play cycle. Rate remainder and particle IDs survive frame-rate variation.
- `vfx_random_spawn` and `vfx_random_update` are addressable by seed, particle ID, tick, and sample key.
- Cold GPU preparation stalls effect time within the bounded queue. Post-start overflow reports `vfx-intent-queue-overflow`; ticks are not silently discarded.
- Seed/effect changes and stop-to-play transitions restart the player at an update boundary.
- `phaseTick` counts effect dispatches, including zero-time admission, and resets to zero on replay or `restart-on-visible`; `tick` is the runtime update count kept for correlation. Each intent records its own `delta` and the cycle's `elapsed` seconds; `initialDelta` retains the first dispatch delta so recovery does not add a simulated interval to an initialized Player.
- Ordinary effect recovery quantizes variable frame deltas: `buildVfxRecoveryIntents` replays the same dispatch count over the same cycle time, keeping the exact `initialDelta` and splitting the remaining `elapsed` evenly. Dispatch count, cycle time, spawn total and particle IDs match the live cycle; motion integrates over the even steps instead of the recorded frame partition. Persistent allocator pools instead require the exact submitted author-input history described below.
- `replay(player)` advances an authored stopped player for exactly one update and never creates a second persistent play-state authority.

`VfxGpuRuntime.inspectPlayers()` and `inspectPlayer(player)` expose stable keyed
snapshots for every attached player and emitter. They report the asset GUID,
program/layout fingerprints, parameter generation, pending patch count, channel
counters, `cameraVisible`, `sessionEnabled`, phase/global ticks, schedule, bounds, renderer/stage metadata and the latest
committed tick intent per emitter. Observation never selects a single global
“latest intent,” so two players and multi-emitter effects remain distinguishable.
The renderer uses `forEachEmitterSource(world, visitor)` to refresh frustum
visibility even when a paused player has no pending tick intent. It
admits new Players and retires despawned entities and removed `ParticleEffectPlayer` components from
the pending and committed state before extraction, without advancing World time.

`ParticleEffectPlayer.preparePipelines` defaults to `false`.

| `playing` | `preparePipelines` | Work |
| --- | --- | --- |
| `true` | Either | Ordinary reset, simulation and presentation |
| `false` | `false` | Existing paused, frozen-render behavior |
| `false` | `true` | Retain actual programs and capacity buffers; no simulation intent, copy, dispatch or draw |

A prepared player starts through the ordinary reset/spawn boundary and uses the
same resource owner. Returning it to paused preparation retires unconsumed ticks
by exact sequence acknowledgement and stops retained drawing, including an old
emitter definition. No reset, simulation or copy executes while it is parked.
Remove the component or despawn it to release ownership.
Explicit preparation keeps frame presentation pending until the requested
compute and raster pipelines resolve. Backends exposing native asynchronous
creation are awaited; legacy synchronous providers retain their existing API
semantics without a native compilation-completion guarantee.

> [!IMPORTANT]
> Loading an effect or publishing its source is not GPU readiness. CPU/NullRHI
> contracts establish ownership and completion gates, not device timing or FPS.

## Culling policy

| `simulationWhenCulled` | Hidden behavior | Visible transition |
|:--|:--|:--|
| `continue` | Simulate without projection or draw | Draw current state |
| `pause` | Freeze simulation and effect time | Resume frozen state |
| `restart-on-visible` | Freeze while hidden | Reset before drawing again |

Bounds are required and conservatively tested against the camera frustum. Local-space bounds use the player's world transform and maximum axis scale.

Camera culling and editor preview masking are independent runtime axes:

- `setEmitterCameraVisibility` is renderer-owned frustum evidence and applies the authored culling policy.
- `setEmitterSessionEnabled` is a non-authored preview mask used for mute/isolate. Disabled emitters neither simulate nor render retained output.
- Neither API changes a cooked renderer's authored `enabled` field.

## Structured recovery

Source validation visits each emitter's identity and simulation facts, then its
renderers, channels and events; cross-emitter references are checked after the
complete emitter roster. When multiple fields are invalid, `detail.path` names
the first failure in that order. Repair it and validate again.

| Code | Repair |
|:--|:--|
| `vfx-source-version-unsupported` | Migrate behavior to WGSL and cold-cook the supported schema |
| `vfx-source-invalid` | Repair `detail.path`; unknown and unsupported fields fail closed |
| `vfx-asset-version-unsupported` | Cold-cook the older source and publish the Program 5 payload |
| `vfx-asset-v3-program-missing` | Republish the Program 5 asset-local `particle-effect/program.json` artifact |
| `vfx-asset-v3-fingerprint-mismatch` | Cold-cook the schema-v3 payload and Program 5 artifact atomically |
| `vfx-effect-unavailable` | Load the shared effect before the first update |
| `vfx-intent-queue-overflow` | Recover the Renderer or restart the player; inspect render readiness |

Device recovery discards the old render generation and reconstructs each active
retained emitter from its deterministic committed tick inputs on the first
submitted replacement-device frame. Recovery does not advance World time,
publish channel events, allocate a play cycle, or reset the authored player.
No stale handle or CPU particle mirror survives recovery.

## Managed force fields

`ParticleEmitterSourceV3.forceFields` is an optional nonempty array of at most eight `VfxForceField` declarations. Sphere and box declarations use `kind`, an affine column-major JSON-array `transform` with finite f32 determinant and absolute determinant at least 1e-8, with finite f32 inverse coefficients and normal-or-zero shader cross/dot inputs and intermediates (WGSL 15.7.2 permits subnormal values to flush to zero), finite f32 `strength`, and `attenuation` in [0,8]. A vector declaration additionally names an ordinary texture GUID in `texture` and closed `sampling: 'nearest' | 'trilinear'`. Declare the `forgeax_vfx::data::force_fields` WGSL import with the fields; call `vfx_apply_force_fields(ctx, particle)` before the existing `vfx_integrate`. The explicit acceleration helper is also available. No provider or GPU handle is required.

| Contract | Behavior |
|:--|:--|
| Support | Field-local unit sphere or [-1,1] box; outside contributes zero |
| Attraction | World direction toward center, finite zero at center, strength times `(1-r)^attenuation` |
| Saved vectors | Linear `rgba32float` ordinary 3D TextureAsset, no mips, dimensions 2..64, finite little-endian voxels |
| Coordinates | World field transform; emitter local/world policy retains its existing Scene authority; nonuniform scale transforms vector magnitude |
| Sampling | Nodes span [-1,1], x fastest; nearest rounds nodes; trilinear mixes eight nodes |
| Bounds | At most 16 MiB of metadata plus samples per emitter; invalid source/payload/transform returns a closed structured field error |

Source declarations use texture GUIDs; an adopted or code-created definition can
bind an `AssetHandle<'texture'>`. The effect holds those references, and changing
texture bytes is adopted by the next simulation tick without restarting playback.
Queued ticks retain exact texture versions, alongside definition and parameter
inputs; rendering cannot substitute a later field. Fixed-version publication keeps
sample bytes outside ordinary tick messages. A byte-range edit revalidates and stages only the
changed f32-aligned spans. GPU preparation copies the accepted previous field buffer and patches
those spans into a new version, allowing old/new queued ticks in one submission. Initial use,
whole replacement, absent predecessor evidence and device recovery upload the complete field.
The real 8³-field regression measures 8,368 bytes initially, 16 bytes for one voxel edit, and
zero field bytes on subsequent unchanged frames.

The source descriptor and particle output producer include vector texture GUIDs in normal dependency closure. Catalog replacement preserves the GUID and produces a new payload; VFX does not own a second asset registry, texture format or CPU particle simulation. See the ordinary `hello-boss-lightning/assets/fields.pack.ts` producer and `fields.html` consumer.

The portable managed field path admits at most eight compute storage bindings. Combining fields, Custom storage and event storage above that limit is a structured cook failure; split the work into another emitter.

Scalar/vector byte sizes and alignments derive from Types' `WGSL_NUMERIC_LAYOUT`.
VFX retains its Core field offsets, Custom lane budget, and authored member order;
the compiler and runtime packers consume the same numeric layout.

### Producer-backed water sampling and GPU output events

World-specific GPU samplers use `createVfxRuntimeHost({providersForWorld})`.
The source World captures portable feature-texture references and uniform data;
render workers resolve those references against their own device generation.
Declare producer ordering with the host's `dependencies` option. Opaque GPU
views are never transported between realms.

An authored water effect imports
`forgeax_vfx::data::{water_displacement,water_hull,water_config}` and calls
`vfx_water_sample(worldPosition)`. Its provider supplies the actual displacement
array, local hull-wave texture, and a 112-byte uniform describing their world
mapping. The managed shader inverts horizontal displacement four times and
returns actual height, finite-difference normal, and local wave vertical velocity.

`createVfxGpuEventOutput(world, capacity).unwrap()` owns a bounded output stream.
Subscribe to its typed event records and release the subscription/owner on exit;
`reset()` changes the epoch so queued observations from the previous run cannot
leak into a new run. Effects import `forgeax_vfx::data::gpu_events` and call
`vfx_emit_event(channel, position, strength, particleId)`. The return value says
whether the shared World/frame output budget accepted the event. Only these
records are asynchronously read back; particle storage remains GPU-only.
Receipt-bound triple buffering rejects new output when every readback slot is
busy. Epoch, device generation and ordered sequence checks reject stale records.

`VfxGpuUpdate` is the public Update ordering token for game systems that publish
Player parameters after physics and before native GPU tick intents are captured.

Persistent visual pools may declare `emitter.pool` with a closed allocator
configuration. The managed single-invocation allocator runs after initial spawn
and before authored updates, selects idle slots first and otherwise the largest
GPU-authored priority, and invokes the declared acquire hook with
`(ctx, particle, custom, commandIndex, ordinal, physicalSlot)`. Commands are typed
uniforms; neither allocation nor particle motion is mirrored on the CPU.

Persistent-pool recovery retains complete submitted input cycles, including each
delta, parameter block, source transform, asset version and producer snapshot.
`maxRecoveryRecords` (per emitter, default 16384) and
`maxRecoveryPayloadBytes` (shared unique buffers, default 128 MiB) bound this
history. Exceeding either budget reports a structured recovery error; a live
cycle is never silently truncated. A transient pool can start a new cycle after
all authored lifetimes have expired.

Temporal data-interface providers publish a frame/version recovery resource and
retain its source checkpoint/tape through `retainRecovery`. The runtime holds
that lease until the corresponding input history is released. Recovering ticks
use the captured uniforms and historical resource, never the current producer
texture. Coupled producer/consumer work uses the render graph's temporal timeline
to replay each producer tick before its VFX consumer. An unavailable historical
environment blocks recovery explicitly. Recovery GPU events use an independent
zero-capacity sink so historical collisions cannot repeat live game effects.

`ParticleEffectWorldBounds` supplies an author-owned world AABB for one Player's
visibility. Extraction snapshots this component and publishes it across render
realms; admission, retained rendering and visibility feedback consume the same
volume. It overrides culling only. Moving an emitter's volume never moves
world-space GPU particles, changes their simulation coordinates, or requires a
particle-state readback. Without the component, authored emitter bounds retain
their existing simulation-space behavior.

### Ordered coupled GPU pools and bounded output contributions

Code-first `pool.control` names an authored `fn(VfxSpawnContext)` called by the managed single-invocation allocator after scheduled initialization/acquire and before update/compaction. A control-only pool declares no command pairs. Managed `vfx_pool_load_particle/custom` and `vfx_pool_store_particle/custom` expose only that emitter's bounded storage; writes maintain the managed alive scratch. Out-of-range reads return zero, writes are rejected. This supports coupled secondary emissions without concurrent per-particle slot mutation or CPU simulation.

`acquireVfxGpuEventChannel(world, channel, capacity)` borrows an existing World output owner through a Result and returns an explicit release/subscribe lease. The one binding-21 buffer reserves disjoint quotas for at most 16 channels (1024 total records). Primary channel 1 retains the original owner's quota. Layout changes advance the output epoch; portable publication, native allocation, three-slot receipt-bound readback and zero-capacity recovery sinks share the same header contract. `vfx_emit_event` appends within its channel quota. An authored single controller may instead call `vfx_write_observation(channel, ordinal, position, strength, id)` to replace a bounded aggregate observation with the latest submitted GPU tick. Consumers observe derived render facts; they must not integrate a CPU particle mirror. Source generation IDs reject reset-era observations. These additions are implemented but not yet validated in the current migration batch.
