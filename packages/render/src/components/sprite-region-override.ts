// @forgeax/engine-runtime - SpriteRegionOverride (per-entity UV region
// override, sprite-only).
//
// Schema: 1 fixed-length array column `region: 'array<f32, 4>'` carrying a
// packed UV sub-rectangle `[uMin, vMin, uW, vH]`. The fixed `4` length is
// enforced at compile time by the ECS schema-vocab keyword
// `'array<T, N>'` (D-6: prefer compile-time enforcement over runtime
// fail-fast for length-bound contracts).
//
// Why an entity-side override component instead of a render parameter on
// MaterialRenderer? Plan-strategy section 1 / requirements section 5
// constraint #1 (Pipeline Isolation R1, M1 ssot): `AssetRegistry` stays
// append-only / read-only and `MaterialRenderer` schema is frozen.
// Per-entity render-parameter overrides ride the same rail as Layer /
// SortKey — one ECS column per entity, read at extract time, never
// flowing back to the asset.
//
// Sprite-only consumption (requirements section 5 constraint #2 + section
// 7 boundary line 1): `render-system-extract` reads this component ONLY
// inside the sprite bucket branch (`pipelineTag === 'sprite'` plus the
// asset-side sprite discriminant). Opaque (`unlit` / `standard`) buckets
// ignore the column even when the entity happens to carry it; the M3
// T-15 grep gate
// (`packages/runtime/src/__tests__/sprite-only-isolation-grep-gate.test.ts`)
// asserts this file contains zero substring matches against the asset
// discriminant identifier as a structural lock (charter P5 producer /
// consumer separation: the component owner never names the asset
// discriminant directly).
//
// Naming: bare `SpriteRegionOverride` (no `Component` suffix per
// AGENTS.md section Component naming "Single-semantic components drop
// the Component suffix"). The `Sprite` prefix is intentional — 3D UV
// region animation lands in a separate component (e.g. future
// `MaterialRegionOverride`) per OOS-01 to avoid premature 3D
// generalisation. Plan-strategy section 8 naming convention pins the
// prefix to make the AC-11 grep gate trivially decidable.
//
// @derives `defineComponent` factory (packages/ecs/src/component.ts) —
//   `'array<f32, 4>'` is on the `SchemaVocabKeyword` whitelist (line ~94
//   `array<${ManagedArrayElementType}, ${number}>`).
// @consumes M3 T-16 (`render-system-extract.ts` sprite bucket branch
//   reads override into `paramSnapshot.region`, post-M3 feat-20260625
//   ablation -- the pre-ablation per-entity hop through the snapshot
//   POD layer collapsed into the generic paramSchema-driven path).
// @produces M4 T-23 (`spriteAnimationTickSystem` writes per-frame UV
//   slice into `region`).
//
// charter mapping: F1 (single-import barrel discovery — joins Layer /
// SortKey / Transform / SpriteAnimation under a single
// `from '@forgeax/engine-render'`); P3 (compile-time length=4 lock
// surfaces mismatched payloads at the TS edge before the column write
// path observes them); P4 (consistent abstraction — same per-entity
// override shape AI users already learned for Layer / SortKey).
//
// Anchors: plan-strategy section 2 D-6 + section 3.1 SRO + section 4
// risk R-SCHEMA-2 reaction; plan-tasks.json T-11; research F-5;
// requirements section AC-01 + section 2.4 + section 5 constraint #2.

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Per-entity sprite UV region override (sprite-only).
 *
 * Carries a fixed-length `Float32Array(4)` of `[uMin, vMin, uW, vH]` that
 * `render-system-extract` reads in the sprite bucket branch and writes
 * into `paramSnapshot.region`, replacing the asset-side region for
 * this entity only (feat-20260625 M3 ablation: the prior per-entity POD
 * indirection collapsed into the generic paramSchema-driven snapshot).
 * Opaque buckets ignore this component; the AC-11 grep gate keeps the
 * producer / consumer separation structural (this file never names the
 * asset-side sprite discriminant identifier).
 *
 * Pair with `SpriteAnimation` to drive the override per frame
 * (sprite-animation-tick system, M4 T-23). Standalone use (manual region
 * override without animation) is also supported — set the column once and
 * the next extract picks up the new value.
 *
 * Schema-vocab keyword `'array<f32, 4>'` (D-6) — fixed-length 4 is the
 * compile-time enforcement axis. `Float32Array` payloads with length !== 4
 * round-trip fewer / more bytes per the underlying BufferPool slot, but
 * the slot is sized at schema registration time; AI users keep the
 * payload exactly four-floats wide.
 *
 * @example Spawn a sprite entity that displays the right half of an atlas:
 *   import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
 *   import { SpriteRegionOverride } from '@forgeax/engine-render/authoring';
 *   import { Transform } from '@forgeax/engine-scene';
 *   import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
 *
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 0, 0],
 *       quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
 *     { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
 *     { component: MeshRenderer, data: { materials: [spriteMaterial] } },
 *     { component: SpriteRegionOverride,
 *       data: { region: new Float32Array([0.5, 0, 0.5, 1]) } },
 *   );
 *
 * @example Update the override at runtime (e.g. flip-frame test):
 *   world.set(entity, SpriteRegionOverride,
 *     { region: new Float32Array([0, 0, 1, 1]) }).unwrap();
 */
export const SpriteRegionOverride = defineComponent('SpriteRegionOverride', {
  region: { type: 'array<f32, 4>' },
});
