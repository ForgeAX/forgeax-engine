import { expect, it } from 'vitest';
import {
  SDF_SURFACE_ROOT_PREPARATION_WGSL,
  SDF_SURFACE_ROOT_PREPARE_WGSL,
  SDF_SURFACE_ROOT_REQUEST_BYTES,
} from '../sdf-surface-root-request-wgsl';
import { SDF_SURFACE_TRACE_ROOT_WGSL } from '../sdf-surface-trace-wgsl';
import {
  rootBits,
  rootControl,
  rootPaymentClause,
  rootSeparationControl,
} from './sdf-surface-root.fixture';

it('redeems the original paid root once and leaves the budget2/3 triangle opportunity intact', () => {
  for (const budget of [2, 3]) {
    const run = rootControl({ budget });
    expect(run.samples).toBe(1);
    expect(run.request.control.w).toBe(budget - 1);
    expect(run.redeem()).toBe(1);
    expect(run.remaining.value).toBe(budget - 1);
    expect(run.consumed.value).toBe(1);
    // Independent one-root/one-triangle ledger. A separate stage charge plus the
    // original root charge would leave budget2 with no triangle opportunity.
    expect(run.remaining.value - 1).toBe(budget - 2);
    expect(run.redeem()).toBe(2);
  }
  expect(rootPaymentClause()).toContain('if(!paid && !sdfSurfaceCharge(remaining))');
  const wrong = SDF_SURFACE_TRACE_ROOT_WGSL.replace(
    'if(!paid && !sdfSurfaceCharge(remaining))',
    'if(!sdfSurfaceCharge(remaining))',
  );
  expect(rootPaymentClause(wrong)).not.toContain('if(!paid && !sdfSurfaceCharge(remaining))');
  const bad = rootControl({ budget: 2 });
  bad.payment(wrong);
  expect(bad.remaining.value).toBe(0);
  const good = rootControl({ budget: 2 });
  expect(good.payment()).toBe(true);
  expect(good.remaining.value).toBe(1);
});

it('does not prepay budget0 and preserves source/row/instance/original signed-zero ray identity', () => {
  const zero = rootControl({ budget: 0 });
  expect(zero.samples).toBe(0);
  expect(zero.redeem()).toBe(0);
  expect(zero.remaining.value).toBe(0);
  const run = rootControl({ budget: 2, first: -0 });
  expect(run.matches()).toBe(true);
  expect(run.request.payload[2].x).toBe(0x80000000);
  expect(run.redeem(1)).toBe(0);
  expect(run.remaining.value).toBe(2);
  run.request.payload[3].x = 74;
  expect(run.redeem()).toBe(2);
  expect(run.remaining.value).toBe(2);
});

it('keeps a useful old sample and requires both useless-old proof and full lattice coverage before entry replacement', () => {
  for (const options of [
    { oldUnusable: false, covered: true },
    { oldUnusable: true, covered: false },
  ]) {
    const run = rootControl({ budget: 2, entry: 2, ...options });
    expect(run.request.payload[2].z).toBe(rootBits(0.5));
  }
  const boundary = rootControl({ budget: 2, entry: 2, oldUnusable: true, covered: true });
  expect(boundary.request.payload[2].z).toBe(rootBits(2.5));
  expect(boundary.samples).toBe(1);
  expect(boundary.world.tRange.x).toBe(rootBits(0));
  expect(boundary.world.tRange.y).toBe(rootBits(8));
});

it('keeps invalid source/raw/packet unpaid and rejects stale epoch or changed ray before redemption', () => {
  for (const failure of [
    { rawValid: false },
    { packetValid: false },
    { sourceValid: false },
    { actualEpoch: 8 },
  ]) {
    const run = rootControl({ budget: 3, ...failure });
    expect(run.samples).toBe(0);
    expect(run.redeem()).toBe(0);
    expect(run.remaining.value).toBe(3);
  }
  const stale = rootControl({ budget: 3 });
  stale.expected.w = 8;
  expect(stale.matches()).toBe(false);
  expect(stale.redeem()).toBe(2);
  expect(stale.remaining.value).toBe(3);
  const changed = rootControl({ budget: 3 });
  changed.world.directionHi.x = rootBits(2);
  expect(changed.matches()).toBe(false);
});

it('uses one closed 96B transport and contains no triangle/BVH exact query in preparation', () => {
  expect(SDF_SURFACE_ROOT_REQUEST_BYTES).toBe(6 * 16);
  expect(SDF_SURFACE_ROOT_PREPARATION_WGSL).not.toMatch(
    /fn sdfSurface(Triangle|LeafTriangle|TraceRow|Accept)\(/,
  );
  expect(SDF_SURFACE_ROOT_PREPARATION_WGSL).toContain(
    'sampleRay.tRange.x=bitcast<u32>(bounds.near)',
  );
  expect(SDF_SURFACE_ROOT_PREPARATION_WGSL).toContain('if(!sdfMeshMarchCoverage(row,sampleRay))');
});

it('proves only a genuinely useless old sample and catches a thin-wall entry-proof omission', () => {
  for (const x of [-2, -1, -0.5, 0, 1, 2, 2.5, 3, 4]) {
    const actual = rootSeparationControl([x, 1, 1]);
    // Independent integer half-unit oracle, lattice [0,2], band1.
    const twice = BigInt(x * 2);
    const separated = twice <= -2n || twice >= 6n;
    expect(actual).toBe(separated);
    if (separated) {
      const delta = twice < 0n ? -twice : twice - 4n;
      // Best possible legal magnitude still cannot offset the one-code-unit
      // error plus radius. E>=0 only lowers it further.
      expect(2n * 32766n - 32767n * delta).toBeLessThanOrEqual(0n);
    }
  }
  const input = { budget: 2, entry: 2, oldUnusable: false, covered: true };
  const safe = rootControl(input);
  expect(safe.request.payload[2].z).toBe(rootBits(0.5));
  const mutant = SDF_SURFACE_ROOT_PREPARE_WGSL.replace(
    'sdfSurfaceRootOldSampleUnusable(row,local)',
    'true',
  );
  expect(mutant).not.toBe(SDF_SURFACE_ROOT_PREPARE_WGSL);
  const wrong = rootControl(input, mutant);
  expect(wrong.request.payload[2].z).toBe(rootBits(2.5));
  // A plane at t=1 is retained by .5 but would be hidden by the wrong 2.5 prefix.
  expect(1 > 0.5 && 1 < 2.5).toBe(true);
});

it('rejects another Screen ray or integer frame before paid work can be redeemed', () => {
  for (const field of ['x', 'y'] as const) {
    const run = rootControl({ budget: 2, rayIndex: 17, frameToken: 31 });
    expect(run.matches()).toBe(true);
    expect(run.request.payload[3].z).toBe(17);
    expect(run.request.payload[3].w).toBe(31);
    run.context[field]++;
    expect(run.matches()).toBe(false);
    expect(run.redeem()).toBe(2);
    expect(run.remaining.value).toBe(2);
    expect(run.consumed.value).toBe(0);
  }
  const mutant = SDF_SURFACE_ROOT_PREPARE_WGSL.replace(
    'any(request.payload[3].zw!=context)',
    'false',
  );
  expect(mutant).not.toBe(SDF_SURFACE_ROOT_PREPARE_WGSL);
  const wrong = rootControl({ budget: 2, rayIndex: 17, frameToken: 31 }, mutant);
  wrong.context.x++;
  expect(wrong.matches()).toBe(true);
  expect(wrong.redeem()).toBe(1);
});
