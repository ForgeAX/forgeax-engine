#define_import_path forgeax_ssr::forward
#import forgeax_view::common::{View, screenSpaceReflectionRoughnessFade, ssrSceneColorLod, sampleSsrSceneColor}
#import forgeax_depth_pyramid::sample::{DEPTH_PYRAMID_EMPTY_DEPTH, linearizeViewDepth}

struct ForwardSsrHit {
  uv: vec2<f32>,
  depth: f32,
  found: bool,
};

fn forwardSsrVignette(uv: vec2<f32>) -> f32 {
  let edge = clamp(abs(uv * 2.0 - 1.0) * 5.0 - 4.0, vec2<f32>(0.0), vec2<f32>(1.0));
  return clamp(1.0 - dot(edge, edge), 0.0, 1.0);
}

fn loadForwardHiZDepth(source: texture_2d<f32>, uv: vec2<f32>) -> f32 {
  let size = textureDimensions(source, 0);
  let pixel = vec2<i32>(min(vec2<u32>(uv * vec2<f32>(size)), size - 1u));
  return textureLoad(source, pixel, 0).r;
}

fn forwardSsrTrace(
  source: texture_2d<f32>, v: View, origin: vec3<f32>, direction: vec3<f32>,
) -> ForwardSsrHit {
  let miss = ForwardSsrHit(vec2<f32>(0.0), 0.0, false);
  let a = v.worldViewProj * vec4<f32>(origin, 1.0);
  if (a.w <= 0.0 || v.ssrParams.x <= 0.0) { return miss; }
  let delta = v.worldViewProj * vec4<f32>(direction * v.ssrParams.x, 0.0);
  let distanceScale = select(1.0, min(1.0, -0.95 * a.w / min(delta.w, -1e-6)), delta.w < 0.0);
  let b = a + delta * distanceScale;
  let start = a.xyz / a.w;
  let travel = b.xyz / b.w - start;
  let xyDistance = (sign(travel.xy) - start.xy) / select(vec2<f32>(1e-6), travel.xy, abs(travel.xy) > vec2<f32>(1e-6));
  let clipFactor = min(select(1.0, xyDistance.x, abs(travel.x) > 1e-6), select(1.0, xyDistance.y, abs(travel.y) > 1e-6));
  let step = travel * clamp(clipFactor, 0.0, 1.0) / 16.0;
  let size = vec2<f32>(textureDimensions(source, 0));
  if (length(step.xy * size) < 0.0625) { return miss; }
  let originUv = start.xy * vec2<f32>(0.5, -0.5) + 0.5;
  let projectedStep = max(length(step.xy * size * 0.5), 1.0);
  let level = min(u32(log2(projectedStep)), textureNumLevels(source) - 1u);
  var lastT = 0.0;
  var lastDifference = 0.0;
  for (var i = 1u; i <= 16u; i++) {
    let t = f32(i);
    let p = start + step * t;
    let uv = p.xy * vec2<f32>(0.5, -0.5) + 0.5;
    if (p.z <= 0.0 || p.z >= 1.0 || any(uv <= vec2<f32>(0.0)) || any(uv >= vec2<f32>(1.0))) { break; }
    let rayDepth = linearizeViewDepth(p.z, v.temporalProjection);
    if (level > 0u) {
      let levelSize = textureDimensions(source, level);
      let levelPixel = vec2<i32>(min(vec2<u32>(uv * vec2<f32>(levelSize)), levelSize - 1u));
      if (textureLoad(source, levelPixel, level).r > rayDepth) {
        lastT = t;
        lastDifference = -1.0;
        continue;
      }
    }
    let depth = loadForwardHiZDepth(source, uv);
    let difference = rayDepth - depth;
    if (depth < DEPTH_PYRAMID_EMPTY_DEPTH && difference >= 0.0 && lastDifference <= 0.0) {
      var lo = lastT;
      var hi = t;
      for (var refine = 0u; refine < 5u; refine++) {
        let halfway = (lo + hi) * 0.5;
        let mid = start + step * halfway;
        let uvMid = mid.xy * vec2<f32>(0.5, -0.5) + 0.5;
        let rayMid = linearizeViewDepth(mid.z, v.temporalProjection);
        if (rayMid < loadForwardHiZDepth(source, uvMid)) { lo = halfway; }
        else { hi = halfway; }
      }
      let hit = start + step * hi;
      let hitUv = hit.xy * vec2<f32>(0.5, -0.5) + 0.5;
      let hitDepth = loadForwardHiZDepth(source, hitUv);
      let gap = linearizeViewDepth(hit.z, v.temporalProjection) - hitDepth;
      if (gap <= v.ssrParams.y && length((hitUv - originUv) * size) > 1.5) {
        return ForwardSsrHit(hitUv, hit.z, true);
      }
    }
    lastT = t;
    lastDifference = difference;
  }
  return miss;
}

fn forwardSsrWater(source: texture_2d<f32>, color: texture_2d<f32>, v: View,
    position: vec3<f32>, normal: vec3<f32>, toCamera: vec3<f32>, roughness: f32) -> vec4<f32> {
  let fade = screenSpaceReflectionRoughnessFade(roughness, v.ssrParams.z);
  if (v.ssrParams.w < 1.5 || fade <= 0.0 || textureNumLevels(source) <= 1u) {
    return vec4<f32>(0.0);
  }
  let hit = forwardSsrTrace(source, v, position, reflect(-toCamera, normal));
  if (!hit.found) { return vec4<f32>(0.0); }
  let confidence = fade * forwardSsrVignette(hit.uv);
  let lod = ssrSceneColorLod(roughness, v.ssrParams.z, textureNumLevels(color));
  return vec4<f32>(sampleSsrSceneColor(color, hit.uv, lod), 1.0) * confidence;
}

fn forwardSsrOpaque(source: texture_2d<f32>, previousColor: texture_2d<f32>, v: View,
    position: vec3<f32>, normal: vec3<f32>, toCamera: vec3<f32>, roughness: f32) -> vec4<f32> {
  let fade = screenSpaceReflectionRoughnessFade(roughness, v.ssrParams.z);
  if (v.ssrParams.w < 2.5 || fade <= 0.0 || all(textureDimensions(source, 0) == vec2<u32>(1u))) {
    return vec4<f32>(0.0);
  }
  let hit = forwardSsrTrace(source, v, position, reflect(-toCamera, normal));
  if (!hit.found) { return vec4<f32>(0.0); }
  let clip = vec4<f32>(hit.uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), hit.depth, 1.0);
  let previous = v.temporalPreviousViewProj * (v.inverseViewProj * clip);
  if (previous.w <= 0.0) { return vec4<f32>(0.0); }
  let previousUv = previous.xy / previous.w * vec2<f32>(0.5, -0.5) + 0.5;
  let confidence = fade * min(forwardSsrVignette(hit.uv), forwardSsrVignette(previousUv));
  let lod = ssrSceneColorLod(roughness, v.ssrParams.z, textureNumLevels(previousColor));
  return vec4<f32>(sampleSsrSceneColor(previousColor, previousUv, lod) * confidence, confidence);
}
