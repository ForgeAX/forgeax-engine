import { expect, it } from 'vitest';
import {
  runFluidAddressProbe,
  runFluidImpulseProbe,
  runFluidRippleNormalProbe,
} from './fluid-normal-gpu';

it('uses the selected Ripple R-only stencil, source material spacing and positive-X height channel', async () => {
  const actual = await runFluidRippleNormalProbe();
  const length = Math.hypot(0.0625, 0.125, 1);
  expect(actual[0]).toBeCloseTo(-0.0625 / length, 5);
  expect(actual[1]).toBeCloseTo(-0.125 / length, 5);
  expect(actual[2]).toBeCloseTo(0.4803125, 6);
  expect(actual[3]).toBe(1);
});

it('clamps both Ripple height histories despite repeat-addressed source textures', async () => {
  const pixels = await runFluidAddressProbe('ripple', true);
  expect(pixels.map((pixel) => pixel[0])).toEqual([-26, -32]);
});

it.each([
  true,
  false,
])('preserves texture addressing in Shallow advection (repeat=%s)', async (repeat) => {
  const pixels = await runFluidAddressProbe('advect-height', repeat);
  expect(pixels.map((pixel) => pixel[0])).toEqual([2, repeat ? 1 : 4]);
});

it.each([
  true,
  false,
])('preserves texture addressing in Ripple normals (repeat=%s)', async (repeat) => {
  const pixels = await runFluidAddressProbe('normal-height', repeat);
  const slope = repeat ? -0.78125 : 0.390625;
  expect(pixels[0]?.[0]).toBeCloseTo(-slope / Math.hypot(slope, 1), 6);
  expect(pixels[1]?.[0]).toBeCloseTo(-slope / Math.hypot(slope, 1), 6);
});

it('draws default impulse noise and additive source foam without normalizing G', async () => {
  const pixels = await runFluidImpulseProbe();
  const noise = (64 / 255) ** 0.001;
  expect(pixels[0]?.[0]).toBeCloseTo(-noise, 6);
  expect(pixels[0]?.slice(1)).toEqual([99.75, 0, 1]);
  expect(pixels[1]).toEqual([0, 49.75, 0, 1]);
  expect(pixels[2]?.[0]).toBeCloseTo(-0.5 * noise, 6);
  expect(pixels[2]?.slice(1)).toEqual([0, 0, 1]);
  const zeroNoise = await runFluidImpulseProbe('zero-noise');
  expect(zeroNoise[0]).toEqual([0, 99.75, 0, 1]);
  const below = await runFluidImpulseProbe('subthreshold-overlap');
  expect(below[0]?.[0]).toBeCloseTo(0.004 * noise, 8);
  expect(below[0]?.slice(1)).toEqual([0, 0, 1]);
  expect((await runFluidImpulseProbe('threshold'))[0]?.[1]).toBe(0);
  const boundary = await runFluidImpulseProbe('mask-boundary');
  expect(boundary[1]?.[0]).toBeCloseTo(-0.75 * noise, 6);
  expect(boundary[1]?.[1]).toBe(0);
});
