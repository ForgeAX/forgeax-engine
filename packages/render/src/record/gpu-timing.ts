import type { Buffer, QuerySet, RhiCommandEncoder, RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_QUERY_RESOLVE,
} from '../gpu-usage';

// The pass descriptor timestampWrites API needs one pair per actual raster or
// compute pass. Keep the capture bounded so enabling timing cannot turn into an
// unbounded query allocation on a pathological graph.
const MAX_CAPTURE_PASSES = 64;
const QUERY_COUNT = MAX_CAPTURE_PASSES * 2;
const QUERY_RESULT_BYTES = 8;
const READBACK_BYTES = QUERY_COUNT * QUERY_RESULT_BYTES;
const PASS_NAMES = [
  'volume-inject',
  'volume-integrate',
  'volume-temporal',
  'volume-composite',
  'cloud-layer-density-cache',
  'cloud-layer-shadow',
  'cloud-layer-composite',
  'cloud-layer-depth',
  'cloud-layer-history',
] as const;
const CLOUD_PASS_NAMES = [
  'cloud-layer-density-cache',
  'cloud-layer-shadow',
  'cloud-layer-composite',
  'cloud-layer-depth',
  'cloud-layer-history',
] as const;

type TimedPassKind = 'raster' | 'compute';

interface TimedPass {
  readonly name: string;
  readonly kind: TimedPassKind;
  readonly executionIndex: number;
  readonly queryIndex: number;
}

export interface GpuTimingPassTimestampWrites {
  readonly querySet: QuerySet;
  readonly beginningOfPassWriteIndex: number;
  readonly endOfPassWriteIndex: number;
}

export type VolumeTimingObservation =
  | {
      readonly status: 'ready';
      readonly unit: 'ms';
      /** Envelope of authored volumetric pass boundaries, including gaps and overlap. */
      readonly totalMs: number;
      /** Derived envelope of all graph pass boundaries, not a native outer query or FPS. */
      readonly frameMs: number;
      readonly passes: readonly { readonly name: string; readonly milliseconds: number }[];
      /** Cloud producer timings captured by the same physical timestamp lane. */
      readonly cloud?: {
        readonly totalMs: number;
        readonly passes: readonly { readonly name: string; readonly milliseconds: number }[];
      };
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
    };

function unavailable(reason: string): VolumeTimingObservation {
  return Object.freeze({ status: 'unavailable', reason });
}

/**
 * Renderer-owned timestamp capture for the authored volume graph. Query
 * resources are private to one accepted submit and never cross the receipt
 * boundary. This publishes raw renderer timings; a benchmark runner owns
 * runner class, frame-count, and threshold qualification.
 */
export class GpuTimingCapture {
  readonly #device: RhiDevice;
  readonly #querySet: QuerySet;
  readonly #resolveBuffer: Buffer;
  readonly #readbackBuffer: Buffer;
  readonly #periodNanoseconds: number;
  readonly #passes: TimedPass[] = [];
  #resolved = false;
  #submitted = false;
  #discarded = false;
  #disposed = false;
  #frameStarted = false;
  #unavailableReason: string | undefined;
  #observation: Promise<VolumeTimingObservation> | undefined;

  private constructor(
    device: RhiDevice,
    querySet: QuerySet,
    resolveBuffer: Buffer,
    readbackBuffer: Buffer,
    periodNanoseconds: number,
  ) {
    this.#device = device;
    this.#querySet = querySet;
    this.#resolveBuffer = resolveBuffer;
    this.#readbackBuffer = readbackBuffer;
    this.#periodNanoseconds = periodNanoseconds;
  }

  static create(device: RhiDevice): Result<GpuTimingCapture | undefined, RhiError> {
    const period = device.caps.timestampPeriodNanoseconds;
    if (!device.caps.timestampQuery || period === null || !Number.isFinite(period) || period <= 0) {
      return ok(undefined);
    }
    const querySet = device.createQuerySet({
      label: 'volume-timing',
      type: 'timestamp',
      count: QUERY_COUNT,
    });
    if (!querySet.ok) return querySet;
    const resolveBuffer = device.createBuffer({
      label: 'volume-timing.resolve',
      size: READBACK_BYTES,
      usage: GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC,
    });
    if (!resolveBuffer.ok) {
      device.destroyQuerySet(querySet.value);
      return resolveBuffer;
    }
    const readbackBuffer = device.createBuffer({
      label: 'volume-timing.readback',
      size: READBACK_BYTES,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!readbackBuffer.ok) {
      device.destroyBuffer(resolveBuffer.value);
      device.destroyQuerySet(querySet.value);
      return readbackBuffer;
    }
    return ok(
      new GpuTimingCapture(
        device,
        querySet.value,
        resolveBuffer.value,
        readbackBuffer.value,
        period,
      ),
    );
  }

  /**
   * Reserve a query pair for a real render/compute pass. The pair is later
   * attached to that pass's descriptor by the render-graph instrumentation
   * seam; no command-encoder timestamp method is used.
   */
  beginPass(
    name: string,
    kind: TimedPassKind,
    executionIndex: number,
  ): GpuTimingPassTimestampWrites | undefined {
    if (this.#unavailableReason !== undefined || this.#resolved || this.#discarded) return;
    const existing = this.#passes.find((pass) => pass.executionIndex === executionIndex);
    if (existing !== undefined) {
      return {
        querySet: this.#querySet,
        beginningOfPassWriteIndex: existing.queryIndex * 2,
        endOfPassWriteIndex: existing.queryIndex * 2 + 1,
      };
    }
    if (this.#passes.length >= MAX_CAPTURE_PASSES) {
      this.#unavailableReason = `timestamp capture exceeded ${MAX_CAPTURE_PASSES} pass pairs`;
      return;
    }
    const index = this.#passes.length;
    this.#passes.push({ name, kind, executionIndex, queryIndex: index });
    this.#frameStarted = true;
    return {
      querySet: this.#querySet,
      beginningOfPassWriteIndex: index * 2,
      endOfPassWriteIndex: index * 2 + 1,
    };
  }

  /** An existing producer-owned timestamp pair cannot be overwritten. */
  markOwnerConflict(name: string): void {
    if (this.#unavailableReason === undefined) {
      this.#unavailableReason = `timestamp pass '${name}' already has producer-owned timestampWrites`;
    }
  }

  resolve(encoder: RhiCommandEncoder): Result<void, RhiError> {
    if (!this.#frameStarted || this.#unavailableReason !== undefined || this.#passes.length === 0) {
      this.#resolved = true;
      return ok(undefined);
    }
    const resolved = encoder.resolveQuerySet(
      this.#querySet,
      0,
      this.#passes.length * 2,
      this.#resolveBuffer,
      0,
    );
    if (!resolved.ok) return resolved;
    encoder.copyBufferToBuffer(this.#resolveBuffer, this.#readbackBuffer, READBACK_BYTES);
    this.#resolved = true;
    return ok(undefined);
  }

  markSubmitted(): void {
    if (!this.#discarded) this.#submitted = true;
  }

  discard(): void {
    if (this.#discarded) return;
    this.#discarded = true;
    this.#resolved = true;
    this.#submitted = false;
    this.#dispose();
  }

  observation(): Promise<VolumeTimingObservation> {
    if (this.#observation !== undefined) return this.#observation;
    // Frame markers are the generic renderer timing lane. The optional volume
    // markers enrich that same observation when authored fog passes exist, but
    // a Standard graph without fog must still publish frame timing.
    if (
      this.#discarded ||
      !this.#resolved ||
      !this.#submitted ||
      !this.#frameStarted ||
      this.#unavailableReason !== undefined
    ) {
      this.#observation = Promise.resolve(
        unavailable(
          this.#unavailableReason ?? 'timestamp capture did not reach an accepted render submit',
        ),
      );
      this.#dispose();
      return this.#observation;
    }
    this.#observation = this.#readbackBuffer
      .mapAsync(GPU_BUFFER_USAGE_MAP_READ)
      .then((mapped) => {
        if (!mapped.ok) {
          this.#dispose();
          return unavailable(`timestamp readback failed: ${mapped.error.code}`);
        }
        const range = mapped.value.getMappedRange();
        if (!range.ok) {
          mapped.value.unmap();
          this.#dispose();
          return unavailable(`timestamp mapping failed: ${range.error.code}`);
        }
        const values = new DataView(range.value);
        const decoded = this.#passes.map((pass, index) => ({
          name: pass.name,
          kind: pass.kind,
          begin: values.getBigUint64(index * 2 * QUERY_RESULT_BYTES, true),
          end: values.getBigUint64((index * 2 + 1) * QUERY_RESULT_BYTES, true),
        }));
        const envelope = (entries: typeof decoded): { begin: bigint; end: bigint } | undefined => {
          const first = entries[0];
          if (first === undefined) return;
          let begin = first.begin;
          let end = first.end;
          for (const entry of entries) {
            if (entry.begin < begin) begin = entry.begin;
            if (entry.end > end) end = entry.end;
          }
          return { begin, end };
        };
        const frame = envelope(decoded);
        const frameBegin = frame?.begin;
        const frameEnd = frame?.end;
        if (
          frameBegin === undefined ||
          frameEnd === undefined ||
          frameEnd <= frameBegin ||
          decoded.some(({ end, begin }) => end < begin)
        ) {
          mapped.value.unmap();
          this.#dispose();
          return unavailable('timestamp query returned a non-positive frame interval');
        }
        const volumeDecoded = decoded.filter(({ name }) =>
          PASS_NAMES.includes(name as (typeof PASS_NAMES)[number]),
        );
        const cloudDecoded = volumeDecoded.filter(({ name }) =>
          CLOUD_PASS_NAMES.includes(name as (typeof CLOUD_PASS_NAMES)[number]),
        );
        const volumeOnlyDecoded = volumeDecoded.filter(
          ({ name }) => !CLOUD_PASS_NAMES.includes(name as (typeof CLOUD_PASS_NAMES)[number]),
        );
        const passes = volumeOnlyDecoded.map(({ name, begin, end }) => ({
          name,
          milliseconds: (Number(end - begin) * this.#periodNanoseconds) / 1_000_000,
        }));
        const cloudPasses = cloudDecoded.map(({ name, begin, end }) => ({
          name,
          milliseconds: (Number(end - begin) * this.#periodNanoseconds) / 1_000_000,
        }));
        const frameMs = (Number(frameEnd - frameBegin) * this.#periodNanoseconds) / 1_000_000;
        const volume = envelope(volumeOnlyDecoded);
        const firstBegin = volume?.begin;
        const lastEnd = volume?.end;
        const totalMs =
          firstBegin === undefined || lastEnd === undefined
            ? 0
            : (Number(lastEnd - firstBegin) * this.#periodNanoseconds) / 1_000_000;
        mapped.value.unmap();
        this.#dispose();
        if (
          !Number.isFinite(frameMs) ||
          !Number.isFinite(totalMs) ||
          passes.some((pass) => !Number.isFinite(pass.milliseconds)) ||
          cloudPasses.some((pass) => !Number.isFinite(pass.milliseconds))
        ) {
          return unavailable('timestamp query returned a non-finite duration');
        }
        const cloud = envelope(cloudDecoded);
        const cloudFirstBegin = cloud?.begin;
        const cloudLastEnd = cloud?.end;
        const cloudTotalMs =
          cloudFirstBegin === undefined || cloudLastEnd === undefined
            ? 0
            : (Number(cloudLastEnd - cloudFirstBegin) * this.#periodNanoseconds) / 1_000_000;
        return Object.freeze({
          status: 'ready',
          unit: 'ms',
          totalMs,
          frameMs,
          passes,
          ...(cloudPasses.length === 0
            ? {}
            : { cloud: Object.freeze({ totalMs: cloudTotalMs, passes: cloudPasses }) }),
        });
      })
      .catch((cause: unknown) => {
        this.#dispose();
        return unavailable(`timestamp readback failed: ${String(cause)}`);
      });
    return this.#observation;
  }

  #dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#device.destroyBuffer(this.#resolveBuffer);
    this.#device.destroyBuffer(this.#readbackBuffer);
    this.#device.destroyQuerySet(this.#querySet);
  }
}
