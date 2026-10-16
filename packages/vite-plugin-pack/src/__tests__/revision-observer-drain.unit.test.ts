import type { FSWatcher } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRevisionObserver, type DevWatchListener } from '../dev/revision-observer.js';

const snapshotGate = vi.hoisted(() => ({
  afterStat: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const fact = await actual.lstat(...args);
      await snapshotGate.afterStat?.(String(args[0]));
      return fact;
    },
  };
});

it('drain observes a write made after an in-flight snapshot already read that file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-observer-drain-'));
  const source = join(root, 'hero.png');
  await writeFile(source, new Uint8Array([1]));
  const observed: string[] = [];
  let changed: DevWatchListener | undefined;
  const watcher = {
    close() {},
    on() {
      return watcher;
    },
    unref() {},
  } as unknown as FSWatcher;
  const observer = createRevisionObserver({
    roots: [root],
    watchFactory: (_root, listener) => {
      changed = listener;
      return watcher;
    },
    onBatch: (batch) => {
      observed.push(...batch.sources.map((entry) => entry.filename));
    },
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const captured = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await observer.ready;
    snapshotGate.afterStat = async (path) => {
      if (path !== source) return;
      snapshotGate.afterStat = undefined;
      entered();
      await blocked;
    };
    changed?.('change', source);
    await captured;
    await writeFile(source, new Uint8Array([2, 3]));
    const drained = observer.drain();
    release();
    await drained;
    expect(observed).toEqual([source]);
  } finally {
    release();
    snapshotGate.afterStat = undefined;
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});
