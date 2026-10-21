import type { HostTransportClient, HostRequestOptions } from '@forgeax/engine-host/transport';
import type { EngineWorkspaceCameraInput, EngineWorkspaceCameraResult, EngineWorkspaceTargetTools } from '@forgeax/engine/app';
import type { WorkspacePreviewDisplay, WorkspacePreviewDisplayOptions, WorkspaceState, WorkspaceSummary, WorkspacePages, WorkspacePackReveal, WorkspacePackRevealResult, WorkspaceInspection, WorkspaceAsset, WorkspaceThumbnail } from './contract.ts';
import type { ProjectSession } from './project-session.ts';
import { workspaceDiagnosticRecord } from './command-error.ts';
export type WorkspaceCallOptions = HostRequestOptions & { requestId?: string; reportError?: boolean };
export type WorkspaceTargetOptions = WorkspaceCallOptions & { tabId?: string; targetId?: string; targetGeneration?: number };
export type WorkspaceOptions = WorkspaceTargetOptions & Partial<EngineWorkspaceCameraInput> & {
  label?: string; entityIds?: readonly string[]; root?: string; projectId?: string; expectedTargetId?: string | null; expectedTargetState?: string;
  expectedRevision?: string; width?: number; height?: number; reason?: string; offset?: number; limit?: number; revision?: string;
  sourceId?: string; sourceGeneration?: number; sinceRevision?: number;
};
export type WorkspaceTransport = Pick<HostTransportClient, 'request'> & Partial<Pick<HostTransportClient, 'subscribe' | 'onDisconnect' | 'close' | 'connected'>>;
export type WorkspaceClientOptions = { transport: WorkspaceTransport; clientId: string; token?: string };
import {
  VIEW_WORKSPACE_SERVICES,
  VIEW_WORKSPACE_OPERATION_EFFECTS,
  VIEW_WORKSPACE_STATE_TOPIC,
  VIEW_WORKSPACE_TAB_ID,
  ViewWorkspaceError,
  createWorkspaceRequest,
  requireWorkspaceString,
} from './contract.ts';
import { reportWorkspaceCommandError } from './command-error.ts';
import { createRequestSharing } from './request-sharing.ts';
const VIEW_INSPECTOR_TOPIC = 'forgeax.view.inspector.changed';

export function workspaceBrowserEndpoint(endpoint: string, token: string, baseHref?: string, role?: string, frontendTicket?: string) {
  requireWorkspaceString(endpoint, 'endpoint');
  requireWorkspaceString(token, 'token');
  const url = new URL(endpoint, baseHref);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new TypeError('View frontend endpoint must use ws: or wss:');
  url.searchParams.set('token', token);
  if (role !== undefined) url.searchParams.set('role', role);
  if (role === 'frontend' && frontendTicket !== undefined) url.searchParams.set('frontendTicket', frontendTicket);
  return url.toString();
}

function decodeWorkspaceTransportError(error: unknown) {
  if (error instanceof ViewWorkspaceError) return error;
  const record = workspaceDiagnosticRecord(error);
  const detail = workspaceDiagnosticRecord(record.detail);
  const transportCode = record.code;
  const remoteCode =
    typeof detail.remoteCode === 'string'
      ? detail.remoteCode
      : undefined;
  const code = [transportCode, remoteCode].find(
    (candidate) => typeof candidate === 'string' && candidate.startsWith('view-'),
  );
  if (typeof code !== 'string') return error;
  const message = typeof record.message === 'string' && record.message.trim() !== ''
    ? record.message
    : String(error);
  return new ViewWorkspaceError(
    code,
    typeof record.expected === 'string' ? record.expected : message,
    typeof record.hint === 'string' ? record.hint : message,
    {
      ...(record.detail && typeof detail === 'object' ? detail : {}),
      transportCode,
      ...(remoteCode === undefined ? {} : { remoteCode }),
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
    },
  );
}

/**
 * Typed client used by both the View frontend and an independent CLI process.
 * It has no local domain state: every operation goes through the Engine Host
 * workspace service and every returned value is the backend authority's value.
 */
export class ViewWorkspaceClient {
  readonly #requests = createRequestSharing();
  declare readonly transport: WorkspaceTransport;
  declare readonly clientId: string;
  declare readonly token: string | undefined;
  declare projectSession?: ProjectSession;
  constructor({ transport, clientId, token }: Partial<WorkspaceClientOptions> = {}) {
    if (!transport || typeof transport.request !== 'function') {
      throw new TypeError('View workspace client requires an Engine Host transport');
    }
    this.transport = transport;
    this.clientId = requireWorkspaceString(clientId, 'clientId');
    this.token = token === undefined ? undefined : requireWorkspaceString(token, 'token');
  }

  call<T = unknown>(operation: string, args: Record<string, unknown> = {}, { signal, generation, requestId, reportError }: WorkspaceCallOptions = {}): Promise<T> {
    const request = createWorkspaceRequest(operation, args, {
      clientId: this.clientId,
      token: this.token,
      requestId,
    });
    const query = VIEW_WORKSPACE_OPERATION_EFFECTS[operation as keyof typeof VIEW_WORKSPACE_OPERATION_EFFECTS] === 'query';
    if (!query) this.#requests.fence();
    const invoke = (signal?: AbortSignal) => this.transport.request<typeof request, T>(VIEW_WORKSPACE_SERVICES.call, request, { signal, generation });
    return (query ? this.#requests.read(JSON.stringify([operation, request.args, generation, requestId]), invoke, signal) : Promise.resolve().then(() => invoke(signal)))
      .catch((error) => {
        const decoded = decodeWorkspaceTransportError(error);
        if (reportError !== false) reportWorkspaceCommandError(decoded, { operation, signal });
        throw decoded;
      });
  }

  sources<T = unknown>(options: WorkspaceOptions = {}) {
    return this.call<T>('plugins.sources', {}, options);
  }

  inspectPlugins<T = unknown>(options: WorkspaceOptions = {}) {
    // generation identifies the inspected source, not the workspace transport service.
    const { signal, requestId, ...args } = options;
    return this.call<T>('plugins.inspect', args, { signal, requestId });
  }

  watchPlugins<T = unknown>(options: WorkspaceOptions = {}) {
    const { signal, requestId, ...args } = options;
    return this.call<T>('plugins.watch', args, { signal, requestId });
  }

  capabilities(options: WorkspaceOptions = {}) {
    return this.transport.request(VIEW_WORKSPACE_SERVICES.capabilities, undefined, options);
  }

  getState(options: WorkspaceCallOptions = {}) {
    return this.call<WorkspaceState>('tabs.get', {}, options);
  }

  getSummary(options: WorkspaceCallOptions = {}) {
    return this.call<WorkspaceSummary>('summary.get', {}, options);
  }

  listPages(options: WorkspaceCallOptions = {}) {
    return this.call<WorkspacePages>('pages.list', {}, options);
  }

  revealPack(input: WorkspacePackReveal, options: WorkspaceCallOptions = {}) {
    return this.call<WorkspacePackRevealResult>('pack.reveal', input, options);
  }

  selectTab(tabId: string, options: WorkspaceCallOptions = {}) {
    return this.call<WorkspaceState>('tabs.select', { tabId }, options);
  }

  selectSceneEntity(entityId: string, { label, entityIds, tabId, targetId, targetGeneration, ...options }: WorkspaceOptions = {}) {
    return this.call<WorkspaceState>(
      'scene.select',
      {
        entityId, targetId, targetGeneration,
        ...(tabId === undefined ? {} : { tabId }),
        ...(label === undefined ? {} : { label }),
        ...(entityIds === undefined ? {} : { entityIds }),
      },
      options,
    );
  }

  clearSceneSelection({ tabId, targetId, targetGeneration, ...options }: WorkspaceOptions = {}) {
    return this.call<WorkspaceState>('scene.clear', { targetId, targetGeneration, ...(tabId === undefined ? {} : { tabId }) }, options);
  }

  openProject(root: string, { tabId, expectedTargetId, ...options }: WorkspaceOptions = {}) {
    return this.call<WorkspaceState>('project.open', { root, tabId, ...(expectedTargetId === undefined ? {} : { expectedTargetId }) }, options);
  }

  reopenProject({ root, tabId, expectedTargetId, expectedTargetState, ...options }: WorkspaceOptions = {}) {
    return this.call<WorkspaceState>(
      'project.reopen',
      {
        ...(root === undefined ? {} : { root }),
        ...(tabId === undefined ? {} : { tabId }),
        ...(expectedTargetId === undefined ? {} : { expectedTargetId }),
        ...(expectedTargetState === undefined ? {} : { expectedTargetState }),
      },
      options,
    );
  }

  closeProject(projectId: string | undefined, { tabId, ...options }: WorkspaceOptions = {}) {
    return this.call<WorkspaceState>('project.close', { projectId, tabId }, options);
  }

  listAssets(projectId: string, { tabId, targetId, targetGeneration, ...options }: WorkspaceOptions = {}) {
    return this.call<{ assets: WorkspaceAsset[] }>('assets.list', {
      projectId, tabId,
      ...(targetId === undefined ? {} : { targetId }),
      ...(targetGeneration === undefined ? {} : { targetGeneration }),
    }, options);
  }

  thumbnails(projectId: string, guids: string[], { signal }: { signal?: AbortSignal } = {}) {
    return this.call<{ thumbnails: WorkspaceThumbnail[] }>('assets.thumbnails', { projectId, guids, tabId: VIEW_WORKSPACE_TAB_ID }, { signal, reportError: false });
  }

  inspectAsset(guid: string, { projectId, tabId, targetId, targetGeneration, ...options }: WorkspaceOptions = {}) {
    return this.call<{ inspection: WorkspaceInspection }>('asset.inspect', {
      guid, tabId,
      ...(projectId === undefined ? {} : { projectId }),
      ...(targetId === undefined ? {} : { targetId }),
      ...(targetGeneration === undefined ? {} : { targetGeneration }),
    }, options);
  }

  rebuildAssetSource(guid: string, { projectId, tabId, targetId, targetGeneration, expectedRevision, requestId, ...options }: WorkspaceOptions = {}) {
    return this.call(
      'asset.source.rebuild',
      {
        guid,
        tabId,
        ...(projectId === undefined ? {} : { projectId }),
        ...(targetId === undefined ? {} : { targetId }),
        ...(targetGeneration === undefined ? {} : { targetGeneration }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ...(requestId === undefined ? {} : { requestId }),
      },
      options,
    );
  }

  coldCookAssetSource(guid: string, { projectId, tabId, targetId, targetGeneration, expectedRevision, requestId, ...options }: WorkspaceOptions = {}) {
    return this.call(
      'asset.source.cold-cook',
      {
        guid,
        tabId,
        ...(projectId === undefined ? {} : { projectId }),
        ...(targetId === undefined ? {} : { targetId }),
        ...(targetGeneration === undefined ? {} : { targetGeneration }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ...(requestId === undefined ? {} : { requestId }),
      },
      options,
    );
  }

  openAsset(guid: string, { projectId, width, height, tabId, targetId, targetGeneration, ...options }: WorkspaceOptions = {}) {
    return this.call(
      'asset.open',
      {
        guid,
        tabId,
        ...(projectId === undefined ? {} : { projectId }),
        ...(targetId === undefined ? {} : { targetId }),
        ...(targetGeneration === undefined ? {} : { targetGeneration }),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      },
      options,
    );
  }

  closePreview({ targetId, targetGeneration, tabId, ...options }: WorkspaceOptions = {}) {
    return this.call(
      'preview.close',
      { tabId, targetGeneration, ...(targetId === undefined ? {} : { targetId }) },
      options,
    );
  }

  capture(options: WorkspaceOptions = {}) {
    const { signal, generation, requestId, reportError, targetId, targetGeneration, tabId, ...args } = options;
    return this.call(
      'preview.capture',
      { tabId, targetGeneration, ...(targetId === undefined ? {} : { targetId }), ...args },
      { signal, generation, requestId, ...(reportError === undefined ? {} : { reportError }) },
    );
  }

  resizePreview({ targetId, targetGeneration, width, height, tabId, ...options }: WorkspaceOptions = {}) {
    return this.call(
      'preview.resize',
      {
        tabId,
        targetGeneration,
        ...(targetId === undefined ? {} : { targetId }),
        width,
        height,
      },
      options,
    );
  }

  getCamera({ targetId, targetGeneration, tabId, ...options }: WorkspaceOptions = {}) {
    return this.call<EngineWorkspaceCameraResult>('camera.get', { tabId, targetGeneration, ...(targetId === undefined ? {} : { targetId }) }, options);
  }

  getPreviewDisplay({ targetId, targetGeneration, tabId, ...options }: WorkspaceTargetOptions) {
    return this.call<WorkspacePreviewDisplay>('preview.display.get', { targetId, targetGeneration, tabId }, options);
  }

  setPreviewDisplay(display: WorkspacePreviewDisplayOptions, { targetId, targetGeneration, tabId, ...options }: WorkspaceTargetOptions) {
    return this.call<WorkspacePreviewDisplay>('preview.display.set', { targetId, targetGeneration, tabId, ...display }, options);
  }

  beginCamera({ targetId, targetGeneration, baseVersion, interactionId, tabId, ...options }: WorkspaceOptions = {}) {
    return this.call<EngineWorkspaceCameraResult>(
      'camera.begin',
      {
        tabId,
        targetGeneration,
        ...(targetId === undefined ? {} : { targetId }),
        baseVersion,
        ...(interactionId === undefined ? {} : { interactionId }),
      },
      options,
    );
  }

  updateCamera({ targetId, targetGeneration, interactionId, camera, input, tabId, ...options }: WorkspaceOptions = {}) {
    return this.call<EngineWorkspaceCameraResult>(
      'camera.update',
      {
        tabId,
        targetGeneration,
        targetId,
        interactionId,
        ...(camera === undefined ? {} : { camera }),
        ...(input === undefined ? {} : { input }),
      },
      options,
    );
  }

  commitCamera({ targetId, targetGeneration, interactionId, operationId, expectedVersion, camera, tabId, ...options }: WorkspaceOptions = {}) {
    return this.call<EngineWorkspaceCameraResult>(
      'camera.commit',
      { tabId, targetId, targetGeneration, interactionId, operationId, expectedVersion, camera },
      options,
    );
  }

  abortCamera({ targetId, targetGeneration, interactionId, reason, tabId, ...options }: WorkspaceOptions = {}) {
    return this.call<EngineWorkspaceCameraResult>(
      'camera.abort',
      {
        tabId,
        targetGeneration,
        targetId,
        interactionId,
        ...(reason === undefined ? {} : { reason }),
      },
      options,
    );
  }

  getSceneTree({ projectId, targetId, targetGeneration, tabId, offset, limit, revision, ...options }: WorkspaceOptions = {}) {
    return this.call<Awaited<ReturnType<EngineWorkspaceTargetTools['tree']>>>(
      'scene.tree.get',
      {
        tabId,
        ...(projectId === undefined ? {} : { projectId }),
        ...(targetId === undefined ? {} : { targetId }),
        ...(targetGeneration === undefined ? {} : { targetGeneration }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
        ...(revision === undefined ? {} : { revision }),
      },
      options,
    );
  }

  subscribe(listener: (state: WorkspaceState) => void) {
    if (typeof this.transport.subscribe !== 'function') return () => {};
    return this.transport.subscribe(VIEW_WORKSPACE_STATE_TOPIC, listener);
  }

  subscribeInspector(listener: (value: unknown) => void) {
    return this.transport.subscribe?.(VIEW_INSPECTOR_TOPIC, listener) ?? (() => {});
  }

  onDisconnect(listener: Parameters<HostTransportClient['onDisconnect']>[0]) {
    return this.transport.onDisconnect?.(listener) ?? (() => {});
  }

  close(reason?: unknown) {
    this.transport.close?.(reason);
  }
}

export function createViewWorkspaceClient(options: WorkspaceClientOptions) {
  return new ViewWorkspaceClient(options);
}
