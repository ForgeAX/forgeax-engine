import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../../gpu-scene-schema';
import { type LodSelection, selectLod } from './lod-selector';
export const GPU_LOD_ROW_LAYOUT = GPU_SCENE_LAYOUTS.lod;

export interface LodDrawRange {
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly baseVertex: number;
}

export interface GpuLodRowsInput {
  readonly generation: number;
  readonly hysteresis: number;
  readonly ranges: readonly LodDrawRange[];
  /** Absolute projected-height thresholds, including root at index zero. */
  readonly coverages: readonly number[];
  readonly ready: readonly boolean[];
}

export interface GpuLodRow extends LodDrawRange {
  readonly generation: number;
  readonly level: number;
  readonly screenCoverage: number;
  readonly hysteresis: number;
  readonly ready: boolean;
}

function finiteInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function finiteFraction(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be in [0, 1]`);
  }
  return value;
}

/** Projects one stable row per draw range; it never contains a per-view choice. */
export function buildGpuLodRows(input: GpuLodRowsInput): readonly GpuLodRow[] {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new RangeError('generation must be a non-negative safe integer');
  }
  if (input.ranges.length === 0 || input.ranges.length !== input.coverages.length) {
    throw new RangeError('ranges and coverages must have the same non-zero length');
  }
  if (input.ready.length !== input.ranges.length) {
    throw new RangeError('ready must have one value for every LOD range');
  }
  if (!Number.isFinite(input.hysteresis) || input.hysteresis < 0 || input.hysteresis >= 1) {
    throw new RangeError('hysteresis must be in [0, 1)');
  }
  let previousCoverage = 1;
  return Object.freeze(
    input.ranges.map((range, level) => {
      const coverage = finiteFraction(input.coverages[level] ?? Number.NaN, `coverage[${level}]`);
      if (level === 0 && coverage !== 1) throw new RangeError('root coverage must be 1');
      if (level > 0 && coverage >= previousCoverage) {
        throw new RangeError('LOD coverages must be strictly decreasing');
      }
      previousCoverage = coverage;
      return Object.freeze({
        generation: input.generation,
        level,
        firstIndex: finiteInteger(range.firstIndex, `ranges[${level}].firstIndex`),
        indexCount: finiteInteger(range.indexCount, `ranges[${level}].indexCount`),
        baseVertex: Number.isSafeInteger(range.baseVertex) ? range.baseVertex : 0,
        screenCoverage: coverage,
        hysteresis: input.hysteresis,
        ready: input.ready[level] === true,
      });
    }),
  );
}

const LOD_FIELD = (name: string): number => gpuSceneFieldOffset(GPU_LOD_ROW_LAYOUT, name);
const GENERATION = LOD_FIELD('generation');
const LEVEL = LOD_FIELD('level');
const FIRST_INDEX = LOD_FIELD('firstIndex');
const INDEX_COUNT = LOD_FIELD('indexCount');
const BASE_VERTEX = LOD_FIELD('baseVertex');
const SCREEN_COVERAGE = LOD_FIELD('screenCoverage');
const HYSTERESIS = LOD_FIELD('hysteresis');
const READY = LOD_FIELD('ready');

/** The one `GpuSceneLod` byte writer; GPU view topology and CPU evidence share it. */
export function writeGpuLodRow(view: DataView, offset: number, row: GpuLodRow): void {
  view.setUint32(offset + GENERATION, row.generation, true);
  view.setUint32(offset + LEVEL, row.level, true);
  view.setUint32(offset + FIRST_INDEX, row.firstIndex, true);
  view.setUint32(offset + INDEX_COUNT, row.indexCount, true);
  view.setInt32(offset + BASE_VERTEX, row.baseVertex, true);
  view.setFloat32(offset + SCREEN_COVERAGE, row.screenCoverage, true);
  view.setFloat32(offset + HYSTERESIS, row.hysteresis, true);
  view.setUint32(offset + READY, row.ready ? 1 : 0, true);
}

export function encodeGpuLodRows(rows: readonly GpuLodRow[]): Uint8Array {
  const bytes = new Uint8Array(GPU_LOD_ROW_LAYOUT.stride * rows.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const row of rows) writeGpuLodRow(view, row.level * GPU_LOD_ROW_LAYOUT.stride, row);
  return bytes;
}

export interface GpuLodSelectionInput {
  readonly projectedHeight: number;
  readonly previousLevel: number;
  readonly historyValid: boolean;
}

/** CPU reference used by both the GPU selector contract and unsupported fallback. */
export function selectGpuLod(
  rows: readonly GpuLodRow[],
  input: GpuLodSelectionInput,
): LodSelection {
  const first = rows[0];
  if (first === undefined) return { level: 0, confidence: 1 };
  return selectLod({
    levels: rows.slice(1),
    projectedHeight: input.projectedHeight,
    previousLevel: input.previousLevel,
    hysteresis: first.hysteresis,
    ready: rows.map((row) => row.ready),
    historyValid: input.historyValid,
  });
}
