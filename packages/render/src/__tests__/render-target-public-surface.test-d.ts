import { describe, expectTypeOf, it } from 'vitest';
import type {
  FramebufferSnapshotRequest,
  FramebufferSnapshotTicket,
  RenderError,
  RenderErrorCode,
  Renderer,
  RenderTarget,
  RenderTargetDescriptor,
  RenderTargetFormat,
  RenderTargetReadbackTicket,
  RenderTargetShape,
  RenderTargetTextureSource,
} from '../index';

const formats = [
  'rgba16float',
  'rgba8unorm',
  'rgba8unorm-srgb',
] as const satisfies readonly RenderTargetFormat[];
const shapes = ['2d', 'cube', '3d', '2d-array'] as const satisfies readonly RenderTargetShape[];

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 512,
  height: 256,
  format: 'rgba8unorm-srgb',
  mipLevels: 'full',
  sampleCount: 1,
  depth: 'depth24plus-stencil8',
  sampled: true,
  readback: true,
};

describe('RenderTarget public surface', () => {
  it('keeps the descriptor vocabulary closed and color-domain based', () => {
    expectTypeOf<RenderTargetDescriptor['format']>().toEqualTypeOf<RenderTargetFormat>();
    expectTypeOf<RenderTargetDescriptor['shape']>().toEqualTypeOf<RenderTargetShape>();
    expectTypeOf(formats).toMatchTypeOf<readonly RenderTargetFormat[]>();
    expectTypeOf(shapes).toMatchTypeOf<readonly RenderTargetShape[]>();
    // @ts-expect-error target descriptors do not carry a second color-space fact.
    const withColorSpace: RenderTargetDescriptor = { ...descriptor, colorSpace: 'srgb' };
    void withColorSpace;
    // @ts-expect-error the array shape is spelled '2d-array', mirroring the texture view dimension.
    const arrayTarget: RenderTargetDescriptor = { ...descriptor, shape: 'array' };
    void arrayTarget;
    const volume: RenderTargetDescriptor = {
      ...descriptor,
      shape: '3d',
      mipLevels: 1,
      depthOrArrayLayers: 8,
    };
    const layers: RenderTargetDescriptor = {
      ...descriptor,
      shape: '2d-array',
      depthOrArrayLayers: 4,
    };
    void volume;
    void layers;
    // @ts-expect-error layered shapes must name their slice or layer count.
    const missingLayers: RenderTargetDescriptor = {
      shape: '3d',
      width: 64,
      height: 64,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: true,
    };
    void missingLayers;
    // @ts-expect-error single-layer and cube shapes derive their layer count.
    const flatWithLayers: RenderTargetDescriptor = { ...descriptor, depthOrArrayLayers: 2 };
    void flatWithLayers;
  });

  it('exposes opaque target values and typed Renderer operations', () => {
    const renderer = undefined as unknown as Renderer;
    const target = undefined as unknown as RenderTarget;
    const source = undefined as unknown as RenderTargetTextureSource;
    const ticket = undefined as unknown as RenderTargetReadbackTicket;

    expectTypeOf(renderer.createRenderTarget(descriptor)).toMatchTypeOf<
      | { readonly ok: true; readonly value: RenderTarget }
      | { readonly ok: false; readonly error: RenderError }
    >();
    expectTypeOf(renderer.resizeRenderTarget).parameter(0).toEqualTypeOf<RenderTarget>();
    expectTypeOf(renderer.createRenderTargetTextureSource)
      .parameter(0)
      .toEqualTypeOf<RenderTarget>();
    expectTypeOf(renderer.requestTargetReadback).parameter(0).toEqualTypeOf<RenderTarget>();
    expectTypeOf(renderer.destroyRenderTarget).parameter(0).toEqualTypeOf<RenderTarget>();
    expectTypeOf(renderer.requestFramebufferSnapshot).parameter(0).toEqualTypeOf<RenderTarget>();
    expectTypeOf(renderer.requestFramebufferSnapshot)
      .parameter(1)
      .toEqualTypeOf<FramebufferSnapshotRequest>();
    expectTypeOf(
      renderer.requestFramebufferSnapshot(target, { region: { x: 0, y: 0, width: 1, height: 1 } }),
    ).toMatchTypeOf<
      | { readonly ok: true; readonly value: FramebufferSnapshotTicket }
      | { readonly ok: false; readonly error: RenderError }
    >();
    expectTypeOf<FramebufferSnapshotTicket>().not.toEqualTypeOf<RenderTargetReadbackTicket>();
    expectTypeOf(source).not.toEqualTypeOf(target);
    expectTypeOf(ticket).not.toEqualTypeOf(target);
    // @ts-expect-error opaque target values are not numeric handles.
    const numericIdentity: number = target;
    void numericIdentity;
    void source;
    void ticket;
  });

  it('keeps target failures in the closed RenderError family', () => {
    const targetCodes = [
      'render-target-descriptor-invalid',
      'render-target-capability-missing',
      'render-target-layer-invalid',
      'render-target-state-invalid',
      'render-target-operation-failed',
    ] as const satisfies readonly RenderErrorCode[];
    expectTypeOf<(typeof targetCodes)[number]>().toEqualTypeOf<
      Extract<RenderErrorCode, `${string}target${string}`>
    >();
  });
});
