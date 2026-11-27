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
import type { createWorkspaceSelection } from './backend-lifetime.js';
import type { DevKitHostBinding } from './host-binding.js';
import { createOperationHistoryTools } from './operation-history.js';
import { createProjectCatalogueTools } from './project-catalogue-tools.js';
import { createWorkspaceLiveTools } from './workspace-live-tools.js';
import { runningWorkspaceTarget } from './workspace-preparation.js';
import {
  createDevKitWorkspaceProvider,
  DevKitWorkspaceError,
  type DevKitWorkspaceProviderOptions,
} from './workspace-provider.js';
import { createWorkspaceThumbnails } from './workspace-thumbnails.js';

export const ENGINE_WORKSPACE_CALL_SERVICE = 'engine.workspace.call';
export const ENGINE_WORKSPACE_CAPABILITIES_SERVICE = 'engine.workspace.capabilities';

export interface DevKitWorkspacePluginOptions extends DevKitWorkspaceProviderOptions {
  readonly hostBinding: DevKitHostBinding;
  readonly provider?: EngineWorkspaceProvider;
  readonly selection?: ReturnType<typeof createWorkspaceSelection>;
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
    let thumbnailEpoch = 0;
    const publish = () =>
      backend.transport.publish(ENGINE_WORKSPACE_STATE_TOPIC, {
        ...snapshotEngineWorkspace(runtime, catalogEpoch),
        thumbnailEpoch,
      });
    const notePublished = () => {
      catalogEpoch += 1;
      thumbnails.refresh();
      publish();
    };
    const runtime = createEngineWorkspaceRuntime(
      options.provider ??
        createDevKitWorkspaceProvider({
          ...options,
          onTargetChanged: async () => {
            const status = runtime.project?.status;
            const retired = status?.phase === 'starting' && status.browserGeneration > 0;
            const previews = retired ? runtime.previews : [];
            const play = retired ? runtime.play : undefined;
            publish();
            for (const preview of previews) await runtime.closePreview(preview);
            if (play) await runtime.stopPlay?.(play);
            if (retired) publish();
            await options.onTargetChanged?.();
          },
        }),
    );
    const thumbnails = createWorkspaceThumbnails(runtime, () => {
      thumbnailEpoch++;
      publish();
    });
    let saving = Promise.resolve();
    const saveSelection = (result: unknown) => {
      if (
        !options.selection ||
        (result && typeof result === 'object' && 'ok' in result && result.ok === false)
      )
        return Promise.resolve();
      const project = runtime.project?.project.root ?? null;
      const selection = options.selection;
      saving = saving.catch(() => {}).then(() => selection.write(project));
      return saving;
    };
    const forCaller = (caller?: ToolExecutionContext['caller'], targetId?: string) => {
      const source = caller?.kind === 'frontend' ? caller.sourceId : undefined;
      const projectPage = source?.startsWith('forgeax-workspace:');
      // The retained View Shell observes the backend-owned workspace.
      if (!projectPage && (!targetId || source === 'view-frontend')) return runtime;
      const status = runtime.project?.status;
      const accepted = status && status.phase !== 'preparing' ? status : undefined;
      const document = accepted?.document;
      if (projectPage) {
        return document && source === `forgeax-workspace:${document.sessionId}:${document.targetId}`
          ? runtime
          : undefined;
      }
      // Failed sessions keep their published identities for diagnostics.
      const targets = [
        document,
        accepted?.target,
        ...runtime.previews.map((preview) => preview.target),
        runtime.play?.target,
      ];
      return targets.some((target) => target?.targetId === targetId) ? runtime : undefined;
    };
    const tools = [
      ...createEngineWorkspaceTools(runtime, publish),
      thumbnails.tool,
      ...createWorkspaceLiveTools(),
      ...createOperationHistoryTools(),
      ...createProjectCatalogueTools(),
    ].map((tool) => ({
      descriptor: tool.descriptor,
      async execute(args: unknown, context: ToolExecutionContext) {
        const runAccessDenied = () =>
          tool.descriptor.id.startsWith('engine.run.') &&
          tool.descriptor.id !== 'engine.run.observe' &&
          (options.runAccess === 'observe' || context.caller?.kind === 'frontend');
        if (
          runAccessDenied() ||
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
        if (tool.descriptor.id.startsWith('engine.history.')) {
          if (context.caller?.kind === 'frontend') {
            const source = context.caller.sourceId;
            const project =
              source === 'view-frontend' || source?.startsWith('forgeax-workspace:')
                ? forCaller(context.caller)?.project
                : undefined;
            if (!project)
              return {
                ok: false as const,
                error: {
                  code: 'engine-history-project-required',
                  expected: 'an admitted frontend project',
                  hint: 'Open a project before reading its operation history.',
                },
              };
            return tool.execute(
              { ...(args && typeof args === 'object' ? args : {}), root: project.project.root },
              context,
            );
          }
          return tool.execute(args, context);
        }
        if (
          ['engine.project.list', 'engine.project.register', 'engine.project.browse'].includes(
            tool.descriptor.id,
          )
        )
          return tool.execute(args, context);
        if (!tool.descriptor.id.startsWith('engine.run.')) {
          const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
          if (
            !forCaller(
              context.caller,
              typeof input.targetId === 'string' ? input.targetId : undefined,
            )
          )
            return {
              ok: false as const,
              error: {
                code: 'engine-workspace-target-mismatch',
                expected: 'an active admitted Engine session',
                hint: 'Refresh the workspace and use its exact target identity.',
              },
            };
        }
        const result = await tool.execute(args, context);
        if (
          tool.descriptor.id === 'engine.project.open' ||
          tool.descriptor.id === 'engine.project.close'
        ) {
          thumbnails.refresh();
          await saveSelection(result);
        }
        return result;
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
    // Project-scoped modeling inspection for workspace frontends (the View modeling
    // plugin); loaded lazily so a backend without modeling work never imports the renderer.
    const modelingProviders = import('./workspace-modeling-tools.js').then(
      ({ createWorkspaceModelingTools }) => {
        const handles = new Map<string, ReturnType<ToolApi['registerProvider']>>();
        const byRealm = createWorkspaceModelingTools((context) => {
          const session = forCaller(context.caller);
          return session?.project?.project.root;
        });
        for (const [realm, list] of byRealm) {
          const handle = api.registerProvider({
            providerId: `engine-workspace-modeling:${realm}:${ctx.fiber.uid}`,
            sourceId: ENGINE_WORKSPACE_TOOL_SOURCE,
            realm,
            module: '@forgeax/engine-devkit',
            fiberId: String(ctx.fiber.uid),
            tools: list,
          });
          for (const tool of list) handles.set(tool.descriptor.id, handle);
        }
        return handles;
      },
    );
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
        const owner = payload.operation.startsWith('model.')
          ? ((await modelingProviders).get(payload.operation) ?? provider)
          : provider;
        const terminal = await api.run(payload.operation, 'args' in payload ? payload.args : {}, {
          sourceId: ENGINE_WORKSPACE_TOOL_SOURCE,
          providerId: owner.owner.providerId,
          generation: owner.owner.generation,
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
      const opened = runtime.project;
      const target = runningWorkspaceTarget(opened);
      if (opened && target && runtime.runtimePack)
        void runtime
          .runtimePack({
            ...opened,
            targetId: target.targetId,
            worldId: target.worldId,
            connectionId: caller.connectionId,
            request: { operation: 'release' },
          })
          .catch(() => {})
          .finally(publish);
      for (const preview of [...runtime.previews, runtime.play])
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
    });
    ctx.provide('engineWorkspace', runtime);
    ctx.provide('engineWorkspaceForCaller', forCaller);
    ctx.provide('engineWorkspaceCatalog', { notePublished });
    ctx.effect(() => async () => {
      call();
      capabilities();
      disconnect();
      await provider.revoke('Engine workspace plugin disposed');
      for (const handle of new Set((await modelingProviders.catch(() => new Map())).values()))
        await handle.revoke('Engine workspace plugin disposed');
      await thumbnails.close();
      await runtime.dispose();
    });
  },
};
