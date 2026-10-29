import type { AssetReference } from '@forgeax/view-workspace-core/asset-references';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceEntityInspection, WorkspacePreview, WorkspaceSceneTree, WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { selectWorkspaceResourcePreview, selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';

export type MeshMaterialSlot = Extract<NonNullable<NonNullable<WorkspacePreview['assetBinding']>['meta']>, { kind: 'mesh' }>['materialSlots'][number];
export type MeshMaterialReferences = { references: readonly AssetReference[]; truncated: boolean };

export function meshMaterialScope(state: WorkspaceState | null) {
  const subject = selectWorkspaceResourceSubject(state, ['mesh']);
  const preview = selectWorkspaceResourcePreview(state, subject?.guid);
  if (!state?.project || state.workspaceTargetLost || !preview?.assetBinding || preview.target.generation === undefined) return null;
  return JSON.stringify([state.project.id, state.project.root, state.projectTarget, state.browserGeneration,
    subject?.guid, preview.target.targetId, preview.target.generation, preview.target.worldId,
    preview.assetBinding, state.catalogEpoch]);
}

export function meshThumbnailScope(state: WorkspaceState | null, guids: readonly string[]) {
  const scope = meshMaterialScope(state);
  if (!scope) return null;
  return JSON.stringify([scope, guids.map(guid => {
    const asset = state?.assets?.find(asset => asset.guid === guid);
    return [guid, asset?.publicationId, asset?.revision, asset?.lifecycle];
  })]);
}

/** Discover the exact asset entity through public facts, excluding display helpers. */
export async function readMeshMaterialReferences(client: Pick<ViewWorkspaceClient, 'call'>, state: WorkspaceState, signal: AbortSignal): Promise<MeshMaterialReferences> {
  const subject = selectWorkspaceResourceSubject(state, ['mesh']);
  const preview = selectWorkspaceResourcePreview(state, subject?.guid);
  if (!subject || !preview || !meshMaterialScope(state)) throw new Error('mesh-material-target-unavailable');
  const args = { projectId: state.project!.id, targetId: preview.target.targetId, targetGeneration: preview.target.generation };
  let offset = 0;
  let revision: number | undefined;
  let matching: WorkspaceEntityInspection | undefined;
  do {
    signal.throwIfAborted();
    const tree = await client.call<WorkspaceSceneTree>('scene.tree.get', { ...args, offset, limit: 50, ...(revision === undefined ? {} : { revision }) }, { signal, reportError: false });
    signal.throwIfAborted();
    if (tree.targetId !== args.targetId || (preview.target.worldId && tree.worldId !== preview.target.worldId)
      || (revision !== undefined && tree.revision !== revision)) throw new Error('mesh-material-target-stale');
    revision = tree.revision;
    for (const node of tree.nodes.filter(node => node.componentNames.includes('MeshFilter') && node.componentNames.includes('MeshRenderer'))) {
      const inspection = await client.call<WorkspaceEntityInspection>('entity.inspect', { ...args, entityId: node.entityId }, { signal, reportError: false });
      signal.throwIfAborted();
      if (inspection.entityId !== node.entityId || inspection.targetId !== args.targetId || inspection.worldId !== tree.worldId)
        throw new Error('mesh-material-target-stale');
      const references = inspection.assetReferences?.references ?? [];
      if (!references.some(reference => reference.component === 'MeshFilter' && reference.field === 'assetHandle'
        && reference.kind === 'mesh' && reference.status === 'resolved' && reference.guid === subject.guid)) continue;
      if (matching) throw new Error('mesh-material-entity-ambiguous');
      matching = inspection;
    }
    if (tree.nextOffset === null) break;
    if (tree.nextOffset <= offset) throw new Error('mesh-material-tree-invalid');
    offset = tree.nextOffset;
  } while (true);
  if (!matching?.assetReferences) throw new Error('mesh-material-references-unavailable');
  const facts = preview.assetBinding?.meta;
  const slots = facts?.kind === 'mesh' ? facts.materialSlots : [];
  return {
    references: matching.assetReferences.references.filter(reference => reference.component === 'MeshRenderer'
      && reference.field === 'materials' && reference.kind === 'material' && reference.index !== undefined
      && reference.index >= 0 && reference.index < slots.length
      && (typeof slots[reference.index]?.defaultMaterial !== 'number' || reference.handle === slots[reference.index]?.defaultMaterial)),
    truncated: matching.assetReferences.truncated,
  };
}
