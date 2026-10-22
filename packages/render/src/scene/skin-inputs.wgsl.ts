/** Shared numeric input queries; the actual GPU task declares its own arena binding. */
export const SKIN_INPUT_WGSL = /* wgsl */ `
fn skinInputMatrix(address: u32) -> mat4x4<f32> {
  return mat4x4<f32>(
    bitcast<vec4<f32>>(vec4<u32>(skinInputs[address], skinInputs[address+1u], skinInputs[address+2u], skinInputs[address+3u])),
    bitcast<vec4<f32>>(vec4<u32>(skinInputs[address+4u], skinInputs[address+5u], skinInputs[address+6u], skinInputs[address+7u])),
    bitcast<vec4<f32>>(vec4<u32>(skinInputs[address+8u], skinInputs[address+9u], skinInputs[address+10u], skinInputs[address+11u])),
    bitcast<vec4<f32>>(vec4<u32>(skinInputs[address+12u], skinInputs[address+13u], skinInputs[address+14u], skinInputs[address+15u])));
}
fn skinPageAddress(root: u32, key: u32) -> u32 {
  var address = root;
  for (var shift = 24i; shift >= 0i; shift -= 8i) {
    if (address == 0xffffffffu) { return address; }
    address = skinInputs[address + ((key >> u32(shift)) & 255u)];
  }
  return address;
}
fn skinRowAddress(root: u32, space: u32, key: u32) -> u32 {
  return skinPageAddress(skinPageAddress(root, space), key);
}
`;
