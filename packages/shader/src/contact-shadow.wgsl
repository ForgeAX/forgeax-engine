#define_import_path forgeax_pbr::contact_shadow
#import forgeax_view::common::{View}

const CONTACT_SHADOW_MAX_STEPS : f32 = 8.0;

fn contactShadowLinearDepth(value : f32, near : f32, far : f32, orthographic : bool) -> f32 {
  return select(near / max(value + (1.0 - value) * (near / far), 1e-7), far - value * (far - near), orthographic);
}

// Screen-space contact shadow: a short depth-buffer march toward the
// directional light resolving occlusion finer than the shadow-map texel.
// The march interpolates clip coordinates, so each sample's w is the exact
// view distance of the ray point; only the scene sample needs linearizing.
fn directionalContactShadow(view : View, sceneDepth : texture_depth_2d, position : vec3<f32>, normal : vec3<f32>, originPixel : vec2<i32>, frame : f32) -> f32 {
  let rayLength = view.directionalShadowFilter.w;
  let toLight = normalize(-view.lightDir);
  if (dot(normal, toLight) <= 0.0) { return 1.0; }
  let near = view.temporalProjection.x;
  let far = view.temporalProjection.y;
  let orthographic = view.temporalProjection.z > 0.5;
  // A distance-scaled normal offset keeps depth quantization of the
  // receiver's own plane from registering as a hit at grazing angles.
  let origin = position + normal * (0.001 * abs((view.worldViewProj * vec4<f32>(position, 1.0)).w));
  let clipStart = view.worldViewProj * vec4<f32>(origin, 1.0);
  var clipEnd = view.worldViewProj * vec4<f32>(origin + toLight * rayLength, 1.0);
  // Keep the ray in front of the camera; a toward-camera light would
  // otherwise cross w = 0 and fold the projected segment.
  let minW = near * 0.5;
  if (!orthographic && clipEnd.w < minW) {
    clipEnd = mix(clipStart, clipEnd, (clipStart.w - minW) / max(clipStart.w - clipEnd.w, 1e-6));
  }
  let dims = vec2<f32>(textureDimensions(sceneDepth));
  let screenStart = clipStart.xy / clipStart.w;
  let screenEnd = clipEnd.xy / clipEnd.w;
  let pixelSpan = length((screenEnd - screenStart) * dims * 0.5);
  if (pixelSpan < 1.5) { return 1.0; }
  let steps = clamp(ceil(pixelSpan / 4.0), 3.0, CONTACT_SHADOW_MAX_STEPS);
  let noiseCoord = vec2<f32>(originPixel) + 5.588238 * frame;
  let jitter = fract(52.9829189 * fract(dot(noiseCoord, vec2<f32>(0.06711056, 0.00583715))));
  let startDistance = select(clipStart.w, contactShadowLinearDepth(clipStart.z / clipStart.w, near, far, true), orthographic);
  let endDistance = select(clipEnd.w, contactShadowLinearDepth(clipEnd.z / clipEnd.w, near, far, true), orthographic);
  // Occluders are assumed to be about one step deep plus a quarter of the
  // ray; thicker tolerance casts halos behind foreground silhouettes.
  let thickness = max(abs(endDistance - startDistance) / steps * 2.0, rayLength * 0.25) + startDistance * 0.002;
  for (var i = 0.0; i < steps; i += 1.0) {
    let t = (i + jitter) / steps;
    let clip = mix(clipStart, clipEnd, t);
    let ndc = clip.xyz / clip.w;
    let uv = ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
    if (any(uv < vec2<f32>(0.0)) || any(uv >= vec2<f32>(1.0))) { break; }
    let pixel = vec2<i32>(uv * dims);
    if (all(pixel == originPixel)) { continue; }
    let sceneDepthValue = textureLoad(sceneDepth, pixel, 0);
    if (sceneDepthValue <= 0.0) { continue; }
    let sceneDistance = contactShadowLinearDepth(sceneDepthValue, near, far, orthographic);
    let rayDistance = select(clip.w, contactShadowLinearDepth(ndc.z, near, far, true), orthographic);
    let delta = rayDistance - sceneDistance;
    if (delta > 0.0 && delta < thickness) {
      // Near hits darken fully; hits toward the ray end fade so the shadow
      // edge follows the configured length instead of cutting off.
      return t * t;
    }
  }
  return 1.0;
}

