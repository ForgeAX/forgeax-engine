import { expect, it } from 'vitest';
import { IrradianceFieldRayStatus } from '../../raytracing/irradiance-field';
import { ScreenProbeRayStatus } from '../../raytracing/screen-probe-plan';
import { runCardUnknownSupport } from './card-unknown-support.fixture';

it('retains known backface and rejects unexpected finite Card producer tags', async () => {
  // WGSL permits finite-math assumptions. Nonfinite fault injection is a
  // separate diagnostic, not a portable consumer contract or CI requirement.
  const bits = [0x40000000, 0x40400000, 0xc0000000];
  const result = await runCardUnknownSupport(bits);
  expect(result.errors).toEqual([]);
  expect(result.authoredTriangleNearest).toBeCloseTo(2, 4);
  expect(result.rows).toHaveLength(bits.length);
  for (const [index, row] of result.rows.entries()) {
    expect(row.world[0], row.mode).toBe(1);
    expect(row.worldTagBits, row.mode).toBe(bits[index]);
    expect(row.screen.rgb, row.mode).toEqual([0, 0, 0]);
    expect(row.field.slice(0, 3), row.mode).toEqual([0, 0, 0]);
    if (index === 0) {
      expect(row.world[2]).toBe(2);
      expect(row.screen.state).toBe(ScreenProbeRayStatus.resolved);
      expect(row.field[7]).toBe(IrradianceFieldRayStatus.backface);
    } else {
      expect(row.screen.state, row.mode).toBe(ScreenProbeRayStatus.fallback);
      expect(row.field[7], row.mode).toBe(IrradianceFieldRayStatus.unlit);
    }
  }
});
