import { type DdcEntry, DdcEntryStore, DdcStoreError, type StagedDdcEntry } from './entry-store.js';
import type {
  DdcCommitResult,
  DdcHead,
  DdcLease,
  DdcRestoreFence,
  DdcRestoreResult,
  DdcRollbackSnapshot,
} from './lifecycle.js';
import { DdcLifecycle } from './lifecycle.js';

export interface DdcSessionOptions {
  readonly generation: number;
  readonly leaseTtlMs?: number;
}

export interface DdcGenerationCandidate {
  readonly generation: number;
  readonly lease: DdcLease;
  readonly previousHead: DdcRollbackSnapshot;
}

export interface DdcGenerationEntryCandidate extends DdcGenerationCandidate {
  readonly staged: StagedDdcEntry;
}

export interface DdcSessionMetrics {
  readonly hitCount: number;
  readonly missCount: number;
  readonly corruptCount: number;
  readonly writeFailureCount: number;
}

type MutableDdcGenerationCandidate = Omit<DdcGenerationCandidate, 'lease'> & {
  lease: DdcLease;
};

type MutableDdcGenerationEntryCandidate = Omit<DdcGenerationEntryCandidate, 'lease'> & {
  lease: DdcLease;
};

type HeartbeatTimer = ReturnType<typeof setTimeout>;

type MutableMetrics = { -readonly [K in keyof DdcSessionMetrics]: DdcSessionMetrics[K] };

export class DdcGenerationSession {
  public readonly generation: number;
  private readonly lifecycle: DdcLifecycle;
  private readonly entries: DdcEntryStore;
  private readonly candidates = new Map<
    string,
    {
      candidate: MutableDdcGenerationCandidate;
      heartbeat: HeartbeatTimer | undefined;
    }
  >();
  private readonly restoreFences = new WeakMap<DdcGenerationCandidate, DdcRestoreFence>();
  private readonly counters: MutableMetrics = {
    hitCount: 0,
    missCount: 0,
    corruptCount: 0,
    writeFailureCount: 0,
  };
  private accepting = true;

  public constructor(root: string, options: DdcSessionOptions) {
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new TypeError('DDC generation must be a positive safe integer');
    }
    this.generation = options.generation;
    this.lifecycle = new DdcLifecycle(
      root,
      options.leaseTtlMs === undefined ? undefined : { leaseTtlMs: options.leaseTtlMs },
    );
    this.entries = new DdcEntryStore(root);
  }

  public async beginCandidate(guid: string, desiredKey: string): Promise<DdcGenerationCandidate> {
    this.assertOpen();
    const { lease, previousHead } = await this.lifecycle.beginWithSnapshot(guid, desiredKey);
    if (previousHead.state === 'current') this.counters.hitCount += 1;
    else this.counters.missCount += 1;
    const candidate: MutableDdcGenerationCandidate = {
      generation: this.generation,
      lease,
      previousHead,
    };
    this.candidates.set(lease.attempt, { candidate, heartbeat: undefined });
    this.scheduleHeartbeat(candidate);
    return candidate;
  }

  public async stageEntry(entry: DdcEntry): Promise<DdcGenerationEntryCandidate> {
    this.assertOpen();
    const candidate = (await this.beginCandidate(
      entry.guid,
      entry.key,
    )) as MutableDdcGenerationCandidate;
    try {
      const staged = await this.entries.stage(entry);
      const entryCandidate: MutableDdcGenerationEntryCandidate = Object.assign(candidate, {
        staged,
      });
      return entryCandidate;
    } catch (error) {
      const fence = await this.lifecycle.fail(candidate.lease, {
        code: 'ddc-entry-stage-failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      if (fence !== undefined) this.restoreFences.set(candidate, fence);
      this.stopHeartbeat(candidate.lease.attempt);
      this.candidates.delete(candidate.lease.attempt);
      this.counters.writeFailureCount += 1;
      throw error;
    }
  }

  public async inspect(guid: string, desiredKey: string): Promise<DdcHead> {
    this.assertOpen();
    const head = await this.lifecycle.inspect(guid, desiredKey);
    if (head.state === 'current') this.counters.hitCount += 1;
    else this.counters.missCount += 1;
    return head;
  }

  public async commitCandidate(
    candidate: DdcGenerationCandidate,
    validatedKey: string,
  ): Promise<DdcCommitResult> {
    const registered = this.assertCandidate(candidate);
    try {
      const result = await this.lifecycle.commit(registered.lease, validatedKey);
      if (result.restoreFence !== undefined)
        this.restoreFences.set(registered, result.restoreFence);
      if (result.result === 'invalid') this.counters.corruptCount += 1;
      this.stopHeartbeat(registered.lease.attempt);
      this.candidates.delete(registered.lease.attempt);
      return result;
    } catch (error) {
      this.stopHeartbeat(registered.lease.attempt);
      this.counters.writeFailureCount += 1;
      throw error;
    }
  }

  public async commitEntry(
    candidate: DdcGenerationEntryCandidate,
    validatedKey: string,
  ): Promise<DdcCommitResult> {
    const registered = this.assertCandidate(candidate);
    try {
      const published = await this.entries.publish(candidate.staged);
      if (published.result === 'conflict') {
        throw new DdcStoreError({
          code: 'ddc-entry-conflict',
          detail: `immutable DDC entry ${published.key} conflicts with the staged candidate`,
          expected: 'the existing DDC entry to have the same validated output',
          actual: { key: published.key },
        });
      }
      const result = await this.lifecycle.commit(registered.lease, validatedKey);
      if (result.restoreFence !== undefined)
        this.restoreFences.set(registered, result.restoreFence);
      this.stopHeartbeat(registered.lease.attempt);
      this.candidates.delete(registered.lease.attempt);
      return result;
    } catch (error) {
      this.stopHeartbeat(registered.lease.attempt);
      const fence = await this.lifecycle.fail(registered.lease, {
        code: 'ddc-entry-publish-failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      if (fence !== undefined) this.restoreFences.set(registered, fence);
      await this.entries.discard(candidate.staged).catch(() => {});
      this.candidates.delete(registered.lease.attempt);
      this.counters.writeFailureCount += 1;
      throw error;
    }
  }

  public async discardCandidate(candidate: DdcGenerationCandidate): Promise<void> {
    const registered = this.candidates.get(candidate.lease.attempt)?.candidate;
    if (registered === undefined) return;
    try {
      this.stopHeartbeat(registered.lease.attempt);
      await this.lifecycle.discard(registered.lease);
      this.candidates.delete(registered.lease.attempt);
    } catch (error) {
      this.counters.writeFailureCount += 1;
      throw error;
    }
  }

  public async discardEntry(candidate: DdcGenerationEntryCandidate): Promise<void> {
    await Promise.all([this.discardCandidate(candidate), this.entries.discard(candidate.staged)]);
  }

  public async restoreEntry(candidate: DdcGenerationEntryCandidate): Promise<DdcRestoreResult> {
    const registered = this.candidates.get(candidate.lease.attempt)?.candidate;
    const ownerLease = registered?.lease ?? candidate.lease;
    const fence = this.restoreFences.get(candidate);
    this.stopHeartbeat(ownerLease.attempt);
    let result: DdcRestoreResult = {
      result: 'not-owner',
      revision: candidate.previousHead.revision ?? 0,
      ...(candidate.previousHead.generation === undefined
        ? {}
        : { generation: candidate.previousHead.generation }),
    };
    let restoreError: unknown;
    try {
      result = await this.lifecycle.restoreIfCurrent(candidate.previousHead, ownerLease, fence);
    } catch (error) {
      restoreError = error;
    } finally {
      await this.entries.discard(candidate.staged).catch(() => {});
      if (registered !== undefined) {
        this.candidates.delete(registered.lease.attempt);
      }
    }
    if (restoreError !== undefined) throw restoreError;
    return result;
  }

  public metrics(): DdcSessionMetrics {
    return { ...this.counters };
  }

  public async close(): Promise<void> {
    if (!this.accepting) return;
    this.accepting = false;
    const pending = [...this.candidates.values()];
    for (const { candidate } of pending) this.stopHeartbeat(candidate.lease.attempt);
    for (const { candidate } of pending) {
      try {
        await this.lifecycle.discard(candidate.lease);
      } catch {
        this.counters.writeFailureCount += 1;
      }
    }
    this.candidates.clear();
  }

  private assertOpen(): void {
    if (!this.accepting) throw new Error('DDC generation session is closed');
  }

  private assertCandidate(candidate: DdcGenerationCandidate): MutableDdcGenerationCandidate {
    this.assertOpen();
    const registered = this.candidates.get(candidate.lease.attempt)?.candidate;
    if (candidate.generation !== this.generation || registered === undefined) {
      throw new Error('DDC candidate belongs to another generation session');
    }
    return registered;
  }

  private scheduleHeartbeat(candidate: MutableDdcGenerationCandidate): void {
    const attempt = candidate.lease.attempt;
    this.stopHeartbeat(candidate.lease.attempt);
    const delay = Math.max(1, Math.floor((candidate.lease.expiresAt - Date.now()) / 2));
    const entry = this.candidates.get(attempt);
    if (entry === undefined || entry.candidate !== candidate) return;
    const timer = setTimeout(() => {
      entry.heartbeat = undefined;
      if (!this.accepting || this.candidates.get(attempt) !== entry) return;
      void this.lifecycle
        .heartbeat(candidate.lease)
        .then((lease) => {
          if (!this.accepting || this.candidates.get(attempt) !== entry) return;
          candidate.lease = lease;
          this.scheduleHeartbeat(candidate);
        })
        .catch(() => {
          this.stopHeartbeat(candidate.lease.attempt);
        });
    }, delay);
    timer.unref?.();
    entry.heartbeat = timer;
  }

  private stopHeartbeat(attempt: string): void {
    const entry = this.candidates.get(attempt);
    if (entry?.heartbeat === undefined) return;
    clearTimeout(entry.heartbeat);
    entry.heartbeat = undefined;
  }
}
