import type { RenderFeatureFrameContext, RenderFeatureViewContext } from '../features/types';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import type { ExtractedCloudLayer } from './extract';

/** Project the stable camera/world facts consumed by the cloud feature owner. */
export function createCloudFeatureView(
  camera: CameraSnapshot | undefined,
  worlds: readonly RenderResourceScope[],
  cameraOwner: number,
  width: number,
  height: number,
  deviceGeneration: number,
  cameraCut: boolean,
  recovery: boolean,
): RenderFeatureViewContext | undefined {
  if (camera === undefined) return undefined;
  const cameraWorld = worlds[camera.worldId ?? cameraOwner];
  return {
    identity: `${cameraWorld?.identity ?? 'camera-world'}:${camera.entityKey ?? 0}`,
    width: Math.max(1, width),
    height: Math.max(1, height),
    cameraRevision: camera.historyVersion ?? 0,
    deviceGeneration,
    cameraPosition: [camera.position[0] ?? 0, camera.position[1] ?? 0, camera.position[2] ?? 0],
    // Cloud coverage is a world-space projection. Keep the authored ground
    // anchor stable until a scene-bounds owner supplies a persistent anchor.
    shadowAnchor: [0, 0, 0],
    cameraCut,
    recovery,
  };
}

export function createCloudFeatureFrameContext(
  cloudLayer: ExtractedCloudLayer | undefined,
  view: RenderFeatureViewContext | undefined,
): RenderFeatureFrameContext {
  return {
    ...(cloudLayer === undefined ? {} : { cloudLayer }),
    ...(view === undefined ? {} : { view }),
  };
}
