import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { quat, ray, vec3 } from '@forgeax/engine-math';
import { viewportToWorld } from '@forgeax/engine-picking';
import { Transform } from '@forgeax/engine-scene';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';

export interface ViewportToWorldScene {
  readonly camera: EntityHandle;
  readonly marker: EntityHandle;
}

export function buildViewportToWorldWorld(world: World): ViewportToWorldScene {
  const groundMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.24, 0.42, 0.28, 1] }),
  );
  const markerMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 0.8, 0.1, 1], roughness: 0.28 }),
  );

  world.spawn(
    { component: Transform, data: { pos: [0, -0.04, 0], scale: [16, 0.08, 16] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [groundMaterial] } },
  );

  const marker = world
    .spawn(
      { component: Transform, data: { pos: [0, 0.22, 0], scale: [0.22, 0.22, 0.22] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
      { component: MeshRenderer, data: { materials: [markerMaterial] } },
    )
    .unwrap();

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -1, -0.35], color: [1, 1, 1], intensity: 2.5 },
  });

  const eye: [number, number, number] = [0, 6, 10];
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]) },
      },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
    )
    .unwrap();

  return { camera, marker };
}

/** Place the marker at the intersection of the viewport ray and y=0. */
export function stepViewportToWorld(
  world: World,
  scene: ViewportToWorldScene,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  const worldRay = viewportToWorld(
    world,
    scene.camera,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
  );
  if (!worldRay) return false;

  const direction = ray.getDirection(vec3.create(), worldRay);
  const origin = ray.getOrigin(vec3.create(), worldRay);
  const denominator = direction[1] ?? 0;
  if (Math.abs(denominator) < 1e-6) return false;
  const distance = -(origin[1] ?? 0) / denominator;
  if (distance < 0) return false;

  const position: [number, number, number] = [
    (origin[0] ?? 0) + (direction[0] ?? 0) * distance,
    0.22,
    (origin[2] ?? 0) + (direction[2] ?? 0) * distance,
  ];
  return world.set(scene.marker, Transform, { pos: position }).ok;
}

export function cursorPositionFromInput(
  snapshot: {
    readonly mouse: {
      readonly movementDelta: { readonly x: number; readonly y: number };
      readonly position?: { readonly x: number; readonly y: number } | undefined;
    };
  },
  current: { x: number; y: number },
): { x: number; y: number } {
  const position = snapshot.mouse.position;
  if (position) {
    current.x = position.x;
    current.y = position.y;
  }
  return current;
}
