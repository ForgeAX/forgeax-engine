#define_import_path forgeax_ssr::forward
#import forgeax_view::common::{View, screenSpaceReflectionRoughnessFade, sampleSsrSceneColor}
#import forgeax_ssr::ray::{SsrRayHit, traceSsrRay, ssrReflectionDirection, ssrVignette, ssrClipUv}

fn traceForwardReflection(
  pyramid: texture_2d<f32>, view: View, origin: vec3f, normal: vec3f, toCamera: vec3f, roughness: f32,
) -> SsrRayHit {
  let size = vec2u(vec2f(view.viewportWidth, view.viewportHeight));
  let uv = ssrClipUv(view.worldViewProj * vec4f(origin, 1.0));
  let pixel = vec2u(clamp(uv, vec2f(0.0), vec2f(1.0)) * vec2f(size));
  let direction = ssrReflectionDirection(normal, toCamera, roughness, pixel, u32(view.ssrQuality.w), 0u);
  if (dot(normal, direction) <= 0.0) {
    return SsrRayHit(vec2f(0.0), 0.0, false);
  }
  return traceSsrRay(pyramid, view, size, origin, direction, roughness, u32(max(view.ssrQuality.y, 8.0)));
}

fn forwardSsrWater(source: texture_2d<f32>, color: texture_2d<f32>, v: View,
    position: vec3<f32>, normal: vec3<f32>, toCamera: vec3<f32>, roughness: f32) -> vec4<f32> {
  let fade = screenSpaceReflectionRoughnessFade(roughness, v.ssrParams.z, v.ssrQuality.w > 0.0);
  if (v.ssrParams.w < 1.5 || fade <= 0.0) {
    return vec4<f32>(0.0);
  }
  let hit = traceForwardReflection(source, v, position, normal, toCamera, roughness);
  if (!hit.found) { return vec4<f32>(0.0); }
  let confidence = fade * ssrVignette(hit.uv);
  return vec4<f32>(sampleSsrSceneColor(color, hit.uv), 1.0) * confidence;
}

fn forwardSsrOpaque(source: texture_2d<f32>, previousColor: texture_2d<f32>, v: View,
    position: vec3<f32>, normal: vec3<f32>, toCamera: vec3<f32>, roughness: f32) -> vec4<f32> {
  let fade = screenSpaceReflectionRoughnessFade(roughness, v.ssrParams.z, v.ssrQuality.w > 0.0);
  if (v.ssrParams.w < 2.5 || fade <= 0.0 || all(textureDimensions(source, 0) == vec2<u32>(1u))) {
    return vec4<f32>(0.0);
  }
  let hit = traceForwardReflection(source, v, position, normal, toCamera, roughness);
  if (!hit.found) { return vec4<f32>(0.0); }
  let clip = vec4<f32>(hit.uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), hit.depth, 1.0);
  let previous = v.temporalPreviousViewProj * (v.inverseViewProj * clip);
  if (previous.w <= 0.0) { return vec4<f32>(0.0); }
  let previousUv = previous.xy / previous.w * vec2<f32>(0.5, -0.5) + 0.5;
  let confidence = fade * min(ssrVignette(hit.uv), ssrVignette(previousUv));
  return vec4<f32>(sampleSsrSceneColor(previousColor, previousUv) * confidence, confidence);
}
