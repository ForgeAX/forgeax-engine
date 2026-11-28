import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { bakeMaps } from '../bake';
import { model } from '../model';
import { applyTbn, cross3, degrees, norm, surfaceOf, texel, texelFrames } from './bake-gates';

/**
 * Crease invariant: a hard-faced detail baked onto the same smooth low-poly. Each covered texel,
 * decoded through its base frame, must reproduce the normal of the low-poly face it covers, with
 * the production base normals (split at 30 degrees). The fixture is one planar UV island folded
 * at about 44 degrees along x = 0.
 */

const RES = 128;
const SLOPE = 0.4;
const PRODUCTION_BASE_NORMALS = { mode: 'autoSmooth', angle: 30 } as const;

function kinked() {
  const m = model();
  m.plane({ width: 0.2, height: 0.2, widthSegments: 2, heightSegments: 1 });
  for (const v of m.editMesh.vertices()) {
    const [x, y, z] = m.editMesh.position(v);
    m.editMesh.setPosition(v, x, y, z + SLOPE * Math.abs(x));
  }
  return m;
}

function planarUv(m: ReturnType<typeof kinked>) {
  const mesh = m.editMesh;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const [x, y] = mesh.position(mesh.hVert[h] as number);
      mesh.setCorner('uv0', h, [x / 0.2 + 0.5, y / 0.2 + 0.5]);
    }
  }
}

describe('crease frame: hard detail on a smooth low-poly (invariant)', () => {
  it('each covered texel decodes to its low-poly face normal within 2 degrees with production base normals', {
    timeout: 120000,
  }, () => {
    const low = kinked();
    planarUv(low);
    const r = bakeMaps({
      base: low,
      detail: kinked(),
      maps: ['normal'],
      resolution: RES,
      normals: PRODUCTION_BASE_NORMALS,
      filter: 'none',
    });
    if (!r.ok) throw r.error;
    const tex = r.value.textures.normal as TextureAsset;
    const surf = surfaceOf(low, PRODUCTION_BASE_NORMALS);
    const faceNormal = (t: number) => {
      const at = (corner: number) => {
        const i = surf.indices[t * 3 + corner] as number;
        return [0, 1, 2].map((k) => surf.position[i * 3 + k] as number);
      };
      const [pa, pb, pc] = [at(0), at(1), at(2)] as const;
      return norm(
        cross3(
          pb.map((v, k) => v - (pa[k] as number)),
          pc.map((v, k) => v - (pa[k] as number)),
        ),
      );
    };
    const errors = texelFrames(surf, RES).map((f) =>
      degrees(applyTbn(texel(tex, RES, f.x, f.y), f.n, f.t, f.w), faceNormal(f.triangle)),
    );
    expect(errors.length).toBeGreaterThan(1000);
    expect(Math.max(...errors)).toBeLessThan(2);
  });
});
