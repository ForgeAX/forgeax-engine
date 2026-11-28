import { describe, expect, it } from 'vitest';
import { box } from '../build.ts';
import { facesUsingVertex, presplitEdges } from '../nurbs-presplit.ts';
import type { Shape } from '../types.ts';

function unwrap(r: { ok: boolean; value?: unknown }): Shape {
  if (!r.ok) throw new Error('fixture build failed');
  return r.value as Shape;
}

// Unit box: each vertical-ish edge between two faces is a shared boundary.
const cube = unwrap(box({ size: [1, 1, 1] }) as never);

function edgeBetweenFaces(shape: Shape): { edge: number; faces: number[] } | undefined {
  // Find an edge whose two adjacent faces are distinct; its midpoint is a legal split site.
  for (let ei = 0; ei < shape.edges.length; ei++) {
    const e = shape.edges[ei];
    if (!e || e.curve < 0) continue;
    const faces = [
      ...new Set([...facesUsingVertex(shape, e.v0), ...facesUsingVertex(shape, e.v1)]),
    ];
    if (faces.length >= 2) return { edge: ei, faces };
  }
  return undefined;
}

describe('presplitEdges', () => {
  it('inserts one vertex per site and shares it with every face bounded by the edge', () => {
    const pick = edgeBetweenFaces(cube);
    expect(pick).toBeDefined();
    if (!pick) return;
    const e = cube.edges[pick.edge];
    if (!e) return;
    const mid = (e.t0 + e.t1) / 2;
    const r = presplitEdges(cube, [{ edge: pick.edge, t: mid }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value.vertices[0] as number;
    // Both faces that used the original edge must now reference the inserted vertex.
    const before = facesUsingVertex(r.value.shape, v);
    expect(before.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a split parameter at an edge end (deliberate break: must not return ok)', () => {
    const pick = edgeBetweenFaces(cube);
    if (!pick) throw new Error('no shared edge');
    const e = cube.edges[pick.edge];
    if (!e) throw new Error('no edge');
    const r = presplitEdges(cube, [{ edge: pick.edge, t: e.t0 }]);
    expect(r.ok).toBe(false);
  });
});
