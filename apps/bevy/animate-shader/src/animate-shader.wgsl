#define_import_path bevy::animate_shader

#import forgeax_view::common::{view, meshes}

struct VsIn {
  @location(0) pos : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
}

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.uv = in.uv;
  return out;
}

fn oklab_to_linear_srgb(c : vec3<f32>) -> vec3<f32> {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541720 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3<f32>(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let speed = 2.0;
  let t1 = sin(material.time * speed) * 0.5 + 0.5;
  let t2 = cos(material.time * speed) * 0.5 + 0.5;
  let distance_to_center = distance(in.uv, vec2<f32>(0.5)) * 1.4;

  let red = vec3<f32>(0.627955, 0.224863, 0.125846);
  let green = vec3<f32>(0.866440, -0.233887, 0.179498);
  let blue = vec3<f32>(0.701674, 0.274566, -0.169156);
  let white = vec3<f32>(1.0, 0.0, 0.0);
  let mixed = mix(mix(red, blue, t1), mix(green, white, t2), distance_to_center);
  return vec4<f32>(oklab_to_linear_srgb(mixed), 1.0);
}
