import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addLoadPhases,
  addLoadWork,
  beginLoadSession,
  beginLoadWork,
  bindLoadProgressScope,
  DEFAULT_LOAD_PROGRESS_LABELS,
  describeLoadProgress,
  ENGINE_STARTUP_PHASES,
  endLoadSession,
  LOAD_PROGRESS_INTERVAL_MS,
  type LoadProgressSnapshot,
  loadProgressScope,
  readLoadProgress,
  resolveLoadProgressLabels,
  subscribeLoadProgress,
} from '../load-progress.js';

const scope = globalThis as Record<string, unknown>;

function resetRealm(page: boolean): void {
  const previous = scope.__forgeaxLoadProgress as { channel?: BroadcastChannel } | undefined;
  previous?.channel?.close();
  delete scope.__forgeaxLoadProgress;
  if (page) scope.document = {};
  else delete scope.document;
}

function read(): LoadProgressSnapshot {
  const snapshot = readLoadProgress();
  if (snapshot === undefined) throw new Error('no session');
  return snapshot;
}

function phase(snapshot: LoadProgressSnapshot, id: string) {
  const found = snapshot.phases.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing phase ${id}`);
  return found;
}

/** Deterministic pseudo-random sequence for property checks. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

let clock = 0;
/** Advance the page clock seen by the progress model. */
function advance(ms: number): void {
  clock += ms;
  vi.spyOn(globalThis.performance, 'now').mockReturnValue(clock);
}

const messageTurn = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => resetRealm(true));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetRealm(false);
});

describe('load progress phase derivation', () => {
  it('derives pending, active and done from counters and tracks the latest activity', () => {
    advance(0);
    beginLoadSession('startup', ENGINE_STARTUP_PHASES);
    expect(read().phases.map((p) => p.state)).toEqual(Array(7).fill('pending'));
    expect(read().current).toBeUndefined();

    const workers = beginLoadWork('workers');
    expect(phase(read(), 'workers').state).toBe('active');
    expect(read().current).toBe('workers');

    // A newer phase replaces a still-active shown phase only after it was shown 1 s.
    addLoadWork('downloads', { total: 4, item: 'pack-index.json' });
    expect(read().current).toBe('workers');
    advance(1000);
    expect(read().current).toBe('downloads');
    expect(phase(read(), 'downloads').item).toBe('pack-index.json');

    workers();
    workers();
    // Unbounded work may grow, so finished work counts 1/2 until the phase settles.
    expect(phase(read(), 'workers')).toMatchObject({
      state: 'done',
      done: 1,
      total: 1,
      fraction: 0.5,
    });
    addLoadWork('downloads', { done: 4 });
    expect(phase(read(), 'downloads')).toMatchObject({ state: 'done', fraction: 0.8 });
    expect(read().current).toBeUndefined();

    // Resumed work becomes the current activity again once nothing else is shown.
    addLoadWork('pipelines', { total: 2 });
    expect(read().current).toBe('pipelines');
    addLoadWork('downloads', { total: 1 });
    advance(1000);
    expect(read().current).toBe('downloads');
  });

  it('completes bounded phases when their known work finishes', () => {
    beginLoadSession('battle', [
      { id: 'map', weight: 1, bounded: true },
      { id: 'downloads', weight: 1 },
      { id: 'battle-frame', weight: 2, bounded: true },
    ]);
    addLoadWork('map', { total: 1, done: 1 });
    addLoadWork('downloads', { total: 3, done: 3 });
    expect(phase(read(), 'map').fraction).toBe(1);
    expect(phase(read(), 'downloads').fraction).toBe(0.75);
    expect(read().fraction).toBeCloseTo((1 + 0.75) / 4);
    addLoadWork('battle-frame', { total: 1 });
    expect(phase(read(), 'downloads').fraction).toBe(1);
    expect(read().fraction).toBeCloseTo(2 / 4);
  });

  it('settles phases without work once the final phase starts, and finishes at 1', () => {
    beginLoadSession('startup', ENGINE_STARTUP_PHASES);
    addLoadWork('downloads', { total: 2, done: 1 });
    beginLoadWork('first-frame');
    const snapshot = read();
    expect(phase(snapshot, 'workers').state).toBe('done');
    expect(phase(snapshot, 'pipelines').fraction).toBe(1);
    expect(phase(snapshot, 'downloads').state).toBe('active');
    expect(snapshot.fraction).toBeLessThan(1);
    endLoadSession('startup');
    expect(read()).toMatchObject({ finished: true, fraction: 1 });
    expect(read().phases.every((p) => p.state === 'done')).toBe(true);
  });

  it('measures work unfinished at the session start, including work in flight', () => {
    addLoadWork('assets', { total: 3, done: 1, totalBytes: 300, bytes: 100 });
    addLoadWork('workers', { total: 1, done: 1 });
    beginLoadSession('battle', [
      { id: 'assets', weight: 1 },
      { id: 'workers', weight: 1 },
    ]);
    expect(phase(read(), 'workers').state).toBe('pending');
    expect(phase(read(), 'assets')).toMatchObject({ state: 'active', done: 0, total: 2 });
    addLoadWork('assets', { done: 2, bytes: 200 });
    expect(phase(read(), 'assets')).toMatchObject({ state: 'done', done: 2, total: 2 });
    addLoadWork('assets', { total: 2, done: 1 });
    expect(phase(read(), 'assets')).toMatchObject({ state: 'active', done: 3, total: 4 });
  });

  it('lists undeclared reported phases with zero weight and accepts App phases', () => {
    beginLoadSession('startup', [
      { id: 'assets', weight: 1 },
      { id: 'first-frame', weight: 1 },
    ]);
    addLoadWork('game-ui', { total: 1 });
    expect(phase(read(), 'game-ui')).toMatchObject({ weight: 0, state: 'active' });
    addLoadPhases([{ id: 'game-ui', weight: 1, bounded: true }]);
    addLoadWork('game-ui', { done: 1 });
    expect(phase(read(), 'game-ui')).toMatchObject({ weight: 1, state: 'done' });
    // Appended phases never become the final phase, so assets stays pending.
    expect(phase(read(), 'assets').state).toBe('pending');
    expect(read().fraction).toBeCloseTo(1 / 3);
  });

  it('uses the smaller of unit and byte completion while sizes arrive', () => {
    beginLoadSession('battle', [{ id: 'assets', weight: 1 }]);
    addLoadWork('assets', { total: 10, done: 9, totalBytes: 1000, bytes: 100 });
    expect(phase(read(), 'assets').fraction).toBeCloseTo(0.1);
    addLoadWork('assets', { bytes: 900 });
    expect(phase(read(), 'assets').fraction).toBeCloseTo(9 / 11);
  });
});

describe('load progress monotonicity', () => {
  it('never moves overall or phase progress backwards while totals grow', () => {
    for (let seed = 1; seed <= 20; seed++) {
      resetRealm(true);
      const next = random(seed);
      beginLoadSession('startup', ENGINE_STARTUP_PHASES);
      const outstanding = new Map<string, number>();
      let previous = read();
      for (let step = 0; step < 400; step++) {
        const id =
          ENGINE_STARTUP_PHASES[Math.floor(next() * ENGINE_STARTUP_PHASES.length)]?.id ?? '';
        const open = outstanding.get(id) ?? 0;
        if (open > 0 && next() < 0.55) {
          addLoadWork(id, { done: 1, bytes: 10 });
          outstanding.set(id, open - 1);
        } else {
          const added = 1 + Math.floor(next() * 5);
          addLoadWork(id, { total: added, totalBytes: added * 10 });
          outstanding.set(id, open + added);
        }
        const current = read();
        expect(current.fraction).toBeGreaterThanOrEqual(previous.fraction);
        expect(current.fraction).toBeLessThanOrEqual(1);
        for (const item of current.phases)
          expect(item.fraction).toBeGreaterThanOrEqual(phase(previous, item.id).fraction);
        previous = current;
      }
      endLoadSession('startup');
      expect(read().fraction).toBe(1);
    }
  });
});

describe('load progress delivery', () => {
  it('coalesces subscriber notifications and reports the end at once', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    beginLoadSession('battle', [{ id: 'assets', weight: 1 }]);
    const seen: number[] = [];
    const stop = subscribeLoadProgress((snapshot) => seen.push(snapshot.phases[0]?.done ?? -1));
    for (let index = 0; index < 50; index++) addLoadWork('assets', { total: 1, done: 1 });
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(LOAD_PROGRESS_INTERVAL_MS);
    expect(seen).toEqual([50]);
    endLoadSession('battle');
    expect(seen).toHaveLength(2);
    stop();
  });

  it('sums Worker realm counters posted to the page scope', async () => {
    beginLoadSession('startup', ENGINE_STARTUP_PHASES);
    addLoadWork('assets', { total: 1 });
    const worker = new BroadcastChannel(`forgeax:load-progress:${loadProgressScope()}`);
    worker.postMessage({
      type: 'state',
      realm: 'render-worker',
      phases: { pipelines: { done: 3, total: 8, bytes: 0, totalBytes: 0, item: 'pbr-opaque' } },
    });
    worker.postMessage({
      type: 'state',
      realm: 'engine-worker',
      phases: { assets: { done: 2, total: 3, bytes: 0, totalBytes: 0 } },
    });
    await messageTurn();
    const snapshot = read();
    expect(phase(snapshot, 'pipelines')).toMatchObject({ done: 3, total: 8, item: 'pbr-opaque' });
    expect(phase(snapshot, 'assets')).toMatchObject({ done: 2, total: 4 });
    worker.close();
  });

  it('posts a Worker realm only after binding, with cumulative coalesced counters', async () => {
    resetRealm(false);
    const page = 'page-under-test';
    const received: unknown[] = [];
    const listener = new BroadcastChannel(`forgeax:load-progress:${page}`);
    listener.onmessage = (event) => received.push(event.data);
    addLoadWork('assets', { total: 2 });
    addLoadWork('assets', { done: 1, item: 'bundle.bin' });
    await messageTurn();
    expect(received).toEqual([]);
    bindLoadProgressScope(page);
    expect(loadProgressScope()).toBe(page);
    await messageTurn();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'state',
      phases: { assets: { done: 1, total: 2, item: 'bundle.bin' } },
    });
    listener.close();
  });
});

describe('load progress text', () => {
  it('describes the current phase with counts, bytes, item and elapsed time', () => {
    beginLoadSession('startup', ENGINE_STARTUP_PHASES, { startedAt: 0 });
    addLoadWork('downloads', {
      total: 52,
      done: 37,
      totalBytes: 30 * 1_048_576,
      bytes: 12.4 * 1_048_576,
      item: 'dust2.bin',
    });
    const view = describeLoadProgress(read());
    expect(view.activity).toBe('Downloading assets');
    expect(view.detail).toBe('37 / 52 · 12 / 30 MB · dust2.bin');
    expect(view.elapsed).toMatch(/^\d+ s$/);
    expect(view.percent).toBeGreaterThanOrEqual(0);
  });

  it('overlays App labels on the English defaults', () => {
    const labels = resolveLoadProgressLabels({
      lang: 'en-GB',
      phases: { assets: 'Fetching game data' },
      elapsed: '{seconds} seconds so far',
    });
    expect(labels.phases.assets).toBe('Fetching game data');
    expect(labels.phases.pipelines).toBe(DEFAULT_LOAD_PROGRESS_LABELS.phases.pipelines);
    beginLoadSession('battle', [{ id: 'assets', weight: 1 }], { startedAt: 0 });
    addLoadWork('assets', { total: 1 });
    expect(describeLoadProgress(read(), labels)).toMatchObject({
      activity: 'Fetching game data',
      detail: '',
    });
    endLoadSession('battle');
    expect(describeLoadProgress(read(), labels)).toMatchObject({
      activity: labels.loading,
      percent: 100,
    });
  });
});
