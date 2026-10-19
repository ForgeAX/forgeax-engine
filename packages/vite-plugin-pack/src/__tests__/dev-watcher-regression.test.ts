// @perf-budget-skip: intentional real file-watcher integration regression gate.

import type { FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_DELTA_EVENT } from '../catalog-transport.js';
import { createRevisionObserver, type DevWatchListener } from '../dev/revision-observer.js';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const WATCHER_EVENT_TIMEOUT_MS = 30_000;

interface RecordedMessage {
  readonly type: string;
  readonly payload: {
    readonly type: string;
    readonly event?: string;
    readonly data?: unknown;
  };
}

function mockServer(): {
  readonly middlewares: { use(handler: unknown): void };
  readonly ws: {
    send(payload: { type: string } & Record<string, unknown>): void;
    calls: RecordedMessage[];
  };
} {
  const calls: RecordedMessage[] = [];
  return {
    middlewares: { use: () => {} },
    ws: {
      calls,
      send(payload) {
        calls.push({ type: payload.type, payload });
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WATCHER_EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('watcher event was not observed');
}

describe('dev watcher regression', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-pack-watcher-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'hud.ui.html'), '<div>HUD</div>');
    await writeFile(join(root, 'assets', 'hud.ui.css'), '.hud { color: white; }');
    await writeFile(join(root, 'assets', 'hero.png'), new Uint8Array([1]));
    await writeFile(join(root, 'assets', 'level.reel.json'), '{"version":1}');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('retains UI classification and full reload for non-UI consumers', async () => {
    const server = mockServer();
    const plugin = pluginPack({ roots: [join(root, 'assets')] });
    plugin.configureServer(server);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await writeFile(join(root, 'assets', 'hud.ui.html'), '<div>HUD v2</div>');
    await waitFor(() => server.ws.calls.some((call) => call.type === 'full-reload'));
    expect(server.ws.calls.some((call) => call.payload.event === CATALOG_DELTA_EVENT)).toBe(false);

    server.ws.calls.length = 0;
    await writeFile(join(root, 'assets', 'hud.ui.css'), '.hud { color: black; }');
    await waitFor(() => server.ws.calls.some((call) => call.type === 'full-reload'));
    expect(server.ws.calls.some((call) => call.payload.event === CATALOG_DELTA_EVENT)).toBe(false);

    server.ws.calls.length = 0;
    await writeFile(join(root, 'assets', 'hero.png'), new Uint8Array([2]));
    await waitFor(() => server.ws.calls.some((call) => call.type === 'full-reload'));
    expect(server.ws.calls.some((call) => call.payload.event === CATALOG_DELTA_EVENT)).toBe(false);

    server.ws.calls.length = 0;
    await writeFile(join(root, 'assets', 'level.reel.json'), '{"version":2}');
    await waitFor(() => server.ws.calls.some((call) => call.type === 'full-reload'));
    expect(server.ws.calls.some((call) => call.payload.event === CATALOG_DELTA_EVENT)).toBe(false);
    await plugin.closeBundle();
  });

  it('emits absolute paths so duplicate names in separate roots stay distinct', async () => {
    const secondRoot = join(root, 'second-assets');
    await mkdir(secondRoot);
    const firstPath = join(root, 'assets', 'shared.bin');
    const secondPath = join(secondRoot, 'shared.bin');
    await writeFile(firstPath, new Uint8Array([1]));
    await writeFile(secondPath, new Uint8Array([1]));

    const batches: Array<{ readonly sources: readonly { readonly filename: string }[] }> = [];
    const stop = createRevisionObserver({
      roots: [join(root, 'assets'), secondRoot],
      debounceMs: 10,
      onBatch: (batch) => {
        batches.push({ sources: batch.sources });
      },
    });
    try {
      await stop.ready;
      await writeFile(firstPath, new Uint8Array([2, 3, 4]));
      await writeFile(secondPath, new Uint8Array([2, 3, 4]));
      await stop.reconcile();
      await stop.drain();
      // Debounce coalescing is best-effort under a contended event loop. The
      // contract is that each root's absolute path is retained, even when
      // the two notifications arrive in separate batches.
      const paths = batches.flatMap((batch) => batch.sources.map((change) => change.filename));
      expect(paths).toContain(firstPath);
      expect(paths).toContain(secondPath);
      expect(paths.every(isAbsolute)).toBe(true);
    } finally {
      await stop.close();
    }
  });

  it('retains add/change/unlink across roots and stops delivery after close', async () => {
    const secondRoot = join(root, 'second-assets');
    await mkdir(secondRoot);
    const firstPath = join(root, 'assets', 'lifecycle.bin');
    const secondPath = join(secondRoot, 'lifecycle.bin');
    const batches: Array<{
      readonly sidecars: readonly { readonly filename: string }[];
      readonly sources: readonly { readonly filename: string }[];
    }> = [];
    const watcher = createRevisionObserver({
      roots: [join(root, 'assets'), secondRoot],
      debounceMs: 10,
      onBatch: (batch) => {
        batches.push(batch);
      },
    });
    await watcher.ready;
    try {
      const waitForPath = async (path: string): Promise<void> => {
        await waitFor(() =>
          batches.some((batch) =>
            [...batch.sources, ...batch.sidecars].some((change) => change.filename === path),
          ),
        );
      };
      await writeFile(firstPath, 'add-1');
      await waitForPath(firstPath);
      await writeFile(firstPath, 'change-1');
      await waitForPath(firstPath);
      await unlink(firstPath);
      await waitForPath(firstPath);

      await writeFile(secondPath, 'add-2');
      await waitForPath(secondPath);
      await writeFile(secondPath, 'change-2');
      await waitForPath(secondPath);
      await unlink(secondPath);
      await waitForPath(secondPath);
      expect(
        batches
          .flatMap((batch) => [...batch.sources, ...batch.sidecars])
          .every((change) => isAbsolute(change.filename)),
      ).toBe(true);
    } finally {
      await watcher.close();
    }

    const countAfterStop = batches.length;
    await writeFile(firstPath, 'ignored-after-stop');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(batches).toHaveLength(countAfterStop);
    await unlink(firstPath);
  });

  it('co-batches a source and sidecar before the first ready-dependent generation', async () => {
    const sourcePath = join(root, 'assets', 'material.bin');
    const sidecarPath = `${sourcePath}.meta.json`;
    await writeFile(sourcePath, 'source-old');
    await writeFile(sidecarPath, '{"revision":0}');
    const batches: Array<{
      readonly sidecars: readonly { readonly filename: string }[];
      readonly sources: readonly { readonly filename: string }[];
    }> = [];
    const watcher = createRevisionObserver({
      roots: [join(root, 'assets')],
      // Chokidar's bounded polling interval is 100ms; keep one debounce
      // window around the two pre-ready writes so their producer generation
      // is delivered as one source+sidecar batch.
      debounceMs: 250,
      onBatch: (batch) => {
        batches.push(batch);
      },
    });
    await writeFile(sourcePath, 'source-before-ready');
    await writeFile(sidecarPath, '{"revision":1}');
    await watcher.ready;
    try {
      await waitFor(() =>
        batches.some(
          (batch) =>
            batch.sources.some((change) => change.filename === sourcePath) &&
            batch.sidecars.some((change) => change.filename === sidecarPath),
        ),
      );
    } finally {
      await watcher.close();
    }
  });

  it('reconciles a source changed during a deferred batch exactly once', async () => {
    const source = join(root, 'assets', 'hero.png');
    const unrelated = join(root, 'assets', 'level.reel.json');
    const batches: Array<{ readonly sources: readonly { readonly filename: string }[] }> = [];
    let change: DevWatchListener | undefined;
    let releaseBatch!: () => void;
    let batchEntered!: () => void;
    const batchEnteredPromise = new Promise<void>((resolve) => {
      batchEntered = resolve;
    });
    const batchReleasePromise = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const fakeWatcher = {
      close: () => {},
      on: () => fakeWatcher,
      unref: () => {},
    } as unknown as FSWatcher;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const stop = createRevisionObserver({
      roots: [join(root, 'assets')],
      debounceMs: 10,
      onBatch: async (batch) => {
        batches.push({ sources: batch.sources });
        if (batches.length === 1) {
          batchEntered();
          await batchReleasePromise;
        }
      },
      watchFactory: (_root, listener) => {
        change = listener;
        return fakeWatcher;
      },
    });
    try {
      await stop.ready;
      await writeFile(unrelated, '{"version":2}');
      change?.('change', unrelated);
      await stop.reconcile();
      await vi.advanceTimersByTimeAsync(10);
      await batchEnteredPromise;

      await writeFile(source, new Uint8Array([2]));
      const reconciled = stop.reconcile();
      releaseBatch();
      await reconciled;
      await stop.drain();

      const sourcePaths = batches.flatMap((batch) =>
        batch.sources
          .map((candidate) => candidate.filename)
          .filter((filename) => filename === source),
      );
      expect(sourcePaths).toEqual([source]);
    } finally {
      await stop.close();
      vi.useRealTimers();
    }
  });

  it('does not reschedule reconciliation after stopping a deferred batch', async () => {
    const unrelated = join(root, 'assets', 'level.reel.json');
    const batches: Array<{ readonly sources: readonly { readonly filename: string }[] }> = [];
    let change: DevWatchListener | undefined;
    let releaseBatch!: () => void;
    let batchEntered!: () => void;
    const batchEnteredPromise = new Promise<void>((resolve) => {
      batchEntered = resolve;
    });
    const batchReleasePromise = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const fakeWatcher = {
      close: () => {},
      on: () => fakeWatcher,
      unref: () => {},
    } as unknown as FSWatcher;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const stop = createRevisionObserver({
      roots: [join(root, 'assets')],
      debounceMs: 10,
      onBatch: async (batch) => {
        batches.push({ sources: batch.sources });
        batchEntered();
        await batchReleasePromise;
      },
      watchFactory: (_root, listener) => {
        change = listener;
        return fakeWatcher;
      },
    });
    try {
      await stop.ready;
      // A different size guarantees a stat change even on coarse-mtime filesystems.
      await writeFile(unrelated, '{"version":20}');
      change?.('change', unrelated);
      await stop.reconcile();
      await vi.advanceTimersByTimeAsync(10);
      await batchEnteredPromise;

      const closing = stop.close();
      releaseBatch();
      await closing;

      expect(batches).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseBatch();
      await stop.close();
      vi.useRealTimers();
    }
  });

  it('reconciles once before the warmup deadline expires after a clock jump', async () => {
    const source = join(root, 'assets', 'hero.png');
    const batches: Array<{ readonly sources: readonly { readonly filename: string }[] }> = [];
    const fakeWatcher = {
      close: () => {},
      on: () => fakeWatcher,
      unref: () => {},
    } as unknown as FSWatcher;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(0);
    const stop = createRevisionObserver({
      roots: [join(root, 'assets')],
      debounceMs: 10,
      onBatch: (batch) => {
        batches.push({ sources: batch.sources });
      },
      watchFactory: () => fakeWatcher,
    });
    try {
      await stop.ready;
      await vi.advanceTimersByTimeAsync(299);
      await writeFile(source, new Uint8Array([2]));
      await vi.advanceTimersByTimeAsync(1);
      await stop.drain();

      const sourcePaths = batches.flatMap((batch) =>
        batch.sources
          .map((candidate) => candidate.filename)
          .filter((filename) => filename === source),
      );
      expect(sourcePaths).toEqual([source]);
    } finally {
      await stop.close();
      vi.useRealTimers();
    }
  });
});

it('honors an explicit host refresh after an accepted plugin Pack change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-plugin-refresh-'));
  await writeFile(join(root, 'package.json'), '{"name":"plugin-refresh-fixture"}');
  const path = join(root, 'behavior.pack.json');
  const source = (speed: number) =>
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000000161',
      assets: {
        'plugin/root': {
          kind: 'plugin',
          payload: {
            module: { specifier: './behavior.ts' },
            config: { speed },
          },
        },
      },
    });
  await writeFile(path, source(1));
  await writeFile(join(root, 'behavior.ts'), 'export default { apply() {} };');
  const server = mockServer();
  const plugin = pluginPack({
    roots: [root],
    refresh: (target) => target.ws?.send({ type: 'full-reload' }),
  });
  try {
    plugin.configureServer(server);
    await plugin.ready();
    expect(plugin.catalogSnapshot()).toHaveLength(1);
    await writeFile(path, source(2));
    await waitFor(() => server.ws.calls.some((call) => call.payload.event === CATALOG_DELTA_EVENT));
    await waitFor(() => server.ws.calls.some((call) => call.type === 'full-reload'));
  } finally {
    await plugin.closeBundle();
    await rm(root, { recursive: true, force: true });
  }
});
