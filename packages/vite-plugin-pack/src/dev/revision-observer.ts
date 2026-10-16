import { type FSWatcher, watch as fsWatch, lstatSync, readdirSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPluginPackFailure, type PluginPackFailure } from '../errors.js';

export interface WatchedChange {
  /** Absolute path; callers must not reconstruct it against an arbitrary root. */
  readonly filename: string;
}

export interface WatchBatch {
  readonly revision: number;
  readonly sidecars: readonly WatchedChange[];
  readonly sources: readonly WatchedChange[];
}

export type DevWatchListener = (eventType: string, filename: string | Buffer | null) => void;
export type DevWatchFactory = (root: string, listener: DevWatchListener) => FSWatcher;

export interface RevisionObserverOptions {
  readonly roots: readonly string[];
  readonly debounceMs?: number;
  readonly watchFactory?: DevWatchFactory;
  readonly onBatch: (batch: WatchBatch) => void | Promise<void>;
  readonly onError?: (
    error: unknown,
    context: {
      readonly phase: 'watcher' | 'flush' | 'missing-root' | 'snapshot';
      readonly root?: string;
      readonly revision: number;
    },
  ) => void | Promise<void>;
}

export type DevWatcherOptions = RevisionObserverOptions;

export interface DevWatchClassification {
  readonly kind: 'sidecar' | 'source';
}

export interface RevisionObserver {
  /** Resolves after watch installation and the initial stat snapshot. */
  readonly ready: Promise<void>;
  readonly reconcile: () => Promise<number>;
  readonly drain: () => Promise<void>;
  readonly revision: () => number;
  /** Async compatibility alias used by the plugin lifecycle close fence. */
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface StatFact {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

type Snapshot = Map<string, StatFact>;

const MAX_RECONCILE_ROUNDS = 4;

export function classifyWatchedPath(filename: string): DevWatchClassification {
  const isSidecar =
    filename.endsWith('.meta.json') ||
    filename.endsWith('.pack.json') ||
    filename.endsWith('.pack.ts');
  return { kind: isSidecar ? 'sidecar' : 'source' };
}

function snapshotEqual(left: StatFact | undefined, right: StatFact | undefined): boolean {
  return (
    left?.dev === right?.dev &&
    left?.ino === right?.ino &&
    left?.mode === right?.mode &&
    left?.mtimeMs === right?.mtimeMs &&
    left?.size === right?.size
  );
}

async function collectSnapshot(roots: readonly string[]): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  const visit = async (path: string, root: string): Promise<void> => {
    const entry = await lstat(path);
    if (entry.isDirectory()) {
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children) await visit(resolve(path, child.name), root);
      return;
    }
    if (entry.isFile()) {
      snapshot.set(resolve(root, path), {
        dev: entry.dev,
        ino: entry.ino,
        mode: entry.mode,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
      });
    }
  };
  for (const root of roots) {
    const absoluteRoot = resolve(root);
    try {
      await visit(absoluteRoot, absoluteRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        root: absoluteRoot,
      });
    }
  }
  return snapshot;
}

/**
 * Capture the construction-time baseline before callers can publish a
 * pre-ready change. The async crawl below intentionally remains the source of
 * truth after startup, but an async-only baseline can begin after a caller's
 * first write and erase that change from the initial revision.
 */
function collectSnapshotSync(roots: readonly string[]): Snapshot {
  const snapshot: Snapshot = new Map();
  const visit = (path: string, root: string): void => {
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { root });
    }
    if (entry.isDirectory()) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        visit(resolve(path, child.name), root);
      }
      return;
    }
    if (entry.isFile()) {
      snapshot.set(resolve(root, path), {
        dev: entry.dev,
        ino: entry.ino,
        mode: entry.mode,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
      });
    }
  };
  for (const root of roots) visit(resolve(root), resolve(root));
  return snapshot;
}

function changedPaths(previous: Snapshot, current: Snapshot): readonly string[] {
  const paths = new Set<string>();
  for (const [path, fact] of current) {
    if (!snapshotEqual(previous.get(path), fact)) paths.add(path);
  }
  for (const path of previous.keys()) {
    if (!current.has(path)) paths.add(path);
  }
  return [...paths].sort();
}

function cleanupFailure(): PluginPackFailure {
  return createPluginPackFailure({
    code: 'cleanup-failed',
    expected: 'the revision observer to accept work before close',
    hint: 'create a new dev generation and retry the filesystem operation',
    detail: { stage: 'cleanup', subject: 'revision-observer' },
  });
}

function isCleanupFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'cleanup-failed'
  );
}

export function createRevisionObserver(options: RevisionObserverOptions): RevisionObserver {
  const pendingSidecars = new Map<string, WatchedChange>();
  const pendingSources = new Map<string, WatchedChange>();
  const watchers: FSWatcher[] = [];
  const debounceMs = options.debounceMs ?? 150;
  const probeMs = Math.max(25, Math.min(debounceMs, 100));
  let snapshot: Snapshot = new Map();
  let currentRevision = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSnapshotDurationMs = probeMs;
  let slowSnapshotReported = false;
  let disposed = false;
  let flushInFlight: Promise<void> | undefined;
  let reconcileInFlight: Promise<number> | undefined;
  let reconcileRequested = false;
  let draining = false;

  const report = (
    error: unknown,
    context: {
      readonly phase: 'watcher' | 'flush' | 'missing-root' | 'snapshot';
      readonly root?: string;
      readonly revision?: number;
    },
  ): void => {
    if (options.onError === undefined) {
      console.error('[forgeax-pack] dev watcher failure', error);
      return;
    }
    try {
      const result = options.onError(error, {
        ...context,
        revision: context.revision ?? currentRevision,
      });
      if (result !== undefined) result.catch((nested) => console.error(nested));
    } catch (nested) {
      console.error(nested);
    }
  };

  try {
    snapshot = collectSnapshotSync(options.roots);
  } catch (error) {
    report(error, { phase: 'snapshot' });
  }

  const flush = async (revision = currentRevision): Promise<void> => {
    if (disposed) {
      pendingSidecars.clear();
      pendingSources.clear();
      return;
    }
    if (flushInFlight !== undefined) {
      await flushInFlight;
      if (!disposed && (pendingSidecars.size > 0 || pendingSources.size > 0)) {
        await flush(revision);
      }
      return;
    }
    const sidecars = [...pendingSidecars.values()];
    const sources = [...pendingSources.values()];
    pendingSidecars.clear();
    pendingSources.clear();
    if (sidecars.length === 0 && sources.length === 0) return;
    flushInFlight = (async () => {
      try {
        if (disposed) return;
        await options.onBatch({ revision, sidecars, sources });
      } catch (error) {
        report(error, { phase: 'flush', revision });
      } finally {
        flushInFlight = undefined;
      }
    })();
    await flushInFlight;
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush().catch((error) => report(error, { phase: 'flush' }));
    }, debounceMs);
    flushTimer.unref();
  };

  const enqueue = (path: string): void => {
    if (disposed) return;
    const change = { filename: resolve(path) };
    const target =
      classifyWatchedPath(change.filename).kind === 'sidecar' ? pendingSidecars : pendingSources;
    target.set(change.filename, change);
    scheduleFlush();
  };

  const reconcileNow = async (): Promise<number> => {
    if (disposed) throw cleanupFailure();
    const startedAt = Date.now();
    let current: Snapshot;
    try {
      current = await collectSnapshot(options.roots);
    } catch (error) {
      report(error, { phase: 'snapshot' });
      throw error;
    }
    lastSnapshotDurationMs = Math.max(0, Date.now() - startedAt);
    if (!slowSnapshotReported && lastSnapshotDurationMs > probeMs) {
      slowSnapshotReported = true;
      console.warn(
        `[forgeax-pack] dev watcher snapshot took ${lastSnapshotDurationMs}ms; probe cadence is being coalesced`,
      );
    }
    if (disposed) return currentRevision;
    const paths = changedPaths(snapshot, current);
    snapshot = current;
    if (paths.length > 0) {
      currentRevision += 1;
      for (const path of paths) enqueue(path);
    }
    return currentRevision;
  };

  const reconcile = (hint: 'watch' | 'probe' = 'watch'): Promise<number> => {
    if (disposed) return Promise.reject(cleanupFailure());
    if (reconcileInFlight !== undefined) {
      // Watcher notifications are authoritative hints and must request one
      // more snapshot. Poll probes are only liveness checks; asking for a
      // second snapshot while the first one is still walking the tree was the
      // source of the unbounded reconcile loop.
      if (hint === 'watch') reconcileRequested = true;
      return reconcileInFlight;
    }
    const task = (async (): Promise<number> => {
      let rounds = 0;
      do {
        reconcileRequested = false;
        await reconcileNow();
        rounds += 1;
      } while (reconcileRequested && !disposed && rounds < MAX_RECONCILE_ROUNDS);
      return currentRevision;
    })();
    reconcileInFlight = task.finally(() => {
      reconcileInFlight = undefined;
      if (reconcileRequested && !disposed && !draining) {
        void reconcile('watch').catch((error) => {
          if (disposed && isCleanupFailure(error)) return;
          report(error, { phase: 'snapshot' });
        });
      }
    });
    return reconcileInFlight;
  };

  const scheduleProbe = (): void => {
    if (disposed || draining) return;
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    const delay = Math.max(probeMs, Math.min(lastSnapshotDurationMs * 10, 60_000));
    probeTimer = setTimeout(() => {
      probeTimer = undefined;
      if (reconcileInFlight !== undefined) {
        void reconcileInFlight.finally(scheduleProbe).catch(() => {});
        return;
      }
      void reconcile('probe')
        .catch((error) => {
          if (disposed && isCleanupFailure(error)) return;
          report(error, { phase: 'snapshot' });
        })
        .finally(scheduleProbe);
    }, delay);
    probeTimer.unref();
  };

  const drain = async (): Promise<void> => {
    draining = true;
    if (probeTimer !== undefined) {
      clearTimeout(probeTimer);
      probeTimer = undefined;
    }
    try {
      // An in-flight crawl may have read a file before the caller's write.
      // Queue a fresh snapshot even in that case: drain fences current state,
      // not merely work that happened to start before the fence.
      if (!disposed) reconcile();
      while (true) {
        if (reconcileInFlight === undefined && reconcileRequested && !disposed) reconcile();
        await reconcileInFlight;
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        await flush();
        if (!disposed && (reconcileInFlight !== undefined || reconcileRequested)) continue;
        if (
          flushTimer === undefined &&
          flushInFlight === undefined &&
          pendingSidecars.size === 0 &&
          pendingSources.size === 0
        ) {
          return;
        }
      }
    } finally {
      draining = false;
      scheduleProbe();
    }
  };

  const nativeHint = (hint: 'watch' | 'probe' = 'watch'): void => {
    if (disposed) return;
    if (draining) {
      if (hint === 'watch') reconcileRequested = true;
      return;
    }
    if (hint === 'probe' && reconcileInFlight !== undefined) {
      return;
    }
    void reconcile(hint).catch((error) => {
      // A native hint may already be queued when the owner closes. The
      // queued reconciliation is intentionally rejected by reconcileNow so
      // no new filesystem work can enter a closed generation; that terminal
      // cleanup signal is not a watcher failure and must not be reported.
      if (disposed && isCleanupFailure(error)) return;
      report(error, { phase: 'snapshot' });
    });
  };

  const installWatchers = (): void => {
    const factory =
      options.watchFactory ?? ((root, listener) => fsWatch(root, { recursive: true }, listener));
    const watchedRoots = new Set<string>();
    for (const root of options.roots) {
      const absoluteRoot = resolve(root);
      try {
        // Recursive fs.watch can silently accept a missing root on Linux.
        // File watches also lose their native subscription when an editor
        // replaces the declaration atomically, so watch the containing
        // directory and reconcile only the declared file snapshots.
        const fact = lstatSync(absoluteRoot);
        const watchRoot = fact.isFile() ? dirname(absoluteRoot) : absoluteRoot;
        if (watchedRoots.has(watchRoot)) continue;
        watchedRoots.add(watchRoot);
        const watcher = factory(watchRoot, () => nativeHint('watch'));
        watcher.unref();
        watcher.on('error', (error) => report(error, { phase: 'watcher', root: absoluteRoot }));
        watchers.push(watcher);
      } catch (error) {
        report(error, { phase: 'missing-root', root: absoluteRoot });
      }
    }
  };

  const ready = (async (): Promise<void> => {
    installWatchers();
    try {
      await reconcile();
    } catch (error) {
      if (!disposed || !isCleanupFailure(error)) throw error;
      return;
    }
    if (disposed) return;
    // Readiness only covers watcher installation and the initial snapshot.
    // Do not force a flush here: the first source/sidecar generation must keep
    // its debounce window, and plugin startup may itself await this barrier.
    // Flushing here would split writes that arrived before ready and can form
    // a startupReady -> watcher.ready -> onBatch cycle in the plugin host.
    scheduleProbe();
  })();

  const close = async (): Promise<void> => {
    if (disposed) {
      await Promise.allSettled([
        ready,
        reconcileInFlight ?? Promise.resolve(),
        flushInFlight ?? Promise.resolve(),
      ]);
      return;
    }
    disposed = true;
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    reconcileRequested = false;
    for (const watcher of watchers) watcher.close();
    pendingSidecars.clear();
    pendingSources.clear();
    await Promise.allSettled([
      ready,
      reconcileInFlight ?? Promise.resolve(),
      flushInFlight ?? Promise.resolve(),
    ]);
  };

  return { ready, reconcile, drain, revision: () => currentRevision, stop: close, close };
}

export function watchDevRoots(options: DevWatcherOptions): (() => void) & RevisionObserver {
  const observer = createRevisionObserver(options);
  const stop = (() => {
    void observer.close();
  }) as (() => void) & RevisionObserver;
  Object.defineProperties(stop, {
    ready: { enumerable: true, get: () => observer.ready },
    reconcile: { enumerable: true, value: observer.reconcile },
    drain: { enumerable: true, value: observer.drain },
    revision: { enumerable: true, value: observer.revision },
    stop: { enumerable: true, value: observer.stop },
    close: { enumerable: true, value: observer.close },
  });
  return stop;
}
