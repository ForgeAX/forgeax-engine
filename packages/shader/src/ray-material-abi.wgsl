#define_import_path forgeax_material::ray_abi

// 224-byte context; all fields are ordinary captureable storage records.
struct RayMaterialInput {
  positionOS: vec4f, positionWS: vec4f, normal: vec4f, tangent: vec4f, outgoing: vec4f,
  uvA: vec4f, uvB: vec4f, uvC: vec4f, uvD: vec4f, color: vec4f,
  footprintA: vec4f, footprintB: vec4f,
  vertexNormal: vec4f,
  // material, valid-hit, bounce, ordered triangle index
  identity: vec4u,
}
// 96 bytes. status.x: 0 unset/miss, 1 admitted, 2 unsupported/nonfinite surface, 3 coverage rejected.
// status.y: BSDF lobe, 0 standard, 1 (RAY_BSDF_LAMBERT) albedo-only Lambert.
// status.z: direct DFG mode, 0 analytic fit, 1 original RG16F LUT.
// Card f0Validity.w stores status.x in bits0..1 and status.z in bit2.
struct RayMaterialSurface {
  albedoOpacity: vec4f, normalRoughness: vec4f, emissionMetallic: vec4f,
  f0Occlusion: vec4f, status: vec4u,
  geometricNormal: vec4f,
}

// Each unit normal occupies two signed half-float lanes in a material card.
fn encodeCardNormal(n: vec3f) -> vec2f {
  let p = n / (abs(n.x) + abs(n.y) + abs(n.z));
  if (p.z < 0.0) { return (vec2f(1) - abs(p.yx)) * select(vec2f(-1), vec2f(1), p.xy >= vec2f(0)); }
  return p.xy;
}
