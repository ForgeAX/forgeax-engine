import { describe, expect, it } from 'vitest';
import { compareTriangleContact } from '../../../src/__tests__/triangle-contact-compare';
import { candidatePairs } from '../../../src/__tests__/triangle-contact-corpus';
import { buildRight } from '../body';

describe('triangleContact equivalence on the quality-body candidate pairs', () => {
  it('matches the reference oracle', () => {
    const mesh = buildRight().editMesh;
    for (const tolerance of [0, 1e-5]) {
      const pairs = candidatePairs(mesh, tolerance);
      expect(pairs.length).toBeGreaterThan(0);
      expect(compareTriangleContact(pairs).bad).toEqual([]);
    }
  });
});
