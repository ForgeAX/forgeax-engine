// @forgeax/engine-rhi-null/src/device - RhiNullDevice + caps for the headless
// no-op backend.
//
// RhiNullDevice implements the full RhiDevice surface (research Finding A1
// row 3) as no-ops that mint legal opaque-handle brands and thread them through
// the per-device Bookkeeper (method A; research Finding A6). The `implements
// RhiDevice` clause is the completeness guard: a missing method is a tsc -b
// red, satisfying AC-01 without a hand-maintained member checklist.
//
// caps (D-5): backendKind 'null'; the 3 wgpu-native-only reserved flags
// (multiDrawIndirect / pushConstants / textureBindingArray) are false; every
// other boolean cap is true and maxColorAttachments is 8, so the headless
// backend maximizes structural coverage of capability-gated paths.
//
// Construction binds the supplied Null queue to this device's handle ledger.
//
// Related: requirements scope row 2 (8 interfaces full method set) + AC-01
// (implements compiles) + AC-08 (backendKind === 'null'); plan-strategy §2 D-5
// (caps field-level) + §4 R-3; research Finding A1 + A6.

import type {
  BindGroup,
  BindGroupDescriptor,
  BindGroupLayout,
  BindGroupLayoutDescriptor,
  Blas,
  BlasDescriptor,
  Buffer,
  BufferDescriptor,
  CommandEncoderDescriptor,
  ComputePipeline,
  ComputePipelineDescriptor,
  ExternalTexture,
  ExternalTextureDescriptor,
  PipelineLayout,
  PipelineLayoutDescriptor,
  QuerySet,
  QuerySetDescriptor,
  RenderPipeline,
  RenderPipelineDescriptor,
  Result,
  RhiCaps,
  RhiCommandEncoder,
  RhiComputePipelineOps,
  RhiDevice,
  RhiError as RhiErrorType,
  RhiFeatures,
  RhiLimits,
  RhiQueue,
  RhiRayQueryLimits,
  RhiRenderPipelineOps,
  Sampler,
  SamplerDescriptor,
  Texture,
  TextureDescriptor,
  TextureView,
  TextureViewDescriptor,
  Tlas,
  TlasDescriptor,
} from '@forgeax/engine-rhi';
import {
  RhiError as RhiErrorClass,
  rayQueryUnsupported,
  validateRayQueryBindGroupLayout,
} from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { Bookkeeper, isHandleDestroyed } from './bookkeeping';
import { probeR32FloatCapability } from './internal/r32float-capability';
import { createRenderBundleEncoder } from './pass-encoders';
import { RhiNullQueue } from './queue';
import { NullAccelerationStructures, nullRayQueryCaps } from './ray-query';

/**
 * RhiNull device options. `rayQuery` opts the device into a simulated Ray
 * Query profile with the given limits (structural BLAS/TLAS bookkeeping, no
 * tracing); omitted, `caps.rayQuery` reports `backend-has-no-ray-query`.
 */
export interface RhiNullDeviceOptions {
  readonly rayQuery?: RhiRayQueryLimits | undefined;
}

/** Monotonic device-id source so each RhiNullDevice owns a distinct id; the id
 *  threads into the Bookkeeper for cross-device handle-chain validation. */
let nextDeviceId = 0;

/**
 * Factory that builds a command encoder bound to a device's ledger. Injected at
 * device construction (rather than imported here) so device.ts carries no
 * dependency on command-encoder.ts; the singleton assembly (index.ts) supplies
 * the real factory. The Bookkeeper and RhiNullDevice are passed so the encoder
 * threads draw / dispatch counts + binding validation through the same per-device
 * ledger AND writes aggregated frame stats to the device for M3 unit-test readback.
 */
export type CommandEncoderFactory = (
  bookkeeper: Bookkeeper,
  device: RhiNullDevice,
) => RhiCommandEncoder;

/** A pipeline brand augmented with its no-op `getBindGroupLayout` ops method
 *  (D-2). createRenderPipeline / createComputePipeline return objects of this
 *  shape so the auto-layout consumers can call getBindGroupLayout. */
type PipelineHandle<Brand> = Brand & RhiRenderPipelineOps & RhiComputePipelineOps;

/**
 * Headless no-op RhiDevice. Every create* mints a legal brand and records it;
 * every destroy* fail-fasts a double-destroy; caps reports the all-true-except-
 * reserved profile (D-5).
 */
export class RhiNullDevice implements RhiDevice {
  private readonly internalBookkeeper: Bookkeeper;
  private readonly textureViews = new WeakMap<Texture, Set<TextureView>>();
  private readonly nullQueue: RhiQueue;
  private readonly encoderFactory: CommandEncoderFactory;
  private readonly deviceGeneration: number;
  private readonly enabledFeatures: RhiFeatures;
  private r32FloatProbe: ReturnType<typeof probeR32FloatCapability> | undefined;
  /** @internal Acceleration-structure ledger shared with this device's command encoders. */
  readonly _accelerationStructures: NullAccelerationStructures;

  /** Per-frame total draw count across all pass encoders executed this frame
   *  (aggregated by the command encoder on finish, then reset). M3 unit tests
   *  (w17) read this to assert draw count >= 1 (AC-06). */
  totalDrawCount = 0;
  /** Per-frame total direct and indirect compute dispatch count. */
  totalDispatchCount = 0;
  /** Per-frame total bind group set count (AC-06 / AC-05 readback). */
  totalBindGroupCount = 0;
  /** Per-frame pass names executed this frame, in schedule order (AC-04). */
  framePassNames: string[] = [];

  /** The per-device handle ledger — exposed so M3 tests can assert create/destroy
   *  pairing and BGL/PSO shape counts (AC-05/06/07). */
  get bookkeeper(): Bookkeeper {
    return this.internalBookkeeper;
  }

  constructor(
    queue: RhiQueue,
    encoderFactory: CommandEncoderFactory,
    enabledFeatures: ReadonlySet<GPUFeatureName> = new Set(),
    options: RhiNullDeviceOptions = {},
  ) {
    this.enabledFeatures = new Set(enabledFeatures) as RhiFeatures;
    this.deviceGeneration = nextDeviceId;
    this.internalBookkeeper = new Bookkeeper(nextDeviceId++);
    this._accelerationStructures = new NullAccelerationStructures(
      nullRayQueryCaps(options.rayQuery),
      this.internalBookkeeper,
    );
    this.nullQueue = queue;
    if (queue instanceof RhiNullQueue) queue.bind(this.internalBookkeeper);
    this.encoderFactory = encoderFactory;
  }

  probeTextureFormatCapability(): ReturnType<typeof probeR32FloatCapability> {
    this.r32FloatProbe ??= probeR32FloatCapability(this.deviceGeneration);
    return this.r32FloatProbe;
  }

  get caps(): RhiCaps {
    return {
      backendKind: 'null',
      compute: true,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: true,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      // 3 wgpu-native-only reserved flags stay false on non-native backends
      // (D-5); the headless backend is not a native runtime.
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: true,
      storageBuffer: true,
      storageTexture: true,
      rgba16floatRenderable: true,
      rg11b10ufloatRenderable: true,
      float32Filterable: true,
      textureImport: true,
      externalTexture: true,
      maxColorAttachments: 8,
      rayQuery: this._accelerationStructures.caps,
    };
  }

  get features(): RhiFeatures {
    return this.enabledFeatures;
  }

  get limits(): RhiLimits {
    return NULL_LIMITS as RhiLimits;
  }

  get queue(): RhiQueue {
    return this.nullQueue;
  }

  // forgeax-async-whitelist: dom-native — spec `GPUDevice.lost` Promise
  // passthrough. The headless backend never loses a device (no GPU), so the
  // Promise stays unsettled for the lifetime of the device, mirroring a live
  // device that never transitions to the lost state.
  get lost(): Promise<{ readonly reason: 'destroyed' | 'unknown'; readonly message: string }> {
    return NEVER;
  }

  createBuffer(desc: BufferDescriptor): Result<Buffer, RhiErrorType> {
    const usage = typeof desc.usage === 'number' ? desc.usage : 0;
    const admitted = this._accelerationStructures.admitBuffer(usage);
    if (!admitted.ok) return admitted;
    const buffer = this.internalBookkeeper.register('Buffer') as unknown as Buffer;
    this._accelerationStructures.rememberBuffer(buffer, usage);
    return ok(buffer);
  }

  createTexture(_desc: TextureDescriptor): Result<Texture, RhiErrorType> {
    return ok(this.internalBookkeeper.register('Texture') as unknown as Texture);
  }

  nativeDevice(): Result<GPUDevice, RhiErrorType> {
    return err(
      new RhiErrorClass({
        code: 'feature-not-enabled',
        expected: 'a backend that owns a native GPUDevice',
        hint: 'RhiNull is headless; create interop textures on a WebGPU renderer',
      }),
    );
  }

  /** Structural admission: the same shape/usage rules as WebGPU, without a device. */
  async importTexture(texture: GPUTexture): Promise<Result<Texture, RhiErrorType>> {
    if (texture.dimension !== '2d' || (texture.usage & TEXTURE_BINDING) === 0) {
      return err(
        new RhiErrorClass({
          code: 'rhi-descriptor-invalid',
          expected: 'a 2d texture with TEXTURE_BINDING usage',
          hint: `got dimension='${texture.dimension}', usage=0x${texture.usage.toString(16)}`,
        }),
      );
    }
    return ok(this.internalBookkeeper.register('Texture') as unknown as Texture);
  }

  importExternalTexture(_desc: ExternalTextureDescriptor): Result<ExternalTexture, RhiErrorType> {
    return ok(this.internalBookkeeper.register('ExternalTexture') as unknown as ExternalTexture);
  }

  destroyBuffer(buf: Buffer): Result<void, RhiErrorType> {
    return this.internalBookkeeper.destroy(buf);
  }

  destroyQuerySet(querySet: QuerySet): Result<void, RhiErrorType> {
    return this.internalBookkeeper.destroy(querySet);
  }

  destroyTexture(tex: Texture): Result<void, RhiErrorType> {
    const ownership = this.internalBookkeeper.validateOwnership(tex);
    if (!ownership.ok) return ownership;
    const live = isHandleDestroyed(tex);
    if (!live.ok) return live;

    const views = this.textureViews.get(tex);
    if (views !== undefined) {
      for (const view of views) {
        const destroyed = this.internalBookkeeper.destroy(view);
        if (!destroyed.ok && destroyed.error.code !== 'destroy-after-destroy') return destroyed;
      }
      this.textureViews.delete(tex);
    }

    return this.internalBookkeeper.destroy(tex);
  }

  createBlas(desc: BlasDescriptor): Result<Blas, RhiErrorType> {
    return this._accelerationStructures.createBlas(desc);
  }

  createTlas(desc: TlasDescriptor): Result<Tlas, RhiErrorType> {
    return this._accelerationStructures.createTlas(desc);
  }

  destroyBlas(blas: Blas): Result<void, RhiErrorType> {
    return this._accelerationStructures.destroy(blas, 'destroyBlas');
  }

  destroyTlas(tlas: Tlas): Result<void, RhiErrorType> {
    return this._accelerationStructures.destroy(tlas, 'destroyTlas');
  }

  createTextureView(
    texture: Texture,
    _desc: TextureViewDescriptor,
  ): Result<TextureView, RhiErrorType> {
    const ownership = this.internalBookkeeper.validateOwnership(texture);
    if (!ownership.ok) return ownership;
    if (ownership.value.kind !== 'Texture') {
      return err(
        new RhiErrorClass({
          code: 'rhi-descriptor-invalid',
          expected: 'a live Texture handle created by this RhiNull device',
          hint: 'create the texture view from a texture resource owned by this device',
        }),
      );
    }

    const live = isHandleDestroyed(texture);
    if (!live.ok) return live;

    const view = this.internalBookkeeper.register('TextureView', [
      texture,
    ]) as unknown as TextureView;
    let views = this.textureViews.get(texture);
    if (views === undefined) {
      views = new Set<TextureView>();
      this.textureViews.set(texture, views);
    }
    views.add(view);
    return ok(view);
  }

  createSampler(_desc?: SamplerDescriptor | undefined): Result<Sampler, RhiErrorType> {
    return ok(this.internalBookkeeper.register('Sampler') as unknown as Sampler);
  }

  createBindGroupLayout(desc: BindGroupLayoutDescriptor): Result<BindGroupLayout, RhiErrorType> {
    const gate = validateRayQueryBindGroupLayout(this._accelerationStructures.caps, desc);
    if (!gate.ok) return gate;
    return ok(this.internalBookkeeper.register('BindGroupLayout') as unknown as BindGroupLayout);
  }

  createBindGroup(desc: BindGroupDescriptor): Result<BindGroup, RhiErrorType> {
    const { caps } = this._accelerationStructures;
    for (const entry of desc.entries) {
      if (entry.resource.kind !== 'accelerationStructure') continue;
      if (!caps.supported) return rayQueryUnsupported(`bind group entry ${entry.binding}`, caps);
      if (!this._accelerationStructures.isBuiltTlas(entry.resource.value)) {
        return err(
          new RhiErrorClass({
            code: 'rhi-descriptor-invalid',
            expected: 'a live TLAS built by encoder.buildAccelerationStructures',
            hint: `bind group entry ${entry.binding} binds a TLAS that is destroyed or was never built`,
          }),
        );
      }
    }
    return ok(this.internalBookkeeper.register('BindGroup') as unknown as BindGroup);
  }

  createPipelineLayout(_desc: PipelineLayoutDescriptor): Result<PipelineLayout, RhiErrorType> {
    return ok(this.internalBookkeeper.register('PipelineLayout') as unknown as PipelineLayout);
  }

  createRenderPipeline(_desc: RenderPipelineDescriptor): Result<RenderPipeline, RhiErrorType> {
    return ok(this.makePipeline<RenderPipeline>('RenderPipeline'));
  }

  createComputePipeline(_desc: ComputePipelineDescriptor): Result<ComputePipeline, RhiErrorType> {
    return ok(this.makePipeline<ComputePipeline>('ComputePipeline'));
  }

  createQuerySet(desc: QuerySetDescriptor): Result<QuerySet, RhiErrorType> {
    if (desc.type === 'timestamp') {
      return err(
        new RhiErrorClass({
          code: 'feature-not-enabled',
          expected: 'caps.timestampQuery === true (timestamp-query feature)',
          hint: 'RhiNull is structural-only and cannot produce GPU timestamp ticks',
        }),
      );
    }
    return ok(this.internalBookkeeper.register('QuerySet') as unknown as QuerySet);
  }

  createRenderBundleEncoder(desc: import('@forgeax/engine-rhi').RenderBundleEncoderDescriptor) {
    return ok(createRenderBundleEncoder(this.internalBookkeeper, desc));
  }

  createCommandEncoder(
    _desc?: CommandEncoderDescriptor | undefined,
  ): Result<RhiCommandEncoder, RhiErrorType> {
    return ok(this.encoderFactory(this.internalBookkeeper, this));
  }

  /**
   * Mint a pipeline handle whose object also carries the no-op
   * `getBindGroupLayout(index)` ops method (D-2). The prod auto-layout path
   * (debug-draw.ts) and the existing mock unit tests both call
   * `pipeline.getBindGroupLayout(n)`; returning a legal BindGroupLayout brand
   * (recorded in the ledger) keeps those consumers from crashing on a missing
   * method.
   */
  private makePipeline<Brand>(kind: string): PipelineHandle<Brand> {
    const handle = this.internalBookkeeper.register(kind);
    const getBindGroupLayout = (_index: number): BindGroupLayout =>
      this.internalBookkeeper.register('BindGroupLayout') as unknown as BindGroupLayout;
    return Object.assign(handle, { getBindGroupLayout }) as unknown as PipelineHandle<Brand>;
  }
}

/** Structural capacity for eight attachments of up to 16 bytes per sample. */
export const NULL_LIMITS = { maxColorAttachmentBytesPerSample: 128 } as const;

const TEXTURE_BINDING = 0x04;

/** A Promise that never settles, mirroring a live GPUDevice.lost that stays
 *  unsettled while the device is healthy. */
const NEVER: Promise<{ readonly reason: 'destroyed' | 'unknown'; readonly message: string }> =
  new Promise(() => {});
