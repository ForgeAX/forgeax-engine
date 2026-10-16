import { World } from '@forgeax/engine-ecs';
import { ChildOf } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { resolveVisibility } from '../extract/visibility';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import { RenderScene } from '../scene/render-scene';

const sceneMaterial = {} as MaterialSnapshot;

function sceneSnapshot(worldId: number, entityKey: number, x: number): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = x;
  return {
    assetHandle: 1,
    transform: { world },
    material: sceneMaterial,
    materials: [sceneMaterial],
    materialBindingSources: ['engine-default'],
    worldId,
    entityKey,
  };
}

describe('visibility World isolation', () => {
  it('does not share intent or effective results for equal entity handles', () => {
    const hiddenWorld = new World();
    const visibleWorld = new World();
    const hidden = hiddenWorld
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } })
      .unwrap();
    const visible = visibleWorld
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.visible } })
      .unwrap();

    expect(hidden).toBe(visible);
    expect(resolveVisibility(hiddenWorld).get(hidden)?.effective).toBe('hidden');
    expect(resolveVisibility(visibleWorld).get(visible)?.effective).toBe('visible');
  });

  it('keeps hierarchy parent lookup and snapshots local to each World', () => {
    const first = new World();
    const second = new World();
    const firstParent = first
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } })
      .unwrap();
    const secondParent = second
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.visible } })
      .unwrap();
    const firstChild = first
      .spawn(
        { component: Visibility, data: { state: VisibilityStateValue.inherited } },
        { component: ChildOf, data: { parent: firstParent } },
      )
      .unwrap();
    const secondChild = second
      .spawn(
        { component: Visibility, data: { state: VisibilityStateValue.inherited } },
        { component: ChildOf, data: { parent: secondParent } },
      )
      .unwrap();
    const frame = extractFrames([first, second], 0);

    expect(frame.visibilitySnapshots).toHaveLength(2);
    expect(frame.visibilitySnapshots[0]?.get(firstChild)?.effective).toBe('hidden');
    expect(frame.visibilitySnapshots[1]?.get(secondChild)?.effective).toBe('visible');
  });

  it('keeps equal entity keys isolated when multi-world scene order changes', () => {
    const scene = new RenderScene();
    scene.reset([sceneSnapshot(0, 3, 1), sceneSnapshot(1, 3, 2)]);
    const first = scene.slot(0, 3);
    const second = scene.slot(1, 3);

    scene.reset([sceneSnapshot(1, 3, 2), sceneSnapshot(0, 3, 1)]);

    expect(scene.slot(0, 3)).toMatchObject({ slot: first?.slot, generation: first?.generation });
    expect(scene.slot(1, 3)).toMatchObject({ slot: second?.slot, generation: second?.generation });
    expect(scene.materialize().map((entry) => entry.worldId)).toEqual([1, 0]);
  });
});
