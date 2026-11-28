// Cross-backend WGSL shader sources for the built-in KernelStandardPipeline.
// Supports Desktop Native (Metal/DX12/Vulkan), WebGPU/Dawn (RhiPhysicalExecutor), and
// Browser WebGL2 WASM closure (uniform-buffer PBR fallback + identical Skybox/Bloom/Tonemap/FXAA).

export const KERNEL_VERTEX_LAYOUT_STANDARD: readonly GPUVertexBufferLayout[] = [
  {
    arrayStride: 48,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' },
      { shaderLocation: 3, offset: 32, format: 'float32x4' },
    ],
  },
];

export const KERNEL_VERTEX_LAYOUT_SKINNED: readonly GPUVertexBufferLayout[] = [
  {
    arrayStride: 80,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' },
      { shaderLocation: 3, offset: 32, format: 'float32x4' },
      { shaderLocation: 4, offset: 48, format: 'float32x4' },
      { shaderLocation: 5, offset: 64, format: 'float32x4' },
    ],
  },
];

export const KERNEL_VERTEX_LAYOUT_DEBUG_LINES: readonly GPUVertexBufferLayout[] = [
  {
    arrayStride: 28,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x4' },
    ],
  },
];

export const WGSL_KERNEL_SHADOW_DEPTH = /* wgsl */ `
struct ShadowViewUniform {
  view_proj: mat4x4<f32>,
  light_vp: mat4x4<f32>,
};
struct SceneObjectGpu {
  world: mat4x4<f32>,
  params0: vec4<f32>,
  params1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_view: ShadowViewUniform;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObjectGpu>;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;

@vertex
fn vs_shadow(
  @location(0) pos: vec3<f32>,
  @builtin(instance_index) inst: u32,
) -> @builtin(position) vec4<f32> {
  let obj = s_objects[s_instance_rows[inst]];
  return u_view.light_vp * (obj.world * vec4<f32>(pos, 1.0));
}
`;

export const WGSL_KERNEL_SHADOW_SKINNED = /* wgsl */ `
struct ShadowViewUniform {
  view_proj: mat4x4<f32>,
  light_vp: mat4x4<f32>,
};
struct SceneObjectGpu {
  world: mat4x4<f32>,
  params0: vec4<f32>,
  params1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_view: ShadowViewUniform;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObjectGpu>;
@group(2) @binding(4) var<storage, read> s_skin_joints: array<mat4x4<f32>>;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;

@vertex
fn vs_shadow(
  @location(0) pos: vec3<f32>,
  @location(4) joints: vec4<f32>,
  @location(5) weights: vec4<f32>,
  @builtin(instance_index) inst: u32,
) -> @builtin(position) vec4<f32> {
  let obj = s_objects[s_instance_rows[inst]];
  let slot_raw = u32(max(obj.params1.w, 0.0) + 0.5);
  var skin_mat = obj.world;
  if (slot_raw > 0u) {
    let base_j = slot_raw - 1u;
    let blended =
      s_skin_joints[base_j + u32(joints.x + 0.5)] * weights.x +
      s_skin_joints[base_j + u32(joints.y + 0.5)] * weights.y +
      s_skin_joints[base_j + u32(joints.z + 0.5)] * weights.z +
      s_skin_joints[base_j + u32(joints.w + 0.5)] * weights.w;
    if (obj.params1.z > 0.5) {
      skin_mat = obj.world * blended;
    } else {
      skin_mat = blended;
    }
  }
  return u_view.light_vp * (skin_mat * vec4<f32>(pos, 1.0));
}
`;

export const WGSL_KERNEL_4BGL_PBR = /* wgsl */ `
const PI: f32 = 3.14159265359;

struct ViewUniform {
  view_proj: mat4x4<f32>,
  cascade_vp: array<mat4x4<f32>, 4>,
  cascade_splits: vec4<f32>,
  cascade_atlas_rect: array<vec4<f32>, 4>,
  camera_pos_exposure: vec4<f32>,
  sky_color_intensity: vec4<f32>,
  ground_color_bias: vec4<f32>,
  light_meta: vec4<u32>,
  shadow_atlas_meta: vec4<f32>,
  fog_params0: vec4<f32>,
  fog_params1: vec4<f32>,
  fog_params2: vec4<f32>,
};
struct MaterialUniform {
  albedo: vec4<f32>,
  pbr_params: vec4<f32>,
  emissive_occ: vec4<f32>,
  normal_extra: vec4<f32>,
};
struct SceneObjectGpu {
  world: mat4x4<f32>,
  params0: vec4<f32>,
  params1: vec4<f32>,
};
struct SceneLightGpu {
  position_range: vec4<f32>,
  direction_intensity: vec4<f32>,
  color_outer_cos: vec4<f32>,
  flags_meta: vec4<u32>,
};

@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(1) @binding(0) var<uniform> u_mat: MaterialUniform;
@group(1) @binding(1) var t_albedo: texture_2d<f32>;
@group(1) @binding(2) var s_albedo: sampler;
@group(1) @binding(3) var t_normal: texture_2d<f32>;
@group(1) @binding(4) var t_metallic_roughness: texture_2d<f32>;
@group(1) @binding(5) var t_emissive: texture_2d<f32>;
@group(1) @binding(6) var t_occlusion: texture_2d<f32>;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObjectGpu>;
@group(2) @binding(1) var<storage, read> s_lights: array<SceneLightGpu>;
@group(2) @binding(2) var t_shadow: texture_depth_2d;
@group(2) @binding(3) var s_shadow: sampler_comparison;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world_pos: vec3<f32>,
  @location(1) world_n: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) world_t: vec4<f32>,
  @location(4) tint: vec4<f32>,
};

@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @builtin(instance_index) inst: u32,
) -> VsOut {
  let obj = s_objects[s_instance_rows[inst]];
  let wp = obj.world * vec4<f32>(pos, 1.0);
  var out: VsOut;
  out.pos = u_view.view_proj * wp;
  out.world_pos = wp.xyz;
  let wn = (obj.world * vec4<f32>(normal, 0.0)).xyz;
  let n_len = length(wn);
  out.world_n = select(vec3<f32>(0.0, 1.0, 0.0), wn / n_len, n_len > 1e-6);
  let wt = (obj.world * vec4<f32>(tangent.xyz, 0.0)).xyz;
  let t_len = length(wt);
  let t_norm = select(vec3<f32>(1.0, 0.0, 0.0), wt / t_len, t_len > 1e-6);
  out.world_t = vec4<f32>(t_norm, select(1.0, tangent.w, abs(tangent.w) > 0.5));
  out.uv = uv;
  let has_tint = obj.params0.w > 0.0;
  out.tint = select(vec4<f32>(1.0, 1.0, 1.0, 1.0), obj.params0, has_tint);
  return out;
}

fn sample_cascade_pcf(cascade_idx: u32, world_pos: vec3<f32>, n: vec3<f32>) -> vec2<f32> {
  let bias_scale = 0.04 * (1.0 + f32(cascade_idx) * 0.6);
  let shadow_clip = u_view.cascade_vp[cascade_idx] * vec4<f32>(world_pos + n * bias_scale, 1.0);
  let shadow_ndc = shadow_clip.xyz / max(shadow_clip.w, 1e-5);
  let tile_uv = vec2<f32>(shadow_ndc.x * 0.5 + 0.5, 0.5 - shadow_ndc.y * 0.5);
  let in_bounds = tile_uv.x >= 0.002 && tile_uv.x <= 0.998 &&
    tile_uv.y >= 0.002 && tile_uv.y <= 0.998 &&
    shadow_ndc.z >= 0.0 && shadow_ndc.z <= 1.0;
  let rect = u_view.cascade_atlas_rect[cascade_idx];
  let texel = u_view.shadow_atlas_meta.xy;
  let min_uv = rect.xy + texel;
  let max_uv = rect.xy + rect.zw - texel;
  let atlas_uv = clamp(rect.xy + tile_uv * rect.zw, min_uv, max_uv);
  let cmp_depth = shadow_ndc.z - u_view.ground_color_bias.w * (1.0 + f32(cascade_idx) * 0.45);
  var sum = textureSampleCompare(t_shadow, s_shadow, atlas_uv, cmp_depth);
  sum = sum + textureSampleCompare(t_shadow, s_shadow, clamp(atlas_uv + vec2<f32>(texel.x, 0.0), min_uv, max_uv), cmp_depth);
  sum = sum + textureSampleCompare(t_shadow, s_shadow, clamp(atlas_uv - vec2<f32>(texel.x, 0.0), min_uv, max_uv), cmp_depth);
  sum = sum + textureSampleCompare(t_shadow, s_shadow, clamp(atlas_uv + vec2<f32>(0.0, texel.y), min_uv, max_uv), cmp_depth);
  sum = sum + textureSampleCompare(t_shadow, s_shadow, clamp(atlas_uv - vec2<f32>(0.0, texel.y), min_uv, max_uv), cmp_depth);
  return vec2<f32>(sum * 0.2, select(0.0, 1.0, in_bounds));
}

fn eval_shadow(world_pos: vec3<f32>, n: vec3<f32>, cam_dist: f32) -> f32 {
  if (u_view.light_meta.y == 0u) {
    return 1.0;
  }
  let cascade_count = max(1u, min(u_view.light_meta.w, 4u));
  var chosen: u32 = cascade_count - 1u;
  if (cascade_count > 1u) {
    if (cam_dist <= u_view.cascade_splits.x) {
      chosen = 0u;
    } else if (cascade_count > 2u && cam_dist <= u_view.cascade_splits.y) {
      chosen = 1u;
    } else if (cascade_count > 3u && cam_dist <= u_view.cascade_splits.z) {
      chosen = 2u;
    }
  }
  let s0 = sample_cascade_pcf(chosen, world_pos, n);
  if (s0.y > 0.5) {
    return s0.x;
  }
  if (chosen + 1u < cascade_count) {
    let s1 = sample_cascade_pcf(chosen + 1u, world_pos, n);
    return select(1.0, s1.x, s1.y > 0.5);
  }
  return 1.0;
}

fn d_ggx(ndoth: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let d = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-6);
}

fn g_schlick_ggx(ndotx: f32, k: f32) -> f32 {
  return ndotx / max(ndotx * (1.0 - k) + k, 1e-5);
}

fn f_schlick(cos_theta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let tex = textureSample(t_albedo, s_albedo, in.uv);
  let base = tex.rgb * u_mat.albedo.rgb * in.tint.rgb;
  let alpha = clamp(tex.a * u_mat.albedo.a * in.tint.a, 0.0, 1.0);
  let mat_flags = u32(u_mat.pbr_params.w + 0.5);
  if ((mat_flags & 2u) != 0u && alpha < u_mat.pbr_params.z) {
    discard;
  }

  let geom_n = normalize(in.world_n);
  var n = geom_n;
  if ((mat_flags & 4u) != 0u) {
    let raw_t = in.world_t.xyz - geom_n * dot(in.world_t.xyz, geom_n);
    let t_len = length(raw_t);
    if (t_len > 1e-5) {
      let t_vec = raw_t / t_len;
      let b_vec = cross(geom_n, t_vec) * in.world_t.w;
      let n_sample = textureSample(t_normal, s_albedo, in.uv).xyz * 2.0 - vec3<f32>(1.0);
      let n_ts = vec3<f32>(n_sample.xy * u_mat.normal_extra.x, max(n_sample.z, 1e-4));
      n = normalize(t_vec * n_ts.x + b_vec * n_ts.y + geom_n * n_ts.z);
    }
  }

  let mr_tex = textureSample(t_metallic_roughness, s_albedo, in.uv);
  let roughness = clamp(u_mat.pbr_params.x * mr_tex.g, 0.045, 1.0);
  let metallic = clamp(u_mat.pbr_params.y * mr_tex.b, 0.0, 1.0);
  let occ_tex = textureSample(t_occlusion, s_albedo, in.uv).r;
  let ao = mix(1.0, occ_tex, clamp(u_mat.emissive_occ.w, 0.0, 1.0));
  let emissive_tex = textureSample(t_emissive, s_albedo, in.uv).rgb;
  let emissive = u_mat.emissive_occ.rgb * emissive_tex;

  let to_cam = u_view.camera_pos_exposure.xyz - in.world_pos;
  let cam_dist = length(to_cam);
  let v = to_cam / max(cam_dist, 1e-5);
  let ndotv = max(dot(n, v), 0.001);
  let f0 = mix(vec3<f32>(0.04), base, metallic);
  let alpha_r = roughness * roughness;
  let k_direct = ((roughness + 1.0) * (roughness + 1.0)) * 0.125;

  let dir_shadow = eval_shadow(in.world_pos, geom_n, cam_dist);
  let light_count = min(u_view.light_meta.x, 16u);
  let shadow_idx = u_view.light_meta.z;

  var direct = vec3<f32>(0.0);
  for (var i: u32 = 0u; i < light_count; i = i + 1u) {
    let light = s_lights[i];
    let kind = light.flags_meta.x;
    var l = vec3<f32>(0.0, 1.0, 0.0);
    var atten = 1.0;
    if (kind == 0u) {
      let d_len = length(light.direction_intensity.xyz);
      l = select(vec3<f32>(0.0, 1.0, 0.0), -light.direction_intensity.xyz / d_len, d_len > 1e-6);
      if (i == shadow_idx && light.flags_meta.y != 0u) {
        atten = dir_shadow;
      }
    } else {
      let to_light = light.position_range.xyz - in.world_pos;
      let dist_sq = max(dot(to_light, to_light), 0.0025);
      let dist = sqrt(dist_sq);
      l = to_light / dist;
      atten = 1.0 / dist_sq;
      let rng = light.position_range.w;
      if (rng > 0.0 && rng < 1e8) {
        let ratio = dist / rng;
        let win = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
        atten = atten * win * win;
      }
      if (kind == 2u) {
        let spot_dir = normalize(light.direction_intensity.xyz);
        let cos_theta = dot(-l, spot_dir);
        let outer_cos = light.color_outer_cos.w;
        let inner_cos = min(1.0, outer_cos + (1.0 - outer_cos) * 0.35);
        let cone = smoothstep(outer_cos, max(inner_cos, outer_cos + 0.001), cos_theta);
        atten = atten * cone;
      }
    }
    let ndotl = max(dot(n, l), 0.0);
    if (ndotl > 0.0 && atten > 0.0) {
      let h = normalize(l + v);
      let ndoth = max(dot(n, h), 0.0);
      let hdotv = max(dot(h, v), 0.0);
      let d_term = d_ggx(ndoth, alpha_r);
      let g_term = g_schlick_ggx(ndotv, k_direct) * g_schlick_ggx(ndotl, k_direct);
      let f_term = f_schlick(hdotv, f0);
      let spec = (d_term * g_term * f_term) / max(4.0 * ndotv * ndotl, 0.001);
      let kd = (vec3<f32>(1.0) - f_term) * (1.0 - metallic);
      let radiance = light.color_outer_cos.rgb * light.direction_intensity.w * atten;
      direct = direct + (kd * base * (1.0 / PI) + spec) * radiance * ndotl;
    }
  }

  let hemi = mix(u_view.ground_color_bias.rgb, u_view.sky_color_intensity.rgb, n.y * 0.5 + 0.5);
  let ambient = base * hemi * u_view.sky_color_intensity.w * ao;
  var hdr = (ambient + direct + emissive) * u_view.camera_pos_exposure.w;

  let fog_mode = u32(max(u_view.fog_params0.w, 0.0) + 0.5);
  if (fog_mode > 0u) {
    let dist = length(in.world_pos - u_view.camera_pos_exposure.xyz);
    let density = u_view.fog_params1.x;
    let falloff = u_view.fog_params1.y;
    let f_near = u_view.fog_params1.z;
    let f_far = max(u_view.fog_params1.w, f_near + 0.001);
    let max_op = clamp(u_view.fog_params2.x, 0.0, 1.0);
    var fog_f = 0.0;
    if (fog_mode == 1u) {
      let h_scale = exp(-max(in.world_pos.y, 0.0) * max(falloff, 0.0));
      fog_f = 1.0 - exp(-dist * density * h_scale);
    } else if (fog_mode == 2u) {
      let dd = dist * density;
      fog_f = 1.0 - exp(-(dd * dd));
    } else {
      fog_f = clamp((dist - f_near) / (f_far - f_near), 0.0, 1.0);
    }
    fog_f = clamp(fog_f, 0.0, 1.0) * max_op;
    let fog_hdr = u_view.fog_params0.rgb * u_view.camera_pos_exposure.w;
    hdr = mix(hdr, fog_hdr, fog_f);
  }
  return vec4<f32>(hdr, alpha);
}
`;

export const WGSL_KERNEL_4BGL_PBR_SKINNED = WGSL_KERNEL_4BGL_PBR.replace(
  '@group(2) @binding(3) var s_shadow: sampler_comparison;',
  `@group(2) @binding(3) var s_shadow: sampler_comparison;
@group(2) @binding(4) var<storage, read> s_skin_joints: array<mat4x4<f32>>;`,
).replace(
  `@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @builtin(instance_index) inst: u32,
) -> VsOut {
  let obj = s_objects[s_instance_rows[inst]];
  let wp = obj.world * vec4<f32>(pos, 1.0);
  var out: VsOut;
  out.pos = u_view.view_proj * wp;
  out.world_pos = wp.xyz;
  let wn = (obj.world * vec4<f32>(normal, 0.0)).xyz;
  let n_len = length(wn);
  out.world_n = select(vec3<f32>(0.0, 1.0, 0.0), wn / n_len, n_len > 1e-6);
  let wt = (obj.world * vec4<f32>(tangent.xyz, 0.0)).xyz;
  let t_len = length(wt);
  let t_norm = select(vec3<f32>(1.0, 0.0, 0.0), wt / t_len, t_len > 1e-6);
  out.world_t = vec4<f32>(t_norm, select(1.0, tangent.w, abs(tangent.w) > 0.5));
  out.uv = uv;
  let has_tint = obj.params0.w > 0.0;
  out.tint = select(vec4<f32>(1.0, 1.0, 1.0, 1.0), obj.params0, has_tint);
  return out;
}`,
  `@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(4) joints: vec4<f32>,
  @location(5) weights: vec4<f32>,
  @builtin(instance_index) inst: u32,
) -> VsOut {
  let obj = s_objects[s_instance_rows[inst]];
  let slot_raw = u32(max(obj.params1.w, 0.0) + 0.5);
  var skin_mat = obj.world;
  if (slot_raw > 0u) {
    let base_j = slot_raw - 1u;
    let blended =
      s_skin_joints[base_j + u32(joints.x + 0.5)] * weights.x +
      s_skin_joints[base_j + u32(joints.y + 0.5)] * weights.y +
      s_skin_joints[base_j + u32(joints.z + 0.5)] * weights.z +
      s_skin_joints[base_j + u32(joints.w + 0.5)] * weights.w;
    if (obj.params1.z > 0.5) {
      skin_mat = obj.world * blended;
    } else {
      skin_mat = blended;
    }
  }
  let wp = skin_mat * vec4<f32>(pos, 1.0);
  var out: VsOut;
  out.pos = u_view.view_proj * wp;
  out.world_pos = wp.xyz;
  let wn = (skin_mat * vec4<f32>(normal, 0.0)).xyz;
  let n_len = length(wn);
  out.world_n = select(vec3<f32>(0.0, 1.0, 0.0), wn / n_len, n_len > 1e-6);
  let wt = (skin_mat * vec4<f32>(tangent.xyz, 0.0)).xyz;
  let t_len = length(wt);
  let t_norm = select(vec3<f32>(1.0, 0.0, 0.0), wt / t_len, t_len > 1e-6);
  out.world_t = vec4<f32>(t_norm, select(1.0, tangent.w, abs(tangent.w) > 0.5));
  out.uv = uv;
  let has_tint = obj.params0.w > 0.0;
  out.tint = select(vec4<f32>(1.0, 1.0, 1.0, 1.0), obj.params0, has_tint);
  return out;
}`,
);

/** Uniform-buffer 3D PBR shader requiring zero storage buffers (runs identically on WebGL2 WASM). */
export const WGSL_KERNEL_UNIFORM_PBR = /* wgsl */ `
const PI: f32 = 3.14159265359;
struct DrawUniform {
  view_proj: mat4x4<f32>,
  world: mat4x4<f32>,
  base_color: vec4<f32>,
  emissive_rough_metal: vec4<f32>,
  light_dir_exposure: vec4<f32>,
  light_color_intensity: vec4<f32>,
  ambient_color_intensity: vec4<f32>,
  camera_pos_metallic: vec4<f32>,
  fog_params0: vec4<f32>,
  fog_params1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_draw: DrawUniform;
@group(0) @binding(1) var t_albedo: texture_2d<f32>;
@group(0) @binding(2) var s_albedo: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world_pos: vec3<f32>,
  @location(1) world_n: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) _tangent: vec4<f32>,
) -> VsOut {
  let wp = u_draw.world * vec4<f32>(pos, 1.0);
  var o: VsOut;
  o.pos = u_draw.view_proj * wp;
  o.world_pos = wp.xyz;
  let wn = (u_draw.world * vec4<f32>(normal, 0.0)).xyz;
  let n_len = length(wn);
  o.world_n = select(vec3<f32>(0.0, 1.0, 0.0), wn / n_len, n_len > 1e-6);
  o.uv = uv;
  return o;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let tex = textureSample(t_albedo, s_albedo, in.uv);
  let base = tex.rgb * u_draw.base_color.rgb;
  let alpha = clamp(tex.a * u_draw.base_color.a, 0.0, 1.0);
  let n = normalize(in.world_n);
  let v = normalize(u_draw.camera_pos_metallic.xyz - in.world_pos);
  let l_raw = u_draw.light_dir_exposure.xyz;
  let l_len = length(l_raw);
  let l = select(vec3<f32>(0.0, 1.0, 0.0), -l_raw / l_len, l_len > 1e-5);
  let ndotl = max(dot(n, l), 0.0);
  let roughness = clamp(u_draw.emissive_rough_metal.w, 0.045, 1.0);
  let metallic = clamp(u_draw.camera_pos_metallic.w, 0.0, 1.0);
  let h = normalize(l + v);
  let ndoth = max(dot(n, h), 0.0);
  let spec_pow = mix(96.0, 8.0, roughness);
  let f0 = mix(vec3<f32>(0.04), base, metallic);
  let spec = f0 * pow(ndoth, spec_pow) * (0.25 + 0.75 * (1.0 - roughness));
  let diff = base * (1.0 - metallic) * (1.0 / PI);
  let radiance = u_draw.light_color_intensity.rgb * u_draw.light_color_intensity.w;
  let direct = (diff + spec) * radiance * ndotl;
  let ambient = base * u_draw.ambient_color_intensity.rgb * u_draw.ambient_color_intensity.w;
  var hdr = (ambient + direct + u_draw.emissive_rough_metal.rgb) * u_draw.light_dir_exposure.w;
  let fog_mode = u32(max(u_draw.fog_params0.w, 0.0) + 0.5);
  if (fog_mode > 0u) {
    let dist = length(in.world_pos - u_draw.camera_pos_metallic.xyz);
    let f_near = u_draw.fog_params1.z;
    let f_far = max(u_draw.fog_params1.w, f_near + 0.001);
    let fog_f = clamp((dist - f_near) / (f_far - f_near), 0.0, 1.0);
    hdr = mix(hdr, u_draw.fog_params0.rgb * u_draw.light_dir_exposure.w, fog_f);
  }
  return vec4<f32>(hdr, alpha);
}
`;

export const WGSL_KERNEL_SKYBOX = /* wgsl */ `
struct SkyUniform {
  inv_view_proj: mat4x4<f32>,
  zenith_intensity: vec4<f32>,
  horizon_pad: vec4<f32>,
  ground_pad: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_sky: SkyUniform;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) ndc: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.ndc = p[idx];
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let near_w = u_sky.inv_view_proj * vec4<f32>(in.ndc, 0.0, 1.0);
  let far_w = u_sky.inv_view_proj * vec4<f32>(in.ndc, 1.0, 1.0);
  let dir = normalize(far_w.xyz / max(abs(far_w.w), 1e-5) - near_w.xyz / max(abs(near_w.w), 1e-5));
  let y = dir.y;
  var col = u_sky.horizon_pad.rgb;
  if (y >= 0.0) {
    col = mix(u_sky.horizon_pad.rgb, u_sky.zenith_intensity.rgb, pow(clamp(y, 0.0, 1.0), 0.65));
  } else {
    col = mix(u_sky.horizon_pad.rgb, u_sky.ground_pad.rgb, pow(clamp(-y, 0.0, 1.0), 0.5));
  }
  return vec4<f32>(col * u_sky.zenith_intensity.w, 1.0);
}
`;

export const WGSL_KERNEL_BLOOM_EXTRACT_H = /* wgsl */ `
struct BloomUniform {
  params: vec4<f32>,
};
@group(0) @binding(0) var t_src: texture_2d<f32>;
@group(0) @binding(1) var s_src: sampler;
@group(0) @binding(2) var<uniform> u_bloom: BloomUniform;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
fn bright_pass(c: vec3<f32>, thresh: f32) -> vec3<f32> {
  if (thresh < 0.0) { return max(c, vec3<f32>(0.0)); }
  let lum = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  let contrib = max(lum - thresh, 0.0) / max(lum, 1e-4);
  return max(c * contrib, vec3<f32>(0.0));
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let dx = vec2<f32>(u_bloom.params.z * 1.5, 0.0);
  let t = u_bloom.params.x;
  var acc = bright_pass(textureSample(t_src, s_src, in.uv).rgb, t) * 0.227027;
  acc = acc + bright_pass(textureSample(t_src, s_src, in.uv + dx).rgb, t) * 0.1945946;
  acc = acc + bright_pass(textureSample(t_src, s_src, in.uv - dx).rgb, t) * 0.1945946;
  acc = acc + bright_pass(textureSample(t_src, s_src, in.uv + dx * 2.0).rgb, t) * 0.1216216;
  acc = acc + bright_pass(textureSample(t_src, s_src, in.uv - dx * 2.0).rgb, t) * 0.1216216;
  acc = acc + bright_pass(textureSample(t_src, s_src, in.uv + dx * 3.0).rgb, t) * 0.0702703;
  acc = acc + bright_pass(textureSample(t_src, s_src, in.uv - dx * 3.0).rgb, t) * 0.0702703;
  return vec4<f32>(acc, 1.0);
}
`;

export const WGSL_KERNEL_BLOOM_BLUR_V = /* wgsl */ `
struct BloomUniform {
  params: vec4<f32>,
};
@group(0) @binding(0) var t_src: texture_2d<f32>;
@group(0) @binding(1) var s_src: sampler;
@group(0) @binding(2) var<uniform> u_bloom: BloomUniform;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let dy = vec2<f32>(0.0, u_bloom.params.w * 1.5);
  var acc = textureSample(t_src, s_src, in.uv).rgb * 0.227027;
  acc = acc + textureSample(t_src, s_src, in.uv + dy).rgb * 0.1945946;
  acc = acc + textureSample(t_src, s_src, in.uv - dy).rgb * 0.1945946;
  acc = acc + textureSample(t_src, s_src, in.uv + dy * 2.0).rgb * 0.1216216;
  acc = acc + textureSample(t_src, s_src, in.uv - dy * 2.0).rgb * 0.1216216;
  acc = acc + textureSample(t_src, s_src, in.uv + dy * 3.0).rgb * 0.0702703;
  acc = acc + textureSample(t_src, s_src, in.uv - dy * 3.0).rgb * 0.0702703;
  return vec4<f32>(acc, 1.0);
}
`;

export const WGSL_KERNEL_BLOOM_COMPOSITE = /* wgsl */ `
struct BloomUniform {
  params: vec4<f32>,
};
@group(0) @binding(0) var t_bloom: texture_2d<f32>;
@group(0) @binding(1) var s_bloom: sampler;
@group(0) @binding(2) var<uniform> u_bloom: BloomUniform;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let b = textureSample(t_bloom, s_bloom, in.uv).rgb * u_bloom.params.y;
  return vec4<f32>(b, 1.0);
}
`;

/** Multi-curve Output Transform supporting ACES, AgX, Reinhard, Neutral, and None + optional Vignette. */
export const WGSL_KERNEL_TONEMAP_OUTPUT = /* wgsl */ `
struct OutputUniform {
  // x=mode (0=aces, 1=agx, 2=reinhard, 3=neutral, 4=none), y=vignette_intensity, z=vignette_smooth, w=post_exposure
  params: vec4<f32>,
};
@group(0) @binding(0) var t_hdr: texture_2d<f32>;
@group(0) @binding(1) var s_hdr: sampler;
@group(0) @binding(2) var<uniform> u_out: OutputUniform;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
fn tm_aces(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}
fn tm_agx(x: vec3<f32>) -> vec3<f32> {
  let m_in = mat3x3<f32>(
    vec3<f32>(0.84247906, 0.04232824, 0.04237565),
    vec3<f32>(0.07843360, 0.87846864, 0.07843360),
    vec3<f32>(0.07922375, 0.07916613, 0.87914297),
  );
  let m_out = mat3x3<f32>(
    vec3<f32>( 1.19687900, -0.05289685, -0.05297163),
    vec3<f32>(-0.09802088,  1.15190313, -0.09804345),
    vec3<f32>(-0.09902974, -0.09896118,  1.15107367),
  );
  var v = max(m_in * x, vec3<f32>(1e-10));
  v = clamp((log2(v) + 12.47393) / 16.5, vec3<f32>(0.0), vec3<f32>(1.0));
  let v2 = v * v;
  let v4 = v2 * v2;
  let poly = 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v - 0.00232;
  return clamp(m_out * poly, vec3<f32>(0.0), vec3<f32>(1.0));
}
fn tm_reinhard(x: vec3<f32>) -> vec3<f32> {
  return x / (vec3<f32>(1.0) + x);
}
fn tm_neutral(x: vec3<f32>) -> vec3<f32> {
  let start_c = 0.8 - 0.04;
  let peak = max(x.r, max(x.g, x.b));
  if (peak < start_c) { return x; }
  let d = 1.0 - start_c;
  let new_peak = 1.0 - d * d / (peak + d - start_c);
  var c = x * (new_peak / max(peak, 1e-5));
  let g = 1.0 - 1.0 / (0.15 * (peak - new_peak) + 1.0);
  return mix(c, vec3<f32>(new_peak), g);
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let raw = max(textureSample(t_hdr, s_hdr, in.uv).rgb, vec3<f32>(0.0)) * u_out.params.w;
  let mode = u32(u_out.params.x + 0.5);
  var ldr = raw;
  if (mode == 0u) {
    ldr = tm_aces(raw);
  } else if (mode == 1u) {
    ldr = tm_agx(raw);
  } else if (mode == 2u) {
    ldr = tm_reinhard(raw);
  } else if (mode == 3u) {
    ldr = tm_neutral(raw);
  } else {
    ldr = clamp(raw, vec3<f32>(0.0), vec3<f32>(1.0));
  }
  if (u_out.params.y > 0.001) {
    let centered = in.uv * 2.0 - vec2<f32>(1.0);
    let dist = length(centered);
    let vig = 1.0 - smoothstep(1.0 - u_out.params.z, 1.414, dist) * clamp(u_out.params.y, 0.0, 1.0);
    ldr = ldr * vig;
  }
  let encoded = select(pow(clamp(ldr, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)), clamp(ldr, vec3<f32>(0.0), vec3<f32>(1.0)), mode == 1u);
  return vec4<f32>(encoded, 1.0);
}
`;

export const WGSL_KERNEL_FXAA = /* wgsl */ `
struct FxaaUniform {
  inv_size: vec4<f32>,
};
@group(0) @binding(0) var t_ldr: texture_2d<f32>;
@group(0) @binding(1) var s_ldr: sampler;
@group(0) @binding(2) var<uniform> u_fxaa: FxaaUniform;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
fn luma(rgb: vec3<f32>) -> f32 {
  return dot(rgb, vec3<f32>(0.299, 0.587, 0.114));
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let px = u_fxaa.inv_size.xy;
  let rgb_m = textureSample(t_ldr, s_ldr, in.uv).rgb;
  let rgb_nw = textureSample(t_ldr, s_ldr, in.uv + vec2<f32>(-px.x, -px.y)).rgb;
  let rgb_ne = textureSample(t_ldr, s_ldr, in.uv + vec2<f32>(px.x, -px.y)).rgb;
  let rgb_sw = textureSample(t_ldr, s_ldr, in.uv + vec2<f32>(-px.x, px.y)).rgb;
  let rgb_se = textureSample(t_ldr, s_ldr, in.uv + vec2<f32>(px.x, px.y)).rgb;
  let l_m = luma(rgb_m);
  let l_nw = luma(rgb_nw);
  let l_ne = luma(rgb_ne);
  let l_sw = luma(rgb_sw);
  let l_se = luma(rgb_se);
  let l_min = min(l_m, min(min(l_nw, l_ne), min(l_sw, l_se)));
  let l_max = max(l_m, max(max(l_nw, l_ne), max(l_sw, l_se)));
  if (l_max - l_min < max(0.0312, l_max * 0.125)) {
    return vec4<f32>(rgb_m, 1.0);
  }
  var dir = vec2<f32>(-((l_nw + l_ne) - (l_sw + l_se)), (l_nw + l_sw) - (l_ne + l_se));
  let dir_reduce = max((l_nw + l_ne + l_sw + l_se) * 0.03125, 0.0078125);
  let rcp_dir_min = 1.0 / (min(abs(dir.x), abs(dir.y)) + dir_reduce);
  dir = clamp(dir * rcp_dir_min, vec2<f32>(-8.0), vec2<f32>(8.0)) * px;
  let rgb_a = 0.5 * (
    textureSample(t_ldr, s_ldr, in.uv + dir * (1.0 / 3.0 - 0.5)).rgb +
    textureSample(t_ldr, s_ldr, in.uv + dir * (2.0 / 3.0 - 0.5)).rgb
  );
  let rgb_b = rgb_a * 0.5 + 0.25 * (
    textureSample(t_ldr, s_ldr, in.uv + dir * -0.5).rgb +
    textureSample(t_ldr, s_ldr, in.uv + dir * 0.5).rgb
  );
  let l_b = luma(rgb_b);
  let out_rgb = select(rgb_b, rgb_a, l_b < l_min || l_b > l_max);
  return vec4<f32>(out_rgb, 1.0);
}
`;

export const WGSL_KERNEL_DEBUG_LINES = /* wgsl */ `
struct DebugViewUniform {
  view_proj: mat4x4<f32>,
  exposure: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_view: DebugViewUniform;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) color: vec4<f32>) -> VsOut {
  var o: VsOut;
  o.pos = u_view.view_proj * vec4<f32>(pos, 1.0);
  o.color = color;
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color.rgb * u_view.exposure.x, in.color.a);
}
`;

export const WGSL_KERNEL_UI_OVERLAY = /* wgsl */ `
@group(0) @binding(0) var t_ui: texture_2d<f32>;
@group(0) @binding(1) var s_ui: sampler;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(t_ui, s_ui, in.uv);
}
`;
