import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import type { EditMesh } from '../mesh';
import { model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';

const samples = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

/** A patch over x in [x0, x1], y in [0, h]: flat, or a bump in z that is flat at x0. */
function patch(x0: number, x1: number, h: number, z: number, bump = 0): NurbsSurface {
  const grid = samples(6).map((a) =>
    samples(6).map((b): Tuple3 => [x0 + a * (x1 - x0), b * h, z + bump * Math.sin(Math.PI * a)]),
  );
  const s = nurbs.grid(grid);
  if (!s.ok) throw s.error;
  return s.value;
}

/** Open edges on the plane x = `x`. */
function openAt(mesh: EditMesh, x: number): number {
  return mesh
    .edges()
    .filter((e) => mesh.isBoundaryEdge(e))
    .filter((e) => mesh.edgeVertices(e).every((v) => Math.abs(mesh.position(v)[0] - x) < 1e-4))
    .length;
}

/** A flat panel and a bumped one sharing the side x = 0.4, the bumped one `dz` above it. */
function pair(dz: number, h = 0.4) {
  return [
    { name: 'left', surface: patch(0, 0.4, h, 0) },
    { name: 'right', surface: patch(0.4, 0.8, h, dz, 0.1) },
  ];
}

describe('surface seams', () => {
  it('finds a shared side without a layout, samples it once and welds it by identity', () => {
    const m = model();
    const report = m.surface({ patches: pair(0), chord: 0.0005 });
    expect(report.status).toBe('ok');
    expect(openAt(m.editMesh, 0.4)).toBe(0);
    expect(m.validate().issues.filter((i) => i.code === 't-junction')).toEqual([]);
    const info = report.diagnostics?.find((d) => d.detail?.seams !== undefined);
    expect(info?.detail?.seams).toEqual([
      { a: 'left', sideA: 'u1', b: 'right', sideB: 'u0', gap: expect.any(Number), weldMove: 0 },
    ]);
    const seam = m.diagnostics().surfaces.find((s) => s.name === 'left')?.seams?.[0];
    expect(seam?.gap).toBeLessThan(1e-12);
    // The flat panel needs one segment along y; it takes the bumped panel's isoparms there.
    const onSeam = new Set(
      m.editMesh
        .vertices()
        .filter((v) => Math.abs(m.editMesh.position(v)[0] - 0.4) < 1e-12)
        .map((v) => m.editMesh.position(v)[1].toFixed(9)),
    );
    expect(onSeam.size).toBeGreaterThan(2);
  });

  it('names the mirrored seam after the mirrored patches', () => {
    const m = model();
    expect(m.surface({ patches: pair(0), chord: 0.0005 }).status).toBe('ok');
    expect(m.mirror({ axis: 'y' }).status).toBe('ok');
    const seams = m
      .diagnostics()
      .surfaces.flatMap((s) => (s.seams ?? []).map((x) => `${s.name}:${x.a}|${x.b}`));
    expect(seams).toEqual(['left:left|right', 'left.mirror:left.mirror|right.mirror']);
  });

  it('sews a tolerant seam (gap within twice the model tolerance) with a warning naming it', () => {
    const m = model();
    const report = m.surface({ patches: pair(15e-6), chord: 0.0005 });
    expect(report.status).toBe('ok');
    expect(openAt(m.editMesh, 0.4)).toBe(0);
    const warn = report.diagnostics?.find((d) => d.message.includes('tolerant'));
    expect(warn?.detail).toMatchObject({ seam: 'left:u1|right:u0' });
    expect(warn?.detail?.gap as number).toBeCloseTo(15e-6, 9);
  });

  it('fails a seam whose gap exceeds the sew tolerance, unless sew covers it', () => {
    const open = model();
    open.surface({ patches: pair(50e-6), chord: 0.0005 });
    expect(open.poisoned?.code).toBe('model-precondition');
    const failing = open.poisoned?.detail?.seams as { seam: string; gap: number; at: Tuple3 }[];
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ seam: 'left:u1|right:u0', limit: 2e-5 });
    expect(failing[0]?.gap as number).toBeCloseTo(50e-6, 9);
    expect(failing[0]?.at[0]).toBeCloseTo(0.4, 9);

    const sewn = model();
    const report = sewn.surface({ patches: pair(50e-6), chord: 0.0005, sew: 1e-4 });
    expect(report.status).toBe('ok');
    expect(openAt(sewn.editMesh, 0.4)).toBe(0);
    expect(report.diagnostics?.some((d) => d.message.includes('left:u1|right:u0'))).toBe(true);
    const seam = sewn.diagnostics().surfaces.find((s) => s.name === 'left')?.seams?.[0];
    expect(seam?.gap as number).toBeCloseTo(50e-6, 9);
  });

  it('caps sew at a tenth of the seam length', () => {
    // A 0.4 mm seam: sew 0.1 mm is capped at 40 um, below the 50 um gap.
    const m = model();
    m.surface({ patches: pair(50e-6, 0.0004), chord: 0.0004, sew: 1e-4 });
    expect(m.poisoned?.code).toBe('model-precondition');
    const failing = m.poisoned?.detail?.seams as { limit: number }[];
    expect(failing[0]?.limit as number).toBeCloseTo(4e-5, 9);
  });

  it('lists every failing seam in one error', () => {
    const m = model();
    m.surface({
      patches: [...pair(50e-6), { name: 'far', surface: patch(0.8, 1.2, 0.4, 80e-6) }],
      chord: 0.0005,
    });
    const failing = m.poisoned?.detail?.seams as { seam: string; gap: number }[];
    expect(failing.map((f) => f.seam)).toEqual(['left:u1|right:u0', 'right:u1|far:u0']);
    expect(failing[1]?.gap as number).toBeCloseTo(30e-6, 9);
  });

  it('keeps two seams apart that pass within snap of each other mid-span', () => {
    // A 0.1 mm strip between two panels: its two seams lie closer than snap (0.125 mm).
    const m = model();
    const report = m.surface({
      patches: [
        { name: 'left', surface: patch(0, 0.4, 0.4, 0) },
        { name: 'strip', surface: patch(0.4, 0.4001, 0.4, 0) },
        { name: 'right', surface: patch(0.4001, 0.8, 0.4, 0, 0.1) },
      ],
      chord: 0.0005,
    });
    expect(report.status).toBe('ok');
    const mesh = m.editMesh;
    const at = (x: number) =>
      mesh
        .vertices()
        .map((v) => mesh.position(v))
        .filter((p) => Math.abs(p[0] - x) < 1e-9 && p[1] > 0.01 && p[1] < 0.39);
    expect(at(0.4).length).toBeGreaterThan(2);
    expect(at(0.4001).length).toBe(at(0.4).length);
    expect(openAt(mesh, 0.4) + openAt(mesh, 0.4001)).toBe(0);
    // Only the strip's ends, where both seams end, close to tolerant vertices.
    const ends = report.diagnostics?.filter((d) => d.message.includes('tolerant vertex')) ?? [];
    expect(ends.length).toBe(2);
    expect(ends.every((d) => Math.abs((d.detail?.move as number) - 1e-4) < 1e-9)).toBe(true);
  });

  it('rejects a sew that is not a positive finite number', () => {
    const m = model();
    m.surface({ patches: pair(0), sew: -1 });
    expect(m.poisoned?.code).toBe('model-invalid-argument');
  });
});
