#define_import_path hello-multi-uv::multi-uv-demo-false
#import forgeax_view::common::{view, meshes, instances}
#import forgeax_material::parameters::{material, baseColorTexture, baseColorTexture_sampler, detailTexture, detailTexture_sampler}

struct VsIn {
  @location(0) pos : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) tangent : vec4<f32>,
  @location(6) uv1 : vec2<f32>,
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) uv : vec2<f32>,
  @location(5) uv1 : vec2<f32>,
};

fn transformUv(uv : vec2<f32>, transform : vec4<f32>) -> vec2<f32> {
  return uv * transform.zw + transform.xy;
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let instanceLocal = instances[idx].localFromInstance;
  let entityWorld = meshes[0].worldFromLocal;
  let world = entityWorld * instanceLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.worldPos = world.xyz;
  out.uv = in.uv;
  out.uv1 = in.uv1;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let pattern = vec3<f32>(in.uv1, 0.5);
  let variantTint = vec3<f32>(0.85, 1.0, 0.85);
  let parameterUv = transformUv(in.uv, material.baseColorUvTransform);
  let uvMutation = length(parameterUv - in.uv);
  let uvParameterFactor = 1.0 +
    0.45 * sin((parameterUv.x + parameterUv.y) * 6.2831853) * min(uvMutation, 1.0);
  let sampled = textureSample(baseColorTexture, baseColorTexture_sampler, parameterUv);
  let detail = textureSample(detailTexture, detailTexture_sampler, in.uv);
  return vec4<f32>(material.baseColor.rgb * sampled.rgb * detail.rgb * pattern * variantTint * uvParameterFactor, material.baseColor.a * sampled.a * detail.a);
}
