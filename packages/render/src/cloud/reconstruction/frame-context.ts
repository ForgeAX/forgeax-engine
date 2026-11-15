import type { EnvironmentFrame } from '../../extract/environment';
import type { RenderFeatureFrameContext, RenderFeatureViewContext } from '../../features/types';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { CameraSnapshot } from '../../render-contract';
import type { ExtractedCloudLayer } from '../extract';

/** Project the stable camera/world facts consumed by the cloud feature owner. */
export function createCloudFeatureView(
  camera: CameraSnapshot | undefined,
  sourceScope: RenderResourceScope | undefined,
  width: number,
  height: number,
  deviceGeneration: number,
  cameraCut: boolean,
  recovery: boolean,
): RenderFeatureViewContext | undefined {
  if (camera === undefined) return undefined;
  const cameraWorld = sourceScope;
  return {
    identity: `${cameraWorld?.identity ?? 'camera-world'}:${camera.entityKey ?? 0}`,
    width: Math.max(1, width),
    height: Math.max(1, height),
    cameraRevision: camera.historyVersion ?? 0,
    deviceGeneration,
    cameraPosition: [camera.position[0] ?? 0, camera.position[1] ?? 0, camera.position[2] ?? 0],
    cameraCut,
    recovery,
  };
}

export function createCloudFeatureFrameContext(
  cloudLayer: ExtractedCloudLayer | undefined,
  view: RenderFeatureViewContext | undefined,
  environment?: EnvironmentFrame,
  cloudSun?: RenderFeatureFrameContext['cloudSun'],
): RenderFeatureFrameContext {
  return {
    ...(cloudLayer === undefined ? {} : { cloudLayer }),
    ...(view === undefined ? {} : { view }),
    ...(cloudSun === undefined ? {} : { cloudSun }),
    aerialPerspectiveIdentity: JSON.stringify({
      atmosphere: environment?.source.kind === 'atmosphere' ? environment.source.atmosphere : null,
      fog: environment?.fog ?? null,
    }),
  };
}
