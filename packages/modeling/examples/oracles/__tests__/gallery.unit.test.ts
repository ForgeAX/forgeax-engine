import type { FuzzPrimitive } from '../../../src/__tests__/support/fuzz';
import { describe, expect, it } from 'vitest';
import { model } from '../../../src/model';
import { GALLERY, contactOf, galleryScene } from '../gallery';

describe('fuzz gallery picks', () => {
  for (const pick of GALLERY) {
    it(`${pick.op} ${pick.contact} seed ${pick.seed} is that contact and survives`, () => {
      const s = galleryScene(pick);
      expect(contactOf(...(s.primitives as [FuzzPrimitive, FuzzPrimitive]))).toBe(pick.contact);
      const m = model();
      s.build(m);
      const report = m.validate();
      expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(m.poisoned).toBeUndefined();
      expect(report.volume).toBeGreaterThan(0);
      expect(m.editMesh.faceCount).toBeGreaterThan(0);
    });
  }
});
