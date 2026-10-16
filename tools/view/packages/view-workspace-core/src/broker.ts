import type { EngineWorkspaceRuntime, EngineWorkspacePreview, EngineWorkspacePlay, EngineWorkspaceProjectHandle, EngineWorkspaceCameraResult } from '@forgeax/engine/app';
import type { ToolApi, ToolCallerIdentity } from '@forgeax/engine-tool-runtime';
import type { WorkspaceAsset, WorkspaceInspection, WorkspaceOpenRequest, WorkspaceSceneSelection, WorkspaceState, WorkspaceSummary, WorkspacePages, WorkspacePackReveal, WorkspacePreview, WorkspaceRequest, WorkspaceResourceOpen, WorkspaceTab } from './contract.ts';
import type { HostCallerIdentity, HostTransportServer } from '@forgeax/engine-host/transport';
import { workspaceDiagnosticRecord } from './command-error.ts';
import { randomUUID } from 'node:crypto';
import { runWorkspaceToolApi } from './tool-runtime.ts';
import {
  VIEW_DISPLAY_TAB_ID, VIEW_WORKSPACE_TAB_ID, VIEW_WORKSPACE_API_VERSION,
  VIEW_FILE_GET_SERVICE, VIEW_HTML_FILES_SERVICE, VIEW_PACK_SOURCES_SERVICE, VIEW_PACK_REVEAL_TOPIC, VIEW_PACK_REVEAL_ACK_SERVICE, VIEW_WORKSPACE_SERVICES, VIEW_WORKSPACE_STATE_TOPIC, VIEW_WORKSPACE_OPERATIONS,
  assertWorkspaceRequest, cloneWorkspaceValue, requireWorkspaceString,
  serializeWorkspaceState, serializeWorkspaceAsset, serializeWorkspaceInspection,
  serializeWorkspaceOpenRequest, workspaceCapabilities, workspaceError,
  workspaceUiFingerprint,
} from './contract.ts';
import { createWorkspaceId } from './id.ts';
import {
  editorSceneTargetIds,
  isEditorWorkspaceAsset,
  isTypePreviewAsset,
  logResourceOpen,
  selectEditorWorkspacePreview,
  summarizeResourceAsset,
} from './resource-open.ts';
import { readWorkspaceFilePreview, listWorkspaceHtmlFiles } from './file-preview.ts';
import {
  isWorkspaceTargetRecoveryCode,
  resolveWorkspaceFailure,
  resolveWorkspaceReopenRoot,
} from './workspace-recovery.ts';

export type WorkspaceAuthorization = (input: { clientId: string; operation: string; request: Pick<WorkspaceRequest, 'operation' | 'args' | 'clientId'> & Partial<WorkspaceRequest>; caller?: ToolCallerIdentity; signal?: AbortSignal }) => boolean | Promise<boolean>;
export type WorkspaceCallContext = { signal?: AbortSignal; caller?: ToolCallerIdentity; clientId?: string; token?: string; requestId?: string };
export type PackSourceListing = { sources: readonly { sourcePath: string; revision?: string; packageId?: string; outputs: readonly { guid: string; kind: string; sourceKey?: string }[]; diagnostic?: { code: string; hint: string } }[]; hasMore: boolean };
export type BrokerOptions = { engine?: EngineWorkspaceRuntime; projectIntent?: () => string | undefined; engineForCaller?: (caller?: ToolCallerIdentity, targetId?: string) => EngineWorkspaceRuntime | undefined; toolApi?: ToolApi; display?: (caller?: ToolCallerIdentity) => { state?: string; occupancy?: Pick<WorkspaceTab, 'run' | 'target' | 'targetId'> | null } | undefined; accessToken?: string; authorize?: WorkspaceAuthorization; packSources?: (projectRoot: string) => Promise<PackSourceListing> };
type Args = Record<string, unknown>;
type WorkspaceDomainResult = Partial<EngineWorkspaceCameraResult> & { assets?: WorkspaceAsset[]; inspection?: WorkspaceInspection; preview?: WorkspacePreview; asset?: WorkspaceAsset; target?: WorkspacePreview['target']; entityId?: string | null };

const ENGINE_SOURCE = 'engine-workspace';
const UI_OPERATIONS = Object.freeze<Record<string, (workspace: ViewWorkspaceBroker, args: Args, context: WorkspaceCallContext) => unknown>>({
  'summary.get': (workspace) => workspace.summary(),
  'pages.list': (workspace) => workspace.pages(),
  'pack.reveal': (workspace, args, context) => workspace.revealPack({
    projectId: requireWorkspaceString(args.projectId, 'projectId'),
    sourcePath: requireWorkspaceString(args.sourcePath, 'sourcePath'),
    revision: requireWorkspaceString(args.revision, 'revision'),
    ...(args.packageId === undefined ? {} : { packageId: requireWorkspaceString(args.packageId, 'packageId') }),
    ...(args.connectionId === undefined ? {} : { connectionId: requireWorkspaceString(args.connectionId, 'connectionId') }),
  }, context.signal),
  'target.select': (workspace, args) => workspace.selectTarget(args),
  'tabs.get': (workspace) => workspace.snapshot(),
  'tabs.select': (workspace, args) => workspace.selectTab(args),
  'scene.select': (workspace, args, context) => workspace.selectSceneEntity(args, context),
  'scene.pick': (workspace, args, context) => workspace.pickSceneEntity(args, context),
  'scene.clear': (workspace, args, context) => workspace.clearSceneSelection(args, context),
});
const PAGE_OPERATIONS = new Set([
  'tabs.get', 'tabs.select', 'target.select', 'scene.select', 'scene.pick', 'scene.clear',
  'asset.open', 'preview.close', 'play.start', 'play.ready', 'play.stop',
]);

/** View bindings and display snapshots. Engine owns all project and target resources. */
export class ViewWorkspaceBroker {
  declare readonly engine: EngineWorkspaceRuntime | undefined;
  declare readonly engineForCaller: BrokerOptions['engineForCaller'];
  declare readonly projectIntent: BrokerOptions['projectIntent'];
  declare readonly caller: ToolCallerIdentity | undefined;
  declare readonly toolApi: ToolApi | undefined;
  declare readonly display: NonNullable<BrokerOptions['display']>;
  declare readonly accessToken: string;
  declare readonly authorize: WorkspaceAuthorization | undefined;
  declare readonly packSources: BrokerOptions['packSources'];
  declare selectedTabId: string;
  declare targetBinding: 'editor' | 'play';
  declare editorTargetId: string | undefined;
  declare previewTargetId: string | undefined;
  declare playOwner: EngineWorkspacePlay | undefined;
  declare projectOwner: EngineWorkspaceProjectHandle | undefined;
  declare previewOwner: EngineWorkspacePreview | EngineWorkspacePlay | undefined;
  declare revision: number;
  declare listeners: Set<(state: WorkspaceState) => void>;
  declare assets: WorkspaceAsset[] | null;
  declare inspection: WorkspaceInspection | null;
  declare openRequest: WorkspaceOpenRequest | null;
  declare openRequestSequence: number;
  declare resourceOpens: Map<string, WorkspaceResourceOpen>;
  declare sceneSelection: WorkspaceSceneSelection | null;
  declare selectionAbort: AbortController | undefined;
  declare previewProjection: (WorkspacePreview & Pick<EngineWorkspacePreview, 'presentation'>) | null;
  declare workspaceTargetLost: boolean;
  declare catalogEpoch: number;
  declare thumbnailEpoch: number;
  declare disposing: boolean;
  declare publishFingerprint: string;
  declare readonly pageSessions: Map<string, { broker: ViewWorkspaceBroker; unsubscribe: () => void }>;
  declare transport?: HostTransportServer;
  declare readonly pendingReveals: Map<string, { connectionId: string; projectId: string; sourcePath: string; revision: string; settle: (value: unknown) => void }>;
  constructor({ engine, engineForCaller, projectIntent, toolApi, display = () => undefined, accessToken = randomUUID(), authorize, packSources }: BrokerOptions = {}, caller?: ToolCallerIdentity) {
    this.engine = engine;
    this.engineForCaller = engineForCaller;
    this.projectIntent = projectIntent;
    this.caller = caller;
    this.toolApi = toolApi;
    this.display = display;
    this.accessToken = accessToken;
    this.authorize = authorize;
    this.packSources = packSources;
    this.selectedTabId = VIEW_WORKSPACE_TAB_ID;
    this.targetBinding = 'editor';
    this.editorTargetId = undefined;
    this.playOwner = undefined;
    this.revision = 0;
    this.listeners = new Set<(state: WorkspaceState) => void>();
    this.assets = null;
    this.inspection = null;
    this.openRequest = null;
    this.openRequestSequence = 0;
    this.resourceOpens = new Map();
    this.sceneSelection = null;
    this.selectionAbort?.abort();
    this.previewProjection = null;
    this.projectOwner = undefined;
    this.previewOwner = undefined;
    this.workspaceTargetLost = false;
    this.catalogEpoch = -1;
    this.thumbnailEpoch = -1;
    this.disposing = false;
    this.publishFingerprint = '';
    this.pageSessions = new Map();
    this.pendingReveals = new Map();
  }

  get project() { return this.engine?.project?.project ?? null; }
  get projectTarget() { return this.engine?.project?.target ?? null; }
  get preview() { this.syncBindings(); return this.previewProjection; }

  previews() { return this.engine?.previews ?? (this.engine?.preview ? [this.engine.preview] : []); }
  classifiedPreviews() {
    return this.previews().map((preview) => ({
      target: preview.target,
      asset: this.hydrateAsset(preview.asset),
    }));
  }
  editorPreview() {
    const live = this.previews();
    const selected = selectEditorWorkspacePreview(this.classifiedPreviews(), this.editorTargetId);
    if (!selected) return undefined;
    return live.find((preview) => String(preview.target.targetId) === String(selected.target.targetId));
  }
  boundTarget() {
    if (this.targetBinding === 'play') {
      const play = this.engine?.play;
      return play?.phase === 'running' ? play : undefined;
    }
    return this.previews().find(preview => preview.target.targetId === this.previewTargetId) ?? this.editorPreview();
  }
  hydrateAsset(asset: WorkspaceAsset | null | undefined) {
    if (!asset?.guid) return asset ?? null;
    if (asset.kind) return asset;
    const catalog = Array.isArray(this.assets)
      ? this.assets.find((entry) => entry.guid === asset.guid)
      : undefined;
    if (!catalog?.kind) return asset;
    return { ...asset, kind: catalog.kind, name: asset.name ?? catalog.name };
  }
  selectTarget({ targetId }: Args = {}) {
    if (targetId === this.engine?.play?.target.targetId) this.targetBinding = 'play';
    else {
      const preview = this.previews().find((entry) => entry.target.targetId === targetId);
      if (!preview) throw workspaceError('view-workspace-target-mismatch', 'An existing preview or Play target', 'Refresh tabs.get.');
      this.targetBinding = 'editor';
      this.previewTargetId = targetId as string;
      if (isEditorWorkspaceAsset(this.hydrateAsset(preview.asset))) this.editorTargetId = String(targetId);
    }
    this.changed();
    return this.snapshot();
  }
  syncBindings() {
    if (this.playOwner !== this.engine?.play) {
      this.playOwner = this.engine?.play;
      this.targetBinding = this.playOwner ? 'play' : 'editor';
      if (!this.playOwner) this.previewTargetId = this.editorPreview()?.target.targetId;
    }
    if (this.projectOwner !== this.engine?.project) {
      this.projectOwner = this.engine?.project;
      this.assets = null;
      this.inspection = null;
      this.openRequest = null;
      this.openRequestSequence = 0;
      this.resourceOpens = new Map();
      this.editorTargetId = undefined;
      this.sceneSelection = null;
    this.selectionAbort?.abort();
    }
    if (this.previewOwner !== this.boundTarget()) {
      this.previewOwner = this.boundTarget();
      this.sceneSelection = null;
    this.selectionAbort?.abort();
      this.previewProjection = this.previewOwner ? {
        target: this.previewOwner.target, asset: this.previewOwner.asset,
        presentation: this.previewOwner.presentation,
        assetBinding: this.previewOwner.assetBinding,
      } : null;
    }
  }

  summary(): WorkspaceSummary {
    const project = this.project;
    const previews = this.previews();
    const projectTarget = this.projectTarget && this.engine?.preview?.target.targetId === this.projectTarget.targetId
      ? this.engine.preview.target : this.projectTarget;
    const active = [
      ...(projectTarget ? [{ target: projectTarget, role: 'project' as const }] : []),
      ...(this.engine?.play ? [{ target: this.engine.play.target, role: 'play' as const }] : []),
    ];
    const targets = [...active, ...previews.slice(0, Math.max(0, 16 - active.length))
      .map(preview => ({ target: preview.target, role: 'preview' as const }))];
    return {
      revision: this.revision,
      project: project ? { id: project.id, root: project.root, name: project.name } : null,
      projectPhase: this.engine?.project?.phase ?? null,
      browserGeneration: this.engine?.project?.browserGeneration ?? null,
      targets: targets.map(({ target, role }) => ({
        targetId: target.targetId, ...(target.generation === undefined ? {} : { generation: target.generation }), role,
      })),
      hasMoreTargets: active.length + previews.length > 16,
    };
  }

  pages(): WorkspacePages {
    const entries = [...this.pageSessions.entries()];
    return { pages: entries.slice(0, 16).map(([connectionId, page]) => ({ connectionId, ...page.broker.summary() })),
      hasMorePages: entries.length > 16 };
  }

  snapshot(): WorkspaceState {
    this.syncBindings();
    const display = this.display?.();
    return serializeWorkspaceState({
      revision: this.revision, selectedTabId: this.selectedTabId,
      tabs: [
        { tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', selected: this.selectedTabId === VIEW_DISPLAY_TAB_ID,
          state: display?.state, run: display?.occupancy?.run, target: display?.occupancy?.target,
          targetId: display?.occupancy?.targetId },
        { tabId: VIEW_WORKSPACE_TAB_ID, kind: 'workspace', selected: this.selectedTabId === VIEW_WORKSPACE_TAB_ID,
          state: this.previewProjection ? 'previewing' : this.project ? 'project-open' : 'empty',
          ...(this.previewProjection?.target ?? this.projectTarget ? { target: this.previewProjection?.target ?? this.projectTarget } : {}) },
      ],
      project: this.project, projectTarget: this.projectTarget,
      ...(!this.project && this.projectIntent?.() ? { projectIntent: { root: this.projectIntent()! } } : {}),
      ...(this.engine?.project?.phase === undefined ? {} : { projectPhase: this.engine.project.phase }),
      ...(this.engine?.project?.browserGeneration === undefined ? {} : { browserGeneration: this.engine.project.browserGeneration }),
      assets: this.assets,
      ...(this.catalogEpoch < 0 ? {} : { catalogEpoch: this.catalogEpoch }),
      ...(this.thumbnailEpoch < 0 ? {} : { thumbnailEpoch: this.thumbnailEpoch }),
      preview: this.previewProjection && { ...this.previewProjection, target: this.boundTarget()!.target, asset: this.hydrateAsset(this.previewProjection.asset), assetBinding: this.boundTarget()!.assetBinding },
      editorPreview: this.editorPreview() ? { target: this.editorPreview()!.target, asset: this.hydrateAsset(this.editorPreview()!.asset), assetBinding: this.editorPreview()!.assetBinding } : null,
      previews: this.previews().map(preview => ({ target: preview.target, asset: this.hydrateAsset(preview.asset), assetBinding: preview.assetBinding })),
      play: this.engine?.play ? { target: this.engine.play.target, phase: this.engine.play.phase } : null,
      targetBinding: this.targetBinding,
      inspection: this.inspection,
      openRequest: this.openRequest,
      resourceOpens: Object.fromEntries(this.resourceOpens),
      sceneSelection: this.sceneSelection,
      workspaceTargetLost: this.workspaceTargetLost,
    });
  }

  changed() {
    const current = this.snapshot();
    const fingerprint = workspaceUiFingerprint(current);
    if (fingerprint === this.publishFingerprint) return;
    this.revision += 1;
    const state = this.snapshot();
    this.publishFingerprint = workspaceUiFingerprint(state);
    for (const listener of this.listeners) { try { listener(state); } catch { /* UI observers do not own operations. */ } }
  }
  subscribe(listener: (state: WorkspaceState) => void) {
    this.listeners.add(listener);
    const state = this.snapshot();
    this.publishFingerprint ||= workspaceUiFingerprint(state);
    listener(state);
    return () => this.listeners.delete(listener);
  }
  capabilities() {
    const descriptions = this.toolApi?.list().filter(record => record.callable && (record.owner.sourceId === ENGINE_SOURCE || record.descriptor.id.startsWith('view.display.')))
      .map(record => ({ id: record.descriptor.id.replace(/^(engine|view)\./, ''), path: record.descriptor.path, title: record.descriptor.title, summary: record.descriptor.summary, inputSchema: record.descriptor.inputSchema, outputSchema: record.descriptor.outputSchema })) ?? [];
    const operations = [...Object.keys(UI_OPERATIONS), ...descriptions.map(item => item.id),
      ...VIEW_WORKSPACE_OPERATIONS.filter(id => id.startsWith('plugins.') && this.toolApi?.describe(id, 'view-backend').some(record => record.callable))]
      .filter(id => VIEW_WORKSPACE_OPERATIONS.includes(id));
    return { ...workspaceCapabilities({ ready: !!this.engine && !this.disposing, headed: this.projectTarget?.headed === true, operations }), descriptions };
  }
  async authorizeRequest(request: WorkspaceRequest, caller?: ToolCallerIdentity) {
    if (this.disposing) throw workspaceError('view-workspace-stopping', 'View bindings to remain available', 'Reconnect to the backend.');
    if (request.token !== this.accessToken || (this.authorize && !await this.authorize({ clientId: request.clientId, operation: request.operation, request, caller }))) {
      throw workspaceError('view-workspace-unauthorized', 'an authorized workspace connection', 'Connect with the issued token.', { clientId: request.clientId });
    }
  }
  async call(rawRequest: unknown, { signal, caller }: WorkspaceCallContext = {}): Promise<unknown> {
    const request = assertWorkspaceRequest(rawRequest);
    if (request.operation === 'pages.list' || request.operation === 'pack.reveal') {
      await this.authorizeRequest(request, caller);
      return UI_OPERATIONS[request.operation](this, request.args, { signal, caller, clientId: request.clientId });
    }
    const page = caller?.connectionId && this.pageSessions.get(caller.connectionId);
    if (page) return page.broker.call(rawRequest, { signal, caller });
    await this.authorizeRequest(request, caller);
    if (PAGE_OPERATIONS.has(request.operation) && this.pageSessions.size > 0) {
      if (this.pageSessions.size !== 1) throw workspaceError('view-page-ambiguous',
        'one View page for this page operation', 'Select the exact View page before retrying.');
      return this.pageSessions.values().next().value!.broker.call(request, { signal, caller });
    }
    const ui = UI_OPERATIONS[request.operation];
    if (ui) return ui(this, request.args, { signal, caller, clientId: request.clientId });
    if (request.operation === 'project.reopen') {
      return this.reopenProject(request.args, {
        signal,
        caller,
        clientId: request.clientId,
        token: request.token,
        requestId: request.requestId,
      });
    }
    return this.invoke(request.operation, request.args, { signal, caller, clientId: request.clientId, token: request.token, requestId: request.requestId });
  }
  async invoke(operation: string, args: Args = {}, { signal, caller, clientId = 'view-owner', token, requestId }: WorkspaceCallContext = {}) {
    if (operation === 'asset.open' && this.assets?.find(asset => asset.guid === args.guid)?.previewable === false) {
      const result = await this.invoke('asset.inspect', args, { signal, caller, clientId, token, requestId });
      this.recordOpenRequest({ requestId, result: result as WorkspaceDomainResult, guid: args.guid });
      this.changed();
      return this.snapshot();
    }
    caller ??= this.caller;
    const { tabId, ...input } = args;
    if (tabId !== undefined) this.assertWorkspaceTab(tabId);
    const inspector = operation.startsWith('plugins.');
    const presentation = operation.startsWith('display.');
    const id = inspector ? operation : `${presentation ? 'view' : 'engine'}.${operation}`;
    const sourceId = inspector || presentation ? 'view-backend' : ENGINE_SOURCE;
    if (this.caller && !inspector && !presentation && !operation.startsWith('run.') && input.targetId === undefined && this.projectTarget)
      input.targetId = this.projectTarget.targetId;
    const owner = this.toolApi?.describe(id, sourceId).find(record => record.callable)?.owner;
    if (!owner) throw workspaceError('view-workspace-operation-unavailable', `Engine operation ${operation} to be installed`, 'Enable the Engine capability; UI plugins do not provide domain APIs.', { operation });
    this.syncBindings();
    const play = this.engine?.play;
    if (operation === 'play.stop' && this.targetBinding === 'play' && play &&
      input.targetId === play.target.targetId && input.targetGeneration === play.target.generation) {
      // Revoke Game panel observations before Engine closes their command channel.
      // Keep the presented Play owner and its iframe until the cleanup ACK arrives.
      this.targetBinding = 'editor';
      this.previewTargetId = this.editorPreview()?.target.targetId;
      this.changed();
    }
    const requestedPreview = [...this.previews(), this.engine?.play].find(preview => preview?.target.targetId === input.targetId);
    const terminal = await this.toolApi!.run<WorkspaceDomainResult>(id, inspector ? {
      apiVersion: 'forgeax.view.inspector/1', operation, args: input, ...input, clientId, token, requestId,
    } : presentation ? input : { ...input, clientId }, { sourceId, providerId: owner.providerId, generation: owner.generation, caller, signal }).terminal;
    if (terminal.outcome === 'failed') {
      const resolved = resolveWorkspaceFailure(terminal.failure);
      const addressesWorkspace = input.targetId === undefined ||
        [this.projectTarget, this.editorPreview()?.target].some(target => target &&
          target.targetId === input.targetId &&
          (input.targetGeneration === undefined || target.generation === input.targetGeneration));
      if (isWorkspaceTargetRecoveryCode(resolved.code) && addressesWorkspace) {
        this.workspaceTargetLost = true;
      }
      // Engine can revoke a target before its asynchronous close completes and
      // publishes state. Reconcile the actual binding before returning a late
      // query failure, so observers can revoke their obsolete requests.
      this.changed();
      throw workspaceError(resolved.code, resolved.expected, resolved.hint, resolved.detail);
    }
    const result = terminal.result;
    if (Array.isArray(result?.assets)) this.assets = result.assets.map(asset => serializeWorkspaceAsset({ ...asset, ...(asset.ddc || !asset.cookReceiptUrl ? {} : { ddc: { receiptUrl: asset.cookReceiptUrl } }) }));
    if (result?.inspection) this.inspection = serializeWorkspaceInspection(result.inspection);
    if (operation === 'asset.open') this.bindOpenedAsset(result, input.guid);
    if (operation === 'preview.close' && input.targetId != null && String(input.targetId) === this.editorTargetId) {
      this.editorTargetId = undefined;
    }
    this.syncBindings();
    if (operation === 'asset.open') this.recordOpenRequest({ requestId, result, guid: input.guid });
    if ((operation.startsWith('camera.') || operation === 'target.control') && this.previewProjection && this.boundTarget() === requestedPreview) {
      this.previewProjection.camera = result?.camera;
      this.previewProjection.cameraVersion = result?.version;
      this.previewProjection.interaction = result?.interaction ?? null;
    }
    if (!['scene.tree.get', 'entity.inspect', 'workspace.get', 'preview.capture', 'assets.thumbnails'].includes(operation)) this.changed();
    if (['project.open', 'project.close', 'project.reopen', 'asset.open', 'preview.close', 'camera.abort', 'play.start', 'play.ready', 'play.stop'].includes(operation)) {
      if (operation === 'project.open' || operation === 'project.reopen') this.workspaceTargetLost = false;
      return this.snapshot();
    }
    if (operation.startsWith('camera.')) return { ...cloneWorkspaceValue(result), apiVersion: VIEW_WORKSPACE_API_VERSION, target: requestedPreview?.target };
    if (operation === 'assets.list') return { ...cloneWorkspaceValue(result), assets: this.assets };
    return cloneWorkspaceValue(result);
  }
  assertWorkspaceTab(tabId: unknown) {
    requireWorkspaceString(tabId, 'tabId');
    if (tabId !== VIEW_WORKSPACE_TAB_ID) throw workspaceError('view-workspace-tab-read-only', 'the Editor binding', 'Address AI execution through the Engine run API.', { tabId });
  }
  selectTab({ tabId }: Args = {}) {
    if (![VIEW_DISPLAY_TAB_ID, VIEW_WORKSPACE_TAB_ID].includes(tabId as string)) throw workspaceError('view-workspace-tab-not-found', 'an existing tab', 'Refresh tabs.get.', { tabId });
    this.selectedTabId = tabId as string; this.changed(); return this.snapshot();
  }
  async selectSceneEntity(args: Args = {}, context?: WorkspaceCallContext) {
    const entityId = requireWorkspaceString(args.entityId, 'entityId');
    if (args.entityIds !== undefined && !Array.isArray(args.entityIds)) throw workspaceError('view-workspace-selection-invalid', 'An entity ID array', 'Pass scene entity references.');
    const entityIds = args.entityIds === undefined ? undefined : [...new Set((args.entityIds as unknown[]).map(id => requireWorkspaceString(id, 'entityIds')))];
    if (entityIds && !entityIds.includes(entityId)) throw workspaceError('view-workspace-selection-invalid', 'A primary entity in the selection', 'Include the primary entity ID.');
    return this.changeSceneSelection(args, context, () => ({ entityId, label: args.label, ...(entityIds && entityIds.length > 1 ? { entityIds } : {}) }));
  }
  pickSceneEntity(args: Args = {}, context?: WorkspaceCallContext) {
    return this.changeSceneSelection(args, context, async requestContext => {
      const result = await this.invoke('target.pick', args, requestContext) as { entityId?: string | null };
      if (result?.entityId === null) return null;
      const entityId = requireWorkspaceString(result?.entityId, 'pick.entityId');
      return { entityId };
    });
  }
  clearSceneSelection(args: Args = {}, context?: WorkspaceCallContext) {
    return this.changeSceneSelection(args, context, () => null);
  }
  async changeSceneSelection({ tabId, targetId, targetGeneration }: Args = {}, context: WorkspaceCallContext | undefined, resolveSelection: (context: WorkspaceCallContext) => { entityId: string; label?: unknown; entityIds?: readonly string[] } | null | Promise<{ entityId: string; label?: unknown; entityIds?: readonly string[] } | null>) {
    if (tabId !== undefined) this.assertWorkspaceTab(tabId);
    this.syncBindings();
    const requested = this.boundTarget();
    if (!requested || requested.target.targetId !== targetId || requested.target.generation !== targetGeneration) throw workspaceError('view-workspace-selection-stale', 'The bound target and generation', 'Select the target before changing its selection.');
    this.selectionAbort?.abort();
    const controller = new AbortController();
    this.selectionAbort = controller;
    const signal = context?.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    const requestContext = { ...context, signal };
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.boundTarget() !== requested) throw workspaceError('view-workspace-selection-stale', 'The same selected target', 'Refresh the hierarchy.');
    };
    try {
    const selection = await resolveSelection(requestContext);
    assertCurrent();
    const { entityId, label } = selection ?? {};
    if (selection) {
      const result = await this.invoke('entity.inspect', { entityId, targetId, targetGeneration }, requestContext) as { entityId?: string };
      assertCurrent();
      if (result?.entityId !== entityId) throw workspaceError(
        'view-workspace-selection-stale', 'The inspected entity on the same target', 'Refresh the hierarchy before selecting.');
    }
    await this.invoke('entity.highlight', { ...(selection ? { entityId } : {}), targetId, targetGeneration }, requestContext);
    assertCurrent();
    this.sceneSelection = selection ? { primary: { entityId: entityId!, ...(label === undefined ? {} : { label: String(label) }) }, ...(selection.entityIds ? { entityIds: selection.entityIds } : {}), targetId: requested.target.targetId, targetGeneration: requested.target.generation } : null;
    this.changed();
    return this.snapshot();
    } catch (error) {
      if (controller.signal.aborted && this.selectionAbort !== controller && this.boundTarget() === requested)
        throw workspaceError('view-workspace-selection-superseded', 'the latest selection request', 'A newer selection replaced this request.');
      throw error;
    }
  }
  openProject(args: Args, context?: WorkspaceCallContext) { return this.invoke('project.open', args, context); }
  async reopenProject(args: Args = {}, context?: WorkspaceCallContext) {
    const root = resolveWorkspaceReopenRoot(this.snapshot(), args.root);
    const { tabId, ...rest } = args;
    return this.openProject({ ...rest, root, ...(tabId === undefined ? {} : { tabId }) }, context);
  }
  closeProject(args: Args, context?: WorkspaceCallContext) { return this.invoke('project.close', args, context); }
  listAssets(args: Args, context?: WorkspaceCallContext) { return this.invoke('assets.list', args, context); }
  inspectAsset(args: Args, context?: WorkspaceCallContext) { return this.invoke('asset.inspect', args, context); }
  rebuildAssetSource(args: Args, { mode = 'rebuild', ...context }: WorkspaceCallContext & { mode?: 'rebuild' | 'cold-cook' } = {}) { return this.invoke(`asset.source.${mode}`, args, context); }
  bindOpenedAsset(result: WorkspaceDomainResult, guid: unknown) {
    this.targetBinding = 'editor';
    const kind = this.hydrateAsset(result?.preview?.asset)?.kind
      ?? this.hydrateAsset(result?.asset)?.kind
      ?? this.assets?.find((entry) => entry?.guid === guid)?.kind;
    if (kind === 'scene') {
      const targetId = result?.preview?.target?.targetId
        ?? result?.target?.targetId
        ?? this.previews().find((entry) => this.hydrateAsset(entry.asset)?.guid === guid)?.target?.targetId;
      if (targetId != null) {
        this.editorTargetId = String(targetId);
        this.previewTargetId = this.editorTargetId;
      }
      return;
    }
    const editorId = this.editorPreview()?.target?.targetId;
    if (editorId !== undefined) this.previewTargetId = editorId;
  }
  recordOpenRequest({ requestId, result, guid }: { requestId?: string; result: WorkspaceDomainResult; guid?: unknown }) {
    const requested = typeof guid === 'string' && guid.trim() !== '' ? guid : undefined;
    const editor = this.editorPreview();
    const editorIds = editorSceneTargetIds(
      this.classifiedPreviews(),
      editor ? { target: editor.target, asset: this.hydrateAsset(editor.asset) } : undefined,
    );
    const extras = this.previews().filter((entry) =>
      entry?.target?.targetId && !editorIds.has(String(entry.target.targetId)),
    );
    const preview = [result?.preview, ...extras].find((entry) =>
      entry?.target &&
      !editorIds.has(String(entry.target.targetId)) &&
      (!entry.asset || requested === undefined || entry.asset.guid === requested),
    );
    const catalogAsset = requested && Array.isArray(this.assets)
      ? this.assets.find((entry) => entry?.guid === requested && entry?.kind)
      : undefined;
    const asset = [
      this.hydrateAsset(result?.preview?.asset),
      this.hydrateAsset(result?.asset),
      this.hydrateAsset(result?.inspection?.asset),
      this.hydrateAsset(preview?.asset),
      catalogAsset,
    ].find((candidate) =>
      candidate?.guid &&
      candidate?.kind &&
      (requested === undefined || candidate.guid === requested),
    );
    if (!asset?.guid || !asset?.kind) {
      logResourceOpen('open-request-skipped', {
        reason: 'asset-kind-unavailable',
        requested: requested ?? null,
        resultPreview: summarizeResourceAsset(result?.preview?.asset),
        resultAsset: summarizeResourceAsset(result?.asset),
        extraPreview: summarizeResourceAsset(preview?.asset),
        extraPreviewCount: extras.length,
        catalog: summarizeResourceAsset(catalogAsset),
        editorTargetId: this.editorTargetId ?? null,
      }, { level: 'warn' });
      return;
    }
    this.openRequestSequence += 1;
    const inspection =
      result?.inspection?.guid === asset.guid
        ? result.inspection
        : (this.inspection?.guid === asset.guid ? this.inspection : undefined);
    const previewMatches = preview?.target && (!preview.asset || preview.asset.guid === asset.guid);
    const recordedPreview = previewMatches ? { asset, target: preview.target } : undefined;
    this.openRequest = serializeWorkspaceOpenRequest({
      requestId: typeof requestId === 'string' && requestId.trim() !== ''
        ? requestId
        : createWorkspaceId('open'),
      sequence: this.openRequestSequence,
      asset,
      preview: recordedPreview,
      ...(inspection === undefined ? {} : { inspection }),
    });
    this.resourceOpens.set(asset.kind, {
      asset,
      preview: recordedPreview,
    });
    logResourceOpen('open-request-recorded', {
      requestId: this.openRequest.requestId,
      sequence: this.openRequest.sequence,
      asset: summarizeResourceAsset(this.openRequest.asset),
      hasPreview: Boolean(this.openRequest.preview?.target),
      previewTargetId: this.openRequest.preview?.target?.targetId ?? null,
    });
  }
  openAsset(args: Args, context?: WorkspaceCallContext) { return this.invoke('asset.open', args, context); }
  closePreview(args: Args, context?: WorkspaceCallContext) { return this.invoke('preview.close', args, context); }
  capture(args: Args, context?: WorkspaceCallContext) { return this.invoke('preview.capture', args, context); }
  resizePreview(args: Args, context?: WorkspaceCallContext) { return this.invoke('preview.resize', args, context); }
  getCamera(args: Args, context?: WorkspaceCallContext) { return this.invoke('camera.get', args, context); }
  beginCamera(args: Args, context?: WorkspaceCallContext) { return this.invoke('camera.begin', { ...args, interactionId: args.interactionId ?? randomUUID() }, context); }
  updateCamera(args: Args, context?: WorkspaceCallContext) { return this.invoke('camera.update', args, context); }
  commitCamera(args: Args, context?: WorkspaceCallContext) { return this.invoke('camera.commit', args, context); }
  abortCamera(args: Args, context?: WorkspaceCallContext) { return this.invoke('camera.abort', args, context); }
  getSceneTree(args: Args, context?: WorkspaceCallContext) { return this.invoke('scene.tree.get', args, context); }
  async revokeConnection(connectionId: unknown) {
    if (typeof connectionId !== 'string') return;
    if (!this.pageSessions.has(connectionId) && ![...this.pendingReveals.values()].some(pending => pending.connectionId === connectionId)) return;
    for (const [requestId, pending] of this.pendingReveals) {
      if (pending.connectionId !== connectionId) continue;
      this.pendingReveals.delete(requestId);
      pending.settle({ ok: false, code: 'view-page-gone', requestId });
    }
    const page = this.pageSessions.get(connectionId);
    if (page) {
      this.pageSessions.delete(connectionId);
      page.unsubscribe();
      await page.broker.dispose();
    }
    for (const preview of [this.engine?.preview, this.engine?.play]) {
    if (!preview) continue;
    // The target may already be gone together with its browser page; revoking
    // its input connection is best-effort cleanup, not a failure.
    try {
      const result = await preview.revokeConnection?.({ targetId: preview.target.targetId, connectionId }) as EngineWorkspaceCameraResult | undefined;
      this.syncBindings();
      if (this.previewOwner === preview && this.previewProjection && result) {
        this.previewProjection.interaction = result.interaction ?? null;
        this.previewProjection.cameraVersion = result.version;
      }
    } catch {
      // A lost target owns its own teardown.
    }
    }
    this.changed();
  }
  /** One accepted View frontend owns one presentation projection and event stream. */
  attachPageSession(caller: HostCallerIdentity, transport: HostTransportServer) {
    const engine = this.engineForCaller ? this.engineForCaller(caller) : this.engine;
    const projectTarget = engine?.project?.target;
    const projectCaller = projectTarget && caller.sourceId === `forgeax-workspace:${projectTarget.sessionId}:${projectTarget.targetId}`;
    if (caller.kind !== 'frontend' || (caller.sourceId !== 'view-frontend' && !projectCaller) || this.pageSessions.has(caller.connectionId)) return;
    const broker = new ViewWorkspaceBroker({
      engine, toolApi: this.toolApi, display: () => this.display(caller),
      ...(this.engineForCaller && caller.sourceId === 'view-frontend'
        ? { projectIntent: () => this.project?.root } : {}),
      accessToken: this.accessToken, authorize: this.authorize, packSources: this.packSources,
    }, caller);
    broker.snapshot();
    if (engine === this.engine) broker.assets = this.assets;
    broker.catalogEpoch = this.catalogEpoch;
    broker.thumbnailEpoch = this.thumbnailEpoch;
    const unsubscribe = broker.subscribe(state => transport.publish(VIEW_WORKSPACE_STATE_TOPIC, state, { connectionId: caller.connectionId }));
    this.pageSessions.set(caller.connectionId, { broker, unsubscribe });
  }
  publishPageSessions() {
    for (const { broker } of this.pageSessions.values()) {
      broker.snapshot();
      if (broker.engine === this.engine && this.assets !== null) broker.assets = this.assets;
      broker.changed();
    }
  }
  async revealPack(input: WorkspacePackReveal, signal?: AbortSignal) {
    const transport = this.transport;
    if (!transport) return { ok: false, code: 'view-page-unavailable' };
    if (signal?.aborted) return { ok: false, code: 'view-reveal-cancelled' };
    const candidates = [...this.pageSessions.keys()];
    if (!input.connectionId && candidates.length !== 1)
      return { ok: false, code: candidates.length ? 'view-page-ambiguous' : 'view-page-unavailable', candidates };
    const connectionId = input.connectionId ?? candidates[0];
    const page = this.pageSessions.get(connectionId);
    if (!page) return { ok: false, code: 'view-page-gone' };
    const project = page.broker.project;
    if (!project || project.id !== input.projectId) return { ok: false, code: 'view-project-stale' };
    if (!this.packSources) return { ok: false, code: 'view-pack-sources-unavailable' };
    const source = (await this.packSources(project.root)).sources.find(row => row.sourcePath === input.sourcePath);
    if (signal?.aborted) return { ok: false, code: 'view-reveal-cancelled' };
    if (!source || source.revision !== input.revision || (input.packageId && source.packageId !== input.packageId))
      return { ok: false, code: 'view-pack-stale' };
    const requestId = randomUUID();
    const intent = { requestId, connectionId, projectId: input.projectId,
      sourcePath: input.sourcePath, revision: input.revision,
      ...(source.packageId ? { packageId: source.packageId } : {}) };
    return new Promise<unknown>(resolve => {
      const retire = (code: string) => {
        this.pendingReveals.delete(requestId);
        transport.publish(VIEW_PACK_REVEAL_TOPIC, { ...intent, cancelled: true }, { connectionId });
        settle({ ok: false, code, requestId });
      };
      const cancel = () => {
        retire('view-reveal-cancelled');
      };
      const settle = (value: unknown) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        retire('view-reveal-timeout');
      }, 12000);
      timeout.unref?.();
      this.pendingReveals.set(requestId, { connectionId, projectId: input.projectId, sourcePath: input.sourcePath,
        revision: input.revision, settle });
      signal?.addEventListener('abort', cancel, { once: true });
      transport.publish(VIEW_PACK_REVEAL_TOPIC, intent, { connectionId });
    });
  }
  registerTransport(transport: HostTransportServer, { routeThroughTools = false } = {}) {
    this.transport = transport;
    const capabilities = transport.register(VIEW_WORKSPACE_SERVICES.capabilities, () => this.capabilities());
    const call = transport.register<WorkspaceRequest, unknown>(VIEW_WORKSPACE_SERVICES.call, async ({ payload, signal, caller }) => {
        try {
          // The top-level View URL connects as view-frontend. Once a project
          // opens, its full View shell lives on the exact Engine target page.
          // That caller may connect before the project handle is published,
          // so admit it on its first workspace request as well as connect.
          this.attachPageSession(caller, transport);
          return routeThroughTools
            ? await runWorkspaceToolApi(this.toolApi!, {
                operation: `view.workspace.${payload.operation}`, args: payload.args,
                clientId: payload.clientId, token: payload.token, requestId: payload.requestId,
                caller, signal, sourceId: 'view-workspace',
              })
            : await this.call(payload, { signal, caller });
        }
      catch (error) {
        const failure = workspaceDiagnosticRecord(error);
        if (typeof failure.code !== 'string' || !failure.code.startsWith('view-')) throw error;
        throw Object.assign(new Error(String(failure.message)), { name: 'HostAssemblyError', code: 'host-transport-failure',
          expected: failure.expected, hint: failure.hint, detail: { ...workspaceDiagnosticRecord(failure.detail), remoteCode: failure.code } });
      }
    });
    const fileGet = transport.register<{ path?: unknown }, unknown>(VIEW_FILE_GET_SERVICE, async ({ payload, caller }) => {
      try { return await readWorkspaceFilePreview(this.pageSessions.get(caller.connectionId)?.broker ?? this, payload); }
      catch (error) {
        const failure = workspaceDiagnosticRecord(error);
        if (typeof failure.code !== 'string' || !failure.code.startsWith('view-')) throw error;
        throw Object.assign(new Error(String(failure.message)), { name: 'HostAssemblyError', code: 'host-transport-failure',
          expected: failure.expected, hint: failure.hint, detail: { ...workspaceDiagnosticRecord(failure.detail), remoteCode: failure.code } });
      }
    });
    const htmlFiles = transport.register<{}, unknown>(VIEW_HTML_FILES_SERVICE, async ({ caller }) => listWorkspaceHtmlFiles(this.pageSessions.get(caller.connectionId)?.broker ?? this));
    const packSources = transport.register<{ projectId?: unknown }, unknown>(VIEW_PACK_SOURCES_SERVICE, async ({ payload, caller }) => {
      const project = (this.pageSessions.get(caller.connectionId)?.broker ?? this).project;
      if (!project || payload?.projectId !== project.id) throw workspaceError('view-project-stale', 'the currently open project', 'Refresh the workspace before listing Pack sources.');
      if (!this.packSources) throw workspaceError('view-pack-sources-unavailable', 'an installed Pack source provider', 'Update the View Host Pack.');
      return this.packSources(project.root);
    });
    const revealAck = transport.register<{ requestId?: unknown; shown?: unknown; projectId?: unknown; sourcePath?: unknown; revision?: unknown; reason?: unknown }, unknown>(VIEW_PACK_REVEAL_ACK_SERVICE, async ({ payload, caller }) => {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
      const pending = this.pendingReveals.get(requestId);
      if (!pending || pending.connectionId !== caller.connectionId) return { ok: false, code: 'view-reveal-stale' };
      if (pending.projectId !== payload.projectId || pending.sourcePath !== payload.sourcePath || pending.revision !== payload.revision)
        return { ok: false, code: 'view-reveal-identity-mismatch' };
      const page = this.pageSessions.get(caller.connectionId);
      const project = page?.broker.project;
      const source = project && this.packSources
        ? (await this.packSources(project.root)).sources.find(row => row.sourcePath === pending.sourcePath) : undefined;
      // A visible old card cannot confirm a changed source, project or retired page.
      if (this.pendingReveals.get(requestId) !== pending) return { ok: false, code: 'view-reveal-stale' };
      if (!project || project.id !== pending.projectId || source?.revision !== pending.revision) {
        this.pendingReveals.delete(requestId);
        pending.settle({ ok: false, code: 'view-reveal-stale', requestId });
        return { ok: false, code: 'view-reveal-stale' };
      }
      this.pendingReveals.delete(requestId);
      pending.settle({ ok: payload.shown === true, code: payload.shown === true ? 'shown' : 'view-reveal-not-shown',
        requestId, connectionId: caller.connectionId, projectId: payload.projectId,
        sourcePath: payload.sourcePath, revision: payload.revision,
        ...(typeof payload.reason === 'string' ? { reason: payload.reason.slice(0, 160) } : {}) });
      return { ok: true };
    });
    const subscription = this.subscribe(state => transport.publish(VIEW_WORKSPACE_STATE_TOPIC, state, {
      excludeConnectionIds: [...this.pageSessions.keys()],
    }));
    const removeConnect = transport.onClientConnect(caller => this.attachPageSession(caller, transport));
    const removeDisconnect = transport.onClientDisconnect(caller => { void this.revokeConnection(caller.connectionId); });
    const observer = transport.connect();
    const engineSubscription = observer.subscribe<{ catalogEpoch?: number; thumbnailEpoch?: number }>('engine.workspace.state', (snapshot) => {
      const epoch = snapshot && typeof snapshot.catalogEpoch === 'number' ? snapshot.catalogEpoch : undefined;
      const thumbnailEpoch = snapshot && typeof snapshot.thumbnailEpoch === 'number' ? snapshot.thumbnailEpoch : undefined;
      const brokers = [this, ...[...this.pageSessions.values()].map(page => page.broker)];
      if (thumbnailEpoch !== undefined && thumbnailEpoch > this.thumbnailEpoch) {
        this.thumbnailEpoch = thumbnailEpoch;
        for (const broker of brokers) broker.thumbnailEpoch = thumbnailEpoch;
      }
      if (epoch === undefined || epoch <= this.catalogEpoch) {
        this.changed();
        this.publishPageSessions();
        return;
      }
      this.catalogEpoch = epoch;
      for (const broker of brokers) {
        broker.catalogEpoch = epoch;
        const project = broker.project;
        if (!project || (broker.engine?.project?.phase !== undefined && broker.engine.project.phase !== 'running')) continue;
        const lost = broker.workspaceTargetLost;
        void broker.invoke('assets.list', { projectId: project.id }).catch(() => {
          broker.workspaceTargetLost = lost;
        }).finally(() => broker.changed());
      }
      this.publishPageSessions();
    });
    return () => { if (this.transport === transport) this.transport = undefined; capabilities(); call(); fileGet(); htmlFiles(); packSources(); revealAck(); subscription(); removeConnect(); removeDisconnect(); engineSubscription(); observer.close(); };
  }
  async dispose() {
    this.selectionAbort?.abort(); this.disposing = true; this.listeners.clear();
    for (const [requestId, pending] of this.pendingReveals) {
      this.pendingReveals.delete(requestId);
      pending.settle({ ok: false, code: 'view-page-gone', requestId });
    }
    for (const [connectionId, page] of this.pageSessions) {
      this.pageSessions.delete(connectionId);
      page.unsubscribe();
      await page.broker.dispose();
    }
  }
}
