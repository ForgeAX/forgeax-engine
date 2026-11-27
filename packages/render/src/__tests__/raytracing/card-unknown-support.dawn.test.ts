import { expect, it } from 'vitest';
import { IrradianceFieldRayStatus } from '../../raytracing/irradiance-field';
import { ScreenProbeRayStatus } from '../../raytracing/screen-probe-plan';
import { runCardUnknownSupport } from './card-unknown-support.fixture';

it('keeps unmapped or stale Card hits unavailable while preserving mapped black', async () => {
  const result = await runCardUnknownSupport();
  expect(result.rows).toHaveLength(18);
  expect(result.errors).toEqual([]);
  expect(result.authoredTriangleNearest).toBeCloseTo(2, 4);
  for (const [axis, value] of result.origin.entries()) expect(result.placed[axis]).toBe(value);
  for (const row of result.rows) {
    const name = `${row.mode}/pending-${row.pending}`;
    expect(row.world[0], `${name}: real production geometry hit`).toBe(1);
    if (row.expectedSupported) {
      expect(row.world[2], `${name}: mapped Card witness`).toBe(1);
      expect(row.screen.state, name).toBe(ScreenProbeRayStatus.resolved);
      expect(row.field[7], name).toBe(IrradianceFieldRayStatus.hit);
    } else {
      expect(row.world[2], `${name}: unavailable Card witness`).toBeLessThanOrEqual(0);
      expect(row.screen.state, `${name}: unknown is not known black or sky`).toBe(
        ScreenProbeRayStatus.fallback,
      );
      expect(row.field[7], `${name}: retain radiance history for unavailable material`).toBe(
        IrradianceFieldRayStatus.unlit,
      );
    }
    if (row.mode === 'mapped-black') {
      expect(row.screen.rgb, name).toEqual([0, 0, 0]);
      expect(row.field.slice(0, 3), name).toEqual([0, 0, 0]);
    }
    if (row.mode === 'mapped-color') {
      expect(row.screen.rgb, name).toEqual([2, 1, 0.5]);
      expect(row.field.slice(0, 3), name).toEqual([2, 1, 0.5]);
    }
  }
});
