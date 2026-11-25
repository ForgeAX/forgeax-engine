#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, scaleTangentSpaceNormal}
#import forgeax_view::common::{View, depthSurfaceCameraFacing, reconstructDepthSurface}
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness, loadStandardSceneSurfaceValid}

struct DecalParams {
  inverse : mat4x4<f32>,
  transform : mat4x4<f32>,
  color : vec4<f32>,
  weights : vec4<f32>,
  settings : vec4<f32>,
  flags : vec4<f32>,
  uv0 : array<vec4<f32>, 2>,
  uv1 : array<vec4<f32>, 2>,
  uv2 : array<vec4<f32>, 2>,
};
@group(0) @binding(0) var<uniform> view : View;
@group(1) @binding(0) var<uniform> decal : DecalParams;
@group(1) @binding(1) var sceneDepth : texture_depth_2d;
@group(1) @binding(2) var sceneNormal : texture_2d<u32>;
@group(1) @binding(3) var colorTexture : texture_2d<f32>;
@group(1) @binding(4) var normalTexture : texture_2d<f32>;
@group(1) @binding(5) var roughnessTexture : texture_2d<f32>;
@group(1) @binding(6) var colorSampler : sampler;
@group(1) @binding(7) var normalSampler : sampler;
@group(1) @binding(8) var roughnessSampler : sampler;

@vertex
fn vs_main(@builtin(vertex_index) vertex : u32) -> @builtin(position) vec4<f32> {
  var low = vec2<f32>(1.0);
  var high = vec2<f32>(-1.0);
  var intersectsNear = false;
  for (var corner = 0u; corner < 8u; corner++) {
    let local = vec3<f32>(f32(corner & 1u), f32((corner >> 1u) & 1u), f32((corner >> 2u) & 1u)) - 0.5;
    let clip = view.worldViewProj * decal.transform * vec4<f32>(local, 1.0);
    if (clip.w <= 0.0 || clip.z <= 0.0) { intersectsNear = true; }
    let projected = clip.xy / max(clip.w, 0.000001);
    low = min(low, projected);
    high = max(high, projected);
  }
  if (intersectsNear) { low = vec2<f32>(-1.0); high = vec2<f32>(1.0); }
  low = clamp(low, vec2<f32>(-1.0), vec2<f32>(1.0));
  high = clamp(high, vec2<f32>(-1.0), vec2<f32>(1.0));
  let corners = array<vec2<f32>, 6>(vec2<f32>(0,0), vec2<f32>(1,0), vec2<f32>(0,1),
    vec2<f32>(0,1), vec2<f32>(1,0), vec2<f32>(1,1));
  return vec4<f32>(mix(low, high, corners[vertex]), 0.0, 1.0);
}

fn transformedUv(uv : vec2<f32>, rows : array<vec4<f32>, 2>) -> vec2<f32> {
  return vec2<f32>(dot(rows[0].xyz, vec3<f32>(uv, 1)), dot(rows[1].xyz, vec3<f32>(uv, 1)));
}

struct DecalOutput {
  @location(0) color : vec4<f32>,
  @location(1) normal : vec4<f32>,
  @location(2) roughness : vec4<f32>,
};

struct DecalProjection {
  output : DecalOutput,
  covered : bool,
};

fn projectDecal(world : vec3<f32>, receiverNormal : vec3<f32>, valid : bool) -> DecalProjection {
  let local = (decal.inverse * vec4<f32>(world, 1)).xyz;
  let uv = vec2<f32>(local.x + 0.5, 0.5 - local.y);
  let uv0 = transformedUv(uv, decal.uv0);
  let uv1 = transformedUv(uv, decal.uv1);
  let uv2 = transformedUv(uv, decal.uv2);
  // Derivatives are evaluated uniformly before any receiver/box rejection.
  let dx0 = dpdx(uv0); let dy0 = dpdy(uv0);
  let dx1 = dpdx(uv1); let dy1 = dpdy(uv1);
  let dx2 = dpdx(uv2); let dy2 = dpdy(uv2);
  if (!valid || any(abs(local) > vec3<f32>(0.5))) { return DecalProjection(DecalOutput(), false); }
  let direction = normalize(decal.transform[2].xyz);
  if (dot(receiverNormal, direction) < decal.settings.w) { return DecalProjection(DecalOutput(), false); }
  let color = textureSampleGrad(colorTexture, colorSampler, uv0, dx0, dy0) * decal.color;
  let alpha = clamp(color.a * decal.weights.w, 0.0, 1.0);
  if (alpha <= 0.0 || color.a < decal.flags.z) { return DecalProjection(DecalOutput(), false); }
  let tangentCandidate = decal.transform[0].xyz - receiverNormal * dot(receiverNormal, decal.transform[0].xyz);
  var normal = receiverNormal;
  if (decal.flags.x > 0.0 && dot(tangentCandidate, tangentCandidate) > 0.000001) {
    let tangent = normalize(tangentCandidate);
    let bitangent = -normalize(cross(receiverNormal, tangent));
    let mapped = decodeTangentSpaceNormalRg(textureSampleGrad(normalTexture, normalSampler, uv1, dx1, dy1).rg);
    let adjusted = scaleTangentSpaceNormal(mapped, decal.settings.yz);
    normal = normalize(tangent * adjusted.x + bitangent * adjusted.y + receiverNormal * adjusted.z);
  }
  let roughnessSample = textureSampleGrad(roughnessTexture, roughnessSampler, uv2, dx2, dy2);
  let roughness = clamp(decal.settings.x * roughnessSample[u32(decal.flags.y)], 0.04, 1.0);
  return DecalProjection(DecalOutput(vec4<f32>(color.rgb, alpha * decal.weights.x),
    vec4<f32>(normal, alpha * decal.weights.y * decal.flags.x),
    vec4<f32>(roughness, 0, 0, alpha * decal.weights.z)), true);
}

@fragment
fn fs_main(@builtin(position) pixel : vec4<f32>) -> DecalOutput {
  let coord = vec2<i32>(pixel.xy);
  let depth = textureLoad(sceneDepth, coord, 0);
  let uv = pixel.xy / vec2<f32>(textureDimensions(sceneDepth));
  let worldH = view.inverseViewProj * vec4<f32>(uv * vec2<f32>(2, -2) + vec2<f32>(-1, 1), depth, 1);
  let projection = projectDecal(worldH.xyz / worldH.w, loadStandardNormalRoughness(sceneNormal, coord).xyz,
    depth < 1.0 && loadStandardSceneSurfaceValid(sceneNormal, coord));
  if (!projection.covered) { discard; }
  return projection.output;
}

@fragment
fn fs_depth(@builtin(position) pixel : vec4<f32>) -> DecalOutput {
  let coord = vec2<i32>(pixel.xy);
  let depth = textureLoad(sceneDepth, coord, 0);
  let fallback = depthSurfaceCameraFacing(view.worldViewProj, view.temporalProjection.z > 0.5);
  let surface = reconstructDepthSurface(sceneDepth, coord, depth, view.inverseViewProj, fallback);
  let projection = projectDecal(surface.position, surface.normal, depth > 0.0);
  if (!projection.covered) { discard; }
  return projection.output;
}
