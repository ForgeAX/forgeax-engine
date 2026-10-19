import { textureCopyOrigin } from '@forgeax/engine-rhi';
// W3C WebGPU object model over the native wgpu addon.
//
// This is deliberately the JavaScript WebGPU API shape (GPU, GPUAdapter, GPUDevice, ...)
// so `@forgeax/engine-rhi-webgpu` stays the single RHI shim and every `*.dawn.test.ts`
// runs unchanged on native wgpu. The objects keep only what the API reads back in JS
// (sizes, formats, map state); wgpu owns validation. The Ray Query extension adds
// `createBlas` / `createTlas` on the device and `buildAccelerationStructures` on the
// command encoder, consumed by `@forgeax/engine-rhi-webgpu/src/ray-query.ts`.

import type { NativeAdapter, NativeBinding, NativeDevice } from './binding';
import { NativeCommandEncoder, NativeRenderBundleEncoder } from './encoder';
import {
  bytesOf,
  DeviceChild,
  domError,
  extent,
  hideReference,
  idOf,
  NativeAccelerationStructure,
  NativeGPUBuffer,
  NativeGPUObject,
  NativeGPUPipeline,
  NativeGPUQuerySet,
  NativeGPUShaderModule,
  NativeGPUTexture,
  NativeGPUTextureView,
} from './objects';

export class GPUValidationError extends Error {
  override readonly name = 'GPUValidationError';
}
export class GPUOutOfMemoryError extends Error {
  override readonly name = 'GPUOutOfMemoryError';
}
export class GPUInternalError extends Error {
  override readonly name = 'GPUInternalError';
}
export class GPUPipelineError extends Error {
  override readonly name = 'GPUPipelineError';
  constructor(
    message: string,
    readonly reason: 'validation' | 'internal',
  ) {
    super(message);
  }
}
export class GPUUncapturedErrorEvent extends Event {
  constructor(
    type: string,
    init: { readonly error: GPUValidationError | GPUOutOfMemoryError | GPUInternalError },
  ) {
    super(type);
    this.error = init.error;
  }
  readonly error: GPUValidationError | GPUOutOfMemoryError | GPUInternalError;
}

interface ErrorRecord {
  readonly kind: 'validation' | 'out-of-memory' | 'internal';
  readonly message: string;
}

function gpuError(
  record: ErrorRecord,
): GPUValidationError | GPUOutOfMemoryError | GPUInternalError {
  switch (record.kind) {
    case 'validation':
      return new GPUValidationError(record.message);
    case 'out-of-memory':
      return new GPUOutOfMemoryError(record.message);
    case 'internal':
      return new GPUInternalError(record.message);
  }
}

function bindingResource(resource: unknown): Record<string, unknown> {
  if (resource instanceof NativeGPUBuffer) return { kind: 'buffer', id: resource.nativeId };
  if (resource instanceof NativeGPUTextureView)
    return { kind: 'textureView', id: resource.nativeId };
  if (resource instanceof NativeGPUTexture) {
    return { kind: 'textureView', id: resource.createView().nativeId };
  }
  if (resource instanceof NativeAccelerationStructure) {
    return { kind: 'accelerationStructure', id: resource.nativeId };
  }
  const binding = resource as GPUBufferBinding;
  if (
    binding !== null &&
    typeof binding === 'object' &&
    binding.buffer instanceof NativeGPUBuffer
  ) {
    return {
      kind: 'buffer',
      id: binding.buffer.nativeId,
      offset: binding.offset ?? 0,
      size: binding.size,
    };
  }
  return { kind: 'sampler', id: idOf(resource) };
}

function programmableStage(stage: GPUProgrammableStage): Record<string, unknown> {
  return {
    module: idOf(stage.module),
    entryPoint: stage.entryPoint,
    constants: stage.constants ?? {},
  };
}

function layoutId(layout: GPUPipelineLayout | 'auto' | undefined): number | null {
  return layout === undefined || layout === 'auto' ? null : idOf(layout);
}

function renderPipelineJson(descriptor: GPURenderPipelineDescriptor): string {
  return JSON.stringify({
    label: descriptor.label,
    layout: layoutId(descriptor.layout),
    vertex: {
      ...programmableStage(descriptor.vertex),
      buffers: Array.from(descriptor.vertex.buffers ?? [], (buffer) =>
        buffer === null || buffer === undefined
          ? null
          : { ...buffer, attributes: Array.from(buffer.attributes) },
      ),
    },
    primitive: descriptor.primitive,
    depthStencil: descriptor.depthStencil,
    multisample: descriptor.multisample,
    fragment:
      descriptor.fragment === undefined || descriptor.fragment === null
        ? null
        : {
            ...programmableStage(descriptor.fragment),
            targets: Array.from(descriptor.fragment.targets),
          },
  });
}

// Resource references already retained by encoders/bind groups are the submission
// authority. An unrelated upload or empty submit must not present an acquired image.
function submittedTextures(buffers: readonly GPUCommandBuffer[]): ReadonlySet<NativeGPUTexture> {
  const textures = new Set<NativeGPUTexture>();
  const visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (value instanceof NativeGPUTexture) textures.add(value);
    else if (value instanceof NativeGPUTextureView) textures.add(value.texture);
    else if (value instanceof NativeGPUObject) visit(value.refs);
    else if (Array.isArray(value)) for (const entry of value) visit(entry);
    else if (!(value instanceof DeviceChild))
      for (const entry of Object.values(value)) visit(entry);
  };
  for (const buffer of buffers) visit(buffer);
  return textures;
}

class NativeGPUQueue {
  label = '';
  private declare readonly device: NativeGPUDevice;
  constructor(device: NativeGPUDevice) {
    hideReference(this, 'device', device);
  }

  toJSON(): Record<string, never> {
    return {};
  }

  submit(commandBuffers: Iterable<GPUCommandBuffer>): void {
    const buffers = Array.from(commandBuffers);
    const accepted = this.device.native.queueSubmit(buffers.map(idOf));
    this.device.touch();
    if (accepted) this.device.presentSurfaces(buffers);
  }

  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: BufferSource | SharedArrayBuffer,
    dataOffset = 0,
    size?: number,
  ): void {
    const element = ArrayBuffer.isView(data)
      ? ((data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1)
      : 1;
    const bytes = bytesOf(data);
    const start = dataOffset * element;
    const length = size === undefined ? bytes.byteLength - start : size * element;
    if (start < 0 || length < 0 || start + length > bytes.byteLength) {
      throw domError('OperationError', 'writeBuffer data range exceeds the source');
    }
    this.device.native.queueWriteBuffer(
      idOf(buffer),
      bufferOffset,
      bytes.subarray(start, start + length),
    );
    this.device.touch();
  }

  writeTexture(
    destination: GPUTexelCopyTextureInfo,
    data: BufferSource | SharedArrayBuffer,
    dataLayout: GPUTexelCopyBufferLayout,
    size: GPUExtent3D,
  ): void {
    this.device.native.queueWriteTexture(
      JSON.stringify({
        destination: {
          texture: idOf(destination.texture),
          mipLevel: destination.mipLevel ?? 0,
          origin: textureCopyOrigin(destination.origin),
          aspect: destination.aspect,
        },
        offset: dataLayout.offset ?? 0,
        bytesPerRow: dataLayout.bytesPerRow,
        rowsPerImage: dataLayout.rowsPerImage,
        size: extent(size),
      }),
      bytesOf(data),
    );
    this.device.touch();
  }

  copyExternalImageToTexture(): void {
    throw domError(
      'OperationError',
      'copyExternalImageToTexture is unavailable on the native wgpu device (no DOM image sources in Node)',
    );
  }

  onSubmittedWorkDone(): Promise<undefined> {
    return new Promise((resolve) => {
      setImmediate(() => {
        this.device.native.queueWait();
        this.device.touch();
        resolve(undefined);
      });
    });
  }
}

export class NativeGPUDevice extends EventTarget {
  private readonly surfaces = new Set<{
    present: (textures: ReadonlySet<NativeGPUTexture>) => void;
    retire: () => void;
  }>();
  label: string;
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
  readonly adapterInfo: GPUAdapterInfo;
  readonly queue: NativeGPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  onuncapturederror: ((event: GPUUncapturedErrorEvent) => unknown) | null = null;
  private resolveLost!: (info: GPUDeviceLostInfo) => void;
  private drainScheduled = false;
  private destroyed = false;

  constructor(
    readonly native: NativeDevice,
    adapterInfo: GPUAdapterInfo,
    label: string | undefined,
  ) {
    super();
    this.label = label ?? '';
    this.features = new Set(native.features());
    this.limits = Object.freeze(JSON.parse(native.limits()) as Record<string, number>);
    this.adapterInfo = adapterInfo;
    this.queue = new NativeGPUQueue(this);
    this.lost = new Promise((resolve) => {
      this.resolveLost = resolve;
    });
  }

  toJSON(): Record<string, never> {
    return {};
  }

  /** Presentation follows the submission that actually uses an acquired image. */
  attachSurface(surface: {
    present: (textures: ReadonlySet<NativeGPUTexture>) => void;
    retire: () => void;
  }): () => void {
    if (this.destroyed) throw domError('InvalidStateError', 'The native GPU device is destroyed');
    this.surfaces.add(surface);
    return () => this.surfaces.delete(surface);
  }

  presentSurfaces(buffers: readonly GPUCommandBuffer[]): void {
    if (this.surfaces.size === 0) return;
    const textures = submittedTextures(buffers);
    for (const surface of this.surfaces) surface.present(textures);
  }

  private retireSurfaces(): void {
    for (const surface of this.surfaces) surface.retire();
    this.surfaces.clear();
  }

  /** Nanoseconds per raw timestamp tick; wgpu does not normalize resolved timestamps. */
  get timestampPeriod(): number {
    return this.native.timestampPeriod();
  }

  /** Schedule delivery of uncaptured errors and device loss. */
  touch(): void {
    if (this.drainScheduled || this.destroyed) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.deliver();
    });
  }

  /** Drop the native entry of a collected or destroyed object. */
  releaseId(id: number): void {
    if (!this.destroyed && id !== 0) this.native.release(id);
  }

  private deliver(): void {
    if (this.destroyed) return;
    for (const record of JSON.parse(this.native.drainErrors()) as ErrorRecord[]) {
      const event = new GPUUncapturedErrorEvent('uncapturederror', { error: gpuError(record) });
      const handled = this.onuncapturederror !== null;
      this.onuncapturederror?.(event);
      this.dispatchEvent(event);
      if (!handled && process.env.FORGEAX_WGPU_NATIVE_QUIET !== '1') {
        console.warn(`[rhi-wgpu-native] uncaptured ${record.kind} error: ${record.message}`);
      }
    }
    const lost = this.native.lostInfo();
    if (lost !== null) {
      this.retireSurfaces();
      this.resolveLost({
        reason: lost[0] === 'destroyed' ? 'destroyed' : 'unknown',
        message: lost[1] ?? '',
      } as GPUDeviceLostInfo);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.deliver();
    this.retireSurfaces();
    this.destroyed = true;
    this.native.destroy();
    this.resolveLost({ reason: 'destroyed', message: 'device.destroy()' } as GPUDeviceLostInfo);
  }

  pushErrorScope(filter: GPUErrorFilter): void {
    this.native.pushErrorScope(filter);
  }

  popErrorScope(): Promise<GPUError | null> {
    try {
      const record = JSON.parse(this.native.popErrorScope()) as ErrorRecord | null;
      return Promise.resolve(record === null ? null : (gpuError(record) as unknown as GPUError));
    } catch (cause) {
      return Promise.reject(
        domError('OperationError', cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  createBuffer(descriptor: GPUBufferDescriptor): NativeGPUBuffer {
    return new NativeGPUBuffer(this, descriptor);
  }

  createTexture(descriptor: GPUTextureDescriptor): NativeGPUTexture {
    return new NativeGPUTexture(this, descriptor);
  }

  createSampler(descriptor: GPUSamplerDescriptor = {}): NativeGPUObject {
    const id = this.native.createSampler(JSON.stringify(descriptor));
    this.touch();
    return new NativeGPUObject(this, id, descriptor.label);
  }

  createShaderModule(descriptor: GPUShaderModuleDescriptor): NativeGPUShaderModule {
    // DXC treats wgpu's shader label as a source filename. Content-addressed
    // labels can fail Windows compilation; retain the public/tape label below.
    const nativeLabel =
      process.platform === 'win32'
        ? // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows source filenames exclude control characters.
          descriptor.label?.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        : descriptor.label;
    const result = JSON.parse(
      this.native.createShaderModule(descriptor.code, nativeLabel ?? null),
    ) as { id: number; messages: GPUCompilationMessage[] };
    this.touch();
    return new NativeGPUShaderModule(this, result.id, descriptor.label, result.messages);
  }

  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): NativeGPUObject {
    const id = this.native.createBindGroupLayout(
      JSON.stringify({ label: descriptor.label, entries: Array.from(descriptor.entries) }),
    );
    this.touch();
    return new NativeGPUObject(this, id, descriptor.label);
  }

  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): NativeGPUObject {
    const id = this.native.createPipelineLayout(
      JSON.stringify({
        label: descriptor.label,
        bindGroupLayouts: Array.from(descriptor.bindGroupLayouts, (layout) =>
          layout === null || layout === undefined ? null : idOf(layout),
        ),
        immediateSize: (descriptor as { immediateSize?: number }).immediateSize ?? 0,
      }),
    );
    this.touch();
    return new NativeGPUObject(this, id, descriptor.label);
  }

  createBindGroup(descriptor: GPUBindGroupDescriptor): NativeGPUObject {
    const entries = Array.from(descriptor.entries);
    const id = this.native.createBindGroup(
      JSON.stringify({
        label: descriptor.label,
        layout: idOf(descriptor.layout),
        entries: entries.map((entry) => ({
          binding: entry.binding,
          resource: bindingResource(entry.resource),
        })),
      }),
    );
    this.touch();
    return new NativeGPUObject(this, id, descriptor.label, entries);
  }

  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): NativeGPUPipeline {
    const id = this.native.createRenderPipeline(renderPipelineJson(descriptor));
    this.touch();
    return new NativeGPUPipeline(this, id, descriptor.label);
  }

  createComputePipeline(descriptor: GPUComputePipelineDescriptor): NativeGPUPipeline {
    const id = this.native.createComputePipeline(
      JSON.stringify({
        label: descriptor.label,
        layout: layoutId(descriptor.layout),
        compute: programmableStage(descriptor.compute),
      }),
    );
    this.touch();
    return new NativeGPUPipeline(this, id, descriptor.label);
  }

  createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor): Promise<NativeGPUPipeline> {
    return this.scopedPipeline(() => this.createRenderPipeline(descriptor));
  }

  createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor): Promise<NativeGPUPipeline> {
    return this.scopedPipeline(() => this.createComputePipeline(descriptor));
  }

  private async scopedPipeline(create: () => NativeGPUPipeline): Promise<NativeGPUPipeline> {
    this.native.pushErrorScope('validation');
    this.native.pushErrorScope('internal');
    const pipeline = create();
    const internal = JSON.parse(this.native.popErrorScope()) as ErrorRecord | null;
    const validation = JSON.parse(this.native.popErrorScope()) as ErrorRecord | null;
    const failure = validation ?? internal;
    if (failure !== null) {
      throw new GPUPipelineError(
        failure.message,
        failure.kind === 'validation' ? 'validation' : 'internal',
      );
    }
    return pipeline;
  }

  createQuerySet(descriptor: GPUQuerySetDescriptor): NativeGPUQuerySet {
    return new NativeGPUQuerySet(this, descriptor);
  }

  createCommandEncoder(descriptor: GPUCommandEncoderDescriptor = {}): NativeCommandEncoder {
    return new NativeCommandEncoder(this, descriptor.label);
  }

  createRenderBundleEncoder(
    descriptor: GPURenderBundleEncoderDescriptor,
  ): NativeRenderBundleEncoder {
    return new NativeRenderBundleEncoder(this, descriptor);
  }

  /** Ray Query extension: the descriptor is the RHI `BlasDescriptor`. */
  createBlas(descriptor: { readonly label?: string | undefined }): NativeAccelerationStructure {
    const id = this.native.createBlas(JSON.stringify(descriptor));
    this.touch();
    return new NativeAccelerationStructure(this, id, descriptor.label);
  }

  /** Ray Query extension: the descriptor is the RHI `TlasDescriptor`. */
  createTlas(descriptor: { readonly label?: string | undefined }): NativeAccelerationStructure {
    const id = this.native.createTlas(JSON.stringify(descriptor));
    this.touch();
    return new NativeAccelerationStructure(this, id, descriptor.label);
  }

  importExternalTexture(): never {
    throw domError(
      'OperationError',
      'importExternalTexture is unavailable on the native wgpu device',
    );
  }
}

export class NativeGPUAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
  readonly info: GPUAdapterInfo;
  readonly isFallbackAdapter: boolean;

  constructor(
    private readonly native: NativeAdapter,
    hidden: ReadonlySet<string>,
  ) {
    this.features = new Set(native.features().filter((feature) => !hidden.has(feature)));
    this.limits = Object.freeze(JSON.parse(native.limits()) as Record<string, number>);
    const info = JSON.parse(native.info()) as GPUAdapterInfo & { isFallbackAdapter: boolean };
    this.info = info;
    this.isFallbackAdapter = info.isFallbackAdapter;
  }

  async requestDevice(descriptor: GPUDeviceDescriptor = {}): Promise<NativeGPUDevice> {
    const requiredLimits: Record<string, number> = {};
    for (const [name, value] of Object.entries(descriptor.requiredLimits ?? {})) {
      if (typeof value === 'number') requiredLimits[name] = value;
    }
    let device: NativeDevice;
    try {
      device = this.native.requestDevice(
        JSON.stringify({
          label: descriptor.label,
          requiredFeatures: Array.from(descriptor.requiredFeatures ?? []),
          requiredLimits,
        }),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw /exceeds|not supported|unknown/.test(message)
        ? new TypeError(message)
        : domError('OperationError', message);
    }
    return new NativeGPUDevice(device, this.info, descriptor.label);
  }
}

export class NativeGPU {
  readonly wgslLanguageFeatures: ReadonlySet<string> = new Set();
  /** `hiddenFeatures` are withheld from every adapter (an A/B comparison knob). */
  constructor(
    private readonly binding: Pick<NativeBinding, 'requestAdapter' | 'preferredCanvasFormat'>,
    private readonly hiddenFeatures: ReadonlySet<string> = new Set(),
  ) {}

  async requestAdapter(options: GPURequestAdapterOptions = {}): Promise<NativeGPUAdapter | null> {
    const adapter = this.binding.requestAdapter(
      options.powerPreference ?? null,
      options.forceFallbackAdapter ?? null,
    );
    return adapter === null ? null : new NativeGPUAdapter(adapter, this.hiddenFeatures);
  }

  getPreferredCanvasFormat(): GPUTextureFormat {
    return this.binding.preferredCanvasFormat?.() ?? 'rgba8unorm';
  }
}
