#import hello_triangle::view::{View, Mesh, view, meshes}
#import hello_triangle::brdf::{f_schlick, v_smith, d_ggx}

// Simplified PBR shader - 3 BG mesh-array form (plan-strategy §S-8 / D-R8 /
// OQ-3 close). metal/rough Cook-Torrance (D_GGX + V_SmithCorrelated +
// F_Schlick) + Lambertian diffuse, single directional light, world-space
// lighting, sRGB swap chain (no tone mapping).
// Source: Bevy KB BRDF + webgpu-samples normalMap pruned to 3 BG mesh-array
// layout. Refactored T-19 (feat-20260512-naga-oil-composition-hmr) into
// canonical 3-file composition demo (view + brdf + pbr).

struct Material {
  baseColor : vec3<f32>,
  metallic  : f32,
  roughness : f32,
};

@group(1) @binding(0) var<uniform> material : Material;

struct VsIn  { @location(0) pos : vec3<f32>, @location(1) normal : vec3<f32> };
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
  @location(2) @interpolate(flat) instanceIdx : u32,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.worldPos = world.xyz;
  out.worldNormal = normalize((meshes[idx].worldFromLocal * vec4<f32>(in.normal, 0.0)).xyz);
  out.instanceIdx = idx;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.worldNormal);
  let v = normalize(view.cameraPos - in.worldPos);
  let l = normalize(-view.lightDir);
  let h = normalize(v + l);
  let nDotL = max(dot(n, l), 0.0);
  let nDotV = max(dot(n, v), 1e-5);
  let nDotH = max(dot(n, h), 0.0);
  let vDotH = max(dot(v, h), 0.0);
  let a = material.roughness * material.roughness;
  let f0 = mix(vec3<f32>(0.04), material.baseColor, material.metallic);
  let f = f_schlick(vDotH, f0);
  let specular = d_ggx(nDotH, a) * v_smith(nDotV, nDotL, a) * f;
  let kd = (vec3<f32>(1.0) - f) * (1.0 - material.metallic);
  let diffuse = kd * material.baseColor / 3.14159265;
  let color = (diffuse + specular) * view.lightColor * nDotL;
  return vec4<f32>(color, 1.0);
}
