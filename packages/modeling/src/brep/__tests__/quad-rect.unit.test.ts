import { describe, expect, it } from 'vitest';
import { modeSolids, steppedL, tUnion } from '../../../examples/gallery/solids';
import { buildBracket } from '../../../examples/planar-boolean/bracket';
import { quadrangulate } from '../quad';
import { analyzeRect } from '../quad-rect';
import type { Shape } from '../types';

const ISO = { trimmed: 'quad-dominant', isoQuadric: true } as const;

function lay(shape: Shape, size: number, iso = true) {
  const r = quadrangulate(shape, iso ? { size, ...ISO } : { size, trimmed: 'quad-dominant' });
  if (!r.ok) throw new Error(JSON.stringify(r.error.detail));
  return r.value.report;
}

const bracket = (name: string): Shape => {
  const stage = buildBracket().find((s) => s.name === name);
  if (stage === undefined) throw new Error(name);
  return stage.shape;
};

describe('rectilinear planar faces in iso mode', () => {
  it('lays the T-union as all quads with no skewed element', () => {
    const report = lay(tUnion(), 0.4);
    expect(report.triangles).toBe(0);
    expect(report.openEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.scaledJacobian.min).toBeGreaterThan(0.9);
  });

  it('lays the stepped-L union as all quads with no skewed element', () => {
    const report = lay(steppedL(), 0.4);
    expect(report.triangles).toBe(0);
    expect(report.scaledJacobian.min).toBeGreaterThan(0.9);
  });

  it('lays the bracket wall step that the generic route refused', () => {
    const report = lay(bracket('wall'), 0.8);
    expect(report.triangles).toBe(0);
    expect(report.openEdges).toBe(0);
  });

  it('lays the bracket groove and boss steps without leftover triangles', () => {
    for (const name of ['groove', 'boss']) {
      const report = lay(bracket(name), 0.8);
      expect(report.triangles).toBe(0);
      expect(report.openEdges).toBe(0);
      expect(report.nonManifoldEdges).toBe(0);
      expect(report.scaledJacobian.min).toBeGreaterThan(0.75);
    }
  });

  it('lays the bracket gusset and pocket steps as all quads above the 0.3 quality line', () => {
    for (const name of ['gusset', 'pocket']) {
      const report = lay(bracket(name), 0.8);
      expect(report.triangles).toBe(0);
      expect(report.openEdges).toBe(0);
      expect(report.nonManifoldEdges).toBe(0);
      expect(report.scaledJacobian.min).toBeGreaterThan(0.3);
    }
  });

  it('keeps every other gallery solid closed and manifold', () => {
    for (const s of modeSolids()) {
      const r = quadrangulate(s.shape, { size: s.size, ...ISO });
      if (!r.ok) continue;
      expect(r.value.report.openEdges).toBe(0);
      expect(r.value.report.nonManifoldEdges).toBe(0);
    }
  });

  it('leaves the non-iso route untouched', () => {
    expect(lay(tUnion(), 0.4, false).triangles).toBeGreaterThan(0);
  });

  it('recognizes the six- and eight-edge outlines and no rectangle', () => {
    const shape = tUnion();
    const edgeCounts = shape.faces.map((_, f) => analyzeRect(shape, f)?.edges.length ?? 0);
    expect(edgeCounts.filter((n) => n === 8).length).toBe(2);
    expect(edgeCounts.filter((n) => n === 6).length).toBe(2);
    expect(edgeCounts.filter((n) => n === 4).length).toBe(0);
  });
});
