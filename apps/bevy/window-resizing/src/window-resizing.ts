import { type World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { type MaterialAsset } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { quat } from '@forgeax/engine-math';

export const RESOLUTIONS = {
  small: { w: 640, h: 360 },
  medium: { w: 800, h: 600 },
  large: { w: 1920, h: 1080 },
} as const;

export function buildWindowResizingWorld(world: World): void {
  // Plane — flat cube scaled to [5, 0.02, 5]
  const planeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.3, 0.5, 0.3, 1.0] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [5, 0.02, 5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [planeMat] } },
  );

  // Cube at (0, 0.5, 0)
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.8, 0.7, 0.6, 1.0] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  );

  // PointLight at (4, 8, 4)
  world.spawn(
    { component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } },
  );

  // Camera — perspective, looking from (-2, 2.5, 5) at origin
  const eye: [number, number, number] = [-2, 2.5, 5];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}

const was1Down = { value: false };
const was2Down = { value: false };
const was3Down = { value: false };

export function stepResize(
  snapshot: InputSnapshot | null,
): { w: number; h: number } | null {
  if (!snapshot) return null;
  const k1 = snapshot.keyboard.down('1');
  const k2 = snapshot.keyboard.down('2');
  const k3 = snapshot.keyboard.down('3');

  if (k1 && !was1Down.value) {
    was1Down.value = true;
    was2Down.value = false;
    was3Down.value = false;
    return RESOLUTIONS.small;
  }
  if (k2 && !was2Down.value) {
    was2Down.value = true;
    was1Down.value = false;
    was3Down.value = false;
    return RESOLUTIONS.medium;
  }
  if (k3 && !was3Down.value) {
    was3Down.value = true;
    was1Down.value = false;
    was2Down.value = false;
    return RESOLUTIONS.large;
  }

  was1Down.value = was1Down.value && k1;
  was2Down.value = was2Down.value && k2;
  was3Down.value = was3Down.value && k3;
  return null;
}
