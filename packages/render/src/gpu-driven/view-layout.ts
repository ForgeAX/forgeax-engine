import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import { GPU_DRIVEN_INDIRECT_COMMAND_BYTES, GPU_DRIVEN_LOD_LEVEL_CAPACITY } from './batch-layout';
import { LOD_VIEW_CONSTANTS_BYTES } from './lod-projection.wgsl';
import { GPU_TASK_HEADER_PREFIX_BYTES } from './task-header';
import { GPU_VIEW_BATCH_CONTROL_BYTES } from './view-topology';

export const WORKGROUP_SIZE = 64;
export const LOD_ROW_STRIDE = GPU_SCENE_LAYOUTS.lod.stride;
export const LOD_ROW_CAPACITY = GPU_DRIVEN_LOD_LEVEL_CAPACITY;
/** Only binding identity varies per candidate; execution and LOD belong to its batch. */
export const BATCH_HEADER_STRIDE = GPU_TASK_HEADER_PREFIX_BYTES;
export const GPU_DRIVEN_BATCH_STRIDE = GPU_VIEW_BATCH_CONTROL_BYTES;
export const BATCH_STRIDE = GPU_DRIVEN_BATCH_STRIDE;
export const LOD_CONSTANTS_OFFSET = 128;
export const OCCLUSION_CONSTANTS_OFFSET = LOD_CONSTANTS_OFFSET + LOD_VIEW_CONSTANTS_BYTES;
// viewProjection mat4 + camera range + the per-frame history words below.
export const OCCLUSION_STATE_OFFSET = OCCLUSION_CONSTANTS_OFFSET + 64 + 16;
export const OCCLUSION_STATE_BYTES = 32;
export const SHADOW_CAMERA_CULL_OFFSET = OCCLUSION_STATE_OFFSET + OCCLUSION_STATE_BYTES;

// Pyramid camera, light view-projection and inverse, dilation and enable.
export const SHADOW_CAMERA_CULL_BYTES = 80 + 64 + 64 + 16;
export const SKIN_CONSTANTS_OFFSET = SHADOW_CAMERA_CULL_OFFSET + SHADOW_CAMERA_CULL_BYTES;
export const SKIN_RASTER_OFFSET = Math.ceil((SKIN_CONSTANTS_OFFSET + 48) / 256) * 256;
export const VIEW_BYTES = SKIN_RASTER_OFFSET + 16;
// visible + overflow + one selector bucket per LOD level + selected/root index
// work + texel-culled + one compaction counter per LOD level. The work
// counters let inspection report geometry reduction from the actual indirect
// draw ranges instead of treating submitted-instance count as a proxy for
// vertex/index work.
export const LOD_COUNTER_OFFSET = 2;
export const GEOMETRY_WORK_COUNTER_OFFSET = LOD_COUNTER_OFFSET + LOD_ROW_CAPACITY;
export const ROOT_GEOMETRY_WORK_COUNTER_OFFSET = GEOMETRY_WORK_COUNTER_OFFSET + 1;
export const TEXEL_CULLED_COUNTER_OFFSET = ROOT_GEOMETRY_WORK_COUNTER_OFFSET + 1;
export const LEVEL_VISIBLE_COUNTER_OFFSET = TEXEL_CULLED_COUNTER_OFFSET + 1;
// Two-phase occlusion: the early per-level counts drawn before the pyramid
// exists, and the candidates the late HZB test rejected.
export const EARLY_VISIBLE_COUNTER_OFFSET = LEVEL_VISIBLE_COUNTER_OFFSET + LOD_ROW_CAPACITY;
export const OCCLUSION_CULLED_COUNTER_OFFSET = EARLY_VISIBLE_COUNTER_OFFSET + LOD_ROW_CAPACITY;
/** Light-depth slabs a receiver prism is split into for the camera pyramid test. */
export const SHADOW_CAMERA_CULL_SLABS = 8;
// Shadow casters whose shadowed receivers the main camera cannot see.
export const CAMERA_CULLED_COUNTER_OFFSET = OCCLUSION_CULLED_COUNTER_OFFSET + 1;
export const FRUSTUM_CULLED_COUNTER_OFFSET = CAMERA_CULLED_COUNTER_OFFSET + 1;
export const COUNTER_WORDS = FRUSTUM_CULLED_COUNTER_OFFSET + 1;
export const COUNTER_STRIDE = COUNTER_WORDS * 4;
/** Per 64-candidate tile: level counts, level prefixes and 64 four-word records. */
export const ORDER_TILE_WORDS = 2 * LOD_ROW_CAPACITY + 64 * 4;
export const ORDER_SCAN_LANES = 256;
/** Batch bases plus one tile block per 64 candidates. */
export const orderScratchWords = (batchCapacity: number, candidateCapacity: number): number =>
  batchCapacity * LOD_ROW_CAPACITY + Math.ceil(candidateCapacity / 64) * ORDER_TILE_WORDS;
export const INDIRECT_COMMAND_BYTES = GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
