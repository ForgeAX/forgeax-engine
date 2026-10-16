import { watch as fsWatch } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRevisionObserver } from '../dev/revision-observer.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('revision observer lifecycle contract', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('drains an in-flight batch and publishes no work after close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-revision-observer-close-'));
    roots.push(root);
    await mkdir(join(root, 'assets'));
    const source = join(root, 'assets', 'hero.bin');
    await writeFile(source, 'old');
    let release!: () => void;
    const batchRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const batchStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let batches = 0;
    const observer = createRevisionObserver({
      roots: [join(root, 'assets')],
      watchFactory: (watchedRoot) => fsWatch(watchedRoot, () => {}),
      onBatch: async () => {
        batches += 1;
        markStarted();
        await batchRelease;
      },
    });

    await observer.ready;
    await writeFile(source, 'new-content');
    await observer.reconcile();
    const draining = observer.drain();
    await batchStarted;
    const closing = observer.close();
    let closed = false;
    void draining.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([draining, closing]);
    expect(closed).toBe(true);
    expect(batches).toBe(1);

    await writeFile(source, 'newer');
    await expect(observer.reconcile()).rejects.toMatchObject({ code: 'cleanup-failed' });
    expect(batches).toBe(1);
  });
});
