// w03 - RhiDevice.createTextureView type-level contract test (TDD red).
//
// Locks M1 createTextureView surface (plan-tasks w03 / requirements IN-1):
//   RhiDevice.createTextureView(texture: Texture, desc: TextureViewDescriptor)
//     -> Result<TextureView, RhiError>
//
// Field shape: TextureViewDescriptor = ExplicitUndefined<
//   Pick<GPUTextureViewDescriptor,
//     'format' | 'dimension' | 'usage' | 'aspect' | 'baseMipLevel' |
//     'mipLevelCount' | 'baseArrayLayer' | 'arrayLayerCount' | 'label'
//   >
// >
//
// Red expected state: this file fails tsc -b until w06 ships
//   (1) the `TextureViewDescriptor` type alias on `@forgeax/engine-rhi`,
//   (2) the `RhiDevice.createTextureView` method signature.
// Green expected state (after w06 commit): all expectTypeOf assertions pass.
//
// Anchors: requirements §IN-1 / §AC-01 / §AC-07(a); research §1.1 9 fields
//          (excl swizzle feature-gate); plan-strategy §4.2 type layer + K-10;
//          AI User Charter proposition 1 progressive disclosure +
//          proposition 5 consistent abstraction (single createX entry).

import { describe, expectTypeOf, it } from 'vitest';
import type {
  Result,
  RhiDevice,
  RhiError,
  Texture,
  TextureView,
  TextureViewDescriptor,
} from '../index';

/** Strip undefined from an optional field; bridges forgeax `?: T | undefined`
 *  and spec `?: T` while comparing value types. */
type ValueOf<T, K extends keyof T> = NonNullable<T[K]>;

describe('w03 type-level - TextureViewDescriptor field set === Pick<GPUTextureViewDescriptor, ...> (research §1.1 9 fields, swizzle excluded)', () => {
  it('has exactly the 9 spec keys (label / format / dimension / usage / aspect / baseMipLevel / mipLevelCount / baseArrayLayer / arrayLayerCount)', () => {
    type ExpectedKeys =
      | 'label'
      | 'format'
      | 'dimension'
      | 'usage'
      | 'aspect'
      | 'baseMipLevel'
      | 'mipLevelCount'
      | 'baseArrayLayer'
      | 'arrayLayerCount';
    expectTypeOf<keyof TextureViewDescriptor>().toEqualTypeOf<ExpectedKeys>();
  });

  it('format / dimension / usage value types align with spec', () => {
    expectTypeOf<ValueOf<TextureViewDescriptor, 'format'>>().toEqualTypeOf<
      ValueOf<GPUTextureViewDescriptor, 'format'>
    >();
    expectTypeOf<ValueOf<TextureViewDescriptor, 'dimension'>>().toEqualTypeOf<
      ValueOf<GPUTextureViewDescriptor, 'dimension'>
    >();
    expectTypeOf<ValueOf<TextureViewDescriptor, 'usage'>>().toEqualTypeOf<
      ValueOf<GPUTextureViewDescriptor, 'usage'>
    >();
  });

  it('aspect / baseMipLevel / mipLevelCount / baseArrayLayer / arrayLayerCount value types align with spec', () => {
    expectTypeOf<ValueOf<TextureViewDescriptor, 'aspect'>>().toEqualTypeOf<
      ValueOf<GPUTextureViewDescriptor, 'aspect'>
    >();
    expectTypeOf<ValueOf<TextureViewDescriptor, 'baseMipLevel'>>().toEqualTypeOf<
      ValueOf<GPUTextureViewDescriptor, 'baseMipLevel'>
    >();
    expectTypeOf<ValueOf<TextureViewDescriptor, 'mipLevelCount'>>().toEqualTypeOf<
      ValueOf<GPUTextureViewDescriptor, 'mipLevelCount'>
    >();
    expectTypeOf<ValueOf<TextureViewDescriptor, 'baseArrayLayer'>>().toEqualTypeOf<
      ValueOf<GPUTextureViewDescriptor, 'baseArrayLayer'>
    >();
    expectTypeOf<ValueOf<TextureViewDescriptor, 'arrayLayerCount'>>().toEqualTypeOf<
      ValueOf<GPUTextureViewDescriptor, 'arrayLayerCount'>
    >();
  });

  it('S-7 optional shape: every field uses `?: T | undefined` (omitted vs explicit-undefined both legal)', () => {
    const _empty: TextureViewDescriptor = {};
    const _explicit: TextureViewDescriptor = {
      label: undefined,
      format: undefined,
      dimension: undefined,
      usage: undefined,
      aspect: undefined,
      baseMipLevel: undefined,
      mipLevelCount: undefined,
      baseArrayLayer: undefined,
      arrayLayerCount: undefined,
    };
    void _empty;
    void _explicit;
  });

  it('swizzle is NOT exposed (research §1.1 OOS-MVP feature-gated)', () => {
    type Keys = keyof TextureViewDescriptor;
    type HasSwizzle = 'swizzle' extends Keys ? true : false;
    expectTypeOf<HasSwizzle>().toEqualTypeOf<false>();
  });
});

describe('w03 type-level - RhiDevice.createTextureView signature', () => {
  it('returns Result<TextureView, RhiError>', () => {
    type Sig = RhiDevice['createTextureView'];
    type Ret = ReturnType<Sig>;
    expectTypeOf<Ret>().toEqualTypeOf<Result<TextureView, RhiError>>();
  });

  it('takes (texture: Texture, desc: TextureViewDescriptor) as parameters', () => {
    type Sig = RhiDevice['createTextureView'];
    type Params = Parameters<Sig>;
    expectTypeOf<Params>().toEqualTypeOf<[Texture, TextureViewDescriptor]>();
  });
});

describe('w03 type-level - TextureView opaque handle does not expose raw GPU fields', () => {
  it('TextureView is brand-only (no .gpuTextureView access)', () => {
    const h = {} as TextureView;
    // @ts-expect-error MVP-1.3: TextureView is opaque; gpuTextureView is not exposed.
    h.gpuTextureView;
  });
});
