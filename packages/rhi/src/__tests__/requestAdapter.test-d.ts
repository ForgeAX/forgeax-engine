// w17 - RhiInstance + RhiAdapter type-level contract test (TDD red).
//
// Locks M3 break-point #2 surface (plan-tasks w17 / requirements IN-4 / AC-04;
// plan-strategy K-5 + K-6):
//   RhiInstance.requestAdapter(opts?): Promise<Result<RhiAdapter, RhiError>>
//   RhiAdapter.features: ReadonlySet<GPUFeatureName>  (Round 3 fix-up F-P1-2:
//     was ReadonlyArray<string>; aligned with RhiDevice.features for cross-
//     tier shape uniformity — AI users use `.has(name)` on both layers)
//   RhiAdapter.limits: Readonly<Record<string, number>>
//   RhiAdapter.requestDevice(opts?): Promise<Result<RhiDevice, RhiError>>
//
// Strict two-step path mirrors wgpu / Dawn source (research §6); break-point
// #2 deprecates the top-level `rhi.requestDevice(opts)` factory in favour of
// `rhi.requestAdapter() -> adapter.requestDevice(opts)`.
//
// Red expected: tsc -b fails with TS2305 / TS2339 (missing RhiInstance /
// RhiAdapter / RequestAdapterOptions / RequestDeviceOptions). Turns green
// after w18 ships.
//
// F-1 ai-user-review absorption: readonly REVERSE assertions ensure mutation
// of `features[0]` / `limits['x']` is rejected at compile time (charter
// proposition 4 explicit failure + proposition 5 consistent abstraction).
//
// Anchors: requirements §IN-4 / §AC-04 / break-point #2; research §6.1 + §6.2
//          + §6.3 wgpu / Dawn strict two-step source; plan-strategy §2 K-5 +
//          K-6 + §6 M3 + K-10.

import { describe, expectTypeOf, it } from 'vitest';
import type {
  RequestAdapterOptions,
  RequestDeviceOptions,
  Result,
  RhiAdapter,
  RhiCanvasTarget,
  RhiDevice,
  RhiError,
  RhiInstance,
} from '../index';

describe('w17 type-level - RhiInstance.requestAdapter signature (K-5 / break-point #2)', () => {
  it('returns Promise<Result<RhiAdapter, RhiError>>', () => {
    type Sig = RhiInstance['requestAdapter'];
    type Ret = ReturnType<Sig>;
    expectTypeOf<Ret>().toEqualTypeOf<Promise<Result<RhiAdapter, RhiError>>>();
  });

  it('takes optional RequestAdapterOptions + compatibleSurface parameters', () => {
    type Sig = RhiInstance['requestAdapter'];
    type Params = Parameters<Sig>;
    expectTypeOf<Params>().toEqualTypeOf<
      [opts?: RequestAdapterOptions | undefined, compatibleSurface?: RhiCanvasTarget | undefined]
    >();
  });
});

describe('w17 type-level - RhiAdapter.features is ReadonlySet<GPUFeatureName> (K-5 / F-P1-2)', () => {
  it('features field type is ReadonlySet<GPUFeatureName>', () => {
    expectTypeOf<RhiAdapter['features']>().toEqualTypeOf<ReadonlySet<GPUFeatureName>>();
  });

  it('mutating features.add(...) is rejected at compile time (F-1 readonly REVERSE)', () => {
    const adapter = {} as RhiAdapter;
    // @ts-expect-error F-1 ai-user-review: ReadonlySet rejects .add()
    adapter.features.add('timestamp-query');
  });

  it('mutating features.delete(...) is rejected at compile time (F-1)', () => {
    const adapter = {} as RhiAdapter;
    // @ts-expect-error F-1 ai-user-review: ReadonlySet rejects .delete()
    adapter.features.delete('timestamp-query');
  });

  it('mutating features.clear() is rejected at compile time (F-1)', () => {
    const adapter = {} as RhiAdapter;
    // @ts-expect-error F-1 ai-user-review: ReadonlySet rejects .clear()
    adapter.features.clear();
  });

  it('reassigning features whole set is rejected at compile time (F-1)', () => {
    const adapter = {} as RhiAdapter;
    // @ts-expect-error features is a readonly property
    adapter.features = new Set();
  });

  it('.has(name) is the supported read API (cross-tier uniform with RhiDevice.features)', () => {
    const adapter = {} as RhiAdapter;
    expectTypeOf(adapter.features.has('timestamp-query')).toEqualTypeOf<boolean>();
  });
});

describe('w17 type-level - RhiAdapter.limits is Readonly<Record<string, number>> (K-5)', () => {
  it('limits field type is Readonly<Record<string, number>>', () => {
    expectTypeOf<RhiAdapter['limits']>().toEqualTypeOf<Readonly<Record<string, number>>>();
  });

  it('mutating limits["x"] is rejected at compile time (F-1 readonly REVERSE)', () => {
    const adapter = {} as RhiAdapter;
    // @ts-expect-error F-1 ai-user-review: limits['x'] write is rejected by TS
    adapter.limits.x = 0;
  });

  it('reassigning limits whole record is rejected at compile time (F-1)', () => {
    const adapter = {} as RhiAdapter;
    // @ts-expect-error limits is a readonly property
    adapter.limits = { x: 0 };
  });
});

describe('w17 type-level - RhiAdapter.requestDevice signature (K-6)', () => {
  it('returns Promise<Result<RhiDevice, RhiError>> (NOT a tuple)', () => {
    type Sig = RhiAdapter['requestDevice'];
    type Ret = ReturnType<Sig>;
    expectTypeOf<Ret>().toEqualTypeOf<Promise<Result<RhiDevice, RhiError>>>();
  });

  it('takes an optional RequestDeviceOptions parameter', () => {
    type Sig = RhiAdapter['requestDevice'];
    type Params = Parameters<Sig>;
    expectTypeOf<Params>().toEqualTypeOf<[opts?: RequestDeviceOptions | undefined]>();
  });
});
