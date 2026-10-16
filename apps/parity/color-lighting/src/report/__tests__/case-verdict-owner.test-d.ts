import { describe, expectTypeOf, it } from 'vitest';
import type { CaseReport } from '../../contracts/types';
import type { CaseVerdict } from '../status';

describe('parity case verdict owner', () => {
  it('keeps the CaseReport projection exact in both directions', () => {
    expectTypeOf<CaseReport['verdict']>().toEqualTypeOf<CaseVerdict>();
    expectTypeOf<CaseVerdict>().toEqualTypeOf<CaseReport['verdict']>();

    const acceptsOwner = (verdict: CaseVerdict): CaseVerdict => verdict;
    const acceptsProjection = (verdict: CaseReport['verdict']): CaseReport['verdict'] => verdict;

    acceptsOwner('notRun');
    acceptsOwner('failed');
    acceptsOwner('passed');
    acceptsProjection('notRun');
    acceptsProjection('failed');
    acceptsProjection('passed');
    // @ts-expect-error Unknown case verdicts remain outside the report owner.
    acceptsOwner('unknown-case-verdict');
    // @ts-expect-error Unknown case verdicts remain outside the report projection.
    acceptsProjection('unknown-case-verdict');
  });
});
