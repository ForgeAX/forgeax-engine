import { describe, expect, it } from 'vitest';
import { buildBracket } from '../../../examples/planar-boolean/bracket';
import { booleanSolids } from '../boolean';
import { box } from '../build';
import { quadrangulate } from '../quad';
import { THIN_MIN_ROWS, thinWallEdges } from '../quad-thin';
import type { Shape } from '../types';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const rib = (t: number): Shape => must(box({ size: [4, t, 2], label: 'rib' }));

/** Distinct sample planes across the wall: rows across the thickness are one fewer. */
function rowsAcross(shape: Shape, size: number): { rows: number; tris: number; quads: number } {
  const r = quadrangulate(shape, { size, trimmed: 'quad-dominant', isoQuadric: true });
  const { mesh, report } = must(r);
  const ys = new Set<number>();
  for (let v = 0; v < mesh.vertexCount; v++) ys.add(Math.round(mesh.position(v)[1] * 1e6));
  return { rows: ys.size - 1, tris: report.triangles, quads: report.quads };
}

describe('thin walls keep at least two even rows', () => {
  it('finds the four edges that cross a 0.3 thick rib at size 0.5', () => {
    expect(thinWallEdges(rib(0.3), 0.5).size).toBe(4);
  });

  it('finds none on a wall at least two elements thick', () => {
    expect(thinWallEdges(rib(1.2), 0.5).size).toBe(0);
  });

  it('meshes a thin rib with two rows across, not one', () => {
    for (const t of [0.1, 0.3, 0.6]) {
      const out = rowsAcross(rib(t), 0.5);
      expect(out.rows, `t=${t}`).toBe(THIN_MIN_ROWS);
      expect(out.tris).toBe(0);
    }
  });

  it('leaves a thick plate to its size rule', () => {
    expect(rowsAcross(rib(1.5), 0.5).rows).toBe(3);
  });

  it('keeps the other thin-wall faces of a slotted block all quad', () => {
    const host = must(box({ size: [4, 4, 4], label: 'host' }));
    const tool = must(box({ size: [0.3, 3, 4.5], label: 'slot' }));
    const cut = must(booleanSolids(host, tool, 'difference'));
    const r = must(quadrangulate(cut, { size: 0.5, trimmed: 'quad-dominant', isoQuadric: true }));
    expect(r.report.openEdges).toBe(0);
    expect(r.report.nonManifoldEdges).toBe(0);
  });

  it('falls back to the plain layout when the floor makes the counts unsatisfiable (bracket gusset)', () => {
    const stage = buildBracket().find((x) => x.name === 'gusset');
    if (stage === undefined) throw new Error('gusset');
    expect(thinWallEdges(stage.shape, 0.8).size).toBeGreaterThan(0);
    const r = must(
      quadrangulate(stage.shape, { size: 0.8, trimmed: 'quad-dominant', isoQuadric: true }),
    );
    expect(r.report.triangles).toBe(0);
    expect(r.report.scaledJacobian.min).toBeGreaterThan(0.3);
  });
});
