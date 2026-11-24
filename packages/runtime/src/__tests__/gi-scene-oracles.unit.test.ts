import { expect, it } from 'vitest';
import { opening0SupportWitness } from './gi-scene-opening0.fixture';
import { averageSupportImages, supportImage } from './gi-scene-support-window.fixture';
import {
  roomAnalyticReference,
  roomPixels,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  visibleSupport,
} from './gi-scenes.fixture';

/** Independent midpoint integration of Le * cos(receiver) * cos(source) /
 * (pi * distance^2) over both visible rectangular emitter faces. This does
 * not reuse polygon directions, edge angles or the Renderer. */
function quadrature(x: number, y: number, subdivisions: number): number {
  let side = 0,
    front = 0;
  const dx = x + 2.375,
    frontDz = 2.425;
  for (let i = 0; i < subdivisions; i++)
    for (let j = 0; j < subdivisions; j++) {
      const sourceY = -1 + ((i + 0.5) * 2) / subdivisions;
      const dz = -0.45 + ((j + 0.5) * 1.5) / subdivisions + 2.875;
      const r2 = dx * dx + (sourceY - y) ** 2 + dz * dz;
      side += (((dx * dz) / (r2 * r2)) * 3) / (subdivisions * subdivisions);
      const sourceX = -2.625 + ((j + 0.5) * 0.25) / subdivisions;
      const rFront2 = (sourceX - x) ** 2 + (sourceY - y) ** 2 + frontDz * frontDz;
      front += (((frontDz * frontDz) / (rFront2 * rFront2)) * 0.5) / (subdivisions * subdivisions);
    }
  return (4 * (side + front)) / Math.PI;
}

it('checks every polygon-oracle ROI pixel against converged independent area quadrature', () => {
  const analytic = roomAnalyticReference('open');
  for (const side of ['left', 'right'] as const)
    for (const p of roomPixels(side)) {
      const x =
        ((((p % SCENE_WIDTH) + 0.5) / SCENE_WIDTH) * 2 - 1) * Math.tan(Math.PI / 6) * 1.5 * 4.875;
      const y =
        (1 - ((Math.floor(p / SCENE_WIDTH) + 0.5) / SCENE_HEIGHT) * 2) *
        Math.tan(Math.PI / 6) *
        4.875;
      const coarse = quadrature(x, y, 32),
        fine = quadrature(x, y, 64);
      expect(Math.abs(coarse - fine) / fine).toBeLessThan(0.00005);
      for (const [c, ratio] of [1, 0.3, 0.7].entries())
        expect(
          Math.abs((analytic.rgb[p * 3 + c] ?? NaN) - fine * ratio) / (fine * ratio),
        ).toBeLessThan(0.00005);
    }
});

it('keeps geometric darkness separate from pixels outside the analytic oracle domain', () => {
  const closed = roomAnalyticReference('closed'),
    open = roomAnalyticReference('open');
  const inside = new Set([...roomPixels('left'), ...roomPixels('right')]);
  for (const p of roomPixels('left'))
    for (let c = 0; c < 3; c++) {
      expect(closed.rgb[p * 3 + c]).toBe(open.rgb[p * 3 + c]);
      expect(closed.rgb[p * 3 + c]).toBeGreaterThan(0);
    }
  for (const p of roomPixels('right'))
    for (let c = 0; c < 3; c++) expect(closed.rgb[p * 3 + c]).toBe(0);
  for (let p = 0; p < SCENE_WIDTH * SCENE_HEIGHT; p++)
    if (!inside.has(p))
      for (let c = 0; c < 3; c++) expect(Number.isNaN(closed.rgb[p * 3 + c])).toBe(true);
});

it('averages actual visible support without letting hidden black or NaN observations create holes', async () => {
  for (const hidden of [0, NaN, -1, undefined]) {
    const visible = supportImage([17], 1, 2),
      occluded = supportImage([], hidden, 4);
    for (const frames of [
      [visible, occluded],
      [occluded, visible],
    ]) {
      const { image, saved } = await averageSupportImages(frames);
      expect(visibleSupport(image)).toEqual({
        visible: 1,
        missing: 0,
        incomplete: 0,
        missingFraction: 0,
      });
      expect(image.rgb[51]).toBe(3);
      expect(image.covered?.[17]).toBe(1);
      expect(Number.isNaN(image.support?.[18])).toBe(true);
      expect(saved.get('support-window.f32')).toEqual(new Uint8Array(image.rgb.buffer));
      expect(saved.get('support-window-visible.u8')).toEqual(image.covered);
      expect(saved.get('support-window-minimum-support.f32')).toEqual(
        new Uint8Array(image.support?.buffer ?? new ArrayBuffer(0)),
      );
    }
  }
  const nonfiniteRgb = await averageSupportImages([
    supportImage([17], 1, 2),
    supportImage([], NaN, NaN),
  ]);
  expect(visibleSupport(nonfiniteRgb.image).missing).toBe(0);
  expect(Number.isNaN(nonfiniteRgb.image.rgb[51])).toBe(true);
});

it('keeps visible zero, NaN, negative and absent support as failures in either frame order', async () => {
  for (const invalid of [0, NaN, -1, undefined]) {
    for (const frames of [
      [supportImage([17], 1), supportImage([17], invalid)],
      [supportImage([17], invalid), supportImage([17], 1)],
    ]) {
      const { image } = await averageSupportImages(frames);
      expect(visibleSupport(image).missing).toBe(1);
    }
  }
  // Support present only in a hidden frame cannot qualify the visible missing observation.
  for (const frames of [
    [supportImage([17], undefined), supportImage([], 1)],
    [supportImage([], 1), supportImage([17], undefined)],
  ])
    expect(visibleSupport((await averageSupportImages(frames)).image).missing).toBe(1);
});

it('keeps direct windows without any support undefined and preserves fully supported observations', async () => {
  const direct = await averageSupportImages([
    supportImage([17], undefined),
    supportImage([], undefined),
  ]);
  expect(direct.image.support).toBeUndefined();
  expect(direct.saved.has('support-window-minimum-support.f32')).toBe(false);
  const supported = await averageSupportImages([supportImage([17, 19], 1), supportImage([19], 1)]);
  expect(visibleSupport(supported.image)).toEqual({
    visible: 2,
    missing: 0,
    incomplete: 0,
    missingFraction: 0,
  });
});

it('retains all seven actual historical opening0 same-frame holes as an unrelaxed negative control', async () => {
  const witness = opening0SupportWitness();
  expect(witness.provenance.frameId).toBe(115);
  const { image } = await averageSupportImages([
    { ...supportImage([], undefined), ...witness.image },
  ]);
  const missing: number[] = [];
  for (let pixel = 0; pixel < SCENE_WIDTH * SCENE_HEIGHT; pixel++)
    if (image.covered?.[pixel] && !((image.support?.[pixel] ?? NaN) > 0.99)) missing.push(pixel);
  expect(missing).toEqual([47, 143, 717, 908, 1004, 1195, 1482]);
  expect(visibleSupport(image).missing).toBe(7);
  expect(visibleSupport(image).missingFraction).toBeGreaterThan(0);
});
