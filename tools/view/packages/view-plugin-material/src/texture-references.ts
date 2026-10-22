import type { WorkspaceAsset, WorkspaceInspection, WorkspacePreview, WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { selectWorkspaceResourcePreview, selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';

export type MaterialTextureReferences = {
  status: 'ready' | 'unavailable';
  textures: readonly WorkspaceAsset[];
  unresolved: readonly string[];
};

/** Read only this material output's declared dependencies, never sibling outputs. */
export function materialTextureReferences(state: WorkspaceState | null, inspection?: WorkspaceInspection | null): MaterialTextureReferences {
  const subject = selectWorkspaceResourceSubject(state, ['material']);
  const preview: WorkspacePreview | undefined = selectWorkspaceResourcePreview(state, subject?.guid);
  const binding = preview?.assetBinding;
  const publication = binding ? binding.publication : inspection?.publication ?? inspection?.source?.publication;
  const outputs = publication?.outputs?.filter(output => output.guid.toLowerCase() === subject?.guid.toLowerCase() && output.kind === 'material');
  if (!subject || (!binding && inspection?.guid && inspection.guid.toLowerCase() !== subject.guid.toLowerCase()) || outputs?.length !== 1) {
    return { status: 'unavailable', textures: [], unresolved: [] };
  }
  const catalog = new Map(state?.assets?.map(asset => [asset.guid.toLowerCase(), asset]));
  const textures: WorkspaceAsset[] = [];
  const unresolved: string[] = [];
  for (const guid of new Set(outputs[0]!.refs.map(guid => guid.toLowerCase()))) {
    const asset = catalog.get(guid);
    if (!asset) unresolved.push(guid);
    else if (asset.kind === 'texture' || asset.kind === 'equirect') textures.push(asset);
  }
  return { status: 'ready', textures, unresolved };
}

export function materialReferenceScope(state: WorkspaceState | null) {
  const subject = selectWorkspaceResourceSubject(state, ['material']);
  if (!state?.project || state.workspaceTargetLost || !subject) return null;
  const preview = selectWorkspaceResourcePreview(state, subject.guid);
  const current = state.assets?.find(asset => asset.guid === subject.guid);
  return JSON.stringify([state.project.id, state.project.root, state.projectTarget, state.browserGeneration,
    subject.guid, preview?.target, preview?.assetBinding, state.catalogEpoch,
    current?.publicationId, current?.revision, current?.lifecycle]);
}

export function materialThumbnailScope(state: WorkspaceState | null, guids: readonly string[]) {
  const scope = materialReferenceScope(state);
  if (!scope) return null;
  return JSON.stringify([scope, guids.map(guid => {
    const asset = state?.assets?.find(asset => asset.guid === guid);
    return [guid, asset?.publicationId, asset?.revision, asset?.lifecycle];
  })]);
}
