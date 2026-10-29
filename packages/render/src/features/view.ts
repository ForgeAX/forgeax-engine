import { mat4, vec3 } from '@forgeax/engine-math';
import { computeViewProjectionMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';
import type { RenderFeatureExtractView } from './types';

/** Per-view feature identity; stereo eyes of one Camera are distinct views. */
export function renderFeatureViewIdentity(
  camera: Pick<CameraSnapshot, 'entityKey' | 'eye'> | undefined,
): string {
  const base = `camera:${camera?.entityKey ?? 0}`;
  return camera?.eye === undefined ? base : `${base}:${camera.eye.side}`;
}

/** All feature consumers use the exact extracted camera, including publication. */
export function renderFeatureCameraView(camera: CameraSnapshot): RenderFeatureExtractView {
  return {
    identity: renderFeatureViewIdentity(camera),
    render: camera.view?.enabled ?? true,
    selectedCamera: camera,
    selectedView: {
      position: new Float32Array(camera.position),
      right: vec3.create(camera.world[0] ?? 1, camera.world[1] ?? 0, camera.world[2] ?? 0),
      up: vec3.create(camera.world[4] ?? 0, camera.world[5] ?? 1, camera.world[6] ?? 0),
      viewProjection: computeViewProjectionMatrix(camera, mat4.create()),
    },
  };
}
