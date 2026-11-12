import { describe, expect, it } from 'vitest';
import { coverageOf } from '../report';

type Code = 'a' | 'b';

describe('coverageOf', () => {
  it('counts what the checking code marked against the listed subjects', () => {
    const coverage = coverageOf<Code>(
      { a: ['x', 'y', 'z'], b: ['p'] },
      { a: new Set(['x', 'y']), b: new Set(['p']) },
    );
    expect(coverage.checked).toEqual([
      { code: 'a', subjects: 2 },
      { code: 'b', subjects: 1 },
    ]);
    expect(coverage.unchecked).toEqual([
      { code: 'a', reason: 'unsupported', subjects: 1, sample: ['z'] },
    ]);
  });

  it('shows a listed subject the loop never marked as unsupported, not as absent', () => {
    const coverage = coverageOf<Code>({ a: ['mover', 'forgotten'] }, { a: new Set(['mover']) });
    expect(coverage.unchecked).toEqual([
      { code: 'a', reason: 'unsupported', subjects: 1, sample: ['forgotten'] },
    ]);
  });

  it('gives each left-out subject its reason and caps the sample at 8 names', () => {
    const names = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const coverage = coverageOf<Code>({ a: [...names, 'm'] }, {}, [
      ...names.map((subject) => ({
        code: 'a' as const,
        subject,
        reason: 'not-requested' as const,
      })),
      { code: 'a', subject: 'm', reason: 'missing-input' },
    ]);
    expect(coverage.checked).toEqual([]);
    expect(coverage.unchecked).toEqual([
      { code: 'a', reason: 'not-requested', subjects: 12, sample: names.slice(0, 8) },
      { code: 'a', reason: 'missing-input', subjects: 1, sample: ['m'] },
    ]);
  });

  it('counts a repeated subject once and ignores a marked subject nobody listed', () => {
    const coverage = coverageOf<Code>({ a: ['x', 'x'] }, { a: new Set(['x', 'ghost']) });
    expect(coverage.checked).toEqual([{ code: 'a', subjects: 1 }]);
    expect(coverage.unchecked).toEqual([]);
  });
});
