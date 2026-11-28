import { describe, expect, it } from 'vitest';
import { scaledJacobian } from '../quad';
import { relaxOwned } from '../quad-relax';
import type { P3 } from '../vec';

// A 3x3 grid of quads with the centre vertex (4) owned; the centre sits off-centre so relaxation moves it.
const pos: P3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [2, 0, 0],
  [0, 1, 0],
  [1.9, 1.1, 0],
  [2, 1, 0],
  [0, 2, 0],
  [1, 2, 0],
  [2, 2, 0],
];
const quads = [
  [0, 1, 4, 3],
  [1, 2, 5, 4],
  [3, 4, 7, 6],
  [4, 5, 8, 7],
] as [number, number, number, number][];
const at = (v: number): P3 => pos[v] as P3;

describe('relaxOwned (split-3 interior relaxation)', () => {
  it('moves only owned vertices and keeps shared and ring vertices fixed', () => {
    const moved = relaxOwned(quads, [4], at, scaledJacobian);
    expect([...moved.keys()]).toEqual([4]);
  });

  it('never lowers the face minimum scaled Jacobian and never folds a quad', () => {
    const moved = relaxOwned(quads, [4], at, scaledJacobian);
    const p = (v: number): P3 => moved.get(v) ?? at(v);
    const before = Math.min(...quads.map((q) => scaledJacobian(q.map(at))));
    const after = Math.min(...quads.map((q) => scaledJacobian(q.map(p))));
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeGreaterThan(0);
  });

  it('returns no moves when the owned set is empty (no interior, nothing to relax)', () => {
    expect(relaxOwned(quads, [], at, scaledJacobian).size).toBe(0);
  });
});

describe('trimmedPlaneEdges (local density selector)', () => {
  it('selects trimmed planar face edges and leaves the untrimmed cylinder wall out', async () => {
    const { trimmedPlaneEdges } = await import('../quad');
    const { booleanSolids } = await import('../boolean');
    const { box, cylinder } = await import('../build');
    const { faceLoops } = await import('../faces');
    const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    };
    const shape = must(
      booleanSolids(
        must(box({ size: [2.6, 1, 1], label: 'box' })),
        must(cylinder({ radius: 0.3, height: 3, label: 'cyl' })),
        'difference',
      ),
    );
    const selected = trimmedPlaneEdges(shape);
    expect(selected.size).toBeGreaterThan(0);
    // A curved face's edge is refined only when a trimmed plane also uses it (the shared rim).
    // Its free wall edges (used by no planar face) must stay at base density.
    const planeEdges = new Set<number>();
    for (let f = 0; f < shape.faces.length; f++) {
      const face = shape.faces[f] as { surface: number };
      if ((shape.surfaces[face.surface] as { kind: string }).kind !== 'plane') continue;
      const { outer, holes } = faceLoops(shape, f);
      for (const loop of [outer, ...holes]) {
        for (const c of loop) planeEdges.add((shape.coedges[c] as { edge: number }).edge);
      }
    }
    let freeWall = 0;
    for (let f = 0; f < shape.faces.length; f++) {
      const face = shape.faces[f] as { surface: number };
      if ((shape.surfaces[face.surface] as { kind: string }).kind === 'plane') continue;
      const { outer, holes } = faceLoops(shape, f);
      for (const loop of [outer, ...holes]) {
        for (const c of loop) {
          const edge = (shape.coedges[c] as { edge: number }).edge;
          if (planeEdges.has(edge)) continue;
          freeWall++;
          expect(selected.has(edge)).toBe(false);
        }
      }
    }
    expect(freeWall).toBeGreaterThan(0);
  });
});
