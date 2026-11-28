import { definePackageId, executePackBuild } from '@forgeax/engine-pack/source';
import { sheet } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { BRACKET_ALLOWANCE, bracketSpec, buildSheetBracket, SHEET_BRACKET } from '../body';
import pack from '../bracket.pack';

describe('sheet-metal U bracket', () => {
  it('folds a closed, valid body from its flat pattern', () => {
    const m = buildSheetBracket();
    expect(m.poisoned).toBeUndefined();
    const report = m.validate();
    expect(report.pass).toBe(true);
    expect(report.closed).toBe(true);
  });

  it('keeps the flat pattern fixed while the fold angle changes', () => {
    const outline = (degrees: number) => JSON.stringify(bracketSpec(degrees).outline);
    expect(new Set([30, 60, 90, 120].map(outline)).size).toBe(1);
    for (const degrees of [30, 60, 90]) {
      const flat = sheet.flat(bracketSpec(degrees));
      expect(flat.ok).toBe(true);
    }
  });

  it('allows one 90 degree bend per flange', () => {
    expect(BRACKET_ALLOWANCE).toBeCloseTo(
      sheet.bendAllowance(90, SHEET_BRACKET.radius, SHEET_BRACKET.thickness, SHEET_BRACKET.kFactor),
      15,
    );
  });

  it('is an ordinary Pack build with a mesh/sheet-bracket output', async () => {
    const result = await executePackBuild(pack, {
      packageId: definePackageId('01900000-0000-7000-8000-0000000c5011'),
      readByGuid: async () => {
        throw new Error('the sheet bracket reads no other asset');
      },
      values: { fold: 90 },
    });
    if (!result.ok) throw result.error;
    expect(Object.keys(result.value)).toEqual(['mesh/sheet-bracket']);
  });
});
