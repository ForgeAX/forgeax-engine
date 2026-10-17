import type { WorkspaceAsset, WorkspaceState } from './contract.ts';
import type { WorkspaceStateClient } from './workspace-state.ts';
import { createWorkspaceStateReader } from './workspace-state.ts';
import { selectWorkspaceFallbackSubject, selectWorkspaceResourceSubject } from './resource-open.ts';

/**
 * Live title for the scene page. The Host workspace snapshot is the SSOT:
 * when a preview/scene is bound, the tab shows that asset's name. The page
 * type's titleKey remains the idle fallback — this helper never invents a
 * static label, so the shell stays decoupled from scene vocabulary.
 *
 * @param {unknown} state
 * @returns {string | undefined}
 */
export function scenePageTitleFromWorkspace(state: WorkspaceState | null | undefined) {
  const asset = state && typeof state === 'object' ? state.preview?.asset : undefined;
  if (!asset || typeof asset !== 'object') return undefined;
  for (const candidate of [asset.name, asset.label]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

/**
 * Page controller matching forgeax-interface: `getTitle()` reads now,
 * `subscribeTitle()` fires when the workspace snapshot changes. No polling,
 * and ViewerShell does not read preview.asset itself.
 *
 * @param {unknown} client
 */
export function createScenePageTitleController(client: WorkspaceStateClient | undefined) {
  const reader = createWorkspaceStateReader(client);
  return Object.freeze({
    getResource() {
      const asset = reader.getSnapshot()?.scenePreview?.asset;
      return asset ? { asset: { guid: asset.guid, kind: asset.kind } } : undefined;
    },
    getTitle() {
      return scenePageTitleFromWorkspace(reader.getSnapshot());
    },
    subscribeTitle(listener: () => void) {
      return reader.subscribe(listener);
    },
    dispose() {
      reader.dispose();
    },
  });
}

/** Use only the opened asset's own identity for a resource tab title. */
export function resourceAssetName(asset: WorkspaceAsset | null | undefined) {
  for (const candidate of [asset?.name, asset?.label]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  if (typeof asset?.sourceKey === 'string') {
    const name = asset.sourceKey.split('/').at(-1)?.trim();
    if (name) return name;
  }
  return undefined;
}

function resourcePageSubject(state: WorkspaceState | null | undefined, kinds: readonly string[]) {
  if (kinds.length === 0 && !selectWorkspaceFallbackSubject(state)) return undefined;
  return selectWorkspaceResourceSubject(state, kinds);
}

export function resourcePageTitleFromWorkspace(state: WorkspaceState | null | undefined, kinds: readonly string[]) {
  const subject = resourcePageSubject(state, kinds);
  if (!subject?.guid) return undefined;
  const inspected = state?.openRequest?.inspection?.asset;
  const catalog = state?.assets?.find(asset => asset.guid === subject.guid && asset.kind === subject.kind);
  return resourceAssetName(subject)
    ?? (inspected?.guid === subject.guid ? resourceAssetName(inspected) : undefined)
    ?? resourceAssetName(catalog);
}

export function createResourcePageTitleController(client: WorkspaceStateClient | undefined, kinds: readonly string[]) {
  const reader = createWorkspaceStateReader(client);
  const accepted = [...kinds];
  return Object.freeze({
    getResource() {
      const asset = resourcePageSubject(reader.getSnapshot(), accepted);
      return asset?.guid ? { asset: { guid: asset.guid, kind: asset.kind } } : undefined;
    },
    getTitle() { return resourcePageTitleFromWorkspace(reader.getSnapshot(), accepted); },
    subscribeTitle(listener: () => void) { return reader.subscribe(listener); },
    dispose() { reader.dispose(); },
  });
}
