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

function block(size: [number, number, number], centre: [number, number, number]): Shape {
  return must(box({ size, frame: makeFrame(centre, [0, 0, 1], [1, 0, 0]), tol: 1e-8 }));
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
  const volume = must(measure(shape)).volume;
  expect(Math.abs(volume - expectedVolume) / expectedVolume).toBeLessThan(1e-9);
}

function holedFaces(shape: Shape): number {
  return shape.faces.filter((face) => face.loops.length > 1).length;
}

const PLATE = block([6, 4, 2], [0, 0, 0]); // z -1..1
const POCKET = block([1, 1, 1], [0, 0, 1]); // z 0.5..1.5: blind 0.5 deep in the plate top
const BAR = block([4, 0.4, 0.8], [0, 0, 1.2]); // z 0.8..1.6, lies across the pocket

describe('faces with holes are operands of later planar booleans', () => {
  const pocketed = (): Shape => must(booleanSolids(PLATE, POCKET, 'difference'));

  it('the pocketed plate has one holed face and is itself a valid operand', () => {
    expect(holedFaces(pocketed())).toBe(1);
  });

  it('union with a bar crossing the pocket: holed first operand', () => {
    const shape = must(booleanSolids(pocketed(), BAR, 'union'));
    expectSound(shape, 17, 47.5 + 1.28 - 0.24);
    expect(holedFaces(shape)).toBe(1);
  });

  it('union commutes: holed operand second', () => {
    const shape = must(booleanSolids(BAR, pocketed(), 'union'));
    expectSound(shape, 17, 47.5 + 1.28 - 0.24);
  });

  it('difference with a holed tool: a block minus the pocketed plate leaves a plug', () => {
    const block3 = block([3, 3, 3], [0, 0, 1.2]); // z -0.3..2.7
    const shape = must(booleanSolids(block3, pocketed(), 'difference'));
    expectSound(shape, 11, 3 * 3 * 1.7 + 0.5);
    expect(holedFaces(shape)).toBe(1);
  });

  it('union and intersection with a holed operand', () => {
    const crossing = block([1, 6, 1], [0.13, 0.17, 0.3]); // x -0.37..0.63, y -2.83..3.17, z -0.2..0.8
    const common = 1 * 4 * 1 - 0.87 * 1 * 0.3; // the part of the crossing inside the pocketed plate
    const united = must(booleanSolids(pocketed(), crossing, 'union'));
    expect(validate(united).ok).toBe(true);
    expect(boundaryEdges(united)).toBe(0);
    expect(must(measure(united)).volume).toBeCloseTo(47.5 + 6 - common, 9);
    const common3 = must(booleanSolids(pocketed(), crossing, 'intersect'));
    expect(validate(common3).ok).toBe(true);
    expect(boundaryEdges(common3)).toBe(0);
    expect(must(measure(common3)).volume).toBeCloseTo(common, 9);
  });

  it('a second pocket beside the first, then a groove across both', () => {
    const next = block([1, 0.7, 0.9], [2, 0.05, 1.05]); // offset so no plane meets a hole vertex
    const second = must(booleanSolids(pocketed(), next, 'difference'));
    expectSound(second, 16, 48 - 0.5 - 0.7 * 0.4);
    const grooved = must(booleanSolids(second, block([8, 0.4, 0.4], [0, 0, 1]), 'difference'));
    expect(validate(grooved).ok).toBe(true);
    expect(boundaryEdges(grooved)).toBe(0);
    // the groove removes 6 x 0.4 x 0.2 of plate, less 0.08 inside each earlier pocket
    expect(must(measure(grooved)).volume).toBeCloseTo(48 - 0.5 - 0.28 - (0.48 - 0.16), 9);
  });

  it('deliberate break: dropping one bridge piece of a holed operand leaves a hole in the shell', () => {
    const shape = must(booleanSolids(pocketed(), BAR, 'union'));
    const broken = {
      ...shape,
      shells: shape.shells.map((shell) => ({ faces: shell.faces.slice(1) })),
    };
    expect(validate(broken).ok).toBe(false);
  });
});
