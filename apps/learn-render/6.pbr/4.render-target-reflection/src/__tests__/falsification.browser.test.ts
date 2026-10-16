import { describe, expect, it } from 'vitest';
import { runFalsification } from '../../scripts/falsification.mjs';

const cases = [
  { id: 'candidate-visible', stage: 'candidate-visibility', code: 'candidate-visible' },
  { id: 'brdf-source-mismatch', stage: 'projection', code: 'brdf-source-mismatch' },
  { id: 'r32float-storage-removed', stage: 'format-profile', code: 'r32float-storage-usage-missing' },
] as const;

describe('SSR fallback Browser dev-only falsification', () => {
  it('fails each mutation with a serializable stage/code and no manifest admission', () => {
    for (const expected of cases) {
      const failure = runFalsification(expected.id);
      expect(failure).toMatchObject({
        status: 'fail',
        stage: expected.stage,
        code: expected.code,
        manifestEligible: false,
      });
      expect(failure.detail).toEqual(expect.any(String));
    }
  });
});
