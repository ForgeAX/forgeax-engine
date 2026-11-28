import { describe, expect, it } from 'vitest';
import { bracketFixture } from '../../../examples/qf-m6-bracket/fixture';
import type { EditMesh } from '../../mesh';
import type { QuadResult } from '../quad';
import { quadrangulate } from '../quad';
import { g1RowContinuity } from '../quad-g1-metric';
import { thinWallEdges } from '../quad-thin';

const SIZE = 0.5;

function run(): QuadResult {
  const r = quadrangulate(bracketFixture(), {
    size: SIZE,
    trimmed: 'quad-dominant',
    isoQuadric: true,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** Boundary edges of each source face's submesh that have one owning face and are shared with another source face; a quad on the face's side covers them. */
function firstRing(result: QuadResult): { total: number; withQuad: number } {
  const mesh: EditMesh = result.mesh;
  const owner = new Map<number, number>();
  result.faceRanges.forEach(([lo, hi], f) => {
    for (let m = lo; m < hi; m++) if (mesh.isFaceAlive(m)) owner.set(m, f);
  });
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const perFace = new Map<number, Map<string, { n: number; quad: boolean }>>();
  for (const [m, f] of owner) {
    const vs = mesh.faceVertices(m);
    const map = perFace.get(f) ?? new Map<string, { n: number; quad: boolean }>();
    vs.forEach((a, k) => {
      const b = vs[(k + 1) % vs.length] as number;
      const kk = key(a, b);
      const e = map.get(kk) ?? { n: 0, quad: false };
      e.n++;
      e.quad ||= vs.length === 4;
      map.set(kk, e);
    });
    perFace.set(f, map);
  }
  const global = new Map<string, number>();
  for (const map of perFace.values())
    for (const [kk, e] of map) global.set(kk, (global.get(kk) ?? 0) + e.n);
  let total = 0;
  let withQuad = 0;
  for (const map of perFace.values()) {
    for (const [kk, e] of map) {
      if (e.n !== 1 || global.get(kk) !== 2) continue;
      total++;
      if (e.quad) withQuad++;
    }
  }
  return { total, withQuad };
}

/**
 * Rows of quads across the 0.3 thick web (x in [2.0, 2.3]) at mid-height: distinct x layers among vertices with
 * 0.85 < y < 2 minus one. Top-face vertices (y = 2) are excluded; they are not web rows.
 */
function webRows(result: QuadResult): number {
  const xs = new Set<number>();
  for (let v = 0; v < result.mesh.vertexCount; v++) {
    const [x, y] = result.mesh.position(v);
    if (x > 2.0 - 1e-6 && x < 2.3 + 1e-6 && y > 0.85 && y < 2 - 1e-6) xs.add(Math.round(x * 1e6));
  }
  return xs.size - 1;
}

describe('QF-M6 filleted bracket with thin web', () => {
  it('detects the thin web as thin-wall edges', () => {
    expect(thinWallEdges(bracketFixture(), SIZE).size).toBeGreaterThan(0);
  });

  it('keeps at least one row of quads across the thin web (measured floor)', () => {
    expect(webRows(run())).toBeGreaterThanOrEqual(1);
  });

  // The G1 fraction measures seam perpendicularity, not smoothness: at size 0.5 the r = 0.25 fillets are one chord facet.
  it('keeps the G1 chain fully continued across regular seam vertices (seam perpendicularity, not smoothness)', () => {
    const g = g1RowContinuity(bracketFixture(), run());
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    expect(g.value.regular).toBeGreaterThan(0);
    expect(g.value.fraction).toBe(1);
  });

  // Known gap: one quad row crosses the web at size 0.5 (measured 1 row); two even rows is the target.
  it.fails('keeps at least two even rows across the thin web (measured 1 row at size 0.5)', () => {
    expect(webRows(run())).toBeGreaterThanOrEqual(2);
  });

  it('keeps the interior scaled Jacobian at least 0.3', () => {
    expect(run().report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
  });

  it('reports the current first-ring floor (regression guard, not the target)', () => {
    const ring = firstRing(run());
    expect(ring.total).toBeGreaterThan(0);
    expect(ring.withQuad).toBeGreaterThanOrEqual(230);
  });

  // Known gap: 14 cap-face boundary edges have only a triangle on the cap side (Q-A quad-trimmed owner).
  it.fails('covers every first-ring boundary edge with a quad (target 1.0)', () => {
    const ring = firstRing(run());
    expect(ring.withQuad).toBe(ring.total);
  });
});
