// Type-level — RhiBindingResource 4-kind discriminated union (kind kebab-case).
//
// Introduced in feat-20260511-rhi-spec-realign-aggressive w3 (red) -> w9
// (green) per requirements AC-10 + plan-strategy §7.1 + D-P2 break-point #5.
// Replaces the previous spec-shaped polymorphic `BindGroupEntry.resource:
// GPUBindingResource` field with an explicitly tagged union so:
//   (a) AI users `switch (resource.kind)` is exhaustive — TS2367 guards drift;
//   (b) Construction-site typos like `{ kind: 'samplre', value: x }` trip
//       TS2322 at the literal-string position (closed-union guard).
//
// 4 kinds:
//   - { kind: 'sampler',         value: Sampler }
//   - { kind: 'buffer',          value: { buffer: Buffer; offset?: number; size?: number } }
//   - { kind: 'textureView',     value: TextureView }
//   - { kind: 'externalTexture', value: ExternalTexture } (opaque RHI brand)
//
// charter mapping: proposition 4 (closed-union exhaustive switch) +
// proposition 5 (consistent abstraction — kind discriminator over duck-typing).

import { describe, expectTypeOf, it } from 'vitest';
import type { Buffer, ExternalTexture, RhiBindingResource, Sampler, TextureView } from '../index';

describe('RhiBindingResource — 4-kind discriminated union', () => {
  it('contains kind: sampler', () => {
    type SamplerKind = Extract<RhiBindingResource, { kind: 'sampler' }>;
    expectTypeOf<SamplerKind['value']>().toMatchTypeOf<Sampler>();
  });

  it('contains kind: buffer', () => {
    type BufferKind = Extract<RhiBindingResource, { kind: 'buffer' }>;
    expectTypeOf<BufferKind['value']['buffer']>().toMatchTypeOf<Buffer>();
  });

  it('contains kind: textureView', () => {
    type TextureViewKind = Extract<RhiBindingResource, { kind: 'textureView' }>;
    expectTypeOf<TextureViewKind['value']>().toMatchTypeOf<TextureView>();
  });

  it('contains kind: externalTexture', () => {
    type ExtKind = Extract<RhiBindingResource, { kind: 'externalTexture' }>;
    expectTypeOf<ExtKind['value']>().toEqualTypeOf<ExternalTexture>();
  });

  it('keeps raw GPUExternalTexture out of the RHI binding surface', () => {
    type ExtKind = Extract<RhiBindingResource, { kind: 'externalTexture' }>;
    expectTypeOf<GPUExternalTexture>().not.toMatchTypeOf<ExtKind['value']>();
  });

  it('rejects kind typo at construction (TS2322 anchor)', () => {
    // @ts-expect-error TS2322: closed union — 'samplre' is not in 5-kind keyspace.
    const _bogus: RhiBindingResource = { kind: 'samplre', value: undefined as unknown as Sampler };
    void _bogus;
  });

  it('rejects undefined kind branch at consumption (TS2367 anchor)', () => {
    function describeKind(r: RhiBindingResource): string {
      switch (r.kind) {
        case 'sampler':
          return 'sampler';
        case 'buffer':
          return 'buffer';
        case 'textureView':
          return 'view';
        case 'externalTexture':
          return 'external';
        case 'accelerationStructure':
          return 'tlas';
      }
      // No default — TS guards: missing case here triggers compile-time red.
    }
    expectTypeOf(describeKind).returns.toEqualTypeOf<string>();
  });
});
