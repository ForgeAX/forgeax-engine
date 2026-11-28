import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { bakeMaps } from '../bake';
import { model } from '../model';
import { paddingTexels } from '../uv';
import { degrees, surfaceOf, texel, texelFrames, type V3 } from './bake-gates';

/**
 * Gutter reach: the fill of an empty atlas is bounded by the padding the packer reserved around
 * charts. The default `gutter: 'fill'` copies each chart's detail normal across every empty texel
 * of the atlas; on the mobile hero's disc islands that copy is what painted the 30 to 48 degree
 * stripes (96 percent of the tilted texels in the disc windows were empty atlas, not rasterized
 * chart texels). Texels farther than the reserved padding are never sampled, so they stay flat.
 */

const RES = 128;
const PRODUCTION_BASE_NORMALS = { mode: 'autoSmooth', angle: 30 } as const;
/** The gutter the atlas reserves at `{ mips: 3 }`; deliver passes this value to the detail bake. */
const RESERVED_GUTTER = paddingTexels({ mips: 3 });

/** Two flat planes; the second rises about 27 degrees, so its chart tilts and the fill copies it. */
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

/** Largest tilt from the flat tangent normal over empty texels at least `reach` texels from a chart. */
function farTilt(gutter: number | 'fill'): { worst: number; far: number } {
  const low = twoPlanes(false);
  expect(low.uv.auto({ resolution: RES, padding: 6 }).status).toBe('ok');
  const r = bakeMaps({
    base: low,
    detail: twoPlanes(true),
    maps: ['normal'],
    resolution: RES,
    normals: PRODUCTION_BASE_NORMALS,
    gutter,
    filter: 'none',
  });
  if (!r.ok) throw r.error;
  const tex = r.value.textures.normal as TextureAsset;
  const charts = texelFrames(surfaceOf(low, PRODUCTION_BASE_NORMALS), RES).map((f) => ({
    x: f.x,
    y: f.y,
  }));
  const covered = new Set(charts.map((c) => `${c.x},${c.y}`));
  let far = 0;
  let worst = 0;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      if (covered.has(`${x},${y}`)) continue;
      // The fill grows one 8-neighbour ring per pass, so its reach is the Chebyshev distance.
      let reach = Number.POSITIVE_INFINITY;
      for (const c of charts)
        reach = Math.min(reach, Math.max(Math.abs(c.x - x), Math.abs(c.y - y)));
      if (reach <= RESERVED_GUTTER) continue;
      far++;
      worst = Math.max(worst, degrees(tangentOf(tex, x, y), [0, 0, 1]));
    }
  }
  return { worst, far };
}

describe('gutter reach: an empty atlas stays flat beyond the reserved padding (gate)', () => {
  it('texels beyond the atlas padding keep the flat normal when the bake fills to that padding', {
    timeout: 120000,
  }, () => {
    const { worst, far } = farTilt(RESERVED_GUTTER);
    expect(far).toBeGreaterThan(200);
    expect(worst).toBeLessThan(2);
  });

  it('falsifier: the unbounded fill copies the chamfer tilt into those far texels', {
    timeout: 120000,
  }, () => {
    const { worst, far } = farTilt('fill');
    expect(far).toBeGreaterThan(200);
    expect(worst).toBeGreaterThan(10);
  });
});
