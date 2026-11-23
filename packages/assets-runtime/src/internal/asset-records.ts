import {
  describeMeshDraw,
  interleavedMesh,
  type MeshDrawDescription,
} from '@forgeax/engine-geometry';
import {
  ASSET_ERROR_HINTS,
  type Asset,
  AssetError,
  type AssetErrorCode,
  type AssetHandle,
  type AssetReferenceOwner,
  err,
  type MeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import {
  assetDataBytes,
  assetFieldBytes,
  captureAssetDataAllocated,
  copyAssetData,
  takeAssetData,
} from './asset-data';
import type { MeshArtifactFailure, MeshArtifactStorage } from './asset-source';

export interface PreparedAssetContent<T = unknown> {
  readonly value: T;
  readonly dependencies?: readonly number[];
}

/** Explicit private preparation capability; ordinary owner reads stay committed. */
export interface AssetAdoptionReader {
  read<T>(handle: number): Result<T, AssetError>;
  /** Synchronous use only for committed values; never retain their POD across a step. */
  borrow<T>(handle: number): Result<T, AssetError>;
  version(handle: number): Result<number, AssetError>;
  kind(handle: number): Result<string, AssetError>;
  dependencies(handle: number): Result<readonly number[], AssetError>;
  borrowClosure<T>(roots: readonly number[]): Result<ReadonlyMap<number, T>, AssetError>;
  validate(handle: number, target?: string): Result<void, AssetError>;
}

export interface AssetAdoptionStatus {
  readonly phase: 'preparing' | 'committed' | 'retiring' | 'retired' | 'closed';
  readonly assets: number;
  readonly bytes: number;
  readonly consumerReferences: number;
  readonly processedReferences: number;
}

/** A short-lived operation of the existing owner, never a public asset registry. */
export interface AssetAdoption {
  readonly reader: AssetAdoptionReader;
  adopt<K extends string, T, E = never>(
    target: K,
    input: T,
    dependencies?: readonly number[],
    prepare?: (owned: T, reader: AssetAdoptionReader) => Result<PreparedAssetContent, E>,
    replacing?: AssetHandle<K>,
    storage?: 'copy' | 'take',
  ): Result<AssetHandle<K>, AssetError | E>;
  copyStagedMesh(handle: number): Result<void, AssetError>;
  commit(beforeCommit?: () => void): Result<void, AssetError>;
  retire(): void;
  stepRetirement(maxWork: number): Result<AssetAdoptionStatus, AssetError>;
  inspect(): AssetAdoptionStatus;
}

interface AdoptionState {
  readonly synchronous: boolean;
  readonly maximumInputRevision: number;
  readonly values: Map<number, RecordEntry>;
  readonly newIdentities: Set<number>;
  readonly expected: Map<number, number>;
  readonly guardRoots: number[];
  readonly edgeRoots: number[];
  readonly consumers: Map<number, number>;
  readonly check: (() => Result<void, AssetError>) | undefined;
  phase: AssetAdoptionStatus['phase'];
  bytes: number;
  consumerReferences: number;
  processedReferences: number;
  cleanup: readonly AssetRetirement[] | undefined;
}

/** Default content byte budget of one AssetRegistry: a runaway-growth guard, not a scene cap. */
export const DEFAULT_ASSET_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;

/** Shared admission check for public content byte budgets, before any registry is created. */
export function validateAssetBudgetBytes(bytes: unknown): asserts bytes is number {
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0)
    throw new RangeError('assetBudgetBytes must be a positive safe integer');
}

export interface AssetLimits {
  readonly maxAssets?: number;
  readonly maxBytes?: number;
  readonly maxSnapshots?: number;
  readonly maxRanges?: number;
  readonly maxObservers?: number;
  readonly maxDependencies?: number;
}

export interface AssetRange {
  readonly path: readonly string[];
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly rowBytes?: number;
  readonly byteStride?: number;
}

/** A prepared byte write may copy packed rows into an interleaved destination. */
export interface AssetByteWrite {
  readonly path: readonly string[];
  readonly byteOffset: number;
  readonly bytes: Uint8Array;
  readonly rowBytes?: number;
  readonly byteStride?: number;
}

export interface PreparedAssetRanges {
  readonly writes: readonly AssetByteWrite[];
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly remove?: readonly string[];
  /** Existing nested leaves; preparation never copies their enclosing arrays. */
  readonly fieldWrites?: readonly { readonly path: readonly string[]; readonly value: unknown }[];
}

export interface AssetRangeUpdate {
  readonly handle: number;
  readonly ranges: PreparedAssetRanges;
}

interface ClosureRanges<Input> {
  readonly edits: () => readonly { readonly handle: number; readonly input: Input }[] | undefined;
  readonly prepare: (current: unknown, input: Input) => Result<PreparedAssetRanges, AssetError>;
}

export interface AssetChange {
  readonly handle: AssetHandle;
  readonly revision: number;
  readonly removed: boolean;
  readonly fields: readonly string[];
  readonly ranges: readonly AssetRange[];
}

export interface AssetChangeBatch {
  readonly changes: readonly AssetChange[];
  accept(): void;
}

export interface AssetObserver {
  read(): Result<AssetChangeBatch, AssetError>;
  dispose(): void;
}

export interface AssetRevisionGuard {
  version(handle: number): Result<number, AssetError>;
  matchesCurrent(): boolean;
  dispose(): void;
}

export interface AssetSnapshot extends AssetRevisionGuard {
  read<T>(handle: number): Result<T, AssetError>;
}

/** One owner-held cleanup cursor. Each step bounds reference decrements, including dependency edges. */
export interface AssetRetirement {
  step(maxReferences: number): Result<AssetRetirementStatus, AssetError>;
  inspect(): AssetRetirementStatus;
}

export interface AssetRetirementStatus {
  readonly done: boolean;
  readonly pendingReferences: number;
  readonly processedReferences: number;
  readonly retiredAssets: number;
  readonly retiredBytes: number;
}

/** Engine-only fixed closure plus real holds; borrowed values must not be edited or outlive retirement. */
export interface AssetContentLease extends Omit<AssetRevisionGuard, 'dispose'> {
  readonly handles: readonly number[];
  read<T>(handle: number): Result<T, AssetError>;
  retire(): Result<AssetRetirement, AssetError>;
}

/** One independent acquisition of a sealed fixed closure. */
export interface AssetContentCapture {
  step(maxAssets: number): Result<AssetContentLease | undefined, AssetError>;
  inspect(): AssetContentCaptureStatus;
  retire(): Result<AssetRetirement, AssetError>;
}

export interface AssetContentCaptureStatus {
  readonly phase: 'capturing' | 'complete' | 'cancelled';
  readonly copiedAssets: number;
  /** Cumulative copied work, not a live-memory measurement after cancellation. */
  readonly copiedBytes: number;
  readonly reservedBytes: number;
}

interface FixedSnapshotData {
  readonly snapshot: CapturedSnapshot;
  readonly value: unknown;
  borrow<T>(handle: number): Result<T, AssetError>;
}

interface SharedContentSnapshot {
  readonly root: number;
  readonly data: FixedSnapshotData;
  holders: number;
}

interface ContentCaptureState {
  readonly handle: number;
  readonly handles: readonly number[];
  readonly expected: Map<number, { readonly revision: number; readonly bytes: number }>;
  readonly guard: CapturedRevisionGuard;
  readonly values: Map<number, { readonly value: unknown; readonly revision: number }>;
  readonly bytes: number;
  copiedAssets: number;
  copiedBytes: number;
  status:
    | { readonly kind: 'capturing' }
    | { readonly kind: 'complete'; readonly lease: AssetContentLease }
    | {
        readonly kind: 'cancelled';
        readonly retirement: AssetRetirement;
        readonly cause?: AssetError;
      };
}

/** Engine-only fixed content lease. No borrowed storage is exposed by public snapshots. */
export interface AssetVersionDelta {
  readonly from: number;
  readonly fields: readonly string[];
  readonly ranges: readonly AssetRange[];
}

export interface AssetVersion<T> {
  readonly handle: number;
  readonly revision: number;
  readonly value: T;
  /** Exact predecessor evidence retained with this fixed version; absent means full replacement. */
  readonly delta?: AssetVersionDelta;
  /** Whether the complete captured dependency closure still matches the live records. */
  matchesCurrent(): boolean;
  retain(): AssetVersion<T>;
  dispose(): void;
}

interface CapturedSnapshot extends AssetSnapshot {
  matchesCurrent(preserveChangeEvidence?: boolean): boolean;
}

interface CapturedRevisionGuard extends AssetRevisionGuard {
  matchesCurrent(preserveChangeEvidence?: boolean): boolean;
}

interface PinnedVersion {
  readonly snapshot: CapturedSnapshot;
  readonly value: unknown;
  readonly revision: number;
  readonly delta?: AssetVersionDelta;
  holds: number;
}

/** Exact source for one accepted revision and its physical Render lease. */
export interface MeshPresentation {
  readonly handoff?: 'transfer' | 'copy';
  readonly bytes: number;
  readonly storage: MeshArtifactStorage;
  read(): Promise<MeshAsset>;
  lease: MeshPresentationLease;
  release(): void;
}

export interface MeshPresentationLease {
  isCurrent(): boolean;
  release(): void;
}

type MeshPresentationRejection = 'render-budget-exceeded' | 'render-preparation-failed';
export type MeshCpuRequirement = 'cpu-required' | 'multiple-render-receivers' | 'render-recovery';
export type MeshCpuFallback =
  | MeshArtifactFailure
  | MeshPresentationRejection
  | 'no-render-receiver'
  | 'render-not-ready'
  | 'multiple-render-receivers'
  | 'unsupported-mesh';
export type MeshCpuRetentionReason = 'not-requested' | MeshCpuRequirement | MeshCpuFallback;

/** A Render reservation can be refused without capturing a private Mesh. */
export interface MeshPresentationInput {
  readonly bytes: number;
  capture(): MeshAsset;
  sent?(): void;
}

type MeshCpuRetention =
  | { readonly kind: 'required'; readonly reason: MeshCpuRequirement }
  | { readonly kind: 'fallback'; readonly reason: MeshCpuFallback; readonly revision: number };

export type MeshPresenter = (
  handle: AssetHandle<'mesh'>,
  revision: number,
  input: MeshPresentationInput,
  signal?: AbortSignal,
) => Promise<Result<MeshPresentationLease, MeshPresentationRejection>>;

interface RecordEntry {
  readonly target: string;
  meshPresentation?: MeshPresentation;
  meshCpuRetention: MeshCpuRetention | undefined;
  meshDraw?: { readonly revision: number; readonly value: MeshDrawDescription };
  value: unknown;
  readonly fieldBytes: Map<string, number>;
  readonly patchedField?: string;
  dependencies: readonly number[];
  revision: number;
  holders: number;
  bytes: number;
}

interface ChangeNode {
  readonly handle: number;
  revision: number;
  removed: boolean;
  readonly fields: Map<string, number>;
  readonly ranges: (AssetRange & { readonly revision: number })[];
  previous: ChangeNode | undefined;
  next: ChangeNode | undefined;
}

interface Cursor {
  revision: number;
  index: number;
}

const identityKey = Symbol.for('forgeax.assets.identities');
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
if (realm[identityKey] === undefined)
  realm[identityKey] = {
    reference: 0,
    owner: 0,
    // This namespace distinguishes transport realms, never authorizes access.
    // Mini Game hosts need no browser Crypto implementation to own assets.
    realm:
      globalThis.crypto?.randomUUID?.() ??
      Array.from({ length: 4 }, () =>
        Math.floor(Math.random() * 0x1_0000_0000)
          .toString(16)
          .padStart(8, '0'),
      ).join(''),
  };
const identities = realm[identityKey] as {
  reference: number;
  owner: number;
  realm: string;
};
const EMPTY_BATCH: AssetChangeBatch = Object.freeze({ changes: Object.freeze([]), accept() {} });
const EMPTY_READ = ok(EMPTY_BATCH);

interface NestedFieldWrite {
  readonly target: Record<string, unknown>;
  readonly field: string;
  readonly value: unknown;
  readonly top: string;
  readonly delta: number;
}

interface ByteRangeOperation {
  readonly target: Uint8Array;
  readonly write: AssetByteWrite;
  readonly rowBytes: number;
  readonly byteStride: number;
  readonly span: number;
}

/** One validated asset's owned copies, adopted together once every update passes. */
interface PreparedRangeUpdate {
  readonly handle: number;
  readonly record: RecordEntry;
  readonly value: Record<string, unknown>;
  readonly replaced: readonly string[];
  readonly fields: Readonly<Record<string, unknown>>;
  readonly sizes: ReadonlyMap<string, number>;
  readonly nested: readonly NestedFieldWrite[];
  readonly operations: readonly ByteRangeOperation[];
  readonly contentDelta: number;
  readonly candidateBytes: number;
}

function isPathPrefix(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((part, i) => part === b[i]);
}

function overlapsOtherPath(
  path: readonly string[],
  index: number,
  paths: readonly (readonly string[])[],
): boolean {
  return paths.some(
    (other, otherIndex) =>
      otherIndex !== index && (isPathPrefix(other, path) || isPathPrefix(path, other)),
  );
}

/** The owned value at `path`, or undefined when a step leaves owned object/array fields. */
function ownedPathValue(root: unknown, path: readonly string[]): unknown {
  let target: unknown = root;
  for (const field of path) {
    if (
      target === null ||
      typeof target !== 'object' ||
      ArrayBuffer.isView(target) ||
      target instanceof ArrayBuffer ||
      !Object.hasOwn(target, field)
    )
      return undefined;
    target = (target as Record<string, unknown>)[field];
  }
  return target;
}

function replaceableNestedParent(
  value: Record<string, unknown>,
  path: readonly string[],
  field: string,
): Result<Record<string, unknown>, AssetError> {
  const target = ownedPathValue(value, path.slice(0, -1));
  if (!isObjectFields(target) && !Array.isArray(target))
    return err(failure('asset-invalid-value', 'an existing owned field parent'));
  if (!Object.hasOwn(target, field))
    return err(failure('asset-invalid-value', 'an existing owned nested field'));
  const descriptor = Object.getOwnPropertyDescriptor(target, field);
  if (descriptor?.writable !== true || descriptor.configurable !== true)
    return err(failure('asset-invalid-value', 'a replaceable owned nested field'));
  return ok(target as Record<string, unknown>);
}

/** Row size, destination stride and span of a byte write, when all are bounded integers. */
function byteRangeLayout(
  write: AssetByteWrite,
): { readonly rowBytes: number; readonly byteStride: number; readonly span: number } | undefined {
  const { byteOffset, bytes } = write;
  const rowBytes = write.rowBytes ?? bytes.byteLength;
  const byteStride = write.byteStride ?? rowBytes;
  const count = bytes.byteLength / rowBytes;
  const span = (count - 1) * byteStride + rowBytes;
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    !Number.isSafeInteger(rowBytes) ||
    rowBytes <= 0 ||
    !Number.isSafeInteger(byteStride) ||
    byteStride < rowBytes ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(span)
  )
    return undefined;
  return { rowBytes, byteStride, span };
}

function ownedBinaryView(
  target: unknown,
  byteOffset: number,
  span: number,
): Uint8Array | undefined {
  if (target instanceof ArrayBuffer)
    return byteOffset + span > target.byteLength
      ? undefined
      : new Uint8Array(target, byteOffset, span);
  if (!ArrayBuffer.isView(target) || !(target.buffer instanceof ArrayBuffer)) return undefined;
  if (byteOffset + span > target.byteLength) return undefined;
  return new Uint8Array(target.buffer, target.byteOffset + byteOffset, span);
}

function prepareByteWrites(
  value: Record<string, unknown>,
  writes: readonly AssetByteWrite[],
  replaced: readonly string[],
  paths: readonly (readonly string[])[],
): Result<ByteRangeOperation[], AssetError> {
  const operations: ByteRangeOperation[] = [];
  for (const write of writes) {
    if (write.bytes.byteLength === 0) continue;
    const { path, byteOffset } = write;
    const layout = byteRangeLayout(write);
    if (
      path.length === 0 ||
      replaced.includes(path[0] ?? '') ||
      paths.some((field) => isPathPrefix(field, path) || isPathPrefix(path, field)) ||
      layout === undefined
    )
      return err(failure('asset-invalid-value', 'a bounded contiguous or strided byte range'));
    const target = ownedBinaryView(ownedPathValue(value, path), byteOffset, layout.span);
    if (target === undefined)
      return err(failure('asset-invalid-value', 'an in-bounds owned binary range'));
    operations.push({ target, write, ...layout });
  }
  return ok(operations);
}

function copyRangeBytes({ target, write, rowBytes, byteStride }: ByteRangeOperation): void {
  if (rowBytes === byteStride) {
    target.set(write.bytes);
    return;
  }
  for (
    let source = 0, destination = 0;
    source < write.bytes.byteLength;
    source += rowBytes, destination += byteStride
  )
    target.set(write.bytes.subarray(source, source + rowBytes), destination);
}

function defineOwnedField(target: Record<string, unknown>, field: string, value: unknown): void {
  Object.defineProperty(target, field, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function applyOwnedFields(
  current: Record<string, unknown>,
  patch: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  sizes: ReadonlyMap<string, number>,
  fieldBytes: Map<string, number>,
  objectField: string | undefined,
  contentDelta: number,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) {
      delete current[field];
      if (objectField === undefined) fieldBytes.delete(field);
      continue;
    }
    defineOwnedField(current, field, patch[field]);
    if (objectField === undefined) fieldBytes.set(field, sizes.get(field) ?? 0);
  }
  if (objectField !== undefined)
    fieldBytes.set(objectField, (fieldBytes.get(objectField) ?? 0) + contentDelta);
}

function isObjectFields(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer)
  );
}

function objectFields(value: unknown): Record<string, unknown> {
  return isObjectFields(value) ? value : {};
}

function freezeFixedData<T>(value: T): T {
  if (
    value === null ||
    typeof value !== 'object' ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  )
    return value;
  for (const child of Object.values(value)) freezeFixedData(child);
  return Object.freeze(value);
}

function failure(code: AssetErrorCode, expected: string): AssetError {
  return new AssetError({ code, expected, hint: ASSET_ERROR_HINTS[code] });
}

function meshCpuUnavailable(handle: number, revision: number): AssetError {
  return new AssetError({
    code: 'asset-cpu-data-unavailable',
    expected: 'CPU geometry for this Mesh revision',
    hint: ASSET_ERROR_HINTS['asset-cpu-data-unavailable'],
    detail: { handle, revision },
  });
}

/** The private record storage of one AssetRegistry, not another public asset service. */
export class AssetRecords implements AssetReferenceOwner {
  readonly identity = `assets-${identities.realm}-${++identities.owner}`;
  private readonly records = new Map<number, RecordEntry>();
  private readonly meshPresenters = new Map<
    MeshPresenter,
    { readonly confirmsTransfer?: boolean; readonly isReady?: () => boolean }
  >();

  get canTransferMesh(): boolean {
    const presenter = this.meshPresenter;
    return presenter !== undefined && this.meshPresenters.get(presenter)?.confirmsTransfer === true;
  }

  get meshPresenter(): MeshPresenter | undefined {
    return this.meshPresenters.size === 1 ? this.meshPresenters.keys().next().value : undefined;
  }

  get meshPresenterReady(): boolean {
    const presenter = this.meshPresenter;
    return presenter !== undefined && this.meshPresenters.get(presenter)?.isReady?.() !== false;
  }

  meshReceiverFallback(): MeshCpuFallback {
    if (this.meshPresenters.size > 1) return 'multiple-render-receivers';
    if (this.meshPresenters.size === 0) return 'no-render-receiver';
    return 'render-preparation-failed';
  }

  bindMeshPresenter(
    presenter: MeshPresenter,
    options: { readonly confirmsTransfer?: boolean; readonly isReady?: () => boolean } = {},
  ): () => void {
    this.meshPresenters.set(presenter, options);
    return () => {
      this.meshPresenters.delete(presenter);
    };
  }

  /** The startup renderer exists but cannot prepare until its device is ready. */
  deferredMeshPresentations(): readonly number[] {
    const deferred: number[] = [];
    for (const [handle, record] of this.records) {
      const retention = record.meshCpuRetention;
      if (
        retention?.kind === 'fallback' &&
        retention.reason === 'render-not-ready' &&
        retention.revision === record.revision
      )
        deferred.push(handle);
    }
    return deferred;
  }

  meshPresentationsForReceiver(): readonly number[] {
    const handles: number[] = [];
    const multipleReceivers = this.meshPresenters.size > 1;
    for (const [handle, record] of this.records)
      if (
        record.meshPresentation &&
        (multipleReceivers || !record.meshPresentation.lease.isCurrent())
      )
        handles.push(handle);
    return handles;
  }

  private readonly changes = new Map<number, ChangeNode>();
  private readonly cursors: Cursor[] = [];
  private readonly pinned = new Map<number, PinnedVersion>();
  private readonly versions = new Map<string, PinnedVersion>();
  /** Holds in custody cannot be consumed by an unrelated ordinary release. */
  private readonly custodyHolds = new Map<number, number>();
  private readonly pendingCaptures = new Set<ContentCaptureState>();
  /** The current sealed copy per root. Replaced versions stay with their existing leases. */
  private readonly contentSnapshots = new Map<number, SharedContentSnapshot>();
  private readonly pendingAdoptions = new Set<AdoptionState>();
  private participatingAdoption: AdoptionState | undefined;
  private adoptionBytes = 0;
  private adoptionIdentities = 0;
  private captureReservedBytes = 0;
  private readonly limits: Required<AssetLimits>;
  private first: ChangeNode | undefined;
  private last: ChangeNode | undefined;
  private revision = 0;
  private bytes = 0;
  private snapshotBytes = 0;
  private snapshots = 0;
  private observers = 0;
  private retiredPending = 0;
  private closed = false;
  private staged: Set<number> | undefined;
  private preparingAdoption = false;
  private acceptingAdoption = false;
  private replacements: Map<number, RecordEntry> | undefined;
  private candidateBytes = 0;
  private scope: object | undefined;

  constructor(
    limits: AssetLimits = {},
    private readonly copySnapshotContent: typeof copyAssetData = copyAssetData,
  ) {
    this.limits = {
      maxAssets: 65_536,
      maxBytes: DEFAULT_ASSET_BUDGET_BYTES,
      maxSnapshots: 128,
      maxRanges: 64,
      maxObservers: 32,
      maxDependencies: 1024,
      ...limits,
    };
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError('asset limits must be positive safe integers');
  }

  /** Extension preparation may inspect candidate data but cannot publish runtime work. */
  mutationError(): AssetError | undefined {
    return this.preparingAdoption || this.acceptingAdoption
      ? failure('asset-write-conflict', 'runtime mutation outside atomic asset preparation')
      : undefined;
  }

  /** Acceptance may establish consumers of the already validated candidate. */
  private referenceMutationError(): AssetError | undefined {
    return this.preparingAdoption ? this.mutationError() : undefined;
  }

  private admissionError(newIdentity: boolean): AssetError | undefined {
    if (this.closed) return failure('asset-owner-closed', this.identity);
    if (this.revision >= Number.MAX_SAFE_INTEGER - this.limits.maxAssets)
      return failure('asset-budget-exceeded', 'available content revisions');
    if (
      newIdentity &&
      (this.records.size + this.retiredPending + this.adoptionIdentities >= this.limits.maxAssets ||
        identities.reference >= 0xffff_ffff)
    )
      return failure('asset-budget-exceeded', 'available asset identity capacity');
    return undefined;
  }

  attach(scope: object): Result<void, AssetError> {
    if (this.closed) return err(failure('asset-owner-closed', this.identity));
    if (this.scope === scope) return ok(undefined);
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    if (this.scope !== undefined)
      return err(failure('asset-reference-invalid', 'an asset owner isolated to one World'));
    this.scope = scope;
    return ok(undefined);
  }

  create<Target extends string, T, E = never>(
    target: Target,
    input: T,
    dependencies: readonly number[] = [],
    prepare?: (owned: T) => Result<PreparedAssetContent, E>,
  ): Result<AssetHandle<Target>, AssetError | E> {
    return this.adopt(target, input, dependencies, prepare);
  }

  /**
   * Complete replacements join the active adoption or own a single synchronous adoption.
   * `storage: 'take'` admits input whose binary storage the caller gives up: it
   * is validated and prepared like a copy, without duplicating whole buffers.
   */
  adopt<Target extends string, T, E = never>(
    target: Target,
    input: T,
    dependencies: readonly number[] = [],
    prepare?: (owned: T) => Result<PreparedAssetContent, E>,
    replacing?: AssetHandle<Target>,
    storage: 'copy' | 'take' = 'copy',
  ): Result<AssetHandle<Target>, AssetError | E> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    if (replacing !== undefined && this.staged === undefined)
      return this.adoptClosure(() =>
        this.adopt(target, input, dependencies, prepare, replacing, storage),
      );
    const admission = this.admissionError(replacing === undefined);
    if (admission !== undefined) return err(admission);
    const previous = replacing === undefined ? undefined : this.records.get(replacing);
    if (replacing !== undefined) {
      if (previous === undefined || previous.target !== target)
        return err(failure('asset-reference-invalid', 'a live source identity of the same kind'));
      if (this.replacements === undefined || this.replacements.has(replacing))
        return err(failure('asset-write-conflict', 'one replacement per atomic source adoption'));
    }
    if (dependencies.length > this.limits.maxDependencies)
      return err(failure('asset-budget-exceeded', 'available dependency capacity'));
    const measured = this.measureInput(input);
    if (!measured.ok) return measured;
    if (!this.fits(measured.value))
      return err(failure('asset-budget-exceeded', 'available content bytes'));
    const captured = this.capture(input, storage);
    if (!captured.ok) return captured;
    let prepared: Result<PreparedAssetContent, E>;
    this.preparingAdoption = this.staged !== undefined;
    try {
      prepared = prepare?.(captured.value) ?? ok({ value: captured.value });
    } finally {
      this.preparingAdoption = false;
    }
    if (!prepared.ok) return prepared;
    // Ordinary create preparation may accept a nested write. Its consumed
    // capacity must be observed before this outer candidate can commit.
    const remaining = this.admissionError(replacing === undefined);
    if (remaining !== undefined) return err(remaining);
    const linked = prepared.value.dependencies ?? dependencies;
    if (linked.length > this.limits.maxDependencies)
      return err(failure('asset-budget-exceeded', 'available dependency capacity'));
    const held = Object.freeze([...new Set(linked)]);
    const value = prepared.value.value;
    const fieldBytes = new Map<string, number>();
    const bytes = assetDataBytes(value, fieldBytes) + held.length * 8;
    if (!this.fits(bytes))
      return err(failure('asset-budget-exceeded', 'available prepared content bytes'));
    for (const handle of held) {
      const found = this.entry(handle);
      if (!found.ok) return found;
    }
    const handle = replacing ?? (++identities.reference as AssetHandle<Target>);
    for (const dependency of held) this.retain(dependency).unwrap();
    const record: RecordEntry = {
      target,
      meshCpuRetention: undefined,
      value,
      fieldBytes,
      dependencies: held,
      revision: previous?.revision ?? ++this.revision,
      holders: 1,
      bytes,
    };
    if (replacing !== undefined) {
      this.replacements?.set(handle, record);
      this.candidateBytes += bytes;
      return ok(handle);
    }
    this.records.set(handle, record);
    this.bytes += bytes;
    if (this.staged !== undefined) this.staged.add(handle);
    else this.changed(handle, [...fieldBytes.keys()]);
    return ok(handle);
  }

  /** Adopt a prepared source closure synchronously, publishing only a successful whole. */
  adoptClosure<T, E, Input = never>(
    adopt: () => Result<T, E>,
    ranges?: ClosureRanges<Input>,
  ): Result<T, AssetError | E> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    if (this.staged !== undefined)
      return err(failure('asset-write-conflict', 'one atomic asset adoption at a time'));
    const staged = new Set<number>();
    const revision = this.revision;
    this.staged = staged;
    const replacements = new Map<number, RecordEntry>();
    this.replacements = replacements;
    let committed = false;
    try {
      const result = adopt();
      if (!result.ok) return result;
      for (const [handle, record] of replacements) {
        const valid = this.validateDependencies(handle, record.dependencies);
        if (!valid.ok) return valid;
      }
      // Range inputs target existing content and participate only at the commit
      // boundary after the complete candidate has passed validation.
      const rangeCommits =
        ranges === undefined ? undefined : this.prepareClosureRanges(ranges, staged, replacements);
      if (rangeCommits?.ok === false) return rangeCommits;
      const retired: RecordEntry[] = [];
      if (replacements.size > 0 || rangeCommits?.value.updates.length) this.revision++;
      for (const [handle, record] of replacements) {
        const previous = this.records.get(handle) as RecordEntry;
        record.holders = previous.holders;
        record.meshCpuRetention =
          previous.meshCpuRetention?.kind === 'required' ? previous.meshCpuRetention : undefined;
        record.revision = this.revision;
        this.records.set(handle, record);
        this.bytes += record.bytes - previous.bytes;
        retired.push(previous);
        this.changed(
          handle,
          record.patchedField === undefined
            ? [...new Set([...previous.fieldBytes.keys(), ...record.fieldBytes.keys()])]
            : [record.patchedField],
        );
      }
      for (const handle of staged) {
        const record = this.records.get(handle);
        if (record !== undefined) {
          record.revision = this.revision;
          this.changed(handle, Object.keys(objectFields(record.value)));
        }
      }
      if (rangeCommits !== undefined) {
        this.bytes += rangeCommits.value.totalDelta;
        for (const update of rangeCommits.value.updates) this.commitRangeUpdate(update);
      }
      this.replacements = undefined;
      this.candidateBytes = 0;
      for (const previous of retired) {
        previous.meshPresentation?.release();
        for (const dependency of previous.dependencies) this.release(dependency).unwrap();
      }
      committed = true;
      return result;
    } finally {
      if (!committed) {
        this.replacements = undefined;
        this.candidateBytes = 0;
        for (const record of replacements.values())
          for (const dependency of record.dependencies) this.release(dependency).unwrap();
        for (const handle of [...staged].reverse()) this.release(handle).unwrap();
        this.revision = revision; // No content or evidence escaped the private candidate.
      }
      this.staged = undefined;
      this.replacements = undefined;
    }
  }

  private prepareClosureRanges<Input>(
    ranges: ClosureRanges<Input>,
    staged: ReadonlySet<number>,
    replacements: ReadonlyMap<number, RecordEntry>,
  ) {
    this.preparingAdoption = true;
    try {
      const edits = ranges.edits();
      if (!edits?.length) return ok({ updates: [], totalDelta: 0 });
      const admission = this.admissionError(false);
      if (admission !== undefined) return err(admission);
      const measured = this.measureInput(edits);
      if (!measured.ok) return measured;
      if (!this.fits(measured.value))
        return err(failure('asset-budget-exceeded', 'range capture bytes'));
      const captured = this.capture(edits);
      if (!captured.ok) return captured;
      const updates: AssetRangeUpdate[] = [];
      for (const { handle, input } of captured.value) {
        if (staged.has(handle) || replacements.has(handle))
          return err(failure('asset-write-conflict', 'one content edit per asset adoption'));
        const found = this.cpuEntry(handle);
        if (!found.ok) return found;
        const ready = ranges.prepare(found.value.value, input);
        if (!ready.ok) return ready;
        updates.push({ handle, ranges: ready.value });
      }
      // Independent mesh edits keep their own range limit and share the owner's byte budget.
      return this.prepareRangeCommits(updates, measured.value, 'asset');
    } finally {
      this.preparingAdoption = false;
    }
  }

  /** Reserve one private ingestion operation, without opening a global staged view. */
  beginAdoption(
    check?: () => Result<void, AssetError>,
    maximumInputRevision = this.revision,
  ): Result<AssetAdoption, AssetError> {
    return this.openAdoption(maximumInputRevision, false, check);
  }

  /** Editor acceptance uses the same private writes, with synchronous cleanup. */
  adoptPreparedClosure<T, E>(
    prepare: (adoption: AssetAdoption) => Result<T, E>,
    beforeCommit?: () => void,
  ): Result<T, AssetError | E> {
    const opened = this.openAdoption(this.revision, true);
    if (!opened.ok) return opened;
    const adoption = opened.value;
    try {
      const candidate = prepare(adoption);
      if (!candidate.ok) return candidate;
      const committed = adoption.commit(beforeCommit);
      return committed.ok ? candidate : committed;
    } finally {
      adoption.stepRetirement(Number.MAX_SAFE_INTEGER).unwrap();
    }
  }

  private openAdoption(
    maximumInputRevision: number,
    synchronous: boolean,
    check?: () => Result<void, AssetError>,
  ): Result<AssetAdoption, AssetError> {
    const conflict = this.custodyConflict();
    if (conflict !== undefined) return err(conflict);
    if (this.closed) return err(failure('asset-owner-closed', this.identity));
    if (
      !Number.isSafeInteger(maximumInputRevision) ||
      maximumInputRevision < 0 ||
      maximumInputRevision > this.revision
    )
      return err(
        failure('asset-invalid-value', 'bounded ingestion inputs and an initial revision'),
      );
    if (!synchronous)
      for (const pending of this.pendingAdoptions)
        if (pending.phase === 'preparing')
          return err(failure('asset-write-conflict', 'one active ingestion candidate per owner'));
    const state: AdoptionState = {
      synchronous,
      maximumInputRevision,
      values: new Map(),
      newIdentities: new Set(),
      expected: new Map(),
      guardRoots: [],
      edgeRoots: [],
      consumers: new Map(),
      check,
      phase: 'preparing',
      bytes: 0,
      consumerReferences: 0,
      processedReferences: 0,
      cleanup: undefined,
    };
    this.pendingAdoptions.add(state);
    const reader = this.adoptionReader(state);
    return ok({
      reader,
      adopt: (target, input, dependencies = [], prepare, replacing, storage = 'copy') =>
        this.prepareAdoption(
          state,
          reader,
          target,
          input,
          dependencies,
          prepare,
          replacing,
          storage,
        ),
      copyStagedMesh: (handle) => {
        const checked = this.checkAdoption(state);
        if (!checked.ok) return checked;
        const record = state.values.get(handle);
        if (record?.target !== 'mesh' || !state.newIdentities.has(handle))
          return err(failure('asset-reference-invalid', 'a staged new Mesh'));
        if (!this.fits(record.bytes))
          return err(failure('asset-budget-exceeded', 'Mesh ingestion scratch capacity'));
        const copied = this.capture(record.value);
        if (!copied.ok) return copied;
        record.value = copied.value;
        return ok(undefined);
      },
      commit: (beforeCommit) => this.commitAdoption(state, beforeCommit),
      retire: () => {
        const conflict = this.custodyConflict();
        if (conflict !== undefined) throw conflict;
        this.cancelAdoption(state);
      },
      stepRetirement: (maxWork) => this.stepAdoptionRetirement(state, maxWork),
      inspect: () => this.inspectAdoption(state),
    });
  }

  private inspectAdoption(state: AdoptionState): AssetAdoptionStatus {
    return {
      phase: state.phase,
      assets: state.values.size,
      bytes: state.bytes,
      consumerReferences: state.consumerReferences,
      processedReferences: state.processedReferences,
    };
  }

  private checkAdoption(state: AdoptionState): Result<void, AssetError> {
    try {
      const checked = this.validateAdoptionInputs(state);
      if (!checked.ok) this.cancelAdoption(state);
      return checked;
    } catch (cause) {
      this.cancelAdoption(state);
      throw cause;
    }
  }

  private validateAdoptionInputs(state: AdoptionState): Result<void, AssetError> {
    if (this.closed) return err(failure('asset-owner-closed', this.identity));
    if (state.phase !== 'preparing')
      return err(failure('asset-write-conflict', 'an active private ingestion candidate'));
    if (
      this.staged !== undefined ||
      (this.acceptingAdoption && this.participatingAdoption !== state)
    )
      return err(failure('asset-write-conflict', 'candidate reads outside another adoption'));
    const preparing = this.preparingAdoption;
    this.preparingAdoption = true;
    let checked: Result<void, AssetError>;
    try {
      checked = state.check?.() ?? ok(undefined);
    } finally {
      this.preparingAdoption = preparing;
    }
    if (!checked.ok) return checked;
    for (const [handle, revision] of state.expected)
      if (this.records.get(handle)?.revision !== revision)
        return err(failure('asset-write-conflict', 'the initial committed ingestion inputs'));
    return ok(undefined);
  }

  private adoptionEntry(state: AdoptionState, handle: number): Result<RecordEntry, AssetError> {
    const current = this.checkAdoption(state);
    if (!current.ok) return current;
    return this.trackAdoptionEntry(state, handle);
  }

  private trackAdoptionEntry(
    state: AdoptionState,
    handle: number,
  ): Result<RecordEntry, AssetError> {
    const candidate = state.values.get(handle);
    if (candidate !== undefined) return ok(candidate);
    const record = this.records.get(handle);
    if (record === undefined)
      return err(failure('asset-reference-invalid', 'a candidate or guarded committed dependency'));
    if (record.revision > state.maximumInputRevision) {
      this.cancelAdoption(state);
      return err(
        failure('asset-write-conflict', 'runtime inputs unchanged since this ingestion began'),
      );
    }
    if (!state.expected.has(handle)) {
      const held = this.protectAdoptionReference(handle, state.guardRoots);
      if (!held.ok) return held;
      state.expected.set(handle, record.revision);
    }
    return ok(record);
  }

  private adoptionReader(state: AdoptionState): AssetAdoptionReader {
    return {
      read: <T>(handle: number) => {
        const found = this.adoptionEntry(state, handle);
        return found.ok ? this.capture(found.value.value as T) : found;
      },
      borrow: <T>(handle: number) => {
        const found = this.adoptionEntry(state, handle);
        return found.ok ? ok(found.value.value as T) : found;
      },
      version: (handle) => {
        const found = this.adoptionEntry(state, handle);
        return found.ok ? ok(found.value.revision) : found;
      },
      kind: (handle) => {
        const found = this.adoptionEntry(state, handle);
        return found.ok ? ok(found.value.target) : found;
      },
      dependencies: (handle) => {
        const found = this.adoptionEntry(state, handle);
        return found.ok ? ok(found.value.dependencies) : found;
      },
      borrowClosure: <T>(roots: readonly number[]) => this.borrowAdoptionClosure<T>(state, roots),
      validate: (handle, target) => {
        if (handle === 0) return this.checkAdoption(state);
        const found = this.adoptionEntry(state, handle);
        if (!found.ok) return found;
        return target === undefined || found.value.target === target
          ? ok(undefined)
          : err(failure('asset-reference-invalid', 'a candidate dependency of the selected kind'));
      },
    };
  }

  private borrowAdoptionClosure<T>(
    state: AdoptionState,
    roots: readonly number[],
  ): Result<ReadonlyMap<number, T>, AssetError> {
    const values = new Map<number, T>();
    const pending = [...roots];
    while (pending.length > 0) {
      const handle = pending.pop() as number;
      if (values.has(handle)) continue;
      const found = this.adoptionEntry(state, handle);
      if (!found.ok) return found;
      values.set(handle, found.value.value as T);
      for (const dependency of found.value.dependencies) pending.push(dependency);
    }
    return ok(values);
  }

  private protectAdoptionReference(handle: number, roots: number[]): Result<void, AssetError> {
    const record = this.records.get(handle);
    if (record === undefined)
      return err(failure('asset-reference-invalid', 'a live committed ingestion dependency'));
    if (record.holders >= Number.MAX_SAFE_INTEGER)
      return err(failure('asset-budget-exceeded', 'available ingestion reference grants'));
    record.holders++;
    this.custodyHolds.set(handle, (this.custodyHolds.get(handle) ?? 0) + 1);
    roots.push(handle);
    return ok(undefined);
  }

  private prepareAdoption<K extends string, T, E>(
    state: AdoptionState,
    reader: AssetAdoptionReader,
    target: K,
    input: T,
    dependencies: readonly number[],
    prepare:
      | ((owned: T, reader: AssetAdoptionReader) => Result<PreparedAssetContent, E>)
      | undefined,
    replacing: AssetHandle<K> | undefined,
    storage: 'copy' | 'take',
  ): Result<AssetHandle<K>, AssetError | E> {
    const conflict = this.custodyConflict();
    if (conflict !== undefined) return err(conflict);
    try {
      const result = this.prepareAdoptionValue(
        state,
        reader,
        target,
        input,
        dependencies,
        prepare,
        replacing,
        storage,
      );
      if (!result.ok) this.cancelAdoption(state);
      return result;
    } catch (cause) {
      this.cancelAdoption(state);
      throw cause;
    }
  }

  private prepareAdoptionValue<K extends string, T, E>(
    state: AdoptionState,
    reader: AssetAdoptionReader,
    target: K,
    input: T,
    dependencies: readonly number[],
    prepare:
      | ((owned: T, reader: AssetAdoptionReader) => Result<PreparedAssetContent, E>)
      | undefined,
    replacing: AssetHandle<K> | undefined,
    storage: 'copy' | 'take',
  ): Result<AssetHandle<K>, AssetError | E> {
    const current = this.checkAdoption(state);
    if (!current.ok) return current;
    const admission = this.admissionError(replacing === undefined);
    if (admission !== undefined) return err(admission);
    const replacement = this.adoptionReplacement(state, target, replacing);
    if (!replacement.ok) return replacement;
    const measured = this.measureInput(input);
    if (!measured.ok) return measured;
    if (!this.fits(measured.value))
      return err(failure('asset-budget-exceeded', 'ingestion scratch capacity'));
    const capturedAllocation = captureAssetDataAllocated(input, storage);
    const scratchBytes = capturedAllocation.bytes;
    this.adoptionBytes += scratchBytes;
    state.bytes += scratchBytes;
    try {
      const captured = ok(capturedAllocation.value);
      let prepared: Result<PreparedAssetContent, E>;
      this.preparingAdoption = true;
      try {
        prepared = prepare?.(captured.value, reader) ?? ok({ value: captured.value });
      } finally {
        this.preparingAdoption = false;
      }
      if (!prepared.ok) return prepared;
      const record = this.prepareAdoptionRecord(
        state,
        target,
        prepared.value,
        dependencies,
        capturedAllocation.reusedBy(prepared.value.value),
      );
      if (!record.ok) return record;
      const handle = replacing ?? (++identities.reference as AssetHandle<K>);
      if (replacing === undefined) {
        state.newIdentities.add(handle);
        this.adoptionIdentities++;
      }
      state.values.set(handle, record.value);
      state.bytes += record.value.bytes;
      this.adoptionBytes += record.value.bytes;
      return ok(handle);
    } finally {
      state.bytes -= scratchBytes;
      this.adoptionBytes -= scratchBytes;
    }
  }

  private adoptionReplacement(
    state: AdoptionState,
    target: string,
    replacing: number | undefined,
  ): Result<void, AssetError> {
    if (replacing === undefined) return ok(undefined);
    if (state.values.has(replacing))
      return err(failure('asset-write-conflict', 'one ingestion replacement per identity'));
    const found = this.adoptionEntry(state, replacing);
    if (!found.ok) return found;
    return found.value.target === target
      ? ok(undefined)
      : err(failure('asset-reference-invalid', 'a live source identity of the same kind'));
  }

  private prepareAdoptionRecord(
    state: AdoptionState,
    target: string,
    prepared: PreparedAssetContent,
    dependencies: readonly number[],
    reusedScratch: number,
  ): Result<RecordEntry, AssetError> {
    const linked = prepared.dependencies ?? dependencies;
    if (linked.length > this.limits.maxDependencies)
      return err(failure('asset-budget-exceeded', 'available dependency capacity'));
    const held = Object.freeze([...new Set(linked)]);
    const fieldBytes = new Map<string, number>();
    const measured = this.measureInput(prepared.value, fieldBytes);
    if (!measured.ok) return measured;
    const bytes = measured.value + held.length * 8;
    if (!this.fits(bytes - reusedScratch))
      return err(failure('asset-budget-exceeded', 'prepared ingestion capacity'));
    for (const handle of held) {
      const found = this.adoptionEntry(state, handle);
      if (!found.ok) return found;
    }
    for (const handle of held) {
      if (state.newIdentities.has(handle)) {
        const child = state.values.get(handle) as RecordEntry;
        if (child.holders >= Number.MAX_SAFE_INTEGER)
          return err(failure('asset-budget-exceeded', 'available candidate dependency grants'));
        child.holders++;
      } else {
        const retained = this.protectAdoptionReference(handle, state.edgeRoots);
        if (!retained.ok) return retained;
      }
    }
    return ok({
      target,
      value: prepared.value,
      dependencies: held,
      bytes,
      revision: 0,
      holders: 1,
      fieldBytes,
      meshCpuRetention: undefined,
    });
  }

  /** Final graph validation also guards nodes that were never payload preparation inputs. */
  private validateAdoptionGraph(state: AdoptionState): Result<void, AssetError> {
    const checked = new Set<number>();
    const visiting = new Set<number>();
    for (const root of state.values.keys()) {
      // An unpublished new identity can only have earlier dependencies.
      // A synchronous closure can only introduce a cycle through a replacement.
      if (state.synchronous && state.newIdentities.has(root)) continue;
      const pending = [root];
      while (pending.length > 0) {
        const handle = pending.pop() as number;
        if (handle < 0) {
          visiting.delete(-handle);
          checked.add(-handle);
          continue;
        }
        if (checked.has(handle)) continue;
        if (visiting.has(handle))
          return err(failure('asset-reference-invalid', 'an acyclic merged ingestion graph'));
        const record = this.trackAdoptionEntry(state, handle);
        if (!record.ok) return record;
        visiting.add(handle);
        // Real identities are positive; the negative marker closes this DFS branch.
        pending.push(-handle);
        for (const dependency of record.value.dependencies) pending.push(dependency);
      }
    }
    return this.checkAdoption(state);
  }

  private commitAdoption(
    state: AdoptionState,
    beforeCommit?: () => void,
  ): Result<void, AssetError> {
    const conflict = this.custodyConflict();
    if (conflict !== undefined) return err(conflict);
    try {
      const current = this.checkAdoption(state);
      if (!current.ok) {
        this.cancelAdoption(state);
        return current;
      }
      const graph = this.validateAdoptionGraph(state);
      if (!graph.ok) {
        this.cancelAdoption(state);
        return graph;
      }
      this.acceptingAdoption = true;
      this.participatingAdoption = state;
      try {
        beforeCommit?.();
      } finally {
        this.participatingAdoption = undefined;
        this.acceptingAdoption = false;
      }
      const after = this.checkAdoption(state);
      if (!after.ok) {
        this.cancelAdoption(state);
        return after;
      }
      const admission = this.admissionError(false);
      if (admission !== undefined) {
        this.cancelAdoption(state);
        return err(admission);
      }
      try {
        this.publishAdoption(state);
      } catch (cause) {
        // Publication has started: terminate this owner rather than pretending
        // a private rollback restored every already public fact.
        this.dispose();
        throw cause;
      }
      return ok(undefined);
    } catch (cause) {
      this.cancelAdoption(state);
      throw cause;
    }
  }

  /** No extension code or payload preparation runs after this first public mutation. */
  private publishAdoption(state: AdoptionState): void {
    const oldRoots: number[] = [];
    if (state.values.size > 0) this.revision++;
    for (const [handle, record] of state.values) {
      const previous = this.records.get(handle);
      if (previous !== undefined) {
        record.holders = previous.holders;
        record.meshCpuRetention =
          previous.meshCpuRetention?.kind === 'required' ? previous.meshCpuRetention : undefined;
        for (const dependency of previous.dependencies) {
          // Transfer the old graph's actual edge, without manufacturing a new grant.
          this.custodyHolds.set(dependency, (this.custodyHolds.get(dependency) ?? 0) + 1);
          oldRoots.push(dependency);
        }
      }
      record.revision = this.revision;
      this.records.set(handle, record);
      if (previous !== record) previous?.meshPresentation?.release();
      this.bytes += record.bytes - (previous?.bytes ?? 0);
      this.changed(handle, [
        ...new Set([...(previous?.fieldBytes.keys() ?? []), ...record.fieldBytes.keys()]),
      ]);
    }
    for (const handle of state.edgeRoots) {
      const count = this.custodyHolds.get(handle) as number;
      if (count === 1) this.custodyHolds.delete(handle);
      else this.custodyHolds.set(handle, count - 1);
    }
    this.adoptionBytes -= state.bytes;
    this.adoptionIdentities -= state.newIdentities.size;
    state.bytes = 0;
    state.values.clear();
    state.newIdentities.clear();
    state.consumers.clear();
    state.consumerReferences = 0;
    state.phase = 'committed';
    state.cleanup = [this.createRetirement(state.guardRoots), this.createRetirement(oldRoots)];
    state.edgeRoots.length = 0;
  }

  private cancelAdoption(state: AdoptionState): void {
    if (state.phase !== 'preparing') return;
    state.phase = 'retiring';
    state.cleanup = [
      this.createRetirement(state.guardRoots),
      this.createRetirement(state.edgeRoots),
    ];
  }

  private stepAdoptionRetirement(
    state: AdoptionState,
    maxWork: number,
  ): Result<AssetAdoptionStatus, AssetError> {
    if (!Number.isSafeInteger(maxWork) || maxWork <= 0)
      return err(
        failure('asset-invalid-value', 'a positive safe-integer ingestion retirement budget'),
      );
    const conflict = this.custodyConflict();
    if (conflict !== undefined) return err(conflict);
    if (state.phase === 'preparing') this.cancelAdoption(state);
    for (let work = 0; work < maxWork; work++) {
      const pending = state.cleanup?.find((task) => !task.inspect().done);
      if (pending !== undefined) {
        const before = pending.inspect().processedReferences;
        const result = pending.step(1);
        if (!result.ok) return result;
        state.processedReferences += result.value.processedReferences - before;
        continue;
      }
      if (state.consumerReferences > 0) break;
      const first = state.values.entries().next();
      if (first.done) {
        this.finishAdoption(state);
        break;
      }
      const [handle, record] = first.value;
      state.values.delete(handle);
      state.bytes -= record.bytes;
      this.adoptionBytes -= record.bytes;
      if (state.newIdentities.delete(handle)) this.adoptionIdentities--;
    }
    return ok(this.inspectAdoption(state));
  }

  private finishAdoption(state: AdoptionState): void {
    if (state.phase === 'closed' || state.phase === 'retired') return;
    state.phase = 'retired';
    state.expected.clear();
    state.guardRoots.length = 0;
    state.edgeRoots.length = 0;
    state.consumers.clear();
    state.cleanup = undefined;
    this.pendingAdoptions.delete(state);
  }

  /** A public read is an independently owned value, including every binary view. */
  read<T>(handle: number): Result<T, AssetError> {
    const found = this.cpuEntry(handle);
    return found.ok ? this.capture(found.value.value as T, 'detached') : found;
  }

  copy<K extends string, P>(handle: AssetHandle<K, P>): Result<AssetHandle<K, P>, AssetError> {
    const found = this.cpuEntry(handle);
    if (!found.ok) return found;
    return this.create(found.value.target, found.value.value, found.value.dependencies) as Result<
      AssetHandle<K, P>,
      AssetError
    >;
  }

  /** Internal synchronous consumption only. Do not retain this value across a write boundary. */
  borrow<T>(handle: number): Result<T, AssetError> {
    const found = this.cpuEntry(handle);
    return found.ok ? ok(found.value.value as T) : found;
  }

  /** A standalone presenter may transfer the owned native storage without a CPU read. */
  borrowMeshForPresentation(handle: number): Result<MeshAsset, AssetError> {
    const found = this.entry(handle);
    if (!found.ok) return found;
    const record = found.value;
    if (record.target !== 'mesh' || record.meshPresentation !== undefined)
      return err(failure('asset-reference-invalid', 'an owned source Mesh payload'));
    return ok(record.value as MeshAsset);
  }

  /** Borrow only the draw metadata, derived once for each accepted Mesh revision. */
  meshDraw(handle: number): Result<MeshDrawDescription, AssetError> {
    const found = this.entry(handle);
    if (!found.ok) return found;
    const record = found.value;
    if (record.target !== 'mesh')
      return err(failure('asset-reference-invalid', 'a live Mesh asset'));
    if (record.meshDraw?.revision !== record.revision)
      record.meshDraw = {
        revision: record.revision,
        value: describeMeshDraw(record.value as MeshAsset),
      };
    return ok(record.meshDraw.value);
  }

  requireMeshCpu(handle: number): MeshPresentation | undefined {
    const record = this.records.get(handle);
    if (record?.target !== 'mesh') return undefined;
    if (record.meshPresentation === undefined)
      record.meshCpuRetention = { kind: 'required', reason: 'cpu-required' };
    return record.meshPresentation;
  }

  meshPresentation(handle: number): MeshPresentation | undefined {
    return this.records.get(handle)?.meshPresentation;
  }

  canPresentMesh(handle: number): boolean {
    const record = this.records.get(handle);
    return (
      record?.target === 'mesh' &&
      record.meshCpuRetention?.kind !== 'required' &&
      record.meshPresentation === undefined
    );
  }

  noteMeshCpuFallback(handle: number, revision: number, reason: MeshCpuFallback): void {
    const record = this.records.get(handle);
    if (record?.revision === revision && this.canPresentMesh(handle))
      record.meshCpuRetention = { kind: 'fallback', reason, revision };
  }

  rebindMeshPresentation(
    handle: number,
    presentation: MeshPresentation,
    lease: MeshPresentationLease,
  ): boolean {
    const record = this.records.get(handle);
    if (
      record?.meshPresentation !== presentation ||
      this.meshPresenters.size !== 1 ||
      !lease.isCurrent()
    )
      return false;
    presentation.lease.release();
    presentation.lease = lease;
    return true;
  }

  meshCpuResidency(handle: number): Result<
    {
      readonly revision: number;
      readonly mode: 'cpu' | 'render';
      readonly registryBytes: number;
      readonly cpuRetentionReason?: MeshCpuRetentionReason;
      readonly recoveryArtifactBytes: number;
      readonly recoveryArtifactStorage?: MeshArtifactStorage;
      readonly handoff?: 'transfer' | 'copy';
    },
    AssetError
  > {
    const found = this.entry(handle);
    if (!found.ok) return found;
    const record = found.value;
    if (record.target !== 'mesh')
      return err(failure('asset-reference-invalid', 'a live Mesh asset'));
    const retention = record.meshCpuRetention;
    const reason =
      retention?.kind === 'required' || retention?.revision === record.revision
        ? retention.reason
        : 'not-requested';
    return ok({
      revision: record.revision,
      mode: record.meshPresentation === undefined ? 'cpu' : 'render',
      registryBytes: record.bytes,
      recoveryArtifactBytes: record.meshPresentation?.bytes ?? 0,
      ...(record.meshPresentation === undefined
        ? { cpuRetentionReason: reason }
        : {
            recoveryArtifactStorage: record.meshPresentation.storage,
            ...(record.meshPresentation.handoff === undefined
              ? {}
              : { handoff: record.meshPresentation.handoff }),
          }),
    });
  }

  cancelMeshHandoff(handle: number, presentation: MeshPresentation, mesh: MeshAsset): boolean {
    const record = this.records.get(handle);
    if (
      record?.meshPresentation !== presentation ||
      mesh.vertices.length !== record.meshDraw?.value.vertexWordCount
    )
      return false;
    const fields = new Map<string, number>();
    const bytes = assetDataBytes(mesh, fields) + 8 * record.dependencies.length;
    if (!this.fits(bytes - record.bytes)) return false;
    this.bytes += bytes - record.bytes;
    record.bytes = bytes;
    for (const [field, size] of fields) record.fieldBytes.set(field, size);
    record.value = mesh;
    delete record.meshPresentation;
    presentation.release();
    return true;
  }

  /** Change storage only. Readers and Render refer to the same content revision. */
  retainMeshPresentation(
    handle: number,
    revision: number,
    presentation: MeshPresentation,
  ): boolean {
    const record = this.records.get(handle);
    if (
      this.staged !== undefined ||
      record?.target !== 'mesh' ||
      record.revision !== revision ||
      record.meshCpuRetention?.kind === 'required' ||
      record.meshPresentation !== undefined
    )
      return false;
    for (const capture of this.pendingCaptures)
      if (capture.status.kind === 'capturing' && capture.expected.has(handle)) return false;
    const draw = this.meshDraw(handle).unwrap();
    const bytes = assetDataBytes(draw) + 8 * record.dependencies.length;
    if (!this.fits(bytes - record.bytes)) return false;
    this.bytes += bytes - record.bytes;
    record.bytes = bytes;
    record.fieldBytes.clear();
    record.value = undefined;
    record.meshCpuRetention = undefined;
    record.meshPresentation = presentation;
    return true;
  }

  /** The presentation token fences release, replacement and concurrent loads. */
  restoreMeshCpu(
    handle: number,
    presentation: MeshPresentation,
    mesh: MeshAsset,
    reason: MeshCpuRequirement = 'cpu-required',
  ): Result<void, AssetError> {
    const restored = this.restoreMeshReferences(handle, presentation, mesh);
    if (!restored.ok) return restored;
    const record = this.records.get(handle) as RecordEntry;
    const captured = this.capture(restored.value, 'take');
    if (!captured.ok) return captured;
    const bytes = assetDataBytes(captured.value) + 8 * record.dependencies.length;
    if (!this.fits(bytes - record.bytes))
      return err(failure('asset-budget-exceeded', 'restored Mesh CPU bytes'));
    this.bytes += bytes - record.bytes;
    record.bytes = bytes;
    record.value = captured.value;
    record.meshCpuRetention = { kind: 'required', reason };
    delete record.meshPresentation;
    for (const [field, value] of Object.entries(captured.value))
      record.fieldBytes.set(field, assetFieldBytes(field, assetDataBytes(value)));
    presentation.release();
    return ok(undefined);
  }

  restoreMeshReferences(
    handle: number,
    presentation: MeshPresentation,
    mesh: MeshAsset,
  ): Result<MeshAsset, AssetError> {
    const record = this.records.get(handle);
    if (record?.meshPresentation !== presentation || this.staged !== undefined)
      return err(failure('asset-write-conflict', 'the same presented Mesh revision'));
    // The fixed source contains author GUIDs. Restore the bound references
    // from this exact runtime revision, even after the Catalog was replaced.
    const draw = this.meshDraw(handle).unwrap();
    return ok({
      ...mesh,
      materialSlots: draw.materialSlots,
      ...(draw.lods === undefined ? {} : { lods: draw.lods }),
    });
  }

  /** The same accepted asset reader is used by local and published consumers. */
  resolveAsset<T = Asset>(handle: number, revision?: number): Result<T, AssetError> {
    return revision === undefined
      ? this.borrow<T>(handle)
      : this.borrowVersion<T>(handle, revision);
  }

  /** Internal lease-accounting evidence for atomic domain admission and rollback. */
  refcount(handle: number): number {
    if (this.participatingAdoption?.newIdentities.has(handle))
      return this.participatingAdoption.values.get(handle)?.holders ?? 0;
    return this.records.get(handle)?.holders ?? 0;
  }

  version(handle: number): Result<number, AssetError> {
    const found = this.entry(handle);
    return found.ok ? ok(found.value.revision) : found;
  }

  kind(handle: number): Result<string, AssetError> {
    const found = this.entry(handle);
    return found.ok ? ok(found.value.target) : found;
  }

  /** Request fencing compares only the identities actually prepared by that request. */
  get currentRevision(): number {
    return this.revision;
  }

  /** The domain validates a patch before this atomic capture/commit boundary. */
  update<E = never>(
    handle: number,
    input: Readonly<Record<string, unknown>>,
    options: {
      readonly prepare?: (
        current: Readonly<Record<string, unknown>>,
        owned: Record<string, unknown>,
      ) => Result<PreparedAssetContent<Record<string, unknown>>, E>;
      readonly dependencies?: readonly number[];
      /** Patch one existing object field without copying its unchanged siblings. */
      readonly field?: string;
      /** Omitted fields are removed, rather than retained as in a field patch. */
      readonly replace?: boolean;
    } = {},
  ): Result<void, AssetError | E> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    const { prepare, field: objectField } = options;
    if (
      this.staged !== undefined &&
      ((options.replace
        ? objectField !== undefined
        : objectField === undefined || objectField === 'kind') ||
        this.replacements?.has(handle))
    )
      return err(
        failure('asset-write-conflict', 'one replacement or object field patch per asset adoption'),
      );
    let { dependencies } = options;
    const found = this.cpuEntry(handle);
    if (!found.ok) return found;
    const expectedRevision = found.value.revision;
    if (this.revision >= Number.MAX_SAFE_INTEGER - this.limits.maxAssets)
      return err(failure('asset-budget-exceeded', 'available content revisions'));
    const measured = this.measureInput(input);
    if (!measured.ok) return measured;
    if (!this.fits(measured.value))
      return err(failure('asset-budget-exceeded', 'available candidate capture bytes'));
    if (!isObjectFields(input) || !isObjectFields(found.value.value))
      return err(failure('asset-invalid-value', 'object content and an object field patch'));
    const captured = this.capture(input);
    if (!captured.ok) return captured;
    const record = found.value;
    const root = found.value.value;
    const current = objectField === undefined ? root : root[objectField];
    if (!isObjectFields(current))
      return err(failure('asset-invalid-value', 'an existing object field'));
    let prepared: Result<PreparedAssetContent<Record<string, unknown>>, E>;
    this.preparingAdoption = this.staged !== undefined;
    try {
      prepared = prepare?.(current, captured.value) ?? ok({ value: captured.value });
    } finally {
      this.preparingAdoption = false;
    }
    if (!prepared.ok) return prepared;
    const patch = prepared.value.value;
    if (!isObjectFields(patch))
      return err(failure('asset-invalid-value', 'prepared object content for a field update'));
    dependencies = prepared.value.dependencies ?? dependencies;
    if (dependencies !== undefined && dependencies.length > this.limits.maxDependencies)
      return err(failure('asset-budget-exceeded', 'available dependency capacity'));
    const nextDependencies =
      dependencies === undefined ? record.dependencies : Object.freeze([...new Set(dependencies)]);
    if (dependencies !== undefined) {
      if (this.staged === undefined) {
        const valid = this.validateDependencies(handle, nextDependencies);
        if (!valid.ok) return valid;
      } else {
        // The complete candidate graph is checked once all replacements are prepared.
        for (const dependency of nextDependencies) {
          const found = this.entry(dependency);
          if (!found.ok) return found;
        }
      }
    }
    if (objectField === undefined && 'kind' in patch && patch.kind !== current.kind)
      return err(failure('asset-invalid-value', 'an unchanged asset kind'));
    const fields = options.replace
      ? [...new Set([...Object.keys(current), ...Object.keys(patch)])]
      : Object.keys(patch);
    if (fields.length === 0 && dependencies === undefined) return ok(undefined);
    const sizes = new Map(
      fields.map((field) => [
        field,
        Object.hasOwn(patch, field) ? assetFieldBytes(field, assetDataBytes(patch[field])) : 0,
      ]),
    );
    let contentDelta = 0;
    for (const [field, size] of sizes) {
      const priorSize =
        objectField === undefined
          ? (record.fieldBytes.get(field) ?? 0)
          : Object.hasOwn(current, field)
            ? assetFieldBytes(field, assetDataBytes(current[field]))
            : 0;
      contentDelta += size - priorSize;
    }
    const delta = contentDelta + (nextDependencies.length - record.dependencies.length) * 8;
    if (!this.fits(delta)) return err(failure('asset-budget-exceeded', 'available content bytes'));
    if (this.records.get(handle) !== record || record.revision !== expectedRevision)
      return err(
        failure('asset-write-conflict', 'unchanged content during input capture and preparation'),
      );
    if (this.replacements !== undefined) {
      const bytes = record.bytes + delta;
      if (!this.fits(bytes))
        return err(failure('asset-budget-exceeded', 'available prepared content bytes'));
      for (const dependency of nextDependencies) this.retain(dependency).unwrap();
      const stagedFields =
        objectField === undefined
          ? new Map([...sizes].filter(([field]) => Object.hasOwn(patch, field)))
          : new Map(record.fieldBytes).set(
              objectField,
              (record.fieldBytes.get(objectField) ?? 0) + contentDelta,
            );
      this.replacements.set(handle, {
        target: record.target,
        meshCpuRetention: record.meshCpuRetention,
        value:
          objectField === undefined ? patch : { ...root, [objectField]: { ...current, ...patch } },
        fieldBytes: stagedFields,
        ...(objectField === undefined ? {} : { patchedField: objectField }),
        dependencies: nextDependencies,
        revision: record.revision,
        holders: 1,
        bytes,
      });
      this.candidateBytes += bytes;
      return ok(undefined);
    }
    const priorDependencies = record.dependencies;
    if (dependencies !== undefined)
      for (const dependency of nextDependencies) this.retain(dependency).unwrap();
    applyOwnedFields(current, patch, fields, sizes, record.fieldBytes, objectField, contentDelta);
    record.dependencies = nextDependencies;
    record.bytes += delta;
    this.bytes += delta;
    record.revision = ++this.revision;
    this.changed(handle, objectField === undefined ? fields : [objectField]);
    if (dependencies !== undefined)
      for (const dependency of priorDependencies) this.release(dependency).unwrap();
    return ok(undefined);
  }

  /** Domain preparation describes every affected range before any owned byte changes. */
  writeRange<T, E = AssetError>(
    handle: number,
    input: T,
    prepare: (
      current: unknown,
      captured: T,
      limits: Required<AssetLimits>,
    ) => Result<PreparedAssetRanges, E>,
  ): Result<void, AssetError | E> {
    return this.writeRanges(handle, input, (current, captured, limits) => {
      const ranges = prepare(current, captured, limits);
      return ranges.ok ? ok([{ handle, ranges: ranges.value }]) : ranges;
    });
  }

  /** Validate every affected owner before adopting their bytes and metadata at one revision. */
  writeRanges<T, E = AssetError>(
    handle: number,
    input: T,
    prepare: (
      current: unknown,
      captured: T,
      limits: Required<AssetLimits>,
    ) => Result<readonly AssetRangeUpdate[], E>,
  ): Result<void, AssetError | E> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    if (this.staged !== undefined)
      return err(failure('asset-write-conflict', 'range writes outside a closure replacement'));
    const found = this.cpuEntry(handle);
    if (!found.ok) return found;
    const revision = this.revision;
    if (revision >= Number.MAX_SAFE_INTEGER - this.limits.maxAssets)
      return err(failure('asset-budget-exceeded', 'available content revisions'));
    const measured = this.measureInput(input);
    if (!measured.ok) return measured;
    if (!this.fits(measured.value))
      return err(failure('asset-budget-exceeded', 'range capture bytes'));
    const captured = this.capture(input);
    if (!captured.ok) return captured;
    const prepared = prepare(found.value.value, captured.value, this.limits);
    if (!prepared.ok) return prepared;
    const commits = this.prepareRangeCommits(prepared.value, measured.value);
    if (!commits.ok) return commits;
    if (this.revision !== revision)
      return err(failure('asset-write-conflict', 'unchanged content during range preparation'));
    if (commits.value.updates.length === 0) return ok(undefined);
    this.revision++;
    this.bytes += commits.value.totalDelta;
    for (const update of commits.value.updates) this.commitRangeUpdate(update);
    return ok(undefined);
  }

  /** Every update is validated and its copies owned before any record changes. */
  private prepareRangeCommits(
    updates: readonly AssetRangeUpdate[],
    capturedBytes: number,
    rangeBudget: 'whole' | 'asset' = 'whole',
  ): Result<{ readonly updates: PreparedRangeUpdate[]; readonly totalDelta: number }, AssetError> {
    const adopted = new Set<number>();
    const commits: PreparedRangeUpdate[] = [];
    let candidateBytes = capturedBytes;
    let totalDelta = 0;
    let rangeCount = 0;
    for (const update of updates) {
      if (adopted.has(update.handle))
        return err(failure('asset-invalid-value', 'one range update per asset'));
      adopted.add(update.handle);
      const entry = this.cpuEntry(update.handle);
      if (!entry.ok) return entry;
      const value = entry.value.value;
      if (!isObjectFields(value))
        return err(failure('asset-invalid-value', 'object content with an unchanged kind'));
      const { writes, fieldWrites = [] } = update.ranges;
      const editRangeCount = writes.length + fieldWrites.length;
      rangeCount += editRangeCount;
      if ((rangeBudget === 'asset' ? editRangeCount : rangeCount) > this.limits.maxRanges)
        return err(failure('asset-budget-exceeded', 'bounded range preparation'));
      const prepared = this.prepareRangeUpdate(update, entry.value, value);
      if (!prepared.ok) return prepared;
      candidateBytes += prepared.value.candidateBytes;
      totalDelta += prepared.value.contentDelta;
      if (!this.fits(candidateBytes) || !this.fits(totalDelta))
        return err(failure('asset-budget-exceeded', 'range candidate and adopted content bytes'));
      const { operations, replaced, nested } = prepared.value;
      if (operations.length === 0 && replaced.length === 0 && nested.length === 0) continue;
      commits.push(prepared.value);
    }
    return ok({ updates: commits, totalDelta });
  }

  private prepareRangeUpdate(
    update: AssetRangeUpdate,
    record: RecordEntry,
    value: Record<string, unknown>,
  ): Result<PreparedRangeUpdate, AssetError> {
    const { writes, fields = {}, remove = [], fieldWrites = [] } = update.ranges;
    const patched = Object.keys(fields);
    const replaced = [...new Set([...patched, ...remove])];
    if (replaced.includes('kind'))
      return err(failure('asset-invalid-value', 'object content with an unchanged kind'));
    const measuredFields = this.measureInput(fields);
    if (!measuredFields.ok) return measuredFields;
    const copiedFields = this.capture(fields);
    if (!copiedFields.ok) return copiedFields;
    const sizes = new Map(
      patched.map((field) => [
        field,
        assetFieldBytes(field, assetDataBytes(copiedFields.value[field])),
      ]),
    );
    let contentDelta = 0;
    for (const field of replaced)
      contentDelta += (sizes.get(field) ?? 0) - (record.fieldBytes.get(field) ?? 0);
    const paths: readonly (readonly string[])[] = fieldWrites.map((write) => [...write.path]);
    const nested = this.prepareNestedWrites(value, fieldWrites, replaced, paths);
    if (!nested.ok) return nested;
    const operations = prepareByteWrites(value, writes, replaced, paths);
    if (!operations.ok) return operations;
    let writtenBytes = 0;
    for (const write of writes) writtenBytes += write.bytes.byteLength;
    return ok({
      handle: update.handle,
      record,
      value,
      replaced,
      fields: copiedFields.value,
      sizes,
      nested: nested.value.leaves,
      operations: operations.value,
      contentDelta: contentDelta + nested.value.contentDelta,
      candidateBytes: measuredFields.value + nested.value.candidateBytes + writtenBytes,
    });
  }

  private prepareNestedWrites(
    value: Record<string, unknown>,
    fieldWrites: NonNullable<PreparedAssetRanges['fieldWrites']>,
    replaced: readonly string[],
    paths: readonly (readonly string[])[],
  ): Result<
    { readonly leaves: NestedFieldWrite[]; contentDelta: number; candidateBytes: number },
    AssetError
  > {
    const prepared = { leaves: [] as NestedFieldWrite[], contentDelta: 0, candidateBytes: 0 };
    for (const [index, write] of fieldWrites.entries()) {
      const top = write.path[0],
        field = write.path.at(-1);
      if (
        write.path.length < 2 ||
        top === undefined ||
        field === undefined ||
        top === 'kind' ||
        replaced.includes(top) ||
        overlapsOtherPath(write.path, index, paths)
      )
        return err(failure('asset-invalid-value', 'distinct existing nested field paths'));
      const parent = replaceableNestedParent(value, write.path, field);
      if (!parent.ok) return parent;
      const leaf = this.measureInput(write.value);
      if (!leaf.ok) return leaf;
      prepared.candidateBytes += leaf.value;
      const capturedLeaf = this.capture(write.value);
      if (!capturedLeaf.ok) return capturedLeaf;
      const delta = leaf.value - assetDataBytes(parent.value[field]);
      prepared.contentDelta += delta;
      prepared.leaves.push({ target: parent.value, field, value: capturedLeaf.value, top, delta });
    }
    return ok(prepared);
  }

  private commitRangeUpdate(update: PreparedRangeUpdate): void {
    const { record, value, fields, sizes } = update;
    for (const operation of update.operations) copyRangeBytes(operation);
    for (const field of update.replaced) {
      if (Object.hasOwn(fields, field)) {
        defineOwnedField(value, field, fields[field]);
        record.fieldBytes.set(field, sizes.get(field) ?? 0);
      } else {
        delete value[field];
        record.fieldBytes.delete(field);
      }
    }
    for (const leaf of update.nested) {
      defineOwnedField(leaf.target, leaf.field, leaf.value);
      record.fieldBytes.set(leaf.top, (record.fieldBytes.get(leaf.top) ?? 0) + leaf.delta);
    }
    record.bytes += update.contentDelta;
    record.revision = this.revision;
    this.changed(update.handle, [
      ...new Set([...update.replaced, ...update.nested.map((leaf) => leaf.top)]),
    ]);
    for (const { write, span } of update.operations)
      this.changed(update.handle, [], {
        path: write.path,
        byteOffset: write.byteOffset,
        byteLength: span,
        ...(write.byteStride === undefined
          ? {}
          : {
              rowBytes: write.rowBytes ?? write.bytes.byteLength,
              byteStride: write.byteStride,
            }),
      });
  }

  retain(handle: number, target?: string): Result<void, AssetError> {
    const conflict = this.referenceMutationError();
    if (conflict !== undefined) return err(conflict);
    const valid = this.validate(handle, target);
    if (!valid.ok || handle === 0) return valid;
    const participant = this.participatingAdoption;
    if (participant?.newIdentities.has(handle)) {
      const record = participant.values.get(handle) as RecordEntry;
      if (record.holders >= Number.MAX_SAFE_INTEGER)
        return err(failure('asset-budget-exceeded', 'available private consumer grants'));
      record.holders++;
      participant.consumers.set(handle, (participant.consumers.get(handle) ?? 0) + 1);
      participant.consumerReferences++;
      return ok(undefined);
    }
    const record = this.records.get(handle) as RecordEntry;
    if (record.holders >= Number.MAX_SAFE_INTEGER)
      return err(failure('asset-budget-exceeded', 'available reference holds'));
    record.holders++;
    return ok(undefined);
  }

  validate(handle: number, target?: string): Result<void, AssetError> {
    if (handle === 0) return ok(undefined);
    const found = this.entry(handle);
    if (!found.ok) return found;
    if (target !== undefined && found.value.target !== target)
      return err(failure('asset-reference-invalid', `${target} owned by ${this.identity}`));
    return ok(undefined);
  }

  release(handle: number): Result<void, AssetError> {
    const conflict = this.referenceMutationError();
    if (conflict !== undefined) return err(conflict);
    if (handle === 0) return ok(undefined);
    if (!this.closed && !this.records.has(handle)) {
      for (const state of this.pendingAdoptions)
        if (state.newIdentities.has(handle)) return this.releaseAdoptionConsumer(state, handle);
    }
    const found = this.entry(handle);
    if (!found.ok) return found;
    const committed = this.records.get(handle) as RecordEntry;
    if (committed.holders <= (this.custodyHolds.get(handle) ?? 0))
      return err(failure('asset-reference-invalid', 'a caller-owned reference outside custody'));
    const pending = [handle];
    while (pending.length > 0) {
      const retired = pending.pop() as number;
      const record = this.records.get(retired) as RecordEntry;
      if (--record.holders > 0) continue;
      this.records.delete(retired);
      record.meshPresentation?.release();
      this.bytes -= record.bytes;
      this.revision++;
      if (!this.staged?.has(retired)) this.changed(retired, []);
      for (const dependency of record.dependencies) pending.push(dependency);
    }
    return ok(undefined);
  }

  releaseIfSoleHolder(handle: number): Result<boolean, AssetError> {
    const found = this.entry(handle);
    if (!found.ok) return found;
    if (found.value.holders !== 1 || this.custodyHolds.has(handle)) return ok(false);
    const released = this.release(handle);
    return released.ok ? ok(true) : released;
  }

  private releaseAdoptionConsumer(state: AdoptionState, handle: number): Result<void, AssetError> {
    const count = state.consumers.get(handle) ?? 0;
    if (count === 0)
      return err(failure('asset-reference-invalid', 'an outstanding private consumer grant'));
    if (count === 1) state.consumers.delete(handle);
    else state.consumers.set(handle, count - 1);
    state.consumerReferences--;
    const record = state.values.get(handle) as RecordEntry;
    record.holders--;
    if (state.synchronous && state.phase === 'retiring' && state.consumerReferences === 0)
      this.stepAdoptionRetirement(state, Number.MAX_SAFE_INTEGER).unwrap();
    return ok(undefined);
  }

  /** Transfer already owned references exactly once, before any dependency can be decremented. */
  deferRelease(handles: readonly number[]): Result<AssetRetirement, AssetError> {
    const conflict = this.custodyConflict();
    if (conflict !== undefined) return err(conflict);
    if (this.closed) return err(failure('asset-owner-closed', this.identity));
    const counts = new Map<number, number>();
    const roots: number[] = [];
    for (const handle of handles) {
      if (handle === 0) continue;
      const found = this.entry(handle);
      if (!found.ok) return found;
      const count = (counts.get(handle) ?? 0) + 1;
      if (count > found.value.holders - (this.custodyHolds.get(handle) ?? 0))
        return err(failure('asset-reference-invalid', 'one owned hold per transferred reference'));
      counts.set(handle, count);
      roots.push(handle);
    }
    for (const [handle, count] of counts)
      this.custodyHolds.set(handle, (this.custodyHolds.get(handle) ?? 0) + count);
    return ok(this.createRetirement(roots));
  }

  /** Atomically reserve the initial closure and real holds, without copying its values. */
  beginContentCapture(handle: number): Result<AssetContentCapture, AssetError> {
    const plan = this.reserveContentCapture(handle);
    if (!plan.ok) return plan;
    const { handles, expected, bytes, shared } = plan.value;
    const capture: ContentCaptureState = {
      handle,
      handles,
      expected,
      bytes,
      guard: this.revisionGuard(expected),
      values: new Map(),
      copiedAssets: 0,
      copiedBytes: 0,
      status: { kind: 'capturing' },
    };
    if (shared === undefined) this.pendingCaptures.add(capture);
    else this.completeContentCapture(capture, shared);
    return ok({
      step: (maxAssets) => this.stepContentCapture(capture, maxAssets),
      inspect: () => ({
        phase: capture.status.kind,
        copiedAssets: capture.copiedAssets,
        copiedBytes: capture.copiedBytes,
        reservedBytes:
          capture.status.kind === 'capturing' ? capture.bytes - capture.copiedBytes : 0,
      }),
      retire: () => this.retireContentCapture(capture),
    });
  }

  /** No live Record/value escapes this serial admission operation. */
  private reserveContentCapture(handle: number): Result<
    {
      readonly handles: readonly number[];
      readonly expected: ContentCaptureState['expected'];
      readonly bytes: number;
      readonly shared: SharedContentSnapshot | undefined;
    },
    AssetError
  > {
    const conflict = this.custodyConflict();
    if (conflict !== undefined) return err(conflict);
    const selected = this.collectRecords([handle]);
    if (!selected.ok) return selected;
    const expected: ContentCaptureState['expected'] = new Map();
    const shared = this.currentContentSnapshot(handle);
    let bytes = 0;
    for (const [reference, record] of selected.value) {
      const cpu = this.cpuRecord(reference, record);
      if (!cpu.ok) return cpu;
      if (record.holders >= Number.MAX_SAFE_INTEGER)
        return err(failure('asset-budget-exceeded', 'available reference holds'));
      expected.set(reference, { revision: record.revision, bytes: cpu.value.bytes });
      if (shared === undefined) bytes += cpu.value.bytes;
    }
    if (this.snapshots >= this.limits.maxSnapshots || !this.fits(bytes))
      return err(failure('asset-budget-exceeded', 'available fixed snapshot capacity'));
    const handles = Object.freeze([...expected.keys()]);
    this.snapshots++;
    this.captureReservedBytes += bytes;
    for (const reference of handles) {
      const record = this.records.get(reference) as RecordEntry;
      record.holders++;
      this.custodyHolds.set(reference, (this.custodyHolds.get(reference) ?? 0) + 1);
    }
    return ok({ handles, expected, bytes, shared });
  }

  private stepContentCapture(
    capture: ContentCaptureState,
    maxAssets: number,
  ): Result<AssetContentLease | undefined, AssetError> {
    if (!Number.isSafeInteger(maxAssets) || maxAssets <= 0)
      return err(failure('asset-invalid-value', 'a positive safe-integer asset work budget'));
    const conflict = this.custodyConflict();
    if (conflict !== undefined) return err(conflict);
    if (this.closed) return err(failure('asset-owner-closed', this.identity));
    if (capture.status.kind === 'complete') return ok(capture.status.lease);
    if (capture.status.kind === 'cancelled')
      return err(
        capture.status.cause ?? failure('asset-reference-invalid', 'an uncancelled fixed capture'),
      );
    if (!capture.guard.matchesCurrent()) return this.invalidateContentCapture(capture);
    const shared = this.currentContentSnapshot(capture.handle);
    if (shared !== undefined) return ok(this.completeContentCapture(capture, shared));
    for (let work = 0; work < maxAssets && capture.copiedAssets < capture.handles.length; work++) {
      const reference = capture.handles[capture.copiedAssets] as number;
      const expected = capture.expected.get(reference) as { revision: number; bytes: number };
      // entry() deliberately supports staged replacement reads. Capture never does.
      const record = this.records.get(reference);
      if (record === undefined || record.revision !== expected.revision)
        return this.invalidateContentCapture(capture);
      capture.values.set(reference, {
        value: copyAssetData(record.value),
        revision: expected.revision,
      });
      capture.copiedAssets++;
      capture.copiedBytes += expected.bytes;
      this.captureReservedBytes -= expected.bytes;
      this.snapshotBytes += expected.bytes;
    }
    if (capture.copiedAssets !== capture.handles.length) return ok(undefined);
    if (!capture.guard.matchesCurrent()) return this.invalidateContentCapture(capture);
    return ok(this.completeContentCapture(capture));
  }

  private currentContentSnapshot(handle: number): SharedContentSnapshot | undefined {
    const shared = this.contentSnapshots.get(handle);
    return shared?.data.snapshot.matchesCurrent() === true ? shared : undefined;
  }

  private completeContentCapture(
    capture: ContentCaptureState,
    shared?: SharedContentSnapshot,
  ): AssetContentLease {
    if (shared === undefined) {
      const root = capture.handle;
      shared = { root, data: this.fixedSnapshot(root, capture.values, capture.bytes), holders: 0 };
      this.contentSnapshots.set(root, shared);
    } else {
      // A concurrent closed acquisition can adopt the copy already sealed by its peer.
      this.captureReservedBytes -= capture.bytes - capture.copiedBytes;
      this.snapshotBytes -= capture.copiedBytes;
      capture.values.clear();
    }
    capture.guard.dispose();
    capture.expected.clear();
    const lease = this.contentLease(capture.handles, shared);
    capture.status = { kind: 'complete', lease };
    this.pendingCaptures.delete(capture);
    return lease;
  }

  private invalidateContentCapture(capture: ContentCaptureState): Result<never, AssetError> {
    const cause = failure('asset-write-conflict', 'the unchanged initial fixed-capture closure');
    const retired = this.retireContentCapture(capture, cause);
    return retired.ok ? err(cause) : retired;
  }

  private retireContentCapture(
    capture: ContentCaptureState,
    cause?: AssetError,
  ): Result<AssetRetirement, AssetError> {
    const conflict = this.custodyConflict();
    if (conflict !== undefined) return err(conflict);
    if (capture.status.kind === 'complete') return capture.status.lease.retire();
    if (capture.status.kind === 'cancelled') return ok(capture.status.retirement);
    capture.guard.dispose();
    capture.expected.clear();
    capture.values.clear();
    this.snapshots--;
    this.snapshotBytes -= capture.copiedBytes;
    this.captureReservedBytes -= capture.bytes - capture.copiedBytes;
    const retirement = this.createRetirement(capture.handles, () =>
      this.pendingCaptures.delete(capture),
    );
    capture.status = { kind: 'cancelled', retirement, ...(cause === undefined ? {} : { cause }) };
    return ok(retirement);
  }

  private contentLease(
    handles: readonly number[],
    shared: SharedContentSnapshot,
  ): AssetContentLease {
    const { snapshot, borrow } = shared.data;
    shared.holders++;
    let readable = true;
    let retirement: AssetRetirement | undefined;
    return {
      handles,
      read: <T>(reference: number) =>
        readable
          ? borrow<T>(reference)
          : err(failure('asset-reference-invalid', 'a live fixed content lease')),
      version: (reference) =>
        readable
          ? snapshot.version(reference)
          : err(failure('asset-reference-invalid', 'a live fixed content lease')),
      matchesCurrent: () => readable && this.staged === undefined && snapshot.matchesCurrent(),
      retire: () => {
        if (retirement !== undefined) return ok(retirement);
        const conflict = this.custodyConflict();
        if (conflict !== undefined) return err(conflict);
        readable = false;
        retirement = this.createRetirement(handles, () => {
          if (--shared.holders === 0) {
            snapshot.dispose();
            if (this.contentSnapshots.get(shared.root) === shared)
              this.contentSnapshots.delete(shared.root);
          } else {
            this.snapshots--;
          }
        });
        return ok(retirement);
      },
    };
  }

  private custodyConflict(): AssetError | undefined {
    return (
      this.mutationError() ??
      (this.staged === undefined
        ? undefined
        : failure('asset-write-conflict', 'reference custody outside an adoption transaction'))
    );
  }

  private createRetirement(roots: readonly number[], complete?: () => void): AssetRetirement {
    const frames: { readonly dependencies: readonly number[]; index: number }[] = [];
    let pendingRoots = roots;
    let rootIndex = 0;
    let pendingReferences = pendingRoots.length;
    let processedReferences = 0;
    let retiredAssets = 0;
    let retiredBytes = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pendingReferences = 0;
      pendingRoots = [];
      frames.length = 0;
      complete?.();
    };
    if (pendingReferences === 0) finish();
    const inspect = (): AssetRetirementStatus => ({
      done,
      pendingReferences,
      processedReferences,
      retiredAssets,
      retiredBytes,
    });
    return {
      inspect,
      step: (maxReferences) => {
        if (!Number.isSafeInteger(maxReferences) || maxReferences <= 0)
          return err(
            failure('asset-invalid-value', 'a positive safe-integer reference work budget'),
          );
        if (done) return ok(inspect());
        const conflict = this.custodyConflict();
        if (conflict !== undefined) return err(conflict);
        if (this.closed) {
          finish();
          return ok(inspect());
        }
        for (let work = 0; work < maxReferences && pendingReferences > 0; work++) {
          const frame = frames[frames.length - 1];
          const reference = (
            frame === undefined ? pendingRoots[rootIndex] : frame.dependencies[frame.index]
          ) as number;
          const found = this.entry(reference);
          if (!found.ok) return found;
          if (frame === undefined) {
            const protectedCount = this.custodyHolds.get(reference) ?? 0;
            if (protectedCount <= 0)
              return err(
                failure('asset-reference-invalid', 'an unconsumed reference custody token'),
              );
            if (protectedCount === 1) this.custodyHolds.delete(reference);
            else this.custodyHolds.set(reference, protectedCount - 1);
            rootIndex++;
          } else if (++frame.index === frame.dependencies.length) frames.pop();
          pendingReferences--;
          processedReferences++;
          const record = found.value;
          if (--record.holders > 0) continue;
          this.records.delete(reference);
          record.meshPresentation?.release();
          this.bytes -= record.bytes;
          retiredAssets++;
          retiredBytes += record.bytes;
          this.revision++;
          this.changed(reference, []);
          if (record.dependencies.length > 0) {
            frames.push({ dependencies: record.dependencies, index: 0 });
            pendingReferences += record.dependencies.length;
          }
        }
        if (pendingReferences === 0) finish();
        return ok(inspect());
      },
    };
  }

  /** Derive dependents from the authoritative held-reference graph. */
  dependentHandles(handle: number): readonly number[] {
    const found: number[] = [];
    for (const [key, record] of this.records) {
      const candidate =
        this.participatingAdoption?.values.get(key) ?? this.replacements?.get(key) ?? record;
      if (candidate.dependencies.includes(handle)) found.push(key);
    }
    if (this.participatingAdoption !== undefined)
      for (const key of this.participatingAdoption.newIdentities)
        if (this.participatingAdoption.values.get(key)?.dependencies.includes(handle))
          found.push(key);
    return found;
  }

  dependencies(handle: number): Result<readonly number[], AssetError> {
    const found = this.entry(handle);
    return found.ok ? ok(found.value.dependencies) : found;
  }

  /** Borrow a complete live closure for synchronous internal consumers. */
  borrowClosure<T>(
    roots: readonly number[],
    target?: string,
  ): Result<ReadonlyMap<number, T>, AssetError> {
    const selected = this.collectRecords(roots);
    if (!selected.ok) return selected;
    const values = new Map<number, T>();
    for (const [handle, record] of selected.value) {
      if (target !== undefined && record.target !== target) continue;
      const cpu = this.cpuRecord(handle, record);
      if (!cpu.ok) return cpu;
      values.set(handle, cpu.value.value as T);
    }
    return ok(values);
  }

  private collectRecords(
    roots: readonly number[],
    forbidden?: number,
  ): Result<Map<number, RecordEntry>, AssetError> {
    const selected = new Map<number, RecordEntry>();
    const pending = [...roots];
    while (pending.length > 0) {
      const handle = pending.pop() as number;
      if (handle === forbidden)
        return err(failure('asset-reference-invalid', 'an acyclic runtime dependency closure'));
      if (selected.has(handle)) continue;
      const record = this.entry(handle);
      if (!record.ok) return record;
      selected.set(handle, record.value);
      pending.push(...record.value.dependencies);
    }
    return ok(selected);
  }

  private validateDependencies(
    root: number,
    dependencies: readonly number[],
  ): Result<void, AssetError> {
    const selected = this.collectRecords(dependencies, root);
    return selected.ok ? ok(undefined) : selected;
  }

  snapshot(handle: number): Result<AssetSnapshot, AssetError> {
    const captured = this.captureSnapshot(handle);
    return captured.ok ? ok(captured.value.snapshot) : captured;
  }

  borrowVersion<T>(handle: number, revision: number): Result<T, AssetError> {
    const version = this.versions.get(`${handle}:${revision}`);
    return version === undefined
      ? err(failure('asset-reference-invalid', 'a retained exact asset version'))
      : ok(version.value as T);
  }

  /** Prove which live content was captured by this exact owner-issued fixed value. */
  fixedContentRevision(handle: number, revision: number, value: unknown): number | undefined {
    const fixed = this.versions.get(`${handle}:${revision}`);
    if (fixed === undefined || fixed.value !== value) return undefined;
    return fixed.snapshot.version(handle).unwrap();
  }

  /** Shared exact closure for in-flight engine work; acquisition never mints an asset identity. */
  pin<T>(handle: number): Result<AssetVersion<T>, AssetError> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    const found = this.entry(handle);
    if (!found.ok) return found;
    let version = this.pinned.get(handle);
    if (version === undefined || !version.snapshot.matchesCurrent(true)) {
      // A failed snapshot admission retains the predecessor cursor. Its next retry
      // still sees every write; no second journal or per-consumer history is needed.
      const node = this.changes.get(handle),
        precedingRevision = version?.revision;
      const delta: AssetVersionDelta | undefined =
        precedingRevision === undefined || node?.removed
          ? undefined
          : {
              from: precedingRevision,
              fields: [...(node?.fields ?? [])]
                .filter(([, revision]) => revision > precedingRevision)
                .map(([field]) => field),
              ranges: (node?.ranges ?? [])
                .filter((range) => range.revision > precedingRevision)
                .map(({ revision: _revision, ...range }) => range),
            };
      const captured = this.captureSnapshot(handle);
      if (!captured.ok) return captured;
      version?.snapshot.matchesCurrent();
      version = {
        snapshot: captured.value.snapshot,
        value: freezeFixedData(captured.value.value),
        revision: this.revision,
        ...(delta === undefined ? {} : { delta }),
        holds: 0,
      };
      this.pinned.set(handle, version);
      this.versions.set(`${handle}:${version.revision}`, version);
    }
    const pinned = version;
    const lease = (): AssetVersion<T> => {
      pinned.holds++;
      let active = true;
      return {
        handle,
        revision: pinned.revision,
        value: pinned.value as T,
        ...(pinned.delta === undefined ? {} : { delta: pinned.delta }),
        matchesCurrent: () => active && pinned.snapshot.matchesCurrent(true),
        retain: () => {
          if (!active) throw failure('asset-reference-invalid', 'a live fixed content lease');
          return lease();
        },
        dispose: () => {
          if (!active) return;
          active = false;
          if (--pinned.holds !== 0) return;
          pinned.snapshot.dispose();
          this.versions.delete(`${handle}:${pinned.revision}`);
          if (this.pinned.get(handle) === pinned) this.pinned.delete(handle);
        },
      };
    };
    return ok(lease());
  }

  /** Domain-owned copies use their domain byte budget; retain only closure revisions here. */
  captureRevision(handle: number): Result<AssetRevisionGuard, AssetError> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    const closure = this.collectRecords([handle]);
    if (!closure.ok) return closure;
    const versions = new Map<number, { revision: number }>();
    for (const [reference, record] of closure.value)
      versions.set(reference, { revision: record.revision });
    const guard = this.revisionGuard(versions);
    return ok({
      ...guard,
      dispose: () => {
        guard.dispose();
        versions.clear();
      },
    });
  }

  private revisionGuard(
    versions: ReadonlyMap<number, { readonly revision: number }>,
  ): CapturedRevisionGuard {
    let active = true;
    const cursor = this.openCursor();
    let validatedRevision = -1;
    return {
      version: (reference) => {
        const retained = versions.get(reference);
        return active && retained !== undefined
          ? ok(retained.revision)
          : err(failure('asset-reference-invalid', 'a live asset revision reference'));
      },
      matchesCurrent: (preserveChangeEvidence = false) => {
        if (!active || this.closed || this.preparingAdoption || cursor.index < 0) return false;
        if (validatedRevision === this.revision) return true;
        // Key iteration: this runs per guarded consumer every frame, and an
        // entries() walk would allocate one [key, value] pair per reference.
        for (const reference of versions.keys()) {
          const retained = versions.get(reference) as { readonly revision: number };
          if (this.records.get(reference)?.revision !== retained.revision) {
            if (!preserveChangeEvidence) this.closeCursor(cursor);
            return false;
          }
        }
        validatedRevision = this.revision;
        this.acceptCursor(cursor, validatedRevision);
        return true;
      },
      dispose: () => {
        if (!active) return;
        active = false;
        this.closeCursor(cursor);
      },
    };
  }

  private captureSnapshot(
    handle: number,
    selectedRecords?: ReadonlyMap<number, RecordEntry>,
  ): Result<FixedSnapshotData, AssetError> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    const closure =
      selectedRecords === undefined ? this.collectRecords([handle]) : ok(selectedRecords);
    if (!closure.ok) return closure;
    const selected = closure.value;
    let canonical: Map<number, RecordEntry> | undefined;
    let bytes = 0;
    for (const [reference, record] of selected) {
      const cpu = this.cpuRecord(reference, record);
      if (!cpu.ok) return cpu;
      if (cpu.value !== record) {
        canonical ??= new Map();
        canonical.set(reference, cpu.value);
      }
      bytes += cpu.value.bytes;
    }
    if (this.snapshots >= this.limits.maxSnapshots || !this.fits(bytes))
      return err(failure('asset-budget-exceeded', 'available fixed snapshot capacity'));
    const values = new Map<number, { value: unknown; revision: number }>();
    for (const [reference, record] of selected)
      values.set(reference, {
        value: this.copySnapshotContent((canonical?.get(reference) ?? record).value),
        revision: record.revision,
      });
    this.snapshots++;
    this.snapshotBytes += bytes;
    return ok(this.fixedSnapshot(handle, values, bytes));
  }

  /** Accept already owned copies and their existing snapshot accounting; never copies again. */
  private fixedSnapshot(
    handle: number,
    values: Map<number, { readonly value: unknown; readonly revision: number }>,
    bytes: number,
  ): FixedSnapshotData {
    let active = true;
    const borrowed = new Set<number>();
    const guard = this.revisionGuard(values);
    const snapshot: CapturedSnapshot = {
      ...guard,
      read: <T>(reference: number): Result<T, AssetError> => {
        const retained = values.get(reference);
        return active && retained !== undefined
          ? this.capture(retained.value as T)
          : err(failure('asset-reference-invalid', 'a live fixed snapshot reference'));
      },
      dispose: () => {
        if (!active) return;
        active = false;
        guard.dispose();
        values.clear();
        borrowed.clear();
        this.snapshots--;
        this.snapshotBytes -= bytes;
      },
    };
    return {
      snapshot,
      value: values.get(handle)?.value,
      borrow: <T>(reference: number): Result<T, AssetError> => {
        const retained = values.get(reference);
        if (!active || retained === undefined)
          return err(failure('asset-reference-invalid', 'a live captured dependency'));
        if (!borrowed.has(reference)) {
          freezeFixedData(retained.value);
          borrowed.add(reference);
        }
        return ok(retained.value as T);
      },
    };
  }

  observe(): Result<AssetObserver, AssetError> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    if (this.closed) return err(failure('asset-owner-closed', this.identity));
    if (this.observers >= this.limits.maxObservers)
      return err(failure('asset-budget-exceeded', 'available consumer channels'));
    const cursor = this.openCursor();
    this.observers++;
    return ok({
      read: () => {
        const conflict = this.mutationError();
        if (conflict !== undefined) return err(conflict);
        if (cursor.index < 0 || this.closed)
          return err(failure('asset-owner-closed', 'a live consumer channel'));
        if (cursor.revision === this.revision) return EMPTY_READ;
        const revision = this.revision;
        const changes: AssetChange[] = [];
        for (
          let node = this.last;
          node !== undefined && node.revision > cursor.revision;
          node = node.previous
        ) {
          changes.push({
            handle: node.handle as AssetHandle,
            revision: node.revision,
            removed: node.removed,
            fields: [...node.fields]
              .filter(([, changed]) => changed > cursor.revision)
              .map(([field]) => field),
            ranges: node.ranges
              .filter((range) => range.revision > cursor.revision)
              .map(({ path, byteOffset, byteLength, rowBytes, byteStride }) => ({
                path: [...path],
                byteOffset,
                byteLength,
                ...(rowBytes === undefined ? {} : { rowBytes }),
                ...(byteStride === undefined ? {} : { byteStride }),
              })),
          });
        }
        if (changes.length === 0) return EMPTY_READ;
        changes.reverse();
        return ok({
          changes,
          accept: () => {
            const conflict = this.mutationError();
            if (conflict !== undefined) throw conflict;
            this.acceptCursor(cursor, revision);
          },
        });
      },
      dispose: () => {
        if (cursor.index < 0) return;
        this.observers--;
        this.closeCursor(cursor);
      },
    });
  }

  inspect() {
    let adoptionConsumerReferences = 0;
    for (const state of this.pendingAdoptions)
      adoptionConsumerReferences += state.consumerReferences;
    return {
      assets: this.records.size,
      bytes: this.bytes,
      pendingAssets: this.changes.size,
      snapshotBytes: this.snapshotBytes,
      snapshots: this.snapshots,
      observers: this.observers,
      adoptionAssets: this.adoptionIdentities,
      adoptionBytes: this.adoptionBytes,
      adoptions: this.pendingAdoptions.size,
      adoptionConsumerReferences,
    };
  }

  dispose(): void {
    if (this.closed) return;
    const conflict = this.custodyConflict();
    if (conflict !== undefined) throw conflict;
    this.closed = true;
    for (const state of this.pendingAdoptions) {
      state.phase = 'closed';
      state.values.clear();
      state.newIdentities.clear();
      state.expected.clear();
      state.guardRoots.length = 0;
      state.edgeRoots.length = 0;
      state.cleanup = undefined;
      state.bytes = 0;
    }
    this.pendingAdoptions.clear();
    this.adoptionBytes = this.adoptionIdentities = 0;
    for (const capture of this.pendingCaptures) {
      const retired = this.retireContentCapture(capture);
      if (!retired.ok) throw retired.error;
      const closed = retired.value.step(1);
      if (!closed.ok) throw closed.error;
    }
    this.pendingCaptures.clear();
    this.contentSnapshots.clear();
    this.scope = undefined;
    for (const record of this.records.values()) record.meshPresentation?.release();
    this.meshPresenters.clear();
    this.records.clear();
    this.custodyHolds.clear();
    this.pinned.clear();
    this.changes.clear();
    for (const cursor of this.cursors) cursor.index = -1;
    this.cursors.length = 0;
    this.observers = 0;
    this.first = this.last = undefined;
    this.bytes = 0;
    this.retiredPending = 0;
  }

  private openCursor(): Cursor {
    const cursor = { revision: this.revision, index: this.cursors.length };
    this.cursors.push(cursor);
    this.siftUp(cursor.index);
    return cursor;
  }

  private acceptCursor(cursor: Cursor, revision: number): void {
    if (cursor.index < 0 || cursor.revision >= revision) return;
    cursor.revision = revision;
    this.siftDown(cursor.index);
    this.prune();
  }

  private closeCursor(cursor: Cursor): void {
    if (cursor.index < 0) return;
    const index = cursor.index;
    const tail = this.cursors.pop();
    if (tail !== undefined && tail !== cursor) {
      this.cursors[index] = tail;
      tail.index = index;
      this.siftUp(index);
      this.siftDown(tail.index);
    }
    cursor.index = -1;
    this.prune();
  }

  private measureInput(
    input: unknown,
    fieldBytes?: Map<string, number>,
  ): Result<number, AssetError> {
    try {
      return ok(assetDataBytes(input, fieldBytes));
    } catch (cause) {
      return err(
        failure('asset-invalid-value', cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  private capture<T>(
    input: T,
    storage: 'copy' | 'take' | 'detached' = 'copy',
  ): Result<T, AssetError> {
    try {
      const copy = storage === 'detached' ? copyAssetData : this.copySnapshotContent;
      return ok(storage === 'take' ? takeAssetData(input) : copy(input));
    } catch (cause) {
      return err(
        failure('asset-invalid-value', cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  private cpuEntry(handle: number): Result<RecordEntry, AssetError> {
    const found = this.entry(handle);
    return found.ok ? this.cpuRecord(handle, found.value) : found;
  }

  private cpuRecord(handle: number, record: RecordEntry): Result<RecordEntry, AssetError> {
    if (record.meshPresentation !== undefined)
      return err(meshCpuUnavailable(handle, record.revision));
    if (
      record.target !== 'mesh' ||
      (record.value as MeshAsset).attributeStorage !== 'static-streams'
    )
      return ok(record);
    const canonical = interleavedMesh(record.value as MeshAsset);
    // The committed CPU owner can now edit canonical rows. This changes storage
    // only; exact render receipts still refer to this same geometry revision.
    // A participating immutable adoption may only borrow its private view.
    const fields = new Map<string, number>();
    const bytes = assetDataBytes(canonical, fields) + 8 * record.dependencies.length;
    if (this.records.get(handle) !== record)
      return ok({ ...record, value: canonical, bytes, fieldBytes: fields });
    this.bytes += bytes - record.bytes;
    record.bytes = bytes;
    record.value = canonical;
    for (const [field, size] of fields) record.fieldBytes.set(field, size);
    return ok(record);
  }

  private entry(handle: number): Result<RecordEntry, AssetError> {
    if (this.closed) return err(failure('asset-owner-closed', this.identity));
    const record =
      this.participatingAdoption?.values.get(handle) ??
      this.replacements?.get(handle) ??
      this.records.get(handle);
    return record === undefined
      ? err(failure('asset-reference-invalid', `a live reference owned by ${this.identity}`))
      : ok(record);
  }

  private fits(additional: number): boolean {
    return (
      this.bytes +
        this.snapshotBytes +
        this.captureReservedBytes +
        this.candidateBytes +
        this.adoptionBytes +
        additional <=
      this.limits.maxBytes
    );
  }

  private changed(handle: number, fields: readonly string[], range?: AssetRange): void {
    if (this.cursors.length === 0) return;
    let node = this.changes.get(handle);
    if (node === undefined) {
      node = {
        handle,
        revision: this.revision,
        removed: false,
        fields: new Map(),
        ranges: [],
        previous: undefined,
        next: undefined,
      };
      this.changes.set(handle, node);
    } else this.unlink(node);
    node.revision = this.revision;
    node.removed = !this.records.has(handle);
    if (node.removed) {
      this.retiredPending++;
      node.fields.clear();
      node.ranges.length = 0;
    }
    for (const field of fields) node.fields.set(field, this.revision);
    if (range !== undefined) {
      let start = range.byteOffset;
      let end = start + range.byteLength;
      for (let index = node.ranges.length - 1; index >= 0; index--) {
        const prior = node.ranges[index] as AssetRange;
        if (
          prior.byteStride !== undefined ||
          range.byteStride !== undefined ||
          prior.path.length !== range.path.length ||
          !prior.path.every((key, index) => key === range.path[index])
        )
          continue;
        const priorEnd = prior.byteOffset + prior.byteLength;
        if (priorEnd < start || end < prior.byteOffset) continue;
        start = Math.min(start, prior.byteOffset);
        end = Math.max(end, priorEnd);
        node.ranges.splice(index, 1);
      }
      node.ranges.push({
        path: [...range.path],
        byteOffset: start,
        byteLength: end - start,
        ...(range.rowBytes === undefined ? {} : { rowBytes: range.rowBytes }),
        ...(range.byteStride === undefined ? {} : { byteStride: range.byteStride }),
        revision: this.revision,
      });
      if (node.ranges.length > this.limits.maxRanges) {
        for (const entry of node.ranges) node.fields.set(entry.path[0] ?? '', this.revision);
        node.ranges.length = 0;
      }
    }
    node.previous = this.last;
    if (this.last === undefined) this.first = node;
    else this.last.next = node;
    this.last = node;
  }

  private unlink(node: ChangeNode): void {
    if (node.previous === undefined) this.first = node.next;
    else node.previous.next = node.next;
    if (node.next === undefined) this.last = node.previous;
    else node.next.previous = node.previous;
    node.previous = node.next = undefined;
  }

  private prune(): void {
    const accepted = this.cursors[0]?.revision ?? this.revision;
    while (this.first !== undefined && this.first.revision <= accepted) {
      const node = this.first;
      this.unlink(node);
      this.changes.delete(node.handle);
      if (node.removed) this.retiredPending--;
    }
  }

  private swap(a: number, b: number): void {
    const left = this.cursors[a] as Cursor;
    const right = this.cursors[b] as Cursor;
    this.cursors[a] = right;
    this.cursors[b] = left;
    right.index = a;
    left.index = b;
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if ((this.cursors[parent] as Cursor).revision <= (this.cursors[index] as Cursor).revision)
        return;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(index: number): void {
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.cursors.length) return;
      const right = left + 1;
      const child =
        right < this.cursors.length &&
        (this.cursors[right] as Cursor).revision < (this.cursors[left] as Cursor).revision
          ? right
          : left;
      if ((this.cursors[index] as Cursor).revision <= (this.cursors[child] as Cursor).revision)
        return;
      this.swap(index, child);
      index = child;
    }
  }
}
