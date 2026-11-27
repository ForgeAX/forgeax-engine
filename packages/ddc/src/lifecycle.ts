import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type DdcEntry,
  type DdcEntryInput,
  DdcEntryStore,
  type StagedDdcEntry,
} from './entry-store.js';
import { DdcStoreError } from './errors.js';
import { canonicalDdcJson } from './key.js';

export type DdcLifecycleState = 'missing' | 'cooking' | 'current' | 'stale' | 'failed';

export interface DdcLease {
  readonly guid: string;
  readonly desiredKey: string;
  readonly attempt: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly instanceId: string;
  readonly expiresAt: number;
}

export interface DdcHead {
  readonly guid: string;
  readonly desiredKey: string;
  readonly state: DdcLifecycleState;
  readonly currentKey: string | undefined;
  readonly lastKnownGoodKey: string | undefined;
  readonly revision?: number;
  readonly generation?: number;
  readonly activeLease?: DdcLease;
  readonly failure?: { readonly code: string; readonly detail: string };
}

export interface DdcCurrentEntry {
  readonly head: DdcHead;
  readonly entry: DdcEntry | null;
}

export type DdcCommitResult =
  | {
      readonly result: 'current';
      /** The head accepted by this CAS, independent of later writers. */
      readonly head: DdcHead;
      readonly restoreFence: DdcRestoreFence;
    }
  | {
      readonly result: 'invalid';
      readonly key: string;
      readonly revision: number;
      readonly restoreFence: DdcRestoreFence;
    }
  | {
      readonly result: 'stale' | 'lease-lost';
      readonly key: string;
      readonly revision: number;
    };

export interface DdcRestoreFence {
  readonly attempt: string;
  readonly generation: number;
  readonly revision: number;
  readonly desiredKey: string;
  readonly outcome: 'current' | 'invalid' | 'failed';
  readonly key?: string;
  readonly currentKey?: string;
  readonly lastKnownGoodKey?: string;
  readonly failure?: { readonly code: string; readonly detail: string };
}

export interface DdcRestoreResult {
  readonly result: 'restored' | 'not-owner';
  readonly revision: number;
  readonly generation?: number;
}

export type DdcRollbackSnapshot = Omit<DdcHead, 'activeLease'>;

export interface DdcBeginResult {
  readonly lease: DdcLease;
  readonly previousHead: DdcRollbackSnapshot;
}

export interface DdcPublicationAttempt extends DdcBeginResult {
  commit(): Promise<DdcCommitResult>;
  discard(): Promise<void>;
  restore(): Promise<DdcRestoreResult>;
}

interface HeadRecord {
  readonly guid: string;
  readonly desiredKey: string;
  readonly revision: number;
  readonly currentKey?: string;
  readonly lastKnownGoodKey?: string;
  readonly generation?: number;
  readonly active?: DdcLease;
  readonly stale?: boolean;
  readonly empty?: boolean;
  readonly failure?: {
    readonly desiredKey: string;
    readonly code: string;
    readonly detail: string;
  };
}

interface GenerationRecord {
  readonly schemaVersion: 'forgeax-ddc-generation/v2';
  readonly next: number;
}

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const LEASE_TTL_MS = 30_000;

function headFile(heads: string, guid: string): string {
  return join(heads, `${encodeURIComponent(guid)}.json`);
}

function lockFile(root: string, name: string): string {
  return join(root, 'locks', `${encodeURIComponent(name)}.lock`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isLeaseRecord(value: unknown): value is DdcLease {
  if (!isRecord(value)) return false;
  return (
    isString(value.guid) &&
    isString(value.desiredKey) &&
    isString(value.attempt) &&
    isNonNegativeInteger(value.generation) &&
    isNonNegativeInteger(value.expectedRevision) &&
    isString(value.instanceId) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  );
}

function isHeadRecord(value: unknown): value is HeadRecord {
  if (!isRecord(value)) return false;
  if (
    !isString(value.guid) ||
    !isString(value.desiredKey) ||
    !isNonNegativeInteger(value.revision)
  ) {
    return false;
  }
  if (value.currentKey !== undefined && !isString(value.currentKey)) return false;
  if (value.lastKnownGoodKey !== undefined && !isString(value.lastKnownGoodKey)) return false;
  if (
    value.generation !== undefined &&
    (!isNonNegativeInteger(value.generation) || value.generation === 0)
  ) {
    return false;
  }
  if (value.active !== undefined && !isLeaseRecord(value.active)) return false;
  if (value.stale !== undefined && typeof value.stale !== 'boolean') return false;
  if (value.empty !== undefined && typeof value.empty !== 'boolean') return false;
  if (value.failure !== undefined) {
    if (!isRecord(value.failure)) return false;
    if (
      !isString(value.failure.desiredKey) ||
      !isString(value.failure.code) ||
      !isString(value.failure.detail)
    ) {
      return false;
    }
  }
  return true;
}

function malformedHeadError(
  actual: 'syntax-invalid' | 'schema-invalid' | 'unreadable',
): DdcStoreError {
  const detail =
    actual === 'syntax-invalid'
      ? 'DDC head JSON is syntactically invalid'
      : actual === 'schema-invalid'
        ? 'DDC head record does not match the lifecycle schema'
        : 'DDC head file is not readable';
  return new DdcStoreError({
    code: 'ddc-head-conflict',
    detail,
    expected: 'a valid DDC head record',
    actual,
    hint: 'inspect the current head and retry with a fresh revision',
    owner: 'engine-ddc',
    rootKind: 'project-ddc',
    recoveryActions: [
      { kind: 'inspect', executable: true },
      { kind: 'retry', executable: true },
    ],
  });
}

/** Cross-process mkdir lock; a lock owned by a dead PID is reclaimable. */
export async function withDdcLock<T>(
  root: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = lockFile(root, name);
  await mkdir(join(root, 'locks'), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(path);
      await writeFile(
        join(path, 'owner.json'),
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      );
      try {
        return await operation();
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      let ownerPid: number | undefined;
      try {
        ownerPid = (
          JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { pid?: number }
        ).pid;
      } catch {
        ownerPid = undefined;
      }
      // mkdir() publishes the lock directory before the owner record can be
      // written. Treat that short publication window as an in-flight lock,
      // not as a dead owner: reclaiming it here lets two processes enter the
      // same critical section and loses the superseded-attempt fence.
      if (ownerPid === undefined) {
        if (Date.now() >= deadline) {
          throw new DdcStoreError({
            code: 'ddc-lease-expired',
            detail: `DDC lock ${name} did not publish an owner record`,
            hint: 'inspect the lock owner and retry after the incomplete instance exits',
            expected: 'a lock owner record',
            actual: { path },
            rootKind: 'project-ddc',
          });
        }
        await delay(LOCK_WAIT_MS);
        continue;
      }
      let alive = false;
      try {
        process.kill(ownerPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (!alive) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new DdcStoreError({
          code: 'ddc-lease-expired',
          detail: `DDC lock ${name} remained owned by process ${ownerPid}`,
          hint: 'inspect the owner and retry after the stale instance exits',
          expected: 'an available project lock',
          actual: { ownerPid },
          rootKind: 'project-ddc',
          lease: String(ownerPid),
        });
      }
      await delay(LOCK_WAIT_MS);
    }
  }
}

export class DdcLifecycle {
  private readonly heads: string;
  private readonly entries: DdcEntryStore;
  private readonly root: string;
  private readonly leaseTtlMs: number;

  public constructor(root: string, options?: { readonly leaseTtlMs?: number }) {
    this.root = root;
    this.heads = join(root, 'heads');
    this.entries = new DdcEntryStore(root);
    this.leaseTtlMs = options?.leaseTtlMs ?? LEASE_TTL_MS;
  }

  public async inspect(guid: string, desiredKey: string): Promise<DdcHead> {
    const record = await this.read(guid);
    return this.projectHead(guid, desiredKey, record);
  }

  /** Read the accepted entry for a GUID without making callers reconstruct head paths. */
  public async readCurrentEntry(guid: string): Promise<DdcCurrentEntry> {
    const record = await this.read(guid);
    const checked =
      record?.currentKey === undefined ? null : await this.entries.readChecked(record.currentKey);
    const head = this.projectValidatedHead(guid, record?.desiredKey ?? '', record, checked);
    const entry = head.state === 'current' && checked?.ok === true ? checked.value : null;
    if (entry === null) return { head, entry: null };
    // Integrity owns the complete immutable read. Fence its head after that work,
    // without rereading the same artifact closure or acquiring a publication lease.
    return withDdcLock(this.root, `head-${guid}`, async () =>
      canonicalDdcJson(await this.read(guid)) === canonicalDdcJson(record)
        ? { head, entry }
        : { head: { ...head, state: 'stale' }, entry: null },
    );
  }

  /** Stage one immutable entry while keeping its publication lease alive. */
  public async stagePublication(entry: DdcEntryInput): Promise<DdcPublicationAttempt> {
    const { lease: initialLease, previousHead } = await this.beginWithSnapshot(
      entry.guid,
      entry.key,
    );
    let lease = initialLease;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fence: DdcRestoreFence | undefined;
    let committing: Promise<DdcCommitResult> | undefined;
    const stop = () => {
      active = false;
      clearTimeout(timer);
    };
    const heartbeat = () => {
      timer = setTimeout(
        () => {
          if (!active) return;
          void this.heartbeat(lease)
            .then((updated) => {
              if (!active) return;
              lease = updated;
              heartbeat();
            })
            .catch(() => {});
        },
        Math.max(1, Math.floor((lease.expiresAt - Date.now()) / 2)),
      );
      timer.unref?.();
    };
    const fail = (code: string, cause: unknown) =>
      this.fail(lease, { code, detail: cause instanceof Error ? cause.message : String(cause) });
    heartbeat();
    let staged: StagedDdcEntry;
    try {
      staged = await this.entries.stage(entry);
    } catch (cause) {
      stop();
      await fail('ddc-entry-stage-failed', cause);
      throw cause;
    }
    const discardStaging = () => this.entries.discard(staged);
    return {
      get lease() {
        return lease;
      },
      previousHead,
      commit: async () => {
        if (committing !== undefined || !active)
          throw new Error('DDC publication attempt is closed');
        committing = (async () => {
          try {
            const result = await this.commit(lease, entry.key, staged);
            if (result.result === 'current' || result.result === 'invalid')
              fence = result.restoreFence;
            return result;
          } catch (cause) {
            stop();
            try {
              fence = await fail('ddc-entry-publish-failed', cause);
            } finally {
              await discardStaging().catch(() => {});
            }
            throw cause;
          } finally {
            stop();
          }
        })();
        return committing;
      },
      discard: async () => {
        if (!active) return;
        stop();
        try {
          await this.discard(lease);
        } finally {
          // Let an in-flight immutable write finish before removing its staging.
          if (committing !== undefined) await committing.catch(() => {});
          await discardStaging();
        }
      },
      restore: async () => {
        stop();
        if (committing !== undefined) await committing.catch(() => {});
        try {
          return await this.restoreIfCurrent(previousHead, lease, fence);
        } finally {
          await discardStaging().catch(() => {});
        }
      },
    };
  }

  /** Begin a lease and capture the accepted rollback snapshot under one head lock. */
  public async beginWithSnapshot(guid: string, desiredKey: string): Promise<DdcBeginResult> {
    return withDdcLock(this.root, `head-${guid}`, async () => {
      const previous = await this.read(guid);
      const previousHead = await this.projectHead(guid, desiredKey, previous, false);
      const generation = await this.allocateGeneration(previous?.generation ?? 0);
      const lease: DdcLease = {
        guid,
        desiredKey,
        attempt: randomUUID(),
        generation,
        expectedRevision: previous?.revision ?? 0,
        instanceId: `${process.pid}:${randomUUID()}`,
        expiresAt: Date.now() + this.leaseTtlMs,
      };
      const lastKnownGoodKey =
        previous?.currentKey !== undefined && previous.currentKey !== desiredKey
          ? previous.currentKey
          : previous?.lastKnownGoodKey;
      await this.write({
        guid,
        desiredKey,
        revision: previous?.revision ?? 0,
        generation,
        active: lease,
        ...(previous?.currentKey === undefined ? {} : { currentKey: previous.currentKey }),
        ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
      });
      return { lease, previousHead };
    });
  }

  public async begin(guid: string, desiredKey: string): Promise<DdcLease> {
    return (await this.beginWithSnapshot(guid, desiredKey)).lease;
  }

  public async commit(
    lease: DdcLease,
    validatedKey: string,
    staged?: StagedDdcEntry,
  ): Promise<DdcCommitResult> {
    // Immutable bytes can be validated without holding the mutable head lock.
    // Keep heartbeats runnable, then fence the live head after all expensive work.
    const entry =
      staged === undefined
        ? await this.entries.read(validatedKey)
        : await this.entries.publishForCommit(staged);
    return withDdcLock(this.root, `head-${lease.guid}`, async () => {
      const current = await this.read(lease.guid);
      const active = current?.active;
      if (current === null || active === undefined || active.attempt !== lease.attempt) {
        return { result: 'lease-lost', key: validatedKey, revision: current?.revision ?? 0 };
      }
      // The persisted active lease is the authority. The caller may still hold
      // an older token while a publication heartbeat has already refreshed the
      // same attempt in the head.
      if (Date.now() > active.expiresAt) {
        throw new DdcStoreError({
          code: 'ddc-lease-expired',
          detail: 'cook lease expired before commit fencing',
          expected: { attempt: lease.attempt, revision: lease.expectedRevision },
          actual: { revision: current.revision },
          owner: 'engine-ddc',
          rootKind: 'project-ddc',
          generation: lease.generation,
          lease: lease.attempt,
          revision: current.revision,
        });
      }
      if (
        current.revision !== lease.expectedRevision ||
        current.desiredKey !== lease.desiredKey ||
        validatedKey !== lease.desiredKey
      ) {
        await this.write({ ...current, stale: true });
        return { result: 'stale', key: validatedKey, revision: current.revision };
      }
      if (entry === null || entry.guid !== lease.guid || entry.receipt.key !== validatedKey) {
        const restoreFence = await this.writeFailureHead(lease, current, 'invalid', {
          code: 'entry-invalid',
          detail: 'validated DDC key has no readable entry for this asset',
        });
        return {
          result: 'invalid',
          key: validatedKey,
          revision: restoreFence.revision,
          restoreFence,
        };
      }
      const lastKnownGoodKey =
        current.currentKey !== undefined && current.currentKey !== validatedKey
          ? current.currentKey
          : current.lastKnownGoodKey;
      const nextRevision = current.revision + 1;
      const accepted = {
        guid: lease.guid,
        desiredKey: lease.desiredKey,
        revision: nextRevision,
        generation: lease.generation,
        currentKey: validatedKey,
        stale: false,
        ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
      } satisfies HeadRecord;
      await this.write(accepted);
      return {
        result: 'current',
        head: {
          guid: accepted.guid,
          desiredKey: accepted.desiredKey,
          state: 'current',
          currentKey: accepted.currentKey,
          lastKnownGoodKey: accepted.lastKnownGoodKey,
          revision: accepted.revision,
          generation: accepted.generation,
        },
        restoreFence: {
          attempt: lease.attempt,
          generation: lease.generation,
          revision: nextRevision,
          desiredKey: lease.desiredKey,
          outcome: 'current',
          key: validatedKey,
          currentKey: validatedKey,
          ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
        },
      };
    });
  }

  public async fail(
    lease: DdcLease,
    failure: { readonly code: string; readonly detail: string },
  ): Promise<DdcRestoreFence | undefined> {
    return withDdcLock(this.root, `head-${lease.guid}`, async () => {
      const current = await this.read(lease.guid);
      if (current?.active?.attempt !== lease.attempt) return;
      return this.writeFailureHead(lease, current, 'failed', failure);
    });
  }

  private async writeFailureHead(
    lease: DdcLease,
    current: HeadRecord,
    outcome: 'invalid' | 'failed',
    failure: { readonly code: string; readonly detail: string },
  ): Promise<DdcRestoreFence> {
    const { guid, attempt, desiredKey, generation } = lease;
    const locator = {
      desiredKey,
      generation,
      revision: current.revision + 1,
      ...(outcome === 'failed' && current.currentKey !== undefined
        ? { currentKey: current.currentKey }
        : {}),
      ...(current.lastKnownGoodKey === undefined
        ? {}
        : { lastKnownGoodKey: current.lastKnownGoodKey }),
    };
    await this.write({ guid, ...locator, failure: { desiredKey, ...failure } });
    return { attempt, ...locator, outcome, failure };
  }

  public async heartbeat(lease: DdcLease): Promise<DdcLease> {
    return withDdcLock(this.root, `head-${lease.guid}`, async () => {
      const current = await this.read(lease.guid);
      if (
        current?.active?.attempt !== lease.attempt ||
        current.revision !== lease.expectedRevision ||
        current.desiredKey !== lease.desiredKey ||
        Date.now() > current.active.expiresAt
      ) {
        throw new DdcStoreError({
          code: 'ddc-lease-expired',
          detail: 'heartbeat requires the current unexpired cook lease',
          expected: lease.attempt,
          actual: current?.active?.attempt,
          lease: lease.attempt,
          generation: lease.generation,
          rootKind: 'project-ddc',
        });
      }
      const refreshed = { ...current.active, expiresAt: Date.now() + this.leaseTtlMs };
      await this.write({ ...current, active: refreshed });
      return refreshed;
    });
  }

  public async discard(lease: DdcLease): Promise<void> {
    await withDdcLock(this.root, `head-${lease.guid}`, async () => {
      const current = await this.read(lease.guid);
      if (current?.active?.attempt !== lease.attempt) return;
      const { active: _active, ...withoutActive } = current;
      await this.write({
        ...withoutActive,
        revision: current.revision + 1,
        generation: lease.generation,
        stale: current.currentKey === undefined,
      });
    });
  }

  /** Restore only when this exact attempt still owns the mutable head. */
  public async restoreIfCurrent(
    snapshot: DdcRollbackSnapshot,
    lease: DdcLease,
    fence?: DdcRestoreFence,
  ): Promise<DdcRestoreResult> {
    return withDdcLock(this.root, `head-${lease.guid}`, async () => {
      const current = await this.read(lease.guid);
      if (current === null || current.guid !== snapshot.guid) {
        return {
          result: 'not-owner',
          revision: current?.revision ?? 0,
          ...(current?.generation === undefined ? {} : { generation: current.generation }),
        };
      }
      const ownsActive =
        current.active?.attempt === lease.attempt &&
        current.active.generation === lease.generation &&
        current.active.desiredKey === lease.desiredKey;
      const ownsTerminal = fence !== undefined && this.matchesRestoreFence(current, lease, fence);
      if (!ownsActive && !ownsTerminal) {
        return {
          result: 'not-owner',
          revision: current.revision,
          ...(current.generation === undefined ? {} : { generation: current.generation }),
        };
      }

      const nextRevision = current.revision + 1;
      const generation = Math.max(
        current.generation ?? 0,
        lease.generation,
        snapshot.generation ?? 0,
      );
      const restored: HeadRecord = {
        guid: snapshot.guid,
        desiredKey: snapshot.desiredKey,
        revision: nextRevision,
        generation,
        ...(snapshot.currentKey === undefined ? {} : { currentKey: snapshot.currentKey }),
        ...(snapshot.lastKnownGoodKey === undefined
          ? {}
          : { lastKnownGoodKey: snapshot.lastKnownGoodKey }),
        ...(snapshot.state === 'missing' ? { empty: true } : {}),
        ...(snapshot.state === 'stale' ? { stale: true } : {}),
        ...(snapshot.failure === undefined
          ? {}
          : { failure: { desiredKey: snapshot.desiredKey, ...snapshot.failure } }),
      };
      await this.write(restored);
      return { result: 'restored', revision: nextRevision, generation };
    });
  }

  private matchesRestoreFence(
    current: HeadRecord,
    lease: DdcLease,
    fence: DdcRestoreFence,
  ): boolean {
    if (
      fence.attempt !== lease.attempt ||
      fence.generation !== lease.generation ||
      current.active !== undefined ||
      current.revision !== fence.revision ||
      current.generation !== fence.generation ||
      current.desiredKey !== fence.desiredKey ||
      current.currentKey !== fence.currentKey ||
      current.lastKnownGoodKey !== fence.lastKnownGoodKey
    ) {
      return false;
    }
    if (fence.outcome === 'current') {
      return (
        fence.key !== undefined &&
        current.currentKey === fence.key &&
        current.failure === undefined &&
        current.stale !== true
      );
    }
    if (
      fence.failure === undefined ||
      current.failure === undefined ||
      current.failure.desiredKey !== fence.desiredKey ||
      current.failure.code !== fence.failure.code ||
      current.failure.detail !== fence.failure.detail
    ) {
      return false;
    }
    return fence.outcome === 'invalid' ? fence.currentKey === undefined : true;
  }

  private async projectHead(
    guid: string,
    desiredKey: string,
    record: HeadRecord | null,
    includeActive = true,
  ): Promise<DdcHead> {
    const checked =
      record?.currentKey === undefined ? null : await this.entries.readChecked(record.currentKey);
    return this.projectValidatedHead(guid, desiredKey, record, checked, includeActive);
  }

  private projectValidatedHead(
    guid: string,
    desiredKey: string,
    record: HeadRecord | null,
    currentEntry: Awaited<ReturnType<DdcEntryStore['readChecked']>> | null,
    includeActive = true,
  ): DdcHead {
    if (record === null) {
      return {
        guid,
        desiredKey,
        state: 'missing',
        currentKey: undefined,
        lastKnownGoodKey: undefined,
        revision: 0,
      };
    }
    const recordedFailure =
      record.failure?.desiredKey === desiredKey
        ? { code: record.failure.code, detail: record.failure.detail }
        : undefined;
    const entryFailure =
      currentEntry !== null && !currentEntry.ok
        ? { code: currentEntry.error.code, detail: currentEntry.error.detail }
        : undefined;
    const failure = recordedFailure ?? entryFailure;
    const currentValue = currentEntry?.ok === true ? currentEntry.value : null;
    const state: DdcLifecycleState =
      failure !== undefined
        ? 'failed'
        : record.currentKey === desiredKey && currentValue?.guid === guid
          ? 'current'
          : record.stale === true
            ? 'stale'
            : includeActive && record.active?.desiredKey === desiredKey
              ? 'cooking'
              : record.empty === true
                ? 'missing'
                : 'stale';
    return {
      guid,
      desiredKey,
      state,
      currentKey: record.currentKey,
      lastKnownGoodKey: record.lastKnownGoodKey,
      revision: record.revision,
      ...(record.generation === undefined ? {} : { generation: record.generation }),
      ...(includeActive && record.active !== undefined ? { activeLease: record.active } : {}),
      ...(failure === undefined ? {} : { failure }),
    };
  }

  private async allocateGeneration(minimumExclusive = 0): Promise<number> {
    return withDdcLock(this.root, 'generation-counter', async () => {
      const path = join(this.root, 'generations', 'counter.json');
      await mkdir(join(this.root, 'generations'), { recursive: true });
      let next = 1;
      try {
        const record = JSON.parse(await readFile(path, 'utf8')) as GenerationRecord;
        if (
          record.schemaVersion === 'forgeax-ddc-generation/v2' &&
          Number.isSafeInteger(record.next) &&
          record.next >= 1
        )
          next = Math.max(1, record.next);
      } catch {
        // A missing counter is the first allocation, not an implicit legacy fallback.
      }
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      next = Math.max(next, minimumExclusive + 1);
      await writeFile(
        temporary,
        JSON.stringify({ schemaVersion: 'forgeax-ddc-generation/v2', next: next + 1 }),
      );
      await rename(temporary, path);
      return next;
    });
  }

  private async read(guid: string): Promise<HeadRecord | null> {
    const path = headFile(this.heads, guid);
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'ENOENT'
      ) {
        return null;
      }
      throw malformedHeadError('unreadable');
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw malformedHeadError('syntax-invalid');
    }
    if (!isHeadRecord(value) || value.guid !== guid) throw malformedHeadError('schema-invalid');
    return value;
  }

  private async write(record: HeadRecord): Promise<void> {
    await mkdir(this.heads, { recursive: true });
    const path = headFile(this.heads, record.guid);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record));
    await rename(temporary, path);
  }
}
