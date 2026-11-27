import { err, ok, type Result } from '@forgeax/engine-types';
import type { Level, LevelService, LevelStatus, LevelTarget } from '../levels/level-service';
import { RuntimeStreamingScene, type StreamingSceneSource } from './streaming-scene';
import {
  RuntimeStreamingIndex,
  type StreamingCell,
  type StreamingGrid,
  squaredDistance,
  WorldStreamingError,
} from './world-index';

export interface StreamingSource {
  readonly x: number;
  readonly z: number;
  readonly prepareRadius: number;
  readonly activeRadius: number;
  readonly detailRadius?: number;
  readonly roleFilter?: 'visual' | 'collision';
  readonly hysteresis?: number;
  readonly priority?: number;
}

export interface WorldStreamingOptions {
  readonly grid: StreamingGrid;
  readonly cells?: Iterable<StreamingCell>;
  readonly scene?: StreamingSceneSource;
  readonly buildUnitsPerStep?: number;
  readonly selectionUnitsPerStep?: number;
  readonly simultaneousPreparations?: number;
}

type Wanted = Exclude<LevelTarget, 'unloaded'>;
type Intent = { readonly cell: StreamingCell; readonly target: Wanted; readonly priority: number };
type Selection = Map<string, Intent>;
type Query = ReturnType<RuntimeStreamingIndex['query']>;

interface SourceState {
  latest: StreamingSource;
  selected: Selection;
  resolved: StreamingSource | undefined;
  query: { readonly source: StreamingSource; readonly cursor: Query } | undefined;
}

interface Slot {
  readonly cell: StreamingCell;
  readonly level: Level;
  target: LevelTarget;
  pending: boolean;
  requestSequence: number;
  failure: WorldStreamingError | undefined;
  delivered: LevelStatus | undefined;
}

interface GroupWork {
  readonly proxy: readonly StreamingCell[];
  readonly detail: readonly StreamingCell[];
  target: 'proxy' | 'detail' | undefined;
  score: number;
}

const matchesSource = (a: StreamingSource | undefined, b: StreamingSource): boolean =>
  a?.x === b.x &&
  a.z === b.z &&
  a.activeRadius === b.activeRadius &&
  a.prepareRadius === b.prepareRadius &&
  a.detailRadius === b.detailRadius &&
  a.roleFilter === b.roleFilter &&
  a.hysteresis === b.hysteresis &&
  a.priority === b.priority;

function sourceValid(source: StreamingSource): boolean {
  return (
    [
      source.x,
      source.z,
      source.activeRadius,
      source.prepareRadius,
      source.detailRadius ?? 0,
      source.hysteresis ?? 0,
      source.priority ?? 0,
    ].every(Number.isFinite) &&
    source.activeRadius >= 0 &&
    source.prepareRadius >= source.activeRadius &&
    (source.hysteresis ?? 0) >= 0 &&
    (source.detailRadius ?? 0) >= 0 &&
    (source.detailRadius ?? 0) <= source.activeRadius &&
    Number.isFinite(source.prepareRadius + (source.hysteresis ?? 0))
  );
}

function wanted(
  cell: StreamingCell,
  source: StreamingSource,
  previous?: Intent,
): Intent | undefined {
  if (
    source.roleFilter !== undefined &&
    cell.role !== 'combined' &&
    source.roleFilter !== cell.role
  )
    return undefined;
  const distance = Math.sqrt(squaredDistance(source.x, source.z, cell.bounds));
  const hysteresis = source.hysteresis ?? 0;
  const radius =
    cell.replacement?.role === 'detail'
      ? (source.detailRadius ?? source.activeRadius)
      : source.activeRadius;
  const active = radius + (previous?.target === 'active' ? hysteresis : 0);
  const prepare = source.prepareRadius + (previous === undefined ? 0 : hysteresis);
  if (distance > prepare) return undefined;
  return {
    cell,
    target: distance <= active ? 'active' : 'prepared',
    priority: (source.priority ?? 0) - distance,
  };
}

const targetRank = { unloaded: 0, prepared: 1, active: 2 };
function merge(selection: Selection, intent: Intent): void {
  const previous = selection.get(intent.cell.key);
  if (
    previous === undefined ||
    targetRank[intent.target] > targetRank[previous.target] ||
    (intent.target === previous.target && intent.priority > previous.priority)
  )
    selection.set(intent.cell.key, intent);
}

function count(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new WorldStreamingError('invalid-index', {
      subject: 'work grants',
      reason: 'positive integer required',
    });
  return value;
}

export type StreamingEntryStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'unavailable'; readonly reason: 'missing-collision' | 'disabled-layer' }
  | { readonly state: 'ready' };

/** Drives spatial demand in the World realm. App Level owns all preparation and retirement. */
export class WorldStreaming {
  private readonly index: RuntimeStreamingIndex;
  private readonly content: RuntimeStreamingScene | undefined;
  private readonly producing = new Map<string, AbortController>();
  private readonly productionFailures = new Map<string, WorldStreamingError>();
  private readonly sources = new Map<string, SourceState>();
  private readonly disabledLayers = new Set<string>();
  private readonly slots = new Map<string, Slot>();
  private readonly buildUnits: number;
  private readonly selectionUnits: number;
  private readonly simultaneousPreparations: number;
  private sourceCursor = this.sources.values();
  private desired: Selection = new Map();
  private dirty = true;
  private closed = false;
  private groupChanging = false;
  private fault: WorldStreamingError | undefined;
  private startedCount = 0;
  private retiredCount = 0;

  constructor(
    private readonly levels: LevelService,
    options: WorldStreamingOptions,
  ) {
    const content =
      options.scene === undefined ? undefined : new RuntimeStreamingScene(options.scene);
    this.content = content;
    function* cells(): Generator<StreamingCell | undefined> {
      if (options.cells !== undefined) yield* options.cells;
      if (content !== undefined) yield* content.cells(options.grid);
    }
    this.index = new RuntimeStreamingIndex(cells(), options.grid);
    this.buildUnits = count(options.buildUnitsPerStep, 256);
    this.selectionUnits = count(options.selectionUnitsPerStep, 256);
    this.simultaneousPreparations = count(options.simultaneousPreparations, 1);
  }

  setSource(key: string, source: StreamingSource | undefined): Result<void, WorldStreamingError> {
    if (this.closed || key.length === 0 || (source !== undefined && !sourceValid(source)))
      return err(
        new WorldStreamingError('invalid-source', {
          subject: key,
          reason: 'invalid or closed source',
        }),
      );
    if (source === undefined) {
      this.dirty = this.sources.delete(key) || this.dirty;
      return ok(undefined);
    }
    const state = this.sources.get(key);
    if (state === undefined) {
      this.sources.set(key, {
        latest: { ...source },
        selected: new Map(),
        resolved: undefined,
        query: undefined,
      });
    } else if (!matchesSource(state.latest, source)) state.latest = { ...source };
    return ok(undefined);
  }

  setLayer(layer: string, enabled: boolean): void {
    if (enabled) this.disabledLayers.delete(layer);
    else this.disabledLayers.add(layer);
    this.dirty = true;
  }

  private layerEnabled(cell: StreamingCell): boolean {
    return cell.layer === undefined || !this.disabledLayers.has(cell.layer);
  }

  private advanceSource(state: SourceState): boolean {
    if (state.query === undefined) {
      const source = state.latest;
      if (matchesSource(state.resolved, source)) return false;
      const radius = source.prepareRadius + (source.hysteresis ?? 0);
      state.query = { source, cursor: this.index.query(source.x, source.z, radius) };
    }
    const { source, cursor } = state.query;
    for (let units = 0; units < this.selectionUnits; units++) {
      const result = cursor.next();
      if (!result.done) continue;
      state.query = undefined;
      if (result.value === undefined) return false;
      const selected: Selection = new Map();
      for (const [key, cell] of result.value) {
        const intent = wanted(cell, source, state.selected.get(key));
        if (intent !== undefined) selected.set(key, intent);
      }
      state.selected = selected;
      state.resolved = source;
      this.dirty = true;
      return true;
    }
    return true;
  }

  private select(): void {
    // Resume at the next source every tick even when a large query spans ticks.
    for (let remaining = this.sources.size; remaining > 0; remaining--) {
      let next = this.sourceCursor.next();
      if (next.done) {
        this.sourceCursor = this.sources.values();
        next = this.sourceCursor.next();
      }
      if (next.done || this.advanceSource(next.value)) return;
    }
  }

  private rebuildDemand(): void {
    if (!this.dirty) return;
    const desired: Selection = new Map();
    for (const { selected } of this.sources.values())
      for (const intent of selected.values())
        if (this.layerEnabled(intent.cell)) merge(desired, intent);
    this.desired = desired;
    this.dirty = false;
  }

  private wishGroups(): Map<string, GroupWork> {
    const groups = new Map<string, GroupWork>();
    for (const { cell, target, priority } of this.desired.values()) {
      const replacement = cell.replacement;
      if (replacement === undefined) continue;
      let group = groups.get(replacement.group);
      if (group === undefined) {
        const record = this.index.groups.get(replacement.group);
        if (record === undefined) continue;
        group = { ...record, target: undefined, score: priority };
        groups.set(replacement.group, group);
      }
      if (target === 'active' && group.target !== 'detail') group.target = replacement.role;
      group.score = Math.max(group.score, priority);
    }
    return groups;
  }

  private applyGroups(desired: Selection): void {
    for (const { proxy, detail, target, score } of this.wishGroups().values()) {
      const current = proxy.some((cell) => this.slots.get(cell.key)?.target === 'active')
        ? 'proxy'
        : detail.some((cell) => this.slots.get(cell.key)?.target === 'active')
          ? 'detail'
          : undefined;
      // Hold the established coverage while every member of the next representation prepares.
      const cover = target === undefined ? undefined : (current ?? 'proxy');
      if (cover !== undefined) {
        for (const cell of cover === 'proxy' ? proxy : detail)
          desired.set(cell.key, { cell, target: 'active', priority: score });
      }
      if (target !== undefined && target !== cover) {
        const next = target === 'proxy' ? proxy : detail;
        for (const cell of next)
          desired.set(cell.key, { cell, target: 'prepared', priority: score });
        const previous = cover === 'proxy' ? proxy : detail;
        this.exchange(next, previous);
      }
    }
  }

  private exchange(show: readonly StreamingCell[], hide: readonly StreamingCell[]): void {
    if (this.groupChanging) return;
    const next = this.preparedSlots(show, 'prepared');
    const previous = this.preparedSlots(hide, 'active');
    if (next === undefined || previous === undefined) return;
    const result = this.levels.exchangeVisual({
      show: next.map(({ level }) => level),
      hide: previous.map(({ level }) => level),
    });
    if (!result.ok) return;
    this.groupChanging = true;
    void result.value.then((receipt) => {
      this.groupChanging = false;
      if (receipt.ok) {
        for (const slot of next) this.acceptExchange(slot, 'active');
        for (const slot of previous) this.acceptExchange(slot, 'prepared');
      }
      if (this.closed) this.unloadAll();
    });
  }

  private acceptExchange(slot: Slot, target: Wanted): void {
    slot.target = target;
    slot.delivered = slot.level.inspect();
  }

  private preparedSlots(cells: readonly StreamingCell[], phase: Wanted): Slot[] | undefined {
    const slots: Slot[] = [];
    for (const cell of cells) {
      const slot = this.slots.get(cell.key);
      if (slot === undefined || slot.pending || slot.target !== phase) return undefined;
      const current = slot.level.inspect();
      if (!current.current || current.phase !== phase) return undefined;
      slots.push(slot);
    }
    return slots;
  }

  private currentDemand(): Selection {
    const desired: Selection = new Map();
    for (const [key, intent] of this.desired) {
      desired.set(
        key,
        intent.cell.replacement === undefined ? intent : { ...intent, target: 'prepared' },
      );
    }
    this.applyGroups(desired);
    return desired;
  }

  private levelFailure(cell: StreamingCell, cause: unknown): WorldStreamingError {
    return new WorldStreamingError(
      'level-failed',
      { subject: cell.key, reason: 'Level request failed' },
      cause,
    );
  }

  private request(slot: Slot, target: LevelTarget): void {
    if (
      slot.target === target &&
      (slot.pending || slot.delivered !== undefined || slot.failure !== undefined)
    )
      return;
    slot.target = target;
    slot.failure = undefined;
    slot.pending = false;
    const sequence = ++slot.requestSequence;
    const result = slot.level.request(target);
    if (!result.ok) {
      slot.failure = this.levelFailure(slot.cell, result.error);
      return;
    }
    slot.pending = true;
    const request = result.value;
    void request.done.then((settled) => {
      if (slot.requestSequence !== sequence || this.slots.get(slot.cell.key) !== slot) return;
      if (!settled.ok && settled.error.code === 'level-request-superseded') return;
      slot.pending = false;
      if (!settled.ok) slot.failure = this.levelFailure(slot.cell, settled.error);
      else if (target === 'unloaded') {
        this.slots.delete(slot.cell.key);
        this.content?.withdraw(slot.cell.scene);
        this.retiredCount++;
      } else slot.delivered = settled.value;
    });
  }

  private createSlot(cell: StreamingCell, target: Wanted): void {
    const created = this.levels.create({ scene: cell.scene, releaseCache: true });
    if (!created.ok) {
      this.content?.withdraw(cell.scene);
      this.productionFailures.set(cell.key, this.levelFailure(cell, created.error));
      return;
    }
    const slot: Slot = {
      cell,
      level: created.value,
      target: 'unloaded',
      pending: false,
      requestSequence: 0,
      failure: undefined,
      delivered: undefined,
    };
    this.slots.set(cell.key, slot);
    this.startedCount++;
    this.request(slot, target);
  }

  private prepare(intent: Intent): void {
    const { cell, target } = intent;
    const content = this.content;
    if (content === undefined || !content.has(cell.scene)) {
      this.createSlot(cell, target);
      return;
    }
    const stop = new AbortController();
    this.producing.set(cell.key, stop);
    void content
      .publish(cell.scene, stop.signal)
      .then(
        () => {
          if (stop.signal.aborted) content.withdraw(cell.scene);
          else this.createSlot(cell, this.lastDemand.get(cell.key)?.target ?? 'prepared');
        },
        (cause) => {
          if (!stop.signal.aborted)
            this.productionFailures.set(cell.key, this.levelFailure(cell, cause));
        },
      )
      .finally(() => this.producing.delete(cell.key));
  }

  private lastDemand: Selection = new Map();

  private dispatch(desired: Selection): void {
    this.lastDemand = desired;
    for (const [key, task] of this.producing) if (!desired.has(key)) task.abort();
    for (const key of this.productionFailures.keys())
      if (!desired.has(key)) this.productionFailures.delete(key);
    let inPreparation = this.producing.size;
    for (const [key, slot] of this.slots) {
      const target = desired.get(key)?.target ?? 'unloaded';
      // Let the authoritative receipt settle the group before changing any member's intent.
      if (!this.groupChanging || slot.cell.replacement === undefined) this.request(slot, target);
      if (slot.pending && slot.target !== 'unloaded') inPreparation++;
    }
    const available = this.simultaneousPreparations - inPreparation;
    if (available <= 0) return;
    const work = [...desired.values()].filter(
      ({ cell }) =>
        !this.slots.has(cell.key) &&
        !this.producing.has(cell.key) &&
        !this.productionFailures.has(cell.key),
    );
    work.sort((a, b) => targetRank[b.target] - targetRank[a.target] || b.priority - a.priority);
    for (const intent of work.slice(0, available)) this.prepare(intent);
  }

  step(): Result<void, WorldStreamingError> {
    if (this.fault !== undefined) return err(this.fault);
    if (this.closed) return ok(undefined);
    try {
      this.index.advance(this.buildUnits);
      this.select();
      this.rebuildDemand();
      this.dispatch(this.currentDemand());
      return this.fault === undefined ? ok(undefined) : err(this.fault);
    } catch (cause) {
      this.fault =
        cause instanceof WorldStreamingError
          ? cause
          : new WorldStreamingError(
              'invalid-index',
              { subject: 'build', reason: 'index construction failed' },
              cause,
            );
      return err(this.fault);
    }
  }

  /** Read this from FixedUpdate immediately before accepting movement or teleportation. */
  inspectEntry(
    key: string,
    point?: { readonly x: number; readonly z: number },
  ): StreamingEntryStatus {
    const source = this.sources.get(key);
    if (source === undefined || !matchesSource(source.resolved, source.latest))
      return { state: 'pending' };
    let hasCollision = false;
    for (const { cell, target } of source.selected.values()) {
      if (target !== 'active' || cell.role === 'visual') continue;
      if (point !== undefined && squaredDistance(point.x, point.z, cell.bounds) !== 0) continue;
      if (!this.layerEnabled(cell)) return { state: 'unavailable', reason: 'disabled-layer' };
      hasCollision = true;
      const status = this.slots.get(cell.key)?.level.inspect();
      if (status?.phase !== 'active' || !status.current || !status.collisionAccepted)
        return { state: 'pending' };
    }
    return hasCollision
      ? { state: 'ready' }
      : { state: 'unavailable', reason: 'missing-collision' };
  }

  inspectCell(key: string): LevelStatus | undefined {
    return this.slots.get(key)?.level.inspect();
  }

  inspect() {
    return {
      index: this.index.inspect(),
      active: [...this.slots.values()].map(({ cell, level, target, failure }) => {
        const status = level.inspect();
        return {
          key: cell.key,
          target,
          phase: status.phase,
          current: status.current,
          picture: status.picture,
          failure,
        };
      }),
      started: this.startedCount,
      retired: this.retiredCount,
      exchangePending: this.groupChanging,
      failures: [...this.productionFailures.values()],
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sources.clear();
    for (const task of this.producing.values()) task.abort();
    if (!this.groupChanging) this.unloadAll();
  }

  private unloadAll(): void {
    for (const slot of this.slots.values()) this.request(slot, 'unloaded');
  }
}

export function createWorldStreaming(
  levels: LevelService,
  options: WorldStreamingOptions,
): Result<WorldStreaming, WorldStreamingError> {
  try {
    return ok(new WorldStreaming(levels, options));
  } catch (cause) {
    if (cause instanceof WorldStreamingError) return err(cause);
    throw cause;
  }
}
