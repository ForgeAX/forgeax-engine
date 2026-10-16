#define_import_path forgeax_pbr::iridescence

// Bounded RGB thin-film Fresnel approximation.  Thickness is deliberately
// not clamped to min/max order: the glTF contract permits inverted bounds and
// the caller supplies the authored interval verbatim.
fn evaluateIridescenceFresnel(
  baseF0 : vec3<f32>,
  strength : f32,
  filmIor : f32,
  thicknessNanometres : f32,
) -> vec3<f32> {
  let safeStrength = clamp(strength, 0.0, 1.0);
  let safeIor = max(filmIor, 1.0);
  let base = clamp((safeIor - 1.0) / (safeIor + 1.0), 0.0, 1.0);
  let phase = thicknessNanometres * 0.018;
  let spectral = vec3<f32>(
    0.5 + 0.5 * cos(phase),
    0.5 + 0.5 * cos(phase + 2.0943952),
    0.5 + 0.5 * cos(phase + 4.1887903),
  );
  let film = clamp(vec3<f32>(base) * spectral, vec3<f32>(0.0), vec3<f32>(1.0));
  return clamp(mix(baseF0, film, safeStrength), vec3<f32>(0.0), vec3<f32>(1.0));
}
