import { describe, expect, it } from 'vitest';
import { must } from '../../../examples/brep-heal/damage';
import { bore } from '../../../examples/brep-pattern/render';
import { buildLoftShowcase } from '../../../examples/loft/showcase.ts';
import { buildSweepShowcase } from '../../../examples/sweep/showcase.ts';
import { extrude } from '../build';
import { measure } from '../measure';
import { applyPattern, linearPattern } from '../pattern';
import { quadrangulate } from '../quad';
import type { Shape } from '../types';

function lPlateWithBore(): Shape {
  const profile: [number, number][] = [
    [0, 0],
    [6, 0],
    [6, 2],
    [2, 2],
    [2, 6],
    [0, 6],
  ];
  const plate = must(extrude({ profile, depth: 1, label: 'L' }));
  const tools = must(
    linearPattern(bore(0.5, [1, 1, 0], 4), { direction: [1, 0, 0], spacing: 3, count: 1 }),
  );
  return must(applyPattern(plate, tools));
}

function sizeOf(shape: Shape): number {
  const m = measure(shape);
  if (!m.ok) throw new Error(JSON.stringify(m.error));
  return Math.sqrt(m.value.area) / 10;
}

describe('isoQuadric per-face fallback on a holed plane with a non-rectangular outer', () => {
  const part = lPlateWithBore();
  const opts = { size: 0.4, trimmed: 'quad-dominant' } as const;

  it('meshes a mixed part (bore wall via iso, L caps via the trimmed route) instead of failing whole', () => {
    const r = quadrangulate(part, { ...opts, isoQuadric: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.openEdges).toBe(0);
    expect(r.value.report.nonManifoldEdges).toBe(0);
    expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
  });

  it('keeps the iso layout where it applies: fewer triangles than the plain trimmed route', () => {
    const plain = quadrangulate(part, opts);
    const iso = quadrangulate(part, { ...opts, isoQuadric: true });
    expect(plain.ok && iso.ok).toBe(true);
    if (!plain.ok || !iso.ok) return;
    expect(iso.value.report.triangles).toBeLessThan(plain.value.report.triangles);
  });

  it('without the trimmed route the cap still fails closed with its own reason', () => {
    const r = quadrangulate(part, { size: 0.4, isoQuadric: true });
    expect(r.ok).toBe(false);
  });

  it('closes the sweep / loft showcases with caps that have a NURBS outer', () => {
    const shapes = [
      ...(buildSweepShowcase() as Shape[]).slice(0, 1),
      ...(buildLoftShowcase() as Shape[]).filter((_, i) => i === 0 || i === 2),
    ];
    expect(shapes.length).toBe(3);
    for (const shape of shapes) {
      const r = quadrangulate(shape, {
        size: sizeOf(shape),
        trimmed: 'quad-dominant',
        isoQuadric: true,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.report.openEdges).toBe(0);
      expect(r.value.report.nonManifoldEdges).toBe(0);
    }
  });
});
