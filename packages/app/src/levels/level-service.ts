import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Plugin } from '@forgeax/engine-plugin';
import { type AssetHandle, err, ok, type Result } from '@forgeax/engine-types';
import type { AppLevelCandidate, AppLevelOwner } from './app-level-owner';
import type { LevelCandidateError, LevelCandidateStatus } from './candidate';
import { retireUnusedSceneCache } from './scene-cache-retirement';

export type LevelTarget = 'prepared' | 'active' | 'unloaded';

export type LevelPhase =
  | LevelTarget
  | 'loading'
  | 'preparing'
  | 'activating'
  | 'deactivating'
  | 'unloading'
  | 'failed';

export type LevelErrorCode =
  | 'level-invalid-scene'
  | 'level-invalid-target'
  | 'level-owner-closed'
  | 'level-assets-unavailable'
  | 'level-request-superseded'
  | 'level-load-failed'
  | 'level-participation-failed'
  | 'level-release-failed';

export class LevelError extends Error {
  readonly expected = 'a current Level request with confirmed ownership and participation';
  readonly hint = 'inspect the request and its cause before submitting another target';

  constructor(
    readonly code: LevelErrorCode,
    readonly detail: {
      readonly scene: string;
      readonly target: LevelTarget;
      readonly phase: LevelPhase;
    },
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = 'LevelError';
  }
}

export interface LevelStatus {
  readonly scene: string;
  readonly target: LevelTarget;
  readonly phase: LevelPhase;
  /** Whether the observed active or prepared state is valid now. */
  readonly current: boolean;
  readonly members: number;
  /** Current request has crossed the source participation boundary. */
  readonly sourceAccepted: boolean;
  /** Current request has crossed the Render participation boundary. */
  readonly renderAccepted: boolean;
  /** Actual static collision is participating in its Physics owner. */
  readonly collisionAccepted: boolean;
  /** Completed selection picture when the execution route reports one. */
  readonly picture?: { readonly frameId: number; readonly revision: number };
  readonly failure?: LevelError;
  readonly cleanupFailure?: LevelError;
}

export interface LevelRequest {
  readonly done: Promise<Result<LevelStatus, LevelError>>;
}

export interface Level {
  request(target: LevelTarget): Result<LevelRequest, LevelError>;
  inspect(): LevelStatus;
}

export interface LevelVisualExchange {
  readonly show: readonly Level[];
  readonly hide: readonly Level[];
}

export interface LevelService {
  /** Creates a realm-local handle. A request starts work. */
  create(input: {
    readonly scene: AssetGuid | string;
    readonly releaseCache?: boolean;
  }): Result<Level, LevelError>;
  /** Replace one prepared visual representation at a single participation boundary. */
  exchangeVisual(input: LevelVisualExchange): Result<Promise<Result<void, LevelError>>, LevelError>;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    levels: LevelService;
  }
}

export function levelServicePlugin(service: LevelService): Plugin {
  return {
    name: 'levels',
    provide: 'levels',
    apply(ctx) {
      ctx.provide('levels', service);
    },
  };
}

type StartCandidate = (
  scene: AssetHandle<'scene'>,
  observe: (status: Result<LevelCandidateStatus, LevelCandidateError>) => void,
) => ReturnType<AppLevelOwner['create']>;

export type LevelExchangeMembers = readonly {
  readonly candidate: AppLevelCandidate;
  readonly active: boolean;
}[];

type ScheduleExchange = (
  members: LevelExchangeMembers,
) => Result<Promise<Result<void, LevelCandidateError>>, LevelCandidateError>;

interface PendingRequest {
  readonly receipt: LevelRequest;
  finish(result: Result<LevelStatus, LevelError>): void;
}

interface SourceLoad {
  readonly abort: AbortController;
  readonly done: Promise<void>;
}

interface CandidateLease {
  readonly handle: AssetHandle<'scene'>;
  readonly level: AppLevelCandidate;
  stopping: boolean;
}

function candidatePhase(status: LevelCandidateStatus): LevelPhase {
  switch (status.phase) {
    case 'prepared':
    case 'active':
      return status.current ? status.phase : 'preparing';
    case 'activating':
    case 'deactivating':
    case 'failed':
      return status.phase;
    case 'reverting-activation':
      return 'deactivating';
    case 'retired':
      return 'unloaded';
    case 'retire-domains':
    case 'retire-render':
    case 'retire-scene':
    case 'retire-holds':
      return 'unloading';
    default:
      return 'preparing';
  }
}

/** Owns source loads and public waiters; the App owner schedules all candidates. */
export class AppLevelService implements LevelService {
  closed = false;
  readonly loads = new Set<SourceLoad>();
  readonly waiters = new Set<ManagedLevel>();
  private readonly retiring = new Map<number, Generator<void>>();

  constructor(
    private readonly assets: AssetRegistry | undefined,
    private readonly start: StartCandidate,
    private readonly exchange?: ScheduleExchange,
  ) {}

  create({
    scene,
    releaseCache = false,
  }: Parameters<LevelService['create']>[0]): Result<Level, LevelError> {
    const id =
      typeof scene === 'string'
        ? scene.toLowerCase()
        : scene.length === 16
          ? AssetGuid.format(scene)
          : '';
    const detail = { scene: id, target: 'unloaded', phase: 'unloaded' } as const;
    if (this.closed) return err(new LevelError('level-owner-closed', detail));
    if (this.assets === undefined) return err(new LevelError('level-assets-unavailable', detail));
    if (!AssetGuid.parse(id).ok) return err(new LevelError('level-invalid-scene', detail));
    return ok(new ManagedLevel(this, this.assets, this.start, id, releaseCache));
  }

  exchangeVisual(input: LevelVisualExchange): ReturnType<LevelService['exchangeVisual']> {
    const error = (cause?: unknown) =>
      new LevelError(
        'level-participation-failed',
        {
          scene: '',
          target: 'active',
          phase: 'prepared',
        },
        cause,
      );
    if (this.closed)
      return err(
        new LevelError('level-owner-closed', {
          scene: '',
          target: 'active',
          phase: 'unloaded',
        }),
      );
    if (input.show.length === 0 || input.hide.length === 0 || this.exchange === undefined)
      return err(error());
    const show = this.exchangeMembers(input.show, true);
    const hide = this.exchangeMembers(input.hide, false);
    if (show === undefined || hide === undefined) return err(error());
    const moves = [...show, ...hide];
    if (new Set(moves.map(({ level }) => level)).size !== moves.length) return err(error());
    const scheduled = this.exchange(moves);
    if (!scheduled.ok) return err(error(scheduled.error));
    for (const { level } of moves) level.exchanging = true;
    return ok(
      scheduled.value.then((result) => {
        for (const { level, active } of moves) {
          level.exchanging = false;
          if (result.ok) level.acceptExchange(active);
        }
        return result.ok ? ok(undefined) : err(error(result.error));
      }),
    );
  }

  private exchangeMembers(levels: readonly Level[], active: boolean) {
    const members: { level: ManagedLevel; candidate: AppLevelCandidate; active: boolean }[] = [];
    for (const level of levels) {
      if (!(level instanceof ManagedLevel)) return undefined;
      const candidate = level.exchangeCandidate(this, active);
      if (candidate === undefined) return undefined;
      members.push({ level, candidate, active });
    }
    return members;
  }

  get hasCacheRetirement(): boolean {
    return this.retiring.size > 0;
  }

  retireCache(scene: number): void {
    if (!this.closed && this.assets !== undefined && !this.retiring.has(scene))
      this.retiring.set(scene, retireUnusedSceneCache(this.assets, scene));
  }

  drainCache(canContinue: () => boolean): void {
    for (const [scene, work] of this.retiring) {
      while (canContinue()) {
        if (work.next().done) {
          this.retiring.delete(scene);
          break;
        }
      }
      if (!canContinue()) return;
    }
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.retiring.clear();
    for (const load of this.loads) load.abort.abort();
    for (const waiter of this.waiters) waiter.stop();
  }

  async drainLoads(): Promise<void> {
    await Promise.all([...this.loads].map(({ done }) => done));
  }
}

class ManagedLevel implements Level {
  exchanging = false;
  private target: LevelTarget = 'unloaded';
  private pending: PendingRequest | undefined;
  private source: SourceLoad | undefined;
  private candidate: CandidateLease | undefined;
  private failure: LevelError | undefined;
  private cleanupFailure: LevelError | undefined;
  private resetActivation = false;

  constructor(
    private readonly service: AppLevelService,
    private readonly assets: AssetRegistry,
    private readonly start: StartCandidate,
    private readonly scene: string,
    private readonly releaseCache: boolean,
  ) {}

  exchangeCandidate(service: AppLevelService, active: boolean): AppLevelCandidate | undefined {
    if (
      this.service !== service ||
      this.pending !== undefined ||
      this.exchanging ||
      this.candidate?.stopping ||
      this.cleanupFailure !== undefined ||
      this.target !== (active ? 'prepared' : 'active')
    )
      return undefined;
    return this.candidate?.level;
  }

  acceptExchange(active: boolean): void {
    this.target = active ? 'active' : 'prepared';
  }

  inspect(): LevelStatus {
    return this.snapshot(this.candidate?.level.inspect());
  }

  private phase(state: LevelCandidateStatus | undefined): LevelPhase {
    if (this.candidate?.stopping || this.cleanupFailure !== undefined) return 'unloading';
    if (state !== undefined) return candidatePhase(state);
    if (this.source !== undefined)
      return this.source.abort.signal.aborted ? 'unloading' : 'loading';
    return this.failure === undefined || this.target === 'unloaded' ? 'unloaded' : 'failed';
  }

  private snapshot(state: LevelCandidateStatus | undefined): LevelStatus {
    const current =
      !this.service.closed &&
      !this.exchanging &&
      !this.candidate?.stopping &&
      state?.current === true &&
      !this.resetActivation;
    return {
      scene: this.scene,
      target: this.target,
      phase: this.phase(state),
      current,
      members: state?.members ?? 0,
      sourceAccepted:
        this.target === 'active' &&
        !this.resetActivation &&
        (state?.phase === 'active' ||
          state?.phase === 'activating' ||
          state?.phase === 'reverting-activation'),
      renderAccepted:
        this.target === 'active' && !this.resetActivation && state?.phase === 'active',
      collisionAccepted: current && state?.collisionAccepted === true,
      ...(current && state?.phase === 'active' && state.renderSelection?.active === true
        ? { picture: state.renderSelection }
        : {}),
      ...(this.failure === undefined ? {} : { failure: this.failure }),
      ...(this.cleanupFailure === undefined ? {} : { cleanupFailure: this.cleanupFailure }),
    };
  }

  request(target: LevelTarget): Result<LevelRequest, LevelError> {
    if (target !== 'prepared' && target !== 'active' && target !== 'unloaded')
      return err(this.error('level-invalid-target'));
    if (this.service.closed) return err(this.error('level-owner-closed'));
    if (this.exchanging) return err(this.error('level-participation-failed'));
    if (this.cleanupFailure !== undefined) return err(this.cleanupFailure);
    if (this.pending !== undefined && this.target === target) return ok(this.pending.receipt);
    if (this.candidate?.level.phase === 'activating' && target !== 'active')
      this.resetActivation = true;
    if (this.pending !== undefined) this.finish(err(this.error('level-request-superseded')));
    this.target = target;
    this.failure = undefined;
    let finish!: PendingRequest['finish'];
    const done = new Promise<Result<LevelStatus, LevelError>>((resolve) => {
      finish = resolve;
    });
    const request = { receipt: { done }, finish };
    this.pending = request;
    this.service.waiters.add(this);
    this.reconcile();
    return ok(request.receipt);
  }

  stop(): void {
    this.finish(err(this.error('level-owner-closed')));
  }

  private error(code: LevelErrorCode, cause?: unknown): LevelError {
    return new LevelError(
      code,
      { scene: this.scene, target: this.target, phase: this.inspect().phase },
      cause,
    );
  }

  private finish(result: Result<LevelStatus, LevelError>): void {
    const current = this.pending;
    this.pending = undefined;
    this.service.waiters.delete(this);
    current?.finish(result);
  }

  private reconcile(observed?: LevelCandidateStatus): void {
    if (this.pending === undefined || this.service.closed) return;
    if (this.source !== undefined) {
      if (this.target === 'unloaded') this.source.abort.abort();
      return;
    }
    if (this.candidate === undefined) {
      if (this.target === 'unloaded') this.finish(ok(this.inspect()));
      else this.load();
      return;
    }
    this.reconcileCandidate(this.candidate, observed ?? this.candidate.level.inspect());
  }

  private reconcileCandidate(lease: CandidateLease, state: LevelCandidateStatus): void {
    if (lease.stopping) return;
    const invalidated = (state.phase === 'active' || state.phase === 'prepared') && !state.current;
    if (
      this.target === 'unloaded' ||
      state.phase === 'failed' ||
      (invalidated && !state.reusableSource)
    ) {
      lease.stopping = true;
      this.sendTarget(lease, 'unloaded');
      return;
    }
    if (state.phase === 'active' && invalidated) this.resetActivation = true;
    if (state.phase === 'prepared' && state.current) this.resetActivation = false;
    if (!this.sendTarget(lease, this.resetActivation ? 'prepared' : this.target)) return;
    if (!this.resetActivation && state.phase === this.target && state.current)
      this.finish(ok(this.snapshot(state)));
  }

  private sendTarget(lease: CandidateLease, target: LevelTarget): boolean {
    const result = lease.level.target(target);
    if (result.ok) return true;
    this.fail('level-participation-failed', result.error);
    return false;
  }

  private load(): void {
    const abort = new AbortController();
    const work: SourceLoad = { abort, done: Promise.resolve().then(() => this.loadScene(work)) };
    this.source = work;
    this.service.loads.add(work);
  }

  private async loadScene(work: SourceLoad): Promise<void> {
    let hold: AssetHandle<'scene'> | undefined;
    try {
      const result = await this.assets.load(this.scene, 'scene', { signal: work.abort.signal });
      if (result.ok) hold = result.value;
      if (work.abort.signal.aborted || this.service.closed) return;
      if (!result.ok) {
        this.fail('level-load-failed', result.error);
        return;
      }
      let lease: CandidateLease | undefined;
      const started = this.start(result.value, (progress) => {
        if (lease !== undefined && this.candidate === lease) this.observe(progress);
      });
      if (started.ok) {
        lease = { level: started.value, handle: result.value, stopping: false };
        this.candidate = lease;
        hold = undefined;
      } else {
        this.fail('level-participation-failed', started.error);
      }
    } catch (cause) {
      if (!work.abort.signal.aborted && !this.service.closed) this.fail('level-load-failed', cause);
    } finally {
      if (hold !== undefined) this.release(hold);
      this.service.loads.delete(work);
      this.source = undefined;
      this.reconcile();
    }
  }

  private observe(result: Result<LevelCandidateStatus, LevelCandidateError>): void {
    const lease = this.candidate;
    if (lease === undefined) return;
    if (result.ok && result.value.phase === 'retired') {
      this.candidate = undefined;
      this.resetActivation = false;
      this.release(lease.handle);
      this.reconcile();
      return;
    }
    const status = result.ok ? result.value : lease.level.inspect();
    if (status.cleanupFailure !== undefined) {
      this.fail('level-release-failed', status.cleanupFailure);
    } else if (status.failure !== undefined || !result.ok) {
      lease.stopping = true;
      if (this.target !== 'unloaded')
        this.fail('level-participation-failed', result.ok ? status.failure : result.error);
    } else if (status.phase === 'prepared' || status.phase === 'active') {
      if (
        !status.current &&
        this.pending === undefined &&
        this.failure === undefined &&
        !lease.stopping
      ) {
        // The prior success remains historical. The observed owner invalidation
        // starts a new attempt for the retained target.
        this.request(this.target);
      } else {
        this.reconcile(status);
      }
    }
  }

  private release(handle: AssetHandle<'scene'>): void {
    const released = this.assets.release(handle);
    if (!released.ok) this.fail('level-release-failed', released.error);
    else if (this.releaseCache) this.service.retireCache(handle);
  }

  private fail(code: LevelErrorCode, cause: unknown): void {
    const failure = this.error(code, cause);
    if (code === 'level-release-failed') this.cleanupFailure ??= failure;
    else this.failure = failure;
    this.finish(err(failure));
  }
}
