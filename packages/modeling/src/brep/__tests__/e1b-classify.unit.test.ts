import { describe, expect, it } from 'vitest';
import { box, cylinder } from '../build';
import { curvePoint } from '../curves';
import { branchPCurvePoint, intersectSurfaces } from '../intersect';
import { classifyOnFace, faceTrim } from '../trim-face';
import type { P3 } from '../vec';

/** Top face of the box (plane z = 0.5, x in [-1.3, 1.3], y in [-0.5, 0.5]) and the cylinder side (r = 1, z in [-2, 2]). */
function solids() {
  const boxR = box({ size: [2.6, 1, 1] });
  const cylR = cylinder({ radius: 1, height: 4 });
  if (!boxR.ok || !cylR.ok) throw new Error('build failed');
  const top = boxR.value;
  const side = cylR.value;
  const topFace = top.faces.findIndex((f) => {
    const s = top.surfaces[f.surface];
    return s?.kind === 'plane' && Math.abs(s.frame.o[2] - 0.5) < 1e-9;
  });
  const sideFace = side.faces.findIndex((f) => side.surfaces[f.surface]?.kind === 'cylinder');
  return { top, side, topFace, sideFace };
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}

describe('E1b classifier on built solids', () => {
  it('classifies the cylinder/box-top intersection arc against the box top face', () => {
    const { top, side, topFace, sideFace } = solids();
    expect(topFace).toBeGreaterThanOrEqual(0);
    expect(sideFace).toBeGreaterThanOrEqual(0);
    const cylSurface = must(side.surfaces[must(side.faces[sideFace]).surface]);
    const planeSurface = must(top.surfaces[must(top.faces[topFace]).surface]);
    const r = intersectSurfaces(cylSurface, planeSurface, top.tol);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.partials).toEqual([]);
    expect(r.value.branches).toHaveLength(1);
    const branch = must(r.value.branches[0]);
    const trim = faceTrim(top, topFace);
    let checked = 0;
    for (let i = 1; i < 400; i++) {
      const t = branch.t0 + ((branch.t1 - branch.t0) * i) / 400;
      const p = curvePoint(branch.curve, t);
      const y = p[1];
      if (Math.abs(Math.abs(y) - 0.5) < 1e-3) continue;
      const uv = branchPCurvePoint(branch.onB, t);
      const want = Math.abs(y) < 0.5 ? 'in' : 'out';
      expect(classifyOnFace(trim, p, uv), `t=${t} y=${y}`).toBe(want);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('classifies the exact boundary crossings of the arc as on', () => {
    const { top, side, topFace, sideFace } = solids();
    const cylSurface = must(side.surfaces[must(side.faces[sideFace]).surface]);
    const planeSurface = must(top.surfaces[must(top.faces[topFace]).surface]);
    const r = intersectSurfaces(cylSurface, planeSurface, top.tol);
    if (!r.ok) throw new Error('intersect failed');
    const branch = must(r.value.branches[0]);
    const trim = faceTrim(top, topFace);
    const ts = [Math.asin(0.5), Math.PI - Math.asin(0.5)];
    for (const t0 of ts) {
      const t = branch.t0 + (branch.t1 - branch.t0) * 0 + t0;
      const p = curvePoint(branch.curve, t);
      expect(Math.abs(Math.abs(p[1]) - 0.5)).toBeLessThan(1e-9);
      const uv = branchPCurvePoint(branch.onB, t);
      expect(classifyOnFace(trim, p, uv)).toBe('on');
    }
  });

  it('classifies points on the cylinder side: inside the height range is in, beyond it out, on the rim is on', () => {
    const { side, sideFace } = solids();
    const trim = faceTrim(side, sideFace);
    const at = (z: number): P3 => [1, 0, z];
    expect(classifyOnFace(trim, at(1))).toBe('in');
    expect(classifyOnFace(trim, at(2.5))).toBe('out');
    expect(classifyOnFace(trim, at(2))).toBe('on');
  });
});
