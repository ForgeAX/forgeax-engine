import { describe, expect, it } from 'vitest';
import {
  buildExtendedLightingComparisonCoverage,
  evaluateExtendedLightingSemanticCoverage,
} from '../extended-case-coverage';
import { EXTENDED_LIGHTING_REQUIRED_CASE_IDS } from '../case-roster';

describe('extended-lighting current-head comparison coverage', () => {
  it('binds every required roster entry to either a real GPU carrier or an independent oracle', () => {
    const coverage = buildExtendedLightingComparisonCoverage();

    expect(coverage.map((entry) => entry.caseId)).toEqual(EXTENDED_LIGHTING_REQUIRED_CASE_IDS);
    expect(coverage.every((entry) => entry.required)).toBe(true);
    expect(coverage.every((entry) => entry.referenceKinds.length > 0)).toBe(true);
    expect(coverage.every((entry) => entry.boundary.threeNativeSubset.length > 0)).toBe(true);
    expect(coverage.every((entry) => entry.boundary.independentOracleBoundary.length > 0)).toBe(true);
    expect(coverage.find((entry) => entry.caseId === 'rect-area')?.comparisonKind).toBe('three-pixel-carrier');
    expect(coverage.find((entry) => entry.caseId === 'spot-modifiers')?.comparisonKind).toBe('three-pixel-carrier');
    expect(coverage.find((entry) => entry.caseId === 'probe-oracle')?.comparisonKind).toBe('three-native-plus-independent-oracle');
    expect(coverage.find((entry) => entry.caseId === 'recovery-stale-generation')?.comparisonKind).toBe('three-reference-boundary-plus-negative-oracle');
  });

  it('executes the independent probe oracle and every required negative case', () => {
    const semantic = evaluateExtendedLightingSemanticCoverage();

    expect(semantic.map((entry) => entry.caseId)).toEqual([
      'probe-oracle',
      'rect-area-reversed-front',
      'rect-area-zero-ltc',
      'probe-sky-contributor',
      'recovery-stale-generation',
    ]);
    expect(semantic.every((entry) => entry.required && entry.verdict === 'passed'), JSON.stringify(semantic)).toBe(true);
    expect(semantic.find((entry) => entry.caseId === 'probe-oracle')?.observations.propertiesPassed).toBe(6);
    expect(semantic.find((entry) => entry.caseId === 'rect-area-zero-ltc')?.observations.zeroTableCount).toBe(0);
    expect(semantic.find((entry) => entry.caseId === 'probe-sky-contributor')?.observations.admittedSky).toBe(false);
    expect(semantic.find((entry) => entry.caseId === 'recovery-stale-generation')?.observations.staleRejected).toBe(true);
  });
});
