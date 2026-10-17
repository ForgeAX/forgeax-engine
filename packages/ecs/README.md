# `@forgeax/engine-ecs`

Archetype ECS for ForgeaX. The package owns the hot path shared by every
domain: entity identity, component storage, relationships, queries, structural
mutation, two schedules, resources, time, and optional shared numeric kernels.

> [!IMPORTANT]
> `World` is the state authority. Scene instances, render extraction, physics
> backends, asset ownership, input collection, and application lifecycle stay
> in their owning packages. Do not add a second ECS facade for one of those
> domains.

`World` directly owns its graph, entity records, managed stores, relationship
indexes, row/block revisions, and execution health. Query, command, and
lifecycle helpers receive only the typed package-internal capabilities they
actually consume; there is no `WorldCore`, `WorldData`, or second state bag.

```mermaid
flowchart LR
  HOST["App host"] --> WORLD["World.update(delta)"]
  WORLD --> FIXED["FixedUpdate"]
  FIXED --> UPDATE["Update + command flush"]
  UPDATE --> PUBLISH["Scene / render projections"]
  WORLD --> QUERY["Query row / span"]
  WORLD --> VERSION["Component row versions"]
  VERSION --> QUERY
  WORLD --> STRUCTURE["Structure epoch + typed evidence"]
```

## The smallest useful journey

```ts
import type { Result } from '@forgeax/engine-types';
import {
  type EcsError,
  FixedTime,
  Update,
  World,
  defineComponent,
  defineSystem,
} from '@forgeax/engine-ecs';

const Position = defineComponent('Position', {
  x: { type: 'f32', default: 0 },
  y: { type: 'f32', default: 0 },
});

const Move = defineSystem({
  name: 'move',
  queries: [{ write: [Position] }],
  fn: (_world, [positions]) => {
    for (const row of positions) {
      const position = row.mut(Position);
      position.x += 1;
    }
  },
});

const world = new World();
const spawned = world.spawn({ component: Position, data: { x: 0, y: 0 } });
if (!spawned.ok) throw spawned.error;
const registered = world.addSystem(Update, Move);
if (!registered.ok) throw registered.error;
const stepped: Result<void, EcsError> = world.update(1 / 60);
if (!stepped.ok) console.error(stepped.error.code, stepped.error.hint);
```

The normal data path is `world.query(descriptor)` with a row iterator or a
packed `QuerySpan`. Success-path row access is direct and allocation-free;
expected boundary failures use the shared `Result` carrier from
`@forgeax/engine-types`.

## Components and schema

`defineComponent` accepts one closed storage vocabulary. The token exposes only
the schema facts needed by a consumer: `name`, frozen `fields`, and `storage`.
Authoring metadata, lifecycle callbacks, render policy, simulation policy, and
open-ended metadata do not belong on a component token.

| Shape | Use | Example |
|:--|:--|:--|
| scalar | numeric, boolean, or enum data | `{ type: 'f32', default: 0 }` |
| `string` | managed text value | `{ type: 'string', default: '' }` |
| `entity` | raw entity reference | `{ type: 'entity' }` |
| `shared<Tag>` | externally owned shared payload handle | `{ type: 'shared<MeshAsset>' }` |
| `array<T>` | variable array replaced as one value or written in place by range | `{ type: 'array<f32>' }` |
| `array<T,N>` | fixed-size inline array | `{ type: 'array<f32, 4>' }` |
| sparse tag | presence-only marker | `defineComponent('Disabled', {})` |

`world.sharedRefs.acquire(target, payload)` returns one caller-owned reference
while preserving the interned handle for the same target and payload object.
Release once per acquisition, including repeated acquisitions of the same
handle. Component columns retain their own references through the normal write
barrier. `world.internSharedRef` remains an idempotent producer lookup and does
not retain on repeated discovery; `world.allocSharedRef` creates an independent
handle.

`world.allocUniqueRef(tag, payload, onRelease?)` stores the actual owned
payload. `world.resolveUniqueRef<T>(handle)` reads that same payload and returns
`unique-ref-released` or `unique-ref-stale` for invalid generations. Component
replacement, removal and despawn own release; the read API grants no independent
release or mutation of the store.

The `fields` object is deeply frozen at definition time. A value replacement
uses the ordinary mutation path:

```ts
const Trail = defineComponent('Trail', { points: { type: 'array<f32>' } });
const entity = world.spawn({ component: Trail, data: { points: new Float32Array([0, 1]) } }).unwrap();
const current = world.get(entity, Trail).unwrap();
world.set(entity, Trail, { points: new Float32Array([...current.points, 2]) });
```

`world.setArrayRange(entity, component, field, offset, values)` overwrites
`values.length` elements of an array field in place, starting at element
`offset`; the array length never changes. It publishes the component through
the same changed-epoch barrier as `set`, and additionally records the element
range so projection consumers can refresh only what changed:

```ts
// Move instance row 42 (16 floats per mat4) without republishing the column.
world.setArrayRange(entity, Instances, 'transforms', 42 * 16, matrix).unwrap();
```

A window outside the array, or a field that is not an array, returns
`array-range-out-of-bounds` (`detail: { component, field, offset, length, size }`,
`size: -1` for a non-array field) and leaves the World unchanged. Use `set`
to resize.

`readArrayRangesChangedSince(world, entity, component, field, since)` from
`@forgeax/engine-ecs/projection` answers the merged element ranges written
after the mutation epoch `since` (read with `readMutationEpoch(world)`), or
`'whole'` when any other write replaced the field, the entity was despawned,
or the bounded per-field history (1024 writes) no longer covers `since`.
`'whole'` is always a safe answer; consumers then reproject the full array.

The Scene package may define a single-field `Name { value: 'string' }` token
for authoring. ECS stores the value through the same closed `string` schema
vocabulary, but does not own the Scene component or its authoring policy.

Scene and Render own their domain schemas, for example `Instances { transforms`
is a Render-owned projection whose array payload follows ECS replacement and
range-write semantics.

### Required components are resolved at structural boundaries

Use `requires` when a component is only valid with one or more other component
tokens. The ECS expands this declaration transitively during `spawn`,
`addComponent`, and deferred `Commands` materialization; it does not scan or
repair entities during a frame.

```ts
const GlobalTransform = defineComponent('GlobalTransform', { world: 'array<f32, 16>' });
const Transform = defineComponent(
  'Transform',
  { x: 'f32' },
  { requires: [GlobalTransform] },
);

// The archetype contains both columns. No scene-specific helper is required.
const entity = world.spawn({ component: Transform, data: { x: 0 } }).unwrap();
```

The declaration is generic: explicit data for a required component wins, and
missing requirements are appended once in dependency order. Removing a
required component is intentionally not a cascade; it is an explicit escape
hatch that lets an owner surface a structured invariant error instead of doing
hidden structural work.

There is no public `push`, `pop`, `capacity`, `reserveArrayCapacity`, view
class, or user-managed target-array mutation API. A replacement is one bounded
mutation, so an invalid value leaves the previous column and reference counts
unchanged.

Object-shaped numeric writes reject `NaN` before touching the column. The
returned `component-numeric-value-invalid` error carries the component, field,
entity, received value, and optional array index in `detail`; `Infinity` remains
valid when the schema accepts it. Branch on `error.code` and use `error.hint` to
choose the correction instead of parsing a message.

## Relationships: one source, one materialized index

Relationships preserve the reverse index because lookup complexity is part of
the contract. Reading a parent's children is $O(1 + k)$ for $k$ direct children,
not an $O(N)$ scan of every entity. The source is the only writable fact; the
target is an engine-maintained, read-only materialized vector with a
source-to-slot backpointer for amortized $O(1)$ attach, detach, and reparent.

```ts
import { defineComponent, defineRelationship } from '@forgeax/engine-ecs';

const Spatial = defineComponent('Spatial', {});

const { source: ChildOf, target: Children } = defineRelationship({
  sourceName: 'ChildOf',
  sourceField: 'parent',
  targetName: 'Children',
  targetField: 'entities',
  sourceRequires: [Spatial],
  exclusive: true,
  linkedSpawn: true,
});

const parent = world.spawn().unwrap();
const child = world.spawn({ component: ChildOf, data: { parent } }).unwrap();
const children = world.get(parent, Children).unwrap().entities;
```

`sourceRequires` applies the same structural-boundary rule to the writable
relationship source: adding `ChildOf` also materializes its required
components. The reverse `Children` projection does not gain a second write
path, and no frame system scans the world to repair the dependency.

`Children` and `AnimationTargets` are read projections, not a second write
authority. `Children { entities` is a materialized target owned by ECS; the
Scene package owns the `ChildOf` vocabulary and chooses where to use it. The
same rule applies to `AnimationTargets`. Direct target writes are rejected by
`World` at both the type and runtime boundaries.

Relationship policy shares the component token's realm-wide owner registry.
A World loaded through a separate bundle or development program session still
maintains mirrors, enforces target write protection, and follows linked despawn
for components declared by the canonical ECS entry.

## Queries and projections

Queries are the only public data-plane API. A row is the flexible path; a span
is the packed numeric path and includes entity handles for owner-side identity.
Raw `Table`, `Archetype`, `Column`, and `FieldView` values are package-private.

Each Query keeps its own iteration and observation state. Descriptor compilation borrows the component definition's field roster and
allocates diagnostic role lists only on conflicts; temporal sets are built only
for requested changed/added predicates. Dense queries match
only tables; queries with sparse predicates match only archetypes. A World's
storage rosters append without replacing their owners, so a retained Query
checks only newly appended owners and keeps empty matches for later repopulation.
Rows, spans and derived writers borrow the same matched table objects. Structural
mutation still invalidates active iterators; `changed` and `added` observations
remain independent between Query instances.

The [storage matching allocation comparison](reports/query-storage-matching-20261017/README.md)
records a source-qualified environment extraction fixture and its raw profiles.

The row iterator reuses its borrowed row facade. Read each entity/value during
iteration; for an entity snapshot use `Array.from(query, row => row.entity)`.
Spreading row facades and reading them after iteration retains the same final
row rather than distinct entity snapshots.

```ts
const query = world.query({ read: [Position] }).unwrap();
for (const row of query) console.log(row.entity, row.get(Position).x);
const writable = world.query({ write: [Position] }).unwrap();
for (const span of writable.spans().unwrap()) {
  const positions = span.mut(Position);
  for (let i = 0; i < span.length; i += 1) positions.x[i] += 1;
}
```

Incremental owners keep their own `changed` Query. Component row versions are
the value-change authority; `World.getStructureEpoch()` invalidates caches when
entity/component membership changes. There is no parallel value-event journal
or projection-change object vocabulary. A changed query uses the existing
component mutation epochs to skip row scans when any required changed input
has no unobserved write; row versions still select the exact result otherwise.

```ts
const structureEpoch = world.getStructureEpoch();
const changed = world.query({ changed: [Position] }).unwrap();
for (const span of changed.spans().unwrap()) {
  for (const entity of span.entities) console.log(entity);
}
// If world.getStructureEpoch() !== structureEpoch, reconcile membership from
// the owner's ordinary Query and then drain the changed Query once.
```

`added` is the matching first-observation filter for component membership. It
uses the same row-version cursor as `changed`, so each consumer drains its own
query independently:

```ts
const added = world.query({ read: [Position], added: [Position] }).unwrap();
for (const row of added) initializeProjection(row.entity, row.get(Position));
```

`World.set` advances change evidence only when a scalar's stored value changes,
including the actual f32/integer column conversion. Equal enum, boolean and
numeric writes leave projections current. Array, buffer and managed-field writes
remain explicit publications: a fixed-array view may already have been edited
through an alias before `set` is called.

State consumers use `createStateProjection` from the projection subpath. A consumer
retains accepted identities per 256-row block; current membership and component
revisions discover the next unique source-index work set. Deletion, migration,
sparse tags and generation reuse reconcile against final World records, without
a structural event history or an overflow recovery mode.
Changed table blocks compare complete entity handles and forward changed row
identities plus component writes, so a spawn does not invalidate unchanged block
neighbors. Tracked or candidate sparse components retain conservative block
discovery because their membership changes need not move table rows.

```ts
import { createStateProjection } from '@forgeax/engine-ecs/projection';

const projection = createStateProjection(world, [Position]);
const candidate = projection.read();
for (const index of candidate.indices) {
  reconcileCurrentEntity(index, projection.entity(index));
}
candidate.accept(); // Only after the consumer successfully applies its changes.
```

| Boundary | Contract |
|:--|:--|
| Discovery | Enumerates current nonempty relevant tables plus retained deleted blocks; unchanged blocks skip row reads. |
| Acceptance | Synchronous, consumer-local; a new read, invalidation, or World mutation expires an outstanding candidate. |
| Failure | Leave the batch unaccepted and read again; poisoned Worlds reject projection. |
| Scratch | `indices` is borrowed until the next `read`; do not retain it as a snapshot. |
| Invalidation | Preserves prior identities so deleted sources can still leave the consumer. |
| Fast check | `isCurrent()` compares accepted World epochs without allocating a batch; unrelated writes may return false. |
| Root facts | `membershipChanged` and `changedComponents` conservatively identify work domains; `changed(entity, component)` checks a surviving value against acceptance. Removed components require current-membership reconciliation. |

The optional third argument selects candidate table membership (any listed
component); it defaults to the observed components. Sparse candidates conservatively
include current tables. Consumers still inspect final component membership and
values: the work set is conservative, never an event stream.

The `@forgeax/engine-ecs/world-read` seam is a read-only owner capability for
hot semantic scalar/array probes. `World.getStructureEpoch()` remains the
public cache-invalidation primitive; the seam never returns tables, archetypes,
columns, or mutable views. Ordinary gameplay code should continue to use
`World.get` and queries.

When an owner needs one scalar or one array element without materializing a row,
import the capability explicitly and keep the probe read-only. Entity fields
are returned as their stored u32, so narrow a non-null value to the existing
`EntityHandle` before passing it to another entity-typed probe:

```ts
import { ENTITY_NULL_RAW, type EntityHandle } from '@forgeax/engine-ecs';
import { ChildOf, Children } from '@forgeax/engine-scene';
import { worldRead } from '@forgeax/engine-ecs/world-read';

const parentRaw = world[worldRead].getFieldValue(child, ChildOf, 'parent');
const parent: EntityHandle | undefined =
  parentRaw === undefined || parentRaw === ENTITY_NULL_RAW
    ? undefined
    : (parentRaw as EntityHandle);
const count =
  parent === undefined ? undefined : world[worldRead].getArrayLength(parent, Children, 'entities');
const firstChild =
  parent === undefined
    ? undefined
    : world[worldRead].getArrayElement(parent, Children, 'entities', 0);
```

`undefined` means the entity, component, field, or element is unavailable; the
capability never hands out a storage view and cannot mutate the World.

Queries never expose table ids, rows, columns, or a duplicate snapshot data
plane.

## Schedules, time, and resources

Only `Update` and `FixedUpdate` are user schedules. Registration is token-first;
there is no frame-end schedule, system-parameter DSL, terminal render hook, or
severity/error-handler registry.

```ts
world.addSystem(Update, Move).unwrap();
world.addSystem(FixedUpdate, {
  name: 'fixed-step',
  queries: [],
  fn: (fixedWorld) => {
    const fixed = fixedWorld.getResource(FixedTime);
    void fixed.tick;
  },
}).unwrap();
```

`world.update(deltaSeconds)` advances the clock, runs zero or more fixed steps,
runs one update step, and flushes each system's command buffer. Clock readers
receive a stable read view; the scheduler owns writes.
Catch-up step counts derive from the initial accumulated delta, so intermediate
remainder rounding does not discard an exact final step (including `3 / 60`).
An `Update` system ordered `after: [FixedUpdate]` observes the final
`FixedTime.overstep` and dropped-time counters for this update, including zero
fixed ticks, an empty fixed schedule, and capped catch-up. The remainder does
not wait until `world.update(deltaSeconds)` returns to become visible.
Referencing the registration token itself in `before` or `after` brackets every
execution of that schedule. For example, a FixedUpdate system with
`before: [FixedUpdate]` runs before every fixed tick, while `after: [FixedUpdate]`
runs after its ordinary systems and command flushes. Registration order does
not weaken these boundaries; contradictory ordering uses the ordinary cycle
failure. Update boundaries also enclose its intrinsic fixed block.

Resources are non-owning values: Cordis/plugin owners dispose external payloads, not `World`.
Final shared-reference `release()` returns the payload to its caller.
The store retains no release journal or content-change versions. Runtime content
uses managed ECS components owned by `assets-runtime`; final release does not
retain the external payload.

## Failure and recovery

Branch on `error.code`, never on a message string. The closed ECS error union
preserves `code`, `expected`, `hint`, `detail`, and `cause` where applicable.

```ts
const result = world.update(1 / 60);
if (!result.ok) {
  switch (result.error.code) {
    case 'world-poisoned':
      // Stop the frame and ask the App execution owner to rebuild.
      break;
    default:
      console.error(result.error.code, result.error.hint);
  }
}
```

Recovery means constructing a fresh World and replaying the authoritative
game state; a poisoned identity is never reused:

```ts
function createWorld(): World {
  const next = new World();
  next.addSystem(Update, Move).unwrap();
  return next;
}

let liveWorld = createWorld();
const step = liveWorld.update(1 / 60);
if (!step.ok && liveWorld.execution.health === 'poisoned') {
  // The first failed frame can be `system-failed`; a later call is
  // `world-poisoned`. Health is the stable recovery boundary for both.
  liveWorld = createWorld();
  for (const saved of savedPositions) {
    liveWorld.spawn({ component: Position, data: saved }).unwrap();
  }
}
```

Expected command failures are reported before structural commit and leave the
World unchanged. A system throw or an unknown post-write failure cannot prove
that no row was mutated: the World becomes poisoned and must be rebuilt by the
App execution owner. Shared-kernel partial writes follow the same fail-closed
rule.

```mermaid
stateDiagram-v2
  [*] --> Healthy
  Healthy --> Healthy: expected failure / zero delta
  Healthy --> Poisoned: system throw or partial write
  Poisoned --> Rebuilt: App stops frame and replaces World
  Rebuilt --> Healthy
```

## Inspection

`world.inspect()` is an explicit, detached, deeply frozen POD snapshot for
diagnostics. It is not a live registry and is not a storage escape hatch.
Consumers should use entity counts, active component names, schedule summaries,
and resource keys; gameplay code should use queries.

`world.componentsOf(entity)` returns a detached array of the live entity's
component tokens, including sparse tags, or the normal stale-entity error.
Unlike `world.components.entries()`, it reflects actual archetype membership
without requiring a plugin catalog lease. Inspection plugins combine it with
public component reflection and `world.get`; it adds no inspection state or
per-frame work to the World.

## Public surface and subpaths

The root barrel is intentionally small. Advanced capabilities are named by
their owner instead of being forwarded through the root.

| Entry | Purpose |
|:--|:--|
| `@forgeax/engine-ecs` | World, components, relationships, queries, schedules, resources, errors |
| `@forgeax/engine-ecs/projection` | Current-state block projection, render read versions, numeric spans, and array range-change evidence |
| `@forgeax/engine-ecs/shared` | Shared numeric kernel contracts |
| `@forgeax/engine-ecs/world-read` | Safe semantic scalar/array reads for owner-package hot paths |
| `@forgeax/engine-ecs/externalization` | Generic component projection and entity remap |

`Result`, `ok`, `err`, and `Handle` come from `@forgeax/engine-types`; ECS does
not forward them. There is no ECS remote bin, simulation record/restore
protocol, scene-instance resolver, or compatibility alias for removed APIs.

<details>
<summary>Removed concepts</summary>

The one-cut surface deliberately removes `FrameEnd`, `setErrorHandler`,
`defineSystemParam`, `ParamValidation`, simulation record/restore/trace APIs,
scene lifecycle methods, raw storage exports, relationship metadata lookup,
root `Result`/`Handle` forwarding, and array convenience commands. When a
consumer needs one of those concerns, move the owner to App, Scene, Render,
Physics, or the explicitly named ECS subpath.
</details>

## Contract invariants

The following are package-contract statements, not a claim that every
repository-wide browser, Dawn, or consumer gate is green. Gate results for a
specific change belong to its closed-loop verification report.

- [x] Entity and component mutation use one World authority.
- [x] Relationship targets remain materialized for $O(1 + k)$ reads.
- [x] Query row/span are the only public data plane.
- [x] `Update` and `FixedUpdate` are the only schedules.
- [x] Expected failures are structured; unknown partial writes poison the World.
- [x] Advanced projection/shared/externalization APIs are named subpaths.

For the full migration rationale and acceptance matrix, see the canonical
ECS World ownership simplification design.

### Large managed arrays

The eight BufferPool size classes bound pooling, not field capacity. Larger
arrays use dedicated allocations; release drops their storage instead of
retaining a large free bucket. Growth preserves bytes and slot identity, and
allocation failure returns the existing structured managed-buffer error. Small
fields keep their existing allocation and reuse behavior. Game data, including
instance transforms, remains World-owned regardless of its size.
