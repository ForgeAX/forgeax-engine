import type {
  CatalogDiagnostic,
  CatalogEntry,
  RuntimeAssetBinding,
  RuntimeScopeStatus,
} from '@forgeax/engine-types';
import {
  createPluginPackFailure,
  type PluginPackFailure,
  type PluginPackFailureStage,
  projectFailureCause,
} from '../errors.js';
import type {
  ProductionRunResult,
  ProductionSession,
  ProductionSourceChange,
} from '../production/session.js';

export interface DevSessionSnapshot {
  readonly generation: number;
  readonly catalog: readonly CatalogEntry[];
  readonly authority: 'authoritative' | 'degraded';
  readonly diagnostics: readonly CatalogDiagnostic[];
}

export type DevSessionState =
  | { readonly status: 'starting' }
  | { readonly status: 'serving'; readonly snapshot: DevSessionSnapshot }
  | {
      readonly status: 'rebuilding';
      readonly snapshot: DevSessionSnapshot;
      readonly candidateGeneration: number;
    }
  | {
      readonly status: 'degraded';
      readonly snapshot: DevSessionSnapshot;
      readonly diagnostics: readonly CatalogDiagnostic[];
    }
  | { readonly status: 'failed'; readonly error: PluginPackFailure }
  | { readonly status: 'closing' }
  | { readonly status: 'closed' };

export interface DevSessionContext {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly previous?: DevSessionSnapshot;
}

export interface DevSessionOptions<TState = undefined> {
  readonly generation: number;
  readonly startup: (context: DevSessionContext) => Promise<DevSessionSnapshot>;
  readonly productionSession: ProductionSession<TState>;
  readonly onStateChange?: (state: DevSessionState) => void;
}

export interface DevSession {
  readonly signal: AbortSignal;
  state(): DevSessionState;
  runtimeScope(): RuntimeAssetBinding | undefined;
  bindRuntime(binding: RuntimeAssetBinding): void;
  publishRuntime(
    status: Exclude<RuntimeScopeStatus, 'unbound' | 'transitioning'>,
    authority?: RuntimeAssetBinding['authority'],
    diagnostics?: RuntimeAssetBinding['diagnostics'],
  ): RuntimeAssetBinding | undefined;
  start(): Promise<DevSessionState>;
  rebuild(
    operation: (context: DevSessionContext) => Promise<DevSessionSnapshot>,
  ): Promise<DevSessionState>;
  materializeProduction(guid: string): Promise<ProductionRunResult>;
  rebuildProduction(changes: readonly ProductionSourceChange[]): Promise<ProductionRunResult>;
  /** Wait until the latest watcher-owned rebuild has settled. */
  waitForRebuild(): Promise<void>;
  track<T>(task: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function failureStage(error: unknown): PluginPackFailureStage {
  if (
    typeof error === 'object' &&
    error !== null &&
    'detail' in error &&
    typeof (error as { detail?: unknown }).detail === 'object' &&
    (error as { detail?: { stage?: unknown } }).detail?.stage !== undefined
  ) {
    const stage = (error as { detail: { stage?: unknown } }).detail.stage;
    if (
      stage === 'config' ||
      stage === 'scan' ||
      stage === 'produce' ||
      stage === 'finalize' ||
      stage === 'commit' ||
      stage === 'emit' ||
      stage === 'watch' ||
      stage === 'route' ||
      stage === 'cleanup'
    ) {
      return stage;
    }
  }
  return 'scan';
}

function asFailure(error: unknown, subject: string): PluginPackFailure {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'expected' in error &&
    'hint' in error &&
    'detail' in error
  ) {
    return error as PluginPackFailure;
  }
  const stage = failureStage(error);
  return createPluginPackFailure({
    code:
      stage === 'scan'
        ? 'scan-failed'
        : stage === 'watch'
          ? 'watch-failed'
          : stage === 'route'
            ? 'route-failed'
            : 'produce-failed',
    expected: 'a dev session startup or rebuild that produces an accepted snapshot',
    hint: 'inspect the diagnostic, repair the source or watcher, rebuild, verify, and retry',
    detail: { stage, subject },
    cause: error,
  });
}

function diagnosticForFailure(failure: PluginPackFailure): CatalogDiagnostic {
  const cause = projectFailureCause(failure);
  return {
    code: failure.code,
    ...(cause === undefined ? {} : { cause }),
    severity: 'blocking',
    authority: 'catalog',
    ...(failure.detail.subject === undefined
      ? {}
      : { subject: { type: 'resource' as const, id: failure.detail.subject } }),
    expected: failure.expected,
    actual: failure.detail.stage,
    hint: failure.hint,
  };
}

function currentSnapshot(state: DevSessionState): DevSessionSnapshot | undefined {
  return state.status === 'serving' || state.status === 'rebuilding' || state.status === 'degraded'
    ? state.snapshot
    : undefined;
}

/**
 * Startup/rebuild callbacks are caller-owned and may ignore abort.  Their
 * settled promises are tracked separately so close drains the callback before
 * the session becomes terminal; the post-await fence prevents a late result
 * from mutating this session.
 */
async function settleGenerationOrAbort<T>(
  task: Promise<T>,
  signal: AbortSignal,
  drain: (task: Promise<unknown>) => void,
): Promise<T | undefined> {
  const settled = task.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  drain(settled);
  const result = await settled;
  if (signal.aborted) return undefined;
  if (result.status === 'rejected') throw result.error;
  return result.value;
}

/**
 * Own one generation-scoped dev lifecycle. Accepted snapshots are immutable
 * from the session's point of view; rebuild work can only replace them after
 * its promise settles successfully and its generation token still matches.
 */
export function createDevSession<TState = undefined>(
  options: DevSessionOptions<TState>,
): DevSession {
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    throw new TypeError('DevSession generation must be a positive safe integer');
  }
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let state: DevSessionState = { status: 'starting' };
  let intakeOpen = true;
  let started: Promise<DevSessionState> | undefined;
  let operationToken = 0;
  let runtimeScope: RuntimeAssetBinding | undefined;
  let activeRebuild: Promise<unknown> | undefined;

  const bindRuntime = (binding: RuntimeAssetBinding): void => {
    if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
      throw new Error('forgeax: runtime generation must be a positive safe integer');
    }
    if (binding.scopeId.trim().length === 0 || binding.gameId.trim().length === 0) {
      throw new Error('forgeax: runtime gameId and scopeId are required');
    }
    if (runtimeScope !== undefined) {
      throw new Error('forgeax: runtime binding already belongs to this DevSession');
    }
    runtimeScope = Object.freeze({ ...binding, status: 'transitioning' });
  };

  const publishRuntime = (
    status: Exclude<RuntimeScopeStatus, 'unbound' | 'transitioning'>,
    authority?: RuntimeAssetBinding['authority'],
    diagnostics?: RuntimeAssetBinding['diagnostics'],
  ): RuntimeAssetBinding | undefined => {
    if (runtimeScope === undefined) return undefined;
    const binding = Object.freeze({
      ...runtimeScope,
      status,
      ...(authority === undefined ? {} : { authority }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    });
    runtimeScope = binding;
    return binding;
  };

  const publish = (next: DevSessionState): void => {
    if (next.status === 'failed') {
      publishRuntime('degraded', 'degraded', [diagnosticForFailure(next.error)]);
    }
    if (next.status === 'serving' || next.status === 'degraded') {
      publishRuntime(
        next.status === 'degraded' ? 'degraded' : 'ready',
        next.status === 'degraded' ? 'degraded' : next.snapshot.authority,
        next.status === 'degraded' ? next.diagnostics : next.snapshot.diagnostics,
      );
    }
    state = next;
    options.onStateChange?.(next);
  };

  const publishSnapshot = (snapshot: DevSessionSnapshot): void => {
    publish(
      snapshot.authority === 'degraded'
        ? { status: 'degraded', snapshot, diagnostics: snapshot.diagnostics }
        : { status: 'serving', snapshot },
    );
  };

  const drain = (task: Promise<unknown>): void => {
    pending.add(task);
    task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
  };

  const track = <T>(task: Promise<T>): Promise<T> => {
    if (!intakeOpen || controller.signal.aborted) {
      void task.catch(() => undefined);
      const rejected = Promise.reject(
        createPluginPackFailure({
          code: 'cleanup-failed',
          expected: 'the DevSession to accept work before terminal close',
          hint: 'discard the late task and retry against the active session generation',
          detail: { stage: 'cleanup', subject: 'dev-session' },
        }),
      );
      void rejected.catch(() => undefined);
      return rejected;
    }
    drain(task);
    return task;
  };

  const start = (): Promise<DevSessionState> => {
    if (started !== undefined) return started;
    const task = (async (): Promise<DevSessionState> => {
      try {
        const snapshot = await settleGenerationOrAbort(
          options.startup({
            generation: options.generation,
            signal: controller.signal,
          }),
          controller.signal,
          drain,
        );
        if (snapshot === undefined) {
          publish({ status: 'closing' });
          return state;
        }
        if (!intakeOpen || controller.signal.aborted) {
          publish({ status: 'closing' });
          return state;
        }
        publishSnapshot(snapshot);
      } catch (error) {
        publish({ status: 'failed', error: asFailure(error, `generation:${options.generation}`) });
      }
      return state;
    })();
    started = track(task);
    return started;
  };

  const rebuild = (
    operation: (context: DevSessionContext) => Promise<DevSessionSnapshot>,
  ): Promise<DevSessionState> => {
    const previous = currentSnapshot(state);
    if (!intakeOpen || (previous === undefined && state.status !== 'failed'))
      return Promise.resolve(state);
    const candidateGeneration = (previous?.generation ?? options.generation) + 1;
    const token = ++operationToken;
    if (previous !== undefined)
      publish({ status: 'rebuilding', snapshot: previous, candidateGeneration });
    const task = (async (): Promise<DevSessionState> => {
      try {
        const snapshot = await settleGenerationOrAbort(
          operation({
            generation: candidateGeneration,
            signal: controller.signal,
            ...(previous === undefined ? {} : { previous }),
          }),
          controller.signal,
          drain,
        );
        if (snapshot === undefined) return state;
        if (
          !intakeOpen ||
          controller.signal.aborted ||
          token !== operationToken ||
          state.status === 'closing' ||
          state.status === 'closed'
        ) {
          return state;
        }
        publishSnapshot(snapshot);
      } catch (error) {
        if (!intakeOpen || controller.signal.aborted || token !== operationToken) return state;
        const failure = asFailure(error, `generation:${candidateGeneration}`);
        if (previous === undefined) {
          publish({ status: 'failed', error: failure });
          return state;
        }
        const diagnostics = [...previous.diagnostics, diagnosticForFailure(failure)];
        publish({
          status: 'degraded',
          snapshot: previous,
          diagnostics,
        });
      }
      return state;
    })();
    const tracked = track(task);
    activeRebuild = tracked;
    void tracked.then(
      () => {
        if (activeRebuild === tracked) activeRebuild = undefined;
      },
      () => {
        if (activeRebuild === tracked) activeRebuild = undefined;
      },
    );
    return tracked;
  };

  const waitForRebuild = async (): Promise<void> => {
    while (activeRebuild !== undefined) {
      const observed = activeRebuild;
      await observed;
      if (activeRebuild === observed) return;
    }
  };

  return {
    signal: controller.signal,
    state: () => state,
    runtimeScope: () => runtimeScope,
    bindRuntime,
    publishRuntime,
    start,
    rebuild,
    async materializeProduction(guid): Promise<ProductionRunResult> {
      await waitForRebuild();
      return track(options.productionSession.materialize(guid));
    },
    rebuildProduction(changes): Promise<ProductionRunResult> {
      return track(options.productionSession.rebuild(changes));
    },
    waitForRebuild,
    track,
    async close(): Promise<void> {
      if (state.status === 'closed') return;
      intakeOpen = false;
      operationToken += 1;
      publish({ status: 'closing' });
      controller.abort();
      runtimeScope = undefined;
      const productionClose = options.productionSession.close();
      await Promise.allSettled([productionClose, ...pending]);
      publish({ status: 'closed' });
    },
  };
}
