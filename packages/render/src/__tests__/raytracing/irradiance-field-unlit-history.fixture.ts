import {
  IRRADIANCE_FIELD_UPDATE_WGSL,
  packIrradianceFieldFrame,
} from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';

export const historyProbeIds = [0, 1, 7] as const;
export const historyOrdinals = [0, 7, 31] as const;
export const historyRays = 256;
export const historyProbeCount = 8;
export const historyTolerance = 0.000002;
/** Deliberately wrong per-location gain; equal angular halves preserve the global mean. */
export function wrongGainHistorySource() {
  const needle = 'irradiance[level0]=select(stored,updated,noUnlit||stored.w==0.0);';
  if (IRRADIANCE_FIELD_UPDATE_WGSL.split(needle).length !== 2)
    throw new Error('History negative control requires one exact production store');
  return IRRADIANCE_FIELD_UPDATE_WGSL.replace(
    needle,
    `${needle}
  let wrong=irradiance[level0];
  let gain=select(0.5,1.5,((texel+frame.schedule.w)&1u)==0u);
  irradiance[level0]=vec4f(wrong.xyz*gain,wrong.w);`,
  );
}
export interface HistorySnapshot {
  readonly irradiance: Float32Array;
  readonly moments: Float32Array;
  readonly meta: Uint32Array;
}
export type HistoryMutation =
  | 'stable'
  | 'unknown-x'
  | 'unknown-y'
  | 'unknown-all'
  | 'black-x'
  | 'black-all';
export interface HistoryCase {
  readonly name: string;
  readonly mutation: HistoryMutation;
  readonly hysteresis: number;
  readonly steps: number;
  readonly initial?: 'invalid' | 'fresh' | 'fresh-partial';
  readonly warmDistance?: number;
}
export const historyCases: readonly HistoryCase[] = [
  { name: 'complete-stable', mutation: 'stable', hysteresis: 0.5, steps: 1 },
  { name: 'unknown-bright-x-warm', mutation: 'unknown-x', hysteresis: 0.5, steps: 4 },
  { name: 'unknown-bright-y-warm', mutation: 'unknown-y', hysteresis: 0.5, steps: 1 },
  { name: 'unknown-bright-x-steady', mutation: 'unknown-x', hysteresis: 0.97, steps: 2 },
  { name: 'unknown-all-warm', mutation: 'unknown-all', hysteresis: 0.5, steps: 1 },
  { name: 'known-black-bright-x', mutation: 'black-x', hysteresis: 0.5, steps: 1 },
  { name: 'known-black-all', mutation: 'black-all', hysteresis: 0.5, steps: 1 },
  {
    name: 'unknown-depth-eight',
    mutation: 'unknown-all',
    hysteresis: 0.5,
    steps: 1,
    warmDistance: 2,
  },
  {
    name: 'invalid-slot-unknown',
    mutation: 'unknown-all',
    hysteresis: 0.5,
    steps: 1,
    initial: 'invalid',
  },
  {
    name: 'fresh-slot-unknown',
    mutation: 'unknown-all',
    hysteresis: 0.5,
    steps: 1,
    initial: 'fresh',
  },
  {
    name: 'fresh-partial-unknown',
    mutation: 'unknown-x',
    hysteresis: 0.5,
    steps: 1,
    initial: 'fresh-partial',
  },
];

export function historyFrame(hysteresis: number, frameIndex = 0): Uint8Array {
  return packIrradianceFieldFrame({
    worldSource: { traversal: 'unused' },
    probeBudget: historyProbeIds.length,
    raysPerProbe: historyRays,
    frameIndex,
    tileOffset: 0,
    tileBudget: 0,
    tileCount: 0,
    lightCount: 0,
    cardResolution: 1,
    atlasWidth: 1,
    radiosity: false,
    environment: [0, 0, 0],
    hysteresis,
    maxDistance: 12,
    surfaceBias: 0,
    depthClamp: 12,
    cardMargin: 0,
    gather: [1, 1, 1, 1],
    query: new Uint8Array(8),
    reflections: [0, 0],
  });
}
export function effectiveHistoryHysteresis(value: number): number {
  return new Float32Array(historyFrame(value).buffer)[15] ?? Number.NaN;
}
/** The direction producer is GPU-owned. This independent positive affine signal is not a kernel oracle. */
export function historyIncident(directions: Float32Array, distance = 8): Float32Array {
  const result = new Float32Array(historyProbeIds.length * historyRays * 8);
  for (let ray = 0; ray < result.length / 8; ray++) {
    const x = directions[ray * 4] ?? Number.NaN;
    const y = directions[ray * 4 + 1] ?? Number.NaN;
    const z = directions[ray * 4 + 2] ?? Number.NaN;
    result.set([1 + 0.8 * x, 0.9 + 0.6 * y, 1.1 + 0.5 * z, distance, x, y, z, 1], ray * 8);
  }
  return result;
}
export function historyMutation(input: Float32Array, mutation: HistoryMutation): Float32Array {
  const result = input.slice();
  for (let ray = 0; ray < result.length / 8; ray++) {
    const offset = ray * 8;
    const selected =
      mutation.endsWith('all') ||
      (mutation.endsWith('x') && (input[offset + 4] ?? 0) > 0.4) ||
      (mutation.endsWith('y') && (input[offset + 5] ?? 0) > 0.4);
    if (!selected) continue;
    if (mutation.startsWith('unknown')) result[offset + 7] = 4;
    else if (mutation.startsWith('black')) result.fill(0, offset, offset + 3);
  }
  return result;
}
export function emptyHistory(poison = false, invalid = false): HistorySnapshot {
  const irradiance = new Float32Array(historyProbeCount * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
  const moments = new Float32Array(historyProbeCount * 64 * 2);
  const meta = new Uint32Array(historyProbeCount * 4);
  if (poison)
    for (const probe of historyProbeIds) {
      // A plausible old valid cell: constant radiance and distance11 (<clamp12).
      // Keep validity1 and physically consistent moments, rather than relying
      // on malformed sentinel data to reveal a recycled-slot leak.
      for (let texel = 0; texel < IRRADIANCE_FIELD_PROBE_STRIDE; texel++)
        irradiance.set([2, 1, 0.5, 1], (probe * IRRADIANCE_FIELD_PROBE_STRIDE + texel) * 4);
      for (let texel = 0; texel < 64; texel++) moments.set([11, 121], probe * 128 + texel * 2);
      meta.set([invalid ? 0 : 19, invalid ? 3 : 1, 0, 0], probe * 4);
    }
  return { irradiance, moments, meta };
}
export function scheduledValues(snapshot: HistorySnapshot, kind: 'irradiance' | 'moments') {
  const stride = kind === 'irradiance' ? IRRADIANCE_FIELD_PROBE_STRIDE * 4 : 128;
  return Float32Array.from(
    historyProbeIds.flatMap((probe) =>
      Array.from(snapshot[kind].subarray(probe * stride, (probe + 1) * stride)),
    ),
  );
}
export function maximumHistoryDelta(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  scale = 1,
) {
  let maximum = 0;
  for (let index = 0; index < actual.length; index++)
    maximum = Math.max(
      maximum,
      Math.abs((actual[index] ?? Number.NaN) - (expected[index] ?? Number.NaN) * scale),
    );
  return maximum;
}
export function checkHistoryState(snapshot: HistorySnapshot, expectedUpdates: number): string[] {
  const failures: string[] = [];
  for (const kind of ['irradiance', 'moments'] as const)
    if (!scheduledValues(snapshot, kind).every(Number.isFinite))
      failures.push(`${kind}: nonfinite`);
  for (const probe of historyProbeIds) {
    const row = Array.from(snapshot.meta.subarray(probe * 4, probe * 4 + 4));
    if (row.join(',') !== `${expectedUpdates},1,0,0`)
      failures.push(`meta ${probe}: ${row.join(',')}`);
  }
  return failures;
}
