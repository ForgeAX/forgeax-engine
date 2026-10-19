#define_import_path forgeax_pbr::lighting_punctual

// @forgeax/engine-shader - lighting-punctual.wgsl
// (feat-20260523-shader-template-instance-split M5 / T02).
//
// Point + spot light evaluators extracted from pbr.wgsl
// (feat-20260519-light-casters-point-spot-pbr M4 / w22 byte-equivalent
// extraction). Both light types share a punctual BRDF body (GGX specular +
// Lambertian diffuse + Three r184 squared finite-range attenuation); the
// PointLight carries its authored distance exponent; SpotLight keeps exponent 2
// and multiplies a cone-falloff factor
// `evalSpotCone(cosInner, cosOuter, dot(l, -lightDir))` on top.
//
// charter P4 consistent abstraction: one body, two thin wrappers that each
// carry exactly the parameters their light type needs. evalPoint avoids the
// "evalPunctual(cosInner=1, cosOuter=-1, ...)" magic-value collapse pattern
// since `smoothstep(-1, 1, x)` is the Hermite cubic 0..1 (not a constant 1).
//
// Default (decay=2) attenuation (Three r184 squared finite-range authority):
//   atten = clamp(1 - (d^2 * invR^2)^2, 0, 1)^2 / max(d^2, 1e-4)
// `max(d^2, 1e-4)` math safety net keeps the divisor finite when the
// fragment is at the light position (zero-distance NaN guard, layer 2 of
// the two-layer fail-fast strategy alongside the host-side bounds gate).
// `invRangeSquared = 0` collapses the quartic falloff to a pure 1/d^2 law.
//
// Pure-function module aside from the brdf #import; takes all light + surface
// parameters as args so the helper does not declare its own bindings (host
// material shader owns the @group(0) light buffer namespace).
//
// Exports:
//   - evalPoint(lightPos, colorTimesIntensity, invRangeSquared, decay, ...) -> vec3<f32>
//   - evalSpot(lightPos, lightDir, colorTimesIntensity, cosInner, cosOuter,
//              invRangeSquared, ...) -> vec3<f32>

#import forgeax_pbr::brdf::{standardOpaqueBrdf}
#import forgeax_pbr::lighting_spot_modifiers::{spotModifierProduct}

// extendedLighting is one closed resource topology for IES, Cookie, and
// probe factors. The ordinary path supplies identity factors.
#import forgeax_pbr::lighting_attenuation::{evalSpotCone, evalDistanceAttenuation, evalSpotAttenuation, projectSpotUv}
// feat-20260625-spot-light-shadow-mapping M3 / w15 (plan-strategy D-3 + D-5):
// spot shadow sampling reuses the shared 2D 9-tap PCF core (sample_shadow_2d)
// and the always-on `spotShadowMap` (binding 8) + `shadowSampler` (binding 4).
// `shadowSampler` is imported UNCONDITIONALLY here (spot is always-on, D-5):
// the point-shadow #ifdef block below must NOT re-import it (double import).
#import forgeax_pbr::shadow_pcf::{sample_shadow_2d_kernel}
#import forgeax_view::common::{spotShadowMap, shadowSampler}
#ifdef POINT_SHADOW_AVAILABLE
#import forgeax_pbr::shadow_pcf::{sample_shadow_cube_hw2x2}
// Pull in the @group(0) @binding(5) shadowAtlas declaration from common.wgsl so
// the free-identifier references in `evalPointShadowed` resolve through
// naga_oil's import scope. (`shadowSampler` is already imported above for the
// always-on spot path.)
#import forgeax_view::common::{shadowAtlas}
#endif

// Volume lighting uses the same host-derived range and cone facts as surface
// lighting. These wrappers intentionally return radiance factors only; the
// volume integrator owns density, phase, transmittance, and accumulation.
fn evalVolumePoint(
  lightPos            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared     : f32,
  decay               : f32,
  worldPos            : vec3<f32>,
) -> vec3<f32> {
  let toLight = lightPos - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  let safeDistance = max(dSquared, 1e-4);
  return colorTimesIntensity * evalDistanceAttenuation(safeDistance, invRangeSquared, decay, 1e-4);
}

fn evalVolumeSpot(
  lightPos            : vec3<f32>,
  lightDir            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  cosInner            : f32,
  cosOuter            : f32,
  invRangeSquared     : f32,
  worldPos            : vec3<f32>,
) -> vec3<f32> {
  return colorTimesIntensity * evalSpotAttenuation(
    lightPos, lightDir, worldPos, cosInner, cosOuter, invRangeSquared,
  );
}

// Shared punctual BRDF body returning brdf *
// colorTimesIntensity * nDotL * attenuation. Cone factor is applied by the
// caller (evalSpot only). `transmission` is the diffuse-transmission albedo
// (KHR_materials_diffuse_transmission): a Lambertian BTDF lobe on the
// hemisphere opposite the shading normal, lit by the same light and
// attenuation. N.L and -N.L are mutually exclusive, so the lobe adds no
// extra light iteration; opaque callers pass zero.
fn evalPunctualBody(
  lightPos            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared     : f32,
  decay               : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
  transmission        : vec3<f32>,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let toLight = lightPos - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  let l = toLight / sqrt(dSquared);
  let h = normalize(viewDir + l);
  let signedNDotL = dot(normal, l);
  let nDotL = max(signedNDotL, 0.0);
  let nDotV = max(dot(normal, viewDir), 1e-5);
  let nDotH = max(dot(normal, h), 0.0);
  let vDotH = max(dot(viewDir, h), 0.0);
  let brdf = standardOpaqueBrdf(baseColor, metallic, alphaSq, F0, nDotV, nDotL, nDotH, vDotH,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  let attenuation = evalDistanceAttenuation(dSquared, invRangeSquared, decay, 1e-4);
  let transmitted = transmission * (max(-signedNDotL, 0.0) / 3.14159265);
  return brdf * colorTimesIntensity * nDotL * attenuation
    + transmitted * colorTimesIntensity * attenuation;
}

// Omnidirectional point light: no cone factor.
fn evalPoint(
  lightPos            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared     : f32,
  decay               : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
  transmission        : vec3<f32>,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  return evalPunctualBody(
    lightPos, colorTimesIntensity, invRangeSquared, decay,
    worldPos, normal, viewDir, baseColor, metallic, alphaSq, F0, transmission,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
}

// Flat 2D punctual evaluators share the range/cone math with the clustered
// path, but intentionally skip the 3D BRDF normal term.
// Sprite-lit treats every quad as an omnidirectional receiver; keeping this
// owner here prevents URP and Cluster from drifting when the light lies in the
// sprite plane (the common 2D flashlight setup).
fn evalPointFlat(
  lightPos            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared     : f32,
  decay               : f32,
  worldPos            : vec3<f32>,
  baseColor           : vec3<f32>,
) -> vec3<f32> {
  // The flat 2D path shares the same finite-range attenuation owner as the
  // clustered and direct Standard paths; its only intentional difference is
  // that a sprite is an omnidirectional receiver.
  let toLight = lightPos - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  return baseColor * colorTimesIntensity * evalDistanceAttenuation(dSquared, invRangeSquared, decay, 1e-4);
}

fn evalSpotFlat(
  lightPos            : vec3<f32>,
  lightDir            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  cosInner            : f32,
  cosOuter            : f32,
  invRangeSquared     : f32,
  worldPos            : vec3<f32>,
  baseColor           : vec3<f32>,
) -> vec3<f32> {
  let toLight = lightPos - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  let l = toLight / sqrt(dSquared);
  let cone = evalSpotCone(cosInner, cosOuter, dot(l, -lightDir));
  return evalPointFlat(
    lightPos, colorTimesIntensity, invRangeSquared, 2.0, worldPos, baseColor,
  ) * cone;
}

#ifdef POINT_SHADOW_AVAILABLE
// Shadow-modulated omnidirectional point light: same BRDF body * shadow factor.
//
// feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-3 + M4 / T-M4-3
// (plan-strategy §D-1 + §D-8). Only emitted when POINT_SHADOW_AVAILABLE is
// true (forward path with the cube_array atlas at @group(0) binding 5).
// The shadow factor is reconstructed from `lightLocal` via the largest-axis
// projection (research L0.5 Bevy pattern); the caller passes `near` / `far`
// directly so both pipelines route the same constants without owning the
// upstream binding (URP reads them from `shadowParams[layer]` at @group(0)
// binding 6; the shared DirectLightSlot metadata remains the identity owner
// while this shadow-parameter buffer carries the reconstruction constants per
// plan-strategy §D-8).
//
// Caller responsibility: gate this on `shadowAtlasLayer >= 0` so the
// no-shadow lights stay on the unshadowed `evalPoint` path; passing a
// negative layer here is undefined (the cube_array view rejects it).
fn evalPointShadowed(
  lightPos            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared     : f32,
  decay               : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
  transmission        : vec3<f32>,
  shadowAtlasLayer    : i32,
  near                : f32,
  far                 : f32,
  depthBias           : f32,
  normalBias          : f32,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let lit = evalPunctualBody(
    lightPos, colorTimesIntensity, invRangeSquared, decay,
    worldPos, normal, viewDir, baseColor, metallic, alphaSq, F0, transmission,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  // Bevy fetch_point_shadow: bias the receiver in world space. The normal
  // offset is normalBias cube texels at this distance (the host pre-scales it
  // by the face texel angle), pushed toward the lit hemisphere so a
  // transmitting thin surface does not self-shadow its backlight; depthBias
  // shortens the light-axis distance in world units and never passes the
  // near plane.
  let toLight = lightPos - worldPos;
  let distanceToLight = length(toLight);
  let facing = select(-normal, normal, dot(normal, toLight) >= 0.0);
  let offsetPos = worldPos + facing * (normalBias * distanceToLight);
  // The atlas uses the shared CubeCamera face directions. The raster matrices
  // reflect clip-space X to preserve authored front-face winding, so sampling
  // must use the corresponding raw light-to-fragment direction.
  let fromLight = offsetPos - lightPos;
  let lightLocal = fromLight;
  // Reconstruct [0,1] NDC depth from the largest-axis distance, matching the
  // per-face perspective near / far of buildPointShadowMatrices:
  // z_ndc = near * (far - largest) / (largest * (far - near)).
  let absV = abs(fromLight);
  let largestAxis = max(max(absV.x, max(absV.y, absV.z)) - depthBias, near);
  let denom = max(largestAxis * (far - near), 1e-6);
  let depthRef = clamp(near * (far - largestAxis) / denom, 0.0, 1.0);
  let shadowFactor = sample_shadow_cube_hw2x2(
    shadowAtlas, shadowSampler, lightLocal, shadowAtlasLayer, depthRef,
  );
  return lit * shadowFactor;
}
#endif

// Cone-restricted spot light: BRDF body * smoothstep cone factor.
// `cosInner` / `cosOuter` are pre-computed cosines (host-side
// degree -> cosine conversion in extract-frame; plan-strategy D-S2).
fn evalSpot(
  lightPos            : vec3<f32>,
  lightDir            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  cosInner            : f32,
  cosOuter            : f32,
  invRangeSquared     : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
  transmission        : vec3<f32>,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let body = evalPunctualBody(
    lightPos, colorTimesIntensity, invRangeSquared, 2.0,
    worldPos, normal, viewDir, baseColor, metallic, alphaSq, F0, transmission,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  let toLight = lightPos - worldPos;
  let l = normalize(toLight);
  let cone = evalSpotCone(cosInner, cosOuter, dot(l, -lightDir));
  return body * spotModifierProduct(1.0, 1.0, cone, 1.0, 1.0, 1.0);
}

// feat-20260625-spot-light-shadow-mapping M3 / w15 (plan-strategy D-3 + D-4 +
// D-5). Shadow-modulated spot light: the unshadowed `evalSpot` result times a
// PCF shadow factor sampled from the spot's perspective depth-atlas tile.
//
// Mirrors `evalPointShadowed`'s "shadowed wrapper + upstream gate" pattern
// (research Finding B3): the caller gates on `shadowAtlasTile >= 0` so
// no-shadow / clipped / direction-degenerate spots (tile = -1, plan D-4) stay
// on the unshadowed `evalSpot` path.
//
// Depth-ref reconstruction is the standard perspective `splane.z / splane.w`
// non-linear depth (plan-strategy D-4, godot-point-spot-shadows wiki S3.4):
// store-side and sample-side share the SAME perspective `lightViewProj`, so the
// projection's non-linearity cancels and no near/far reconstruction is needed
// (unlike the point cube path's largest-axis projection).
//
// Atlas tiling: the host packs up to 4 spot shadows into a 2x2 grid of one
// `spotShadowDepth` texture (urp-pipeline.ts). Tile N occupies quadrant
// (col = N % 2, row = N / 2); the [0,1] light-clip UV is scaled to a 0.5x0.5
// sub-rect and offset to the tile origin. PCF taps stay inside the tile by
// scaling the texel step to the half-resolution sub-rect.
//
// OOB / NaN gate (research Finding F1, mirrors lighting-directional.wgsl): a
// degenerate `lightViewProj` (near-zero spot direction) yields NaN UVs; the
// `>= 0 && <= 1` form is false for NaN, so the fragment returns fully lit
// (shadowFactor = 1.0) instead of a hard-black artifact.
fn evalSpotShadowed(
  lightPos            : vec3<f32>,
  lightDir            : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  cosInner            : f32,
  cosOuter            : f32,
  invRangeSquared     : f32,
  worldPos            : vec3<f32>,
  normal              : vec3<f32>,
  viewDir             : vec3<f32>,
  baseColor           : vec3<f32>,
  metallic            : f32,
  alphaSq             : f32,
  F0                  : vec3<f32>,
  transmission        : vec3<f32>,
  lightViewProj       : mat4x4<f32>,
  shadowAtlasTile     : i32,
  depthBias           : f32,
  normalBias          : f32,
  pcfKernelSize       : f32,
  shadowIntensity     : f32,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let body = evalSpot(
    lightPos, lightDir, colorTimesIntensity, cosInner, cosOuter, invRangeSquared,
    worldPos, normal, viewDir, baseColor, metallic, alphaSq, F0, transmission,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );

  // Project the fragment into the spot's light clip space.
  let splane = lightViewProj * vec4<f32>(worldPos, 1.0);
  // Perspective divide; guard a zero/near-zero w (fragment behind the light or
  // a degenerate matrix) so the OOB gate below catches it as fully lit.
  let invW = select(1.0 / splane.w, 0.0, abs(splane.w) < 1e-6);
  let clipUv = projectSpotUv(lightViewProj, worldPos);
  let depthRef = splane.z * invW;
  // OOB / NaN gate: outside the light frustum (or NaN from a degenerate matrix)
  // returns fully lit. Mirrors the directional `>= 0 && <= 1` NaN-safe form.
  if (!(clipUv.x >= 0.0 && clipUv.x <= 1.0 && clipUv.y >= 0.0 && clipUv.y <= 1.0 && depthRef >= 0.0 && depthRef <= 1.0)) {
    return body;
  }

  // Each shadow-casting spot owns layer `shadowAtlasTile` of the array.
  let layerDims = vec2<f32>(textureDimensions(spotShadowMap, 0));
  let texel = vec2<f32>(1.0, 1.0) / layerDims;

  // Same light-facing receiver bias as evalPointShadowed.
  let nDotL = abs(dot(normal, normalize(lightPos - worldPos)));
  let shadowFactor = sample_shadow_2d_kernel(
    spotShadowMap, shadowSampler, clipUv, shadowAtlasTile, texel, depthRef, normalBias, depthBias, nDotL,
    pcfKernelSize,
  );
  // Three's SpotLight.shadow.intensity is the opacity of the shadow, not a
  // multiplier on the light's candela radiance. A value of 1 keeps the
  // sampled visibility fully opaque; 0 leaves the unshadowed body intact.
  return body * mix(1.0, shadowFactor, clamp(shadowIntensity, 0.0, 1.0));
}
