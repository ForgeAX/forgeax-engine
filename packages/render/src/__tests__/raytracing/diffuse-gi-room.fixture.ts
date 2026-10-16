import { vec3 } from '@forgeax/engine-math';
import { expect } from 'vitest';
import type { DiffuseGiFixture } from './diffuse-gi.commands';
import { giSource, runGi } from './diffuse-gi.fixture';
export async function verifyGiRoom(
  fixture: DiffuseGiFixture,
  feedback = false,
  observe?: (result: Awaited<ReturnType<typeof runGi>>) => Promise<void>,
) {
  const sources = [
    giSource(fixture, 'white', 0, [0, 0, -3.25], [3.5, 3.5, 0.25]),
    giSource(fixture, 'white', 1, [0, -3.25, 0], [3.5, 0.25, 3.5]),
    giSource(fixture, 'red', 2, [-3.25, 0, 0], [0.25, 3.5, 3.5]),
    giSource(fixture, 'white', 3, [3.25, 0, 0], [0.25, 3.5, 3.5]),
    giSource(fixture, 'white', 4, [0.8, -2, 0], [0.75, 1, 0.75]),
    giSource(fixture, 'white', 5, [-1, -2.25, -1], [0.6, 0.75, 0.6]),
    giSource(fixture, feedback ? 'emission' : 'white', 6, [0, 2.9, 0], [1, 0.1, 1]),
    giSource(fixture, 'white', 7, [0, 3.25, 0], [3.5, 0.25, 3.5]),
  ];
  const n = [0, 0.2873478855663454, 0.9578262852211513] as const,
    v = [0, -n[2], n[1]] as const;
  const result = await runGi(fixture, {
    sources,
    capture: observe !== undefined,
    lights: feedback
      ? false
      : [
          {
            kind: 'point',
            position: vec3.create(0, 2, 1),
            color: vec3.create(Math.PI * 8, Math.PI * 8, Math.PI * 8),
            intensity: Math.PI * 8,
            invRangeSquared: 0,
          },
        ],
    settings: {
      resolution: 32,
      cardResolution: 8,
      samples: 128,
      iterations: feedback ? 1 : 0,
      probeOrigin: [-2.8, -2.8, -2.8],
      probeCounts: [4, 4, 4],
      probeSpacing: 1.86666666667,
      view: {
        origin: [-2.4, n[1] * 8 - v[1] * 2.4, n[2] * 8 - v[2] * 2.4],
        u: [1, 0, 0],
        v,
        n,
        width: 4.8,
        height: 4.8,
        depth: 16,
      },
    },
  });
  await observe?.(result);
  const f = new Float32Array(result.reference.buffer);
  expect(Array.from(f).every(Number.isFinite)).toBe(true);
  expect(Array.from({ length: 1024 }, (_, i) => f[i * 20 + 12] ?? 0).some((v) => v > 0.01)).toBe(
    true,
  );
  const counts = Object.fromEntries(
    ['field', 'reference'].map((name) => {
      const data = name === 'field' ? result.field : result.reference;
      const states = new Uint32Array(data.buffer);
      return [
        name,
        Array.from({ length: 1024 }, (_, i) => states[i * 20 + 16]).filter((s) => s === 1).length,
      ];
    }),
  );
  if (!feedback) {
    expect(counts.field).toBeGreaterThanOrEqual(800);
    expect(counts.reference).toBeGreaterThanOrEqual(1000);
  } else {
    // Contact/buried card feedback is not yet a qualified complete generation.
    expect(counts.field).toBeLessThan(1024);
  }
  return { ...result, completePixels: counts };
}
