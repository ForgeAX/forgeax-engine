import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../diff';
import { decodeSnapshot } from '../fxem';
import { model } from '../model';
import { faceSel } from '../selectors';

const box = (order: readonly string[]) => {
  const m = model();
  m.box({ size: [1, 1, 1] });
  for (const t of order) m.tag(faceSel.all(), t);
  return m;
};

describe('canonical snapshot tag order', () => {
  it('boxes tagged p,q and q,p have identical bytes and an identical diff', () => {
    const a = box(['p', 'q']);
    const b = box(['q', 'p']);
    expect(Buffer.from(a.snapshot()).equals(Buffer.from(b.snapshot()))).toBe(true);
    const d = diffMeshes(a.editMesh, b.editMesh);
    expect(d.ok && d.value.identical).toBe(true);
  });

  it('a partial tag stays on the same faces after reordering', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.tag(faceSel.all(), 'zeta');
    const first = m.editMesh.faces()[0] as number;
    m.editMesh.addTag(first, m.editMesh.tagIndex('alpha', true));
    const out = m.editMesh.compact().mesh;
    const alpha = out.tagNames.indexOf('alpha');
    const zeta = out.tagNames.indexOf('zeta');
    expect(out.tagNames).toEqual(['alpha', 'zeta']);
    expect(out.faces().filter((f) => out.hasTag(f, alpha))).toHaveLength(1);
    expect(out.faces().filter((f) => out.hasTag(f, zeta))).toHaveLength(6);
  });
});

describe('snapshot round trip keeps tags', () => {
  it('decodes to the same tag membership', () => {
    const m = box(['zeta', 'alpha']);
    const decoded = decodeSnapshot(m.snapshot());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.tagNames).toEqual(['alpha', 'zeta']);
      expect(decoded.value.faces().every((f) => decoded.value.hasTag(f, 0))).toBe(true);
    }
  });
});
