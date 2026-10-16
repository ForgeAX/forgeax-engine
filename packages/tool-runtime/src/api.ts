import { domainFailureError } from './errors.js';
import { createToolRuntime } from './runtime.js';
import type {
  JsonValue,
  ToolCallerIdentity,
  ToolContribution,
  ToolDescriptor,
  ToolExecutionOwner,
  ToolRealm,
  ToolRun,
  ToolRunOptions,
  ToolRuntimeError,
  ToolTerminal,
} from './types.js';
import { TOOL_REALMS } from './types.js';

export type ToolApiProviderState = 'pending' | 'active' | 'revoking' | 'revoked' | 'failed';

export interface ToolApiProviderInput {
  /** Stable provider identity within one source. */
  readonly providerId: string;
  /** Host/source identity. Different sources may expose the same operation id. */
  readonly sourceId: string;
  readonly realm: ToolRealm;
  readonly generation?: number;
  readonly fiberId?: string | number;
  readonly module?: string;
  readonly fiberState?: string;
  /** Async plugin activation stays non-callable until explicitly activated. */
  readonly initialState?: 'pending' | 'active';
  readonly tools: readonly ToolContribution[];
  /** Domain authorization remains owned by the provider. */
  readonly authorize?: (
    caller: ToolCallerIdentity | undefined,
    operation: ToolDescriptor,
  ) => boolean;
}

export interface ToolApiProviderSnapshot {
  readonly owner: ToolExecutionOwner;
  readonly state: ToolApiProviderState;
  readonly fiberState?: string;
  readonly callable: boolean;
  readonly operationIds: readonly string[];
}

export interface ToolApiRecord {
  readonly descriptor: ToolDescriptor;
  readonly owner: ToolExecutionOwner;
  readonly providerState: ToolApiProviderState;
  readonly declared: true;
  readonly callable: boolean;
  readonly fiberState?: string;
}

export interface ToolApiSnapshot {
  readonly providers: readonly ToolApiProviderSnapshot[];
  readonly operations: readonly ToolApiRecord[];
}

export interface ToolApiProviderHandle {
  readonly owner: ToolExecutionOwner;
  readonly snapshot: () => ToolApiProviderSnapshot;
  /** Mark a pending provider callable after its domain apply succeeds. */
  readonly activate: (fiberState?: string) => void;
  /** Mark a pending/active provider failed without making it callable. */
  readonly fail: (reason?: string, fiberState?: string) => void;
  /** Withdraw admission and wait for every executor to actually exit. */
  readonly revoke: (reason?: string) => Promise<void>;
}

export type ToolApiRunOptions = Omit<ToolRunOptions, 'owner'>;

export interface ToolApi {
  readonly snapshot: () => ToolApiSnapshot;
  readonly list: () => readonly ToolApiRecord[];
  readonly describe: (id: string, sourceId?: string) => readonly ToolApiRecord[];
  readonly registerProvider: (input: ToolApiProviderInput) => ToolApiProviderHandle;
  readonly run: <TResult = unknown>(
    id: string,
    args: unknown,
    options?: ToolApiRunOptions,
  ) => ToolRun<TResult>;
  readonly subscribe: (listener: (snapshot: ToolApiSnapshot) => void) => () => void;
  /** Revoke all providers and wait for their executors to exit. */
  readonly dispose: () => Promise<void>;
}

interface ProviderRecord {
  readonly input: ToolApiProviderInput;
  readonly owner: ToolExecutionOwner;
  readonly runtime: ReturnType<typeof createToolRuntime>;
  readonly runs: Set<ToolRun<unknown>>;
  state: ToolApiProviderState;
  fiberState?: string;
  reason?: string;
}

function assertName(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) {
    throw new TypeError(`${label} must be a stable non-empty identity`);
  }
}

function operationPath(descriptor: ToolDescriptor): string {
  return (descriptor.path ?? descriptor.id.split('.')).join(' ');
}

function providerKey(sourceId: string, providerId: string): string {
  return `${sourceId}\u0000${providerId}`;
}

function apiFailure(
  code: string,
  expected: string,
  hint: string,
  detail: JsonValue,
): ToolRuntimeError {
  return domainFailureError(code, expected, hint, detail);
}

function failedRun<TResult>(failure: ToolRuntimeError): ToolRun<TResult> {
  const id = `api:${crypto.randomUUID()}`;
  const terminal: Promise<ToolTerminal<TResult>> = Promise.resolve({
    outcome: 'failed',
    failure,
    artifacts: [],
  });
  const events: AsyncIterable<import('./types.js').ToolRunEvent> = {
    async *[Symbol.asyncIterator]() {
      yield { kind: 'started', runId: id, atMs: performance.now() };
      yield { kind: 'terminal', runId: id, outcome: 'failed', atMs: performance.now() };
    },
  };
  return {
    id,
    events,
    terminal,
    executorExited: Promise.resolve(),
    cancel() {},
    disconnect() {},
    providerExit() {},
  };
}

function validateProvider(input: ToolApiProviderInput): void {
  assertName(input.providerId, 'providerId');
  assertName(input.sourceId, 'sourceId');
  if (!TOOL_REALMS.includes(input.realm))
    throw new TypeError(`unsupported Tool API realm ${String(input.realm)}`);
  if (!Array.isArray(input.tools) || input.tools.length === 0)
    throw new TypeError('Tool API providers must publish at least one contribution');
  const ids = new Set<string>();
  const paths = new Set<string>();
  if (
    input.initialState !== undefined &&
    input.initialState !== 'pending' &&
    input.initialState !== 'active'
  )
    throw new TypeError('Tool API provider initialState must be pending or active');
  for (const contribution of input.tools) {
    if (contribution === null || typeof contribution !== 'object')
      throw new TypeError('Tool API contributions must be objects');
    if (typeof contribution.execute !== 'function')
      throw new TypeError(
        `Tool API contribution ${String(contribution.descriptor?.id)} needs an executor`,
      );
    const descriptor = contribution.descriptor;
    if (descriptor.realm !== input.realm)
      throw new TypeError(
        `Tool API ${descriptor.id} declares ${descriptor.realm} but provider is ${input.realm}`,
      );
    if (ids.has(descriptor.id))
      throw new TypeError(`duplicate Tool API operation id ${descriptor.id}`);
    ids.add(descriptor.id);
    const path = operationPath(descriptor);
    if (paths.has(path)) throw new TypeError(`duplicate Tool API command path ${path}`);
    paths.add(path);
  }
}

/**
 * Create the one effective Tool API capability for a Context/owner.
 *
 * Declarations are retained for inspection, while calls are admitted only
 * through an active provider binding. The command tree and clients may cache
 * the returned projection, but they never own executors or provider state.
 */
export function createToolApi(): ToolApi {
  const providers = new Map<string, ProviderRecord>();
  const listeners = new Set<(snapshot: ToolApiSnapshot) => void>();
  let providerGeneration = 0;
  let disposed = false;

  const notify = (): void => {
    const value = api.snapshot();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // Observation must not affect admission or executor cleanup.
      }
    }
  };

  const snapshot = (): ToolApiSnapshot => {
    const providerSnapshots: ToolApiProviderSnapshot[] = [];
    const operations: ToolApiRecord[] = [];
    for (const record of providers.values()) {
      providerSnapshots.push({
        owner: record.owner,
        state: record.state,
        ...(record.fiberState === undefined ? {} : { fiberState: record.fiberState }),
        callable: record.state === 'active',
        operationIds: record.input.tools.map(({ descriptor }) => descriptor.id),
      });
      for (const contribution of record.input.tools) {
        operations.push({
          descriptor: contribution.descriptor,
          owner: record.owner,
          providerState: record.state,
          declared: true,
          callable: record.state === 'active',
          ...(record.fiberState === undefined ? {} : { fiberState: record.fiberState }),
        });
      }
    }
    providerSnapshots.sort((left, right) =>
      providerKey(left.owner.sourceId, left.owner.providerId).localeCompare(
        providerKey(right.owner.sourceId, right.owner.providerId),
      ),
    );
    operations.sort((left, right) => {
      const source = left.owner.sourceId.localeCompare(right.owner.sourceId);
      return source !== 0 ? source : left.descriptor.id.localeCompare(right.descriptor.id);
    });
    return { providers: providerSnapshots, operations };
  };

  const registerProvider = (input: ToolApiProviderInput): ToolApiProviderHandle => {
    if (disposed) throw new Error('Tool API is disposed');
    validateProvider(input);
    const key = providerKey(input.sourceId, input.providerId);
    if (['pending', 'active', 'revoking'].includes(providers.get(key)?.state ?? '')) {
      throw new TypeError(
        `Tool API provider ${input.sourceId}/${input.providerId} is already registered`,
      );
    }
    const generation = input.generation ?? ++providerGeneration;
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new TypeError('Tool API provider generation must be a positive integer');
    providerGeneration = Math.max(providerGeneration, generation);
    const owner: ToolExecutionOwner = {
      providerId: input.providerId,
      sourceId: input.sourceId,
      generation,
      realm: input.realm,
      ...(input.fiberId === undefined ? {} : { fiberId: input.fiberId }),
      ...(input.module === undefined ? {} : { module: input.module }),
    };
    const runtime = createToolRuntime(input.tools);
    const record: ProviderRecord = {
      input: { ...input, tools: [...input.tools] },
      owner,
      runtime,
      runs: new Set(),
      state: input.initialState ?? 'active',
      ...(input.fiberState === undefined ? {} : { fiberState: input.fiberState }),
    };
    providers.set(key, record);
    notify();

    const activate = (fiberState = 'active'): void => {
      if (record.state !== 'pending') return;
      record.state = 'active';
      record.fiberState = fiberState;
      notify();
    };
    const fail = (reason = 'provider failed', fiberState = 'failed'): void => {
      if (record.state !== 'pending' && record.state !== 'active') return;
      record.state = 'failed';
      record.reason = reason;
      record.fiberState = fiberState;
      for (const run of record.runs) run.cancel(reason);
      notify();
    };
    const revoke = async (reason = 'provider revoked'): Promise<void> => {
      if (record.state === 'revoked') return;
      if (record.state === 'active' || record.state === 'pending') {
        record.state = 'revoking';
        record.reason = reason;
        record.fiberState = 'unloading';
        notify();
        for (const run of record.runs) run.cancel(reason);
      }
      await Promise.all([...record.runs].map((run) => run.executorExited));
      if (record.state !== 'failed') {
        record.state = 'revoked';
        record.fiberState = 'disposed';
      }
      notify();
    };
    return Object.freeze({
      owner,
      activate,
      fail,
      snapshot: () => ({
        owner,
        state: record.state,
        ...(record.fiberState === undefined ? {} : { fiberState: record.fiberState }),
        callable: record.state === 'active',
        operationIds: record.input.tools.map(({ descriptor }) => descriptor.id),
      }),
      revoke,
    });
  };

  const findRecords = (id: string, sourceId?: string): ProviderRecord[] =>
    [...providers.values()].filter(
      (record) =>
        (sourceId === undefined || record.owner.sourceId === sourceId) &&
        record.input.tools.some(({ descriptor }) => descriptor.id === id),
    );

  const run = <TResult = unknown>(
    id: string,
    args: unknown,
    options: ToolApiRunOptions = {},
  ): ToolRun<TResult> => {
    if (disposed) {
      return failedRun<TResult>(
        apiFailure(
          'api-disposed',
          'the Tool API owner to remain available',
          'Create a fresh owner and retry the operation.',
          { operation: id },
        ),
      );
    }
    if (options.providerId !== undefined && options.sourceId === undefined) {
      return failedRun<TResult>(
        apiFailure(
          'api-source-required',
          `operation ${id} to include its explicit sourceId with providerId`,
          'Refresh Tool API sources and pass both sourceId and providerId from one snapshot.',
          { operation: id, providerId: options.providerId },
        ),
      );
    }
    const matches = findRecords(id, options.sourceId);
    const active = matches.filter((record) => record.state === 'active');
    const selected =
      options.providerId === undefined
        ? active.length === 1
          ? active[0]
          : undefined
        : active.find((record) => record.owner.providerId === options.providerId);
    if (selected === undefined) {
      const code =
        matches.length === 0 || active.length === 0
          ? 'api-operation-unavailable'
          : 'api-provider-route-required';
      return failedRun<TResult>(
        apiFailure(
          code,
          `operation ${id} to have one active, explicitly routable provider`,
          'Refresh Tool API sources and select the providerId/sourceId returned by discovery.',
          {
            operation: id,
            ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
            providers: matches.map((record) => record.owner.providerId),
          },
        ),
      );
    }
    if (options.generation !== undefined && options.generation !== selected.owner.generation) {
      return failedRun<TResult>(
        apiFailure(
          'api-stale-generation',
          `provider ${selected.owner.providerId} generation ${options.generation} to match ${selected.owner.generation}`,
          'Refresh the source snapshot before retrying the operation.',
          {
            operation: id,
            providerId: selected.owner.providerId,
            expectedGeneration: selected.owner.generation,
            actualGeneration: options.generation,
          },
        ),
      );
    }
    const contribution = selected.input.tools.find(({ descriptor }) => descriptor.id === id);
    if (contribution === undefined) {
      return failedRun<TResult>(
        apiFailure(
          'api-operation-unavailable',
          `operation ${id} to remain published by its provider`,
          'Refresh Tool API sources before retrying.',
          { operation: id },
        ),
      );
    }
    if (selected.input.authorize?.(options.caller, contribution.descriptor) === false) {
      return failedRun<TResult>(
        apiFailure(
          'api-unauthorized',
          `caller to be authorized for operation ${id}`,
          'Use the authenticated Host connection and the capability it was granted.',
          { operation: id, providerId: selected.owner.providerId },
        ),
      );
    }
    const runOptions: ToolRunOptions = {
      ...options,
      owner: selected.owner,
      ...(options.caller === undefined ? {} : { caller: options.caller }),
    };
    const activeRun = selected.runtime.run(contribution, args, runOptions);
    selected.runs.add(activeRun as ToolRun<unknown>);
    void activeRun.executorExited.finally(() =>
      selected.runs.delete(activeRun as ToolRun<unknown>),
    );
    return activeRun as ToolRun<TResult>;
  };

  const api: ToolApi = {
    snapshot,
    list: () => snapshot().operations,
    describe: (id, sourceId) =>
      findRecords(id, sourceId).flatMap((record) => {
        const contribution = record.input.tools.find(({ descriptor }) => descriptor.id === id);
        return contribution === undefined
          ? []
          : [
              {
                descriptor: contribution.descriptor,
                owner: record.owner,
                providerState: record.state,
                declared: true as const,
                callable: record.state === 'active',
                ...(record.fiberState === undefined ? {} : { fiberState: record.fiberState }),
              },
            ];
      }),
    registerProvider,
    run,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const pending = [...providers.values()].map((record) => {
        if (record.state === 'active' || record.state === 'pending') {
          record.state = 'revoking';
          record.fiberState = 'unloading';
          for (const run of record.runs) run.cancel('Tool API owner disposed');
        }
        return Promise.all([...record.runs].map((run) => run.executorExited)).then(() => {
          if (record.state !== 'failed') {
            record.state = 'revoked';
            record.fiberState = 'disposed';
          }
        });
      });
      await Promise.all(pending);
      notify();
      listeners.clear();
    },
  };
  return api;
}
