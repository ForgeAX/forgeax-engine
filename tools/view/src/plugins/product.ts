import type { Context, Fiber } from '@forgeax/engine-plugin';
import type {} from '@forgeax/engine/devkit';
import type { DevKitHostBinding } from '@forgeax/engine/devkit';
import type { HostRootDescriptor } from '@forgeax/engine-host/protocol';
import type { ToolJsonSchema, ToolSchema } from '@forgeax/engine-tool-runtime';
import type { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';
import type { ViewFrontendConfig } from '@forgeax/view-viewer/config';
import { workspaceDiagnosticRecord } from '@forgeax/view-workspace-core/command-error';
export type ViewProductConfig = Pick<ViewHostServerOptions, 'port'> & { disabledPages?: readonly string[]; staticRoot?: string; frontendConfig?: Pick<ViewFrontendConfig, 'layout'>; frontend?: { root?: Partial<HostRootDescriptor>; module?: DevKitHostBinding['frontendModule'] } };
type LifecycleArgs = { root?: string; project?: string; frontendConfig?: Pick<ViewFrontendConfig, 'layout'> };
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHostAssembly } from '@forgeax/engine-host/protocol';
import { defineTool, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import { registerTools, startNativePlugin } from '@forgeax/engine-plugin';
import { createViewProductPlan, viewFrontendRoot, VIEW_FRONTEND_MODULE } from '@forgeax/view-viewer/catalog/shared';
import { listPackSources } from '@forgeax/engine-pack/build';
import { VIEW_PRODUCT_BACKEND_CATALOG } from '@forgeax/view-viewer/catalog/backend';
import { startViewHostServer, type ViewHostServerOptions } from '@forgeax/view-workspace-core/resident';

import { openViewProject, viewProjectOpenError } from '../view-project-open.ts';
import { resolveProjectIntent, withProjectIntent } from '../view-start.ts';
import { viewStartFrontendConfigSchema } from '../commands.ts';

const ownerArgs = toolJsonSchema({ type: 'object', properties: { root: { type: 'string' } }, additionalProperties: false });
const startArgs = toolJsonSchema({ type: 'object', properties: {
  root: { type: 'string' }, project: { type: 'string' },
  frontendConfig: viewStartFrontendConfigSchema,
}, additionalProperties: false });
const projectOpenSchema = {
  type: 'object',
  properties: { root: { type: 'string' }, project: { type: 'string' } },
  required: ['project'],
  additionalProperties: false,
} satisfies ToolJsonSchema;

function readWorkspaceCore(owner?: Context) {
  if (!owner || typeof owner.get !== 'function') return undefined;
  try {
    const value = owner.get('viewWorkspaceCore', false);
    return value && typeof value.openProject === 'function' && typeof value.snapshot === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
}

function installedViewStaticRoot(projectRoot: string) {
  try {
    const pluginEntry = createRequire(join(projectRoot, 'forge.json')).resolve('@forgeax/view/plugin');
    const staticRoot = resolve(dirname(pluginEntry), '../viewer');
    return existsSync(join(staticRoot, 'index.html')) ? staticRoot : undefined;
  } catch {
    return undefined;
  }
}

function projectFailure(error: unknown) {
  const record = workspaceDiagnosticRecord(error);
  const hint = typeof record.hint === 'string' ? record.hint : typeof record.message === 'string' ? record.message : String(error);
  return {
    ok: false,
    error: {
      code: typeof record.code === 'string' ? record.code : 'view-project-open-failed',
      expected: typeof record.expected === 'string' ? record.expected : hint,
      hint,
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    },
  };
}

function projectSuccess(body: Awaited<ReturnType<typeof openViewProject>>) {
  return {
    ok: true,
    value: {
      ok: true,
      alreadyOpen: body.alreadyOpen === true,
      ...(body.viewerUrl === undefined ? {} : { viewerUrl: body.viewerUrl }),
      project: body.project,
      projectTarget: body.projectTarget,
    },
  };
}

/** Installed on Engine's resident Host. View owns only its plugin Fibers and sockets. */
export default {
  name: 'forgeax.view',
  inject: ['devkitBackend', 'engineWorkspace', 'toolApi'],
  async apply(ctx: Context, config: ViewProductConfig = {}) {
    const { host } = ctx.devkitBackend;
    let fiber: Fiber | undefined;
    let server: Awaited<ReturnType<typeof startViewHostServer>> | undefined;
    let serverEffect: ReturnType<Context['effect']> | undefined;
    let failure: ReturnType<typeof failed> | undefined;
    const failed = (error: unknown) => {
      const record = workspaceDiagnosticRecord(error);
      return ({
      code: typeof record.code === 'string' ? record.code : 'view-cleanup-failed',
      expected: typeof record.expected === 'string' ? record.expected : 'View-owned contributions to finish cleanup',
      hint: typeof record.hint === 'string' ? record.hint : typeof record.message === 'string' ? record.message : String(error),
      cleanup: workspaceDiagnosticRecord(record.detail).cleanup ?? 'failed',
    }); };
    let workspaceCore: ViewWorkspaceBroker | undefined;
    let openAbort: AbortController | undefined;
    let sessionEpoch = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(execute: () => T | Promise<T>) => {
      const result = queue.then(execute);
      queue = result.catch(() => {});
      return result;
    };
    const status = () => failure ? { phase: 'failed', error: failure } : ({ phase: server ? 'ready' : 'stopped', ...(server ? {
      url: server.viewerUrl,
      // Derive the public presentation identity from its native admission lease.
      // A fixed URL can outlive that lease; the credential itself stays private.
      presentationId: createHash('sha256').update(server.frontendTicket).digest('hex'),
    } : {}) });
    const stop = async () => {
      if (failure) throw new Error(`${failure.code}: ${failure.hint}`);
      sessionEpoch += 1;
      openAbort?.abort();
      openAbort = undefined;
      workspaceCore = undefined;
      try { await serverEffect?.(); await server?.close(); await fiber?.dispose(); }
      catch (error) { failure = failed(error); throw error; }
      fiber = undefined;
      server = undefined;
      return status();
    };
    const start = async (args: LifecycleArgs = {}) => {
      if (failure) throw new Error(`${failure.code}: ${failure.hint}`);
      const project = resolveProjectIntent(args.project === undefined ? [] : ['--project', args.project], ctx.devkitBackend.root);
      if (fiber) return withProjectIntent(status(), project);
      const token = randomUUID();
      const workspaceClient = { clientId: 'view-frontend', token, resourceBrowser: true };
      const layout = args.frontendConfig?.layout ?? config.frontendConfig?.layout;
      const frontendConfig: ViewFrontendConfig = {
        embedded: true,
        workspace: workspaceClient,
        ...(layout === undefined ? {} : { layout }),
      };
      const plan = createViewProductPlan({
        disabledPages: config.disabledPages,
        backendConfig: { workspaceAccessToken: token, packSources: (root, assetRoots) => listPackSources(root, 200, assetRoots) },
        frontendConfig,
      });
      const installation = {
        name: 'forgeax.view.product',
        provide: ['devkitWorkspaceFrontend'],
        async apply(owner: Context) {
          for (const component of plan.backend) {
            const record = VIEW_PRODUCT_BACKEND_CATALOG.get(component.module);
            if (!record) throw new Error(`View backend program is missing: ${component.module}`);
            const module = await record.load();
            await (await owner.plugin(module.default, component.config)).await();
          }
          const builtRoot = config.staticRoot ? undefined : installedViewStaticRoot(
            ctx.devkitBackend.hostPackageRoot ?? ctx.devkitBackend.root,
          );
          if (!config.staticRoot && !builtRoot) throw new Error('View UI is not built. Build or install the View package before starting it.');
          // The launcher is the parent fiber. Cordis get walks ancestors, so the
          // broker provided by this installation is read here and kept for the tool.
          workspaceCore = readWorkspaceCore(owner);
          const core = workspaceCore;
          serverEffect = owner.effect(async () => {
            const ownedServer = await startViewHostServer({
            ...(config.port === undefined ? {} : {port: config.port}),
            backendHost: host,
            accessToken: token,
            staticRoot: config.staticRoot ?? builtRoot,
            frontendConfig,
            ...(core === undefined ? {} : {
              onClientConnect: (caller) => core.attachPageSession(caller, host.transport),
              onClientDisconnect: (caller) => core.revokeConnection(caller.connectionId),
            }),
          });
            server = ownedServer;
            return () => ownedServer.close();
          });
          await serverEffect;
          Object.assign(workspaceClient, { endpoint: server!.frontendEndpoint, frontendTicket: server!.frontendTicket });
          const frontendRoot = viewFrontendRoot(frontendConfig, plan.disabledPages);
          const assembly = createHostAssembly({ root: frontendRoot });
          const targetAssembly = config.frontend ? createHostAssembly({ root: { ...frontendRoot, ...config.frontend.root, config: frontendRoot.config } }) : assembly;
          owner.provide('devkitWorkspaceFrontend', { assembly: targetAssembly, module: config.frontend?.module ?? VIEW_FRONTEND_MODULE });
          const removeAdmission = host.transport.onClientConnect(caller => {
            if (caller.kind === 'frontend' && caller.sourceId === 'view-frontend') {
              host.bindProjection(caller, { assembly });
            }
          });
          owner.effect(() => removeAdmission);
        },
      };
      const started = await startNativePlugin(ctx, installation);
      if (!started.ok) {
        workspaceCore = undefined;
        if (workspaceDiagnosticRecord(started.error.detail).cleanup !== 'completed') failure = failed(started.error);
        else server = undefined;
        throw Object.assign(new Error(`${started.error.code}: ${started.error.hint}`), started.error);
      }
      fiber = started.value;
      return withProjectIntent(status(), project);
    };

    const openProject = async (args: LifecycleArgs = {}, epoch = sessionEpoch) => {
      const stopped = () => projectFailure(viewProjectOpenError(
        'view-not-started',
        'View has stopped. Run forgeax view start again when needed.',
      ));
      if (epoch !== sessionEpoch || !server || !workspaceCore) {
        return projectFailure(viewProjectOpenError(
          'view-not-started',
          epoch !== sessionEpoch
            ? 'View has stopped. Run forgeax view start again when needed.'
            : 'Run forgeax backend start, then forgeax view start.',
        ));
      }
      const project = typeof args.project === 'string' ? args.project : '';
      const controller = new AbortController();
      openAbort = controller;
      try {
        if (epoch !== sessionEpoch || controller.signal.aborted) return stopped();
        const body = await openViewProject(workspaceCore, project, {
          signal: controller.signal,
          viewerUrl: server.viewerUrl,
        });
        if (epoch !== sessionEpoch || controller.signal.aborted) return stopped();
        return projectSuccess(body);
      } catch (error) {
        if (epoch !== sessionEpoch || controller.signal.aborted) return stopped();
        return projectFailure(error);
      } finally {
        if (openAbort === controller) openAbort = undefined;
      }
    };
    const lifecycleTool = (operation: string, execute: (args: LifecycleArgs) => unknown, { before, argsSchema = ownerArgs }: { before?: () => void; argsSchema?: ToolSchema<unknown> } = {}) => defineTool<unknown, unknown>({
      id: `view.${operation}`, path: ['view', operation], title: `View ${operation}`,
      summary: `${operation} the optional View interface on the existing Engine backend.`, realm: 'host',
      argsSchema, resultSchema: toolJsonSchema({ type: 'object' }), inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, evidence: [],
    }, (args) => {
      before?.();
      return enqueue(() => execute(args as LifecycleArgs));
    });
    const tools = [
      lifecycleTool('start', start, { argsSchema: startArgs }),
      lifecycleTool('status', status),
      lifecycleTool('stop', stop, { before: () => { sessionEpoch += 1; openAbort?.abort(); } }),
      defineTool<unknown, unknown>({
        id: 'view.project.open',
        path: ['view', 'project', 'open'],
        title: 'Open View project',
        summary: 'Open a project on the running View and return its headed document URL.',
        realm: 'host',
        argsSchema: toolJsonSchema(projectOpenSchema),
        resultSchema: toolJsonSchema({ type: 'object' }),
        inputSchema: projectOpenSchema,
        outputSchema: { type: 'object' },
        evidence: [],
      }, (args) => {
        const epoch = sessionEpoch;
        return enqueue(() => openProject(args as LifecycleArgs, epoch));
      }),
    ];
    const revoke = registerTools(ctx, tools, { sourceId: 'view-launcher', module: '@forgeax/view/plugin', realm: 'host' });
    ctx.effect(() => async () => { await revoke(); await queue; await stop(); });
  },
};
