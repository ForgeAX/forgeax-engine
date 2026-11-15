import type { ExtractedCloudLayer } from '../extract';
import { viewCloudShadowProjection } from './shadow';

/** Derive the selected camera's shadow inputs without mutating its captured source layer. */
export function prepareCloudShadowView(
  layer: ExtractedCloudLayer | undefined,
  cameraPosition: ArrayLike<number>,
): ExtractedCloudLayer | undefined {
  if (layer?.shadowSettings === undefined) return layer;
  return { ...layer, shadowMap: viewCloudShadowProjection(layer.shadowSettings, cameraPosition) };
}
