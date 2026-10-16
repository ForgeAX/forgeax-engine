import { World } from '@forgeax/engine-ecs';
import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { ensureFallbackCamera } from '../fallback-camera';

describe('ensureFallbackCamera', () => {
  it('installs one neutral host fallback with the requested aspect', () => {
    const world = new World();
    const spawned = ensureFallbackCamera(world, 16 / 9);
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;

    expect(world.get(spawned.value, Transform).unwrap().pos).toEqual(new Float32Array([0, 0.6, 5]));
    expect(world.get(spawned.value, Camera).unwrap().aspect).toBeCloseTo(16 / 9);
    expect([...world.query({ with: [Camera] }).unwrap()]).toHaveLength(1);
  });

  it('preserves an authored scene camera', () => {
    const world = new World();
    const authored = world.spawn(
      { component: Transform, data: { pos: [1, 2, 3] } },
      { component: Camera, data: {} },
    );
    expect(authored.ok).toBe(true);

    expect(ensureFallbackCamera(world, 16 / 9)).toBeUndefined();
    expect([...world.query({ with: [Camera] }).unwrap()]).toHaveLength(1);
  });
});
