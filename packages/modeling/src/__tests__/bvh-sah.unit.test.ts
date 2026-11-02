import { describe, expect, it } from 'vitest';
import { LEGACY_BVH, TriangleBvh } from '../compute/bvh';
import { model } from '../model';
import { sel } from '../selectors';

/**
 * U38 gate: binned SAH splits find the same closest hits and nearest points as median
 * splits (ties break by triangle index, so results do not depend on the tree) with fewer
 * node visits.
 */

function scene(): { positions: Float32Array; indices: Uint32Array } {
  const m = model();
  m.box({ size: [0.4, 0.04, 0.3] });
  m.bevel(sel.edges.all(), { width: 0.004, segments: 3 });
  for (let i = 0; i < 12; i++) {
    m.cylinder({
      radiusTop: 0.006,
      radiusBottom: 0.008,
      height: 0.02,
      radialSegments: 24,
      center: [-0.17 + i * 0.03, 0.03, 0.1 - (i % 3) * 0.1],
    });
    m.sphere({
      radius: 0.01,
      widthSegments: 12,
      heightSegments: 8,
      center: [-0.17 + i * 0.03, 0.05, 0],
    });
  }
  const positions: number[] = [];
  for (const f of m.editMesh.faces()) {
    const vs = m.editMesh.faceVertices(f);
    for (let k = 1; k + 1 < vs.length; k++) {
      for (const v of [vs[0], vs[k], vs[k + 1]] as number[])
        positions.push(...m.editMesh.position(v));
    }
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
  };
}

/** Deterministic rays from a sphere around the scene toward jittered points inside it. */
function rays(count: number): { o: number[]; d: number[] }[] {
  const out: { o: number[]; d: number[] }[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i * 2.399963) % (2 * Math.PI);
    const z = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - z * z);
    const o = [0.5 * r * Math.cos(a), 0.5 * z, 0.5 * r * Math.sin(a)];
    const target = [
      (((i * 37) % 101) / 101) * 0.4 - 0.2,
      (((i * 53) % 97) / 97) * 0.06 - 0.03,
      (((i * 71) % 89) / 89) * 0.3 - 0.15,
    ];
    const d = target.map((t, c) => t - (o[c] as number));
    const l = Math.hypot(...d);
    out.push({ o, d: d.map((x) => x / l) });
  }
  return out;
}

describe('TriangleBvh SAH (U38, gate)', () => {
  it('SAH answers every query like the median tree with at most 75% of its node visits; the median tree is the falsifier', () => {
    const { positions, indices } = scene();
    const sah = new TriangleBvh(positions, indices);
    const median = new TriangleBvh(positions, indices, { median: true });
    const queries = rays(4000);
    for (const { o, d } of queries) {
      expect(sah.raycast(o, d, 2)).toEqual(median.raycast(o, d, 2));
      expect(sah.raycast(o, d, 2, true) === undefined).toBe(
        median.raycast(o, d, 2, true) === undefined,
      );
    }
    for (const { o } of queries.slice(0, 1000)) expect(sah.nearest(o)).toEqual(median.nearest(o));
    expect(indices.length / 3).toBeGreaterThan(3000);
    // Measured: 145884 against 293460 visits (0.50).
    expect(sah.visits).toBeLessThan(0.75 * median.visits);
  });
});

describe('TriangleBvh legacy tree (shrinkwrap, layer)', () => {
  it('an unbounded ray finds the hit a bounded one finds (no slack: Infinity * 0 culled every box)', () => {
    const { positions, indices } = scene();
    const legacy = new TriangleBvh(positions, indices, LEGACY_BVH);
    let hits = 0;
    for (const { o, d } of rays(500)) {
      const bounded = legacy.raycast(o, d, 2);
      expect(legacy.raycast(o, d, Number.POSITIVE_INFINITY)).toEqual(bounded);
      if (bounded !== undefined) hits++;
    }
    expect(hits).toBeGreaterThan(100);
  });
});

describe('TriangleBvh SAH on faceted shapes: on- and off-surface queries (gate)', () => {
  /**
   * The query pattern that exposed tree-dependent results on the maid-whale G6 facets: points
   * on and 0.5 mm off the surface, nearest points and both-way vertical rays through shared
   * vertices and along vertical walls. Synthetic faceted shapes (a box turned off axis, a
   * sphere, a segmented cylinder) hold the same features at 2k triangles.
   */
  function faceted() {
    const m = model();
    m.box({ size: [0.4, 0.3, 0.3] });
    m.rotate(sel.all(), 'y', 17);
    const sphere = model();
    sphere.sphere({ radius: 0.2, widthSegments: 32, heightSegments: 24, center: [0.5, 0, 0] });
    m.append(sphere);
    const cylinder = model();
    cylinder.cylinder({
      radiusTop: 0.1,
      radiusBottom: 0.1,
      height: 0.4,
      radialSegments: 32,
      heightSegments: 8,
      center: [-0.5, 0, 0],
    });
    m.append(cylinder);
    const mesh = m.editMesh;
    const positions: number[] = [];
    for (const f of mesh.faces()) {
      const vs = mesh.faceVertices(f);
      for (let k = 1; k + 1 < vs.length; k++) {
        for (const v of [vs[0], vs[k], vs[k + 1]] as number[]) positions.push(...mesh.position(v));
      }
    }
    const points = mesh.vertices().map((v) => mesh.position(v));
    return {
      positions,
      indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
      points,
    };
  }
  const answers = (tree: TriangleBvh, points: readonly (readonly number[])[]) =>
    points.map((p) => {
      const out: unknown[] = [];
      for (const lift of [0, 0.0005, -0.0005]) {
        const q = [p[0] as number, (p[1] as number) + lift, p[2] as number];
        out.push(tree.nearest(q), tree.raycast(q, [0, 1, 0], Number.POSITIVE_INFINITY));
        out.push(tree.raycast(q, [0, -1, 0], Number.POSITIVE_INFINITY));
      }
      return JSON.stringify(out);
    });

  it('SAH and median trees answer byte-identically; without exact hits they differ (falsifier); vertex ties take the lowest triangle', () => {
    const { positions, indices, points } = faceted();
    const sah = answers(new TriangleBvh(positions, indices), points);
    const median = answers(new TriangleBvh(positions, indices, { median: true }), points);
    expect(points.length).toBeGreaterThan(1000);
    expect(sah.filter((a, i) => a !== median[i])).toEqual([]);
    // Round-off hits of rays almost in a facet's plane, kept by the pre-fix trees: the tree decides.
    const rawSah = answers(new TriangleBvh(positions, indices, { exactHits: false }), points);
    const rawMedian = answers(
      new TriangleBvh(positions, indices, { median: true, exactHits: false }),
      points,
    );
    // Measured: 408 of 1034 vertices differ.
    expect(rawSah.filter((a, i) => a !== rawMedian[i]).length).toBeGreaterThan(100);
    // A query at a vertex is (nearly) at distance 0 from every triangle at that position; the
    // triangles at exactly the least distance tie, and only the (distance, triangle) order settles them.
    const at = new Map<string, number[]>();
    for (let t = 0; t < indices.length / 3; t++) {
      for (let k = 0; k < 3; k++) {
        const key = positions.slice((t * 3 + k) * 3, (t * 3 + k) * 3 + 3).join();
        at.set(key, [...(at.get(key) ?? []), t]);
      }
    }
    let ties = 0;
    for (const tree of [
      new TriangleBvh(positions, indices),
      new TriangleBvh(positions, indices, { median: true }),
    ]) {
      for (const p of points) {
        const owners = at.get([...p].join()) ?? [];
        const d = owners.map((o) => tree.nearest(p, (t) => t === o)?.distanceSquared as number);
        const least = Math.min(...d);
        const tied = owners.filter((_, k) => d[k] === least);
        if (tied.length < 2) continue;
        ties++;
        expect(tree.nearest(p)?.triangle).toBe(Math.min(...tied));
      }
    }
    // Measured: 2064 tied queries over both trees.
    expect(ties).toBeGreaterThan(1000);
  });
});
