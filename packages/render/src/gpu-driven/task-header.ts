import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import { writeGpuLodRow } from '../scene/visibility/gpu-lod';
import {
  batchLevelStride,
  batchLodLevelCount,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
  GPU_DRIVEN_LOD_LEVEL_CAPACITY,
} from './batch-layout';
import type { GpuDrivenBatch } from './batch-topology';

export const GPU_TASK_HEADER_PREFIX_BYTES = 52;
export const GPU_TASK_HEADER_BYTES =
  GPU_TASK_HEADER_PREFIX_BYTES + GPU_DRIVEN_LOD_LEVEL_CAPACITY * GPU_SCENE_LAYOUTS.lod.stride;
export const GPU_TASK_HEADER_WORDS = GPU_TASK_HEADER_BYTES / 4;
export const GPU_TASK_MEMBER_WORD = 12;

/** Capture static task columns. Word seven belongs to the View's active work table. */
export function encodeTaskHeader(
  batch: GpuDrivenBatch,
  materialAddress: number,
  geometryAddress: number,
): Uint32Array {
  const words = new Uint32Array(GPU_TASK_HEADER_WORDS);
  const data = new DataView(words.buffer);
  const key = batch.key;
  const lod = batch.lod;
  const coverages = lod?.coverages;
  const ranges = lod?.ranges;
  const shape =
    coverages === undefined
      ? undefined
      : { coverages, ...(ranges === undefined ? {} : { ranges }) };
  const levels = batchLodLevelCount(shape === undefined ? {} : { lod: shape });
  const count = key.count;
  const first = key.first;
  const baseVertex = key.baseVertex;
  const capacity = batch.visibleCapacity;
  const allocation = batch.visibleAllocationCapacity;
  const crossfade = lod?.crossfade === true;
  const hysteresis = lod?.hysteresis ?? 0.08;
  const generation = batch.generation;
  data.setUint32(0, batch.visibleBase, true);
  data.setUint32(4, capacity, true);
  data.setUint32(8, count, true);
  data.setUint32(12, first, true);
  data.setInt32(16, baseVertex, true);
  data.setUint32(20, batch.indirectOffset / GPU_DRIVEN_INDIRECT_COMMAND_BYTES, true);
  const flags =
    (key.drawKind === 'indexed' ? 1 : 0) |
    (levels << 1) |
    (batch.logicalResources === true ? 0x10000 : 0) |
    (key.rowMaterial === true ? 0x20000 : 0);
  data.setUint32(24, flags, true);
  data.setUint32(
    32,
    batchLevelStride({
      visibleCapacity: capacity,
      ...(allocation === undefined ? {} : { visibleAllocationCapacity: allocation }),
    }),
    true,
  );
  data.setUint32(36, crossfade ? 1 : 0, true);
  data.setUint32(40, materialAddress, true);
  data.setUint32(44, geometryAddress, true);
  for (let level = 0; level < levels; level++) {
    const range = level === 0 ? undefined : ranges?.[level - 1];
    writeGpuLodRow(data, GPU_TASK_HEADER_PREFIX_BYTES + level * GPU_SCENE_LAYOUTS.lod.stride, {
      generation,
      level,
      firstIndex: range?.first ?? first,
      indexCount: range?.count ?? count,
      baseVertex: range?.baseVertex ?? baseVertex,
      screenCoverage: coverages?.[level] ?? (level === 0 ? 1 : 0),
      hysteresis: hysteresis,
      ready: !crossfade || level === 0 || range !== undefined,
    });
  }
  return words;
}
