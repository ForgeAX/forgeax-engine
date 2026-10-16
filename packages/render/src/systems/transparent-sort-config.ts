import type { RenderResourceScope } from '../publication/resource-scope';
// @forgeax/engine-runtime - TransparentSortConfig KV resource + helpers.
//
// feat-20260520-2d-sprite-layer-mvp M-2 w14 / requirements AC-08 + AC-18
// path (2)/(3) + AC-19 derivation audit (5).
//
// Surface:
//   - interface  TransparentSortConfig { mode: number; yzAlpha: number }
//   - constant   TRANSPARENT_SORT_CONFIG_KEY   = 'TransparentSortConfig'
//   - constants  TRANSPARENT_SORT_MODE_LAYER_Z  = 0  (horizontal-z)
//                TRANSPARENT_SORT_MODE_LAYER_Y  = 1  (Y-sort)
//                TRANSPARENT_SORT_MODE_LAYER_YZ = 2  (Y-Z blend)
//   - helper     getTransparentSortConfig(world): TransparentSortConfig
//   - helper     setTransparentSortConfig(world, cfg):
//                  Result<void, ResourceInvalidValueError>
//
// 5-view selection table (charter F1 progressive disclosure for AI users
// reading IDE hover on this header; same SSOT mirrored in
// apps/hello/sprite/README.md M-4 w33):
//
//   | view              | mode | yzAlpha | sortValue formula              |
//   |:------------------|:----:|:-------:|:--------------------------------|
//   | horizontal (side) |  0   |   ---   | posZ                            |
//   | top-down          |  1   |   ---   | -(posY - pivot.y * size.y)      |
//   | Don't Starve      |  2   |   1.0   | (posY - pivot.y * size.y) + posZ|
//   | isometric         |  2   |   0.5   | (posY - pivot.y * size.y) + 0.5*posZ |
//   | JRPG (foot pivot) |  1   |   ---   | -(posY - pivot.y * size.y)      |
//
// AC-18 path (2): @fallback getTransparentSortConfig KV missing returns
//   default; no warn; no throw (legal default state, not an error state).
// AC-18 path (3): @fallback setTransparentSortConfig mode out-of-range
//   does NOT silently coerce to mode=0 — returns Result.err with the
//   4 SSOT fields locked by plan-strategy D-4 so AI users can self-repair
//   via .code / .expected / .hint / .detail property access (charter P3).
// AC-18 path (3) carve-out: yzAlpha range is intentionally NOT validated;
//   mode=0 / mode=1 ignore the field entirely, mode=2 reads it, mode=3
//   (distance) also reads it for compat but ignores it (squared-distance
//   formula does not use yzAlpha). The silent-ignore is the documented
//   charter P3 "legal default" boundary.
//
// @new-surface KV resource: ECS has no defineResource factory at this
//   feat's commit time; the TS POD interface + string KV key form is the
//   minimum-new-surface route. The world resource store
//   (insertResource / getResource / hasResource) is reused unchanged
//   (requirements §2.2.G derivation row 5).
// @derives world.hasResource / world.insertResource / world.getResource
//   KV API (packages/ecs/src/resource.ts + world.ts: insertResource l.490,
//   getResource l.498, hasResource l.503).
// @fallback getTransparentSortConfig KV missing returns
//   { mode: 0, yzAlpha: 1.0 }; no warn; no throw.
// @fallback setTransparentSortConfig mode out-of-range returns Result.err
//   with code='resource-invalid-value'; never silently coerced.
//
// charter mapping: F1 (single-import barrel + 5-view JSDoc table on
// hover) + P3 (structured failure on mode out-of-range; legal-default
// fallback distinguished from error fallback) + P4 (consistent
// abstraction — same world.{has,get,insert}Resource KV API as every
// other engine resource consumer).

import type { World } from '@forgeax/engine-ecs';
import { ResourceInvalidValueError } from '@forgeax/engine-ecs/projection';
import { err, ok, type Result } from '@forgeax/engine-types';

// ────────────────────────────────────────────────────────────────────────────
// POD interface + KV key + 3 named mode constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Transparent-bucket sort configuration (plain-data POD). Lives as a
 * world-level resource keyed by `TRANSPARENT_SORT_CONFIG_KEY`.
 *
 * Fields:
 *   - `mode \u2208 {0, 1, 2, 3}` selects the sort formula
 *     (`TRANSPARENT_SORT_MODE_LAYER_Z` / `_LAYER_Y` / `_LAYER_YZ` / `_DISTANCE`).
 *   - `yzAlpha` (mode=2 only) blends Y-axis into Z-axis: 1.0 weights
 *     posZ equally with `posY - pivot.y * size.y` (Don't-Starve style),
 *     0.5 weights posZ at half (isometric). mode=0 / mode=1 ignore the
 *     field (documented charter P3 legal-default boundary).
 */
export interface TransparentSortConfig {
  readonly mode: number;
  readonly yzAlpha: number;
}

/** World resource key for `TransparentSortConfig` KV entry. */
export const TRANSPARENT_SORT_CONFIG_KEY = 'TransparentSortConfig' as const;

/** horizontal / side-scroller: sortValue = posZ. */
export const TRANSPARENT_SORT_MODE_LAYER_Z = 0;

/** top-down / JRPG: sortValue = -(posY - pivot.y * size.y) (foot pivot Y-sort). */
export const TRANSPARENT_SORT_MODE_LAYER_Y = 1;

/** Don't-Starve / isometric: sortValue = (posY - pivot.y * size.y) + yzAlpha * posZ. */
export const TRANSPARENT_SORT_MODE_LAYER_YZ = 2;

/** 3D distance: sortValue = -(dist^2) to cameraPos, back-to-front (far first). */
export const TRANSPARENT_SORT_MODE_DISTANCE = 3;

/** Grouped authoring values and the single configuration operation. */
export const TransparentSort = Object.freeze({
  layerZ: TRANSPARENT_SORT_MODE_LAYER_Z,
  layerY: TRANSPARENT_SORT_MODE_LAYER_Y,
  layerYZ: TRANSPARENT_SORT_MODE_LAYER_YZ,
  distance: TRANSPARENT_SORT_MODE_DISTANCE,
  configure: setTransparentSortConfig,
} as const);

// ────────────────────────────────────────────────────────────────────────────
// Internal: silent default + mode validity check
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TransparentSortConfig = Object.freeze({
  mode: TRANSPARENT_SORT_MODE_LAYER_Z,
  yzAlpha: 1.0,
});

const VALID_MODES: ReadonlySet<number> = new Set<number>([
  TRANSPARENT_SORT_MODE_LAYER_Z,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_DISTANCE,
]);

// The expected / hint literals are the SSOT locked by plan-strategy D-4.
// They MUST round-trip byte-for-byte into ResourceInvalidValueError so AI
// users can read err.expected / err.hint for self-repair (charter P3).
// `\u2208` is the math "is-element-of" symbol; the ASCII source escape
// keeps the file English-only per AGENTS.md §Conventions.
const EXPECTED_MODE = 'mode \u2208 {0, 1, 2, 3}';
const HINT_MODE = '0=layer-z, 1=layer-y, 2=layer-yz, 3=distance';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read the world's `TransparentSortConfig` resource.
 *
 * @fallback KV missing returns `{ mode: 0, yzAlpha: 1.0 }`
 * (`TRANSPARENT_SORT_MODE_LAYER_Z`, horizontal-z safe default).
 * NO warn, NO throw — KV missing is a legal state (not an error state),
 * mirroring how a sprite-free scene is a legal state for the renderer
 * even though render-system has a transparent bucket. plan-strategy D-2:
 * `hasResource` guard precedes the read so this helper never trips
 * `ResourceNotFoundError` from `world.getResource`.
 *
 * @example
 *   const cfg = getTransparentSortConfig(world);
 *   // cfg.mode === 0, cfg.yzAlpha === 1.0 when no resource inserted.
 *
 * @example
 *   world.insertResource(TRANSPARENT_SORT_CONFIG_KEY,
 *     { mode: TRANSPARENT_SORT_MODE_LAYER_Y, yzAlpha: 1.0 });
 *   const cfg = getTransparentSortConfig(world);
 *   // cfg.mode === 1, cfg.yzAlpha === 1.0 (yzAlpha ignored by mode=1).
 */
export function getTransparentSortConfig(world: RenderResourceScope): TransparentSortConfig {
  if ('resolveAsset' in world) return world.transparentSort;
  if (!world.hasResource(TRANSPARENT_SORT_CONFIG_KEY)) {
    return DEFAULT_CONFIG;
  }
  return world.getResource<TransparentSortConfig>(TRANSPARENT_SORT_CONFIG_KEY);
}

/**
 * Write the world's `TransparentSortConfig` resource, validating `mode`.
 *
 * Returns `Result<void, ResourceInvalidValueError>`:
 *
 *   - `ok` — mode is in `{0, 1, 2, 3}`; the resource is inserted /
 *     overwritten via `world.insertResource`.
 *   - `err` — mode is out of range; the resource is NOT mutated;
 *     `err.error` is a `ResourceInvalidValueError` instance carrying:
 *       `.code === 'resource-invalid-value'`
 *       `.expected === 'mode \u2208 {0, 1, 2, 3}'`
 *       `.hint === '0=layer-z, 1=layer-y, 2=layer-yz, 3=distance'`
 *       `.detail.receivedMode === <the rejected mode>`
 *
 * @fallback mode out-of-range is NEVER silently coerced to mode=0 —
 * `Result.err` is the only fail-mode (charter P3 structured failure).
 * AI users read `.code / .expected / .hint / .detail` properties to
 * self-repair, NOT the human-readable `.message` string.
 *
 * @fallback yzAlpha range is intentionally not validated; mode=0 / mode=1
 * ignore the field, mode=2 reads it. The silent-ignore is the
 * documented charter P3 "legal default" boundary (plan-strategy D-4 +
 * AC-18 path (3) carve-out).
 *
 * @example success path:
 *   const r = setTransparentSortConfig(world,
 *     { mode: TRANSPARENT_SORT_MODE_LAYER_YZ, yzAlpha: 0.5 });
 *   if (!r.ok) return r;
 *
 * @example failure path:
 *   const r = setTransparentSortConfig(world, { mode: 99, yzAlpha: 1.0 });
 *   if (!r.ok) {
 *     // r.error.code === 'resource-invalid-value'
 *     // r.error.expected === 'mode \u2208 {0, 1, 2, 3}'
 *     // r.error.hint === '0=layer-z, 1=layer-y, 2=layer-yz, 3=distance'
 *     // r.error.detail.receivedMode === 99
 *   }
 */
export function setTransparentSortConfig(
  world: World,
  cfg: TransparentSortConfig,
): Result<void, ResourceInvalidValueError> {
  if (!VALID_MODES.has(cfg.mode)) {
    return err(
      new ResourceInvalidValueError(EXPECTED_MODE, HINT_MODE, {
        receivedMode: cfg.mode,
        receivedKey: TRANSPARENT_SORT_CONFIG_KEY,
      }),
    );
  }
  world.insertResource<TransparentSortConfig>(TRANSPARENT_SORT_CONFIG_KEY, {
    mode: cfg.mode,
    yzAlpha: cfg.yzAlpha,
  });
  return ok(undefined);
}
