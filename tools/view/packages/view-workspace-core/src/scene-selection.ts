import { type WorkspaceSceneSelection, requireWorkspaceString } from './contract.ts';

/**
 * Workspace-authoritative scene entity selection (Inspector + Hierarchy + Viewport).
 * Orthogonal to asset catalog selection and `inspection` (asset.inspect metadata).
 */
export function serializeWorkspaceSceneSelection(sceneSelection: WorkspaceSceneSelection | null | undefined) {
  if (!sceneSelection?.primary) return null;
  const entityId = requireWorkspaceString(
    sceneSelection.primary.entityId,
    'sceneSelection.primary.entityId',
  );
  return {
    ...(sceneSelection.targetId === undefined ? {} : { targetId: sceneSelection.targetId, targetGeneration: sceneSelection.targetGeneration }),
    primary: {
      entityId,
      ...(sceneSelection.primary.label === undefined
        ? {}
        : { label: String(sceneSelection.primary.label) }),
    },
    ...(sceneSelection.entityIds === undefined ? {} : { entityIds: [...sceneSelection.entityIds] }),
  };
}

export function createEmptySceneSelection() {
  return null;
}
