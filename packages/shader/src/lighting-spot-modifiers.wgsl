#define_import_path forgeax_pbr::lighting_spot_modifiers

#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{spotModifierSampler, cookieTexture, cookieMatrices}
#endif
#import forgeax_pbr::lighting_ies_profile::{sampleIesProfile}

// DirectLightSlot.metadata.y carries this marker for the SpotLight projector
// path. A marked spot samples the shared array with its lightViewProj in the
// punctual owner, so the Cookie projection
// below must not modulate it a second time.
const PROJECTOR_FLAG: u32 = 0x40000000u;

// Shared Spot modifier composition. Identity defaults preserve the ordinary
// punctual path when an extension resource is absent.
fn spotModifierProduct(
  brdf   : f32,
  range  : f32,
  cone   : f32,
  ies    : f32,
  cookie : f32,
  shadow : f32,
) -> f32 {
  return brdf * range * cone * ies * cookie * shadow;
}

// Shared IES/Cookie projection owner. The light direction is the authored
// outgoing axis (light -> scene), matching evalSpot's `dot(L, -lightDir)`.
// Cookie matrices carry only source-texture aspect correction; keeping the
// cone term here allows a Cookie slice to be shared by Spots with different
// outer cones.
fn spotModifierFactors(
  lightPos : vec3<f32>,
  lightDir : vec3<f32>,
  cosOuter : f32,
  worldPos : vec3<f32>,
  rollDeg : f32,
  metadata : vec4<u32>,
) -> vec4<f32> {
#ifdef EXTENDED_LIGHTING_AVAILABLE
  let toSurface = worldPos - lightPos;
  let distanceToSurface = length(toSurface);
  var ies = 1.0;
  var cookie = vec3<f32>(1.0);
  if (distanceToSurface <= 0.000001) {
    return vec4<f32>(ies, cookie);
  }

  let outgoing = toSurface / distanceToSurface;
  let forward = normalize(lightDir);
  var referenceUp = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(forward.y) > 0.999) {
    referenceUp = vec3<f32>(0.0, 0.0, 1.0);
  }
  let right = normalize(cross(forward, referenceUp));
  let up = normalize(cross(right, forward));
  let localX = dot(outgoing, right);
  let localY = dot(outgoing, up);
  let depth = dot(outgoing, forward);
  let roll = rollDeg * 0.01745329252;
  let rolledX = localX * cos(roll) - localY * sin(roll);
  let rolledY = localX * sin(roll) + localY * cos(roll);

  if (metadata.z != 0xffffffffu) {
    ies = sampleIesProfile(vec3<f32>(rolledX, rolledY, depth), metadata.z);
  }

  // The shadow lane uses 0xffffffff as its no-shadow sentinel. That value
  // contains PROJECTOR_FLAG bits, so test the sentinel before interpreting
  // the lane as a projector marker; otherwise every non-shadow Cookie spot
  // silently takes the projector exclusion path.
  if (
    metadata.w != 0xffffffffu &&
    (metadata.y == 0xffffffffu || (metadata.y & PROJECTOR_FLAG) == 0u)
  ) {
    if (depth <= 0.0) {
      cookie = vec3<f32>(0.0);
    } else {
      let sinOuter = sqrt(max(1.0 - cosOuter * cosOuter, 0.0));
      let tanOuter = sinOuter / max(cosOuter, 0.0001);
      let matrixPlane = cookieMatrices[metadata.w] * vec4<f32>(rolledX / depth, rolledY / depth, 0.0, 1.0);
      let cookieUv = vec2<f32>(0.5) + matrixPlane.xy / tanOuter * 0.5;
      if (
        cookieUv.x < 0.0 || cookieUv.x > 1.0 ||
        cookieUv.y < 0.0 || cookieUv.y > 1.0
      ) {
        cookie = vec3<f32>(0.0);
      } else {
        let cookieSample = textureSampleLevel(cookieTexture, spotModifierSampler, cookieUv, metadata.w, 0.0);
        cookie = max(cookieSample.rgb * cookieSample.a, vec3<f32>(0.0));
      }
    }
  }
  return vec4<f32>(ies, cookie);
#else
  return vec4<f32>(1.0);
#endif
}
