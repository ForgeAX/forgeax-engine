import type { RenderableSnapshot } from '../render-system-extract';

/** Expanded terrain sections remain distinct draws of their one ECS entity. */
export function renderableDrawKey(
  snapshot: Pick<RenderableSnapshot, 'entityKey' | 'terrainSection'>,
): string {
  const entity = `${snapshot.entityKey}`;
  return snapshot.terrainSection === undefined
    ? entity
    : `${entity}:terrain:${snapshot.terrainSection.index}`;
}
