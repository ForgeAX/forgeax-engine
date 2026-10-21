import { err, type NavigationMeshAsset, ok, type Result } from '@forgeax/engine-types';
import { invalidInput, type NavigationError } from './errors';

export const MAX_POLYGONS = 131072;

/** Validate bounded POD topology without copying source data or constructing a query/BVH. */
export function validateNavigationMesh(
  input: NavigationMeshAsset,
): Result<NavigationMeshAsset, NavigationError> {
  if (
    !input ||
    input.kind !== 'navigation-mesh' ||
    input.version !== 'recast-poly/1' ||
    typeof input.sourceDigest !== 'string' ||
    !input.sourceDigest ||
    !Array.isArray(input.vertices) ||
    input.vertices.length < 9 ||
    input.vertices.length % 3 !== 0 ||
    input.vertices.length > 786432 ||
    !Array.isArray(input.polygons) ||
    input.polygons.length < 1 ||
    input.polygons.length > MAX_POLYGONS
  )
    return err(invalidInput('navigation-mesh', input, 'Versioned bounded polygon data'));
  for (const value of input.vertices)
    if (!Number.isFinite(value))
      return err(invalidInput('vertices', value, 'Finite vertex channels'));
  const s = input.settings;
  if (
    !s ||
    ![s.radius, s.height, s.maxSlopeDeg, s.maxStep, s.cellSize, s.cellHeight].every(
      Number.isFinite,
    ) ||
    s.radius < 0 ||
    s.height <= 0 ||
    s.maxSlopeDeg < 0 ||
    s.maxSlopeDeg >= 90 ||
    s.maxStep < 0 ||
    s.cellSize <= 0 ||
    s.cellHeight <= 0
  )
    return err(invalidInput('settings', s, 'Finite ground-agent bake settings'));
  const shared = new Map<string, number>();
  for (const polygon of input.polygons) {
    if (
      !Array.isArray(polygon) ||
      polygon.length < 3 ||
      polygon.length > 6 ||
      new Set(polygon).size !== polygon.length ||
      polygon.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= input.vertices.length / 3,
      )
    )
      return err(invalidInput('polygon', polygon, '3..6 distinct in-range indices'));
    let sign = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i] as number,
        b = polygon[(i + 1) % polygon.length] as number;
      const ax = input.vertices[a * 3] as number,
        az = input.vertices[a * 3 + 2] as number;
      const bx = input.vertices[b * 3] as number,
        bz = input.vertices[b * 3 + 2] as number;
      if (ax === bx && az === bz)
        return err(invalidInput('polygon', polygon, 'Convex nondegenerate XZ polygon'));
      // All vertices lie on the same side of each edge. Unlike only checking
      // adjacent turns, this also excludes self-intersecting polygon rings.
      for (const index of polygon) {
        const cross =
          (bx - ax) * ((input.vertices[index * 3 + 2] as number) - az) -
          (bz - az) * ((input.vertices[index * 3] as number) - ax);
        if (Math.abs(cross) <= 1e-10) continue;
        if (sign && sign * cross < 0)
          return err(invalidInput('polygon', polygon, 'Convex nondegenerate XZ polygon'));
        sign = Math.sign(cross);
      }
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const count = (shared.get(key) ?? 0) + 1;
      if (count > 2) return err(invalidInput('polygon', polygon, 'Manifold shared edges'));
      shared.set(key, count);
    }
    if (!sign) return err(invalidInput('polygon', polygon, 'Nonzero XZ area'));
  }
  return ok(input);
}
