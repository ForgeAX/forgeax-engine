#define_import_path forgeax_pbr::lighting_attenuation

// Shared punctual light optics. Range is represented by the host-derived
// inverse squared range; the shader never reconstructs authoring units.
fn evalDistanceAttenuation(
  dSquared : f32, invRangeSquared : f32, decay : f32, nearFloor : f32,
) -> f32 {
  let safeDistance = max(dSquared, nearFloor);
  let window = clamp(1.0 - (safeDistance * invRangeSquared) * (safeDistance * invRangeSquared), 0.0, 1.0);
  // Keep the established inverse-square path, including its rounding and each
  // consumer's near-light floor. Zero exponent leaves only the range window.
  if (decay == 2.0) { return window * window / safeDistance; }
  if (decay == 0.0) { return window * window; }
  // Bound pow before evaluation, including the largest accepted f32 exponent.
  // Below the near floor the denominator is clamped; beyond f32's normal
  // range the radiance is zero. Ordinary exponents retain the direct power law.
  let logDistance = log2(safeDistance);
  if (logDistance < 0.0 && decay >= 2.0 * log2(nearFloor) / logDistance) {
    return window * window / nearFloor;
  }
  if (logDistance > 0.0 && decay >= 254.0 / logDistance) { return 0.0; }
  return window * window / max(pow(safeDistance, 0.5 * decay), nearFloor);
}

// Equal inner/outer cosines represent a hard cone. smoothstep(a, a, x)
// is undefined, including at the edge, on both WGSL and GLSL backends.
fn evalSpotCone(cosInner: f32, cosOuter: f32, angleCos: f32) -> f32 {
  if (cosInner <= cosOuter) { return step(cosOuter, angleCos); }
  return smoothstep(cosOuter, cosInner, angleCos);
}

fn evalSpotAttenuation(
  lightPos : vec3<f32>,
  lightDir : vec3<f32>,
  worldPos : vec3<f32>,
  cosInner : f32,
  cosOuter : f32,
  invRangeSquared : f32,
) -> f32 {
  let toLight = lightPos - worldPos;
  let dSquared = dot(toLight, toLight);
  let distance = evalDistanceAttenuation(dSquared, invRangeSquared, 2.0, 1e-4);
  let direction = normalize(select(vec3<f32>(0.0, 0.0, -1.0), toLight, dSquared > 1e-4));
  let cone = evalSpotCone(cosInner, cosOuter, dot(direction, -normalize(lightDir)));
  return distance * cone;
}

// Isolated volume radiance helpers: this module has no resource bindings, so
// compute stages can reuse the exact surface attenuation and cone facts.
fn evalVolumePointRadiance(
  lightPos : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  invRangeSquared : f32,
  decay : f32,
  worldPos : vec3<f32>,
) -> vec3<f32> {
  let toLight = lightPos - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  return colorTimesIntensity * evalDistanceAttenuation(dSquared, invRangeSquared, decay, 1e-4);
}

fn evalVolumeSpotRadiance(
  lightPos : vec3<f32>,
  lightDir : vec3<f32>,
  colorTimesIntensity : vec3<f32>,
  cosInner : f32,
  cosOuter : f32,
  invRangeSquared : f32,
  worldPos : vec3<f32>,
) -> vec3<f32> {
  return colorTimesIntensity * evalSpotAttenuation(
    lightPos, lightDir, worldPos, cosInner, cosOuter, invRangeSquared,
  );
}

fn projectSpotUv(lightViewProj : mat4x4<f32>, worldPos : vec3<f32>) -> vec2<f32> {
  let clip = lightViewProj * vec4<f32>(worldPos, 1.0);
  let invW = select(1.0 / clip.w, 0.0, abs(clip.w) < 1e-6);
  return vec2<f32>(clip.x * invW * 0.5 + 0.5, clip.y * invW * -0.5 + 0.5);
}
