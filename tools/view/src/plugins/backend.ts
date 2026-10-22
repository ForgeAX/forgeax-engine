import type { Fiber, Plugin } from '@forgeax/engine-plugin';
import type { BackendHost, BackendHostOptions } from '@forgeax/engine-host/backend';
import type { HostAssembly } from '@forgeax/engine-host/protocol';
import type { DevKitWorkspacePluginOptions } from '@forgeax/engine/devkit';
import type { ViewBackendProductConfig } from '@forgeax/view-viewer/catalog/shared';
import type { ViewFrontendConfig } from '@forgeax/view-viewer/config';
import type { ViewPlatform } from '@forgeax/view-plugin-display/carrier-contract';
import { workspaceDiagnosticRecord } from '@forgeax/view-workspace-core/command-error';
export type ViewBackendOptions = ViewBackendProductConfig & {
  platform?: ViewPlatform & { start?: () => void | Promise<void> };
  frontendConfig?: ViewFrontendConfig; disabledPages?: readonly string[];
  engineHost?: BackendHost; workspacePlugin?: Plugin<DevKitWorkspacePluginOptions>;
  workspaceOptions?: Omit<DevKitWorkspacePluginOptions, 'hostBinding' | 'provider'>;
  onActivationReport?: BackendHostOptions['onActivationReport'];
  workspaceServer?: boolean; workspaceHost?: string; workspacePort?: number;
  workspacePath?: string; staticRoot?: string | URL; workspaceFrontendSourceId?: string;
};
import { randomUUID } from 'node:crypto';
import { startNativePlugin } from '@forgeax/engine-plugin';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { createHostAssembly } from '@forgeax/engine-host/protocol';
import { createViewProductPlan, viewFrontendRoot, VIEW_FRONTEND_MODULE } from '@forgeax/view-viewer/catalog/shared';
import { listPackSources } from '@forgeax/engine-pack/build';
import { VIEW_PRODUCT_BACKEND_CATALOG } from '@forgeax/view-viewer/catalog/backend';
import { startViewHostServer } from '@forgeax/view-workspace-core/resident';

export function createViewPlatformBinding(platform: ViewPlatform) {
  if (!platform || typeof platform.createPage !== 'function') {
    throw new TypeError('View platform binding requires platform.createPage');
  }
  let disposal: Promise<void> | undefined;
  return {
    createPage: platform.createPage.bind(platform),
    ...(typeof platform.getCapabilities === 'function'
      ? { getCapabilities: platform.getCapabilities.bind(platform) }
      : {}),
    ...(typeof platform.dispose === 'function' ? { dispose: () => disposal ??= Promise.resolve().then(() => platform.dispose?.()) } : {}),
  };
}

export function createViewHostBinding({ backendHost, frontendAssembly }: { backendHost?: BackendHost; frontendAssembly?: HostAssembly } = {}) {
  if (!backendHost || !frontendAssembly) {
    throw new TypeError('View Host binding requires a backend Host and a frontend root assembly');
  }
  return Object.freeze({
    backend: backendHost,
    frontendAssembly,
    frontendModule: VIEW_FRONTEND_MODULE,
  });
}

/** The embedding helper owns View Fibers; a supplied BackendHost remains borrowed. */
export async function createViewBackend({ platform, capabilities, frontendConfig, disabledPages, workspaceEngine, workspaceAccessToken, workspaceAuthorize, engineHost, workspacePlugin, workspaceOptions, onActivationReport, workspaceServer = true, workspaceHost = '127.0.0.1', workspacePort = 0, workspacePath, staticRoot, workspaceFrontendSourceId }: ViewBackendOptions = {}) {
  const platformBinding = platform ? createViewPlatformBinding(platform) : undefined;
  let platformStarted = false;
  let backendHost: BackendHost | undefined;
  let workspaceFiber: Fiber | undefined;
  let resident: Awaited<ReturnType<typeof startViewHostServer>> | undefined;
  const fibers: Fiber[] = [];
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    const failures: unknown[] = [];
    for (const release of [
      () => resident?.close(), ...fibers.toReversed().map(fiber => () => fiber.dispose()),
      () => workspaceFiber?.dispose(), () => !engineHost && backendHost?.dispose(),
      () => platformStarted && platformBinding?.dispose?.(),
    ]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'View cleanup failed');
  })();
  try {
    platformStarted = platform !== undefined;
    await platform?.start?.();
  const token = workspaceAccessToken ?? randomUUID();
  const config = {
    ...(frontendConfig ?? {}),
    displayCarrier: platform !== undefined,
    workspace: {
      ...(frontendConfig?.workspace ?? {}),
      clientId: frontendConfig?.workspace?.clientId ?? 'view-frontend',
      token,
    },
  };
  const plan = createViewProductPlan({
    backendConfig: {
      ...(platform ? { platform: platformBinding } : {}),
      capabilities: capabilities ?? platform?.getCapabilities?.(),
      workspaceEngine,
      workspaceAccessToken: token,
      workspaceAuthorize,
      packSources: (root, assetRoots) => listPackSources(root, 200, assetRoots),
    },
    frontendConfig: config,
    disabledPages,
  });
  const frontendAssembly = createHostAssembly({
    root: viewFrontendRoot(config, plan.disabledPages),
  });
  const selectedWorkspacePlugin = workspacePlugin ??
    (workspaceEngine ? (await import('@forgeax/engine/devkit')).devKitWorkspacePlugin : undefined);
    backendHost = engineHost ?? await createBackendHost({
      assembly: frontendAssembly,
      onActivationReport,
    });
    if (selectedWorkspacePlugin) {
      if (engineHost) throw new TypeError('Install the workspace plugin on the owner before borrowing a Host');
      const started = await startNativePlugin(backendHost.context, selectedWorkspacePlugin, {
        ...workspaceOptions,
        ...(workspaceAuthorize === undefined ? {} : { authorize: ({ operation, args, caller, signal }: Parameters<NonNullable<DevKitWorkspacePluginOptions['authorize']>>[0]) => {
          const id = operation.replace(/^engine\./, '');
          const clientId = caller?.sourceId ?? (typeof workspaceDiagnosticRecord(args).clientId === 'string' ? String(workspaceDiagnosticRecord(args).clientId) : 'view-owner');
          return workspaceAuthorize({ operation: id, clientId, caller, signal, request: { operation: id, args: workspaceDiagnosticRecord(args), clientId } });
        } }),
        ...(workspaceEngine === undefined ? {} : { provider: workspaceEngine }),
        runAccess: 'observe',
        hostBinding: createViewHostBinding({ backendHost, frontendAssembly }),
      });
      if (!started.ok) throw started.error;
      workspaceFiber = started.value;
    }
    for (const component of plan.backend) {
      const record = VIEW_PRODUCT_BACKEND_CATALOG.get(component.module);
      if (!record) throw new Error(`View backend program is missing: ${component.module}`);
      const { default: plugin } = await record.load();
      const started = await startNativePlugin(backendHost.context, plugin, component.config);
      if (!started.ok) throw started.error;
      fibers.push(started.value);
    }
    const workspaceCore = backendHost.context.get('viewWorkspaceCore');
    if (!workspaceCore) throw new Error('View backend did not activate workspace core');
    if (workspaceServer) {
      resident = await startViewHostServer({
        backendHost,
        accessToken: backendHost.context.get('viewWorkspaceAccessToken'),
        host: workspaceHost,
        port: workspacePort,
        ...(workspaceFrontendSourceId === undefined ? {} : { frontendSourceId: workspaceFrontendSourceId }),
        onClientConnect: (caller) => {
          if (engineHost) engineHost.bindProjection(caller, { assembly: frontendAssembly });
          workspaceCore.attachPageSession(caller, backendHost!.transport);
        },
        onClientDisconnect: (caller) => workspaceCore.revokeConnection(caller.connectionId),
        ...(workspacePath === undefined ? {} : { path: workspacePath }),
        ...(staticRoot === undefined ? {} : { staticRoot }),
        ...(config.layout === undefined ? {} : { frontendConfig: { layout: config.layout } }),
      });
    }
    return Object.freeze({
      backendHost,
      broker: backendHost.context.get('viewBroker', false),
      carrier: backendHost.context.get('viewCarrier', false),
      workspaceCore,
      workspaceAccessToken: backendHost.context.get('viewWorkspaceAccessToken'),
      ...(resident === undefined ? {} : {
        workspaceServer: resident,
        workspaceEndpoint: resident.endpoint,
        workspaceUrl: resident.url,
        workspaceFrontendEndpoint: resident.frontendEndpoint,
        workspaceFrontendUrl: resident.frontendUrl,
        workspaceFrontendTicket: resident.frontendTicket,
      }),
      assembly: backendHost.assembly,
      hostBinding: createViewHostBinding({ backendHost, frontendAssembly }),
      dispose,
    });
  } catch (error) {
    try { await dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'View startup and cleanup failed'); }
    throw error;
  }
}
