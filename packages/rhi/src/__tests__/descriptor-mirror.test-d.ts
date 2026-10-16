// MVP-1.1 - 5 core descriptors mirror @webgpu/types (type-level red -> green).
// Extended in feat-20260508-rhi-surface-completion w8 (D-S5) with 4 new
// descriptors: CommandEncoderDescriptor / RenderPassColorAttachment /
// RenderPassDepthStencilAttachment / RenderPassDescriptor.
//
// Mirror policy (decision S-7 + research F-3):
// - Field NAMES align byte-for-byte with spec: keyof forgeax === locked key
//   list === keyof Pick<spec, ...>.
// - Field VALUE types (NonNullable) align with spec: forgeax[K] minus undefined
//   === spec[K] minus undefined.
// - Optional shape: forgeax writes `?: T | undefined` (decision S-7); spec
//   v0.1.69 writes `?: T` (ecosystem upstream pending migration); the
//   ExplicitUndefined mapped type bridges them, allowing
//   `{ label: undefined }` writes (charter proposition 4: explicit failure /
//   distinguish missing vs explicit-undefined).
//
// view narrow Path X (feat-20260510-rhi-resource-creation M2 / breakage point
// #1): the `view` field on RenderPassColorAttachment /
// RenderPassDepthStencilAttachment is NARROWED to the forgeax `TextureView`
// brand (instead of the spec polymorphism `GPUTexture | GPUTextureView`).
// This breaks field-type alignment but preserves field-name alignment (R12
// lint scope). Charter proposition 5 (consistent abstraction) over
// proposition 1 (strict spec shape) so AI users land on the single
// constructable brand: `device.createTextureView(tex, {}).unwrap()`. The
// earlier D-S5 tightening to `Texture` was retired with M1 of this closure.
//
// Related: requirements AC MVP-1.1 (5 descriptors + field-name byte-for-byte) +
//          AC-RSC-08 (4 new descriptors + view tightening); plan-strategy 4.3
//          key tests #1; 7 propositions 4 / 5; research F-1 / F-3 / F-7;
//          plan-strategy 2 D-S3 / D-S5 / D-S7.

import { describe, expectTypeOf, it } from 'vitest';
import type {
  BindGroupLayoutDescriptor,
  BindGroupLayoutEntry,
  BufferDescriptor,
  CommandEncoderDescriptor,
  PipelineLayout,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RenderPassDescriptor,
  RenderPassTimestampWrites,
  RenderPipelineDescriptor,
  RenderPipelineFragmentState,
  RenderPipelineVertexState,
  SamplerDescriptor,
  TextureDescriptor,
  TextureFormat,
  TextureView,
} from '../index';

/** Strip undefined from an optional field; bridges forgeax `?: T | undefined`
 *  and spec `?: T` while comparing value types. */
type ValueOf<T, K extends keyof T> = NonNullable<T[K]>;

describe('MVP-1.1 - 5 descriptors mirror @webgpu/types', () => {
  it('BufferDescriptor field set === Pick<GPUBufferDescriptor, ...>', () => {
    type BufferKeys = 'label' | 'size' | 'usage' | 'mappedAtCreation';
    expectTypeOf<keyof BufferDescriptor>().toEqualTypeOf<BufferKeys>();
    expectTypeOf<ValueOf<BufferDescriptor, 'label'>>().toEqualTypeOf<
      ValueOf<GPUBufferDescriptor, 'label'>
    >();
    expectTypeOf<ValueOf<BufferDescriptor, 'size'>>().toEqualTypeOf<
      ValueOf<GPUBufferDescriptor, 'size'>
    >();
    expectTypeOf<ValueOf<BufferDescriptor, 'usage'>>().toEqualTypeOf<
      ValueOf<GPUBufferDescriptor, 'usage'>
    >();
    expectTypeOf<ValueOf<BufferDescriptor, 'mappedAtCreation'>>().toEqualTypeOf<
      ValueOf<GPUBufferDescriptor, 'mappedAtCreation'>
    >();
    // S-7: writing `{ label: undefined }` is legal under exactOptionalPropertyTypes.
    const b: BufferDescriptor = { size: 16, usage: 0, label: undefined };
    expectTypeOf(b).toMatchTypeOf<BufferDescriptor>();
  });

  it('TextureDescriptor field set === Pick<GPUTextureDescriptor, ...> (incl R8 Compatibility Mode)', () => {
    type TextureKeys =
      | 'label'
      | 'size'
      | 'mipLevelCount'
      | 'sampleCount'
      | 'dimension'
      | 'format'
      | 'usage'
      | 'viewFormats'
      | 'textureBindingViewDimension';
    expectTypeOf<keyof TextureDescriptor>().toEqualTypeOf<TextureKeys>();
    expectTypeOf<ValueOf<TextureDescriptor, 'format'>>().toEqualTypeOf<
      ValueOf<GPUTextureDescriptor, 'format'>
    >();
    expectTypeOf<ValueOf<TextureDescriptor, 'usage'>>().toEqualTypeOf<
      ValueOf<GPUTextureDescriptor, 'usage'>
    >();
    expectTypeOf<ValueOf<TextureDescriptor, 'textureBindingViewDimension'>>().toEqualTypeOf<
      ValueOf<GPUTextureDescriptor, 'textureBindingViewDimension'>
    >();
    // Explicit `undefined` writes are legal (R8 Compatibility Mode follow-on).
    const t: TextureDescriptor = {
      size: [128, 128],
      format: 'rgba8unorm',
      usage: 0,
      textureBindingViewDimension: undefined,
    };
    expectTypeOf(t).toMatchTypeOf<TextureDescriptor>();
  });

  it('SamplerDescriptor field set === Pick<GPUSamplerDescriptor, ...>', () => {
    type SamplerKeys =
      | 'label'
      | 'addressModeU'
      | 'addressModeV'
      | 'addressModeW'
      | 'magFilter'
      | 'minFilter'
      | 'mipmapFilter'
      | 'lodMinClamp'
      | 'lodMaxClamp'
      | 'compare'
      | 'maxAnisotropy';
    expectTypeOf<keyof SamplerDescriptor>().toEqualTypeOf<SamplerKeys>();
    expectTypeOf<ValueOf<SamplerDescriptor, 'compare'>>().toEqualTypeOf<
      ValueOf<GPUSamplerDescriptor, 'compare'>
    >();
    expectTypeOf<ValueOf<SamplerDescriptor, 'magFilter'>>().toEqualTypeOf<
      ValueOf<GPUSamplerDescriptor, 'magFilter'>
    >();
  });

  it('BindGroupLayoutDescriptor field set === Pick<GPUBindGroupLayoutDescriptor, ...>', () => {
    type BglKeys = 'label' | 'entries';
    expectTypeOf<keyof BindGroupLayoutDescriptor>().toEqualTypeOf<BglKeys>();
    // Entries are the spec entry plus the capability-gated acceleration-structure member.
    expectTypeOf<GPUBindGroupLayoutEntry>().toMatchTypeOf<BindGroupLayoutEntry>();
    expectTypeOf<ValueOf<BindGroupLayoutDescriptor, 'entries'>>().toEqualTypeOf<
      Iterable<BindGroupLayoutEntry>
    >();
  });

  it('RenderPipelineDescriptor field set === Pick<GPURenderPipelineDescriptor, ...>', () => {
    type RppKeys =
      | 'label'
      | 'layout'
      | 'vertex'
      | 'primitive'
      | 'depthStencil'
      | 'multisample'
      | 'fragment';
    expectTypeOf<keyof RenderPipelineDescriptor>().toEqualTypeOf<RppKeys>();
    expectTypeOf<
      ValueOf<RenderPipelineDescriptor, 'vertex'>
    >().toEqualTypeOf<RenderPipelineVertexState>();
    expectTypeOf<
      ValueOf<RenderPipelineDescriptor, 'fragment'>
    >().toEqualTypeOf<RenderPipelineFragmentState>();
    expectTypeOf<ValueOf<RenderPipelineDescriptor, 'layout'>>().toEqualTypeOf<
      'auto' | PipelineLayout
    >();
  });
});

describe('M4 RHI descriptor mirror', () => {
  it('uses the spec TextureFormat union for texture descriptors', () => {
    expectTypeOf<NonNullable<TextureDescriptor['format']>>().toEqualTypeOf<TextureFormat>();
    const invalid: TextureDescriptor = {
      // @ts-expect-error -- RHI descriptors reject arbitrary format strings.
      format: 'not-a-texture-format',
      size: { width: 1, height: 1 },
      usage: 0,
    };
    void invalid;
  });
});

// w8: 4 new descriptors (D-S5) - field NAMES align byte-for-byte with spec;
// the `view` field TYPE is tightened to `Texture` (spec has
// `GPUTexture | GPUTextureView`).
describe('w8 - 4 new descriptors mirror @webgpu/types (D-S5)', () => {
  it('CommandEncoderDescriptor field set === Pick<GPUCommandEncoderDescriptor, label>', () => {
    type CmdKeys = 'label';
    expectTypeOf<keyof CommandEncoderDescriptor>().toEqualTypeOf<CmdKeys>();
    expectTypeOf<ValueOf<CommandEncoderDescriptor, 'label'>>().toEqualTypeOf<
      ValueOf<GPUCommandEncoderDescriptor, 'label'>
    >();
    const desc: CommandEncoderDescriptor = { label: 'frame-encoder' };
    expectTypeOf(desc).toMatchTypeOf<CommandEncoderDescriptor>();
  });

  it('RenderPassColorAttachment field set === Pick + view aligned to TextureView (view narrow Path X)', () => {
    type AttKeys = 'view' | 'depthSlice' | 'resolveTarget' | 'clearValue' | 'loadOp' | 'storeOp';
    expectTypeOf<keyof RenderPassColorAttachment>().toEqualTypeOf<AttKeys>();
    // view is the forgeax TextureView handle, NOT spec polymorphism.
    // (feat-20260510-rhi-resource-creation M2 view narrow Path X / breakage
    // point #1: the earlier D-S5 temporary tightening to Texture was
    // retired once M1 shipped RhiDevice.createTextureView.)
    expectTypeOf<RenderPassColorAttachment['view']>().toEqualTypeOf<TextureView>();
    // resolveTarget shares the same view narrow alignment.
    expectTypeOf<
      NonNullable<RenderPassColorAttachment['resolveTarget']>
    >().toEqualTypeOf<TextureView>();
    // Other fields keep spec types.
    expectTypeOf<ValueOf<RenderPassColorAttachment, 'loadOp'>>().toEqualTypeOf<
      ValueOf<GPURenderPassColorAttachment, 'loadOp'>
    >();
    expectTypeOf<ValueOf<RenderPassColorAttachment, 'storeOp'>>().toEqualTypeOf<
      ValueOf<GPURenderPassColorAttachment, 'storeOp'>
    >();
    expectTypeOf<ValueOf<RenderPassColorAttachment, 'clearValue'>>().toEqualTypeOf<
      ValueOf<GPURenderPassColorAttachment, 'clearValue'>
    >();
  });

  it('RenderPassDepthStencilAttachment field set === Pick + view aligned to TextureView (view narrow Path X)', () => {
    type DsKeys =
      | 'view'
      | 'depthClearValue'
      | 'depthLoadOp'
      | 'depthStoreOp'
      | 'depthReadOnly'
      | 'stencilClearValue'
      | 'stencilLoadOp'
      | 'stencilStoreOp'
      | 'stencilReadOnly';
    expectTypeOf<keyof RenderPassDepthStencilAttachment>().toEqualTypeOf<DsKeys>();
    expectTypeOf<RenderPassDepthStencilAttachment['view']>().toEqualTypeOf<TextureView>();
    expectTypeOf<ValueOf<RenderPassDepthStencilAttachment, 'depthClearValue'>>().toEqualTypeOf<
      ValueOf<GPURenderPassDepthStencilAttachment, 'depthClearValue'>
    >();
    expectTypeOf<ValueOf<RenderPassDepthStencilAttachment, 'depthLoadOp'>>().toEqualTypeOf<
      ValueOf<GPURenderPassDepthStencilAttachment, 'depthLoadOp'>
    >();
  });

  // w40 (M5) - BufferDescriptor.mappedAtCreation mirror extension. Pairs
  // with K-7 (mappedAtCreation passthrough fix) by locking the type-level
  // contract: forgeax field is `boolean | undefined` (forgeax
  // ExplicitUndefined<...>) and the underlying value type matches
  // @webgpu/types.GPUBufferDescriptor.mappedAtCreation byte-for-byte.
  // Anchors: requirements §IN-5 F-4 / AC-05; research §4.3 +
  // plan-strategy §4.2 type layer + K-10.
  it('BufferDescriptor.mappedAtCreation field is `boolean | undefined` and matches GPUBufferDescriptor.mappedAtCreation', () => {
    // Field is part of the Pick<> set (already covered above; re-anchor here
    // so a future Pick<> edit that drops the field is caught by w40 too).
    type HasMappedAtCreation = 'mappedAtCreation' extends keyof BufferDescriptor ? true : false;
    expectTypeOf<HasMappedAtCreation>().toEqualTypeOf<true>();
    // Underlying value type aligns with the spec.
    expectTypeOf<ValueOf<BufferDescriptor, 'mappedAtCreation'>>().toEqualTypeOf<
      ValueOf<GPUBufferDescriptor, 'mappedAtCreation'>
    >();
    // ExplicitUndefined<...> shape: the forgeax form accepts `boolean |
    // undefined` writes (S-7 distinguishes missing vs explicit-undefined).
    const m1: BufferDescriptor = { size: 16, usage: 0, mappedAtCreation: true };
    expectTypeOf(m1).toMatchTypeOf<BufferDescriptor>();
    const m2: BufferDescriptor = { size: 16, usage: 0, mappedAtCreation: false };
    expectTypeOf(m2).toMatchTypeOf<BufferDescriptor>();
    const m3: BufferDescriptor = { size: 16, usage: 0, mappedAtCreation: undefined };
    expectTypeOf(m3).toMatchTypeOf<BufferDescriptor>();
    const m4: BufferDescriptor = { size: 16, usage: 0 };
    expectTypeOf(m4).toMatchTypeOf<BufferDescriptor>();
    // Anti-form: passing a non-boolean must NOT type-check (commented out;
    // uncommenting must turn tsc red, not throw at runtime):
    //   const bad: BufferDescriptor = { size: 16, usage: 0, mappedAtCreation: 1 as never };
  });

  it('RenderPassDescriptor field set === Pick<GPURenderPassDescriptor, ...> (label inherited)', () => {
    type RpKeys =
      | 'label'
      | 'colorAttachments'
      | 'depthStencilAttachment'
      | 'occlusionQuerySet'
      | 'timestampWrites'
      | 'maxDrawCount';
    expectTypeOf<keyof RenderPassDescriptor>().toEqualTypeOf<RpKeys>();
    // depthStencilAttachment uses the tightened type (not spec).
    expectTypeOf<
      NonNullable<RenderPassDescriptor['depthStencilAttachment']>
    >().toEqualTypeOf<RenderPassDepthStencilAttachment>();
    // timestampWrites uses the forgeax QuerySet brand; maxDrawCount keeps the
    // spec type.
    expectTypeOf<
      ValueOf<RenderPassDescriptor, 'timestampWrites'>
    >().toEqualTypeOf<RenderPassTimestampWrites>();
    expectTypeOf<ValueOf<RenderPassDescriptor, 'maxDrawCount'>>().toEqualTypeOf<
      ValueOf<GPURenderPassDescriptor, 'maxDrawCount'>
    >();
  });
});
