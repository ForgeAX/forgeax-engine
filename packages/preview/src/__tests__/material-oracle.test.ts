import { describe, expect, it } from 'vitest';
import { evaluateMaterialOracle, type MaterialOracleInput } from '../evidence/oracle.js';

const materialFacts = (overrides: Partial<MaterialOracleInput> = {}): MaterialOracleInput => ({
  requested: {
    subjectDigest: 'sha256:material',
    program: 'shader/material.wgsl',
    pass: 'forward',
    bindingsDigest: 'sha256:bindings',
    closureDigest: 'sha256:closure',
  },
  observed: {
    subjectDigest: 'sha256:material',
    program: 'shader/material.wgsl',
    pass: 'forward',
    bindingsDigest: 'sha256:bindings',
    closureDigest: 'sha256:closure',
    rendererHealthy: true,
    drawCalls: 1,
    nonBlackPixels: 100,
  },
  ...overrides,
});

describe('material preview oracle', () => {
  it('requires program, pass, bindings, closure, and renderer facts together', () => {
    expect(evaluateMaterialOracle(materialFacts())).toMatchObject({
      status: 'passed',
      subjectBound: true,
    });
  });

  it.each([
    [
      'shader specialization replacement',
      { observed: { ...materialFacts().observed, program: 'shader/other.wgsl' } },
    ],
    [
      'binding replacement',
      { observed: { ...materialFacts().observed, bindingsDigest: 'sha256:other' } },
    ],
    [
      'neutral fallback',
      { observed: { ...materialFacts().observed, subjectDigest: 'sha256:neutral' } },
    ],
    [
      'bright sky only',
      {
        observed: {
          ...materialFacts().observed,
          subjectDigest: 'sha256:missing',
          drawCalls: 1,
          nonBlackPixels: 100,
        },
      },
    ],
  ])('rejects %s even when the frame is non-black', (_label, override) => {
    expect(evaluateMaterialOracle(materialFacts(override))).toMatchObject({ status: 'failed' });
  });
});
