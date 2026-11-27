import { equalBytes } from '../../../../../scripts/test/byte-equality.mjs';
import type { StandardIrradianceField } from '../../pipeline/standard-profile';
import {
  type IrradianceFieldLevelWindow,
  packIrradianceFieldFrame,
} from '../../raytracing/irradiance-field';
import {
  IRRADIANCE_FIELD_PROBE_STRIDE,
  type IrradianceFieldPlan,
  planIrradianceField,
} from '../../raytracing/irradiance-field-plan';

export type WorldPoint = readonly [number, number, number];
export interface WorldKeyRow {
  readonly slot: number;
  readonly level: number;
  readonly cell: WorldPoint;
  readonly position: WorldPoint;
  readonly key: string;
  readonly ratio: readonly [number, number];
}
export interface WorldKeyCache {
  readonly irradiance: Float32Array;
  readonly moments: Float32Array;
  readonly meta: Uint32Array;
}
export const worldKeyRays = 256;
export const worldKeyHysteresis = 0.9;
export const worldKeyRatioTolerance = 0.00002;
export const worldKeyFocus: WorldPoint = [0.5, 0.5, 0.5];
export const worldKeyNextFocus: WorldPoint = [1.5, 0.5, 0.5];
export function worldKeyPlan(gridOrigin: WorldPoint = [-32.5, -32.5, -32.5]): IrradianceFieldPlan {
  const field: StandardIrradianceField = {
    region: {
      grid: {
        origin: gridOrigin,
        dimensions: [67, 67, 67],
        spacing: 1,
        maxDistance: 8,
        coverageDistance: 4,
      },
      maxInstances: 16,
      maxFieldBytes: 32 * 1024 * 1024,
    },
    probeSpacing: 1,
    raysPerProbe: worldKeyRays,
    probeBudget: 96,
    hysteresis: worldKeyHysteresis,
    cards: { resolution: 8, maxCaptureBytes: 8 * 1024 * 1024, budget: 1 },
    resolution: 'half',
    radiosity: false,
    clipmap: { levels: 1, dimensions: [6, 4, 4] },
  };
  return planIrradianceField(field).unwrap();
}
/** Independent finite enumeration of the unique congruent world cell; no probeCell/probeIndex oracle. */
function congruent(start: number, dimension: number, residue: number): number {
  const candidates = Array.from({ length: dimension }, (_, i) => start + i).filter((cell) =>
    Number.isInteger((cell - residue) / dimension),
  );
  if (candidates.length !== 1 || candidates[0] === undefined)
    throw new Error('World-key congruence is not unique');
  return candidates[0];
}
export function worldKeyTable(
  plan: IrradianceFieldPlan,
  windows: readonly IrradianceFieldLevelWindow[],
): WorldKeyRow[] {
  const [dx, dy, dz] = plan.dimensions,
    per = dx * dy * dz;
  return Array.from({ length: plan.probeCount }, (_, slot) => {
    const level = Math.floor(slot / per),
      local = slot - level * per,
      window = windows[level]?.window;
    if (!window) throw new Error('Missing world-key level window');
    const cell: WorldPoint = [
      congruent(window[0], dx, local % dx),
      congruent(window[1], dy, Math.floor(local / dx) % dy),
      congruent(window[2], dz, Math.floor(local / (dx * dy))),
    ];
    const spacing = plan.spacing * 2 ** level;
    const position: WorldPoint = [
      plan.origin[0] + cell[0] * spacing,
      plan.origin[1] + cell[1] * spacing,
      plan.origin[2] + cell[2] * spacing,
    ];
    const twice = position.map((v) => v * 2);
    if (!twice.every(Number.isInteger))
      throw new Error('Controlled marker oracle requires half-integer positions');
    const x2 = twice[0] ?? Number.NaN,
      y2 = twice[1] ?? Number.NaN,
      z2 = twice[2] ?? Number.NaN;
    // Integer-key algebra, independent of the physical-position signal generator.
    const ratio: readonly [number, number] = [
      (2048 + 32 * x2 + y2) / 1024,
      (3072 + 32 * z2 + y2) / 2048,
    ];
    return { slot, level, cell, position, key: `${level}:${cell.join(',')}`, ratio };
  });
}
/** Positive controlled incident RGB at the actual PLACE origin. This is an identity witness, not physical GI. */
export function worldKeyIncident(position: WorldPoint): WorldPoint {
  return [8 + position[0] / 4 + position[1] / 128, 4, 6 + position[2] / 8 + position[1] / 256];
}
export function worldKeyFrame(count: number, index: number): Uint8Array {
  return packIrradianceFieldFrame({
    worldSource: { traversal: 'unused' },
    probeBudget: count,
    raysPerProbe: worldKeyRays,
    frameIndex: index,
    tileOffset: 0,
    tileBudget: 0,
    tileCount: 0,
    lightCount: 0,
    atlasWidth: 1,
    cardResolution: 1,
    radiosity: false,
    environment: [0, 0, 0],
    hysteresis: worldKeyHysteresis,
    maxDistance: 8,
    surfaceBias: 0,
    depthClamp: 3,
    cardMargin: 0,
    gather: [1, 1, 1, 1],
    query: new Uint8Array(8),
    reflections: [0, 0],
  });
}
export function worldKeyRatios(
  cache: WorldKeyCache,
  slot: number,
  texel = 0,
): readonly [number, number] {
  const index = (slot * IRRADIANCE_FIELD_PROBE_STRIDE + texel) * 4;
  const g = cache.irradiance[index + 1] ?? Number.NaN;
  if (!(g > 0.05)) return [Number.NaN, Number.NaN];
  return [
    (cache.irradiance[index] ?? Number.NaN) / g,
    (cache.irradiance[index + 2] ?? Number.NaN) / g,
  ];
}
export function unselectedWorldCacheEqual(
  before: WorldKeyCache,
  after: WorldKeyCache,
  selected: ReadonlySet<number>,
  count: number,
): boolean {
  for (let slot = 0; slot < count; slot++)
    if (!selected.has(slot))
      for (const [name, stride] of [
        ['irradiance', IRRADIANCE_FIELD_PROBE_STRIDE * 16],
        ['moments', 64 * 8],
        ['meta', 16],
      ] as const) {
        const a = before[name],
          b = after[name];
        if (
          !equalBytes(
            new Uint8Array(a.buffer, a.byteOffset + slot * stride, stride),
            new Uint8Array(b.buffer, b.byteOffset + slot * stride, stride),
          )
        )
          return false;
      }
  return true;
}
