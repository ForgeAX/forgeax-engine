import { Context, createToolApiPlugin } from '@forgeax/engine-plugin';
import {
  createHostAssembly,
  type HostActivationReport,
  type HostAssembly,
  HostAssemblyError,
  type HostAssemblyInput,
  validateHostAssembly,
} from './protocol.js';
import { createHostStartup, type HostStartupOptions } from './startup.js';
import {
  createHostTransport,
  HOST_ACTIVATION_REPORT_SERVICE,
  HOST_ASSEMBLY_CHANGED_TOPIC,
  HOST_ASSEMBLY_SERVICE,
  type HostCallerIdentity,
  type HostTransportServer,
} from './transport.js';

export type HostActivationReportListener = (
  report: HostActivationReport,
  caller: HostCallerIdentity,
) => void | Promise<void>;
export interface BackendHostActivationStatus {
  readonly state: HostActivationReport['state'] | 'unavailable';
  readonly revision: string;
  readonly error?: unknown;
}
export interface BackendAssemblyAuthority {
  readonly current: HostAssembly;
  readonly generation: number;
  readonly activation: BackendHostActivationStatus;
  subscribe(listener: (assembly: HostAssembly) => void): () => void;
}
export interface BackendHostOptions
  extends Pick<HostStartupOptions, 'context' | 'startupTimeoutMs' | 'startupPlugins'> {
  readonly assembly?: HostAssembly;
  readonly config?: unknown;
  readonly transport?: HostTransportServer;
  readonly onActivationReport?: HostActivationReportListener;
}
export interface BackendHost {
  readonly context: Context;
  readonly assembly: BackendAssemblyAuthority;
  readonly transport: HostTransportServer;
  readonly ownedContext: boolean;
  update(
    input: HostAssemblyInput,
    options?: { readonly expectedRevision?: string },
  ): Promise<HostAssembly>;
  bindProjection(
    caller: HostCallerIdentity,
    projection: { readonly assembly: HostAssembly },
  ): () => void;
  subscribeActivationReports(listener: HostActivationReportListener): () => void;
  subscribeDispose(listener: () => void | Promise<void>): () => void;
  dispose(): Promise<void>;
}

/** Backend domain code is native startupPlugins; the published root belongs to the frontend. */
export async function createBackendHost(options: BackendHostOptions = {}): Promise<BackendHost> {
  const context = options.context ?? new Context();
  const transport = options.transport ?? createHostTransport();
  const checked = validateHostAssembly(
    options.assembly ?? createHostAssembly({ config: options.config }),
  );
  if (!checked.ok) throw checked.error;
  let current = checked.value;
  let status: BackendHostActivationStatus = { state: 'created', revision: current.revision };
  let disposed = false;
  const listeners = new Set<(assembly: HostAssembly) => void>();
  const reports = new Set<HostActivationReportListener>();
  const shutdown = new Set<() => void | Promise<void>>();
  const assembly: BackendAssemblyAuthority = {
    get current() {
      return current;
    },
    get generation() {
      return current.sessionGeneration;
    },
    get activation() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const projections = new Map<
    string,
    {
      readonly caller: HostCallerIdentity;
      readonly assembly?: HostAssembly;
    }
  >();
  const projectionFor = (caller: HostCallerIdentity) => {
    const projected = projections.get(caller.connectionId);
    if (projected && (projected.caller.capability !== caller.capability || !projected.assembly)) {
      throw new HostAssemblyError(
        'host-assembly-service-unavailable',
        'an active assembly projection for this connection',
        'Reconnect through the projection owner.',
        { service: HOST_ASSEMBLY_SERVICE },
      );
    }
    return projected;
  };
  const startup = await createHostStartup({
    context,
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    startupPlugins: [
      {
        name: 'forgeax:backend-foundation',
        apply(ctx) {
          ctx.provide('hostAssembly', assembly);
          ctx.provide('hostTransport', transport);
        },
      },
      ...(context.get('toolApi', false) === undefined ? [createToolApiPlugin()] : []),
      ...(options.startupPlugins ?? []),
    ],
  });
  const removeProjectionDisconnect = transport.onClientDisconnect((caller) =>
    projections.delete(caller.connectionId),
  );
  const unregisterAssembly = transport.register(
    HOST_ASSEMBLY_SERVICE,
    ({ caller }) => projectionFor(caller)?.assembly ?? current,
  );
  const unregisterReport = transport.register(
    HOST_ACTIVATION_REPORT_SERVICE,
    async ({ payload, caller }) => {
      const report = payload as HostActivationReport;
      const projected = projectionFor(caller);
      const accepted = [projected?.assembly ?? current];
      if (
        !accepted.some(
          (candidate) =>
            candidate &&
            report.revision === candidate.revision &&
            report.sessionGeneration === candidate.sessionGeneration,
        )
      ) {
        throw new HostAssemblyError(
          'host-assembly-revision-mismatch',
          'a report from the current session',
          'discard the stale frontend report',
          { actual: report.revision, expected: current.revision },
        );
      }
      await options.onActivationReport?.(report, caller);
      for (const listener of reports) await listener(report, caller);
      return { accepted: true };
    },
  );
  status = { state: 'active', revision: current.revision };
  let disposal: Promise<void> | undefined;
  return {
    context,
    transport,
    assembly,
    ownedContext: options.context === undefined,
    bindProjection(caller, projection) {
      if (disposed || !transport.isConnected(caller))
        throw new HostAssemblyError(
          'host-assembly-service-unavailable',
          'an active backend and its server-authenticated live connection',
          'Bind the projection using the current transport caller.',
          { service: HOST_ASSEMBLY_SERVICE },
        );
      const checked = validateHostAssembly(projection.assembly);
      if (!checked.ok) throw checked.error;
      const binding = {
        caller,
        assembly: checked.value,
      };
      projections.set(caller.connectionId, binding);
      transport.publish(HOST_ASSEMBLY_CHANGED_TOPIC, binding.assembly, {
        connectionId: caller.connectionId,
      });
      return () => {
        if (projections.get(caller.connectionId) !== binding) return;
        // A tombstone lives only until disconnect. Withdrawal must never select
        // the host's default assembly for a still-connected foreign realm.
        projections.set(caller.connectionId, { caller });
      };
    },
    async update(input, updateOptions) {
      if (disposed)
        throw new HostAssemblyError(
          'host-assembly-service-unavailable',
          'a live backend',
          'create a new host',
          { service: HOST_ASSEMBLY_SERVICE },
        );
      if (
        updateOptions?.expectedRevision !== undefined &&
        updateOptions.expectedRevision !== current.revision
      ) {
        throw new HostAssemblyError(
          'host-assembly-revision-mismatch',
          'the expected current assembly',
          'discard the stale update',
          { actual: current.revision, expected: updateOptions.expectedRevision },
        );
      }
      const generation = input.sessionGeneration ?? current.sessionGeneration + 1;
      if (generation <= current.sessionGeneration)
        throw new HostAssemblyError(
          'host-assembly-stale-request',
          'a monotonically increasing session generation',
          'rebuild a new session',
          { service: HOST_ASSEMBLY_SERVICE, generation },
        );
      current = createHostAssembly({ ...input, sessionGeneration: generation });
      status = { state: 'active', revision: current.revision };
      for (const listener of listeners) {
        try {
          listener(current);
        } catch {
          /* Observers do not control publication. */
        }
      }
      transport.publish(HOST_ASSEMBLY_CHANGED_TOPIC, current, {
        excludeConnectionIds: [...projections.keys()],
      });
      return current;
    },
    subscribeActivationReports(listener) {
      if (disposed) return () => {};
      reports.add(listener);
      return () => reports.delete(listener);
    },
    subscribeDispose(listener) {
      if (disposed) {
        void Promise.resolve().then(listener);
        return () => {};
      }
      shutdown.add(listener);
      return () => shutdown.delete(listener);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => {
        const errors: unknown[] = [];
        for (const cleanup of [
          ...shutdown,
          removeProjectionDisconnect,
          () => projections.clear(),
          unregisterReport,
          unregisterAssembly,
          () => transport.close(),
          () => startup.dispose(),
          ...(options.context === undefined ? [() => context.fiber.dispose()] : []),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        reports.clear();
        listeners.clear();
        shutdown.clear();
        status = { state: 'disposed', revision: current.revision };
        if (errors.length) throw new AggregateError(errors, 'backend host disposal failed');
      })();
      return disposal;
    },
  };
}
export { HostAssemblyError };
