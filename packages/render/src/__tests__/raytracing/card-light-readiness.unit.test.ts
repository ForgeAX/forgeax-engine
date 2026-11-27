import { expect, it } from 'vitest';
import {
  integratedLightingState,
  lightEpoch,
  prepareLighting,
  resolveLighting,
} from './card-light-readiness.fixture';
import { cardLightingGpuPrograms } from './card-light-readiness-gpu.fixture';

it('keeps known finite current direct radiance when SH and geometric links have no support', () => {
  const r = resolveLighting({});
  expect(r.lit).toEqual([0.5, 0.25, 0.125, 1]);
  expect(r.history).toEqual([0, 0, 0, 0]);
  expect(resolveLighting({ direct: [0, 0, 0, 1] }).lit).toEqual([0, 0, 0, 1]);
});
it('requires current valid surface and direct even when indirect is supported', () => {
  for (const input of [
    { valid: 0 },
    { direct: [0.5, 0.25, 0.125, 0] },
    { direct: [NaN, 0, 0, 1] },
    { direct: [Infinity, 0, 0, 1] },
  ]) {
    const r = resolveLighting({ ...input, weight: 1, incident: [1, 1, 1] });
    expect(r.lit).toEqual([0, 0, 0, 0]);
    expect(r.history).toEqual([0, 0, 0, 0]);
  }
});
it('does not add or stamp blocked unknown or stale geometry and probe support', () => {
  for (const input of [
    { link: 0 },
    { link: 2 },
    { linkEpoch: 2 },
    { linkModel: 2 },
    { probeEpoch: 2 },
    { probeModel: 2 },
  ]) {
    const r = resolveLighting({ ...input, weight: 1, incident: [10, 10, 10] });
    expect(r.lit).toEqual([0.5, 0.25, 0.125, 1]);
    expect(r.history).toEqual([0, 0, 0, 0]);
  }
});
it('stamps supported zero SH while keeping direct outgoing radiance unmodified', () => {
  const zero = resolveLighting({ weight: 1 });
  expect(zero.lit).toEqual([0.5, 0.25, 0.125, 1]);
  expect(zero.history).toEqual([0, 0, 0, lightEpoch(3)]);
  const lit = resolveLighting({ weight: 1, incident: [2, 2, 2] });
  expect(lit.lit).toEqual([1, 1.25, 1.625, 1]);
  expect(lit.history).toEqual([2, 2, 2, lightEpoch(3)]);
});
it('rejects nonfinite and overflowing indirect without discarding a valid finite base', () => {
  for (const input of [
    { incident: [NaN, 0, 0] },
    { incident: [Infinity, 0, 0] },
    { incident: [3e38, 0, 0], albedo: [2, 1, 1] },
    { incident: [3e38, 0, 0], albedo: [1, 1, 1], direct: [3e38, 0, 0, 1] },
  ]) {
    const r = resolveLighting({ ...input, weight: 1 });
    expect(r.lit).toEqual((input.direct ?? [0.5, 0.25, 0.125, 1]).map(Math.fround));
    expect(r.history).toEqual([0, 0, 0, 0]);
  }
});
it('keeps direct fallback and source epochs separate through repeated bounce publication', () => {
  const r = resolveLighting({ weight: 1, incident: [2, 2, 2] });
  expect(prepareLighting({}, r.history)).toEqual(r.lit);
  expect(prepareLighting({ epoch: 4 }, r.history)).toEqual([0.5, 0.25, 0.125, 1]);
  expect(prepareLighting({}, r.history, 2)).toEqual([0.5, 0.25, 0.125, 1]);
  expect(prepareLighting({ direct: [0, 0, 0, 0] }, r.history)).toEqual([0, 0, 0, 0]);
  expect(prepareLighting({}, [NaN, 0, 0, lightEpoch(3)])).toEqual([0.5, 0.25, 0.125, 1]);
  const metadata = resolveLighting({
    epoch: 0x7fc00001,
    probeEpoch: 0x7fc00001,
    linkEpoch: 0x7fc00001,
    weight: 1,
  });
  // The existing link fixture owns epoch3. Exercise the shared bounce helper
  // directly with a legal NaN-shaped epoch word, never a radiance value.
  expect(prepareLighting({ epoch: 0x7fc00001 }, [0, 0, 0, lightEpoch(0x7fc00001)])).toEqual([
    0.5, 0.25, 0.125, 1,
  ]);
  expect(metadata.lit).toEqual([0.5, 0.25, 0.125, 1]);
});

it('rejects pre-clamp unknown even when WGSL max may select the finite operand', () => {
  const input = { incident: [NaN, 0, 0], weight: 1 };
  expect(resolveLighting(input).history).toEqual([0, 0, 0, 0]);
  const mutant = resolveLighting(input, true);
  expect(mutant.lit).toEqual([0.5, 0.25, 0.125, 1]);
  // Deleting both real pre-clamp guards manufactures supported black history.
  expect(mutant.history).toEqual([0, 0, 0, lightEpoch(3)]);
});

it('uses the same base guard for invalid direct and surface in next-bounce preparation', () => {
  for (const input of [
    { valid: 0 },
    { direct: [0, 0, 0, 0] },
    { direct: [0, 0, 0, 2] },
    { direct: [NaN, 0, 0, 1] },
  ])
    expect(prepareLighting(input, [1, 1, 1, lightEpoch(3)])).toEqual([0, 0, 0, 0]);
  expect(prepareLighting({ direct: [0, 0, 0, 1] }, [0, 0, 0, lightEpoch(3)])).toEqual([0, 0, 0, 1]);
  expect(prepareLighting({ albedo: [2, 1, 1] }, [3e38, 0, 0, lightEpoch(3)])).toEqual([
    0.5, 0.25, 0.125, 1,
  ]);
});

import { compileShader } from '@forgeax/engine-shader-compiler';
import {
  cardLightReadinessFixture,
  irradianceFieldKernelBindings,
  irradianceFieldKernelWgsl,
} from './card-light-readiness.fixture';

it('validates the exact shared GPU control composition and its typed input/output ABI', async () => {
  const compiled = (
    await compileShader(cardLightReadinessFixture, { computeEntry: 'auditCardLighting' })
  ).unwrap();
  expect(compiled.bindings[0]?.entries.map((row) => row.binding)).toEqual([0, 1]);
  expect(
    compiled.reflection.boundGlobals.find((row) => row.binding === 0)?.typeDescriptor,
  ).toMatchObject({ kind: 'array', stride: 64 });
});
for (const stage of ['prepareCardRadiosityBounce', 'resolveCardRadiosity'] as const) {
  it(`validates current actual ${stage} without changing the storage roster`, async () => {
    const sources = irradianceFieldKernelWgsl('global-sdf');
    expect(irradianceFieldKernelWgsl('ray-query')[stage]).toBe(sources[stage]);
    const result = (await compileShader(sources[stage], { computeEntry: stage })).unwrap();
    const reflected = result.reflection.boundGlobals
      .map((row) => row.binding)
      .sort((a, b) => a - b);
    expect(reflected).toEqual(
      irradianceFieldKernelBindings('global-sdf', stage)
        .map(([b]) => b)
        .sort((a, b) => a - b),
    );
    expect(
      result.reflection.boundGlobals.filter((row) => row.resourceKind === 'storage-buffer').length,
    ).toBe(stage === 'resolveCardRadiosity' ? 8 : 5);
  });
}

it('requires estimator model4 while source epoch3 and geometric link model3 remain distinct', () => {
  const state = integratedLightingState(true);
  expect(state).toEqual([3, 9, 4, 0]);
  expect(integratedLightingState(false)).toEqual([0, 9, 4, 0]);
  const old = resolveLighting({ probeModel: 3, linkModel: 3, weight: 1, incident: [2, 2, 2] });
  expect(old.lit).toEqual([0.5, 0.25, 0.125, 1]);
  expect(old.history).toEqual([0, 0, 0, 0]);
  expect(prepareLighting({}, [2, 2, 2, lightEpoch(3)], 3)).toEqual([0.5, 0.25, 0.125, 1]);
  const current = resolveLighting({
    probeModel: state[2],
    probeEpoch: state[0],
    linkModel: 3,
    weight: 1,
    incident: [2, 2, 2],
  });
  expect(current.lit).toEqual([1, 1.25, 1.625, 1]);
  expect(current.history).toEqual([2, 2, 2, lightEpoch(3)]);
  expect(prepareLighting({}, current.history, state[2])).toEqual(current.lit);
  expect(prepareLighting({ epoch: 4 }, current.history, state[2])).toEqual([0.5, 0.25, 0.125, 1]);
});

it('proves finite composition before operations and retains unbounded ready direct fallback', () => {
  const safe = { albedo: [2 ** 100, 1, 1], incident: [2 ** 25, 0, 0], weight: 1 };
  expect(resolveLighting(safe).lit).toEqual([2 ** 125, 0.25, 0.125, 1]);
  const boundary = resolveLighting({ ...safe, direct: [2 ** 126, 0.25, 0.125, 1] });
  expect(boundary.lit).toEqual([3 * 2 ** 125, 0.25, 0.125, 1]);
  expect(boundary.history).toEqual([2 ** 25, 0, 0, lightEpoch(3)]);
  const outsideProduct = { albedo: [2 ** 126, 1, 1], incident: [1, 0, 0], weight: 1 };
  expect(resolveLighting(outsideProduct).lit).toEqual([0.5, 0.25, 0.125, 1]);
  expect(resolveLighting(outsideProduct).history).toEqual([0, 0, 0, 0]);
  expect(resolveLighting(outsideProduct, false, 'product').history).toEqual([
    1,
    0,
    0,
    lightEpoch(3),
  ]);
  const outsideSum = {
    direct: [Math.fround(2 ** 126 * (1 + 2 ** -23)), 0, 0, 1],
    albedo: [1, 1, 1],
    incident: [1, 0, 0],
    weight: 1,
  };
  expect(resolveLighting(outsideSum).lit).toEqual(outsideSum.direct);
  expect(resolveLighting(outsideSum).history).toEqual([0, 0, 0, 0]);
  expect(resolveLighting(outsideSum, false, 'sum').history).toEqual([1, 0, 0, lightEpoch(3)]);
  const zero = resolveLighting({ direct: [3e38, 0, 0, 1], albedo: [3e38, 1, 1], weight: 1 });
  expect(zero.lit).toEqual([Math.fround(3e38), 0, 0, 1]);
  expect(zero.history).toEqual([0, 0, 0, lightEpoch(3)]);
});

it('stores self-contained GPU regression inputs and exact metadata expectations', () => {
  const programs = cardLightingGpuPrograms();
  expect(programs.map((p) => [p.name, p.cases.length])).toEqual([
    ['auditCardLighting', 11],
    ['prepareCardRadiosityBounce', 14],
    ['resolveCardRadiosity', 14],
  ]);
  for (const program of programs) {
    expect(new Set(program.bindings.map((b) => b.binding)).size).toBe(program.bindings.length);
    for (const output of program.outputs) {
      expect(output.expected.length % (program.cases.length * 16)).toBe(0);
      expect(program.bindings.find((b) => b.binding === output.binding)?.bytes.length).toBe(
        output.expected.length,
      );
    }
  }
  const helper = programs[0];
  if (!helper) throw new Error('Composition control required');
  const row = helper.cases.indexOf('nan-shaped-epoch-is-metadata');
  const expected = helper.outputs[0]?.expected;
  if (!expected) throw new Error('Exact epoch expectation required');
  expect(new DataView(expected.buffer).getUint32(row * 32 + 28, true)).toBe(0x7fc00001);
});
