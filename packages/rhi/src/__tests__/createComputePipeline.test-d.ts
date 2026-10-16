// w07 - RhiDevice.createComputePipeline type-level contract test (TDD red).
//
// Locks M1 createComputePipeline surface (plan-tasks w07 / requirements IN-1):
//   RhiDevice.createComputePipeline(desc: ComputePipelineDescriptor)
//     -> Result<ComputePipeline, RhiError>
//
// Field shape (research §1.2 IDL):
//   ComputePipelineDescriptor = ExplicitUndefined<
//     Pick<GPUComputePipelineDescriptor, 'label' | 'layout' | 'compute'>
//   > with the spec polymorphism `(GPUAutoLayoutMode or GPUPipelineLayout)`
//   tightened to the forgeax union `'auto' | PipelineLayout` (D-S5 pattern),
//   and `compute.module` tightened to the forgeax `ShaderModule` opaque handle.
//
// Red expected: tsc -b fails with TS2724 (missing ComputePipelineDescriptor)
// + TS2339 (createComputePipeline missing on RhiDevice). Turns green after
// w09 ships interface + shim.
//
// Anchors: requirements §IN-1 / §AC-01; research §1.2 IDL + 'auto' vs
//          explicit PipelineLayout double form; plan-strategy §4.2 + K-10.

import { describe, expectTypeOf, it } from 'vitest';
import type {
  ComputePipeline,
  ComputePipelineDescriptor,
  PipelineLayout,
  Result,
  RhiDevice,
  RhiError,
  ShaderModule,
} from '../index';

/** Strip undefined from an optional field; bridges forgeax `?: T | undefined`
 *  and spec `?: T` while comparing value types. */
type ValueOf<T, K extends keyof T> = NonNullable<T[K]>;

describe('w07 type-level - ComputePipelineDescriptor field set === Pick<GPUComputePipelineDescriptor, ...>', () => {
  it('has exactly the keys label / layout / compute', () => {
    type ExpectedKeys = 'label' | 'layout' | 'compute';
    expectTypeOf<keyof ComputePipelineDescriptor>().toEqualTypeOf<ExpectedKeys>();
  });

  it('label field type aligns with spec (string | undefined)', () => {
    type LabelForgeaX = NonNullable<ComputePipelineDescriptor['label']>;
    type LabelSpec = NonNullable<GPUComputePipelineDescriptor['label']>;
    expectTypeOf<LabelForgeaX>().toEqualTypeOf<LabelSpec>();
  });
});

describe("w07 type-level - layout union 'auto' | PipelineLayout", () => {
  it("layout: 'auto' literal is a legal assignment", () => {
    const psm = {} as ShaderModule;
    const _auto: ComputePipelineDescriptor = {
      layout: 'auto',
      compute: { module: psm },
    };
    void _auto;
  });

  it('layout: PipelineLayout brand is a legal assignment', () => {
    const psm = {} as ShaderModule;
    const pl = {} as PipelineLayout;
    const _explicit: ComputePipelineDescriptor = {
      layout: pl,
      compute: { module: psm },
    };
    void _explicit;
  });

  it("layout type is exactly 'auto' | PipelineLayout (no spec polymorphism leak)", () => {
    type Layout = ComputePipelineDescriptor['layout'];
    expectTypeOf<Layout>().toEqualTypeOf<'auto' | PipelineLayout>();
  });
});

describe('w07 type-level - compute nested dictionary mirrors GPUProgrammableStage', () => {
  it('compute.module is the forgeax ShaderModule opaque handle (not GPUShaderModule)', () => {
    type ModuleForgeaX = ComputePipelineDescriptor['compute']['module'];
    expectTypeOf<ModuleForgeaX>().toEqualTypeOf<ShaderModule>();
  });

  it('compute.entryPoint is optional string | undefined', () => {
    const psm = {} as ShaderModule;
    const _withEntry: ComputePipelineDescriptor = {
      layout: 'auto',
      compute: { module: psm, entryPoint: 'cs_main' },
    };
    const _withoutEntry: ComputePipelineDescriptor = {
      layout: 'auto',
      compute: { module: psm },
    };
    const _explicitUndef: ComputePipelineDescriptor = {
      layout: 'auto',
      compute: { module: psm, entryPoint: undefined },
    };
    void _withEntry;
    void _withoutEntry;
    void _explicitUndef;
  });

  it('compute.constants is optional Record<string, number>', () => {
    const psm = {} as ShaderModule;
    const _withConsts: ComputePipelineDescriptor = {
      layout: 'auto',
      compute: { module: psm, constants: { foo: 1.0, bar: 2.5 } },
    };
    void _withConsts;
  });
});

describe('w07 type-level - RhiDevice.createComputePipeline signature', () => {
  it('returns Result<ComputePipeline, RhiError>', () => {
    type Sig = RhiDevice['createComputePipeline'];
    type Ret = ReturnType<Sig>;
    expectTypeOf<Ret>().toEqualTypeOf<Result<ComputePipeline, RhiError>>();
  });

  it('takes a ComputePipelineDescriptor as the sole parameter', () => {
    type Sig = RhiDevice['createComputePipeline'];
    type Params = Parameters<Sig>;
    expectTypeOf<Params>().toEqualTypeOf<[ComputePipelineDescriptor]>();
  });
});

describe('w07 type-level - ComputePipeline opaque handle does not expose raw GPU fields', () => {
  it('ComputePipeline is brand-only (no .gpuComputePipeline access)', () => {
    const h = {} as ComputePipeline;
    // @ts-expect-error MVP-1.3: ComputePipeline is opaque; raw fields not exposed.
    h.gpuComputePipeline;
  });

  it('S-7 optional shape: label uses `?: T | undefined`', () => {
    const psm = {} as ShaderModule;
    const _omitted: ComputePipelineDescriptor = {
      layout: 'auto',
      compute: { module: psm },
    };
    const _explicit: ComputePipelineDescriptor = {
      label: undefined,
      layout: 'auto',
      compute: { module: psm },
    };
    void _omitted;
    void _explicit;
    type LabelType = ComputePipelineDescriptor['label'];
    expectTypeOf<NonNullable<LabelType>>().toEqualTypeOf<
      ValueOf<GPUComputePipelineDescriptor, 'label'>
    >();
  });
});
