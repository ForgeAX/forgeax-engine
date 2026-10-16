import { describe, expect, it } from 'vitest';
import {
  containsSourcePackageError,
  normalizeSourcePackageError,
  sourcePackageError,
} from '../source-package-errors.js';

const context = {
  sourceMeta: '/game/assets/fox.glb.meta.json',
  anchorGuid: '018e7a4d-1234-7abc-8def-000000000020',
  affectedGuids: ['018e7a4d-1234-7abc-8def-000000000020'],
  producer: 'source-package/gltf',
  importer: 'gltf',
};

describe('source-package error normalization', () => {
  it('walks nested production wrappers to retain the source-package failure', () => {
    const sourceFailure = sourcePackageError('source-package-ddc-failed', context, {
      stage: 'ddc',
      reason: 'DDC lifecycle commit returned stale',
    });
    const wrapped = {
      code: 'commit-failed',
      expected: 'DDC to commit the staged publication',
      hint: 'retry the active generation',
      detail: { stage: 'commit' },
      cause: {
        code: 'produce-failed',
        expected: 'the production generation to complete',
        hint: 'repair the producer',
        detail: { stage: 'produce' },
        cause: sourceFailure,
      },
    };

    expect(normalizeSourcePackageError(wrapped, context)).toEqual(sourceFailure);
    expect(containsSourcePackageError(wrapped)).toBe(true);
  });

  it('does not mistake an unrelated lifecycle wrapper for an ImportError', () => {
    const normalized = normalizeSourcePackageError(
      {
        code: 'commit-failed',
        expected: 'a commit',
        hint: 'retry',
        detail: { stage: 'commit' },
      },
      context,
    );

    expect(normalized.code).toBe('source-package-conversion-failed');
    expect(normalized.detail.reason).toContain('commit-failed');
    expect(
      containsSourcePackageError({
        code: 'pack-source-load-failed',
        expected: 'a ScriptablePack build',
        hint: 'retry',
        detail: { reason: 'timeout' },
      }),
    ).toBe(false);
  });
});
