import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { type QuadResult, quadrangulate } from '../../../src/brep/quad';
import { tessellate } from '../../../src/brep/tessellate';
import type { P3 } from '../../../src/brep/vec';
import { contactSheet, type PolyMesh, renderShape, type SheetCell } from '../../brep-kit/index.ts';
import { asPolyMesh } from '../../brep-kit/mesh-scene.ts';
import { vizOutputDir } from '../../test-output.ts';
import { buildHousing } from '../housing.ts';

const OUT = vizOutputDir('trimface-dod');

function valenceHist(faces: readonly (readonly number[])[]): Record<string, number> {
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)?.add(b);
  };
  for (const f of faces)
    for (let k = 0; k < f.length; k++) {
      const a = f[k] as number;
      const b = f[(k + 1) % f.length] as number;
      link(a, b);
      link(b, a);
    }
  const h: Record<string, number> = {};
  for (const s of adj.values()) h[String(s.size)] = (h[String(s.size)] ?? 0) + 1;
  return h;
}

function pointTri(p: P3, a: P3, b: P3, c: P3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as P3;
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as P3;
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]] as P3;
  const d = (x: P3, y: P3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const d1 = d(ab, ap),
    d2 = d(ac, ap);
  const proj = (q: P3): number => Math.sqrt(d(q, q));
  if (d1 <= 0 && d2 <= 0) return proj(ap);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]] as P3;
  const d3 = d(ab, bp),
    d4 = d(ac, bp);
  if (d3 >= 0 && d4 <= d3) return proj(bp);
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]] as P3;
  const d5 = d(ab, cp),
    d6 = d(ac, cp);
  if (d6 >= 0 && d5 <= d6) return proj(cp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return proj([ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]]);
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return proj([ap[0] - t * ac[0], ap[1] - t * ac[1], ap[2] - t * ac[2]]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + d5 - d6);
    const w = [
      bp[0] + t * (cp[0] - bp[0]),
      bp[1] + t * (cp[1] - bp[1]),
      bp[2] + t * (cp[2] - bp[2]),
    ] as P3;
    return proj(w);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den,
    w = vc * den;
  return proj([
    ap[0] - v * ab[0] - w * ac[0],
    ap[1] - v * ab[1] - w * ac[1],
    ap[2] - v * ab[2] - w * ac[2],
  ]);
}

/** One-sided Hausdorff: max over quad vertices of the distance to the fine tessellation surface. */
function hausdorffQuadToFine(qpos: readonly P3[], fine: PolyMesh): number {
  let worst = 0;
  for (const p of qpos) {
    let best = Infinity;
    for (const f of fine.faces)
      for (let k = 1; k + 1 < f.length; k++) {
        const d = pointTri(
          p,
          fine.positions[f[0] as number] as P3,
          fine.positions[f[k] as number] as P3,
          fine.positions[f[k + 1] as number] as P3,
        );
        if (d < best) best = d;
      }
    if (best > worst) worst = best;
  }
  return worst;
}

function quadStats(q: QuadResult): Record<string, unknown> {
  const pm = asPolyMesh(q.mesh);
  const quadPolys = pm.faces.filter((f) => f.length === 4).length;
  return {
    polygons: pm.faces.length,
    quadPolys,
    quadRatio: quadPolys / pm.faces.length,
    scaledJacobian: q.report.scaledJacobian,
    openEdges: q.report.openEdges,
    nonManifold: q.report.nonManifoldEdges,
    singularities: q.report.singularities,
    valence: valenceHist(pm.faces),
  };
}

it('per-part DoD stats and before/after sheet', () => {
  const parts = buildHousing();
  const rows: Record<string, unknown>[] = [];
  const cellsBefore: SheetCell[] = [];
  const cellsAfter: SheetCell[] = [];
  const meshesBefore: PolyMesh[] = [];
  const meshesAfter: PolyMesh[] = [];
  for (const p of parts) {
    const before = quadrangulate(p.shape, { size: 4, trimmed: 'reject' });
    const after = quadrangulate(p.shape, { size: 4 });
    const row: Record<string, unknown> = { part: p.name };
    row.before = before.ok
      ? { status: 'ok', ...quadStats(before.value) }
      : { status: 'rejected', reason: (before.error.detail as { reason?: string })?.reason };
    if (after.ok) {
      const fine = tessellate(p.shape, { angle: Math.PI / 32, chord: 0.05 });
      row.after = {
        status: 'ok',
        ...quadStats(after.value),
        hausdorffQuadToFine: fine.ok
          ? hausdorffQuadToFine(asPolyMesh(after.value.mesh).positions, asPolyMesh(fine.value))
          : 'fine-tessellate-failed',
      };
      meshesAfter.push(asPolyMesh(after.value.mesh));
    } else {
      row.after = {
        status: 'rejected',
        reason: (after.error.detail as { reason?: string })?.reason,
      };
    }
    if (before.ok) meshesBefore.push(asPolyMesh(before.value.mesh));
    rows.push(row);
  }
  writeFileSync(`${OUT}/trimface-dod.json`, JSON.stringify(rows, null, 2));

  for (const [label, meshes, cells] of [
    ['before', meshesBefore, cellsBefore],
    ['after', meshesAfter, cellsAfter],
  ] as const) {
    const r = renderShape(meshes, {
      outDir: OUT,
      size: 360,
      silhouette: false,
      modes: ['network', 'jacobian'],
      name: `quad-${label}-`,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    for (const v of r.value.views)
      cells.push({ image: v.image, caption: `${label} ${v.mode} ${v.view}` });
  }
  const rejected = rows
    .filter((r) => (r.after as { status: string }).status === 'rejected')
    .map((r) => `${r.part} (${(r.after as { reason: string }).reason})`);
  contactSheet([...cellsBefore, ...cellsAfter], {
    columns: 4,
    cell: 360,
    title: `Flanged housing quad: before (trimmed=reject) vs after (Blossom-Quad). Rejected after: ${rejected.join(', ') || 'none'}`,
    path: `${OUT}/housing-quad-before-after.png`,
  });

  // Assertions behind the DoD numbers, so the sheet cannot silently drift.
  const after = rows.map((r) => r.after as Record<string, unknown>);
  expect(after.filter((a) => a.status === 'ok').length).toBe(10);
  for (const a of after.filter((x) => x.status === 'ok')) {
    expect(a.openEdges).toBe(0);
    expect(a.nonManifold).toBe(0);
    expect((a.scaledJacobian as { min: number }).min).toBeGreaterThan(0);
    expect(a.quadRatio).toBe(1);
  }
});
