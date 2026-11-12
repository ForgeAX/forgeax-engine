import { type Model, model, sel, TriangleBvh } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildAssembly } from '../s7-assembly';
import { buildS6c } from '../s6c-assembly';

/**
 * C-100 S6c: the cockpit against the real car-form assembly (the S7 rig's model at u = 0:
 * S5 internals, mech source, joint housings, frames and drives). The margins are small (the
 * seat backrests clear the hip housings by under 1 cm), so any later hip, seat or frame move
 * must fail here instead of silently re-clashing.
 */
function only(src: Model, tag: string): Model {
  const m = model();
  m.append(src.snapshot());
  m.delete(sel.all().minus(sel.tag(tag)));
  return m;
}

/** Smallest distance from any vertex of `a` to the surface of `b`, both ways. */
function clearance(a: Model, b: Model): number {
  const bvh = (m: Model) => {
    const mesh = m.editMesh;
    const p: number[] = [];
    const t: number[] = [];
    for (const f of mesh.faces()) {
      const vs = mesh.faceVertices(f);
      const base = p.length / 3;
      for (const v of vs) p.push(...mesh.position(v));
      for (let k = 1; k + 1 < vs.length; k++) t.push(base, base + k, base + k + 1);
    }
    return new TriangleBvh(p, t);
  };
  const one = (from: Model, to: TriangleBvh) => Math.min(...from.editMesh.vertices().map((v) => Math.sqrt(to.nearest(from.editMesh.position(v))?.distanceSquared ?? Infinity)));
  return Math.min(one(a, bvh(b)), one(b, bvh(a)));
}

describe('C-100 S6c cockpit in the car-form assembly', () => {
  const assembly = buildAssembly('closed').model;
  const cockpit = buildS6c('cockpit').model;
  const box = cockpit.bounds(sel.all());
  if (!box.ok) throw box.error;

  it('crosses no assembly part', { timeout: 600000 }, () => {
    const clashes: string[] = [];
    for (const tag of assembly.inspect().tags.filter((t) => t.startsWith('part:') || t.startsWith('s7:'))) {
      const b = assembly.bounds(sel.tag(tag));
      if (!b.ok || [0, 1, 2].some((c) => (b.value.max[c] as number) < (box.value.min[c] as number) || (b.value.min[c] as number) > (box.value.max[c] as number))) continue;
      const both = model();
      both.append(cockpit.snapshot());
      both.append(only(assembly, tag).snapshot());
      const cross = both.validate().issues.find((i) => i.code === 'self-intersection' && i.severity !== 'info');
      if (cross !== undefined) clashes.push(`${tag}: ${(cross.detail as { total: number }).total}`);
    }
    expect(clashes).toEqual([]);
  });

  it('the seat backrests keep clear of the hip housings', { timeout: 600000 }, () => {
    for (const side of ['l', 'r'] as const) {
      const hip = assembly.inspect().tags.find((t) => t === `part:hw-hip-${side}-mechanism`);
      if (hip === undefined) continue;
      const seat = only(cockpit, `detail:seat-${side === 'l' ? 'r' : 'l'}`);
      const gap = Math.min(clearance(seat, only(assembly, hip)), clearance(only(cockpit, `detail:seat-${side}`), only(assembly, hip)));
      console.log(`seat backrest vs ${hip}: clearance ${(gap * 1000).toFixed(1)} mm`);
      expect(gap).toBeGreaterThan(0.001);
    }
  });
});
