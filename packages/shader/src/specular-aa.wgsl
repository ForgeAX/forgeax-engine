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

// Largest screen-space change of the interpolated normal across one pixel.
// Derivatives require uniform control flow, so callers sample it before any
// discard or non-uniform branch.
fn geometricNormalSpread(geometricNormalWS : vec3<f32>) -> f32 {
  let n = normalize(geometricNormalWS);
  let spread = max(abs(dpdx(n)), abs(dpdy(n)));
  return max(max(spread.x, spread.y), spread.z);
}

fn specularAntiAliasedRoughness(roughness : f32, normalSpread : f32) -> f32 {
  return min(roughness + 0.5 * normalSpread, 1.0);
}
