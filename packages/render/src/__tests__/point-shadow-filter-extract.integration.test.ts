import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { PointLight, PointLightShadow } from '../components';
import {
  DIRECT_LIGHT_SLOT_KIND_MASK,
  DIRECT_LIGHT_SLOT_PCF_SHIFT,
  DirectLightSlotKind,
  packDirectLightSlot,
} from '../light-buffer-layout';
import { extractFrames } from '../render-system-extract-tail';

it('publishes live PointLightShadow filter changes to both shadow and lighting consumers', () => {
  const world = new World();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: PointLight, data: {} },
      { component: PointLightShadow, data: {} },
    )
    .unwrap();
  propagateTransforms(world).unwrap();
  const assets = new AssetRegistry({} as never);
  for (const pcfKernelSize of [3, 5, 1, 3]) {
    world.set(entity, PointLightShadow, { pcfKernelSize }).unwrap();
    const lights = extractFrames([world], 0, assets).lights;
    expect(lights.pointShadow?.[0]?.pcfKernelSize).toBe(pcfKernelSize);
    const point = lights.point[0];
    if (point === undefined) throw new Error('PointLight extraction missing');
    expect(point.pcfKernelSize).toBe(pcfKernelSize);
    const metadata = new Uint32Array(packDirectLightSlot(point).buffer)[16] ?? 0;
    expect(metadata & DIRECT_LIGHT_SLOT_KIND_MASK).toBe(DirectLightSlotKind.POINT);
    expect(metadata >>> DIRECT_LIGHT_SLOT_PCF_SHIFT).toBe(pcfKernelSize);
  }
});
