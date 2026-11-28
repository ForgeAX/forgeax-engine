import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sectionByPlane } from '../../../src/brep/query/section.ts';
import { buildHousing } from '../../brep-showcase/housing.ts';
import { probe, RAY, rayCrossings, renderQueries, SECTION_PLANE } from '../query.ts';

describe('housing exact queries', () => {
  const parts = buildHousing();

  it('signs the probes: inside the base flange, outside in the air, inside the sleeve wall', () => {
    expect(probe(parts, [40, 0, 5]).value).toBeLessThan(0);
    expect(probe(parts, [-40, 0, 5]).value).toBeLessThan(0);
    expect(probe(parts, [60, 20, 30]).value).toBeGreaterThan(0);
    const wall = probe(parts, [-26, 0, 30]);
    expect(wall.value).toBeLessThan(0);
    expect(wall.value).toBeCloseTo(-2, 6);
    expect(wall.part).toBe('sleeve');
  });

  it('finds the analytic crossings of the ray z=30 through the sleeve wall and the side port', () => {
    const { hits, unresolved } = rayCrossings(parts, RAY.a, RAY.b, 120);
    expect(unresolved).toBe(0);
    const xs = hits.map((h) => RAY.a[0] + h.t * (RAY.b[0] - RAY.a[0]));
    // sleeve wall (r 18..28) at -28..-18 and 18..28 merges with the side port (x 23..49) and its flange (48..52)
    expect(xs.length).toBe(4);
    xs.forEach((x, k) => {
      expect(x).toBeCloseTo([-28, -18, 18, 52][k] as number, 3);
    });
    expect(hits.map((h) => h.enters)).toEqual([true, false, true, false]);
  });

  // The trailing limit is a hang guard, not a speed budget: the render measured 245 to 263 s
  // inside the loaded merge gate, so a 240 s limit failed on load alone.
  it('renders the three query views with the expected counts', () => {
    const out = process.env.FORGEAX_QUERY_OUT;
    const dir = out ?? mkdtempSync(join(tmpdir(), 'hq-'));
    try {
      const r = renderQueries(dir, out === undefined ? 240 : 720);
      expect(r.sheet).toBe('sheet.png');
      expect(r.unresolvedProbes).toBe(0);
      expect(r.sectionCurves).toBeGreaterThan(0);
      expect(r.sectionResidual).toBeLessThan(1e-9);
      expect(r.silhouetteContours).toBeGreaterThan(0);
      expect(r.silhouetteEdges).toBeGreaterThan(0);
      for (const f of [
        'distance-iso',
        'section-front',
        'section-cut-iso',
        'silhouette-iso',
        'sheet',
      ])
        expect(readFileSync(join(dir, `${f}.png`)).length).toBeGreaterThan(1000);
      if (out !== undefined)
        writeFileSync(
          join(out, 'report.json'),
          JSON.stringify(
            { ...r, probes: r.probes.map((q) => [q.p[0], q.value, q.part, q.reason]) },
            null,
            1,
          ),
        );
    } finally {
      if (out === undefined) rmSync(dir, { recursive: true });
    }
  }, 900000);

  it('section and silhouette are deterministic', () => {
    const rib = buildHousing().find((q) => q.name === 'rib 1')?.shape;
    if (rib === undefined) throw new Error('housing rib 1 missing');
    const a = JSON.stringify(sectionByPlane(rib, SECTION_PLANE, { resolution: 32 }));
    expect(JSON.stringify(sectionByPlane(rib, SECTION_PLANE, { resolution: 32 }))).toBe(a);
  });
});
