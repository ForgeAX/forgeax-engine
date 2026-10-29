/**
 * Actual candidate work supplies skinDemandCandidateSlot(index). Execution
 * scratch and transient output belong to the view, separately from Scene rows.
 * The owner declares skinInputs, skinDemand, skinCounters, skinOutput and skinIndirect (the existing indirect-argument buffer).
 */
export const SKIN_DEMAND_WGSL = /* wgsl */ `
struct SkinDemandConstants {
  currentRoot: u32,
  previousRoot: u32,
  candidateCount: u32,
  hashCapacity: u32,
  counterBase: u32,
  descriptorBase: u32,
  rosterBase: u32,
  paletteBase: u32,
  jointCapacity: u32,
  rosterCapacity: u32,
  dispatchBase: u32,
  maxWorkgroups: u32,
};

// Clear only the previous compact demand roster. A separate reset dispatch
// follows this pass; clearing the count in this dispatch would race readers.
@compute @workgroup_size(64)
fn clearSkinDemand(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let index = id.x + id.y * groups.x * 64u;
  let count = min(atomicLoad(&skinCounters[skinDemand.counterBase]), skinDemand.rosterCapacity);
  if (index >= count) { return; }
  let hashSlot = skinOutput[skinDemand.rosterBase + index].x;
  atomicStore(&skinCounters[skinDemand.counterBase + 4u + hashSlot], 0u);
  skinOutput[skinDemand.descriptorBase + hashSlot] = vec4<u32>(0u);
}

@compute @workgroup_size(1)
fn resetSkinDemand() {
  atomicStore(&skinCounters[skinDemand.counterBase], 0u);
  atomicStore(&skinCounters[skinDemand.counterBase + 1u], 0u);
  atomicStore(&skinCounters[skinDemand.counterBase + 2u], 0u);
}

// No workgroup waits for another claimant: collisions have a finite probe
// bound. Later dispatches, rather than spinning, consume completed descriptors.
@compute @workgroup_size(64)
fn claimSkinDemand(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let index = id.x + id.y * groups.x * 64u;
  if (index >= skinDemand.candidateCount) { return; }
  // Every actual candidate writes its own reference. Raster/cull reads this
  // directly via the unchanged visible.z candidate identity, never a hash probe.
  let candidateBase = skinDemand.rosterBase + skinDemand.rosterCapacity;
  skinOutput[candidateBase + index] = vec4<u32>(0xffffffffu, 0u, 0u, 0u);
  let slot = skinDemandCandidateSlot(index);
  if (slot == 0xffffffffu) { return; }
  let binding = skinRowAddress(skinDemand.currentRoot, 1u, slot);
  if (binding == 0xffffffffu) { return; }
  let count = skinInputs[binding];
  if (count == 0u) { return; }
  let key = slot + 1u;
  var hashSlot = (slot * 0x9e3779b9u) & (skinDemand.hashCapacity - 1u);
  for (var probe = 0u; probe < skinDemand.hashCapacity; probe++) {
    let claim = atomicCompareExchangeWeak(&skinCounters[skinDemand.counterBase + 4u + hashSlot], 0u, key);
    if (claim.exchanged) {
      skinOutput[candidateBase + index].x = hashSlot;
      let demand = atomicAdd(&skinCounters[skinDemand.counterBase], 1u);
      if (demand >= skinDemand.rosterCapacity) {
        atomicStore(&skinCounters[skinDemand.counterBase + 2u], 1u);
        return;
      }
      // Every acquired key is retained for sparse clear, including a rejected
      // palette allocation. Every key owns a joint, so rosterCapacity >= keys.
      skinOutput[skinDemand.rosterBase + demand] = vec4<u32>(hashSlot, 0u, 0u, 0u);
      let joints = atomicAdd(&skinCounters[skinDemand.counterBase + 1u], count);
      if (joints > skinDemand.jointCapacity || count > skinDemand.jointCapacity - joints) {
        atomicStore(&skinCounters[skinDemand.counterBase + 2u], 1u);
        return;
      }
      // Descriptor = complete key, joint count, vec4 palette base, valid flags.
      // Palette addresses never replace persistent Instance/customData fields.
      skinOutput[skinDemand.descriptorBase + hashSlot] = vec4<u32>(key, count, skinDemand.paletteBase + joints * 8u, 0u);
      return;
    }
    if (claim.old_value == key) {
      skinOutput[candidateBase + index].x = hashSlot;
      return;
    }
    // Weak exchange may fail spuriously at an empty slot. Retrying that
    // location uses the same bounded iteration; it never waits on a producer.
    if (claim.old_value != 0u) { hashSlot = (hashSlot + 1u) & (skinDemand.hashCapacity - 1u); }
  }
  atomicStore(&skinCounters[skinDemand.counterBase + 2u], 1u);
}

// Separate from claim: every descriptor and the compact count is complete.
// The host admits rosterCapacity <= maxWorkgroups squared before any dispatch.
@compute @workgroup_size(1)
fn finalizeSkinDemand() {
  var count = min(atomicLoad(&skinCounters[skinDemand.counterBase]), skinDemand.rosterCapacity);
  if (atomicLoad(&skinCounters[skinDemand.counterBase + 2u]) != 0u) { count = 0u; }
  skinIndirect[skinDemand.dispatchBase] = max(1u, min(count, skinDemand.maxWorkgroups));
  skinIndirect[skinDemand.dispatchBase + 1u] = max(1u, (count + skinDemand.maxWorkgroups - 1u) / skinDemand.maxWorkgroups);
  skinIndirect[skinDemand.dispatchBase + 2u] = 1u;
}

var<workgroup> skinDemandRow: vec4<u32>;
var<workgroup> skinDemandHashSlot: u32;
var<workgroup> skinDemandBinding: u32;
var<workgroup> skinDemandSkeleton: u32;
var<workgroup> skinDemandAvailable: bool;
var<workgroup> skinDemandHistory: bool;
var<workgroup> skinDemandMissing: atomic<u32>;
var<workgroup> skinDemandMissingHistory: atomic<u32>;
var<workgroup> skinDemandInvalid: atomic<u32>;
var<workgroup> skinDemandInvalidHistory: atomic<u32>;

fn skinDemandDescriptor(candidateIndex: u32) -> vec4<u32> {
  if (candidateIndex >= skinDemand.candidateCount) { return vec4<u32>(0u); }
  let candidateBase = skinDemand.rosterBase + skinDemand.rosterCapacity;
  let hashSlot = skinOutput[candidateBase + candidateIndex].x;
  if (hashSlot >= skinDemand.hashCapacity) { return vec4<u32>(0u); }
  return skinOutput[skinDemand.descriptorBase + hashSlot];
}

// Integer exponent tests: WGSL implementations may assume float comparisons
// never observe Inf/NaN and fold them away.
fn skinDemandFiniteColumn(column: vec4<f32>) -> bool {
  return all((bitcast<vec4<u32>>(column) & vec4<u32>(0x7fffffffu)) <= vec4<u32>(0x7f7fffffu));
}
fn skinDemandFinite(matrix: mat4x4<f32>) -> bool {
  return skinDemandFiniteColumn(matrix[0]) && skinDemandFiniteColumn(matrix[1]) &&
    skinDemandFiniteColumn(matrix[2]) && skinDemandFiniteColumn(matrix[3]);
}

fn skinDemandWriteMatrix(base: u32, matrix: mat4x4<f32>) {
  skinOutput[base] = bitcast<vec4<u32>>(matrix[0]);
  skinOutput[base + 1u] = bitcast<vec4<u32>>(matrix[1]);
  skinOutput[base + 2u] = bitcast<vec4<u32>>(matrix[2]);
  skinOutput[base + 3u] = bitcast<vec4<u32>>(matrix[3]);
}

// Lane 0 resolves only the shared Binding/Skeleton rows. Every joint's
// presence, composition and finiteness are checked by the lanes that write it,
// so a complete pose costs no serial walk over all joints.
@compute @workgroup_size(64)
fn resolveSkinDemand(@builtin(workgroup_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let demandIndex = id.x + id.y * groups.x;
  if (lane == 0u) {
    skinDemandAvailable = false;
    skinDemandHistory = false;
    atomicStore(&skinDemandMissing, 0u);
    atomicStore(&skinDemandMissingHistory, 0u);
    atomicStore(&skinDemandInvalid, 0u);
    atomicStore(&skinDemandInvalidHistory, 0u);
    if (demandIndex < min(atomicLoad(&skinCounters[skinDemand.counterBase]), skinDemand.rosterCapacity) &&
        atomicLoad(&skinCounters[skinDemand.counterBase + 2u]) == 0u) {
      skinDemandHashSlot = skinOutput[skinDemand.rosterBase + demandIndex].x;
      skinDemandRow = skinOutput[skinDemand.descriptorBase + skinDemandHashSlot];
      let slot = skinDemandRow.x - 1u;
      let binding = skinRowAddress(skinDemand.currentRoot, 1u, slot);
      if (binding != 0xffffffffu) {
        let count = skinInputs[binding];
        let skeletonKey = skinInputs[binding + 2u];
        let skeleton = skinRowAddress(skinDemand.currentRoot, 0u, skeletonKey);
        if (skeleton != 0xffffffffu && skinInputs[skeleton] == count && count > 0u) {
          skinDemandBinding = binding;
          skinDemandSkeleton = skeleton;
          skinDemandAvailable = true;
          // Both roots are retained by one arena: equal row addresses denote the
          // exact immutable Binding/Skeleton versions in the previous frame.
          skinDemandHistory =
            skinRowAddress(skinDemand.previousRoot, 1u, slot) == binding &&
            skinRowAddress(skinDemand.previousRoot, 0u, skeletonKey) == skeleton;
        }
      }
    }
  }
  workgroupBarrier();
  let available = workgroupUniformLoad(&skinDemandAvailable);
  if (available) {
    let zero = mat4x4<f32>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
    let binding = skinDemandBinding;
    let count = skinInputs[binding];
    let jointSpace = skinInputs[binding + 1u];
    for (var index = lane; index < skinDemandRow.y; index += 64u) {
      var current = zero;
      var previous = zero;
      if (index < count) {
        let entity = skinInputs[binding + 3u + index];
        let inverse = skinInputMatrix(skinDemandSkeleton + 1u + index * 16u);
        let joint = skinRowAddress(skinDemand.currentRoot, jointSpace, entity);
        if (joint == 0xffffffffu || skinInputs[joint] != entity) {
          atomicStore(&skinDemandMissing, 1u);
        } else {
          current = skinInputMatrix(joint + 1u) * inverse;
        }
        previous = current;
        if (skinDemandHistory) {
          let before = skinRowAddress(skinDemand.previousRoot, jointSpace, entity);
          if (before == 0xffffffffu || skinInputs[before] != entity) {
            atomicStore(&skinDemandMissingHistory, 1u);
          } else {
            previous = skinInputMatrix(before + 1u) * inverse;
          }
        }
      }
      if (!skinDemandFinite(current)) { atomicStore(&skinDemandInvalid, 1u); }
      if (!skinDemandFinite(previous)) { atomicStore(&skinDemandInvalidHistory, 1u); }
      skinDemandWriteMatrix(skinDemandRow.z + index * 4u, current);
      skinDemandWriteMatrix(skinDemandRow.z + (skinDemandRow.y + index) * 4u, previous);
    }
  }
  workgroupBarrier();
  // A missing current joint is not a complete pose: no flags are published.
  if (available && atomicLoad(&skinDemandMissing) == 0u) {
    let invalid = atomicLoad(&skinDemandInvalid);
    let history = skinDemandHistory && atomicLoad(&skinDemandMissingHistory) == 0u;
    // Seed the complete previous pose from current when history is absent,
    // incomplete or not representable; no compatible prefix survives.
    let resetHistory = (skinDemandHistory && !history) || atomicLoad(&skinDemandInvalidHistory) != 0u;
    if (resetHistory) {
      for (var index = lane; index < skinDemandRow.y; index += 64u) {
        let currentBase = skinDemandRow.z + index * 4u;
        let previousBase = currentBase + skinDemandRow.y * 4u;
        for (var column = 0u; column < 4u; column++) { skinOutput[previousBase + column] = skinOutput[currentBase + column]; }
      }
    }
    if (lane == 0u) {
      skinOutput[skinDemand.descriptorBase + skinDemandHashSlot].w =
        select(0u, 1u | select(0u, 2u, history && !resetHistory), invalid == 0u);
    }
  }
}
`;
