import { SKIN_INPUT_WGSL } from '../scene/skin-inputs.wgsl';

const inputs = `${SKIN_INPUT_WGSL}
struct SkinFrame { currentRoot: u32, previousRoot: u32, bindingSlot: u32, reserved: u32, };
@group(2) @binding(1) var<storage, read> skinInputs: array<u32>;
@group(2) @binding(2) var<uniform> skinFrame: SkinFrame;
// Reference queries over the published arena layout; production resolves the
// same rows in parallel inside resolveSkinDemand.
// Returning zero for an individual missing influence is not pose admission.
fn skinPoseAvailable(root: u32, slot: u32) -> bool {
  let binding = skinRowAddress(root, 1u, slot);
  if (binding == 0xffffffffu) { return false; }
  let count = skinInputs[binding];
  let skeleton = skinRowAddress(root, 0u, skinInputs[binding + 2u]);
  if (skeleton == 0xffffffffu) { return false; }
  if (skinInputs[skeleton] != count) { return false; }
  for (var index = 0u; index < count; index++) {
    let entity = skinInputs[binding + 3u + index];
    let joint = skinRowAddress(root, skinInputs[binding + 1u], entity);
    if (joint == 0xffffffffu) { return false; }
    if (skinInputs[joint] != entity) { return false; }
  }
  return count > 0u;
}
fn skinInfluenceAt(root: u32, slot: u32, index: u32) -> mat4x4<f32> {
  let zero = mat4x4<f32>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
  let binding = skinRowAddress(root, 1u, slot);
  if (binding == 0xffffffffu) { return zero; }
  if (index >= skinInputs[binding]) { return zero; }
  let skeleton = skinRowAddress(root, 0u, skinInputs[binding + 2u]);
  if (skeleton == 0xffffffffu) { return zero; }
  if (skinInputs[skeleton] != skinInputs[binding]) { return zero; }
  let entity = skinInputs[binding + 3u + index];
  let joint = skinRowAddress(root, skinInputs[binding + 1u], entity);
  if (joint == 0xffffffffu) { return zero; }
  if (skinInputs[joint] != entity) { return zero; }
  return skinInputMatrix(joint + 1u) * skinInputMatrix(skeleton + 1u + index * 16u);
}

// Both roots are simultaneously retained by the same arena; shared row
// addresses therefore denote the exact immutable Binding/Skeleton versions.
fn skinHistoryCompatible(current: u32, previous: u32, slot: u32) -> bool {
  if (!skinPoseAvailable(current, slot) || !skinPoseAvailable(previous, slot)) { return false; }
  let binding = skinRowAddress(current, 1u, slot);
  if (binding != skinRowAddress(previous, 1u, slot)) { return false; }
  let skeleton = skinInputs[binding + 2u];
  return skinRowAddress(current, 0u, skeleton) == skinRowAddress(previous, 0u, skeleton);
}
`;

export const skinDeformation = `${inputs}
@group(0) @binding(0) var<storage, read_write> output: array<vec4<f32>>;
fn blended(root: u32, slot: u32) -> mat4x4<f32> {
  // Duplicate identities deliberately retain different authored inverse binds.
  return skinInfluenceAt(root, slot, 0u) * 0.5 +
    skinInfluenceAt(root, slot, 1u) * 0.25 +
    skinInfluenceAt(root, slot, 2u) * 0.25;
}
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id: vec3<u32>) {
  let slot = skinFrame.bindingSlot + id.x * 16u;
  let base = id.x * 5u;
  if (!skinPoseAvailable(skinFrame.currentRoot, slot)) {
    for (var i = 0u; i < 5u; i++) { output[base + i] = vec4<f32>(0.0); }
    return;
  }
  let current = blended(skinFrame.currentRoot, slot);
  var previous = current;
  if (skinHistoryCompatible(skinFrame.currentRoot, skinFrame.previousRoot, slot)) {
    previous = blended(skinFrame.previousRoot, slot);
  }
  let position = vec4<f32>(1.0, 2.0, 3.0, 1.0);
  output[base] = current * position;
  output[base+1u] = previous * position;
  output[base+2u] = current * vec4<f32>(0.0, 1.0, 0.0, 0.0);
  output[base+3u] = current * vec4<f32>(1.0, 0.0, 0.0, 0.0);
  output[base+4u] = mat4x4<f32>(vec4<f32>(2.0,0.0,0.0,0.0), vec4<f32>(0.0,3.0,0.0,0.0),
    vec4<f32>(0.0,0.0,4.0,0.0), vec4<f32>(0.0,0.0,0.0,1.0)) * output[base];
}`;
