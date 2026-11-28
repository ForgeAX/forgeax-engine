import { describe, expect, it } from 'vitest';
import { buildBracket } from './fixtures/synth-parts';
import { compareTriangleContact } from './triangle-contact-compare';
import { candidatePairs, syntheticCorpus } from './triangle-contact-corpus';

describe('triangleContact equivalence with the reference oracle', () => {
  const synthetic = syntheticCorpus(15_000);

  it('matches on at least 200,000 seeded synthetic pairs covering every outcome class', () => {
    expect(synthetic.length).toBeGreaterThanOrEqual(200_000);
    const { classes, bad } = compareTriangleContact(synthetic);
    expect(bad).toEqual([]);
    expect([...classes].sort()).toEqual(['cross', 'none', 'touch']);
  });

  it('matches on the candidate pairs of the bracket fixture', () => {
    const mesh = buildBracket().editMesh;
    for (const tolerance of [0, 1e-5]) {
      const pairs = candidatePairs(mesh, tolerance);
      expect(pairs.length).toBeGreaterThan(0);
      expect(compareTriangleContact(pairs).bad).toEqual([]);
    }
  });
});
