#define_import_path forgeax::vfx-render.particles.mesh-inputs
#pragma variant_axis ATMOSPHERE_AVAILABLE
#import forgeax_view::common::{View, view}
#import forgeax_scene_temporal::{sceneViewZ}
#import forgeax_material::standard_surface::{VsOut, StandardSurfaceFactors, evaluateStandardSurface, material}
#import forgeax_material::standard_surface::{materialTextureFilteringWitness}

#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE
#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE
#pragma variant_axis DIRECTIONAL_PCSS_AVAILABLE
#pragma variant_axis PROJECTOR_AVAILABLE

// Retain the full declared material ABI in reflection, including inactive inputs.
fn materialInterfaceWitness() { materialTextureFilteringWitness(); }

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) @interpolate(flat) render_controls: vec2<f32>,
  @location(4) world_position: vec3<f32>,
  @location(5) uv: vec2<f32>,
  @location(6) tangent: vec4<f32>,
  @location(7) uv1: vec2<f32>,
};

struct VertexInput {
  @location(0) geometry_position: vec3<f32>,
  @location(1) geometry_normal: vec3<f32>,
  @location(2) geometry_uv: vec2<f32>,
  @location(3) geometry_tangent: vec4<f32>,
  @location(14) geometry_color: vec4<f32>,
  @location(15) geometry_uv1: vec2<f32>,
  @location(4) center: vec3<f32>,
  @location(5) right: vec3<f32>,
  @location(6) up: vec3<f32>,
  @location(7) forward: vec3<f32>,
  @location(8) particle_color: vec4<f32>,
  @location(9) render_controls: vec2<f32>,
  @location(10) particle_inputs: vec4<f32>,
};

fn safeNormalize(value: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
  let magnitude = length(value);
  if (magnitude > 0.000001) { return value / magnitude; }
  return fallback;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.world_position = input.center + input.right * input.geometry_position.x +
    input.up * input.geometry_position.y + input.forward * input.geometry_position.z;
  output.position = view.worldViewProj * vec4<f32>(output.world_position, 1.0);
  let heat = clamp(input.particle_inputs.x, 0.0, 1.0);
  output.color = input.geometry_color * input.particle_color * (0.35 + 0.65 * heat);
  let normalBasisX = cross(input.up, input.forward);
  let normalBasisY = cross(input.forward, input.right);
  let normalBasisZ = cross(input.right, input.up);
  // Cofactors require determinant sign for reflected/non-uniform Scale3.
  let handedness = select(-1.0, 1.0, dot(input.right, normalBasisX) >= 0.0);
  output.normal = safeNormalize(handedness * (
    normalBasisX * input.geometry_normal.x + normalBasisY * input.geometry_normal.y +
    normalBasisZ * input.geometry_normal.z), vec3<f32>(0.0, 1.0, 0.0));
  let tangent = input.right * input.geometry_tangent.x + input.up * input.geometry_tangent.y +
    input.forward * input.geometry_tangent.z;
  output.tangent = vec4<f32>(safeNormalize(tangent - output.normal * dot(output.normal, tangent),
    vec3<f32>(1.0, 0.0, 0.0)), input.geometry_tangent.w * handedness);
  output.uv = input.geometry_uv;
  output.uv1 = input.geometry_uv1;
  output.render_controls = input.render_controls;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  var surface: VsOut;
  let clip = view.worldViewProj * vec4<f32>(input.world_position, 1.0);
  surface.clip = clip;
  surface.worldPos = input.world_position;
  surface.worldNormal = input.normal;
  surface.worldTangent = input.tangent;
  surface.uv = input.uv;
  surface.uvOne = input.uv1;
  surface.uvTwo = input.uv;
  surface.uvThree = input.uv;
  surface.uvFour = input.uv;
  surface.uvFive = input.uv;
  surface.uvSix = input.uv;
  surface.uvSeven = input.uv;
  surface.ndc = vec4<f32>(clip.xyz / clip.w, 0.0);
  surface.viewZ = sceneViewZ(clip, view.temporalProjection);
  return evaluateStandardSurface(surface, StandardSurfaceFactors(
    input.color * material.baseColor, material.metallic, material.roughness,
    material.emissive, material.emissiveIntensity,
    material.clearcoat, material.clearcoatRoughness,
    input.render_controls.x != 0.0, input.render_controls.y != 0.0,
  )).color;
}
