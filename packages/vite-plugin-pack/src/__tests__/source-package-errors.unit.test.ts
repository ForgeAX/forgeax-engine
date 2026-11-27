import {
  ImportError,
  normalizeSourcePackageError,
  type SourcePackageErrorCode,
  type SourcePackageErrorContext,
  sourcePackageError,
} from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';

const context: SourcePackageErrorContext = {
  sourceMeta: 'assets/scene.gltf.meta.json',
  anchorGuid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
  affectedGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065f', '019e3969-1d48-7c3b-ac24-6d68f4570660'],
  producer: 'source-package/gltf',
  importer: 'gltf',
};

describe('source package structured failures', () => {
  it('normalizes lower-level importer failures without losing typed facts', () => {
    const error = normalizeSourcePackageError(
      new ImportError({
        code: 'importer-not-registered',
        expected: 'a registered gltf importer',
        hint: 'register gltf',
        detail: { importer: 'gltf', registeredImporters: ['image'] },
      }),
      context,
    );

    expect(error.code).toBe('source-package-importer-missing');
    expect(error.expected).toContain('registered importer');
    expect(error.hint).toContain('register');
    expect(error.detail).toMatchObject({
      sourceMeta: context.sourceMeta,
      affectedGuids: context.affectedGuids,
      stage: 'importer',
      importer: 'gltf',
      registeredImporters: ['image'],
    });
  });

  it.each([
    [
      'source-package-meta-invalid',
      'meta',
      { reason: 'missing subAssets' },
      'a valid source Meta declaration with complete GUID topology',
      'repair the Meta declaration, then rebuild or cold-cook the source package',
    ],
    [
      'source-package-importer-missing',
      'importer',
      { registeredImporters: ['image'] },
      'a registered importer for the source Meta importer key',
      'register the named importer, then rebuild or cold-cook the source package',
    ],
    [
      'source-package-conversion-failed',
      'conversion',
      { reason: 'decoder rejected source' },
      'the configured importer to convert the source successfully',
      'repair the source or importer, then rebuild or cold-cook the source package',
    ],
    [
      'source-package-ddc-failed',
      'ddc',
      { reason: 'write denied' },
      'a validated persistent DDC entry committed by the active publication owner',
      'inspect the DDC failure and active publication, then retry through the producer',
    ],
    [
      'source-package-publication-invalid',
      'route-integrity',
      { missing: ['body.bin'] },
      'a complete Pack body, refs, artifacts, and route integrity',
      'repair the missing product bytes, then rebuild or cold-cook the source package',
    ],
    [
      'source-package-guid-closure-mismatch',
      'closure',
      {},
      'exactly one produced asset for every declared GUID',
      'repair the Meta topology or importer output, then rebuild the whole source package',
    ],
  ] as const)('reports typed recovery facts for %s', (code, stage, detail, expected, hint) => {
    expect(sourcePackageError(code, context, { stage, ...detail })).toMatchObject({
      code,
      expected,
      hint,
      detail: { ...context, stage, ...detail },
    });
  });

  it('retains the decoder result for unrecognized codes without inventing recovery', () => {
    const unknown = 'source-package-unknown' as SourcePackageErrorCode;
    const error = sourcePackageError(unknown, context, { stage: 'conversion' });
    expect(error.code).toBe(unknown);
    expect(error.expected).toBeUndefined();
    expect(error.hint).toBeUndefined();
    expect(error.detail).toEqual({ ...context, stage: 'conversion' });
  });

  it('preserves owner and recovery fields through browser JSON projection', () => {
    const error = sourcePackageError('source-package-publication-invalid', context, {
      stage: 'route-integrity',
      missing: ['audio/source.bin'],
    });
    const response = JSON.parse(JSON.stringify(error));
    expect(response).toMatchObject({
      code: 'source-package-publication-invalid',
      expected: expect.any(String),
      hint: expect.stringMatching(/rebuild|cold-cook|repair/),
      detail: {
        sourceMeta: context.sourceMeta,
        affectedGuids: context.affectedGuids,
        stage: 'route-integrity',
      },
    });
  });

  it('normalizes unknown failures into the conversion stage with source provenance', () => {
    const error = normalizeSourcePackageError(new Error('decoder stopped'), context);

    expect(error).toMatchObject({
      code: 'source-package-conversion-failed',
      detail: {
        sourceMeta: context.sourceMeta,
        anchorGuid: context.anchorGuid,
        affectedGuids: context.affectedGuids,
        stage: 'conversion',
        reason: 'decoder stopped',
      },
    });
    expect(error.expected).not.toContain('decoder stopped');
    expect(error.hint).toMatch(/rebuild|cold-cook/);
  });
});
