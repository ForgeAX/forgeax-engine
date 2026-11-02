import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';

/** A 1 m grid folded 40 degrees along its x axis: a crease at y = 0. */
function folded() {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
  m.rotate(sel.inBox([-1, 0.01, -1], [1, 1, 1], { by: 'centroid' }), 'x', 40);
  return m;
}

/** How far the subdivided surface pulls away from the crease line (0 when it stays crisp). */
function creaseSag(m: ReturnType<typeof model>): number {
  m.subdivide(undefined, { levels: 2 });
  const mesh = m.editMesh;
  let sag = Infinity;
  for (const v of mesh.vertices()) {
    const [x, y, z] = mesh.position(v);
    if (Math.abs(x) < 0.3) sag = Math.min(sag, Math.hypot(y, z));
  }
  return sag;
}

describe('support loops', () => {
  it('adds a loop on each side of the crease and tags the strips', () => {
    const m = folded();
    const report = m.supportLoops(sel.edges.dihedral('>', 20), { offset: 0.02 });
    expect(report.status).toBe('ok');
    expect(m.editMesh.faceCount).toBe(16 + 8);
    expect(m.count(sel.tag('support'))).toBe(8);
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const two = folded();
    two.supportLoops(sel.edges.dihedral('>', 20), { offset: [0.01, 0.03] });
    expect(two.editMesh.faceCount).toBe(16 + 16);
    expect(two.count(sel.tag('support'))).toBe(16);
  });

  it('keeps a subdivided crease crisper than without support', () => {
    const plain = creaseSag(folded());
    const supported = folded();
    supported.supportLoops(sel.edges.dihedral('>', 20), { offset: 0.01 });
    const crisp = creaseSag(supported);
    expect(plain).toBeGreaterThan(0.01);
    expect(crisp).toBeLessThan(plain / 5);
  });

  it('rejects corners, oversized offsets and malformed offsets', () => {
    const box = model();
    box.box({ size: [1, 1, 1] });
    expect(box.supportLoops(sel.edges.all(), { offset: 0.01 }).error?.code).toBe(
      'model-precondition',
    );
    expect(folded().supportLoops(sel.edges.dihedral('>', 20), { offset: 0.2 }).error?.code).toBe(
      'model-precondition',
    );
    expect(
      folded().supportLoops(sel.edges.dihedral('>', 20), { offset: [0.03, 0.01] }).error?.code,
    ).toBe('model-invalid-argument');
  });
});
