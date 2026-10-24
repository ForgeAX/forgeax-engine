import {
  ASSET_ERROR_HINTS,
  type Asset,
  AssetError,
  type AssetErrorCode,
  type AssetHandle,
  type AssetReferenceOwner,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { assetDataBytes, assetFieldBytes, copyAssetData } from './asset-data';

export interface PreparedAssetContent<T = unknown> {
  readonly value: T;
  readonly dependencies?: readonly number[];
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

interface RecordEntry {
  readonly target: string;
  value: unknown;
  readonly fieldBytes: Map<string, number>;
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

/** The private record storage of one AssetRegistry, not another public asset service. */
export class AssetRecords implements AssetReferenceOwner {
  readonly identity = `assets-${identities.realm}-${++identities.owner}`;
  private readonly records = new Map<number, RecordEntry>();
  private readonly changes = new Map<number, ChangeNode>();
  private readonly cursors: Cursor[] = [];
  private readonly pinned = new Map<number, PinnedVersion>();
  private readonly versions = new Map<string, PinnedVersion>();
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
  private replacements: Map<number, RecordEntry> | undefined;
  private candidateBytes = 0;
  private scope: object | undefined;

  constructor(limits: AssetLimits = {}) {
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
    return this.preparingAdoption
      ? failure('asset-write-conflict', 'runtime mutation outside atomic asset preparation')
      : undefined;
  }

  private admissionError(newIdentity: boolean): AssetError | undefined {
    if (this.closed) return failure('asset-owner-closed', this.identity);
    if (this.revision >= Number.MAX_SAFE_INTEGER - this.limits.maxAssets)
      return failure('asset-budget-exceeded', 'available content revisions');
    if (
      newIdentity &&
      (this.records.size + this.retiredPending >= this.limits.maxAssets ||
        identities.reference >= 0xffff_ffff)
    )
      return failure('asset-budget-exceeded', 'available asset identity capacity');
    return undefined;
  }

  attach(scope: object): Result<void, AssetError> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    if (this.closed) return err(failure('asset-owner-closed', this.identity));
    if (this.scope !== undefined && this.scope !== scope)
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

  /** Complete replacements join the active adoption or own a single synchronous adoption. */
  adopt<Target extends string, T, E = never>(
    target: Target,
    input: T,
    dependencies: readonly number[] = [],
    prepare?: (owned: T) => Result<PreparedAssetContent, E>,
    replacing?: AssetHandle<Target>,
  ): Result<AssetHandle<Target>, AssetError | E> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    if (replacing !== undefined && this.staged === undefined)
      return this.adoptClosure(() => this.adopt(target, input, dependencies, prepare, replacing));
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
    const captured = this.capture(input);
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
    const bytes = assetDataBytes(prepared.value.value) + held.length * 8;
    if (!this.fits(bytes))
      return err(failure('asset-budget-exceeded', 'available prepared content bytes'));
    for (const handle of held) {
      const found = this.entry(handle);
      if (!found.ok) return found;
    }
    const handle = replacing ?? (++identities.reference as AssetHandle<Target>);
    for (const dependency of held) this.retain(dependency).unwrap();
    const value = prepared.value.value;
    const fields = objectFields(value);
    const record: RecordEntry = {
      target,
      value,
      fieldBytes: new Map(
        Object.entries(fields).map(([key, child]) => [
          key,
          assetFieldBytes(key, assetDataBytes(child)),
        ]),
      ),
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
    else this.changed(handle, Object.keys(fields));
    return ok(handle);
  }

  /** Adopt a prepared source closure synchronously, publishing only a successful whole. */
  adoptClosure<T, E>(
    adopt: () => Result<T, E>,
    beforeCommit?: () => void,
  ): Result<T, AssetError | E> {
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
      // Acceptance may inspect candidate content and retain it for new consumers.
      // A thrown failure rolls back the candidate before any change is published.
      beforeCommit?.();
      const retired: RecordEntry[] = [];
      if (replacements.size > 0) this.revision++;
      for (const [handle, record] of replacements) {
        const previous = this.records.get(handle) as RecordEntry;
        record.holders = previous.holders;
        record.revision = this.revision;
        this.records.set(handle, record);
        this.bytes += record.bytes - previous.bytes;
        retired.push(previous);
        this.changed(handle, [
          ...new Set([...previous.fieldBytes.keys(), ...record.fieldBytes.keys()]),
        ]);
      }
      for (const handle of staged) {
        const record = this.records.get(handle);
        if (record !== undefined) {
          record.revision = this.revision;
          this.changed(handle, Object.keys(objectFields(record.value)));
        }
      }
      this.replacements = undefined;
      this.candidateBytes = 0;
      for (const previous of retired)
        for (const dependency of previous.dependencies) this.release(dependency).unwrap();
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

  /** A public read is an independently owned value, including every binary view. */
  read<T>(handle: number): Result<T, AssetError> {
    const found = this.entry(handle);
    return found.ok ? this.capture(found.value.value as T) : found;
  }

  copy<K extends string, P>(handle: AssetHandle<K, P>): Result<AssetHandle<K, P>, AssetError> {
    const found = this.entry(handle);
    if (!found.ok) return found;
    return this.create(found.value.target, found.value.value, found.value.dependencies) as Result<
      AssetHandle<K, P>,
      AssetError
    >;
  }

  /** Internal synchronous consumption only. Do not retain this value across a write boundary. */
  borrow<T>(handle: number): Result<T, AssetError> {
    const found = this.entry(handle);
    return found.ok ? ok(found.value.value as T) : found;
  }

  /** The same accepted asset reader is used by local and published consumers. */
  resolveAsset<T = Asset>(handle: number, revision?: number): Result<T, AssetError> {
    return revision === undefined
      ? this.borrow<T>(handle)
      : this.borrowVersion<T>(handle, revision);
  }

  /** Internal lease-accounting evidence for atomic domain admission and rollback. */
  refcount(handle: number): number {
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
      (!options.replace || objectField !== undefined || this.replacements?.has(handle))
    )
      return err(failure('asset-write-conflict', 'one complete replacement per asset adoption'));
    let { dependencies } = options;
    const found = this.entry(handle);
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
      this.replacements.set(handle, {
        target: record.target,
        value: patch,
        fieldBytes: new Map([...sizes].filter(([field]) => Object.hasOwn(patch, field))),
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
    for (const field of fields) {
      if (!Object.hasOwn(patch, field)) {
        delete current[field];
        if (objectField === undefined) record.fieldBytes.delete(field);
        continue;
      }
      Object.defineProperty(current, field, {
        value: patch[field],
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (objectField === undefined) record.fieldBytes.set(field, sizes.get(field) ?? 0);
    }
    if (objectField !== undefined)
      record.fieldBytes.set(objectField, (record.fieldBytes.get(objectField) ?? 0) + contentDelta);
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
    if (this.staged !== undefined)
      return err(failure('asset-write-conflict', 'range writes outside a closure replacement'));
    const found = this.entry(handle);
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
      const entry = this.entry(update.handle);
      if (!entry.ok) return entry;
      const value = entry.value.value;
      if (!isObjectFields(value))
        return err(failure('asset-invalid-value', 'object content with an unchanged kind'));
      const { writes, fieldWrites = [] } = update.ranges;
      rangeCount += writes.length + fieldWrites.length;
      if (rangeCount > this.limits.maxRanges)
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
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    const valid = this.validate(handle, target);
    if (!valid.ok || handle === 0) return valid;
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
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    if (handle === 0) return ok(undefined);
    const found = this.entry(handle);
    if (!found.ok) return found;
    const pending = [handle];
    while (pending.length > 0) {
      const retired = pending.pop() as number;
      const record = this.records.get(retired) as RecordEntry;
      if (--record.holders > 0) continue;
      this.records.delete(retired);
      this.bytes -= record.bytes;
      this.revision++;
      if (!this.staged?.has(retired)) this.changed(retired, []);
      for (const dependency of record.dependencies) pending.push(dependency);
    }
    return ok(undefined);
  }

  dependencies(handle: number): Result<readonly number[], AssetError> {
    const found = this.entry(handle);
    return found.ok ? ok(found.value.dependencies) : found;
  }

  /** Borrow a complete live closure for synchronous internal consumers. */
  borrowClosure<T>(roots: readonly number[]): Result<ReadonlyMap<number, T>, AssetError> {
    const selected = this.collectRecords(roots);
    return selected.ok
      ? ok(new Map([...selected.value].map(([handle, record]) => [handle, record.value as T])))
      : selected;
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
    return {
      version: (reference) => {
        const retained = versions.get(reference);
        return active && retained !== undefined
          ? ok(retained.revision)
          : err(failure('asset-reference-invalid', 'a live asset revision reference'));
      },
      matchesCurrent: (preserveChangeEvidence = false) => {
        if (!active || this.closed || this.preparingAdoption || cursor.index < 0) return false;
        // Key iteration: this runs per guarded consumer every frame, and an
        // entries() walk would allocate one [key, value] pair per reference.
        for (const reference of versions.keys()) {
          const retained = versions.get(reference) as { readonly revision: number };
          if (this.records.get(reference)?.revision !== retained.revision) {
            if (!preserveChangeEvidence) this.closeCursor(cursor);
            return false;
          }
        }
        this.acceptCursor(cursor, this.revision);
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
  ): Result<{ snapshot: CapturedSnapshot; value: unknown }, AssetError> {
    const conflict = this.mutationError();
    if (conflict !== undefined) return err(conflict);
    const closure = this.collectRecords([handle]);
    if (!closure.ok) return closure;
    const selected = closure.value;
    let bytes = 0;
    for (const record of selected.values()) bytes += record.bytes;
    if (this.snapshots >= this.limits.maxSnapshots || !this.fits(bytes))
      return err(failure('asset-budget-exceeded', 'available fixed snapshot capacity'));
    const values = new Map<number, { value: unknown; revision: number }>();
    for (const [reference, record] of selected)
      values.set(reference, {
        value: copyAssetData(record.value),
        revision: record.revision,
      });
    this.snapshots++;
    this.snapshotBytes += bytes;
    let active = true;
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
        this.snapshots--;
        this.snapshotBytes -= bytes;
      },
    };
    return ok({ snapshot, value: values.get(handle)?.value });
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
          accept: () => this.acceptCursor(cursor, revision),
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
    return {
      assets: this.records.size,
      bytes: this.bytes,
      pendingAssets: this.changes.size,
      snapshotBytes: this.snapshotBytes,
      snapshots: this.snapshots,
      observers: this.observers,
    };
  }

  dispose(): void {
    if (this.closed) return;
    const conflict = this.mutationError();
    if (conflict !== undefined) throw conflict;
    this.closed = true;
    this.scope = undefined;
    this.records.clear();
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

  private measureInput(input: unknown): Result<number, AssetError> {
    try {
      return ok(assetDataBytes(input));
    } catch (cause) {
      return err(
        failure('asset-invalid-value', cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  private capture<T>(input: T): Result<T, AssetError> {
    try {
      return ok(copyAssetData(input));
    } catch (cause) {
      return err(
        failure('asset-invalid-value', cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  private entry(handle: number): Result<RecordEntry, AssetError> {
    if (this.closed) return err(failure('asset-owner-closed', this.identity));
    const record = this.replacements?.get(handle) ?? this.records.get(handle);
    return record === undefined
      ? err(failure('asset-reference-invalid', `a live reference owned by ${this.identity}`))
      : ok(record);
  }

  private fits(additional: number): boolean {
    return (
      this.bytes + this.snapshotBytes + this.candidateBytes + additional <= this.limits.maxBytes
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
