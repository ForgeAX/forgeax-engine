import {
  type ArrayRangesChange,
  InstanceTransformsStrideMismatchError,
} from '@forgeax/engine-ecs/projection';
import type { RhiErrorCode } from '@forgeax/engine-rhi';

const MATRIX_STRIDE = 16;

/** Renderer projection identity; never stored in a World or SceneAsset. */
export type InstanceCollectionId = number & {
  readonly __forgeaxInstanceCollectionId: unique symbol;
};
export interface InstanceCollectionInfo {
  readonly collectionId: InstanceCollectionId;
  readonly count: number;
  readonly revision: number;
}
export interface InstanceDirtyRange {
  start: number;
  end: number;
}
export interface InstanceCollectionSnapshot extends InstanceCollectionInfo {
  /**
   * Detached matrices of this revision. A renderer-owned buffer is reused two
   * revisions later, so a holder must not read revision `r` after `r + 2` has
   * been projected (the RenderScene retains at most the current and the
   * submitted revision, and seeds motion when the submitted one is older).
   */
  readonly transforms: Float32Array;
  readonly generations: Uint32Array;
  /** Rows that differ from `revision - 1`; absent when the whole column may differ. */
  readonly dirtyRanges?: readonly InstanceDirtyRange[];
}

/**
 * Row-level change evidence of the authored `Instances.transforms` column.
 * `changedSince` answers element (f32) ranges written after an epoch, or
 * `'whole'` when the source cannot prove them (see `World.setArrayRange`).
 */
export interface InstanceRowSource {
  readonly epoch: number;
  changedSince(epoch: number): ArrayRangesChange;
}

/** Monotonic work counters; flat per moved row regardless of collection size. */
export interface InstanceProjectionWork {
  /** Rows validated, compared, or copied by projection. */
  readonly rows: number;
  /** Projections that used the full-column path. */
  readonly fullProjections: number;
  /** Projections that used the dirty-row path. */
  readonly rowProjections: number;
}
export type InstanceSubmissionLane =
  | 'unresident'
  | 'direct-storage'
  | 'chunked-storage'
  | 'direct-uniform'
  | 'chunked-uniform'
  | 'unavailable';
export type InstanceBackendKind = 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null' | 'unknown';
export type InstanceCollectionFailureCode = RhiErrorCode | 'queue-write-buffer-failed';
export interface InstanceCollectionFailureFacts {
  readonly requestedBytes: number;
  readonly supportedBytes: number | undefined;
  readonly backend: InstanceBackendKind;
  readonly owner: 'renderer.instances';
  readonly cause: string;
  readonly recovery: string;
}
export interface InstanceCollectionInspection extends InstanceCollectionInfo {
  readonly residentGeneration: number | undefined;
  readonly lane: InstanceSubmissionLane;
  readonly uploadRanges: readonly InstanceDirtyRange[];
  readonly uploadedBytes: number;
  readonly requestedBytes: number;
  readonly supportedBytes: number | undefined;
  readonly backend: InstanceBackendKind;
  readonly owner: 'renderer.instances';
  readonly error:
    | {
        readonly code: InstanceCollectionFailureCode;
        readonly expected: string;
        readonly hint: string;
        readonly detail: InstanceCollectionFailureFacts;
      }
    | undefined;
}

export class InstanceTransformsError extends Error {
  readonly code = 'instance-transforms-invalid' as const;
  readonly expected = 'finite column-major mat4 values, with transforms.length a multiple of 16';
  readonly hint = 'repair Instances.transforms in the World or source SceneAsset and retry';
  constructor(
    readonly detail: { readonly actualLength: number; readonly nonFiniteIndex?: number },
  ) {
    super('Instances.transforms must contain complete finite matrices');
    this.name = 'InstanceTransformsError';
  }
}
export type InstanceProjectionError =
  | InstanceTransformsError
  | InstanceTransformsStrideMismatchError;

export function validateInstanceTransforms(
  transforms: ArrayLike<number>,
): InstanceProjectionError | undefined {
  if (transforms.length % MATRIX_STRIDE !== 0)
    return new InstanceTransformsStrideMismatchError(transforms.length);
  for (let index = 0; index < transforms.length; index++) {
    if (!Number.isFinite(transforms[index]))
      return new InstanceTransformsError({
        actualLength: transforms.length,
        nonFiniteIndex: index,
      });
  }
  return undefined;
}

const uniqueIdentities = new WeakMap<Uint32Array, boolean>();

/**
 * Whether a generation column names distinct, non-zero identities. Snapshot
 * generation columns are immutable, so the proof is memoized per column and a
 * stable collection pays O(N) once instead of on every row move.
 */
export function uniqueInstanceIdentities(generations: Uint32Array): boolean {
  let unique = uniqueIdentities.get(generations);
  if (unique === undefined) {
    unique = !generations.includes(0) && new Set(generations).size === generations.length;
    uniqueIdentities.set(generations, unique);
  }
  return unique;
}

/**
 * How the previous-matrix lane of an instance upload pairs with the current
 * collection: `'none'` writes previous = current, `'prior'` reads the
 * immediately preceding revision by ordinal, and `'unpaired'` needs a
 * generation remap (or a seed) over the whole collection.
 */
export type InstancePreviousPairing = 'none' | 'prior' | 'unpaired';

interface InstanceUploadSubject {
  readonly collectionId?: InstanceCollectionId;
  readonly transforms: Float32Array;
  readonly generations?: Uint32Array;
  readonly revision?: number;
  readonly dirtyRanges?: readonly InstanceDirtyRange[];
}

export function instancePreviousPairing(
  current: InstanceUploadSubject,
  previous: InstanceUploadSubject | undefined,
): InstancePreviousPairing {
  if (previous === undefined || previous.transforms === current.transforms) return 'none';
  return current.revision !== undefined &&
    previous.revision === current.revision - 1 &&
    previous.collectionId === current.collectionId &&
    previous.generations !== undefined &&
    previous.generations === current.generations
    ? 'prior'
    : 'unpaired';
}

/** Resident facts of one instance GPU buffer (or chunk of it). */
export interface InstanceResidentUpload {
  readonly uploadedRevision?: number;
  /**
   * Collection rows whose resident previous matrix may differ from the current
   * one; `undefined` when unknown. Lanes without previous matrices keep `[]`.
   */
  readonly uploadedMotionRows?: readonly InstanceDirtyRange[];
}

export interface InstanceUploadPlan {
  /** Rows to write, local to the window. */
  readonly ranges: readonly InstanceDirtyRange[];
  /** `uploadedMotionRows` after the write, in collection rows. */
  readonly motionRows: readonly InstanceDirtyRange[] | undefined;
}

function clipRanges(
  ranges: readonly { readonly start: number; readonly end: number }[],
  window: InstanceDirtyRange,
): InstanceDirtyRange[] {
  const clipped: InstanceDirtyRange[] = [];
  for (const range of ranges) {
    const start = Math.max(window.start, range.start);
    const end = Math.min(window.end, range.end);
    if (end > start) clipped.push({ start, end });
  }
  return clipped;
}

/**
 * Rows a resident instance buffer must receive for the current revision. A
 * dirty-row write is valid only on top of revision `r - 1`; it also refreshes
 * rows that moved in `r - 1`, whose previous matrix now equals the current one.
 * Every other resident (new, older, unknown motion rows, remapped identities)
 * receives the whole window.
 */
export function planInstanceUpload(input: {
  readonly activeIsNew: boolean;
  readonly resident: InstanceResidentUpload;
  readonly current: InstanceUploadSubject;
  /** `'no-previous-lane'` for uniform lanes that store current matrices only. */
  readonly pairing: InstancePreviousPairing | 'no-previous-lane';
  /** Collection rows covered by this buffer. */
  readonly window: InstanceDirtyRange;
}): InstanceUploadPlan {
  const { activeIsNew, resident, current, pairing, window } = input;
  const previousLane = pairing !== 'no-previous-lane';
  const dirty = current.dirtyRanges;
  const motionRows =
    !previousLane || pairing === 'none'
      ? []
      : pairing === 'prior' && dirty !== undefined
        ? clipRanges(dirty, window)
        : undefined;
  // A stopped collection keeps its revision while its accepted previous lane
  // advances. Retire exactly the resident motion rows on that settling frame.
  if (
    !activeIsNew &&
    current.revision !== undefined &&
    resident.uploadedRevision === current.revision &&
    pairing === 'none' &&
    resident.uploadedMotionRows !== undefined
  ) {
    return {
      ranges: clipRanges(resident.uploadedMotionRows, window).map(({ start, end }) => ({
        start: start - window.start,
        end: end - window.start,
      })),
      motionRows,
    };
  }
  const incremental =
    !activeIsNew &&
    dirty !== undefined &&
    current.revision !== undefined &&
    resident.uploadedRevision === current.revision - 1 &&
    pairing !== 'unpaired' &&
    (!previousLane || resident.uploadedMotionRows !== undefined);
  if (!incremental) return { ranges: [{ start: 0, end: window.end - window.start }], motionRows };
  const rows = clipRanges(
    [...dirty, ...(previousLane ? (resident.uploadedMotionRows ?? []) : [])],
    window,
  ).sort((a, b) => a.start - b.start);
  const ranges: InstanceDirtyRange[] = [];
  for (const row of rows) {
    const last = ranges.at(-1);
    const start = row.start - window.start;
    const end = row.end - window.start;
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return { ranges, motionRows };
}

interface Projection extends InstanceCollectionSnapshot {
  readonly world: object;
  readonly entity: number;
  /** Source epoch this revision reflects; row evidence is requested after it. */
  readonly sourceEpoch: number | undefined;
}
/**
 * Second buffer of a collection. It equals the accepted front buffer except
 * for `diff` rows, so the next dirty-row projection refreshes only those rows
 * before writing its own.
 */
interface BackBuffer {
  transforms: Float32Array;
  diff: readonly InstanceDirtyRange[] | 'whole';
  candidate: Projection | undefined;
}
interface Residency
  extends Omit<InstanceCollectionInspection, keyof InstanceCollectionInfo | 'owner'> {
  readonly frameNumber: number;
}

/** Rebuildable renderer projection. All authoring and entity lifetime belong to World. */
export class InstanceProjectionStore {
  private nextId = 1;
  private nextGeneration = 1;
  private identities = new WeakMap<object, Map<number, InstanceCollectionId>>();
  private readonly records = new Map<InstanceCollectionId, Projection>();
  private readonly candidates = new Map<InstanceCollectionId, Projection>();
  private readonly backs = new Map<InstanceCollectionId, BackBuffer>();
  /** Buffers this store allocated; only these may be recycled as back storage. */
  private readonly owned = new WeakSet<Float32Array>();
  private readonly residency = new Map<InstanceCollectionId, Residency>();
  private work = { rows: 0, fullProjections: 0, rowProjections: 0 };

  /**
   * Project one authored column into a detached revision. With `rows`, a
   * collection whose source proves its changed element ranges costs O(changed
   * rows): only those rows are validated, compared and copied, and the result
   * carries `dirtyRanges`. Otherwise the whole column is validated and copied.
   */
  project(
    world: object,
    entity: number,
    transforms: ArrayLike<number>,
    rows?: InstanceRowSource,
  ): InstanceCollectionSnapshot | InstanceProjectionError {
    const collectionId =
      this.identities.get(world)?.get(entity) ?? (this.nextId++ as InstanceCollectionId);
    const previous = this.records.get(collectionId);
    if (
      rows !== undefined &&
      previous?.sourceEpoch !== undefined &&
      previous.transforms.length === transforms.length
    ) {
      const change = rows.changedSince(previous.sourceEpoch);
      if (change !== 'whole') return this.projectRows(previous, transforms, change, rows.epoch);
    }
    this.work.fullProjections += 1;
    this.work.rows += transforms.length / MATRIX_STRIDE;
    const invalid = validateInstanceTransforms(transforms);
    if (invalid !== undefined) return invalid;
    if (
      previous !== undefined &&
      previous.transforms.length === transforms.length &&
      previous.transforms.every((value, index) => Object.is(value, transforms[index]))
    ) {
      if (rows === undefined || previous.sourceEpoch === rows.epoch) return previous;
      // Same values, newly proven source epoch: re-publish the revision so the
      // next projection can take the dirty-row path.
      const reseeded: Projection = { ...previous, sourceEpoch: rows.epoch };
      this.candidates.set(collectionId, reseeded);
      return reseeded;
    }
    const count = transforms.length / MATRIX_STRIDE;
    // Ordinals are identities within the authored array. Pose edits retain them;
    // resizing seeds topology anew so new instances cannot inherit old motion.
    const generations =
      previous?.count === count
        ? previous.generations
        : Uint32Array.from({ length: count }, () => this.nextGeneration++);
    // A same-size whole rewrite reuses the collection's back buffer: `accept`
    // swaps it with the old front, so a collection rewritten every frame
    // ping-pongs two buffers instead of allocating a fresh column per frame
    // (render-worker GC pressure on animated instance collections).
    let back = previous?.count === count ? this.backs.get(collectionId) : undefined;
    let target: Float32Array;
    if (back !== undefined && back.transforms.length === transforms.length) {
      back.transforms.set(transforms);
      target = back.transforms;
    } else {
      target = this.own(new Float32Array(transforms));
      if (previous?.count === count && this.owned.has(previous.transforms)) {
        back = { transforms: target, diff: 'whole', candidate: undefined };
        this.backs.set(collectionId, back);
      } else {
        back = undefined;
      }
    }
    const record: Projection = {
      collectionId,
      world,
      entity,
      transforms: target,
      generations,
      count,
      revision: (previous?.revision ?? 0) + 1,
      sourceEpoch: rows?.epoch,
    };
    if (back !== undefined) {
      back.diff = 'whole';
      back.candidate = record;
    }
    this.candidates.set(collectionId, record);
    return record;
  }

  private projectRows(
    previous: Projection,
    source: ArrayLike<number>,
    change: readonly { readonly start: number; readonly end: number }[],
    epoch: number,
  ): InstanceCollectionSnapshot | InstanceProjectionError {
    this.work.rowProjections += 1;
    const written: InstanceDirtyRange[] = [];
    for (const range of change) {
      const start = Math.floor(range.start / MATRIX_STRIDE);
      const end = Math.min(previous.count, Math.ceil(range.end / MATRIX_STRIDE));
      const last = written.at(-1);
      if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
      else if (end > start) written.push({ start, end });
    }
    for (const range of written) {
      this.work.rows += range.end - range.start;
      for (let index = range.start * MATRIX_STRIDE; index < range.end * MATRIX_STRIDE; index++) {
        if (!Number.isFinite(source[index]))
          return new InstanceTransformsError({
            actualLength: source.length,
            nonFiniteIndex: index,
          });
      }
    }
    const front = previous.transforms;
    let back = this.backs.get(previous.collectionId);
    if (back === undefined || back.transforms.length !== front.length) {
      back = { transforms: this.own(new Float32Array(front)), diff: [], candidate: undefined };
      this.backs.set(previous.collectionId, back);
      this.work.rows += previous.count;
    } else if (back.diff === 'whole') {
      back.transforms.set(front);
      this.work.rows += previous.count;
    } else {
      for (const range of back.diff) {
        this.work.rows += range.end - range.start;
        back.transforms.set(
          front.subarray(range.start * MATRIX_STRIDE, range.end * MATRIX_STRIDE),
          range.start * MATRIX_STRIDE,
        );
      }
    }
    const target = back.transforms;
    const dirtyRanges: InstanceDirtyRange[] = [];
    for (const range of written) {
      for (let row = range.start; row < range.end; row += 1) {
        let changed = false;
        for (let lane = row * MATRIX_STRIDE; lane < (row + 1) * MATRIX_STRIDE; lane += 1) {
          const value = source[lane] as number;
          target[lane] = value;
          if (!Object.is(target[lane], front[lane])) changed = true;
        }
        if (!changed) continue;
        const last = dirtyRanges.at(-1);
        if (last !== undefined && last.end === row) last.end = row + 1;
        else dirtyRanges.push({ start: row, end: row + 1 });
      }
    }
    back.diff = written;
    if (dirtyRanges.length === 0) {
      back.candidate = undefined;
      return previous;
    }
    const record: Projection = {
      ...previous,
      transforms: target,
      revision: previous.revision + 1,
      dirtyRanges,
      sourceEpoch: epoch,
    };
    back.candidate = record;
    this.candidates.set(previous.collectionId, record);
    return record;
  }

  /** Called only after the owning RenderScene accepts its prepared changes. */
  accept(
    world: object,
    entity: number,
    snapshot: {
      readonly collectionId?: InstanceCollectionId;
      readonly revision?: number;
      readonly transforms: Float32Array;
      readonly generations?: Uint32Array;
    },
  ): void {
    const { collectionId, revision, transforms, generations } = snapshot;
    if (collectionId === undefined || revision === undefined || generations === undefined) return;
    let entities = this.identities.get(world);
    if (entities === undefined) {
      entities = new Map();
      this.identities.set(world, entities);
    }
    entities.set(entity, collectionId);
    const current = this.records.get(collectionId);
    const candidate = this.candidates.get(collectionId);
    this.candidates.delete(collectionId);
    const matches =
      candidate !== undefined &&
      candidate.transforms === transforms &&
      candidate.revision === revision;
    const back = this.backs.get(collectionId);
    if (current?.transforms !== transforms && back !== undefined) {
      if (back.candidate !== undefined && back.transforms === transforms) {
        // Swap: the old front differs from the accepted buffer exactly on the
        // rows the candidate wrote, which `back.diff` already names. A caller
        // buffer never becomes writable back storage.
        if (
          current === undefined ||
          current.transforms.length !== transforms.length ||
          !this.owned.has(current.transforms)
        ) {
          this.backs.delete(collectionId);
        } else {
          back.transforms = current.transforms;
        }
      } else {
        back.diff = 'whole';
      }
      back.candidate = undefined;
    }
    this.records.set(
      collectionId,
      matches
        ? candidate
        : {
            collectionId,
            revision,
            transforms,
            generations,
            count: transforms.length / MATRIX_STRIDE,
            world,
            entity,
            sourceEpoch: current?.transforms === transforms ? current.sourceEpoch : undefined,
          },
    );
  }

  private own(buffer: Float32Array): Float32Array {
    this.owned.add(buffer);
    return buffer;
  }

  /** Cumulative projection work; tests and benches read deltas. */
  inspectWork(): InstanceProjectionWork {
    return { ...this.work };
  }

  release(world: object, entity: number): void {
    const entities = this.identities.get(world);
    const id = entities?.get(entity);
    if (id === undefined) return;
    entities?.delete(entity);
    this.records.delete(id);
    this.candidates.delete(id);
    this.backs.delete(id);
    this.residency.delete(id);
  }
  retain(ids: ReadonlySet<InstanceCollectionId>): void {
    for (const record of this.records.values()) {
      if (!ids.has(record.collectionId)) this.release(record.world, record.entity);
    }
  }
  dispose(): void {
    this.records.clear();
    this.candidates.clear();
    this.backs.clear();
    this.residency.clear();
    this.identities = new WeakMap();
  }
  _resetResidency(): void {
    this.residency.clear();
  }

  _reportResidency(
    input: Omit<Residency, 'error' | 'lane'> & {
      readonly collectionId: InstanceCollectionId;
      readonly lane: Exclude<InstanceSubmissionLane, 'unresident' | 'unavailable'>;
    },
  ): void {
    if (!this.records.has(input.collectionId)) return;
    const previous = this.residency.get(input.collectionId);
    const sameFrame = previous?.frameNumber === input.frameNumber && previous.error === undefined;
    const ranges = [...(sameFrame ? previous.uploadRanges : []), ...input.uploadRanges]
      .map((range) => ({ ...range }))
      .sort((a, b) => a.start - b.start);
    const uploadRanges: InstanceDirtyRange[] = [];
    for (const range of ranges) {
      const last = uploadRanges.at(-1);
      if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else uploadRanges.push(range);
    }
    this.residency.set(input.collectionId, {
      ...input,
      uploadRanges,
      uploadedBytes: input.uploadedBytes + (sameFrame ? previous.uploadedBytes : 0),
      error: undefined,
    });
  }
  _reportFailure(input: {
    readonly collectionId: InstanceCollectionId;
    readonly code: InstanceCollectionFailureCode;
    readonly expected: string;
    readonly hint: string;
    readonly facts: InstanceCollectionFailureFacts;
  }): void {
    if (!this.records.has(input.collectionId)) return;
    this.residency.set(input.collectionId, {
      frameNumber: -1,
      residentGeneration: undefined,
      lane: 'unavailable',
      uploadRanges: [],
      uploadedBytes: 0,
      requestedBytes: input.facts.requestedBytes,
      supportedBytes: input.facts.supportedBytes,
      backend: input.facts.backend,
      error: {
        code: input.code,
        expected: input.expected,
        hint: input.hint,
        detail: { ...input.facts },
      },
    });
  }
  _inspections(frameNumber: number): readonly InstanceCollectionInspection[] {
    return [...this.records.values()].map((record) => {
      const resident = this.residency.get(record.collectionId);
      const current = resident?.frameNumber === frameNumber;
      return {
        collectionId: record.collectionId,
        count: record.count,
        revision: record.revision,
        residentGeneration: resident?.residentGeneration,
        lane: resident?.lane ?? 'unresident',
        uploadRanges: current ? resident.uploadRanges.map((range) => ({ ...range })) : [],
        uploadedBytes: current ? resident.uploadedBytes : 0,
        requestedBytes: resident?.requestedBytes ?? record.transforms.byteLength,
        supportedBytes: resident?.supportedBytes,
        backend: resident?.backend ?? 'unknown',
        owner: 'renderer.instances',
        error: resident?.error,
      };
    });
  }
}
