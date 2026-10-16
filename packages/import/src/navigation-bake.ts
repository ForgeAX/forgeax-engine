import { createHash } from 'node:crypto';
import {
  err,
  type MeshAsset,
  type NavigationBakeSettings,
  type NavigationMeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import {
  freeCompactHeightfield,
  freeContourSet,
  freeHeightfield,
  freePolyMesh,
  freePolyMeshDetail,
  init,
  Raw,
} from '@recast-navigation/core';
import { generateSoloNavMesh } from '@recast-navigation/generators';

export interface NavigationBakeSource {
  readonly geometry: readonly { readonly mesh: MeshAsset; readonly world: ArrayLike<number> }[];
  readonly settings: NavigationBakeSettings;
  /** Hard pre-allocation limits; independent of voxel resolution. */
  readonly maxTriangles?: number;
  readonly maxCells?: number;
}
export type NavigationBakeError = {
  readonly code: 'navigation-bake-invalid' | 'navigation-bake-limit' | 'navigation-bake-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string; readonly value: unknown };
};
function failure(
  code: NavigationBakeError['code'],
  field: string,
  value: unknown,
): NavigationBakeError {
  return {
    code,
    expected: 'bounded indexed geometry and valid ground-agent settings producing a nonempty mesh',
    hint: 'Correct the source or bake limits, then rebuild the same Pack GUID.',
    detail: { field, value },
  };
}
/** Explicit production operation. No ECS frame, runtime compiler or generated identity. */
export async function bakeNavigationMesh(
  source: NavigationBakeSource,
): Promise<Result<NavigationMeshAsset, NavigationBakeError>> {
  if (
    !source ||
    !Array.isArray(source.geometry) ||
    source.geometry.length === 0 ||
    source.geometry.length > 1_000_000
  )
    return err(failure('navigation-bake-invalid', 'geometry', 'a bounded nonempty geometry array'));
  const { settings: s } = source;
  if (
    !s ||
    ![s.radius, s.height, s.maxSlopeDeg, s.maxStep, s.cellSize, s.cellHeight].every(
      Number.isFinite,
    ) ||
    s.radius < 0 ||
    s.height <= 0 ||
    s.maxStep < 0 ||
    s.maxSlopeDeg < 0 ||
    s.maxSlopeDeg >= 90 ||
    s.cellSize <= 0 ||
    s.cellHeight <= 0 ||
    Math.ceil(s.height / s.cellHeight) < 3 ||
    Math.ceil(s.height / s.cellHeight) > 255 ||
    Math.ceil(s.radius / s.cellSize) > 255 ||
    Math.floor(s.maxStep / s.cellHeight) > 255
  )
    return err(failure('navigation-bake-invalid', 'settings', s));
  const maxTriangles = source.maxTriangles ?? 1_000_000;
  const maxCells = source.maxCells ?? 4_000_000;
  if (
    ![maxTriangles, maxCells].every((n) => Number.isInteger(n) && n > 0) ||
    maxTriangles > 1_000_000 ||
    maxCells > 4_000_000
  )
    return err(failure('navigation-bake-invalid', 'limits', { maxTriangles, maxCells }));
  const positions: number[] = [],
    indices: number[] = [];
  for (const entry of source.geometry) {
    if (!entry?.mesh?.attributes || !entry.world)
      return err(
        failure(
          'navigation-bake-invalid',
          'geometry',
          'mesh attributes and world placement required',
        ),
      );
    const { mesh, world: m } = entry;
    const raw = mesh.attributes.position;
    const p =
      raw instanceof Float32Array
        ? raw
        : raw instanceof ArrayBuffer && raw.byteLength % 4 === 0
          ? new Float32Array(raw)
          : undefined;
    if (
      !p ||
      !mesh.indices ||
      p.length % 3 !== 0 ||
      mesh.indices.length % 3 !== 0 ||
      m.length !== 16 ||
      !Array.from(m).every(Number.isFinite) ||
      m[3] !== 0 ||
      m[7] !== 0 ||
      m[11] !== 0 ||
      m[15] !== 1
    )
      return err(
        failure(
          'navigation-bake-invalid',
          'geometry',
          'indexed positions and affine world matrix required',
        ),
      );
    if (
      indices.length / 3 + mesh.indices.length / 3 > maxTriangles ||
      positions.length + p.length > maxTriangles * 9
    )
      return err(failure('navigation-bake-limit', 'triangles', maxTriangles));
    const offset = positions.length / 3;
    const determinant =
      (m[0] as number) *
        ((m[5] as number) * (m[10] as number) - (m[9] as number) * (m[6] as number)) -
      (m[4] as number) *
        ((m[1] as number) * (m[10] as number) - (m[9] as number) * (m[2] as number)) +
      (m[8] as number) *
        ((m[1] as number) * (m[6] as number) - (m[5] as number) * (m[2] as number));
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
      return err(failure('navigation-bake-invalid', 'world', 'singular transform'));
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] as number,
        y = p[i + 1] as number,
        z = p[i + 2] as number;
      positions.push(
        (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
        (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
        (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
      );
    }
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = mesh.indices[i] as number,
        b = mesh.indices[i + 1] as number,
        c = mesh.indices[i + 2] as number;
      if ([a, b, c].some((n) => !Number.isInteger(n) || n < 0 || n >= p.length / 3))
        return err(failure('navigation-bake-invalid', 'indices', [a, b, c]));
      indices.push(
        offset + a,
        offset + (determinant < 0 ? c : b),
        offset + (determinant < 0 ? b : c),
      );
    }
  }
  if (indices.length === 0 || !positions.every((n) => Number.isFinite(n) && Math.abs(n) < 1e7))
    return err(failure('navigation-bake-invalid', 'geometry', 'empty or non-finite geometry'));
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis] as number, positions[i] as number);
    max[axis] = Math.max(max[axis] as number, positions[i] as number);
  }
  const nx = Math.ceil(((max[0] as number) - (min[0] as number)) / s.cellSize) + 1,
    nz = Math.ceil(((max[2] as number) - (min[2] as number)) / s.cellSize) + 1;
  // Bound both horizontal cells and worst-case rasterization work, including stacked geometry.
  let rasterWork = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = (indices[i] as number) * 3,
      b = (indices[i + 1] as number) * 3,
      c = (indices[i + 2] as number) * 3;
    const width =
      Math.ceil(
        (Math.max(positions[a] as number, positions[b] as number, positions[c] as number) -
          Math.min(positions[a] as number, positions[b] as number, positions[c] as number)) /
          s.cellSize,
      ) + 1;
    const depth =
      Math.ceil(
        (Math.max(
          positions[a + 2] as number,
          positions[b + 2] as number,
          positions[c + 2] as number,
        ) -
          Math.min(
            positions[a + 2] as number,
            positions[b + 2] as number,
            positions[c + 2] as number,
          )) /
          s.cellSize,
      ) + 1;
    rasterWork += width * depth;
  }
  if (
    nx * nz > maxCells ||
    rasterWork > 200_000_000 ||
    ((max[1] as number) - (min[1] as number)) / s.cellHeight > 65500
  )
    return err(
      failure('navigation-bake-limit', 'voxel-work', { nx, nz, triangles: indices.length / 3 }),
    );
  const sourceDigest = createHash('sha256')
    .update(JSON.stringify(['recast-poly/1', 'recast-navigation@0.43.1', s, positions, indices]))
    .digest('hex');
  try {
    await init();
  } catch (cause) {
    return err(failure('navigation-bake-failed', 'wasm', String(cause)));
  }
  let built: ReturnType<typeof generateSoloNavMesh> | undefined;
  try {
    built = generateSoloNavMesh(
      positions,
      indices,
      {
        cs: s.cellSize,
        ch: s.cellHeight,
        walkableHeight: Math.ceil(s.height / s.cellHeight),
        walkableRadius: Math.ceil(s.radius / s.cellSize),
        walkableClimb: Math.floor(s.maxStep / s.cellHeight),
        walkableSlopeAngle: s.maxSlopeDeg,
        minRegionArea: 0,
        mergeRegionArea: 0,
        maxSimplificationError: 0.5,
        bounds: [
          [min[0] as number, (min[1] as number) - s.cellHeight, min[2] as number],
          [max[0] as number, (max[1] as number) + s.height + s.cellHeight, max[2] as number],
        ],
      },
      true,
    );
    const p = built.intermediates.polyMesh;
    if (!built.success || !p || p.npolys() === 0)
      return err(
        failure('navigation-bake-failed', 'recast', built.success ? 'empty mesh' : built.error),
      );
    const vertices: number[] = [],
      polygons: number[][] = [];
    const origin = p.bmin();
    for (let i = 0; i < p.nverts(); i++)
      vertices.push(
        origin.x + p.verts(i * 3) * p.cs(),
        origin.y + p.verts(i * 3 + 1) * p.ch(),
        origin.z + p.verts(i * 3 + 2) * p.cs(),
      );
    for (let i = 0; i < p.npolys(); i++) {
      const polygon: number[] = [];
      for (let j = 0; j < p.nvp(); j++) {
        const v = p.polys(i * p.nvp() * 2 + j);
        if (v === 65535) break;
        polygon.push(v);
      }
      if (polygon.length >= 3) polygons.push(polygon);
    }
    return ok({
      kind: 'navigation-mesh',
      version: 'recast-poly/1',
      sourceDigest,
      settings: { ...s },
      vertices,
      polygons,
    });
  } catch (cause) {
    return err(failure('navigation-bake-failed', 'recast', String(cause)));
  } finally {
    built?.navMesh?.destroy();
    const i = built?.intermediates;
    if (i) {
      if (i.heightfield) freeHeightfield(i.heightfield);
      if (i.compactHeightfield) freeCompactHeightfield(i.compactHeightfield);
      if (i.contourSet) freeContourSet(i.contourSet);
      if (i.polyMesh) freePolyMesh(i.polyMesh);
      if (i.polyMeshDetail) freePolyMeshDetail(i.polyMeshDetail);
      Raw.destroy(i.buildContext.raw);
    }
  }
}
