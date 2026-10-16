import {
  type SourcePackageError,
  type SourcePackageErrorCode,
  sourcePackageError,
} from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';

const context = {
  sourceMeta: 'assets/scene.gltf.meta.json',
  anchorGuid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
  affectedGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065f'],
  producer: 'source-package/gltf',
  importer: 'gltf',
} as const;

const codes: readonly SourcePackageErrorCode[] = [
  'source-package-meta-invalid',
  'source-package-importer-missing',
  'source-package-conversion-failed',
  'source-package-ddc-failed',
  'source-package-publication-invalid',
  'source-package-guid-closure-mismatch',
];

type RecoveryStep = 'inspect' | 'rebuild' | 'cold-cook' | 'verify' | 'retry';

function recoverySteps(error: SourcePackageError): readonly RecoveryStep[] {
  const steps: RecoveryStep[] = ['inspect'];
  switch (error.code) {
    case 'source-package-meta-invalid':
    case 'source-package-importer-missing':
    case 'source-package-conversion-failed':
      steps.push('rebuild', 'verify', 'retry');
      return steps;
    case 'source-package-ddc-failed':
    case 'source-package-publication-invalid':
    case 'source-package-guid-closure-mismatch':
      steps.push('cold-cook', 'verify', 'retry');
      return steps;
  }
  const exhaustive: never = error.code;
  return exhaustive;
}

describe('producer recovery contract', () => {
  it('branches on structured code and detail, then retries the same GUID', () => {
    const error = sourcePackageError('source-package-importer-missing', context, {
      stage: 'importer',
      registeredImporters: ['image'],
    });

    expect(error.code).toBe('source-package-importer-missing');
    expect(error.detail.stage).toBe('importer');
    expect(error.detail.registeredImporters).toEqual(['image']);
    expect(recoverySteps(error)).toEqual(['inspect', 'rebuild', 'verify', 'retry']);
    expect(error.hint).toContain('cold-cook');
    expect(error.detail.anchorGuid).toBe(context.anchorGuid);
  });

  it('keeps the exact six-code policy surface closed and byte-identical', () => {
    expect(codes).toHaveLength(6);
    expect(new Set(codes).size).toBe(6);
    expect(codes).toEqual([
      'source-package-meta-invalid',
      'source-package-importer-missing',
      'source-package-conversion-failed',
      'source-package-ddc-failed',
      'source-package-publication-invalid',
      'source-package-guid-closure-mismatch',
    ]);
    expect(
      codes.map((code) => {
        const error = sourcePackageError(code, context, { stage: 'conversion' });
        return { code: error.code, expected: error.expected, hint: error.hint };
      }),
    ).toEqual([
      {
        code: 'source-package-meta-invalid',
        expected: 'a valid source Meta declaration with complete GUID topology',
        hint: 'repair the Meta declaration, then rebuild or cold-cook the source package',
      },
      {
        code: 'source-package-importer-missing',
        expected: 'a registered importer for the source Meta importer key',
        hint: 'register the named importer, then rebuild or cold-cook the source package',
      },
      {
        code: 'source-package-conversion-failed',
        expected: 'the configured importer to convert the source successfully',
        hint: 'repair the source or importer, then rebuild or cold-cook the source package',
      },
      {
        code: 'source-package-ddc-failed',
        expected: 'a readable persistent DDC entry with matching integrity evidence',
        hint: 'discard the invalid derived entry, then rebuild or cold-cook the source package',
      },
      {
        code: 'source-package-publication-invalid',
        expected: 'a complete Pack body, refs, artifacts, and route integrity',
        hint: 'repair the missing product bytes, then rebuild or cold-cook the source package',
      },
      {
        code: 'source-package-guid-closure-mismatch',
        expected: 'exactly one produced asset for every declared GUID',
        hint: 'repair the Meta topology or importer output, then rebuild the whole source package',
      },
    ]);
  });

  it('preserves unknown-code lookup behavior without widening recovery', () => {
    const unknownCode = 'source-package-unknown' as SourcePackageErrorCode;
    const error = sourcePackageError(unknownCode, context, { stage: 'conversion' });

    expect(error.code).toBe(unknownCode);
    expect(error.expected).toBeUndefined();
    expect(error.hint).toBeUndefined();
    expect(error.detail).toEqual({ ...context, stage: 'conversion' });
  });

  it('keeps exhaustive recovery choices grouped by producer error code', () => {
    expect(
      codes.map((code) =>
        recoverySteps(sourcePackageError(code, context, { stage: 'conversion' })),
      ),
    ).toEqual([
      ['inspect', 'rebuild', 'verify', 'retry'],
      ['inspect', 'rebuild', 'verify', 'retry'],
      ['inspect', 'rebuild', 'verify', 'retry'],
      ['inspect', 'cold-cook', 'verify', 'retry'],
      ['inspect', 'cold-cook', 'verify', 'retry'],
      ['inspect', 'cold-cook', 'verify', 'retry'],
    ]);
  });
});
