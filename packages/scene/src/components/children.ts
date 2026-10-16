// @forgeax/engine-runtime - Children (forward-list of child entities).
//
// Schema: 1 array<entity> field `entities` (variable-length, ECS-managed via
// the BufferPool slot column + sidecar count column allocated by the ECS
// relationship owner).
//
// feat-20260515-buffer-array-vocab-collapse M3 / w17:
// the legacy `VarArrayView<Entity>` value-shape wrapper was retired in
// favour of a direct `TypedArray` snapshot returned by `world.get`. AI users
// read the engine-maintained list through the read-only `Uint32Array` snapshot:
//
//   const snap = world.get(parent, Children).unwrap().entities;
//   const liveCount = snap.length;
//   for (let i = 0; i < liveCount; i++) { const child = snap[i]; ... }
//
// Snapshot length equals the live element count (sidecar count column owned
// by the ECS layer); the public snapshot is detached and rematerialised on
// every `world.get` (D-4 no-cache), so `fill` or index writes cannot mutate the
// target. Internal relationship maintenance and Scene traversal borrow the
// live array through the package-internal zero-copy seams instead.
//
// feat-20260531-ecs-relationship-abstraction-bidirectional-sync M4 / t20:
// Children is the MIRROR side of the ChildOf relationship. Its schema is
// unchanged (the `entities: 'array<entity>'` shape is exactly what the
// relationship mirror contract requires), but the engine now maintains this
// list automatically whenever ChildOf is added / removed / reparented on a
// child entity (M2 bidirectional-sync hook on ChildOf). The prior OOS-10
// "AI users keep the two sides consistent themselves" contract is retired:
// `world.addComponent(child, ChildOf{parent})` appends `child` to
// `parent.Children.entities`, `world.removeComponent` / reparent prunes it.
// For the ChildOf hierarchy the engine owns consistency; no public target
// write can diverge from the source relationship.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w13 (kept
// for context): migrated from the legacy `{ count: 'u32' }` advisory marker
// to the real variable-length entity-array storage path.
//   - OOS-09 (prior loop): no `addChild` / `removeChild` / `removeChildren`
//     Commands API. Retired this feat: `world.addChild` / `world.removeChild`
//     / `world.reparent` ship in M3, plus the relationship hook above.
//   - Normal ChildOf child despawn invokes the source onRemove hook and
//     removes the child before the row is retired; parent despawn follows the
//     linkedSpawn cascade. A dangling u32 is therefore an explicitly malformed
//     internal fixture or a non-linked generic relationship, not a normal
//     ChildOf lifecycle result. Consumers still probe liveness before using a
//     handle and receive the structured ECS error for malformed state.
//
// charter mapping: proposition 2 (Bevy ChildOf+Children pair, holder
// perspective) + proposition 3 (machine-readable schema:
// `componentSchema(Children).entities === 'array<entity>'`) + proposition 4 (explicit
// failure: dangling entries surface to the AI user via `world.get(parent, Entity)` liveness probe,
// not silent drop) + proposition 5 (consistent abstraction: Children is the
// generic relationship-mirror shape, not a ChildOf special case).

import { defineRelationship } from '@forgeax/engine-ecs';
import { Transform } from './transform';

/**
 * Hierarchy forward-list of child entities.
 *
 * `entities` is a variable-length `array<entity>` field; each element is
 * an `Entity` u32 the ECS relationship owner materialized. The value returned
 * by `world.get(parent, Children).unwrap().entities` is a detached read-only
 * `Uint32Array` snapshot rematerialised fresh on every read (D-4 no-cache);
 * mutating the returned array cannot change ECS-owned storage, and the
 * snapshot's `length` equals the live element count. Internal Scene/ECS paths
 * use the package-internal zero-copy array seams instead of this snapshot.
 *
 * Invariants:
 *   - `propagateTransforms` consumes Children from the ECS-owned materialized
 *     buffer and expands each root parent-first. The forward list is also
 *     available for AI-user traversal / debug / inspection.
 *   - Children <-> ChildOf consistency is maintained by the engine via the
 *     ChildOf `relationship` mirror hook (see ./child-of.ts): adding /
 *     removing / reparenting ChildOf on a child auto-updates the parent's
 *     `entities` list. AI users do not hand-sync the two sides for the
 *     hierarchy.
 *   - ChildOf's linked lifecycle keeps ordinary Children entries aligned: a
 *     child despawn prunes its source slot and a parent despawn cascades. A
 *     deliberately malformed/non-linked edge remains observable as a dead
 *     handle and must be diagnosed through the structured error channel.
 *
 * @example Spawn a parent and two children via ChildOf (engine maintains Children):
 *   const parent = world.spawn({ component: Transform, data: identityXf() }).unwrap();
 *   const a = world.spawn(
 *     { component: Transform, data: identityXf() },
 *     { component: ChildOf, data: { parent } },
 *   ).unwrap();
 *   const b = world.spawn(
 *     { component: Transform, data: identityXf() },
 *     { component: ChildOf, data: { parent } },
 *   ).unwrap();
 *   // Read back via the read-only snapshot - engine appended a, b:
 *   const snap = world.get(parent, Children).unwrap().entities;
 *   for (let i = 0; i < snap.length; i++) {
 *     const child = snap[i];
 *     // ... consume; probe the handle before using it when reading a
 *     // deliberately malformed/non-linked relationship.
 *   }
 */
export const { source: ChildOf, target: Children } = defineRelationship({
  sourceName: 'ChildOf',
  sourceField: 'parent',
  targetName: 'Children',
  targetField: 'entities',
  // Every scene hierarchy node is spatial.  Adding ChildOf therefore
  // materializes the local/derived transform pair at the same structural
  // boundary, so render- and scene-authored children cannot enter a frame
  // with an incomplete hierarchy node.
  sourceRequires: [Transform],
  exclusive: true,
  linkedSpawn: true,
});
