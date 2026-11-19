import { AssetError, err, ok, type Result } from '@forgeax/engine-types';
import type { Vec2 } from './contracts.js';
import { requireWaterValue } from './required-value.js';
import type { WaterMeshBodyInput, WaterMeshTileInstance } from './water-mesh.js';
import { WATER_WAVE_LWC_TILE_LENGTH_M } from './waves.js';

export type WaterMeshContinuitySupport = Readonly<{
  version: 1;
  /** Row-major weights on the original unit grid, before perspective interpolation. */
  weights: readonly number[];
}>;
type Segment = readonly [Vec2, Vec2];
const at = <T>(values: readonly T[], index: number): T => requireWaterValue(values[index]);
const cross = (a: Vec2, b: Vec2, c: Vec2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const distance = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function pointSegment(p: Vec2, [a, b]: Segment): number {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / Math.max(dx * dx + dz * dz, 1e-20)),
  );
  return distance(p, [a[0] + t * dx, a[1] + t * dz]);
}
function edges(tile: WaterMeshTileInstance): Segment[] {
  return (tile.coverageRings ?? []).flatMap((ring) =>
    ring.map((p, i) => {
      const q = at(ring, (i + 1) % ring.length);
      return [
        [p[0] + tile.originXZ[0], p[1] + tile.originXZ[1]],
        [q[0] + tile.originXZ[0], q[1] + tile.originXZ[1]],
      ] as Segment;
    }),
  );
}
function overlap([a, b]: Segment, [c, d]: Segment): Segment | undefined {
  const length = distance(a, b);
  if (
    length <= 1e-8 ||
    Math.abs(cross(a, b, c)) > length * 1e-5 ||
    Math.abs(cross(a, b, d)) > length * 1e-5
  )
    return;
  const u: Vec2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const scalar = (p: Vec2) => (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
  const low = Math.max(0, Math.min(scalar(c), scalar(d))),
    high = Math.min(length, Math.max(scalar(c), scalar(d)));
  if (high - low <= 1e-5) return;
  return [
    [a[0] + low * u[0], a[1] + low * u[1]],
    [a[0] + high * u[0], a[1] + high * u[1]],
  ];
}
/** Numeric projection of the production tile morph, including its f32 upload boundary. */
export function waterMeshContinuityVertex(
  tile: WaterMeshTileInstance,
  column: number,
  row: number,
): Vec2 {
  const f = Math.fround;
  const p = [
    f(f(column / tile.quadsPerEdge) * tile.extentXZ[0]),
    f(f(row / tile.quadsPerEdge) * tile.extentXZ[1]),
  ];
  const quad = tile.extentXZ.map((x) => f(x / tile.quadsPerEdge));
  if (tile.shouldMorph)
    for (let lod = tile.lod0; lod < tile.maxMorphLod; lod++) {
      const dist = Math.hypot(
        f(at(p, 0) - f(tile.cameraRelativeXZ[0])),
        f(at(p, 1) - f(tile.cameraRelativeXZ[1])),
      );
      const height = lod === tile.lod0 ? Math.round(tile.heightMorph01 * 8191) / 8191 : 0;
      // Production WGSL clamps the distance ramp before adding first-level height morph.
      const distanceFactor = Math.max(0, Math.min(1, dist / (f(tile.lodScaleM) * 2 ** lod) - 1));
      const factor = Math.max(0, Math.min(1, height + distanceFactor));
      for (const axis of [0, 1] as const) {
        const grid = f(at(quad, axis) * 4),
          coordinate = at(p, axis),
          phase = f(coordinate / grid);
        const offset = f(phase - Math.floor(phase) - 0.5);
        if (Math.abs(offset) < 0.26) p[axis] = f(coordinate + f(f(offset * factor) * grid));
        quad[axis] = f(at(quad, axis) * 2);
      }
      if (factor < 1) break;
    }
  return [f(f(tile.originXZ[0]) + at(p, 0)), f(f(tile.originXZ[1]) + at(p, 1))];
}
function insideTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const x = cross(a, b, p),
    y = cross(b, c, p),
    z = cross(c, a, p);
  return (
    Math.abs(cross(a, b, c)) > 1e-10 && (Math.min(x, y, z) >= -1e-5 || Math.max(x, y, z) <= 1e-5)
  );
}
function intersects(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  return (
    Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <=
      Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) + 1e-6 &&
    Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <=
      Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) + 1e-6 &&
    cross(a, b, c) * cross(a, b, d) <= 1e-8 &&
    cross(c, d, a) * cross(c, d, b) <= 1e-8
  );
}
function hits(segment: Segment, points: readonly Vec2[]): boolean {
  const a = at(points, 0),
    b = at(points, 1),
    c = at(points, 2);
  return (
    insideTriangle(segment[0], a, b, c) ||
    insideTriangle(segment[1], a, b, c) ||
    intersects(segment[0], segment[1], a, b) ||
    intersects(segment[0], segment[1], b, c) ||
    intersects(segment[0], segment[1], c, a)
  );
}
function sameGrid(a: WaterMeshTileInstance, b: WaterMeshTileInstance): boolean {
  return (
    a.originXZ[0] === b.originXZ[0] &&
    a.originXZ[1] === b.originXZ[1] &&
    a.extentXZ[0] === b.extentXZ[0] &&
    a.extentXZ[1] === b.extentXZ[1] &&
    a.quadsPerEdge === b.quadsPerEdge &&
    a.lod0 === b.lod0 &&
    a.maxMorphLod === b.maxMorphLod &&
    a.shouldMorph === b.shouldMorph &&
    Math.round(a.heightMorph01 * 8191) === Math.round(b.heightMorph01 * 8191) &&
    a.cameraRelativeXZ[0] === b.cameraRelativeXZ[0] &&
    a.cameraRelativeXZ[1] === b.cameraRelativeXZ[1] &&
    a.lodScaleM === b.lodScaleM
  );
}
function boundsOverlap(a: WaterMeshTileInstance, b: WaterMeshTileInstance): boolean {
  return (
    a.originXZ[0] <= b.originXZ[0] + b.extentXZ[0] &&
    b.originXZ[0] <= a.originXZ[0] + a.extentXZ[0] &&
    a.originXZ[1] <= b.originXZ[1] + b.extentXZ[1] &&
    b.originXZ[1] <= a.originXZ[1] + a.extentXZ[1]
  );
}
/** Derived with the view roster, not retained in a parallel membership registry. */
export function buildWaterMeshContinuity(
  tiles: readonly WaterMeshTileInstance[],
  bodies: readonly WaterMeshBodyInput[],
): Result<readonly WaterMeshTileInstance[], AssetError> {
  const fail = (expected: string, detail: unknown) =>
    err(
      new AssetError({
        code: 'asset-invalid-value',
        expected,
        detail: { field: 'transitionContinuity', got: detail },
        hint: 'repair the authored terminal continuity reach or paired WaterMesh grid',
      }),
    );
  if (!bodies.some((b) => b.transitionContinuity !== undefined)) return ok(tiles);
  const weights = new Map<WaterMeshTileInstance, number[]>();
  const sourceTargets = new Map<WaterMeshTileInstance, WaterMeshBodyInput>();
  const qualified = bodies.filter((b) => b.transitionContinuity !== undefined);
  for (const source of qualified) {
    const policy = source.transitionContinuity;
    if (!policy) continue;
    const rings =
      source.polygonRings ??
      (source.polygon ? [source.polygon.outer, ...(source.polygon.holes ?? [])] : []);
    const authoredEdges: Segment[] = rings.flatMap((ring) =>
      ring.map((p, i) => [p, at(ring, (i + 1) % ring.length)] as Segment),
    );
    const sources = tiles.filter(
      (t) =>
        !t.far &&
        t.ownerGuid === source.guid &&
        t.ownerGeneration === source.generation &&
        t.transitionBodyGuid !== undefined,
    );
    const coreVertices = new Map<string, Vec2>();
    const targetOwners = new Map<string, number>();
    const edgeCache = new Map<WaterMeshTileInstance, Segment[]>();
    const tileEdges = (tile: WaterMeshTileInstance) => {
      let value = edgeCache.get(tile);
      if (value === undefined) {
        value = edges(tile);
        edgeCache.set(tile, value);
      }
      return value;
    };
    const collectSharedBoundaryVertices = () => {
      for (const tile of sources) {
        const target = bodies.find(
          (b) =>
            b.guid === tile.transitionBodyGuid &&
            b.generation === tile.transitionBodyGeneration &&
            b.type === 'ocean',
        );
        if (!target) continue;
        const candidates = tiles.filter(
          (t) =>
            !t.far &&
            t.transitionBodyGuid === undefined &&
            t.ownerGuid === target.guid &&
            t.ownerGeneration === target.generation,
        );
        // Clipping creates tile perimeter edges too; only source footprint edges grant a join.
        const sourceEdges = tileEdges(tile).flatMap((edge) =>
          authoredEdges.flatMap((authored) => {
            const segment = overlap(edge, authored);
            return segment ? [segment] : [];
          }),
        );
        for (const other of candidates) {
          if (!boundsOverlap(tile, other)) continue;
          const segments = sourceEdges.flatMap((a) =>
            tileEdges(other).flatMap((b) => {
              const s = overlap(a, b);
              return s ? [s] : [];
            }),
          );
          const selected = segments.filter(
            (s) =>
              s.some((p) => distance(p, policy.centerXZ) < policy.reachM - policy.blendWidthM) ||
              pointSegment(policy.centerXZ, s) < policy.reachM - policy.blendWidthM,
          );
          if (!selected.length) continue;
          if (!sameGrid(tile, other))
            return fail('matching morphed grids for an opted-in shared transition boundary', {
              source: tile.originXZ,
              target: other.originXZ,
            });
          const n = tile.quadsPerEdge,
            points = Array.from({ length: (n + 1) ** 2 }, (_, i) =>
              waterMeshContinuityVertex(tile, i % (n + 1), Math.floor(i / (n + 1))),
            );
          const ids = new Set<number>();
          for (let row = 0; row < n; row++)
            for (let column = 0; column < n; column++) {
              const a = row * (n + 1) + column,
                b = a + 1,
                c = a + n + 1,
                d = c + 1;
              for (const triangle of [
                [a, c, b],
                [b, c, d],
              ]) {
                const vertices = triangle.map((i) => at(points, i));
                if (!selected.some((s) => hits(s, vertices))) continue;
                if (
                  vertices.some(
                    (p) => distance(p, policy.centerXZ) >= policy.reachM - policy.blendWidthM,
                  )
                )
                  continue;
                for (const id of triangle) ids.add(id);
              }
            }
          if (!ids.size) continue;
          for (const instance of [tile, other]) {
            targetOwners.set(target.guid, target.generation);
            let w = weights.get(instance);
            if (!w) {
              w = new Array((n + 1) ** 2).fill(0);
              weights.set(instance, w);
            }
            for (const id of ids) w[id] = 1;
          }
          for (const id of ids) {
            const p = at(points, id);
            coreVertices.set(`${p[0]},${p[1]}`, p);
          }
        }
      }
      return undefined;
    };
    const boundaryFailure = collectSharedBoundaryVertices();
    if (boundaryFailure !== undefined) return boundaryFailure;
    if (!coreVertices.size) continue;
    if (targetOwners.size > 1)
      return fail('one generation-qualified Ocean target in a terminal continuity support', [
        ...targetOwners,
      ]);
    const target = requireWaterValue(bodies.find((b) => targetOwners.get(b.guid) === b.generation));
    const bins = new Map<string, Vec2[]>();
    const cell = policy.blendWidthM;
    for (const p of coreVertices.values()) {
      const key = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
      const values = bins.get(key) ?? [];
      values.push(p);
      bins.set(key, values);
    }
    // Numeric distance to the small derived support, once at the producer.
    // It is never evaluated per fragment and never follows a tile perimeter.
    const extendSharedBoundarySupport = () => {
      for (const tile of tiles) {
        if (
          tile.far ||
          !(
            (tile.ownerGuid === source.guid &&
              tile.ownerGeneration === source.generation &&
              (tile.transitionBodyGuid === undefined ||
                targetOwners.get(tile.transitionBodyGuid) === tile.transitionBodyGeneration)) ||
            (tile.transitionBodyGuid === undefined &&
              targetOwners.get(tile.ownerGuid) === tile.ownerGeneration)
          )
        )
          continue;
        const n = tile.quadsPerEdge;
        let w = weights.get(tile);
        for (let row = 0; row <= n; row++)
          for (let column = 0; column <= n; column++) {
            const p = waterMeshContinuityVertex(tile, column, row),
              radial = distance(p, policy.centerXZ);
            if (radial >= policy.reachM) continue;
            let d = Infinity;
            const bx = Math.floor(p[0] / cell),
              bz = Math.floor(p[1] / cell);
            for (let x = bx - 1; x <= bx + 1; x++)
              for (let z = bz - 1; z <= bz + 1; z++)
                for (const v of bins.get(`${x},${z}`) ?? []) d = Math.min(d, distance(p, v));
            if (d >= policy.blendWidthM) continue;
            const t = Math.max(0, Math.min(1, d / policy.blendWidthM)),
              r = Math.max(0, Math.min(1, (policy.reachM - radial) / policy.blendWidthM));
            const value = (1 - t * t * (3 - 2 * t)) * (r * r * (3 - 2 * r));
            if (!w) {
              w = new Array((n + 1) ** 2).fill(0);
              weights.set(tile, w);
            }
            const index = row * (n + 1) + column;
            w[index] = Math.max(at(w, index), value);
            if (tile.ownerGuid === source.guid && tile.transitionBodyGuid === undefined)
              sourceTargets.set(tile, target);
          }
      }
    };
    extendSharedBoundarySupport();
  }
  return ok(
    Object.freeze(
      tiles.map((t) => {
        const w = weights.get(t);
        const target = sourceTargets.get(t);
        const wrap = (value: number) =>
          value -
          Math.floor((value + WATER_WAVE_LWC_TILE_LENGTH_M * 0.5) / WATER_WAVE_LWC_TILE_LENGTH_M) *
            WATER_WAVE_LWC_TILE_LENGTH_M;
        return w
          ? Object.freeze({
              ...t,
              ...(target === undefined
                ? {}
                : {
                    transitionBodyGuid: target.guid,
                    transitionBodyGeneration: target.generation,
                    transitionRenderIndex: requireWaterValue(
                      tiles.find(
                        (tile) =>
                          tile.ownerGuid === target.guid &&
                          tile.ownerGeneration === target.generation,
                      ),
                    ).ownerRenderIndex,
                    waterYM: target.baseHeightM,
                    yMinM: Math.min(
                      t.yMinM,
                      (target.worldYBounds?.[0] ?? target.baseHeightM) - target.maxWaveHeightM,
                    ),
                    yMaxM: Math.max(
                      t.yMaxM,
                      (target.worldYBounds?.[1] ?? target.baseHeightM) + target.maxWaveHeightM,
                    ),
                    waveOriginOffsetXZ: [
                      wrap(t.originXZ[0] - target.waveOriginXZ[0]),
                      wrap(t.originXZ[1] - target.waveOriginXZ[1]),
                    ] satisfies Vec2,
                  }),
              continuitySupport: Object.freeze({ version: 1 as const, weights: Object.freeze(w) }),
            })
          : t;
      }),
    ),
  );
}
