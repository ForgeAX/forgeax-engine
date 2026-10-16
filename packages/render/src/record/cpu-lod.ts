import type { MeshGpuHandles } from '../device/gpu-residency';
import { type LodHeightCamera, projectedHeightForSnapshot } from '../gpu-driven/batch-topology';
import { selectGpuLodLane } from '../gpu-driven/view-gpu';
import type { RenderableSnapshot } from '../render-system-extract';
import { renderableDrawKey } from '../scene/draw-key';
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
    source.skin !== undefined ||
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

/**
 * Project validated rows onto the CPU-selected LOD level. Rows that stay at
 * LOD0 are returned by identity, so a scene without LOD chains is unchanged.
 */
export function selectCpuLodRows(
  rows: readonly ValidatedRenderable[],
  camera: LodHeightCamera,
): readonly ValidatedRenderable[] {
  let projected: ValidatedRenderable[] | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const level = cpuLodLevel(row.source, row.mesh, camera);
    if (level === 0) continue;
    projected ??= rows.slice();
    projected[index] = { ...row, mesh: levelMesh(row.mesh, level) };
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
): (rows: readonly ValidatedRenderable[]) => readonly ValidatedRenderable[] {
  return selectGpuLodLane(caps) === 'cpu'
    ? (rows) => selectCpuLodRows(rows, camera)
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

/**
 * Project one shared validation result into a cull-specific renderable index
 * domain. The retained ShadowCaster projection is the superset; the primary
 * camera submission reuses its resolved mesh rows without a second residency
 * walk or a second validation authority.
 */
export function projectValidatedRows(
  validated: readonly ValidatedRenderable[],
  target: readonly RenderableSnapshot[],
): readonly ValidatedRenderable[] {
  if (validated.length === target.length) {
    let sameDomain = true;
    for (let index = 0; index < target.length; index += 1) {
      const row = validated[index];
      if (row?.source !== target[index] || row?.renderableIndex !== index) {
        sameDomain = false;
        break;
      }
    }
    if (sameDomain) return validated;
  }
  const byIdentity = new Map<string, ValidatedRenderable>();
  for (const row of validated) byIdentity.set(renderableDrawKey(row.source), row);
  const projected: ValidatedRenderable[] = [];
  for (let index = 0; index < target.length; index += 1) {
    const snapshot = target[index];
    if (snapshot === undefined) continue;
    const row = byIdentity.get(renderableDrawKey(snapshot));
    if (row === undefined) continue;
    projected.push({ ...row, source: snapshot, renderableIndex: index });
  }
  return projected;
}
