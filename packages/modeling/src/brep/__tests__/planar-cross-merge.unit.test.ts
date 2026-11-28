import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box } from '../build';
import { measure } from '../measure';
import { makeFrame } from '../surfaces';
import { tessellate } from '../tessellate';
import type { Face, Shape } from '../types';
import { validate } from '../validate';

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function block(size: [number, number, number], origin: [number, number, number]): Shape {
  return must(box({ size, frame: makeFrame(origin, [0, 0, 1], [1, 0, 0]), tol: 1e-8 }));
}

function volume(shape: Shape): number {
  return must(measure(shape)).volume;
}

function outwardNormal(shape: Shape, face: Face): [number, number, number] {
  const surface = shape.surfaces[face.surface];
  if (surface?.kind !== 'plane') throw new Error('planar faces only');
  const z = surface.frame.z;
  return face.reversed ? [-z[0], -z[1], -z[2]] : [z[0], z[1], z[2]];
}

function faceEdges(shape: Shape, face: Face): number[] {
  return face.loops.flatMap((li) =>
    (shape.loops[li]?.coedges ?? []).map((ci) => shape.coedges[ci]?.edge ?? -1),
  );
}

/** Pairs of faces that share an edge and have the same outward normal (redundant seams). */
function coplanarNeighbourPairs(shape: Shape): number {
  const owners = new Map<number, number[]>();
  shape.faces.forEach((face, fi) => {
    for (const edge of faceEdges(shape, face)) owners.set(edge, [...(owners.get(edge) ?? []), fi]);
  });
  let pairs = 0;
  for (const faces of owners.values()) {
    if (faces.length !== 2) continue;
    const a = outwardNormal(shape, shape.faces[faces[0] as number] as Face);
    const b = outwardNormal(shape, shape.faces[faces[1] as number] as Face);
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 1 - 1e-9) pairs += 1;
  }
  return pairs;
}

/** Vertices that no longer bend any face boundary: used by fewer than three distinct planes. */
function seamVertices(shape: Shape): number {
  const planes = new Map<number, Set<string>>();
  for (const face of shape.faces) {
    const n = outwardNormal(shape, face);
    const key = n.map((c) => Math.round(c * 1e6)).join(',');
    for (const li of face.loops) {
      for (const ci of shape.loops[li]?.coedges ?? []) {
        const edge = shape.edges[shape.coedges[ci]?.edge ?? -1];
        if (edge === undefined) continue;
        for (const v of [edge.v0, edge.v1]) {
          const set = planes.get(v) ?? new Set<string>();
          set.add(key);
          planes.set(v, set);
        }
      }
    }
  }
  return [...planes.values()].filter((set) => set.size < 3).length;
}

function boundaryEdges(shape: Shape): number {
  const mesh = must(tessellate(shape));
  const uses = new Map<string, number>();
  for (const face of mesh.faces()) {
    const vertices = mesh.faceVertices(face);
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i] as number;
      const b = vertices[(i + 1) % vertices.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter((count) => count !== 2).length;
}

const HOST = block([4, 4, 4], [0, 0, 0]);
const BAR = block([4, 1, 1], [0, 0, 0]);

const cases = [
  {
    name: 'through-slot difference',
    run: () => booleanSolids(HOST, block([0.6, 1.4, 6], [0, 0, 0]), 'difference'),
    faces: 10,
    volume: 64 - 0.6 * 1.4 * 4,
  },
  {
    name: 'blind pocket difference',
    run: () => booleanSolids(HOST, block([1.2, 1.2, 1.4], [0, 0, 1.4]), 'difference'),
    faces: 11,
    volume: 64 - 1.2 * 1.2 * 1.3,
  },
  {
    name: 'T-shaped block union',
    run: () => booleanSolids(BAR, block([1, 2, 1.3], [0.13, 1.2, 0.17]), 'union'),
    faces: 12,
    volume: 6.306,
  },
  {
    name: 'stepped L-bracket union',
    run: () => booleanSolids(BAR, block([1, 2, 1.3], [1.45, 1, 0.17]), 'union'),
    faces: 12,
    volume: 6.11,
  },
  {
    name: 'T-shaped block intersection',
    run: () => booleanSolids(BAR, block([1, 2, 1.3], [0.13, 1.2, 0.17]), 'intersect'),
    faces: 6,
    volume: 0.294,
  },
  {
    name: 'stepped L-bracket intersection',
    run: () => booleanSolids(BAR, block([1, 2, 1.3], [1.45, 1, 0.17]), 'intersect'),
    faces: 6,
    volume: 0.49,
  },
] as const;

describe('planar crossing result is merged to minimal coplanar faces', () => {
  for (const c of cases) {
    it(`${c.name}: ${c.faces} faces, no coplanar seams, volume and closure unchanged`, () => {
      const shape = must(c.run());
      expect(shape.faces.length).toBe(c.faces);
      expect(coplanarNeighbourPairs(shape)).toBe(0);
      expect(seamVertices(shape)).toBe(0);
      expect(validate(shape).ok).toBe(true);
      expect(boundaryEdges(shape)).toBe(0);
      expect(Math.abs(volume(shape) - c.volume) / c.volume).toBeLessThan(1e-9);
    });
  }

  it('a through-slot leaves the top and bottom faces with one hole each', () => {
    const shape = must(booleanSolids(HOST, block([0.6, 1.4, 6], [0, 0, 0]), 'difference'));
    const holed = shape.faces.filter((face) => face.loops.length === 2);
    expect(holed.length).toBe(2);
  });

  it('a groove across a whole face splits it into two separate faces', () => {
    const shape = must(booleanSolids(HOST, block([0.6, 6, 1.4], [0, 0, 1.4]), 'difference'));
    expect(shape.faces.length).toBe(10);
    expect(coplanarNeighbourPairs(shape)).toBe(0);
  });
});
