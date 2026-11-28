import { type Mat4, mat4 } from '@forgeax/engine-math';
import type { MeshGpuHandles, MeshGpuRange } from '../device/gpu-residency';
import {
  type LodHeightCamera,
  projectedHeightForBounds,
  projectedHeightForSnapshot,
} from '../gpu-driven/batch-topology';
import { selectGpuLodLane } from '../gpu-driven/view-gpu';
import type { DrawRows } from '../record/frame-snapshot';
import type { RenderableSnapshot } from '../render-system-extract';
import { CapturedSceneTransform } from '../scene/captured-transform';
import { drawPoseStorage } from '../scene/mesh-draw';
import { targetLodLevel } from '../scene/visibility/lod-selector';
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
  return residentLodLevel(
    lods,
    projectedHeightForSnapshot(source, camera),
    source.lodHysteresis ?? DEFAULT_LOD_HYSTERESIS,
    ranges,
    mesh.submeshes.length,
  );
}

/** Only the chosen LOD and finer fallbacks need a resident range for each submesh. */
function residentLodLevel(
  lods: NonNullable<RenderableSnapshot['lods']>,
  height: number,
  hysteresis: number,
  ranges: NonNullable<MeshGpuHandles['lodRanges']>,
  submeshes: number,
): number {
  let level = targetLodLevel(lods, height, undefined, hysteresis);
  while (level > 0 && ranges[level]?.length !== submeshes) level--;
  return level;
}

/** Consecutive original ordinals sharing a hard-selected resident level. */
export interface CpuInstanceLodRun {
  readonly first: number;
  readonly count: number;
  readonly level: number;
}

const EMPTY_LOD_RUNS: readonly CpuInstanceLodRun[] = Object.freeze([]);

/** Instance transforms stay in their collection; only this camera's draw ranges change. */
export function cpuInstanceLodRuns(
  source: RenderableSnapshot,
  mesh: MeshGpuHandles | undefined,
  camera: LodHeightCamera,
  issued?: readonly CpuInstanceLodRun[],
  matrix?: Mat4,
): readonly CpuInstanceLodRun[] | undefined {
  const instances = source.instances;
  const lods = source.lods;
  if (
    instances === undefined ||
    lods === undefined ||
    lods.length === 0 ||
    mesh === undefined ||
    !mesh.indexed ||
    mesh.lodRanges === undefined ||
    source.skinBinding !== undefined ||
    source.morph !== undefined
  )
    return undefined;
  if (instances.instanceCount === 0) return EMPTY_LOD_RUNS;
  const aabb = source.localAabb;
  if (aabb === undefined || aabb.length < 6) {
    const first = issued?.[0];
    return issued?.length === 1 &&
      first?.first === 0 &&
      first.count === instances.instanceCount &&
      first.level === 0
      ? issued
      : [{ first: 0, count: instances.instanceCount, level: 0 }];
  }
  const world = matrix ?? mat4.create();
  const pose = drawPoseStorage(source);
  const root = CapturedSceneTransform.column(pose);
  const rootOffset = CapturedSceneTransform.offset(pose);
  const hysteresis = source.lodHysteresis ?? DEFAULT_LOD_HYSTERESIS;
  const ranges = mesh.lodRanges;
  const submeshes = mesh.submeshes.length;
  const transforms = instances.transforms;
  let runs: CpuInstanceLodRun[] | undefined;
  let index = 0;
  let first = 0;
  let previous: number | undefined;
  for (let ordinal = 0; ordinal <= instances.instanceCount; ordinal++) {
    const offset = ordinal * 16;
    // The terminal ordinal flushes the last range without allocating a sentinel.
    let level: number | undefined = ordinal === instances.instanceCount ? undefined : 0;
    if (level !== undefined && offset + 16 <= transforms.length) {
      mat4.multiply(world, root, transforms, offset, rootOffset);
      level = residentLodLevel(
        lods,
        projectedHeightForBounds(aabb, world, camera),
        hysteresis,
        ranges,
        submeshes,
      );
    }
    if (previous === level) continue;
    if (previous !== undefined) {
      const count = ordinal - first;
      const before = issued?.[index];
      if (before?.first === first && before.count === count && before.level === previous) {
        runs?.push(before);
      } else {
        runs ??= issued?.slice(0, index) ?? [];
        runs.push({ first, count, level: previous });
      }
      index++;
    }
    first = ordinal;
    previous = level;
  }
  return runs ?? (issued?.length === index ? issued : issued?.slice(0, index)) ?? EMPTY_LOD_RUNS;
}

type InstanceDrawWindow = {
  readonly instanceCount: number;
  readonly firstInstanceOrdinal?: number;
  readonly firstInstance?: number;
  readonly lodLevel?: number;
};

type CpuInstanceLodDraw<T> = T & {
  readonly range?: MeshGpuRange;
  readonly lodLevel?: number;
  readonly instanceOrdinals?: readonly number[];
};

/** Intersect existing resident pages with LOD runs, without moving matrices or identities. */
export function cpuInstanceLodDraws<T extends InstanceDrawWindow>(
  row: ValidatedRenderable,
  submesh: number,
  draws: readonly T[],
  remap = false,
): readonly CpuInstanceLodDraw<T>[] {
  const runs = row.cpuInstanceLods;
  if (runs === undefined) return draws;
  const selected: CpuInstanceLodDraw<T>[] = [];
  let cursor = 0;
  for (const draw of draws) {
    if (draw.lodLevel !== undefined) {
      const range = row.mesh.lodRanges?.[draw.lodLevel]?.[submesh];
      if (range !== undefined) selected.push({ ...draw, range });
      continue;
    }
    const first = draw.firstInstanceOrdinal ?? 0;
    const end = first + draw.instanceCount;
    while (cursor < runs.length && (runs[cursor]?.first ?? 0) + (runs[cursor]?.count ?? 0) <= first)
      cursor++;
    const buckets = remap ? new Map<number, number[]>() : undefined;
    for (let index = cursor; index < runs.length; index++) {
      const run = runs[index];
      if (run === undefined || run.first >= end) break;
      const start = Math.max(first, run.first);
      const stop = Math.min(end, run.first + run.count);
      const range = row.mesh.lodRanges?.[run.level]?.[submesh];
      if (stop <= start || range === undefined) continue;
      if (buckets !== undefined) {
        let ordinals = buckets.get(run.level);
        if (ordinals === undefined) {
          ordinals = [];
          buckets.set(run.level, ordinals);
        }
        for (let ordinal = start; ordinal < stop; ordinal++) ordinals.push(ordinal);
        continue;
      }
      selected.push({
        ...draw,
        instanceCount: stop - start,
        firstInstanceOrdinal: start,
        firstInstance: (draw.firstInstance ?? 0) + start - first,
        range,
      });
    }
    if (buckets !== undefined) appendRemappedLodDraws(selected, row.mesh, submesh, draw, buckets);
  }
  return selected;
}

/** Publish deterministic level buckets with their resident physical ranges. */
function appendRemappedLodDraws<T extends InstanceDrawWindow>(
  selected: CpuInstanceLodDraw<T>[],
  mesh: MeshGpuHandles,
  submesh: number,
  draw: T,
  buckets: ReadonlyMap<number, number[]>,
): void {
  for (const [level, ordinals] of [...buckets].sort((a, b) => a[0] - b[0])) {
    const range = mesh.lodRanges?.[level]?.[submesh];
    if (range === undefined) continue;
    selected.push({
      ...draw,
      instanceCount: ordinals.length,
      firstInstance: 0,
      lodLevel: level,
      instanceOrdinals: ordinals,
      range,
    });
  }
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

function projectedLodRow(
  row: ValidatedRenderable,
  level: number,
  runs: readonly CpuInstanceLodRun[] | undefined,
): ValidatedRenderable {
  if (runs !== undefined) return { ...row, cpuInstanceLods: runs };
  return level === 0 ? row : { ...row, mesh: levelMesh(row.mesh, level) };
}

/** A physical draw receives only its own camera-selected geometry. */
export function selectCpuLodRow(
  row: ValidatedRenderable,
  camera: LodHeightCamera,
  /** The last native projection of this exact input row, before addressing or pass overlays. */
  issued?: ValidatedRenderable,
  matrix?: Mat4,
): ValidatedRenderable {
  if ((row.source.lods?.length ?? 0) === 0) return row;
  const runs = cpuInstanceLodRuns(row.source, row.mesh, camera, issued?.cpuInstanceLods, matrix);
  if (runs !== undefined)
    return issued?.cpuInstanceLods === runs ? issued : { ...row, cpuInstanceLods: runs };
  const level = cpuLodLevel(row.source, row.mesh, camera);
  if (level === 0) return row;
  const mesh = levelMesh(row.mesh, level);
  return issued?.mesh === mesh ? issued : { ...row, mesh };
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
  rows: DrawRows,
  camera: LodHeightCamera,
  selection?: CpuLodSelection,
): DrawRows {
  let projected: ValidatedRenderable[] | undefined;
  let next: number[] | undefined;
  let cursor = 0;
  function record(previous: readonly number[], entity: number, level: number, count: number): void {
    // A negative count cannot alias the next nonnegative entity. Single draws
    // occupy two numbers. Long instance runs take three regardless of length.
    if (
      next === undefined &&
      (previous[cursor] !== entity ||
        previous[cursor + 1] !== level ||
        (count > 1 && previous[cursor + 2] !== -count))
    )
      next = previous.slice(0, cursor);
    next?.push(entity, level);
    cursor += 2;
    if (count > 1) {
      next?.push(-count);
      cursor++;
    }
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows.at(index);
    if (row === undefined) continue;
    const runs = cpuInstanceLodRuns(row.source, row.mesh, camera);
    const level = cpuLodLevel(row.source, row.mesh, camera);
    if (selection !== undefined && (row.source.lods?.length ?? 0) > 0) {
      const entity = row.source.entityKey;
      if (!Number.isSafeInteger(entity) || entity < 0)
        throw new RangeError('CPU LOD query requires exact nonnegative source identities');
      if (runs === undefined) record(selection.values, entity, level, 1);
      else for (const run of runs) record(selection.values, entity, run.level, run.count);
    }
    const selected = projectedLodRow(row, level, runs);
    if (selected !== row) {
      projected ??= rows.slice();
      projected[index] = selected;
    }
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
): (rows: DrawRows) => DrawRows {
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
