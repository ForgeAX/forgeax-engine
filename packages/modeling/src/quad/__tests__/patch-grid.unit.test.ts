import { describe, expect, it } from 'vitest';
import { bossBox, chamferBox } from '../../../examples/quad-field/models';
import { solveSideCounts } from '../../brep/quad-counts';
import { patchGrid } from '../patch-grid';

const ALLOWED_REASONS = new Set([
  'corners-3',
  'corners-5',
  'corners-6',
  'corners-7',
  'corners-8',
  'corners-0',
  'corners-1',
  'corners-2',
  'no-interior',
  'holed-boundary',
  'open-boundary',
  'pinched-boundary',
  'count-mismatch',
  'single-triangle',
]);

describe('patchGrid', () => {
  it('grids the chamfer box with no open shared edges and no inverted quads', () => {
    const g = patchGrid(chamferBox());
    const m = g.metrics;
    expect(m.patches).toBe(26);
    expect(m.gridded).toBe(6);
    expect(m.gridded + m.unmeshed).toBe(m.patches);
    expect(m.quads).toBeGreaterThan(0);
    expect(m.openEdges).toBe(0);
    expect(m.invertedQuads).toBe(0);
    expect(m.minScaledJacobian).toBeGreaterThan(0);
    expect(m.areaCoveredPct).toBeGreaterThan(50);
    expect(m.areaCoveredPct).toBeLessThan(100);
  });

  it('reports every unmeshed patch with a known reason and its triangles', () => {
    const g = patchGrid(chamferBox());
    expect(g.unmeshed.length).toBe(g.metrics.unmeshed);
    for (const u of g.unmeshed) {
      expect(ALLOWED_REASONS.has(u.detail.reason)).toBe(true);
      expect(u.triangles.length).toBeGreaterThan(0);
    }
  });

  it('counts four-corner patches in the merged layout as patchesNotFour complement', () => {
    const g = patchGrid(chamferBox());
    const fourCorner = g.layout.patchCount - g.metrics.patchesNotFour;
    expect(fourCorner).toBe(18);
  });

  it('grids a box with a boss without open shared edges', () => {
    const g = patchGrid(bossBox());
    expect(g.metrics.openEdges).toBe(0);
    expect(g.metrics.invertedQuads).toBe(0);
    expect(g.metrics.gridded).toBeGreaterThan(0);
  });

  it('keeps grid vertices on the mesh surface at corners and shared sample points', () => {
    const mesh = chamferBox();
    const g = patchGrid(mesh);
    const meshVerts = new Set<string>();
    for (let i = 0; i < mesh.positions.length; i += 3) {
      meshVerts.add(
        [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]
          .map((x) => (x as number).toFixed(9))
          .join(','),
      );
    }
    let corners = 0;
    for (let i = 0; i < g.positions.length; i += 3) {
      const key = [g.positions[i], g.positions[i + 1], g.positions[i + 2]]
        .map((x) => (x as number).toFixed(9))
        .join(',');
      if (meshVerts.has(key)) corners++;
    }
    expect(corners).toBeGreaterThan(0);
  });
});

describe('solveSideCounts', () => {
  it('lifts both members of an opposite-side class to the class maximum', () => {
    expect(solveSideCounts([2, 5, 3, 1], [[0, 2]])).toEqual([3, 5, 3, 1]);
  });

  it('chains classes through shared sides into one maximum', () => {
    expect(
      solveSideCounts(
        [2, 4, 7, 1],
        [
          [0, 1],
          [1, 3],
        ],
      ),
    ).toEqual([4, 4, 7, 4]);
  });

  it('leaves unpaired sides at their forced count', () => {
    expect(solveSideCounts([2, 9], [])).toEqual([2, 9]);
  });
});
