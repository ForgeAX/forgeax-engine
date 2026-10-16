// w10 - RhiDevice.createQuerySet type-level contract test (TDD red).
//
// Locks M1 createQuerySet surface (plan-tasks w10 / requirements IN-1):
//   RhiDevice.createQuerySet(desc: QuerySetDescriptor)
//     -> Result<QuerySet, RhiError>
//
// Field shape (research §1.3 IDL):
//   QuerySetDescriptor = ExplicitUndefined<
//     Pick<GPUQuerySetDescriptor, 'label' | 'type' | 'count'>
//   >
//   type: 'occlusion' | 'timestamp' (closed union, GPUQueryType).
//
// Red expected: tsc -b fails with TS2305 (missing QuerySetDescriptor) +
// TS2339 (createQuerySet missing on RhiDevice). Turns green after w12 ships.
//
// Anchors: requirements §IN-1 / §AC-01; research §1.3 IDL + Pick set;
//          plan-strategy §4.2 + K-10.

import { describe, expectTypeOf, it } from 'vitest';
import type { QuerySet, QuerySetDescriptor, Result, RhiDevice, RhiError } from '../index';

/** Strip undefined from an optional field; bridges forgeax `?: T | undefined`
 *  and spec `?: T` while comparing value types. */
type ValueOf<T, K extends keyof T> = NonNullable<T[K]>;

describe('w10 type-level - QuerySetDescriptor field set === Pick<GPUQuerySetDescriptor, ...>', () => {
  it('has exactly the keys label / type / count', () => {
    type ExpectedKeys = 'label' | 'type' | 'count';
    expectTypeOf<keyof QuerySetDescriptor>().toEqualTypeOf<ExpectedKeys>();
  });

  it('label field type aligns with spec (string | undefined)', () => {
    type LabelForgeaX = NonNullable<QuerySetDescriptor['label']>;
    type LabelSpec = NonNullable<GPUQuerySetDescriptor['label']>;
    expectTypeOf<LabelForgeaX>().toEqualTypeOf<LabelSpec>();
  });

  it("type field is a closed union 'occlusion' | 'timestamp' (GPUQueryType)", () => {
    type TypeForgeaX = ValueOf<QuerySetDescriptor, 'type'>;
    expectTypeOf<TypeForgeaX>().toEqualTypeOf<ValueOf<GPUQuerySetDescriptor, 'type'>>();
    // Sentinel assignment: both literal members are accepted.
    const _occ: QuerySetDescriptor = { type: 'occlusion', count: 4 };
    const _ts: QuerySetDescriptor = { type: 'timestamp', count: 4 };
    void _occ;
    void _ts;
  });

  it('count field is GPUSize32 (number)', () => {
    type CountForgeaX = ValueOf<QuerySetDescriptor, 'count'>;
    expectTypeOf<CountForgeaX>().toEqualTypeOf<ValueOf<GPUQuerySetDescriptor, 'count'>>();
  });

  it('S-7 optional shape: label uses `?: T | undefined`', () => {
    const _omitted: QuerySetDescriptor = { type: 'occlusion', count: 0 };
    const _explicit: QuerySetDescriptor = { label: undefined, type: 'occlusion', count: 0 };
    void _omitted;
    void _explicit;
  });
});

describe('w10 type-level - RhiDevice.createQuerySet signature', () => {
  it('returns Result<QuerySet, RhiError>', () => {
    type Sig = RhiDevice['createQuerySet'];
    type Ret = ReturnType<Sig>;
    expectTypeOf<Ret>().toEqualTypeOf<Result<QuerySet, RhiError>>();
  });

  it('takes a QuerySetDescriptor as the sole parameter', () => {
    type Sig = RhiDevice['createQuerySet'];
    type Params = Parameters<Sig>;
    expectTypeOf<Params>().toEqualTypeOf<[QuerySetDescriptor]>();
  });
});

describe('w10 type-level - QuerySet opaque handle does not expose raw GPU fields', () => {
  it('QuerySet is brand-only (no .gpuQuerySet access)', () => {
    const h = {} as QuerySet;
    // @ts-expect-error MVP-1.3: QuerySet is opaque; raw fields not exposed.
    h.gpuQuerySet;
  });
});
