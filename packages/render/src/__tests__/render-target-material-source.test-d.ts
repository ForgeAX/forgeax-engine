import type { SchemaOf, ShapeOf } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import { expectTypeOf, it } from 'vitest';
import type { Camera } from '../components/camera';
import type {
  FrameDomainObservation,
  FrameObservationDomain,
  FrameObservationInclude,
  FrameObservationRequest,
  FrameReceipt,
  FrameReceiptObservation,
  RendererEvent,
} from '../render-contract';
import type {
  RenderTargetReadbackData,
  RenderTargetReadbackTicket,
  RenderTargetTextureSource,
} from '../targets/contracts';

it('keeps Camera target as a simulation-transient shared RenderTarget handle', () => {
  expectTypeOf<ShapeOf<SchemaOf<typeof Camera>>['target']>().toEqualTypeOf<
    Handle<'RenderTarget', 'shared'>
  >();
});

it('keeps target material source opaque and receipt readback data explicit', () => {
  type NoProperty<T, K extends PropertyKey> = Extract<keyof T, K> extends never ? true : false;
  expectTypeOf<NoProperty<RenderTargetTextureSource, 'texture'>>().toEqualTypeOf<true>();
  expectTypeOf<NoProperty<RenderTargetTextureSource, 'view'>>().toEqualTypeOf<true>();
  expectTypeOf<NoProperty<RenderTargetTextureSource, 'colorSpace'>>().toEqualTypeOf<true>();
  expectTypeOf<
    FrameObservationRequest['include'][number]
  >().toEqualTypeOf<FrameObservationInclude>();
  expectTypeOf<FrameDomainObservation['domain']>().toEqualTypeOf<FrameObservationDomain>();
  expectTypeOf<FrameReceiptObservation['frameId']>().toEqualTypeOf<number>();
  expectTypeOf<NonNullable<import('../render-contract').FrameReceipt['backendId']>>().toEqualTypeOf<
    'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null'
  >();
  expectTypeOf<NonNullable<FrameDomainObservation['metadata']['backendId']>>().toEqualTypeOf<
    'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null'
  >();
  expectTypeOf<FrameDomainObservation['metadata']['format']>().toEqualTypeOf<
    import('@forgeax/engine-rhi').TextureFormat
  >();
  expectTypeOf<NonNullable<FrameReceiptObservation['observations']>>().toEqualTypeOf<
    readonly FrameDomainObservation[]
  >();
  expectTypeOf<FrameObservationRequest['targetReadbacks']>().toEqualTypeOf<
    readonly RenderTargetReadbackTicket[] | undefined
  >();
  expectTypeOf<RenderTargetReadbackData['bytes']>().toEqualTypeOf<Uint8Array>();
  type SubmittedEvent = Extract<RendererEvent, { kind: 'frame-submitted' }>;
  expectTypeOf<SubmittedEvent['receipt']>().toEqualTypeOf<FrameReceipt>();
});
