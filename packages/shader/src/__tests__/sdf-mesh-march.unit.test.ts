import { expect, it } from 'vitest';
import { SDF_MESH_MARCH_STATE, SDF_MESH_MARCH_WGSL } from '../sdf-mesh-march-wgsl';
import { marchBits, planePrefix, runMarchControl } from './sdf-mesh-march.fixture';

it('charges each actual attempt against budgets zero through three and retains the original closed range', () => {
  for (const budget of [0, 1, 2, 3]) {
    const run = runMarchControl({ budget, prefix: planePrefix(10, 2) });
    expect(run.result.state).toBe(
      budget === 3 ? SDF_MESH_MARCH_STATE.clear : SDF_MESH_MARCH_STATE.budget,
    );
    expect(run.result.attempts).toBe(budget);
    expect(run.result.samples).toBe(budget);
    expect(run.remaining).toBe(0);
    expect(run.result.remaining).toBe(run.remaining);
    expect(run.result.originalRange).toEqual({ x: marchBits(0), y: marchBits(3) });
    expect(run.world.tRange).toEqual(run.result.originalRange);
    expect(run.result.instance).toBe(73);
    expect(run.result.expectedSource).toEqual({ x: 36, y: 128, z: 1, w: 7 });
    expect(run.sampled).toHaveLength(budget);
    if (budget > 0) expect(run.result.emptyEndLower).toBeGreaterThan(run.result.sampledAt);
  }
});

it('keeps original parameters for nonunit directions rather than normalizing the segment', () => {
  for (const speed of [0.5, 1, 2]) {
    const run = runMarchControl({
      budget: 3,
      last: 3 / speed,
      speed,
      prefix: planePrefix(10, 2, speed),
    });
    expect(run.result.state).toBe(SDF_MESH_MARCH_STATE.clear);
    expect(run.result.originalRange.y).toBe(marchBits(3 / speed));
    expect(run.result.firstUnresolved).toBe(3 / speed);
    expect(run.result.attempts).toBe(3);
    expect(run.remaining).toBe(0);
  }
});

it('preserves signed-zero original parameter bits when no work remains', () => {
  const run = runMarchControl({ budget: 0, first: -0, prefix: planePrefix(10, 2) });
  expect(run.result.state).toBe(SDF_MESH_MARCH_STATE.budget);
  expect(run.result.originalRange.x).toBe(0x80000000);
  expect(run.world.tRange.x).toBe(0x80000000);
  expect(run.sampled).toEqual([]);
});

it('visits equality at the closed endpoint and rejects the actual greater-or-equal mutant', () => {
  // This dependency supplies only the generic open-prefix contract, deliberately
  // without assuming extra strictness from the current quantization encoder.
  const prefix = (at: number) => ({ valid: Number(at < 1), samples: 1, end: at < 1 ? 1 : 0 });
  const one = runMarchControl({ budget: 1, last: 1, prefix });
  expect(one.result.state).toBe(SDF_MESH_MARCH_STATE.budget);
  expect(one.result.firstUnresolved).toBe(1);
  expect(one.sampled).toEqual([0]);
  const two = runMarchControl({ budget: 2, last: 1, prefix });
  expect(two.result.state).toBe(SDF_MESH_MARCH_STATE.nearBand);
  expect(two.sampled).toEqual([0, 1]);
  const wrong = SDF_MESH_MARCH_WGSL.replace('if(proof.end>last)', 'if(proof.end>=last)');
  expect(wrong).not.toBe(SDF_MESH_MARCH_WGSL);
  expect(runMarchControl({ budget: 1, last: 1, prefix }, wrong).result.state).toBe(
    SDF_MESH_MARCH_STATE.clear,
  );
});

it('keeps unavailable certificates and out-of-domain coverage as refinement requests without a clamped clear', () => {
  const absent = runMarchControl({ budget: 3, eligible: false, prefix: planePrefix(10, 2) });
  expect(absent.result.state).toBe(SDF_MESH_MARCH_STATE.nearBand);
  expect(absent.sampled).toEqual([]);
  expect(absent.remaining).toBe(3);
  const input = {
    budget: 3,
    first: 5,
    last: 5.25,
    coverage: [0, 4] as const,
    prefix: planePrefix(10, 2, 1, 0, false, 4),
  };
  const outside = runMarchControl(input);
  expect(outside.result.state).toBe(SDF_MESH_MARCH_STATE.nearBand);
  expect(outside.sampled).toEqual([]);
  const wrong = SDF_MESH_MARCH_WGSL.replace(
    'if(!sdfMeshMarchCoverage(row,sampleRay))',
    'if(false)',
  );
  expect(wrong).not.toBe(SDF_MESH_MARCH_WGSL);
  expect(runMarchControl(input, wrong).result.state).toBe(SDF_MESH_MARCH_STATE.clear);
});

it('does not advance across an authored thin plane and catches both a skipped error and an unproved minimum step', () => {
  const input = { budget: 3, last: 0.2, prefix: planePrefix(0.125, 1, 1, 0.125) };
  const safe = runMarchControl(input);
  expect(safe.result.state).toBe(SDF_MESH_MARCH_STATE.nearBand);
  expect(safe.result.firstUnresolved).toBeLessThanOrEqual(0.125);
  // Independent rational counterexample: ignoring E=.125 makes the stored
  // .25 sample falsely certify a prefix past the real plane at .125.
  expect(
    runMarchControl({ ...input, prefix: planePrefix(0.125, 1, 1, 0.125, true) }).result.state,
  ).toBe(SDF_MESH_MARCH_STATE.clear);
  const wrong = SDF_MESH_MARCH_WGSL.replace(
    'out.firstUnresolved=proof.end;',
    'out.firstUnresolved=proof.end+0.5;',
  );
  expect(wrong).not.toBe(SDF_MESH_MARCH_WGSL);
  expect(runMarchControl(input, wrong).result.firstUnresolved).toBeGreaterThan(0.125);
});

it('keeps selected raw errors and independent source mismatches unavailable before floating preparation', () => {
  for (const input of [
    { rawValid: false },
    { rowMask: 256 },
    { mask: 256 },
    { actual: { x: 36, y: 128, z: 1, w: 8 } },
    { actual: { x: 36, y: 128, z: 1, w: 0 }, expected: { x: 36, y: 128, z: 1, w: 0 } },
    { actual: { x: 72, y: 128, z: 1, w: 7 }, expected: { x: 72, y: 128, z: 1, w: 7 } },
    { actual: { x: 36, y: 129, z: 1, w: 7 }, expected: { x: 36, y: 129, z: 1, w: 7 } },
    { actual: { x: 36, y: 128, z: 2, w: 7 }, expected: { x: 36, y: 128, z: 2, w: 7 } },
    { actual: { x: 36, y: 128, z: 1, w: 8 }, expected: { x: 36, y: 128, z: 1, w: 8 } },
  ]) {
    const run = runMarchControl({ budget: 3, ...input });
    expect(run.result.state).toBe(SDF_MESH_MARCH_STATE.unknown);
    expect(run.floatingPreparations).toBe(0);
    expect(run.sampled).toEqual([]);
    expect(run.remaining).toBe(3);
  }
});

it('keeps mask skips, invalid packets and budget-domain errors distinct without resetting continuation work', () => {
  for (const input of [
    { mask: 0, rawValid: false },
    { rowMask: 0, rawValid: false },
  ]) {
    const run = runMarchControl({ budget: 2, ...input });
    expect(run.result.state).toBe(SDF_MESH_MARCH_STATE.clear);
    expect(run.floatingPreparations).toBe(0);
    expect(run.remaining).toBe(2);
  }
  for (const input of [{ packetValid: false }, { localValid: false }, { layout: false }]) {
    expect(runMarchControl({ budget: 2, ...input }).result.state).toBe(
      SDF_MESH_MARCH_STATE.unknown,
    );
  }
  expect(runMarchControl({ budget: 1025 }).result.state).toBe(SDF_MESH_MARCH_STATE.unknown);
  const wrong = SDF_MESH_MARCH_WGSL.replace('*remaining-=1u;', '*remaining-=0u;');
  expect(wrong).not.toBe(SDF_MESH_MARCH_WGSL);
  const run = runMarchControl({ budget: 1, prefix: planePrefix(10, 2) }, wrong);
  expect(run.result.state).toBe(SDF_MESH_MARCH_STATE.clear);
  expect(run.remaining).toBe(1);
  expect(run.result.attempts).toBe(3);
});

it('limits clear to a per-row surface interval, including an empty segment inside an opaque box', () => {
  // The authored box faces at z=+-1 have no intersection with [0,.25].
  // An unsigned certificate can exclude those surfaces without proving the
  // origin outside the volume. The result deliberately carries no Scene Hit.
  const run = runMarchControl({ budget: 1, last: 0.25, prefix: planePrefix(1, 1) });
  expect(run.result.state).toBe(SDF_MESH_MARCH_STATE.clear);
  expect(run.result.instance).toBe(73);
  expect(run.result).not.toHaveProperty('radiance');
  expect(run.result).not.toHaveProperty('hit');
  expect(SDF_MESH_MARCH_WGSL).not.toMatch(
    /fn traceWorld\b|fn worldCardRadiance\b|fn sdfSurfaceTriangle\b/,
  );
});

it('rejects new unsupported control-source calls instead of silently interpreting more WGSL', () => {
  const wrong = SDF_MESH_MARCH_WGSL.replace(
    'let rowMask=sdfInstanceMask(row);',
    'let rowMask=unsupported();',
  );
  expect(wrong).not.toBe(SDF_MESH_MARCH_WGSL);
  expect(() => runMarchControl({ budget: 1 }, wrong)).toThrow('Unsupported source call');
});
