import { describe, expect, it } from 'vitest';
import { EDGE_SEAM, EDGE_SHARP } from '../mesh';
import { model } from '../model';
import { sel } from '../selectors';

const NORMALS = { mode: 'smooth' } as const;

/** A 1 x 1 x 0.01 plate: its four sides are strips far narrower than the default minWidth. */
function plate() {
  const m = model();
  m.box({ size: [1, 1, 0.01] });
  m.markSharp(sel.edges.dihedral('>', 40));
  return m;
}

const sharpWithoutSeam = (m: ReturnType<typeof model>) => {
  const mesh = m.editMesh;
  return mesh
    .edges()
    .filter((e) => !mesh.isBoundaryEdge(e))
    .filter((e) => {
      const f = mesh.eFlags[e] as number;
      return (f & EDGE_SHARP) !== 0 && (f & EDGE_SEAM) === 0;
    }).length;
};

const sharpNotSeam = (m: ReturnType<typeof model>) =>
  m
    .validate({ bake: { normals: NORMALS, checks: ['sharp-not-seam'] } })
    .issues.filter((i) => i.code === 'bake').length;

describe('uv.plan respectSharp and the thin-island merge', () => {
  it('keeps every sharp edge a seam while thin side strips would otherwise merge', () => {
    const m = plate();
    expect(m.uv.plan({ respectSharp: true, hardAngle: 180 }).status).toBe('ok');
    expect(m.uv.unwrap({ seams: 'marked' }).status).toBe('ok');
    expect(sharpWithoutSeam(m)).toBe(0);
    expect(sharpNotSeam(m)).toBe(0);
  });

  it('still merges thin strips across non-sharp angle seams (falsifier)', () => {
    const m = model();
    m.box({ size: [1, 1, 0.01] });
    expect(m.uv.plan({ hardAngle: 60 }).status).toBe('ok');
    const seams = m.editMesh
      .edges()
      .filter((e) => ((m.editMesh.eFlags[e] as number) & EDGE_SEAM) !== 0);
    // The 12 box edges are angle seams; the merge removes some of them for the thin sides.
    expect(seams.length).toBeLessThan(12);
  });
});
