import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box } from '../build';
import { measure } from '../measure';
import { makeFrame } from '../surfaces';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { validate } from '../validate';

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Axis-aligned box given by its centre. */
function block(size: [number, number, number], centre: [number, number, number]): Shape {
  return must(box({ size, frame: makeFrame(centre, [0, 0, 1], [1, 0, 0]), tol: 1e-8 }));
}

function volume(shape: Shape): number {
  return must(measure(shape)).volume;
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

function expectSound(shape: Shape, faces: number, expectedVolume: number): void {
  expect(shape.faces.length).toBe(faces);
  expect(validate(shape).ok).toBe(true);
  expect(boundaryEdges(shape)).toBe(0);
  expect(Math.abs(volume(shape) - expectedVolume) / expectedVolume).toBeLessThan(1e-9);
}

function reasonOf(result: { ok: boolean; error?: unknown }): string | undefined {
  const error = result.error as { detail?: { reason?: string } } | undefined;
  return result.ok ? undefined : error?.detail?.reason;
}

const PLATE = block([6, 4, 2], [0, 0, 0]);
const GROOVE = block([0.8, 6, 1.2], [-1, 0, 0.8]); // open at the top, across the full width
const EDGE_BOSS = block([1.2, 1.2, 1.5], [1.5, 2, 1.05]); // overhangs the +y side
const POCKET = block([0.5, 0.5, 1], [1.5, 2, 1.8]); // blind pocket in the boss top

describe('bracket: slot by difference, boss by union, chained', () => {
  const grooved = (): Shape => must(booleanSolids(PLATE, GROOVE, 'difference'));
  const bossed = (): Shape => must(booleanSolids(grooved(), EDGE_BOSS, 'union'));

  it('stage 1: the groove leaves a 10-face plate', () => {
    expectSound(grooved(), 10, 48 - 0.8 * 4 * 0.8);
  });

  it('stage 2: a boss unioned onto the non-convex grooved plate', () => {
    expectSound(bossed(), 16, 48 - 2.56 + 1.2 * 1.2 * 1.5 - 0.6 * 1.2 * 0.7);
  });

  it('stage 3: a pocket cut into the boss of the chained result', () => {
    const pocketed = must(booleanSolids(bossed(), POCKET, 'difference'));
    expectSound(pocketed, 21, 48 - 2.56 + 1.2 * 1.2 * 1.5 - 0.6 * 1.2 * 0.7 - 0.5 * 0.5 * 0.5);
  });

  it('commutes: boss first operand, grooved plate second', () => {
    const shape = must(booleanSolids(EDGE_BOSS, grooved(), 'union'));
    expectSound(shape, 16, 48 - 2.56 + 1.2 * 1.2 * 1.5 - 0.6 * 1.2 * 0.7);
  });

  it('intersection of the grooved plate with a slab keeps only the common volume', () => {
    const slab = block([3, 4, 2], [-0.5, 1, 0.5]);
    const shape = must(booleanSolids(grooved(), slab, 'intersect'));
    expectSound(shape, 10, 3 * 3 * 1.5 - 0.8 * 3 * 0.8);
  });
});

describe('non-convex planar operands fail closed outside the supported scope', () => {
  it('refuses a through-cut that would split the plate into two solids', () => {
    const split = booleanSolids(PLATE, block([0.8, 6, 3], [-1, 0, 0]), 'difference');
    expect(reasonOf(split)).toBe('planar-cross-multi-component-result');
  });

  it('accepts a non-convex operand that still has holed faces', () => {
    const holed = must(booleanSolids(PLATE, block([0.6, 1.4, 6], [0, 0, 0]), 'difference'));
    expect(holed.faces.filter((face) => face.loops.length > 1).length).toBe(2);
    const result = must(booleanSolids(holed, EDGE_BOSS, 'union'));
    expect(validate(result).ok).toBe(true);
    expect(boundaryEdges(result)).toBe(0);
  });
});
