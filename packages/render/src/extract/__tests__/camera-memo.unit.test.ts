import { World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../components/camera';
import { collectCameraSnapshots } from '../cameras';

describe('collectCameraSnapshots reuse', () => {
  it('returns the same list until the World changes', () => {
    const world = new World();
    const camera = world
      .spawn(
        { component: Camera, data: { fov: 1 } },
        { component: Transform, data: {} },
        { component: GlobalTransform, data: {} },
      )
      .unwrap();
    const first = collectCameraSnapshots(world);
    expect(first).toHaveLength(1);
    expect(collectCameraSnapshots(world)).toBe(first);
    world.set(camera, Camera, { fov: 0.5 }).unwrap();
    const second = collectCameraSnapshots(world);
    expect(second).not.toBe(first);
    expect(second[0]?.fov).toBeCloseTo(0.5);
    expect(first[0]?.fov).toBeCloseTo(1);
  });
});
