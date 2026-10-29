# `@forgeax/engine-scene`

## Explicit instance field writes

`worldWriteSceneField(world, root, sceneEntity(sourceKey, address), component,
field, value)` changes one declared scalar or short vector through normal
`World.set`. It validates the component schema and resolves the exact existing
instance binding, including nested addresses. References and structural fields
require their domain owner. A retired root or mismatched sourceKey rejects the
write. `worldSceneEntityAddressOf` reverses one known instance binding without
searching entities or other scenes. Updating a SceneAsset still affects future
instantiation; it does not broadcast to existing instances.

> [!IMPORTANT]
> Owner: scene identity, hierarchy, and world-space propagation. This package is the sole authority for `Transform`, `ChildOf`, `Children`, `Name`, `Mobility`, and `scenePlugin`.

## Smallest useful example

```ts
import { scenePlugin, Transform } from '@forgeax/engine/scene';
import { createWorldContext, World } from '@forgeax/engine/ecs';

const world = new World();
const context = await createWorldContext(world, [scenePlugin()]);
const entity = world
  .spawn({ component: Transform, data: {} })
  .unwrap();
void entity;
await context.fiber.restart();
```

`scenePlugin()` is a native Cordis plugin. Its Fiber installs hierarchy
propagation and removes it when the realm unloads.

`PROPAGATE_TRANSFORMS_FIXED_SYSTEM` is the public FixedUpdate ordering anchor for
local Transform writers, including navigation and distance-based path following. Register a writer with
`before: [PROPAGATE_TRANSFORMS_FIXED_SYSTEM]` after installing `scenePlugin()`.

The direct `propagateTransforms(world)` entry point returns `Result<void, SceneError>`;
branch on `error.code` and repair a diagnosable stale edge, mirror mismatch, or
cycle through `World.set`/`World.removeComponent` (or the owning structural
command) before retrying while the World is healthy.

## Affine authoring

`Transform` stores one authored local transform: `pos`, `quat`, `scale`, and
`shear` (default `[0, 0, 0]`). The matrix is `T * R * H * S`, where H is the
upper-triangular shear with XY, XZ, YZ entries. Existing TRS edits retain the
current shear unless the author explicitly resets it. Propagation and fixed-step
presentation both use this composition; `GlobalTransform` stays derived.

`mat4.decomposeAffine` converts a finite nonsingular authored matrix into these
fields without discarding shear. A false result leaves its output arguments
unchanged; the consumer owns the structured admission error. This does not
promise that consumers requiring rigid or orthogonal transforms, such as a
specific collision-shape implementation, can accept arbitrary shear.

## Simulation and presentation poses

`Transform` and `GlobalTransform.world` remain the exact simulation pose. Scene
samples marked local translation, rotation, scale and shear between the final two fixed ticks using
`FixedTime.overstep / FixedTime.delta`; rendering never writes that pose back
into Physics or animation. Update propagation runs after the fixed block.

| Surface | Ownership and use |
|:--|:--|
| `TransformInterpolation` | Transient marker opting local TRS into fixed sampling; RigidBody and AnimationTargetId require it |
| `GlobalTransform.world` | Exact hierarchy for simulation, physics sync and gameplay queries |
| `readPresentationWorldMatrix(world, entity)` | Borrowed world matrix for camera following and every render consumer; descendants inherit the sampled parent |
| `resetTransformInterpolation(world, entity)` | Reset history after an explicit fixed-tick teleport or discontinuity |

Before Update propagation, the reader samples the same hierarchy prospectively.
After propagation, it borrows the published matrix. Consume the borrow before
the next World mutation. Outside-fixed TRS writes use the current author pose;
Update animation therefore keeps its current joint sample on the interpolated
root. Rotation uses shortest-arc quaternion interpolation. Reparenting, missed
catch-up intervals and explicit resets discard unrelated history. Removing the
last propagation lease retires the sampler and its World-local history.

The synchronous sampler borrows current TRS and Children storage while computing
matrices. These views never enter presentation history or escape the traversal;
history still owns copied fixed poses. Reading a moving subtree therefore avoids
materializing full component objects for joints and detached Children snapshots.
TRS views returned by public World.get already borrow their current column bytes;
this optimization does not claim to remove a byte copy from those TRS fields.

Continuously moving fixed histories reuse the previous pose settled by
before-capture. After-capture reads the final source pose without copying the
same previous pose again; a stopped writer still receives its final settlement.

```sh
node packages/scene/bench/presentation.mjs
```

> [!NOTE]
> This opt-in CPU benchmark requires `process.threadCpuUsage` and verifies four
> fixed steps per update. It reports phase wall time and thread CPU separately,
> with moving and stopped pose digests for equivalent-work comparisons. It does
> not qualify browser FPS.

## Keyed SceneAsset authoring

`SceneAsset` is authored as ordinary data. The key in `entities` is the only
persistent local identity; runtime numeric slots and mount windows are derived
inside this package and never belong in source files.

```ts
const level: SceneAsset = {
  kind: 'scene',
  entities: {
    root: { components: { Transform: {} } },
    house: {
      components: { ChildOf: { parent: 'root' } },
      instance: {
        source: houseSceneGuid,
        overrides: [{ target: ['door'], components: { Name: { value: 'front-door' } } }],
      },
    },
  },
};
```

| Source value | Meaning |
|:--|:--|
| `'root'` | Entity in the current scene |
| `['house', 'door']` | Entity `door` inside instance `house`; every segment is a key |
| `sceneEntity(guid, address)` | Reference bound to one catalog identity and address |
| `sceneEntity('', address)` | Reference to an anonymous direct POD scene |

> [!IMPORTANT]
> Unknown components, unknown fields, missing targets, hierarchy cycles, and
> recursive instance graphs fail before entity creation. A direct POD scene has
> no persistent source identity; choose a Pack output key before saving it.

Authored primitive fields are checked before storage conversion: scalar types, finite floating-point values, integer ranges and fixed-array lengths must match the declared schema. Typed numeric author arrays project their values instead of reinterpreting bytes. Malformed values return `asset-package-invalid` before any scene entity is spawned. Omitted fields still use schema defaults.

`buffer` and `buffer<N>` store raw bytes. Native buffers and views preserve their
exact byte window, including wider TypedArrays and DataViews; externalization
projects those bytes to JSON arrays, and binding checks byte values and the fixed
byte count. All fixed arrays, including entity and shared-handle arrays, enforce
their schema length. Shape annotations do not change the underlying storage type.

Schema-declared scalar and array entity references bind after all owned entities and mount carriers exist. Forward and cyclic references therefore resolve to the current instance; hierarchy still follows its parent-first ordering. This does not make hierarchy cycles valid.

### Publication fence for loaded scenes

Catalog-loaded scenes carry their publication evidence in the producer/loading
context, not in the authored `instance` declaration. Acquire the current fence
from that context, then pass it to
`AssetRegistry.instantiateWithPublicationFence` or
`instantiateFlatWithPublicationFence`; the call compares the complete tuple:
source path and revision, generation, package digest, output-set digest, and
receipt identity. Ordinary `instantiate`/`instantiateFlat` still validate every
nested scene output against the parent publication before spawning. A missing or
mismatched tuple returns `asset-generation-fence-mismatch` with `expected`,
`actual`, `currentGeneration`, `lastKnownGood`, and recovery actions; repair or
recook the producer, then open the current publication and retry. Direct
anonymous POD scenes have no Catalog fence and remain addressable only for their
current in-memory instance; saving one requires an explicit Pack/output key.

Each `SceneInstance.state` names the actual `SceneInstanceState` payload in
World's managed reference store. `worldGetSceneInstanceState` resolves that
identity; reverse binding diagnostics query live SceneInstance entities. There
is no parallel state catalogue or placeholder payload. Override records are
projected directly into the owned state; the former internal
`worldMountOverridesToStateMap` export is removed.

Each SceneInstanceState retains the schema-declared shared references in its
source, including arrays and instance overrides, until that state is destroyed.
Changing a live field therefore does not invalidate the original value needed
by `worldRemoveSceneOverride`. Nested instances own their source references
independently; flat top-level entities retain only their live component values.
Replacing an owned scene root can release the old instance without affecting
another consumer of the same asset.

When the plugin runs from the scheduled path, `world.update(deltaSeconds)`
wraps a thrown Scene failure as `system-failed`; the wrapper's
`error.detail.cause` is the original `SceneError` (including its structured
`code`/`detail`). That post-write system failure poisons the World, so the next
use returns `world-poisoned`. Inspect `detail.cause`, stop using that World
identity, discard it, and ask the App execution owner to call
`app.execution.rebuild()` for a fresh World. Do not retry a poisoned or
partially-written World in place.

If an explicitly malformed internal fixture reports a `Children` mirror
mismatch, never write the target array directly. A same-target
`world.set(child, ChildOf, { parent })` intentionally records the source
evidence but skips mirror/index churn, so it cannot repair that mismatch. On a
healthy World, repair through the source owner by removing and re-adding
`ChildOf` (or reparenting through another target and then back to the intended
one); if the failure has poisoned the World, discard it and rebuild through the
App instead.

Transform propagation writes the exact recomputed frontier into
`GlobalTransform` and advances those rows' ordinary component versions only
after a successful pass. A no-change pass advances no `GlobalTransform` row.
Persistent consumers keep a `changed: [GlobalTransform]` Query, so a moved
subtree is exposed as contiguous spans without a parallel event journal.
`Transform` remains authored local TRS; `GlobalTransform` is the resolved
world-space authority.

Visibility and other hierarchy consumers share one World-local parent-edge
projection. Its invalidation comes from the existing ECS relationship revision
and `ChildOf` write evidence. Unrelated structural changes recheck edge order
and parent generations through the retained read Query before reusing the
snapshot. Changed edges, iteration order, or existing diagnostics rebuild the
projection. Root lookup stays empty, malformed edges keep sorted diagnostics,
and previously returned snapshots remain unchanged.

The first propagation, and the next one after any hierarchy error, validates
the full hierarchy through ECS-maintained `Children` lists. After that, work is
driven by change evidence: edited `Transform`/`ChildOf`/`GlobalTransform` rows,
plus the exact structural identities from spawn, despawn and component changes. Only the highest such entities and
their subtrees are expanded in parent-first order, so an unrelated spawn or
despawn does not rescan unrelated Transform storage. Changed rows are recorded
during computation, then published through the ECS-owned numeric write fence.
Only touched row markers are cleared; a table grows only its own scratch storage. A `ChildOf`
value write whose target `Children` list does not mirror the edge, a parent
cycle detected on the actual parent path, or an entity that leaves the Transform pair
while still holding a hierarchy edge falls back to the full pass so malformed
graphs report the same diagnostics as a cold evaluation. An unexpected planning
exception invalidates discovery before rethrowing, so a healthy explicit retry
rebuilds the baseline even if private dirty cursors had already advanced. Numeric
producer/staging failures instead poison the World through ECS. A second
FixedUpdate/Update propagation without intervening writes performs no
hierarchy traversal. External writes to `GlobalTransform` (flat roots
included) are reconciled back to the derived value; the owner's own
publications are consumed before returning. `Children` remains a read-only relationship projection;
there is no duplicate Scene graph or per-node matrix cache.

Removing `ChildOf` is a structural root transition. Even when the authored
`Transform` is unchanged, the next propagation composes and publishes that
entity as a flat local root; ordinary same-value hierarchy recomputation still
does not publish an unchanged `GlobalTransform` row.

Flat propagation uses the same numeric kernel inline or through an installed
SharedKernel executor. It borrows the existing changed query, joins root
matrices before resolving the hierarchy, and leaves small or fragmented ranges
inline. Scene builds its self-contained kernel module into `pkg/` from the same
TypeScript source; no new Worker pool, component-name registry, or transform
change journal is introduced. Partial shared writes poison the owning World.

`Transform` declares the generic ECS requirement `GlobalTransform`. Therefore
ordinary `world.spawn`, `world.addComponent`, and deferred `Commands.spawn`
materialize the transient world column automatically at the structural
boundary; scene code does not need a special pair-completion helper and the
frame loop never scans entities to repair them. Explicit `GlobalTransform`
data remains valid when an importer or recovery path needs to provide it.

`ChildOf` declares `Transform` as a relationship-source requirement. A child
created with only `{ component: ChildOf, data: { parent } }` therefore receives
the full local/world pair transitively, while explicit `Transform` data still
wins. This keeps hierarchy authoring small without adding per-frame repair or
an additional scene-side component registry.

Deferred `Commands.spawn` uses the same `{ component, data }` entries as
`World.spawn`; the pending child is materialized and linked at command flush.
For an existing child, the generic reparent call is
`world.reparent(child, newParent, ChildOf, { parent: newParent })` and routes
through the same relationship owner.

`ChildOf` uses `linkedSpawn: true`: despawning a parent recursively despawns
its linked hierarchy. A generic relationship may opt out, but that is not the
Scene hierarchy lifecycle.

Removing the required component is still an explicit malformed-state escape
hatch, not an automatic cascade. Propagation reports that state as a
structured `SceneError`, preserving a clear owner and recovery path.

The authority also applies to dynamic loading: import `Transform`, `ChildOf`, and `scenePlugin` from `@forgeax/engine/scene` when a host resolves packages at runtime.

## Mobility

`Mobility { kind }` is the author's commitment about motion, stored as the
closed enum `MobilityKind = 'static' | 'stationary' | 'movable'` (numeric
values in `MobilityKindValue`, narrowed by `mobilityKindFromU32`). An entity
without `Mobility` is movable; runtime spawns stay movable unless authoring
writes `static`.

```ts
world.spawn(
  { component: Transform, data: { pos: [0, 0, -5] } },
  { component: Mobility, data: { kind: MobilityKindValue.static } },
);
```

| Kind | Mesh entity | Light entity |
|:--|:--|:--|
| `static` | Never moves after placement; eligible for baking and static caches (a shadow caster joins the static shadow layer on its first frame) | Fully baked |
| `stationary` | Invalid: `mobility-invalid-kind` | Fixed position, runtime direct light |
| `movable` / absent | No promise; caches use observed motion | Fully realtime |

`Mobility` is the rendering and baking authority; physics `RigidBodyType` is the
simulation authority. Neither is derived from the other.

Violations are non-blocking diagnostics with one closed union,
`MobilityDiagnosticCode` in [`src/errors.ts`](src/errors.ts). Each diagnostic
carries `code`, `expected`, `hint`, and `detail.entity`, plus
`detail.sceneEntityRef` when a SceneInstance binds the entity. Each
`(World, code, entity)` is reported once through
`subscribeMobilityDiagnostics(listener)` and `console.warn`. The package that
sees both sides of each contract detects it:

| Code | Detector | Trigger |
|:--|:--|:--|
| `mobility-static-moved` | `scenePlugin` Update system | A `static` entity's `Transform` changes after the frame that declared it |
| `mobility-invalid-kind` | Renderer source systems | `stationary` on an entity with `MeshFilter` |
| `mobility-physics-conflict` | `physicsPlugin` | `static` with `RigidBody` type `dynamic` or `kinematic` |

Diagnostics never change behaviour: a moved static entity still propagates and
renders correctly. Repair by declaring `MobilityKindValue.movable` (or removing
`Mobility`) on entities that move. Detector packages report through
`emitMobilityDiagnostic(world, entity, violation)`; they do not define another
channel.

## Boundary

| This package owns | Excluded concepts |
|:--|:--|
| Identity, parent/child links, local/world transforms | Meshes, materials, cameras, skins, animation, GPU/RHI |

See [`src/index.ts`](src/index.ts) for the public roster and [`src/errors.ts`](src/errors.ts) for recovery details.

## Visibility hierarchy boundary

Quick start: create `ChildOf` links through the scene package, then let
`resolveVisibility(world)` consume the projected hierarchy when a render or
remote diagnostic asks for an effective state.

| Fact | Scene owns | Consumer owns |
|:--|:--|:--|
| Parent relation | `ChildOf`, `Children`, and hierarchy projection | Visibility intent and render filtering |
| Effective lookup | Valid parent traversal and hierarchy diagnostics | `Visibility` field values and renderer statistics |
| Recovery | Repair a stale/cyclic relation from `SceneHierarchyDiagnostic` | Do not reinterpret a hierarchy error as a camera or picking error |

Read `VisibilityResolution.source` to distinguish `self`, `parent`, and the
default root case. If diagnostics report an invalid hierarchy, fix the scene
relation and resolve again; do not add a render-only parent or bypass the
scene graph. Camera, picking, lifecycle, assets, and VFX shadow behavior are
out of scope for this package.
