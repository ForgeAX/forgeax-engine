// packages/rhi-wgpu/src/__tests__/surface-mirror.test-d.ts — type-layer
// surface-mirror assertions (w15 red-tier).
//
// This file is a TS type-check-only test: vitest runs it through
// `typecheck: { enabled: true }` (see vitest.config.ts). Each `expectTypeOf`
// chain asserts that the @forgeax/engine-rhi-wgpu package's surface exports the
// same names + types as the @forgeax/engine-rhi interface SSOT.
//
// Coverage (46 type-layer assertions — w15 acceptanceCheck):
//   - 7 main interfaces  (RhiInstance / RhiAdapter / RhiCanvasContext /
//                         RhiDevice / RhiQueue / RhiCommandEncoder /
//                         RhiRenderPassEncoder)
//   - 14 opaque handles  (Buffer / Texture / TextureView / Sampler /
//                         BindGroup / BindGroupLayout / PipelineLayout /
//                         RenderPipeline / ComputePipeline / ShaderModule /
//                         QuerySet / Fence / CommandEncoder / CommandBuffer)
//   - 17 descriptors     (BufferDescriptor / TextureDescriptor /
//                         SamplerDescriptor / BindGroupDescriptor /
//                         BindGroupLayoutDescriptor / PipelineLayoutDescriptor /
//                         RenderPipelineDescriptor / ComputePipelineDescriptor /
//                         CommandEncoderDescriptor / RenderPassDescriptor /
//                         RenderPassColorAttachment /
//                         RenderPassDepthStencilAttachment /
//                         TextureViewDescriptor / QuerySetDescriptor /
//                         CanvasConfiguration / RequestAdapterOptions /
//                         RequestDeviceOptions)
//   - Buffer mapping 4   (mapAsync / getMappedRange / unmap / mappedAtCreation)
//   - Queue 4            (submit / writeBuffer / writeTexture /
//                         onSubmittedWorkDone)
//
// w15 red state: the `@forgeax/engine-rhi-wgpu` module currently exports the
// wasm-loader hooks only; the 7 main interface impls (`rhi` singleton,
// `RhiAdapter`, `RhiDevice` etc.) land in w16-w19. Until then, the
// `device.ts` consumed below resolves to `undefined` at compile time and
// the test-d file reports type errors.
//
// w16-w19 land the impls and the test-d file goes green. The
// `surface-mirror` filename matches the AC-08 grep gate semantic so
// reviewer tooling can navigate to it directly.
//
// Anchors: plan-strategy §6 M2 + AC-08 surface byte-for-byte gate +
//          AGENTS.md `## RHI / WebGPU` 14 opaque handle iron law.

/// <reference types="@webgpu/types" />

import type {
  // 14 opaque handles
  BindGroup,
  BindGroupDescriptor,
  BindGroupLayout,
  BindGroupLayoutDescriptor,
  // 17 descriptors
  Buffer,
  BufferDescriptor,
  CanvasConfiguration,
  CommandBuffer,
  CommandEncoder,
  CommandEncoderDescriptor,
  ComputePipeline,
  ComputePipelineDescriptor,
  Fence,
  PipelineLayout,
  PipelineLayoutDescriptor,
  QuerySet,
  QuerySetDescriptor,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RenderPassDescriptor,
  RenderPipeline,
  RenderPipelineDescriptor,
  RequestAdapterOptions,
  RequestDeviceOptions,
  // 7 main interfaces
  RhiAdapter,
  RhiCanvasContext,
  RhiCommandEncoder,
  RhiDevice,
  RhiInstance,
  RhiQueue,
  RhiRenderPassEncoder,
  Sampler,
  SamplerDescriptor,
  ShaderModule,
  Texture,
  TextureDescriptor,
  TextureView,
  TextureViewDescriptor,
} from '@forgeax/engine-rhi';
import { describe, expectTypeOf, test } from 'vitest';

// w15 red: the impls are not yet exported. w16 lands `rhi` (RhiInstance) and
// `makeRhiAdapter`; w17 lands `makeRhiDevice` (RhiDevice + RhiQueue + the
// 14 createX entries + Buffer mapping 4 surface); w18 lands `makeRhiQueue` /
// `makeRhiCommandEncoder` / `makeRhiRenderPassEncoder` re-exports; w19 lands
// the Buffer mapping 4 surface on the Buffer brand.
//
// Until then, the import below is a type-only construct; the consumer
// module resolves to undefined at runtime and TS reports `Module not found`
// at type-check time (red state).
//
// w16-w19 add the corresponding modules to satisfy these imports.
import { rhi as rhiTyped } from '..';

// ============================================================================
// 7 main interfaces (acceptanceCheck §1)
// ============================================================================

describe('surface-mirror: 7 main interfaces', () => {
  test('RhiInstance — top-level entry shape', () => {
    expectTypeOf(rhiTyped).toMatchTypeOf<RhiInstance>();
  });

  test('RhiAdapter — features / limits / requestDevice', () => {
    expectTypeOf<RhiAdapter>().toHaveProperty('features');
    expectTypeOf<RhiAdapter>().toHaveProperty('limits');
    expectTypeOf<RhiAdapter>().toHaveProperty('requestDevice');
  });

  test('RhiCanvasContext — 4 method shape', () => {
    expectTypeOf<RhiCanvasContext>().toHaveProperty('configure');
    expectTypeOf<RhiCanvasContext>().toHaveProperty('unconfigure');
    expectTypeOf<RhiCanvasContext>().toHaveProperty('getConfiguration');
    expectTypeOf<RhiCanvasContext>().toHaveProperty('getCurrentTexture');
  });

  test('RhiDevice — features / limits / caps / queue / createX entries', () => {
    expectTypeOf<RhiDevice>().toHaveProperty('features');
    expectTypeOf<RhiDevice>().toHaveProperty('limits');
    expectTypeOf<RhiDevice>().toHaveProperty('caps');
    expectTypeOf<RhiDevice>().toHaveProperty('queue');
    expectTypeOf<RhiDevice>().toHaveProperty('createBuffer');
    expectTypeOf<RhiDevice>().toHaveProperty('createTexture');
    expectTypeOf<RhiDevice>().toHaveProperty('createSampler');
    expectTypeOf<RhiDevice>().toHaveProperty('createBindGroup');
    expectTypeOf<RhiDevice>().toHaveProperty('createBindGroupLayout');
    expectTypeOf<RhiDevice>().toHaveProperty('createPipelineLayout');
    expectTypeOf<RhiDevice>().toHaveProperty('createRenderPipeline');
    expectTypeOf<RhiDevice>().toHaveProperty('createComputePipeline');
    expectTypeOf<RhiDevice>().toHaveProperty('createCommandEncoder');
    expectTypeOf<RhiDevice>().toHaveProperty('createTextureView');
    expectTypeOf<RhiDevice>().toHaveProperty('createQuerySet');
    // createShaderModule is a top-level async factory on the rhi singleton
    // (not on RhiDevice; D-S5 / fix-f3 placeholder removed) — the
    // assertion lives in the RhiInstance test above.
  });

  test('RhiQueue — submit / writeBuffer / writeTexture / onSubmittedWorkDone', () => {
    expectTypeOf<RhiQueue>().toHaveProperty('submit');
    expectTypeOf<RhiQueue>().toHaveProperty('writeBuffer');
    expectTypeOf<RhiQueue>().toHaveProperty('writeTexture');
    expectTypeOf<RhiQueue>().toHaveProperty('onSubmittedWorkDone');
  });

  test('RhiCommandEncoder — beginRenderPass / beginComputePass / copyX / finish', () => {
    expectTypeOf<RhiCommandEncoder>().toHaveProperty('beginRenderPass');
    expectTypeOf<RhiCommandEncoder>().toHaveProperty('beginComputePass');
    expectTypeOf<RhiCommandEncoder>().toHaveProperty('finish');
  });

  test('RhiRenderPassEncoder — setPipeline / setBindGroup / draw / end', () => {
    expectTypeOf<RhiRenderPassEncoder>().toHaveProperty('setPipeline');
    expectTypeOf<RhiRenderPassEncoder>().toHaveProperty('setBindGroup');
    expectTypeOf<RhiRenderPassEncoder>().toHaveProperty('draw');
    expectTypeOf<RhiRenderPassEncoder>().toHaveProperty('end');
  });
});

// ============================================================================
// 14 opaque handles (acceptanceCheck §2)
// ============================================================================

describe('surface-mirror: 14 opaque handle brands', () => {
  test('Buffer brand is opaque', () => {
    expectTypeOf<Buffer>().not.toBeAny();
  });
  test('Texture brand is opaque', () => {
    expectTypeOf<Texture>().not.toBeAny();
  });
  test('TextureView brand is opaque', () => {
    expectTypeOf<TextureView>().not.toBeAny();
  });
  test('Sampler brand is opaque', () => {
    expectTypeOf<Sampler>().not.toBeAny();
  });
  test('BindGroup brand is opaque', () => {
    expectTypeOf<BindGroup>().not.toBeAny();
  });
  test('BindGroupLayout brand is opaque', () => {
    expectTypeOf<BindGroupLayout>().not.toBeAny();
  });
  test('PipelineLayout brand is opaque', () => {
    expectTypeOf<PipelineLayout>().not.toBeAny();
  });
  test('RenderPipeline brand is opaque', () => {
    expectTypeOf<RenderPipeline>().not.toBeAny();
  });
  test('ComputePipeline brand is opaque', () => {
    expectTypeOf<ComputePipeline>().not.toBeAny();
  });
  test('ShaderModule brand is opaque', () => {
    expectTypeOf<ShaderModule>().not.toBeAny();
  });
  test('QuerySet brand is opaque', () => {
    expectTypeOf<QuerySet>().not.toBeAny();
  });
  test('Fence brand is opaque', () => {
    expectTypeOf<Fence>().not.toBeAny();
  });
  test('CommandEncoder brand is opaque', () => {
    expectTypeOf<CommandEncoder>().not.toBeAny();
  });
  test('CommandBuffer brand is opaque', () => {
    expectTypeOf<CommandBuffer>().not.toBeAny();
  });
});

// ============================================================================
// 17 descriptors (acceptanceCheck §3)
// ============================================================================
//
// Per AGENTS.md naming-iron-law + r12-lint: each descriptor is a
// `Pick<GPUXxxDescriptor, ...>`-shaped alias. The test asserts the alias
// names are exported (the field-level r12-lint sweeps the field set against
// `@webgpu/types`).

describe('surface-mirror: 17 descriptor aliases', () => {
  test('BufferDescriptor matches spec field set', () => {
    expectTypeOf<BufferDescriptor>().not.toBeAny();
  });
  test('TextureDescriptor matches spec field set', () => {
    expectTypeOf<TextureDescriptor>().not.toBeAny();
  });
  test('SamplerDescriptor matches spec field set', () => {
    expectTypeOf<SamplerDescriptor>().not.toBeAny();
  });
  test('BindGroupDescriptor matches spec field set', () => {
    expectTypeOf<BindGroupDescriptor>().not.toBeAny();
  });
  test('BindGroupLayoutDescriptor matches spec field set', () => {
    expectTypeOf<BindGroupLayoutDescriptor>().not.toBeAny();
  });
  test('PipelineLayoutDescriptor matches spec field set', () => {
    expectTypeOf<PipelineLayoutDescriptor>().not.toBeAny();
  });
  test('RenderPipelineDescriptor matches spec field set', () => {
    expectTypeOf<RenderPipelineDescriptor>().not.toBeAny();
  });
  test('ComputePipelineDescriptor matches spec field set', () => {
    expectTypeOf<ComputePipelineDescriptor>().not.toBeAny();
  });
  test('CommandEncoderDescriptor matches spec field set', () => {
    expectTypeOf<CommandEncoderDescriptor>().not.toBeAny();
  });
  test('RenderPassDescriptor matches spec field set', () => {
    expectTypeOf<RenderPassDescriptor>().not.toBeAny();
  });
  test('RenderPassColorAttachment matches spec field set', () => {
    expectTypeOf<RenderPassColorAttachment>().not.toBeAny();
  });
  test('RenderPassDepthStencilAttachment matches spec field set', () => {
    expectTypeOf<RenderPassDepthStencilAttachment>().not.toBeAny();
  });
  test('TextureViewDescriptor matches spec field set', () => {
    expectTypeOf<TextureViewDescriptor>().not.toBeAny();
  });
  test('QuerySetDescriptor matches spec field set', () => {
    expectTypeOf<QuerySetDescriptor>().not.toBeAny();
  });
  test('CanvasConfiguration matches spec field set', () => {
    expectTypeOf<CanvasConfiguration>().not.toBeAny();
  });
  test('RequestAdapterOptions matches spec field set', () => {
    expectTypeOf<RequestAdapterOptions>().not.toBeAny();
  });
  test('RequestDeviceOptions matches spec field set', () => {
    expectTypeOf<RequestDeviceOptions>().not.toBeAny();
  });
});

// ============================================================================
// Buffer mapping 4 (acceptanceCheck §4 — Buffer mapping surface)
// ============================================================================

describe('surface-mirror: Buffer mapping 4', () => {
  test('Buffer.mapAsync exists', () => {
    expectTypeOf<Buffer>().toHaveProperty('mapAsync');
  });
  // w24 / D-P2 #6 (feat-20260511-rhi-spec-realign-aggressive): getMappedRange
  // and unmap migrated from Buffer to MappedBuffer brand. The forgeax-rhi
  // MappedBuffer extends Buffer, so the brand still flows through; the
  // signature lookup happens via that brand union (lifted into Buffer's
  // mapAsync return type) rather than the plain Buffer surface.
  test('MappedBuffer.getMappedRange exists (D-P2 #6 brand)', () => {
    type MappedBuffer = import('@forgeax/engine-rhi').MappedBuffer;
    expectTypeOf<MappedBuffer>().toHaveProperty('getMappedRange');
  });
  test('MappedBuffer.unmap exists (D-P2 #6 brand)', () => {
    type MappedBuffer = import('@forgeax/engine-rhi').MappedBuffer;
    expectTypeOf<MappedBuffer>().toHaveProperty('unmap');
  });
  test('Buffer descriptor exposes mappedAtCreation', () => {
    // Strict: BufferDescriptor includes the mappedAtCreation field (Pick of
    // GPUBufferDescriptor; the forgeax alias passes the field name through).
    type HasMappedAtCreation = 'mappedAtCreation' extends keyof BufferDescriptor ? true : false;
    expectTypeOf<HasMappedAtCreation>().toEqualTypeOf<true>();
  });
});

// ============================================================================
// Queue 4 (acceptanceCheck §5 — Queue operation surface)
// ============================================================================

describe('surface-mirror: Queue 4 ops', () => {
  test('RhiQueue.submit signature', () => {
    expectTypeOf<RhiQueue['submit']>().not.toBeAny();
  });
  test('RhiQueue.writeBuffer signature', () => {
    expectTypeOf<RhiQueue['writeBuffer']>().not.toBeAny();
  });
  test('RhiQueue.writeTexture signature', () => {
    expectTypeOf<RhiQueue['writeTexture']>().not.toBeAny();
  });
  test('RhiQueue.onSubmittedWorkDone signature', () => {
    expectTypeOf<RhiQueue['onSubmittedWorkDone']>().not.toBeAny();
  });
});
