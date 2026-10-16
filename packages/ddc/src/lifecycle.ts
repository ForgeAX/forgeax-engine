import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type DdcEntry, DdcEntryStore } from './entry-store.js';
import { DdcStoreError } from './errors.js';

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

export interface DdcCommitResult {
  readonly result: 'current' | 'stale' | 'lease-lost' | 'invalid';
  readonly key: string;
  readonly revision?: number;
  /** Internal CAS evidence retained for a later generation rollback. */
  readonly restoreFence?: DdcRestoreFence;
}

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

interface HeadRecord {
  readonly guid: string;
  readonly desiredKey: string;
  readonly revision: number;
  readonly currentKey?: string;
  readonly lastKnownGoodKey?: string;
  readonly generation?: number;
  readonly active?: DdcLease;
  readonly supersededAttempts?: readonly string[];
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

function withRevision(
  result: Omit<DdcCommitResult, 'revision'>,
  revision: number,
  restoreFence?: DdcRestoreFence,
): DdcCommitResult {
  const value = { ...result } as DdcCommitResult;
  Object.defineProperty(value, 'revision', { value: revision, enumerable: false });
  if (restoreFence !== undefined) {
    Object.defineProperty(value, 'restoreFence', { value: restoreFence, enumerable: false });
  }
  return value;
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
  if (
    value.supersededAttempts !== undefined &&
    (!Array.isArray(value.supersededAttempts) || !value.supersededAttempts.every(isString))
  ) {
    return false;
  }
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
    const head = await this.projectHead(guid, record?.desiredKey ?? '', record);
    const entry =
      head.currentKey === undefined || head.state !== 'current'
        ? null
        : await this.entries.read(head.currentKey);
    return { head, entry };
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
      const supersededAttempts = [
        ...(previous?.supersededAttempts ?? []),
        ...(previous?.active === undefined ? [] : [previous.active.attempt]),
      ];
      await this.write({
        guid,
        desiredKey,
        revision: previous?.revision ?? 0,
        generation,
        active: lease,
        ...(previous?.currentKey === undefined ? {} : { currentKey: previous.currentKey }),
        ...(supersededAttempts.length === 0 ? {} : { supersededAttempts }),
        ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
      });
      return { lease, previousHead };
    });
  }

  public async begin(guid: string, desiredKey: string): Promise<DdcLease> {
    return (await this.beginWithSnapshot(guid, desiredKey)).lease;
  }

  public async commit(lease: DdcLease, validatedKey: string): Promise<DdcCommitResult> {
    // Immutable bytes can be validated without holding the mutable head lock.
    // Keep heartbeats runnable, then fence the live head after all expensive work.
    const entry = await this.entries.read(validatedKey);
    return withDdcLock(this.root, `head-${lease.guid}`, async () => {
      const current = await this.read(lease.guid);
      const active = current?.active;
      if (current === null || active === undefined || active.attempt !== lease.attempt) {
        if (current?.supersededAttempts?.includes(lease.attempt)) {
          await this.write({ ...current, stale: true });
          return withRevision({ result: 'stale', key: validatedKey }, current.revision);
        }
        return withRevision({ result: 'lease-lost', key: validatedKey }, current?.revision ?? 0);
      }
      // The persisted active lease is the authority. The caller may still hold
      // an older token while a session heartbeat has already refreshed the
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
        return withRevision({ result: 'stale', key: validatedKey }, current.revision);
      }
      if (entry === null || entry.guid !== lease.guid || entry.receipt.key !== validatedKey) {
        const nextRevision = current.revision + 1;
        const failure = {
          desiredKey: lease.desiredKey,
          code: 'entry-invalid',
          detail: 'validated DDC key has no readable entry for this asset',
        };
        await this.write({
          guid: lease.guid,
          desiredKey: lease.desiredKey,
          revision: nextRevision,
          generation: lease.generation,
          ...(current.lastKnownGoodKey === undefined
            ? {}
            : { lastKnownGoodKey: current.lastKnownGoodKey }),
          ...(current.supersededAttempts === undefined
            ? {}
            : { supersededAttempts: current.supersededAttempts }),
          failure,
        });
        return withRevision({ result: 'invalid', key: validatedKey }, nextRevision, {
          attempt: lease.attempt,
          generation: lease.generation,
          revision: nextRevision,
          desiredKey: lease.desiredKey,
          outcome: 'invalid',
          ...(current.lastKnownGoodKey === undefined
            ? {}
            : { lastKnownGoodKey: current.lastKnownGoodKey }),
          failure: { code: failure.code, detail: failure.detail },
        });
      }
      const lastKnownGoodKey =
        current.currentKey !== undefined && current.currentKey !== validatedKey
          ? current.currentKey
          : current.lastKnownGoodKey;
      const nextRevision = current.revision + 1;
      await this.write({
        guid: lease.guid,
        desiredKey: lease.desiredKey,
        revision: nextRevision,
        generation: lease.generation,
        currentKey: validatedKey,
        stale: false,
        ...(current.supersededAttempts === undefined
          ? {}
          : { supersededAttempts: current.supersededAttempts }),
        ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
      });
      return withRevision({ result: 'current', key: validatedKey }, nextRevision, {
        attempt: lease.attempt,
        generation: lease.generation,
        revision: nextRevision,
        desiredKey: lease.desiredKey,
        outcome: 'current',
        key: validatedKey,
        currentKey: validatedKey,
        ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
      });
    });
  }

  public async fail(
    lease: DdcLease,
    failure: { readonly code: string; readonly detail: string },
  ): Promise<DdcRestoreFence | undefined> {
    return withDdcLock(this.root, `head-${lease.guid}`, async () => {
      const current = await this.read(lease.guid);
      if (current?.active?.attempt !== lease.attempt) return;
      const nextRevision = current.revision + 1;
      await this.write({
        guid: lease.guid,
        desiredKey: lease.desiredKey,
        revision: nextRevision,
        generation: lease.generation,
        ...(current.currentKey === undefined ? {} : { currentKey: current.currentKey }),
        ...(current.lastKnownGoodKey === undefined
          ? {}
          : { lastKnownGoodKey: current.lastKnownGoodKey }),
        ...(current.supersededAttempts === undefined
          ? {}
          : { supersededAttempts: current.supersededAttempts }),
        failure: { desiredKey: lease.desiredKey, ...failure },
      });
      return {
        attempt: lease.attempt,
        generation: lease.generation,
        revision: nextRevision,
        desiredKey: lease.desiredKey,
        outcome: 'failed' as const,
        ...(current.currentKey === undefined ? {} : { currentKey: current.currentKey }),
        ...(current.lastKnownGoodKey === undefined
          ? {}
          : { lastKnownGoodKey: current.lastKnownGoodKey }),
        failure,
      };
    });
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

  public async close(lease: DdcLease): Promise<void> {
    await withDdcLock(this.root, `head-${lease.guid}`, async () => {
      const current = await this.read(lease.guid);
      if (current?.active?.instanceId !== lease.instanceId) return;
      const { active: _active, ...withoutActive } = current;
      await this.write({
        ...withoutActive,
        revision: current.revision + 1,
        stale: current.currentKey === undefined,
      });
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

  /**
   * Restore accepted content only when this lease still owns the mutable head.
   * A newer active or terminal mutation makes rollback a deliberate no-op.
   */
  public async restore(
    head: DdcHead | DdcRollbackSnapshot,
    lease?: DdcLease,
    fence?: DdcRestoreFence,
  ): Promise<DdcRestoreResult> {
    const inferredLease =
      lease ??
      ('activeLease' in head && head.activeLease !== undefined ? head.activeLease : undefined);
    if (inferredLease === undefined) {
      return {
        result: 'not-owner',
        revision: head.revision ?? 0,
        ...(head.generation === undefined ? {} : { generation: head.generation }),
      };
    }
    const snapshot = this.rollbackSnapshot(head);
    return this.restoreIfCurrent(snapshot, inferredLease, fence);
  }

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
      const supersededAttempts = current.supersededAttempts;
      const restored: HeadRecord = {
        guid: snapshot.guid,
        desiredKey: snapshot.desiredKey,
        revision: nextRevision,
        generation,
        ...(snapshot.currentKey === undefined ? {} : { currentKey: snapshot.currentKey }),
        ...(snapshot.lastKnownGoodKey === undefined
          ? {}
          : { lastKnownGoodKey: snapshot.lastKnownGoodKey }),
        ...(supersededAttempts === undefined ? {} : { supersededAttempts }),
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

  public async revoke(lease: DdcLease): Promise<void> {
    await this.fail(lease, {
      code: 'lease-lost',
      detail: 'cook lease was revoked before validation',
    });
  }

  public async recover(guid: string, desiredKey: string): Promise<DdcHead> {
    return withDdcLock(this.root, `head-${guid}`, async () => {
      const current = await this.read(guid);
      if (current?.active?.desiredKey === desiredKey) {
        await this.write({
          guid,
          desiredKey,
          revision: current.revision + 1,
          ...(current.generation === undefined ? {} : { generation: current.generation }),
          ...(current.supersededAttempts === undefined
            ? {}
            : { supersededAttempts: current.supersededAttempts }),
          ...(current.lastKnownGoodKey === undefined
            ? {}
            : { lastKnownGoodKey: current.lastKnownGoodKey }),
          failure: {
            desiredKey,
            code: 'writer-crashed',
            detail: 'active cook attempt was recovered after process interruption',
          },
        });
      }
      return this.inspect(guid, desiredKey);
    });
  }

  private rollbackSnapshot(head: DdcHead | DdcRollbackSnapshot): DdcRollbackSnapshot {
    const { activeLease: _activeLease, ...snapshot } = head as DdcHead;
    if (snapshot.state !== 'cooking') return snapshot;
    return {
      ...snapshot,
      state: snapshot.currentKey === undefined ? 'missing' : 'stale',
    };
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
    const currentEntry =
      record.currentKey === undefined ? null : await this.entries.readChecked(record.currentKey);
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
      ...(includeActive && record.active === undefined
        ? {}
        : includeActive && record.active !== undefined
          ? { activeLease: record.active }
          : {}),
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
