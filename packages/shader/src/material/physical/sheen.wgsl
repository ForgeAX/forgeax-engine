#define_import_path forgeax_pbr::sheen

// Charlie-like grazing lobe approximation with explicit energy compensation.
// It is evaluated below clearcoat, so the caller attenuates this result when
// the top coat Fresnel is applied.
fn evaluateSheenLayer(
  baseRadiance : vec3<f32>,
  sheenColor : vec3<f32>,
  sheenRoughness : f32,
  viewCosine : f32,
) -> vec3<f32> {
  let roughness = clamp(sheenRoughness, 0.04, 1.0);
  let grazing = pow(1.0 - clamp(viewCosine, 0.0, 1.0), 2.0);
  let lobe = grazing * (1.0 - 0.5 * roughness);
  let energy = clamp(max(max(sheenColor.r, sheenColor.g), sheenColor.b), 0.0, 1.0);
  return baseRadiance * (1.0 - energy * lobe * 0.5) + sheenColor * lobe;
}
