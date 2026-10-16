// @forgeax/engine-runtime - SpritePlaybackMode (u32 column encoding + mapper).
//
// SSOT for the SpriteAnimation.playbackMode ECS column (M2 T-12) and the
// runtime tick-system branch selector (M4 T-23). The shape mirrors the M1
// `Tonemap` block in `./camera.ts:72-90` (TONEMAP_NONE = 0 /
// TONEMAP_REINHARD_EXTENDED = 1 + `type Tonemap = 'none' |
// 'reinhard-extended'` + `tonemapFromF32`) for charter P4 consistent
// abstraction — AI users keep one mental model across all u32-encoded
// closed-union schema columns.
//
// Why `'u32'` + constant + mapper instead of a string-literal column?
// ECS schema whitelist `SchemaFieldType` (packages/ecs/src/component.ts
// section schema-field-type) does not accept string-literal unions
// (research F-2 + F-5). Storing a u32 + translating to a closed
// `'loop' | 'clamp'` literal union at the tick-system seam preserves
// AI-user-facing narrowing (`switch (mode) { case 'loop': ... }`)
// without forcing the ECS column to learn a new field-type vocabulary.
//
// Naming convention (plan-strategy section 8.command naming):
//   SPRITE_PLAYBACK_MODE_LOOP / SPRITE_PLAYBACK_MODE_CLAMP mirror M1
//   TONEMAP_* / TRANSPARENT_SORT_MODE_*. `spritePlaybackModeFromU32`
//   mirrors `tonemapFromF32` / `cameraProjectionFromF32`. AI users
//   discover the trio via single-import barrel re-export from
//   `@forgeax/engine-runtime` (wired in by M2 T-13).
//
// Anchors: plan-strategy section 2 D-5 + section 3.1 PR block SPM +
//          section 4 risk R-SCHEMA-1 reaction; research F-2 + F-5;
//          requirements section AC-02 + section 2.3 playbackMode row;
//          plan-tasks.json T-07 acceptanceCheck (rg
//          "SPRITE_PLAYBACK_MODE_LOOP|SPRITE_PLAYBACK_MODE_CLAMP|
//          spritePlaybackModeFromU32" >= 3 hits in this file).

/**
 * Playback mode discriminator literal union (requirements section AC-02 +
 * section 2.3). Two members for the MVP:
 *
 *   `'loop'`  — `currentFrame = (currentFrame + 1) % frameCount`; the
 *               sprite-animation-tick system wraps the index when
 *               `accumDt >= frameDuration` (default for hello-sprite-
 *               atlas demo "100 sprites synchronised walk cycle").
 *   `'clamp'` — `currentFrame = min(currentFrame + 1, frameCount - 1)`;
 *               holds the last frame for death / terminator-animation
 *               style sequences (requirements section 2.5 q8 lock).
 *
 * Future modes (`'pingpong'`, reverse playback, arbitrary frame index
 * jumps) are deferred per requirements OOS-03. The closed union shape
 * leaves room for additive growth without breaking the u32 enum encoding
 * (plan-strategy section 2 D-5).
 */
export type SpritePlaybackMode = 'loop' | 'clamp';

/** Numeric encoding of the loop playback mode (schema value for `playbackMode`). */
export const SPRITE_PLAYBACK_MODE_LOOP = 0 as const;

/** Numeric encoding of the clamp playback mode (schema value for `playbackMode`). */
export const SPRITE_PLAYBACK_MODE_CLAMP = 1 as const;

/** Grouped authoring values; the numeric ECS encoding stays owner-local. */
export const SpritePlayback = Object.freeze({
  loop: SPRITE_PLAYBACK_MODE_LOOP,
  clamp: SPRITE_PLAYBACK_MODE_CLAMP,
} as const);

/**
 * Map a `SpriteAnimation.playbackMode` numeric column value to the closed
 * `SpritePlaybackMode` string-literal union. The defensive fallback mirrors
 * `cameraProjectionFromF32` / `tonemapFromF32` precedent — a value other
 * than `SPRITE_PLAYBACK_MODE_CLAMP` (1) maps to `'loop'`, so stale or
 * uninitialised entities surface a predictable playback shape through the
 * tick-system query (rather than throwing or returning `undefined`).
 * Validation of `playbackMode` happens at schema-write time, not here.
 *
 * The tick-system in M4 T-23 (`spriteAnimationTickSystem`) consumes the
 * return value via `switch (mode) { case 'loop': ...; case 'clamp': ... }`
 * to pick the per-branch frame-advance arithmetic.
 */
export function spritePlaybackModeFromU32(value: number): SpritePlaybackMode {
  return value === SPRITE_PLAYBACK_MODE_CLAMP ? 'clamp' : 'loop';
}
