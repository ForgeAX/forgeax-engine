import { observeAssetThumbnails, type ThumbnailObservationOptions } from '@forgeax/view-workspace-core/asset-thumbnails';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { inspectorWorkspaceTarget, type InspectorEntity } from './inspection.ts';

export function inspectorThumbnailGuids(source: InspectorEntity | null) {
  if (!source) return [];
  const references = [source.meshReference, ...(source.materialOverrides ?? []),
    ...source.components.flatMap(component => component.fields.flatMap(field =>
      [...(field.resource ? [field.resource] : []), ...(field.resources ?? [])]))];
  return [...new Set(references.flatMap(reference => reference.guid && reference.asset
    && reference.status !== 'missing' ? [reference.guid] : []))].sort();
}

export function inspectorThumbnailScope(state: WorkspaceState | null, guids: readonly string[]) {
  const target = inspectorWorkspaceTarget(state);
  if (!state?.project || !target || !state.sceneSelection?.primary) return null;
  return JSON.stringify([state.project.id, state.project.root, state.projectTarget,
    target.targetId, target.generation, state.sceneSelection.primary.entityId,
    state.browserGeneration, state.catalogEpoch, guids.map(guid => {
      const asset = state.assets?.find(asset => asset.guid === guid);
      return [guid, asset?.publicationId, asset?.revision, asset?.lifecycle];
    })]);
}

/** One Inspector read lease; Engine owns generation, caching and asset identity. */
export function observeInspectorThumbnails(options: Omit<ThumbnailObservationOptions, 'getScope'>) {
  return observeAssetThumbnails({ ...options, getScope: inspectorThumbnailScope });
}
