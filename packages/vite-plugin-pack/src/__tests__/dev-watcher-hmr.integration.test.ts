import type { FSWatcher } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DevWatchListener, watchDevRoots } from '../dev/watcher.js';

describe('dev watcher and HMR intake', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('classifies a missing root as an observed diagnostic', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'forgeax-watcher-missing-parent-')), 'missing');
    roots.push(root.slice(0, root.lastIndexOf('/')));
    const errors: Array<{ phase: string; root?: string; revision?: number }> = [];
    const stop = watchDevRoots({
      roots: [root],
      onBatch: async () => {},
      onError: (_error, context) => {
        errors.push(context);
      },
    });
    try {
      await stop.ready;
      expect(errors).toContainEqual({ phase: 'missing-root', revision: 0, root });
    } finally {
      await stop.close();
    }
  });

  it('observes onBatch rejection instead of leaking an async flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-watcher-rejection-'));
    roots.push(root);
    const source = join(root, 'scene.gltf');
    await writeFile(source, '{"version":1}');
    let change: DevWatchListener | undefined;
    let closed = false;
    const errors: Array<{ error: unknown; phase: string; root?: string }> = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    const fakeWatcher = {} as FSWatcher;
    process.on('unhandledRejection', onUnhandled);
    vi.useFakeTimers();
    const stop = watchDevRoots({
      roots: [root],
      debounceMs: 10,
      onBatch: async () => {
        throw new Error('batch rejected');
      },
      watchFactory: (_root, listener) => {
        change = listener;
        return {
          on: () => fakeWatcher,
          close: () => {
            closed = true;
          },
          unref: () => undefined,
        } as unknown as FSWatcher;
      },
      onError: (error, context) => {
        errors.push({ error, ...context });
      },
    });
    await stop.ready;
    await writeFile(source, '{"version":2}');
    change?.('change', source);
    await stop.drain();
    await stop.close();
    vi.useRealTimers();
    process.off('unhandledRejection', onUnhandled);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toEqual(new Error('batch rejected'));
    expect(errors[0]?.phase).toBe('flush');
    expect(unhandled).toHaveLength(0);
    expect(closed).toBe(true);
  });
});
