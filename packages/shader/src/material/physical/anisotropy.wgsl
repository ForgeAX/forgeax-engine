#define_import_path forgeax_pbr::anisotropy

// Engine-owned anisotropy helpers.  The root contract supplies strength and
// rotation; the map (when present) supplies tangent direction in RG and a
// strength multiplier in B.  Keeping the frame operation here means the
// Standard evaluator and custom Surface share one deterministic seam.
fn evaluateAnisotropicNormal(
  normal : vec3<f32>,
  tangent : vec4<f32>,
  strength : f32,
  rotation : f32,
  direction : vec2<f32>,
) -> vec3<f32> {
  let frameTangent = normalize(tangent.xyz);
  let handedBitangent = normalize(cross(normal, frameTangent)) * select(-1.0, 1.0, tangent.w >= 0.0);
  var mapDirection = vec2<f32>(1.0, 0.0);
  if (dot(direction, direction) >= 1e-6) {
    mapDirection = normalize(direction);
  }
  let mappedTangent = normalize(frameTangent * mapDirection.x + handedBitangent * mapDirection.y);
  let mappedBitangent = normalize(cross(normal, mappedTangent)) * select(-1.0, 1.0, tangent.w >= 0.0);
  let axis = normalize(mappedTangent * cos(rotation) + mappedBitangent * sin(rotation));
  // A bounded bent normal preserves the zero-strength isotropic path while
  // moving only the base specular highlight for non-zero anisotropy.
  return normalize(normal + axis * clamp(strength, -0.999, 0.999) * 0.35);
}
