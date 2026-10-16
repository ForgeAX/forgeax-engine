import { describe, expect, it } from 'vitest';
import { canonicalizeSourceOverrides, validateSourceOverrideMap } from '../asset-producer.js';

describe('source override producer contract', () => {
  it('accepts a producer-owned payload keyed by a declared sourceKey', () => {
    const result = validateSourceOverrideMap(
      {
        'mesh/main': { lod: 2, materialPolicy: 'preserve' },
      },
      ['mesh/main'],
    );

    expect(result).toEqual({
      ok: true,
      value: { 'mesh/main': { lod: 2, materialPolicy: 'preserve' } },
    });
  });

  it('canonicalizes omitted and empty maps to the same no-override value', () => {
    expect(canonicalizeSourceOverrides(undefined)).toBeUndefined();
    expect(canonicalizeSourceOverrides({})).toBeUndefined();
  });

  it('rejects unknown and duplicate source keys without mutating the input', () => {
    const unknown = Object.freeze({ 'mesh/unknown': { lod: 1 } });
    const unknownResult = validateSourceOverrideMap(unknown, ['mesh/main']);
    expect(unknownResult).toMatchObject({
      ok: false,
      error: {
        code: 'unknown-source-key',
        expected: 'sourceKey to be declared by the producer topology',
        actual: 'mesh/unknown',
      },
    });

    const duplicateResult = validateSourceOverrideMap(
      [
        ['mesh/main', { lod: 1 }],
        ['mesh/main', { lod: 2 }],
      ],
      ['mesh/main'],
    );
    expect(duplicateResult).toMatchObject({
      ok: false,
      error: { code: 'duplicate-source-key' },
    });
    expect(unknown).toEqual({ 'mesh/unknown': { lod: 1 } });
  });
});
