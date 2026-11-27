import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { rayShaderTestImports } from './ray-shader-imports.fixture';
import {
  angularAllocation,
  sameNormalQuadrature,
  screenProbeSupportSource,
  supportNormal,
} from './screen-probe-support-domain.fixture';

it('retains the required horizon cells so same-normal known quadrature remains supported', () => {
  const n = supportNormal([1, 0, 1]),
    result = sameNormalQuadrature(n);
  expect(result.allocation.centerCosines[5]).toBeLessThan(-0.12);
  expect(result.allocation.required[5]).toBe(true);
  expect(result.allocation.slots[5]).toBeGreaterThan(0);
  expect(result.value.w).toBe(1);
  expect(result.value.x).toBeCloseTo(1, 6);
});

it('keeps the required domain and per-cell weights under rotations, near-horizon normals and cold/black guides', () => {
  const normals = [
    [0, 0, 1],
    [0.0002443792182, 0.0002443792182, 1],
    [1, 0.0002443792182, 0],
    [1, 0.3, 0.2],
    ...Array.from({ length: 8 }, (_, i) => [
      Math.cos((i * Math.PI) / 4),
      Math.sin((i * Math.PI) / 4),
      0.3,
    ]),
  ];
  for (const raw of normals) {
    const n = supportNormal([raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0]);
    const result = sameNormalQuadrature(n);
    expect(result.value.w).toBe(1);
    expect(result.value.x).toBeCloseTo(1, 6);
    for (let t = 0; t < 64; t++) {
      const count = result.allocation.slots[t] ?? 0;
      expect(count > 0).toBe(result.allocation.required[t]);
      expect([0, 1, 4]).toContain(count);
      if (count > 0) expect(count * (1 / count)).toBe(1);
    }
    expect(result.allocation.total).toBeLessThanOrEqual(64);
    // Boundary coverage must not add expensive guide lookups to the old center domain.
    expect(result.allocation.cacheQueries).toBe(
      result.allocation.centerCosines.filter((c) => c > 0).length,
    );
    for (const guide of [
      [0, 0, 0, 1],
      [1, 1, 1, 1],
      [40, 1, 0, 1],
    ] as const) {
      const guided = angularAllocation(n, true, guide);
      expect(guided.total).toBeLessThanOrEqual(64);
      expect(guided.slots.map((count) => count > 0)).toEqual(result.allocation.required);
      expect(guided.cacheQueries).toBe(result.allocation.cacheQueries);
    }
    expect(angularAllocation(n, false).slots).toEqual(Array(64).fill(1));
  }
});

it('composes every actual Screen entry through the production imports in live and four-buffer modes', async () => {
  const imports = await rayShaderTestImports();
  for (const visibility of [false, true]) {
    const result = await compileShader(screenProbeSupportSource, {
      id: `screen-probe-support-domain-${visibility}`,
      imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: visibility },
    });
    expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
    if (result.ok) {
      const entries = result.value.manifestEntry.entryPoints?.map((entry) => entry.name);
      for (const entry of ['generateProbeRays', 'resolveProbeRays', 'integrateScreenProbes'])
        expect(entries).toContain(entry);
    }
  }
});

it('keeps positive unknown transport unavailable and rejects an unsupported tilted-neighbor lobe', () => {
  const n = supportNormal([0, 0, 1]);
  const base = angularAllocation(n);
  const positive = base.centerCosines.findIndex((c) => c > 0.5);
  expect(positive).toBeGreaterThanOrEqual(0);
  const unknown = sameNormalQuadrature(n, n, positive);
  expect(unknown.value.w).toBe(-1);
  expect(unknown.value.x).toBe(0);
  const tilted = sameNormalQuadrature(n, supportNormal([1, 0, -1]));
  expect(tilted.value.w).toBeLessThanOrEqual(0);
  expect(tilted.value.x).toBe(0);
});
