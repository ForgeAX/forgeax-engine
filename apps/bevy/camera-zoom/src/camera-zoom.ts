// apps/bevy/camera-zoom — shared scene and projection zoom controller.
// Reproduces Bevy camera/projection_zoom.rs: wheel input zooms orthographic
// extents or perspective FOV, and Space switches the active projection.

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { CAMERA_PROJECTION_ORTHOGRAPHIC, CAMERA_PROJECTION_PERSPECTIVE, orthographic, perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';

import type { MaterialAsset } from '@forgeax/engine-runtime';
import type { InputSnapshot } from '@forgeax/engine-input';
import { quat } from '@forgeax/engine-math';

export const ORTHOGRAPHIC_HALF_HEIGHT = 2.5;
export const ORTHOGRAPHIC_MIN_HALF_HEIGHT = 0.5;
export const ORTHOGRAPHIC_MAX_HALF_HEIGHT = 10;
export const ORTHOGRAPHIC_ZOOM_SPEED = 0.2;
export const PERSPECTIVE_MIN_FOV = Math.PI / 5;
export const PERSPECTIVE_MAX_FOV = Math.PI - 0.2;
export const PERSPECTIVE_ZOOM_SPEED = 0.05;

/** Explicit public-input slice for projection zoom behavior. */
export interface CameraZoomInput {
  readonly switchProjection: boolean;
  readonly wheelDelta: number;
}

/** App-owned zoom settings corresponding to Bevy's CameraSettings resource. */
export const ZoomCamera = defineComponent('ZoomCamera', {
  orthoMinHalfHeight: { type: 'f32', default: ORTHOGRAPHIC_MIN_HALF_HEIGHT },
  orthoMaxHalfHeight: { type: 'f32', default: ORTHOGRAPHIC_MAX_HALF_HEIGHT },
  orthoZoomSpeed: { type: 'f32', default: ORTHOGRAPHIC_ZOOM_SPEED },
  perspectiveMinFov: { type: 'f32', default: PERSPECTIVE_MIN_FOV },
  perspectiveMaxFov: { type: 'f32', default: PERSPECTIVE_MAX_FOV },
  perspectiveZoomSpeed: { type: 'f32', default: PERSPECTIVE_ZOOM_SPEED },
});

function firstCamera(world: World): EntityHandle | null {
  const query = world.query({ with: [Camera, Transform, ZoomCamera] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

function material(world: World, color: readonly [number, number, number, number]) {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ baseColor: color }));
}

/** Build Bevy's cube-on-plane scene with an initially orthographic camera. */
export function buildCameraZoomWorld(world: World): void {
  const plane = material(world, [0.3, 0.5, 0.3, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [5, 0.04, 5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [plane] } },
  );
  const cube = material(world, [0.8, 0.7, 0.6, 1]);
  world.spawn(
    { component: Transform, data: { pos: [1.5, 0.5, 1.5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cube] } },
  );
  world.spawn(
    { component: Transform, data: { pos: [3, 8, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 30 } },
  );

  const eye: [number, number, number] = [5, 5, 5];
  const halfWidth = ORTHOGRAPHIC_HALF_HEIGHT * (16 / 9);
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -halfWidth, right: halfWidth, bottom: -ORTHOGRAPHIC_HALF_HEIGHT, top: ORTHOGRAPHIC_HALF_HEIGHT, near: 0.1, far: 100 }) },
    {
      component: ZoomCamera,
      data: {
        orthoMinHalfHeight: ORTHOGRAPHIC_MIN_HALF_HEIGHT,
        orthoMaxHalfHeight: ORTHOGRAPHIC_MAX_HALF_HEIGHT,
        orthoZoomSpeed: ORTHOGRAPHIC_ZOOM_SPEED,
        perspectiveMinFov: PERSPECTIVE_MIN_FOV,
        perspectiveMaxFov: PERSPECTIVE_MAX_FOV,
        perspectiveZoomSpeed: PERSPECTIVE_ZOOM_SPEED,
      },
    },
  );
}

/** Apply Space projection switch and wheel zoom to the currently active projection. */
export function stepCameraZoom(world: World, input: CameraZoomInput): void {
  const handle = firstCamera(world);
  if (handle === null) return;
  const camera = world.get(handle, Camera);
  const settings = world.get(handle, ZoomCamera);
  if (!camera.ok || !settings.ok) return;

  if (input.switchProjection) {
    if (camera.value.projection === CAMERA_PROJECTION_ORTHOGRAPHIC) {
      world.set(handle, Camera, perspective({ fov: settings.value.perspectiveMinFov, aspect: 16 / 9, near: 0.1, far: 100 }));
    } else {
      const halfHeight = ORTHOGRAPHIC_HALF_HEIGHT;
      const halfWidth = halfHeight * (16 / 9);
      world.set(handle, Camera, orthographic({ left: -halfWidth, right: halfWidth, bottom: -halfHeight, top: halfHeight, near: 0.1, far: 100 }));
    }
    return;
  }

  if (camera.value.projection === CAMERA_PROJECTION_ORTHOGRAPHIC) {
    const halfHeight = Math.abs(camera.value.top);
    const nextHalfHeight = Math.max(
      settings.value.orthoMinHalfHeight,
      Math.min(settings.value.orthoMaxHalfHeight, halfHeight * (1 - input.wheelDelta * settings.value.orthoZoomSpeed)),
    );
    const aspect = (camera.value.right - camera.value.left) / (camera.value.top - camera.value.bottom);
    world.set(handle, Camera, {
      left: -nextHalfHeight * aspect,
      right: nextHalfHeight * aspect,
      bottom: -nextHalfHeight,
      top: nextHalfHeight,
    });
  } else if (camera.value.projection === CAMERA_PROJECTION_PERSPECTIVE) {
    const nextFov = Math.max(
      settings.value.perspectiveMinFov,
      Math.min(settings.value.perspectiveMaxFov, camera.value.fov - input.wheelDelta * settings.value.perspectiveZoomSpeed),
    );
    world.set(handle, Camera, { fov: nextFov });
  }
}

/** Map the frozen public snapshot to projection-zoom input. */
export function cameraZoomInput(snapshot: InputSnapshot): CameraZoomInput {
  return { switchProjection: snapshot.keyboard.up(' '), wheelDelta: snapshot.mouse.wheelDelta };
}

/** Return the current primary zoom value for the active projection. */
export function cameraZoomValue(world: World): number {
  const handle = firstCamera(world);
  if (handle === null) return Number.NaN;
  const camera = world.get(handle, Camera);
  if (!camera.ok) return Number.NaN;
  return camera.value.projection === CAMERA_PROJECTION_ORTHOGRAPHIC ? Math.abs(camera.value.top) : camera.value.fov;
}
