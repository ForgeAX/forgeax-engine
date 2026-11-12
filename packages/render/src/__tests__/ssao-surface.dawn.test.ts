import { expect, it } from 'vitest';
import {
  runSsaoSurfaceCase,
  type SsaoSurfaceAlgorithm,
  type SsaoSurfaceScene,
} from './ssao-surface-dawn-fixture';

const scenes: readonly (readonly [SsaoSurfaceScene, number])[] = [
  ['plane', 16],
  ['plane', 32],
  ['plane', 64],
  ['orthographic', 16],
  ['orthographic', 32],
  ['orthographic', 64],
  ['contact', 64],
  ['distant-edge', 64],
  ['background', 64],
];
const gtaoScenes: readonly (readonly [SsaoSurfaceScene, number])[] = [
  ['plane', 4],
  ['plane', 10],
  ['contact', 16],
  ['distant-edge', 16],
  ['background', 16],
  ['plane-odd', 16],
  ['plane-jitter', 16],
  ['plane-odd', 64],
  ['plane-jitter', 64],
];

function casesFor(
  algorithm: SsaoSurfaceAlgorithm,
): readonly (readonly [SsaoSurfaceScene, number])[] {
  return algorithm === 'gtao' ? [...scenes.slice(0, 6), ...gtaoScenes, ...scenes.slice(6)] : scenes;
}

for (const algorithm of ['ssao', 'gtao'] as const)
  it.each(
    casesFor(algorithm),
  )(`production ${algorithm} %s with %i samples`, async (scene, sampleCount) => {
    expect(await runSsaoSurfaceCase(algorithm, scene, sampleCount)).toBeUndefined();
  });
