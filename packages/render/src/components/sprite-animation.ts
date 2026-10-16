// @forgeax/engine-runtime - SpriteAnimation (per-entity frame-tick clock).
//
// 6-field schema (1:1 with requirements section 2.3 table; D-5 + D-6
// vocab keywords locked):
//
//   frameCount    : 'u32'         total frames in the cycle (>= 1).
//   frameDuration : 'f32'         per-frame seconds (> 0).
//   currentFrame  : 'u32'         live frame index, in [0, frameCount).
//   accumDt       : 'f32'         dt accumulator (research F-3 carries
//                                  fractional residue across ticks).
//   regions       : 'array<f32>'  flat per-frame UV rectangles
//                                  [uMin, vMin, uW, vH]; the M4 tick
//                                  system enforces
//                                  `regions.length === frameCount * 4`
//                                  on first observation (AC-09 fail-fast,
//                                  D-1 path).
//   playbackMode  : 'u32'         numeric encoding of `SpritePlaybackMode`
//                                  (0 = SPRITE_PLAYBACK_MODE_LOOP,
//                                   1 = SPRITE_PLAYBACK_MODE_CLAMP).
//
// Why u32 for playbackMode? research F-2 + F-5: the ECS schema whitelist
// rejects string-literal unions. The M1 SSOT
// `packages/runtime/src/components/sprite-playback-mode.ts` carries the
// numeric constants + the `spritePlaybackModeFromU32` mapper that turns
// the column value back into a string-literal union at the M4 tick-system
// seam — same shape as the M1 Tonemap encoding (`tonemap: 'f32'` +
// TONEMAP_NONE / TONEMAP_REINHARD_EXTENDED + tonemapFromF32). One mental
// model across all closed-union schema columns; charter P4 consistent
// abstraction.
//
// Why array<f32> (variable) and not array<f32, N> (fixed) for regions?
// The length `frameCount * 4` is data-dependent: `frameCount` is itself a
// per-entity column read at runtime, not a schema-time literal. Same
// shape as the renderer-owned 3D instance collection snapshot whose length
// depends on the live instance count; the owners remain separate.
//
// dt accumulator clock model (requirements section 2.5 q6 + plan-strategy
// section 2 D-5):
//   accumDt += Time.delta
//   while (accumDt >= frameDuration) { advance currentFrame; accumDt -= frameDuration }
// The carry-over `accumDt` survives across ticks so frame timing stays
// stable under jittery dt; M4 T-23 implements the loop. Per-frame UV
// is materialised by writing the slice
// `regions[currentFrame*4 .. currentFrame*4 + 4]` into the entity's
// `SpriteRegionOverride.region` column (T-11 + M4 T-23).
//
// Sprite-only consumption (requirements section 5 constraint #2): the
// M4 tick system + the M3 extract branch read this component only when
// the entity routes through the sprite bucket. Opaque buckets ignore
// the component even when present. Naming keeps the `Sprite` prefix per
// OOS-01 (no premature 3D generalisation); 3D UV animation lands in a
// separate component in a future feat.
//
// 4-step recipe (charter F1 progressive disclosure — minimum walk-cycle
// host code; full demo lands in M6 hello-sprite-atlas):
//   1. Build atlas via `forgeax asset atlas --input <glob> --name <prefix> --output <dir> --root <project>`
//      (M5 build-time hook); load the emitted `<name>.atlas.png` plus
//      `<name>.atlas.meta.json` sidecar.
//   2. Register the sprite material referencing the atlas
//      `TextureAsset` with the initial frame's `region` rectangle (the
//      runtime tick system overrides this region per entity per frame).
//   3. `world.spawn` an entity with `MeshFilter(HANDLE_QUAD)` +
//      `MeshRenderer(spriteMaterial)` + `Instances(...)` plus this
//      `SpriteAnimation` (frameCount / frameDuration / regions /
//      playbackMode) and `SpriteRegionOverride { region }` (the tick
//      system writes per-frame UV).
//   4. Add `spriteAnimationTickSystem` (M4 T-23) to the schedule between
//      input/time and `RenderSystem.extract`.
//
// @derives `defineComponent` factory (packages/ecs/src/component.ts) —
//   `'u32'` / `'f32'` are scalar tier-1 keywords; `'array<f32>'` is a
//   tier-2 schema-vocab keyword (variable-capacity; M1 feat-20260515
//   buffer-array vocab). Layer-3 default fallback fills missing
//   `currentFrame` / `accumDt` / `playbackMode` with 0
//   (component-default-fallback typeDefault table).
// @consumes M4 T-23 (`spriteAnimationTickSystem` reads all 6 fields and
//   writes per-frame slice into SpriteRegionOverride).
//
// charter mapping: F1 (single-import barrel discovery + 4-step recipe
// at the JSDoc head); P3 (4 explicit error fields surface via the M4
// tick-system fail-fast — `regions.length` mismatch / `frameDuration`
// non-positive routes through SpriteAnimationInvalidError, M1 T-05);
// P4 (consistent abstraction — same numeric closed-union encoding as
// Tonemap / TransparentSortConfig.mode); P5 (producer / consumer
// separation — atlas regions are produced build-time by
// vite-plugin-image and consumed runtime as a flat Float32Array; AI
// users never call a packer at runtime).
//
// Anchors: plan-strategy section 2 D-5 + D-6 + section 3.1 SAC + section
// 4 risks R-SCHEMA-1 + R-SCHEMA-2 + R-TIME-1 reaction; plan-tasks.json
// T-12; research F-2 + F-3 + F-5; requirements section AC-02 + section
// 2.3 + section 2.5 + section 7 boundary table.

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Per-entity sprite frame-tick clock.
 *
 * Schema (6 fields, 1:1 with requirements section 2.3):
 * - `frameCount: u32` — total frames (>= 1).
 * - `frameDuration: f32` — seconds per frame (> 0).
 * - `currentFrame: u32` — live frame index (0..frameCount). Layer-3
 *   default `0` when omitted at spawn.
 * - `accumDt: f32` — dt residue carried across ticks. Layer-3 default
 *   `0` when omitted; lives on the component (not on a system-side
 *   resource) so the system stays stateless and AI-user setFrame paths
 *   can reset both `currentFrame` and `accumDt` atomically.
 * - `regions: array<f32>` — flat per-frame UV rectangles
 *   `[uMin, vMin, uW, vH]`; runtime invariant
 *   `regions.length === frameCount * 4` (enforced by the M4 tick system).
 * - `playbackMode: u32` — numeric encoding of `SpritePlaybackMode`;
 *   `SPRITE_PLAYBACK_MODE_LOOP = 0` (default) /
 *   `SPRITE_PLAYBACK_MODE_CLAMP = 1`.
 *
 * Pair with `SpriteRegionOverride` (T-11) — the tick system writes the
 * per-frame UV slice into the override column, which `render-system-
 * extract` then reads in the sprite bucket branch.
 *
 * @example Spawn a 4-frame walk cycle that loops:
 *   import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
 *   import {
 *     SpriteAnimation, SpriteRegionOverride, SPRITE_PLAYBACK_MODE_LOOP,
 *   } from '@forgeax/engine-render/authoring';
 *   import { Transform } from '@forgeax/engine-scene';
 *   import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
 *
 *   // 4 frames packed in an atlas, each 64x64 inside a 256x64 row:
 *   const regions = new Float32Array([
 *     0.00, 0, 0.25, 1,  // walk-0
 *     0.25, 0, 0.25, 1,  // walk-1
 *     0.50, 0, 0.25, 1,  // walk-2
 *     0.75, 0, 0.25, 1,  // walk-3
 *   ]);
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 0, 0],
 *       quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
 *     { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
 *     { component: MeshRenderer, data: { materials: [spriteMaterial] } },
 *     { component: SpriteAnimation,
 *       data: {
 *         frameCount: 4,
 *         frameDuration: 0.1,
 *         regions,
 *         playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
 *       } },
 *     { component: SpriteRegionOverride,
 *       data: { region: new Float32Array([0, 0, 0.25, 1]) } },
 *   );
 *
 * @example Manual setFrame — jump to frame 2 atomically:
 *   world.set(entity, SpriteAnimation,
 *     { currentFrame: 2, accumDt: 0 }).unwrap();
 *
 * Error path (M4 T-23 routes through `SpriteAnimationInvalidError`,
 * `EcsErrorCode === 'sprite-animation-invalid'`; charter P3):
 * - `regions.length !== frameCount * 4` -> detail.field = 'regions-length',
 *   detail carries `regionsLength` + `frameCount`.
 * - `frameDuration <= 0` -> detail.field = 'frame-duration', detail carries
 *   `frameDuration`.
 */
export const SpriteAnimation = defineComponent('SpriteAnimation', {
  frameCount: { type: 'u32' },
  frameDuration: { type: 'f32' },
  currentFrame: { type: 'u32', transient: true },
  accumDt: { type: 'f32', transient: true },
  regions: { type: 'array<f32>' },
  playbackMode: { type: 'u32' },
});
