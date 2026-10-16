// @forgeax/engine-rhi-null/src/ray-query - structural acceleration-structure
// ledger for the headless backend.
//
// A default RhiNull device reports `caps.rayQuery` as
// `backend-has-no-ray-query` and every BLAS/TLAS operation returns the shared
// `feature-not-enabled` error. A device created with `{ rayQuery: limits }`
// simulates a Ray Query device structurally: descriptors are validated by the
// shared RHI validators, handles go through the Bookkeeper, and builds check
// topology, liveness, and BLAS-before-TLAS ordering. Nothing is traced.

import type {
  Blas,
  BlasBuildEntry,
  BlasDescriptor,
  Buffer,
  Result,
  RhiError as RhiErrorType,
  RhiRayQueryCaps,
  RhiRayQueryLimits,
  Tlas,
  TlasBuildEntry,
  TlasDescriptor,
} from '@forgeax/engine-rhi';
import {
  RAY_QUERY_BACKEND_UNSUPPORTED,
  RhiError,
  rayQueryUnsupported,
  validateBlasBuild,
  validateBlasDescriptor,
  validateRayQueryBufferUsage,
  validateTlasBuild,
  validateTlasDescriptor,
} from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import type { Bookkeeper } from './bookkeeping';

/** Derive `caps.rayQuery` from the optional simulated limits. */
export function nullRayQueryCaps(limits: RhiRayQueryLimits | undefined): RhiRayQueryCaps {
  return limits === undefined ? RAY_QUERY_BACKEND_UNSUPPORTED : { supported: true, ...limits };
}

function staleHandle(what: string): RhiErrorType {
  return new RhiError({
    code: 'destroy-after-destroy',
    expected: `a live ${what} handle`,
    hint: `${what} was destroyed; create a new one before building or binding it`,
  });
}

/** Per-device BLAS/TLAS ledger. */
export class NullAccelerationStructures {
  private readonly blasStates = new WeakMap<Blas, { descriptor: BlasDescriptor; built: boolean }>();
  private readonly tlasStates = new WeakMap<Tlas, { descriptor: TlasDescriptor; built: boolean }>();
  private readonly bufferUsage = new WeakMap<Buffer, number>();

  constructor(
    readonly caps: RhiRayQueryCaps,
    private readonly bookkeeper: Bookkeeper,
  ) {}

  /** Gate and remember a buffer's creation usage (BLAS input admission). */
  admitBuffer(usage: number): Result<void, RhiErrorType> {
    return validateRayQueryBufferUsage(this.caps, usage);
  }

  rememberBuffer(buffer: Buffer, usage: number): void {
    this.bufferUsage.set(buffer, usage);
  }

  createBlas(desc: BlasDescriptor): Result<Blas, RhiErrorType> {
    const valid = validateBlasDescriptor(this.caps, desc);
    if (!valid.ok) return valid;
    const blas = this.bookkeeper.register('Blas') as unknown as Blas;
    this.blasStates.set(blas, { descriptor: desc, built: false });
    return ok(blas);
  }

  createTlas(desc: TlasDescriptor): Result<Tlas, RhiErrorType> {
    const valid = validateTlasDescriptor(this.caps, desc);
    if (!valid.ok) return valid;
    const tlas = this.bookkeeper.register('Tlas') as unknown as Tlas;
    this.tlasStates.set(tlas, { descriptor: desc, built: false });
    return ok(tlas);
  }

  destroy(
    handle: Blas | Tlas,
    operation: 'destroyBlas' | 'destroyTlas',
  ): Result<void, RhiErrorType> {
    if (!this.caps.supported) return rayQueryUnsupported(operation, this.caps);
    return this.bookkeeper.destroy(handle);
  }

  /** Whether `tlas` is live and has been built at least once (bind-group admission). */
  isBuiltTlas(tlas: Tlas): boolean {
    return this.tlasStates.get(tlas)?.built === true && !this.bookkeeper.isDestroyed(tlas);
  }

  build(
    blasEntries: readonly BlasBuildEntry[],
    tlasEntries: readonly TlasBuildEntry[],
  ): Result<void, RhiErrorType> {
    if (!this.caps.supported) return rayQueryUnsupported('buildAccelerationStructures', this.caps);
    for (const entry of blasEntries) {
      const desc = this.liveDescriptor(this.blasStates, entry.blas, 'BLAS');
      if (!desc.ok) return desc;
      const valid = validateBlasBuild(
        desc.value,
        entry,
        (buffer) => this.bufferUsage.get(buffer) ?? 0,
      );
      if (!valid.ok) return valid;
    }
    const pending = new Set(blasEntries.map((blasEntry) => blasEntry.blas));
    for (const entry of tlasEntries) {
      const desc = this.liveDescriptor(this.tlasStates, entry.tlas, 'TLAS');
      if (!desc.ok) return desc;
      const valid = validateTlasBuild(desc.value, entry);
      if (!valid.ok) return valid;
      for (const [index, instance] of entry.instances.entries()) {
        const blas = this.liveDescriptor(this.blasStates, instance.blas, 'BLAS');
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

  private liveDescriptor<H extends object, D>(
    states: WeakMap<H, { descriptor: D; built: boolean }>,
    handle: H,
    what: 'BLAS' | 'TLAS',
  ): Result<D, RhiErrorType> {
    const ownership = this.bookkeeper.validateOwnership(handle);
    if (!ownership.ok) return ownership;
    const state = states.get(handle);
    if (state === undefined || ownership.value.destroyed) return err(staleHandle(what));
    return ok(state.descriptor);
  }
}
