import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import {
  LIGHTING_CHANNELS_DEFAULT,
  validateLightingChannels,
} from '../components/lighting-channels';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { PointLight } from '../components/point-light';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import { packDirectLightSlot } from '../light-buffer-layout';
import { extractFrames } from '../render-system-extract-tail';

describe('surface lighting channels', () => {
  it.each([
    0,
    3,
    0xffffffff,
    ...Array.from({ length: 32 }, (_, bit) => 2 ** bit),
  ])('accepts every unsigned bit including %i', (mask) => {
    expect(validateLightingChannels(mask)).toBeNull();
  });
  it.each([
    -1,
    0.5,
    0x100000000,
    Infinity,
  ])('rejects invalid author mask %s before integer projection', (mask) => {
    expect(validateLightingChannels(mask)).toMatchObject({
      code: 'resource-invalid-value',
      detail: { receivedKey: 'lightingChannels', receivedMode: mask },
    });
    const world = new World();
    const entity = world
      .spawn({ component: MeshRenderer, data: { lightingChannels: mask } })
      .unwrap();
    expect(world.get(entity, MeshRenderer).unwrap().lightingChannels).toBe(mask);
  });
  it('rejects NaN at the existing ECS numeric write boundary', () => {
    const result = new World().spawn({ component: MeshRenderer, data: { lightingChannels: NaN } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('component-numeric-value-invalid');
    expect(validateLightingChannels(NaN)?.code).toBe('resource-invalid-value');
  });
  it('packs light channels as u32 and uses primitive padding without enlarging its row', () => {
    for (const mask of [
      0,
      0x80000001,
      LIGHTING_CHANNELS_DEFAULT,
      ...Array.from({ length: 32 }, (_, bit) => 2 ** bit),
    ]) {
      const packed = packDirectLightSlot({
        kind: 'point',
        position: [0, 0, 0],
        color: [1, 1, 1],
        intensity: 1,
        invRangeSquared: 0.01,
        lightingChannels: mask,
      } as never);
      expect(new Uint32Array(packed.buffer)[20]).toBe(mask);
    }
    expect(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'lightingChannels')).toBe(44);
    expect(GPU_SCENE_LAYOUTS.primitive.stride).toBe(64);
  });
  it('carries every u32 bit from World to light and receiver snapshots', () => {
    const world = new World();
    const receiver = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: {
            assetHandle: world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap()),
          },
        },
        { component: MeshRenderer, data: { lightingChannels: 0x80000001 } },
      )
      .unwrap();
    world.spawn({ component: PointLight, data: { lightingChannels: 0x80000000 } }).unwrap();
    // Receiver channels must not materialise the unrelated materials array.
    const read = vi.spyOn(world, 'get');
    const frame = extractFrames([world], 0, new AssetRegistry({} as never));
    expect(frame.renderables[0]?.lightingChannels).toBe(0x80000001);
    expect(frame.lights.point[0]?.lightingChannels).toBe(0x80000000);
    expect(read.mock.calls.filter(([, component]) => component === MeshRenderer)).toEqual([]);
    world.set(receiver, MeshRenderer, { lightingChannels: 0x40000000 }).unwrap();
    expect(
      extractFrames([world], 0, new AssetRegistry({} as never)).renderables[0]?.lightingChannels,
    ).toBe(0x40000000);
  });
});
