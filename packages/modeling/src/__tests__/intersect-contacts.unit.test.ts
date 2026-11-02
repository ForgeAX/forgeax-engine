import { describe, expect, it } from 'vitest';
import { faceContacts } from '../intersect';
import { model } from '../model';

describe('faceContacts with an `only` set', () => {
  it('returns exactly the pairs of the full scan that involve an `only` face', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [3, 3, 3] });
    m.box({ size: [0.6, 0.6, 2], center: [0.2, 0.1, 0] });
    m.sphere({ radius: 0.4, widthSegments: 12, heightSegments: 8, center: [3, 0, 0] });
    const mesh = m.editMesh;
    const faces = mesh.faces();
    const key = (c: { faces: readonly [number, number] }) => c.faces.join(':');
    const all = faceContacts(mesh, Number.MAX_SAFE_INTEGER, 1e-6).contacts;
    expect(all.some((c) => c.contact === 'cross')).toBe(true);
    for (const pick of [
      faces.slice(0, 5),
      faces.slice(20, 40),
      faces.slice(-6),
      [faces[3] as number],
    ]) {
      const only = new Set(pick);
      const expected = all
        .filter((c) => only.has(c.faces[0]) || only.has(c.faces[1]))
        .map(key)
        .sort();
      const got = faceContacts(mesh, Number.MAX_SAFE_INTEGER, 1e-6, only).contacts.map(key).sort();
      expect(got).toEqual(expected);
    }
  });
});
