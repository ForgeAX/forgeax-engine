#define_import_path forgeax::vfx-render.particles.billboard-water-sphere
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#import forgeax_view::common::{View, view, viewDirectionToCamera}
#import forgeax_view::fog::{ndc_world}
#import forgeax_scene_temporal::{sceneViewZ}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg}
#import forgeax_material::standard_surface::{
  VsOut, StandardSurfaceFactors, evaluateStandardSurfaceWithWorldNormal, material, normalTexture,
  normalTexture_sampler, occlusionTexture, occlusionTexture_sampler,
}
@group(0) @binding(1) var scene_depth: texture_depth_2d;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,
  @location(2) subsurface_gain: vec3<f32>,
  @location(3) opacity_multiplier: f32,
  @location(4) sheet_uv: vec2<f32>,
  @location(5) sheet_frame: f32,
  @location(6) fade_distance: f32,
  @location(7) clip_position: vec3<f32>,
  @location(8) billboard_right: vec2<f32>,
  @location(9) billboard_up: vec2<f32>,
  @location(11) water_sphere_shading: vec4<f32>,
  @location(12) water_sphere_flatten_sphere: vec4<f32>,
  @location(13) water_sphere_projection: vec4<f32>,
};

fn textureSheetUv(local: vec2<f32>, frame: u32, columns: u32, rows: u32) -> vec2<f32> {
  let safeColumns = max(columns, 1u);
  let safeRows = max(rows, 1u);
  let cell = vec2<u32>(frame % safeColumns, frame / safeColumns);
  return (local + vec2<f32>(1.0)) * 0.5 / vec2<f32>(f32(safeColumns), f32(safeRows)) +
    vec2<f32>(f32(cell.x) / f32(safeColumns), f32(cell.y) / f32(safeRows));
}

fn softParticle(position: vec4<f32>, alpha: f32, fadeDistance: f32) -> f32 {
  let pixel = vec2<i32>(position.xy);
  let sceneDepth = textureLoad(scene_depth, pixel, 0);
  if (sceneDepth <= 0.0) { return alpha; }
  if (fadeDistance <= 0.0) { return select(alpha, 0.0, position.z < sceneDepth); }
  return alpha * clamp((position.z - sceneDepth) / fadeDistance, 0.0, 1.0);
}

fn sphereMask(uv: vec2<f32>, radius: f32, hardnessPercent: f32) -> f32 {
  let distance = length(uv - vec2<f32>(0.5));
  return clamp(
    (1.0 - distance / radius) / max(1.0 - hardnessPercent / 100.0, 0.00001),
    0.0,
    1.0,
  );
}

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) right: vec2<f32>,
  @location(2) up: vec2<f32>,
  @location(3) particle_color: vec4<f32>,
  @location(4) base_color: vec4<f32>,
  @location(5) emissive_intensity: vec4<f32>,
  @location(6) surface: vec4<f32>,
  @location(7) advanced: vec4<f32>,
  @location(8) texture_sheet: vec4<f32>,
  @location(9) subsurface_gain_opacity: vec4<f32>,
  @location(10) water_sphere_shading: vec4<f32>,
  @location(11) water_sphere_flatten_sphere: vec4<f32>,
  @location(12) water_sphere_projection: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
  );
  let corner = corners[vertex_index] + input.advanced.xy * 2.0;
  var output: VertexOutput;
  let clipPosition = vec3<f32>(
    input.position.xy + input.right * corner.x + input.up * corner.y,
    input.position.z,
  );
  output.position = vec4<f32>(clipPosition, 1.0);
  output.clip_position = clipPosition;
  output.billboard_right = input.right;
  output.billboard_up = input.up;
  output.color = input.particle_color * input.base_color;
  output.local = corner;
  output.subsurface_gain = input.subsurface_gain_opacity.xyz;
  output.opacity_multiplier = input.subsurface_gain_opacity.w;
  output.water_sphere_shading = input.water_sphere_shading;
  output.water_sphere_flatten_sphere = input.water_sphere_flatten_sphere;
  output.water_sphere_projection = input.water_sphere_projection;
  output.sheet_uv = textureSheetUv(
    corners[vertex_index], u32(input.advanced.z),
    u32(input.texture_sheet.x), u32(input.texture_sheet.y),
  );
  output.sheet_frame = input.advanced.z;
  output.fade_distance = input.texture_sheet.z;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texCoord3 = input.local * 0.5 + vec2<f32>(0.5);
  let texCoord4 = input.sheet_uv;
  let uvNoise = texCoord4 * input.water_sphere_shading.y +
    vec2<f32>(input.water_sphere_projection.x);
  let opacityNoise = textureSample(occlusionTexture, occlusionTexture_sampler, uvNoise).r;
  let noiseOffset = (opacityNoise - 0.7) * input.water_sphere_shading.z;
  let opacityTexCoord3 = texCoord3 + vec2<f32>(noiseOffset);
  let sphereMask = sphereMask(
    opacityTexCoord3,
    input.water_sphere_projection.w,
    input.water_sphere_projection.z,
  );
  let alpha = softParticle(
    input.position,
    sphereMask * input.opacity_multiplier * input.color.a,
    input.fade_distance,
  );
  let worldPosition = ndc_world(view, input.clip_position);
  let viewDirection = viewDirectionToCamera(worldPosition);
  let sphereRadius = input.water_sphere_flatten_sphere.w;
  let sphereX = input.local.x;
  let sphereY = input.local.y;
  let zSquared = sphereRadius * sphereRadius - sphereX * sphereX - sphereY * sphereY;
  let sphereNormal = select(
    vec3<f32>(0.0, 0.0, 1.0),
    vec3<f32>(sphereX, sphereY, sqrt(max(zSquared, 0.0))),
    zSquared >= 0.0,
  );
  // TexCoord4 owns detail normals; TexCoord3 is an independent opacity-noise
  // projection. R8 explicitly authors each scale and each keyed random offset.
  let normalTextureValue = decodeTangentSpaceNormalRg(
    textureSample(normalTexture, normalTexture_sampler, uvNoise).rg,
  );
  let flattened = mix(normalTextureValue, input.water_sphere_flatten_sphere.xyz, input.water_sphere_shading.w);
  let localClipCenter = input.clip_position - vec3<f32>(
    input.billboard_right * input.local.x + input.billboard_up * input.local.y,
    0.0,
  );
  let worldCenter = ndc_world(view, localClipCenter);
  let worldRight = normalize(ndc_world(view, localClipCenter + vec3<f32>(input.billboard_right, 0.0)) - worldCenter);
  let worldUp = normalize(ndc_world(view, localClipCenter + vec3<f32>(input.billboard_up, 0.0)) - worldCenter);
  let baseNormal = vec3<f32>(sphereNormal.x, sphereNormal.y, sphereNormal.z + 1.0);
  let detailNormal = vec3<f32>(-flattened.x, -flattened.y, flattened.z);
  let angleCorrected = normalize(
    baseNormal * dot(baseNormal, detailNormal) - (sphereNormal.z + 1.0) * detailNormal,
  );
  let surfaceNormal = normalize(
    worldRight * angleCorrected.x + worldUp * angleCorrected.y + viewDirection * angleCorrected.z,
  );
  let power = input.water_sphere_shading.x;
  let csub = input.color.rgb * input.subsurface_gain;
  let backscatter = csub *
    pow(clamp(dot(normalize(view.lightDir), viewDirection), 0.0, 1.0), power) *
    view.lightColor * ((power + 2.0) / 8.0);
  var materialSurface: VsOut;
  materialSurface.clip = input.position;
  materialSurface.worldPos = worldPosition;
  materialSurface.worldNormal = surfaceNormal;
  materialSurface.worldTangent = vec4<f32>(worldRight, 1.0);
  materialSurface.uv = input.sheet_uv;
  materialSurface.uvOne = input.sheet_uv;
  materialSurface.uvTwo = input.sheet_uv;
  materialSurface.uvThree = input.sheet_uv;
  materialSurface.uvFour = input.sheet_uv;
  materialSurface.uvFive = input.sheet_uv;
  materialSurface.uvSix = input.sheet_uv;
  materialSurface.uvSeven = input.sheet_uv;
  materialSurface.ndc = vec4<f32>(input.position.xyz / input.position.w, 0.0);
  materialSurface.viewZ = sceneViewZ(input.position, view.temporalProjection);
  let surface = evaluateStandardSurfaceWithWorldNormal(
    materialSurface,
    StandardSurfaceFactors(
      vec4<f32>(input.color.rgb, alpha),
      material.metallic,
      material.roughness,
      material.emissive + backscatter,
      1.0,
      material.clearcoat,
      material.clearcoatRoughness,
      true,
      false,
    ),
    surfaceNormal,
  );
  return vec4<f32>(surface.color.rgb * surface.color.a, surface.color.a);
}
