#define_import_path forgeax_pbr::specular_aa

// Geometric specular anti-aliasing. A pixel covers a range of interpolated
// normals; a GGX lobe narrower than that range turns into a sub-pixel
// highlight that point sampling misses or pops between pixels. Widening the
// lobe by the pixel's normal spread keeps the highlight's energy on screen and
// stable under motion. The measure is three.js getGeometryRoughness (UE's
// NormalCurvatureToRoughness and Tokuyoshi-Kaplanyan filter the same screen
// derivatives); half its weight is the strength that stays closer to an 8x
// supersampled reference on well-resolved curvature than no filtering, while
// still damping fully sub-pixel curvature (specular-aa.dawn.test.ts).
//
// The interpolated normal alone misses detail the material adds per pixel: a
// normal map or a procedural normal (rain ripples) on a flat receiver has zero
// geometric spread, so a glossy lobe under a punctual light turns single
// pixels into fireflies hundreds of times brighter than their neighbours. UE's
// NormalCurvatureToRoughness measures the final pixel normal for that reason;
// the shading normal's spread is folded in the same way.

// Largest screen-space change of the interpolated normal across one pixel.
// Derivatives require uniform control flow, so callers sample it before any
// discard or non-uniform branch.
fn geometricNormalSpread(geometricNormalWS : vec3<f32>) -> f32 {
  let n = normalize(geometricNormalWS);
  let spread = max(abs(dpdx(n)), abs(dpdy(n)));
  return max(max(spread.x, spread.y), spread.z);
}

// Same measure on the material's shading normal. Callers take it right after
// surface evaluation, still in uniform control flow, and keep the larger one.
fn shadingNormalSpread(shadingNormalWS : vec3<f32>) -> f32 {
  return geometricNormalSpread(shadingNormalWS);
}

fn specularAntiAliasedRoughness(roughness : f32, normalSpread : f32) -> f32 {
  return min(roughness + 0.5 * normalSpread, 1.0);
}
