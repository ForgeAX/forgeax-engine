import { describe, expect, it } from 'vitest';
import { bakeMaps } from '../bake';
import { model } from '../model';
import { sel } from '../selectors';
import { applyTbn, degrees, norm, surfaceOf, texel, texelFrames, type V3 } from './bake-gates';

/**
 * Audit B20 A4: a welded mirror line (uv.auto, then m.mirror) shares its seam vertices
 * between two shells of opposite uv0 handedness. One tangent frame per vertex let w
 * interpolate through 0 in the seam triangles (14.7 deg); export now splits render
 * vertices on handedness, as MikkTSpace does.
 */

const SEGS = 32;
const RES = 128;
const A = 0.01;
const K = 2 * Math.PI * 3;
const N = 200;

/** Heightfield z = A cos(K x) as N x 4 planar quads over [-0.5, 0.5]^2, with its facet normals. */
function ripple() {
  const m = model();
  const mesh = m.editMesh;
  const xs = Array.from({ length: N + 1 }, (_, i) => -0.5 + i / N);
  const h = xs.map((x) => A * Math.cos(K * x));
  const rows = 4;
  const ids: number[][] = [];
  for (let j = 0; j <= rows; j++)
    ids.push(xs.map((x, i) => mesh.addVertex(x, -0.5 + j / rows, h[i] as number)));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < N; i++) {
      const row = ids[j] as number[];
      const next = ids[j + 1] as number[];
      const face = mesh.addFace([
        row[i] as number,
        row[i + 1] as number,
        next[i + 1] as number,
        next[i] as number,
      ]);
      if (!face.ok) throw face.error;
    }
  }
  const normalAt = (x: number): V3 => {
    const i = Math.min(N - 1, Math.max(0, Math.floor((x + 0.5) * N)));
    return norm([-((h[i + 1] as number) - (h[i] as number)) * N, 0, 1]);
  };
  return { detail: m, normalAt };
}

function mirroredBase() {
  const base = model();
  base.plane({ width: 0.5, height: 1, widthSegments: SEGS, heightSegments: SEGS * 2 });
  const xs = base.editMesh.vertices().map((v) => base.editMesh.position(v)[0] as number);
  base.translate(sel.all(), [-0.25 - (Math.min(...xs) + Math.max(...xs)) / 2, 0, 0]);
  expect(base.uv.auto({ resolution: RES, padding: 4 }).status).toBe('ok');
  expect(base.mirror({ axis: 'x', weldDistance: 1e-6 }).status).toBe('ok');
  return base;
}

describe('welded mirror seams keep one tangent frame per side', () => {
  it('gives every render triangle one tangent handedness', () => {
    const s = surfaceOf(mirroredBase());
    let mixed = 0;
    for (let t = 0; t < s.indices.length / 3; t++) {
      const w = [0, 1, 2].map((k) => s.tangent[(s.indices[t * 3 + k] as number) * 4 + 3]);
      if (w[0] !== w[1] || w[1] !== w[2]) mixed++;
    }
    expect(mixed).toBe(0);
  });

  it('bakes the seam band of both shells within 0.5 deg of the facet normals', () => {
    const base = mirroredBase();
    const { detail, normalAt } = ripple();
    const surface = surfaceOf(base);
    const r = bakeMaps({
      base,
      detail,
      maps: ['normal'],
      resolution: RES,
      cage: { offset: 0.03, maxRay: 0.06 },
      filter: 'none',
      detailNormals: { mode: 'flat' },
    });
    if (!r.ok) throw r.error;
    const normal = r.value.textures.normal;
    if (normal === undefined) throw new Error('no normal map');
    // Both shells share one uv space, so each side is rasterized on its own.
    for (const side of [-1, 1]) {
      const own: number[] = [];
      for (let t = 0; t < surface.indices.length / 3; t++) {
        const corners = [0, 1, 2].map((k) => surface.indices[t * 3 + k] as number);
        const x = corners.reduce((sum, i) => sum + (surface.position[i * 3] as number), 0);
        if (Math.sign(x) === side) own.push(...corners);
      }
      let band = 0;
      let worst = 0;
      for (const f of texelFrames({ ...surface, indices: Uint32Array.from(own) }, RES)) {
        if (Math.abs(f.p[0]) >= 0.5 / SEGS) continue;
        band++;
        const decoded = applyTbn(texel(normal, RES, f.x, f.y), f.n, f.t, f.w);
        worst = Math.max(worst, degrees(decoded, normalAt(f.p[0])));
      }
      expect(band).toBeGreaterThan(200);
      // Measured: 0.28 deg per side (8-bit); 14.7 deg on the mirrored side before the split.
      expect(worst).toBeLessThanOrEqual(0.5);
    }
  });
});
