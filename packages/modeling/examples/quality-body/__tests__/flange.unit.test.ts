import { type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildRight } from '../body';

const FLANGE = { reach: 0.015, depth: 0.005 } as const;

/** Edge-adjacent faces folded onto each other across a smooth edge (validate does not flag them). */
function folds(m: Model): number {
  const mesh = m.editMesh;
  type V = readonly [number, number, number];
  const normal = (f: number): V => {
    const p = mesh.faceVertices(f).map((v) => mesh.position(v) as V);
    let [x, y, z] = [0, 0, 0];
    for (const [i, [ax, ay, az]] of p.entries()) {
      const [bx, by, bz] = p[(i + 1) % p.length] as V;
      x += (ay - by) * (az + bz);
      y += (az - bz) * (ax + bx);
      z += (ax - bx) * (ay + by);
    }
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  let count = 0;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      if (g < 0 || g < f || (mesh.eFlags[h >> 1] as number) !== 0) continue;
      const [a, b] = [normal(f), normal(g)];
      if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < -0.5) count++;
    }
  }
  return count;
}

describe('C-114 body panels take a return flange', () => {
  it('flanges the door and the openings clean, closed and unfolded', {
    timeout: 60_000,
  }, () => {
    // The waist blend is a 77 um band on its near-tangent crease, narrower than snap over its
    // whole length: it closes into the fender-door seam, so the door's flange ends on that
    // seam and builds closed and unfolded.
    const door = buildRight(undefined, { openings: true });
    const built = door.shell(sel.all(), {
      thickness: 0.0015,
      flange: { ...FLANGE, at: sel.tag('door') },
    });
    expect(built.status).toBe('ok');
    expect(door.validate().closed).toBe(true);
    expect(folds(door)).toBe(0);
    // The openings' rings (`trim` and `support`): the cells along the blends' seams are `trim`
    // too, and the band's ends there are narrower than the thickness.
    for (const at of [sel.tag('trim').and(sel.tag('support'))]) {
      const tag = 'trim';
      const m = buildRight(undefined, { openings: true });
      const op = m.shell(sel.all(), { thickness: 0.0015, flange: { ...FLANGE, at } });
      expect(op.status, tag).toBe('ok');
      const v = m.validate();
      expect(v.closed, tag).toBe(true);
      expect(v.issues.filter((i) => i.code !== 'uv-missing'), tag).toEqual([]);
      expect(folds(m), tag).toBe(0);
    }
  });

  it('refuses a hood flange whose end meets a rim bending back over it, and builds it ended short', { timeout: 60_000 }, () => {
    const whole = buildRight(undefined, { openings: true });
    const refused = whole.shell(sel.all(), {
      thickness: 0.0015,
      flange: { ...FLANGE, at: sel.tag('hood') },
    });
    expect(refused.error?.code).toBe('model-precondition');
    expect(refused.error?.expected).toBe('every flange end turns away from the plain rim it meets');
    const m = buildRight(undefined, { openings: true });
    const box = m.bounds(sel.tag('hood'));
    if (!box.ok) throw box.error;
    const [x0, x1] = [box.value.min[0] + 0.02, box.value.max[0] - 0.02];
    const at = sel.tag('hood').and(sel.inBox([x0, -10, -10], [x1, 10, 10], { by: 'centroid' }));
    expect(m.shell(sel.all(), { thickness: 0.0015, flange: { ...FLANGE, at } }).status).toBe('ok');
    const v = m.validate();
    expect(v.closed).toBe(true);
    expect(v.issues.filter((i) => i.code !== 'uv-missing')).toEqual([]);
    expect(folds(m)).toBe(0);
  });
});
