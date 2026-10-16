import { describe, expect, it } from 'vitest';
import {
  ColorLightingParityError,
  parityError,
  type ColorLightingParityErrorCode,
  type ColorLightingParityErrorDetail,
} from '../errors';
import { exitCodeForError } from '../cli/exit-code';

describe('structured color lighting parity errors', () => {
  it('exposes code, expected, hint, and narrowed detail', () => {
    const error = parityError('provenance-conflict', {
      code: 'provenance-conflict',
      forgeaxImplementation: 'forgeax',
      threeImplementation: 'forgeax',
    });
    expect(error).toBeInstanceOf(ColorLightingParityError);
    expect(error.code).toBe('provenance-conflict');
    expect(error.expected).toContain('different');
    expect(error.hint).toContain('independent');
    expect(error.detail.code).toBe('provenance-conflict');
  });

  it('fails closed when a producer observation is missing', () => {
    const error = parityError('observation-evidence-missing', {
      code: 'observation-evidence-missing',
      owner: 'linearHdr',
      reason: 'missing',
    });
    expect(error.code).toBe('observation-evidence-missing');
    expect(error.expected).toContain('linearHdr');
    expect(error.hint).toContain('producer');
    expect(error.detail).toEqual({ code: 'observation-evidence-missing', owner: 'linearHdr', reason: 'missing' });
  });

  it.each<[ColorLightingParityErrorCode, number]>([
    ['schema-invalid', 64],
    ['provenance-conflict', 65],
    ['primary-capture-missing', 74],
    ['budget-exceeded', 65],
    ['unsupported-capability', 69],
  ])('maps %s to a non-zero exit code', (code, expected) => {
    expect(exitCodeForError(parityError(code, detailFor(code)))).toBe(expected);
  });
});

function detailFor(code: ColorLightingParityErrorCode): ColorLightingParityErrorDetail {
  switch (code) {
    case 'provenance-conflict':
      return { code, forgeaxImplementation: 'forgeax', threeImplementation: 'forgeax' };
    case 'primary-capture-missing':
      return { code, missing: ['threeWebGpu'] };
    case 'budget-exceeded':
      return { code, metric: 'roi', actual: 1, budget: 0 };
    case 'unsupported-capability':
      return { code, capability: 'webgpu' };
    case 'schema-invalid':
    case 'non-finite-value':
    case 'file-read-failed':
      return { code, path: ['caseId'] };
    case 'capture-envelope-invalid':
      return { code, field: 'hash' };
    case 'aggregate-only-input':
      return { code, fields: ['aggregateDiff'] };
    case 'metric-non-finite':
      return { code, metric: 'analytic', actual: Number.NaN, budget: 0 };
    case 'status-incomplete':
      return { code, missing: ['primary'] };
    case 'observation-evidence-missing':
      return { code, owner: 'linearHdr', reason: 'missing' };
  }
}
