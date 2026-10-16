import { isSerializableValue, validateArtifactRefs } from './artifacts.js';
import {
  artifactIncompleteError,
  cancellationError,
  capabilityUnavailableError,
  cleanupError,
  disconnectedError,
  domainFailureError,
  invalidArgsError,
  terminalError,
  timeoutError,
} from './errors.js';
import { createLexicalLease, type LeaseTerminationReason } from './lease.js';
import { createExclusiveTiming, finishToolTiming, startToolTiming } from './timing.js';
import type {
  JsonValue,
  ToolCapability,
  ToolCleanupReport,
  ToolContribution,
  ToolDescriptor,
  ToolDomainFailure,
  ToolExecutionContext,
  ToolExecutor,
  ToolRun,
  ToolRunEvent,
  ToolRunOptions,
  ToolRuntimeError,
  ToolSchema,
  ToolTerminal,
} from './types.js';

export interface ToolRuntime {
  readonly list: () => readonly ToolDescriptor[];
  readonly describe: (id: string) => ToolDescriptor | undefined;
  readonly get: (id: string) => ToolContribution<unknown, unknown> | undefined;
  readonly run: <TArgs, TResult>(
    contribution: ToolContribution<TArgs, TResult>,
    args: TArgs,
    options?: ToolRunOptions,
  ) => ToolRun<TResult>;
}

export function defineTool<TArgs, TResult>(
  descriptor: ToolDescriptor<TArgs, TResult>,
  execute: ToolExecutor<TArgs, TResult>,
): ToolContribution<TArgs, TResult> {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(descriptor.id)) {
    throw new TypeError(`Tool id must use a stable lower-case path: ${descriptor.id}`);
  }
  if (descriptor.title.trim().length === 0 || descriptor.summary.trim().length === 0) {
    throw new TypeError('Tool title and summary must not be empty');
  }
  if (!Array.isArray(descriptor.evidence)) throw new TypeError('Tool evidence must be an array');
  if (descriptor.preview !== undefined && descriptor.preview.realm !== descriptor.realm) {
    throw new TypeError(
      `Tool ${descriptor.id} preview contract declares ${descriptor.preview.realm} but descriptor declares ${descriptor.realm}`,
    );
  }
  const argsSchema: ToolSchema<TArgs> = descriptor.argsSchema;
  const resultSchema: ToolSchema<TResult> = descriptor.resultSchema;
  return {
    descriptor: { ...descriptor, argsSchema, resultSchema, evidence: [...descriptor.evidence] },
    execute,
  };
}

function eventChannel(): {
  readonly emit: (event: ToolRunEvent) => void;
  readonly close: () => void;
  readonly events: AsyncIterable<ToolRunEvent>;
} {
  const queue: ToolRunEvent[] = [];
  const waiters: Array<(result: IteratorResult<ToolRunEvent>) => void> = [];
  let closed = false;
  const emit = (event: ToolRunEvent): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value: event });
    else queue.push(event);
  };
  const close = (): void => {
    closed = true;
    while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined });
  };
  const events: AsyncIterable<ToolRunEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<ToolRunEvent> {
      return {
        next: async (): Promise<IteratorResult<ToolRunEvent>> => {
          const event = queue.shift();
          if (event !== undefined) return { done: false, value: event };
          if (closed) return { done: true, value: undefined };
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
  return { emit, close, events };
}

function isTerminal<TResult>(value: unknown): value is ToolTerminal<TResult> {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = Reflect.get(value, 'outcome');
  return outcome === 'succeeded' || outcome === 'failed';
}

function serializablePreview(value: unknown): JsonValue {
  return isSerializableValue(value) ? value : null;
}

function domainError(error: ToolDomainFailure): ToolRuntimeError {
  return domainFailureError(
    error.code,
    typeof error.expected === 'string' ? error.expected : 'the producer operation to succeed',
    typeof error.hint === 'string'
      ? error.hint
      : error.hint === undefined || error.hint === null
        ? 'Inspect detail and repair the owning producer before retrying.'
        : (JSON.stringify(error.hint) ??
          'Inspect detail and repair the owning producer before retrying.'),
    error.detail,
  );
}

function hasOkField(value: unknown): value is { readonly ok: boolean } {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'ok') === 'boolean'
  );
}

function isToolRuntimeError(value: unknown): value is ToolRuntimeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'code') === 'string' &&
    Reflect.get(value, 'code').startsWith('tool-')
  );
}

export function createToolRuntime<TArgs, TResult>(
  contributions: readonly ToolContribution<TArgs, TResult>[],
): ToolRuntime;
export function createToolRuntime(contributions: readonly unknown[]): ToolRuntime;
export function createToolRuntime(contributions: readonly unknown[]): ToolRuntime {
  const byId = new Map<string, ToolContribution<unknown, unknown>>();
  for (const candidate of contributions) {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new TypeError('Tool contributions must be objects');
    }
    const contribution = candidate as ToolContribution<unknown, unknown>;
    if (typeof contribution.execute !== 'function') {
      throw new TypeError('Tool contributions must provide an executor');
    }
    const id = contribution.descriptor.id;
    if (byId.has(id)) throw new TypeError(`Duplicate tool contribution id: ${id}`);
    byId.set(id, contribution);
  }

  const list = (): readonly ToolDescriptor[] =>
    [...byId.values()].map((contribution) => contribution.descriptor);

  const run = <TArgs, TResult>(
    contribution: ToolContribution<TArgs, TResult>,
    args: TArgs,
    options: ToolRunOptions = {},
  ): ToolRun<TResult> => {
    const runId = `${contribution.descriptor.id}:${crypto.randomUUID()}`;
    const channel = eventChannel();
    const controller = new AbortController();
    const startedAtMs = startToolTiming();
    const operationTiming = createExclusiveTiming();
    const lookupStartedAtMs = startToolTiming();
    operationTiming.record('lookup', Math.max(0, startToolTiming() - lookupStartedAtMs));
    const lease = createLexicalLease(runId);
    const leaseStartedAtMs = startToolTiming();
    operationTiming.record('lease', Math.max(0, startToolTiming() - leaseStartedAtMs));
    let terminalStarted = false;
    let cleanupReport: ToolCleanupReport = {
      census: { worlds: 0, renderers: 0, canvases: 0, leases: 0 },
      failures: [],
    };
    let cancelReason = 'cancelled by caller';
    let resolveTerminal!: (terminal: ToolTerminal<TResult>) => void;
    const terminal = new Promise<ToolTerminal<TResult>>((resolve) => {
      resolveTerminal = resolve;
    });
    let resolveExecutorExited!: () => void;
    const executorExited = new Promise<void>((resolve) => {
      resolveExecutorExited = resolve;
    });

    const settle = async (
      candidate: ToolTerminal<TResult>,
      reason: LeaseTerminationReason = 'terminal',
    ): Promise<void> => {
      if (terminalStarted) return;
      terminalStarted = true;
      controller.abort();
      const finalizeStartedAtMs = startToolTiming();
      const cleanupResult = await lease.terminate(reason);
      const cleanupFailure = cleanupResult.failures[0];
      const liveResources = Object.entries(cleanupReport.census).filter(([, count]) => count !== 0);
      const reportFailure =
        cleanupReport.failures[0] ??
        (liveResources.length === 0
          ? undefined
          : `live resources remain: ${liveResources.map(([kind, count]) => `${kind}=${count}`).join(', ')}`);
      operationTiming.record('finalize', Math.max(0, startToolTiming() - finalizeStartedAtMs));
      const finalTerminal: ToolTerminal<TResult> =
        cleanupFailure || (candidate.outcome === 'succeeded' && reportFailure !== undefined)
          ? {
              outcome: 'failed',
              failure: cleanupError(
                runId,
                cleanupFailure === undefined
                  ? (reportFailure as string)
                  : `${cleanupFailure.owner}: ${cleanupFailure.message}`,
              ),
              artifacts: candidate.artifacts,
              cleanup: cleanupReport,
              ...(candidate.snapshotAfter === undefined
                ? {}
                : { snapshotAfter: candidate.snapshotAfter }),
              timing: finishToolTiming(startedAtMs, operationTiming),
            }
          : {
              ...candidate,
              cleanup: cleanupReport,
              timing: finishToolTiming(startedAtMs, operationTiming),
            };
      resolveTerminal(finalTerminal);
      channel.emit({
        kind: 'terminal',
        runId,
        outcome: finalTerminal.outcome,
        atMs: performance.now(),
      });
      channel.close();
    };

    const context: ToolExecutionContext = {
      runId,
      signal: controller.signal,
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      ...(options.caller === undefined ? {} : { caller: options.caller }),
      ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
      emit: (event) => {
        if (!terminalStarted) channel.emit({ ...event, runId });
      },
      addCleanup: (cleanup) => {
        if (!lease.register(`cleanup:${lease.state}`, cleanup)) void cleanup();
      },
      setCleanupReport: (report) => {
        cleanupReport = {
          census: { ...report.census },
          failures: [...report.failures],
        };
      },
      require: <T>(capability: ToolCapability<T>) => {
        if (terminalStarted) {
          return { ok: false as const, error: terminalError(runId, 'succeeded') };
        }
        const resolved = options.capabilityResolver?.(capability);
        if (resolved !== undefined) return resolved;
        return {
          ok: false as const,
          error: capabilityUnavailableError(capability.id, contribution.descriptor.realm),
        };
      },
      runChild: async (childContribution, childArgs, childOptions = {}) => {
        if (terminalStarted) {
          return {
            outcome: 'failed',
            failure: terminalError(runId, 'failed'),
            artifacts: [],
          };
        }
        const childRun = runtime.run(childContribution, childArgs, {
          ...childOptions,
          signal: controller.signal,
          ...(childOptions.capabilityResolver === undefined &&
          options.capabilityResolver !== undefined
            ? { capabilityResolver: options.capabilityResolver }
            : {}),
          ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
        });
        channel.emit({
          kind: 'child-started',
          runId,
          childRunId: childRun.id,
          atMs: performance.now(),
        });
        lease.register(`child:${childRun.id}`, () => {
          childRun.cancel('parent terminal');
        });
        return childRun.terminal;
      },
    };

    const fail = (failure: ToolRuntimeError): void => {
      void settle({ outcome: 'failed', failure, artifacts: [] });
    };

    const cancel = (reason = 'cancelled by caller'): void => {
      cancelReason = reason;
      void settle(
        { outcome: 'failed', failure: cancellationError(reason), artifacts: [] },
        'cancel',
      );
    };

    const disconnect = (transport = 'tool transport'): void => {
      void settle(
        { outcome: 'failed', failure: disconnectedError(transport), artifacts: [] },
        'disconnect',
      );
    };

    const providerExit = (provider = 'provider'): void => {
      void settle(
        {
          outcome: 'failed',
          failure: domainFailureError(
            'provider-exit',
            'the provider to remain alive until terminal',
            'Restart the provider and retry from the serialized snapshot.',
            provider,
          ),
          artifacts: [],
        },
        'provider-exit',
      );
    };

    const timeout =
      options.deadlineMs === undefined
        ? undefined
        : setTimeout(
            () =>
              void settle(
                {
                  outcome: 'failed',
                  failure: timeoutError(options.deadlineMs as number),
                  artifacts: [],
                },
                'timeout',
              ),
            options.deadlineMs,
          );

    channel.emit({ kind: 'started', runId, atMs: performance.now() });
    void (async () => {
      try {
        let parsedArgs: ReturnType<typeof contribution.descriptor.argsSchema.parse>;
        try {
          parsedArgs = contribution.descriptor.argsSchema.parse(args);
        } catch (cause) {
          await settle({
            outcome: 'failed',
            failure: invalidArgsError(
              cause instanceof Error ? cause.message : String(cause),
              serializablePreview(args),
            ),
            artifacts: [],
          });
          return;
        }
        if (!parsedArgs.ok) {
          fail(invalidArgsError(parsedArgs.error, serializablePreview(args)));
          return;
        }
        if (options.signal?.aborted) {
          cancelReason = 'aborted by caller';
          fail(cancellationError(cancelReason));
          return;
        }
        const onAbort = (): void => cancel('aborted by caller');
        options.signal?.addEventListener('abort', onAbort, { once: true });
        let produced: unknown;
        const executeStartedAtMs = startToolTiming();
        try {
          produced = await contribution.execute(parsedArgs.value, context);
        } finally {
          operationTiming.record('execute', Math.max(0, startToolTiming() - executeStartedAtMs));
          options.signal?.removeEventListener('abort', onAbort);
        }
        if (terminalStarted) return;
        if (controller.signal.aborted) {
          fail(cancellationError(cancelReason));
          return;
        }
        let result: unknown = produced;
        let snapshotAfter = options.snapshot;
        let artifacts: readonly import('./types.js').ArtifactRef[] = [];
        if (isTerminal<TResult>(produced)) {
          if (produced.outcome === 'failed') {
            await settle(produced);
            return;
          }
          result = produced.result;
          snapshotAfter = produced.snapshotAfter;
          artifacts = produced.artifacts;
          cleanupReport = produced.cleanup ?? cleanupReport;
        } else if (hasOkField(produced)) {
          if (produced.ok === false) {
            const error = Reflect.get(produced, 'error');
            const failureArtifacts = Reflect.get(produced, 'artifacts') ?? [];
            if (!validateArtifactRefs(failureArtifacts)) {
              await settle({
                outcome: 'failed',
                failure: domainFailureError(
                  'artifact-ref-invalid',
                  'failure artifact refs to be serializable ArtifactRef values',
                  'Return refs created by createArtifactRef.',
                ),
                artifacts: [],
              });
              return;
            }
            if (isToolRuntimeError(error)) {
              await settle({ outcome: 'failed', failure: error, artifacts: failureArtifacts });
              return;
            }
            await settle({
              outcome: 'failed',
              failure: domainError(error as ToolDomainFailure),
              artifacts: failureArtifacts,
            });
            return;
          }
          result = Reflect.get(produced, 'value');
          snapshotAfter = Reflect.get(produced, 'snapshotAfter');
          artifacts = Reflect.get(produced, 'artifacts') ?? [];
        }
        if (!isSerializableValue(result)) {
          await settle({
            outcome: 'failed',
            failure: domainFailureError(
              'terminal-not-serializable',
              'the result to be JSON serializable',
              'Return plain JSON data and ArtifactRef values instead of live handles.',
            ),
            artifacts: [],
          });
          return;
        }
        const parsedResult = contribution.descriptor.resultSchema.parse(result);
        if (!parsedResult.ok) {
          await settle({
            outcome: 'failed',
            failure: domainFailureError(
              'result-schema-invalid',
              'the result to satisfy resultSchema',
              parsedResult.error,
            ),
            artifacts: [],
          });
          return;
        }
        if (!validateArtifactRefs(artifacts)) {
          await settle({
            outcome: 'failed',
            failure: domainFailureError(
              'artifact-ref-invalid',
              'artifact refs to be serializable ArtifactRef values',
              'Return refs created by createArtifactRef.',
            ),
            artifacts: [],
          });
          return;
        }
        const requiredEvidence = [
          ...new Set([...(contribution.descriptor.evidence ?? []), ...(options.evidence ?? [])]),
        ];
        const missingEvidence = requiredEvidence.filter(
          (kind) => !artifacts.some((artifact) => artifact.kind === kind),
        );
        if (missingEvidence.length > 0) {
          await settle({
            outcome: 'failed',
            failure: artifactIncompleteError(missingEvidence, runId),
            artifacts,
          });
          return;
        }
        await settle({
          outcome: 'succeeded',
          result: parsedResult.value,
          artifacts,
          ...(snapshotAfter === undefined ? {} : { snapshotAfter }),
        });
      } catch (cause) {
        await settle({
          outcome: 'failed',
          failure: domainFailureError(
            'executor-threw',
            'the contribution executor to return a result',
            cause instanceof Error ? cause.message : String(cause),
          ),
          artifacts: [],
        });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        resolveExecutorExited();
      }
    })();

    const runtimeRun: ToolRun<TResult> = {
      id: runId,
      events: channel.events,
      terminal,
      executorExited,
      cancel,
      disconnect,
      providerExit,
    };
    return runtimeRun;
  };

  const runtime: ToolRuntime = {
    list,
    describe: (id) => byId.get(id)?.descriptor,
    get: (id) => byId.get(id),
    run,
  };
  return runtime;
}
