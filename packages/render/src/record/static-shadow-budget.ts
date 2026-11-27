import { SHADOW_ATLAS_DEFAULT_FACE_SIZE } from '../shadow-atlas';
import { MIN_SHADOW_ARRAY_LAYERS, type ShadowDepthLayers } from '../shadow-depth-layers';
import {
  DEFAULT_STATIC_SHADOW_BUDGET_BYTES,
  type StaticShadowLayout,
} from '../static-shadow-memory';
import type { ViewLights } from '../world/render-lights';

const singleLayer: Readonly<StaticShadowLayout> = { directional: false, pointMask: 0, spotMask: 0 };

export function staticShadowAdmission(
  lights: ViewLights,
  directionalSize: number | undefined,
  spotSize: number,
  budget = DEFAULT_STATIC_SHADOW_BUDGET_BYTES,
  owner?: ShadowDepthLayers,
): Readonly<StaticShadowLayout> {
  const cascades = lights.cascades?.cascadeCount ?? 0;
  const directionalRequested =
    lights.directionalCsmConfig?.staticShadowCache === true && cascades > 0;
  let points = 0;
  for (const light of lights.pointShadow)
    if (light.staticShadowCache && light.shadowAtlasLayer >= 0)
      points |= 1 << light.shadowAtlasLayer;
  let spots = 0;
  for (const light of lights.spot)
    if (light.staticShadowCache && light.shadowAtlasTile >= 0 && light.lightViewProj !== undefined)
      spots |= 1 << light.shadowAtlasTile;

  if (!directionalRequested && points === 0 && spots === 0 && owner?.staticPlan === undefined)
    return singleLayer;
  const layout = owner?.beginStaticPlan(budget).layout ?? {
    directional: false,
    pointMask: 0,
    spotMask: 0,
  };
  // Each view leaves space for a replacement. The device also charges overlapping views
  // and old generations until their last submitted command buffer finishes.
  let remaining = Math.floor(budget / 2);
  const directionalLayers = Math.max(MIN_SHADOW_ARRAY_LAYERS, cascades);
  const directionalBytes = (directionalSize ?? 0) ** 2 * 4 * directionalLayers;
  layout.directional =
    directionalRequested &&
    directionalSize !== undefined &&
    directionalBytes > 0 &&
    directionalBytes <= remaining &&
    (owner === undefined ||
      owner.admitStatic('directional-shadow-static', directionalSize, directionalLayers));
  if (layout.directional) remaining -= directionalBytes;

  const faceSize = lights.pointShadow[0]?.mapSize ?? SHADOW_ATLAS_DEFAULT_FACE_SIZE;
  const cubeBytes = faceSize ** 2 * 4 * 6;
  const pointMask = fittingLayers(points, remaining, cubeBytes);
  const cubes = 32 - Math.clz32(pointMask);
  layout.pointMask =
    pointMask !== 0 &&
    (owner === undefined || owner.admitStatic('point-shadow-static', faceSize, cubes * 6))
      ? pointMask
      : 0;
  if (layout.pointMask !== 0) remaining -= cubes * cubeBytes;

  const spotLayerBytes = spotSize ** 2 * 4;
  const spotMask =
    remaining < spotLayerBytes * MIN_SHADOW_ARRAY_LAYERS
      ? 0
      : fittingLayers(spots, remaining, spotLayerBytes);
  const spotLayers = Math.max(MIN_SHADOW_ARRAY_LAYERS, 32 - Math.clz32(spotMask));
  layout.spotMask =
    spotMask !== 0 &&
    (owner === undefined || owner.admitStatic('spot-shadow-static', spotSize, spotLayers))
      ? spotMask
      : 0;
  return layout;
}

function fittingLayers(mask: number, remaining: number, bytesPerLayer: number): number {
  if (mask === 0 || bytesPerLayer <= 0) return 0;
  const span = 32 - Math.clz32(mask);
  const count = Math.min(span, Math.floor(remaining / bytesPerLayer));
  return count === span ? mask : mask & (2 ** count - 1);
}
