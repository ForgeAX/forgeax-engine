import { describe, expect, it } from 'vitest';
import { type BakeExecutor, type BakeOptions, bakeMaps, bakeMapsParallel } from '../bake';
import { bakePhases } from '../compute/bake-ts';
import { WorkMeter } from '../compute/job';
import { type Model, model } from '../model';

/**
 * Bake issues name their findings as clusters (PIPELINE S5c request): a cage-clip or
 * stray-detail issue lists one cluster per feature or part with its sample count, worst
 * distance, bounds, affected faces and a fix hint, so a case bake report says where to look
 * and what to change. The per-group fields stay as they were (audit A1, A3).
 */

const step = (e0: number, e1: number, x: number) => Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
/** 45 degree frustum emboss at (cx, cy): top half-width 0.03 m, 0.03 m high. */
const stamp = (cx: number, cy: number) => (x: number, y: number) =>
  Math.max(0, Math.min(0.03, 0.06 - Math.max(Math.abs(x - cx), Math.abs(y - cy))));
/** Blind hole r 0.05 m, 0.1 m deep. */
const hole = (x: number, y: number) => -0.1 * step(0.054, 0.05, Math.hypot(x, y));

function heightfield(
  f: (x: number, y: number) => number,
  n: number,
  extra: number[][][] = [],
): Model {
  const m = model();
  const mesh = m.editMesh;
  const ids: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -0.5 + i / n;
      const y = -0.5 + j / n;
      ids.push(mesh.addVertex(x, y, f(x, y)));
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = ids[j * (n + 1) + i] as number;
      const b = ids[j * (n + 1) + i + 1] as number;
      const c = ids[(j + 1) * (n + 1) + i + 1] as number;
      const d = ids[(j + 1) * (n + 1) + i] as number;
      mesh.addFace([a, b, c]);
      mesh.addFace([a, c, d]);
    }
  }
  for (const quad of extra) {
    mesh.addFace(quad.map((p) => mesh.addVertex(p[0] as number, p[1] as number, p[2] as number)));
  }
  return m;
}

function plate(): Model {
  const m = model();
  const mesh = m.editMesh;
  const f = mesh.addFace([
    mesh.addVertex(-0.5, -0.5, 0),
    mesh.addVertex(0.5, -0.5, 0),
    mesh.addVertex(0.5, 0.5, 0),
    mesh.addVertex(-0.5, 0.5, 0),
  ]);
  if (!f.ok) throw f.error;
  for (const h of mesh.faceHalves(f.value)) {
    const [x, y] = mesh.position(mesh.hVert[h] as number) as [number, number, number];
    mesh.setCorner('uv0', h, [x + 0.5, y + 0.5]);
  }
  return m;
}

const settings = (detail: Model, extra: Partial<BakeOptions> = {}): BakeOptions => ({
  base: plate(),
  detail,
  maps: ['normal', 'height'],
  resolution: 64,
  filter: 'none',
  detailNormals: { mode: 'flat' },
  ...extra,
});

function bake(detail: Model, extra: Partial<BakeOptions> = {}) {
  const r = bakeMaps(settings(detail, extra));
  if (!r.ok) throw r.error;
  return r.value;
}

interface Bounds {
  readonly min: readonly number[];
  readonly max: readonly number[];
}
interface ClipCluster {
  readonly side: 'above' | 'below';
  readonly samples: number;
  readonly worst: number;
  readonly bounds: Bounds;
  readonly baseFaces: readonly number[];
  readonly detailFaces: readonly number[];
  readonly detailFaceCount: number;
  readonly hint: string;
}
interface StrayCluster {
  readonly part: number;
  readonly samples: number;
  readonly gap: number;
  readonly bounds: Bounds;
  readonly baseFaces: readonly number[];
  readonly detailFaces: readonly number[];
  readonly detailFaceCount: number;
  readonly hint: string;
}

const clustersOf = <T>(r: ReturnType<typeof bake>, code: string): readonly T[] =>
  (r.issues.find((i) => i.code === code)?.detail.clusters ?? []) as readonly T[];

describe('cage-clip clusters (PIPELINE S5c)', () => {
  it('one cluster per clipped feature, with count, worst distance, bounds, faces and a raise-offset hint', {
    timeout: 60000,
  }, () => {
    const two = (x: number, y: number) => stamp(-0.3, -0.3)(x, y) + stamp(0.3, 0.3)(x, y);
    const r = bake(heightfield(two, 128), { cage: { offset: 0.01, maxRay: 0.1 } });
    const issue = r.issues.find((i) => i.code === 'cage-clip');
    // The per-group fields are unchanged.
    expect(issue?.detail).toMatchObject({ subject: '', offset: 0.01, maxRay: 0.1 });
    expect(issue?.detail.clipped).toBe(r.provenance.groups[0]?.clipped);
    expect(typeof issue?.detail.hint).toBe('string');
    const clusters = clustersOf<ClipCluster>(r, 'cage-clip');
    expect(clusters).toHaveLength(2);
    // Sorted by sample count, then by bounds, so equal bakes list equal clusters.
    expect(clusters.reduce((n, c) => n + c.samples, 0)).toBe(r.provenance.groups[0]?.clipped);
    for (const c of clusters) {
      expect(c.side).toBe('above');
      expect(c.samples).toBeGreaterThan(0);
      // The stamp top is 0.03 m: 0.02 m beyond a cage starting at 0.01 m.
      expect(c.worst).toBeGreaterThan(0.015);
      expect(c.worst).toBeLessThan(0.025);
      expect(c.baseFaces).toEqual([0]);
      expect(c.detailFaces.length).toBeGreaterThan(0);
      expect(c.detailFaceCount).toBeGreaterThanOrEqual(c.detailFaces.length);
      expect(c.hint).toContain('offset');
      expect(c.hint).toContain('0.03');
    }
    const centers = clusters.map((c) => [
      ((c.bounds.min[0] as number) + (c.bounds.max[0] as number)) / 2,
      ((c.bounds.min[1] as number) + (c.bounds.max[1] as number)) / 2,
    ]);
    centers.sort((a, b) => (a[0] as number) - (b[0] as number));
    expect(centers[0]?.[0]).toBeCloseTo(-0.3, 1);
    expect(centers[0]?.[1]).toBeCloseTo(-0.3, 1);
    expect(centers[1]?.[0]).toBeCloseTo(0.3, 1);
    expect(centers[1]?.[1]).toBeCloseTo(0.3, 1);
    for (const c of clusters) {
      expect((c.bounds.max[0] as number) - (c.bounds.min[0] as number)).toBeLessThan(0.2);
    }
    expect(r.provenance.groups[0]?.clipClusters).toEqual(clusters.map(({ hint, ...c }) => c));
  });

  it('a hole deeper than maxRay is a below cluster whose hint raises maxRay', {
    timeout: 60000,
  }, () => {
    const r = bake(heightfield(hole, 128), { cage: { offset: 0.05, maxRay: 0.1 } });
    const clusters = clustersOf<ClipCluster>(r, 'cage-clip');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.side).toBe('below');
    expect(clusters[0]?.hint).toContain('maxRay');
    expect(clusters[0]?.worst).toBeGreaterThan(0.03);
  });

  it('a cage that covers the feature has no clusters and no issue (falsifier)', {
    timeout: 60000,
  }, () => {
    const r = bake(heightfield(stamp(0, 0), 128), { cage: { offset: 0.05, maxRay: 0.1 } });
    expect(r.issues.find((i) => i.code === 'cage-clip')).toBeUndefined();
    expect(r.provenance.groups[0]?.clipClusters).toEqual([]);
  });

  it('serial and Worker-split bakes list the same clusters', { timeout: 60000 }, async () => {
    const options = settings(heightfield(stamp(0.2, -1 / 6), 32), {
      resolution: 96,
      cage: { offset: 0.01, maxRay: 0.1 },
    });
    const serial = bakeMaps(options);
    if (!serial.ok) throw serial.error;
    // Every tile row sampled by its own prepared Baker, as a Worker pool would; the stamp straddles the row border at y = -1/6 inside one grid cell.
    const split: BakeExecutor = async (request, rows, { budget }) => {
      const parts = rows.map((row) => {
        const prepared = bakePhases.prepare(request, new WorkMeter(Number.POSITIVE_INFINITY));
        if (!prepared.ok) throw prepared.error;
        const part = bakePhases.rows(prepared.value, [row], new WorkMeter(budget));
        if (!part.ok) throw part.error;
        return part.value;
      });
      return { ok: true, parts, work: 0 };
    };
    const parallel = await bakeMapsParallel(options, split);
    if (!parallel.ok) throw parallel.error;
    expect(clustersOf<ClipCluster>(parallel.value, 'cage-clip')).toEqual(
      clustersOf<ClipCluster>(serial.value, 'cage-clip'),
    );
    expect(clustersOf<ClipCluster>(serial.value, 'cage-clip')).toHaveLength(1);
    const again = bakeMaps(options);
    if (!again.ok) throw again.error;
    expect(again.value.provenance.groups).toEqual(serial.value.provenance.groups);
  });
});

describe('stray-detail clusters (PIPELINE S5c)', () => {
  /** A 0.2 m square tilted 30 degrees, centered 0.1 m above the plate. */
  const hovering = (cx: number): number[][][] => {
    const a = Math.PI / 6;
    return [
      [
        [-0.1, -0.1],
        [0.1, -0.1],
        [0.1, 0.1],
        [-0.1, 0.1],
      ].map(([x, y]) => [
        cx + (x as number),
        (y as number) * Math.cos(a),
        0.1 + (y as number) * Math.sin(a),
      ]),
    ];
  };

  it('names the floater island with its samples, gap, bounds, faces and a fix hint', {
    timeout: 60000,
  }, () => {
    const detail = heightfield(() => 0, 64, hovering(0));
    const r = bake(detail);
    const issue = r.issues.find((i) => i.code === 'stray-detail');
    expect(issue?.detail).toMatchObject({ subject: '', parts: 1 });
    expect(typeof issue?.detail.hint).toBe('string');
    const clusters = clustersOf<StrayCluster>(r, 'stray-detail');
    expect(clusters).toHaveLength(1);
    const c = clusters[0] as StrayCluster;
    expect(c.samples).toBe(issue?.detail.samples);
    expect(c.gap).toBeCloseTo(0.05, 3);
    // Face ids are FXEM face ids of the exported mesh; the island is the one quad.
    expect(c.detailFaces).toHaveLength(1);
    expect(c.detailFaceCount).toBe(1);
    expect(c.baseFaces).toEqual([0]);
    expect(c.bounds.min[0]).toBeCloseTo(-0.1, 3);
    expect(c.bounds.max[0]).toBeCloseTo(0.1, 3);
    expect(c.bounds.min[2]).toBeCloseTo(0.05, 3);
    expect(c.bounds.max[2]).toBeCloseTo(0.15, 3);
    expect(c.hint).toContain('tags.floater');
    expect(c.hint).toContain('groupPrefix');
    expect(c.hint).toContain('remove');
    expect(r.provenance.groups[0]?.stray.clusters).toEqual(clusters.map(({ hint, ...s }) => s));
  });

  it('an attached stamp has no stray clusters (falsifier)', { timeout: 60000 }, () => {
    const r = bake(heightfield(stamp(0, 0), 64));
    expect(r.issues.find((i) => i.code === 'stray-detail')).toBeUndefined();
    expect(r.provenance.groups[0]?.stray.clusters).toEqual([]);
  });
});
