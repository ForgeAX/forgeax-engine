import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probeGate = vi.hoisted(() => ({
  root: '',
  blockNext: false,
  entered: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  rootSnapshots: 0,
  trackCalls: false,
  inFlight: 0,
  maximumInFlight: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: string) => {
      const tracked = probeGate.trackCalls;
      if (tracked) {
        probeGate.inFlight += 1;
        probeGate.maximumInFlight = Math.max(probeGate.maximumInFlight, probeGate.inFlight);
      }
      try {
        if (path === probeGate.root) {
          probeGate.rootSnapshots += 1;
          if (probeGate.blockNext) {
            probeGate.blockNext = false;
            probeGate.entered?.();
            await new Promise<void>((resolve) => {
              probeGate.release = resolve;
            });
          }
        }
        return await actual.lstat(path);
      } finally {
        if (tracked) probeGate.inFlight -= 1;
      }
    },
  };
});

import { createRevisionObserver } from '../dev/revision-observer.js';

describe('revision observer probe scheduling', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    probeGate.root = '';
    probeGate.blockNext = false;
    probeGate.entered = undefined;
    probeGate.release = undefined;
    probeGate.rootSnapshots = 0;
    probeGate.trackCalls = false;
    probeGate.inFlight = 0;
    probeGate.maximumInFlight = 0;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reports actual snapshot I/O only when workspace timing is enabled', async () => {
    vi.stubEnv('FORGEAX_WORKSPACE_TIMING', '1');
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), 'forgeax-revision-timing-'));
    roots.push(root);
    await Promise.all(['a', 'b', 'c'].map((file) => writeFile(join(root, file), 'source')));
    const watcher = { close: () => {}, on: () => watcher, unref: () => {} } as never;
    const observer = createRevisionObserver({
      roots: [root],
      watchFactory: () => watcher,
      onBatch: () => {},
    });
    try {
      await observer.ready;
      await observer.drain();
      const snapshots = logs.mock.calls
        .filter(([prefix]) => prefix === '[forgeax.dev-watch.timing]')
        .map(([, json]) => JSON.parse(String(json)));
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) {
        expect(snapshot).toMatchObject({
          stage: 'snapshot',
          completed: true,
          rootCount: 1,
          statCalls: 4,
          directoryReads: 1,
          fileCount: 3,
        });
        expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await observer.close();
    }
  });

  it('bounds snapshot I/O while observing every file in a wide root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-revision-width-'));
    roots.push(root);
    const files = Array.from({ length: 32 }, (_, index) => join(root, `asset-${index}.png`));
    await Promise.all(files.map((file) => writeFile(file, 'old')));
    const observed = new Set<string>();
    const watcher = { close: () => {}, on: () => watcher, unref: () => {} } as never;
    probeGate.trackCalls = true;
    const observer = createRevisionObserver({
      roots: [root],
      watchFactory: () => watcher,
      onBatch: (batch) => {
        for (const source of batch.sources) observed.add(source.filename);
      },
    });
    try {
      await observer.ready;
      await Promise.all(files.map((file) => writeFile(file, 'updated')));
      await observer.drain();
      expect([...observed].sort()).toEqual([...files].sort());
      expect(probeGate.maximumInFlight).toBeGreaterThan(1);
      expect(probeGate.maximumInFlight).toBeLessThanOrEqual(8);
      expect(probeGate.inFlight).toBe(0);
    } finally {
      await observer.close();
    }
  });

  it.each([
    [120, 1_200],
    [90_000, 60_000],
  ])('spaces a %i ms snapshot by %i ms after completion', async (cost, delay) => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'forgeax-revision-spacing-'));
    roots.push(root);
    probeGate.root = root;
    probeGate.blockNext = true;
    const entered = new Promise<void>((resolve) => {
      probeGate.entered = resolve;
    });
    const fakeWatcher = { close: () => {}, on: () => fakeWatcher, unref: () => {} } as never;
    const observer = createRevisionObserver({
      roots: [root],
      watchFactory: () => fakeWatcher,
      onBatch: () => {},
    });
    await entered;
    await vi.advanceTimersByTimeAsync(cost);
    probeGate.release?.();
    await observer.ready;
    try {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(probeGate.rootSnapshots).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(probeGate.rootSnapshots).toBe(2);
    } finally {
      await observer.close();
    }
  });

  it('does not turn a probe tick into another snapshot while one is in flight', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'forgeax-revision-probe-'));
    roots.push(root);
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'hero.bin'), 'old');
    const watchedRoot = join(root, 'assets');
    probeGate.root = watchedRoot;

    const fakeWatcher = {
      close: () => {},
      on: () => fakeWatcher,
      unref: () => {},
    } as never;
    const observer = createRevisionObserver({
      roots: [watchedRoot],
      debounceMs: 100,
      watchFactory: () => fakeWatcher,
      onBatch: () => {},
    });
    await observer.ready;
    const baselineSnapshots = probeGate.rootSnapshots;
    probeGate.blockNext = true;
    const entered = new Promise<void>((resolve) => {
      probeGate.entered = resolve;
    });
    const reconcile = observer.reconcile();
    await entered;

    await vi.advanceTimersByTimeAsync(100);
    probeGate.release?.();
    await reconcile;

    expect(probeGate.rootSnapshots).toBe(baselineSnapshots + 1);
    await observer.close();
  });
});
