import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { ToolApi, ToolRunOptions, ToolTerminal } from '@forgeax/engine-tool-runtime';
import { createToolClient, type ToolClient } from './tools/client.js';

/** The DevKit command surface is a Host capability, not a second CLI runtime. */
export interface DevkitCliService {
  readonly ready: () => Promise<ToolClient>;
  readonly closed: () => boolean;
}

export interface DevkitCliStartup {
  readonly plugin: Plugin;
  readonly service: DevkitCliService;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    devkitCli: DevkitCliService;
  }
}

/**
 * Assemble the SDK command registry inside the same Cordis lifecycle used by
 * every other Host. The binary only owns startup/disposal; command discovery,
 * dispatch and project extension loading belong to this startup capability.
 */
export function createDevkitCliStartup(projectRoot: string): DevkitCliStartup {
  let closed = false;
  const lifecycle = new AbortController();
  const active = new Set<Promise<unknown>>();
  let client: Promise<ToolClient> | undefined;
  let toolApi: ToolApi | undefined;
  let ownerContext: Context | undefined;

  const closedTerminal = (): ToolTerminal<never> => ({
    outcome: 'failed',
    failure: {
      code: 'tool-capability-unavailable',
      expected: 'the DevKit CLI Host to remain mounted for the duration of a command',
      hint: 'Start a new Host before issuing another command.',
      detail: { capability: 'host:devkit-cli', realm: 'build' },
    },
    artifacts: [],
  });

  const signalFor = (caller: AbortSignal | undefined): AbortSignal => {
    if (caller === undefined) return lifecycle.signal;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (caller.aborted || lifecycle.signal.aborted) controller.abort();
    else {
      caller.addEventListener('abort', abort, { once: true });
      lifecycle.signal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
  };

  const track = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation);
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    );
    return operation;
  };

  const wrapClient = (base: ToolClient): ToolClient => ({
    list: base.list,
    describe: base.describe,
    help: base.help,
    tree: base.tree,
    runPath: <TResult = unknown>(
      path: readonly string[] | string,
      args: unknown,
      options?: ToolRunOptions,
    ): Promise<ToolTerminal<TResult>> => {
      if (closed) return Promise.resolve(closedTerminal() as ToolTerminal<TResult>);
      return track(
        base.runPath<TResult>(path, args, {
          ...options,
          signal: signalFor(options?.signal),
        }),
      );
    },
    run: <TResult = unknown>(
      id: string,
      args: unknown,
      options?: ToolRunOptions,
    ): Promise<ToolTerminal<TResult>> => {
      if (closed) return Promise.resolve(closedTerminal() as ToolTerminal<TResult>);
      return track(
        base.run<TResult>(id, args, {
          ...options,
          signal: signalFor(options?.signal),
        }),
      );
    },
    dispose: async () => {
      await base.dispose?.();
    },
  });

  const dispose = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    lifecycle.abort();
    await Promise.allSettled([...active]);
    await client?.then((value) => value.dispose?.()).catch(() => {});
  };

  const service: DevkitCliService = {
    ready: () => {
      if (closed) return Promise.reject(new Error('devkit CLI Host has been disposed'));
      client ??= createToolClient({
        projectRoot,
        ...(ownerContext === undefined ? {} : { context: ownerContext }),
        ...(toolApi === undefined ? {} : { toolApi }),
      }).then(wrapClient);
      return client.then((value) => {
        if (closed) throw new Error('devkit CLI Host has been disposed');
        return value;
      });
    },
    closed: () => closed,
  };
  const plugin: Plugin = {
    name: 'forgeax:devkit-cli-host',
    provide: ['devkitCli'],
    apply(ctx) {
      ownerContext = ctx;
      toolApi = ctx.get('toolApi', false) as ToolApi | undefined;
      ctx.provide('devkitCli', service);
      ctx.effect(() => dispose, 'devkit/cli-host');
    },
  };
  return { plugin, service };
}
