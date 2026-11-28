import { describe, expect, it } from 'vitest';
import { buildSweepShowcase } from '../../../examples/sweep/showcase';
import { filletPrism } from '../fillet-prism';
import { quadrangulate } from '../index';
import { measure } from '../measure';
import type { Shape } from '../types';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

// Filleted L-bracket from examples/brep-offset-solids: face 0 is outer-only and planar, with an odd
// forced ring sum. Ring parity is owned by the count solve, so quad-dominant closes it.
function bracket(): Shape {
  return must(
    filletPrism({
      profile: [
        [0, 0],
        [3, 0],
        [3, 1],
        [1, 1],
        [1, 3],
        [0, 3],
      ],
      height: 1.5,
      radii: [0, 0, 0.3, 0, 0.5, 0],
      label: 'filleted-bracket',
    }),
  );
}

function sizeOf(shape: Shape): number {
  return Math.sqrt(must(measure(shape)).area) / 10;
}

describe('quad count solve: outer-only ring parity', () => {
  it('closes the filleted bracket face 0 in quad-dominant with the owned count solve', () => {
    const shape = bracket();
    const r = quadrangulate(shape, {
      size: sizeOf(shape),
      trimmed: 'quad-dominant',
    });
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.triangles).toBe(4);
    expect(r.value.report.openEdges).toBe(0);
    expect(r.value.report.nonManifoldEdges).toBe(0);
  });

  it('keeps blossom fail-closed on the bracket with the no-perfect-matching reason', () => {
    const shape = bracket();
    const r = quadrangulate(shape, { size: sizeOf(shape), trimmed: 'blossom' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.detail?.reason).toBe('no-perfect-matching');
  });
});

describe('quad count solve: holed and sweep regression', () => {
  it('keeps sweep-0 blossom at 1680 quads (holed-face bump stays inside the owner)', () => {
    const shape = (buildSweepShowcase() as Shape[])[0] as Shape;
    const r = quadrangulate(shape, { size: sizeOf(shape), trimmed: 'blossom' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.quads).toBe(1680);
  });
});
