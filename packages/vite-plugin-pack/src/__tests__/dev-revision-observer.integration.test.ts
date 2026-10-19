import { watch as fsWatch, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRevisionObserver, type DevWatchListener } from '../dev/revision-observer.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function silentNativeWatch(root: string, _listener: DevWatchListener) {
  return fsWatch(root, process.platform === 'darwin' ? { recursive: true } : {}, () => {});
}

describe('revision observer real filesystem contract', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reconciles real stat mutations when native hints are silent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-revision-observer-'));
    roots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const existing = join(assets, 'hero.bin');
    await writeFile(existing, 'old');
    // Same-size writes may share mtime on coarse filesystems. This contract
    // exercises stat reconciliation, so give the baseline a distinct time.
    await utimes(existing, 1, 1);
    const batches: Array<{ revision: number; sources: string[] }> = [];
    const observer = createRevisionObserver({
      roots: [assets],
      watchFactory: silentNativeWatch,
      onBatch: (batch) => {
        batches.push({
          revision: batch.revision,
          sources: batch.sources.map(({ filename }) => filename),
        });
      },
    });

    await observer.ready;
    await writeFile(existing, 'new');
    const added = join(assets, 'nested', 'new.bin');
    await mkdir(join(assets, 'nested'));
    await writeFile(added, 'added');
    const removed = join(assets, 'removed.bin');
    await writeFile(removed, 'removed');
    await rm(removed);
    const revision = await observer.reconcile();
    await observer.drain();

    expect(revision).toBeGreaterThan(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({
      revision,
      sources: expect.arrayContaining([existing, added]),
    });
    expect(batches[0]?.sources).not.toContain(removed);
    await observer.close();
  });

  it('deduplicates an absolute path within one revision and rebuilds directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-revision-observer-dedup-'));
    roots.push(root);
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    const sharedFirst = join(first, 'shared.bin');
    const sharedSecond = join(second, 'shared.bin');
    await writeFile(sharedFirst, 'old');
    await writeFile(sharedSecond, 'old');
    await utimes(sharedSecond, 1, 1);
    const batches: string[][] = [];
    const observer = createRevisionObserver({
      roots: [first, second],
      watchFactory: silentNativeWatch,
      onBatch: (batch) => {
        batches.push(batch.sources.map(({ filename }) => filename));
      },
    });

    await observer.ready;
    await writeFile(sharedFirst, 'new-1');
    await writeFile(sharedFirst, 'new-2');
    await writeFile(sharedSecond, 'new');
    await observer.reconcile();
    await observer.drain();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(expect.arrayContaining([sharedFirst, sharedSecond]));
    expect(new Set(batches[0]).size).toBe(2);
    await observer.close();
  });

  it('keeps a declared file root live through atomic replacement without admitting a sibling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-revision-observer-file-root-'));
    roots.push(root);
    const source = join(root, 'asset.pack.json');
    const sibling = join(root, 'unrelated.pack.json');
    const replacement = join(root, '.asset.pack.next.json');
    await writeFile(source, '{"version":1}');
    // Stage before the watcher starts so staging-file creation cannot mask
    // whether the observer follows the declared file's atomic replacement.
    await writeFile(replacement, '{"version":2}');
    const preservedMtime = new Date('2026-01-01T00:00:00.000Z');
    await utimes(source, preservedMtime, preservedMtime);
    await utimes(replacement, preservedMtime, preservedMtime);
    const sourceBeforeReplacement = await lstat(source);
    const stagedReplacement = await lstat(replacement);
    expect(stagedReplacement.size).toBe(sourceBeforeReplacement.size);
    expect(stagedReplacement.mtimeMs).toBe(sourceBeforeReplacement.mtimeMs);
    expect(stagedReplacement.ino).not.toBe(sourceBeforeReplacement.ino);
    const batches: string[][] = [];
    const watchedRoots: string[] = [];
    const observer = createRevisionObserver({
      roots: [source],
      watchFactory: (watchedRoot, listener) => {
        watchedRoots.push(watchedRoot);
        return fsWatch(
          watchedRoot,
          process.platform === 'darwin' ? { recursive: true } : {},
          listener,
        );
      },
      onBatch: (batch) => {
        batches.push([...batch.sidecars, ...batch.sources].map(({ filename }) => filename));
      },
    });

    // Native directory hints can be absent. The existing observer's stat
    // reconciliation owns delivery; this test adds no watcher or probe timer.
    const waitForBatch = async (): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (batches.length === 0) {
        if (Date.now() >= deadline) {
          throw new Error('declared file root did not receive a revision batch');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    try {
      await observer.ready;
      expect(watchedRoots).toEqual([root]);

      await writeFile(sibling, '{"ignored":true}');
      await observer.drain();
      expect(batches).toEqual([]);

      await rename(replacement, source);
      await waitForBatch();
      await observer.drain();
      expect(batches).toEqual([[source]]);

      batches.length = 0;
      await writeFile(source, '{"version":3}');
      await waitForBatch();
      await observer.drain();
      expect(batches).toEqual([[source]]);
    } finally {
      await observer.close();
    }
  });

  it('closes the startup snapshot race before reporting ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-revision-observer-ready-'));
    roots.push(root);
    let installed = false;
    const late = join(root, 'late.pack.json');
    const batches: string[][] = [];
    const observer = createRevisionObserver({
      roots: [root],
      watchFactory: (watchedRoot, listener) => {
        if (!installed) {
          installed = true;
          // Publish one complete mutation during watcher installation. An
          // unawaited async write can expose both creation and completion as
          // distinct stat revisions before drain, even in one emitted batch.
          writeFileSync(late, '{"version":2}');
        }
        return silentNativeWatch(watchedRoot, listener);
      },
      onBatch: (batch) => {
        batches.push(batch.sidecars.map(({ filename }) => filename));
      },
    });

    try {
      await observer.ready;
      await observer.drain();

      expect(batches).toEqual([[late]]);
      expect(observer.revision()).toBe(1);
    } finally {
      await observer.close();
    }
  });
});
