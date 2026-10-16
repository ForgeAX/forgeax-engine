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
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: string) => {
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
      return actual.lstat(path);
    },
  };
});

import { createRevisionObserver } from '../dev/revision-observer.js';

describe('revision observer probe scheduling', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    probeGate.root = '';
    probeGate.blockNext = false;
    probeGate.entered = undefined;
    probeGate.release = undefined;
    probeGate.rootSnapshots = 0;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
