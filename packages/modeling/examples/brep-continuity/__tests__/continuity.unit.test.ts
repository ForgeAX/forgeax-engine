import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { box, cone, cylinder, sphere, torus } from '../../../src/brep/build.ts';
import {
  type Continuity,
  type ContinuityReport,
  measureContinuity,
} from '../../../src/brep/continuity.ts';
import type { Shape } from '../../../src/brep/types.ts';
import { must } from '../../brep-heal/damage.ts';
import { buildPlate } from '../../brep-heal/parts.ts';
import {
  allCases,
  filletedBox,
  housingAssembly,
  pipeElbowShape,
  splitMiddle,
  tiltPlane,
  translateFace,
} from '../cases.ts';
import { continuityLines, GRADE_COLOR, renderContinuity } from '../render.ts';

function report(shape: Shape, options = {}): ContinuityReport {
  return must(measureContinuity(shape, options));
}

/** Edge counts per grade, seams excluded. */
function counts(r: ContinuityReport): Record<Continuity, number> {
  const out: Record<Continuity, number> = { open: 0, G0: 0, G1: 0, G2: 0 };
  for (const e of r.edges) if (!e.seam) out[e.grade]++;
  return out;
}

const RADIUS = 1.5;

describe('measureContinuity: closed-form expectations', () => {
  it('a box has twelve creases of exactly a right angle and no gap', () => {
    const r = report(must(box({ size: [4, 5, 6] })));
    expect(counts(r)).toEqual({ open: 0, G0: 12, G1: 0, G2: 0 });
    for (const e of r.edges) {
      expect(e.angle).toBeCloseTo(Math.PI / 2, 9);
      expect(e.gap).toBeLessThan(1e-9);
    }
  });

  it('a filleted box joins flat to round at G1 with a cross-edge curvature jump of 1 / radius', () => {
    const r = report(filletedBox());
    expect(counts(r)).toEqual({ open: 0, G0: 0, G1: 48, G2: 0 });
    for (const e of r.edges) {
      expect(e.angle).toBeLessThan(1e-9);
      expect(e.curvatureJump).toBeCloseTo(1 / RADIUS, 4);
    }
    // the eight sphere poles are degenerate edges, not comparable pairs
    expect(r.skipped.map((s) => s.reason)).toEqual(new Array(8).fill('degenerate'));
  });

  it('cutting a fillet band in half gives G2 edges and leaves every original join at G1', () => {
    const r = report(splitMiddle(filletedBox(), 'cylinder', 'v'));
    expect(counts(r)).toEqual({ open: 0, G0: 0, G1: 72, G2: 12 });
    for (const e of r.edges.filter((x) => x.grade === 'G2')) {
      expect(e.curvatureJump).toBeLessThan(1e-6);
      expect(e.angle).toBeLessThan(1e-9);
    }
  });

  it('a pipe elbow is tangent where legs meet the bend, with jumps 1 / (R - r) for each wall', () => {
    const r = report(pipeElbowShape());
    expect(counts(r)).toEqual({ open: 0, G0: 4, G1: 4, G2: 0 });
    const jumps = r.edges
      .filter((e) => e.grade === 'G1')
      .map((e) => e.curvatureJump as number)
      .sort((a, b) => a - b);
    // outer wall r = 3, bore r = 2, bend radius 12; the inner side of the bend is the extreme sample
    expect(jumps[0]).toBeCloseTo(1 / 10, 3);
    expect(jumps[1]).toBeCloseTo(1 / 10, 3);
    expect(jumps[2]).toBeCloseTo(1 / 9, 3);
    expect(jumps[3]).toBeCloseTo(1 / 9, 3);
    for (const e of r.edges.filter((x) => x.grade === 'G0')) {
      expect(e.angle).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it('the torus-side curvature at every elbow sample matches the surface-of-revolution formula, signed by the wall normal', () => {
    // bend about the z axis through the origin, centreline radius 12, outer tube 3 (normal out), bore 2 (normal into the bore)
    const elbow = pipeElbowShape();
    const r = report(elbow);
    let checked = 0;
    for (const e of r.edges.filter((x) => x.grade === 'G1')) {
      const side = e.faces.findIndex(
        (f) => elbow.surfaces[(elbow.faces[f] as { surface: number }).surface]?.kind === 'torus',
      );
      for (const s of e.samples) {
        const [px, py, pz] = s.point;
        const rho = Math.sqrt(px * px + py * py);
        const cx = (12 * px) / rho;
        const cy = (12 * py) / rho;
        const tube = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2 + pz * pz);
        const wall = tube > 2.5 ? 1 : -1;
        const nx = (wall * (px - cx)) / tube;
        const ny = (wall * (py - cy)) / tube;
        const expected = (nx * px + ny * py) / rho / rho;
        expect((s.curvature as readonly number[])[side]).toBeCloseTo(expected, 4);
        checked++;
      }
    }
    expect(checked).toBe(4 * 9);
  });

  it('cutting the elbow bend and legs in half adds G2 edges only', () => {
    const r = report(pipeElbowShape());
    const cut = report(splitMiddle(splitMiddle(pipeElbowShape(), 'torus', 'u'), 'cylinder', 'v'));
    expect(counts(cut)).toEqual({ ...counts(r), G2: 6 });
  });

  it('periodic seams of closed surfaces are G2 and flagged as seams', () => {
    for (const s of [
      must(cylinder({ radius: 3, height: 7 })),
      must(cone({ radius: 3, height: 6 })),
      must(sphere({ radius: 3 })),
      must(torus({ major: 5, minor: 1.5 })),
    ]) {
      const r = report(s);
      const seams = r.edges.filter((e) => e.seam);
      expect(seams.length).toBeGreaterThan(0);
      for (const e of seams) expect(e.grade).toBe('G2');
    }
  });

  it('coplanar neighbouring faces are G2 and creases are not', () => {
    const r = report(buildPlate());
    const g2 = r.edges.filter((e) => e.grade === 'G2');
    expect(g2.length).toBe(2);
    expect(r.counts.G0).toBe(136);
    for (const e of g2) expect(e.angle).toBeLessThan(1e-12);
  });
});

describe('measureContinuity: damaged joins', () => {
  const base = filletedBox();
  const top = base.faces.findIndex((f) => f.label === 'filleted-box.p2+');

  it('a tilted top face opens its three other joins and creases the pivot join', () => {
    const r = report(tiltPlane(base, top, [0, 2.5, 3], 0.04));
    expect(counts(r)).toEqual({ open: 3, G0: 1, G1: 44, G2: 0 });
    const crease = r.edges.find((e) => e.grade === 'G0');
    expect(crease?.angle).toBeCloseTo(0.04, 6);
    expect(crease?.gap).toBeLessThan(1e-9);
    for (const e of r.edges.filter((x) => x.grade === 'open')) expect(e.gap).toBeGreaterThan(1e-3);
  });

  it('a moved corner sphere opens exactly its three joins by about the move', () => {
    const corner = base.faces.findIndex((f) => f.label === 'filleted-box.c111');
    const r = report(translateFace(base, corner, [0.05, 0.05, 0.05]));
    expect(counts(r)).toEqual({ open: 3, G0: 0, G1: 45, G2: 0 });
    for (const e of r.edges.filter((x) => x.grade === 'open')) {
      expect(e.gap).toBeGreaterThan(0.04);
      expect(e.gap).toBeLessThan(0.09);
    }
  });

  it('a tiny kink is still a crease at the default angle tolerance, and G1 when the tolerance is raised', () => {
    const kinked = tiltPlane(base, top, [0, 2.5, 3], 0.04);
    expect(counts(report(kinked, { gapTol: 1 })).G0).toBe(4);
    expect(counts(report(kinked, { gapTol: 1, angleTol: 0.05 })).G0).toBe(0);
  });
});

describe('measureContinuity: thresholds and sampling', () => {
  it('each threshold moves the grade it owns and no other', () => {
    const fb = filletedBox();
    expect(counts(report(fb, { curvatureTol: 1e9 }))).toEqual({ open: 0, G0: 0, G1: 0, G2: 48 });
    expect(counts(report(fb, { curvatureTol: 1e-9 }))).toEqual({ open: 0, G0: 0, G1: 48, G2: 0 });
    const b = must(box({ size: [4, 5, 6] }));
    expect(counts(report(b, { angleTol: 1.6 })).G0).toBe(0);
    expect(counts(report(b, { angleTol: 1.5 })).G0).toBe(12);
    const moved = translateFace(
      fb,
      fb.faces.findIndex((f) => f.label === 'filleted-box.c111'),
      [0.05, 0.05, 0.05],
    );
    expect(counts(report(moved, { gapTol: 1 })).open).toBe(0);
    expect(counts(report(moved, { gapTol: 1e-6 })).open).toBe(3);
  });

  it('the grades do not depend on the sample count', () => {
    for (const c of allCases()) {
      const few = counts(report(c.shape, { samples: 3 }));
      const many = counts(report(c.shape, { samples: 21 }));
      expect(few, c.name).toEqual(many);
    }
  });

  it('every sample carries finite measurements', () => {
    for (const c of allCases())
      for (const e of report(c.shape).edges)
        for (const s of e.samples) {
          expect(Number.isFinite(s.gap) && Number.isFinite(s.angle)).toBe(true);
          expect(s.angle).toBeGreaterThanOrEqual(0);
        }
  });

  it('refuses a structurally broken Shape instead of measuring it', () => {
    const b = must(box({ size: [1, 1, 1] }));
    const broken: Shape = {
      ...b,
      coedges: b.coedges.map((c, i) => (i === 0 ? { ...c, edge: 999 } : c)),
    };
    expect(measureContinuity(broken).ok).toBe(false);
  });
});

describe('housing assembly', () => {
  const c = housingAssembly();
  const parts = [c.shape, ...(c.extra ?? [])];
  const counts = (r: ReturnType<typeof measureContinuity>) => {
    const rep = must(r);
    const n = { open: 0, G0: 0, G1: 0, G2: 0 };
    for (const e of rep.edges) if (!e.seam) n[e.grade]++;
    return { n, seams: rep.edges.filter((e) => e.seam).length };
  };

  it('the housing has only G0 creases: 8 outline sides x 3 + window 4 x 3 + four 12-gon holes x 12 x 3', () => {
    expect(counts(measureContinuity(c.shape)).n).toEqual({
      open: 0,
      G0: 24 + 12 + 4 * 12 * 3,
      G1: 0,
      G2: 0,
    });
  });

  it('each standoff has four G1 rim joins and three seams, none G0', () => {
    expect(parts.length).toBe(5);
    for (const p of parts.slice(1)) {
      expect(counts(measureContinuity(p))).toEqual({
        n: { open: 0, G0: 0, G1: 4, G2: 0 },
        seams: 3,
      });
    }
  });

  it('the standoffs stand on the four screw-hole centres, top disk 14 above the housing', () => {
    const tops = parts.slice(1).map((p) => {
      const planes = p.surfaces.flatMap((sf) => (sf.kind === 'plane' ? [sf.frame.o] : []));
      return planes.reduce((a, o) => (o[2] > a[2] ? o : a));
    });
    expect(tops.map((o) => [o[0], o[1], o[2]]).sort()).toEqual(
      [
        [8, 8, 32],
        [72, 8, 32],
        [8, 42, 32],
        [72, 42, 32],
      ].sort(),
    );
  });
});

describe('continuity render', () => {
  it('colours every measured edge by its grade and draws seams grey', () => {
    const c = allCases().find((x) => x.name === 'pipe-elbow-split');
    if (c === undefined) throw new Error('case');
    const r = report(c.shape);
    const lines = continuityLines(c.shape, r);
    expect(lines.length).toBe(r.edges.length);
    for (const grade of ['G0', 'G1', 'G2'] as const) {
      const n = lines.filter((l) => l.color === GRADE_COLOR[grade]).length;
      expect(n, grade).toBe(r.edges.filter((e) => !e.seam && e.grade === grade).length);
    }
  });

  it('writes a deterministic sheet per case', () => {
    const a = mkdtempSync(join(tmpdir(), 'cont-a-'));
    const b = mkdtempSync(join(tmpdir(), 'cont-b-'));
    try {
      const c = allCases()[0];
      if (c === undefined) throw new Error('case');
      const x = renderContinuity(c, a, 200);
      const y = renderContinuity(c, b, 200);
      expect(readFileSync(x.sheet).equals(readFileSync(y.sheet))).toBe(true);
      expect(x.counts).toEqual({ open: 0, G0: 0, G1: 48, G2: 0 });
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
