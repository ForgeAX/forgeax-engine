import { err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import {
  createGpuSceneTable,
  destroyGpuSceneTable,
  type GpuSceneTableBackend,
  type GpuSceneTableResource,
  type GpuSceneTableStorage,
  writeGpuSceneTable,
} from './gpu-scene-tables';

export type CapacityTable = 'primitive' | 'instance' | 'transform' | 'material';
export interface GpuSceneCapacityStatus {
  readonly phase: 'copying' | 'current' | 'published' | 'failed' | 'retiring' | 'retired';
  readonly tables: number;
  readonly transferredTables: number;
  readonly reservedBytes: number;
  readonly cpuBytes: number;
  readonly uploadedBytes: number;
  /** Actual task-private row bytes encoded, distinct from baseline copy/upload traffic. */
  readonly privateWriteBytes: number;
  /** Task-owned descriptor CPU bytes; these are not yet uploaded by the Inputs owner. */
  readonly privateDescriptorBytes: number;
}
interface Target {
  readonly name: CapacityTable;
  readonly stride: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  resource: GpuSceneTableStorage;
  binding: GpuSceneTableResource | undefined;
  readonly dirty: Set<number>;
  copied: number;
  readonly privateRanges: Map<number, { start: number; end: number }[]>;
}
export interface CapacityTableDemand {
  readonly name: CapacityTable;
  readonly stride: number;
  readonly bytes: number;
}

const COPY_BYTES = 64 * 1024;

/** Private replacement storage of one existing Scene. It authorizes no publication or draw. */
export class GpuSceneCapacityPreparation {
  private readonly targets: Target[] = [];
  private next = 0;
  private published = false;
  private transferred = 0;
  private dirtyCursor = 0;
  private preparationFailure: { readonly cause: unknown } | undefined;
  private uploaded = 0;
  private privateWriteBytes = 0;
  private busy = false;
  private retiring = false;
  private retired = false;
  private failure: { readonly cause: unknown } | undefined;

  constructor(
    private readonly device: RhiDevice,
    private readonly backend: GpuSceneTableBackend,
    private demands: readonly CapacityTableDemand[] | undefined,
    private source: ((name: CapacityTable) => Uint8Array) | undefined,
    private live: (() => boolean) | undefined,
    private finished: (() => void) | undefined,
    private retireRows?: () => boolean,
    private descriptorBytes?: () => number,
  ) {}

  planTables(demands: readonly CapacityTableDemand[]): void {
    if (this.demands !== undefined || this.retiring || this.retired) throw stale();
    this.demands = demands;
  }

  inspect(): GpuSceneCapacityStatus {
    return {
      phase: this.retired
        ? 'retired'
        : this.retiring
          ? 'retiring'
          : this.published
            ? 'published'
            : this.preparationFailure !== undefined || this.failure !== undefined
              ? 'failed'
              : this.copied()
                ? 'current'
                : 'copying',
      tables: this.targets.length,
      transferredTables: this.transferred,
      reservedBytes: this.targets.reduce(
        (sum, target) =>
          sum +
          (target.resource.kind === 'buffer'
            ? target.bytes.byteLength
            : target.resource.width *
              16 *
              Math.max(1, Math.ceil(target.bytes.byteLength / (target.resource.width * 16)))),
        0,
      ),
      cpuBytes: this.targets.reduce((sum, target) => sum + target.bytes.byteLength, 0),
      uploadedBytes: this.uploaded,
      privateWriteBytes: this.privateWriteBytes,
      privateDescriptorBytes: this.descriptorBytes?.() ?? 0,
    };
  }
  private copied(): boolean {
    return (
      this.next === this.demands?.length &&
      this.targets.every(
        (target) => target.copied === target.bytes.byteLength && target.dirty.size === 0,
      )
    );
  }
  isCurrent(): boolean {
    return this.observe(true);
  }
  /** Currency of Source/address custody, independent of pending ordinary numeric catch-up. */
  isValid(): boolean {
    return this.observe(false);
  }
  private observe(requireCopied: boolean): boolean {
    if (
      this.busy ||
      this.retiring ||
      this.retired ||
      this.failure !== undefined ||
      this.preparationFailure !== undefined
    )
      return false;
    this.busy = true;
    try {
      return (
        this.live?.() === true &&
        !this.retiring &&
        (!requireCopied || this.published || this.copied())
      );
    } finally {
      this.busy = false;
    }
  }
  /** The existing Scene's writes notify only private copies, never another authority. */
  dirty(name: CapacityTable, offset: number, size: number): void {
    if (this.published || this.retiring || this.retired || size === 0) return;
    const target = this.targets.find((value) => value.name === name);
    if (target === undefined) return;
    const end = Math.min(offset + size, target.bytes.byteLength);
    for (let chunk = Math.floor(offset / COPY_BYTES); chunk * COPY_BYTES < end; chunk++)
      target.dirty.add(chunk);
  }
  invalidate(): void {
    this.retiring = true;
  }

  step(): Result<GpuSceneCapacityStatus, RhiError> {
    if (
      this.busy ||
      this.retiring ||
      this.retired ||
      this.published ||
      this.failure !== undefined ||
      this.preparationFailure !== undefined
    )
      return err(stale());
    const demands = this.demands;
    if (demands === undefined) return err(stale());
    this.busy = true;
    try {
      if (this.live?.() !== true || this.retiring || this.retired) return err(stale());
      const demand = demands[this.next];
      if (demand !== undefined) {
        const bytes = new Uint8Array(demand.bytes);
        const created = createGpuSceneTable(
          this.device,
          this.backend,
          `gpu-scene-prepared-${demand.name}-table`,
          demand.bytes,
          (resource) => {
            this.targets.push({
              ...demand,
              bytes,
              resource,
              binding: undefined,
              dirty: new Set(),
              copied: 0,
              privateRanges: new Map(),
            });
          },
        );
        if (!created.ok) {
          this.preparationFailure = { cause: created.error };
          return created;
        }
        const held = this.targets.at(-1);
        if (held === undefined) return err(stale());
        held.binding = created.value;
        this.next++;
      } else {
        const target =
          this.targets.find((value) => value.copied < value.bytes.byteLength) ?? this.nextDirty();
        if (target !== undefined) this.copy(target).unwrap();
      }
      return this.live?.() === true && !this.retiring ? ok(this.inspect()) : err(stale());
    } catch (cause) {
      this.preparationFailure = { cause };
      throw cause;
    } finally {
      this.busy = false;
    }
  }
  private nextDirty(): Target | undefined {
    for (let step = 0; step < this.targets.length; step++) {
      const index = this.dirtyCursor++ % this.targets.length;
      const target = this.targets[index];
      if (target !== undefined && target.dirty.size > 0) return target;
    }
    return undefined;
  }
  private copy(target: Target): Result<void, RhiError> {
    const chunk =
      target.copied < target.bytes.byteLength
        ? target.copied / COPY_BYTES
        : target.dirty.values().next().value;
    if (chunk === undefined || this.source === undefined) return err(stale());
    const offset = chunk * COPY_BYTES;
    const end = Math.min(offset + COPY_BYTES, target.bytes.byteLength);
    // Remove before native work: a reentrant Scene write must remain pending.
    target.dirty.delete(chunk);
    const current = this.source(target.name);
    let start = offset;
    const baseline = (from: number, to: number) => {
      target.bytes.fill(0, from, to);
      if (from < current.byteLength)
        target.bytes.set(current.subarray(from, Math.min(to, current.byteLength)), from);
    };
    for (const range of target.privateRanges.get(chunk) ?? []) {
      baseline(start, range.start);
      start = range.end;
    }
    baseline(start, end);
    const write = writeGpuSceneTable(
      this.device,
      target.resource,
      target.bytes.buffer,
      offset,
      end - offset,
    );
    if (!write.ok) {
      target.dirty.add(chunk);
      return write;
    }
    this.uploaded += write.value;
    if (offset === target.copied) target.copied = end;
    return ok(undefined);
  }

  /** During live table contraction, keep the already copied prefix current as it is written.
   * Untouched future chunks still take the active source exactly once at their copy cursor. */
  followSubmitted(name: CapacityTable, offset: number, size: number): Result<void, RhiError> {
    const target = this.targets.find((candidate) => candidate.name === name);
    if (target === undefined || offset >= target.copied) return ok(undefined);
    const end = Math.min(offset + size, target.copied);
    const source = this.source?.(name);
    if (source === undefined || this.busy) return err(stale());
    target.bytes.set(source.subarray(offset, end), offset);
    const written = writeGpuSceneTable(
      this.device,
      target.resource,
      target.bytes.buffer,
      offset,
      end - offset,
    );
    if (!written.ok) return written;
    this.uploaded += written.value;
    return ok(undefined);
  }

  /** Give an abandoned private copy to the owning device's ordinary fenced retirement. */
  abandon(retire: (storage: GpuSceneTableStorage) => void): void {
    if (this.busy || this.published || this.retireRows !== undefined) throw stale();
    for (const target of this.targets) retire(target.resource);
    this.targets.length = 0;
    this.source = this.live = this.descriptorBytes = undefined;
    this.retired = true;
    const done = this.finished;
    this.finished = undefined;
    done?.();
  }

  /** Encode owned private rows without changing active bytes; catch-up preserves these intervals. */
  writeRows(name: CapacityTable, offset: number, bytes: Uint8Array): Result<void, RhiError> {
    if (
      this.busy ||
      this.published ||
      this.retiring ||
      this.retired ||
      this.failure !== undefined ||
      this.preparationFailure !== undefined
    )
      return err(stale());
    this.busy = true;
    try {
      const target = this.targets.find((value) => value.name === name);
      if (
        target === undefined ||
        this.live?.() !== true ||
        this.retiring ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset % target.stride !== 0 ||
        bytes.byteLength === 0 ||
        bytes.byteLength % target.stride !== 0 ||
        bytes.byteLength > COPY_BYTES ||
        offset + bytes.byteLength > target.bytes.byteLength
      )
        return err(stale());
      target.bytes.set(bytes, offset);
      this.protectRows(target, offset, offset + bytes.byteLength);
      this.privateWriteBytes += bytes.byteLength;
      return this.live?.() === true && !this.retiring ? ok(undefined) : err(stale());
    } finally {
      this.busy = false;
    }
  }

  private protectRows(target: Target, offset: number, end: number): void {
    for (let at = offset; at < end; ) {
      const chunk = Math.floor(at / COPY_BYTES);
      const stop = Math.min(end, (chunk + 1) * COPY_BYTES);
      const ranges = target.privateRanges.get(chunk) ?? [];
      let index = 0;
      while (index < ranges.length && (ranges[index]?.end ?? 0) < at) index++;
      let start = at,
        finish = stop;
      while (index < ranges.length && (ranges[index]?.start ?? Infinity) <= finish) {
        const range = ranges.splice(index, 1)[0];
        if (range !== undefined) {
          start = Math.min(start, range.start);
          finish = Math.max(finish, range.end);
        }
      }
      ranges.splice(index, 0, { start, end: finish });
      target.privateRanges.set(chunk, ranges);
      target.dirty.add(chunk);
      at = stop;
    }
  }
  /** Issuing Scene only: inspect exact owned data without a new source read or native call. */
  preparedTables():
    | readonly {
        readonly name: CapacityTable;
        readonly resource: GpuSceneTableResource;
        readonly bytes: Uint8Array<ArrayBuffer>;
      }[]
    | undefined {
    if (
      this.busy ||
      this.published ||
      this.retiring ||
      this.retired ||
      this.preparationFailure !== undefined ||
      !this.copied()
    )
      return undefined;
    const values = [];
    for (const target of this.targets) {
      if (target.binding === undefined) return undefined;
      values.push({ name: target.name, resource: target.binding, bytes: target.bytes });
    }
    return values;
  }

  /** Pure custody transfer after the aggregate's full preflight; no callback executes here. */
  transfer(current: () => boolean): Result<void, RhiError> {
    if (this.preparedTables() === undefined) return err(stale());
    this.published = true;
    this.transferred = this.targets.length;
    this.targets.length = 0;
    this.source = undefined;
    this.live = current;
    return ok(undefined);
  }

  /** Caller first fences all writes, then releases one exact private allocation per grant. */
  retireStep(): boolean {
    if (this.busy) throw stale();
    if (this.retired) return true;
    this.retiring = true;
    if (this.failure !== undefined) throw this.failure.cause;
    this.busy = true;
    try {
      const target = this.targets[0];
      if (target !== undefined) {
        try {
          destroyGpuSceneTable(this.device, target.resource);
        } catch (cause) {
          this.failure = { cause };
          throw cause;
        }
        this.targets.shift();
        return false;
      }
      try {
        if (this.retireRows?.() === false) return false;
      } catch (cause) {
        this.failure = { cause };
        throw cause;
      }
      this.retireRows = undefined;
      this.descriptorBytes = undefined;
      this.retired = true;
      this.source = undefined;
      this.live = undefined;
      const done = this.finished;
      this.finished = undefined;
      done?.();
      return true;
    } finally {
      this.busy = false;
    }
  }
}

function stale(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'the original live GPU Scene and its private table capacity copy',
    hint: 'retain cleanup responsibility and restart after Scene storage changes',
  });
}
