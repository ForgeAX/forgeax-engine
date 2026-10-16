import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import {
  ClippingContractError,
  type ClippingOptions,
  type ClippingPlane,
  MAX_CLIPPING_PLANES,
  normalizeClippingPlanes,
} from '@forgeax/engine-types';

/** Camera companion. Captures reuse CameraSnapshot.clipping, never a global renderer mutation. */
export const ClippingPlanes = defineComponent('ClippingPlanes', {
  planes: { type: 'array<f32, 24>' },
  count: { type: 'u32', default: 0 },
  intersection: { type: 'bool', default: false },
  clipShadows: { type: 'bool', default: false },
});
export type ClippingPlanesData = ShapeOf<SchemaOf<typeof ClippingPlanes>>;

export function clippingPlanesData(options: ClippingOptions): ClippingPlanesData {
  const normalized = normalizeClippingPlanes(options.planes);
  const planes = new Float32Array(MAX_CLIPPING_PLANES * 4);
  for (const [index, plane] of normalized.entries()) planes.set(plane, index * 4);
  return {
    planes,
    count: normalized.length,
    intersection: options.intersection === true,
    clipShadows: options.clipShadows === true,
  };
}

export function extractClippingPlanes(
  data: ClippingPlanesData | undefined,
): ClippingOptions | undefined {
  if (data === undefined) return undefined;
  if (!Number.isInteger(data.count) || data.count < 0 || data.count > MAX_CLIPPING_PLANES)
    throw new ClippingContractError({ field: 'count', actual: data.count });
  const planes: ClippingPlane[] = [];
  for (let index = 0; index < data.count; index++) {
    const offset = index * 4;
    planes.push([
      data.planes[offset] ?? Number.NaN,
      data.planes[offset + 1] ?? Number.NaN,
      data.planes[offset + 2] ?? Number.NaN,
      data.planes[offset + 3] ?? Number.NaN,
    ]);
  }
  return {
    planes: normalizeClippingPlanes(planes),
    intersection: data.intersection,
    clipShadows: data.clipShadows,
  };
}
