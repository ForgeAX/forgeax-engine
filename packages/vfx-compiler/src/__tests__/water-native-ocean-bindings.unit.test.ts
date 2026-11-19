import { describe, expect, it } from 'vitest';
import { reflectVfxLayout } from '../reflection.js';

describe('combined Water and native Ocean data interfaces', () => {
  it('reserves separate slots for both producers and external event output', () => {
    const result = reflectVfxLayout({
      root: '#import forgeax_vfx::data::{water_surface,water_displacement,water_hull,water_config,gpu_events}',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const requirements = result.value.dataInterfaces;
    if (!requirements) throw new Error('Expected reflected Water and Ocean interfaces');
    expect(requirements.map((row) => [row.kind, row.binding])).toEqual([
      ['gpu-events', 25],
      ['water-displacement', 22],
      ['water-hull', 23],
      ['water-config', 24],
      ['water-surface', 18],
    ]);
    const slots = requirements.flatMap((row) => [
      row.binding,
      ...(row.solverNormalBinding === undefined ? [] : [row.solverNormalBinding]),
      ...(row.domainBinding === undefined ? [] : [row.domainBinding]),
    ]);
    expect(new Set(slots).size).toBe(slots.length);
    expect(slots).not.toContain(21);
  });
});
