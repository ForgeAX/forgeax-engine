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

/** Object with a native table id. */
export interface NativeObject {
  readonly nativeId: number;
}

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

function domError(
  name: 'OperationError' | 'AbortError' | 'InvalidStateError',
  message: string,
): Error {
  return new DOMException(message, name);
}

/** `GPUExtent3D` (sequence or dictionary) as the dictionary the addon reads. */
export function extent(value: GPUExtent3D): {
  width: number;
  height: number;
  depthOrArrayLayers: number;
} {
  if (Symbol.iterator in Object(value)) {
    const [width = 1, height = 1, depthOrArrayLayers = 1] = Array.from(value as Iterable<number>);
    return { width, height, depthOrArrayLayers };
  }
  const dict = value as GPUExtent3DDict;
  return {
    width: dict.width,
    height: dict.height ?? 1,
    depthOrArrayLayers: dict.depthOrArrayLayers ?? 1,
  };
}

export function origin(value: GPUOrigin3D | undefined): { x: number; y: number; z: number } {
  if (value === undefined) return { x: 0, y: 0, z: 0 };
  if (Symbol.iterator in Object(value)) {
    const [x = 0, y = 0, z = 0] = Array.from(value as Iterable<number>);
    return { x, y, z };
  }
  const dict = value as GPUOrigin3DDict;
  return { x: dict.x ?? 0, y: dict.y ?? 0, z: dict.z ?? 0 };
}

export function color(value: GPUColor): [number, number, number, number] {
  if (Symbol.iterator in Object(value)) {
    const [r = 0, g = 0, b = 0, a = 0] = Array.from(value as Iterable<number>);
    return [r, g, b, a];
  }
  const dict = value as GPUColorDict;
  return [dict.r, dict.g, dict.b, dict.a];
}

/**
 * Attach a back-reference as a non-enumerable property. W3C GPU objects expose no own
 * enumerable state, and RHI Debug walks recorded descriptors with `Object.values` and
 * `JSON.stringify`, so an enumerable `device` would make the object graph cyclic.
 */
export function hideReference(owner: object, key: string, value: unknown): void {
  Object.defineProperty(owner, key, { value, enumerable: false, writable: false });
}

export function idOf(object: unknown): number {
  return (object as NativeObject | null | undefined)?.nativeId ?? 0;
}

/** Bytes of an `AllowSharedBufferSource` (whole view). */
export function bytesOf(data: BufferSource | SharedArrayBuffer): Uint8Array {
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data as ArrayBuffer);
}

/** The process-wide registry that drops native table entries of collected JS objects. */
const releaser = new FinalizationRegistry<{ device: NativeGPUDevice; id: number }>(
  ({ device, id }) => device.releaseId(id),
);

abstract class DeviceChild implements NativeObject {
  label: string;
  declare readonly device: NativeGPUDevice;
  constructor(
    device: NativeGPUDevice,
    readonly nativeId: number,
    label: string | undefined,
  ) {
    hideReference(this, 'device', device);
    this.label = label ?? '';
    if (nativeId !== 0) releaser.register(this, { device, id: nativeId });
  }

  /** Serialize like a W3C GPU object (`{}`): descriptor snapshots must not walk the device. */
  toJSON(): Record<string, never> {
    return {};
  }
}

export class NativeGPUBuffer extends DeviceChild {
  readonly size: number;
  readonly usage: number;
  mapState: GPUBufferMapState;
  private mapMode = 0;
  private mapOffset = 0;
  private mapSize = 0;
  private pending: { aborted: boolean } | undefined;
  private ranges: { offset: number; data: ArrayBuffer }[] = [];
  private destroyed = false;

  constructor(device: NativeGPUDevice, descriptor: GPUBufferDescriptor) {
    super(
      device,
      device.native.createBuffer(
        JSON.stringify({
          label: descriptor.label,
          size: descriptor.size,
          usage: descriptor.usage,
          mappedAtCreation: descriptor.mappedAtCreation ?? false,
        }),
      ),
      descriptor.label,
    );
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.mapState = descriptor.mappedAtCreation === true ? 'mapped' : 'unmapped';
    if (descriptor.mappedAtCreation === true) {
      this.mapMode = GPUMapModeFlags.WRITE;
      this.mapSize = descriptor.size;
    }
    device.touch();
  }

  mapAsync(mode: number, offset = 0, size?: number): Promise<undefined> {
    const rangeSize = size ?? Math.max(0, this.size - offset);
    if (this.mapState !== 'unmapped' || this.destroyed) {
      const message = `mapAsync on a buffer whose mapState is '${this.mapState}'${this.destroyed ? ' (destroyed)' : ''}`;
      this.device.native.reportValidationError(message);
      this.device.touch();
      return Promise.reject(domError('OperationError', message));
    }
    const ticket = { aborted: false };
    this.pending = ticket;
    this.mapState = 'pending';
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        if (this.pending === ticket) this.pending = undefined;
        if (ticket.aborted) {
          reject(
            domError('AbortError', 'buffer was unmapped or destroyed before mapAsync resolved'),
          );
          return;
        }
        const failure = this.device.native.bufferMap(this.nativeId, mode, offset, rangeSize);
        this.device.touch();
        if (failure !== null) {
          this.mapState = 'unmapped';
          reject(domError('OperationError', failure));
          return;
        }
        this.mapState = 'mapped';
        this.mapMode = mode;
        this.mapOffset = offset;
        this.mapSize = rangeSize;
        resolve(undefined);
      });
    });
  }

  getMappedRange(offset = 0, size?: number): ArrayBuffer {
    const rangeSize = size ?? Math.max(0, this.mapOffset + this.mapSize - offset);
    if (
      this.mapState !== 'mapped' ||
      offset < this.mapOffset ||
      offset + rangeSize > this.mapOffset + this.mapSize
    ) {
      throw domError('OperationError', 'getMappedRange outside the mapped range');
    }
    for (const range of this.ranges) {
      if (offset < range.offset + range.data.byteLength && range.offset < offset + rangeSize) {
        throw domError('OperationError', 'getMappedRange overlaps a previous range');
      }
    }
    const data = new ArrayBuffer(rangeSize);
    if (rangeSize > 0) {
      try {
        new Uint8Array(data).set(
          this.device.native.bufferReadMapped(this.nativeId, offset, rangeSize),
        );
      } catch (cause) {
        if ((this.mapMode & GPUMapModeFlags.READ) !== 0) throw cause;
      }
    }
    this.ranges.push({ offset, data });
    return data;
  }

  unmap(): void {
    if (this.pending !== undefined) {
      this.pending.aborted = true;
      this.pending = undefined;
      this.mapState = 'unmapped';
      return;
    }
    if (this.mapState !== 'mapped') return;
    if ((this.mapMode & GPUMapModeFlags.WRITE) !== 0) {
      for (const range of this.ranges) {
        this.device.native.bufferWriteMapped(
          this.nativeId,
          range.offset,
          new Uint8Array(range.data),
        );
      }
    }
    this.device.native.bufferUnmap(this.nativeId);
    // Detach the mapped ArrayBuffers as WebGPU requires (ES2024 `transfer`).
    for (const range of this.ranges)
      (range.data as unknown as { transfer(): ArrayBuffer }).transfer();
    this.ranges = [];
    this.mapState = 'unmapped';
    this.mapMode = 0;
    this.device.touch();
  }

  destroy(): void {
    if (this.mapState === 'mapped' || this.pending !== undefined) this.unmap();
    this.destroyed = true;
    this.device.native.bufferDestroy(this.nativeId);
    this.device.touch();
  }
}

export class NativeGPUTexture extends DeviceChild {
  private expired = false;
  private readonly borrowed: boolean;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly dimension: GPUTextureDimension;
  readonly format: GPUTextureFormat;
  readonly usage: number;
  readonly textureBindingViewDimension: GPUTextureViewDimension | undefined;

  constructor(device: NativeGPUDevice, descriptor: GPUTextureDescriptor, nativeId?: number) {
    const size = extent(descriptor.size);
    super(
      device,
      nativeId ??
        device.native.createTexture(
          JSON.stringify({
            label: descriptor.label,
            size,
            mipLevelCount: descriptor.mipLevelCount ?? 1,
            sampleCount: descriptor.sampleCount ?? 1,
            dimension: descriptor.dimension,
            format: descriptor.format,
            usage: descriptor.usage,
            viewFormats: descriptor.viewFormats ? Array.from(descriptor.viewFormats) : [],
          }),
        ),
      descriptor.label,
    );
    this.borrowed = nativeId !== undefined;
    this.width = size.width;
    this.height = size.height;
    this.depthOrArrayLayers = size.depthOrArrayLayers;
    this.mipLevelCount = descriptor.mipLevelCount ?? 1;
    this.sampleCount = descriptor.sampleCount ?? 1;
    this.dimension = descriptor.dimension ?? '2d';
    this.format = descriptor.format;
    this.usage = descriptor.usage;
    this.textureBindingViewDimension = descriptor.textureBindingViewDimension;
    device.touch();
  }

  createView(descriptor: GPUTextureViewDescriptor = {}): NativeGPUTextureView {
    if (this.expired) throw domError('InvalidStateError', 'The native surface texture has expired');
    const id = this.device.native.createView(this.nativeId, JSON.stringify(descriptor));
    this.device.touch();
    return new NativeGPUTextureView(
      this.device,
      id,
      descriptor.label,
      this,
      descriptor.format ?? this.format,
    );
  }

  destroy(): void {
    if (this.borrowed) {
      this.expire();
      return;
    }
    this.device.native.textureDestroy(this.nativeId);
    this.device.touch();
  }

  /** Presentation retires the borrowed table entry, never the native window. */
  expire(): void {
    if (this.expired) return;
    this.expired = true;
    if (this.borrowed) {
      this.device.native.textureDestroy(this.nativeId);
      this.device.releaseId(this.nativeId);
    }
  }
}

export class NativeGPUTextureView extends DeviceChild {
  constructor(
    device: NativeGPUDevice,
    id: number,
    label: string | undefined,
    readonly texture: NativeGPUTexture,
    readonly format: GPUTextureFormat,
  ) {
    super(device, id, label);
  }
}

/** Opaque children that carry only their id (samplers, layouts, bind groups, ...). */
export class NativeGPUObject extends DeviceChild {
  // Keeps referenced JS objects reachable while this native object may use them.
  constructor(
    device: NativeGPUDevice,
    id: number,
    label: string | undefined,
    readonly refs?: unknown,
  ) {
    super(device, id, label);
  }
}

export class NativeGPUShaderModule extends DeviceChild {
  constructor(
    device: NativeGPUDevice,
    id: number,
    label: string | undefined,
    private readonly messages: readonly GPUCompilationMessage[],
  ) {
    super(device, id, label);
  }

  getCompilationInfo(): Promise<GPUCompilationInfo> {
    return Promise.resolve({ messages: this.messages } as unknown as GPUCompilationInfo);
  }
}

export class NativeGPUPipeline extends DeviceChild {
  getBindGroupLayout(index: number): NativeGPUObject {
    const id = this.device.native.pipelineBindGroupLayout(this.nativeId, index);
    this.device.touch();
    return new NativeGPUObject(this.device, id, undefined);
  }
}

export class NativeGPUQuerySet extends DeviceChild {
  constructor(device: NativeGPUDevice, descriptor: GPUQuerySetDescriptor) {
    super(
      device,
      device.native.createQuerySet(
        JSON.stringify({ label: descriptor.label, type: descriptor.type, count: descriptor.count }),
      ),
      descriptor.label,
    );
    this.type = descriptor.type;
    this.count = descriptor.count;
    device.touch();
  }
  readonly type: GPUQueryType;
  readonly count: number;

  destroy(): void {
    this.device.native.querySetDestroy(this.nativeId);
    this.device.touch();
  }
}

/** BLAS/TLAS of the Ray Query extension. */
export class NativeAccelerationStructure extends DeviceChild {
  destroy(): void {
    this.device.releaseId(this.nativeId);
  }
}

export const GPUBufferUsageFlags = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
} as const;
export const GPUTextureUsageFlags = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
} as const;
export const GPUMapModeFlags = { READ: 0x0001, WRITE: 0x0002 } as const;
export const GPUShaderStageFlags = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 } as const;
export const GPUColorWriteFlags = {
  RED: 0x1,
  GREEN: 0x2,
  BLUE: 0x4,
  ALPHA: 0x8,
  ALL: 0xf,
} as const;

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
          origin: origin(destination.origin),
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
