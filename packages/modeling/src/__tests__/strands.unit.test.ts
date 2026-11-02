import { describe, expect, it } from 'vitest';
import { faceCentroid, length, sub, type Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { isClosed } from '../ops';
import { sel } from '../selectors';

function scalp(): Model {
  const m = model();
  m.sphere({ radius: 0.1, widthSegments: 32, heightSegments: 16, tag: 'head' });
  return m;
}
const cap = () => sel.tag('head').and(sel.inBox([-1, 0.04, -1], [1, 1, 1], { by: 'all' }));
const clump: Tuple3[] = [
  [0, 0, 0],
  [0, 0.03, 0.02],
  [0, 0.04, 0.06],
  [0, 0.01, 0.1],
];

describe('strands (hair cards / strand array, B11c G2)', () => {
  it('grows count strands from a scalp region, each tagged, closed with the head', () => {
    const m = scalp();
    const r = m.strands(cap(), { count: 12, path: clump, comb: [0, 0, -1], label: 'hair' });
    expect(r.status, JSON.stringify(r.error)).toBe('ok');
    expect(r.roles.tip).toBe(12);
    for (let i = 0; i < 12; i++) expect(m.count(sel.tag(`strand:${i}`))).toBeGreaterThan(0);
    expect(isClosed(m.editMesh)).toBe(true);
    expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    // Tips lie outside the scalp and toward the comb side.
    const mesh = m.editMesh;
    for (const f of sel.createdBy('hair', 'tip').evaluate(mesh)) {
      expect(length(faceCentroid(mesh, f))).toBeGreaterThan(0.1);
    }
  });

  it('roots spread evenly; variation is seeded and deterministic', () => {
    const build = (seed: number) => {
      const m = scalp();
      m.strands(cap(), {
        count: 8,
        path: clump,
        comb: [0, 0, -1],
        vary: { length: [0.7, 1.3], turn: 25 },
        seed,
      });
      return m.snapshot();
    };
    expect(build(3)).toEqual(build(3));
    expect(build(3)).not.toEqual(build(4));
    const m = scalp();
    m.strands(cap(), { count: 6, path: clump, comb: [0, 0, -1], label: 'hair' });
    const tips = sel
      .createdBy('hair', 'tip')
      .evaluate(m.editMesh)
      .map((f) => faceCentroid(m.editMesh, f));
    let closest = Infinity;
    for (let i = 0; i < tips.length; i++)
      for (let j = i + 1; j < tips.length; j++)
        closest = Math.min(closest, length(sub(tips[i] as Tuple3, tips[j] as Tuple3)));
    expect(closest).toBeGreaterThan(0.01);
  });

  it('rootFaces groups faces per strand; bad options and a small region are rejected', () => {
    const m = scalp();
    expect(
      m.strands(cap(), { count: 4, rootFaces: 3, path: clump, comb: [0, 0, -1], label: 'hair' })
        .roles.tip,
    ).toBe(12);
    for (const options of [
      { count: 0, path: clump, comb: [0, 0, 1] as Tuple3 },
      { count: 2, path: [[0, 0, 0]] as Tuple3[], comb: [0, 0, 1] as Tuple3 },
      { count: 2, path: clump, comb: [0, 0, 0] as Tuple3 },
      {
        count: 2,
        path: clump,
        comb: [0, 0, 1] as Tuple3,
        vary: { length: [0, 1] as [number, number] },
      },
      { count: 1000, path: clump, comb: [0, 0, 1] as Tuple3 },
      { count: 2, path: clump, comb: [0, 0, 1] as Tuple3, combFrame: 'up' as 'world' },
    ]) {
      expect(scalp().strands(cap(), options).error?.code).toBe('model-invalid-argument');
    }
  });
  it('roots that use up the region grow connected patches', () => {
    for (const rootFaces of [2, 3, 4]) {
      const m = scalp();
      const count = Math.floor(m.count(cap()) / rootFaces);
      const r = m.strands(cap(), {
        count,
        rootFaces,
        path: clump,
        comb: [0, 0, -1],
        label: 'hair',
      });
      expect(r.status, `rootFaces ${rootFaces}: ${JSON.stringify(r.error)}`).toBe('ok');
      expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });

  it('a comb within a few degrees of the root normal warns and combs sideways', () => {
    const m = scalp();
    const r = m.strands(cap(), { count: 12, path: clump, comb: [0, 1, 0], label: 'hair' });
    expect(r.status).toBe('ok');
    expect(r.diagnostics?.some((d) => d.severity === 'warn' && d.message.includes('comb'))).toBe(
      true,
    );
  });

  it("combFrame 'world' lets strands fall along the comb from upward-facing roots (F2 G4)", () => {
    // Lift off the scalp, then run 15 cm along the comb (straight down).
    const fall: Tuple3[] = [
      [0, 0, 0],
      [0, 0.02, 0.02],
      [0, 0.02, 0.08],
      [0, 0.01, 0.15],
    ];
    const tipHeights = (combFrame: 'surface' | 'world') => {
      const m = scalp();
      const r = m.strands(cap(), {
        count: 12,
        path: fall,
        comb: [0, -1, 0],
        combFrame,
        label: 'hair',
      });
      expect(r.status, JSON.stringify(r.error)).toBe('ok');
      expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
      return sel
        .createdBy('hair', 'tip')
        .evaluate(m.editMesh)
        .map((f) => faceCentroid(m.editMesh, f)[1]);
    };
    // Projected onto the near-horizontal tangent planes of the crown, the comb fans out.
    expect(Math.max(...tipHeights('surface'))).toBeGreaterThan(0);
    // Kept in world space, every strand ends below the cap's lowest root (y 0.04).
    expect(Math.max(...tipHeights('world'))).toBeLessThan(0);
  });

  it('reports strands that cross each other, and stays quiet when none do (B11c N1)', () => {
    const clean = scalp();
    const ok = clean.strands(cap(), { count: 12, path: clump, comb: [0, 0, -1], label: 'hair' });
    expect(ok.diagnostics?.some((d) => d.message.includes('cross each other'))).toBe(false);
    // Long strands combed in random directions over a dense set of roots must collide.
    const tangled = scalp();
    const r = tangled.strands(cap(), {
      count: 40,
      path: [
        [0, 0, 0],
        [0, 0.02, 0.05],
        [0, 0.0, 0.15],
        [0, -0.04, 0.25],
      ],
      comb: [0, 0, -1],
      vary: { turn: 180 },
      seed: 7,
      label: 'hair',
    });
    expect(r.status).toBe('ok');
    const warn = r.diagnostics?.find((d) => d.message.includes('cross each other'));
    expect(warn).toBeDefined();
    const pairs = warn?.detail?.pairs as [number, number][];
    expect(pairs.length).toBeGreaterThan(0);
    for (const [a, b] of pairs) expect(a).toBeLessThan(b);
    // The reported faces are real faces of the two strands.
    const [f0, f1] = (warn?.detail?.faces as [number, number][])[0] as [number, number];
    const mesh = tangled.editMesh;
    const tagOf = (f: number) =>
      mesh.tagNames.findIndex((name, t) => name.startsWith('strand:') && mesh.hasTag(f, t));
    expect(tagOf(f0)).not.toBe(tagOf(f1));
  });
});
