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
} from './candidate';
import type { CandidateRenderHost } from './candidate-render-source';
import { DEFAULT_LEVEL_WORK_SLICE_MS } from './work-slice';

type Target = 'prepared' | 'active' | 'unloaded';
interface Entry {
  readonly candidate: LevelCandidate;
  target: Target;
}
interface EntryWork {
  readonly entry: Entry;
  readonly status: ReturnType<LevelCandidate['workStatus']>;
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
  target(target: Target): Result<void, LevelCandidateError>;
  inspect(): LevelCandidateStatus;
  readonly members: LevelCandidate['members'];
}

/** Internal M1 assembly, with one fixed participation owner and bounded outer-frame grants. */
export class AppLevelOwner {
  private readonly entries = new Set<Entry>();
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
  ) {}
  create(scene: AssetHandle<'scene'>): Result<AppLevelCandidate, LevelCandidateError> {
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
    const entry: Entry = { candidate, target: 'prepared' };
    this.entries.add(entry);
    return ok({
      get members() {
        return candidate.members;
      },
      inspect: () => candidate.inspect(),
      target: (target) => {
        const { phase } = candidate;
        if (this.closed || phase === 'retired')
          return err(new LevelCandidateError({ reason: 'closed', phase }));
        entry.target = target;
        return ok(undefined);
      },
    });
  }
  /** A frame that can publish a picture grants one fixed-boundary participation transaction. */
  beginFrame(publish = true): void {
    this.participationGranted = publish;
  }

  private acceptBoundary(): void {
    if (!this.participationGranted) return;
    for (const entry of this.entries) {
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
    for (const entry of this.entries) {
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
    for (const entry of this.entries) {
      if (entry.target !== 'prepared') continue;
      const status = entry.candidate.workStatus();
      if (status.phase === 'prepared' && !entry.candidate.viewsCurrent()) return { entry, status };
    }
    return undefined;
  }
  private retirementEntry(except: Entry): EntryWork | undefined {
    for (const entry of this.entries) {
      if (entry === except || entry.target !== 'unloaded') continue;
      const status = entry.candidate.workStatus();
      if (
        status.phase !== 'active' &&
        status.pending === undefined &&
        status.cleanupFailure === undefined
      )
        return { entry, status };
    }
    return undefined;
  }
  private sourcePreparationEntry(except: Entry): EntryWork | undefined {
    for (const entry of this.entries) {
      if (entry === except || entry.target === 'unloaded') continue;
      const status = entry.candidate.workStatus();
      if (status.pending === undefined && preparesOnlySceneSource(status.phase))
        return { entry, status };
    }
    return undefined;
  }
  step(grantMs = DEFAULT_LEVEL_WORK_SLICE_MS): void {
    if (this.closed || this.entries.size === 0) return;
    const now = this.host.now;
    const start = now();
    try {
      this.runScheduledWork(grantMs, now, start);
    } finally {
      const elapsed = now() - start;
      this.costs.turns++;
      this.costs.turnMs += elapsed;
      this.costs.maxTurnMs = Math.max(this.costs.maxTurnMs, elapsed);
    }
  }
  private runScheduledWork(grantMs: number, now: () => number, start: number): void {
    const canContinue = () => now() - start < grantMs;
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
      } else if (result.value.phase === 'retired') this.entries.delete(entry);
    }
  }
  inspect() {
    return { live: this.entries.size, failure: this.failure, costs: { ...this.costs } };
  }
  /** Called only after the App stops and all admitted frame receipts settle. */
  async closeStopped(): Promise<void> {
    if (!this.host.stopped())
      throw Error('Level close requires the stopped App and drained receipts');
    this.closed = true;
    if (this.boundary !== undefined) {
      this.host.world.removeSystem(FixedUpdate, this.boundary).unwrap();
      this.boundary = undefined;
    }
    const failures: unknown[] = [];
    for (const entry of this.entries) {
      try {
        await this.closeEntry(entry);
        this.entries.delete(entry);
      } catch (cause) {
        failures.push(cause);
      }
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
