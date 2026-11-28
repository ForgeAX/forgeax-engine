import { describe, expect, it } from 'vitest';
import { EditMesh, setPartRole } from '../mesh';
import { type Model, model } from '../model';
import { measureSeamVisibility } from '../seam-visibility';
import { sel } from '../selectors';

/** A 2 x 1 x 1 block on a wide slab; every face is projected so each box edge is a seam. */
function scene(withSlab: boolean): Model {
  const m = model();
  m.box({ size: [2, 1, 1], center: [0, 0.5, 0], label: 'block' });
  if (withSlab) m.box({ size: [12, 1, 12], center: [0, -0.5, 0], label: 'slab' });
  m.markSharp(sel.edges.dihedral('>', 30));
  m.uv.unwrap({ seams: 'sharp' });
  m.uv.pack({ resolution: 256, padding: 2, method: 'raster' });
  return m;
}

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

describe('seamVisibility: BK58', () => {
  it('a closed block shows its seams; a slab under it hides the lower ones (falsifier: occluders ignored)', () => {
    const open = ok(scene(false).seamVisibility());
    const slab = ok(scene(true).seamVisibility());
    expect(open.seams).toBe(12);
    expect(open.hiddenScore).toBeLessThan(0.5);
    expect(ok(scene(true).seamVisibility({ occluders: [] })).seams).toBe(slab.seams);
    const bare = ok(scene(true).seamVisibility({ occluders: [] }));
    expect(slab.hiddenScore).toBeGreaterThan(bare.hiddenScore + 0.02);
  });

  it('only viewpoints facing an adjacent face count (falsifier: all views counted)', () => {
    const m = scene(false);
    expect(ok(m.seamVisibility()).hiddenScore).toBeLessThan(0.02);
    const slab = ok(scene(true).seamVisibility());
    expect(slab.hiddenScore).toBeGreaterThan(0.075);
    expect(slab.hiddenScore).toBeLessThan(0.09);
  });

  it('the score is the length-weighted mean of the chains', () => {
    const r = ok(scene(true).seamVisibility());
    expect(r.chains.length).toBeGreaterThan(1);
    const len = r.chains.reduce((s, c) => s + c.length, 0);
    const weighted = r.chains.reduce((s, c) => s + c.length * c.hidden, 0) / len;
    const plain = r.chains.reduce((s, c) => s + c.hidden, 0) / r.chains.length;
    expect(r.length).toBeCloseTo(len, 9);
    expect(r.hiddenScore).toBeCloseTo(weighted, 9);
    expect(Math.abs(weighted - plain)).toBeGreaterThan(1e-3);
    expect(r.visibleLength).toBeCloseTo(len * (1 - weighted), 9);
    expect(r.exposed).toBe(r.chains.filter((c) => c.hidden < 0.5).length);
  });

  it('chains are ordered by visible length and report their islands and a worst point', () => {
    const r = ok(scene(true).seamVisibility());
    const visible = r.chains.map((c) => c.length * (1 - c.hidden));
    expect(visible).toEqual([...visible].sort((a, b) => b - a));
    for (const c of r.chains) {
      expect(c.islands[0]).toBeLessThanOrEqual(c.islands[1]);
      expect(c.worst).toHaveLength(3);
    }
  });

  it('per-island border sums to twice the seam length and flags thin islands', () => {
    const r = ok(scene(false).seamVisibility());
    expect(r.byIsland.reduce((s, i) => s + i.border, 0)).toBeCloseTo(2 * r.length, 9);
    expect(r.byIsland.every((i) => i.hidden >= 0 && i.hidden <= 1)).toBe(true);
    const shared = ok(scene(true).seamVisibility());
    expect(shared.byIsland.reduce((s, i) => s + i.border * i.hidden, 0)).toBeCloseTo(
      2 * shared.hiddenScore * shared.length,
      9,
    );
    const fine = ok(scene(false).seamVisibility({ resolution: 1024 }));
    const tiny = ok(scene(false).seamVisibility({ resolution: 8 }));
    expect(tiny.byIsland.filter((i) => i.thin).length).toBeGreaterThan(
      fine.byIsland.filter((i) => i.thin).length,
    );
  });

  it('is read-only and deterministic', () => {
    const m = scene(true);
    const before = JSON.stringify(Array.from(m.editMesh.faces()));
    const a = JSON.stringify(ok(m.seamVisibility()));
    expect(JSON.stringify(ok(m.seamVisibility()))).toBe(a);
    expect(JSON.stringify(Array.from(m.editMesh.faces()))).toBe(before);
  });

  it('refuses a mesh without the channel and invalid options', () => {
    const bare = model();
    bare.box({ size: [1, 1, 1] });
    const r = bare.seamVisibility();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-precondition');
    const m = scene(false);
    for (const options of [
      { views: 3 },
      { views: 5000 },
      { minHidden: 2 },
      { resolution: 0 },
      { occluders: ['x'] },
    ]) {
      const bad = m.seamVisibility(options as never);
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe('model-invalid-argument');
    }
  });
});

type P3 = readonly [number, number, number];

/** Build a mesh from points and loops; `uv(face, position)` sets every corner of uv0. */
function built(
  points: readonly P3[],
  faces: readonly (readonly number[])[],
  uv: (face: number, p: P3) => [number, number],
): EditMesh {
  const mesh = new EditMesh();
  for (const p of points) mesh.addVertex(...p);
  const ids: number[] = [];
  for (const loop of faces) {
    const added = mesh.addFace(loop);
    if (!added.ok) throw added.error;
    ids.push(added.value);
  }
  ids.forEach((f, i) => {
    for (const h of mesh.faceHalves(f))
      mesh.setCorner('uv0', h, uv(i, mesh.position(mesh.hVert[h] as number)));
  });
  return mesh;
}

/** Two islands of two quads each meeting in a chain of two collinear seam edges along y = 0. */
function strip(
  boxA: readonly [number, number] = [0.5, 0.5],
  boxB: readonly [number, number] = [0.5, 0.5],
  plate?: 'form' | 'tool',
): EditMesh {
  const pts: P3[] = [];
  for (const y of [-1, 0, 1]) for (const x of [0, 1, 2]) pts.push([x, y, 0]);
  const at = (x: number, y: number) => (y + 1) * 3 + x;
  const quad = (x: number, y: number) => [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1)];
  const loops = [quad(0, -1), quad(1, -1), quad(0, 0), quad(1, 0)].map((l) => [...l]);
  if (plate !== undefined) {
    const base = pts.length;
    pts.push([-10, -10, 0.05], [1, -10, 0.05], [1, 10, 0.05], [-10, 10, 0.05]);
    loops.push([base, base + 1, base + 2, base + 3]);
  }
  const mesh = built(pts, loops, (face, p) => {
    if (face === 4) return [0.9, 0.9];
    if (face < 2) return [(p[0] / 2) * boxA[0], (p[1] + 1) * boxA[1]];
    return [0.5 + (p[0] / 2) * boxB[0], 0.5 + p[1] * boxB[1]];
  });
  if (plate === 'tool') setPartRole(mesh, mesh.faces()[4] as number, 'tool');
  return mesh;
}

const run = (mesh: EditMesh, options = {}) => ok(measureSeamVisibility(mesh, options));

describe('seamVisibility: stated semantics and pinned edges', () => {
  it('a seam whose faces no viewpoint can face counts as hidden (counted 0 gives 1)', () => {
    const line: P3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ];
    const mesh = built(
      line,
      [
        [0, 1, 2],
        [2, 1, 3],
      ],
      (face) => (face === 0 ? [0, 0] : [0.5, 0.5]),
    );
    const r = run(mesh);
    expect(r.seams).toBe(1);
    expect(r.length).toBeCloseTo(1, 9);
    expect(r.hiddenScore).toBe(1);
    expect(r.chains[0]?.hidden).toBe(1);
    expect(r.exposed).toBe(0);
  });

  it('a zero-length seam makes a chain of hidden 1 and a total length of 0', () => {
    const points: P3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ];
    const mesh = built(
      points,
      [
        [0, 1, 2],
        [2, 1, 3],
      ],
      (face) => (face === 0 ? [0, 0] : [0.5, 0.5]),
    );
    const r = run(mesh);
    expect(r.length).toBe(0);
    expect(r.chains[0]?.hidden).toBe(1);
    expect(r.hiddenScore).toBe(1);
  });

  it('no seams scores 1 with no chains', () => {
    const mesh = built(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [2, 0, 0],
        [2, 1, 0],
      ],
      [
        [0, 1, 2, 3],
        [1, 4, 5, 2],
      ],
      (_, p) => [p[0] / 2, p[1]],
    );
    const r = run(mesh);
    expect(r.seams).toBe(0);
    expect(r.hiddenScore).toBe(1);
    expect(r.chains).toEqual([]);
    expect(r.exposed).toBe(0);
    expect(r.byIsland.map((i) => i.hidden)).toEqual([1]);
    expect(r.byIsland.map((i) => i.border)).toEqual([0]);
  });

  it('boundary edges are not seams; an edge is a seam when either end disagrees', () => {
    const r = run(strip());
    expect(r.seams).toBe(2);
    const points: P3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [2, 0, 0],
      [2, 1, 0],
    ];
    const shared = [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ];
    const oneEnd = built(points, shared, (face, p) =>
      face === 1 && p[1] === 1 ? [p[0] / 2 + 0.25, p[1]] : [p[0] / 2, p[1]],
    );
    const m = run(oneEnd);
    expect(m.seams).toBe(1);
    expect(m.length).toBeCloseTo(1, 9);
  });

  it('three islands around one vertex are three chains, one per island pair', () => {
    const points: P3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [-0.5, 0.87, 0],
      [-0.5, -0.87, 0],
    ];
    const mesh = built(
      points,
      [
        [0, 1, 2],
        [0, 2, 3],
        [0, 3, 1],
      ],
      (face, p) => [face * 0.3 + p[0] * 0.1, p[1] * 0.1],
    );
    const r = run(mesh);
    expect(r.seams).toBe(3);
    expect(r.chains).toHaveLength(3);
    expect(new Set(r.chains.map((c) => c.islands.join(':'))).size).toBe(3);
  });

  it('exposed counts chains strictly under minHidden and the default is 0.5', () => {
    const open = strip();
    const r = run(open);
    expect(r.views).toBe(96);
    expect(r.chains[0]?.hidden).toBe(0);
    expect(r.exposed).toBe(1);
    expect(run(open, { minHidden: 0 }).exposed).toBe(0);
    expect(run(open, { minHidden: 0.01 }).exposed).toBe(1);
  });

  it('worst is the midpoint of the most exposed edge of the chain', () => {
    const r = run(strip(undefined, undefined, 'form'));
    expect(r.chains).toHaveLength(1);
    const worst = r.chains[0]?.worst as readonly number[];
    expect(worst[0]).toBeCloseTo(1.5, 9);
    expect(worst[1]).toBeCloseTo(0, 9);
    expect(r.chains[0]?.hidden).toBeGreaterThan(0.3);
    expect(r.chains[0]?.hidden).toBeLessThan(0.7);
  });

  it('the default occluders are form and detail; tool is added on request (falsifier: tool blocks by default)', () => {
    const tool = strip(undefined, undefined, 'tool');
    const form = strip(undefined, undefined, 'form');
    expect(run(tool).hiddenScore).toBe(0);
    expect(run(form).hiddenScore).toBeGreaterThan(0.3);
    expect(run(tool, { occluders: ['form', 'detail', 'tool'] }).hiddenScore).toBeCloseTo(
      run(form).hiddenScore,
      9,
    );
  });

  it('an island without seams has hidden 1; the thin flags sit exactly on their thresholds', () => {
    const lone = run(strip(undefined, undefined, 'form'));
    expect(lone.byIsland).toHaveLength(3);
    const plate = lone.byIsland[2];
    expect(plate?.border).toBe(0);
    expect(plate?.hidden).toBe(1);
    const ratio = run(strip([0.375, 0.0625], [0.5, 0.5]), { resolution: 256 });
    expect(ratio.byIsland.map((i) => i.thin)).toEqual([true, false]);
    const edge = run(strip([0.375, 0.0625 * 1.0001], [0.5, 0.5]), { resolution: 256 });
    expect(edge.byIsland.map((i) => i.thin)).toEqual([false, false]);
    const small = run(strip([11 / 512, 11 / 512], [0.5, 0.5]), { resolution: 256 });
    expect(small.byIsland.map((i) => i.thin)).toEqual([true, false]);
    const fit = run(strip([6 / 256, 6 / 256], [0.5, 0.5]), { resolution: 256 });
    expect(fit.byIsland.map((i) => i.thin)).toEqual([false, false]);
  });

  it('non-finite positions are a model-precondition result, not a thrown RangeError', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const mesh = strip();
      const v = mesh.vertices()[4] as number;
      mesh.setPosition(v, bad, 0, 0);
      const r = measureSeamVisibility(mesh);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('model-precondition');
        expect((r.error.detail as { code: string }).code).toBe('non-finite-position');
        expect((r.error.detail as { vertex: number }).vertex).toBe(v);
      }
    }
  });

  it('limit: the two faces of a seam never occlude it, so a V-groove of open sheets scores 0', () => {
    const points: P3[] = [
      [-1, 0, 1],
      [0, 0, 0],
      [0, 1, 0],
      [-1, 1, 1],
      [1, 0, 1],
      [1, 1, 1],
    ];
    const groove = built(
      points,
      [
        [0, 1, 2, 3],
        [2, 1, 4, 5],
      ],
      (face, p) => [face * 0.5 + Math.abs(p[0]) * 0.4, p[1] * 0.4],
    );
    const r = run(groove);
    expect(r.seams).toBe(1);
    expect(r.hiddenScore).toBe(0);
  });
});
