import type { WorkspaceAsset, WorkspacePreview, WorkspaceState, WorkspaceOpenRequest } from './contract.ts';
import type { WorkspaceStateClient } from './workspace-state.ts';
import { createWorkspaceStateReader } from './workspace-state.ts';
import { traceView } from './view-trace.ts';

const LOG_PREFIX = '[forgeax.view.resource-open]';

/** Editor viewport hosts the scene world. Other kinds never acquire scene ownership. */
export const EDITOR_ASSET_KIND = 'scene';
export const TYPE_PREVIEW_KINDS = Object.freeze(['material', 'mesh', 'texture']);

export function summarizeResourceAsset(asset: WorkspaceAsset | null | undefined) {
  if (!asset || typeof asset !== 'object') return null;
  return {
    guid: typeof asset.guid === 'string' ? asset.guid : null,
    kind: typeof asset.kind === 'string' ? asset.kind : null,
  };
}

export function isEditorWorkspaceAsset(asset: WorkspaceAsset | null | undefined) {
  return asset?.kind === EDITOR_ASSET_KIND;
}

export function isTypePreviewAsset(asset: WorkspaceAsset | null | undefined) {
  return asset != null && TYPE_PREVIEW_KINDS.includes(asset.kind);
}

/**
 * Editor identity is the scene world, never Engine array order.
 * A pinned editor target wins even when Engine omits kind on the live preview.
 * Otherwise only an explicitly classified scene or one unclassified target can be the editor.
 */
export function selectEditorWorkspacePreview(previews: readonly WorkspacePreview[] | null | undefined, preferredTargetId?: string) {
  const list = (Array.isArray(previews) ? previews : []).filter(
    (entry) => entry?.target?.targetId != null,
  );
  if (preferredTargetId != null && preferredTargetId !== '') {
    const preferred = list.find(
      (entry) => String(entry.target.targetId) === String(preferredTargetId),
    );
    if (preferred && (!preferred.asset || isEditorWorkspaceAsset(preferred.asset))) return preferred;
  }
  const scenes = list.filter((entry) => isEditorWorkspaceAsset(entry.asset));
  if (scenes.length === 1) return scenes[0];
  const editorWorlds = list.filter((entry) => !entry.asset);
  return editorWorlds.length === 1 ? editorWorlds[0] : undefined;
}

/**
 * Viewport overlay target. Dock claim can render before editorPreview is
 * classified; only an Editor-bound preview can supply the scene world.
 */
export function selectWorkspaceEditorSurfaceTarget(state: WorkspaceState | null | undefined) {
  if (state?.editorPreview?.target) return state.editorPreview.target;
  if (state?.targetBinding === 'play') return null;
  const preview = state?.preview;
  if (preview?.target && (!preview.asset || isEditorWorkspaceAsset(preview.asset))) return preview.target;
  return null;
}

export function editorSceneTargetIds(previews: readonly WorkspacePreview[] | null | undefined, editorPreview: WorkspacePreview | null | undefined) {
  const ids = new Set<string>();
  const add = (entry: WorkspacePreview | null | undefined) => {
    if (entry?.target?.targetId == null) return;
    ids.add(String(entry.target.targetId));
  };
  add(editorPreview);
  for (const entry of Array.isArray(previews) ? previews : []) {
    if (isEditorWorkspaceAsset(entry?.asset)) add(entry);
  }
  return ids;
}

/** Console breadcrumb for the asset.open → openRequest → openPage path. */
export function logResourceOpen(event: string, data: Record<string, unknown> = {}, { level = 'info' }: { level?: 'info' | 'warn' | 'error' } = {}) {
  const logger = typeof console === 'undefined' ? undefined : console[level];
  if (typeof logger === 'function') logger(LOG_PREFIX, event, data);
  try {
    traceView('resource-open', event, data);
  } catch {
    // Trace dump is optional; console breadcrumbs still stand alone.
  }
}

function isKind(asset: WorkspaceAsset | null | undefined, kinds: readonly string[]): asset is WorkspaceAsset {
  return Boolean(asset && kinds.includes(asset.kind) && typeof asset.guid === 'string' && asset.guid !== '');
}

function extraPreviewEntries(snapshot: WorkspaceState | null | undefined) {
  const editorIds = editorSceneTargetIds(snapshot?.previews, snapshot?.editorPreview);
  return (Array.isArray(snapshot?.previews) ? snapshot.previews : []).filter((entry) => {
    if (!entry?.asset || entry.target?.targetId == null) return false;
    if (isEditorWorkspaceAsset(entry.asset)) return false;
    if (editorIds.has(String(entry.target.targetId))) return false;
    return true;
  });
}

function resourceOpenEntry(snapshot: WorkspaceState | null | undefined, kind: string) {
  const opens = snapshot?.resourceOpens;
  if (!opens || typeof opens !== 'object' || kind == null) return undefined;
  return opens instanceof Map ? opens.get(kind) : opens[kind];
}

/**
 * Each asset editor page keeps the last matching asset after later opens.
 * `openRequest` is only the most recent open, so material/mesh tabs must
 * fall back to live extras and per-kind resourceOpens.
 */
export function selectWorkspaceResourceSubject(snapshot: WorkspaceState | null | undefined, kinds: readonly string[]) {
  const accepted = Array.isArray(kinds) ? kinds : [];
  if (accepted.length === 0) {
    const asset = snapshot?.openRequest?.asset;
    return typeof asset?.guid === 'string' && asset.guid !== '' ? asset : undefined;
  }
  const extras = extraPreviewEntries(snapshot);
  const candidates = [
    snapshot?.openRequest?.asset,
    snapshot?.openRequest?.preview?.asset,
    ...accepted.flatMap((kind) => [
      resourceOpenEntry(snapshot, kind)?.asset,
      resourceOpenEntry(snapshot, kind)?.preview?.asset,
    ]),
    ...[...extras].reverse().map((entry) => entry.asset),
    snapshot?.inspection?.asset,
  ];
  return candidates.find((asset) => isKind(asset, accepted));
}

/** Live mesh preview target. Scene and other type-previews are not substitutes. */
export function selectMeshPreviewCameraTarget(snapshot: WorkspaceState | null | undefined) {
  const subject = selectWorkspaceResourceSubject(snapshot, ['mesh']);
  const preview = selectWorkspaceResourcePreview(snapshot, subject?.guid);
  return preview?.target?.targetId == null ? undefined : preview.target;
}

export function selectWorkspaceResourcePreview(snapshot: WorkspaceState | null | undefined, guid: string | undefined) {
  if (typeof guid !== 'string' || guid === '') return undefined;
  // Open requests retain the last asset for each editor page. Only Engine's
  // current preview projection proves that a target is still alive.
  const live = extraPreviewEntries(snapshot).filter(entry => entry.asset?.guid === guid);
  const request = snapshot?.openRequest?.asset?.guid === guid
    ? snapshot.openRequest
    : Object.values(snapshot?.resourceOpens ?? {}).find(entry => entry?.asset?.guid === guid);
  const requested = request?.preview?.target;
  return live.find(entry => requested && entry.target.targetId === requested.targetId
    && entry.target.generation === requested.generation) ?? live[0];
}

function openRequestSequence(request: WorkspaceOpenRequest | null | undefined) {
  return request && Number.isSafeInteger(request.sequence) ? request.sequence : 0;
}

/**
 * Observe later workspace openRequest sequences once each. The first snapshot
 * only baselines a retained sequence so a reconnect does not reopen pages.
 * Fiber owners must call the returned disposer; this helper holds no domain state.
 */
export function observeWorkspaceOpenRequests(client: WorkspaceStateClient | undefined, onOpen: (request: WorkspaceOpenRequest) => void) {
  if (typeof onOpen !== 'function') {
    throw new TypeError('observeWorkspaceOpenRequests requires onOpen');
  }
  const reader = createWorkspaceStateReader(client);
  let lastSequence = 0;
  let primed = false;
  const unsubscribe = reader.subscribe(() => {
    const snapshot = reader.getSnapshot();
    if (!snapshot) return;
    const request = snapshot.openRequest;
    const sequence = openRequestSequence(request);
    if (!primed) {
      primed = true;
      lastSequence = sequence;
      logResourceOpen('open-request-baseline', {
        requestId: request?.requestId ?? null,
        sequence: lastSequence,
        asset: summarizeResourceAsset(request?.asset),
      });
      return;
    }
    if (!request || sequence <= lastSequence) return;
    lastSequence = sequence;
    logResourceOpen('open-request-observed', {
      requestId: request.requestId,
      sequence: request.sequence,
      asset: summarizeResourceAsset(request.asset),
      hasPreview: Boolean(request.preview?.target),
      previewTargetId: request.preview?.target?.targetId ?? null,
    });
    onOpen(request);
  });
  return () => {
    unsubscribe();
    reader.dispose();
  };
}
