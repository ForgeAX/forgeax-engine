// MVP-1.3 — 14 opaque handle types do not surface internal GPU fields
// (type-level red → green).
//
// Shape: 14 typed `Id<T>` brand-only types; user attempts to access
// `.gpuBuffer` / `.__brand` etc. → TypeScript compile-time red signal
// (auto-guarded by `@ts-expect-error`).
//
// Red expected state (at the M1 t7 commit): t10 has not declared these types
// → `tsc -b` reports a 'no exported member' red.
// Green expected state (after the M1 t10 commit): the 14 handle types are
// exported and brand-only → all 14 `ts-expect-error` directive blocks fire
// (attempts to access internal fields fail).
//
// Anchors: requirements §AC MVP-1.3 + §AI User Affordances / resource handles
//          opaque; plan-strategy §4.3 key-test-point table row 2; §7
//          proposition 4 / proposition 5; research §F-1 + §R5 (`__brand` is
//          the d.ts nominal-typing workaround).

import { describe, it } from 'vitest';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  CommandBuffer,
  CommandEncoder,
  ComputePipeline,
  Fence,
  PipelineLayout,
  QuerySet,
  RenderPipeline,
  Sampler,
  ShaderModule,
  Texture,
  TextureView,
} from '../index';

describe('MVP-1.3 — 14 opaque handle types reject access to internal GPU fields', () => {
  it('Buffer rejects access to the internal GPU object', () => {
    const h = {} as Buffer;
    // @ts-expect-error MVP-1.3: Buffer is opaque; gpuBuffer is not exposed.
    h.gpuBuffer;
  });

  it('Texture rejects access to the internal GPU object', () => {
    const h = {} as Texture;
    // @ts-expect-error MVP-1.3: Texture is opaque; gpuTexture is not exposed.
    h.gpuTexture;
  });

  it('TextureView rejects access to the internal GPU object', () => {
    const h = {} as TextureView;
    // @ts-expect-error MVP-1.3: TextureView is opaque; gpuTextureView is not exposed.
    h.gpuTextureView;
  });

  it('Sampler rejects access to the internal GPU object', () => {
    const h = {} as Sampler;
    // @ts-expect-error MVP-1.3: Sampler is opaque; gpuSampler is not exposed.
    h.gpuSampler;
  });

  it('BindGroup rejects access to the internal GPU object', () => {
    const h = {} as BindGroup;
    // @ts-expect-error MVP-1.3: BindGroup is opaque; gpuBindGroup is not exposed.
    h.gpuBindGroup;
  });

  it('BindGroupLayout rejects access to the internal GPU object', () => {
    const h = {} as BindGroupLayout;
    // @ts-expect-error MVP-1.3: BindGroupLayout is opaque; gpuBindGroupLayout is not exposed.
    h.gpuBindGroupLayout;
  });

  it('PipelineLayout rejects access to the internal GPU object', () => {
    const h = {} as PipelineLayout;
    // @ts-expect-error MVP-1.3: PipelineLayout is opaque; gpuPipelineLayout is not exposed.
    h.gpuPipelineLayout;
  });

  it('RenderPipeline rejects access to the internal GPU object', () => {
    const h = {} as RenderPipeline;
    // @ts-expect-error MVP-1.3: RenderPipeline is opaque; gpuRenderPipeline is not exposed.
    h.gpuRenderPipeline;
  });

  it('ComputePipeline rejects access to the internal GPU object', () => {
    const h = {} as ComputePipeline;
    // @ts-expect-error MVP-1.3: ComputePipeline is opaque; gpuComputePipeline is not exposed.
    h.gpuComputePipeline;
  });

  it('ShaderModule rejects access to the internal GPU object', () => {
    const h = {} as ShaderModule;
    // @ts-expect-error MVP-1.3: ShaderModule is opaque; gpuShaderModule is not exposed.
    h.gpuShaderModule;
  });

  it('QuerySet rejects access to the internal GPU object', () => {
    const h = {} as QuerySet;
    // @ts-expect-error MVP-1.3: QuerySet is opaque; gpuQuerySet is not exposed.
    h.gpuQuerySet;
  });

  it('Fence rejects access to the internal sync object', () => {
    const h = {} as Fence;
    // @ts-expect-error MVP-1.3: Fence is opaque; internal sync handle is not exposed.
    h.gpuFence;
  });

  it('CommandEncoder rejects access to the internal GPU object', () => {
    const h = {} as CommandEncoder;
    // @ts-expect-error MVP-1.3: CommandEncoder is opaque; gpuCommandEncoder is not exposed.
    h.gpuCommandEncoder;
  });

  it('CommandBuffer rejects access to the internal GPU object', () => {
    const h = {} as CommandBuffer;
    // @ts-expect-error MVP-1.3: CommandBuffer is opaque; gpuCommandBuffer is not exposed.
    h.gpuCommandBuffer;
  });
});
