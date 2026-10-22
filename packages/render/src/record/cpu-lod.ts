import type { MeshGpuHandles } from '../device/gpu-residency';
import { type LodHeightCamera, projectedHeightForSnapshot } from '../gpu-driven/batch-topology';
import { selectGpuLodLane } from '../gpu-driven/view-gpu';
import type { RenderableSnapshot } from '../render-system-extract';
import { selectLod } from '../scene/visibility/lod-selector';
import type { ValidatedRenderable } from './frame-snapshot';

const DEFAULT_LOD_HYSTERESIS = 0.08;

/**
 * CPU-lane hard LOD selection for one renderable: the level the GPU lane's
 * projection would select without history or crossfade. Only rigid,
 * non-instanced, indexed meshes whose lower levels are resident switch; every
 * other shape keeps LOD0 exactly as the GPU lane's single-level fallback does.
 */
export function cpuLodLevel(
  source: RenderableSnapshot,
  mesh: MeshGpuHandles | undefined,
  camera: LodHeightCamera,
): number {
  const lods = source.lods;
  if (
    lods === undefined ||
    lods.length === 0 ||
    source.instances !== undefined ||
    source.skinBinding !== undefined ||
    source.morph !== undefined
  )
    return 0;
  const ranges = mesh?.lodRanges;
  if (mesh === undefined || !mesh.indexed || ranges === undefined) return 0;
  return selectLod({
    levels: lods,
    projectedHeight: projectedHeightForSnapshot(source, camera),
    previousLevel: 0,
    hysteresis: source.lodHysteresis ?? DEFAULT_LOD_HYSTERESIS,
    ready: [true, ...lods.map((_, index) => (ranges[index + 1]?.length ?? 0) > 0)],
    historyValid: false,
  }).level;
}

/** Per-mesh level views, retired with their resident handles. */
const levelViews = new WeakMap<MeshGpuHandles, (MeshGpuHandles | undefined)[]>();

function levelMesh(mesh: MeshGpuHandles, level: number): MeshGpuHandles {
  const ranges = mesh.lodRanges?.[level];
  if (ranges === undefined || ranges.length !== mesh.submeshes.length) return mesh;
  let views = levelViews.get(mesh);
  if (views === undefined) {
    views = [];
    levelViews.set(mesh, views);
  }
  const cached = views[level];
  if (cached !== undefined && cached.contentEpoch === mesh.contentEpoch) return cached;
  const view: MeshGpuHandles = {
    ...mesh,
    indexCount: ranges.reduce((sum, range) => sum + range.count, 0),
    // Source submeshes still identify materials and GPU claims. Recording
    // consumes the selected physical ranges without rewriting those facts.
    lodRanges: [ranges],
  };
  views[level] = view;
  return view;
}

/** Latest numeric result of one actual CPU LOD query; tokens retain no rows or Meshes. */
export interface CpuLodSelection {
  values: readonly number[];
  token: object;
}

/**
 * Project validated rows onto the CPU-selected LOD level. Rows that stay at
 * LOD0 are returned by identity, so a scene without LOD chains is unchanged.
 */
export function selectCpuLodRows(
  rows: readonly ValidatedRenderable[],
  camera: LodHeightCamera,
  selection?: CpuLodSelection,
): readonly ValidatedRenderable[] {
  let projected: ValidatedRenderable[] | undefined;
  let next: number[] | undefined;
  let cursor = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const level = cpuLodLevel(row.source, row.mesh, camera);
    if (selection !== undefined && (row.source.lods?.length ?? 0) > 0) {
      const world = row.source.worldId;
      const entity = row.source.entityKey;
      if (!Number.isSafeInteger(world) || world < 0 || !Number.isSafeInteger(entity) || entity < 0)
        throw new RangeError('CPU LOD query requires exact nonnegative source identities');
      const previous = selection.values;
      if (
        next === undefined &&
        (previous[cursor] !== world ||
          previous[cursor + 1] !== entity ||
          previous[cursor + 2] !== level)
      )
        next = previous.slice(0, cursor);
      next?.push(world, entity, level);
      cursor += 3;
    }
    if (level === 0) continue;
    projected ??= rows.slice();
    projected[index] = { ...row, mesh: levelMesh(row.mesh, level) };
  }
  if (selection !== undefined) {
    if (next === undefined && cursor !== selection.values.length)
      next = selection.values.slice(0, cursor);
    // Publish only a complete actual query. A throw above leaves its prior
    // numbers and token unchanged; consumers still receive current rows.
    if (next !== undefined) {
      const token = {};
      selection.values = next;
      selection.token = token;
    }
  }
  return projected ?? rows;
}

/**
 * Row projection for the classic draws from this camera: without the GPU LOD
 * lane each rigid LOD chain is hard-selected on the CPU (the cached validation
 * stays LOD0); with it, rows pass through unchanged.
 */
export function cpuLaneLodRows(
  caps: Parameters<typeof selectGpuLodLane>[0],
  camera: LodHeightCamera,
  selection?: CpuLodSelection,
): (rows: readonly ValidatedRenderable[]) => readonly ValidatedRenderable[] {
  return selectGpuLodLane(caps) === 'cpu'
    ? (rows) => selectCpuLodRows(rows, camera, selection)
    : (rows) => rows;
}

/** Level histogram in ascending level order; an empty input reports zero LOD0 rows. */
export function lodLevelHistogram(
  levels: Iterable<number>,
): readonly { readonly level: number; readonly count: number }[] {
  const counts = new Map<number, number>();
  for (const level of levels) counts.set(level, (counts.get(level) ?? 0) + 1);
  if (counts.size === 0) return [{ level: 0, count: 0 }];
  return [...counts]
    .sort((left, right) => left[0] - right[0])
    .map(([level, count]) => ({ level, count }));
}
