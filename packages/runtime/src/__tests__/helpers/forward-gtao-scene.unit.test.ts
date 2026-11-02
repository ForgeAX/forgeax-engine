import { expect, it } from 'vitest';
import { FORWARD_GTAO_FIXTURE } from './forward-gtao-scene';

it('keeps the Alpha Mask cutoff away from every odd-width pixel center', () => {
  const { width, height, alphaMask } = FORWARD_GTAO_FIXTURE;
  // The two green texels cross cutoff 0.5 at the foreground box's center.
  // An exactly aligned sample lets backend interpolation rounding change depth
  // by the whole foreground/background separation, rather than a depth ULP.
  const projectedHalfWidth = Math.tan(Math.PI / 6) * (width / height) * 3.95;
  const separation = Math.min(
    ...Array.from({ length: width }, (_, x) => {
      const rayX = ((2 * (x + 0.5)) / width - 1) * projectedHalfWidth;
      return Math.abs(rayX - alphaMask.foregroundCenterX);
    }),
  );
  expect(width % 2).toBe(1);
  expect(height % 2).toBe(1);
  expect(separation).toBeGreaterThan(1e-4);
});
