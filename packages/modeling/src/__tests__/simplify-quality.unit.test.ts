import { describe, expect, it } from 'vitest';
import { EDGE_SEAM } from '../mesh';
import { type Model, model } from '../model';

function fineBox(): Model {
  const m = model();
  m.box({ size: [1, 0.4, 2] });
  expect(m.remesh(undefined, { targetEdgeLength: 0.05, iterations: 3 }).status).toBe('ok');
  return m;
}

function quality(m: Model) {
  const r = m.meshQuality();
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

function lastDiagnostics(m: Model): string {
  return JSON.stringify(m.journal[m.journal.length - 1]?.diagnostics);
}

function hubPlates(): Model {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'hub' });
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [-1, 1]) {
      const size: [number, number, number] = [1.1, 1.1, 1.1];
      size[axis] = 0.1;
      const center: [number, number, number] = [0.05, 0.05, 0.05];
      center[axis] = side * 0.55;
      m.box({ size, center, tag: `plate${axis}${side > 0 ? 'p' : 'n'}` });
    }
  }
  return m;
}

function lostOf(m: Model): Record<string, unknown> {
  const d = m.journal[m.journal.length - 1]?.diagnostics?.find((x) =>
    x.message.startsWith('lowpoly'),
  );
  return ((d?.detail ?? {}) as { lost?: Record<string, unknown> }).lost ?? {};
}

describe('isotropic remesh of a hard-edged box (M-B4)', () => {
  it('meets the aspect and min-angle limits on its own', () => {
    const q = quality(fineBox());
    expect(q.aspect.p90).toBeLessThanOrEqual(4);
    expect(q.minAngle.p10).toBeGreaterThanOrEqual(20);
    // The few leftovers sit on the box corners, where the pinned sharp edges leave no flip.
    expect(q.aspect.over6).toBeLessThanOrEqual(0.03);
  });
});

describe('simplify slivers on a hard-edged box (M-B3)', () => {
  it('plain QEM to 200 faces keeps aspect p90 within 4', () => {
    const m = fineBox();
    expect(m.simplify(undefined, { targetFaces: 200 }).status).toBe('ok');
    const q = quality(m);
    expect(q.triangles).toBeLessThanOrEqual(200);
    expect(q.aspect.p90).toBeLessThanOrEqual(4);
    expect(q.aspect.over6).toBeLessThanOrEqual(0.02);
  });

  it('lowpoly to 200 faces keeps aspect p90 within 4', () => {
    const m = fineBox();
    expect(m.lowpoly(undefined, { targetFaces: 200, quads: false }).status).toBe('ok');
    expect(quality(m).aspect.p90).toBeLessThanOrEqual(4);
  });

  it('maxAspect holds and a target it blocks is reported by name', () => {
    const m = fineBox();
    expect(m.simplify(undefined, { targetFaces: 200, maxAspect: 4 }).status).toBe('ok');
    const q = quality(m);
    // maxAspect refuses a collapse that makes a triangle worse than 4; slivers already in the
    // input and not on the collapse path may stay, so the worst one is bounded, not removed.
    expect(q.aspect.p90).toBeLessThanOrEqual(4);
    expect(q.aspect.over6).toBe(0);
    expect(q.aspect.max).toBeLessThanOrEqual(6);
    expect(q.triangles > 200 ? lastDiagnostics(m) : 'maxAspect 4').toContain('maxAspect 4');
  });
});

describe('lowpoly voxel loss report (M-B1a)', () => {
  const VOXEL = { targetFaces: 300, union: { mode: 'voxel' as const, voxelSize: 0.1 } };

  it('does not report a material lost while output faces still carry it', () => {
    const m = hubPlates();
    const mesh = m.editMesh;
    const steel = mesh.nameIndex(mesh.materialNames, 'steel');
    const plate = mesh.tagIndex('plate0p', false);
    for (const f of mesh.faces()) if (mesh.hasTag(f, plate)) mesh.fMaterial[f] = steel;
    expect(m.lowpoly(undefined, VOXEL).status).toBe('ok');
    const out = m.editMesh;
    const carried = out
      .faces()
      .filter((f) => out.fMaterial[f] === out.materialNames.indexOf('steel'));
    expect(carried.length).toBeGreaterThan(0);
    expect((lostOf(m).materials as Record<string, number>).steel ?? 0).toBe(0);
    const bySource = lostOf(m).bySource as Record<string, { materials: number }>;
    expect(bySource.plate0p?.materials ?? 0).toBe(0);
  });

  it('reports the seams the rebuild drops', () => {
    const m = hubPlates();
    const mesh = m.editMesh;
    let seams = 0;
    for (const e of mesh.edges()) {
      if (seams < 4) {
        mesh.eFlags[e] = (mesh.eFlags[e] as number) | EDGE_SEAM;
        seams++;
      }
    }
    expect(m.lowpoly(undefined, VOXEL).status).toBe('ok');
    const out = m.editMesh;
    const kept = out.edges().filter((e) => ((out.eFlags[e] as number) & EDGE_SEAM) !== 0).length;
    expect(lostOf(m).seams).toBe(Math.max(0, seams - kept));
    expect(kept).toBeLessThan(seams);
  });

  it('reports the part roles the rebuild drops', () => {
    const m = hubPlates();
    const mesh = m.editMesh;
    let flagged = 0;
    for (const f of mesh.faces()) {
      if (flagged < 6) {
        mesh.fFlags[f] = (mesh.fFlags[f] as number) | 0b0100;
        flagged++;
      }
    }
    expect(m.lowpoly(undefined, VOXEL).status).toBe('ok');
    expect(lostOf(m).roles).toEqual({ detail: flagged });
  });
});
