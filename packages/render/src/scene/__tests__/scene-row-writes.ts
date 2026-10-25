import type { RenderSceneSlot } from '../render-scene-types';
import type { SceneSlots } from '../scene-slots';

export type SceneRowFixture = Omit<RenderSceneSlot, 'version' | 'slot'> & {
  readonly slot?: number;
  readonly version?: number;
};

/** Write one complete fixture row (its snapshot minus identity/pose is the row content). */
export function setSceneRow(
  slots: SceneSlots,
  slot: number,
  row: SceneRowFixture | undefined,
): RenderSceneSlot | undefined {
  if (row === undefined) {
    slots.remove(slot);
    return undefined;
  }
  if (row.slot !== undefined && row.slot !== slot)
    throw new RangeError('Scene write requires its exact non-negative slot address');
  const { worldId: _worldId, entityKey: _entityKey, transform, ...content } = row.snapshot;
  return slots.write(slot, {
    worldId: row.worldId,
    entityKey: row.entityKey,
    generation: row.generation,
    content,
    pose: transform?.world ?? new Float32Array(16),
  });
}
