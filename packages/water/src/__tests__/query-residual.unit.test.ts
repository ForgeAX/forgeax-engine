import { expect, it } from 'vitest';
import { WaterQueryFlags, type WaterQueryInput, type WaterQueryResult } from '../contracts';
import { composeWaterQueryResidual, type WaterResidualQueryField } from '../query-residual';

const binding = {
  worldIdentity: 'world',
  bodyGuid: 'body',
  bodyGeneration: 3,
  maximumAgeSeconds: 0.2,
};
const field: WaterResidualQueryField = {
  binding,
  recipeGuid: 'recipe',
  recipeVersion: 'v1',
  patchGeneration: 2,
  deviceGeneration: 4,
  sourceSequence: 7,
  sourcePhysicsStep: 60,
  timeSeconds: 1,
  simulationTimeSeconds: 1,
  completedFrame: 9,
  resolution: 32,
  centerXZ: [0, 0],
  domainLengthM: 16,
  baseHeightM: 8,
  yawRadians: 0,
  offset: [0, 0],
  size: [32, 32],
  heightsM: new Float32Array(32 * 32).fill(0.2),
};
const result: WaterQueryResult = {
  bodyGuid: 'body',
  bodyGeneration: 3,
  adjustedFlags: WaterQueryFlags.IncludeWaves,
  valid: new Set(['location', 'normal', 'depth', 'immersion']),
  locationM: [0, 8, 0],
  surfaceM: [0, 8.3, 0],
  normalYUp: [0, 1, 0],
  depthM: 4.3,
  immersionM: 0.5,
  excluded: false,
  source: 'terrain',
};
const input: WaterQueryInput = {
  positionM: [0, 7.8, 0],
  flags: WaterQueryFlags.IncludeWaves,
  timeSeconds: 900,
  nativePhysics: { completedStep: 63, timeSeconds: 1.05 },
};
const domain = {
  resolution: field.resolution,
  centerXZ: field.centerXZ,
  domainLengthM: field.domainLengthM,
  baseHeightM: field.baseHeightM,
  yawRadians: field.yawRadians,
};

it('selects a receiver-qualified external field without feeding its own source back into the query', () => {
  const cells = field.size[0] * field.size[1];
  const heights = new Float32Array(cells * 3);
  heights.fill(0.2, 0, cells);
  heights.fill(0.05, cells, cells * 2);
  heights.fill(-0.1, cells * 2);
  const source = {
    binding,
    domain,
    field: {
      ...field,
      heightsM: heights,
      receivers: [
        { entity: 12, generation: 4 },
        { entity: 13, generation: 5 },
      ],
    },
  };
  expect(composeWaterQueryResidual(result, input, source).unwrap().surfaceM?.[1]).toBeCloseTo(8.5);
  for (const [receiver, expected] of [
    [{ entity: 12, generation: 4 }, 8.35],
    [{ entity: 13, generation: 5 }, 8.2],
  ] as const) {
    const query = composeWaterQueryResidual(result, { ...input, receiver }, source).unwrap();
    expect(query.surfaceM?.[1]).toBeCloseTo(expected);
  }
  const stale = composeWaterQueryResidual(
    result,
    { ...input, receiver: { entity: 12, generation: 5 } },
    source,
  ).unwrap();
  expect(stale.surfaceM).toEqual(result.surfaceM);
  expect(stale.localResidual).toMatchObject({
    ok: false,
    error: { detail: { reason: 'receiver-unavailable' } },
  });
});

it('uses independent native time and adds the residual once above a nonzero Body/reference height', () => {
  const queried = composeWaterQueryResidual(result, input, { binding, domain, field }).unwrap();
  expect(queried.locationM).toEqual(result.locationM);
  expect(queried.surfaceM?.[1]).toBeCloseTo(8.5);
  expect(queried.immersionM).toBeCloseTo(0.7);
  expect(queried.depthM).toBeCloseTo(4.5);
  expect(queried.localResidual).toMatchObject({
    ok: true,
    value: { sourcePhysicsStep: 60, timeSeconds: 1 },
  });
  expect(queried.localResidual?.unwrap().ageSeconds).toBeCloseTo(0.05);
  expect(
    composeWaterQueryResidual(
      result,
      { ...input, timeSeconds: 0 },
      { binding, domain, field },
    ).unwrap().surfaceM,
  ).toEqual(queried.surfaceM);
});

it('matches the four-cell patch edge and rotates its blend gradient independently of the tile', () => {
  const queried = composeWaterQueryResidual(
    result,
    { ...input, positionM: [7, 0, 0] },
    {
      binding,
      domain: { ...domain, yawRadians: Math.PI / 2 },
      field: { ...field, yawRadians: Math.PI / 2 },
    },
  ).unwrap();
  expect(queried.localResidual?.unwrap().weight).toBeCloseTo(0.5);
  expect(queried.localResidual?.unwrap().heightM).toBeCloseTo(0.1);
  const slope = ((0.2 * 6 * 0.5 * 0.5) / 4) * 2;
  expect(queried.normalYUp?.[0]).toBeCloseTo(slope / Math.hypot(1, slope));
  expect(queried.normalYUp?.[2]).toBeCloseTo(0);
});

it('preserves base water while reporting missing, future, expired, cross-Body and uncovered local data', () => {
  for (const source of [
    { binding },
    { binding, field: { ...field, timeSeconds: 2 } },
    { binding, field: { ...field, timeSeconds: 0 } },
    { binding: { ...binding, bodyGeneration: 4 }, field },
    {
      binding,
      field: {
        ...field,
        offset: [0, 0] as const,
        size: [4, 4] as const,
        heightsM: new Float32Array(16),
      },
    },
  ]) {
    const queried = composeWaterQueryResidual(result, input, { ...source, domain }).unwrap();
    expect(queried.surfaceM).toBe(result.surfaceM);
    expect(queried.immersionM).toBe(result.immersionM);
    expect(queried.normalYUp).toBe(result.normalYUp);
    expect(queried.localResidual).toMatchObject({
      ok: false,
      error: { code: 'query-data-unavailable', detail: { kind: 'local-residual' } },
    });
  }
  expect(
    composeWaterQueryResidual(
      result,
      { ...input, nativePhysics: { completedStep: 59, timeSeconds: 1.05 } },
      { binding, domain, field },
    ).unwrap().localResidual?.ok,
  ).toBe(false);
  expect(
    composeWaterQueryResidual(
      result,
      { positionM: input.positionM, flags: input.flags, timeSeconds: input.timeSeconds },
      { binding, domain, field },
    ).unwrap().localResidual?.ok,
  ).toBe(false);
  for (const source of [
    { binding, domain, field },
    { binding, domain },
    { binding, domain, field: { ...field, timeSeconds: -10 } },
  ])
    expect(
      composeWaterQueryResidual(
        result,
        { positionM: [9, 0, 0], flags: input.flags, timeSeconds: input.timeSeconds },
        source,
      ).unwrap(),
    ).toBe(result);
});
