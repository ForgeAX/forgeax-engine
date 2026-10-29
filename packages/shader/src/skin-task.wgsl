#define_import_path forgeax_skin::task

#if STORAGE_BUFFER_AVAILABLE == true
struct SkinTaskAddress {
  candidateBase: u32,
  descriptorBase: u32,
  directCandidate: u32,
  reserved: u32,
};
@group(2) @binding(1) var<storage, read> skinTaskOutput: array<vec4<u32>>;
@group(2) @binding(2) var<uniform> skinTaskAddress: SkinTaskAddress;
#else
// 255 matrices plus one 16-byte state row fit the 16 KiB portable UBO limit.
struct SkinUniformTask {
  joints: array<mat4x4<f32>, 255>,
  state: vec4<u32>, // count, current/history validity, reserved
};
struct SkinUniformPrevious {
  joints: array<mat4x4<f32>, 255>,
};
@group(2) @binding(1) var<uniform> skinTaskCurrent: SkinUniformTask;
@group(2) @binding(2) var<uniform> skinTaskPrevious: SkinUniformPrevious;
#endif

fn skinTaskDirectCandidate() -> u32 {
#if STORAGE_BUFFER_AVAILABLE == true
  return skinTaskAddress.directCandidate;
#else
  return 0u;
#endif
}

// The candidate identity is unchanged in visible.z. Both Direct and indirect
// storage draws consume the same task layout; no Scene field holds an address.
fn skinTaskDescriptor(candidate: u32) -> vec4<u32> {
#if STORAGE_BUFFER_AVAILABLE == true
  let hashSlot = skinTaskOutput[skinTaskAddress.candidateBase + candidate].x;
  if (hashSlot == 0xffffffffu) { return vec4<u32>(0u); }
  return skinTaskOutput[skinTaskAddress.descriptorBase + hashSlot];
#else
  return vec4<u32>(0u, skinTaskCurrent.state.x, 0u, skinTaskCurrent.state.y);
#endif
}

fn skinTaskHistoryValid(descriptor: vec4<u32>) -> bool {
  return (descriptor.w & 3u) == 3u;
}

fn skinTaskJoint(descriptor: vec4<u32>, index: u32, previous: bool) -> mat4x4<f32> {
  if ((descriptor.w & 1u) == 0u || index >= descriptor.y) {
    return mat4x4<f32>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
  }
#if STORAGE_BUFFER_AVAILABLE == true
  let base = descriptor.z + (index + select(0u, descriptor.y, previous)) * 4u;
  return mat4x4<f32>(bitcast<vec4<f32>>(skinTaskOutput[base]),
    bitcast<vec4<f32>>(skinTaskOutput[base + 1u]),
    bitcast<vec4<f32>>(skinTaskOutput[base + 2u]),
    bitcast<vec4<f32>>(skinTaskOutput[base + 3u]));
#else
  if (previous) { return skinTaskPrevious.joints[index]; }
  return skinTaskCurrent.joints[index];
#endif
}

fn skinTaskBlend(descriptor: vec4<u32>, indices: vec4<u32>, weights: vec4<f32>, previous: bool) -> mat4x4<f32> {
  return skinTaskJoint(descriptor, indices.x, previous) * weights.x +
    skinTaskJoint(descriptor, indices.y, previous) * weights.y +
    skinTaskJoint(descriptor, indices.z, previous) * weights.z +
    skinTaskJoint(descriptor, indices.w, previous) * weights.w;
}
