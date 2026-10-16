import { AssetError, err, ok, type Result } from '@forgeax/engine-types';
import { distanceFieldMeshDigest, type FieldVec3 } from './distance-field';
import { createTriangleQuery, type QueryTriangle } from './triangle-query';

export type { MeshCardLayout, MeshCardProjection } from '@forgeax/engine-types';

import type { MeshCardLayout, MeshCardProjection } from '@forgeax/engine-types';

interface Surfel {
  x: number;
  y: number;
  z: number;
  near: number;
  weight: number;
  samples: { position: FieldVec3; normal: FieldVec3 }[];
}
interface Cluster {
  direction: number;
  plane: number;
  samples: number[];
  weight: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}
const cross = (a: FieldVec3, b: FieldVec3): FieldVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: FieldVec3, b: FieldVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: FieldVec3): FieldVec3 => {
  const size = Math.hypot(...a);
  return size === 0 ? [0, 0, 0] : [a[0] / size, a[1] / size, a[2] / size];
};
export function meshCardFailure(reason: string, value: unknown): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-parse-failed',
      expected: 'bounded indexed mesh and finite card sampling settings',
      hint: 'Repair the source mesh or card build settings, then rebuild the same mesh GUID.',
      detail: { field: 'mesh-card-layout', value, reason },
    }),
  );
}

/**
 * Offline six-axis, multiple-depth card fitting. UE MeshCardRepresentationUtilities
 * motivates the near-plane visibility constraint and global coverage budget;
 * this bounded implementation does not copy its world-unit defaults.
 */
export async function buildMeshCardLayout(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  settings: {
    readonly resolution?: number;
    readonly maxCards?: number;
    readonly triangleSidedness?: ArrayLike<number>;
  } = {},
): Promise<Result<MeshCardLayout, AssetError>> {
  const resolution = settings.resolution ?? 16,
    maxCards = settings.maxCards ?? 24;
  if (
    !Number.isInteger(resolution) ||
    resolution < 8 ||
    resolution > 32 ||
    !Number.isInteger(maxCards) ||
    maxCards < 1 ||
    maxCards > 64 ||
    positions.length < 9 ||
    positions.length % 3 !== 0 ||
    positions.length > 3_145_728 ||
    indices.length < 3 ||
    indices.length % 3 !== 0 ||
    indices.length > 3_145_728
  )
    return meshCardFailure('resolution 8..32, maxCards 1..64, at most 1048576 vertices/triangles', {
      resolution,
      maxCards,
      triangleCount: indices.length / 3,
      positions: positions.length,
      indices: indices.length,
    });
  const triangleCount = indices.length / 3;
  const flags = settings.triangleSidedness;
  if (
    flags !== undefined &&
    (flags.length !== triangleCount ||
      Array.from(flags).some((value) => value !== 0 && value !== 1))
  )
    return meshCardFailure('triangleSidedness must contain one 0 or 1 per indexed triangle', null);
  const sidedness = flags === undefined ? new Uint8Array(triangleCount) : Uint8Array.from(flags);
  // UE MeshRepresentationCommon derives the foliage fitting hint at one quarter.
  // Individual hits still use the originating triangle, never this aggregate hint.
  const mostlyTwoSided = sidedness.reduce((sum, value) => sum + value, 0) * 4 >= triangleCount;
  const points: FieldVec3[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const p: FieldVec3 = [
      Math.fround(item(positions, i)),
      Math.fround(item(positions, i + 1)),
      Math.fround(item(positions, i + 2)),
    ];
    if (!p.every(Number.isFinite)) return meshCardFailure('positions must be finite f32', p);
    points.push(p);
  }
  const triangles: QueryTriangle[] = [],
    normals: FieldVec3[] = [],
    triangleSides: number[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [item(indices, i), item(indices, i + 1), item(indices, i + 2)];
    if (ids.some((id) => !Number.isInteger(id) || id < 0 || id >= points.length))
      return meshCardFailure('index outside source vertices', ids);
    const a = item(points, item(ids, 0)),
      b = item(points, item(ids, 1)),
      c = item(points, item(ids, 2));
    const normal = normalize(
      cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]),
    );
    // Collapsed source triangles have no raster coverage, as in the exact query path.
    if (dot(normal, normal) === 0) continue;
    triangles.push([a, b, c]);
    triangleSides.push(item(sidedness, i / 3));
    normals.push(normal);
    for (const p of [a, b, c])
      for (const axis of [0, 1, 2] as const) {
        min[axis] = Math.min(min[axis], p[axis]);
        max[axis] = Math.max(max[axis], p[axis]);
      }
  }
  if (triangles.length === 0) return meshCardFailure('mesh has no nondegenerate surface', 0);
  const spacing = Math.max(...max.map((x, i) => x - item(min, i))) / resolution;
  if (!(spacing > 0) || !Number.isFinite(spacing))
    return meshCardFailure('invalid spatial extent', spacing);
  const query = createTriangleQuery(triangles),
    hit = { primitive: -1, distance: 0, frontFace: false };
  const bases: MeshCardProjection[] = [],
    allSurfels: Surfel[][] = [],
    clusters: Cluster[] = [];
  let rays = 0,
    rejectedInside = 0;
  const epsilon = Math.max(
    spacing * 1e-5,
    Number.EPSILON * Math.max(...min.map(Math.abs), ...max.map(Math.abs)) * 16,
  );
  for (let direction = 0; direction < 6; direction++) {
    const axis = Math.floor(direction / 2),
      sign = direction % 2 ? -1 : 1;
    const n: [number, number, number] = [0, 0, 0],
      u: [number, number, number] = [0, 0, 0];
    n[axis] = sign;
    u[(axis + 1) % 3] = 1;
    const v = cross(u, n),
      size = max.map((x, i) => x - item(min, i));
    const extent = (a: FieldVec3) =>
      Math.abs(a[0]) * item(size, 0) +
      Math.abs(a[1]) * item(size, 1) +
      Math.abs(a[2]) * item(size, 2);
    const columns = Math.max(1, Math.ceil(extent(u) / spacing)),
      rows = Math.max(1, Math.ceil(extent(v) / spacing));
    const width = columns * spacing,
      height = rows * spacing,
      depth = Math.max(spacing, extent(n));
    const origin: FieldVec3 = [0, 1, 2].map(
      (i) =>
        (item(min, i) + item(max, i)) / 2 +
        (item(n, i) * depth) / 2 -
        (item(u, i) * width) / 2 -
        (item(v, i) * height) / 2,
    ) as [number, number, number];
    bases.push({ origin, u, v, n, width, height, depth });
    const cast: FieldVec3 = [-n[0], -n[1], -n[2]],
      surfels = new Map<string, Surfel>();
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++)
        for (let sample = 0; sample < 32; sample++) {
          let bits = sample,
            inverse = 0,
            fraction = 0.5;
          while (bits > 0) {
            inverse += (bits & 1) * fraction;
            bits >>>= 1;
            fraction *= 0.5;
          }
          const jitter = [(sample + 0.5) / 32, inverse];
          const start: FieldVec3 = [0, 1, 2].map(
            (i) =>
              item(origin, i) +
              item(u, i) * (x + item(jitter, 0)) * spacing +
              item(v, i) * (y + item(jitter, 1)) * spacing +
              item(n, i) * 2 * spacing,
          ) as [number, number, number];
          let near = 0,
            lastCell = -2;
          while (near <= depth + 2 * spacing + epsilon) {
            rays++;
            if (!query.trace(hit, start, cast, near, depth + 2 * spacing + epsilon)) break;
            const cell = Math.max(0, Math.floor((hit.distance - 2 * spacing) / spacing));
            const originalNormal = item(normals, hit.primitive),
              alignment = dot(originalNormal, n),
              twoSided = item(triangleSides, hit.primitive) === 1;
            // Advancing the query already skips the occupied cell. An adjacent
            // cell may contain a separate visible surface across an air gap.
            if ((twoSided ? Math.abs(alignment) : alignment) >= 0.5 && cell > lastCell) {
              const normal: FieldVec3 =
                twoSided && alignment < 0
                  ? [-originalNormal[0], -originalNormal[1], -originalNormal[2]]
                  : originalNormal;
              const position: FieldVec3 = [
                start[0] + cast[0] * hit.distance + normal[0] * epsilon,
                start[1] + cast[1] * hit.distance + normal[1] * epsilon,
                start[2] + cast[2] * hit.distance + normal[2] * epsilon,
              ];
              const nearPlane = Math.max(0, lastCell + 1),
                key = `${x},${y},${cell},${nearPlane}`;
              const surfel = surfels.get(key) ?? {
                x,
                y,
                z: cell,
                near: nearPlane,
                weight: 0,
                samples: [],
              };
              surfel.samples.push({ position, normal });
              surfels.set(key, surfel);
            }
            lastCell = cell;
            near = 2 * spacing + (cell + 1) * spacing + epsilon;
          }
        }
    const samples = [...surfels.values()].filter((surfel) => {
      let hits = 0,
        backHits = 0;
      // Visibility is sampled across the actual surface points, never at a mean
      // point which may lie inside curved geometry. Reuse the compacted span.
      for (let sample = 0; sample < 8; sample++) {
        const { position, normal } = item(surfel.samples, sample % surfel.samples.length);
        const tangent = normalize(cross(normal, Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]));
        const bitangent = cross(normal, tangent);
        const z = (sample + 0.5) / 8,
          radius = Math.sqrt(1 - z * z),
          phi = sample * 2.399963229728653;
        const ray: FieldVec3 = [0, 1, 2].map(
          (i) =>
            item(normal, i) * z +
            radius * (item(tangent, i) * Math.cos(phi) + item(bitangent, i) * Math.sin(phi)),
        ) as [number, number, number];
        rays++;
        if (query.trace(hit, position, ray, 0, Infinity)) {
          hits++;
          if (!hit.frontFace && item(triangleSides, hit.primitive) === 0) backHits++;
        }
      }
      surfel.weight = ((2 - hits / 8) * surfel.samples.length) / 32;
      surfel.samples.length = 0;
      if (hits > 8 * 0.8 && backHits > 8 * 0.2) {
        rejectedInside++;
        return false;
      }
      return true;
    });
    allSurfels.push(samples);
    if (allSurfels.reduce((sum, list) => sum + list.length, 0) > 32768)
      return meshCardFailure(
        'surfel budget exceeded; rebuild with lower sampling resolution',
        allSurfels.reduce((sum, list) => sum + list.length, 0),
      );
    const assigned = new Set<number>();
    const fit = (plane: number): Cluster | undefined => {
      const eligible: number[] = [];
      samples.forEach((s, index) => {
        if (!assigned.has(index) && s.z >= plane && s.near <= plane) eligible.push(index);
      });
      const enclose = (indices: number[]): Cluster => {
        const cluster: Cluster = {
          direction,
          plane,
          samples: indices,
          weight: 0,
          minX: Infinity,
          minY: Infinity,
          maxX: -Infinity,
          maxY: -Infinity,
          minZ: Infinity,
          maxZ: -Infinity,
        };
        for (const index of indices) {
          const s = item(samples, index);
          cluster.weight += s.weight;
          cluster.minX = Math.min(cluster.minX, s.x);
          cluster.minY = Math.min(cluster.minY, s.y);
          cluster.maxX = Math.max(cluster.maxX, s.x);
          cluster.maxY = Math.max(cluster.maxY, s.y);
          cluster.minZ = Math.min(cluster.minZ, s.z);
          cluster.maxZ = Math.max(cluster.maxZ, s.z);
        }
        return cluster;
      };
      const valid = (cluster: Cluster) =>
        cluster.weight >= 0.25 &&
        cluster.weight / ((cluster.maxX - cluster.minX + 1) * (cluster.maxY - cluster.minY + 1)) >=
          0.05;
      const whole = enclose(eligible);
      if (valid(whole)) return whole;
      // Empty space between disconnected surfaces must not dilute each surface's
      // density. Keep the same admission thresholds and global Card budget.
      const cells = new Map<number, number[]>();
      for (const index of eligible) {
        const s = item(samples, index),
          key = s.y * columns + s.x;
        const cell = cells.get(key) ?? [];
        cell.push(index);
        cells.set(key, cell);
      }
      const islands: Cluster[] = [];
      while (cells.size > 0) {
        const first = cells.keys().next().value;
        if (first === undefined) break;
        const queue = [first],
          indices: number[] = [];
        for (let cursor = 0; cursor < queue.length; cursor++) {
          const key = item(queue, cursor),
            cell = cells.get(key);
          if (cell === undefined) continue;
          cells.delete(key);
          indices.push(...cell);
          const x = key % columns,
            y = Math.floor(key / columns);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx,
                ny = y + dy;
              if (nx < 0 || nx >= columns || ny < 0 || ny >= rows) continue;
              const neighbor = ny * columns + nx;
              if (cells.has(neighbor)) queue.push(neighbor);
            }
        }
        islands.push(enclose(indices));
      }
      islands.sort((a, b) => b.weight - a.weight);
      const seed = islands.find(valid);
      if (seed === undefined) return undefined;
      let best = seed;
      // Pack nearby islands when their union is admissible, so splitting does
      // not spend the finite budget on unnecessarily small projections.
      for (const island of islands) {
        if (island === seed) continue;
        const combined = enclose([...best.samples, ...island.samples]);
        if (valid(combined)) best = combined;
      }
      return best;
    };
    let best = fit(0);
    while (true) {
      if (best !== undefined) {
        clusters.push(best);
        for (const index of best.samples) assigned.add(index);
      }
      best = undefined;
      for (let plane = 0; plane <= (mostlyTwoSided ? 0 : resolution); plane++) {
        const candidate = fit(plane);
        if (candidate !== undefined && (best === undefined || candidate.weight > best.weight))
          best = candidate;
      }
      if (best === undefined) break;
    }
  }
  clusters.sort((a, b) => b.weight - a.weight || a.direction - b.direction || a.plane - b.plane);
  const selected = clusters.slice(0, maxCards);
  const cards = selected.map((cluster): MeshCardProjection => {
    const base = item(bases, cluster.direction),
      // An inner near plane excludes the preceding occupied cell. Extending
      // half a voxel into that cell would capture the rejected occluder again.
      near =
        cluster.plane === 0
          ? cluster.minZ - 0.5
          : Math.max(cluster.minZ - 0.5, cluster.plane - epsilon / spacing);
    return {
      origin: [0, 1, 2].map(
        (i) =>
          item(base.origin, i) +
          item(base.u, i) * cluster.minX * spacing +
          item(base.v, i) * cluster.minY * spacing -
          item(base.n, i) * near * spacing,
      ) as [number, number, number],
      u: base.u,
      v: base.v,
      n: base.n,
      width: (cluster.maxX - cluster.minX + 1) * spacing,
      height: (cluster.maxY - cluster.minY + 1) * spacing,
      // Keep the far half-voxel enclosure while preserving the fitted near plane.
      depth: (cluster.maxZ + 1.5 - near) * spacing,
    };
  });
  return ok({
    meshDigest: await distanceFieldMeshDigest(positions, indices),
    bounds: { min, max },
    cards,
    sidednessDigest: await meshCardSidednessDigest(sidedness),
    sampling: {
      resolution,
      spacing,
      rays,
      surfels: allSurfels.reduce((sum, list) => sum + list.length, 0),
      weightedCoverage: allSurfels.reduce(
        (sum, list) => sum + list.reduce((s, surfel) => s + surfel.weight, 0),
        0,
      ),
      representedWeight: selected.reduce((sum, cluster) => sum + cluster.weight, 0),
      rejectedInside,
    },
  });
}

function item<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError('Card layout index outside validated input');
  return value;
}

/** Representation policy identity; independent of geometry and material values. */
export async function meshCardSidednessDigest(flags: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(flags));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
