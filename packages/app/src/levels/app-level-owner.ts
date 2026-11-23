import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineSystem, FixedUpdate, type SystemToken, type World } from '@forgeax/engine-ecs';
import { PhysicsSimulation, PhysicsSync } from '@forgeax/engine-physics';
import { RapierPhysicsWorld3D } from '@forgeax/engine-physics-rapier3d';
import { type AssetHandle, err, ok, type Result } from '@forgeax/engine-types';
import type { App } from '../types';
import {
  createLevelCandidate,
  type LevelCandidate,
  LevelCandidateError,
  type LevelCandidatePhase,
  type LevelCandidateStatus,
  type VisualLevelChange,
} from './candidate';
import type { CandidateRenderHost, LevelRenderSelection } from './candidate-render-source';
import { AppLevelService, type LevelExchangeMembers, type LevelTarget } from './level-service';
import { DEFAULT_LEVEL_WORK_SLICE_MS } from './work-slice';

type ObserveCandidate = (status: Result<LevelCandidateStatus, LevelCandidateError>) => void;
interface Entry {
  readonly handle: AppLevelCandidate;
  readonly candidate: LevelCandidate;
  readonly observe: ObserveCandidate | undefined;
  target: LevelTarget;
}
interface EntryWork {
  readonly entry: Entry;
  readonly status: ReturnType<LevelCandidate['workStatus']>;
}

interface VisualExchange {
  readonly moves: readonly { readonly entry: Entry; readonly active: boolean }[];
  readonly finish: (result: Result<void, LevelCandidateError>) => void;
  changes: readonly VisualLevelChange[] | undefined;
  refused: { readonly cause: unknown } | undefined;
}

function preparesOnlySceneSource(phase: LevelCandidatePhase): boolean {
  switch (phase) {
    case 'capture-begin':
    case 'capture':
    case 'publication':
    case 'vocabulary':
    case 'materialize':
    case 'roster':
    case 'transforms':
      return true;
    default:
      return false;
  }
}
export interface AppLevelCandidate {
  target(target: LevelTarget): Result<void, LevelCandidateError>;
  inspect(): LevelCandidateStatus;
  readonly phase: LevelCandidatePhase;
  readonly members: LevelCandidate['members'];
}

/** Internal M1 assembly, with one fixed participation owner and bounded outer-frame grants. */
export class AppLevelOwner {
  readonly service: AppLevelService;
  private readonly entries = new Map<AppLevelCandidate, Entry>();
  private qualificationCursor = this.entries.values();
  private exchange: VisualExchange | undefined;
  private closed = false;
  private boundary: SystemToken | undefined;
  private participationGranted = false;
  private failure: LevelCandidateError | undefined;
  readonly costs = {
    turns: 0,
    turnMs: 0,
    maxTurnMs: 0,
    units: 0,
    totalMs: 0,
    maxUnitMs: 0,
    worst: undefined as
      | {
          phase: LevelCandidateStatus['phase'];
          renderPhase: string | undefined;
          resourcePhase: string | undefined;
          beginMs: number;
          elapsedMs: number;
        }
      | undefined,
  };
  constructor(
    private readonly host: {
      readonly world: World;
      render(): CandidateRenderHost | undefined;
      readonly assets: AssetRegistry | undefined;
      now(): number;
      physics(): unknown;
      stopped(): boolean;
    },
  ) {
    this.service = new AppLevelService(
      host.assets,
      (scene, observe) => this.create(scene, observe),
      (members) => this.scheduleVisualExchange(members),
    );
  }
  create(
    scene: AssetHandle<'scene'>,
    observe?: ObserveCandidate,
  ): Result<AppLevelCandidate, LevelCandidateError> {
    const { world, assets } = this.host;
    const render = this.host.render();
    if (this.closed || assets === undefined || render === undefined || !render.current())
      return err(new LevelCandidateError({ reason: 'render-unavailable', phase: 'capture-begin' }));
    if (this.boundary === undefined) {
      const boundary = defineSystem({
        name: 'level-participation',
        queries: [],
        after: [PhysicsSync],
        before: [PhysicsSimulation],
        fn: () => this.acceptBoundary(),
      });
      world.addSystem(FixedUpdate, boundary).unwrap();
      this.boundary = boundary;
    }
    const physics = this.host.physics();
    const candidate = createLevelCandidate({
      world,
      assets,
      scene,
      render,
      stopped: this.host.stopped,
      ...(physics instanceof RapierPhysicsWorld3D ? { physics } : {}),
    });
    const handle: AppLevelCandidate = {
      get members() {
        return candidate.members;
      },
      get phase() {
        return candidate.phase;
      },
      inspect: () => candidate.inspect(),
      target: (target) => {
        const { phase } = candidate;
        if (this.closed || phase === 'retired')
          return err(new LevelCandidateError({ reason: 'closed', phase }));
        entry.target = target;
        return ok(undefined);
      },
    };
    const entry: Entry = { candidate, handle, observe, target: 'prepared' };
    this.entries.set(handle, entry);
    return ok(handle);
  }

  private scheduleVisualExchange(
    members: LevelExchangeMembers,
  ): Result<Promise<Result<void, LevelCandidateError>>, LevelCandidateError> {
    if (this.closed || this.exchange !== undefined)
      return err(new LevelCandidateError({ reason: 'busy', phase: 'prepared' }));
    const moves: VisualExchange['moves'][number][] = [];
    for (const { candidate, active } of members) {
      const entry = this.entries.get(candidate);
      if (entry === undefined)
        return err(new LevelCandidateError({ reason: 'closed', phase: 'prepared' }));
      moves.push({ entry, active });
    }
    return ok(
      new Promise((finish) => {
        this.exchange = { moves, finish, changes: undefined, refused: undefined };
      }),
    );
  }

  private finishVisualExchange(
    exchange: VisualExchange,
    result: Result<void, LevelCandidateError>,
  ): void {
    this.exchange = undefined;
    exchange.finish(result);
  }

  private beginVisualExchange(exchange: VisualExchange): void {
    const changes: VisualLevelChange[] = [];
    for (const { entry, active } of exchange.moves) {
      const planned = entry.candidate.visualChange(active);
      if (!planned.ok) {
        this.finishVisualExchange(exchange, planned);
        return;
      }
      changes.push(planned.value);
    }
    exchange.changes = changes;
    const receipts: (void | Promise<LevelRenderSelection>)[] = [];
    try {
      const apply = () => {
        for (const change of changes) receipts.push(change.apply());
      };
      const batch = this.host.render()?.batchSelections;
      if (batch === undefined) apply();
      else batch(apply);
    } catch (cause) {
      for (const receipt of receipts) if (receipt !== undefined) void receipt.catch(() => {});
      this.finishVisualExchange(
        exchange,
        err(new LevelCandidateError({ reason: 'owner', phase: 'active' }, cause)),
      );
      // Once source application starts, unexpected partial effects fault the App.
      throw cause;
    }
    if (receipts.every((receipt) => receipt === undefined)) {
      this.confirmVisualExchange(exchange, changes, []);
      return;
    }
    void Promise.all(receipts).then(
      (complete) => this.confirmVisualExchange(exchange, changes, complete),
      (cause) => {
        exchange.refused = { cause };
      },
    );
  }

  private confirmVisualExchange(
    exchange: VisualExchange,
    changes: readonly VisualLevelChange[],
    receipts: readonly (void | LevelRenderSelection)[],
  ): void {
    if (this.exchange !== exchange) return;
    for (const [index, { entry, active }] of exchange.moves.entries()) {
      changes[index]?.commit(receipts[index] || undefined);
      entry.target = active ? 'active' : 'prepared';
    }
    this.finishVisualExchange(exchange, ok(undefined));
  }

  private advanceVisualExchange(): boolean {
    const exchange = this.exchange;
    if (exchange === undefined) return false;
    this.participationGranted = false;
    if (exchange.changes === undefined) this.beginVisualExchange(exchange);
    else if (exchange.refused !== undefined) {
      const failure = new LevelCandidateError(
        { reason: 'owner', phase: 'active' },
        exchange.refused.cause,
      );
      try {
        for (const change of [...exchange.changes].reverse())
          change.restoreSource(exchange.refused.cause);
      } finally {
        this.finishVisualExchange(exchange, err(failure));
      }
    }
    return true;
  }

  private exchanging(entry: Entry): boolean {
    return this.exchange?.moves.some((move) => move.entry === entry) === true;
  }

  /** A frame that can publish a picture grants one fixed-boundary participation transaction. */
  beginFrame(publish = true): void {
    this.participationGranted = publish;
  }

  stopRequests(): void {
    this.service.stop();
    if (this.exchange !== undefined)
      this.finishVisualExchange(
        this.exchange,
        err(
          new LevelCandidateError({
            reason: 'closed',
            phase: 'prepared',
          }),
        ),
      );
  }

  private acceptBoundary(): void {
    if (!this.participationGranted || this.advanceVisualExchange()) return;
    for (const entry of this.entries.values()) {
      const { candidate, target } = entry;
      const { phase } = candidate;
      const failure = phase === 'failed' ? candidate.workStatus().failure : undefined;
      if (failure !== undefined) {
        this.failure ??= failure;
        entry.target = 'unloaded';
      }
      if (
        (phase === 'prepared' && target === 'active' && candidate.inspect().current) ||
        (phase === 'active' && target !== 'active') ||
        phase === 'reverting-activation' ||
        (failure !== undefined && candidate.needsStop)
      ) {
        this.participationGranted = false;
        const result = candidate.accept(phase === 'prepared');
        const observe = entry.observe;
        if (observe !== undefined) {
          observe(result);
          if (result.ok && result.value.pending !== undefined)
            void result.value.pending.then(() => observe(ok(candidate.inspect())));
        }
        if (!result.ok) {
          this.failure ??= result.error;
          throw result.error;
        }
        return;
      }
    }
  }
  private workEntry(): EntryWork | undefined {
    let queued: EntryWork | undefined;
    let progressing: EntryWork | undefined;
    for (const entry of this.entries.values()) {
      const work = this.requestedWork(entry);
      if (work === undefined) continue;
      const { status } = work;
      // Keep the shared Source and View work with its current owner even
      // when another request already prepared some private CPU state.
      if (status.phase === 'render-source' || status.phase === 'native') return work;
      if (
        (status.phase === 'failed' && entry.target === 'unloaded') ||
        (status.phase !== 'capture-begin' &&
          status.phase !== 'prepared' &&
          status.phase !== 'failed')
      )
        progressing ??= work;
      queued ??= work;
    }
    return progressing ?? queued ?? this.viewMaintenanceEntry();
  }
  private requestedWork(entry: Entry): EntryWork | undefined {
    if (this.exchanging(entry)) return undefined;
    const status = entry.candidate.workStatus();
    if (status.cleanupFailure !== undefined) return undefined;
    switch (status.phase) {
      case 'active':
      case 'activating':
      case 'reverting-activation':
      case 'deactivating':
        return undefined;
      case 'failed':
        if (entry.target !== 'unloaded') return undefined;
        break;
      case 'prepared':
        // Requests advance before maintaining dormant View preparations.
        if (entry.target === 'prepared') return undefined;
        if (entry.target === 'active' && entry.candidate.inspect().current) return undefined;
        break;
    }
    return { entry, status };
  }
  private viewMaintenanceEntry(): EntryWork | undefined {
    for (const entry of this.entries.values()) {
      if (entry.target !== 'prepared' || this.exchanging(entry)) continue;
      const status = entry.candidate.workStatus();
      if (status.phase === 'prepared' && !entry.candidate.viewsCurrent()) return { entry, status };
    }
    return undefined;
  }
  private retirementEntry(except: Entry): EntryWork | undefined {
    for (const entry of this.entries.values()) {
      if (entry === except || entry.target !== 'unloaded') continue;
      const status = entry.candidate.workStatus();
      if (
        !entry.candidate.needsStop &&
        status.pending === undefined &&
        status.cleanupFailure === undefined
      )
        return { entry, status };
    }
    return undefined;
  }
  private sourcePreparationEntry(except: Entry): EntryWork | undefined {
    for (const entry of this.entries.values()) {
      if (entry === except || entry.target === 'unloaded') continue;
      const status = entry.candidate.workStatus();
      if (status.pending === undefined && preparesOnlySceneSource(status.phase))
        return { entry, status };
    }
    return undefined;
  }
  step(grantMs = DEFAULT_LEVEL_WORK_SLICE_MS): void {
    if (this.closed || (this.entries.size === 0 && !this.service.hasCacheRetirement)) return;
    const now = this.host.now;
    const start = now();
    try {
      this.checkOneQualification();
      this.runScheduledWork(grantMs, now, start);
    } finally {
      const elapsed = now() - start;
      this.costs.turns++;
      this.costs.turnMs += elapsed;
      this.costs.maxTurnMs = Math.max(this.costs.maxTurnMs, elapsed);
    }
  }
  private checkOneQualification(): void {
    let next = this.qualificationCursor.next();
    if (next.done) {
      this.qualificationCursor = this.entries.values();
      next = this.qualificationCursor.next();
    }
    if (next.done) return;
    const { candidate, observe, target } = next.value;
    if (this.exchanging(next.value)) return;
    if (
      observe === undefined ||
      target === 'unloaded' ||
      (candidate.phase !== 'prepared' && candidate.phase !== 'active')
    )
      return;
    const status = candidate.inspect();
    if (!status.current) observe(ok(status));
  }
  private runScheduledWork(grantMs: number, now: () => number, start: number): void {
    const canContinue = () => now() - start < grantMs;
    let cacheUnits = 32;
    this.service.drainCache(() => cacheUnits-- > 0 && canContinue());
    for (let pass = 0; pass < 256 && canContinue(); pass++) {
      let work = this.workEntry();
      if (work === undefined) return;
      if (work.status.pending !== undefined)
        work = this.retirementEntry(work.entry) ?? this.sourcePreparationEntry(work.entry);
      if (work === undefined) return;
      const { entry } = work;
      const begin = now();
      const result =
        entry.target === 'unloaded'
          ? entry.candidate.retireStep(canContinue)
          : entry.candidate.step();
      const elapsed = now() - begin;
      this.costs.units++;
      this.costs.totalMs += elapsed;
      if (elapsed > this.costs.maxUnitMs)
        this.costs.worst = {
          phase: work.status.phase,
          renderPhase: work.status.render?.phase,
          resourcePhase: work.status.render?.resources?.phase,
          beginMs: begin,
          elapsedMs: elapsed,
        };
      this.costs.maxUnitMs = Math.max(this.costs.maxUnitMs, elapsed);
      if (!result.ok) {
        this.failure ??= result.error;
        entry.target = 'unloaded';
      } else if (result.value.phase === 'retired') this.entries.delete(entry.handle);
      entry.observe?.(result);
    }
  }
  inspect() {
    return { live: this.entries.size, failure: this.failure, costs: { ...this.costs } };
  }
  /** Called only after the App stops and all admitted frame receipts settle. */
  async closeStopped(mode: 'retire-members' | 'replace-world' = 'retire-members'): Promise<void> {
    if (!this.host.stopped())
      throw Error('Level close requires the stopped App and drained receipts');
    this.closed = true;
    this.stopRequests();
    await this.service.drainLoads();
    if (this.boundary !== undefined) {
      this.host.world.removeSystem(FixedUpdate, this.boundary).unwrap();
      this.boundary = undefined;
    }
    const failures: unknown[] = [];
    for (const entry of this.entries.values()) {
      try {
        await this.closeEntry(entry);
        this.entries.delete(entry.handle);
      } catch (cause) {
        // Native participation has retired before this error. A World replacement
        // discards the poisoned ECS and its Registry as a unit.
        if (
          mode === 'replace-world' &&
          cause instanceof LevelCandidateError &&
          cause.detail.reason === 'world-faulted' &&
          cause.detail.world === this.host.world.identity
        )
          this.entries.delete(entry.handle);
        else failures.push(cause);
      }
      entry.observe?.(ok(entry.candidate.inspect()));
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'App Level retirement remains owned');
  }
  private async closeEntry({ candidate }: Entry): Promise<void> {
    if (candidate.needsStop) {
      const stopped = candidate.accept(false);
      if (!stopped.ok) {
        const physics = this.host.physics();
        if (physics instanceof RapierPhysicsWorld3D) physics.dispose();
      }
    }
    for (;;) {
      const status = candidate.retireStep().unwrap();
      if (status.phase === 'retired') break;
      if (status.pending !== undefined) await status.pending;
      else await Promise.resolve();
    }
  }
}

const owners = new WeakMap<App, () => AppLevelOwner>();
export function bindAppLevelOwner(app: App, owner: () => AppLevelOwner): void {
  owners.set(app, owner);
}
export function appLevelOwner(app: App): AppLevelOwner {
  const owner = owners.get(app);
  if (owner === undefined) throw Error('App has no local Level owner');
  return owner();
}
