import { describe, expect, it } from 'vitest';
import { bakeMaps } from '../bake';
import { model } from '../model';

/**
 * Mip bleed owners: one UV chart that the base crease angle splits into frame islands is still one
 * chart. The gutter beside it is filled from its frames and bleeds into no mip block. Owning the
 * frames instead marked those gutter texels MIXED and counted them as bleed (224/184/131 blocks at
 * levels 1 to 3 on the mobile hero), though the padding around the chart held.
 */
describe('mip bleed owner: frames of one UV chart are one chart (gate)', () => {
  it('an eight-sided cylinder split into frames by its 30 degree crease bleeds into no mip block', {
    timeout: 120000,
  }, () => {
    const m = model();
    m.cylinder({ radiusTop: 0.1, radiusBottom: 0.1, height: 0.2, radialSegments: 8 });
    expect(m.uv.auto({ resolution: 1024, padding: { mips: 3 } }).status).toBe('ok');
    const r = bakeMaps({
      base: m,
      detail: m,
      maps: ['normal'],
      resolution: 1024,
      normals: { mode: 'autoSmooth', angle: 30 },
    });
    if (!r.ok) throw r.error;
    expect(r.value.provenance.bleed.slice(0, 3)).toEqual([0, 0, 0]);
    expect(r.value.issues.filter((i) => i.code === 'mip-bleed')).toEqual([]);
  });
});
