// @forgeax/engine-render - Layer (render-order layer index, signed 32-bit).
//
// Schema: 1 i32 column (value). Signed two's complement so negatives travel
// through the spawn payload unchanged — background sprites live at negative
// values (e.g. -100), the default game layer at 0, foreground at 100, UI at
// 1000. Layer is consumed at sort time by `TransparentSortCache`
// (systems/transparent-dispatch.ts) as the primary key in the
// (layer asc, sortValue asc) composite ordering.
//
// Naming convention: bare entity name (no Component suffix; single-semantic
// component idiom aligned with Bevy ECS conventions — Transform / Camera /
// DirectionalLight follow the same shape, see AGENTS.md §Component naming).
//
// Layer is a generic ECS renderer component — NOT a 2D-only special. 3D
// entities may also carry Layer to bias their bucket placement (charter
// P4 consistent abstraction: same component drives both pipelines).
//
// AC-18 path (1): an entity spawned without an explicit Layer reads back
// 0 via the existing 4-layer spawn fallback chain
// (feat-20260517-spawn-default-fallback). This feat does NOT introduce a
// fifth fallback layer; the silent default flows through layer-3
// `typeDefault('i32') === 0`.
//
// @derives defineComponent factory (packages/ecs/src/component.ts) — i32
//   is a legacy scalar type; its intrinsic properties (byteSize / viewCtor
//   / storage) live in TYPE_METADATA['i32'] (feat-20260602 M1).
// @reuses spawn 4-layer fallback chain (feat-20260517-spawn-default-fallback)
//   — layer-3 typeDefault('i32') returns 0, no fifth layer.
//
// charter mapping: F1 (single-import barrel discovery — Layer joins
// Transform / MeshFilter / MeshRenderer / Camera / DirectionalLight)
// + P3 (explicit default — 0 surfaces as a read-back value, not undefined)
// + P4 (consistent abstraction — Layer is a generic render component, not
// a 2D-only special).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Render-order layer index.
 *
 * Convention (non-binding; conveys intent, not enforced):
 *   - negative (e.g. -100): background layers (sky / parallax tiles).
 *   - 0: default game layer.
 *   - positive (e.g. 100): foreground layers (overlays, FX).
 *   - 1000+: UI / HUD.
 *
 * Signed i32 (two's complement, range \u00b12\u00b3\u00b9). Negatives round-trip
 * through the spawn payload unchanged — no schema-layer mutate. i32 lives in
 * the CPU sort path (`TransparentSortCache`); no GPU-side stride
 * compatibility risk.
 *
 * @example Minimal spawn (defaults to game layer 0):
 *   world.spawn({ component: Layer, data: {} }); // yields value=0
 *
 * @example Spawn 4 sprites across the conventional layer band:
 *   world.spawn({ component: Layer, data: { value: -100 } }); // background
 *   world.spawn({ component: Layer, data: { value: 0 } });    // default
 *   world.spawn({ component: Layer, data: { value: 100 } });  // foreground
 *   world.spawn({ component: Layer, data: { value: 1000 } }); // UI
 *
 * @example Spawn payload omitting Layer — the 4-layer fallback fills 0:
 *   const e = world.spawn(
 *     { component: Transform, data: { pos: [0, 0, 0],
 *       quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
 *   );
 *   // Layer is not on the entity; query joins must check membership.
 */
export const Layer = defineComponent('Layer', {
  value: { type: 'i32', default: 0 },
});
