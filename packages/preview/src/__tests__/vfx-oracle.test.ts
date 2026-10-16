import { describe, expect, it } from 'vitest';
import { evaluateVfxOracle, type VfxOracleInput } from '../evidence/oracle.js';

const vfxFacts = (overrides: Partial<VfxOracleInput> = {}): VfxOracleInput => ({
  requested: {
    subjectDigest: 'sha256:vfx',
    programFingerprint: 'sha256:program',
    emitterDigest: 'sha256:emitter',
    sampleDigest: 'sha256:sample',
    boundsDigest: 'sha256:bounds',
    computeDigest: 'sha256:compute',
    indirectDigest: 'sha256:indirect',
    contactSheetDigest: 'sha256:contact-sheet',
  },
  observed: {
    subjectDigest: 'sha256:vfx',
    programFingerprint: 'sha256:program',
    emitterDigest: 'sha256:emitter',
    sampleDigest: 'sha256:sample',
    boundsDigest: 'sha256:bounds',
    computeDigest: 'sha256:compute',
    indirectDigest: 'sha256:indirect',
    contactSheetDigest: 'sha256:contact-sheet',
    rendererHealthy: true,
    dispatches: 1,
    indirectDraws: 1,
    subjectOutputs: 1,
    nonBlackPixels: 100,
  },
  ...overrides,
});

describe('VFX preview oracle', () => {
  it('requires program, simulation, indirect, contact sheet, and subject output facts', () => {
    expect(evaluateVfxOracle(vfxFacts())).toMatchObject({ status: 'passed', subjectBound: true });
  });

  it.each([
    [
      'program fingerprint mismatch',
      { observed: { ...vfxFacts().observed, programFingerprint: 'sha256:other' } },
    ],
    ['disabled dispatch', { observed: { ...vfxFacts().observed, dispatches: 0 } }],
    ['no subject output', { observed: { ...vfxFacts().observed, subjectOutputs: 0 } }],
    [
      'bright sky only',
      { observed: { ...vfxFacts().observed, subjectDigest: 'sha256:sky', nonBlackPixels: 100 } },
    ],
  ])('rejects %s even when the frame is non-black', (_label, override) => {
    expect(evaluateVfxOracle(vfxFacts(override))).toMatchObject({ status: 'failed' });
  });
});
