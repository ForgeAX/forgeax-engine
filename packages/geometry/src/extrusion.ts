import { type AssetError, err, type MeshAsset, type Result } from '@forgeax/engine-types';
import { geometryError, insetPolygon, preparePolygon } from './contour';
import { type PolygonRing, polygonMesh } from './polygon-mesh';
import type { Vec2Point, Vec3Point } from './procedural';

export interface ExtrusionOptions {
  readonly holes?: readonly (readonly Vec2Point[])[];
  /** Rim inset and axial depth, in source units. Zero disables bevel. */
  readonly bevelSize?: number;
  /** One is a chamfer; additional layers approximate a quarter-circle. */
  readonly bevelSegments?: number;
}
export function createExtrusionGeometry(
  contour: readonly Vec2Point[],
  depth: number,
  options: ExtrusionOptions = {},
): Result<MeshAsset, AssetError> {
  if (!Number.isFinite(depth) || depth <= 0)
    return err(geometryError('depth', 'must be positive and finite'));
  const shape = preparePolygon({ contour, holes: options.holes ?? [] });
  if (!shape.ok) return shape;
  const bevel = options.bevelSize ?? 0,
    segments = options.bevelSegments ?? 1;
  if (
    !Number.isFinite(bevel) ||
    bevel < 0 ||
    bevel >= depth / 2 ||
    !Number.isSafeInteger(segments) ||
    segments < 1 ||
    segments > 64
  )
    return err(
      geometryError('bevel', 'size must be non-negative and less than half depth; segments 1..64'),
    );
  const loops = shape.value;
  if (loops.flat().length * (bevel === 0 ? 2 : 2 * (segments + 1)) > 262144)
    return err(geometryError('mesh', 'at most 262144 ring vertices'));
  const rings: PolygonRing[] = [];
  const add = (section: Vec2Point[][], z: number) =>
    rings.push({
      v: (z + depth / 2) / depth,
      section,
      points: section.flat().map((p): Vec3Point => [p.x, p.y, z]),
    });
  if (bevel === 0) {
    add(loops, -depth / 2);
    add(loops, depth / 2);
  } else {
    for (const upper of [false, true])
      for (let i = 0; i <= segments; i++) {
        const angle = ((upper ? i / segments : 1 - i / segments) * Math.PI) / 2;
        const inset = bevel * (1 - Math.cos(angle));
        const section = inset === 0 ? shape : insetPolygon(loops, inset);
        if (!section.ok) return section;
        const z = (depth / 2 - bevel + bevel * Math.sin(angle)) * (upper ? 1 : -1);
        add(section.value, z);
      }
  }
  return polygonMesh(rings, true);
}
