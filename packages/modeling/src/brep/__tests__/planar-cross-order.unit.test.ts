import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { steppedL } from '../../../examples/gallery/solids';
import { buildBracket } from '../../../examples/planar-boolean/bracket';
import type { Shape } from '../types';

// Output order of inputs the planar crossing boolean already handled is part of its contract: quad
// meshing reads faces, loops and edge ids in this order. A reorder must fail here, not downstream.

const point = (shape: Shape, vertex: number): string =>
  (shape.vertices[vertex]?.p ?? []).map((x) => x.toFixed(4)).join(',');

function orderedSignature(shape: Shape): string {
  const lines: string[] = [];
  shape.faces.forEach((face, fi) => {
    const kind = shape.surfaces[face.surface]?.kind ?? '?';
    const loops = face.loops.map((l) =>
      (shape.loops[l]?.coedges ?? [])
        .map((co) => {
          const coedge = shape.coedges[co];
          const edge = coedge ? shape.edges[coedge.edge] : undefined;
          if (!coedge || !edge) return '?';
          return point(shape, coedge.reversed ? edge.v1 : edge.v0);
        })
        .join(' '),
    );
    lines.push(`F${fi} ${kind} ${face.role} ${face.reversed} :: ${loops.join(' | ')}`);
  });
  shape.edges.forEach((edge, ei) => {
    lines.push(`E${ei} ${point(shape, edge.v0)} -> ${point(shape, edge.v1)}`);
  });
  return lines.join('\n');
}

const digest = (shape: Shape): string =>
  createHash('sha256').update(orderedSignature(shape)).digest('hex');

const bracket = (name: string): Shape => {
  const stage = buildBracket().find((s) => s.name === name);
  if (stage === undefined) throw new Error(name);
  return stage.shape;
};

describe('planar crossing boolean output order is pinned for handled inputs', () => {
  it('keeps the stepped-L union face, loop and edge order', () => {
    const shape = steppedL();
    expect([shape.faces.length, shape.edges.length]).toEqual([12, 30]);
    expect(digest(shape)).toBe('9a7c89fe8020f643dc251035b481f4810b4c24f05962fa3cf4d5e7d27d8b0161');
  });

  it('keeps the bracket pocket face, loop and edge order', () => {
    const shape = bracket('pocket');
    expect([shape.faces.length, shape.edges.length]).toEqual([32, 87]);
    expect(digest(shape)).toBe('a498252b96e6578552f15e7133b6dabcb644ecc504cdb32a9e1db04c22f82000');
  });
});
