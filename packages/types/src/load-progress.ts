/**
 * Live load progress shared by Engine producers, the startup cover and App UIs.
 *
 * Producers in any realm add units of work to a named phase with
 * {@link addLoadWork}: discovered work raises `total`, finished work raises
 * `done`, and transfers may add byte counts. A Worker realm posts its
 * cumulative per-phase counters to its page at most every 100 ms over one
 * page-scoped BroadcastChannel; the page sums every realm.
 *
 * A load session ({@link beginLoadSession}) declares weighted phases and
 * measures work from its start. Phase state is derived from counters only:
 * no work is `pending`, unfinished work is `active`, finished work is `done`.
 * Once the final declared phase has work, phases that never received any count
 * as done. Overall progress is the weighted mean of per-phase fractions, each
 * held at its session maximum, so it never moves backwards while totals grow.
 */

import { type LoadChannel, loadChannelConstructor } from './load-channel.js';

/** Increments reported by one producer. Every count is a non-negative delta. */
export interface LoadWork {
  /** Finished units. */
  readonly done?: number;
  /** Discovered units. */
  readonly total?: number;
  /** Finished bytes, counted in the same unit as `totalBytes`. */
  readonly bytes?: number;
  /** Bytes whose size became known. */
  readonly totalBytes?: number;
  /** Current item, e.g. a file or pipeline label. */
  readonly item?: string;
}

export interface LoadPhaseDefinition {
  readonly id: string;
  /** Share of overall progress relative to the other declared phases. */
  readonly weight: number;
  /**
   * The producer reports the whole total before finishing it, so finishing all
   * known work completes the phase. Unbounded phases (downloads, pipelines)
   * may discover more work and count as complete only once settled.
   */
  readonly bounded?: boolean;
}

export type LoadPhaseState = 'pending' | 'active' | 'done';

export interface LoadPhaseProgress {
  readonly id: string;
  /** Declared weight; `0` for phases that reported work without being declared. */
  readonly weight: number;
  readonly state: LoadPhaseState;
  readonly done: number;
  readonly total: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly item?: string;
  /** Monotonic phase completion in `[0, 1]`. */
  readonly fraction: number;
}

export interface LoadProgressSnapshot {
  readonly session: string;
  /** Page `performance.now()` at session start (`0` is navigation start). */
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly finished: boolean;
  /** Monotonic overall completion in `[0, 1]`. */
  readonly fraction: number;
  /** Most recently activated phase that still has unfinished work. */
  readonly current?: string;
  readonly phases: readonly LoadPhaseProgress[];
}

/** Engine startup phases in work order, weighted by their usual share of a cold start. */
export const ENGINE_STARTUP_PHASES: readonly LoadPhaseDefinition[] = Object.freeze([
  { id: 'engine-code', weight: 10, bounded: true },
  { id: 'workers', weight: 10 },
  { id: 'downloads', weight: 25 },
  { id: 'assets', weight: 15 },
  { id: 'pipelines', weight: 20 },
  { id: 'scene', weight: 10 },
  { id: 'first-frame', weight: 10, bounded: true },
]);

interface Counters {
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  item?: string;
}

interface Session {
  readonly id: string;
  readonly phases: LoadPhaseDefinition[];
  readonly startedAt: number;
  readonly baseline: Map<string, Counters>;
  readonly fractions: Map<string, number>;
  readonly activated: Map<string, number>;
  readonly states: Map<string, LoadPhaseState>;
  /** Last phase declared at session start; App phases added later never replace it. */
  readonly finalPhase: string | undefined;
  /** Phase shown as the current activity and when it became current. */
  current: string | undefined;
  currentSince: number;
  finalReached: boolean;
  fraction: number;
  finished: boolean;
}

type ProgressMessage =
  | { readonly type: 'state'; readonly realm: string; readonly phases: Record<string, Counters> }
  | { readonly type: 'sync' };

interface Store {
  readonly realm: string;
  readonly page: boolean;
  readonly local: Map<string, Counters>;
  readonly remote: Map<string, Map<string, Counters>>;
  readonly items: Map<string, string>;
  readonly listeners: Set<(snapshot: LoadProgressSnapshot) => void>;
  session?: Session;
  /** Page this realm reports to; a page reports to itself. */
  scope?: string;
  channel?: LoadChannel;
  flushTimer?: ReturnType<typeof setTimeout> | undefined;
  notifyTimer?: ReturnType<typeof setTimeout> | undefined;
  dirty: boolean;
  sequence: number;
}

/** Coalescing interval for Worker posts and page notifications. */
export const LOAD_PROGRESS_INTERVAL_MS = 100;
const CHANNEL_PREFIX = 'forgeax:load-progress:';
const GLOBAL_KEY = '__forgeaxLoadProgress';
const scope = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Store };

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function store(): Store {
  // One store per realm even when bundlers duplicate this module.
  let current = scope[GLOBAL_KEY];
  if (current === undefined) {
    const page = typeof (globalThis as { document?: unknown }).document === 'object';
    current = {
      realm: Math.random().toString(36).slice(2, 12),
      page,
      local: new Map(),
      remote: new Map(),
      items: new Map(),
      listeners: new Set(),
      dirty: false,
      sequence: 0,
    };
    scope[GLOBAL_KEY] = current;
    if (page) openChannel(current, current.realm);
  }
  return current;
}

function openChannel(target: Store, name: string): void {
  if (target.channel !== undefined) return;
  target.scope = name;
  const Channel = loadChannelConstructor();
  if (Channel === undefined) return;
  try {
    const channel = new Channel(CHANNEL_PREFIX + name);
    // Node keeps a process alive while a channel is referenced.
    channel.unref?.();
    channel.onmessage = (event) => receive(target, event.data as ProgressMessage | undefined);
    target.channel = channel;
    if (target.page) channel.postMessage({ type: 'sync' } satisfies ProgressMessage);
  } catch {
    // Without a channel, each realm still reports its own work locally.
  }
}

function receive(target: Store, message: ProgressMessage | undefined): void {
  if (message?.type === 'sync') {
    if (!target.page) flush(target);
    return;
  }
  if (message?.type !== 'state' || !target.page || message.realm === target.realm) return;
  const previous = target.remote.get(message.realm);
  const next = new Map<string, Counters>();
  for (const [phase, counters] of Object.entries(message.phases)) {
    next.set(phase, { ...counters });
    if (counters.item !== undefined && counters.item !== previous?.get(phase)?.item)
      target.items.set(phase, counters.item);
  }
  target.remote.set(message.realm, next);
  scheduleNotify(target);
}

function amount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Add work to `phase` in this realm. Never throws; invalid counts are ignored. */
export function addLoadWork(phase: string, work: LoadWork): void {
  const target = store();
  let counters = target.local.get(phase);
  if (counters === undefined) {
    counters = { done: 0, total: 0, bytes: 0, totalBytes: 0 };
    target.local.set(phase, counters);
  }
  counters.done += amount(work.done);
  counters.total += amount(work.total);
  counters.bytes += amount(work.bytes);
  counters.totalBytes += amount(work.totalBytes);
  if (work.item !== undefined && work.item.length > 0) {
    counters.item = work.item;
    target.items.set(phase, work.item);
  }
  if (target.page) scheduleNotify(target);
  else scheduleFlush(target);
}

/**
 * Report one indeterminate unit of work and return its completion; calling the
 * completion twice finishes once.
 */
export function beginLoadWork(phase: string, item?: string): () => void {
  addLoadWork(phase, item === undefined ? { total: 1 } : { total: 1, item });
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    addLoadWork(phase, { done: 1 });
  };
}

/**
 * Page identity a Worker realm needs to reach this page's progress model; a
 * bound Worker returns its page so nested Workers report to the same page.
 */
export function loadProgressScope(): string | undefined {
  return store().scope;
}

/** Bind a Worker realm to its page; earlier work is posted on binding. */
export function bindLoadProgressScope(page: string): void {
  const target = store();
  if (target.page || page.length === 0) return;
  openChannel(target, page);
  if (target.dirty) flush(target);
}

function scheduleFlush(target: Store): void {
  target.dirty = true;
  if (target.flushTimer !== undefined || target.channel === undefined) return;
  target.flushTimer = setTimeout(() => flush(target), LOAD_PROGRESS_INTERVAL_MS);
}

function flush(target: Store): void {
  if (target.flushTimer !== undefined) clearTimeout(target.flushTimer);
  target.flushTimer = undefined;
  if (target.channel === undefined) return;
  target.dirty = false;
  target.channel.postMessage({
    type: 'state',
    realm: target.realm,
    phases: Object.fromEntries(target.local),
  } satisfies ProgressMessage);
}

function scheduleNotify(target: Store): void {
  if (target.notifyTimer !== undefined || target.session === undefined) return;
  target.notifyTimer = setTimeout(() => notify(target), LOAD_PROGRESS_INTERVAL_MS);
}

function notify(target: Store): void {
  if (target.notifyTimer !== undefined) clearTimeout(target.notifyTimer);
  target.notifyTimer = undefined;
  const snapshot = readLoadProgress();
  if (snapshot === undefined) return;
  for (const listener of [...target.listeners]) {
    try {
      listener(snapshot);
    } catch {
      // A failing view must not stop other views or the producers.
    }
  }
}

function sums(target: Store): Map<string, Counters> {
  const result = new Map<string, Counters>();
  const add = (phases: Map<string, Counters>) => {
    for (const [phase, counters] of phases) {
      const sum = result.get(phase) ?? { done: 0, total: 0, bytes: 0, totalBytes: 0 };
      sum.done += counters.done;
      sum.total += counters.total;
      sum.bytes += counters.bytes;
      sum.totalBytes += counters.totalBytes;
      result.set(phase, sum);
    }
  };
  add(target.local);
  for (const phases of target.remote.values()) add(phases);
  return result;
}

function admitPhase(phase: LoadPhaseDefinition): LoadPhaseDefinition {
  const weight = Number.isFinite(phase.weight) && phase.weight > 0 ? phase.weight : 0;
  return phase.bounded === true
    ? { id: phase.id, weight, bounded: true }
    : { id: phase.id, weight };
}

/**
 * Start measuring a load on this page. A new session replaces the previous one;
 * work already in flight counts toward the new session only once it finishes.
 */
export function beginLoadSession(
  id: string,
  phases: readonly LoadPhaseDefinition[],
  options: { readonly startedAt?: number } = {},
): void {
  const target = store();
  target.session = {
    id,
    phases: phases.map(admitPhase),
    startedAt: options.startedAt ?? nowMs(),
    baseline: sums(target),
    fractions: new Map(),
    activated: new Map(),
    states: new Map(),
    finalPhase: phases[phases.length - 1]?.id,
    current: undefined,
    currentSince: 0,
    finalReached: false,
    fraction: 0,
    finished: false,
  };
  scheduleNotify(target);
}

/**
 * Append App-defined phases to the active session. Existing phase ids keep
 * their weight. Overall progress never decreases when weights are added.
 */
export function addLoadPhases(phases: readonly LoadPhaseDefinition[]): void {
  const session = store().session;
  if (session === undefined || session.finished) return;
  for (const phase of phases) {
    if (session.phases.some((known) => known.id === phase.id)) continue;
    session.phases.push(admitPhase(phase));
  }
}

/** Finish session `id`: overall progress becomes 1 and subscribers hear it at once. */
export function endLoadSession(id: string): void {
  const target = store();
  if (target.session?.id !== id || target.session.finished) return;
  target.session.finished = true;
  notify(target);
}

/** Observe the active session; called at most every 100 ms and once at its end. */
export function subscribeLoadProgress(
  listener: (snapshot: LoadProgressSnapshot) => void,
): () => void {
  const target = store();
  target.listeners.add(listener);
  scheduleNotify(target);
  return () => {
    target.listeners.delete(listener);
  };
}

/**
 * Session work: everything not finished at session start. Work already in
 * flight then belongs to the new load, so a session never finishes before it.
 */
function delta(current: Counters | undefined, base: Counters | undefined): Counters {
  const done = base?.done ?? 0;
  const bytes = base?.bytes ?? 0;
  const total = Math.max(0, (current?.total ?? 0) - done);
  const totalBytes = Math.max(0, (current?.totalBytes ?? 0) - bytes);
  return {
    done: Math.min(total, Math.max(0, (current?.done ?? 0) - done)),
    total,
    bytes: Math.min(totalBytes, Math.max(0, (current?.bytes ?? 0) - bytes)),
    totalBytes,
  };
}

function stateOf(work: Counters): LoadPhaseState {
  if (work.total === 0) return 'pending';
  return work.done < work.total ? 'active' : 'done';
}

/**
 * Phase completion from counters. Until a phase is settled, more work may
 * still be discovered, so at least one more unit is assumed: one finished file
 * of one known counts 1/2, three hundred of three hundred count 300/301.
 * Byte sizes arrive per transfer; the smaller of both views is the honest one.
 */
function measured(work: Counters, settled: boolean): number {
  if (settled) return 1;
  if (work.total === 0) return 0;
  const units = work.done / (work.total + 1);
  return work.totalBytes > 0 ? Math.min(units, work.bytes / work.totalBytes) : units;
}

function phaseIds(session: Session, current: Map<string, Counters>): string[] {
  const ids = session.phases.map((phase) => phase.id);
  for (const [phase, counters] of current) {
    if (!ids.includes(phase) && delta(counters, session.baseline.get(phase)).total > 0)
      ids.push(phase);
  }
  return ids;
}

function reachFinalPhase(session: Session, current: Map<string, Counters>): void {
  if (session.finalPhase === undefined || session.finalReached) return;
  const final = session.finalPhase;
  session.finalReached = delta(current.get(final), session.baseline.get(final)).total > 0;
}

function phaseProgress(
  target: Store,
  session: Session,
  id: string,
  counters: Counters | undefined,
): LoadPhaseProgress {
  const work = delta(counters, session.baseline.get(id));
  let state = stateOf(work);
  // Reaching the final phase settles phases without unfinished work; ending settles all.
  if ((state === 'pending' && session.finalReached) || session.finished) state = 'done';
  const definition = session.phases.find((phase) => phase.id === id);
  const settled =
    session.finished ||
    (state === 'done' && (session.finalReached || definition?.bounded === true));
  const fraction = Math.max(session.fractions.get(id) ?? 0, measured(work, settled));
  session.fractions.set(id, fraction);
  // A phase that resumes work becomes the current activity again.
  if (state === 'active' && session.states.get(id) !== 'active')
    session.activated.set(id, ++target.sequence);
  session.states.set(id, state);
  const weight = definition?.weight ?? 0;
  const item = target.items.get(id);
  return { id, weight, state, ...work, ...(item === undefined ? {} : { item }), fraction };
}

/** A shown phase that is still active stays at least this long before a newer one replaces it. */
const CURRENT_DWELL_MS = 1000;

/** Keep alternating overlapped phases (e.g. downloads during a map stage) readable. */
function holdCurrent(
  session: Session,
  phases: readonly LoadPhaseProgress[],
  latest: string | undefined,
): string | undefined {
  const now = nowMs();
  const shown = session.current;
  const shownActive = phases.some((phase) => phase.id === shown && phase.state === 'active');
  if (
    shown !== undefined &&
    shownActive &&
    latest !== shown &&
    now - session.currentSince < CURRENT_DWELL_MS
  )
    return shown;
  if (latest !== shown) {
    session.current = latest;
    session.currentSince = now;
  }
  return latest;
}

/** Current page snapshot of the active or last session, or `undefined` before any session. */
export function readLoadProgress(): LoadProgressSnapshot | undefined {
  const target = store();
  const session = target.session;
  if (session === undefined) return undefined;
  const current = sums(target);
  reachFinalPhase(session, current);
  const phases = phaseIds(session, current).map((id) =>
    phaseProgress(target, session, id, current.get(id)),
  );
  let weighted = 0;
  let weights = 0;
  let latest: string | undefined;
  let order = 0;
  for (const phase of phases) {
    weighted += phase.weight * phase.fraction;
    weights += phase.weight;
    const activated = session.activated.get(phase.id) ?? 0;
    if (phase.state === 'active' && activated > order) {
      order = activated;
      latest = phase.id;
    }
  }
  const currentPhase = holdCurrent(session, phases, latest);
  const overall = session.finished ? 1 : weights > 0 ? weighted / weights : 0;
  session.fraction = Math.min(1, Math.max(session.fraction, overall));
  return {
    session: session.id,
    startedAt: session.startedAt,
    elapsedMs: Math.max(0, nowMs() - session.startedAt),
    finished: session.finished,
    fraction: session.fraction,
    ...(currentPhase === undefined ? {} : { current: currentPhase }),
    phases,
  };
}

/** Text shown for a snapshot. `{seconds}` in `elapsed` is replaced by whole seconds. */
export interface LoadProgressLabels {
  /** BCP 47 language of the labels. */
  readonly lang: string;
  readonly phases: Readonly<Record<string, string>>;
  readonly loading: string;
  readonly elapsed: string;
  readonly slow: string;
  readonly reload: string;
}

export type LoadProgressLabelInput = Partial<Omit<LoadProgressLabels, 'phases'>> & {
  readonly phases?: Readonly<Record<string, string>>;
};

export const DEFAULT_LOAD_PROGRESS_LABELS: LoadProgressLabels = Object.freeze({
  lang: 'en',
  phases: Object.freeze({
    'engine-code': 'Downloading engine code',
    workers: 'Starting workers',
    downloads: 'Downloading assets',
    assets: 'Loading assets',
    pipelines: 'Preparing shaders and pipelines',
    scene: 'Building the scene',
    'first-frame': 'Waiting for the first frame',
  }),
  loading: 'Loading…',
  elapsed: '{seconds} s',
  slow: 'Still loading. You can keep waiting or reload.',
  reload: 'Reload',
});

/** English defaults overlaid with App-supplied labels. */
export function resolveLoadProgressLabels(input?: LoadProgressLabelInput): LoadProgressLabels {
  if (input === undefined) return DEFAULT_LOAD_PROGRESS_LABELS;
  return {
    ...DEFAULT_LOAD_PROGRESS_LABELS,
    ...input,
    phases: { ...DEFAULT_LOAD_PROGRESS_LABELS.phases, ...input.phases },
  };
}

export interface LoadProgressView {
  /** Whole percent, never above 100. */
  readonly percent: number;
  /** Current phase in plain words. */
  readonly activity: string;
  /** Determinate counts, bytes and the current item when known. */
  readonly detail: string;
  readonly elapsed: string;
}

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0);
}

/** Plain-words view of a snapshot for a loading screen. */
export function describeLoadProgress(
  snapshot: LoadProgressSnapshot,
  labels: LoadProgressLabels = DEFAULT_LOAD_PROGRESS_LABELS,
): LoadProgressView {
  const phase = snapshot.phases.find((candidate) => candidate.id === snapshot.current);
  const parts: string[] = [];
  if (phase !== undefined) {
    if (phase.total > 1) parts.push(`${phase.done} / ${phase.total}`);
    if (phase.totalBytes > 0)
      parts.push(`${megabytes(phase.bytes)} / ${megabytes(phase.totalBytes)} MB`);
    if (phase.item !== undefined) parts.push(phase.item);
  }
  return {
    percent: Math.min(100, Math.floor(snapshot.fraction * 100)),
    activity: phase === undefined ? labels.loading : (labels.phases[phase.id] ?? phase.id),
    detail: parts.join(' · '),
    elapsed: labels.elapsed.replace('{seconds}', String(Math.floor(snapshot.elapsedMs / 1000))),
  };
}
