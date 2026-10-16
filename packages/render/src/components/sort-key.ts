// @forgeax/engine-render - SortKey (per-entity transparent sort override, f32).
//
// Schema: 1 f32 column (value). Entity-level sort override read at extract
// time and carried on Points/Lines retained snapshots. The mesh transparent
// order owner, `TransparentSortCache` (systems/transparent-dispatch.ts),
// currently derives its secondary key from TransparentSortConfig.mode only
// and does not read SortKey.
//
// Like Layer, SortKey is a generic ECS renderer component — NOT a
// 2D-only special. 3D entities may also carry SortKey to bias their
// position inside the transparent bucket (charter P4 consistent
// abstraction: same component drives both pipelines).
//
// AC-19 derivation audit row (4) names this file as the
// `defineComponent` factory derivation. JSDoc surfaces the override
// priority via @derives (ECS factory) annotation; the consumer side
// of the override behaviour belongs to the sort owner, not here.
//
// @derives defineComponent factory (packages/ecs/src/component.ts) —
//   f32 is a legacy scalar type; its intrinsic properties (byteSize / viewCtor
//   / storage) live in TYPE_METADATA['f32'] (feat-20260602 M1).
//
// charter mapping: F1 (single-import barrel - joins Layer / Transform
// / MeshFilter / MeshRenderer / Camera / DirectionalLight) +
// P3 (explicit default 0.0 surfaces via the 4-layer fallback chain) +
// P4 (consistent abstraction — generic render component, not 2D-only).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Per-entity transparent-sort override.
 *
 * When attached to an entity inside the transparent bucket (M-3 w22),
 * `SortKey.value` REPLACES the result of `TransparentSortConfig.mode`
 * formula evaluation for this entity. Sort key range is the host's
 * choice — typical use is small (e.g. -10 ... +10) to keep the
 * composite (layer asc, sortValue asc) ordering predictable; large
 * magnitudes work but cross-layer biasing should usually go through
 * `Layer` instead.
 *
 * Intended override priority (not yet consumed by `TransparentSortCache`):
 *
 *   if (world.has(entity, SortKey)) {
 *     sortValue = world.get(entity, SortKey).value;
 *   } else {
 *     sortValue = modeFormula(mode, transform, sprite);
 *   }
 *
 * SortKey lives alongside Layer in the (layer, sortValue) composite
 * key — Layer remains the primary key, SortKey replaces the secondary
 * key. This means a `Layer { value: 100 }` foreground entity with
 * `SortKey { value: -99 }` still draws AFTER a `Layer { value: 0 }`
 * background entity; SortKey biases WITHIN a layer, not ACROSS layers.
 *
 * @example Minimal spawn (no override, use mode formula):
 *   world.spawn({ component: SortKey, data: {} }); // yields value=0
 *
 * @example Bias one sprite above the JRPG Y-sort formula:
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 1, 0],
 *       quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
 *     { component: Layer, data: { value: 0 } },
 *     { component: SortKey, data: { value: -100 } },
 *   );
 *
 * @example Spawn payload omitting SortKey — the 4-layer fallback fills 0:
 *   // entity reads back SortKey only if explicitly attached;
 *   // otherwise the mode-formula path is taken by the sort owner.
 */
export const SortKey = defineComponent('SortKey', {
  value: { type: 'f32', default: 0 },
});
