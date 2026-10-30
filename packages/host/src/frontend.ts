import {
  Context,
  createToolApiPlugin,
  type Fiber,
  inspectPluginFiber,
  type Plugin,
  type PluginFiberInspection,
  startNativePlugin,
} from '@forgeax/engine-plugin';
import { beforeDeadline } from './deadline.js';
import {
  createHostAssembly,
  type HostActivationEntry,
  type HostActivationReport,
  type HostAssembly,
  HostAssemblyError,
  type HostErrorSummary,
  type HostRootDescriptor,
  validateHostAssembly,
} from './protocol.js';
import { createHostStartup, type HostStartupOptions } from './startup.js';
import {
  HOST_ACTIVATION_REPORT_SERVICE,
  HOST_ASSEMBLY_SERVICE,
  type HostTransportClient,
} from './transport.js';

export type FrontendHostState = HostActivationReport['state'];
export interface FrontendHostStatus {
  readonly state: FrontendHostState;
  readonly revision: string;
  readonly entries?: readonly HostActivationEntry[];
  readonly error?: unknown;
}
export interface FrontendAssemblyState {
  readonly current: HostAssembly;
  readonly status: FrontendHostStatus;
  readonly inspection: readonly PluginFiberInspection[];
  subscribe(listener: (state: FrontendAssemblyState) => void): () => void;
}
export interface FrontendHostOptions
  extends Pick<HostStartupOptions, 'context' | 'startupTimeoutMs' | 'startupPlugins'> {
  readonly cleanupTimeoutMs?: number;
  readonly assembly?: HostAssembly;
  readonly transport?: HostTransportClient;
  /** Static compiled resolution. Host never discovers or evaluates source modules. */
  readonly resolveRoot?: (root: HostRootDescriptor) => Promise<Plugin>;
  /** A domain may install through its own validated asset reader and external startup barrier. */
  readonly activateRoot?: (
    ctx: Context,
    root: HostRootDescriptor,
    signal: AbortSignal,
    startupTimeoutMs: number | null,
  ) => Promise<{ readonly fiber: Fiber }>;
  readonly reportStatus?: (status: FrontendHostStatus) => void | Promise<void>;
  readonly autoActivate?: boolean;
}
export interface FrontendHost {
  readonly context: Context;
  readonly assembly: FrontendAssemblyState;
  readonly transport?: HostTransportClient;
  readonly ownedContext: boolean;
  readonly status: FrontendHostStatus;
  readonly fiber: Fiber | undefined;
  activate(assembly?: HostAssembly): Promise<void>;
  update(assembly: HostAssembly): Promise<void>;
  dispose(): Promise<void>;
}
function summary(cause: unknown): HostErrorSummary {
  const value = cause as Partial<HostErrorSummary> | null;
  return {
    code: value?.code ?? 'host-root-failed',
    expected: value?.expected ?? 'a native root to become active',
    hint: value?.hint ?? String(cause),
    detail: value?.detail ?? {},
  };
}
export async function createFrontendHost(options: FrontendHostOptions = {}): Promise<FrontendHost> {
  const received =
    options.assembly ??
    (options.transport
      ? await options.transport.request<undefined, HostAssembly>(HOST_ASSEMBLY_SERVICE, undefined)
      : createHostAssembly());
  const checked = validateHostAssembly(received);
  if (!checked.ok) throw checked.error;
  const initial = checked.value;
  const context = options.context ?? new Context();
  const controller = new AbortController();
  let fiber: Fiber | undefined;
  let activationOwner: Fiber | undefined;
  let current = checked.value;
  let status: FrontendHostStatus = { state: 'created', revision: current.revision };
  let activated = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let activating: Promise<void> | undefined;
  const listeners = new Set<(value: FrontendAssemblyState) => void>();
  const inspection = (): PluginFiberInspection[] => {
    if (!fiber) return [];
    const result: PluginFiberInspection[] = [];
    for (const runtime of context.registry.values())
      for (const child of runtime.fibers) {
        for (let cursor = child; ; cursor = cursor.parent.fiber) {
          if (cursor === context.fiber) {
            result.push(inspectPluginFiber(child));
            break;
          }
          if (cursor === cursor.parent.fiber) break;
        }
      }
    return result;
  };
  const state: FrontendAssemblyState = {
    get current() {
      return current;
    },
    get status() {
      return status;
    },
    get inspection() {
      return inspection();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        /* Observers cannot control activation. */
      }
    }
  };
  const cleanup = (work: Promise<unknown>): Promise<unknown> =>
    beforeDeadline(
      work,
      options.cleanupTimeoutMs ?? 5_000,
      () =>
        new HostAssemblyError(
          'host-assembly-cleanup-timeout',
          'native Host contributions to drain',
          'terminate the page or Worker before retrying',
          { milliseconds: options.cleanupTimeoutMs ?? 5_000 },
        ),
    );
  const report = async (next: FrontendHostStatus) => {
    status = next;
    notify();
    await options.reportStatus?.(next);
    if (
      (disposed || controller.signal.aborted) &&
      (next.state === 'loading' || next.state === 'active')
    )
      throw controller.signal.reason ?? new Error('frontend report cancelled');
    if (options.transport)
      await options.transport.request(HOST_ACTIVATION_REPORT_SERVICE, {
        state: next.state,
        revision: next.revision,
        sessionGeneration: current.sessionGeneration,
        ...(next.entries ? { entries: next.entries } : {}),
        ...(next.error ? { error: summary(next.error) } : {}),
      });
    if (
      (disposed || controller.signal.aborted) &&
      (next.state === 'loading' || next.state === 'active')
    )
      throw controller.signal.reason ?? new Error('frontend report cancelled');
  };
  const startup = await createHostStartup({
    context,
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    startupPlugins: [
      {
        name: 'forgeax:frontend-foundation',
        apply(ctx) {
          ctx.provide('hostAssembly', state);
          if (options.transport) ctx.provide('hostTransport', options.transport);
        },
      },
      ...(context.get('toolApi', false) === undefined ? [createToolApiPlugin()] : []),
      ...(options.startupPlugins ?? []),
    ],
  });
  const disconnect = options.transport?.onDisconnect((cause) => {
    controller.abort(cause);
    if (!disposed) {
      status = { state: 'failed', revision: current.revision, error: cause };
      notify();
      void host.dispose().catch((error) => {
        status = { state: 'failed', revision: current.revision, error };
        notify();
      });
    }
  });
  const host: FrontendHost = {
    context,
    assembly: state,
    ownedContext: options.context === undefined,
    ...(options.transport ? { transport: options.transport } : {}),
    get status() {
      return status;
    },
    get fiber() {
      return fiber;
    },
    activate(next = current) {
      if (disposed) return Promise.reject(new Error('frontend host disposed'));
      const valid = validateHostAssembly(next);
      if (!valid.ok) return Promise.reject(valid.error);
      if (next.revision !== initial.revision)
        return Promise.reject(
          new HostAssemblyError(
            'host-assembly-reload-required',
            'a fresh JavaScript environment for a new root session',
            'reload the page or replace the Worker',
            {
              module: next.root?.program ?? '<empty>',
              actual: initial.revision,
              expected: next.revision,
            },
          ),
        );
      if (activating) return activating;
      if (activated) return Promise.resolve();
      next = valid.value;
      current = next;
      const startupTimeoutMs =
        options.startupTimeoutMs === undefined ? null : options.startupTimeoutMs;
      const activation = (async () => {
        await report({ state: 'loading', revision: next.revision });
        if (controller.signal.aborted || disposed)
          throw controller.signal.reason ?? new Error('frontend activation cancelled');
        if (next.root) {
          activationOwner = context.plugin({ name: 'forgeax:frontend-root', apply() {} }).ctx.fiber;
          const scope = activationOwner.ctx;
          if (options.activateRoot) {
            const mounted = await options.activateRoot(
              scope,
              next.root,
              controller.signal,
              startupTimeoutMs,
            );
            fiber = mounted.fiber;
          } else {
            if (!options.resolveRoot)
              throw new Error(`no compiled resolver for ${next.root.program}`);
            const plugin = await options.resolveRoot(next.root);
            if (controller.signal.aborted) throw controller.signal.reason;
            const result = await startNativePlugin(
              scope,
              plugin,
              structuredClone(next.root.config),
              { signal: controller.signal, timeoutMs: startupTimeoutMs },
            );
            if (!result.ok) throw result.error;
            fiber = result.value;
          }
        }
        if (controller.signal.aborted || disposed) {
          await cleanup(Promise.resolve(activationOwner?.dispose()));
          throw new Error('frontend activation cancelled');
        }
        activated = true;
        await report({
          state: 'active',
          revision: next.revision,
          entries: inspection().map((item) => ({
            entryId: `${current.sessionGeneration}:${item.uid}`,
            fiberState: item.state,
          })),
        });
      })();
      const boundedActivation =
        startupTimeoutMs === null
          ? activation
          : beforeDeadline(activation, startupTimeoutMs, () => {
              const error = new HostAssemblyError(
                'host-assembly-activation-timeout',
                'root resolution and startup before the deadline',
                'repair the plugin or resolver, then start a fresh environment',
                { milliseconds: startupTimeoutMs },
              );
              controller.abort(error);
              return error;
            });
      activating = boundedActivation.catch(async (cause) => {
        const failures: unknown[] = [cause];
        try {
          await cleanup(Promise.resolve(activationOwner?.dispose()));
        } catch (error) {
          failures.push(error);
        }
        if (!disposed) {
          status = { state: 'failed', revision: next.revision, error: cause };
          notify();
          void report(status).catch(() => {});
        }
        throw failures.length === 1
          ? cause
          : new AggregateError(failures, 'Host activation and cleanup failed');
      });
      return activating;
    },
    update(next) {
      return host.activate(next);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      controller.abort();
      disconnect?.();
      disposal = (async () => {
        const failures: unknown[] = [];
        for (const dispose of [
          () => activationOwner?.dispose(),
          () => startup.dispose(),
          () => (options.context === undefined ? context.fiber.dispose() : undefined),
        ]) {
          try {
            await cleanup(Promise.resolve(dispose()));
          } catch (cause) {
            failures.push(cause);
          }
        }
        status = failures.length
          ? {
              state: 'failed',
              revision: current.revision,
              error: new AggregateError(failures, 'Host cleanup failed'),
            }
          : { state: 'disposed', revision: current.revision };
        notify();
        listeners.clear();
        if (failures.length) throw status.error;
      })();
      return disposal;
    },
  };
  if (options.autoActivate !== false) {
    try {
      await host.activate();
    } catch (cause) {
      try {
        await host.dispose();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Host activation and cleanup failed');
      }
      throw cause;
    }
  }
  return host;
}
export { HostAssemblyError };
