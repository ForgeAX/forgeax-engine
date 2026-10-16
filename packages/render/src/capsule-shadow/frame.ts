import { mat4 } from '@forgeax/engine-math';
import type { DirectionalShadowQuality } from '../components/directional-shadow-filter';
import { computeProjectionMatrix, computeViewMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot } from '../render-system-extract';
import type { CapsuleShadowSubmission } from './inspection';
import { WORLD_CAPSULE_STRIDE } from './world-capsules';

/** Per-frame capsule budget; farther capsules are dropped first. */
export const MAX_FRAME_CAPSULES = 1024;
export const CAPSULE_TILE_SIZE = 16;
export const MAX_CAPSULES_PER_TILE = 32;
/** Shared tile index pool; tiles past it keep fewer capsules and count as overflow. */
export const CAPSULE_TILE_INDEX_CAPACITY = 65536;
/** Tile header packing: index offset in the high bits, count in the low bits. */
export const CAPSULE_TILE_COUNT_BITS = 6;

const MAX_REACH = 8;
const MIN_LIGHT_SIN = 0.25;
const MIN_CONE = Math.PI / 180;
const MAX_CONE = Math.PI / 6;

/**
 * One frame's capsule shadow payload: world capsules sorted closest-first
 * (`b.w` carries the reach), and a tile table whose first `tilesX * tilesY`
 * words are packed headers followed by the capsule index lists.
 */
export interface CapsuleShadowFrame {
  readonly capsules: Float32Array;
  readonly tiles: Uint32Array;
  readonly tilesX: number;
  readonly tilesY: number;
  /** Light cone half-angle in radians shared by binning and shading. */
  readonly coneHalfAngle: number;
  readonly submission: CapsuleShadowSubmission;
}

/** Tile table words for a lighting target: headers plus the shared index pool. */
export function capsuleTileTableWords(width: number, height: number): number {
  return (
    Math.ceil(width / CAPSULE_TILE_SIZE) * Math.ceil(height / CAPSULE_TILE_SIZE) +
    CAPSULE_TILE_INDEX_CAPACITY
  );
}

/** Light-source cone half-angle: five times the authored angular radius, clamped. */
export function capsuleConeHalfAngle(quality: DirectionalShadowQuality | undefined): number {
  const angular = quality?.kind === 'pcss' ? quality.angularRadiusRadians : 0;
  return Math.min(MAX_CONE, Math.max(MIN_CONE, 5 * angular));
}

/**
 * Shadow reach of an occluder of length `length` and radius `radius`: its
 * ground shadow ends within `(L + 2r) / sin(elevation)`. The shader fades over
 * the last third of the reach, so the reach is 1.5x that length to keep the
 * geometric shadow unfaded; the clamp lets low suns fade instead of growing.
 */
export function capsuleReach(length: number, radius: number, lightSin: number): number {
  return Math.min(MAX_REACH, (1.5 * (length + 2 * radius)) / Math.max(lightSin, MIN_LIGHT_SIN));
}

interface Candidate {
  readonly source: Float32Array;
  readonly offset: number;
  readonly distance: number;
}

/**
 * Collect admitted capsules, keep the closest `MAX_FRAME_CAPSULES`, and bin
 * each capsule's light-swept bound into screen tiles. Binning is a
 * conservative screen rectangle; the per-pixel evaluation applies the exact
 * reach and cone falloff.
 */
export function buildCapsuleShadowFrame(
  renderables: readonly { readonly source: RenderableSnapshot }[],
  camera: CameraSnapshot,
  lightDirection: ArrayLike<number>,
  coneHalfAngle: number,
  width: number,
  height: number,
): CapsuleShadowFrame {
  const lx = -(lightDirection[0] ?? 0);
  const ly = -(lightDirection[1] ?? -1);
  const lz = -(lightDirection[2] ?? 0);
  const lightLength = Math.hypot(lx, ly, lz) || 1;
  const toLight = [lx / lightLength, ly / lightLength, lz / lightLength] as const;
  const cx = camera.position[0] ?? 0;
  const cy = camera.position[1] ?? 0;
  const cz = camera.position[2] ?? 0;
  const candidates: Candidate[] = [];
  for (const { source } of renderables) {
    const state = source.capsuleShadow;
    if (state?.status !== 'ready') continue;
    for (let offset = 0; offset < state.capsules.length; offset += WORLD_CAPSULE_STRIDE) {
      const c = state.capsules;
      const mx = ((c[offset] as number) + (c[offset + 4] as number)) / 2 - cx;
      const my = ((c[offset + 1] as number) + (c[offset + 5] as number)) / 2 - cy;
      const mz = ((c[offset + 2] as number) + (c[offset + 6] as number)) / 2 - cz;
      candidates.push({ source: c, offset, distance: mx * mx + my * my + mz * mz });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const kept = Math.min(candidates.length, MAX_FRAME_CAPSULES);
  const capsules = new Float32Array(kept * WORLD_CAPSULE_STRIDE);
  for (let index = 0; index < kept; index++) {
    const { source, offset } = candidates[index] as Candidate;
    capsules.set(
      source.subarray(offset, offset + WORLD_CAPSULE_STRIDE),
      index * WORLD_CAPSULE_STRIDE,
    );
    const base = index * WORLD_CAPSULE_STRIDE;
    const length = Math.hypot(
      (capsules[base + 4] as number) - (capsules[base] as number),
      (capsules[base + 5] as number) - (capsules[base + 1] as number),
      (capsules[base + 6] as number) - (capsules[base + 2] as number),
    );
    capsules[base + 7] = capsuleReach(length, capsules[base + 3] as number, toLight[1]);
  }

  const tilesX = Math.ceil(width / CAPSULE_TILE_SIZE);
  const tilesY = Math.ceil(height / CAPSULE_TILE_SIZE);
  const tileTotal = tilesX * tilesY;
  const projection = computeProjectionMatrix(camera);
  const viewProjection = mat4.create();
  mat4.multiply(viewProjection, projection, computeViewMatrix(camera));
  const rects = new Int32Array(kept * 4);
  const counts = new Uint16Array(tileTotal);
  const spread = Math.tan(coneHalfAngle);
  let visible = 0;
  for (let index = 0; index < kept; index++) {
    const rect = sweptScreenRect(capsules, index, toLight, spread, viewProjection, tilesX, tilesY);
    rects.set(rect ?? [1, 1, 0, 0], index * 4);
    if (rect === undefined) continue;
    visible += 1;
    for (let y = rect[1]; y <= rect[3]; y++)
      for (let x = rect[0]; x <= rect[2]; x++) {
        const tile = y * tilesX + x;
        counts[tile] = (counts[tile] as number) + 1;
      }
  }

  const tiles = new Uint32Array(tileTotal + CAPSULE_TILE_INDEX_CAPACITY);
  const cursor = new Uint32Array(tileTotal);
  let pool = 0;
  let tileCount = 0;
  let tileOverflow = 0;
  for (let tile = 0; tile < tileTotal; tile++) {
    const wanted = counts[tile] as number;
    if (wanted === 0) continue;
    const granted = Math.min(wanted, MAX_CAPSULES_PER_TILE, CAPSULE_TILE_INDEX_CAPACITY - pool);
    tileCount += 1;
    if (granted < wanted) tileOverflow += 1;
    tiles[tile] = ((tileTotal + pool) << CAPSULE_TILE_COUNT_BITS) | granted;
    cursor[tile] = granted;
    pool += granted;
  }
  // Capsules are already closest-first, so a full tile keeps its nearest occluders.
  const filled = new Uint32Array(tileTotal);
  for (let index = 0; index < kept && visible > 0; index++) {
    const x0 = rects[index * 4] as number;
    const y0 = rects[index * 4 + 1] as number;
    const x1 = rects[index * 4 + 2] as number;
    const y1 = rects[index * 4 + 3] as number;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const tile = y * tilesX + x;
        const slot = filled[tile] as number;
        if (slot >= (cursor[tile] as number)) continue;
        tiles[((tiles[tile] as number) >>> CAPSULE_TILE_COUNT_BITS) + slot] = index;
        filled[tile] = slot + 1;
      }
  }
  return {
    capsules,
    tiles: tiles.subarray(0, tileTotal + pool),
    tilesX,
    tilesY,
    coneHalfAngle,
    submission: {
      capsuleCount: kept,
      droppedCapsules: candidates.length - kept,
      tileCount,
      tileOverflow,
    },
  };
}

/**
 * Inclusive tile rectangle covering the capsule swept away from the light by
 * its reach and widened by the cone spread; `undefined` when off screen. A
 * corner behind the camera widens the rectangle to the whole target.
 */
function sweptScreenRect(
  capsules: Float32Array,
  index: number,
  toLight: readonly [number, number, number],
  spread: number,
  viewProjection: Float32Array,
  tilesX: number,
  tilesY: number,
): readonly [number, number, number, number] | undefined {
  const base = index * WORLD_CAPSULE_STRIDE;
  const reach = capsules[base + 7] as number;
  const pad = (capsules[base + 3] as number) + reach * spread;
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const end of [0, 4])
    for (const t of [0, reach])
      for (let axis = 0; axis < 3; axis++) {
        const value = (capsules[base + end + axis] as number) - (toLight[axis] as number) * t;
        low[axis] = Math.min(low[axis] as number, value - pad);
        high[axis] = Math.max(high[axis] as number, value + pad);
      }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let behind = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = (corner & 1 ? high[0] : low[0]) as number;
    const y = (corner & 2 ? high[1] : low[1]) as number;
    const z = (corner & 4 ? high[2] : low[2]) as number;
    const m = viewProjection;
    const w =
      (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
    if (w <= 1e-4) {
      behind += 1;
      continue;
    }
    const ndcX =
      ((m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number)) / w;
    const ndcY =
      ((m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number)) / w;
    minX = Math.min(minX, ndcX);
    maxX = Math.max(maxX, ndcX);
    minY = Math.min(minY, ndcY);
    maxY = Math.max(maxY, ndcY);
  }
  if (behind === 8) return undefined;
  if (behind > 0) return [0, 0, tilesX - 1, tilesY - 1];
  if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) return undefined;
  // NDC y points up; tile rows count down from the top of the target.
  const tile = (ndc: number, count: number) =>
    Math.min(count - 1, Math.max(0, Math.floor(((ndc + 1) / 2) * count)));
  return [tile(minX, tilesX), tile(-maxY, tilesY), tile(maxX, tilesX), tile(-minY, tilesY)];
}
