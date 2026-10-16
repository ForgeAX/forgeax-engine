// pack-error-detail-narrowed.test-d - PackErrorDetail variant narrowing
// type-test (feat-20260608-scene-nesting-ecs-fication M1 / w5).
//
// Coverage (AC-04 / AC-05 / AC-06 / AC-07 / AC-08):
//   - the four NEW variants (mount-localid-overlap / mount-count-mismatch /
//     mount-override-localid-out-of-range / mount-override-unknown-field)
//     each carry a `code` discriminant + the per-AC narrowed fields;
//   - the EVOLVED `pack-cyclic-reference` variant gains a `kind:
//     'childof' | 'mount-asset'` discriminant alongside the existing
//     `cycle: readonly string[]` so build-time mount-asset cycles and
//     runtime ChildOf cycles share one code but stay narrowable (R10).
//
// TDD red signal: assertions below reference variants whose shape is only
// added by w8. Until w8 the file fails to compile (vitest --typecheck).
//
// Charter mapping: proposition 3 (machine-readable union > prose) +
// proposition 4 (explicit failure: discriminated detail narrowed by code)
// + proposition 5 (consistent abstraction: variants follow the
// PackErrorCode → PackErrorDetail mapping pattern).

import { describe, expectTypeOf, it } from 'vitest';
import type { PackErrorDetail } from '../index';

// Helper: extract the detail variant whose .code matches Code from
// PackErrorDetail. Mirrors the runtime narrowing produced by switch
// (err.code) without relying on runtime values.
type DetailFor<Code extends string> = Extract<PackErrorDetail, { readonly code: Code }>;

describe('pack-mount-localid-overlap detail (AC-04)', () => {
  it('narrows to { code, overlapping, sources }', () => {
    type D = DetailFor<'pack-mount-localid-overlap'>;
    expectTypeOf<D['code']>().toEqualTypeOf<'pack-mount-localid-overlap'>();
    expectTypeOf<D['overlapping']>().toEqualTypeOf<readonly number[]>();
    expectTypeOf<D['sources']>().toEqualTypeOf<readonly string[]>();
  });
});

describe('pack-mount-count-mismatch detail (AC-05)', () => {
  it('narrows to { code, mountLocalId, declared, actual }', () => {
    type D = DetailFor<'pack-mount-count-mismatch'>;
    expectTypeOf<D['code']>().toEqualTypeOf<'pack-mount-count-mismatch'>();
    expectTypeOf<D['mountLocalId']>().toEqualTypeOf<number>();
    expectTypeOf<D['declared']>().toEqualTypeOf<number>();
    expectTypeOf<D['actual']>().toEqualTypeOf<number>();
  });
});

describe('pack-mount-override-localid-out-of-range detail (AC-06)', () => {
  it('narrows to { code, overrideLocalId, mountLocalId, memberCount }', () => {
    type D = DetailFor<'pack-mount-override-localid-out-of-range'>;
    expectTypeOf<D['code']>().toEqualTypeOf<'pack-mount-override-localid-out-of-range'>();
    expectTypeOf<D['overrideLocalId']>().toEqualTypeOf<number>();
    expectTypeOf<D['mountLocalId']>().toEqualTypeOf<number>();
    expectTypeOf<D['memberCount']>().toEqualTypeOf<number>();
  });
});

describe('pack-mount-override-unknown-field detail (AC-07)', () => {
  it('narrows to { code, comp, field, mountLocalId }', () => {
    type D = DetailFor<'pack-mount-override-unknown-field'>;
    expectTypeOf<D['code']>().toEqualTypeOf<'pack-mount-override-unknown-field'>();
    expectTypeOf<D['comp']>().toEqualTypeOf<string>();
    expectTypeOf<D['field']>().toEqualTypeOf<string>();
    expectTypeOf<D['mountLocalId']>().toEqualTypeOf<number>();
  });
});

describe('pack-cyclic-reference detail evolution (AC-08; R10)', () => {
  it('narrows to { code, kind, cycle } so ChildOf vs mount-asset stay distinguishable', () => {
    type D = DetailFor<'pack-cyclic-reference'>;
    expectTypeOf<D['code']>().toEqualTypeOf<'pack-cyclic-reference'>();
    expectTypeOf<D['kind']>().toEqualTypeOf<'childof' | 'mount-asset'>();
    expectTypeOf<D['cycle']>().toEqualTypeOf<readonly string[]>();
  });

  it('rt: detail narrows on detail.kind === "childof"', () => {
    // Compile-time exercise: starting from a generic detail, branch on
    // detail.kind to confirm the runtime narrowing keeps detail.cycle
    // accessible for both cycle producers (build-time mount-asset edge
    // detection, runtime ChildOf relationship cycle).
    function inspectChildOfCycle(detail: DetailFor<'pack-cyclic-reference'>): readonly string[] {
      return detail.kind === 'childof' ? detail.cycle : detail.cycle;
    }
    expectTypeOf(inspectChildOfCycle).returns.toEqualTypeOf<readonly string[]>();
  });
});
