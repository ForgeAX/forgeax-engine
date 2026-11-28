import { describe, expect, it } from 'vitest';
import { measureUv } from '../compute/uv-ts';
import { dot, faceNormal } from '../geom';
import { EDGE_SEAM, EDGE_SHARP } from '../mesh';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

function info(report: OpReport): Record<string, number> {
  const last = report.diagnostics?.filter((d) => d.severity === 'info').at(-1);
  if (report.status !== 'ok' || last === undefined) {
    throw new Error(`${report.op}: ${report.error?.message}`);
  }
  return last.detail as Record<string, number>;
}

function seamCount(m: Model): number {
  return m.editMesh.edges().filter((e) => ((m.editMesh.eFlags[e] as number) & EDGE_SEAM) !== 0)
    .length;
}

describe('uv.plan', () => {
  it('a box gets its twelve hard edges as seams and needs no stretch cut', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [3, 3, 3] });
    const facts = info(m.uv.plan());
    expect(facts.cuts).toBe(0);
    expect(facts.islands).toBe(6);
    expect(facts.stretchLinf).toBeLessThan(1.05);
  });

  it('every edge sharper than hardAngle is a seam (hard edge = seam)', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    const report = m.uv.plan({ hardAngle: 60 });
    expect(report.error?.message).toBeUndefined();
    const hard = m.editMesh.edges().filter((e) => {
      const a = m.editMesh.hFace[e * 2] as number;
      const b = m.editMesh.hFace[e * 2 + 1] as number;
      return a >= 0 && b >= 0 && dot(faceNormal(m.editMesh, a), faceNormal(m.editMesh, b)) < 0.5;
    });
    expect(hard.length).toBe(12 * 2);
    for (const e of hard) expect((m.editMesh.eFlags[e] as number) & EDGE_SEAM).toBe(EDGE_SEAM);
  });

  it('a sphere is cut until every island stays under maxStretch and nothing flips', () => {
    const m = model();
    m.sphere({ radius: 1, widthSegments: 24, heightSegments: 12 });
    const facts = info(m.uv.plan({ maxStretch: 1.8 }));
    expect(facts.unresolved).toBe(0);
    expect(facts.cuts).toBeGreaterThan(0);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.flipped).toBe(0);
    expect(measured.value.zeroArea).toBe(0);
    for (const island of measured.value.islands)
      expect(island.stretchLinf).toBeLessThanOrEqual(1.8);
  });

  it('a cylinder tube (two boundary loops) is opened without leaving a closed ring', () => {
    const m = model();
    m.cylinder({
      radiusTop: 0.5,
      radiusBottom: 0.5,
      height: 2,
      radialSegments: 24,
      heightSegments: 4,
      openEnded: true,
    });
    const facts = info(m.uv.plan({ maxStretch: 1.3 }));
    expect(facts.unresolved).toBe(0);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.flipped).toBe(0);
  });

  it('tag borders are seams and respectSharp ties normal hardening to the charts', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    const before = seamCount(m);
    m.tag(sel.facing('+y'), 'top');
    info(m.uv.plan({ hardAngle: 180 }));
    expect(seamCount(m)).toBeGreaterThan(before);
    const k = model();
    k.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    k.markSharp(sel.edges.dihedral('>', 40));
    info(k.uv.plan({ hardAngle: 180, respectSharp: true }));
    for (const e of k.editMesh.edges()) {
      if (((k.editMesh.eFlags[e] as number) & EDGE_SHARP) !== 0) {
        expect((k.editMesh.eFlags[e] as number) & EDGE_SEAM).toBe(EDGE_SEAM);
      }
    }
  });

  it('minWidth merges a thin tagged strip into its neighbor and keeps marked seams', () => {
    const build = () => {
      const m = model();
      m.plane({ width: 4, height: 1, widthSegments: 16, heightSegments: 1 });
      m.tag(sel.inBox([-0.5, -1, -1], [-0.25, 1, 1]), 'strip');
      return m;
    };
    const apart = info(build().uv.plan({ minWidth: 0 }));
    const m = build();
    const facts = info(m.uv.plan({ minWidth: 0.5, hardAngle: 60 }));
    expect(facts.merged).toBeGreaterThan(0);
    expect(facts.islands).toBeLessThan(apart.islands as number);
    expect(facts.unresolved).toBe(0);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.flipped).toBe(0);

    const marked = model();
    marked.box({ size: [4, 1, 1], segments: [16, 1, 1] });
    marked.markSeam(sel.edges.dihedral('>', 40));
    const kept = seamCount(marked);
    info(marked.uv.plan({ minWidth: 5, hardAngle: 180 }));
    expect(seamCount(marked)).toBeGreaterThanOrEqual(kept);
  });

  it('an elongated tagged strip wider than minWidth is merged into its neighbor', () => {
    const build = () => {
      const m = model();
      m.plane({ width: 10, height: 10, widthSegments: 10, heightSegments: 20 });
      m.tag(sel.inBox([-6, 4.4, -1], [6, 6, 1]), 'strip');
      return m;
    };
    const apart = info(build().uv.plan({ minWidth: 0 }));
    const m = build();
    const facts = info(m.uv.plan());
    expect(apart.islands).toBe(2);
    expect(facts.islands).toBe(1);
    expect(facts.merged).toBeGreaterThan(0);
    expect(facts.unresolved).toBe(0);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.flipped).toBe(0);
  });

  it('a multi-facet bevel strip is judged against the flat face it grew from', () => {
    const m = model();
    m.box({ size: [4, 4, 4], segments: [4, 4, 4] });
    m.bevel(sel.edges.dihedral('>', 40), { width: 0.3, segments: 4 });
    const facts = info(m.uv.plan({ hardAngle: 75 }));
    const flat = model();
    flat.box({ size: [4, 4, 4], segments: [4, 4, 4] });
    const sides = info(flat.uv.plan({ hardAngle: 75 }));
    expect(facts.islands).toBeLessThanOrEqual((sides.islands as number) + 12);
  });

  it('manual mode takes only marked seams and ignores hard edges, materials and tags', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    m.tag(sel.facing('+y'), 'top');
    const facts = info(m.uv.plan({ manual: true, maxStretch: 3 }));
    expect(facts.semantic).toBe(0);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.flipped).toBe(0);
    const k = model();
    k.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    k.markSeam(sel.edges.dihedral('>', 40));
    info(k.uv.plan({ manual: true }));
    expect(seamCount(k)).toBe(24);
  });

  it('a thin arm of a compact island is cut off as a chart of its own', () => {
    const build = () => {
      const m = model();
      m.plane({ width: 20, height: 8, widthSegments: 40, heightSegments: 16 });
      m.delete(
        sel
          .all()
          .minus(sel.inBox([-10.1, -4.1, -1], [-1.9, 4.1, 1]))
          .minus(sel.inBox([-2.1, -0.6, -1], [10.1, 0.1, 1])),
      );
      return m;
    };
    const whole = info(build().uv.plan({ minWidth: 0, hardAngle: 180 }));
    const m = build();
    const facts = info(m.uv.plan({ minWidth: 1, hardAngle: 180 }));
    expect(whole.islands).toBe(1);
    expect(facts.pruned).toBeGreaterThan(0);
    expect(facts.islands).toBe(2);
    expect(facts.unresolved).toBe(0);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.flipped).toBe(0);
  });

  it('mergeMarked lets a thin island fold back into its neighbor across marked seams', () => {
    const build = () => {
      const m = model();
      m.box({ size: [4, 1, 1], segments: [16, 1, 1] });
      m.markSeam(sel.edges.dihedral('>', 40));
      return m;
    };
    const kept = build();
    const before = seamCount(kept);
    info(kept.uv.plan({ manual: true, minWidth: 0.9 }));
    expect(seamCount(kept)).toBe(before);
    const m = build();
    const facts = info(
      m.uv.plan({ manual: true, mergeMarked: true, minWidth: 0.9, maxStretch: 3 }),
    );
    expect(facts.merged).toBeGreaterThan(0);
    expect(seamCount(m)).toBeLessThan(before);
  });

  it('is deterministic and rejects non-finite options', () => {
    const run = () => {
      const m = model();
      m.sphere({ radius: 1, widthSegments: 16, heightSegments: 8 });
      m.uv.plan({ maxStretch: 1.5 });
      return [...m.editMesh.eFlags];
    };
    expect(run()).toEqual(run());
    const bad = model();
    bad.box({ size: [1, 1, 1] });
    expect(bad.uv.plan({ maxStretch: Number.NaN }).status).toBe('failed');
  });
});

describe('seams planned on the form survive lowpoly', () => {
  const seamLength = (m: Model): number => {
    let total = 0;
    for (const e of m.editMesh.edges()) {
      if (((m.editMesh.eFlags[e] as number) & EDGE_SEAM) === 0) continue;
      const [a, b] = m.editMesh.edgeVertices(e);
      const p = m.editMesh.position(a);
      const q = m.editMesh.position(b);
      total += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
    return total;
  };

  it('the seam length planned on a bevelled box survives lowpoly; the manual re-plan keeps every seam and only adds measured cuts', () => {
    const m = model();
    m.box({ size: [4, 3, 2], segments: [8, 6, 4] });
    m.bevel(sel.edges.dihedral('>', 40), { width: 0.2, segments: 3 });
    const planned = info(m.uv.plan({ hardAngle: 75, maxStretch: 1.6, refine: 'slim' }));
    const before = seamLength(m);
    expect(m.lowpoly(undefined, { targetFaces: 160, quads: false }).status).toBe('ok');
    const simplified = seamLength(m);
    // Measured: 28.65 m planned, 28.56 m after the simplifier (the collapsed fans move seam vertices by millimetres).
    expect(simplified).toBeGreaterThan(0.95 * before);
    expect(simplified).toBeLessThan(1.05 * before);
    const replanned = info(m.uv.plan({ manual: true, maxStretch: 1.6 }));
    expect(replanned.semantic).toBe(0);
    expect(replanned.unresolved).toBe(0);
    expect(replanned.islands as number).toBeGreaterThanOrEqual(planned.islands as number);
    expect(seamLength(m)).toBeGreaterThanOrEqual(simplified);
  });
});
