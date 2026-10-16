import {
  createEngineWorkspaceRuntime,
  createEngineWorkspaceTools,
  ENGINE_WORKSPACE_STATE_TOPIC,
  ENGINE_WORKSPACE_TOOL_SOURCE,
  type EngineWorkspaceProvider,
  type EngineWorkspaceRuntime,
  snapshotEngineWorkspace,
} from '@forgeax/engine-app';
import type { Context } from '@forgeax/engine-plugin';
import type { ToolApi, ToolExecutionContext } from '@forgeax/engine-tool-runtime';
import type { DevKitHostBinding } from './host-binding.js';
import { createWorkspaceLiveTools } from './workspace-live-tools.js';
import {
  createDevKitWorkspaceProvider,
  DevKitWorkspaceError,
  type DevKitWorkspaceProviderOptions,
} from './workspace-provider.js';

export const ENGINE_WORKSPACE_CALL_SERVICE = 'engine.workspace.call';
export const ENGINE_WORKSPACE_CAPABILITIES_SERVICE = 'engine.workspace.capabilities';

export interface DevKitWorkspacePluginOptions extends DevKitWorkspaceProviderOptions {
  readonly hostBinding: DevKitHostBinding;
  readonly provider?: EngineWorkspaceProvider;
  /** Restrict this workspace adapter to observing independent runs. */
  readonly runAccess?: 'control' | 'observe';
  readonly authorize?: (input: {
    readonly operation: string;
    readonly args: unknown;
    readonly caller: ToolExecutionContext['caller'];
    readonly signal: AbortSignal;
  }) => boolean | Promise<boolean>;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    engineWorkspace: EngineWorkspaceRuntime;
    engineWorkspaceCatalog: { notePublished(): void };
  }
}

/** Engine domain owner, independent of any product frontend or browser launcher. */
export const devKitWorkspacePlugin = {
  name: 'forgeax:devkit-workspace',
  inject: ['toolApi'],
  provide: ['engineWorkspace', 'engineWorkspaceForCaller', 'engineWorkspaceCatalog'],
  apply(ctx: Context, options: DevKitWorkspacePluginOptions) {
    const backend = options.hostBinding.backend;
    const api = ctx.get('toolApi') as ToolApi;
    let catalogEpoch = 0;
    const publish = () =>
      backend.transport.publish(
        ENGINE_WORKSPACE_STATE_TOPIC,
        snapshotEngineWorkspace(runtime, catalogEpoch),
      );
    const notePublished = () => {
      catalogEpoch += 1;
      publish();
    };
    const runtimes = new Set<EngineWorkspaceRuntime>();
    const entries = new Map<string, EngineWorkspaceRuntime>();
    const createRuntime = () => {
      const session = createEngineWorkspaceRuntime(
        options.provider ??
          createDevKitWorkspaceProvider({
            ...options,
            onTargetChanged: async () => {
              const project = session.project;
              const retired = project?.phase === 'starting' && (project.browserGeneration ?? 0) > 0;
              const previews = retired ? session.previews : [];
              const play = retired ? session.play : undefined;
              publish();
              for (const preview of previews) await session.closePreview(preview);
              if (play) await session.stopPlay?.(play);
              if (retired) publish();
              await options.onTargetChanged?.();
            },
          }),
      );
      runtimes.add(session);
      return session;
    };
    const runtime = createRuntime();
    const forCaller = (caller?: ToolExecutionContext['caller'], targetId?: string) => {
      if (caller?.kind === 'frontend' && caller.sourceId?.startsWith('forgeax-workspace:')) {
        return [...runtimes].find((session) => {
          const target = session.project?.target;
          return (
            target && caller.sourceId === `forgeax-workspace:${target.sessionId}:${target.targetId}`
          );
        });
      }
      if (caller?.kind === 'frontend' && caller.sourceId === 'view-frontend') {
        let session = entries.get(caller.connectionId);
        if (!session) {
          if (runtimes.size >= 16)
            throw new DevKitWorkspaceError(
              'engine-workspace-session-limit',
              'at most 16 active workspace sessions',
              'Close an unused project session before opening another.',
            );
          session = createRuntime();
          entries.set(caller.connectionId, session);
        }
        return session;
      }
      if (targetId)
        return [...runtimes].find((session) =>
          [
            session.project?.target,
            ...session.previews.map((preview) => preview.target),
            session.play?.target,
          ].some((target) => target?.targetId === targetId),
        );
      return runtime;
    };
    const sessionTools = new WeakMap<
      EngineWorkspaceRuntime,
      ReturnType<typeof createEngineWorkspaceTools>
    >();
    const tools = [
      ...createEngineWorkspaceTools(runtime, publish),
      ...createWorkspaceLiveTools(),
    ].map((tool) => ({
      descriptor: tool.descriptor,
      async execute(args: unknown, context: ToolExecutionContext) {
        if (
          (tool.descriptor.id.startsWith('engine.run.') &&
            tool.descriptor.id !== 'engine.run.observe' &&
            (options.runAccess === 'observe' || context.caller?.kind === 'frontend')) ||
          (options.authorize &&
            !(await options.authorize({
              operation: tool.descriptor.id,
              args,
              caller: context.caller,
              signal: context.signal,
            })))
        ) {
          return {
            ok: false as const,
            error: {
              code: 'engine-workspace-unauthorized',
              expected: 'an authorized Engine operation',
              hint: 'Use an admitted identity with permission for this target.',
            },
          };
        }
        context.signal.throwIfAborted();
        if (!tool.descriptor.id.startsWith('engine.run.')) {
          const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
          const session = forCaller(
            context.caller,
            typeof input.targetId === 'string' ? input.targetId : undefined,
          );
          if (!session)
            return {
              ok: false as const,
              error: {
                code: 'engine-workspace-target-mismatch',
                expected: 'an active admitted Engine session',
                hint: 'Refresh the workspace and use its exact target identity.',
              },
            };
          let handlers = sessionTools.get(session);
          if (!handlers) {
            handlers = createEngineWorkspaceTools(session, publish);
            sessionTools.set(session, handlers);
          }
          const handler = handlers.find(
            (candidate) => candidate.descriptor.id === tool.descriptor.id,
          );
          if (handler) return handler.execute(args, context);
        }
        return tool.execute(args, context);
      },
    }));
    const provider = api.registerProvider({
      providerId: `engine-workspace:${ctx.fiber.uid}`,
      sourceId: ENGINE_WORKSPACE_TOOL_SOURCE,
      realm: 'host',
      module: '@forgeax/engine-devkit',
      fiberId: String(ctx.fiber.uid),
      tools,
    });
    const capabilities = backend.transport.register(ENGINE_WORKSPACE_CAPABILITIES_SERVICE, () => ({
      apiVersion: runtime.apiVersion,
      operations: tools.map(
        ({ descriptor: { id, path, title, summary, inputSchema, outputSchema } }) => ({
          id,
          path,
          title,
          summary,
          inputSchema,
          outputSchema,
        }),
      ),
    }));
    const call = backend.transport.register(
      ENGINE_WORKSPACE_CALL_SERVICE,
      async ({ payload, caller, signal }) => {
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('operation' in payload) ||
          typeof payload.operation !== 'string'
        ) {
          throw new TypeError('Engine workspace call requires an operation');
        }
        const terminal = await api.run(payload.operation, 'args' in payload ? payload.args : {}, {
          sourceId: ENGINE_WORKSPACE_TOOL_SOURCE,
          providerId: provider.owner.providerId,
          generation: provider.owner.generation,
          caller,
          signal,
        }).terminal;
        if (terminal.outcome === 'failed') {
          throw new DevKitWorkspaceError(
            terminal.failure.code,
            terminal.failure.expected,
            terminal.failure.hint,
            { failure: terminal.failure },
          );
        }
        return terminal.result;
      },
    );
    const disconnect = backend.transport.onClientDisconnect((caller) => {
      for (const session of runtimes) {
        const opened = session.project;
        const target = opened?.target;
        if (opened && target && session.runtimePack)
          void session
            .runtimePack({
              ...opened,
              targetId: target.targetId,
              worldId: target.worldId,
              connectionId: caller.connectionId,
              request: { operation: 'release' },
            })
            .catch(() => {})
            .finally(publish);
        for (const preview of [...session.previews, session.play])
          if (preview)
            void Promise.resolve()
              .then(() =>
                preview.revokeConnection?.({
                  targetId: preview.target.targetId,
                  connectionId: caller.connectionId,
                }),
              )
              .catch(() => {})
              .finally(publish);
      }
      const entry = entries.get(caller.connectionId);
      entries.delete(caller.connectionId);
      if (entry && !entry.project) {
        runtimes.delete(entry);
        void entry.dispose().catch(() => {});
      }
    });
    ctx.provide('engineWorkspace', runtime);
    ctx.provide('engineWorkspaceForCaller', forCaller);
    ctx.provide('engineWorkspaceCatalog', { notePublished });
    ctx.effect(() => async () => {
      call();
      capabilities();
      disconnect();
      await provider.revoke('Engine workspace plugin disposed');
      await Promise.all([...runtimes].map((session) => session.dispose()));
      runtimes.clear();
      entries.clear();
    });
  },
};
