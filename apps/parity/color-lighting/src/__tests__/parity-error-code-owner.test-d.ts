import { describe, expectTypeOf, it } from 'vitest';
import type {
  ColorLightingParityError,
  ColorLightingParityErrorCode,
  ColorLightingParityErrorDetail,
} from '../errors';
import { parityError } from '../errors';
import { exitCodeForError } from '../cli/exit-code';

const expectedCodes = [
  'schema-invalid',
  'non-finite-value',
  'file-read-failed',
  'provenance-conflict',
  'primary-capture-missing',
  'capture-envelope-invalid',
  'aggregate-only-input',
  'metric-non-finite',
  'budget-exceeded',
  'unsupported-capability',
  'observation-evidence-missing',
  'status-incomplete',
] as const satisfies readonly ColorLightingParityErrorCode[];
type ExpectedCodeUnion = (typeof expectedCodes)[number];

describe('ColorLightingParityError code owner', () => {
  it('derives the exact closed code surface from the detail union', () => {
    expectTypeOf<ColorLightingParityErrorCode>().toEqualTypeOf<ExpectedCodeUnion>();
    expectTypeOf<ExpectedCodeUnion>().toEqualTypeOf<ColorLightingParityErrorCode>();
    expectTypeOf<ColorLightingParityErrorCode>().toEqualTypeOf<ColorLightingParityErrorDetail['code']>();
    expectTypeOf<ColorLightingParityErrorDetail['code']>().toEqualTypeOf<ColorLightingParityErrorCode>();
    expectTypeOf<ColorLightingParityError['code']>().toEqualTypeOf<ColorLightingParityErrorCode>();

    const acceptsCode = (code: ColorLightingParityErrorCode): ColorLightingParityErrorCode => code;
    for (const code of expectedCodes) acceptsCode(code);
    // @ts-expect-error Unknown codes remain outside the closed parity error vocabulary.
    acceptsCode('color-lighting-error-code-not-real');
  });

  it('narrows every detail payload by the same exhaustive code owner', () => {
    const readDetail = (detail: ColorLightingParityErrorDetail): string => {
      switch (detail.code) {
        case 'schema-invalid':
        case 'non-finite-value':
        case 'file-read-failed':
          return detail.path.join('.');
        case 'provenance-conflict':
          return `${detail.forgeaxImplementation}:${detail.threeImplementation}`;
        case 'primary-capture-missing':
          return detail.missing.join(',');
        case 'capture-envelope-invalid':
          return `${detail.field}:${detail.role ?? ''}`;
        case 'aggregate-only-input':
          return detail.fields.join(',');
        case 'metric-non-finite':
        case 'budget-exceeded':
          return `${detail.metric}:${detail.actual}:${detail.budget}`;
        case 'unsupported-capability':
          return `${detail.capability}:${detail.fallback ?? ''}`;
        case 'observation-evidence-missing':
          return `${detail.owner}:${detail.reason}`;
        case 'status-incomplete':
          return detail.missing.join(',');
      }

      const exhaustive: never = detail;
      return exhaustive;
    };

    void readDetail;
  });

  it('preserves the runtime error contract and CLI projection', () => {
    const error = parityError('observation-evidence-missing', {
      code: 'observation-evidence-missing',
      owner: 'linearHdr',
      reason: 'missing',
    });
    expectTypeOf(error).toEqualTypeOf<ColorLightingParityError>();
    expectTypeOf(error.code).toEqualTypeOf<ColorLightingParityErrorCode>();
    expectTypeOf(error.detail).toEqualTypeOf<ColorLightingParityErrorDetail>();
    void exitCodeForError(error);
  });
});
