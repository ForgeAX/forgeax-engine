// @forgeax/engine-runtime - SceneInstance component (feat-20260608-
// scene-nesting-ecs-fication M2 / w16).
//
// Single ECS fat component carrying everything that used to live on the
// old `SceneInstance` + `SceneInstanceContainer` pair (deleted
// in M3). Schema fits the ECS schema vocab (3 single-identifier fields):
//
//   { source:  'shared<SceneAsset>',
//     mapping: 'array<entity>',
//     state:   'unique<SceneInstanceState>' }
//
// `source` carries the SceneAsset handle the synthetic root entity was
// instantiated from (Tier-A AssetUnion handle, AGENTS.md §Assets submodule).
// `mapping` is the LocalEntityId -> Entity table indexed positionally
// (mapping[localId] = spawned Entity); the ECS variable-array column gives
// us a SoA-friendly read path for query<SceneInstance> scans without
// touching the dynamic Map/Set state.
// `state` is a `ref<SceneInstanceState>` slot — World holds the live
// SceneInstanceState payload in its UniqueRefStore and World despawn
// auto-releases the ref u32 (the same path used by audio / physics
// payloads, plan-strategy §D-2). Each instantiateScene call calls
// `world.allocUniqueRef('SceneInstanceState', state)` once and stores the
// returned u32 in this column.
//
// Decision anchors:
//   - plan-strategy §D-2 (single ref wraps SceneInstanceState dynamic
//     structure; ECS schema vocab `\w+` rejects `ref<Map<...>>`)
//   - plan-strategy §3.2 sequence (sequence diagram step 'set ... state:
//     {entityToLocalId, detached, overrides, rootEntities}')
//   - AGENTS.md §Component naming rule #1 (single-semantic component drops
//     `Component` suffix)
//   - charter F1 (single-import barrel: SceneInstance lives in
//     `@forgeax/engine-render` next to Transform / Camera / DirectionalLight)
//   - charter P3 (machine-readable schema: 3 closed fields)
//   - charter P4 (consistent abstraction: instance == entity carrying
//     SceneInstance — same `world.query({ read: [SceneInstance] })` /
//     `world.get(root, SceneInstance)` path as another component)

import { defineComponent } from '@forgeax/engine-ecs';

export type { SceneInstanceOverrideRecord, SceneInstanceState } from '@forgeax/engine-scene';

/**
 * SceneInstance ECS component — synthetic root entity payload for one
 * materialised SceneAsset (instance == entity carrying SceneInstance,
 * charter P4).
 *
 * AI users discover the component via IDE autocomplete on
 * `@forgeax/engine-render` (single-import barrel; AGENTS.md §Components):
 *
 * ```ts
 * import { SceneInstance } from '@forgeax/engine-render';
 * for (const row of world.query({ read: [SceneInstance] }).unwrap()) {
 *   console.log(`root=${row.entity} source=${row.get(SceneInstance).source}`);
 * }
 *
 * const inst = world.get(root, SceneInstance).value;
 * const memberEntity = inst.mapping[localId]; // Uint32Array snapshot
 * for (const detached of inst.state.detachedLocalIds) { /* ... *\/ }
 * ```
 *
 * The component does not register a relationship — synthetic root +
 * members are wired through the standard `ChildOf` (member -> root) so
 * the existing `world.iterDescendants(root)` / Children mirror code paths
 * apply unchanged (plan-strategy §D-5).
 *
 * @example Materialise + inspect a SceneAsset:
 *   const { root, diagnostics } = world.instantiateScene(handle).value;
 *   const inst = world.get(root, SceneInstance).value;
 *   // inst.source === handle, inst.mapping is Uint32Array(totalSlots)
 *   // inst.state holds entityToLocalId / detachedLocalIds / overrides /
 *   // rootEntities / mountRoots / totalSlots / mountTimeOverrides.
 */
export const SceneInstance = defineComponent(
  'SceneInstance',
  {
    source: { type: 'shared<SceneAsset>' },
    mapping: { type: 'array<entity>' },
    // The unique slot is the ECS storage seam for the instance's structured
    // runtime payload; keep the nested semantic visible to schema consumers.
    state: { type: 'unique<SceneInstanceState>', shape: 'nested' },
  },
  { transient: true },
);
