import { World } from '@forgeax/engine-ecs';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera } from '../components/camera';
import { Outline, OutlineOcclusionValue, resolveOutline } from '../components/outline';
import { extractCameraSnapshots } from '../render-system-extract';

describe('Outline camera authoring', () => {
  it('detaches the entity set, preserves defaults, and projects only the selected camera', () => {
    const world = new World();
    const mesh = world.spawn().unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: {} },
        { component: Outline, data: { entities: [mesh, mesh] } },
      )
      .unwrap();
    propagateTransforms(world);
    const snapshot = extractCameraSnapshots(world)[0]?.outline;
    expect(snapshot?.entities).toEqual([mesh]);
    expect(snapshot?.width).toBe(2);
    expect(snapshot?.occlusion).toBe(OutlineOcclusionValue.visible);
    world.set(camera, Outline, { entities: [] }).unwrap();
    expect(extractCameraSnapshots(world)[0]?.outline).toBeUndefined();
    expect(snapshot?.entities).toEqual([mesh]);
  });
  it.each([-1, 0.5, 9, NaN, Infinity])('rejects invalid width %s', (width) => {
    const world = new World();
    const camera = world.spawn({ component: Outline, data: {} }).unwrap();
    const result = resolveOutline({ ...world.get(camera, Outline).unwrap(), width });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        code: 'outline-invalid-parameter',
        detail: { field: 'width' },
      });
  });
  it('validates policy and colors even with an empty set', () => {
    const world = new World();
    const camera = world.spawn({ component: Outline, data: { occlusion: 3 } }).unwrap();
    expect(resolveOutline(world.get(camera, Outline).unwrap()).ok).toBe(false);
    world.set(camera, Outline, { occlusion: 0, visibleColor: [-1, 0, 0] }).unwrap();
    expect(resolveOutline(world.get(camera, Outline).unwrap()).ok).toBe(false);
  });
});
