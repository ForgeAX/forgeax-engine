import { GPU_SCENE_PRIMITIVE_CAPSULE_SHADOW } from '../gpu-scene';
import { GPU_MATERIAL_DESCRIPTOR, GPU_MESH_DESCRIPTOR } from '../gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS, gpuSceneWgsl } from '../gpu-scene-schema';
import { SKIN_INPUT_WGSL } from '../scene/skin-inputs.wgsl';
import { LOD_PROJECTION_WGSL } from './lod-projection.wgsl';
import { SHADOW_LOD_COARSEST } from './production-raster-lod';
import { shadowCameraCullWgsl } from './shadow-camera-cull.wgsl';
import { SKIN_BOUNDS_WGSL } from './skin-bounds.wgsl';
import { SKIN_DEMAND_WGSL } from './skin-demand.wgsl';
import {
  BATCH_HEADER_STRIDE,
  BATCH_STRIDE,
  CAMERA_CULLED_COUNTER_OFFSET,
  COUNTER_WORDS,
  EARLY_VISIBLE_COUNTER_OFFSET,
  FRUSTUM_CULLED_COUNTER_OFFSET,
  GEOMETRY_WORK_COUNTER_OFFSET,
  LEVEL_VISIBLE_COUNTER_OFFSET,
  LOD_COUNTER_OFFSET,
  LOD_ROW_CAPACITY,
  LOD_ROW_STRIDE,
  OCCLUSION_CULLED_COUNTER_OFFSET,
  ORDER_SCAN_LANES,
  ORDER_TILE_WORDS,
  ROOT_GEOMETRY_WORK_COUNTER_OFFSET,
  SHADOW_CAMERA_CULL_SLABS,
  SKIN_CONSTANTS_OFFSET,
  SKIN_RASTER_OFFSET,
  TEXEL_CULLED_COUNTER_OFFSET,
  WORKGROUP_SIZE,
} from './view-layout';

const SKIN_VIEW_WGSL = `${SKIN_INPUT_WGSL}\n${SKIN_DEMAND_WGSL}\n${SKIN_BOUNDS_WGSL}`
  .replaceAll(/\bskinInputs\b/g, 'sceneInputs')
  .replaceAll(/\bskinCounters\b/g, 'counters')
  .replaceAll(/\bskinOutput\b/g, 'visibleIndices')
  .replaceAll(/\bskinIndirect\b/g, 'indirectArgs')
  .replaceAll(/\bskinDemand\b/g, 'view.skin');
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
  // First counters word of the visible-order scratch (see orderTileBase).
  orderBase: u32,
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
  let control = batchIndex * ${BATCH_STRIDE / 4}u;
  if (word == 7u) { return batchWords[control]; }
  return sceneInputs[batchWords[control + 1u] + word];
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
      batchWord(candidate.batchIndex, 1u) == 0u || isSuppressed(candidate.primitiveIndex)) { return 0xffffffffu; }
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

// Visible items are placed in candidate order, never in atomic arrival order:
// with discard-free opaque programs the rasterizer resolves equal-depth and
// overlapping fragments by submission order, so an arrival-ordered segment
// changes pixels from frame to frame. The cull records each admitted
// candidate and counts it per 64-candidate tile; scanVisibleOrder turns the
// tile counts into per-level prefixes, and placeVisibleOrder writes every
// item at its batch-local rank.
//
// Scratch layout after the counters' other regions: eight batch bases per
// batch, then one block per tile of [8 counts, 8 prefixes, 64 records of
// (flags, instance, material, fade)]. Flags: bit 0 admitted, bits 1-4 level,
// bit 5 paired with level + 1, bits 6+ batch index.
fn orderBatchBase(batchIndex: u32, level: u32) -> u32 {
  return view.orderBase + batchIndex * ${LOD_ROW_CAPACITY}u + level;
}
fn orderTileBase(tile: u32) -> u32 {
  return view.orderBase + view.batchCapacity * ${LOD_ROW_CAPACITY}u + tile * ${ORDER_TILE_WORDS}u;
}
fn orderRecord(candidateIndex: u32) -> u32 {
  return orderTileBase(candidateIndex >> 6u) + ${2 * LOD_ROW_CAPACITY}u + (candidateIndex & 63u) * 4u;
}
fn clearOrderRecord(candidateIndex: u32) {
  if (candidateIndex >= view.candidateCount) { return; }
  atomicStore(&counters[orderRecord(candidateIndex)], 0u);
}

// Count one visible item of the batch's per-level segment; each segment is an
// independent indirect command sized by the batch's visible capacity.
fn countVisible(batchIndex: u32, candidateIndex: u32, level: u32) {
  let localVisible = atomicAdd(&counters[levelVisibleIndex(batchIndex, level)], 1u);
  if (localVisible >= batchWord(batchIndex, 1u)) {
    atomicStore(&counters[overflowIndex(batchIndex)], 1u);
  }
  atomicAdd(&counters[orderTileBase(candidateIndex >> 6u) + level], 1u);
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
  let record = orderRecord(candidateIndex);
  atomicStore(&counters[record + 1u], instanceIndex);
  atomicStore(&counters[record + 2u], materialIndex);
  atomicStore(&counters[record + 3u], bitcast<u32>(lod.fade));
  atomicStore(
    &counters[record],
    1u | (level << 1u) | select(0u, 32u, lod.paired) | (candidate.batchIndex << 6u),
  );
  countVisible(candidate.batchIndex, candidateIndex, level);
  if (lod.paired) { countVisible(candidate.batchIndex, candidateIndex, level + 1u); }
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
  if (isSuppressed(candidate.primitiveIndex)) { return false; }
  if (!isVisible(primitive, world)) {
    atomicAdd(&counters[counterIndex(candidate.batchIndex) + ${FRUSTUM_CULLED_COUNTER_OFFSET}u], 1u);
    return false;
  }
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
  );
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn cullView(@builtin(global_invocation_id) id: vec3<u32>) {
  clearOrderRecord(id.x);
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
  clearOrderRecord(candidateIndex);
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
    !isSuppressed(candidate.primitiveIndex) &&
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
  );
}

var<workgroup> orderLaneSums: array<array<u32, ${LOD_ROW_CAPACITY}>, ${ORDER_SCAN_LANES}>;
var<workgroup> orderLaneFlags: array<u32, ${WORKGROUP_SIZE}>;

// One workgroup: tile counts become exclusive per-level prefixes over every
// candidate before the tile, and each batch records the prefix at its first
// candidate. Counts are cleared for the next phase.
@compute @workgroup_size(${ORDER_SCAN_LANES})
fn scanVisibleOrder(@builtin(local_invocation_index) lane: u32) {
  let tiles = (view.candidateCount + 63u) / 64u;
  let span = (tiles + ${ORDER_SCAN_LANES - 1}u) / ${ORDER_SCAN_LANES}u;
  let first = min(lane * span, tiles);
  let end = min(first + span, tiles);
  var sums: array<u32, ${LOD_ROW_CAPACITY}>;
  for (var tile = first; tile < end; tile += 1u) {
    let base = orderTileBase(tile);
    for (var level = 0u; level < ${LOD_ROW_CAPACITY}u; level += 1u) {
      sums[level] += atomicLoad(&counters[base + level]);
    }
  }
  orderLaneSums[lane] = sums;
  workgroupBarrier();
  var running: array<u32, ${LOD_ROW_CAPACITY}>;
  for (var other = 0u; other < lane; other += 1u) {
    let counted = orderLaneSums[other];
    for (var level = 0u; level < ${LOD_ROW_CAPACITY}u; level += 1u) { running[level] += counted[level]; }
  }
  for (var tile = first; tile < end; tile += 1u) {
    let base = orderTileBase(tile);
    for (var level = 0u; level < ${LOD_ROW_CAPACITY}u; level += 1u) {
      let count = atomicLoad(&counters[base + level]);
      atomicStore(&counters[base + ${LOD_ROW_CAPACITY}u + level], running[level]);
      atomicStore(&counters[base + level], 0u);
      running[level] += count;
    }
  }
  storageBarrier();
  workgroupBarrier();
  for (var batchIndex = lane; batchIndex < view.batchCount; batchIndex += ${ORDER_SCAN_LANES}u) {
    let start = batchWord(batchIndex, 7u);
    if (start >= view.candidateCount) { continue; }
    let tileBase = orderTileBase(start >> 6u);
    var base: array<u32, ${LOD_ROW_CAPACITY}>;
    for (var level = 0u; level < ${LOD_ROW_CAPACITY}u; level += 1u) {
      base[level] = atomicLoad(&counters[tileBase + ${LOD_ROW_CAPACITY}u + level]);
    }
    for (var candidateIndex = start & ~63u; candidateIndex < start; candidateIndex += 1u) {
      let flags = atomicLoad(&counters[orderRecord(candidateIndex)]);
      if ((flags & 1u) == 0u) { continue; }
      let level = min((flags >> 1u) & 15u, ${LOD_ROW_CAPACITY - 1}u);
      base[level] += 1u;
      if ((flags & 32u) != 0u) { base[min(level + 1u, ${LOD_ROW_CAPACITY - 1}u)] += 1u; }
    }
    for (var level = 0u; level < ${LOD_ROW_CAPACITY}u; level += 1u) {
      atomicStore(&counters[orderBatchBase(batchIndex, level)], base[level]);
    }
  }
}

// Late items follow the early prefix finalizeView stored; the mirror index is
// the item's rank within the late suffix.
fn placeVisible(
  batchIndex: u32,
  candidateIndex: u32,
  lane: u32,
  level: u32,
  item: vec4<u32>,
  late: bool,
) {
  var rank =
    atomicLoad(&counters[orderTileBase(candidateIndex >> 6u) + ${LOD_ROW_CAPACITY}u + level]) -
    atomicLoad(&counters[orderBatchBase(batchIndex, level)]);
  for (var other = 0u; other < lane; other += 1u) {
    let flags = orderLaneFlags[other];
    if ((flags & 1u) == 0u) { continue; }
    let otherLevel = (flags >> 1u) & 15u;
    if (otherLevel == level || ((flags & 32u) != 0u && otherLevel + 1u == level)) { rank += 1u; }
  }
  var slot = rank;
  if (late) { slot += atomicLoad(&counters[earlyVisibleIndex(batchIndex, level)]); }
  if (slot >= batchWord(batchIndex, 1u)) { return; }
  let segmentBase = batchWord(batchIndex, 0u) + level * batchWord(batchIndex, 8u);
  visibleIndices[segmentBase + slot] = item;
  if (late) { visibleIndices[view.occlusion.lateVisibleBase + segmentBase + rank] = item; }
}

// Visible item ABI: x = GPU Scene instance row, y = scene material row,
// z = the view candidate row for every deformation,
// w = bitcast LOD crossfade. Submeshes share an instance row, so per-draw
// tables (Surface frame rows) key by the candidate row.
fn placeVisibleItems(candidateIndex: u32, lane: u32, late: bool) {
  var flags = 0u;
  if (candidateIndex < view.candidateCount) {
    flags = atomicLoad(&counters[orderRecord(candidateIndex)]);
  }
  orderLaneFlags[lane] = flags;
  workgroupBarrier();
  if ((flags & 1u) == 0u) { return; }
  let batchIndex = flags >> 6u;
  let level = (flags >> 1u) & 15u;
  let record = orderRecord(candidateIndex);
  let item = vec4<u32>(
    atomicLoad(&counters[record + 1u]),
    atomicLoad(&counters[record + 2u]),
    candidateIndex,
    atomicLoad(&counters[record + 3u]),
  );
  placeVisible(batchIndex, candidateIndex, lane, level, item, late);
  if ((flags & 32u) != 0u) {
    placeVisible(
      batchIndex,
      candidateIndex,
      lane,
      level + 1u,
      vec4<u32>(item.xyz, bitcast<u32>(-bitcast<f32>(item.w))),
      late,
    );
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn placeVisibleOrder(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(local_invocation_index) lane: u32,
) {
  placeVisibleItems(id.x, lane, false);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn placeVisibleOrderLate(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(local_invocation_index) lane: u32,
) {
  placeVisibleItems(id.x, lane, true);
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
export const GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL = shadowCameraCullWgsl(
  GPU_DRIVEN_VIEW_WGSL,
  WORKGROUP_SIZE,
  SHADOW_CAMERA_CULL_SLABS,
  CAMERA_CULLED_COUNTER_OFFSET,
);
