import { describe, expect, it } from 'vitest';
import { measureUv } from '../compute/uv-ts';
import { faceCentroid } from '../geom';
import { EDGE_SEAM } from '../mesh';
import { type Model, model, type OpReport } from '../model';
import { Selector, sel } from '../selectors';

function info(report: OpReport): Record<string, unknown> {
  const last = report.diagnostics?.filter((d) => d.severity === 'info').at(-1);
  if (report.status !== 'ok' || last === undefined) {
    throw new Error(`${report.op}: ${report.error?.message}`);
  }
  return last.detail as Record<string, unknown>;
}

const seams = (m: Model): number[] =>
  m.editMesh.edges().filter((e) => ((m.editMesh.eFlags[e] as number) & EDGE_SEAM) !== 0);

const edgesOf = (ids: readonly number[], name: string) =>
  new Selector('edge', name, () => [...ids]);

const sphere = (): Model => {
  const m = model();
  m.sphere({ radius: 1, widthSegments: 24, heightSegments: 12 });
  return m;
};

const tube = (): Model => {
  const m = model();
  m.cylinder({
    radiusTop: 0.5,
    radiusBottom: 0.5,
    height: 8,
    radialSegments: 16,
    heightSegments: 16,
    openEnded: true,
  });
  return m;
};

const centroidSpan = (m: Model): number => {
  const measured = measureUv(m.editMesh);
  if (!measured.ok) throw measured.error;
  const lo = new Map<number, number[]>();
  const hi = new Map<number, number[]>();
  for (const f of m.editMesh.faces()) {
    const id = measured.value.faceIsland[f] as number;
    const c = faceCentroid(m.editMesh, f);
    const a = lo.get(id) ?? [Infinity, Infinity, Infinity];
    const b = hi.get(id) ?? [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      a[k] = Math.min(a[k] as number, c[k] as number);
      b[k] = Math.max(b[k] as number, c[k] as number);
    }
    lo.set(id, a);
    hi.set(id, b);
  }
  let worst = 0;
  for (const [id, a] of lo) {
    const b = hi.get(id) as number[];
    worst = Math.max(worst, Math.hypot(...a.map((v, k) => (b[k] as number) - v)));
  }
  return worst;
};

const snapshot = (m: Model) => {
  const mesh = m.editMesh;
  const halves = mesh.faces().flatMap((f) => mesh.faceHalves(f));
  return {
    seams: seams(m),
    uv0: halves.map((h) => Array.from((mesh.corner('uv0', h) ?? []) as Float32Array)),
    flags: Array.from(mesh.eFlags.slice(0, mesh.halfHighWater >> 1)),
  };
};

describe('uv.plan seam controls', () => {
  it('forbid keeps the planner off an edge it cuts without the option', () => {
    const base = sphere();
    info(base.uv.plan({ maxStretch: 1.8 }));
    const cut = seams(base);
    expect(cut.length).toBeGreaterThan(0);
    const banned = cut.filter((_, i) => i % 3 === 0);
    const m = sphere();
    info(m.uv.plan({ maxStretch: 1.8, forbid: edgesOf(banned, 'forbid-cuts') }));
    const after = new Set(seams(m));
    for (const e of banned) expect(after.has(e)).toBe(false);
    expect(after.size).toBeGreaterThan(0);
    const closed = sphere().uv.plan({ forbid: edgesOf(cut, 'every-cut') });
    expect(closed.status).toBe('failed');
    expect(closed.error?.code).toBe('model-precondition');
    expect(closed.error?.detail?.code).toBe('forbid-closed');
  });

  it('forbid fails closed when the cuts a stretched island needs are all forbidden', () => {
    const sphereInterior = (m: Model): number[] =>
      m.editMesh
        .edges()
        .filter(
          (x) =>
            (m.editMesh.hFace[x * 2] as number) >= 0 &&
            (m.editMesh.hFace[x * 2 + 1] as number) >= 0,
        );
    const m = sphere();
    const all = sphereInterior(m);
    const keep = all[5] as number;
    const forced = m.uv.plan({
      force: edgesOf([keep], 'one'),
      forbid: edgesOf(
        all.filter((x) => x !== keep),
        'rest',
      ),
    });
    expect(forced.status).toBe('failed');
    expect(forced.error?.code).toBe('model-precondition');
    expect(forced.error?.detail?.code).toBe('forbid-unresolved');
    expect(seams(m)).toEqual([]);
    const open = tube();
    const frozen = open.uv.plan({ maxStretch: 1.3, forbid: edgesOf(open.editMesh.edges(), 'all') });
    expect(frozen.status).toBe('failed');
    expect(frozen.error?.detail?.code).toBe('forbid-unresolved');
  });

  it('falsifier: a forbid-unresolved failure leaves uv0 and the seam flags as they were', () => {
    const open = tube();
    open.uv.unwrap({});
    const forcedEdge = open.editMesh.edges()[3] as number;
    const before = snapshot(open);
    const r = open.uv.plan({
      maxStretch: 1.3,
      force: edgesOf([forcedEdge], 'one'),
      forbid: edgesOf(
        open.editMesh.edges().filter((e) => e !== forcedEdge),
        'rest',
      ),
    });
    expect(r.status).toBe('failed');
    expect(r.error?.detail?.code).toBe('forbid-unresolved');
    expect(snapshot(open)).toEqual(before);
    const closed = sphere();
    const pristine = snapshot(closed);
    const c = closed.uv.plan({ forbid: edgesOf(closed.editMesh.edges(), 'all') });
    expect(c.error?.detail?.code).toBe('forbid-closed');
    expect(snapshot(closed)).toEqual(pristine);
  });

  it('falsifier: a forbid-closed failure undoes a forced seam written on another island', () => {
    const a = sphere();
    const countA = a.editMesh.edges().length;
    const m = sphere();
    m.append(a, { translate: [5, 0, 0] });
    const edges = m.editMesh.edges();
    const forced = edges[0] as number;
    const second = edges.filter((e) => e !== forced && e >= countA);
    const before = snapshot(m);
    const r = m.uv.plan({ force: edgesOf([forced], 'one'), forbid: edgesOf(second, 'second') });
    expect(r.status).toBe('failed');
    expect(r.error?.detail?.code).toBe('forbid-closed');
    expect(seams(m)).toEqual([]);
    expect(snapshot(m)).toEqual(before);
  });

  it('forbid-unresolved reports the unresolved islands and the forbidden edge count', () => {
    const m = tube();
    const all = m.editMesh.edges();
    const r = m.uv.plan({ maxStretch: 1.3, forbid: edgesOf(all, 'all') });
    expect(r.error?.detail?.code).toBe('forbid-unresolved');
    expect(r.error?.detail?.forbidden).toBe(all.length);
    expect(r.error?.detail?.unresolved).toBeGreaterThan(0);
  });

  it('exhausting the rounds with an unrelated forbid is a plan with unresolved islands, not an error', () => {
    const m = tube();
    const r = m.uv.plan({
      maxStretch: 1.3,
      maxRounds: 0,
      forbid: edgesOf([m.editMesh.edges()[0] as number], 'one'),
    });
    expect(r.status).toBe('ok');
    expect(info(r).unresolved).toBeGreaterThan(0);
  });

  it('an unresolved island without forbid stays a plan, not a forbid-unresolved error', () => {
    const m = sphere();
    const r = m.uv.plan({ maxStretch: 1 });
    expect(r.status).toBe('ok');
    expect(info(r).unresolved).toBeGreaterThan(0);
  });

  it('thin-arm detachment never cuts a forbidden edge', () => {
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
    const base = build();
    expect(info(base.uv.plan({ minWidth: 1, hardAngle: 180 })).pruned).toBeGreaterThan(0);
    const junction = seams(base);
    expect(junction.length).toBeGreaterThan(0);
    const m = build();
    const facts = info(
      m.uv.plan({ minWidth: 1, hardAngle: 180, forbid: edgesOf(junction, 'arm') }),
    );
    expect(seams(m).filter((e) => junction.includes(e))).toEqual([]);
    expect(facts.pruned).toBe(0);
  });

  it('falsifier: a single-boundary island is never cut along a forbidden edge', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let planned = 0;
    for (let k = 0; k < 48; k++) {
      const m = model();
      m.sphere({ radius: 1, widthSegments: 16, heightSegments: 8 });
      m.delete(sel.inBox([-2, -2, -2], [0, 2, 2]));
      const banned = m.editMesh
        .edges()
        .filter(() => rnd() < (k % 3 === 0 ? 0.4 : k % 3 === 1 ? 0.7 : 0.85));
      const set = new Set(banned);
      const r = m.uv.plan({
        maxStretch: 1.05 + 0.125 * ((k >> 1) % 3),
        forbid: edgesOf(banned, 'f'),
      });
      if (r.status === 'ok') planned++;
      expect(seams(m).filter((e) => set.has(e))).toEqual([]);
    }
    expect(planned).toBeGreaterThan(0);
  });

  it('a forbidden line of the tube is routed around, not dropped', () => {
    const base = tube();
    info(base.uv.plan({ maxStretch: 1.3 }));
    const line = seams(base);
    const m = tube();
    const facts = info(m.uv.plan({ maxStretch: 1.3, forbid: edgesOf(line, 'the-slit') }));
    const after = seams(m);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((e) => line.includes(e))).toEqual([]);
    expect(facts.unresolved).toBe(0);
    expect(facts.cuts).toBeGreaterThan(0);
  });

  it('a ring of forbidden edges that every slit must cross fails closed instead of crossing', () => {
    const m = tube();
    const mesh = m.editMesh;
    const ring = mesh.edges().filter((e) => {
      const [a, b] = mesh.edgeVertices(e);
      const ya = mesh.position(a)[1];
      const yb = mesh.position(b)[1];
      return Math.abs(ya - yb) > 1e-6 && Math.min(ya, yb) >= -1e-6 && Math.max(ya, yb) <= 0.6;
    });
    expect(ring.length).toBe(16);
    const r = m.uv.plan({ maxStretch: 1.3, forbid: edgesOf(ring, 'ring') });
    expect(r.status).toBe('failed');
    expect(r.error?.detail?.code).toBe('forbid-unresolved');
    expect(seams(m).filter((e) => ring.includes(e))).toEqual([]);
  });

  it('bisecting a too-long island never cuts a forbidden edge', () => {
    const base = tube();
    info(base.uv.plan({ maxStretch: 1.3, maxLength: 2 }));
    const cut = seams(base);
    const m = tube();
    const r = m.uv.plan({ maxStretch: 1.3, maxLength: 2, forbid: edgesOf(cut, 'every-cut') });
    expect(seams(m).filter((e) => cut.includes(e))).toEqual([]);
    if (r.status === 'ok') expect(info(r).unresolved).toBe(0);
    else expect(r.error?.detail?.code).toBe('forbid-unresolved');
  });

  it('forbid on a hard edge drops its semantic seam; forced and forbidden is an error', () => {
    const box = model();
    box.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    const hard = box.editMesh
      .edges()
      .filter(
        (e) =>
          (box.editMesh.hFace[e * 2] as number) >= 0 &&
          (box.editMesh.hFace[e * 2 + 1] as number) >= 0,
      );
    const m = model();
    m.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    m.uv.plan();
    const [first] = seams(m);
    const n = seams(m).length;
    const f = model();
    f.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    info(f.uv.plan({ forbid: edgesOf([first as number], 'one-hard') }));
    expect(seams(f).length).toBeLessThan(n);
    expect(seams(f)).not.toContain(first);
    const bad = model();
    bad.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    const r = bad.uv.plan({
      force: edgesOf([first as number], 'e'),
      forbid: edgesOf([first as number], 'e'),
    });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-invalid-argument');
    expect(hard.length).toBeGreaterThan(0);
  });

  it('force marks seams as the patch source', () => {
    const m = sphere();
    const e = m.editMesh
      .edges()
      .filter(
        (x) =>
          (m.editMesh.hFace[x * 2] as number) >= 0 && (m.editMesh.hFace[x * 2 + 1] as number) >= 0,
      )[5] as number;
    const facts = info(m.uv.plan({ maxStretch: 1.8, force: edgesOf([e], 'one') }));
    expect(seams(m)).toContain(e);
    expect((facts.sources as Record<string, number>).patch).toBe(1);
  });

  it('avoid moves the cut path off the avoided edges', () => {
    const base = tube();
    info(base.uv.plan({ maxStretch: 1.3 }));
    const cut = seams(base);
    const m = tube();
    info(m.uv.plan({ maxStretch: 1.3, avoid: edgesOf(cut, 'avoid-cuts'), avoidCost: 50 }));
    const after = new Set(seams(m));
    expect(cut.filter((e) => after.has(e)).length).toBe(0);
    expect(after.size).toBe(cut.length);
  });

  it('maxLength bisects long islands and bounds the geodesic of every chart', () => {
    const free = tube();
    expect(info(free.uv.plan({ maxStretch: 1.3 })).islands).toBe(1);
    expect(centroidSpan(free)).toBeGreaterThan(2);
    const m = tube();
    const facts = info(m.uv.plan({ maxStretch: 1.3, maxLength: 2 }));
    expect(facts.islands).toBeGreaterThan(1);
    expect(facts.unresolved).toBe(0);
    expect(centroidSpan(m)).toBeLessThanOrEqual(2);
  });

  it('minArea merges a tagged island the default leaves alone', () => {
    const make = (): Model => {
      const m = model();
      m.box({ size: [1, 1, 1], segments: [4, 4, 4] });
      m.tag(sel.facing('+y').and(sel.inBox([-0.3, 0.4, -0.3], [0.1, 0.6, 0.1])), 'patch');
      return m;
    };
    const a = make();
    const kept = info(a.uv.plan({ hardAngle: 180 }));
    const b = make();
    const merged = info(b.uv.plan({ hardAngle: 180, minArea: 0.2 }));
    expect(kept.merged).toBe(0);
    expect(merged.merged).toBeGreaterThan(0);
    expect(merged.islands as number).toBeLessThan(kept.islands as number);
  });

  it('reports seams by source in the closed order part, patch, feature, curvature', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [3, 3, 3] });
    m.tag(sel.facing('+y'), 'lid');
    const facts = info(m.uv.plan());
    const sources = facts.sources as {
      part: number;
      patch: number;
      feature: number;
      curvature: number;
    };
    expect(Object.keys(sources)).toEqual(['part', 'patch', 'feature', 'curvature']);
    expect(sources.part).toBeGreaterThan(0);
    expect(sources.feature).toBeGreaterThan(0);
    expect(sources.patch).toBe(0);
    expect(sources.part + sources.feature + sources.patch + sources.curvature).toBe(
      seams(m).length,
    );
  });

  it('an island under minArea is merged and counted as thin even when minWidth is 0 or small', () => {
    const make = (): Model => {
      const m = model();
      m.box({ size: [1, 1, 1], segments: [4, 4, 4] });
      m.tag(sel.facing('+y').and(sel.inBox([-0.3, 0.4, -0.3], [0.1, 0.6, 0.1])), 'patch');
      return m;
    };
    const keep = info(make().uv.plan({ hardAngle: 180, minWidth: 0 }));
    const merged = info(make().uv.plan({ hardAngle: 180, minWidth: 0, minArea: 0.2 }));
    expect(keep.merged).toBe(0);
    expect(merged.merged).toBeGreaterThan(0);
    const plane = model();
    plane.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
    const wide = info(plane.uv.plan({ minWidth: 0.01 }));
    expect(wide.thin).toBe(0);
    const small = model();
    small.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
    expect(info(small.uv.plan({ minWidth: 0.01, minArea: 10 })).thin).toBe(1);
  });

  it('a thin strip merges across its weakest border: a patch seam gives way before a part seam', () => {
    const column = (m: Model, x: number): number[] =>
      m.editMesh.edges().filter((e) => {
        const [a, b] = m.editMesh.edgeVertices(e);
        const pa = m.editMesh.position(a);
        const pb = m.editMesh.position(b);
        return Math.abs(pa[0] - x) < 1e-6 && Math.abs(pb[0] - x) < 1e-6;
      });
    for (const forcedX of [0, 1] as const) {
      const m = model();
      m.plane({ width: 6, height: 6, widthSegments: 6, heightSegments: 6 });
      m.tag(sel.inBox([-0.1, -3.1, -0.1], [1.1, 3.1, 0.1]), 'strip');
      const interior = (e: number) =>
        (m.editMesh.hFace[e * 2] as number) >= 0 && (m.editMesh.hFace[e * 2 + 1] as number) >= 0;
      const forcedEdges = column(m, forcedX).filter(interior);
      const otherEdges = column(m, 1 - forcedX).filter(interior);
      const facts = info(
        m.uv.plan({
          minWidth: 1.5,
          minArea: 0,
          mergeMarked: true,
          force: edgesOf(forcedEdges, 'forced-border'),
        }),
      );
      expect(facts.merged).toBe(1);
      const left = new Set(seams(m));
      expect(forcedEdges.every((e) => !left.has(e))).toBe(true);
      expect(otherEdges.every((e) => left.has(e))).toBe(true);
    }
  });
});
