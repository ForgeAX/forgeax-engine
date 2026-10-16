import { expect, it } from 'vitest';
import { packSettings, type RayPathSettings } from '../../raytracing/path-input';

const ray = {
  origin: [1, 2, 3],
  direction: [0, 1, 0],
  coneWidth: 0.02,
  coneSpread: 0.3,
  active: true,
};
const settings = {
  width: 1,
  height: 1,
  maxBounces: 1,
  seed: 47,
  environment: [0, 0, 0],
  maxDistance: 120,
};
it('admits a bounded external ray source without requiring a camera', () => {
  expect(packSettings({ ...settings, rays: [ray] } as unknown as RayPathSettings).ok).toBe(true);
});
it('refuses cardinality, direction, footprint and ambiguous source errors', () => {
  for (const source of [
    {},
    { rayBuffer: null },
    { rayBuffer: 1 },
    { rayBuffer: {}, rays: [ray] },
    {
      rayBuffer: {},
      camera: { origin: [0, 0, 2], target: [0, 0, 0], up: [0, 1, 0], verticalFov: 1 },
    },
    { rays: [] },
    { rays: [{ ...ray, origin: [Infinity, 0, 0] }] },
    { rays: [{ ...ray, direction: [0, 0, 0] }] },
    { rays: [{ ...ray, direction: [0, 2, 0] }] },
    { rays: [{ ...ray, coneWidth: -1 }] },
    { rays: [{ ...ray, coneSpread: NaN }] },
    { rays: [{ ...ray, active: 1 }] },
    {
      rays: [ray],
      camera: { origin: [0, 0, 2], target: [0, 0, 0], up: [0, 1, 0], verticalFov: 1 },
    },
  ])
    expect(packSettings({ ...settings, ...source } as unknown as RayPathSettings).ok).toBe(false);
});
