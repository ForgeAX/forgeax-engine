import type {
  CatalogDiagnostic,
  RuntimeAssetBinding,
  RuntimeScopeStatus,
} from '@forgeax/engine-types';
import {
  createPluginPackFailure,
  PLUGIN_PACK_FAILURE_STAGES,
  type PluginPackFailure,
  type PluginPackFailureStage,
  projectFailureCause,
} from '../errors.js';
import type { ProductionSession } from '../production/session.js';

export interface DevSessionSnapshot {
  readonly generation: number;
  readonly authority: 'authoritative' | 'degraded';
  readonly diagnostics: readonly CatalogDiagnostic[];
}

type DevSessionState =
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

interface DevSessionContext {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly previous?: DevSessionSnapshot;
}

interface DevSessionOptions<TState = undefined> {
  readonly generation: number;
  readonly startup: (context: DevSessionContext) => Promise<DevSessionSnapshot>;
  readonly productionSession: ProductionSession<TState>;
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
  readonly production: Pick<ProductionSession, 'materialize' | 'rebuild'>;
  /** Wait until the latest watcher-owned rebuild has settled. */
  waitForRebuild(): Promise<void>;
  track<T>(task: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function failureStage(error: unknown): PluginPackFailureStage {
  const stage =
    typeof error === 'object' && error !== null && 'detail' in error
      ? (error as { detail?: { stage?: unknown } }).detail?.stage
      : undefined;
  return (PLUGIN_PACK_FAILURE_STAGES as readonly unknown[]).includes(stage)
    ? (stage as PluginPackFailureStage)
    : 'scan';
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
    code: `${stage}-failed`,
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
  const production = options.productionSession;
  const { signal, track } = production;
  let state: DevSessionState = { status: 'starting' };
  let started: Promise<DevSessionState> | undefined;
  let operationToken = 0;
  let closing: Promise<void> | undefined;
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
  };

  const publishSnapshot = (snapshot: DevSessionSnapshot): void => {
    publish(
      snapshot.authority === 'degraded'
        ? { status: 'degraded', snapshot, diagnostics: snapshot.diagnostics }
        : { status: 'serving', snapshot },
    );
  };

  const runCandidate = (
    generation: number,
    operation: (context: DevSessionContext) => Promise<DevSessionSnapshot>,
    previous?: DevSessionSnapshot,
  ): Promise<DevSessionState> => {
    const token = ++operationToken;
    const current = () => !signal.aborted && token === operationToken;
    // Track the whole attempt before calling the producer, including cleanup
    // for producers that settle after they receive the abort signal.
    return track(
      Promise.resolve().then(async () => {
        try {
          const snapshot = await operation({
            generation,
            signal,
            ...(previous === undefined ? {} : { previous }),
          });
          if (current()) publishSnapshot(snapshot);
        } catch (error) {
          if (current()) {
            const failure = asFailure(error, `generation:${generation}`);
            publish(
              previous === undefined
                ? { status: 'failed', error: failure }
                : {
                    status: 'degraded',
                    snapshot: previous,
                    diagnostics: [...previous.diagnostics, diagnosticForFailure(failure)],
                  },
            );
          }
        }
        return state;
      }),
    );
  };

  const start = (): Promise<DevSessionState> => {
    started ??= runCandidate(options.generation, options.startup);
    return started;
  };

  const rebuild = (
    operation: (context: DevSessionContext) => Promise<DevSessionSnapshot>,
  ): Promise<DevSessionState> => {
    const previous = currentSnapshot(state);
    if (signal.aborted || (previous === undefined && state.status !== 'failed'))
      return Promise.resolve(state);
    const candidateGeneration = (previous?.generation ?? options.generation) + 1;
    if (previous !== undefined)
      publish({ status: 'rebuilding', snapshot: previous, candidateGeneration });
    const tracked = runCandidate(candidateGeneration, operation, previous);
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
    signal,
    state: () => state,
    runtimeScope: () => runtimeScope,
    bindRuntime,
    publishRuntime,
    start,
    rebuild,
    production,
    waitForRebuild,
    track,
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closing = Promise.resolve().then(async () => {
        await productionClose;
        publish({ status: 'closed' });
      });
      const productionClose = production.close();
      runtimeScope = undefined;
      publish({ status: 'closing' });
      return closing;
    },
  };
}
