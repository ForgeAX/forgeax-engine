// @forgeax/engine-rhi-webgpu/src/ray-query - acceleration structures over a
// WebGPU-shaped device that carries wgpu's Ray Query extension.
//
// Browser WebGPU and Dawn expose no acceleration structures, so their devices
// lack `createBlas` and report `backend-has-no-ray-query`. The native wgpu
// GPU (`@forgeax/engine-rhi-wgpu-native`) adds the extension to the raw
// objects: `device.createBlas/createTlas`, `encoder.buildAccelerationStructures`,
// a TLAS object accepted as a bind-group resource, buffer usage
// `BLAS_INPUT_BUFFER_USAGE`, and the `wgpu-ray-query` feature plus four limits.
// RHI handles are the raw BLAS/TLAS objects; this ledger owns validation,
// liveness and BLAS-before-TLAS ordering with the shared RHI validators.

import type {
  Blas,
  BlasBuildEntry,
  BlasDescriptor,
  Buffer,
  Result,
  RhiError as RhiErrorType,
  RhiRayQueryCaps,
  Tlas,
  TlasBuildEntry,
  TlasDescriptor,
} from '@forgeax/engine-rhi';
import {
  deriveRayQueryCaps,
  RAY_QUERY_FEATURE,
  RhiError,
  rayQueryUnsupported,
  validateBlasBuild,
  validateBlasDescriptor,
  validateTlasBuild,
  validateTlasDescriptor,
} from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';

/** A raw acceleration structure object of the extension. */
export interface RawAccelerationStructure {
  destroy(): void;
}

/** Raw build entries: RHI shapes with raw buffers and acceleration structures. */
export interface RawBlasBuildEntry {
  readonly blas: RawAccelerationStructure;
  readonly geometries: readonly {
    readonly vertexBuffer: GPUBuffer;
    readonly firstVertex?: number | undefined;
    readonly vertexStride: number;
    readonly index?:
      | { readonly buffer: GPUBuffer; readonly firstIndex?: number | undefined }
      | undefined;
  }[];
}

export interface RawTlasBuildEntry {
  readonly tlas: RawAccelerationStructure;
  readonly instances: readonly {
    readonly blas: RawAccelerationStructure;
    readonly transform: ArrayLike<number>;
    readonly customIndex: number;
    readonly mask: number;
  }[];
}

/** Device-side extension members. */
export interface RawRayQueryDevice {
  createBlas(descriptor: BlasDescriptor): RawAccelerationStructure;
  createTlas(descriptor: TlasDescriptor): RawAccelerationStructure;
}

/** Encoder-side extension member. */
export interface RawRayQueryEncoder {
  buildAccelerationStructures(
    blas: readonly RawBlasBuildEntry[],
    tlas: readonly RawTlasBuildEntry[],
  ): void;
}

function rawRayQueryDevice(rawDevice: GPUDevice): RawRayQueryDevice | undefined {
  const candidate = rawDevice as unknown as Partial<RawRayQueryDevice>;
  return typeof candidate.createBlas === 'function' && typeof candidate.createTlas === 'function'
    ? (candidate as RawRayQueryDevice)
    : undefined;
}

/** `caps.rayQuery` of a raw device: one derivation from its features and limits. */
export function webgpuRayQueryCaps(rawDevice: GPUDevice): RhiRayQueryCaps {
  return deriveRayQueryCaps(
    rawRayQueryDevice(rawDevice) !== undefined,
    rawDevice.features.has(RAY_QUERY_FEATURE as GPUFeatureName),
    rawDevice.limits as unknown as Readonly<Record<string, unknown>>,
  );
}

function staleHandle(what: string): RhiErrorType {
  return new RhiError({
    code: 'destroy-after-destroy',
    expected: `a live ${what} created by this device`,
    hint: `${what} was destroyed or belongs to another device; create a new one before building or binding it`,
  });
}

/** Per-device BLAS/TLAS ledger of the WebGPU shim. */
export class WebGpuAccelerationStructures {
  private readonly blasStates = new WeakMap<
    Blas,
    { descriptor: BlasDescriptor; built: boolean; destroyed: boolean }
  >();
  private readonly tlasStates = new WeakMap<
    Tlas,
    { descriptor: TlasDescriptor; built: boolean; destroyed: boolean }
  >();

  constructor(
    readonly caps: RhiRayQueryCaps,
    private readonly rawDevice: GPUDevice,
    private readonly bufferUsage: (buffer: Buffer) => number,
    private readonly rawBuffer: (buffer: Buffer) => GPUBuffer,
  ) {}

  createBlas(desc: BlasDescriptor): Result<Blas, RhiErrorType> {
    const valid = validateBlasDescriptor(this.caps, desc);
    if (!valid.ok) return valid;
    const raw = rawRayQueryDevice(this.rawDevice);
    if (raw === undefined) return rayQueryUnsupported('createBlas', this.caps);
    const blas = raw.createBlas(desc) as unknown as Blas;
    this.blasStates.set(blas, { descriptor: desc, built: false, destroyed: false });
    return ok(blas);
  }

  createTlas(desc: TlasDescriptor): Result<Tlas, RhiErrorType> {
    const valid = validateTlasDescriptor(this.caps, desc);
    if (!valid.ok) return valid;
    const raw = rawRayQueryDevice(this.rawDevice);
    if (raw === undefined) return rayQueryUnsupported('createTlas', this.caps);
    const tlas = raw.createTlas(desc) as unknown as Tlas;
    this.tlasStates.set(tlas, { descriptor: desc, built: false, destroyed: false });
    return ok(tlas);
  }

  destroy(
    handle: Blas | Tlas,
    operation: 'destroyBlas' | 'destroyTlas',
  ): Result<void, RhiErrorType> {
    if (!this.caps.supported) return rayQueryUnsupported(operation, this.caps);
    const what = operation === 'destroyBlas' ? 'BLAS' : 'TLAS';
    const state =
      operation === 'destroyBlas'
        ? this.blasStates.get(handle as Blas)
        : this.tlasStates.get(handle as Tlas);
    if (state === undefined || state.destroyed) return err(staleHandle(what));
    state.destroyed = true;
    (handle as unknown as RawAccelerationStructure).destroy();
    return ok(undefined);
  }

  /** Whether `tlas` is live and was built at least once (bind-group admission). */
  isBuiltTlas(tlas: Tlas): boolean {
    const state = this.tlasStates.get(tlas);
    return state?.built === true && !state.destroyed;
  }

  build(
    rawEncoder: GPUCommandEncoder,
    blasEntries: readonly BlasBuildEntry[],
    tlasEntries: readonly TlasBuildEntry[],
  ): Result<void, RhiErrorType> {
    if (!this.caps.supported) return rayQueryUnsupported('buildAccelerationStructures', this.caps);
    for (const entry of blasEntries) {
      const desc = this.live(this.blasStates, entry.blas, 'BLAS');
      if (!desc.ok) return desc;
      const valid = validateBlasBuild(desc.value, entry, this.bufferUsage);
      if (!valid.ok) return valid;
    }
    const pending = new Set(blasEntries.map((entry) => entry.blas));
    for (const entry of tlasEntries) {
      const desc = this.live(this.tlasStates, entry.tlas, 'TLAS');
      if (!desc.ok) return desc;
      const valid = validateTlasBuild(desc.value, entry);
      if (!valid.ok) return valid;
      for (const [index, instance] of entry.instances.entries()) {
        const blas = this.live(this.blasStates, instance.blas, 'BLAS');
        if (!blas.ok) return blas;
        if (this.blasStates.get(instance.blas)?.built !== true && !pending.has(instance.blas)) {
          return err(
            new RhiError({
              code: 'rhi-descriptor-invalid',
              expected: 'every TLAS instance references a BLAS built before or in this call',
              hint: `instances[${index}] references a BLAS that was never built; add it to the blas entries`,
            }),
          );
        }
      }
    }
    const rawBlas: RawBlasBuildEntry[] = blasEntries.map((entry) => ({
      blas: entry.blas as unknown as RawAccelerationStructure,
      geometries: entry.geometries.map((geometry) => ({
        vertexBuffer: this.rawBuffer(geometry.vertexBuffer),
        firstVertex: geometry.firstVertex,
        vertexStride: geometry.vertexStride,
        index:
          geometry.index === undefined
            ? undefined
            : {
                buffer: this.rawBuffer(geometry.index.buffer),
                firstIndex: geometry.index.firstIndex,
              },
      })),
    }));
    const rawTlas: RawTlasBuildEntry[] = tlasEntries.map((entry) => ({
      tlas: entry.tlas as unknown as RawAccelerationStructure,
      instances: entry.instances.map((instance) => ({
        blas: instance.blas as unknown as RawAccelerationStructure,
        transform: instance.transform,
        customIndex: instance.customIndex,
        mask: instance.mask,
      })),
    }));
    (rawEncoder as unknown as RawRayQueryEncoder).buildAccelerationStructures(rawBlas, rawTlas);
    for (const entry of blasEntries) {
      const state = this.blasStates.get(entry.blas);
      if (state !== undefined) state.built = true;
    }
    for (const entry of tlasEntries) {
      const state = this.tlasStates.get(entry.tlas);
      if (state !== undefined) state.built = true;
    }
    return ok(undefined);
  }

  private live<H extends Blas | Tlas, D>(
    states: WeakMap<H, { descriptor: D; built: boolean; destroyed: boolean }>,
    handle: H,
    what: 'BLAS' | 'TLAS',
  ): Result<D, RhiErrorType> {
    const state = states.get(handle);
    if (state === undefined || state.destroyed) return err(staleHandle(what));
    return ok(state.descriptor);
  }
}
