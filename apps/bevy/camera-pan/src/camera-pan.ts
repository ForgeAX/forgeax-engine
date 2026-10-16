// apps/bevy/camera-pan — shared orthographic pan/zoom scene and controller.
// Reproduces Bevy's camera/pan_camera_controller.rs through the public
// InputSnapshot: WASD/arrows pan the camera and wheel notches zoom the extents.

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { orthographic } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';

import type { MaterialAsset } from '@forgeax/engine-runtime';
import type { InputSnapshot } from '@forgeax/engine-input';

export const PAN_SPEED = 4;
export const INITIAL_HALF_HEIGHT = 3;
export const MIN_HALF_HEIGHT = 1;
export const MAX_HALF_HEIGHT = 10;
export const ZOOM_STEP = 0.2;

/** Explicit public-input slice for pan camera behavior. */
export interface CameraPanInput {
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
  readonly wheelDelta: number;
}

/** App-owned pan/zoom settings corresponding to Bevy's PanCamera controller. */
export const PanCamera = defineComponent('PanCamera', {
  speed: { type: 'f32', default: PAN_SPEED },
  minHalfHeight: { type: 'f32', default: MIN_HALF_HEIGHT },
  maxHalfHeight: { type: 'f32', default: MAX_HALF_HEIGHT },
});

function firstCamera(world: World): EntityHandle | null {
  const query = world.query({ with: [Camera, Transform, PanCamera] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

function colorMaterial(world: World, color: readonly [number, number, number, number]) {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ baseColor: color }));
}

/** Build a colorful 2D-style cube field viewed by an orthographic pan camera. */
export function buildCameraPanWorld(world: World): void {
  const colors: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.9, 0.2, 0.2, 1],
    [0.2, 0.8, 0.3, 1],
    [0.2, 0.4, 0.9, 1],
    [0.9, 0.75, 0.1, 1],
  ];
  const positions: ReadonlyArray<readonly [number, number, number]> = [
    [-2, 1, 0],
    [2, 1, 0],
    [-2, -1.5, 0],
    [2, -1.5, 0],
  ];
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i] ?? [0, 0, 0];
    const color = colors[i] ?? [1, 1, 1, 1];
    const material = colorMaterial(world, color);
    world.spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [1.4, 1.4, 0.2] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    );
  }

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.3, -0.8, -0.4], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  const halfWidth = INITIAL_HALF_HEIGHT * (16 / 9);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 8], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    {
      component: Camera,
      data: orthographic({
        left: -halfWidth,
        right: halfWidth,
        bottom: -INITIAL_HALF_HEIGHT,
        top: INITIAL_HALF_HEIGHT,
        near: 0.1,
        far: 100,
      }),
    },
    { component: PanCamera, data: { speed: PAN_SPEED, minHalfHeight: MIN_HALF_HEIGHT, maxHalfHeight: MAX_HALF_HEIGHT } },
  );
}

/** Apply keyboard pan and sign-discrete wheel zoom from one frozen input slice. */
export function stepCameraPan(world: World, dt: number, input: CameraPanInput): void {
  const handle = firstCamera(world);
  if (handle === null) return;
  const camera = world.get(handle, Camera);
  const transform = world.get(handle, Transform);
  const settings = world.get(handle, PanCamera);
  if (!camera.ok || !transform.ok || !settings.ok) return;

  const dx = Number(input.right) - Number(input.left);
  const dy = Number(input.up) - Number(input.down);
  const speed = settings.value.speed * dt;
  world.set(handle, Transform, {
    pos: [
      (transform.value.pos[0] ?? 0) + dx * speed,
      (transform.value.pos[1] ?? 0) + dy * speed,
      transform.value.pos[2] ?? 8,
    ],
  });

  const currentHalfHeight = Math.abs(camera.value.top);
  const zoom = Math.max(
    settings.value.minHalfHeight,
    Math.min(settings.value.maxHalfHeight, currentHalfHeight * (1 + input.wheelDelta * ZOOM_STEP)),
  );
  const aspect = (camera.value.right - camera.value.left) / (camera.value.top - camera.value.bottom);
  world.set(handle, Camera, {
    left: -zoom * aspect,
    right: zoom * aspect,
    bottom: -zoom,
    top: zoom,
  });
}

/** Map the public frozen snapshot onto the controller's documented bindings. */
export function cameraPanInput(snapshot: InputSnapshot): CameraPanInput {
  return {
    left: snapshot.keyboard.down('a') || snapshot.keyboard.down('ArrowLeft'),
    right: snapshot.keyboard.down('d') || snapshot.keyboard.down('ArrowRight'),
    up: snapshot.keyboard.down('w') || snapshot.keyboard.down('ArrowUp'),
    down: snapshot.keyboard.down('s') || snapshot.keyboard.down('ArrowDown'),
    wheelDelta: snapshot.mouse.wheelDelta,
  };
}

/** Current half-height of the camera frustum, used by the semantic smoke. */
export function cameraHalfHeight(world: World): number {
  const handle = firstCamera(world);
  if (handle === null) return Number.NaN;
  const camera = world.get(handle, Camera);
  return camera.ok ? Math.abs(camera.value.top) : Number.NaN;
}
