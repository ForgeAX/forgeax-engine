import { bench, describe } from 'vitest';
import { buildRight } from '../examples/quality-body/body.ts';
import { candidatePairs, syntheticCorpus } from '../src/__tests__/triangle-contact-corpus';
import { referenceTriangleContact } from '../src/__tests__/triangle-contact-reference';
import { triangleContact } from '../src/intersect';

// `npx vitest bench bench/triangle-contact.bench.ts`: the reference is the origin/main closure
// (before); triangleContact is the allocation-free rewrite (after). Divide the reported time by
// the pair count for microseconds per candidate.
const synthetic = syntheticCorpus(1000);
const candidates = candidatePairs(buildRight().editMesh, 1e-5);

describe('synthetic corpus', () => {
  bench('before (reference)', () => {
    for (const p of synthetic) referenceTriangleContact(p.t1, p.t2, p.tolerance);
  });
  bench('after (triangleContact)', () => {
    for (const p of synthetic) triangleContact(p.t1, p.t2, p.tolerance);
  });
});

describe('quality-body candidate pairs', () => {
  bench('before (reference)', () => {
    for (const p of candidates) referenceTriangleContact(p.t1, p.t2, p.tolerance);
  });
  bench('after (triangleContact)', () => {
    for (const p of candidates) triangleContact(p.t1, p.t2, p.tolerance);
  });
});
