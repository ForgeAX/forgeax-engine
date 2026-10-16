// w19 - RhiSurface + RhiCanvasContext type-level contract test (TDD red).
//
// Locks M3 CanvasContext surface (plan-tasks w19 / requirements IN-4 / AC-04;
// plan-strategy K-4):
//   RhiSurface — abstraction wrapping HTMLCanvasElement / OffscreenCanvas
//   RhiCanvasContext.configure(desc): Result<void, RhiError>
//   RhiCanvasContext.unconfigure(): void  (spec literal void return)
//   RhiCanvasContext.getConfiguration(): CanvasConfiguration | undefined
//   RhiCanvasContext.getCurrentTexture(): Result<Texture, RhiError> (K-4)
//
//   CanvasConfiguration = Pick<GPUCanvasConfiguration,
//     'device' | 'format' | 'usage' | 'viewFormats' | 'colorSpace' |
//     'toneMapping' | 'alphaMode'> (7 fields per spec §3.2)
//
// Red expected: tsc -b fails with TS2305 / TS2339 (missing RhiSurface /
// RhiCanvasContext / CanvasConfiguration). Turns green after w21 ships.
//
// K-4 decision: getCurrentTexture returns Result<Texture, RhiError> (NOT
// TextureView) — spec literal alignment; AI users go two-step:
//   const tex = (canvasContext.getCurrentTexture()).unwrap();
//   const view = device.createTextureView(tex, {}).unwrap();
//
// Anchors: requirements §IN-4 / §AC-04; research §3.1 4 methods + §3.2 7
//          fields; plan-strategy §2 K-4 + §6 M3 + K-10.

import { describe, expectTypeOf, it } from 'vitest';
import type {
  CanvasConfiguration,
  Result,
  RhiCanvasContext,
  RhiError,
  RhiSurface,
  Texture,
} from '../index';

describe('w19 type-level - RhiSurface abstraction', () => {
  it('RhiSurface is an abstraction over canvas surface (brand-only opaque)', () => {
    // RhiSurface wraps HTMLCanvasElement / OffscreenCanvas; the abstraction
    // is opaque from the AI-user perspective (spec couples context to canvas).
    const s = {} as RhiSurface;
    // @ts-expect-error MVP: RhiSurface is opaque; raw fields not exposed.
    s.getContext;
  });
});

describe('w19 type-level - CanvasConfiguration field set === Pick<GPUCanvasConfiguration, ...> (research §3.2 7 fields)', () => {
  it('has exactly the 7 spec keys (device / format / usage / viewFormats / colorSpace / toneMapping / alphaMode)', () => {
    type ExpectedKeys =
      | 'device'
      | 'format'
      | 'usage'
      | 'viewFormats'
      | 'colorSpace'
      | 'toneMapping'
      | 'alphaMode';
    expectTypeOf<keyof CanvasConfiguration>().toEqualTypeOf<ExpectedKeys>();
  });

  it('format is a GPUTextureFormat (forgeax form preserves spec field type)', () => {
    type FormatField = NonNullable<CanvasConfiguration['format']>;
    type SpecFormat = NonNullable<GPUCanvasConfiguration['format']>;
    expectTypeOf<FormatField>().toEqualTypeOf<SpecFormat>();
  });
});

describe('w19 type-level - RhiCanvasContext.configure signature', () => {
  it('takes CanvasConfiguration and returns Result<void, RhiError>', () => {
    type Sig = RhiCanvasContext['configure'];
    type Ret = ReturnType<Sig>;
    expectTypeOf<Ret>().toEqualTypeOf<Result<void, RhiError>>();
    type Params = Parameters<Sig>;
    expectTypeOf<Params>().toEqualTypeOf<[desc: CanvasConfiguration]>();
  });
});

describe('w19 type-level - RhiCanvasContext.unconfigure signature (spec void return)', () => {
  it('takes no arguments and returns void (spec literal alignment)', () => {
    type Sig = RhiCanvasContext['unconfigure'];
    type Ret = ReturnType<Sig>;
    expectTypeOf<Ret>().toEqualTypeOf<void>();
    type Params = Parameters<Sig>;
    expectTypeOf<Params>().toEqualTypeOf<[]>();
  });
});

describe('w19 type-level - RhiCanvasContext.getConfiguration signature', () => {
  it('returns CanvasConfiguration | undefined (feature-detection entry)', () => {
    type Sig = RhiCanvasContext['getConfiguration'];
    type Ret = ReturnType<Sig>;
    expectTypeOf<Ret>().toEqualTypeOf<CanvasConfiguration | undefined>();
  });
});

describe('w19 type-level - RhiCanvasContext.getCurrentTexture signature (K-4)', () => {
  it('returns Result<Texture, RhiError> (K-4: Texture brand, NOT TextureView)', () => {
    type Sig = RhiCanvasContext['getCurrentTexture'];
    type Ret = ReturnType<Sig>;
    expectTypeOf<Ret>().toEqualTypeOf<Result<Texture, RhiError>>();
  });

  it('takes no arguments', () => {
    type Sig = RhiCanvasContext['getCurrentTexture'];
    type Params = Parameters<Sig>;
    expectTypeOf<Params>().toEqualTypeOf<[]>();
  });
});
