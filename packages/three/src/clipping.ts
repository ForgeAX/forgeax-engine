import {
  type ClippingOptions,
  type ClippingPlane,
  normalizeClippingPlanes,
} from '@forgeax/engine-types';
import { ClippingGroup } from 'three/src/objects/ClippingGroup.js';
import type { Object3D } from 'three/src/Three.Core.js';
import { unsupported } from './errors';

export interface SourceClipping {
  readonly union: readonly ClippingPlane[];
  readonly intersection: readonly ClippingPlane[];
}

/** r184 accumulates each kind across nested ClippingGroups. */
export function objectClipping(
  object: Object3D,
  parent?: SourceClipping,
): SourceClipping | undefined {
  if (!(object instanceof ClippingGroup) || !object.enabled || object.clippingPlanes.length === 0)
    return parent;
  const planes = object.clippingPlanes.map(
    (plane): ClippingPlane => [...plane.normal.toArray(), plane.constant],
  );
  const kind = object.clipIntersection ? 'intersection' : 'union';
  return {
    union: parent?.union ?? [],
    intersection: parent?.intersection ?? [],
    [kind]: [...(parent?.[kind] ?? []), ...planes],
  };
}

/** Camera and material clipping are the native pair of independent predicates.
 * Factor a shared source set into the camera; keep each remaining set local. */
export function projectClipping(
  objects: readonly Object3D[],
  source: ReadonlyMap<Object3D, SourceClipping | undefined>,
): {
  camera?: ClippingOptions;
  local: ReadonlyMap<Object3D, ClippingOptions>;
} {
  const local = new Map<Object3D, ClippingOptions>();
  const firstObject = objects[0];
  const first = firstObject === undefined ? undefined : source.get(firstObject);
  const common = (['union', 'intersection'] as const).find(
    (kind) =>
      (first?.[kind].length ?? 0) > 0 &&
      objects.every(
        (object) => JSON.stringify(source.get(object)?.[kind]) === JSON.stringify(first?.[kind]),
      ),
  );
  const camera =
    common === undefined || first === undefined
      ? undefined
      : {
          planes: normalizeClippingPlanes(first[common]),
          intersection: common === 'intersection',
        };
  for (const object of objects) {
    const planes = source.get(object);
    const union = common === 'union' ? [] : (planes?.union ?? []);
    const intersection = common === 'intersection' ? [] : (planes?.intersection ?? []);
    if (union.length > 0 && intersection.length > 0)
      return unsupported(
        'Mixed clipping with no shared plane set requires two native local predicates',
        object.uuid,
      ).unwrap();
    if (union.length + intersection.length > 0)
      local.set(object, {
        planes: normalizeClippingPlanes(union.length > 0 ? union : intersection),
        intersection: intersection.length > 0,
      });
  }
  return { ...(camera === undefined ? {} : { camera }), local };
}
