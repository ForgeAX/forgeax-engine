import type { Renderer } from '@forgeax/engine-render';
import {
  type PublishedLevelPreparation,
  preparePublishedLevel,
  StagedMeshSourceError,
} from '@forgeax/engine-render/internal';
import { AssetError, err, ok, type Result } from '@forgeax/engine-types';
import {
  type ClosedLevelFrameSelection,
  type ClosedLevelFrameSelectionReceipt,
  type ClosedLevelRowIdentity,
  type ClosedLevelRowReceipt,
  type ClosedLevelRowRequest,
  sameClosedLevelRowIdentity,
} from './closed-level-row-protocol';
import type { RenderClosedLevelRows } from './render-closed-level-rows';
import { yieldRenderWorkerTaskTurn } from './render-worker-task-turn';
import { serializableDetail } from './worker-error';

type Outcome = ClosedLevelRowReceipt['result'];
interface Job {
  readonly id: ClosedLevelRowIdentity;
  readonly work: PublishedLevelPreparation;
  requests: ClosedLevelRowRequest[];
  phase: 'prepare' | 'ready' | 'retire' | 'failed';
  pending?: Promise<void>;
  failure?: { readonly cause: unknown };
}

const okReceipt = { ok: true } as const;
const closedReceipt = { ok: false, reason: 'closed' } as const;
const nativeFailure = (cause: unknown): Outcome => ({
  ok: false,
  reason: 'native',
  detail: serializableDetail(cause),
});
const missing = () =>
  err(
    new AssetError({
      code: 'asset-not-found',
      expected: 'an asset in the sealed Level publication',
      hint: 'publish the exact fixed dependency closure before device preparation',
    }),
  );

/** Device work advances a single step between ordinary recordings and waits off the draw lane. */
export class RenderLevelDeviceWork {
  private readonly jobs = new Map<number, Job>();
  private readonly runnable = new Set<Job>();
  private active: Job | undefined;

  constructor(
    private readonly renderer: Renderer,
    private readonly rows: RenderClosedLevelRows,
    private readonly reply: (receipt: ClosedLevelRowReceipt) => void,
    private readonly wake: () => void,
  ) {}

  receive(message: ClosedLevelRowRequest): boolean {
    const { id, operation } = message;
    if (operation.kind !== 'prepare' && operation.kind !== 'retire') return false;
    const job = this.jobs.get(id.stream);
    if (job !== undefined && !sameClosedLevelRowIdentity(job.id, id)) {
      this.finish([message], { ok: false, reason: 'identity' });
      return true;
    }
    if (operation.kind === 'retire') {
      if (job === undefined) return false;
      this.beginRetirement(job);
      job.requests.push(message);
      return true;
    }
    if (job === undefined) this.beginPreparation(message);
    else if (job.phase === 'prepare') job.requests.push(message);
    else if (job.phase === 'ready') {
      if (job.work.isCurrent()) this.finish([message], okReceipt);
      else {
        job.phase = 'prepare';
        job.requests.push(message);
        this.runnable.add(job);
      }
    } else this.finish([message], closedReceipt);
    return true;
  }

  select(
    selection: ClosedLevelFrameSelection,
  ): Result<() => void, Extract<ClosedLevelFrameSelectionReceipt['result'], { ok: false }>> {
    const job = this.jobs.get(selection.id.stream);
    if (job === undefined || !sameClosedLevelRowIdentity(job.id, selection.id))
      return err({ ok: false, reason: 'identity' });
    if (job.phase !== 'ready') return err(closedReceipt);
    try {
      return ok(job.work.select(selection.active));
    } catch (cause) {
      const reason =
        cause instanceof StagedMeshSourceError && cause.detail.reason === 'view-obsolete'
          ? 'view-obsolete'
          : 'native';
      return err({ ok: false, reason, detail: serializableDetail(cause) });
    }
  }

  private beginPreparation(message: ClosedLevelRowRequest): void {
    const { id } = message;
    const sealed = this.rows.borrowSealed(id);
    if (sealed === undefined) {
      this.finish([message], { ok: false, reason: 'sequence' });
      return;
    }
    try {
      const work = preparePublishedLevel(this.renderer, {
        members: sealed.members,
        chunks: sealed.chunks,
        isCurrent: sealed.rowsCurrent,
        content: {
          handles: [...sealed.assets.keys()],
          matchesCurrent: sealed.isCurrent,
          version(handle) {
            const entry = sealed.assets.get(handle);
            return entry === undefined ? missing() : ok(entry.version);
          },
          read<T>(handle: number) {
            const entry = sealed.assets.get(handle);
            return entry === undefined ? missing() : ok(entry.hold.value as T);
          },
        },
      });
      const job: Job = { id, work, phase: 'prepare', requests: [message] };
      this.jobs.set(id.stream, job);
      this.runnable.add(job);
    } catch (cause) {
      this.finish([message], nativeFailure(cause));
    }
  }

  private beginRetirement(job: Job): void {
    if (job.phase === 'retire') return;
    this.finish(job.requests, closedReceipt);
    job.requests = [];
    job.phase = 'retire';
    delete job.failure;
    if (job.pending === undefined) this.runnable.add(job);
  }

  private finish(requests: readonly ClosedLevelRowRequest[], result: Outcome): void {
    for (const { id, serial } of requests)
      this.reply({ kind: 'closed-level-rows-result', id, serial, result });
  }

  hasWork(): boolean {
    return this.active === undefined ? this.runnable.size > 0 : this.runnable.has(this.active);
  }

  step(): void {
    const job = this.active ?? this.runnable.values().next().value;
    if (job === undefined || !this.runnable.has(job)) return;
    // Preparation and retirement edit one scene's Inputs. Keep the owner's turn
    // across GPU fences while ordinary frame submission continues independently.
    this.active = job;
    try {
      if (job.failure !== undefined) throw job.failure.cause;
      const retiring = job.phase === 'retire';
      const next = retiring ? job.work.retireStep() : job.work.step();
      if (next instanceof Promise) {
        this.runnable.delete(job);
        job.pending = next
          .then(
            () => {},
            (cause) => {
              if (retiring || job.phase !== 'retire') job.failure = { cause };
            },
          )
          .finally(() => {
            delete job.pending;
            this.runnable.add(job);
            this.wake();
          });
      } else if (next) {
        this.active = undefined;
        this.runnable.delete(job);
        if (retiring) {
          this.rows.discard(job.id);
          this.jobs.delete(job.id.stream);
        } else job.phase = 'ready';
        this.finish(job.requests, okReceipt);
        job.requests = [];
      }
    } catch (cause) {
      this.active = undefined;
      this.runnable.delete(job);
      job.phase = 'failed';
      job.failure = { cause };
      this.finish(job.requests, nativeFailure(cause));
      job.requests = [];
    }
  }

  async dispose(): Promise<void> {
    for (const job of this.jobs.values()) this.beginRetirement(job);
    while (this.jobs.size > 0) {
      const pending = [...this.jobs.values()].flatMap((job) =>
        job.pending === undefined ? [] : [job.pending],
      );
      if (this.hasWork()) {
        this.step();
        await yieldRenderWorkerTaskTurn();
      } else if (pending.length > 0) await Promise.race(pending);
      else
        throw new AggregateError(
          [...this.jobs.values()].map((job) => job.failure?.cause),
          'Render Worker Level retirement remains unconfirmed',
        );
    }
  }
}
