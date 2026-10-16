import { describe, expect, it } from 'vitest';
import { MaterialAuthoringContractError, Materials } from '../materials';

describe('Materials.standard authoring validation', () => {
  it.each([
    [-0.01, 'range'],
    [1.01, 'range'],
    [Number.NaN, 'non-finite'],
    [Number.POSITIVE_INFINITY, 'non-finite'],
  ] as const)('rejects alphaCutoff=%s with a narrow structured error', (alphaCutoff, reason) => {
    expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], alphaCutoff })).toThrow(
      MaterialAuthoringContractError,
    );
    try {
      Materials.standard({ baseColor: [1, 1, 1, 1], alphaCutoff });
    } catch (error) {
      expect(error).toMatchObject({
        name: 'MaterialAuthoringContractError',
        code: 'material-authoring-contract-invalid',
        expected: expect.stringContaining('finite'),
        hint: expect.stringContaining('alphaCutoff'),
        detail: {
          code: 'material-authoring-contract-invalid',
          material: 'Standard',
          parameter: 'alphaCutoff',
          reason,
          actual: alphaCutoff,
        },
      });
    }
  });

  it('keeps the closed interval as a valid Standard authoring value', () => {
    expect(Materials.standard({ baseColor: [1, 1, 1, 1], alphaCutoff: 0 }).values).toMatchObject({
      alphaCutoff: 0,
    });
    expect(Materials.standard({ baseColor: [1, 1, 1, 1], alphaCutoff: 1 }).values).toMatchObject({
      alphaCutoff: 1,
    });
  });
});
