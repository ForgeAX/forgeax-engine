import { describe, expect, it } from 'vitest';
import { type Affine, IDENTITY } from '../affine';
import type { MotionBound, ScanPose } from '../interference';
import { model } from '../model';
import { type JointSpec, type ResolvedPart, rig } from '../rig';

/**
 * Travel bound of one solved loop coordinate between two scan samples, driven with hand-built
 * rate rows so every branch of the bound is reached directly (the scan reaches only two of
 * them through real four-bars, and the others guard rate tables a future joint kind could
 * produce). Slots: root 0, driver 1, follower 2 (a mimic of root with ratio 3).
 */
const ROOT = 1;
const FOLLOWER = 3;
const joints: JointSpec[] = [
  { name: 'ground', parent: null, position: [0, 0, 0] },
  { name: 'root', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
  { name: 'drv', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
  {
    name: 'follower',
    parent: 'ground',
    position: [0, 0, 0],
    kind: 'revolute',
    axis: 'z',
    mimic: { joint: 'root', ratio: 3 },
  },
];

type Rates = {
  drivers: readonly number[];
  scale: readonly number[];
  rows: ReadonlyMap<number, readonly number[]>;
};
type Bounds = (
  s0: ScanPose,
  s1: ScanPose,
  a: number,
  b: number,
) => readonly [MotionBound, MotionBound];

const subject = rig(model(), { joints });
const parts: ResolvedPart[] = [
  { name: 'moving', joint: ROOT, faces: [], closed: true },
  { name: 'moving-follower', joint: FOLLOWER, faces: [], closed: true },
  { name: 'fixed', joint: 0, faces: [], closed: true },
];

function sample(q: readonly number[]): ScanPose {
  const worlds: Affine[] = joints.map(() => IDENTITY);
  return {
    q: Float64Array.from(q),
    worlds,
    deltas: parts.map(() => IDENTITY),
    clamped: [],
  } as unknown as ScanPose;
}

function angle(
  part: 0 | 1,
  change: number,
  rates0: Rates | undefined,
  rates1: Rates | undefined,
  driverStep = 0.05,
): number {
  const s0 = sample([0, 0, 0]);
  const s1 = sample([change, driverStep, 0]);
  const table = new WeakMap<Float64Array, Rates>();
  if (rates0 !== undefined) table.set(s0.q, rates0);
  if (rates1 !== undefined) table.set(s1.q, rates1);
  const bounds = (
    subject as unknown as { motionBounds(p: ResolvedPart[], r: typeof table): Bounds }
  ).motionBounds(parts, table);
  const turns = bounds(s0, s1, part, 2)[0].turns;
  return turns[0]?.angle ?? 0;
}

const rates = (rate: number, drivers: readonly number[] = [1]): Rates => ({
  drivers,
  scale: drivers.map(() => 1),
  rows: new Map([[0, [rate]]]),
});

describe('rig scan: travel bound of a solved coordinate', () => {
  it('without rate rows the travel is the change between the samples', () => {
    expect(angle(0, 0.03, undefined, undefined)).toBeCloseTo(0.03, 12);
  });

  it('agreeing end rates bound the travel by the larger rate times the safety margin', () => {
    // rates 1.0 and 1.0 over a driver step of 0.05 move the coordinate by 0.05
    expect(angle(0, 0.05, rates(1), rates(1))).toBeCloseTo(0.0625, 12);
  });

  it('a mimic follower scales the bound of its root and never takes the unscaled one', () => {
    expect(angle(1, 0.05, rates(1), rates(1))).toBeCloseTo(3 * 0.0625, 12);
  });

  it('the margin covers a coordinate that turns around inside the interval', () => {
    // end rates +1 and +1 but a net change of 0.046 (it ran ahead and came back)
    expect(angle(0, 0.046, rates(1), rates(1))).toBeCloseTo(0.0625, 12);
  });

  it('a change that disagrees with the mean end rate splits the interval', () => {
    expect(angle(0, 0.02, rates(1), rates(1))).toBe(Number.POSITIVE_INFINITY);
    expect(angle(0, 0.2, rates(0), rates(0))).toBe(Number.POSITIVE_INFINITY);
    // a 20 % gap between the change (0.04) and the mean end rate (0.05) is over the agreement
    expect(angle(0, 0.04, rates(1), rates(1))).toBe(Number.POSITIVE_INFINITY);
  });

  it('the agreement is measured against the larger of the peak rate and the change', () => {
    // |0.0555 - 0.05| = 0.0055 passes 0.1 * 0.0555 but fails 0.1 * 0.05
    expect(angle(0, 0.0555, rates(1), rates(1))).toBeCloseTo(0.0625, 12);
  });

  it('a change at rounding level next to zero rates keeps its own travel', () => {
    const tiny = angle(0, 5e-13, rates(0), rates(0));
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeLessThan(1e-11);
  });

  it('a missing rate row at either end splits the interval', () => {
    const empty: Rates = { drivers: [1], scale: [1], rows: new Map() };
    expect(angle(0, 0.05, rates(1), undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(angle(0, 0.05, undefined, rates(1))).toBe(Number.POSITIVE_INFINITY);
    expect(angle(0, 0.05, rates(1), empty)).toBe(Number.POSITIVE_INFINITY);
    expect(angle(0, 0.05, empty, rates(1))).toBe(Number.POSITIVE_INFINITY);
  });

  it('different driver sets at the two ends split the interval', () => {
    expect(angle(0, 0.05, rates(1, [1]), rates(1, [2]))).toBe(Number.POSITIVE_INFINITY);
    expect(angle(0, 0.05, rates(1, [1]), rates(1, [1, 2]))).toBe(Number.POSITIVE_INFINITY);
  });

  it('a driver step beyond one continuation step splits the interval', () => {
    // the change agrees with the rates here, so only the step limit splits it
    expect(angle(0, 0.2, rates(1), rates(1), 0.2)).toBe(Number.POSITIVE_INFINITY);
    expect(angle(0, 0.1, rates(1), rates(1), 0.1)).toBeCloseTo(0.125, 12);
  });
});
