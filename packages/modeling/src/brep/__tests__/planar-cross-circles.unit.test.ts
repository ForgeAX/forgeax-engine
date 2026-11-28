import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { measure } from '../measure';
import { makeFrame } from '../surfaces';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { validate } from '../validate';

type Vec = readonly [number, number, number];

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const block = (size: Vec, centre: Vec): Shape =>
  must(box({ size, frame: makeFrame(centre, [0, 0, 1], [1, 0, 0]), tol: 1e-8 }));
const drill = (radius: number, x: number, y: number): Shape =>
  must(cylinder({ radius, height: 2, frame: makeFrame([x, y, 0], [0, 0, 1]) }));

function openEdges(shape: Shape): number {
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
  return [...uses.values()].filter((n) => n !== 2).length;
}

function sound(shape: Shape, volume: number, area: number): void {
  expect(validate(shape).ok).toBe(true);
  expect(openEdges(shape)).toBe(0);
  const m = must(measure(shape));
  expect(Math.abs(m.volume - volume) / volume).toBeLessThan(1e-9);
  expect(Math.abs(m.area - area) / area).toBeLessThan(1e-9);
}

const R = 0.1;
const HOLE_VOLUME = Math.PI * R * R * 0.5;
// A through hole removes two cap discs and adds its wall.
const HOLE_AREA = -2 * Math.PI * R * R + 2 * Math.PI * R * 0.5;
const PLATE = (): Shape => block([2, 2, 0.5], [0, 0, 0]);
// Slot x 0.3..1.2, y -0.1..0.1 notches the plate edge at x = 1 over 0.7.
const SLOT = (): Shape => block([0.9, 0.2, 2], [0.75, 0, 0]);
const SLOT_VOLUME = 0.7 * 0.2 * 0.5;
const SLOT_AREA = -2 * 0.7 * 0.2 - 0.2 * 0.5 + 2 * 0.7 * 0.5 + 0.2 * 0.5;
const holed = (): Shape => must(booleanSolids(PLATE(), drill(R, -0.5, 0), 'difference'));

describe('planar crossing that carries circle holes', () => {
  it('notches both caps of a drilled plate and keeps the hole a circle', () => {
    const shape = must(booleanSolids(holed(), SLOT(), 'difference'));
    sound(shape, 2 - HOLE_VOLUME - SLOT_VOLUME, 12 + HOLE_AREA + SLOT_AREA);
    const circles = shape.loops.filter((loop) => {
      if (loop.outer || loop.coedges.length !== 1) return false;
      const edge = shape.edges[shape.coedges[loop.coedges[0] as number]?.edge ?? -1];
      return edge !== undefined && shape.curves[edge.curve]?.kind === 'circle';
    });
    expect(circles).toHaveLength(2);
    expect(shape.surfaces.filter((s) => s.kind === 'cylinder')).toHaveLength(1);
  });

  it('serves as the operand of a further drilling', () => {
    const slotted = must(booleanSolids(holed(), SLOT(), 'difference'));
    const shape = must(booleanSolids(slotted, drill(R, -0.5, 0.6), 'difference'));
    sound(shape, 2 - 2 * HOLE_VOLUME - SLOT_VOLUME, 12 + 2 * HOLE_AREA + SLOT_AREA);
  });

  it('gives the same solid in either order', () => {
    // At y = 0 the hole is tangent to the slot's side planes, which the drill-after-slot path still
    // refuses (brep-ssi-tangent), so order independence is checked with the hole off the slot line.
    const volume = 2 - HOLE_VOLUME - SLOT_VOLUME;
    const area = 12 + HOLE_AREA + SLOT_AREA;
    const first = must(booleanSolids(PLATE(), drill(R, -0.5, 0.5), 'difference'));
    sound(must(booleanSolids(first, SLOT(), 'difference')), volume, area);
    const slotted = must(booleanSolids(PLATE(), SLOT(), 'difference'));
    sound(must(booleanSolids(slotted, drill(R, -0.5, 0.5), 'difference')), volume, area);
  });

  it('unions a clear tenon in either operand order', () => {
    const tenon = (): Shape => block([0.4, 0.4, 0.4], [0.7, 0.6, 0.45]);
    // The tenon top replaces the top-cap patch under its base; only its four sides add area.
    const area = 12 + HOLE_AREA + 4 * 0.16;
    const volume = 2 - HOLE_VOLUME + 0.4 ** 3;
    sound(must(booleanSolids(holed(), tenon(), 'union')), volume, area);
    sound(must(booleanSolids(tenon(), holed(), 'union')), volume, area);
  });

  it('drops the hole wall when the hole lies outside an intersection', () => {
    const shape = must(booleanSolids(SLOT(), holed(), 'intersect'));
    sound(shape, SLOT_VOLUME, 2 * 0.7 * 0.2 + 2 * 0.7 * 0.5 + 2 * 0.2 * 0.5);
  });

  it('refuses a slot whose bounded chord reaches the hole', () => {
    const through = block([1.6, 0.2, 2], [0.4, 0, 0]);
    const result = booleanSolids(holed(), through, 'difference');
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.detail).toMatchObject({ reason: 'planar-chord-with-curved-solid' });
  });
});
