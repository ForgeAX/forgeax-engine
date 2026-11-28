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

function block(
  size: [number, number, number],
  origin: [number, number, number],
  axis: [number, number, number] = [0, 0, 1],
): Shape {
  return must(box({ size, frame: makeFrame(origin, axis), tol: 1e-8 }));
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

const HOST = block([4, 4, 4], [0, 0, 0]);

describe('planar crossing solid difference', () => {
  it('cuts a rectangular through-slot with the exact closed-form volume', () => {
    const slot = block([0.6, 1.4, 6], [0, 0, 0]);
    const result = booleanSolids(HOST, slot, 'difference');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validate(result.value).ok).toBe(true);
    expect(boundaryEdges(result.value)).toBe(0);
    const expected = 64 - 0.6 * 1.4 * 4;
    expect(Math.abs(volume(result.value) - expected) / expected).toBeLessThan(1e-9);
    const broken = {
      ...result.value,
      shells: result.value.shells.map((shell) => ({
        faces: shell.faces.slice(1),
      })),
    };
    expect(validate(broken).ok).toBe(false);
  });

  it('cuts a blind rectangular pocket with the exact closed-form volume', () => {
    const pocket = block([1.2, 1.2, 1.4], [0, 0, 1.4]);
    const result = booleanSolids(HOST, pocket, 'difference');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validate(result.value).ok).toBe(true);
    expect(boundaryEdges(result.value)).toBe(0);
    const expected = 64 - 1.2 * 1.2 * 1.3;
    expect(Math.abs(volume(result.value) - expected) / expected).toBeLessThan(1e-9);
    const broken = {
      ...result.value,
      shells: result.value.shells.map((shell) => ({
        faces: shell.faces.slice(1),
      })),
    };
    expect(validate(broken).ok).toBe(false);
  });

  it('returns a specific tolerance reason for a near-coplanar tool face', () => {
    const pocket = block([1.2, 1.2, 1.4], [0, 0, 1.3 - 5e-9]);
    const result = booleanSolids(HOST, pocket, 'difference');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.reason).toBe('planar-cross-tolerance-contact');
  });

  it('accepts a repeated cut when the first result has a holed face', () => {
    const slot = must(booleanSolids(HOST, block([0.6, 1.4, 6], [0, 0, 0]), 'difference'));
    const pocket = block([1.2, 1.2, 1.4], [0, 0, 1.4]);
    const result = booleanSolids(slot, pocket, 'difference');
    expect(result.ok).toBe(true);
    if (result.ok) expect(validate(result.value).ok).toBe(true);
  });

  it('deliberate break: omitting each cutter plane leaves a non-closed shell', () => {
    const pocket = block([1.2, 1.2, 1.4], [0, 0, 1.4]);
    const cut = must(booleanSolids(HOST, pocket, 'difference'));
    const broken = {
      ...cut,
      shells: cut.shells.map((shell) => ({ faces: shell.faces.slice(1) })),
    };
    expect(validate(broken).ok).toBe(false);
  });
});
