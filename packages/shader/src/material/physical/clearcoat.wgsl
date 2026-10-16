#define_import_path forgeax_pbr::clearcoat

// Clearcoat is the terminal physical layer. Its Fresnel term owns both the
// attenuation of lower layers and the weight of the coat radiance.
// The root supplies clearcoatRoughness and clearcoatNormalScale after their
// texture projections; this module deliberately owns only layer energy.
fn evaluateClearcoatFresnel(viewCosine : f32, clearcoatFactor : f32) -> f32 {
  let cosine = clamp(viewCosine, 0.0, 1.0);
  let oneMinusCosine = 1.0 - cosine;
  let dielectricFresnel = 0.04 + 0.96 * oneMinusCosine * oneMinusCosine *
    oneMinusCosine * oneMinusCosine * oneMinusCosine;
  return clamp(clearcoatFactor, 0.0, 1.0) * dielectricFresnel;
}

fn evaluateClearcoatLayer(
  baseRadiance : vec3<f32>,
  coatRadiance : vec3<f32>,
  viewCosine : f32,
  clearcoatFactor : f32,
) -> vec3<f32> {
  let fresnel = evaluateClearcoatFresnel(viewCosine, clearcoatFactor);
  let attenuatedBase = baseRadiance * (1.0 - fresnel);
  return attenuatedBase + coatRadiance * fresnel;
}
