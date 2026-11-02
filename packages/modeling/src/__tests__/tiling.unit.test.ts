import { describe, expect, it } from 'vitest';
import { EDGE_SHARP } from '../mesh';
import { type Model, model } from '../model';
import { isClosed } from '../ops';
import { sel } from '../selectors';

function quality(m: Model) {
  const q = m.meshQuality();
  if (!q.ok) throw new Error(q.error.expected);
  return q.value;
}

/** A QEM-simplified flat grid: on a plane every collapse costs nothing, so QEM leaves slivers and fans. */
function qemPlane(options: { maxAspect?: number; maxValence?: number } = {}): Model {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: 48, heightSegments: 48 });
  m.triangulate(sel.all());
  expect(m.simplify(undefined, { targetFaces: 300, ...options }).status).toBe('ok');
  return m;
}

function sharpEdges(m: Model): number {
  let n = 0;
  for (const e of m.editMesh.edges())
    if (((m.editMesh.eFlags[e] as number) & EDGE_SHARP) !== 0) n++;
  return n;
}

describe('cleanup.tiling: Delaunay flips and needle collapses on a triangle tiling', () => {
  it('evens a QEM-simplified plane: higher smallest angles, lower aspect, still flat', {
    timeout: 120000,
  }, () => {
    const m = qemPlane();
    const before = quality(m);
    const r = m.cleanup.tiling(undefined, { maxError: 0.01 });
    expect(r.status).toBe('ok');
    const after = quality(m);
    expect(after.minAngle.p10).toBeGreaterThan(before.minAngle.p10 + 3);
    expect(after.aspect.p90).toBeLessThan(before.aspect.p90);
    expect(after.aspect.over6).toBeLessThanOrEqual(before.aspect.over6);
    // No fans: flips and collapses keep every vertex at 8 neighbours or fewer.
    expect(Math.max(...Object.keys(after.valence.byValence).map(Number))).toBeLessThanOrEqual(8);
    const bounds = m.bounds(sel.all());
    expect(bounds.ok && Math.abs(bounds.value.max[2] - bounds.value.min[2])).toBeLessThan(1e-9);
    const metrics = (
      r.diagnostics?.find((d) => d.severity === 'info')?.detail as {
        metrics: Record<string, number>;
      }
    ).metrics;
    expect(metrics.flips).toBeGreaterThan(0);
  });

  it('keeps feature curves: a sharp box keeps every sharp edge', { timeout: 120000 }, () => {
    const m = model();
    m.box({ size: [1, 0.2, 0.2], segments: [12, 3, 3] });
    m.markSharp(sel.edges.dihedral('>', 40));
    m.triangulate(sel.all());
    const sharp = sharpEdges(m);
    m.cleanup.tiling(undefined, { maxError: 0.001 });
    expect(sharpEdges(m)).toBe(sharp);
    expect(isClosed(m.editMesh)).toBe(true);
  });

  it('rejects bad options and reports a tiling with nothing to do', () => {
    expect(model().cleanup.tiling(undefined, { maxError: 0 }).status).toBe('failed');
    const grid = model();
    grid.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
    grid.triangulate(sel.all());
    const r = grid.cleanup.tiling(undefined, { maxError: 0.001 });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-op-no-effect');
  });
});

describe('simplify quality limits: maxAspect and maxValence', () => {
  it('maxAspect keeps QEM from creating slivers; maxValence from creating fans', {
    timeout: 120000,
  }, () => {
    const plain = quality(qemPlane());
    const limited = quality(qemPlane({ maxAspect: 4, maxValence: 8 }));
    expect(limited.aspect.p90).toBeLessThan(plain.aspect.p90);
    expect(limited.aspect.max).toBeLessThan(plain.aspect.max);
    expect(Math.max(...Object.keys(limited.valence.byValence).map(Number))).toBeLessThanOrEqual(8);
  });
});
