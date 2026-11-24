import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { rayShaderTestImports } from './ray-shader-imports.fixture';
import {
  carryPolicyCull,
  isPolicyCull,
  type PlanReceiver,
  plannedCull,
  policyCullPacket,
  projectedCullBound,
} from './screen-probe-angular-plan.fixture';
import { type ResolveRayInput, resolveRayCells } from './screen-probe-resolve.fixture';
import {
  angularAllocation,
  sameNormalQuadrature,
  screenProbeSupportSource,
  supportNormal,
} from './screen-probe-support-domain.fixture';

// Actual source c69/frame1232, probe17710 and adjacent pixels881/882 at y704.
// The empty cell29 packet and normals are observed GPU data; other cells below
// are independent uniform-light controls, not a reconstruction of the scene.
const receiver: PlanReceiver = {
  normal: [0.007458223029971123, 0.9999150633811951, -0.010690473020076752],
  pixel: 880 | (704 << 16),
  receiverExpected: [36864, 4194304, 1, 3],
  receiverControl: [1, 0, 47, 1],
};
const pair = [
  [0.007447223179042339, 0.9999300837516785, -0.009185239672660828],
  [0.007432584185153246, 0.9999465942382812, -0.007185129914432764],
] as const;
function inputPlan() {
  const allocation = angularAllocation(receiver.normal),
    rays: ResolveRayInput[] = [];
  for (const [texel, count] of allocation.slots.entries())
    for (let i = 0; i < count; i++) {
      const x = ((texel % 8) + 0.5) / 4 - 1,
        y = (Math.floor(texel / 8) + 0.5) / 4 - 1;
      const z = 1 - Math.abs(x) - Math.abs(y);
      const direction = supportNormal(
        z < 0
          ? [(1 - Math.abs(y)) * Math.sign(x || 1), (1 - Math.abs(x)) * Math.sign(y || 1), z]
          : [x, y, z],
      );
      rays.push({ info: texel | 512, direction, radiance: [1, 1, 1], hitDistance: 2 });
    }
  while (rays.length < 64)
    rays.push({ info: 3 << 12, direction: [0, 0, 1], radiance: [0, 0, 0], hitDistance: -1 });
  return rays;
}
function evaluate(query: readonly [number, number, number], rays = inputPlan(), ready = true) {
  const output = resolveRayCells(rays, true, [0, 0, 0, 0], true, 1, { receiver, ready }).output;
  const replacements = new Map(output.map((packet, i) => [i, packet]));
  return {
    output,
    value: sameNormalQuadrature(
      receiver.normal,
      query,
      undefined,
      true,
      undefined,
      undefined,
      replacements,
    ).value,
  };
}
it('retains the observed adjacent-normal signal while charging unobserved angular mass', () => {
  expect(inputPlan().filter((r) => (r.info & 512) !== 0 && (r.info & 63) === 29)).toHaveLength(0);
  for (const query of pair) {
    const value = evaluate(query).value;
    expect(value.x).toBeCloseTo(1, 6);
    expect(value.w).toBeGreaterThan(2);
    if (query === pair[1])
      expect(value.w).toBeLessThan(3); // The newly exposed angular region incurs debt.
    else expect(value.w).toBeLessThanOrEqual(3);
  }
});
it('mints only a current policy cull, not an absent plan, inactive receiver or failed assigned ray', () => {
  expect(plannedCull(receiver, 29)).toBe(true);
  expect(plannedCull(receiver, 29, false)).toBe(false);
  expect(plannedCull(receiver, 29, true, false)).toBe(false);
  expect(evaluate(pair[1], inputPlan(), false).value.w).toBe(0);
  const rays = inputPlan();
  const first = rays[0];
  if (first === undefined) throw Error('The independent plan must retain its original ray budget');
  rays[0] = { ...first, info: 29 | 512 | (4 << 12) };
  expect(evaluate(pair[1], rays).output[29]?.age).toBe(-2);
  expect(evaluate(pair[1], rays).output[29]?.policyCullTexel).toBeUndefined();
});
it('adds neither radiance nor known measure and rejects nonfinite or corrupted cull metadata', () => {
  const packet = policyCullPacket(29);
  expect(packet.samples.slice(0, 2)).toEqual([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ]);
  expect(projectedCullBound(29, pair[1])).toBeGreaterThan(0);
  expect(projectedCullBound(29, [NaN, 1, 0])).toBe(-1);
  expect(projectedCullBound(29, [Infinity, 0, 0])).toBe(-1);
  expect(isPolicyCull(packet, 29)).toBe(true);
  expect(isPolicyCull(packet, 30)).toBe(false);
  packet.samples[0] = { x: 0x7fc00000, y: 0 };
  expect(isPolicyCull(packet, 29)).toBe(false);
});

it('keeps a wholly absent plan and a thin-wall failed ray unavailable without inventing observations', () => {
  const absent: ResolveRayInput[] = Array.from({ length: 64 }, () => ({
    info: 3 << 12,
    direction: [0, 0, 1],
    radiance: [0, 0, 0],
    hitDistance: -1,
  }));
  expect(evaluate(pair[1], absent).value.w).toBe(0);
  absent[0] = {
    info: 29 | 512 | (4 << 12),
    direction: [0, 1, 0],
    radiance: [0, 0, 0],
    hitDistance: -1,
  };
  const failed = evaluate(pair[1], absent);
  expect(failed.output[29]?.age).toBe(-2);
  expect(failed.output[29]?.weighted[3]).toBeGreaterThan(0);
  expect(failed.value.w).toBe(0);
  expect(plannedCull({ ...receiver, receiverExpected: [36864, 4194304, 1, 4] }, 29)).toBe(false);
});

it('preserves a policy marker through actual temporal and filter exits without creating supported history', () => {
  for (const stage of ['temporal', 'filter'] as const) {
    const result = carryPolicyCull(stage);
    expect(result.radiance).toBe(result.packet);
    if (stage === 'temporal') expect(result.history).toBe(result.packet);
    expect(result.packet.support).toBeLessThan(0);
  }
});

function projectedCellMeasure(texel: number, sx: number, sy: number, n: readonly number[]) {
  const x = ((texel % 8) + sx) / 4 - 1,
    y = (Math.floor(texel / 8) + sy) / 4 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const v =
    z < 0
      ? [(1 - Math.abs(y)) * Math.sign(x || 1), (1 - Math.abs(x)) * Math.sign(y || 1), z]
      : [x, y, z];
  const norm = Math.hypot(...v);
  return (
    Math.max(
      v.reduce((sum, value, k) => sum + value * (n[k] ?? 0), 0),
      0,
    ) /
    norm ** 4
  );
}
it('bounds missing cellwise projected mass across folded seams and grazing directions', () => {
  for (const n of [
    ...pair,
    supportNormal([0, 1, 0]),
    supportNormal([1, 0, 1]),
    supportNormal([-1, 0.2, -0.1]),
  ]) {
    for (let texel = 0; texel < 64; texel++) {
      const bound = projectedCullBound(texel, n);
      for (let y = 0; y <= 8; y++)
        for (let x = 0; x <= 8; x++) {
          // Independent oct-J*cos identity. Sampling supplements the continuum
          // corner/radius proof; it is not GPU arithmetic qualification.
          expect(projectedCellMeasure(texel, x / 8, y / 8, n)).toBeLessThanOrEqual(bound);
        }
    }
  }
});

it('composes actual Screen entries with both visibility and cached preparation policies', async () => {
  const imports = await rayShaderTestImports();
  for (const visibility of [false, true])
    for (const cached of [false, true]) {
      const result = await compileShader(screenProbeSupportSource, {
        id: `screen-probe-angular-policy-${visibility}-${cached}`,
        imports,
        defines: {
          IRRADIANCE_FIELD_VISIBILITY: visibility,
          IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE: cached,
        },
      });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
    }
});
