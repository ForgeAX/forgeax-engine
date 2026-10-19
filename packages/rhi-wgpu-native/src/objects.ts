// Native device children own table identity, resource state and retained references.
// Recording and device factories share these objects without importing one another.

import type { NativeGPUDevice } from './gpu';

/** Object with a native table id. */
export interface NativeObject {
  readonly nativeId: number;
}

export function domError(
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

export abstract class DeviceChild implements NativeObject {
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
