import type { Mat4 } from '@forgeax/engine-math';
import { computeViewProjectionMatrix } from './record/helpers';
import type { CameraSnapshot } from './render-contract';
/**
 * Capture-only snapshots keep the selected camera's geometry and clear color
 * but omit display companions, so captures restore the author configuration.
 */
export function captureOnlyCameras(
  cameras: readonly CameraSnapshot[],
  cameraEntityKey: number | undefined,
): CameraSnapshot[] {
  return cameras
    .filter((camera, index) =>
      cameraEntityKey === undefined ? index === 0 : camera.entityKey === cameraEntityKey,
    )
    .map((camera) => ({
      position: camera.position,
      world: camera.world,
      fov: camera.fov,
      aspect: camera.aspect,
      near: camera.near,
      far: camera.far,
      projection: camera.projection,
      ...(camera.projectionOffset === undefined
        ? {}
        : { projectionOffset: camera.projectionOffset }),
      orthoLeft: camera.orthoLeft,
      orthoRight: camera.orthoRight,
      orthoBottom: camera.orthoBottom,
      orthoTop: camera.orthoTop,
      tonemap: 'none' as const,
      exposure: 1,
      whitePoint: 1,
      antialias: 'none' as const,
      bloom: 'off' as const,
      bloomThreshold: 1,
      bloomIntensity: 0,
      bloomSmoothWidth: 0,
      bloomRadius: 0,
      clearColor: camera.clearColor,
      ...(camera.entityKey === undefined ? {} : { entityKey: camera.entityKey }),
    }));
}

/** The selected display camera and its view basis as seen by render features. */
export function featureCameraSelection(camera: CameraSnapshot | undefined) {
  if (camera === undefined) return {};
  const sourcePosition = camera.position;
  const count = sourcePosition.length;
  const backing = new ArrayBuffer((count + 22) * 4);
  const position = new Float32Array(backing, 0, count);
  position.set(sourcePosition);
  const right = new Float32Array(backing, count * 4, 3);
  right[0] = camera.world[0] ?? 1;
  right[1] = camera.world[1] ?? 0;
  right[2] = camera.world[2] ?? 0;
  const up = new Float32Array(backing, (count + 3) * 4, 3);
  up[0] = camera.world[4] ?? 0;
  up[1] = camera.world[5] ?? 1;
  up[2] = camera.world[6] ?? 0;
  // brand-cast-ok: this checked 16-float arena window preserves shared backing without a copy.
  const viewProjection = new Float32Array(backing, (count + 6) * 4, 16) as Mat4;
  return {
    selectedCamera: camera,
    selectedView: {
      position,
      right,
      up,
      viewProjection: computeViewProjectionMatrix(camera, viewProjection),
    },
  };
}
