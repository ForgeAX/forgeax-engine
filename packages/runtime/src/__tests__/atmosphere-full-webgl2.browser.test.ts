import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { atmosphereImageError, fullAtmosphereCases } from './atmosphere-full.fixture';

it('matches full physical atmosphere on actual WebGL2, including opaque and blended AP, caching and real context recovery', {
  timeout: 180_000,
}, async () => {
  const reference = await fullAtmosphereCases('webgpu');
  const actual = await fullAtmosphereCases('wgpu-webgl2');
  const evidence = [];
  for (const key of ['day', 'noAerial', 'sunset', 'high', 'vacuum', 'fog', 'ao'] as const) {
    const error = atmosphereImageError(reference[key], actual[key]);
    expect(error.p95, `${key} p95`).toBeLessThanOrEqual(0.02);
    expect(error.p99, `${key} p99`).toBeLessThanOrEqual(0.05);
    evidence.push({ case: key, ...error });
  }
  for (let y = 30; y <= 34; y++)
    for (let x = 46; x <= 50; x++)
      for (let c = 0; c < 3; c++)
        expect(
          Math.abs(
            (reference.noAerial[(y * 97 + x) * 4 + c] ?? 0) -
              (actual.noAerial[(y * 97 + x) * 4 + c] ?? 0),
          ) / 255,
        ).toBeLessThanOrEqual(0.02);
  const cubeErrors = actual.cube
    .map(
      (value, index) =>
        Math.abs(value - (reference.cube[index] ?? 0)) /
        Math.max(1, Math.abs(reference.cube[index] ?? 0)),
    )
    .sort((a, b) => a - b);
  expect(cubeErrors[Math.floor(cubeErrors.length * 0.99)]).toBeLessThanOrEqual(0.005);
  const planarErrors = actual.planar
    .map(
      (value, index) =>
        Math.abs(value - (reference.planar[index] ?? 0)) /
        Math.max(1, Math.abs(reference.planar[index] ?? 0)),
    )
    .sort((a, b) => a - b);
  expect(planarErrors[Math.floor(planarErrors.length * 0.99)]).toBeLessThanOrEqual(0.005);
  await commands.writeFile(
    'artifacts/ci-focus/atmosphere-full/quality.json',
    JSON.stringify(
      {
        images: evidence,
        planar: {
          p99RelativeError: planarErrors[Math.floor(planarErrors.length * 0.99)],
          maxRelativeError: planarErrors.at(-1),
          channels: planarErrors.length,
        },
        cube: {
          p99RelativeError: cubeErrors[Math.floor(cubeErrors.length * 0.99)],
          maxRelativeError: cubeErrors.at(-1),
          channels: cubeErrors.length,
        },
      },
      null,
      2,
    ),
  );
});
