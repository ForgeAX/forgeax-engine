import type { EngineWorkspaceTarget, EngineWorkspaceProject, EngineWorkspaceAsset, EngineWorkspaceCameraResult, EngineWorkspaceAssetBinding, EngineWorkspaceTargetTools, EngineWorkspacePreviewDisplay, EngineWorkspacePreviewDisplayOptions } from '@forgeax/engine/app';
import { createWorkspaceId } from './id.ts';
export type { PresentationSnapshot, WorkspacePresentation } from './presentation.ts';
import { serializeWorkspaceSceneSelection } from './scene-selection.ts';
/** Optional display producer projection. Consumers must discover the operation before calling. */
export type WorkspacePreviewDisplayOptions = EngineWorkspacePreviewDisplayOptions;
export type WorkspacePreviewDisplay = EngineWorkspacePreviewDisplay;

export type WorkspaceTarget = Partial<EngineWorkspaceTarget> & Pick<EngineWorkspaceTarget, 'targetId'>;
export type WorkspaceProject = EngineWorkspaceProject;
export type WorkspaceEntityInspection = Awaited<ReturnType<EngineWorkspaceTargetTools['inspect']>>;
export type WorkspaceSceneTree = Awaited<ReturnType<EngineWorkspaceTargetTools['tree']>>;
export type WorkspaceDdc = { state?: string; guid?: string; desiredKey?: string; receiptUrl?: string; hint?: string };
export type WorkspaceAsset = EngineWorkspaceAsset & {
  sourcePath?: string;
  sourceKind?: string; packageId?: string; packageUrl?: string; cookReceiptUrl?: string; lifecycle?: 'missing' | 'cooking' | 'current' | 'stale' | 'failed';
  label?: string; revision?: string; previewable?: boolean; ddc?: WorkspaceDdc;
  publicationId?: string;
};
export type WorkspaceThumbnail = { guid: string; state: 'queued' | 'cooking' | 'ready' | 'failed' | 'unsupported'; dataUrl?: string; publicationId?: string; error?: { code: string; expected: string; hint: string } };
export type WorkspaceInspection = {
  guid?: string; kind?: string; asset?: WorkspaceAsset; source?: { path?: string; kind?: string; revision?: string; publication?: EngineWorkspaceAssetBinding['publication'] };
  meta?: Record<string, unknown>; ddc?: WorkspaceDdc; revision?: string;
  publication?: EngineWorkspaceAssetBinding['publication'];
};
export type WorkspaceSceneSelection = {
  targetId?: string; targetGeneration?: number; primary: { entityId: string; label?: string };
  entityIds?: readonly string[];
};
export type WorkspaceResourceOpen = { catalogEpoch?: number; requestId?: string; pending?: WorkspaceOpenRequest; asset: WorkspaceAsset; preview?: WorkspacePreview; detailsOnly?: boolean; sequence?: number };
export type WorkspaceTab = { tabId: string; kind: string; selected: boolean; state?: string; width?: number; height?: number; target?: WorkspaceTarget | null; targetId?: string; run?: unknown };
export type WorkspaceRequest = { apiVersion: string; operation: string; clientId: string; requestId: string; args: Record<string, unknown>; token?: string };
export type WorkspacePreview = {
  target: WorkspaceTarget; asset?: WorkspaceAsset | null; assetBinding?: EngineWorkspaceAssetBinding;
  camera?: EngineWorkspaceCameraResult['camera']; cameraVersion?: number; interaction?: Pick<NonNullable<EngineWorkspaceCameraResult['interaction']>, 'interactionId'> | null;
};
export type WorkspaceOpenRequest = {
  requestId: string; sequence: number; asset: WorkspaceAsset; preview?: WorkspacePreview;
  target?: WorkspaceTarget; inspection?: WorkspaceInspection;
  detailsOnly?: boolean;
  phase?: 'opening' | 'ready' | 'failed';
  failure?: { code: string; expected: string; hint: string };
};
export type WorkspaceState = {
  apiVersion?: string; revision?: number; selectedTabId?: string | null; tabs?: readonly WorkspaceTab[];
  projectIntent?: { root: string };
  project?: WorkspaceProject | null; projectTarget?: WorkspaceTarget | null; assets?: readonly WorkspaceAsset[] | null;
  preview?: WorkspacePreview | null; previews?: readonly WorkspacePreview[]; scenePreview?: WorkspacePreview | null;
  play?: { target: WorkspaceTarget; phase?: string } | null; targetBinding?: string;
  inspection?: WorkspaceInspection | null; openRequest?: WorkspaceOpenRequest | null;
  resourceOpens?: Map<string, WorkspaceResourceOpen> | Record<string, WorkspaceResourceOpen>;
  sceneSelection?: WorkspaceSceneSelection | null; workspaceTargetLost?: boolean; projectPhase?: string; browserGeneration?: number; catalogEpoch?: number; thumbnailEpoch?: number;
};
export type WorkspaceSummary = {
  revision: number;
  project: Pick<WorkspaceProject, 'id' | 'root' | 'name'> | null;
  projectPhase: string | null;
  browserGeneration: number | null;
  targets: readonly { targetId: string; generation?: number; role: 'project' | 'play' | 'preview' }[];
  hasMoreTargets: boolean;
};
export type WorkspacePages = { pages: readonly ({ connectionId: string } & WorkspaceSummary)[]; hasMorePages: boolean };
export type WorkspacePackReveal = { projectId: string; sourcePath: string; revision: string; packageId?: string; connectionId?: string };
export type WorkspacePackRevealResult = {
  ok: boolean; code: string; requestId?: string; connectionId?: string;
  projectId?: string; sourcePath?: string; revision?: string;
  candidates?: readonly string[]; reason?: string;
};

/**
 * Public wire contract for the user workspace.  The contract is deliberately
 * transport agnostic: the CLI and the browser client both send these calls to
 * the same Engine Host service.  No command implementation lives in the
 * frontend.
 */
export const VIEW_WORKSPACE_API_VERSION = 'forgeax.view.workspace/1';

export const VIEW_WORKSPACE_SERVICES = Object.freeze({
  capabilities: 'forgeax.view.workspace.capabilities',
  call: 'forgeax.view.workspace.call',
});

/** Host service for Content Browser source preview. Not a workspace CLI operation. */
export const VIEW_FILE_GET_SERVICE = 'forgeax.view.file.get';
export const VIEW_HTML_FILES_SERVICE = 'forgeax.view.html.files';
export const VIEW_PACK_SOURCES_SERVICE = 'forgeax.view.pack.sources';
export const VIEW_PACK_REVEAL_TOPIC = 'forgeax.view.pack.reveal';
export const VIEW_PACK_REVEAL_ACK_SERVICE = 'forgeax.view.pack.reveal.ack';

export const VIEW_WORKSPACE_STATE_TOPIC = 'forgeax.view.workspace.state';

export const VIEW_PAGE_TYPES = Object.freeze({
  history: 'history',
  scene: 'scene',
  display: 'display',
  plugins: 'plugins',
  material: 'material',
  mesh: 'mesh',
  texture: 'texture',
  asset: 'asset',
  html: 'html',
});

export const VIEW_WORKSPACE_COOK_MODES = Object.freeze(['rebuild', 'cold-cook']);

/** Operation effects are the request-sharing authority; commands always retain independent execution. */
export const VIEW_WORKSPACE_CORE_OPERATION_EFFECTS = Object.freeze({
  'presentation.get': 'query',
  'presentation.page.open': 'command',
  'presentation.page.select': 'command',
  'presentation.page.close': 'command',
  'presentation.panel.reveal': 'command',
  'summary.get': 'query',
  'pages.list': 'query',
  'pack.reveal': 'command',
  'tabs.get': 'query',
  'tabs.select': 'command',
  'scene.select': 'command',
  'scene.pick': 'command',
  'scene.clear': 'command',
  'project.open': 'command',
  'project.close': 'command',
  'project.reopen': 'command',
} as const);
export const VIEW_WORKSPACE_DOMAIN_OPERATION_EFFECTS = Object.freeze({
  ...VIEW_WORKSPACE_CORE_OPERATION_EFFECTS,
  'history.list': 'query',
  'history.get': 'query',
  'history.artifact.read': 'query',
  'display.bind': 'command',
  'display.status': 'query',
  'assets.list': 'query',
  'assets.thumbnails': 'query',
  'asset.inspect': 'command',
  'asset.source.rebuild': 'command',
  'asset.source.cold-cook': 'command',
  'asset.source.draft': 'command',
  'asset.open': 'command',
  'runtime-pack.inspect': 'query',
  'runtime-pack.admit': 'command',
  'runtime-pack.generate': 'command',
  'runtime-pack.snapshot': 'command',
  'runtime-pack.restore': 'command',
  'runtime-pack.withdraw': 'command',
  'runtime-pack.plugin-install': 'command',
  'runtime-pack.plugin-inspect': 'query',
  'runtime-pack.plugin-dispose': 'command',
  'runtime-pack.prepare': 'command',
  'play.start': 'command',
  'play.ready': 'command',
  'play.stop': 'command',
  'target.control': 'command',
  'target.select': 'command',
  'target.pick': 'query',
  'entity.highlight': 'command',
  'preview.close': 'command',
  'preview.capture': 'command',
  'preview.resize': 'command',
  'preview.texture.get': 'query',
  'preview.texture.set': 'command',
  'preview.display.get': 'query',
  'preview.display.set': 'command',
  'camera.get': 'query',
  'camera.begin': 'command',
  'camera.update': 'command',
  'camera.commit': 'command',
  'camera.abort': 'command',
  'scene.tree.get': 'query',
  'entity.inspect': 'query',
  'entity.focus': 'command',
  'run.start': 'command',
  'run.status': 'query',
  'run.reload': 'command',
  'run.stop': 'command',
  'run.capture': 'command',
  'run.eval': 'command',
  'run.find': 'query',
  'run.focus': 'command',
  'run.camera.get': 'query',
  'run.camera.set': 'command',
  'run.camera.release': 'command',
} as const);
export const VIEW_WORKSPACE_OPERATION_EFFECTS = Object.freeze({
  ...VIEW_WORKSPACE_DOMAIN_OPERATION_EFFECTS,
  'plugins.sources': 'query',
  'plugins.inspect': 'query',
  'plugins.watch': 'command',
} as const);

export const VIEW_WORKSPACE_CORE_OPERATIONS = Object.freeze(Object.keys(VIEW_WORKSPACE_CORE_OPERATION_EFFECTS));
export const VIEW_WORKSPACE_DOMAIN_OPERATIONS = Object.freeze(Object.keys(VIEW_WORKSPACE_DOMAIN_OPERATION_EFFECTS));
export const VIEW_WORKSPACE_OPERATIONS = Object.freeze(Object.keys(VIEW_WORKSPACE_OPERATION_EFFECTS));

export const VIEW_DISPLAY_TAB_ID = 'forgeax-cli-display';
export const VIEW_WORKSPACE_TAB_ID = 'forgeax-user-workspace';

const OPERATION_SET = new Set(VIEW_WORKSPACE_OPERATIONS);

const OPAQUE_WORKSPACE_DIAGNOSTICS = new Set([
  'the contribution executor to return a result',
  'the producer operation to succeed',
  'the workspace command to complete',
  'Inspect the resident View workspace and retry.',
  'Inspect the provider snapshot and retry.',
  'Inspect detail and repair the owning producer before retrying.',
  'Inspect the browser page failure details.',
  'Inspect the Engine command or tool result.',
  'Refresh the inspector source and retry.',
  'the View workspace provider to complete the operation',
  'the View API provider to complete the operation',
]);

export function isOpaqueWorkspaceDiagnostic(value: unknown) {
  if (typeof value !== 'string') return true;
  const text = value.trim();
  if (text === '') return true;
  if (OPAQUE_WORKSPACE_DIAGNOSTICS.has(text)) return true;
  if (/^the browser workspace operation \S+ to complete$/.test(text)) return true;
  if (/^(?:workspace|inspector) operation \S+ to complete$/.test(text)) return true;
  if (/^Engine .+ to succeed$/.test(text)) return true;
  return false;
}

function workspaceErrorMessage(code: string, expected: string | undefined, hint: string | undefined) {
  const parts: string[] = [];
  for (const value of [expected, hint]) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text || parts.includes(text)) continue;
    parts.push(text);
  }
  const real = parts.filter((text) => !isOpaqueWorkspaceDiagnostic(text));
  const chosen = real.length > 0 ? real : parts;
  return chosen.length > 0 ? `${code}: ${chosen.join(' — ')}` : String(code ?? 'view-workspace-error');
}

export class ViewWorkspaceError extends Error {
  declare readonly code: string;
  declare readonly expected: string | undefined;
  declare readonly hint: string | undefined;
  declare readonly detail: Record<string, unknown>;
  constructor(code: string, expected: string | undefined, hint: string | undefined, detail: Record<string, unknown> = {}) {
    super(workspaceErrorMessage(code, expected, hint));
    this.name = 'ViewWorkspaceError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

export function workspaceError(code: string, expected: string | undefined, hint: string | undefined, detail: Record<string, unknown> = {}) {
  return new ViewWorkspaceError(code, expected, hint, detail);
}

export function requireWorkspaceString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw workspaceError(
      'view-workspace-invalid-args',
      `${field} to be a non-empty string`,
      `Provide a non-empty ${field}.`,
      { field },
    );
  }
  return value;
}

export function requireWorkspaceObject(value: unknown, field: string) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw workspaceError(
      'view-workspace-invalid-args',
      `${field} to be an object`,
      `Provide an object for ${field}.`,
      { field },
    );
  }
  return value as Record<string, unknown>;
}

export function requireWorkspaceInteger(value: unknown, field: string, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw workspaceError(
      'view-workspace-invalid-args',
      `${field} to be an integer >= ${min}`,
      `Provide a valid ${field}.`,
      { field, min },
    );
  }
  return value;
}

export function cloneWorkspaceValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

export function jsonUnchanged(left: unknown, right: unknown) {
  if (left === right) return true;
  if (left == null || right == null) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function omitUiTelemetry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUiTelemetry);
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'frameId' || key === 'cameraVersion' || key === 'interaction' || key === 'inputVersion') continue;
    if (key === 'camera' && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      if ('control' in nested && nested.control !== undefined) next.camera = { control: nested.control };
      continue;
    }
    next[key] = omitUiTelemetry(nested);
  }
  return next;
}

/**
 * Stable UI identity for a workspace snapshot. Omits per-frame telemetry so
 * camera orbit, submitted frame ids, play input versions, and revision bumps
 * do not rebuild panels. Nested `tabs[].target.frameId` is included in the walk.
 */
export function workspaceUiFingerprint(state: WorkspaceState | null | undefined) {
  if (!state) return '';
  const { revision: _revision, ...rest } = state;
  return JSON.stringify(omitUiTelemetry(rest));
}

export function createWorkspaceRequest(operation: string, args: Record<string, unknown> = {}, { clientId, token, requestId }: { clientId?: string; token?: string; requestId?: string } = {}) {
  if (!OPERATION_SET.has(operation)) {
    throw workspaceError(
      'view-workspace-operation-unknown',
      'operation to be present in the View workspace API',
      'Refresh the workspace API capabilities and use a supported operation.',
      { operation },
    );
  }
  const request: WorkspaceRequest = {
    apiVersion: VIEW_WORKSPACE_API_VERSION,
    operation,
    clientId: requireWorkspaceString(clientId, 'clientId'),
    requestId: requestId === undefined ? createWorkspaceId('request') : requireWorkspaceString(requestId, 'requestId'),
    args: requireWorkspaceObject(args, 'args'),
  };
  if (token !== undefined) request.token = requireWorkspaceString(token, 'token');
  return Object.freeze(request);
}

export function assertWorkspaceRequest(value: unknown) {
  const request = requireWorkspaceObject(value, 'request');
  if (request.apiVersion !== VIEW_WORKSPACE_API_VERSION) {
    throw workspaceError(
      'view-workspace-version-mismatch',
      `API version ${VIEW_WORKSPACE_API_VERSION}`,
      'Install a matching View workspace client.',
      { actual: request.apiVersion, expected: VIEW_WORKSPACE_API_VERSION },
    );
  }
  if (typeof request.operation !== 'string' || !OPERATION_SET.has(request.operation)) {
    throw workspaceError(
      'view-workspace-operation-unknown',
      'operation to be present in the View workspace API',
      'Refresh the workspace API capabilities and use a supported operation.',
      { operation: request.operation },
    );
  }
  requireWorkspaceString(request.clientId, 'clientId');
  requireWorkspaceString(request.requestId, 'requestId');
  requireWorkspaceObject(request.args, 'args');
  return request as WorkspaceRequest;
}

export function workspaceCapabilities({
  ready = true,
  headed = ready,
  reason,
  code,
  operations = VIEW_WORKSPACE_OPERATIONS,
}: { ready?: boolean; headed?: boolean; reason?: unknown; code?: unknown; operations?: readonly string[] } = {}) {
  return {
    apiVersion: VIEW_WORKSPACE_API_VERSION,
    ready: Boolean(ready),
    headed: Boolean(headed),
    operations: [...operations],
    ...(reason === undefined ? {} : { reason: String(reason) }),
    ...(code === undefined ? {} : { code: String(code) }),
  };
}

export function serializeWorkspaceTarget(target: WorkspaceTarget): WorkspaceTarget;
export function serializeWorkspaceTarget(target: null | undefined): null;
export function serializeWorkspaceTarget(target: WorkspaceTarget | null | undefined): WorkspaceTarget | null;
export function serializeWorkspaceTarget(target: WorkspaceTarget | null | undefined): WorkspaceTarget | null {
  if (!target) return null;
  requireWorkspaceString(target.targetId, 'target.targetId');
  return {
    targetId: target.targetId,
    ...(target.generation === undefined ? {} : { generation: target.generation }),
    ...(target.sessionId === undefined ? {} : { sessionId: String(target.sessionId) }),
    ...(target.worldId === undefined ? {} : { worldId: String(target.worldId) }),
    headed: target.headed === true,
    ...(target.frameId === undefined ? {} : { frameId: target.frameId }),
    ...(target.width === undefined ? {} : { width: target.width }),
    ...(target.height === undefined ? {} : { height: target.height }),
    ...(target.url === undefined ? {} : { url: String(target.url) }),
    ...(target.surface === undefined || typeof target.surface !== 'string'
      ? {}
      : { surface: target.surface }),
  };
}

export function serializeWorkspaceProject(project: WorkspaceProject | null | undefined) {
  if (!project) return null;
  requireWorkspaceString(project.id, 'project.id');
  requireWorkspaceString(project.root, 'project.root');
  return {
    id: project.id,
    root: project.root,
    ...(project.assetRoots === undefined ? {} : { assetRoots: [...project.assetRoots] }),
    ...(project.name === undefined ? {} : { name: String(project.name) }),
    ...(project.revision === undefined ? {} : { revision: String(project.revision) }),
  };
}

export function serializeWorkspaceAsset(asset: WorkspaceAsset) {
  requireWorkspaceString(asset.guid, 'asset.guid');
  requireWorkspaceString(asset.kind, 'asset.kind');
  return {
    guid: asset.guid,
    kind: asset.kind,
    ...(asset.name === undefined ? {} : { name: String(asset.name) }),
    ...(asset.sourceKey === undefined ? {} : { sourceKey: String(asset.sourceKey) }),
    ...(asset.path === undefined ? {} : { path: String(asset.path) }),
    ...(asset.sourcePath === undefined ? {} : { sourcePath: String(asset.sourcePath) }),
    ...(asset.sourceKind === undefined ? {} : { sourceKind: String(asset.sourceKind) }),
    ...(asset.packageId === undefined ? {} : { packageId: String(asset.packageId) }),
    ...(asset.lifecycle === undefined ? {} : { lifecycle: asset.lifecycle }),
    ...(asset.packageUrl === undefined ? {} : { packageUrl: String(asset.packageUrl) }),
    ...(asset.cookReceiptUrl === undefined ? {} : { cookReceiptUrl: String(asset.cookReceiptUrl) }),
    ...(asset.label === undefined ? {} : { label: String(asset.label) }),
    ...(asset.revision === undefined ? {} : { revision: String(asset.revision) }),
    ...(asset.publicationId === undefined ? {} : { publicationId: String(asset.publicationId) }),
    ...(asset.previewable === undefined ? {} : { previewable: Boolean(asset.previewable) }),
    ...(serializeWorkspaceDdc(asset.ddc) === undefined ? {} : { ddc: serializeWorkspaceDdc(asset.ddc) }),
  };
}

export function serializeWorkspaceDdc(ddc: WorkspaceDdc | null | undefined) {
  if (!ddc || typeof ddc !== 'object' || Array.isArray(ddc)) return undefined;
  const state = ddc.state === undefined ? undefined : String(ddc.state);
  return cloneWorkspaceValue({
    ...(state === undefined ? {} : { state }),
    ...(ddc.guid === undefined ? {} : { guid: String(ddc.guid) }),
    ...(ddc.desiredKey === undefined ? {} : { desiredKey: String(ddc.desiredKey) }),
    ...(ddc.receiptUrl === undefined ? {} : { receiptUrl: String(ddc.receiptUrl) }),
    ...(ddc.hint === undefined ? {} : { hint: String(ddc.hint) }),
  });
}

export function serializeWorkspaceOpenRequest(request: WorkspaceOpenRequest): WorkspaceOpenRequest;
export function serializeWorkspaceOpenRequest(request: null | undefined): null;
export function serializeWorkspaceOpenRequest(request: WorkspaceOpenRequest | null | undefined): WorkspaceOpenRequest | null;
export function serializeWorkspaceOpenRequest(request: WorkspaceOpenRequest | null | undefined): WorkspaceOpenRequest | null {
  if (!request) return null;
  requireWorkspaceString(request.requestId, 'openRequest.requestId');
  requireWorkspaceInteger(request.sequence, 'openRequest.sequence', { min: 1 });
  const asset = serializeWorkspaceAsset(request.asset);
  const previewTarget = request.preview?.target ?? request.target;
  const previewAsset = request.preview?.asset ?? (previewTarget ? asset : undefined);
  return {
    requestId: request.requestId,
    sequence: request.sequence,
    ...(request.phase ? { phase: request.phase } : {}),
    ...(request.failure ? { failure: { ...request.failure } } : {}),
    asset,
    ...(request.detailsOnly ? { detailsOnly: true } : {}),
    ...(previewTarget
      ? {
          preview: {
            asset: previewAsset ? serializeWorkspaceAsset(previewAsset) : asset,
            target: serializeWorkspaceTarget(previewTarget),
            ...(request.preview?.assetBinding ? { assetBinding: cloneWorkspaceValue(request.preview.assetBinding) } : {}),
          },
        }
      : {}),
    ...(request.inspection
      ? { inspection: serializeWorkspaceInspection(request.inspection) }
      : {}),
  };
}

export function serializeWorkspaceResourceOpens(opens: WorkspaceState['resourceOpens']) {
  if (!opens || typeof opens !== 'object') return undefined;
  const entries = opens instanceof Map ? [...opens.entries()] : Object.entries(opens);
  const serialized: Record<string, WorkspaceResourceOpen> = {};
  for (const [kind, entry] of entries) {
    if (typeof kind !== 'string' || !entry?.asset) continue;
    const asset = serializeWorkspaceAsset(entry.asset);
    const previewTarget = entry.preview?.target;
    serialized[kind] = {
      asset,
      ...(entry.catalogEpoch === undefined ? {} : { catalogEpoch: entry.catalogEpoch }),
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      ...(entry.pending ? { pending: serializeWorkspaceOpenRequest(entry.pending) } : {}),
      ...(entry.detailsOnly ? { detailsOnly: true } : {}),
      ...(entry.sequence === undefined ? {} : { sequence: entry.sequence }),
      ...(previewTarget
        ? {
            preview: {
              asset: serializeWorkspaceAsset(entry.preview?.asset ?? asset),
              target: serializeWorkspaceTarget(previewTarget),
              ...(entry.preview?.assetBinding ? { assetBinding: cloneWorkspaceValue(entry.preview.assetBinding) } : {}),
            },
          }
        : {}),
    };
  }
  return serialized;
}

export function workspaceInspectionFactRows(inspection: WorkspaceInspection | null | undefined) {
  if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) {
    return Object.freeze([]);
  }
  const asset: Partial<WorkspaceAsset> = inspection.asset && typeof inspection.asset === 'object' ? inspection.asset : {};
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    rows.push(
      Object.freeze({
        label,
        value: typeof value === 'object' ? JSON.stringify(value) : String(value),
      }),
    );
  };
  add('GUID', inspection.guid ?? asset.guid);
  add('Kind', asset.kind);
  add('Name', asset.name);
  add('Path', asset.path);
  add('Source', inspection.source?.path ?? asset.sourcePath);
  add('Revision', inspection.revision ?? asset.revision ?? inspection.source?.revision);
  add('Package', asset.packageId ?? asset.packageUrl);
  if (inspection.ddc?.state) add('DDC', inspection.ddc.state);
  const meta = inspection.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta)) add(key, value);
  }
  return Object.freeze(rows);
}

export function serializeWorkspaceInspection(inspection: WorkspaceInspection): WorkspaceInspection;
export function serializeWorkspaceInspection(inspection: null | undefined): null;
export function serializeWorkspaceInspection(inspection: WorkspaceInspection | null | undefined): WorkspaceInspection | null;
export function serializeWorkspaceInspection(inspection: WorkspaceInspection | null | undefined): WorkspaceInspection | null {
  if (!inspection) return null;
  const guid = requireWorkspaceString(inspection.guid ?? inspection.asset?.guid, 'inspection.guid');
  const asset = serializeWorkspaceAsset({
    ...inspection.asset,
    guid,
    kind: requireWorkspaceString(inspection.asset?.kind ?? inspection.kind, 'inspection.kind'),
  });
  const source = inspection.source;
  return {
    guid,
    asset,
    ...(source === undefined || source === null
      ? {}
      : {
          source: {
            ...(source.path === undefined ? {} : { path: String(source.path) }),
            ...(source.kind === undefined ? {} : { kind: String(source.kind) }),
            ...(source.revision === undefined ? {} : { revision: String(source.revision) }),
            ...(source.publication === undefined ? {} : { publication: cloneWorkspaceValue(source.publication) }),
          },
        }),
    ...(inspection.meta !== null && typeof inspection.meta === 'object' && !Array.isArray(inspection.meta)
      ? { meta: cloneWorkspaceValue(inspection.meta) }
      : {}),
    ...(serializeWorkspaceDdc(inspection.ddc) === undefined
      ? {}
      : { ddc: serializeWorkspaceDdc(inspection.ddc) }),
    ...(inspection.revision === undefined ? {} : { revision: String(inspection.revision) }),
    ...(inspection.publication === undefined ? {} : { publication: cloneWorkspaceValue(inspection.publication) }),
  };
}

export function serializeWorkspaceState(state: WorkspaceState): WorkspaceState {
  return cloneWorkspaceValue({
    apiVersion: VIEW_WORKSPACE_API_VERSION,
    revision: state.revision,
    selectedTabId: state.selectedTabId,
    tabs: state.tabs,
    project: serializeWorkspaceProject(state.project),
    ...(typeof state.projectIntent?.root === 'string' ? { projectIntent: { root: state.projectIntent.root } } : {}),
    projectTarget: serializeWorkspaceTarget(state.projectTarget),
    assets: Array.isArray(state.assets) ? state.assets.map((asset) => serializeWorkspaceAsset(asset)) : null,
    preview: state.preview
      ? {
          asset: state.preview.asset ? serializeWorkspaceAsset(state.preview.asset) : null,
          target: serializeWorkspaceTarget(state.preview.target),
          assetBinding: state.preview.assetBinding,
          camera: state.preview.camera,
          cameraVersion: state.preview.cameraVersion,
          interaction: state.preview.interaction
            ? { interactionId: state.preview.interaction.interactionId }
            : null,
        }
      : null,
    previews: (state.previews ?? []).map(preview => ({ target: serializeWorkspaceTarget(preview.target), asset: preview.asset ? serializeWorkspaceAsset(preview.asset) : null, assetBinding: preview.assetBinding })),
    scenePreview: state.scenePreview ? { target: serializeWorkspaceTarget(state.scenePreview.target), asset: state.scenePreview.asset ? serializeWorkspaceAsset(state.scenePreview.asset) : null, assetBinding: state.scenePreview.assetBinding } : null,
    play: state.play ? { target: serializeWorkspaceTarget(state.play.target), phase: state.play.phase } : null,
    targetBinding: state.targetBinding ?? 'scene',
    inspection: serializeWorkspaceInspection(state.inspection),
    openRequest: serializeWorkspaceOpenRequest(state.openRequest),
    resourceOpens: serializeWorkspaceResourceOpens(state.resourceOpens),
    sceneSelection: serializeWorkspaceSceneSelection(state.sceneSelection),
    workspaceTargetLost: state.workspaceTargetLost === true,
    ...(state.projectPhase === undefined ? {} : { projectPhase: state.projectPhase }),
    ...(state.browserGeneration === undefined ? {} : { browserGeneration: state.browserGeneration }),
    ...(state.catalogEpoch === undefined ? {} : { catalogEpoch: state.catalogEpoch }),
    ...(state.thumbnailEpoch === undefined ? {} : { thumbnailEpoch: state.thumbnailEpoch }),
  });
}
export type { TextureViewInfo, TextureViewOptions } from '@forgeax/engine/app';
