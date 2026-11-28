import { describe, expect, it } from 'vitest';
import { buildLoftShowcase } from '../../../examples/loft/showcase.ts';
import { buildSweepShowcase } from '../../../examples/sweep/showcase.ts';
import { measure } from '../measure';
import { quadrangulate } from '../quad';
import type { Shape } from '../types';

function sizeOf(shape: Shape): number {
  const m = measure(shape);
  if (!m.ok) throw new Error(JSON.stringify(m.error));
  return Math.sqrt(m.value.area) / 10;
}

function run(shape: Shape, trimmed: 'blossom' | 'quad-dominant') {
  return quadrangulate(shape, { size: sizeOf(shape), trimmed });
}

function closedAllQuad(shape: Shape, trimmed: 'blossom' | 'quad-dominant' = 'blossom') {
  const r = run(shape, trimmed);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.report;
}

const sweeps = buildSweepShowcase() as Shape[];
const lofts = buildLoftShowcase() as Shape[];

describe('quadrangulate NURBS edges (sweep / loft)', () => {
  it('sweep-0: NURBS edges sample by length; blossom closes all-quad', () => {
    const report = closedAllQuad(sweeps[0] as Shape);
    expect(report.openEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
  });

  it('sweep-1: NURBS sweep closes under blossom', () => {
    const report = closedAllQuad(sweeps[1] as Shape);
    expect(report.openEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
  });

  it('loft-0: holed cap would need triangles, so blossom fails closed', () => {
    const r = run(lofts[0] as Shape, 'blossom');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain('no-perfect-matching');
  });

  it('loft-0: quad-dominant closes the NURBS loft', () => {
    const report = closedAllQuad(lofts[0] as Shape, 'quad-dominant');
    expect(report.openEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
  });

  it('loft-2: quad-dominant closes the NURBS loft', () => {
    const report = closedAllQuad(lofts[2] as Shape, 'quad-dominant');
    expect(report.openEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
  });
});

describe('row-front blossom contract', () => {
  it('blossom returns all-quad output or fails closed (never triangles)', () => {
    for (const shape of [...sweeps, ...lofts]) {
      const r = run(shape, 'blossom');
      if (r.ok) expect(r.value.report.triangles).toBe(0);
    }
  });
});
