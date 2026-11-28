import { describe, expect, it } from 'vitest';
import { box, cylinder, sphere } from '../../build';
import type { Frame } from '../../types';
import { clearanceBetween } from '../clearance';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const at = (x: number, y = 0, z = 0): Frame => ({
  o: [x, y, z],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
});
const cube = (x: number, size = 2) => must(box({ size: [size, size, size], frame: at(x) }));

describe('clearanceBetween', () => {
  it('measures the gap and witness points of two apart boxes', () => {
    const c = must(clearanceBetween(cube(0), cube(5)));
    expect(c.kind).toBe('clear');
    expect(c.gap).toBeCloseTo(3, 8);
    expect(Math.abs(c.pointA[0] - c.pointB[0])).toBeCloseTo(3, 8);
  });

  it('calls face-to-face boxes touching, with no certified depth', () => {
    const c = must(clearanceBetween(cube(0), cube(2)));
    expect(c.kind).toBe('touching');
    expect(c.depth).toBe(0);
  });

  it('calls a sphere tangent to a box touching', () => {
    const s = must(sphere({ radius: 1, frame: at(2) }));
    expect(must(clearanceBetween(cube(0), s)).kind).toBe('touching');
  });

  it('certifies interference and a lower bound of its depth', () => {
    const c = must(clearanceBetween(cube(0), cube(1.5)));
    expect(c.kind).toBe('interfering');
    expect(c.depth).toBeGreaterThan(0.4);
    expect(c.depth).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(c.deepest).toBeDefined();
  });

  it('detects a pin crossing a wall through a face sample', () => {
    const wall = must(box({ size: [10, 10, 1], frame: at(0) }));
    const pin = must(cylinder({ radius: 0.5, height: 4, frame: at(0) }));
    const c = must(clearanceBetween(wall, pin));
    expect(c.kind).toBe('interfering');
  });

  it('reports nested solids as contained with the wall gap', () => {
    const c = must(clearanceBetween(cube(0, 10), cube(0, 2)));
    expect(c.kind).toBe('contained');
    expect(c.gap).toBeCloseTo(4, 8);
  });

  it('fails closed on an open solid', () => {
    const a = cube(0);
    const open = { ...a, coedges: a.coedges.slice(1) };
    const r = clearanceBetween(open, cube(5));
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.error.detail as { reason?: string }).reason).toBe('clearance-open-shape');
  });
});
