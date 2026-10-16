import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contract = JSON.parse(
  readFileSync(new URL('../../scripts/field-matrix-cases.json', import.meta.url), 'utf8'),
) as { coreCases: string[]; supplementalCases: string[] };

describe('ROI 21 field effect matrix', () => {
  it('keeps the 22 frozen cases and affine spatial supplement', () => {
    const cases = [...contract.coreCases, ...contract.supplementalCases];
    expect(contract.coreCases).toHaveLength(22);
    expect(contract.supplementalCases).toEqual(['affine-spatial']);
    expect(cases).toHaveLength(23);
    expect(new Set(cases).size).toBe(23);
  });
});
