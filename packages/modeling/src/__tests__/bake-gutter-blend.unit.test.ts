import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { bakeMaps } from '../bake';
import { model } from '../model';
import { degrees, surfaceOf, texel, texelFrames, type V3 } from './bake-gates';

/**
 * Gutter blend: two disjoint islands, a flat plane and a second plane whose detail rises at
 * about 27 degrees. The gap texels between their islands are gutter; each must keep the
 * tangent normal of its nearest chart texel. Averaging across the gap gave 14 to 43 degree
 * stripes between a flat face and a chamfer on the mobile hero's disc islands.
 */

const RES = 128;
const PRODUCTION_BASE_NORMALS = { mode: 'autoSmooth', angle: 30 } as const;

/** Two flat planes side by side, one island each after uv.auto (padding separates them). */
function twoPlanes(detail: boolean) {
  const m = model();
  m.plane({ width: 0.2, height: 0.2, center: [-0.15, 0, 0] });
  m.plane({ width: 0.2, height: 0.2, center: [0.15, 0, 0] });
  if (detail) {
    for (const v of m.editMesh.vertices()) {
      const [x, y, z] = m.editMesh.position(v);
      if (x > 0) m.editMesh.setPosition(v, x, y, z + 0.5 * (x - 0.05));
    }
  }
  return m;
}

const tangentOf = (t: TextureAsset, x: number, y: number): V3 => {
  const c = texel(t, RES, x, y);
  return [(c[0] as number) * 2 - 1, (c[1] as number) * 2 - 1, (c[2] as number) * 2 - 1];
};

describe('gutter blend: gutter texels between two islands keep one chart normal (invariant)', () => {
  it('every gap texel decodes to the tangent normal of its nearest chart texel within 2 degrees', {
    timeout: 120000,
  }, () => {
    const low = twoPlanes(false);
    expect(low.uv.auto({ resolution: RES, padding: 6 }).status).toBe('ok');
    const r = bakeMaps({
      base: low,
      detail: twoPlanes(true),
      maps: ['normal'],
      resolution: RES,
      normals: PRODUCTION_BASE_NORMALS,
      gutter: 'fill',
      filter: 'none',
    });
    if (!r.ok) throw r.error;
    const tex = r.value.textures.normal as TextureAsset;
    const surf = surfaceOf(low, PRODUCTION_BASE_NORMALS);
    const charts = texelFrames(surf, RES).map((f) => ({ x: f.x, y: f.y }));
    const covered = new Set(charts.map((c) => `${c.x},${c.y}`));
    expect(charts.length).toBeGreaterThan(1000);
    let gap = 0;
    let worst = 0;
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        if (covered.has(`${x},${y}`)) continue;
        let nearest = charts[0] as { x: number; y: number };
        let d2 = Number.POSITIVE_INFINITY;
        for (const c of charts) {
          const e = (c.x - x) ** 2 + (c.y - y) ** 2;
          if (e < d2) {
            d2 = e;
            nearest = c;
          }
        }
        gap++;
        worst = Math.max(
          worst,
          degrees(tangentOf(tex, x, y), tangentOf(tex, nearest.x, nearest.y)),
        );
      }
    }
    expect(gap).toBeGreaterThan(200);
    expect(worst).toBeLessThan(2);
  });
});
