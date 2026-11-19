import { World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../components/camera';
import { collectCameraSnapshots } from '../cameras';
import { EnvironmentFrameGate } from '../environment-frame-gate';

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
    const reader = new EnvironmentFrameGate();
    reader.assetsChanged = false;
    const first = collectCameraSnapshots(world, reader);
    expect(first).toHaveLength(1);
    expect(collectCameraSnapshots(world, reader)).toBe(first);
    const independent = new EnvironmentFrameGate();
    independent.assetsChanged = false;
    const other = collectCameraSnapshots(world, independent);
    expect(other).toEqual(first);
    expect(other).not.toBe(first);
    expect(other[0]).not.toBe(first[0]);
    world.set(camera, Camera, { fov: 0.5 }).unwrap();
    const second = collectCameraSnapshots(world, reader);
    expect(second).not.toBe(first);
    expect(second[0]?.fov).toBeCloseTo(0.5);
    expect(first[0]?.fov).toBeCloseTo(1);
  });
});
