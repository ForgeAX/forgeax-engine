import { mat4 } from '@forgeax/engine-math';
import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  PipelineLayout,
  RenderBundle,
  Result,
  RhiDevice,
  RhiRenderPassEncoder,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import {
  decodeGeometryCommands,
  decodeGeometryView,
  GEOMETRY_OBSERVATION_MAX_BYTES,
  type GeometryCommandCapture,
} from '../geometry-observation';
import { GPU_SCENE_PRIMITIVE_CAPSULE_SHADOW, type GpuScene } from '../gpu-scene';
import {
  GPU_MATERIAL_DESCRIPTOR,
  GPU_MESH_DESCRIPTOR,
  type GpuInputReadFrame,
} from '../gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS, gpuSceneWgsl } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_INDIRECT,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { SkinTaskBinding } from '../record/skin-tasks';
import type { FrameList } from '../scene/frame-list';
import { SKIN_INPUT_WGSL } from '../scene/skin-inputs.wgsl';
import type { SkinSceneFrame } from '../scene/skin-scene-inputs';
import { writeGpuLodRow } from '../scene/visibility/gpu-lod';
import type {
  SurfaceGpuIndirectParameters,
  SurfaceGpuIndirectReadbackError,
  SurfaceGpuReadbackSnapshot,
  SurfaceSubmissionCandidate,
} from '../surface/submission-observation';
import { decodeSurfaceIndirectParameters } from '../surface/submission-observation';
import {
  batchLevelStride,
  batchLodLevelCount,
  batchVisibleSpan,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
  GPU_DRIVEN_LOD_LEVEL_CAPACITY,
} from './batch-layout';
import { MemberCandidates } from './batch-members';
import type { GpuDrivenBatch, GpuDrivenCandidate, SubmissionPlan } from './batch-topology';
import { hasFixedTaskHeaders } from './fixed-task-plan';
import {
  LOD_PROJECTION_WGSL,
  LOD_VIEW_CONSTANTS_BYTES,
  type LodViewCamera,
  writeLodViewConstants,
} from './lod-projection.wgsl';
import {
  type PreparedRasterBindings,
  type PreparedRasterBundleCache,
  type PreparedRasterCounters,
  PreparedRasterPass,
} from './prepared-raster-bundle';
import { admittedRasterBatchCount, SHADOW_LOD_COARSEST } from './production-raster-lod';
import { suppressionPatchOf } from './production-raster-prepare';
import {
  GpuResourceAllocationLedger,
  type GpuResourceAllocationToken,
} from './resource-allocation';
import { SKIN_BOUNDS_WGSL } from './skin-bounds.wgsl';
import { type SkinDemandLayout, skinDemandLayout, writeSkinDemandConstants } from './skin-demand';
import { SKIN_DEMAND_WGSL } from './skin-demand.wgsl';

const COMPUTE_STAGE = 0x4;
const WORKGROUP_SIZE = 64;
const LOD_ROW_STRIDE = GPU_SCENE_LAYOUTS.lod.stride;
const LOD_ROW_CAPACITY = GPU_DRIVEN_LOD_LEVEL_CAPACITY;
/** Only binding identity varies per candidate; execution and LOD belong to its batch. */
const BATCH_HEADER_STRIDE = 52;
export const GPU_DRIVEN_BATCH_STRIDE = BATCH_HEADER_STRIDE + LOD_ROW_CAPACITY * LOD_ROW_STRIDE;
const BATCH_STRIDE = GPU_DRIVEN_BATCH_STRIDE;
const LOD_CONSTANTS_OFFSET = 128;
const OCCLUSION_CONSTANTS_OFFSET = LOD_CONSTANTS_OFFSET + LOD_VIEW_CONSTANTS_BYTES;
// viewProjection mat4 + camera range + the per-frame history words below.
const OCCLUSION_STATE_OFFSET = OCCLUSION_CONSTANTS_OFFSET + 64 + 16;
const OCCLUSION_STATE_BYTES = 32;
const SHADOW_CAMERA_CULL_OFFSET = OCCLUSION_STATE_OFFSET + OCCLUSION_STATE_BYTES;

/**
 * Light NDC to world, or undefined when the light matrix has no usable inverse.
 * `mat4.invert` treats |det| < 1e-8 as singular and returns identity, which a
 * kilometre-wide orthographic cascade reaches; scaling the world axes first
 * keeps the determinant near one, and the round trip rejects a truly singular
 * matrix so the kernel never builds a receiver prism in the wrong space.
 *
 * @internal
 */
export function invertLightViewProjection(
  lightViewProjection: Float32Array,
): Float32Array | undefined {
  let scale = 0;
  for (let index = 0; index < 12; index += 1) {
    if (index % 4 !== 3) scale = Math.max(scale, Math.abs(lightViewProjection[index] as number));
  }
  if (!(scale > 0 && Number.isFinite(scale))) return undefined;
  const scaled = mat4.create();
  scaled.set(lightViewProjection.subarray(0, 16));
  for (let index = 0; index < 12; index += 1) scaled[index] = (scaled[index] as number) / scale;
  const inverse = mat4.invert(mat4.create(), scaled);
  const product = mat4.multiply(mat4.create(), scaled, inverse);
  for (let index = 0; index < 16; index += 1) {
    const expected = index % 5 === 0 ? 1 : 0;
    if (!(Math.abs((product[index] as number) - expected) <= 1e-4)) return undefined;
  }
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      inverse[column * 4 + row] = (inverse[column * 4 + row] as number) / scale;
    }
  }
  return inverse;
}
// Pyramid camera, light view-projection and inverse, dilation and enable.
const SHADOW_CAMERA_CULL_BYTES = 80 + 64 + 64 + 16;
const SKIN_CONSTANTS_OFFSET = SHADOW_CAMERA_CULL_OFFSET + SHADOW_CAMERA_CULL_BYTES;
const SKIN_RASTER_OFFSET = Math.ceil((SKIN_CONSTANTS_OFFSET + 48) / 256) * 256;
const VIEW_BYTES = SKIN_RASTER_OFFSET + 16;
const SKIN_VIEW_WGSL = `${SKIN_INPUT_WGSL}\n${SKIN_DEMAND_WGSL}\n${SKIN_BOUNDS_WGSL}`
  .replaceAll(/\bskinInputs\b/g, 'sceneInputs')
  .replaceAll(/\bskinCounters\b/g, 'counters')
  .replaceAll(/\bskinOutput\b/g, 'visibleIndices')
  .replaceAll(/\bskinIndirect\b/g, 'indirectArgs')
  .replaceAll(/\bskinDemand\b/g, 'view.skin');
// visible + overflow + one selector bucket per LOD level + selected/root index
// work + texel-culled + one compaction counter per LOD level. The work
// counters let inspection report geometry reduction from the actual indirect
// draw ranges instead of treating submitted-instance count as a proxy for
// vertex/index work.
const LOD_COUNTER_OFFSET = 2;
const GEOMETRY_WORK_COUNTER_OFFSET = LOD_COUNTER_OFFSET + LOD_ROW_CAPACITY;
const ROOT_GEOMETRY_WORK_COUNTER_OFFSET = GEOMETRY_WORK_COUNTER_OFFSET + 1;
const TEXEL_CULLED_COUNTER_OFFSET = ROOT_GEOMETRY_WORK_COUNTER_OFFSET + 1;
const LEVEL_VISIBLE_COUNTER_OFFSET = TEXEL_CULLED_COUNTER_OFFSET + 1;
// Two-phase occlusion: the early per-level counts drawn before the pyramid
// exists, and the candidates the late HZB test rejected.
const EARLY_VISIBLE_COUNTER_OFFSET = LEVEL_VISIBLE_COUNTER_OFFSET + LOD_ROW_CAPACITY;
const OCCLUSION_CULLED_COUNTER_OFFSET = EARLY_VISIBLE_COUNTER_OFFSET + LOD_ROW_CAPACITY;
/** Light-depth slabs a receiver prism is split into for the camera pyramid test. */
const SHADOW_CAMERA_CULL_SLABS = 8;
// Shadow casters whose shadowed receivers the main camera cannot see.
const CAMERA_CULLED_COUNTER_OFFSET = OCCLUSION_CULLED_COUNTER_OFFSET + 1;
const COUNTER_WORDS = CAMERA_CULLED_COUNTER_OFFSET + 1;
const COUNTER_STRIDE = COUNTER_WORDS * 4;
const INDIRECT_COMMAND_BYTES = GPU_DRIVEN_INDIRECT_COMMAND_BYTES;

export type GpuLodLane = 'gpu' | 'cpu';

export function selectGpuLodLane(caps: {
  readonly compute: boolean;
  readonly storageBuffer: boolean;
  readonly indirectDrawing: boolean;
}): GpuLodLane {
  return caps.compute && caps.storageBuffer && caps.indirectDrawing ? 'gpu' : 'cpu';
}

export const GPU_DRIVEN_VIEW_WGSL = /* wgsl */ `
${SKIN_VIEW_WGSL}
struct PrimitiveRecord {
  generation: u32,
  flags: u32,
  transformIndex: u32,
  materialIndex: u32,
  instanceStart: u32,
  instanceCount: u32,
  sourceIndex: u32,
  localBoundsMin: vec3<f32>,
  lightingChannels: u32,
  localBoundsMax: vec4<f32>,
};

${gpuSceneWgsl(GPU_SCENE_LAYOUTS.transform)}

${gpuSceneWgsl(GPU_SCENE_LAYOUTS.lod)}

${LOD_PROJECTION_WGSL}

// The batch address is derived for actual cull work, never stored per instance.
struct CandidateRecord {
  primitiveIndex: u32,
  generation: u32,
  instanceOrdinal: u32,
  batchIndex: u32,
  sourceSlot: u32,
};

struct InstanceRecord {
  primitiveIndex: u32,
  transformIndex: u32,
  customDataStart: u32,
  flags: u32,
};

struct PyramidCamera {
  // Unjittered projection of the view that rasterized the pyramid source.
  viewProjection: mat4x4<f32>,
  near: f32,
  far: f32,
  orthographic: u32,
  // Uniform footprint scale; 1 in production. The falsifier shrinks it to
  // prove the conservative footprint is what keeps partial occluders visible.
  footprintScale: f32,
};

struct OcclusionConstants {
  camera: PyramidCamera,
  // Non-zero only when this frame's graph also records the late phase.
  enabled: u32,
  // Zero after a camera cut, resize, recovery or skipped late phase: every
  // candidate then counts as previously visible and draws early.
  historyValid: u32,
  // Word offsets of the two instance-visibility bit regions in counters.
  previousBase: u32,
  nextBase: u32,
  bitWords: u32,
  // First u32 of the late-phase indirect region.
  lateArgsBase: u32,
  // First item of the late-phase visible mirror: every segment's late
  // suffix is copied to the same segment offset here. Capable commands use
  // this absolute base; portable commands bind a window and start at zero.
  lateVisibleBase: u32,
};

// A shadow view skips a caster whose every shadowed receiver the main
// camera cannot see: the light-space prism from the caster's nearest depth
// to the far plane, widened by the receiver's sampling footprint, lies
// outside the viewport or behind the main camera's furthest depth.
struct ShadowCameraCull {
  camera: PyramidCamera,
  lightViewProjection: mat4x4<f32>,
  lightInverse: mat4x4<f32>,
  // Receiver sampling footprint: light NDC widening for the filter kernel and
  // world widening for the receiver's normal offset.
  ndcDilation: f32,
  worldDilation: f32,
  enabled: u32,
};

struct ViewConstants {
  planes: array<vec4<f32>, 6>,
  candidateCount: u32,
  batchCount: u32,
  batchCapacity: u32,
  minCasterDiameter: f32,
  suppressionBase: u32,
  resourceRoot: u32,
  capsuleDirectional: u32,
  // A shadow view sets lod.clamp: its casters never raster coarser than SHADOW_LOD_COARSEST.
  lod: LodViewConstants,
  occlusion: OcclusionConstants,
  shadowCamera: ShadowCameraCull,
  skin: SkinDemandConstants,
  ${SKIN_RASTER_OFFSET > SKIN_CONSTANTS_OFFSET + 48 ? `skinPadding: array<vec4<u32>, ${(SKIN_RASTER_OFFSET - SKIN_CONSTANTS_OFFSET - 48) / 16}>,` : ''}
  skinRaster: vec4<u32>,
};

@group(0) @binding(0) var<storage, read> primitives: array<PrimitiveRecord>;
@group(0) @binding(1) var<storage, read> instances: array<InstanceRecord>;
@group(0) @binding(2) var<storage, read> transforms: array<GpuSceneTransform>;
@group(0) @binding(3) var<storage, read> sceneInputs: array<u32>;
@group(0) @binding(4) var<storage, read> batchWords: array<u32>;
@group(0) @binding(5) var<uniform> view: ViewConstants;
@group(0) @binding(6) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> visibleIndices: array<vec4<u32>>;
@group(0) @binding(8) var<storage, read_write> indirectArgs: array<u32>;
// Furthest-depth pyramid of the current frame's early phase (late cull only).
@group(1) @binding(0) var occlusionPyramid: texture_2d<f32>;

// Per-view admission bitmap indexed by GPU Scene primitive slot, stored after
// the batch table in batchWords (a separate binding would exceed the portable
// eight storage buffers per stage). A set bit suppresses the primitive
// (occlusion facet, author-hidden, unavailable); frustum rejection stays in
// isVisible.
fn isSuppressed(primitiveIndex: u32) -> bool {
  let word = batchWords[view.suppressionBase + (primitiveIndex >> 5u)];
  return (word & (1u << (primitiveIndex & 31u))) != 0u;
}

fn batchWord(batchIndex: u32, word: u32) -> u32 {
  return batchWords[batchIndex * ${BATCH_STRIDE / 4}u + word];
}

// Four radix256 reads resolve one logical resource. Pages contain descriptor
// numbers only; preparation must lease every resource a task can reach.
fn logicalResource(slot: u32) -> u32 {
  var page = view.resourceRoot;
  for (var shift = 24i; shift >= 0i; shift -= 8i) {
    if (page == 0xffffffffu) { return 0xffffffffu; }
    page = sceneInputs[page + ((slot >> u32(shift)) & 255u)];
  }
  return page;
}

fn resourceDescriptor(batchIndex: u32, word: u32) -> u32 {
  let slot = batchWord(batchIndex, word);
  if ((batchWord(batchIndex, 6u) & 0x10000u) == 0u) { return slot; }
  return logicalResource(slot);
}

// Row-material batches read each member's material through its primitive's
// logical material slot; a slot the captured resource root does not reach
// keeps the batch binding's material.
fn candidateMaterialDescriptor(batchIndex: u32, materialSlot: u32) -> u32 {
  if ((batchWord(batchIndex, 6u) & 0x20000u) != 0u && materialSlot != 0xffffffffu) {
    let descriptor = logicalResource(materialSlot);
    if (descriptor != 0xffffffffu) { return descriptor; }
  }
  return resourceDescriptor(batchIndex, 10u);
}

// Work stays dense across submesh executions; membership remains shared. The
// sorted execution starts make the lookup bounded by log2(batchCount).
fn candidateAt(work: u32) -> CandidateRecord {
  var low = 0u;
  var high = view.batchCount;
  while (low < high) {
    let middle = low + (high - low) / 2u;
    if (batchWord(middle, 7u) <= work) { low = middle + 1u; }
    else { high = middle; }
  }
  let batchIndex = low - 1u;
  var member = batchWord(batchIndex, 12u);
  var ordinal = work - batchWord(batchIndex, 7u);
  loop {
    if (member == 0u) { break; }
    let leftWeight = sceneInputs[member + 2u];
    let ownCount = sceneInputs[member + 3u];
    if (ordinal < leftWeight) {
      member = sceneInputs[member];
    } else if (ordinal - leftWeight < ownCount) {
      // Page records: [laneStart, physical, generation, sourceSlot, ordinalBase].
      let lane = ordinal - leftWeight;
      let records = sceneInputs[member + 4u];
      var low = 0u;
      var high = sceneInputs[member + 5u];
      while (high - low > 1u) {
        let middle = low + (high - low) / 2u;
        if (sceneInputs[records + middle * 5u] <= lane) { low = middle; } else { high = middle; }
      }
      let record = records + low * 5u;
      return CandidateRecord(sceneInputs[record + 1u], sceneInputs[record + 2u],
        lane - sceneInputs[record] + sceneInputs[record + 4u], batchIndex,
        sceneInputs[record + 3u]);
    } else {
      ordinal -= leftWeight + ownCount;
      member = sceneInputs[member + 1u];
    }
  }
  // Only a malformed work extent can reach null: never admit primitive zero.
  return CandidateRecord(0u, primitives[0].generation ^ 0xffffffffu, 0u, batchIndex, 0u);
}

// Bounds and displacement are shared resource records. Actual culling dereferences
// them without rewriting any primitive, instance, or candidate on asset edits.
fn candidateSkinBinding(candidate: CandidateRecord) -> u32 {
  if (view.skin.jointCapacity == 0u) { return 0xffffffffu; }
  return skinRowAddress(view.skin.currentRoot, 1u, candidate.sourceSlot);
}

fn skinDemandCandidateSlot(index: u32) -> u32 {
  let candidate = candidateAt(index);
  if (primitives[candidate.primitiveIndex].generation != candidate.generation ||
      batchWord(candidate.batchIndex, 1u) == 0u || isSuppressed(candidate.sourceSlot)) { return 0xffffffffu; }
  return candidate.sourceSlot;
}

fn candidatePrimitive(candidate: CandidateRecord, candidateIndex: u32) -> PrimitiveRecord {
  var primitive = primitives[candidate.primitiveIndex];
  if ((primitive.flags & 64u) != 0u) {
    let geometryAddress = resourceDescriptor(candidate.batchIndex, 11u);
    var geometryFlags = 0u;
    var boundsMin = vec3<f32>(0.0);
    var boundsMax = vec3<f32>(0.0);
    if (geometryAddress != 0u) {
      geometryFlags = sceneInputs[geometryAddress + ${GPU_MESH_DESCRIPTOR.flags}u];
      boundsMin = bitcast<vec3<f32>>(vec3<u32>(
        sceneInputs[geometryAddress + ${GPU_MESH_DESCRIPTOR.min}u],
        sceneInputs[geometryAddress + ${GPU_MESH_DESCRIPTOR.min + 1}u],
        sceneInputs[geometryAddress + ${GPU_MESH_DESCRIPTOR.min + 2}u]));
      boundsMax = bitcast<vec3<f32>>(vec3<u32>(
        sceneInputs[geometryAddress + ${GPU_MESH_DESCRIPTOR.max}u],
        sceneInputs[geometryAddress + ${GPU_MESH_DESCRIPTOR.max + 1}u],
        sceneInputs[geometryAddress + ${GPU_MESH_DESCRIPTOR.max + 2}u]));
    }
    let materialAddress = candidateMaterialDescriptor(candidate.batchIndex, primitive.materialIndex);
    var radius = 0.0;
    if (materialAddress != 0u) { radius = bitcast<f32>(sceneInputs[materialAddress + ${GPU_MATERIAL_DESCRIPTOR.radius}u]); }
    primitive.flags = (primitive.flags & ~2u) | (geometryFlags & 2u);
    if ((bitcast<u32>(radius) & 0x7f800000u) == 0x7f800000u) {
      primitive.flags &= ~2u;
    }
    primitive.localBoundsMin = boundsMin - vec3<f32>(radius);
    primitive.localBoundsMax = vec4<f32>(boundsMax + vec3<f32>(radius), 0.0);
  }
  if (candidateSkinBinding(candidate) != 0xffffffffu) {
    primitive.flags &= ~2u;
    let descriptor = skinDemandDescriptor(candidateIndex);
    if ((descriptor.w & 1u) == 0u) { primitive.instanceCount = 0u; return primitive; }
    if (view.capsuleDirectional != 0u && (primitive.flags & ${GPU_SCENE_PRIMITIVE_CAPSULE_SHADOW}u) != 0u) {
      let binding = candidateSkinBinding(candidate);
      let skeleton = skinRowAddress(view.skin.currentRoot, 0u, sceneInputs[binding + 2u]);
      let capsuleCount = sceneInputs[skeleton + 1u + descriptor.y * 16u];
      if (capsuleCount != 0xffffffffu && capsuleCount > 0u) {
        primitive.instanceCount = 0u;
        return primitive;
      }
    }
    let geometry = resourceDescriptor(candidate.batchIndex, 11u);
    let material = resourceDescriptor(candidate.batchIndex, 10u);
    if (geometry == 0u || geometry == 0xffffffffu || material == 0u || material == 0xffffffffu ||
        sceneInputs[material + ${GPU_MATERIAL_DESCRIPTOR.positionBounds}u] != 1u) { return primitive; }
    let envelope = sceneInputs[geometry + ${GPU_MESH_DESCRIPTOR.skinEnvelopes}u];
    let bounds = skinEnvelopeBounds(envelope, descriptor.z, descriptor.y,
      bitcast<f32>(sceneInputs[material + ${GPU_MATERIAL_DESCRIPTOR.radius}u]));
    if (bounds.valid != 0u) {
      primitive.flags |= 2u;
      primitive.localBoundsMin = bounds.minimum;
      primitive.localBoundsMax = vec4<f32>(bounds.maximum, 0.0);
    }
  }
  return primitive;
}

fn candidateRootWorld(candidate: CandidateRecord, primitive: PrimitiveRecord) -> mat4x4<f32> {
  if (candidateSkinBinding(candidate) != 0xffffffffu) {
    return mat4x4<f32>(vec4<f32>(1.0,0.0,0.0,0.0), vec4<f32>(0.0,1.0,0.0,0.0),
      vec4<f32>(0.0,0.0,1.0,0.0), vec4<f32>(0.0,0.0,0.0,1.0));
  }
  return transforms[primitive.transformIndex].currentWorld;
}

// Shared execution bytes; no material or LOD edit rewrites a candidate record.
fn batchLod(batchIndex: u32, level: u32) -> GpuSceneLod {
  let first = ${BATCH_HEADER_STRIDE / 4}u + level * ${LOD_ROW_STRIDE / 4}u;
  return GpuSceneLod(
    batchWord(batchIndex, first), batchWord(batchIndex, first + 1u),
    batchWord(batchIndex, first + 2u), batchWord(batchIndex, first + 3u),
    bitcast<i32>(batchWord(batchIndex, first + 4u)),
    bitcast<f32>(batchWord(batchIndex, first + 5u)),
    bitcast<f32>(batchWord(batchIndex, first + 6u)), batchWord(batchIndex, first + 7u),
  );
}

fn batchLods(batchIndex: u32, count: u32) -> array<GpuSceneLod, ${LOD_ROW_CAPACITY}> {
  var rows: array<GpuSceneLod, ${LOD_ROW_CAPACITY}>;
  for (var level = 0u; level < count; level += 1u) { rows[level] = batchLod(batchIndex, level); }
  return rows;
}

fn counterIndex(batchIndex: u32) -> u32 { return batchIndex * ${COUNTER_WORDS}u; }
fn overflowIndex(batchIndex: u32) -> u32 { return counterIndex(batchIndex) + 1u; }
fn lodCounterIndex(batchIndex: u32, level: u32) -> u32 {
  return counterIndex(batchIndex) + ${LOD_COUNTER_OFFSET}u + level;
}
fn levelVisibleIndex(batchIndex: u32, level: u32) -> u32 {
  return counterIndex(batchIndex) + ${LEVEL_VISIBLE_COUNTER_OFFSET}u + level;
}
fn earlyVisibleIndex(batchIndex: u32, level: u32) -> u32 {
  return counterIndex(batchIndex) + ${EARLY_VISIBLE_COUNTER_OFFSET}u + level;
}

// Instance visibility history lives after the batch counters, keyed by GPU
// Scene instance row. A row outside the bitmap, or an invalid history, is
// treated as previously visible so it draws in the early phase.
fn previouslyVisible(instanceIndex: u32) -> bool {
  if (view.occlusion.historyValid == 0u) { return true; }
  if ((instanceIndex >> 5u) >= view.occlusion.bitWords) { return true; }
  let word = atomicLoad(&counters[view.occlusion.previousBase + (instanceIndex >> 5u)]);
  return (word & (1u << (instanceIndex & 31u))) != 0u;
}

fn recordVisibility(instanceIndex: u32, visible: bool) {
  if ((instanceIndex >> 5u) >= view.occlusion.bitWords) { return; }
  let index = view.occlusion.nextBase + (instanceIndex >> 5u);
  let bit = 1u << (instanceIndex & 31u);
  if (visible) {
    atomicOr(&counters[index], bit);
  } else {
    atomicAnd(&counters[index], ~bit);
  }
}

fn isVisible(primitive: PrimitiveRecord, world: mat4x4<f32>) -> bool {
  // GPU Scene bounds are optional. A producer that has not published local
  // bounds still belongs in the GPU lane; keep it conservatively visible
  // instead of silently dropping a valid draw.
  if ((primitive.flags & 5u) != 5u) { return false; }
  if ((primitive.flags & 2u) == 0u) { return true; }
  let localCenter = (primitive.localBoundsMin.xyz + primitive.localBoundsMax.xyz) * 0.5;
  let localExtent = (primitive.localBoundsMax.xyz - primitive.localBoundsMin.xyz) * 0.5;
  let worldCenter = (world * vec4<f32>(localCenter, 1.0)).xyz;
  let worldExtent =
    abs(world[0].xyz) * localExtent.x +
    abs(world[1].xyz) * localExtent.y +
    abs(world[2].xyz) * localExtent.z;
  for (var planeIndex = 0u; planeIndex < 6u; planeIndex += 1u) {
    let plane = view.planes[planeIndex];
    let radius = dot(abs(plane.xyz), worldExtent);
    if (dot(plane.xyz, worldCenter) + plane.w < -radius) { return false; }
  }
  return true;
}

// Extent across the first two side planes (left, bottom). Orthographic
// shadow views are the only producers of a non-zero minimum diameter.
fn belowMinDiameter(primitive: PrimitiveRecord, world: mat4x4<f32>) -> bool {
  if (view.minCasterDiameter <= 0.0 || (primitive.flags & 2u) == 0u) { return false; }
  let localExtent = (primitive.localBoundsMax.xyz - primitive.localBoundsMin.xyz) * 0.5;
  let worldExtent =
    abs(world[0].xyz) * localExtent.x +
    abs(world[1].xyz) * localExtent.y +
    abs(world[2].xyz) * localExtent.z;
  let across = max(dot(abs(view.planes[0].xyz), worldExtent), dot(abs(view.planes[2].xyz), worldExtent));
  return across * 2.0 < view.minCasterDiameter;
}

// One height per primitive from its root transform: every instance of a
// primitive shares the root's LOD level, as on the CPU reference.
fn primitiveHeight(primitive: PrimitiveRecord, rootWorld: mat4x4<f32>) -> f32 {
  if ((primitive.flags & 2u) == 0u) { return LOD_INVALID_HEIGHT; }
  return projectedHeight(
    primitive.localBoundsMin.xyz,
    primitive.localBoundsMax.xyz,
    rootWorld,
    view.lod,
  );
}

// Append one visible item to the batch's per-level segment; each segment is an
// independent indirect command sized by the batch's visible capacity.
fn appendVisible(
  batchIndex: u32,
  segmentBase: u32,
  visibleCapacity: u32,
  level: u32,
  item: vec4<u32>,
  late: bool,
) {
  let localVisible = atomicAdd(&counters[levelVisibleIndex(batchIndex, level)], 1u);
  if (localVisible >= visibleCapacity) {
    atomicStore(&counters[overflowIndex(batchIndex)], 1u);
    return;
  }
  visibleIndices[segmentBase + localVisible] = item;
  if (late) {
    // Late appends continue after the early prefix finalizeView stored, so
    // the mirror index is the item's rank within the late suffix.
    let early = atomicLoad(&counters[earlyVisibleIndex(batchIndex, level)]);
    visibleIndices[view.occlusion.lateVisibleBase + segmentBase + localVisible - early] = item;
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn resetView(@builtin(global_invocation_id) id: vec3<u32>) {
  let batchIndex = id.x;
  if (batchIndex >= view.batchCount) { return; }
  for (var word = 0u; word < ${COUNTER_WORDS}u; word += 1u) {
    atomicStore(&counters[counterIndex(batchIndex) + word], 0u);
  }
  // Reuse the established submission overflow authority. A bounded claim or
  // palette admission failure must reject work explicitly, never hide Skin.
  if (view.skin.jointCapacity != 0u &&
      atomicLoad(&counters[view.skin.counterBase + 2u]) != 0u) {
    atomicStore(&counters[overflowIndex(batchIndex)], 1u);
  }
}

fn candidateLod(
  candidate: CandidateRecord,
  primitive: PrimitiveRecord,
  rootWorld: mat4x4<f32>,
) -> LodCrossfade {
  let lodCount = (batchWord(candidate.batchIndex, 6u) >> 1u) & 15u;
  if (lodCount <= 1u) { return LodCrossfade(0u, 0.0, false); }
  let rows = batchLods(candidate.batchIndex, lodCount);
  let crossfade = batchWord(candidate.batchIndex, 9u) != 0u;
  var height = primitiveHeight(primitive, rootWorld);
  if (view.lod.clamp != 0u && height >= 0.0) {
    height = max(height, lodCoarsestHeight(${SHADOW_LOD_COARSEST}u, rows, lodCount));
  }
  if (crossfade) {
    return lodCrossfade(height, rows, lodCount);
  }
  return LodCrossfade(
    selectLodLevel(height, 0u, false, rows, lodCount),
    0.0,
    false,
  );
}

fn appendCandidate(
  candidateIndex: u32,
  candidate: CandidateRecord,
  instanceIndex: u32,
  lod: LodCrossfade,
  late: bool,
) {
  let level = lod.level;
  var work = batchLod(candidate.batchIndex, level).indexCount;
  if (lod.paired) { work += batchLod(candidate.batchIndex, level + 1u).indexCount; }
  atomicAdd(&counters[counterIndex(candidate.batchIndex) + ${GEOMETRY_WORK_COUNTER_OFFSET}u], work);
  // The no-LOD baseline counts each source once, even during dual coverage.
  atomicAdd(
    &counters[counterIndex(candidate.batchIndex) + ${ROOT_GEOMETRY_WORK_COUNTER_OFFSET}u],
    batchLod(candidate.batchIndex, 0u).indexCount,
  );
  atomicAdd(&counters[counterIndex(candidate.batchIndex)], 1u);
  // Visible item ABI: x = GPU Scene instance row, y = scene material row,
  // z = the view candidate row for every deformation,
  // w = bitcast LOD crossfade. Submeshes share an instance row, so per-draw
  // tables (Surface frame rows) key by the candidate row.
  let materialAddress = candidateMaterialDescriptor(
    candidate.batchIndex,
    primitives[candidate.primitiveIndex].materialIndex,
  );
  var materialIndex = 0u;
  if (materialAddress != 0u) { materialIndex = sceneInputs[materialAddress + ${GPU_MATERIAL_DESCRIPTOR.payload}u]; }
  let item = vec4<u32>(
    instanceIndex,
    materialIndex,
    candidateIndex,
    bitcast<u32>(lod.fade),
  );
  appendVisible(
    candidate.batchIndex,
    batchWord(candidate.batchIndex, 0u) + level * batchWord(candidate.batchIndex, 8u),
    batchWord(candidate.batchIndex, 1u),
    level,
    item,
    late,
  );
  if (lod.paired) {
    appendVisible(
      candidate.batchIndex,
      batchWord(candidate.batchIndex, 0u) + (level + 1u) * batchWord(candidate.batchIndex, 8u),
      batchWord(candidate.batchIndex, 1u),
      level + 1u,
      vec4<u32>(item.xyz, bitcast<u32>(-lod.fade)),
      late,
    );
  }
}

struct EarlyCandidate {
  candidate: CandidateRecord,
  primitive: PrimitiveRecord,
  instanceIndex: u32,
  world: mat4x4<f32>,
  lod: LodCrossfade,
};

// Every early-phase test shared by the main and shadow cull entries.
fn admitEarly(candidateIndex: u32, out: ptr<function, EarlyCandidate>) -> bool {
  if (candidateIndex >= view.candidateCount) { return false; }
  let candidate = candidateAt(candidateIndex);
  if (batchWord(candidate.batchIndex, 1u) == 0u) { return false; }
  let primitive = candidatePrimitive(candidate, candidateIndex);
  if (primitive.generation != candidate.generation) { return false; }
  if (candidate.instanceOrdinal >= primitive.instanceCount) { return false; }
  let instanceIndex = primitive.instanceStart + candidate.instanceOrdinal;
  let instance = instances[instanceIndex];
  let rootWorld = candidateRootWorld(candidate, primitive);
  let world = rootWorld * transforms[instance.transformIndex].currentWorld;
  let lod = candidateLod(candidate, primitive, rootWorld);
  // Selector counters describe the complete LOD population, including
  // candidates outside the frustum and candidates suppressed by the
  // per-view bitmap. Submission counters below remain compacted draw facts.
  atomicAdd(&counters[lodCounterIndex(candidate.batchIndex, lod.level)], 1u);
  if (lod.paired) { atomicAdd(&counters[lodCounterIndex(candidate.batchIndex, lod.level + 1u)], 1u); }
  if (isSuppressed(candidate.sourceSlot)) { return false; }
  if (!isVisible(primitive, world)) { return false; }
  if (belowMinDiameter(primitive, world)) {
    atomicAdd(&counters[counterIndex(candidate.batchIndex) + ${TEXEL_CULLED_COUNTER_OFFSET}u], 1u);
    return false;
  }
  // Two-phase occlusion: the early phase draws only last frame's visible
  // set; cullViewLate tests the rest against this frame's early depth.
  if (view.occlusion.enabled != 0u && !previouslyVisible(instanceIndex)) { return false; }
  *out = EarlyCandidate(candidate, primitive, instanceIndex, world, lod);
  return true;
}

fn appendEarly(candidateIndex: u32, early: EarlyCandidate) {
  appendCandidate(
    candidateIndex,
    early.candidate,
    early.instanceIndex,
    early.lod,
    false,
  );
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn cullView(@builtin(global_invocation_id) id: vec3<u32>) {
  var early: EarlyCandidate;
  if (admitEarly(id.x, &early)) { appendEarly(id.x, early); }
}

fn linearOcclusionDepth(camera: PyramidCamera, value: f32) -> f32 {
  if (camera.orthographic != 0u) { return camera.far - value * (camera.far - camera.near); }
  return camera.near / (value + (1.0 - value) * (camera.near / camera.far));
}

// Conservative HZB test against the furthest-depth pyramid. Pyramid texel j
// of level L covers uv [j / w_L, (j + 1) / w_L] (the reductions ceil their
// footprint end), so the texels floor(uv * w_L) spanning the inflated screen
// rectangle cover every pixel the bounds can touch. Occluded only when the
// bounds' nearest point lies behind the furthest depth of all those texels.
fn occludedByPyramid(primitive: PrimitiveRecord, world: mat4x4<f32>) -> bool {
  if ((primitive.flags & 2u) == 0u) { return false; }
  let camera = view.occlusion.camera;
  let clipFromLocal = camera.viewProjection * world;
  var uvMin = vec2<f32>(1.0, 1.0);
  var uvMax = vec2<f32>(0.0, 0.0);
  var nearestDepth = 0.0;
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let clip = clipFromLocal * vec4<f32>(boundsCorner(primitive, corner), 1.0);
    // A corner at or behind the eye plane has no bounded projection.
    if (clip.w <= 1e-6) { return false; }
    let ndc = clip.xyz / clip.w;
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    uvMin = min(uvMin, uv);
    uvMax = max(uvMax, uv);
    nearestDepth = max(nearestDepth, ndc.z);
  }
  return screenRectOccluded(camera, uvMin, uvMax, nearestDepth, 1u);
}

fn boundsCorner(primitive: PrimitiveRecord, corner: u32) -> vec3<f32> {
  return vec3<f32>(
    select(primitive.localBoundsMin.x, primitive.localBoundsMax.x, (corner & 1u) != 0u),
    select(primitive.localBoundsMin.y, primitive.localBoundsMax.y, (corner & 2u) != 0u),
    select(primitive.localBoundsMin.z, primitive.localBoundsMax.z, (corner & 4u) != 0u),
  );
}

// One level-0 pyramid texel (two full-resolution pixels) absorbs TAA jitter
// and rasterization rounding at a screen rectangle's edge.
fn pyramidTexelUv() -> vec2<f32> {
  return 1.0 / vec2<f32>(textureDimensions(occlusionPyramid, 0));
}

// The pyramid half of the HZB test: a screen rectangle whose nearest reversed-Z
// depth is nearestDepth. Every caller shares this footprint, level choice and
// margin, so the main and shadow tests cannot drift apart; maxTexelSpan only
// trades fetches for a finer level (1: 2x2, 3: 4x4).
fn screenRectOccluded(
  camera: PyramidCamera,
  uvMin: vec2<f32>,
  uvMax: vec2<f32>,
  nearestDepth: f32,
  maxTexelSpan: u32,
) -> bool {
  // Reversed Z: a corner in front of the near plane is never occluded.
  if (nearestDepth >= 1.0) { return false; }
  let middle = (uvMin + uvMax) * 0.5;
  let halfSize = (uvMax - uvMin) * 0.5 * camera.footprintScale;
  let extent0 = textureDimensions(occlusionPyramid, 0);
  let size0 = vec2<f32>(extent0);
  let pad = pyramidTexelUv();
  let lo = clamp(middle - halfSize - pad, vec2<f32>(0.0), vec2<f32>(1.0));
  let hi = clamp(middle + halfSize + pad, vec2<f32>(0.0), vec2<f32>(1.0));
  // Written so a non-finite footprint (NaN compares false) stays visible.
  if (!all(lo < hi)) { return false; }
  let levels = textureNumLevels(occlusionPyramid);
  let span = max((hi - lo).x * size0.x, (hi - lo).y * size0.y);
  let texelsPerSide = f32((maxTexelSpan + 1u) / 2u);
  var level = u32(max(0.0, floor(log2(max(span / texelsPerSide, 1.0)))));
  level = min(level, levels - 1u);
  var texelMin = vec2<u32>(0u);
  var texelMax = vec2<u32>(0u);
  loop {
    // Inline copy of forgeax_depth_pyramid::sample::depthPyramidLevelSize;
    // this raw WGSL string has no import resolution.
    let size = max(extent0 >> vec2<u32>(level), vec2<u32>(1u));
    texelMin = min(vec2<u32>(lo * vec2<f32>(size)), size - vec2<u32>(1u));
    texelMax = min(vec2<u32>(hi * vec2<f32>(size)), size - vec2<u32>(1u));
    if (all(texelMax - texelMin <= vec2<u32>(maxTexelSpan)) || level + 1u >= levels) { break; }
    level += 1u;
  }
  var furthest = 0.0;
  for (var y = texelMin.y; y <= texelMax.y; y += 1u) {
    for (var x = texelMin.x; x <= texelMax.x; x += 1u) {
      furthest = max(
        furthest,
        textureLoad(occlusionPyramid, vec2<i32>(vec2<u32>(x, y)), i32(level)).r,
      );
    }
  }
  let nearest = linearOcclusionDepth(camera, max(nearestDepth, 0.0));
  // A relative margin keeps coplanar geometry (decals, the occluder's own
  // bounds) visible under float linearization error.
  return nearest > furthest * 1.0001;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn cullViewLate(@builtin(global_invocation_id) id: vec3<u32>) {
  let candidateIndex = id.x;
  if (candidateIndex >= view.candidateCount) { return; }
  let candidate = candidateAt(candidateIndex);
  if (batchWord(candidate.batchIndex, 1u) == 0u) { return; }
  let primitive = candidatePrimitive(candidate, candidateIndex);
  if (primitive.generation != candidate.generation) { return; }
  if (candidate.instanceOrdinal >= primitive.instanceCount) { return; }
  let instanceIndex = primitive.instanceStart + candidate.instanceOrdinal;
  let instance = instances[instanceIndex];
  let rootWorld = candidateRootWorld(candidate, primitive);
  let world = rootWorld * transforms[instance.transformIndex].currentWorld;
  var visible =
    !isSuppressed(candidate.sourceSlot) &&
    isVisible(primitive, world) &&
    !belowMinDiameter(primitive, world);
  if (visible && occludedByPyramid(primitive, world)) {
    visible = false;
    atomicAdd(&counters[counterIndex(candidate.batchIndex) + ${OCCLUSION_CULLED_COUNTER_OFFSET}u], 1u);
  }
  // Every submesh candidate of one instance row evaluates the same bounds,
  // so their writes agree; the previous region is read-only this frame.
  recordVisibility(instanceIndex, visible);
  if (!visible || previouslyVisible(instanceIndex)) { return; }
  appendCandidate(
    candidateIndex,
    candidate,
    instanceIndex,
    candidateLod(candidate, primitive, rootWorld),
    true,
  );
}

override INDIRECT_FIRST_INSTANCE: bool = false;

fn finalizeBatch(batchIndex: u32, late: bool) {
  if (batchIndex >= view.batchCount) { return; }
  // Overflow is a failed generation, never a partially valid draw. Keep the
  // telemetry flag for the producer retry path but emit zero instances so no
  // subset of a visible batch reaches the rasterizer.
  let overflowed = atomicLoad(&counters[overflowIndex(batchIndex)]) != 0u;
  let capacity = batchWord(batchIndex, 1u);
  let flags = batchWord(batchIndex, 6u);
  let indexed = (flags & 1u) != 0u;
  let levelCount = max(1u, (flags >> 1u) & 15u);
  for (var level = 0u; level < levelCount; level += 1u) {
    var visibleCount = min(atomicLoad(&counters[levelVisibleIndex(batchIndex, level)]), capacity);
    if (overflowed) { visibleCount = 0u; }
    let args = (batchWord(batchIndex, 5u) + level) * 5u;
    var drawCount = batchWord(batchIndex, 2u);
    var drawFirst = batchWord(batchIndex, 3u);
    var drawBaseVertex: i32 = 0;
    if (capacity > 0u) {
      let lod = batchLod(batchIndex, level);
      drawCount = lod.indexCount;
      if (indexed) {
        drawFirst = lod.firstIndex;
        drawBaseVertex = lod.baseVertex;
      }
    } else if (indexed) {
      drawBaseVertex = bitcast<i32>(batchWord(batchIndex, 4u));
    }
    indirectArgs[args] = drawCount;
    indirectArgs[args + 1u] = visibleCount;
    indirectArgs[args + 2u] = drawFirst;
    let segmentBase = batchWord(batchIndex, 0u) + level * batchWord(batchIndex, 8u);
    let firstInstance = select(0u, segmentBase, INDIRECT_FIRST_INSTANCE);
    indirectArgs[args + 3u] = select(firstInstance, bitcast<u32>(drawBaseVertex), indexed);
    indirectArgs[args + 4u] = select(0u, firstInstance, indexed);
    if (late) {
      // Late items were appended after the early prefix of the same segment
      // and mirrored from the segment start of the late region: the late
      // command draws that mirror, the main command the union.
      let early = min(atomicLoad(&counters[earlyVisibleIndex(batchIndex, level)]), visibleCount);
      let lateArgs = view.occlusion.lateArgsBase + args;
      indirectArgs[lateArgs] = drawCount;
      indirectArgs[lateArgs + 1u] = visibleCount - early;
      indirectArgs[lateArgs + 2u] = drawFirst;
      let lateFirstInstance = select(0u, view.occlusion.lateVisibleBase + segmentBase, INDIRECT_FIRST_INSTANCE);
      indirectArgs[lateArgs + 3u] = select(lateFirstInstance, bitcast<u32>(drawBaseVertex), indexed);
      indirectArgs[lateArgs + 4u] = select(0u, lateFirstInstance, indexed);
    } else {
      atomicStore(&counters[earlyVisibleIndex(batchIndex, level)], visibleCount);
    }
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn finalizeView(@builtin(global_invocation_id) id: vec3<u32>) {
  finalizeBatch(id.x, false);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn finalizeViewLate(@builtin(global_invocation_id) id: vec3<u32>) {
  finalizeBatch(id.x, true);
}
`;

/**
 * The main-camera shadow caster cull. Only views that receive a camera cull
 * input compile it, so every other view keeps the smaller module.
 */
export const GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL = /* wgsl */ `${GPU_DRIVEN_VIEW_WGSL}
// Shadow maps use reversed Z with a zero clear, and a receiver is shadowed
// only by a stored depth greater than its own. Every receiver this caster can
// darken therefore lies in its dilated light-space rectangle between depth 0
// (the far plane) and the caster's nearest light depth.
fn shadowReceiversHidden(primitive: PrimitiveRecord, world: mat4x4<f32>) -> bool {
  let cull = view.shadowCamera;
  if (cull.enabled == 0u) { return false; }
  var worldMin = vec3<f32>(3.0e38);
  var worldMax = vec3<f32>(-3.0e38);
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let point = (world * vec4<f32>(boundsCorner(primitive, corner), 1.0)).xyz;
    worldMin = min(worldMin, point);
    worldMax = max(worldMax, point);
  }
  // The caster's own box lies inside its receiver prism, so a box the
  // pyramid cannot hide keeps the caster without the slab walk. Most
  // casters of an unoccluded view exit here after one 4x4 test.
  if (casterBoxVisible(cull.camera, worldMin, worldMax)) { return false; }
  // A receiver samples the map at its position offset along its normal.
  worldMin -= vec3<f32>(cull.worldDilation);
  worldMax += vec3<f32>(cull.worldDilation);
  var lightMin = vec2<f32>(3.0e38);
  var lightMax = vec2<f32>(-3.0e38);
  var lightNearest = 0.0;
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let point = vec3<f32>(
      select(worldMin.x, worldMax.x, (corner & 1u) != 0u),
      select(worldMin.y, worldMax.y, (corner & 2u) != 0u),
      select(worldMin.z, worldMax.z, (corner & 4u) != 0u),
    );
    let clip = cull.lightViewProjection * vec4<f32>(point, 1.0);
    if (clip.w <= 1e-6) { return false; }
    let ndc = clip.xyz / clip.w;
    lightMin = min(lightMin, ndc.xy);
    lightMax = max(lightMax, ndc.xy);
    lightNearest = max(lightNearest, ndc.z);
  }
  // Receivers outside this map never sample it.
  lightMin = max(lightMin - vec2<f32>(cull.ndcDilation), vec2<f32>(-1.0));
  lightMax = min(lightMax + vec2<f32>(cull.ndcDilation), vec2<f32>(1.0));
  if (!all(lightMin < lightMax)) { return false; }
  let lightTop = clamp(lightNearest, 0.0, 1.0);
  // The prism reaches the light's far plane, usually far below the visible
  // receivers. One screen rectangle for all of it spans a coarse pyramid
  // level whose texels include the sky, so each depth slab is tested on its
  // own and the caster is skipped only when every slab is hidden. A visible
  // caster usually shades itself, so walking down from its own slab exits at
  // the first iteration.
  for (var step = 0u; step < ${SHADOW_CAMERA_CULL_SLABS}u; step += 1u) {
    let slab = ${SHADOW_CAMERA_CULL_SLABS}u - 1u - step;
    let slabFar = lightTop * f32(slab) / ${SHADOW_CAMERA_CULL_SLABS}.0;
    let slabNear = lightTop * f32(slab + 1u) / ${SHADOW_CAMERA_CULL_SLABS}.0;
    if (!lightSlabHidden(cull, lightMin, lightMax, slabFar, slabNear)) { return false; }
  }
  return true;
}

// True only for a box wholly in front of the camera, overlapping the screen,
// and not proven hidden; any other box falls through to the slab walk.
fn casterBoxVisible(camera: PyramidCamera, worldMin: vec3<f32>, worldMax: vec3<f32>) -> bool {
  var uvMin = vec2<f32>(3.0e38);
  var uvMax = vec2<f32>(-3.0e38);
  var nearestDepth = -3.0e38;
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let point = vec3<f32>(
      select(worldMin.x, worldMax.x, (corner & 1u) != 0u),
      select(worldMin.y, worldMax.y, (corner & 2u) != 0u),
      select(worldMin.z, worldMax.z, (corner & 4u) != 0u),
    );
    let clip = camera.viewProjection * vec4<f32>(point, 1.0);
    if (clip.w <= 1e-6) { return false; }
    let ndc = clip.xyz / clip.w;
    uvMin = min(uvMin, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
    uvMax = max(uvMax, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
    nearestDepth = max(nearestDepth, ndc.z);
  }
  if (any(uvMax <= vec2<f32>(0.0)) || any(uvMin >= vec2<f32>(1.0)) || nearestDepth < 0.0) {
    return false;
  }
  return !screenRectOccluded(camera, uvMin, uvMax, nearestDepth, 3u);
}

fn lightSlabHidden(
  cull: ShadowCameraCull,
  lightMin: vec2<f32>,
  lightMax: vec2<f32>,
  slabFar: f32,
  slabNear: f32,
) -> bool {
  let camera = cull.camera;
  // Nothing nearer than the near plane is rasterized, so the slab is clipped
  // there instead of being rejected when the long prism passes the camera.
  let nearW = select(camera.near, 1e-6, camera.orthographic != 0u);
  var clips: array<vec4<f32>, 8>;
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let lightPoint = vec4<f32>(
      select(lightMin.x, lightMax.x, (corner & 1u) != 0u),
      select(lightMin.y, lightMax.y, (corner & 2u) != 0u),
      select(slabFar, slabNear, (corner & 4u) != 0u),
      1.0,
    );
    let worldPoint = cull.lightInverse * lightPoint;
    if (!(abs(worldPoint.w) > 1e-12)) { return false; }
    clips[corner] = camera.viewProjection * vec4<f32>(worldPoint.xyz / worldPoint.w, 1.0);
  }
  var uvMin = vec2<f32>(3.0e38);
  var uvMax = vec2<f32>(-3.0e38);
  var nearestDepth = -3.0e38;
  var inFront = 0u;
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let clip = clips[corner];
    if (clip.w < nearW) { continue; }
    inFront += 1u;
    let ndc = clip.xyz / clip.w;
    uvMin = min(uvMin, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
    uvMax = max(uvMax, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
    nearestDepth = max(nearestDepth, ndc.z);
  }
  if (inFront == 0u) { return true; }
  if (inFront < 8u) {
    // The box is convex, so its visible part is bounded by the in-front
    // corners plus each edge's crossing of the near plane.
    for (var edge = 0u; edge < 12u; edge += 1u) {
      // Edge e runs along axis bit 1 << (e / 4); its other two corner bits
      // are e % 4 spread around that axis.
      let axis = 1u << (edge / 4u);
      let rest = edge % 4u;
      let below = rest & (axis - 1u);
      let start = below | ((rest - below) << 1u);
      let end = start | axis;
      let p = clips[start];
      let q = clips[end];
      if ((p.w < nearW) == (q.w < nearW)) { continue; }
      let clip = mix(p, q, (nearW - p.w) / (q.w - p.w));
      let ndc = clip.xyz / clip.w;
      uvMin = min(uvMin, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
      uvMax = max(uvMax, vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5));
      nearestDepth = max(nearestDepth, ndc.z);
    }
  }
  // No receiver of the slab lies on screen or inside the far plane.
  let pad = pyramidTexelUv();
  if (any(uvMax < -pad) || any(uvMin > 1.0 + pad) || nearestDepth < 0.0) { return true; }
  // A slab seen from a low camera hugs the horizon; the coarse 2x2 level would
  // reach the sky above the occluders, so the rarer shadow test pays 4x4.
  return screenRectOccluded(camera, uvMin, uvMax, nearestDepth, 3u);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn cullViewShadowCamera(@builtin(global_invocation_id) id: vec3<u32>) {
  var early: EarlyCandidate;
  if (!admitEarly(id.x, &early)) { return; }
  if (shadowReceiversHidden(early.primitive, early.world)) {
    atomicAdd(&counters[counterIndex(early.candidate.batchIndex) + ${CAMERA_CULLED_COUNTER_OFFSET}u], 1u);
    return;
  }
  appendEarly(id.x, early);
}
`;

interface ViewBuffers {
  readonly batches: Buffer;
  readonly view: Buffer;
  readonly counters: Buffer;
  readonly visible: Buffer;
  readonly indirect: Buffer;
  readonly lodReadback: Buffer;
  readonly visibleSurfaceRows?: Buffer;
}

type MutableViewBuffers = { -readonly [Name in keyof ViewBuffers]: ViewBuffers[Name] };

type LodTelemetryCopy = {
  readonly buffers: ViewBuffers;
  readonly plan: SubmissionPlan;
  readonly resourceGeneration: number;
  readonly indirectBufferIdentity: number;
  readonly indirectReadbackOffset: number;
  readonly surfaceReadbackSnapshot?: () => SurfaceGpuReadbackSnapshot | undefined;
  readonly submit?: ViewTelemetrySubmit;
  /** The copy follows the late phase, so its counters include occlusion facts. */
  readonly occlusion: boolean;
};

/**
 * Camera facts for the late HZB test. They must describe the same view that
 * rasterized the pyramid source; `historyKey` changes (camera switch, resize,
 * history reset) discard the per-instance visibility history.
 */
export interface GpuDrivenOcclusionCamera {
  /** Unjittered projection * view, column-major. */
  readonly viewProjection: Float32Array;
  readonly near: number;
  readonly far: number;
  readonly orthographic: boolean;
  readonly historyKey: string;
}

/**
 * Main-camera visibility test for a shadow view's casters. The widening is the
 * receiver's sampling footprint, so a skipped caster darkens no visible pixel.
 */
export interface GpuDrivenShadowCameraCull {
  readonly camera: GpuDrivenOcclusionCamera;
  /** The shadow view's light view-projection, column-major. */
  readonly lightViewProjection: Float32Array;
  /** Light NDC widening for the receiver filter kernel. */
  readonly ndcDilation: number;
  /** World widening for the receiver's normal offset. */
  readonly worldDilation: number;
}

export interface GpuDrivenLodSubmitIdentity {
  readonly frameId: number;
  readonly deviceGeneration: number;
}

/** Identity captured by the existing shadow telemetry copy, never by map completion. */
export interface GpuDrivenCullingProducerReceipt extends GpuDrivenLodSubmitIdentity {
  readonly graphGeneration?: number;
  readonly viewKey: string;
  readonly viewGeneration: number;
  readonly sourceRevision: number;
}

export interface GpuDrivenCullingObservation {
  readonly producer: GpuDrivenCullingProducerReceipt;
  /** Compute buffers captured by the copy, excluding the view material-resource generation. */
  readonly resourceGeneration: number;
  readonly indirectBufferIdentity: number;
  readonly planRevision: number;
  readonly candidateCount: number;
  readonly batchCount: number;
  /** Compacted candidate/instance rows; not entities, triangles or triangle clusters. */
  readonly visible: number;
  /** An overflowing batch contributes zero visible rows, as in readLodSelection. */
  readonly overflow: boolean;
  readonly texelCulled: number;
  readonly cameraCulled: number;
}

type ViewTelemetrySubmit = GpuDrivenLodSubmitIdentity & {
  readonly cullingProducer?: GpuDrivenCullingProducerReceipt;
};

export interface GpuDrivenViewGraphResources {
  readonly visibleSurfaceRows?: GraphBuffer;
  readonly primitive: GraphBuffer;
  readonly instance: GraphBuffer;
  readonly transform: GraphBuffer;
  readonly material: GraphBuffer;
  readonly visible: GraphBuffer;
  readonly indirect: GraphBuffer;
  readonly overflow: GraphBuffer;
  /**
   * Present when `addPasses` reserved the two-phase occlusion path. The caller
   * adds the late cull after its early depth pyramid exists; until then the
   * early phase draws every frustum-visible candidate.
   */
  readonly addLateOcclusion?: (
    pyramid: GraphTextureView,
  ) => Result<GpuDrivenLateOcclusionGraph, RenderGraphError>;
}

export interface GpuDrivenLateOcclusionGraph {
  readonly passNames: readonly string[];
  /** Byte offset of the late-phase indirect region inside `indirect`. */
  readonly lateIndirectByteOffset: number;
  /**
   * First item of the late-phase mirror inside `visible`: the late command of
   * a segment at item `base` draws the window starting at
   * `lateVisibleBase + base` from instance zero.
   */
  readonly lateVisibleBase: number;
}

export interface GpuDrivenViewInspection {
  readonly shadowBundles?: PreparedRasterCounters;
  readonly topologyRevision: number | undefined;
  readonly candidateCount: number;
  readonly batchCount: number;
  readonly visibleCapacity: number;
  readonly candidateCapacity: number;
  /** Allocated visible-index capacity; distinct from logical candidates. */
  readonly visibleBufferCapacity: number;
  readonly batchCapacity: number;
  readonly indirectCapacity: number;
  readonly updateCount: number;
  readonly uploadBytes: number;
  /** Shared arena bytes actually uploaded by this update; other views may reuse them. */
  readonly sharedInputUploadBytes: number;
  /** Bytes of the per-primitive suppression bitmap uploaded this frame (dirty words only). */
  readonly suppressionUploadBytes: number;
  readonly batchUploadBytes: number;
  readonly viewConstantsUploadBytes: number;
  readonly bindGroupCreates: number;
  readonly bufferRebuilds: number;
  readonly resourceGeneration: number;
  /** Logical Engine allocation facts; physical VRAM residency is unknown. */
  readonly resourceAllocation: import('../inspection-types').GpuResourceAllocationInspection;
}

export interface GpuDrivenViewBufferCapacities {
  readonly candidate: number;
  readonly visible: number;
  readonly batch: number;
  readonly indirect: number;
}

export interface GpuDrivenLodSelectionInspection {
  /** Exact resource generation whose selector rows were copied. */
  readonly resourceGeneration?: number;
  readonly candidateCount: number;
  readonly batchCount: number;
  readonly indirectDrawCount: number;
  readonly visible: number;
  readonly occluded: number;
  /** True when the selector had to reject or clamp a visible candidate. */
  readonly overflow: boolean;
  readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
  readonly batches: readonly {
    readonly batchId: number;
    readonly candidateCount: number;
    readonly visible: number;
    readonly occluded: number;
    readonly overflow: boolean;
    readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
  }[];
  readonly worldSelections?: readonly {
    readonly worldKey: number;
    readonly primitiveSlot: number;
    readonly slotGeneration: number;
    readonly candidateCount: number;
    readonly visible: number;
    readonly occluded: number;
    readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
  }[];
  readonly geometryWork: number;
  readonly rootGeometryWork: number;
  /** In-frustum candidates dropped below the view's minimum caster diameter. */
  readonly texelCulled: number;
  /** Shadow casters whose shadowed receivers the main camera cannot see. */
  readonly cameraCulled: number;
  /**
   * Two-phase HZB facts when the submitted graph ran the late phase:
   * candidates the pyramid rejected and visible items drawn only late.
   */
  readonly occlusion?: { readonly culled: number; readonly late: number };
  /**
   * Actual visible rows copied from the submitted GPU selector, each with the
   * slot generation encoded in that submission; a reader joins only rows whose
   * current generation still matches.
   */
  readonly actualMembers: readonly {
    readonly batchId: number;
    readonly primitiveIndex: number;
    readonly generation: number;
    readonly drawItemIndex: number;
    readonly instanceOrdinal: number;
  }[];
  /** Surface subset projected by the material producer after readback. */
  readonly surfaceActualMemberIds?: readonly string[];
  /** Decoded indexed/non-indexed command words for the exact Surface copy. */
  readonly surfaceIndirectParameters?: readonly SurfaceGpuIndirectParameters[];
  /** Fail-closed readback reason when the copied command range is unusable. */
  readonly surfaceIndirectReadbackError?: SurfaceGpuIndirectReadbackError;
  /** Exact Surface recording whose selector bytes were copied. */
  readonly surfaceReadback?: SurfaceGpuReadbackSnapshot;
  /** Public receipt identity captured when the telemetry copy was encoded. */
  readonly submit?: GpuDrivenLodSubmitIdentity;
}

function nextCapacity(required: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, required)));
}

/** Raster binds windows at 256-byte storage offsets: 64 visible entries. */
const VISIBLE_ALIGNMENT = 64;
const VISIBLE_ENTRY_BYTES = 16;
const VISIBLE_GROWTH = 1.5;
/** First-allocation headroom: one small window relocation must not rebuild every binding. */
const VISIBLE_HEADROOM = 1.25;

function alignVisible(entries: number): number {
  return Math.ceil(Math.max(VISIBLE_ALIGNMENT, entries) / VISIBLE_ALIGNMENT) * VISIBLE_ALIGNMENT;
}

/**
 * Visible-index allocation for one view: the aligned requirement plus bounded
 * headroom on first allocation, then geometric growth, so a stable workload
 * never reallocates and a growing one reallocates amortized O(1) times. Slack
 * never exceeds what the device can bind; the requirement itself is never clamped.
 */
export function growGpuDrivenVisibleCapacity(
  current: number,
  required: number,
  maxEntries: number,
): number {
  const needed = alignVisible(required);
  if (needed <= current) return current;
  const grown = alignVisible(
    current === 0 ? Math.ceil(needed * VISIBLE_HEADROOM) : Math.ceil(current * VISIBLE_GROWTH),
  );
  const ceiling = Math.floor(Math.max(0, maxEntries) / VISIBLE_ALIGNMENT) * VISIBLE_ALIGNMENT;
  return Math.max(needed, Math.min(grown, ceiling));
}

/**
 * Derive each GPU-driven allocation from its own logical capacity domain.
 * Candidate records are dense; visible indices use the sparse, 64-entry
 * aligned ranges assigned by BatchTopology. Keeping these values separate is
 * what makes a large LOD candidate set bounded instead of multiplying the
 * candidate record and inline LOD-row buffers by the visible address space.
 */
export function deriveGpuDrivenViewBufferCapacities(
  plan: Pick<SubmissionPlan, 'candidateCount' | 'batches'>,
): GpuDrivenViewBufferCapacities {
  const cached = viewBufferCapacities.get(plan);
  if (cached !== undefined) return cached;
  const memberships = new Set<FrameList<GpuDrivenCandidate>>();
  let candidateCount = 0;
  let visible = 0;
  let indirect = 0;
  for (const batch of plan.batches) {
    const members = batch.candidates;
    if (!memberships.has(members)) {
      memberships.add(members);
      candidateCount += members.length;
    }
    // Derived from the batch segments the kernels address, so a plan whose
    // LOD chain grew never lets a level segment write past the buffer. Exact
    // (aligned): growth slack is the allocator's decision, bounded by limits.
    visible = Math.max(visible, batch.visibleBase + batchVisibleSpan(batch));
    indirect = Math.max(
      indirect,
      batch.indirectOffset / INDIRECT_COMMAND_BYTES + batchLodLevelCount(batch),
    );
  }
  const capacities = Object.freeze({
    candidate: nextCapacity(candidateCount),
    visible: alignVisible(visible),
    batch: nextCapacity(plan.batches.length),
    indirect: nextCapacity(indirect),
  });
  // Plans are immutable and shared by every view (cascade, layer) drawing them.
  viewBufferCapacities.set(plan, capacities);
  return capacities;
}
const viewBufferCapacities = new WeakMap<object, GpuDrivenViewBufferCapacities>();

function bufferBinding(buffer: Buffer): {
  readonly kind: 'buffer';
  readonly value: { buffer: Buffer };
} {
  return { kind: 'buffer', value: { buffer } };
}

interface EncodedViewTopology {
  readonly batchBytes: Uint8Array;
  /** Fixed source batches in row order; an identical row keeps its encoded bytes. */
  readonly rows?: readonly GpuDrivenBatch[];
  /** Each row's logical member root; header word 12 of that row holds its physical address. */
  readonly members: readonly FrameList<GpuDrivenCandidate>[];
}
/** Rows a successor searches past its cursor for a retained owner; local edits stay in range. */
const ROW_LOOKAHEAD = 8;
const MEMBER_ADDRESS_OFFSET = 48;
const encodedTopologies = new WeakMap<GpuScene, WeakMap<SubmissionPlan, EncodedViewTopology>>();

/**
 * Patch the current physical member roots into a topology template. The
 * template stays shared until an address differs; fixed task plans cache
 * their patched copy for the scene.
 */
function patchMemberAddresses(
  plan: SubmissionPlan,
  scene: GpuScene,
  inputs: GpuInputReadFrame,
  template: EncodedViewTopology,
): EncodedViewTopology {
  let batchBytes = template.batchBytes;
  let patched = false;
  let header = new DataView(batchBytes.buffer);
  const { members } = template;
  for (let row = 0; row < members.length; row++) {
    // Rows sharing one root resolve it once through the read frame's memo.
    const address = inputs.members(members[row] as FrameList<GpuDrivenCandidate>);
    const offset = row * BATCH_STRIDE + MEMBER_ADDRESS_OFFSET;
    if (header.getUint32(offset, true) === address) continue;
    if (!patched) {
      batchBytes = batchBytes.slice();
      header = new DataView(batchBytes.buffer);
      patched = true;
    }
    header.setUint32(offset, address, true);
  }
  if (!patched) return template;
  const encoded = { ...template, batchBytes };
  if (hasFixedTaskHeaders(plan)) encodedTopologies.get(scene)?.set(plan, encoded);
  return encoded;
}

/** The retained row of `batch` at or shortly after `cursor`, if its owner is unchanged. */
function retainedRow(
  rows: readonly GpuDrivenBatch[],
  cursor: number,
  batch: GpuDrivenBatch,
): number | undefined {
  const end = Math.min(rows.length, cursor + ROW_LOOKAHEAD);
  for (let row = cursor; row < end; row++) if (rows[row] === batch) return row;
  return undefined;
}

/** Raster batch ABI flags; material rows may be selected by each candidate. */
function rasterBatchFlags(batch: GpuDrivenBatch, lodCount: number): number {
  return (
    (batch.key.drawKind === 'indexed' ? 1 : 0) |
    (lodCount << 1) |
    (batch.logicalResources === true ? 0x10000 : 0) |
    (batch.key.rowMaterial === true ? 0x20000 : 0)
  );
}

/** Task headers retain logical member roots; physical roots are leased on each read. */
function encodedViewTopology(
  plan: SubmissionPlan,
  scene: GpuScene,
  previous?: EncodedViewTopology,
): EncodedViewTopology {
  let owner = encodedTopologies.get(scene);
  const fixed = hasFixedTaskHeaders(plan);
  const cached = fixed ? owner?.get(plan) : undefined;
  if (cached !== undefined) return cached;
  // A replaced fixed plan copies each identical logical row from the last
  // encoding of the same scene; only edited rows and shifted bases re-encode.
  // Plans keep stable batch order, so rows are matched by owner from a cursor
  // that follows the predecessor: an insertion or removal does not re-encode
  // later rows, and a moved row only rewrites its candidate base word.
  const previousRows = fixed ? previous?.rows : undefined;
  const previousWords =
    previousRows === undefined || previous === undefined
      ? undefined
      : new Uint32Array(
          previous.batchBytes.buffer,
          previous.batchBytes.byteOffset,
          previous.batchBytes.byteLength / 4,
        );
  let cursor = 0;
  if (owner === undefined) {
    owner = new WeakMap();
    encodedTopologies.set(scene, owner);
  }
  const rows: GpuDrivenBatch[] = [];
  const members: FrameList<GpuDrivenCandidate>[] = [];
  const batchBytes = new Uint8Array(Math.max(1, plan.batches.length) * BATCH_STRIDE);
  const batches = new DataView(batchBytes.buffer);
  const words = new Uint32Array(batchBytes.buffer);
  const lodRow = {
    generation: 0,
    level: 0,
    firstIndex: 0,
    indexCount: 0,
    baseVertex: 0,
    screenCoverage: 0,
    hysteresis: 0,
    ready: false,
  };
  let candidateIndex = 0;
  let batchIndex = 0;
  for (const batch of plan.batches) {
    const index = batchIndex++;
    const offset = index * BATCH_STRIDE;
    rows.push(batch);
    members.push(batch.candidates);
    const previousRow =
      previousRows !== undefined &&
      batch.materialAddress !== undefined &&
      batch.geometryAddress !== undefined
        ? retainedRow(previousRows, cursor, batch)
        : undefined;
    if (previousWords !== undefined && previousRow !== undefined) {
      cursor = previousRow + 1;
      const source = (previousRow * BATCH_STRIDE) / 4;
      const target = offset / 4;
      for (let word = 0; word < BATCH_STRIDE / 4; word++)
        words[target + word] = previousWords[source + word] as number;
      batches.setUint32(offset + 28, candidateIndex, true);
      candidateIndex += batch.candidates.length;
      continue;
    }
    const lodCount = batchLodLevelCount(batch);
    batches.setUint32(offset, batch.visibleBase, true);
    batches.setUint32(offset + 4, batch.visibleCapacity, true);
    batches.setUint32(offset + 8, batch.key.count, true);
    batches.setUint32(offset + 12, batch.key.first, true);
    batches.setInt32(offset + 16, batch.key.baseVertex, true);
    batches.setUint32(offset + 20, batch.indirectOffset / INDIRECT_COMMAND_BYTES, true);
    batches.setUint32(offset + 24, rasterBatchFlags(batch, lodCount), true);
    batches.setUint32(offset + 28, candidateIndex, true);
    batches.setUint32(offset + 32, batchLevelStride(batch), true);
    batches.setUint32(offset + 36, batch.lod?.crossfade === true ? 1 : 0, true);
    const materialAddress =
      batch.materialAddress ??
      (batch.binding === undefined
        ? 0
        : (scene.materialIndexForResource(batch.binding.material) ?? 0));
    batches.setUint32(offset + 40, materialAddress, true);
    const geometryAddress =
      batch.geometryAddress ??
      (batch.binding === undefined
        ? 0
        : (scene.geometryIndexForResource(batch.binding.worldId, batch.binding.assetHandle) ?? 0));
    batches.setUint32(offset + 44, geometryAddress, true);

    for (let level = 0; level < lodCount; level++) {
      const range = level === 0 ? batch.key : batch.lod?.ranges?.[level - 1];
      lodRow.generation = batch.generation;
      lodRow.level = level;
      lodRow.firstIndex = range?.first ?? batch.key.first;
      lodRow.indexCount = range?.count ?? batch.key.count;
      lodRow.baseVertex = range?.baseVertex ?? batch.key.baseVertex;
      lodRow.screenCoverage = batch.lod?.coverages[level] ?? (level === 0 ? 1 : 0);
      lodRow.hysteresis = batch.lod?.hysteresis ?? 0.08;
      lodRow.ready = batch.lod?.crossfade !== true || level === 0 || range !== undefined;
      writeGpuLodRow(batches, offset + BATCH_HEADER_STRIDE + level * LOD_ROW_STRIDE, lodRow);
    }
    candidateIndex += batch.candidates.length;
  }
  const encoded = { batchBytes, ...(fixed ? { rows } : {}), members };
  if (fixed) owner.set(plan, encoded);
  return encoded;
}

const SHADOW_RASTER_PASS = new PreparedRasterPass({
  colorFormats: [],
  depthStencilFormat: 'depth32float',
  sampleCount: 1,
});

export class GpuDrivenView {
  private encodedTopology: EncodedViewTopology | undefined;
  private shadowRaster: PreparedRasterCounters | undefined;
  private buffers: ViewBuffers | undefined;
  private surfaceRows: Uint32Array | undefined;
  private supersededBuffers: Partial<ViewBuffers>[] = [];
  private bindGroup: BindGroup | undefined;
  private skinBindGroup: BindGroup | undefined;
  private skinPipelines: readonly ComputePipeline[] | undefined;
  private skinLayout: SkinDemandLayout | undefined;
  private skinJointCapacity = 0;
  private skinActive = false;
  private skinRasterBinding: SkinTaskBinding | undefined;
  private readonly viewBytes = new ArrayBuffer(VIEW_BYTES);
  private readonly viewFloats = new Float32Array(this.viewBytes);
  private readonly viewWords = new Uint32Array(this.viewBytes);
  private readonly viewData = new DataView(this.viewBytes);
  private readonly viewUpload = new Uint8Array(this.viewBytes);
  private candidateCapacity = 0;
  private sceneRef: GpuScene | undefined;
  /** Canonical memberships of the last accepted topology stay encoded for its successor. */
  private memberHolds: { readonly topology: EncodedViewTopology; readonly release: () => void }[] =
    [];
  private visibleBufferCapacity = 0;
  /**
   * Two-phase occlusion mirrors late items after the union region. Only a view
   * that has been given an occlusion camera reserves it; once reserved it stays,
   * so toggling occlusion never thrashes the allocation.
   */
  private lateMirror = false;
  private batchCapacity = 0;
  private indirectCapacity = 0;
  private plan: SubmissionPlan | undefined;
  private sceneInputs: Buffer | undefined;
  private sceneInputBytes = 0;
  private scenePrimitive: Buffer | undefined;
  private sceneInstance: Buffer | undefined;
  private sceneTransform: Buffer | undefined;
  private sceneMaterial: Buffer | undefined;
  private sceneMaterialBytes = 0;
  private sceneCapacity = 0;
  private sceneTransformBytes = 0;
  private updateCount = 0;
  private uploadBytes = 0;
  private sharedInputUploadBytes = 0;
  private batchUploadBytes = 0;
  private viewConstantsUploadBytes = 0;
  private suppressionUploadBytes = 0;
  /** Bitmap words reserved after the batch table in the batches buffer. */
  private suppressionWordCapacity = 0;
  /** CPU mirror of the uploaded admission bitmap; diffed to upload dirty words only. */
  private suppressionMirror = new Uint32Array(0);
  /** A replacement batches buffer has no bitmap yet; the next update seeds it whole. */
  private suppressionReseed = false;
  /** Bitmap the mirror currently equals; `null` when unknown and a full diff must run. */
  private suppressionSource: Uint32Array | undefined | null = null;
  private bindGroupCreates = 0;
  private bufferRebuilds = 0;
  private resourceGeneration = 0;
  /**
   * Generation of the pass list this view adds to a graph. View and scene
   * buffers are resolved live when the graph executes, so buffer growth
   * advances only `resourceGeneration`; this changes only when imports or
   * passes are added or removed (first binding, Skin tasks, surface rows).
   */
  private graphGeneration = 0;
  private graphShape: string | undefined;
  private materialResourceGeneration = 0;
  private readonly allocationLedger = new GpuResourceAllocationLedger();
  private readonly allocationTokens = new WeakMap<Buffer, GpuResourceAllocationToken>();
  /** The last readback copy that was actually encoded and is not consumed. */
  private telemetryPending: LodTelemetryCopy | undefined;
  /** Receipt identity for the copy pass encoded by the current frame. */
  private telemetrySubmit: ViewTelemetrySubmit | undefined;
  /** Coalesce observers while the readback buffer is map-pending. */
  private lodSelectionReadback:
    | {
        readonly promise: Promise<GpuDrivenLodSelectionInspection | undefined>;
      }
    | undefined;
  private lodSelection: GpuDrivenLodSelectionInspection | undefined;
  /** Camera of the pyramid source; undefined keeps the single-phase path. */
  private occlusionCamera: GpuDrivenOcclusionCamera | undefined;
  /**
   * The last projected graph tests shadow casters against a camera pyramid.
   * A cull input enables the test only then, so a view never records a
   * camera-dependent raster its graph did not perform.
   */
  cameraCullBound = false;
  /** Which bit region the next late phase writes; flips when it is encoded. */
  private visibilityParity = 0;
  /** History key and readiness of the region the last late phase wrote. */
  private visibilityHistoryKey: string | undefined;
  private visibilityHistoryReady = false;
  private readonly pyramidBindGroups = new WeakMap<TextureView, BindGroup>();
  private shadowCameraCullPipeline: ComputePipeline | undefined;

  private constructor(
    private readonly device: RhiDevice,
    private readonly bindGroupLayout: BindGroupLayout,
    private readonly pipelineLayout: PipelineLayout,
    private readonly resetPipeline: ComputePipeline,
    private readonly cullPipeline: ComputePipeline,
    private readonly finalizePipeline: ComputePipeline,
    private readonly labelPrefix: string,
    private readonly pyramidLayout: BindGroupLayout,
    private readonly lateCullPipeline: ComputePipeline,
    private readonly lateFinalizePipeline: ComputePipeline,
    private readonly footprintScale: number,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
    private readonly latePipelineLayout: PipelineLayout,
    private readonly shadowCameraCullEligible: boolean,
    private readonly viewModule: ShaderModule,
  ) {}

  /**
   * Compiled on the first update with a camera cull input, so views that never
   * receive one skip the larger module. Undefined while the module compiles.
   */
  private shadowCameraCull(): Result<ComputePipeline | undefined, RhiError> {
    if (this.shadowCameraCullPipeline !== undefined) return ok(this.shadowCameraCullPipeline);
    const module = this.shaderModuleFactory.createShaderModule({
      label: 'gpu-driven-view-shadow-camera',
      code: GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL,
    });
    if (!module.ok) return module.error.code === 'rhi-not-available' ? ok(undefined) : module;
    const created = this.device.createComputePipeline({
      label: `${this.labelPrefix}.cullViewShadowCamera`,
      layout: this.latePipelineLayout,
      compute: { module: module.value, entryPoint: 'cullViewShadowCamera' },
    });
    if (!created.ok) return created;
    this.shadowCameraCullPipeline = created.value;
    return created;
  }

  private prepareSkinPipelines(): Result<void, RhiError> {
    if (this.skinPipelines !== undefined) return ok(undefined);
    // Resolve reads dispatch arguments indirectly; its bind group must omit the
    // writable alias of that buffer, even though finalize writes it earlier.
    const layout = this.device.createBindGroupLayout({
      label: `${this.labelPrefix}-skin-bgl`,
      entries: [
        ...[0, 1, 2, 3, 4].map((binding) => ({
          binding,
          visibility: COMPUTE_STAGE,
          buffer: { type: 'read-only-storage' as const },
        })),
        { binding: 5, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } },
        { binding: 6, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
        { binding: 7, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
      ],
    });
    if (!layout.ok) return layout;
    const pipelineLayout = this.device.createPipelineLayout({
      label: `${this.labelPrefix}-skin-pl`,
      bindGroupLayouts: [layout.value],
    });
    if (!pipelineLayout.ok) return pipelineLayout;
    // The kernels share the view module created with this view; another label
    // would compile identical WGSL asynchronously and fail the first Skin frame.
    const pipelines: ComputePipeline[] = [];
    for (const entryPoint of [
      'clearSkinDemand',
      'resetSkinDemand',
      'claimSkinDemand',
      'finalizeSkinDemand',
      'resolveSkinDemand',
    ]) {
      const pipeline = this.device.createComputePipeline({
        label: `${this.labelPrefix}.${entryPoint}`,
        layout: entryPoint === 'finalizeSkinDemand' ? this.pipelineLayout : pipelineLayout.value,
        compute: { module: this.viewModule, entryPoint },
      });
      if (!pipeline.ok) return pipeline;
      pipelines.push(pipeline.value);
    }
    this.skinPipelineLayout = layout.value;
    this.skinPipelines = pipelines;
    return ok(undefined);
  }
  private skinPipelineLayout: BindGroupLayout | undefined;

  /** Physical task output, captured by raster bindings until GPU completion. */
  skinTaskBinding(): SkinTaskBinding | undefined {
    return this.skinActive ? this.skinRasterBinding : undefined;
  }

  setTelemetrySubmit(identity: GpuDrivenLodSubmitIdentity | undefined): void {
    this.telemetrySubmit = identity;
  }

  /** @internal Only enables CPU decoding on telemetry copies/maps already issued by the view. */
  _setCullingTelemetrySubmit(identity: GpuDrivenCullingProducerReceipt | undefined): void {
    if (identity === undefined) {
      this.telemetrySubmit = undefined;
      return;
    }
    const producer = Object.freeze({
      frameId: identity.frameId,
      deviceGeneration: identity.deviceGeneration,
      ...(identity.graphGeneration === undefined
        ? {}
        : { graphGeneration: identity.graphGeneration }),
      viewKey: identity.viewKey,
      viewGeneration: identity.viewGeneration,
      sourceRevision: identity.sourceRevision,
    });
    this.telemetrySubmit = Object.freeze({
      frameId: producer.frameId,
      deviceGeneration: producer.deviceGeneration,
      cullingProducer: producer,
    });
  }

  static create(input: {
    readonly device: RhiDevice;
    readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
    readonly labelPrefix?: string;
    /**
     * @internal
     * Falsifier hook: scales the HZB screen footprint. Production uses 1.
     */
    readonly occlusionFootprintScale?: number;
    /** Compile the shadow caster cull against the main camera's pyramid. */
    readonly shadowCameraCull?: boolean;
  }): Result<GpuDrivenView, RhiError> {
    const { device, shaderModuleFactory } = input;
    const labelPrefix = input.labelPrefix ?? 'gpu-driven-view';
    if (!device.caps.compute || !device.caps.storageBuffer || !device.caps.indirectDrawing) {
      return err(
        new RhiError({
          code: 'feature-not-enabled',
          expected: 'compute && storageBuffer && indirectDrawing',
          hint: 'use the CPU projection and direct submission fallback on this device',
        }),
      );
    }
    const layout = device.createBindGroupLayout({
      label: `${labelPrefix}-bgl`,
      entries: [
        { binding: 0, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } },
        { binding: 6, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
        { binding: 7, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
        { binding: 8, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
      ],
    });
    if (!layout.ok) return layout;
    const pipelineLayout = device.createPipelineLayout({
      label: `${labelPrefix}-pl`,
      bindGroupLayouts: [layout.value],
    });
    if (!pipelineLayout.ok) return pipelineLayout;
    const module = shaderModuleFactory.createShaderModule({
      label: 'gpu-driven-view',
      code: GPU_DRIVEN_VIEW_WGSL,
    });
    if (!module.ok) return module;
    const createPipeline = (entryPoint: string): Result<ComputePipeline, RhiError> =>
      device.createComputePipeline({
        label: `${labelPrefix}.${entryPoint}`,
        layout: pipelineLayout.value,
        compute: {
          module: module.value,
          entryPoint,
          ...(device.caps.firstInstanceIndirect &&
          (entryPoint === 'finalizeView' || entryPoint === 'finalizeViewLate')
            ? { constants: { INDIRECT_FIRST_INSTANCE: 1 } }
            : {}),
        },
      });
    const reset = createPipeline('resetView');
    if (!reset.ok) return reset;
    const cull = createPipeline('cullView');
    if (!cull.ok) return cull;
    const finalize = createPipeline('finalizeView');
    if (!finalize.ok) return finalize;
    const lateFinalize = createPipeline('finalizeViewLate');
    if (!lateFinalize.ok) return lateFinalize;
    const pyramidLayout = device.createBindGroupLayout({
      label: `${labelPrefix}-occlusion-bgl`,
      entries: [
        {
          binding: 0,
          visibility: COMPUTE_STAGE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    });
    if (!pyramidLayout.ok) return pyramidLayout;
    const latePipelineLayout = device.createPipelineLayout({
      label: `${labelPrefix}-occlusion-pl`,
      bindGroupLayouts: [layout.value, pyramidLayout.value],
    });
    if (!latePipelineLayout.ok) return latePipelineLayout;
    const lateCull = device.createComputePipeline({
      label: `${labelPrefix}.cullViewLate`,
      layout: latePipelineLayout.value,
      compute: { module: module.value, entryPoint: 'cullViewLate' },
    });
    if (!lateCull.ok) return lateCull;
    return ok(
      new GpuDrivenView(
        device,
        layout.value,
        pipelineLayout.value,
        reset.value,
        cull.value,
        finalize.value,
        labelPrefix,
        pyramidLayout.value,
        lateCull.value,
        lateFinalize.value,
        input.occlusionFootprintScale ?? 1,
        shaderModuleFactory,
        latePipelineLayout.value,
        input.shadowCameraCull === true,
        module.value,
      ),
    );
  }

  update(
    plan: SubmissionPlan,
    scene: GpuScene,
    inputs: GpuInputReadFrame,
    planes: Float32Array,
    lodCamera?: LodViewCamera,
    minCasterDiameter = 0,
    suppressedPrimitives?: Uint32Array,
    lodShadow = false,
    occlusionCamera?: GpuDrivenOcclusionCamera,
    visibleSurfaceRows?: Uint32Array,
    shadowCameraCull?: GpuDrivenShadowCameraCull,
    skin?: SkinSceneFrame,
    capsuleDirectional = false,
  ): Result<void, RhiError> {
    if (visibleSurfaceRows !== undefined && visibleSurfaceRows.length !== plan.candidateCount) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'one submitted visible-surface address per view candidate',
          hint: 'derive receiver addresses from the same ordered submission plan before updating the view',
        }),
      );
    }
    try {
      this.resetUpdateTelemetry();
      this.skinActive = (skin?.current.jointCapacity ?? 0) > 0;
      if (this.skinActive) {
        const prepared = this.prepareSkinPipelines();
        if (!prepared.ok) return prepared;
      }
      const inputUploadStart = scene.inputs.uploadBytes;
      const encoded = patchMemberAddresses(
        plan,
        scene,
        inputs,
        encodedViewTopology(
          plan,
          scene,
          this.sceneRef === scene ? this.encodedTopology : undefined,
        ),
      );
      const sharedInput = inputs.buffer();
      if (!sharedInput.ok) return sharedInput;
      this.sharedInputUploadBytes = scene.inputs.uploadBytes - inputUploadStart;
      this.uploadBytes += this.sharedInputUploadBytes;
      const ensured = this.ensureBuffers(
        plan,
        scene,
        suppressedPrimitives,
        visibleSurfaceRows !== undefined,
        skin,
        this.lateMirror || occlusionCamera !== undefined,
      );
      if (!ensured.ok) return ensured;
      const buffersRebuilt = ensured.value;
      const buffers = this.buffers;
      if (buffers === undefined) return ok(undefined);
      const topology = this.uploadTopology(plan, scene, encoded, buffers, buffersRebuilt);
      if (!topology.ok) return topology;
      const surfaceRows = this.uploadSurfaceRows(buffers, visibleSurfaceRows, buffersRebuilt);
      if (!surfaceRows.ok) return surfaceRows;
      this.writeViewConstants(
        plan,
        planes,
        minCasterDiameter,
        sharedInput.value.resourceRoot,
        capsuleDirectional,
      );
      this.writeLodConstants(lodCamera, lodShadow);
      this.writeOcclusionConstants(occlusionCamera);
      const cameraCull = this.writeShadowCameraCullConstants(shadowCameraCull);
      if (!cameraCull.ok) return cameraCull;
      this.writeSkinConstants(skin, plan);
      const viewWrite = this.device.queue.writeBuffer(buffers.view, 0, this.viewUpload);
      if (!viewWrite.ok) return viewWrite;
      this.viewConstantsUploadBytes = this.viewBytes.byteLength;
      this.uploadBytes += this.viewBytes.byteLength;
      const suppressionUpdated = this.updateSuppression(
        buffers.batches,
        this.suppressionReseed,
        suppressedPrimitives,
      );
      if (!suppressionUpdated.ok) return suppressionUpdated;
      const bound = this.ensureBindGroups(scene, sharedInput.value.buffer, buffers, buffersRebuilt);
      if (!bound.ok) return bound;
      this.plan = plan;
      this.sceneInputs = sharedInput.value.buffer;
      this.sceneInputBytes = sharedInput.value.byteLength;
      this.holdMembers(scene, encoded);
      this.adoptScene(scene);
      this.updateCount += 1;
      return ok(undefined);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    }
  }

  /**
   * Preparation may overwrite the same physical buffers without changing their
   * generation. Only its subsequent submit can rebind receipt identity.
   */
  private resetUpdateTelemetry(): void {
    this.telemetrySubmit = undefined;
    this.sharedInputUploadBytes = 0;
    this.suppressionUploadBytes = 0;
    this.batchUploadBytes = 0;
    this.viewConstantsUploadBytes = 0;
    this.bindGroupCreates = 0;
    // The cached graph owns the readback copy.  Do not arm an observation latch
    // here: a graph can be compiled but not submitted, and its copy can be
    // skipped while the previous mapAsync is pending.  The encode callback
    // records only a copy that really reached the command encoder.
    this.lodSelection = undefined;
  }

  /**
   * Rebuild view storage when topology, Skin demand, surface mode or
   * suppression capacity outgrows it. Returns whether buffers were replaced.
   */
  private ensureBuffers(
    plan: SubmissionPlan,
    scene: GpuScene,
    suppressedPrimitives: Uint32Array | undefined,
    surfaceRows: boolean,
    skin: SkinSceneFrame | undefined,
    lateMirror: boolean,
  ): Result<boolean, RhiError> {
    const skinJointCapacity = Math.max(this.skinJointCapacity, skin?.current.jointCapacity ?? 0);
    // A shared membership may execute in several Passes. Task references
    // address actual candidate work, independently of unique member storage.
    const skinCandidates = this.skinLayout?.candidateCapacity ?? 0;
    const skinCandidateCapacity = Math.max(plan.candidateCount, skinCandidates);
    const skinGrows =
      (skinJointCapacity > 0 && skinCandidateCapacity > skinCandidates) ||
      skinJointCapacity > this.skinJointCapacity;
    const suppressionWords = Math.max(
      1,
      Math.ceil(scene.inspect().capacity / 32),
      suppressedPrimitives?.length ?? 0,
    );
    const structureGrows =
      skinGrows ||
      lateMirror !== this.lateMirror ||
      surfaceRows !== (this.buffers?.visibleSurfaceRows !== undefined) ||
      this.buffers === undefined ||
      suppressionWords > this.suppressionWordCapacity;
    if (this.plan === plan && !structureGrows) return ok(false);
    // Candidate records and compacted visible indices are different
    // capacity domains: every LOD level owns an aligned visible segment,
    // so the visible address space exceeds the logical candidate count.
    // Never let it inflate candidate/LOD-row storage allocations.
    const capacities = deriveGpuDrivenViewBufferCapacities(plan);
    if (
      !structureGrows &&
      capacities.candidate <= this.candidateCapacity &&
      capacities.visible <= this.visibleBufferCapacity &&
      capacities.batch <= this.batchCapacity &&
      capacities.indirect <= this.indirectCapacity
    )
      return ok(false);
    const rebuilt = this.rebuildBuffers(
      capacities.candidate,
      capacities.visible,
      capacities.batch,
      capacities.indirect,
      suppressionWords,
      surfaceRows,
      skinJointCapacity,
      skinCandidateCapacity,
      lateMirror,
    );
    return rebuilt.ok ? ok(true) : rebuilt;
  }

  /**
   * Upload the encoded topology when it, its storage or its scene changed.
   * Any accepted write may partially replace the old topology, so a later
   * failure must force reseeding even when the caller retries the old plan.
   */
  private uploadTopology(
    plan: SubmissionPlan,
    scene: GpuScene,
    encoded: EncodedViewTopology,
    buffers: ViewBuffers,
    buffersRebuilt: boolean,
  ): Result<void, RhiError> {
    const previous = buffersRebuilt ? undefined : this.encodedTopology;
    if (
      this.plan === plan &&
      !buffersRebuilt &&
      this.sceneRef === scene &&
      encoded.batchBytes === previous?.batchBytes
    )
      return ok(undefined);
    this.plan = undefined;
    this.encodedTopology = undefined;
    const batchWrite = this.writeChangedWords(
      buffers.batches,
      encoded.batchBytes,
      previous?.batchBytes,
    );
    if (!batchWrite.ok) return batchWrite;
    this.encodedTopology = encoded;
    this.batchUploadBytes = batchWrite.value;
    this.uploadBytes += batchWrite.value;
    return ok(undefined);
  }

  /**
   * Physical buffers retain their accepted bytes. Trim equal words at both
   * ends instead of re-uploading the static roster for a local edit. One
   * aligned interval per table keeps queue work bounded even for scattered
   * changes; a replacement or partial failure always seeds the full table.
   */
  private writeChangedWords(
    buffer: Buffer,
    bytes: Uint8Array,
    before: Uint8Array | undefined,
  ): Result<number, RhiError> {
    if (bytes === before) return ok(0);
    let start = 0;
    let end = bytes.byteLength / 4;
    if (before !== undefined) {
      const next = new Uint32Array(bytes.buffer, bytes.byteOffset, end);
      const old = new Uint32Array(before.buffer, before.byteOffset, before.byteLength / 4);
      while (start < Math.min(end, old.length) && next[start] === old[start]) start++;
      while (end > start && end <= old.length && next[end - 1] === old[end - 1]) end--;
    }
    const size = (end - start) * 4;
    if (size === 0) return ok(0);
    const written = this.device.queue.writeBuffer(buffer, start * 4, bytes, start * 4, size);
    return written.ok ? ok(size) : written;
  }

  /** Upload receiver addresses when they or their storage changed; clear them when absent. */
  private uploadSurfaceRows(
    buffers: ViewBuffers,
    visibleSurfaceRows: Uint32Array | undefined,
    buffersRebuilt: boolean,
  ): Result<void, RhiError> {
    if (visibleSurfaceRows === undefined || buffers.visibleSurfaceRows === undefined) {
      this.surfaceRows = undefined;
      return ok(undefined);
    }
    // Producers never mutate a published row array, so identity proves equality.
    if (
      !buffersRebuilt &&
      (this.surfaceRows === visibleSurfaceRows ||
        (this.surfaceRows?.length === visibleSurfaceRows.length &&
          visibleSurfaceRows.every((row, index) => this.surfaceRows?.[index] === row)))
    )
      return ok(undefined);
    const written = this.device.queue.writeBuffer(
      buffers.visibleSurfaceRows,
      0,
      visibleSurfaceRows,
    );
    if (!written.ok) return written;
    this.surfaceRows = visibleSurfaceRows;
    this.uploadBytes += visibleSurfaceRows.byteLength;
    return ok(undefined);
  }

  /** Reset the view constants and write the frustum and roster header words. */
  private writeViewConstants(
    plan: SubmissionPlan,
    planes: Float32Array,
    minCasterDiameter: number,
    resourceRoot: number,
    capsuleDirectional: boolean,
  ): void {
    this.viewUpload.fill(0);
    const viewFloats = this.viewFloats;
    viewFloats.set(planes.subarray(0, 24));
    const viewU32 = this.viewWords;
    viewU32[24] = plan.candidateCount;
    viewU32[25] = plan.batches.length;
    viewU32[26] = this.batchCapacity;
    viewFloats[27] = minCasterDiameter;
    viewU32[28] = this.suppressionBase() / 4;
    viewU32[29] = resourceRoot;
    viewU32[30] = capsuleDirectional ? 1 : 0;
  }

  /**
   * The per-frame history words (enabled, parity bases) stay zero here; the
   * early cull encode fills them only when its graph also records the late
   * phase, so a graph without it can never skip a previously hidden item.
   */
  private writeOcclusionConstants(occlusionCamera: GpuDrivenOcclusionCamera | undefined): void {
    this.occlusionCamera = occlusionCamera;
    if (occlusionCamera === undefined) return;
    const viewFloats = this.viewFloats;
    viewFloats.set(occlusionCamera.viewProjection.subarray(0, 16), OCCLUSION_CONSTANTS_OFFSET / 4);
    viewFloats[OCCLUSION_CONSTANTS_OFFSET / 4 + 16] = occlusionCamera.near;
    viewFloats[OCCLUSION_CONSTANTS_OFFSET / 4 + 17] = occlusionCamera.far;
    this.viewWords[OCCLUSION_CONSTANTS_OFFSET / 4 + 18] = occlusionCamera.orthographic ? 1 : 0;
    viewFloats[OCCLUSION_CONSTANTS_OFFSET / 4 + 19] = this.footprintScale;
  }

  /**
   * Without a cull input the enable word stays zero, so a graph that binds
   * the camera cull still draws every caster the frustum admits.
   */
  private writeShadowCameraCullConstants(
    shadowCameraCull: GpuDrivenShadowCameraCull | undefined,
  ): Result<void, RhiError> {
    const lightInverse =
      shadowCameraCull === undefined || !this.shadowCameraCullEligible
        ? undefined
        : invertLightViewProjection(shadowCameraCull.lightViewProjection);
    if (shadowCameraCull === undefined || lightInverse === undefined) return ok(undefined);
    const cameraPipeline = this.shadowCameraCull();
    if (!cameraPipeline.ok) return cameraPipeline;
    if (cameraPipeline.value === undefined) return ok(undefined);
    const viewFloats = this.viewFloats;
    const base = SHADOW_CAMERA_CULL_OFFSET / 4;
    const camera = shadowCameraCull.camera;
    viewFloats.set(camera.viewProjection.subarray(0, 16), base);
    viewFloats[base + 16] = camera.near;
    viewFloats[base + 17] = camera.far;
    this.viewWords[base + 18] = camera.orthographic ? 1 : 0;
    viewFloats[base + 19] = this.footprintScale;
    viewFloats.set(shadowCameraCull.lightViewProjection.subarray(0, 16), base + 20);
    viewFloats.set(lightInverse, base + 36);
    viewFloats[base + 52] = shadowCameraCull.ndcDilation;
    viewFloats[base + 53] = shadowCameraCull.worldDilation;
    this.viewWords[base + 54] = 1;
    return ok(undefined);
  }

  /**
   * Without a LOD camera the zero height scale reports an invalid height,
   * so every chain resolves to its root.
   */
  private writeLodConstants(lodCamera: LodViewCamera | undefined, shadow: boolean): void {
    if (lodCamera !== undefined) {
      writeLodViewConstants(this.viewData, LOD_CONSTANTS_OFFSET, lodCamera, shadow);
    }
  }

  /** Skin demand constants exist only while this view has an active Skin layout. */
  private writeSkinConstants(skin: SkinSceneFrame | undefined, plan: SubmissionPlan): void {
    const layout = this.skinLayout;
    if (!this.skinActive || skin === undefined || layout === undefined) return;
    writeSkinDemandConstants(
      this.viewData,
      SKIN_CONSTANTS_OFFSET,
      layout,
      skin.current.root,
      skin.previous?.root ?? 0xffffffff,
      plan.candidateCount,
      this.skinCounterBase(),
      this.skinDispatchBase(),
      Number(this.device.limits.maxComputeWorkgroupsPerDimension) || 65535,
    );
    this.viewWords[SKIN_RASTER_OFFSET / 4] = layout.candidateBase;
    this.viewWords[SKIN_RASTER_OFFSET / 4 + 1] = layout.descriptorBase;
  }

  /** Recreate the cull and Skin task bind groups when their scene or view storage changed. */
  private ensureBindGroups(
    scene: GpuScene,
    inputBuffer: Buffer,
    buffers: ViewBuffers,
    buffersRebuilt: boolean,
  ): Result<void, RhiError> {
    const sceneChanged =
      this.scenePrimitive !== scene.primitiveBuffer ||
      this.sceneInstance !== scene.instanceBuffer ||
      this.sceneTransform !== scene.transformBuffer ||
      this.sceneInputs !== inputBuffer;
    if (
      this.bindGroup !== undefined &&
      !sceneChanged &&
      !buffersRebuilt &&
      (!this.skinActive || this.skinBindGroup !== undefined)
    )
      return ok(undefined);
    // Graph passes read the current scene bindings and imports at execute
    // time, so a scene or input buffer swap alone does not recompile them.
    const graphShapeChanged =
      this.bindGroup === undefined ||
      buffersRebuilt ||
      (this.skinActive && this.skinBindGroup === undefined);
    const entries = [
      { binding: 0, resource: bufferBinding(scene.primitiveBuffer) },
      { binding: 1, resource: bufferBinding(scene.instanceBuffer) },
      { binding: 2, resource: bufferBinding(scene.transformBuffer) },
      { binding: 3, resource: bufferBinding(inputBuffer) },
      { binding: 4, resource: bufferBinding(buffers.batches) },
      { binding: 5, resource: bufferBinding(buffers.view) },
      { binding: 6, resource: bufferBinding(buffers.counters) },
      { binding: 7, resource: bufferBinding(buffers.visible) },
      { binding: 8, resource: bufferBinding(buffers.indirect) },
    ];
    const binding = this.device.createBindGroup({
      label: `${this.labelPrefix}-bg`,
      layout: this.bindGroupLayout,
      entries,
    });
    if (!binding.ok) return binding;
    this.bindGroup = binding.value;
    this.skinBindGroup = undefined;
    if (this.skinPipelineLayout !== undefined) {
      const taskBinding = this.device.createBindGroup({
        label: `${this.labelPrefix}-skin-bg`,
        layout: this.skinPipelineLayout,
        entries: entries.slice(0, 8),
      });
      if (!taskBinding.ok) {
        this.bindGroup = undefined;
        return taskBinding;
      }
      this.skinBindGroup = taskBinding.value;
    }
    this.bindGroupCreates = this.skinBindGroup === undefined ? 1 : 2;
    if (graphShapeChanged) this.resourceGeneration += 1;
    const shape = `${this.skinLayout !== undefined}|${buffers.visibleSurfaceRows !== undefined}`;
    if (shape !== this.graphShape) {
      this.graphShape = shape;
      this.graphGeneration += 1;
    }
    return ok(undefined);
  }

  private holdMembers(scene: GpuScene, topology: EncodedViewTopology): void {
    const previous = this.memberHolds;
    if (this.sceneRef === scene && previous[0]?.topology === topology) return;
    const holds: (typeof previous)[number][] = [];
    for (const candidates of topology.members)
      if (MemberCandidates.is(candidates))
        holds.push({ topology, release: scene.inputs.holdMembers(candidates) });
    this.memberHolds = holds;
    for (const hold of previous) hold.release();
  }

  /** Retain the scene buffers this view's bind groups and receipts now address. */
  private adoptScene(scene: GpuScene): void {
    this.scenePrimitive = scene.primitiveBuffer;
    this.sceneInstance = scene.instanceBuffer;
    this.sceneTransform = scene.transformBuffer;
    if (this.sceneMaterial !== scene.materialBuffer) this.materialResourceGeneration += 1;
    this.sceneMaterial = scene.materialBuffer;
    this.sceneMaterialBytes = scene.materialByteLength;
    this.sceneRef = scene;
    this.sceneCapacity = scene.inspect().capacity;
    this.sceneTransformBytes = scene.transformByteLength;
  }

  get computeResourceGeneration(): number {
    return this.resourceGeneration;
  }

  /** Graph-shape generation: advances only when this view's passes or imports change. */
  get graphResourceGeneration(): number {
    return this.graphGeneration;
  }

  get currentResourceGeneration(): number {
    return this.resourceGeneration + this.materialResourceGeneration;
  }

  resolveShadowBundle(
    cache: PreparedRasterBundleCache,
    observed: PreparedRasterBindings,
  ): RenderBundle {
    this.shadowRaster ??= { hits: 0, builds: 0, commands: 0, evictions: 0 };
    return cache.resolveOne(SHADOW_RASTER_PASS, this.device, observed, this.shadowRaster);
  }

  recordShadow(pass: RhiRenderPassEncoder, bundles: readonly RenderBundle[]): void {
    if (bundles.length === 0) return;
    const executed = pass.executeBundles(bundles);
    if (!executed.ok) throw executed.error;
  }

  inspect(): GpuDrivenViewInspection {
    return {
      ...(this.shadowRaster === undefined ? {} : { shadowBundles: { ...this.shadowRaster } }),
      topologyRevision: this.plan?.revision,
      candidateCount: this.plan?.candidateCount ?? 0,
      batchCount: this.plan?.batches.length ?? 0,
      visibleCapacity: this.plan?.visibleCapacity ?? 0,
      candidateCapacity: this.candidateCapacity,
      visibleBufferCapacity: this.visibleBufferCapacity,
      batchCapacity: this.batchCapacity,
      indirectCapacity: this.indirectCapacity,
      updateCount: this.updateCount,
      uploadBytes: this.uploadBytes,
      sharedInputUploadBytes: this.sharedInputUploadBytes,
      batchUploadBytes: this.batchUploadBytes,
      viewConstantsUploadBytes: this.viewConstantsUploadBytes,
      suppressionUploadBytes: this.suppressionUploadBytes,
      bindGroupCreates: this.bindGroupCreates,
      bufferRebuilds: this.bufferRebuilds,
      resourceGeneration: this.currentResourceGeneration,
      resourceAllocation: this.allocationLedger.inspect(),
    };
  }

  /** Shared GPU Scene inputs this view last read; vertex stages share it. */
  get sceneInputBuffer(): Buffer | undefined {
    return this.sceneInputs;
  }

  get visibleSurfaceRowsBuffer(): Buffer | undefined {
    return this.buffers?.visibleSurfaceRows;
  }

  get visibleBuffer(): Buffer | undefined {
    return this.buffers?.visible;
  }

  get indirectBuffer(): Buffer | undefined {
    return this.buffers?.indirect;
  }

  get overflowBuffer(): Buffer | undefined {
    return this.buffers?.counters;
  }

  get overflowByteOffset(): number {
    return 4;
  }

  /** Read selected levels written by the GPU cull pass for the last submit. */
  readLodSelection(): Promise<GpuDrivenLodSelectionInspection | undefined> {
    const inFlight = this.lodSelectionReadback;
    if (inFlight !== undefined) return inFlight.promise;

    const copy = this.readableTelemetryCopy();
    if (copy === undefined) return Promise.resolve(this.lodSelection);
    const promise = this.readLodSelectionCopy(copy).finally(() => {
      if (this.lodSelectionReadback?.promise === promise) this.lodSelectionReadback = undefined;
    });
    this.lodSelectionReadback = { promise };
    return promise;
  }

  /** Explicit one-shot diagnostic. Caller keeps the issued frame current until this read completes. */
  async readGeometryCommands(
    commands: readonly GeometryCommandCapture[],
    receipt: { frameId: number; deviceGeneration: number },
  ) {
    const buffers = this.buffers,
      plan = this.plan,
      submit = this.telemetrySubmit,
      generation = this.resourceGeneration;
    const current = () =>
      this.buffers === buffers &&
      this.plan === plan &&
      this.resourceGeneration === generation &&
      this.telemetrySubmit === submit;
    if (
      buffers === undefined ||
      plan === undefined ||
      submit?.frameId !== receipt.frameId ||
      submit.deviceGeneration !== receipt.deviceGeneration
    )
      throw Error('receipt-unavailable');
    if (
      commands.some(
        (c) => c.bufferIdentity !== getOpaqueResourceIdentity(buffers.indirect as object),
      )
    )
      throw Error('indirect-buffer-mismatch');
    const indirectBytes = this.indirectCapacity * INDIRECT_COMMAND_BYTES * 2;
    const visibleBytes = this.visiblePrefixBytes(this.visibleBufferCapacity, this.lateMirror);
    const counterBytes = this.batchCapacity * COUNTER_STRIDE;
    const viewOffset = indirectBytes + visibleBytes + counterBytes;
    const size = viewOffset + VIEW_BYTES;
    if (size > GEOMETRY_OBSERVATION_MAX_BYTES) throw Error('readback-budget');
    const created = this.device.createBuffer({
      label: 'geometry-observation-once',
      size,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!created.ok) throw created.error;
    let releaseMap: (() => void) | undefined;
    let decoded:
      | {
          commands: ReturnType<typeof decodeGeometryCommands>;
          viewConstants: ReturnType<typeof decodeGeometryView>;
        }
      | undefined;
    let failure: unknown;
    try {
      const encoded = this.device.createCommandEncoder({ label: 'geometry-observation-once' });
      if (!encoded.ok) throw encoded.error;
      encoded.value.copyBufferToBuffer(buffers.indirect, 0, created.value, 0, indirectBytes);
      encoded.value.copyBufferToBuffer(
        buffers.visible,
        0,
        created.value,
        indirectBytes,
        visibleBytes,
      );
      encoded.value.copyBufferToBuffer(
        buffers.counters,
        0,
        created.value,
        indirectBytes + visibleBytes,
        counterBytes,
      );
      encoded.value.copyBufferToBuffer(buffers.view, 0, created.value, viewOffset, VIEW_BYTES);
      const finished = encoded.value.finish();
      if (!finished.ok) throw finished.error;
      const sent = this.device.queue.submit([finished.value]);
      if (!sent.ok) throw sent.error;
      const result = await created.value.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
      if (!result.ok) throw result.error;
      releaseMap = () => result.value.unmap();
      const range = result.value.getMappedRange();
      if (!range.ok) throw range.error;
      if (!current()) throw Error('superseded');
      const values = new DataView(range.value);
      const earlyCountOffsets = new Map<string, number>();
      let batchIndex = 0;
      for (const batch of plan.batches) {
        const i = batchIndex++;
        if (values.getUint32(indirectBytes + visibleBytes + i * COUNTER_STRIDE + 4, true) !== 0)
          throw Error('selector-overflow');
        for (let level = 0; level < batchLodLevelCount(batch); level++)
          earlyCountOffsets.set(
            `${batch.batchId}:${level}`,
            i * COUNTER_STRIDE + (EARLY_VISIBLE_COUNTER_OFFSET + level) * 4,
          );
      }
      const decodedCommands = decodeGeometryCommands({
        bytes: values,
        commands,
        indirectBytes,
        visibleBytes,
        countersOffset: indirectBytes + visibleBytes,
        earlyCountOffsets,
        firstInstanceIndirect: this.device.caps.firstInstanceIndirect,
      });
      decoded = {
        commands: decodedCommands,
        viewConstants: decodeGeometryView(
          new DataView(range.value, viewOffset, VIEW_BYTES),
          OCCLUSION_CONSTANTS_OFFSET,
          OCCLUSION_STATE_OFFSET,
        ),
      };
    } catch (error) {
      failure = error;
    } finally {
      // Always attempt both cleanup operations, preserving the original observation failure.
      try {
        releaseMap?.();
      } catch (error) {
        failure ??= error;
      }
      try {
        const destroyed = this.device.destroyBuffer(created.value);
        if (!destroyed.ok) failure ??= destroyed.error;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    if (decoded === undefined) throw Error('readback-unavailable');
    return decoded;
  }

  /** Shadows consume batch cull counters, not visible-member or Surface observations. */
  readCullingCounts(): Promise<
    | (Pick<GpuDrivenLodSelectionInspection, 'texelCulled' | 'cameraCulled'> & {
        readonly observation?: GpuDrivenCullingObservation;
      })
    | undefined
  > {
    const copy = this.readableTelemetryCopy();
    if (copy === undefined) return Promise.resolve(undefined);
    // Counters lead the readback; mapping the visible-member and indirect
    // tail would cost bytes proportional to the candidate capacity per view.
    const counterBytes = Math.max(4, copy.plan.batches.length * COUNTER_STRIDE);
    return this.readTelemetryCopy(copy, counterBytes, (values) => {
      let texelCulled = 0;
      let cameraCulled = 0;
      for (let batchIndex = 0; batchIndex < copy.plan.batches.length; batchIndex += 1) {
        const offset = batchIndex * COUNTER_STRIDE;
        texelCulled += values.getUint32(offset + TEXEL_CULLED_COUNTER_OFFSET * 4, true);
        cameraCulled += values.getUint32(offset + CAMERA_CULLED_COUNTER_OFFSET * 4, true);
      }
      const producer = copy.submit?.cullingProducer;
      if (producer === undefined) return { texelCulled, cameraCulled };
      let visible = 0;
      let overflow = false;
      for (let batchIndex = 0; batchIndex < copy.plan.batches.length; batchIndex += 1) {
        const offset = batchIndex * COUNTER_STRIDE;
        const batchOverflow = values.getUint32(offset + 4, true) !== 0;
        overflow ||= batchOverflow;
        if (!batchOverflow) {
          visible += Math.min(
            values.getUint32(offset, true),
            copy.plan.batches.at(batchIndex)?.visibleCapacity ?? 0,
          );
        }
      }
      return {
        texelCulled,
        cameraCulled,
        observation: Object.freeze({
          producer,
          resourceGeneration: copy.resourceGeneration,
          indirectBufferIdentity: copy.indirectBufferIdentity,
          planRevision: copy.plan.revision,
          candidateCount: copy.plan.candidateCount,
          batchCount: copy.plan.batches.length,
          visible,
          overflow,
          texelCulled,
          cameraCulled,
        }),
      };
    });
  }

  private readableTelemetryCopy(): LodTelemetryCopy | undefined {
    const buffers = this.buffers;
    const copy = this.telemetryPending;
    return buffers !== undefined &&
      copy !== undefined &&
      copy.buffers === buffers &&
      copy.plan === this.plan &&
      copy.resourceGeneration === this.resourceGeneration &&
      typeof buffers.lodReadback.mapAsync === 'function' &&
      buffers.lodReadback.mapState === 'unmapped'
      ? copy
      : undefined;
  }

  /** `bytes` maps only the readback prefix the decoder reads; undefined maps all of it. */
  private async readTelemetryCopy<T>(
    copy: LodTelemetryCopy,
    bytes: number | undefined,
    decode: (values: DataView<ArrayBuffer>) => T,
  ): Promise<T | undefined> {
    const buffers = copy.buffers;
    const mapped =
      bytes === undefined
        ? await buffers.lodReadback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)
        : await buffers.lodReadback.mapAsync(GPU_BUFFER_USAGE_MAP_READ, 0, bytes);
    if (!mapped.ok) return undefined;
    const range =
      bytes === undefined ? mapped.value.getMappedRange() : mapped.value.getMappedRange(0, bytes);
    if (!range.ok) {
      mapped.value.unmap();
      return undefined;
    }
    try {
      // Decode only the submitted copy. A later plan may share these buffers;
      // replacement resources cannot supply this range's counter capacities.
      if (
        this.buffers !== buffers ||
        this.resourceGeneration !== copy.resourceGeneration ||
        this.telemetryPending !== copy
      ) {
        return undefined;
      }
      const result = decode(new DataView(range.value));
      this.telemetryPending = undefined;
      return result;
    } finally {
      mapped.value.unmap();
    }
  }

  private readLodSelectionCopy(
    copy: LodTelemetryCopy,
  ): Promise<GpuDrivenLodSelectionInspection | undefined> {
    return this.readTelemetryCopy(copy, undefined, (values) => {
      const plan = copy.plan;
      let visible = 0;
      let overflow = false;
      let geometryWork = 0;
      let rootGeometryWork = 0;
      let texelCulled = 0;
      let cameraCulled = 0;
      let occlusionCulled = 0;
      let lateVisible = 0;
      const actualMembers: Array<{
        readonly batchId: number;
        readonly primitiveIndex: number;
        readonly generation: number;
        readonly drawItemIndex: number;
        readonly instanceOrdinal: number;
      }> = [];
      const histogram = new Map<number, number>();
      let batchIndex = 0;
      let firstCandidate = 0;
      for (const batch of plan.batches) {
        const offset = batchIndex++ * COUNTER_STRIDE;
        const batchOverflow = values.getUint32(offset + 4, true) !== 0;
        const batchVisible = batchOverflow
          ? 0
          : Math.min(values.getUint32(offset, true), batch?.visibleCapacity ?? 0);
        // Visible items carry their candidate row (z) in the submitted plan, so
        // each record names the (slot, generation) encoded with this copy and
        // never consults the current allocation; joins drop stale generations.
        const batchFirst = firstCandidate;
        firstCandidate += batch.candidates.length;
        const levels = batch === undefined || batchOverflow ? 0 : batchLodLevelCount(batch);
        for (let level = 0; level < levels; level += 1) {
          if (batch === undefined) break;
          const segmentBase = batch.visibleBase + level * batchLevelStride(batch);
          const segmentVisible = Math.min(
            values.getUint32(offset + (LEVEL_VISIBLE_COUNTER_OFFSET + level) * 4, true),
            batch.visibleCapacity,
          );
          for (let visibleIndex = 0; visibleIndex < segmentVisible; visibleIndex += 1) {
            const visibleOffset =
              this.batchCapacity * COUNTER_STRIDE + (segmentBase + visibleIndex) * 16;
            const ordinal = values.getUint32(visibleOffset + 8, true) - batchFirst;
            const candidate =
              ordinal >= 0 && ordinal < batch.candidates.length
                ? batch.candidates.at(ordinal)
                : undefined;
            if (candidate !== undefined) {
              actualMembers.push({
                batchId: batch.batchId,
                primitiveIndex: candidate.primitiveIndex,
                generation: candidate.generation,
                drawItemIndex: batch.binding?.drawItemIndex ?? candidate.drawItemIndex,
                instanceOrdinal: candidate.instanceOrdinal,
              });
            }
          }
        }
        visible += batchVisible;
        overflow ||= batchOverflow;
        geometryWork += values.getUint32(offset + GEOMETRY_WORK_COUNTER_OFFSET * 4, true);
        rootGeometryWork += values.getUint32(offset + ROOT_GEOMETRY_WORK_COUNTER_OFFSET * 4, true);
        texelCulled += values.getUint32(offset + TEXEL_CULLED_COUNTER_OFFSET * 4, true);
        cameraCulled += values.getUint32(offset + CAMERA_CULLED_COUNTER_OFFSET * 4, true);
        if (copy.occlusion && !batchOverflow && batch !== undefined) {
          occlusionCulled += values.getUint32(offset + OCCLUSION_CULLED_COUNTER_OFFSET * 4, true);
          for (let level = 0; level < batchLodLevelCount(batch); level += 1) {
            const total = Math.min(
              values.getUint32(offset + (LEVEL_VISIBLE_COUNTER_OFFSET + level) * 4, true),
              batch.visibleCapacity,
            );
            const early = values.getUint32(
              offset + (EARLY_VISIBLE_COUNTER_OFFSET + level) * 4,
              true,
            );
            lateVisible += Math.max(0, total - early);
          }
        }
        for (let level = 0; level < LOD_ROW_CAPACITY; level += 1) {
          const count = values.getUint32(offset + (LOD_COUNTER_OFFSET + level) * 4, true);
          if (count > 0) histogram.set(level, (histogram.get(level) ?? 0) + count);
        }
      }
      const candidateCount = plan.candidateCount;
      const surfaceReadback = copy.surfaceReadbackSnapshot?.();
      const surfaceIndirectReadback =
        surfaceReadback === undefined
          ? undefined
          : decodeSurfaceIndirectParameters({
              bytes: values.buffer,
              byteOffset: copy.indirectReadbackOffset,
              byteLength: this.indirectCapacity * INDIRECT_COMMAND_BYTES,
              indirectBufferIdentity: copy.indirectBufferIdentity,
              recording: surfaceReadback,
            });
      this.lodSelection = Object.freeze({
        resourceGeneration: copy.resourceGeneration,
        candidateCount,
        batchCount: plan.batches.length,
        // Selector-only batches remain in the plan/readback but the production
        // raster skips them. Report the actual nonzero-admission command count
        // (one per LOD level) so a benchmark cannot mistake selector batches
        // for raster draws.
        indirectDrawCount: admittedRasterBatchCount(plan),
        visible,
        // A LOD histogram counts candidates that reached the selector, while
        // `visible` is the actual compacted submission count. Occlusion is the
        // difference between those candidate/visibility totals; using the
        // histogram here would mislabel a visible candidate dropped only by an
        // indirect-capacity overflow as occluded.
        occluded: Math.max(0, candidateCount - visible),
        overflow,
        lodHistogram: Object.freeze(
          [...histogram.entries()]
            .sort(([left], [right]) => left - right)
            .map(([level, count]) => Object.freeze({ level, count })),
        ),
        batches: Object.freeze(
          plan.batches.map((batch, batchIndex) => {
            const offset = batchIndex * COUNTER_STRIDE;
            const batchHistogram = new Map<number, number>();
            for (let level = 0; level < LOD_ROW_CAPACITY; level += 1) {
              const count = values.getUint32(offset + (LOD_COUNTER_OFFSET + level) * 4, true);
              if (count > 0) batchHistogram.set(level, count);
            }
            const batchOverflow = values.getUint32(offset + 4, true) !== 0;
            const batchVisible = batchOverflow
              ? 0
              : Math.min(values.getUint32(offset, true), batch.visibleCapacity);
            return Object.freeze({
              batchId: batch.batchId,
              candidateCount: batch.candidates.length,
              visible: batchVisible,
              occluded: Math.max(0, batch.candidates.length - batchVisible),
              overflow: batchOverflow,
              lodHistogram: Object.freeze(
                [...batchHistogram.entries()]
                  .sort(([left], [right]) => left - right)
                  .map(([level, count]) => Object.freeze({ level, count })),
              ),
            });
          }),
        ),
        geometryWork,
        rootGeometryWork,
        texelCulled,
        cameraCulled,
        ...(copy.occlusion
          ? { occlusion: Object.freeze({ culled: occlusionCulled, late: lateVisible }) }
          : {}),
        actualMembers: Object.freeze(actualMembers),
        ...(surfaceReadback === undefined ? {} : { surfaceReadback }),
        ...(surfaceIndirectReadback === undefined
          ? {}
          : surfaceIndirectReadback.ok
            ? { surfaceIndirectParameters: surfaceIndirectReadback.value }
            : { surfaceIndirectReadbackError: surfaceIndirectReadback.error }),
        ...(copy.submit === undefined ? {} : { submit: copy.submit }),
      });
      return this.lodSelection;
    });
  }

  addPasses<FrameCtx extends RenderGraphFrame>(
    builder: RenderGraphBuilder<FrameCtx>,
    labelPrefix = 'gpu-driven',
    includeCompute = true,
    surfaceSubmissionObservation?: () => SurfaceSubmissionCandidate | undefined,
    executeIf?: (frame: FrameCtx) => boolean,
    lateOcclusion = false,
    shadowCameraPyramid?: GraphTextureView,
    resolveDrawResources?: () => void,
  ): Result<GpuDrivenViewGraphResources, RenderGraphError> {
    const buffers = this.buffers;
    const bindGroup = this.bindGroup;
    const plan = this.plan;
    if (buffers === undefined || bindGroup === undefined || plan === undefined) {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'GpuDrivenView.update(...) precedes addPasses(...)',
          hint: 'publish the current SubmissionPlan and view planes first',
          detail: {
            resourceLabel: 'gpu-driven-view',
            field: 'state',
            expected: 'updated',
            actual: 'not-updated',
          },
        }),
      );
    }
    const importBuffer = (
      name: string,
      buffer: Buffer | (() => Buffer),
      size: number,
      usage: number,
      resolveBefore?: () => void,
    ) =>
      builder.importBuffer(name, { size, usage }, () => {
        resolveBefore?.();
        return typeof buffer === 'function' ? buffer() : buffer;
      });
    // Scene and input buffers may be replaced without a new graph; resolve
    // the current ones when the graph executes.
    const live = (current: () => Buffer | undefined, fallback: Buffer) => () =>
      current() ?? fallback;
    const liveBindGroup = () => this.bindGroup ?? bindGroup;
    // View buffers grow without a new graph as well: every import, dispatch
    // and readback resolves the current generation when the graph executes.
    const currentBuffers = () => this.buffers ?? buffers;
    const scenePrefix = labelPrefix === 'gpu-driven' ? 'gpu-scene' : `${labelPrefix}.scene`;
    const primitive = importBuffer(
      `${scenePrefix}.primitive`,
      live(() => this.scenePrimitive, this.scenePrimitive as Buffer),
      this.sceneCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
      resolveDrawResources,
    );
    if (!primitive.ok) return primitive;
    const transform = importBuffer(
      `${scenePrefix}.transform`,
      live(() => this.sceneTransform, this.sceneTransform as Buffer),
      this.sceneTransformBytes,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!transform.ok) return transform;
    const instance = importBuffer(
      `${scenePrefix}.instance`,
      live(() => this.sceneInstance, this.sceneInstance as Buffer),
      this.sceneCapacity * GPU_SCENE_LAYOUTS.instance.stride,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!instance.ok) return instance;
    const material = importBuffer(
      `${scenePrefix}.material`,
      live(() => this.sceneMaterial, this.sceneMaterial as Buffer),
      this.sceneMaterialBytes,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!material.ok) return material;
    const candidates = importBuffer(
      `${labelPrefix}.candidates`,
      live(() => this.sceneInputs, this.sceneInputs as Buffer),
      this.sceneInputBytes,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!candidates.ok) return candidates;
    let visibleSurfaceRows: GraphBuffer | undefined;
    if (buffers.visibleSurfaceRows !== undefined) {
      const imported = importBuffer(
        `${labelPrefix}.visible-surface-rows`,
        live(() => this.buffers?.visibleSurfaceRows, buffers.visibleSurfaceRows),
        this.visibleBufferCapacity * 4,
        GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
      );
      if (!imported.ok) return imported;
      visibleSurfaceRows = imported.value;
    }
    const batches = importBuffer(
      `${labelPrefix}.batches`,
      () => currentBuffers().batches,
      this.suppressionBase() + this.suppressionWordCapacity * 4,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!batches.ok) return batches;
    const view = importBuffer(
      `${labelPrefix}.view`,
      () => currentBuffers().view,
      VIEW_BYTES,
      GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!view.ok) return view;
    const counters = importBuffer(
      `${labelPrefix}.counters`,
      () => currentBuffers().counters,
      this.countersBytes(),
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!counters.ok) return counters;
    const lodReadback = importBuffer(
      `${labelPrefix}.lod-selection-readback`,
      () => currentBuffers().lodReadback,
      this.batchCapacity * COUNTER_STRIDE +
        this.visibleBufferCapacity * 16 +
        this.indirectCapacity * INDIRECT_COMMAND_BYTES,
      GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!lodReadback.ok) return lodReadback;
    const visible = importBuffer(
      `${labelPrefix}.visible`,
      () => currentBuffers().visible,
      this.visibleBytes(),
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!visible.ok) return visible;
    const indirect = importBuffer(
      `${labelPrefix}.indirect`,
      () => currentBuffers().indirect,
      this.indirectBytes(),
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!indirect.ok) return indirect;
    if (!includeCompute) {
      return ok({
        visible: visible.value,
        primitive: primitive.value,
        instance: instance.value,
        transform: transform.value,
        material: material.value,
        indirect: indirect.value,
        overflow: counters.value,
      });
    }
    // A compiled graph outlives plan revisions that keep the same buffer
    // capacities (spawn churn, LOD regrouping). Dispatch sizes therefore
    // follow the plan uploaded for the submitted frame; the shaders bound
    // every invocation by the counts in the view constants.
    const submitted = (): Pick<SubmissionPlan, 'batches' | 'candidateCount'> => this.plan ?? plan;
    if (this.skinLayout !== undefined) {
      const pipelines = this.skinPipelines;
      const taskBinding = this.skinBindGroup;
      if (pipelines === undefined || taskBinding === undefined) {
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: 'prepared Skin task pipelines and physical buffer bindings',
            hint: 'update the view with its fixed Skin frame before building task passes',
          }),
        );
      }
      const taskEnabled = (frame: FrameCtx) => this.skinActive && (executeIf?.(frame) ?? true);
      const stages = ['clear', 'reset', 'claim', 'finalize', 'resolve'] as const;
      for (let stage = 0; stage < stages.length; stage++) {
        const pipeline = pipelines[stage] as ComputePipeline;
        const result = builder.addComputePass(`${labelPrefix}.skin-${stages[stage]}`, {
          accesses: [
            { resource: primitive.value, usage: 'storage-read' },
            { resource: instance.value, usage: 'storage-read' },
            { resource: transform.value, usage: 'storage-read' },
            { resource: candidates.value, usage: 'storage-read' },
            { resource: batches.value, usage: 'storage-read' },
            { resource: view.value, usage: 'uniform-read' },
            { resource: counters.value, usage: 'storage-read-write' },
            { resource: visible.value, usage: 'storage-read-write' },
            ...(stage === 3
              ? [{ resource: indirect.value, usage: 'storage-read-write' as const }]
              : []),
            ...(stage === 4 ? [{ resource: indirect.value, usage: 'indirect-read' as const }] : []),
          ],
          executeIf: taskEnabled,
          encode: ({ pass }) => {
            pass.setPipeline(pipeline);
            pass.setBindGroup(
              0,
              stage === 3 ? liveBindGroup() : (this.skinBindGroup ?? taskBinding),
            );
            if (stage === 4) {
              pass.dispatchWorkgroupsIndirect(
                currentBuffers().indirect,
                this.skinDispatchBase() * 4,
              );
            } else if (stage === 1 || stage === 3) {
              pass.dispatchWorkgroups(1);
            } else {
              const count =
                stage === 0 ? (this.skinLayout?.rosterCapacity ?? 0) : submitted().candidateCount;
              const groups = Math.max(1, Math.ceil(count / WORKGROUP_SIZE));
              const limit = Number(this.device.limits.maxComputeWorkgroupsPerDimension) || 65535;
              pass.dispatchWorkgroups(Math.min(groups, limit), Math.ceil(groups / limit));
            }
          },
        });
        if (!result.ok) return result;
      }
    }
    const reset = builder.addComputePass(`${labelPrefix}.view-reset`, {
      accesses: [
        { resource: view.value, usage: 'uniform-read' },
        { resource: counters.value, usage: 'storage-read-write' },
      ],
      ...(executeIf === undefined ? {} : { executeIf }),
      encode: ({ pass }) => {
        pass.setPipeline(this.resetPipeline);
        pass.setBindGroup(0, liveBindGroup());
        pass.dispatchWorkgroups(
          Math.ceil(Math.max(1, submitted().batches.length) / WORKGROUP_SIZE),
        );
      },
    });
    if (!reset.ok) return reset;
    // Set during graph construction when the caller adds the late phase; the
    // early cull may skip a previously hidden item only in such a graph.
    let lateRecorded = false;
    const cameraCull = this.shadowCameraCullEligible ? shadowCameraPyramid : undefined;
    this.cameraCullBound = cameraCull !== undefined;
    const cull = builder.addComputePass(`${labelPrefix}.frustum-compact`, {
      accesses: [
        { resource: primitive.value, usage: 'storage-read' },
        { resource: instance.value, usage: 'storage-read' },
        { resource: transform.value, usage: 'storage-read' },
        { resource: candidates.value, usage: 'storage-read' },
        { resource: batches.value, usage: 'storage-read' },
        { resource: view.value, usage: 'uniform-read' },
        { resource: counters.value, usage: 'storage-read-write' },
        { resource: visible.value, usage: 'storage-read-write' },
        ...(cameraCull === undefined
          ? []
          : [{ resource: cameraCull, usage: 'sampled-read' as const }]),
      ],
      ...(executeIf === undefined ? {} : { executeIf }),
      encode: ({ pass, resources: graphResources }) => {
        if (lateRecorded) this.writeOcclusionState();
        // update() compiles the camera cull with its first input; until then
        // the frustum cull is what the disabled camera cull would draw.
        const cameraPipeline = cameraCull === undefined ? undefined : this.shadowCameraCullPipeline;
        pass.setPipeline(cameraPipeline ?? this.cullPipeline);
        pass.setBindGroup(0, liveBindGroup());
        if (cameraCull !== undefined && cameraPipeline !== undefined) {
          pass.setBindGroup(
            1,
            this.pyramidBindGroup(graphResources.textureView(cameraCull).unwrap()),
          );
        }
        pass.dispatchWorkgroups(
          Math.ceil(Math.max(1, submitted().candidateCount) / WORKGROUP_SIZE),
        );
      },
    });
    if (!cull.ok) return cull;
    const finalize = builder.addComputePass(`${labelPrefix}.finalize-indirect`, {
      accesses: [
        { resource: batches.value, usage: 'storage-read' },
        { resource: view.value, usage: 'uniform-read' },
        // Read-write: the finalize snapshots the early per-level counts.
        { resource: counters.value, usage: 'storage-read-write' },
        { resource: indirect.value, usage: 'storage-read-write' },
      ],
      ...(executeIf === undefined ? {} : { executeIf }),
      encode: ({ pass }) => {
        pass.setPipeline(this.finalizePipeline);
        pass.setBindGroup(0, liveBindGroup());
        pass.dispatchWorkgroups(
          Math.ceil(Math.max(1, submitted().batches.length) / WORKGROUP_SIZE),
        );
      },
    });
    if (!finalize.ok) return finalize;
    const addReadback = (occlusion: boolean) =>
      builder.addCopyPass(`${labelPrefix}.lod-selection-readback`, {
        accesses: [
          { resource: counters.value, usage: 'copy-src' },
          { resource: visible.value, usage: 'copy-src' },
          { resource: indirect.value, usage: 'copy-src' },
          { resource: lodReadback.value, usage: 'copy-dst' },
        ],
        ...(executeIf === undefined ? {} : { executeIf }),
        encode: ({ encoder, resources }) => {
          // A cached graph may run while an observer is awaiting mapAsync on the
          // previous copy. WebGPU forbids submitting a copy into a
          // pending/mapped buffer; skip only this telemetry copy and keep the
          // raster/indirect work intact. RhiNull has no runtime mapState, so its
          // undefined value remains structurally executable.
          const current = currentBuffers();
          const mapState = current.lodReadback.mapState;
          if (mapState !== undefined && mapState !== 'unmapped') return;
          const indirectReadbackOffset =
            this.batchCapacity * COUNTER_STRIDE + this.visibleBufferCapacity * 16;
          encoder.copyBufferToBuffer(
            resources.buffer(counters.value).unwrap(),
            resources.buffer(lodReadback.value).unwrap(),
            this.batchCapacity * COUNTER_STRIDE,
          );
          encoder.copyBufferToBuffer(
            resources.buffer(visible.value).unwrap(),
            0,
            resources.buffer(lodReadback.value).unwrap(),
            this.batchCapacity * COUNTER_STRIDE,
            this.visibleBufferCapacity * 16,
          );
          encoder.copyBufferToBuffer(
            resources.buffer(indirect.value).unwrap(),
            0,
            resources.buffer(lodReadback.value).unwrap(),
            indirectReadbackOffset,
            this.indirectCapacity * INDIRECT_COMMAND_BYTES,
          );
          // The render graph is cached across camera-only LOD projection
          // changes. The pass closure therefore retains the graph-generation
          // plan while `this.plan` carries the plan uploaded for the frame that
          // is actually being submitted. Counters belong to that current plan;
          // retaining the stale closure plan would make every observation fail
          // the identity fence and silently leave the CPU level-0 placeholder.
          const submittedPlan = this.plan;
          if (this.buffers === current && submittedPlan !== undefined) {
            const submittedObservation = surfaceSubmissionObservation?.();
            this.telemetryPending = {
              buffers: current,
              plan: submittedPlan,
              resourceGeneration: this.resourceGeneration,
              indirectBufferIdentity: getOpaqueResourceIdentity(current.indirect as object),
              indirectReadbackOffset,
              ...(submittedObservation === undefined
                ? {}
                : {
                    surfaceReadbackSnapshot: () => submittedObservation.gpuReadbackSnapshot(),
                  }),
              ...(this.telemetrySubmit === undefined ? {} : { submit: this.telemetrySubmit }),
              occlusion,
            };
          }
        },
      });
    const resources = {
      ...(visibleSurfaceRows === undefined ? {} : { visibleSurfaceRows }),
      visible: visible.value,
      primitive: primitive.value,
      instance: instance.value,
      transform: transform.value,
      material: material.value,
      indirect: indirect.value,
      overflow: counters.value,
    };
    if (!lateOcclusion) {
      const readback = addReadback(false);
      if (!readback.ok) return readback;
      return ok(resources);
    }
    const owner = this;
    const addLateOcclusion = (
      pyramid: GraphTextureView,
    ): Result<GpuDrivenLateOcclusionGraph, RenderGraphError> => {
      const lateCull = builder.addComputePass(`${labelPrefix}.occlusion-cull`, {
        accesses: [
          { resource: primitive.value, usage: 'storage-read' },
          { resource: instance.value, usage: 'storage-read' },
          { resource: transform.value, usage: 'storage-read' },
          { resource: candidates.value, usage: 'storage-read' },
          { resource: batches.value, usage: 'storage-read' },
          { resource: view.value, usage: 'uniform-read' },
          { resource: counters.value, usage: 'storage-read-write' },
          { resource: visible.value, usage: 'storage-read-write' },
          { resource: pyramid, usage: 'sampled-read' },
        ],
        ...(executeIf === undefined ? {} : { executeIf }),
        encode: ({ pass, resources: graphResources }) => {
          pass.setPipeline(this.lateCullPipeline);
          pass.setBindGroup(0, liveBindGroup());
          pass.setBindGroup(1, this.pyramidBindGroup(graphResources.textureView(pyramid).unwrap()));
          pass.dispatchWorkgroups(
            Math.ceil(Math.max(1, submitted().candidateCount) / WORKGROUP_SIZE),
          );
          // The region this phase writes becomes next frame's history.
          this.visibilityParity ^= 1;
          this.visibilityHistoryKey = this.occlusionCamera?.historyKey;
          this.visibilityHistoryReady = true;
        },
      });
      if (!lateCull.ok) return lateCull;
      const lateFinalize = builder.addComputePass(`${labelPrefix}.occlusion-finalize-indirect`, {
        accesses: [
          { resource: batches.value, usage: 'storage-read' },
          { resource: view.value, usage: 'uniform-read' },
          { resource: counters.value, usage: 'storage-read-write' },
          { resource: indirect.value, usage: 'storage-read-write' },
        ],
        ...(executeIf === undefined ? {} : { executeIf }),
        encode: ({ pass }) => {
          pass.setPipeline(this.lateFinalizePipeline);
          pass.setBindGroup(0, liveBindGroup());
          pass.dispatchWorkgroups(
            Math.ceil(Math.max(1, submitted().batches.length) / WORKGROUP_SIZE),
          );
        },
      });
      if (!lateFinalize.ok) return lateFinalize;
      const readback = addReadback(true);
      if (!readback.ok) return readback;
      lateRecorded = true;
      return ok({
        passNames: Object.freeze([
          `${labelPrefix}.occlusion-cull`,
          `${labelPrefix}.occlusion-finalize-indirect`,
        ]),
        // Late regions start after the current early capacities.
        get lateIndirectByteOffset() {
          return owner.indirectCapacity * INDIRECT_COMMAND_BYTES;
        },
        get lateVisibleBase() {
          return owner.lateVisibleBase();
        },
      });
    };
    return ok({ ...resources, addLateOcclusion });
  }

  /**
   * Fill the per-frame occlusion words of the view constants. Queue writes
   * land before the command buffer that the current graph encode produces.
   */
  private writeOcclusionState(): void {
    const buffers = this.buffers;
    const camera = this.occlusionCamera;
    if (buffers === undefined) return;
    const state = new Uint32Array(OCCLUSION_STATE_BYTES / 4);
    if (camera !== undefined) {
      const bitsBase = this.batchCapacity * COUNTER_WORDS;
      const words = this.suppressionWordCapacity;
      const next = this.visibilityParity;
      state[0] = 1;
      state[1] =
        this.visibilityHistoryReady && this.visibilityHistoryKey === camera.historyKey ? 1 : 0;
      state[2] = bitsBase + (1 - next) * words;
      state[3] = bitsBase + next * words;
      state[4] = words;
      state[5] = (this.indirectCapacity * INDIRECT_COMMAND_BYTES) / 4;
      state[6] = this.lateVisibleBase();
    }
    // A late phase that never encodes leaves no history for the next frame.
    this.visibilityHistoryReady = false;
    const written = this.device.queue.writeBuffer(
      buffers.view,
      OCCLUSION_STATE_OFFSET,
      new Uint8Array(state.buffer),
    );
    if (!written.ok) throw written.error;
  }

  private pyramidBindGroup(pyramid: TextureView): BindGroup {
    const cached = this.pyramidBindGroups.get(pyramid);
    if (cached !== undefined) return cached;
    const created = this.device
      .createBindGroup({
        label: `${this.labelPrefix}-occlusion-bg`,
        layout: this.pyramidLayout,
        entries: [{ binding: 0, resource: { kind: 'textureView', value: pyramid } }],
      })
      .unwrap();
    this.pyramidBindGroups.set(pyramid, created);
    return created;
  }

  /** Skin scratch follows the original counters and visibility history. */
  private skinCounterBase(): number {
    return (this.batchCapacity * COUNTER_STRIDE) / 4 + this.suppressionWordCapacity * 2;
  }
  private skinDispatchBase(): number {
    return (this.indirectCapacity * INDIRECT_COMMAND_BYTES * 2) / 4;
  }
  private countersBytes(): number {
    return (this.skinCounterBase() + (this.skinLayout?.counterWords ?? 0)) * 4;
  }
  private visibleBytes(): number {
    return (
      this.skinLayout?.outputBytes ??
      this.visiblePrefixBytes(this.visibleBufferCapacity, this.lateMirror)
    );
  }
  /** Union region plus, when reserved, the late-phase mirror of two-phase occlusion. */
  private visiblePrefixBytes(capacity: number, lateMirror: boolean): number {
    return capacity * VISIBLE_ENTRY_BYTES * (lateMirror ? 2 : 1);
  }
  /** Without a reserved mirror, late items alias the union region and draw nothing new. */
  private lateVisibleBase(): number {
    return this.lateMirror ? this.visibleBufferCapacity : 0;
  }
  private indirectBytes(): number {
    return (this.skinDispatchBase() + (this.skinLayout === undefined ? 0 : 3)) * 4;
  }

  dispose(): void {
    this.shadowRaster = undefined;
    const holds = this.memberHolds;
    this.memberHolds = [];
    for (const hold of holds) hold.release();
    const buffers = [
      ...this.supersededBuffers,
      ...(this.buffers === undefined ? [] : [this.buffers]),
    ];
    this.supersededBuffers = [];
    this.buffers = undefined;
    this.surfaceRows = undefined;
    this.skinBindGroup = undefined;
    this.skinRasterBinding = undefined;
    this.skinLayout = undefined;
    this.skinJointCapacity = 0;
    this.skinActive = false;
    this.bindGroup = undefined;
    this.plan = undefined;
    this.encodedTopology = undefined;
    this.visibleBufferCapacity = 0;
    this.lateMirror = false;
    this.sceneInputs = undefined;
    this.sceneInputBytes = 0;
    this.scenePrimitive = undefined;
    this.sceneInstance = undefined;
    this.sceneTransform = undefined;
    this.sceneMaterial = undefined;
    this.sceneCapacity = 0;
    this.sceneTransformBytes = 0;
    this.suppressionWordCapacity = 0;
    this.suppressionMirror = new Uint32Array(0);
    this.suppressionSource = null;
    this.telemetryPending = undefined;
    this.telemetrySubmit = undefined;
    this.occlusionCamera = undefined;
    this.visibilityHistoryReady = false;
    this.lodSelectionReadback = undefined;
    this.lodSelection = undefined;
    for (const generation of buffers) this.retireGeneration(generation);
    this.destroyAfterSubmittedWork(buffers);
    void this.pipelineLayout;
  }

  /**
   * @internal
   * Accept the current buffer generation after its typed graph compiles.
   * Superseded imports stay alive while the last-known-good graph remains
   * executable, then retire behind the queue fence only after promotion.
   */
  _commitResourceReplacement(): void {
    const buffers = this.supersededBuffers;
    if (buffers.length === 0) return;
    this.supersededBuffers = [];
    this.destroyAfterSubmittedWork(buffers);
  }

  /**
   * @internal
   * Grow every view buffer after a GPU overflow was observed. The next
   * `update` rewrites the same plan into the replacement generation, so the
   * failed generation cannot be reused even when topology identity is stable.
   */
  _recoverFromOverflow(): Result<void, RhiError> {
    if (this.buffers === undefined) return ok(undefined);
    return this.rebuildBuffers(
      this.candidateCapacity * 2,
      this.visibleBufferCapacity * 2,
      this.batchCapacity * 2,
      this.indirectCapacity * 2,
      this.suppressionWordCapacity,
      this.buffers.visibleSurfaceRows !== undefined,
      this.skinJointCapacity,
      (this.skinLayout?.candidateCapacity ?? 0) * 2,
      this.lateMirror,
    );
  }

  /** Byte offset of the admission bitmap inside the batches buffer. */
  private suppressionBase(): number {
    return this.batchCapacity * BATCH_STRIDE;
  }

  /**
   * Upload only the bitmap words that differ from the last upload. The bitmap
   * covers every GPU Scene slot, so admission changes never touch the plan,
   * the candidate records or the render bundles that read them. A rebuilt
   * batches buffer starts undefined, so it receives the whole bitmap once.
   */
  private updateSuppression(
    buffer: Buffer,
    reseed: boolean,
    target: Uint32Array | undefined,
  ): Result<void, RhiError> {
    const base = this.suppressionBase();
    if (reseed) {
      this.suppressionReseed = false;
      this.suppressionMirror = new Uint32Array(this.suppressionWordCapacity);
      if (target !== undefined) this.suppressionMirror.set(target);
      const initial = this.device.queue.writeBuffer(
        buffer,
        base,
        new Uint8Array(this.suppressionMirror.buffer),
      );
      if (!initial.ok) return initial;
      this.suppressionUploadBytes += this.suppressionMirror.byteLength;
    } else if (target === this.suppressionSource) {
      // Same bitmap object: the mirror already equals it.
    } else if (
      target !== undefined &&
      this.suppressionSource !== null &&
      this.suppressionSource !== undefined &&
      suppressionPatchOf(target)?.base === this.suppressionSource
    ) {
      // A patched successor of the uploaded bitmap: visit only the words it
      // changed, so the upload cost follows the changes rather than capacity.
      const patch = suppressionPatchOf(target)?.words ?? [];
      const mirror = this.suppressionMirror;
      const dirty = [...patch].sort((a, b) => a - b);
      let index = 0;
      while (index < dirty.length) {
        const first = dirty[index] as number;
        let word = first;
        while (index < dirty.length && (dirty[index] as number) <= word) {
          word = (dirty[index] as number) + 1;
          index += 1;
        }
        for (let at = first; at < word; at++) mirror[at] = target[at] ?? 0;
        const written = this.device.queue.writeBuffer(
          buffer,
          base + first * 4,
          new Uint8Array(mirror.buffer, first * 4, (word - first) * 4),
        );
        if (!written.ok) return written;
        this.suppressionUploadBytes += (word - first) * 4;
      }
    } else {
      const mirror = this.suppressionMirror;
      let word = 0;
      while (word < mirror.length) {
        if (mirror[word] === (target?.[word] ?? 0)) {
          word += 1;
          continue;
        }
        const first = word;
        while (word < mirror.length && mirror[word] !== (target?.[word] ?? 0)) {
          mirror[word] = target?.[word] ?? 0;
          word += 1;
        }
        const written = this.device.queue.writeBuffer(
          buffer,
          base + first * 4,
          new Uint8Array(mirror.buffer, first * 4, (word - first) * 4),
        );
        if (!written.ok) return written;
        this.suppressionUploadBytes += (word - first) * 4;
      }
    }
    this.suppressionSource = target;
    this.uploadBytes += this.suppressionUploadBytes;
    return ok(undefined);
  }

  private rebuildBuffers(
    candidateCapacity: number,
    visibleCapacity: number,
    batchCapacity: number,
    indirectCapacity: number,
    suppressionWords: number,
    surfaceRows = this.buffers?.visibleSurfaceRows !== undefined,
    skinJointCapacity = this.skinJointCapacity,
    skinCandidateCapacity = this.skinLayout?.candidateCapacity ?? candidateCapacity,
    lateMirror = this.lateMirror,
  ): Result<void, RhiError> {
    const nextCandidate = nextCapacity(candidateCapacity);
    const nextSuppression = Math.max(nextCapacity(suppressionWords), this.suppressionWordCapacity);
    const nextBatch = nextCapacity(batchCapacity);
    const nextIndirect = nextCapacity(indirectCapacity);
    // The late mirror starts at the capacity and raster binds its windows at
    // static storage offsets, so the capacity keeps the 64-entry alignment
    // BatchTopology gives every early window. Skin output follows the visible
    // prefix inside the same binding, so its tail shares the binding budget.
    const skinTail =
      skinJointCapacity > 0
        ? skinDemandLayout(skinCandidateCapacity, skinJointCapacity).outputBytes
        : 0;
    const storageLimit = Number(this.device.limits.maxStorageBufferBindingSize);
    const visibleCeiling =
      Number.isFinite(storageLimit) && storageLimit > 0
        ? (storageLimit - skinTail - 64) / this.visiblePrefixBytes(1, lateMirror)
        : Number.MAX_SAFE_INTEGER;
    const nextVisible = growGpuDrivenVisibleCapacity(
      // A changed mirror reserves a new allocation; its capacity restarts exact.
      lateMirror === this.lateMirror ? this.visibleBufferCapacity : 0,
      visibleCapacity,
      visibleCeiling,
    );
    const skinLayout =
      skinJointCapacity > 0
        ? skinDemandLayout(
            skinCandidateCapacity,
            skinJointCapacity,
            this.visiblePrefixBytes(nextVisible, lateMirror),
          )
        : undefined;
    const previous = this.buffers;
    const created: Partial<MutableViewBuffers> = {};
    const allocatedBuffers: Buffer[] = [];
    const createdTokens: GpuResourceAllocationToken[] = [];
    const allocate = (
      name: keyof ViewBuffers,
      size: number,
      usage: number,
    ): Result<void, RhiError> => {
      const buffer = this.device.createBuffer({
        label: `gpu-driven-view-${name}`,
        size,
        usage,
        mappedAtCreation: false,
      });
      if (!buffer.ok) return buffer;
      created[name] = buffer.value;
      allocatedBuffers.push(buffer.value);
      const token = this.allocationLedger.allocate(size);
      this.allocationTokens.set(buffer.value, token);
      createdTokens.push(token);
      return ok(undefined);
    };
    const storage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC;
    const requests: readonly {
      readonly name: keyof ViewBuffers;
      readonly size: number;
      readonly usage: number;
      readonly storage: boolean;
    }[] = [
      {
        name: 'batches',
        size: nextBatch * BATCH_STRIDE + nextSuppression * 4,
        usage: storage | GPU_BUFFER_USAGE_COPY_DST,
        storage: true,
      },
      {
        name: 'view',
        size: VIEW_BYTES,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
        storage: false,
      },
      {
        name: 'counters',
        size:
          nextBatch * COUNTER_STRIDE +
          nextSuppression * 2 * 4 +
          (skinLayout?.counterWords ?? 0) * 4,
        usage: storage | GPU_BUFFER_USAGE_COPY_DST,
        storage: true,
      },
      {
        name: 'visible',
        size: skinLayout?.outputBytes ?? this.visiblePrefixBytes(nextVisible, lateMirror),
        usage: storage,
        storage: true,
      },
      {
        name: 'indirect',
        // Main region plus the late-phase region of two-phase occlusion.
        size: nextIndirect * INDIRECT_COMMAND_BYTES * 2 + (skinLayout === undefined ? 0 : 12),
        usage: storage | GPU_BUFFER_USAGE_INDIRECT,
        storage: true,
      },
      ...(surfaceRows
        ? [
            {
              name: 'visibleSurfaceRows' as const,
              size: nextVisible * 4,
              usage: storage | GPU_BUFFER_USAGE_COPY_DST,
              storage: true,
            },
          ]
        : []),
      {
        name: 'lodReadback',
        size: nextBatch * COUNTER_STRIDE + nextVisible * 16 + nextIndirect * INDIRECT_COMMAND_BYTES,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
        storage: false,
      },
    ];
    const maxBufferSize = Number(this.device.limits.maxBufferSize);
    const maxStorageBufferBindingSize = Number(this.device.limits.maxStorageBufferBindingSize);
    for (const request of requests) {
      const limit = request.storage ? maxStorageBufferBindingSize : maxBufferSize;
      if (!Number.isFinite(limit) || limit <= 0 || request.size <= limit) continue;
      return err(
        new RhiError({
          code: 'limit-exceeded',
          expected: `GPU-driven ${request.name} buffer (${request.size} B) fits within ${request.storage ? 'device.limits.maxStorageBufferBindingSize' : 'device.limits.maxBufferSize'} (${limit} B)`,
          hint: 'reduce the visible/candidate workload or split the GPU-driven buffer plan before retrying',
          detail: {
            maxStorageBufferBindingSize: limit,
            requestedBytes: request.size,
          },
        }),
      );
    }
    for (const request of requests) {
      const result = allocate(request.name, request.size, request.usage);
      if (!result.ok) {
        for (const buffer of allocatedBuffers) this.device.destroyBuffer(buffer);
        for (const token of createdTokens) this.allocationLedger.rollback(token);
        return result;
      }
    }
    const next = created as ViewBuffers;
    if (previous !== undefined && this.visibilityHistoryReady) {
      const carried = this.carryVisibilityHistory(previous, next, nextBatch, nextSuppression);
      if (!carried.ok) {
        for (const buffer of allocatedBuffers) this.device.destroyBuffer(buffer);
        for (const token of createdTokens) this.allocationLedger.rollback(token);
        return carried;
      }
    }
    if (previous !== undefined) {
      this.supersededBuffers.push(previous);
      this.retireGeneration(previous);
    }
    this.buffers = next;
    this.skinLayout = skinLayout;
    this.skinJointCapacity = skinJointCapacity;
    this.skinBindGroup = undefined;
    this.skinRasterBinding =
      skinLayout === undefined
        ? undefined
        : {
            data: next.visible,
            auxiliary: next.view,
            dataOffset: 0,
            auxiliaryOffset: SKIN_RASTER_OFFSET,
            dataSize: skinLayout.outputBytes,
            auxiliarySize: 16,
          };
    // Replacement storage has no submitted topology or receiver addresses.
    this.plan = undefined;
    this.encodedTopology = undefined;
    this.surfaceRows = undefined;
    this.candidateCapacity = nextCandidate;
    this.visibleBufferCapacity = nextVisible;
    this.lateMirror = lateMirror;
    this.batchCapacity = nextBatch;
    this.indirectCapacity = nextIndirect;
    this.suppressionWordCapacity = nextSuppression;
    this.suppressionReseed = true;
    this.bufferRebuilds += 1;
    this.bindGroup = undefined;
    this.telemetryPending = undefined;
    return ok(undefined);
  }

  /**
   * Capacity growth must not cost the HZB history: a World joining the view
   * would otherwise draw every candidate in the early phase for one frame.
   * Copy the region the next frame reads as `previousBase`; rows past the old
   * bitmap stay zero and take the late test, which still draws them if visible.
   */
  private carryVisibilityHistory(
    from: ViewBuffers,
    to: ViewBuffers,
    toBatchCapacity: number,
    toWords: number,
  ): Result<void, RhiError> {
    const fromWords = this.suppressionWordCapacity;
    if (fromWords === 0) return ok(undefined);
    const region = 1 - this.visibilityParity;
    const encoder = this.device.createCommandEncoder({
      label: `${this.labelPrefix}-visibility-history-carry`,
    });
    if (!encoder.ok) return encoder;
    encoder.value.copyBufferToBuffer(
      from.counters,
      (this.batchCapacity * COUNTER_WORDS + region * fromWords) * 4,
      to.counters,
      (toBatchCapacity * COUNTER_WORDS + region * toWords) * 4,
      fromWords * 4,
    );
    const commands = encoder.value.finish();
    if (!commands.ok) return commands;
    return this.device.queue.submit([commands.value]);
  }

  private destroyAfterSubmittedWork(generations: readonly Partial<ViewBuffers>[]): void {
    if (generations.length === 0) return;
    const release = (): void => {
      for (const buffers of generations) {
        for (const buffer of Object.values(buffers)) {
          this.device.destroyBuffer(buffer);
          const token = this.allocationTokens.get(buffer);
          if (token !== undefined) this.allocationLedger.release(token);
        }
      }
    };
    void this.device.queue.onSubmittedWorkDone().then(release, release);
  }

  private retireGeneration(generation: Partial<ViewBuffers>): void {
    for (const buffer of Object.values(generation)) {
      const token = this.allocationTokens.get(buffer);
      if (token !== undefined) this.allocationLedger.retire(token);
    }
  }
}
