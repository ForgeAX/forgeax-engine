// High-level 3-pass 4-BGL desktop 3D scene renderer built on top of NativeRenderKernel.
// Bridges live ECS/scene entity transforms, meshes, materials, textures, cameras, and
// directional/point/spot lights into incremental FXK1 SceneDeltas and async pipelined frames
// executing on the dedicated Rust OS render thread (wgpu 30 Metal / DX12 / Vulkan).

import {
  DRAW_FLAG_INSTANCING,
  DRAW_FLAG_SHADOW_CASTER_ONLY,
  type FrameRecorder,
  PHYS_BEGIN_RENDER_PASS,
  SORT_BACK_TO_FRONT,
  SORT_MATERIAL_PSO,
} from '../command-stream.js';
import type { KernelCullParams } from '../contract.js';
import {
  TEXTURE_FORMAT_DEPTH32_FLOAT,
  TEXTURE_FORMAT_RGBA8_UNORM,
  TEXTURE_FORMAT_RGBA16_FLOAT,
} from '../dynamic-texture.js';
import { type KernelError, ok, type Result } from '../errors.js';
import {
  type BindingSetId,
  type BufferId,
  type CullId,
  type DynamicTextureId,
  type LightId,
  type MaterialId,
  type MeshId,
  type RenderObjectId,
  type SamplerId,
  type ShaderProgramId,
  TEMP_TEXTURE_TAG_BIT,
  type TextureId,
  type TextureOrTempId,
} from '../handles.js';
import {
  LAYOUT_FAMILY_SCENE_4BGL,
  PASS_TAG_FORWARD_OPAQUE,
  PASS_TAG_FORWARD_TRANSPARENT,
  PASS_TAG_SHADOW_DEPTH,
  RENDER_STATE_ALPHA_BLEND,
  RENDER_STATE_CULL_BACK,
  RENDER_STATE_CULL_NONE,
  RENDER_STATE_DEPTH_LESS_EQUAL,
  RENDER_STATE_DEPTH_WRITE,
  SURFACE_SWAPCHAIN_HANDLE,
} from '../pso-key.js';
import {
  DELTA_FLAG_BASELINE,
  LIGHT_KIND_DIRECTIONAL,
  LIGHT_KIND_POINT,
  LIGHT_KIND_SPOT,
  type LightInput,
  OBJ_FLAG_CAST_SHADOW,
  OBJ_FLAG_FRUSTUM_CULLED,
  OBJ_FLAG_MASKED,
  OBJ_FLAG_RECEIVE_SHADOW,
  OBJ_FLAG_TRANSPARENT,
  OBJ_FLAG_VISIBLE,
  type SceneDeltaWriter,
  type UpsertObjectInput,
} from '../scene-delta.js';
import { type DesktopFeatureFrameContext, DesktopFeatureHost } from './feature-host.js';
import {
  type CreateNativeRenderKernelOptions,
  createNativeRenderKernel,
  type NativeFrameReceipt,
  type NativeReadbackTexture,
  type NativeRenderKernel,
  type NativeThreadStats,
  type NativeWindowEvent,
  type NativeWindowFacts,
  type NativeWindowOptions,
} from './index.js';
import {
  desktopMat4Invert,
  desktopMat4LookAt,
  desktopMat4Multiply,
  desktopMat4Ortho,
  desktopMat4Perspective,
  packDesktopMeshVertices,
  packDesktopSkinnedMeshVertices,
} from './math-helpers.js';

export type DesktopResourceKey = string | number;

export interface DesktopSubmeshInput {
  readonly firstIndex?: number | undefined;
  readonly indexCount?: number | undefined;
  readonly baseVertex?: number | undefined;
  readonly firstVertex?: number | undefined;
  readonly vertexCount?: number | undefined;
}

export interface DesktopMeshInput {
  readonly key: DesktopResourceKey;
  /**
   * Packed 12-float interleaved vertices: pos(3) + normal(3) + uv(2) + tangent(4) = 48 bytes/vertex,
   * OR 20-float skinned vertices (with `skinned: true`): pos(3)+normal(3)+uv(2)+tangent(4)+joints(4)+weights(4) = 80 bytes/vertex.
   */
  readonly vertices: Float32Array;
  readonly skinned?: boolean | undefined;
  readonly indices?: Uint16Array | Uint32Array | undefined;
  readonly submeshes?: readonly DesktopSubmeshInput[] | undefined;
  readonly boundsMin?: readonly [number, number, number] | undefined;
  readonly boundsMax?: readonly [number, number, number] | undefined;
  readonly label?: string | undefined;
}

export interface DesktopTextureInput {
  readonly key: DesktopResourceKey;
  readonly width: number;
  readonly height: number;
  readonly rgbaBytes: Uint8Array;
  readonly label?: string | undefined;
}

export interface DesktopCustomShaderOptions {
  readonly vertexEntryPoint?: string | undefined;
  readonly fragmentEntryPoint?: string | undefined;
  readonly skinned?: boolean | undefined;
  readonly blendMode?: 'alpha' | 'premultiplied' | 'additive' | undefined;
  readonly label?: string | undefined;
}

export interface DesktopMaterialInput {
  readonly key: DesktopResourceKey;
  /** Linear RGBA base color factor [r, g, b, a]. */
  readonly baseColor: readonly [number, number, number, number];
  readonly roughness?: number | undefined;
  readonly metallic?: number | undefined;
  readonly emissive?: readonly [number, number, number] | undefined;
  readonly normalScale?: number | undefined;
  readonly occlusionStrength?: number | undefined;
  readonly alphaMode?: 'opaque' | 'mask' | 'blend' | undefined;
  readonly alphaCutoff?: number | undefined;
  readonly queue?: number | undefined;
  readonly transparent?: boolean | undefined;
  readonly doubleSided?: boolean | undefined;
  readonly baseColorTextureKey?: DesktopResourceKey | undefined;
  readonly normalTextureKey?: DesktopResourceKey | undefined;
  readonly metallicRoughnessTextureKey?: DesktopResourceKey | undefined;
  readonly emissiveTextureKey?: DesktopResourceKey | undefined;
  readonly occlusionTextureKey?: DesktopResourceKey | undefined;
  /** Optional custom 4-BGL WGSL shader key registered via `registerCustomShader`. */
  readonly customShaderKey?: DesktopResourceKey | undefined;
  readonly label?: string | undefined;
}

export interface DesktopSkylightInput {
  readonly skyColor: readonly [number, number, number];
  readonly groundColor?: readonly [number, number, number] | undefined;
  readonly intensity?: number | undefined;
}

export interface DesktopFogInput {
  readonly mode: 'none' | 'exp' | 'exp2' | 'linear';
  readonly color: readonly [number, number, number];
  readonly density?: number | undefined;
  readonly heightFalloff?: number | undefined;
  readonly near?: number | undefined;
  readonly far?: number | undefined;
  readonly maxOpacity?: number | undefined;
}

export interface DesktopSkyboxInput {
  readonly zenithColor: readonly [number, number, number];
  readonly horizonColor: readonly [number, number, number];
  readonly groundColor?: readonly [number, number, number] | undefined;
  readonly intensity?: number | undefined;
}

export interface DesktopBloomInput {
  readonly enabled: boolean;
  readonly threshold?: number | undefined;
  readonly intensity?: number | undefined;
}

export interface DesktopCameraInput {
  /** Column-major WebGPU [0, 1] NDC view-projection matrix (16 floats). */
  readonly viewProj: Float32Array;
  readonly position: readonly [number, number, number];
  readonly clearColor?: readonly [number, number, number, number] | undefined;
  readonly exposure?: number | undefined;
  readonly cullMask?: number | undefined;
  readonly bloom?: DesktopBloomInput | undefined;
  readonly fxaa?: boolean | undefined;
}

export interface DesktopLightInput {
  readonly id: number;
  readonly kind: 'directional' | 'point' | 'spot';
  readonly position?: readonly [number, number, number] | undefined;
  readonly direction?: readonly [number, number, number] | undefined;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly range?: number | undefined;
  readonly outerConeCos?: number | undefined;
  readonly castShadow?: boolean | undefined;
  /** Number of directional shadow cascades (1..4; >1 uses a single-pass 2x2 CSM atlas). */
  readonly cascadeCount?: number | undefined;
  readonly shadowDistance?: number | undefined;
  readonly shadowTarget?: readonly [number, number, number] | undefined;
  readonly shadowViewProj?: Float32Array | undefined;
}

export interface DesktopRenderObjectInput {
  readonly entityId: number;
  readonly meshKey: DesktopResourceKey;
  readonly submeshIndex?: number | undefined;
  readonly materialKey: DesktopResourceKey;
  /** Optional skin palette key registered via `setSkinJoints(skinKey, matrices)`. */
  readonly skinKey?: DesktopResourceKey | undefined;
  /** When true on a skinned object, left-multiplies the blended vertex by `worldMatrix`. */
  readonly skinAffinePoint?: boolean | undefined;
  /** Column-major 4x4 world matrix (16 floats). */
  readonly worldMatrix: ArrayLike<number>;
  readonly visible?: boolean | undefined;
  readonly castShadow?: boolean | undefined;
  readonly receiveShadow?: boolean | undefined;
  readonly frustumCulled?: boolean | undefined;
  readonly layerMask?: number | undefined;
  readonly queue?: number | undefined;
  readonly drawParams?:
    | readonly [number, number, number, number, number, number, number, number]
    | undefined;
}

export interface DesktopFrameInput {
  readonly width: number;
  readonly height: number;
  readonly camera: DesktopCameraInput;
  readonly lights: readonly DesktopLightInput[];
  readonly objects: readonly DesktopRenderObjectInput[];
  readonly elapsedSeconds?: number | undefined;
  readonly deltaSeconds?: number | undefined;
  readonly ambientColor?: readonly [number, number, number] | undefined;
  readonly skylight?: DesktopSkylightInput | undefined;
  readonly fog?: DesktopFogInput | undefined;
  readonly skybox?: DesktopSkyboxInput | undefined;
}

/**
 * Incremental frame delta input when the caller (e.g. ForgeAX ECS change-detection queries)
 * already knows exactly which entities spawned, despawned, changed metadata, or moved.
 * Avoids O(N) unchanged-entity scans on the JS main thread while keeping zero static shortcuts.
 */
export interface DesktopIncrementalFrameInput {
  readonly width: number;
  readonly height: number;
  readonly camera: DesktopCameraInput;
  readonly lights: readonly DesktopLightInput[];
  /** Newly spawned or metadata-changed entities (mesh/material/visibility/flags). */
  readonly upserts?: readonly DesktopRenderObjectInput[] | undefined;
  /** Entity IDs despawned or removed since the previous frame. */
  readonly removedEntityIds?: readonly number[] | undefined;
  /** Entity IDs whose 4x4 world matrix changed (`dirtyTransformCount` entries). */
  readonly dirtyTransformEntityIds?: ArrayLike<number> | undefined;
  /** Packed column-major 4x4 matrices (`dirtyTransformCount * 16` floats). */
  readonly dirtyTransformMatrices?: Float32Array | undefined;
  readonly dirtyTransformCount?: number | undefined;
  readonly elapsedSeconds?: number | undefined;
  readonly deltaSeconds?: number | undefined;
  readonly ambientColor?: readonly [number, number, number] | undefined;
  readonly skylight?: DesktopSkylightInput | undefined;
  readonly fog?: DesktopFogInput | undefined;
  readonly skybox?: DesktopSkyboxInput | undefined;
}

export interface DesktopNativeSceneRendererOptions {
  readonly maxInFlight?: number | undefined;
  readonly window?: NativeWindowOptions | undefined;
  readonly addonPath?: string | undefined;
  readonly shadowMapSize?: number | undefined;
  readonly defaultClearColor?: readonly [number, number, number, number] | undefined;
  readonly defaultAmbientColor?: readonly [number, number, number] | undefined;
  readonly headless?: boolean | undefined;
}

export interface DesktopWitnessFrameResult {
  readonly receipt: NativeFrameReceipt;
  readonly image: NativeReadbackTexture;
}

export interface DesktopSceneStats {
  readonly thread: NativeThreadStats;
  readonly trackedObjects: number;
  readonly cachedMeshes: number;
  readonly cachedMaterials: number;
  readonly cachedTextures: number;
  readonly sceneRevision: number;
  readonly framesSubmitted: number;
  readonly lastDirtyTransformCount: number;
  readonly lastUpsertCount: number;
  readonly lastRemoveCount: number;
}

const DESKTOP_VERTEX_STRIDE_FLOATS = 12;
const DESKTOP_SKINNED_VERTEX_STRIDE_FLOATS = 20;

const DESKTOP_VERTEX_LAYOUT: readonly GPUVertexBufferLayout[] = [
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

const DESKTOP_SKINNED_VERTEX_LAYOUT: readonly GPUVertexBufferLayout[] = [
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

const DESKTOP_DEBUG_LINE_VERTEX_STRIDE_FLOATS = 7; // pos3 + color4
const DESKTOP_DEBUG_LINE_VERTEX_LAYOUT: readonly GPUVertexBufferLayout[] = [
  {
    arrayStride: 28,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x4' },
    ],
  },
];
const DEBUG_LINES_OBJECT_ID = 0x3fff_fffe as RenderObjectId;
const GPU_BUFFER_USAGE_UNIFORM = 0x40;
const IDENTITY_MAT4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// Material UBO: 64 bytes (4 x vec4<f32>)
//   [0..4]:   albedo (r, g, b, a)
//   [4..8]:   roughness, metallic, alphaCutoff, flags (bit0=transparent, bit1=alphaMask, bit2=hasNormalMap)
//   [8..12]:  emissive (r, g, b), occlusionStrength
//   [12..16]: normalScale, pad, pad, pad
const MATERIAL_UBO_FLOATS = 16;

// View UBO: 544 bytes (5 x mat4x4 + 4 x vec4 atlas rects + 10 x vec4 meta/lighting/fog)
// Fits cleanly within VIEW_UNIFORM_SLOT_STRIDE = 1536 bytes.
const VIEW_UBO_BYTES = 544;
const SHADOW_VIEW_UBO_BYTES = 128; // view_proj + cascade_vp[0]

const WGSL_SHADOW_DEPTH = /* wgsl */ `
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

const WGSL_SHADOW_SKINNED = /* wgsl */ `
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

const WGSL_DESKTOP_PBR_SHADOW = /* wgsl */ `
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

  // Analytic aerial fog (fog_params0.w: 0=none, 1=exp, 2=exp2, 3=linear)
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

const WGSL_DESKTOP_PBR_SKINNED = WGSL_DESKTOP_PBR_SHADOW.replace(
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

const WGSL_TONEMAP_ACES = /* wgsl */ `
@group(0) @binding(0) var t_hdr: texture_2d<f32>;
@group(0) @binding(1) var s_hdr: sampler;
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
fn aces(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let hdr = max(textureSample(t_hdr, s_hdr, in.uv).rgb, vec3<f32>(0.0));
  let mapped = pow(aces(hdr), vec3<f32>(1.0 / 2.2));
  return vec4<f32>(mapped, 1.0);
}
`;

const WGSL_UI_OVERLAY = /* wgsl */ `
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

const WGSL_SKYBOX_DOME = /* wgsl */ `
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

const WGSL_BLOOM_EXTRACT_H = /* wgsl */ `
struct BloomUniform {
  params: vec4<f32>, // x=threshold, y=intensity, z=inv_w, w=inv_h
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

const WGSL_BLOOM_BLUR_V = /* wgsl */ `
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

const WGSL_BLOOM_COMPOSITE = /* wgsl */ `
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

const WGSL_FXAA = /* wgsl */ `
struct FxaaUniform {
  inv_size: vec4<f32>, // x=1/w, y=1/h
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

const WGSL_DEBUG_LINES = /* wgsl */ `
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
@group(0) @binding(0) var<uniform> u_view: ViewUniform;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) color: vec4<f32>,
) -> VsOut {
  var o: VsOut;
  o.pos = u_view.view_proj * vec4<f32>(pos, 1.0);
  o.color = color;
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color.rgb * u_view.camera_pos_exposure.w, in.color.a);
}
`;

export {
  desktopMat4Invert,
  desktopMat4LookAt,
  desktopMat4Multiply,
  desktopMat4Ortho,
  desktopMat4Perspective,
  packDesktopMeshVertices,
  packDesktopSkinnedMeshVertices,
};

interface CachedMeshRecord {
  id: MeshId;
  readonly input: DesktopMeshInput;
  readonly skinned: boolean;
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
}

interface BuiltinDesktopResources {
  readonly shadowShader: ShaderProgramId;
  readonly skinnedShadowShader: ShaderProgramId;
  readonly litShader: ShaderProgramId;
  readonly skinnedLitShader: ShaderProgramId;
  readonly tonemapSurfaceShader: ShaderProgramId;
  readonly tonemapWitnessShader: ShaderProgramId;
  readonly uiOverlaySurfaceShader: ShaderProgramId;
  readonly uiOverlayWitnessShader: ShaderProgramId;
  readonly skyboxShader: ShaderProgramId;
  readonly bloomExtractHShader: ShaderProgramId;
  readonly bloomBlurVShader: ShaderProgramId;
  readonly bloomCompositeShader: ShaderProgramId;
  readonly fxaaSurfaceShader: ShaderProgramId;
  readonly fxaaWitnessShader: ShaderProgramId;
  readonly debugLineMaterialId: MaterialId;
  readonly skyboxUbo: BufferId;
  readonly bloomUbo: BufferId;
  readonly fxaaUbo: BufferId;
  readonly linearSampler: SamplerId;
  readonly postSampler: SamplerId;
}

function initBuiltinSceneShaders(kernel: NativeRenderKernel): Result<
  {
    readonly shadowShader: ShaderProgramId;
    readonly skinnedShadowShader: ShaderProgramId;
    readonly litShader: ShaderProgramId;
    readonly skinnedLitShader: ShaderProgramId;
  },
  KernelError
> {
  const shadowShader = kernel.assets.registerShaderProgram({
    code: WGSL_SHADOW_DEPTH,
    vertexEntryPoint: 'vs_shadow',
    layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
    vertexBufferLayouts: DESKTOP_VERTEX_LAYOUT,
    colorFormats: [],
    depthFormat: 'depth32float',
    label: 'desktop-shadow-depth-4bgl',
  });
  if (!shadowShader.ok) return shadowShader;

  const skinnedShadowShader = kernel.assets.registerShaderProgram({
    code: WGSL_SHADOW_SKINNED,
    vertexEntryPoint: 'vs_shadow',
    layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
    vertexBufferLayouts: DESKTOP_SKINNED_VERTEX_LAYOUT,
    colorFormats: [],
    depthFormat: 'depth32float',
    label: 'desktop-skinned-shadow-depth-4bgl',
  });
  if (!skinnedShadowShader.ok) return skinnedShadowShader;

  const litShader = kernel.assets.registerShaderProgram({
    code: WGSL_DESKTOP_PBR_SHADOW,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
    vertexBufferLayouts: DESKTOP_VERTEX_LAYOUT,
    colorFormats: ['rgba16float'],
    depthFormat: 'depth32float',
    label: 'desktop-pbr-shadow-4bgl',
  });
  if (!litShader.ok) return litShader;

  const skinnedLitShader = kernel.assets.registerShaderProgram({
    code: WGSL_DESKTOP_PBR_SKINNED,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
    vertexBufferLayouts: DESKTOP_SKINNED_VERTEX_LAYOUT,
    colorFormats: ['rgba16float'],
    depthFormat: 'depth32float',
    label: 'desktop-skinned-pbr-shadow-4bgl',
  });
  if (!skinnedLitShader.ok) return skinnedLitShader;

  return ok({
    shadowShader: shadowShader.value,
    skinnedShadowShader: skinnedShadowShader.value,
    litShader: litShader.value,
    skinnedLitShader: skinnedLitShader.value,
  });
}

function initBuiltinPostShaders(
  kernel: NativeRenderKernel,
  headless: boolean,
  surfaceFormat: GPUTextureFormat,
): Result<
  {
    readonly tonemapSurfaceShader: ShaderProgramId;
    readonly tonemapWitnessShader: ShaderProgramId;
    readonly uiOverlaySurfaceShader: ShaderProgramId;
    readonly uiOverlayWitnessShader: ShaderProgramId;
    readonly skyboxShader: ShaderProgramId;
    readonly bloomExtractHShader: ShaderProgramId;
    readonly bloomBlurVShader: ShaderProgramId;
    readonly bloomCompositeShader: ShaderProgramId;
    readonly fxaaSurfaceShader: ShaderProgramId;
    readonly fxaaWitnessShader: ShaderProgramId;
  },
  KernelError
> {
  const tonemapWitnessShader = kernel.assets.registerShaderProgram({
    code: WGSL_TONEMAP_ACES,
    layoutFamilyId: 0,
    colorFormats: ['rgba8unorm'],
    label: 'desktop-tonemap-witness',
  });
  if (!tonemapWitnessShader.ok) return tonemapWitnessShader;

  const tonemapSurfaceShader = headless
    ? tonemapWitnessShader
    : kernel.assets.registerShaderProgram({
        code: WGSL_TONEMAP_ACES,
        layoutFamilyId: 0,
        colorFormats: [surfaceFormat],
        label: 'desktop-tonemap-surface',
      });
  if (!tonemapSurfaceShader.ok) return tonemapSurfaceShader;

  const uiOverlayWitnessShader = kernel.assets.registerShaderProgram({
    code: WGSL_UI_OVERLAY,
    layoutFamilyId: 0,
    colorFormats: ['rgba8unorm'],
    blendMode: 'alpha',
    label: 'desktop-ui-overlay-witness',
  });
  if (!uiOverlayWitnessShader.ok) return uiOverlayWitnessShader;

  const uiOverlaySurfaceShader = headless
    ? uiOverlayWitnessShader
    : kernel.assets.registerShaderProgram({
        code: WGSL_UI_OVERLAY,
        layoutFamilyId: 0,
        colorFormats: [surfaceFormat],
        blendMode: 'alpha',
        label: 'desktop-ui-overlay-surface',
      });
  if (!uiOverlaySurfaceShader.ok) return uiOverlaySurfaceShader;

  const skyboxShader = kernel.assets.registerShaderProgram({
    code: WGSL_SKYBOX_DOME,
    layoutFamilyId: 0,
    colorFormats: ['rgba16float'],
    label: 'desktop-skybox-dome',
  });
  if (!skyboxShader.ok) return skyboxShader;

  const bloomExtractHShader = kernel.assets.registerShaderProgram({
    code: WGSL_BLOOM_EXTRACT_H,
    layoutFamilyId: 0,
    colorFormats: ['rgba16float'],
    label: 'desktop-bloom-extract-h',
  });
  if (!bloomExtractHShader.ok) return bloomExtractHShader;

  const bloomBlurVShader = kernel.assets.registerShaderProgram({
    code: WGSL_BLOOM_BLUR_V,
    layoutFamilyId: 0,
    colorFormats: ['rgba16float'],
    label: 'desktop-bloom-blur-v',
  });
  if (!bloomBlurVShader.ok) return bloomBlurVShader;

  const bloomCompositeShader = kernel.assets.registerShaderProgram({
    code: WGSL_BLOOM_COMPOSITE,
    layoutFamilyId: 0,
    colorFormats: ['rgba16float'],
    blendMode: 'additive',
    label: 'desktop-bloom-composite',
  });
  if (!bloomCompositeShader.ok) return bloomCompositeShader;

  const fxaaWitnessShader = kernel.assets.registerShaderProgram({
    code: WGSL_FXAA,
    layoutFamilyId: 0,
    colorFormats: ['rgba8unorm'],
    label: 'desktop-fxaa-witness',
  });
  if (!fxaaWitnessShader.ok) return fxaaWitnessShader;

  const fxaaSurfaceShader = headless
    ? fxaaWitnessShader
    : kernel.assets.registerShaderProgram({
        code: WGSL_FXAA,
        layoutFamilyId: 0,
        colorFormats: [surfaceFormat],
        label: 'desktop-fxaa-surface',
      });
  if (!fxaaSurfaceShader.ok) return fxaaSurfaceShader;

  return ok({
    tonemapSurfaceShader: tonemapSurfaceShader.value,
    tonemapWitnessShader: tonemapWitnessShader.value,
    uiOverlaySurfaceShader: uiOverlaySurfaceShader.value,
    uiOverlayWitnessShader: uiOverlayWitnessShader.value,
    skyboxShader: skyboxShader.value,
    bloomExtractHShader: bloomExtractHShader.value,
    bloomBlurVShader: bloomBlurVShader.value,
    bloomCompositeShader: bloomCompositeShader.value,
    fxaaSurfaceShader: fxaaSurfaceShader.value,
    fxaaWitnessShader: fxaaWitnessShader.value,
  });
}

function initBuiltinDebugAndUniforms(kernel: NativeRenderKernel): Result<
  {
    readonly debugLineMaterialId: MaterialId;
    readonly skyboxUbo: BufferId;
    readonly bloomUbo: BufferId;
    readonly fxaaUbo: BufferId;
    readonly linearSampler: SamplerId;
    readonly postSampler: SamplerId;
  },
  KernelError
> {
  const linearSampler = kernel.assets.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  if (!linearSampler.ok) return linearSampler;

  const postSampler = kernel.assets.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });
  if (!postSampler.ok) return postSampler;

  const debugLineShader = kernel.assets.registerShaderProgram({
    code: WGSL_DEBUG_LINES,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
    vertexBufferLayouts: DESKTOP_DEBUG_LINE_VERTEX_LAYOUT,
    colorFormats: ['rgba16float'],
    depthFormat: 'depth32float',
    primitiveTopology: 'line-list',
    label: 'desktop-debug-lines',
  });
  if (!debugLineShader.ok) return debugLineShader;

  const debugLineMaterial = kernel.assets.createMaterial(
    {
      shaderProgramId: debugLineShader.value,
      layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
      renderStateBits: RENDER_STATE_DEPTH_LESS_EQUAL | RENDER_STATE_CULL_NONE,
      queue: 2495,
      label: 'desktop-debug-lines-mat',
    },
    new Uint8Array(64),
  );
  if (!debugLineMaterial.ok) return debugLineMaterial;

  const skyboxUbo = kernel.assets.createBuffer({
    size: 112,
    usage: GPU_BUFFER_USAGE_UNIFORM,
    label: 'desktop-skybox-ubo',
  });
  if (!skyboxUbo.ok) return skyboxUbo;

  const bloomUbo = kernel.assets.createBuffer({
    size: 16,
    usage: GPU_BUFFER_USAGE_UNIFORM,
    label: 'desktop-bloom-ubo',
  });
  if (!bloomUbo.ok) return bloomUbo;

  const fxaaUbo = kernel.assets.createBuffer({
    size: 16,
    usage: GPU_BUFFER_USAGE_UNIFORM,
    label: 'desktop-fxaa-ubo',
  });
  if (!fxaaUbo.ok) return fxaaUbo;

  return ok({
    debugLineMaterialId: debugLineMaterial.value,
    skyboxUbo: skyboxUbo.value,
    bloomUbo: bloomUbo.value,
    fxaaUbo: fxaaUbo.value,
    linearSampler: linearSampler.value,
    postSampler: postSampler.value,
  });
}

function initBuiltinDesktopResources(
  kernel: NativeRenderKernel,
  headless: boolean,
  surfaceFormat: GPUTextureFormat,
): Result<BuiltinDesktopResources, KernelError> {
  const sceneShaders = initBuiltinSceneShaders(kernel);
  if (!sceneShaders.ok) return sceneShaders;

  const postShaders = initBuiltinPostShaders(kernel, headless, surfaceFormat);
  if (!postShaders.ok) return postShaders;

  const debugAndUniforms = initBuiltinDebugAndUniforms(kernel);
  if (!debugAndUniforms.ok) return debugAndUniforms;

  return ok({
    ...sceneShaders.value,
    ...postShaders.value,
    ...debugAndUniforms.value,
  });
}

interface CachedMaterialRecord {
  id: MaterialId;
  skinnedId?: MaterialId | undefined;
  input: DesktopMaterialInput;
  readonly queue: number;
  readonly transparent: boolean;
  readonly alphaMask: boolean;
  readonly params: Float32Array;
}

interface CachedCustomShaderRecord {
  shaderId: ShaderProgramId;
  wgslCode: string;
  options: DesktopCustomShaderOptions;
}

interface TrackedObjectRecord {
  readonly objectId: RenderObjectId;
  meshId: MeshId;
  meshKey: DesktopResourceKey;
  submeshIndex: number;
  materialId: MaterialId;
  materialKey: DesktopResourceKey;
  skinSlot: number;
  layerMask: number;
  objFlags: number;
  queue: number;
  seenFrame: number;
  readonly world: Float32Array;
  hasDrawParams: boolean;
  readonly drawParams: Float32Array;
}

function computeBoundsFromPackedVertices(
  vertices: Float32Array,
  strideFloats = DESKTOP_VERTEX_STRIDE_FLOATS,
): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  const count = Math.floor(vertices.length / strideFloats);
  if (count === 0) {
    return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const x = vertices[i * strideFloats + 0] as number;
    const y = vertices[i * strideFloats + 1] as number;
    const z = vertices[i * strideFloats + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function computeMaterialRenderStateBits(
  transparent: boolean,
  doubleSided: boolean | undefined,
): number {
  const cullBit = doubleSided ? RENDER_STATE_CULL_NONE : RENDER_STATE_CULL_BACK;
  return transparent
    ? RENDER_STATE_DEPTH_LESS_EQUAL | RENDER_STATE_ALPHA_BLEND | cullBit
    : RENDER_STATE_DEPTH_WRITE | RENDER_STATE_DEPTH_LESS_EQUAL | cullBit;
}

function computeObjectFlags(
  obj: DesktopRenderObjectInput,
  isTransparent: boolean,
  alphaMask: boolean,
): number {
  return (
    (obj.visible !== false ? OBJ_FLAG_VISIBLE : 0) |
    (obj.castShadow !== false && !isTransparent ? OBJ_FLAG_CAST_SHADOW : 0) |
    (obj.receiveShadow !== false ? OBJ_FLAG_RECEIVE_SHADOW : 0) |
    (obj.frustumCulled !== false ? OBJ_FLAG_FRUSTUM_CULLED : 0) |
    (isTransparent ? OBJ_FLAG_TRANSPARENT : 0) |
    (alphaMask ? OBJ_FLAG_MASKED : 0)
  );
}

function hasWorldMatrixChanged(prev: Float32Array, next: ArrayLike<number>): boolean {
  for (let k = 0; k < 16; k++) {
    if (prev[k] !== next[k]) return true;
  }
  return false;
}

function readNextDrawParam(obj: DesktopRenderObjectInput, affineFlag: number, k: number): number {
  if (k === 6 && affineFlag !== 0) return 1;
  return obj.drawParams !== undefined ? (obj.drawParams[k] as number) : 0;
}

function lightKindCode(kind: DesktopLightInput['kind']): 0 | 1 | 2 {
  if (kind === 'directional') return LIGHT_KIND_DIRECTIONAL;
  if (kind === 'point') return LIGHT_KIND_POINT;
  return LIGHT_KIND_SPOT;
}

function getCascadeSplitFractions(cascadeCount: number): readonly number[] {
  if (cascadeCount === 1) return [1.0];
  if (cascadeCount === 2) return [0.32, 1.0];
  if (cascadeCount === 3) return [0.16, 0.44, 1.0];
  return [0.1, 0.28, 0.58, 1.0];
}

function normalizeLightInput(l: DesktopLightInput): {
  readonly kindCode: 0 | 1 | 2;
  readonly pos: readonly [number, number, number];
  readonly dir: readonly [number, number, number];
  readonly range: number;
  readonly outerCos: number;
  readonly castShadow: boolean;
  readonly lightCascades: number;
} {
  const kindCode = lightKindCode(l.kind);
  const pos: readonly [number, number, number] = l.position ?? [0, 10, 0];
  const rawDir = l.direction ?? [0, -1, 0];
  const dirLen = Math.hypot(rawDir[0], rawDir[1], rawDir[2]) || 1;
  const dir: readonly [number, number, number] = [
    rawDir[0] / dirLen,
    rawDir[1] / dirLen,
    rawDir[2] / dirLen,
  ];
  const range = l.range !== undefined && Number.isFinite(l.range) ? l.range : 1e9;
  const outerCos = l.outerConeCos ?? 0.5;
  const castShadow = l.castShadow === true && kindCode === LIGHT_KIND_DIRECTIONAL;
  const lightCascades = castShadow ? Math.max(1, Math.min(4, l.cascadeCount ?? 1)) : 0;
  return { kindCode, pos, dir, range, outerCos, castShadow, lightCascades };
}

function resolveWitnessPoolSlot(phys: Uint32Array, fallbackSlot: number): number {
  let resolvedSlot = fallbackSlot;
  for (let cursor = 0; cursor < phys.length; ) {
    const hdr = phys[cursor] ?? 0;
    const op = hdr & 0xffff;
    const wlen = hdr >>> 16;
    if (wlen === 0 || cursor + wlen > phys.length) break;
    if (op === PHYS_BEGIN_RENDER_PASS && wlen >= 4) {
      const colorCount = (phys[cursor + 2] ?? 0) & 0xff;
      if (colorCount > 0) {
        const handle = phys[cursor + 3] ?? 0;
        if ((handle & TEMP_TEXTURE_TAG_BIT) !== 0) {
          resolvedSlot = (handle & ~TEMP_TEXTURE_TAG_BIT) >>> 0;
        }
      }
    }
    cursor += wlen;
  }
  return resolvedSlot;
}

function writeMaterialParams(
  out: Float32Array,
  input: DesktopMaterialInput,
  hasNormalMap: boolean,
): void {
  const transparent =
    input.alphaMode === 'blend' || input.transparent === true || (input.queue ?? 2000) > 2500;
  const alphaMask = input.alphaMode === 'mask';
  const flags = (transparent ? 1 : 0) | (alphaMask ? 2 : 0) | (hasNormalMap ? 4 : 0);
  out[0] = input.baseColor[0];
  out[1] = input.baseColor[1];
  out[2] = input.baseColor[2];
  out[3] = input.baseColor[3];
  out[4] = input.roughness ?? 0.5;
  out[5] = input.metallic ?? 0.0;
  out[6] = input.alphaCutoff ?? 0.5;
  out[7] = flags;
  out[8] = input.emissive?.[0] ?? 0;
  out[9] = input.emissive?.[1] ?? 0;
  out[10] = input.emissive?.[2] ?? 0;
  out[11] = input.occlusionStrength ?? 1.0;
  out[12] = input.normalScale ?? 1.0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 0;
}

/**
 * Retained 3-pass 4-BGL desktop 3D renderer running on NativeRenderKernel's dedicated OS render
 * thread (wgpu 30). Incrementally synchronizes changed transforms, entity spawns/despawns,
 * dynamic material parameters, and multi-light scenes without full-scene re-uploads.
 */
export class DesktopNativeSceneRenderer {
  readonly kernel: NativeRenderKernel;
  readonly headless: boolean;
  readonly shadowMapSize: number;

  private readonly defaultClearColor: readonly [number, number, number, number];
  private readonly defaultAmbientColor: readonly [number, number, number];
  private readonly surfaceFormat: GPUTextureFormat;
  private shadowShader: ShaderProgramId;
  private skinnedShadowShader: ShaderProgramId;
  private litShader: ShaderProgramId;
  private skinnedLitShader: ShaderProgramId;
  private tonemapSurfaceShader: ShaderProgramId;
  private tonemapWitnessShader: ShaderProgramId;
  private uiOverlaySurfaceShader: ShaderProgramId;
  private uiOverlayWitnessShader: ShaderProgramId;
  private skyboxShader: ShaderProgramId;
  private bloomExtractHShader: ShaderProgramId;
  private bloomBlurVShader: ShaderProgramId;
  private bloomCompositeShader: ShaderProgramId;
  private fxaaSurfaceShader: ShaderProgramId;
  private fxaaWitnessShader: ShaderProgramId;
  private debugLineMaterialId: MaterialId;
  private skyboxUbo: BufferId;
  private bloomUbo: BufferId;
  private fxaaUbo: BufferId;
  private linearSampler: SamplerId;
  private postSampler: SamplerId;
  private readonly skyboxUboF32 = new Float32Array(28); // invViewProj(16) + zenith(4) + horizon(4) + ground(4)
  private readonly bloomUboF32 = new Float32Array(4);
  private readonly fxaaUboF32 = new Float32Array(4);
  private readonly invViewProjScratch = new Float32Array(16);
  private debugLinesMeshId: MeshId | undefined;
  private lastDebugLines: Float32Array | undefined;
  private debugLinesActive = false;
  private debugLinesDirty = false;
  private uiDynamicTexId: DynamicTextureId | undefined;
  private lastUiOverlay:
    | { width: number; height: number; rgbaBytes: Uint8Array; revision: number }
    | undefined;
  private uiOverlayActive = false;
  private uiOverlayRevision = 0;

  private readonly meshes = new Map<DesktopResourceKey, CachedMeshRecord>();
  private readonly textures = new Map<DesktopResourceKey, TextureId>();
  private readonly textureInputs = new Map<DesktopResourceKey, DesktopTextureInput>();
  private readonly materials = new Map<DesktopResourceKey, CachedMaterialRecord>();
  private readonly customShaders = new Map<DesktopResourceKey, CachedCustomShaderRecord>();
  private readonly pendingMaterialRebinds = new Set<DesktopResourceKey>();
  private readonly skinPalettes = new Map<
    DesktopResourceKey,
    { offset: number; jointCount: number }
  >();
  private readonly pendingSkinUploads: {
    readonly offset: number;
    readonly matrices: Float32Array;
    readonly jointCount: number;
  }[] = [];
  private nextSkinJointOffset = 0;
  private skinnedObjectCount = 0;
  private readonly trackedObjects = new Map<number, TrackedObjectRecord>();
  private readonly featureHost = new DesktopFeatureHost();
  private nextObjectId = 1;

  private readonly pendingMaterialUpdates = new Map<MaterialId, Uint8Array>();
  private readonly upsertsScratch: UpsertObjectInput[] = [];
  private readonly removesScratch: RenderObjectId[] = [];
  private readonly resolvedMetaScratch = {
    matId: 0 as MaterialId,
    skinSlot: 0,
    isTransparent: false,
    queue: 0,
    submeshIndex: 0,
    objFlags: 0,
    layerMask: 0,
  };
  private frameDirtyTransformCount = 0;
  private frameDirtyDrawParamCount = 0;
  private dirtyTransformIds = new Uint32Array(256);
  private dirtyTransformMats = new Float32Array(256 * 16);
  private dirtyDrawParamIds = new Uint32Array(64);
  private dirtyDrawParamVals = new Float32Array(64 * 8);

  private readonly viewUboBuf = new ArrayBuffer(VIEW_UBO_BYTES);
  private readonly viewUboF32 = new Float32Array(this.viewUboBuf);
  private readonly viewUboU32 = new Uint32Array(this.viewUboBuf);
  private readonly viewUboBytes = new Uint8Array(this.viewUboBuf);
  private readonly shadowViewUboBuf = new ArrayBuffer(SHADOW_VIEW_UBO_BYTES);
  private readonly shadowViewUboF32 = new Float32Array(this.shadowViewUboBuf);
  private readonly shadowViewUboBytes = new Uint8Array(this.shadowViewUboBuf);
  private readonly shadowOrthoScratch = new Float32Array(16);
  private readonly shadowViewScratch = new Float32Array(16);
  private readonly cascadeVps: readonly Float32Array[] = [
    new Float32Array(16),
    new Float32Array(16),
    new Float32Array(16),
    new Float32Array(16),
  ];
  private readonly cascadeCamPositions: readonly [number, number, number][] = [
    [0, 30, 0],
    [0, 30, 0],
    [0, 30, 0],
    [0, 30, 0],
  ];
  private readonly cascadeSplitsScratch = new Float32Array(4);
  private activeCascadeCount = 1;

  private readonly deltaWriter: SceneDeltaWriter;
  private readonly sceneEpoch = 1;
  private sceneRevision = 0;
  private frameCounter = 0;
  private syncStamp = 0;
  private lastLightsDigest = '';
  private lastDirtyTransformCount = 0;
  private lastUpsertCount = 0;
  private lastRemoveCount = 0;
  private transparentObjectCount = 0;
  private disposed = false;

  constructor(
    kernel: NativeRenderKernel,
    resources: BuiltinDesktopResources & {
      readonly headless: boolean;
      readonly surfaceFormat: GPUTextureFormat;
      readonly shadowMapSize: number;
      readonly defaultClearColor: readonly [number, number, number, number];
      readonly defaultAmbientColor: readonly [number, number, number];
    },
  ) {
    this.kernel = kernel;
    this.headless = resources.headless;
    this.surfaceFormat = resources.surfaceFormat;
    this.shadowMapSize = resources.shadowMapSize;
    this.defaultClearColor = resources.defaultClearColor;
    this.defaultAmbientColor = resources.defaultAmbientColor;
    this.shadowShader = resources.shadowShader;
    this.skinnedShadowShader = resources.skinnedShadowShader;
    this.litShader = resources.litShader;
    this.skinnedLitShader = resources.skinnedLitShader;
    this.tonemapSurfaceShader = resources.tonemapSurfaceShader;
    this.tonemapWitnessShader = resources.tonemapWitnessShader;
    this.uiOverlaySurfaceShader = resources.uiOverlaySurfaceShader;
    this.uiOverlayWitnessShader = resources.uiOverlayWitnessShader;
    this.skyboxShader = resources.skyboxShader;
    this.bloomExtractHShader = resources.bloomExtractHShader;
    this.bloomBlurVShader = resources.bloomBlurVShader;
    this.bloomCompositeShader = resources.bloomCompositeShader;
    this.fxaaSurfaceShader = resources.fxaaSurfaceShader;
    this.fxaaWitnessShader = resources.fxaaWitnessShader;
    this.debugLineMaterialId = resources.debugLineMaterialId;
    this.skyboxUbo = resources.skyboxUbo;
    this.bloomUbo = resources.bloomUbo;
    this.fxaaUbo = resources.fxaaUbo;
    this.linearSampler = resources.linearSampler;
    this.postSampler = resources.postSampler;
    this.deltaWriter = kernel.beginSceneDelta(256 * 1024);
  }

  ensureMesh(input: DesktopMeshInput): Result<MeshId, KernelError> {
    const existing = this.meshes.get(input.key);
    if (existing !== undefined) {
      return ok(existing.id);
    }
    const skinned = input.skinned === true;
    const stride = skinned ? DESKTOP_SKINNED_VERTEX_STRIDE_FLOATS : DESKTOP_VERTEX_STRIDE_FLOATS;
    const vertexCount = Math.floor(input.vertices.length / stride);
    const indexCount = input.indices?.length ?? 0;
    const isUint32Index = input.indices instanceof Uint32Array;
    const vertexBytes = new Uint8Array(
      input.vertices.buffer,
      input.vertices.byteOffset,
      input.vertices.byteLength,
    );
    const indexBytes =
      input.indices !== undefined
        ? new Uint8Array(input.indices.buffer, input.indices.byteOffset, input.indices.byteLength)
        : undefined;
    const created = this.kernel.assets.createMesh(
      {
        vertexLayoutId: skinned ? 5 : 4,
        vertexCount,
        indexCount,
        isUint32Index,
        ...(input.submeshes !== undefined && input.submeshes.length > 0
          ? {
              submeshes: input.submeshes.map((s) => ({
                firstIndex: s.firstIndex ?? 0,
                indexCount: s.indexCount ?? 0,
                baseVertex: s.baseVertex ?? 0,
                firstVertex: s.firstVertex ?? 0,
                vertexCount: s.vertexCount ?? 0,
              })),
            }
          : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
      },
      vertexBytes,
      indexBytes,
    );
    if (!created.ok) return created;
    const computed =
      input.boundsMin !== undefined && input.boundsMax !== undefined
        ? { min: input.boundsMin, max: input.boundsMax }
        : computeBoundsFromPackedVertices(input.vertices, stride);
    this.meshes.set(input.key, {
      id: created.value,
      input,
      skinned,
      boundsMin: computed.min,
      boundsMax: computed.max,
    });
    return created;
  }

  /**
   * Registers or updates a GPU skinning joint palette (`jointCount` column-major mat4x4 matrices)
   * streamed via `OP_SET_SKIN_JOINTS` into `@group(2) @binding(4) s_skin_joints`.
   */
  setSkinJoints(
    skinKey: DesktopResourceKey,
    matrices: Float32Array,
    jointCount = Math.floor(matrices.length / 16),
  ): number {
    if (jointCount <= 0) return 0;
    let entry = this.skinPalettes.get(skinKey);
    if (entry === undefined || entry.jointCount < jointCount) {
      entry = { offset: this.nextSkinJointOffset, jointCount };
      this.nextSkinJointOffset += jointCount;
      this.skinPalettes.set(skinKey, entry);
    }
    const copy = new Float32Array(jointCount * 16);
    copy.set(matrices.subarray(0, jointCount * 16));
    this.pendingSkinUploads.push({ offset: entry.offset, matrices: copy, jointCount });
    return entry.offset + 1; // 1-based slot (0 = unskinned)
  }

  ensureTexture(input: DesktopTextureInput): Result<TextureId, KernelError> {
    const existing = this.textures.get(input.key);
    if (existing !== undefined) {
      return ok(existing);
    }
    const created = this.kernel.assets.createTexture(
      {
        width: input.width,
        height: input.height,
        format: TEXTURE_FORMAT_RGBA8_UNORM,
        usage: 0x04 | 0x02,
        ...(input.label !== undefined ? { label: input.label } : {}),
      },
      input.rgbaBytes,
    );
    if (!created.ok) return created;
    this.textures.set(input.key, created.value);
    this.textureInputs.set(input.key, input);
    return created;
  }

  private registerCustomShaderProgram(
    key: DesktopResourceKey,
    wgslCode: string,
    options: DesktopCustomShaderOptions,
  ): Result<ShaderProgramId, KernelError> {
    return this.kernel.assets.registerShaderProgram({
      code: wgslCode,
      vertexEntryPoint: options.vertexEntryPoint ?? 'vs_main',
      fragmentEntryPoint: options.fragmentEntryPoint ?? 'fs_main',
      layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
      vertexBufferLayouts: options.skinned ? DESKTOP_SKINNED_VERTEX_LAYOUT : DESKTOP_VERTEX_LAYOUT,
      colorFormats: ['rgba16float'],
      depthFormat: 'depth32float',
      ...(options.blendMode !== undefined ? { blendMode: options.blendMode } : {}),
      label: options.label ?? `desktop-custom-shader-${String(key)}`,
    });
  }

  /**
   * Registers a custom 4-BGL WGSL material shader. If `key` already exists with different WGSL
   * code, performs a live hot-reload (evicting cached PSOs and rebinding referencing materials).
   */
  registerCustomShader(
    key: DesktopResourceKey,
    wgslCode: string,
    options: DesktopCustomShaderOptions = {},
  ): Result<ShaderProgramId, KernelError> {
    const existing = this.customShaders.get(key);
    if (existing !== undefined) {
      if (existing.wgslCode === wgslCode) {
        return ok(existing.shaderId);
      }
      return this.reloadCustomShader(key, wgslCode, options);
    }
    const created = this.registerCustomShaderProgram(key, wgslCode, options);
    if (!created.ok) return created;
    this.customShaders.set(key, {
      shaderId: created.value,
      wgslCode,
      options,
    });
    return created;
  }

  /**
   * Live hot-reloads an existing custom 4-BGL WGSL shader: compiles the replacement shader first,
   * destroys the previous shader (evicting Rust PSO cache entries), rebuilds referencing materials
   * with preserved uniform/texture bindings, and schedules tracked objects for re-upsert.
   */
  reloadCustomShader(
    key: DesktopResourceKey,
    wgslCode: string,
    options?: DesktopCustomShaderOptions,
  ): Result<ShaderProgramId, KernelError> {
    const existing = this.customShaders.get(key);
    const mergedOpts = options ?? existing?.options ?? {};
    const created = this.registerCustomShaderProgram(key, wgslCode, mergedOpts);
    if (!created.ok) return created;

    const oldShaderId = existing?.shaderId;
    this.customShaders.set(key, {
      shaderId: created.value,
      wgslCode,
      options: mergedOpts,
    });

    // Rebind every material referencing this custom shader key
    for (const [matKey, matRec] of this.materials) {
      if (matRec.input.customShaderKey !== key) continue;
      this.rebuildMaterialWithShader(matKey, matRec, matRec.input, created.value);
    }

    if (oldShaderId !== undefined) {
      this.kernel.assets.destroyShaderProgram(oldShaderId);
    }
    return created;
  }

  private rebuildMaterialWithShader(
    matKey: DesktopResourceKey,
    matRec: CachedMaterialRecord,
    input: DesktopMaterialInput,
    shaderProgramId: ShaderProgramId,
  ): Result<MaterialId, KernelError> {
    const renderStateBits = computeMaterialRenderStateBits(matRec.transparent, input.doubleSided);
    const rebuilt = this.createKernelMaterialWithShader(
      input,
      shaderProgramId,
      renderStateBits,
      matRec.queue,
      matRec.params,
    );
    if (!rebuilt.ok) return rebuilt;
    const prevId = matRec.id;
    matRec.id = rebuilt.value;
    this.pendingMaterialUpdates.delete(prevId);
    this.kernel.assets.destroyMaterial(prevId);
    if (matRec.skinnedId !== undefined) {
      this.pendingMaterialUpdates.delete(matRec.skinnedId);
      this.kernel.assets.destroyMaterial(matRec.skinnedId);
      matRec.skinnedId = undefined;
    }
    this.pendingMaterialRebinds.add(matKey);
    return rebuilt;
  }

  private updateExistingMaterial(
    existing: CachedMaterialRecord,
    input: DesktopMaterialInput,
    hasNormalMap: boolean,
    desiredShader: ShaderProgramId,
  ): Result<MaterialId, KernelError> {
    const shaderSwitched = existing.input.customShaderKey !== input.customShaderKey;
    const prev = existing.params;
    const next = new Float32Array(MATERIAL_UBO_FLOATS);
    writeMaterialParams(next, input, hasNormalMap);
    let changed = false;
    for (let i = 0; i < MATERIAL_UBO_FLOATS; i++) {
      if (prev[i] !== next[i]) {
        changed = true;
        break;
      }
    }
    if (changed) {
      prev.set(next);
    }
    if (shaderSwitched) {
      existing.input = input;
      const rebuilt = this.rebuildMaterialWithShader(input.key, existing, input, desiredShader);
      if (!rebuilt.ok) return rebuilt;
      return ok(existing.id);
    }
    if (changed) {
      const bytes = new Uint8Array(prev.buffer.slice(0));
      this.pendingMaterialUpdates.set(existing.id, bytes);
      if (existing.skinnedId !== undefined) {
        this.pendingMaterialUpdates.set(existing.skinnedId, bytes);
      }
    }
    return ok(existing.id);
  }

  ensureMaterial(input: DesktopMaterialInput): Result<MaterialId, KernelError> {
    const hasNormalMap =
      input.normalTextureKey !== undefined && this.textures.has(input.normalTextureKey);
    const desiredShader =
      input.customShaderKey !== undefined
        ? (this.customShaders.get(input.customShaderKey)?.shaderId ?? this.litShader)
        : this.litShader;
    const existing = this.materials.get(input.key);
    if (existing !== undefined) {
      return this.updateExistingMaterial(existing, input, hasNormalMap, desiredShader);
    }

    const transparent =
      input.alphaMode === 'blend' || input.transparent === true || (input.queue ?? 2000) > 2500;
    const alphaMask = input.alphaMode === 'mask';
    const queue = input.queue ?? (transparent ? 3000 : alphaMask ? 2450 : 2000);
    const renderStateBits = computeMaterialRenderStateBits(transparent, input.doubleSided);

    const params = new Float32Array(MATERIAL_UBO_FLOATS);
    writeMaterialParams(params, input, hasNormalMap);
    const created = this.createKernelMaterialWithShader(
      input,
      desiredShader,
      renderStateBits,
      queue,
      params,
    );
    if (!created.ok) return created;
    this.materials.set(input.key, {
      id: created.value,
      input,
      queue,
      transparent,
      alphaMask,
      params,
    });
    return created;
  }

  private createKernelMaterialWithShader(
    input: DesktopMaterialInput,
    shaderProgramId: ShaderProgramId,
    renderStateBits: number,
    queue: number,
    params: Float32Array,
  ): Result<MaterialId, KernelError> {
    const texId =
      input.baseColorTextureKey !== undefined
        ? this.textures.get(input.baseColorTextureKey)
        : undefined;
    const normalTexId =
      input.normalTextureKey !== undefined ? this.textures.get(input.normalTextureKey) : undefined;
    const mrTexId =
      input.metallicRoughnessTextureKey !== undefined
        ? this.textures.get(input.metallicRoughnessTextureKey)
        : undefined;
    const emissiveTexId =
      input.emissiveTextureKey !== undefined
        ? this.textures.get(input.emissiveTextureKey)
        : undefined;
    const occlusionTexId =
      input.occlusionTextureKey !== undefined
        ? this.textures.get(input.occlusionTextureKey)
        : undefined;
    const anyTex =
      texId !== undefined ||
      normalTexId !== undefined ||
      mrTexId !== undefined ||
      emissiveTexId !== undefined ||
      occlusionTexId !== undefined;
    return this.kernel.assets.createMaterial(
      {
        shaderProgramId,
        layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
        renderStateBits,
        queue,
        ...(texId !== undefined ? { baseColorTextureId: texId } : {}),
        ...(normalTexId !== undefined ? { normalTextureId: normalTexId } : {}),
        ...(mrTexId !== undefined ? { metallicRoughnessTextureId: mrTexId } : {}),
        ...(emissiveTexId !== undefined ? { emissiveTextureId: emissiveTexId } : {}),
        ...(occlusionTexId !== undefined ? { occlusionTextureId: occlusionTexId } : {}),
        ...(anyTex ? { samplerId: this.linearSampler } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
      },
      new Uint8Array(params.buffer),
    );
  }

  private resolveMaterialIdForMesh(matRec: CachedMaterialRecord, skinned: boolean): MaterialId {
    if (!skinned) return matRec.id;
    if (matRec.skinnedId !== undefined) return matRec.skinnedId;
    const input = matRec.input;
    const renderStateBits = computeMaterialRenderStateBits(matRec.transparent, input.doubleSided);
    const created = this.createKernelMaterialWithShader(
      input,
      this.skinnedLitShader,
      renderStateBits,
      matRec.transparent ? matRec.queue : 2460,
      matRec.params,
    );
    if (!created.ok) return matRec.id;
    matRec.skinnedId = created.value;
    return created.value;
  }

  private ensureDirtyTransformCapacity(count: number): void {
    if (count <= this.dirtyTransformIds.length) return;
    let nextCap = this.dirtyTransformIds.length;
    while (nextCap < count) nextCap *= 2;
    const nextIds = new Uint32Array(nextCap);
    nextIds.set(this.dirtyTransformIds);
    this.dirtyTransformIds = nextIds;
    const nextMats = new Float32Array(nextCap * 16);
    nextMats.set(this.dirtyTransformMats);
    this.dirtyTransformMats = nextMats;
  }

  private ensureDirtyDrawParamCapacity(count: number): void {
    if (count <= this.dirtyDrawParamIds.length) return;
    let nextCap = this.dirtyDrawParamIds.length;
    while (nextCap < count) nextCap *= 2;
    const nextIds = new Uint32Array(nextCap);
    nextIds.set(this.dirtyDrawParamIds);
    this.dirtyDrawParamIds = nextIds;
    const nextVals = new Float32Array(nextCap * 8);
    nextVals.set(this.dirtyDrawParamVals);
    this.dirtyDrawParamVals = nextVals;
  }

  private resolveObjectMeta(
    obj: DesktopRenderObjectInput,
    meshRec: CachedMeshRecord,
    matRec: CachedMaterialRecord,
  ): void {
    const meta = this.resolvedMetaScratch;
    const skinEntry = obj.skinKey !== undefined ? this.skinPalettes.get(obj.skinKey) : undefined;
    const isTransparent = matRec.transparent || (obj.queue ?? matRec.queue) > 2500;
    meta.matId = this.resolveMaterialIdForMesh(matRec, meshRec.skinned);
    meta.skinSlot = skinEntry !== undefined ? skinEntry.offset + 1 : 0;
    meta.isTransparent = isTransparent;
    meta.queue = meshRec.skinned && !isTransparent ? 2460 : (obj.queue ?? matRec.queue);
    meta.submeshIndex = obj.submeshIndex ?? 0;
    meta.objFlags = computeObjectFlags(obj, isTransparent, matRec.alphaMask);
    meta.layerMask = (obj.layerMask ?? 0xffff_ffff) >>> 0;
  }

  private isTrackedMetaChanged(tracked: TrackedObjectRecord, meshId: MeshId): boolean {
    const meta = this.resolvedMetaScratch;
    return (
      tracked.meshId !== meshId ||
      tracked.submeshIndex !== meta.submeshIndex ||
      tracked.materialId !== meta.matId ||
      tracked.skinSlot !== meta.skinSlot ||
      tracked.layerMask !== meta.layerMask ||
      tracked.objFlags !== meta.objFlags ||
      tracked.queue !== meta.queue
    );
  }

  private pushUpsertForMeta(
    objectId: RenderObjectId,
    entityId: number,
    meshRec: CachedMeshRecord,
  ): void {
    const meta = this.resolvedMetaScratch;
    this.upsertsScratch.push({
      objectId,
      meshId: meshRec.id,
      submeshStart: meta.submeshIndex,
      submeshCount: 1,
      materialId: meta.matId,
      skinSlot: meta.skinSlot,
      layerMask: meta.layerMask,
      objFlags: meta.objFlags,
      queue: meta.queue,
      entityOrder: entityId & 0xffff,
      localBoundsMin: meshRec.boundsMin,
      localBoundsMax: meshRec.boundsMax,
    });
  }

  private recordDirtyTransform(tracked: TrackedObjectRecord, worldMatrix: ArrayLike<number>): void {
    const w = tracked.world;
    for (let k = 0; k < 16; k++) {
      w[k] = worldMatrix[k] as number;
    }
    const idx = this.frameDirtyTransformCount;
    this.ensureDirtyTransformCapacity(idx + 1);
    this.dirtyTransformIds[idx] = tracked.objectId;
    this.dirtyTransformMats.set(w, idx * 16);
    this.frameDirtyTransformCount = idx + 1;
  }

  private syncObjectDrawParams(obj: DesktopRenderObjectInput, tracked: TrackedObjectRecord): void {
    const affineFlag = obj.skinAffinePoint === true ? 1 : 0;
    if (obj.drawParams === undefined && affineFlag === 0 && !tracked.hasDrawParams) return;
    let dpChanged = !tracked.hasDrawParams;
    for (let k = 0; k < 8; k++) {
      if (tracked.drawParams[k] !== readNextDrawParam(obj, affineFlag, k)) {
        dpChanged = true;
        break;
      }
    }
    if (!dpChanged) return;
    tracked.hasDrawParams = true;
    for (let k = 0; k < 8; k++) {
      tracked.drawParams[k] = readNextDrawParam(obj, affineFlag, k);
    }
    const idx = this.frameDirtyDrawParamCount;
    this.ensureDirtyDrawParamCapacity(idx + 1);
    this.dirtyDrawParamIds[idx] = tracked.objectId;
    this.dirtyDrawParamVals.set(tracked.drawParams, idx * 8);
    this.frameDirtyDrawParamCount = idx + 1;
  }

  private updateIncrementalCategoryCounts(
    tracked: TrackedObjectRecord,
    nextVisibleTransparent: boolean,
    nextSkinned: boolean,
  ): void {
    const prevVisibleTransparent =
      (tracked.objFlags & OBJ_FLAG_TRANSPARENT) !== 0 &&
      (tracked.objFlags & OBJ_FLAG_VISIBLE) !== 0;
    if (prevVisibleTransparent !== nextVisibleTransparent) {
      this.transparentObjectCount = Math.max(
        0,
        this.transparentObjectCount + (nextVisibleTransparent ? 1 : -1),
      );
    }
    const prevSkinned = tracked.skinSlot > 0 || tracked.queue === 2460;
    if (prevSkinned !== nextSkinned) {
      this.skinnedObjectCount = Math.max(0, this.skinnedObjectCount + (nextSkinned ? 1 : -1));
    }
  }

  private createTrackedObject(
    obj: DesktopRenderObjectInput,
    meshRec: CachedMeshRecord,
    stamp: number,
    trackCounts: boolean,
  ): TrackedObjectRecord {
    const meta = this.resolvedMetaScratch;
    const objectId = this.nextObjectId++ as RenderObjectId;
    const tracked: TrackedObjectRecord = {
      objectId,
      meshId: meshRec.id,
      meshKey: obj.meshKey,
      submeshIndex: meta.submeshIndex,
      materialId: meta.matId,
      materialKey: obj.materialKey,
      skinSlot: meta.skinSlot,
      layerMask: meta.layerMask,
      objFlags: meta.objFlags,
      queue: meta.queue,
      seenFrame: stamp,
      world: new Float32Array(16),
      hasDrawParams: false,
      drawParams: new Float32Array(8),
    };
    this.trackedObjects.set(obj.entityId, tracked);
    if (trackCounts) {
      if (meta.isTransparent && obj.visible !== false) this.transparentObjectCount += 1;
      if (meta.skinSlot > 0 || meta.queue === 2460) this.skinnedObjectCount += 1;
    }
    return tracked;
  }

  private updateTrackedObject(
    tracked: TrackedObjectRecord,
    obj: DesktopRenderObjectInput,
    meshRec: CachedMeshRecord,
    stamp: number,
    trackCounts: boolean,
  ): number {
    const meta = this.resolvedMetaScratch;
    if (trackCounts) {
      this.updateIncrementalCategoryCounts(
        tracked,
        meta.isTransparent && obj.visible !== false,
        meta.skinSlot > 0 || meta.queue === 2460,
      );
    } else {
      tracked.seenFrame = stamp;
    }
    let changeMask = 0;
    if (this.isTrackedMetaChanged(tracked, meshRec.id)) {
      tracked.meshId = meshRec.id;
      tracked.meshKey = obj.meshKey;
      tracked.submeshIndex = meta.submeshIndex;
      tracked.materialId = meta.matId;
      tracked.materialKey = obj.materialKey;
      tracked.skinSlot = meta.skinSlot;
      tracked.layerMask = meta.layerMask;
      tracked.objFlags = meta.objFlags;
      tracked.queue = meta.queue;
      changeMask |= 1;
    }
    if (hasWorldMatrixChanged(tracked.world, obj.worldMatrix)) {
      changeMask |= 2;
    }
    return changeMask;
  }

  private syncTrackedObject(
    obj: DesktopRenderObjectInput,
    stamp: number,
    trackCounts: boolean,
  ): boolean {
    const meshRec = this.meshes.get(obj.meshKey);
    const matRec = this.materials.get(obj.materialKey);
    if (meshRec === undefined || matRec === undefined) return false;

    this.resolveObjectMeta(obj, meshRec, matRec);
    let tracked = this.trackedObjects.get(obj.entityId);
    let changeMask: number;
    if (tracked === undefined) {
      tracked = this.createTrackedObject(obj, meshRec, stamp, trackCounts);
      changeMask = 3;
    } else {
      changeMask = this.updateTrackedObject(tracked, obj, meshRec, stamp, trackCounts);
    }
    if ((changeMask & 1) !== 0) {
      this.pushUpsertForMeta(tracked.objectId, obj.entityId, meshRec);
    }
    if ((changeMask & 2) !== 0) {
      this.recordDirtyTransform(tracked, obj.worldMatrix);
    }
    this.syncObjectDrawParams(obj, tracked);
    return this.resolvedMetaScratch.isTransparent && obj.visible !== false;
  }

  private sweepUnseenTrackedObjects(stamp: number): void {
    for (const [entityId, tracked] of this.trackedObjects) {
      if (tracked.seenFrame !== stamp) {
        this.removesScratch.push(tracked.objectId);
        this.trackedObjects.delete(entityId);
      }
    }
  }

  private recountTrackedObjectCategories(): void {
    let transparentCount = 0;
    let skinnedCount = 0;
    for (const tracked of this.trackedObjects.values()) {
      if (
        (tracked.objFlags & OBJ_FLAG_TRANSPARENT) !== 0 &&
        (tracked.objFlags & OBJ_FLAG_VISIBLE) !== 0
      ) {
        transparentCount += 1;
      }
      if (tracked.skinSlot > 0 || tracked.queue === 2460) {
        skinnedCount += 1;
      }
    }
    this.transparentObjectCount = transparentCount;
    this.skinnedObjectCount = skinnedCount;
  }

  private removeIncrementalEntities(removedEntityIds: readonly number[]): void {
    for (let i = 0; i < removedEntityIds.length; i++) {
      const entityId = removedEntityIds[i];
      if (entityId === undefined) continue;
      const tracked = this.trackedObjects.get(entityId);
      if (tracked === undefined) continue;
      if (
        (tracked.objFlags & OBJ_FLAG_TRANSPARENT) !== 0 &&
        (tracked.objFlags & OBJ_FLAG_VISIBLE) !== 0
      ) {
        this.transparentObjectCount = Math.max(0, this.transparentObjectCount - 1);
      }
      if (tracked.skinSlot > 0 || tracked.queue === 2460) {
        this.skinnedObjectCount = Math.max(0, this.skinnedObjectCount - 1);
      }
      this.removesScratch.push(tracked.objectId);
      this.trackedObjects.delete(entityId);
    }
  }

  private applyIncrementalDirtyTransforms(
    dirtyCount: number,
    dirtyIds: ArrayLike<number> | undefined,
    dirtyMats: Float32Array | undefined,
  ): void {
    if (dirtyCount <= 0 || dirtyIds === undefined || dirtyMats === undefined) return;
    this.ensureDirtyTransformCapacity(this.frameDirtyTransformCount + dirtyCount);
    for (let i = 0; i < dirtyCount; i++) {
      const entityId = dirtyIds[i];
      if (entityId === undefined) continue;
      const tracked = this.trackedObjects.get(entityId);
      if (tracked === undefined) continue;
      const srcOff = i * 16;
      const dstOff = this.frameDirtyTransformCount * 16;
      const w = tracked.world;
      for (let k = 0; k < 16; k++) {
        const val = dirtyMats[srcOff + k] as number;
        w[k] = val;
        this.dirtyTransformMats[dstOff + k] = val;
      }
      this.dirtyTransformIds[this.frameDirtyTransformCount] = tracked.objectId;
      this.frameDirtyTransformCount += 1;
    }
  }

  private flushPendingMaterialRebinds(): void {
    for (const [entityId, tracked] of this.trackedObjects) {
      if (!this.pendingMaterialRebinds.has(tracked.materialKey)) continue;
      const meshRec = this.meshes.get(tracked.meshKey);
      const matRec = this.materials.get(tracked.materialKey);
      if (meshRec === undefined || matRec === undefined) continue;
      const nextMatId = this.resolveMaterialIdForMesh(matRec, meshRec.skinned);
      if (tracked.materialId !== nextMatId) {
        tracked.materialId = nextMatId;
        this.upsertsScratch.push({
          objectId: tracked.objectId,
          meshId: tracked.meshId,
          submeshStart: tracked.submeshIndex,
          submeshCount: 1,
          materialId: nextMatId,
          skinSlot: tracked.skinSlot,
          layerMask: tracked.layerMask,
          objFlags: tracked.objFlags,
          queue: tracked.queue,
          entityOrder: entityId & 0xffff,
          localBoundsMin: meshRec.boundsMin,
          localBoundsMax: meshRec.boundsMax,
        });
      }
    }
    this.pendingMaterialRebinds.clear();
  }

  private buildSceneDelta(input: DesktopFrameInput): {
    readonly hasDelta: boolean;
    readonly hasTransparent: boolean;
    readonly hasShadowLight: boolean;
    readonly shadowLightIndex: number;
    readonly lightCount: number;
  } {
    this.syncStamp += 1;
    const stamp = this.syncStamp;
    this.upsertsScratch.length = 0;
    this.removesScratch.length = 0;
    this.frameDirtyTransformCount = 0;
    this.frameDirtyDrawParamCount = 0;

    let hasTransparent = false;
    for (let i = 0; i < input.objects.length; i++) {
      const obj = input.objects[i];
      if (obj !== undefined && this.syncTrackedObject(obj, stamp, false)) {
        hasTransparent = true;
      }
    }

    this.sweepUnseenTrackedObjects(stamp);
    this.recountTrackedObjectCategories();
    this.pendingMaterialRebinds.clear();

    return this.finalizeSceneDelta(
      input.camera,
      input.lights,
      input.ambientColor,
      input.skylight,
      input.fog,
      input.elapsedSeconds,
      input.deltaSeconds,
      hasTransparent || this.transparentObjectCount > 0,
    );
  }

  private buildIncrementalSceneDelta(input: DesktopIncrementalFrameInput): {
    readonly hasDelta: boolean;
    readonly hasTransparent: boolean;
    readonly hasShadowLight: boolean;
    readonly shadowLightIndex: number;
    readonly lightCount: number;
  } {
    this.upsertsScratch.length = 0;
    this.removesScratch.length = 0;
    this.frameDirtyTransformCount = 0;
    this.frameDirtyDrawParamCount = 0;

    if (input.removedEntityIds !== undefined) {
      this.removeIncrementalEntities(input.removedEntityIds);
    }
    if (input.upserts !== undefined) {
      for (let i = 0; i < input.upserts.length; i++) {
        const obj = input.upserts[i];
        if (obj !== undefined) {
          this.syncTrackedObject(obj, this.syncStamp, true);
        }
      }
    }
    this.applyIncrementalDirtyTransforms(
      input.dirtyTransformCount ?? 0,
      input.dirtyTransformEntityIds,
      input.dirtyTransformMatrices,
    );
    if (this.pendingMaterialRebinds.size > 0) {
      this.flushPendingMaterialRebinds();
    }

    return this.finalizeSceneDelta(
      input.camera,
      input.lights,
      input.ambientColor,
      input.skylight,
      input.fog,
      input.elapsedSeconds,
      input.deltaSeconds,
      this.transparentObjectCount > 0,
    );
  }

  private configureShadowCascades(
    l: DesktopLightInput,
    pos: readonly [number, number, number],
    dir: readonly [number, number, number],
    cascadeCount: number,
  ): void {
    const maxDist = Math.max(10, Math.min(l.shadowDistance ?? 40, 200));
    const target = l.shadowTarget ?? [0, 0, 0];
    const up: readonly [number, number, number] = Math.abs(dir[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];

    if (cascadeCount === 1 && l.shadowViewProj !== undefined) {
      this.cascadeVps[0]?.set(l.shadowViewProj);
      const cam0 = this.cascadeCamPositions[0];
      if (cam0 !== undefined) {
        cam0[0] = pos[0];
        cam0[1] = pos[1];
        cam0[2] = pos[2];
      }
      this.cascadeSplitsScratch.set([maxDist, maxDist, maxDist, maxDist]);
      return;
    }

    const splitFractions = getCascadeSplitFractions(cascadeCount);
    this.cascadeSplitsScratch.fill(maxDist);
    for (let c = 0; c < cascadeCount; c++) {
      const frac = splitFractions[c] ?? 1.0;
      const extent = maxDist * frac;
      this.cascadeSplitsScratch[c] = extent * 1.35;
      const eyeDist = Math.max(maxDist * 1.15, extent * 1.5);
      const camC = this.cascadeCamPositions[c];
      if (camC === undefined) continue;
      camC[0] = target[0] - dir[0] * eyeDist;
      camC[1] = target[1] - dir[1] * eyeDist;
      camC[2] = target[2] - dir[2] * eyeDist;
      desktopMat4Ortho(
        -extent,
        extent,
        -extent,
        extent,
        0.5,
        eyeDist * 2.5,
        this.shadowOrthoScratch,
      );
      desktopMat4LookAt(camC, target, up, this.shadowViewScratch);
      const vpOut = this.cascadeVps[c];
      if (vpOut !== undefined) {
        desktopMat4Multiply(this.shadowOrthoScratch, this.shadowViewScratch, vpOut);
      }
    }
  }

  private prepareSceneLightsAndShadows(lights: readonly DesktopLightInput[]): {
    readonly lightCount: number;
    readonly hasShadowLight: boolean;
    readonly shadowLightIndex: number;
    readonly cascadeCount: number;
    readonly lightDigest: string;
    readonly packedLights: LightInput[];
  } {
    const lightCount = Math.min(lights.length, 16);
    let hasShadowLight = false;
    let shadowLightIndex = 0;
    let cascadeCount = 1;
    let lightDigest = `${lightCount}:`;
    const packedLights: LightInput[] = [];

    for (let i = 0; i < lightCount; i++) {
      const l = lights[i];
      if (l === undefined) continue;
      const norm = normalizeLightInput(l);
      if (norm.castShadow && !hasShadowLight) {
        hasShadowLight = true;
        shadowLightIndex = i;
        cascadeCount = norm.lightCascades;
        this.configureShadowCascades(l, norm.pos, norm.dir, cascadeCount);
      }
      lightDigest += `${l.id},${norm.kindCode},${norm.castShadow ? 1 : 0},${norm.lightCascades},${norm.pos[0].toFixed(3)},${norm.pos[1].toFixed(3)},${norm.pos[2].toFixed(3)},${norm.dir[0].toFixed(3)},${norm.dir[1].toFixed(3)},${norm.dir[2].toFixed(3)},${l.color[0].toFixed(3)},${l.color[1].toFixed(3)},${l.color[2].toFixed(3)},${l.intensity.toFixed(3)},${norm.range.toFixed(2)},${norm.outerCos.toFixed(3)};`;
      packedLights.push({
        lightId: (l.id >>> 0) as LightId,
        kind: norm.kindCode,
        castShadow: norm.castShadow,
        cascadeCount: norm.lightCascades,
        position: norm.pos,
        direction: norm.dir,
        color: l.color,
        intensity: l.intensity,
        range: norm.range,
        outerConeCos: norm.outerCos,
      });
    }
    this.activeCascadeCount = hasShadowLight ? cascadeCount : 1;
    return {
      lightCount,
      hasShadowLight,
      shadowLightIndex,
      cascadeCount,
      lightDigest,
      packedLights,
    };
  }

  private syncDebugLinesDelta(): void {
    if (!this.debugLinesDirty) return;
    if (this.debugLinesMeshId !== undefined) {
      this.upsertsScratch.push({
        objectId: DEBUG_LINES_OBJECT_ID,
        meshId: this.debugLinesMeshId,
        submeshStart: 0,
        submeshCount: 1,
        materialId: this.debugLineMaterialId,
        layerMask: 0xffff_ffff,
        objFlags: OBJ_FLAG_VISIBLE,
        queue: 2495,
        entityOrder: 0xffff,
        localBoundsMin: [-1e4, -1e4, -1e4],
        localBoundsMax: [1e4, 1e4, 1e4],
      });
      const idx = this.frameDirtyTransformCount;
      this.ensureDirtyTransformCapacity(idx + 1);
      this.dirtyTransformIds[idx] = DEBUG_LINES_OBJECT_ID;
      this.dirtyTransformMats.set(IDENTITY_MAT4, idx * 16);
      this.frameDirtyTransformCount = idx + 1;
      this.debugLinesActive = true;
    } else if (this.debugLinesActive) {
      this.removesScratch.push(DEBUG_LINES_OBJECT_ID);
      this.debugLinesActive = false;
    }
    this.debugLinesDirty = false;
  }

  private encodeSceneDeltaOps(
    isBaseline: boolean,
    elapsedSeconds: number | undefined,
    deltaSeconds: number | undefined,
    lightsChanged: boolean,
    packedLights: readonly LightInput[],
    lightDigest: string,
  ): void {
    const baseRev = this.sceneRevision;
    this.sceneRevision += 1;
    this.deltaWriter.reset(
      this.sceneEpoch,
      this.sceneRevision,
      baseRev,
      isBaseline ? DELTA_FLAG_BASELINE : 0,
      elapsedSeconds ?? 0,
      deltaSeconds ?? 1 / 60,
    );
    if (this.removesScratch.length > 0) {
      this.deltaWriter.removeObjects(this.removesScratch);
    }
    if (this.upsertsScratch.length > 0) {
      this.deltaWriter.upsertObjects(this.upsertsScratch);
    }
    if (this.frameDirtyTransformCount > 0) {
      this.deltaWriter.setTransforms(
        this.dirtyTransformIds,
        this.dirtyTransformMats,
        this.frameDirtyTransformCount,
      );
    }
    if (this.frameDirtyDrawParamCount > 0) {
      this.deltaWriter.setDrawParams(
        this.dirtyDrawParamIds,
        this.dirtyDrawParamVals,
        this.frameDirtyDrawParamCount,
      );
    }
    if (this.pendingMaterialUpdates.size > 0) {
      for (const [matId, paramBytes] of this.pendingMaterialUpdates) {
        this.deltaWriter.updateMaterialParams(matId, 0, paramBytes);
      }
      this.pendingMaterialUpdates.clear();
    }
    if (this.pendingSkinUploads.length > 0) {
      for (let i = 0; i < this.pendingSkinUploads.length; i++) {
        const u = this.pendingSkinUploads[i];
        if (u !== undefined) {
          this.deltaWriter.setSkinJoints(u.offset, u.matrices, u.jointCount);
        }
      }
      this.pendingSkinUploads.length = 0;
    }
    if (lightsChanged) {
      this.deltaWriter.setLights(packedLights);
      this.lastLightsDigest = lightDigest;
    }
  }

  private writeFogUniform(fog: DesktopFogInput | undefined): void {
    if (fog === undefined || fog.mode === 'none') return;
    const modeCode = fog.mode === 'exp' ? 1 : fog.mode === 'exp2' ? 2 : 3;
    this.viewUboF32[120] = fog.color[0];
    this.viewUboF32[121] = fog.color[1];
    this.viewUboF32[122] = fog.color[2];
    this.viewUboF32[123] = modeCode;
    this.viewUboF32[124] = fog.density ?? 0.02;
    this.viewUboF32[125] = fog.heightFalloff ?? 0.0;
    this.viewUboF32[126] = fog.near ?? 10.0;
    this.viewUboF32[127] = fog.far ?? 100.0;
    this.viewUboF32[128] = fog.maxOpacity ?? 1.0;
  }

  private writeViewUniformBuffer(
    camera: DesktopCameraInput,
    ambientColor: readonly [number, number, number] | undefined,
    skylight: DesktopSkylightInput | undefined,
    fog: DesktopFogInput | undefined,
    elapsedSeconds: number | undefined,
    lightCount: number,
    hasShadowLight: boolean,
    shadowLightIndex: number,
    cascadeCount: number,
  ): void {
    // Fill 544-byte ViewUniform
    //   [0..16]:   view_proj
    //   [16..80]:  cascade_vp[0..3]
    //   [80..84]:  cascade_splits
    //   [84..100]: cascade_atlas_rect[0..3]
    //   [100..104]: camera_pos_exposure
    //   [104..108]: sky_color_intensity
    //   [108..112]: ground_color_bias
    //   [112..116]: light_meta (u32x4)
    //   [116..120]: shadow_atlas_meta
    //   [120..136]: fog_params0..2
    this.viewUboF32.fill(0);
    this.viewUboF32.set(camera.viewProj, 0);
    for (let c = 0; c < 4; c++) {
      const base = 16 + c * 16;
      if (hasShadowLight && c < cascadeCount) {
        const vp = this.cascadeVps[c];
        if (vp !== undefined) this.viewUboF32.set(vp, base);
      } else {
        this.viewUboF32[base] = 1;
        this.viewUboF32[base + 5] = 1;
        this.viewUboF32[base + 10] = 1;
        this.viewUboF32[base + 15] = 1;
      }
    }
    this.viewUboF32.set(this.cascadeSplitsScratch, 80);

    const atlasIsTiled = hasShadowLight && cascadeCount > 1;
    const atlasDim = atlasIsTiled ? this.shadowMapSize * 2 : this.shadowMapSize;
    for (let c = 0; c < 4; c++) {
      const rBase = 84 + c * 4;
      if (atlasIsTiled) {
        this.viewUboF32[rBase] = (c & 1) * 0.5;
        this.viewUboF32[rBase + 1] = ((c >> 1) & 1) * 0.5;
        this.viewUboF32[rBase + 2] = 0.5;
        this.viewUboF32[rBase + 3] = 0.5;
      } else {
        this.viewUboF32[rBase] = 0;
        this.viewUboF32[rBase + 1] = 0;
        this.viewUboF32[rBase + 2] = 1;
        this.viewUboF32[rBase + 3] = 1;
      }
    }

    this.viewUboF32[100] = camera.position[0];
    this.viewUboF32[101] = camera.position[1];
    this.viewUboF32[102] = camera.position[2];
    this.viewUboF32[103] = camera.exposure ?? 1.0;

    const skyColor = skylight?.skyColor ?? ambientColor ?? this.defaultAmbientColor;
    const groundColor = skylight?.groundColor ?? skyColor;
    const skyIntensity = skylight?.intensity ?? 1.0;
    this.viewUboF32[104] = skyColor[0];
    this.viewUboF32[105] = skyColor[1];
    this.viewUboF32[106] = skyColor[2];
    this.viewUboF32[107] = skyIntensity;

    this.viewUboF32[108] = groundColor[0];
    this.viewUboF32[109] = groundColor[1];
    this.viewUboF32[110] = groundColor[2];
    this.viewUboF32[111] = 0.002; // shadow depth bias

    this.viewUboU32[112] = lightCount >>> 0;
    this.viewUboU32[113] = hasShadowLight ? 1 : 0;
    this.viewUboU32[114] = shadowLightIndex >>> 0;
    this.viewUboU32[115] = (hasShadowLight ? cascadeCount : 0) >>> 0;

    const invAtlas = 1 / Math.max(1, atlasDim);
    this.viewUboF32[116] = invAtlas;
    this.viewUboF32[117] = invAtlas;
    this.viewUboF32[118] = 1.0;
    this.viewUboF32[119] = elapsedSeconds ?? 0;

    this.writeFogUniform(fog);
  }

  private finalizeSceneDelta(
    camera: DesktopCameraInput,
    lights: readonly DesktopLightInput[],
    ambientColor: readonly [number, number, number] | undefined,
    skylight: DesktopSkylightInput | undefined,
    fog: DesktopFogInput | undefined,
    elapsedSeconds: number | undefined,
    deltaSeconds: number | undefined,
    hasTransparent: boolean,
  ): {
    readonly hasDelta: boolean;
    readonly hasTransparent: boolean;
    readonly hasShadowLight: boolean;
    readonly shadowLightIndex: number;
    readonly lightCount: number;
  } {
    const lightState = this.prepareSceneLightsAndShadows(lights);
    this.syncDebugLinesDelta();

    const lightsChanged = lightState.lightDigest !== this.lastLightsDigest;
    const isBaseline = this.sceneRevision === 0;
    const hasOps =
      isBaseline ||
      this.upsertsScratch.length > 0 ||
      this.removesScratch.length > 0 ||
      this.frameDirtyTransformCount > 0 ||
      this.frameDirtyDrawParamCount > 0 ||
      this.pendingMaterialUpdates.size > 0 ||
      this.pendingSkinUploads.length > 0 ||
      lightsChanged;

    this.lastDirtyTransformCount = this.frameDirtyTransformCount;
    this.lastUpsertCount = this.upsertsScratch.length;
    this.lastRemoveCount = this.removesScratch.length;

    if (hasOps) {
      this.encodeSceneDeltaOps(
        isBaseline,
        elapsedSeconds,
        deltaSeconds,
        lightsChanged,
        lightState.packedLights,
        lightState.lightDigest,
      );
    }

    this.writeViewUniformBuffer(
      camera,
      ambientColor,
      skylight,
      fog,
      elapsedSeconds,
      lightState.lightCount,
      lightState.hasShadowLight,
      lightState.shadowLightIndex,
      lightState.cascadeCount,
    );

    return {
      hasDelta: hasOps,
      hasTransparent,
      hasShadowLight: lightState.hasShadowLight,
      shadowLightIndex: lightState.shadowLightIndex,
      lightCount: lightState.lightCount,
    };
  }

  private uploadSkyboxUniform(camera: DesktopCameraInput, skybox: DesktopSkyboxInput): void {
    desktopMat4Invert(camera.viewProj, this.invViewProjScratch);
    this.skyboxUboF32.set(this.invViewProjScratch, 0);
    this.skyboxUboF32[16] = skybox.zenithColor[0];
    this.skyboxUboF32[17] = skybox.zenithColor[1];
    this.skyboxUboF32[18] = skybox.zenithColor[2];
    this.skyboxUboF32[19] = (skybox.intensity ?? 1.0) * (camera.exposure ?? 1.0);
    this.skyboxUboF32[20] = skybox.horizonColor[0];
    this.skyboxUboF32[21] = skybox.horizonColor[1];
    this.skyboxUboF32[22] = skybox.horizonColor[2];
    this.skyboxUboF32[23] = 0;
    const g = skybox.groundColor ?? skybox.horizonColor;
    this.skyboxUboF32[24] = g[0];
    this.skyboxUboF32[25] = g[1];
    this.skyboxUboF32[26] = g[2];
    this.skyboxUboF32[27] = 0;
    this.kernel.assets.writeBuffer(
      this.skyboxUbo,
      0,
      new Uint8Array(
        this.skyboxUboF32.buffer,
        this.skyboxUboF32.byteOffset,
        this.skyboxUboF32.byteLength,
      ),
    );
  }

  private recordSkyboxPass(
    rec: FrameRecorder,
    hdrColor: TextureOrTempId,
    camera: DesktopCameraInput,
    skybox: DesktopSkyboxInput,
  ): void {
    this.uploadSkyboxUniform(camera, skybox);
    const skyBind = rec.beginBindingSet().bindBuffer(0, this.skyboxUbo, 0).finish();
    rec.beginRenderPass({
      labelId: 10,
      colorAttachments: [{ texture: hdrColor, clearColor: [0, 0, 0, 1] }],
    });
    rec.drawFullscreen(this.skyboxShader, skyBind);
    rec.endRenderPass();
  }

  private recordPostPasses(
    rec: FrameRecorder,
    width: number,
    height: number,
    camera: DesktopCameraInput,
    hdrColor: TextureOrTempId,
    finalTarget: TextureOrTempId,
    isWitness: boolean,
  ): void {
    // Optional HDR Bloom (half-res bright-extract + H blur -> V blur -> additive composite onto hdrColor)
    if (camera.bloom?.enabled === true) {
      const bw = Math.max(1, width >> 1);
      const bh = Math.max(1, height >> 1);
      this.bloomUboF32[0] = camera.bloom.threshold ?? 1.0;
      this.bloomUboF32[1] = camera.bloom.intensity ?? 0.65;
      this.bloomUboF32[2] = 1 / bw;
      this.bloomUboF32[3] = 1 / bh;
      this.kernel.assets.writeBuffer(
        this.bloomUbo,
        0,
        new Uint8Array(
          this.bloomUboF32.buffer,
          this.bloomUboF32.byteOffset,
          this.bloomUboF32.byteLength,
        ),
      );
      const bloomA = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA16_FLOAT, bw, bh, 1, 1, 1, 0x14);
      const bloomB = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA16_FLOAT, bw, bh, 1, 1, 1, 0x14);

      const bindExtract = rec
        .beginBindingSet()
        .bindTexture(0, hdrColor)
        .bindSampler(1, this.postSampler)
        .bindBuffer(2, this.bloomUbo, 0)
        .finish();
      rec.beginRenderPass({
        labelId: 11,
        colorAttachments: [{ texture: bloomA, clearColor: [0, 0, 0, 1] }],
      });
      rec.drawFullscreen(this.bloomExtractHShader, bindExtract);
      rec.endRenderPass();

      const bindBlurV = rec
        .beginBindingSet()
        .bindTexture(0, bloomA)
        .bindSampler(1, this.postSampler)
        .bindBuffer(2, this.bloomUbo, 0)
        .finish();
      rec.beginRenderPass({
        labelId: 12,
        colorAttachments: [{ texture: bloomB, clearColor: [0, 0, 0, 1] }],
      });
      rec.drawFullscreen(this.bloomBlurVShader, bindBlurV);
      rec.endRenderPass();

      const bindComp = rec
        .beginBindingSet()
        .bindTexture(0, bloomB)
        .bindSampler(1, this.postSampler)
        .bindBuffer(2, this.bloomUbo, 0)
        .finish();
      rec.beginRenderPass({
        labelId: 13,
        colorAttachments: [{ texture: hdrColor, loadOp: 'load', storeOp: 'store' }],
      });
      rec.drawFullscreen(this.bloomCompositeShader, bindComp);
      rec.endRenderPass();
    }

    const postBind = rec
      .beginBindingSet()
      .bindTexture(0, hdrColor)
      .bindSampler(1, this.postSampler)
      .finish();
    const uiBind =
      this.uiOverlayActive && this.uiDynamicTexId !== undefined
        ? rec
            .beginBindingSet()
            .bindDynamicTexture(0, this.uiDynamicTexId)
            .bindSampler(1, this.postSampler)
            .finish()
        : 0;

    if (camera.fxaa === true) {
      this.fxaaUboF32[0] = 1 / Math.max(1, width);
      this.fxaaUboF32[1] = 1 / Math.max(1, height);
      this.fxaaUboF32[2] = width;
      this.fxaaUboF32[3] = height;
      this.kernel.assets.writeBuffer(
        this.fxaaUbo,
        0,
        new Uint8Array(
          this.fxaaUboF32.buffer,
          this.fxaaUboF32.byteOffset,
          this.fxaaUboF32.byteLength,
        ),
      );
      const ldrTemp = rec.acquireTempTexture(
        TEXTURE_FORMAT_RGBA8_UNORM,
        width,
        height,
        1,
        1,
        1,
        0x14,
      );
      rec.beginRenderPass({
        labelId: 3,
        colorAttachments: [{ texture: ldrTemp, clearColor: [0, 0, 0, 1] }],
      });
      rec.drawFullscreen(this.tonemapWitnessShader, postBind);
      rec.endRenderPass();

      const fxaaBind = rec
        .beginBindingSet()
        .bindTexture(0, ldrTemp)
        .bindSampler(1, this.postSampler)
        .bindBuffer(2, this.fxaaUbo, 0)
        .finish();
      rec.beginRenderPass({
        labelId: 14,
        colorAttachments: [{ texture: finalTarget, clearColor: [0, 0, 0, 1] }],
      });
      rec.drawFullscreen(
        isWitness || this.headless ? this.fxaaWitnessShader : this.fxaaSurfaceShader,
        fxaaBind,
      );
      if (uiBind !== 0) {
        rec.drawFullscreen(
          isWitness || this.headless ? this.uiOverlayWitnessShader : this.uiOverlaySurfaceShader,
          uiBind,
        );
      }
      rec.endRenderPass();
      return;
    }

    rec.beginRenderPass({
      labelId: 3,
      colorAttachments: [{ texture: finalTarget, clearColor: [0, 0, 0, 1] }],
    });
    rec.drawFullscreen(
      isWitness || this.headless ? this.tonemapWitnessShader : this.tonemapSurfaceShader,
      postBind,
    );
    if (uiBind !== 0) {
      rec.drawFullscreen(
        isWitness || this.headless ? this.uiOverlayWitnessShader : this.uiOverlaySurfaceShader,
        uiBind,
      );
    }
    rec.endRenderPass();
  }

  /**
   * Non-blocking fire-and-forget frame submission from an incremental delta (dirty transforms +
   * spawns/despawns only), avoiding O(N) unchanged-entity scans on the JS main thread.
   */
  submitIncrementalFrameAsync(input: DesktopIncrementalFrameInput): Result<number, KernelError> {
    const sync = this.buildIncrementalSceneDelta(input);
    return this.recordAndSubmitAsync(input.width, input.height, input.camera, input.skybox, sync);
  }

  /**
   * Non-blocking fire-and-forget frame submission to the dedicated OS render thread.
   * Synchronizes only dirty transforms/spawns/despawns/materials and submits the full 3-pass
   * 4-BGL pipeline (Shadow Depth -> HDR Opaque + Transparent -> ACES Tonemap to swapchain).
   */
  submitFrameAsync(input: DesktopFrameInput): Result<number, KernelError> {
    const sync = this.buildSceneDelta(input);
    return this.recordAndSubmitAsync(input.width, input.height, input.camera, input.skybox, sync);
  }

  private recordShadowDepthPass(
    rec: FrameRecorder,
    camera: DesktopCameraInput,
    vSlice: { readonly offset: number; readonly length: number },
    shadowDepth: TextureOrTempId,
    shadowCullIds: readonly CullId[] | null,
  ): BindingSetId {
    const cascadeCount = this.activeCascadeCount;
    const isTiled = cascadeCount > 1;
    const tileDim = this.shadowMapSize;
    rec.beginRenderPass({
      labelId: 1,
      colorAttachments: [],
      depthAttachment: {
        texture: shadowDepth,
        loadOp: 'clear',
        storeOp: 'store',
        clearDepth: 1.0,
      },
    });
    for (let c = 0; c < cascadeCount; c++) {
      let shadowSlice = vSlice;
      if (c > 0) {
        this.shadowViewUboF32.set(camera.viewProj, 0);
        this.shadowViewUboF32.set(this.cascadeVps[c] as Float32Array, 16);
        shadowSlice = rec.writeUniform(this.shadowViewUboBytes);
      }
      if (isTiled) {
        const tx = (c & 1) * tileDim;
        const ty = ((c >> 1) & 1) * tileDim;
        rec.setViewport(tx, ty, tileDim, tileDim, 0, 1);
        rec.setScissor(tx, ty, tileDim, tileDim);
      }
      const cullId = shadowCullIds !== null ? (shadowCullIds[c] as CullId) : ((c + 1) as CullId);
      rec.drawRenderers({
        cullId,
        passTag: PASS_TAG_SHADOW_DEPTH,
        sortMode: SORT_MATERIAL_PSO,
        drawFlags: DRAW_FLAG_INSTANCING | DRAW_FLAG_SHADOW_CASTER_ONLY,
        queueMin: 0,
        queueMax: 2450,
        viewUniformOffset: shadowSlice.offset,
        viewUniformLength: shadowSlice.length,
        overrideShader: this.shadowShader,
        passAttachmentId: 1,
      });
      if (this.skinnedObjectCount > 0) {
        rec.drawRenderers({
          cullId,
          passTag: PASS_TAG_SHADOW_DEPTH,
          sortMode: SORT_MATERIAL_PSO,
          drawFlags: DRAW_FLAG_INSTANCING | DRAW_FLAG_SHADOW_CASTER_ONLY,
          queueMin: 2451,
          queueMax: 2490,
          viewUniformOffset: shadowSlice.offset,
          viewUniformLength: shadowSlice.length,
          overrideShader: this.skinnedShadowShader,
          passAttachmentId: 1,
        });
      }
    }
    rec.endRenderPass();
    return rec.beginBindingSet().bindTexture(0, shadowDepth).finish();
  }

  private recordForwardScenePass(
    rec: FrameRecorder,
    hdrColor: TextureOrTempId,
    mainDepth: TextureOrTempId,
    camera: DesktopCameraInput,
    skybox: DesktopSkyboxInput | undefined,
    mainCullId: CullId,
    vSlice: { readonly offset: number; readonly length: number },
    shadowBind: BindingSetId | 0,
    hasTransparent: boolean,
  ): void {
    if (skybox !== undefined) {
      this.recordSkyboxPass(rec, hdrColor, camera, skybox);
    }

    const clearColor = camera.clearColor ?? this.defaultClearColor;
    const layerMask = camera.cullMask ?? 0xffff_ffff;
    rec.beginRenderPass({
      labelId: 2,
      colorAttachments: [
        skybox !== undefined
          ? { texture: hdrColor, loadOp: 'load', storeOp: 'store' }
          : { texture: hdrColor, clearColor },
      ],
      depthAttachment: {
        texture: mainDepth,
        loadOp: 'clear',
        storeOp: 'discard',
        clearDepth: 1.0,
      },
    });
    rec.drawRenderers({
      cullId: mainCullId,
      passTag: PASS_TAG_FORWARD_OPAQUE,
      sortMode: SORT_MATERIAL_PSO,
      drawFlags: DRAW_FLAG_INSTANCING,
      queueMin: 0,
      queueMax: 2500,
      layerMask,
      viewUniformOffset: vSlice.offset,
      viewUniformLength: vSlice.length,
      extraBindings: shadowBind,
      passAttachmentId: 2,
    });
    if (hasTransparent) {
      rec.drawRenderers({
        cullId: mainCullId,
        passTag: PASS_TAG_FORWARD_TRANSPARENT,
        sortMode: SORT_BACK_TO_FRONT,
        drawFlags: 0,
        queueMin: 2501,
        queueMax: 5000,
        layerMask,
        viewUniformOffset: vSlice.offset,
        viewUniformLength: vSlice.length,
        extraBindings: shadowBind,
        passAttachmentId: 2,
      });
    }
    rec.endRenderPass();
  }

  private cullShadowCascades(): Result<readonly CullId[], KernelError> {
    const shadowCullIds: CullId[] = [];
    for (let c = 0; c < this.activeCascadeCount; c++) {
      const shadowCull = this.kernel.cull({
        viewProj: this.cascadeVps[c] as Float32Array,
        cameraPos: this.cascadeCamPositions[c] as readonly [number, number, number],
      });
      if (!shadowCull.ok) return shadowCull;
      shadowCullIds.push(shadowCull.value.cullId);
    }
    return ok(shadowCullIds);
  }

  private recordAndSubmitAsync(
    rawWidth: number,
    rawHeight: number,
    camera: DesktopCameraInput,
    skybox: DesktopSkyboxInput | undefined,
    sync: {
      readonly hasDelta: boolean;
      readonly hasTransparent: boolean;
      readonly hasShadowLight: boolean;
    },
  ): Result<number, KernelError> {
    const width = Math.max(1, rawWidth | 0);
    const height = Math.max(1, rawHeight | 0);

    this.frameCounter += 1;
    const frameId = this.frameCounter;
    const rec = this.kernel.preparePipelinedRecorder(frameId, width, height);
    const vSlice = rec.writeUniform(this.viewUboBytes);

    const hdrColor = rec.acquireTempTexture(
      TEXTURE_FORMAT_RGBA16_FLOAT,
      width,
      height,
      1,
      1,
      1,
      0x14,
    );
    const mainDepth = rec.acquireTempTexture(
      TEXTURE_FORMAT_DEPTH32_FLOAT,
      width,
      height,
      1,
      1,
      1,
      0x10,
    );
    const finalTarget: TextureOrTempId = this.headless
      ? rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, width, height, 1, 1, 1, 0x11)
      : (SURFACE_SWAPCHAIN_HANDLE as unknown as TextureOrTempId);

    const culls: KernelCullParams[] = [];
    let mainCullId = 1 as CullId;
    let shadowBind: BindingSetId | 0 = 0;

    if (sync.hasShadowLight) {
      const cascadeCount = this.activeCascadeCount;
      const atlasDim = cascadeCount > 1 ? this.shadowMapSize * 2 : this.shadowMapSize;
      const shadowDepth = rec.acquireTempTexture(
        TEXTURE_FORMAT_DEPTH32_FLOAT,
        atlasDim,
        atlasDim,
        1,
        1,
        1,
        0x14,
      );
      for (let c = 0; c < cascadeCount; c++) {
        culls.push({
          viewProj: this.cascadeVps[c] as Float32Array,
          cameraPos: this.cascadeCamPositions[c] as readonly [number, number, number],
        });
      }
      mainCullId = (cascadeCount + 1) as CullId;
      shadowBind = this.recordShadowDepthPass(rec, camera, vSlice, shadowDepth, null);
    }

    culls.push({
      viewProj: camera.viewProj,
      cameraPos: camera.position,
      layerMask: camera.cullMask ?? 0xffff_ffff,
    });

    this.recordForwardScenePass(
      rec,
      hdrColor,
      mainDepth,
      camera,
      skybox,
      mainCullId,
      vSlice,
      shadowBind,
      sync.hasTransparent,
    );
    this.featureHost.recordWithPost(
      rec,
      {
        width,
        height,
        hdrColor,
        mainDepth,
        outputTarget: finalTarget,
        postSampler: this.postSampler,
        viewUniformOffset: vSlice.offset,
        viewUniformLength: vSlice.length,
      },
      () => this.recordPostPasses(rec, width, height, camera, hdrColor, finalTarget, false),
    );

    return this.kernel.submitPipelinedFrameAsync(rec, {
      ...(sync.hasDelta ? { delta: this.deltaWriter } : {}),
      culls,
    });
  }

  registerFeature(
    feature: import('../graph/types.js').KernelRenderFeature<DesktopFeatureFrameContext>,
  ): Result<void, KernelError> {
    return this.featureHost.register(feature);
  }
  unregisterFeature(name: string): boolean {
    return this.featureHost.unregister(name);
  }
  setFeatureEnabled(name: string, enabled: boolean): boolean {
    return this.featureHost.setEnabled(name, enabled);
  }

  /**
   * Executes one deterministic synchronous frame to an offscreen `rgba8unorm` texture and returns
   * both the FrameSubmitReceipt and readback RGBA8 pixels for visual/pixel-witness verification.
   */
  renderWitnessFrame(input: DesktopFrameInput): Result<DesktopWitnessFrameResult, KernelError> {
    const width = Math.max(1, input.width | 0);
    const height = Math.max(1, input.height | 0);
    const sync = this.buildSceneDelta(input);

    if (sync.hasDelta) {
      const committed = this.kernel.commitSceneDelta(this.deltaWriter);
      if (!committed.ok) return committed;
    }

    this.frameCounter += 1;
    const recRes = this.kernel.beginFrame(this.frameCounter, width, height);
    if (!recRes.ok) return recRes;
    const rec = recRes.value;
    const vSlice = rec.writeUniform(this.viewUboBytes);

    let shadowBind: BindingSetId | 0 = 0;
    let witnessPoolSlot = 3; // hdr(1), depth(2), witness(3) without shadow; or +1 with shadow

    if (sync.hasShadowLight) {
      const shadowCullsRes = this.cullShadowCascades();
      if (!shadowCullsRes.ok) return shadowCullsRes;
      const atlasDim = this.activeCascadeCount > 1 ? this.shadowMapSize * 2 : this.shadowMapSize;
      const shadowDepth = rec.acquireTempTexture(
        TEXTURE_FORMAT_DEPTH32_FLOAT,
        atlasDim,
        atlasDim,
        1,
        1,
        1,
        0x14,
      );
      witnessPoolSlot = 4;
      shadowBind = this.recordShadowDepthPass(
        rec,
        input.camera,
        vSlice,
        shadowDepth,
        shadowCullsRes.value,
      );
    }

    const mainCull = this.kernel.cull({
      viewProj: input.camera.viewProj,
      cameraPos: input.camera.position,
      layerMask: input.camera.cullMask ?? 0xffff_ffff,
    });
    if (!mainCull.ok) return mainCull;

    const hdrColor = rec.acquireTempTexture(
      TEXTURE_FORMAT_RGBA16_FLOAT,
      width,
      height,
      1,
      1,
      1,
      0x14,
    );
    const mainDepth = rec.acquireTempTexture(
      TEXTURE_FORMAT_DEPTH32_FLOAT,
      width,
      height,
      1,
      1,
      1,
      0x10,
    );
    const witnessOut = rec.acquireTempTexture(
      TEXTURE_FORMAT_RGBA8_UNORM,
      width,
      height,
      1,
      1,
      1,
      0x11,
    );

    this.recordForwardScenePass(
      rec,
      hdrColor,
      mainDepth,
      input.camera,
      input.skybox,
      mainCull.value.cullId,
      vSlice,
      shadowBind,
      sync.hasTransparent,
    );
    this.featureHost.recordWithPost(
      rec,
      {
        width,
        height,
        hdrColor,
        mainDepth,
        outputTarget: witnessOut,
        postSampler: this.postSampler,
        viewUniformOffset: vSlice.offset,
        viewUniformLength: vSlice.length,
      },
      () => this.recordPostPasses(rec, width, height, input.camera, hdrColor, witnessOut, true),
    );

    const receiptRes = this.kernel.submitFrame(rec);
    if (!receiptRes.ok) return receiptRes;

    // Resolve the exact physical pool slot ID of the final pass's color attachment from
    // resolvedPhysicalCommands so prior async frames or optional post passes never shift slots.
    const resolvedSlot = resolveWitnessPoolSlot(
      receiptRes.value.resolvedPhysicalCommands,
      witnessPoolSlot,
    );
    const readbackRes = this.kernel.readbackPoolTexture(resolvedSlot);
    if (!readbackRes.ok) return readbackRes;

    return ok({
      receipt: receiptRes.value,
      image: readbackRes.value,
    });
  }

  /**
   * Uploads an RGBA8 UI overlay (e.g., Blitz UI raster output) into a retained DynamicTexture
   * and composites it with alpha blending over the tonemapped 3D output in the final pass.
   * Same-size updates write in place with zero GPU texture reallocation.
   */
  setUiOverlayRgba(
    width: number,
    height: number,
    rgbaBytes: Uint8Array,
    revision?: number,
  ): Result<boolean, KernelError> {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    if (this.uiDynamicTexId === undefined) {
      const created = this.kernel.assets.createDynamicTexture({
        width: w,
        height: h,
        format: TEXTURE_FORMAT_RGBA8_UNORM,
        label: 'desktop-ui-overlay',
      });
      if (!created.ok) return created;
      this.uiDynamicTexId = created.value;
    }
    const rev = revision ?? this.uiOverlayRevision + 1;
    this.uiOverlayRevision = rev;
    const up = this.kernel.assets.uploadDynamicTexture(this.uiDynamicTexId, rev, w, h, rgbaBytes);
    if (!up.ok) return up;
    this.lastUiOverlay = { width: w, height: h, rgbaBytes: rgbaBytes.slice(), revision: rev };
    this.uiOverlayActive = true;
    return up;
  }

  clearUiOverlay(): void {
    this.uiOverlayActive = false;
    this.lastUiOverlay = undefined;
  }

  /**
   * Uploads immediate-mode 3D debug line segments (`[x, y, z, r, g, b, a]` = 7 floats per vertex;
   * pairs of vertices form line segments) rendered with depth testing via `line-list` topology.
   */
  setDebugLines(vertices: Float32Array | null): Result<void, KernelError> {
    const prevMeshId = this.debugLinesMeshId;
    if (vertices === null || vertices.length < DESKTOP_DEBUG_LINE_VERTEX_STRIDE_FLOATS * 2) {
      this.debugLinesMeshId = undefined;
      this.lastDebugLines = undefined;
      this.debugLinesDirty = true;
      if (prevMeshId !== undefined) {
        this.kernel.assets.destroyMesh(prevMeshId);
      }
      return ok(undefined);
    }
    const vertexCount = Math.floor(vertices.length / DESKTOP_DEBUG_LINE_VERTEX_STRIDE_FLOATS) & ~1;
    const byteLen = vertexCount * DESKTOP_DEBUG_LINE_VERTEX_STRIDE_FLOATS * 4;
    const created = this.kernel.assets.createMesh(
      {
        vertexLayoutId: 6,
        vertexCount,
        indexCount: 0,
        isUint32Index: false,
        label: 'desktop-debug-lines',
      },
      new Uint8Array(vertices.buffer, vertices.byteOffset, byteLen),
    );
    if (!created.ok) return created;
    this.debugLinesMeshId = created.value;
    this.lastDebugLines = vertices.slice(0, vertexCount * DESKTOP_DEBUG_LINE_VERTEX_STRIDE_FLOATS);
    this.debugLinesDirty = true;
    if (prevMeshId !== undefined) {
      this.kernel.assets.destroyMesh(prevMeshId);
    }
    return ok(undefined);
  }

  clearDebugLines(): void {
    this.setDebugLines(null);
  }

  /** Drops all cached transient RT pool textures and returns the GPU bytes freed. */
  trimPoolTextures(): Result<number, KernelError> {
    return this.kernel.trimPoolTextures();
  }

  private applyBuiltinResources(b: BuiltinDesktopResources): void {
    this.shadowShader = b.shadowShader;
    this.skinnedShadowShader = b.skinnedShadowShader;
    this.litShader = b.litShader;
    this.skinnedLitShader = b.skinnedLitShader;
    this.tonemapSurfaceShader = b.tonemapSurfaceShader;
    this.tonemapWitnessShader = b.tonemapWitnessShader;
    this.uiOverlaySurfaceShader = b.uiOverlaySurfaceShader;
    this.uiOverlayWitnessShader = b.uiOverlayWitnessShader;
    this.skyboxShader = b.skyboxShader;
    this.bloomExtractHShader = b.bloomExtractHShader;
    this.bloomBlurVShader = b.bloomBlurVShader;
    this.bloomCompositeShader = b.bloomCompositeShader;
    this.fxaaSurfaceShader = b.fxaaSurfaceShader;
    this.fxaaWitnessShader = b.fxaaWitnessShader;
    this.debugLineMaterialId = b.debugLineMaterialId;
    this.skyboxUbo = b.skyboxUbo;
    this.bloomUbo = b.bloomUbo;
    this.fxaaUbo = b.fxaaUbo;
    this.linearSampler = b.linearSampler;
    this.postSampler = b.postSampler;
  }

  private resetSceneStateForRecovery(): void {
    this.trackedObjects.clear();
    this.pendingMaterialUpdates.clear();
    this.pendingMaterialRebinds.clear();
    this.pendingSkinUploads.length = 0;
    this.skinPalettes.clear();
    this.nextSkinJointOffset = 0;
    this.skinnedObjectCount = 0;
    this.transparentObjectCount = 0;
    this.sceneRevision = 0;
    this.lastLightsDigest = '';
    this.nextObjectId = 1;
    this.uiDynamicTexId = undefined;
    this.debugLinesMeshId = undefined;
    this.debugLinesActive = false;
    this.debugLinesDirty = false;
  }

  private replayCachedResourcesForRecovery(): Result<void, KernelError> {
    for (const [key, rec] of this.customShaders) {
      const rebuilt = this.registerCustomShaderProgram(key, rec.wgslCode, rec.options);
      if (!rebuilt.ok) return rebuilt;
      rec.shaderId = rebuilt.value;
    }

    this.textures.clear();
    for (const [, texInput] of this.textureInputs) {
      const up = this.ensureTexture(texInput);
      if (!up.ok) return up;
    }

    const savedMeshes = Array.from(this.meshes.values()).map((m) => m.input);
    this.meshes.clear();
    for (const meshInput of savedMeshes) {
      const up = this.ensureMesh(meshInput);
      if (!up.ok) return up;
    }

    const savedMaterials = Array.from(this.materials.values()).map((m) => ({
      input: m.input,
      params: m.params.slice(),
    }));
    this.materials.clear();
    for (const saved of savedMaterials) {
      const up = this.ensureMaterial(saved.input);
      if (!up.ok) return up;
    }

    if (this.uiOverlayActive && this.lastUiOverlay !== undefined) {
      const ui = this.lastUiOverlay;
      const up = this.setUiOverlayRgba(ui.width, ui.height, ui.rgbaBytes, ui.revision);
      if (!up.ok) return up;
    }
    if (this.lastDebugLines !== undefined) {
      const up = this.setDebugLines(this.lastDebugLines);
      if (!up.ok) return up;
    }
    return ok(undefined);
  }

  /**
   * Recovers from a GPU device loss: recreates the native `wgpu::Device`/`Queue`/`Surface` on the
   * dedicated render thread, rebuilds all built-in shaders/UBOs/samplers, replays all cached
   * custom shaders, textures, meshes, materials, UI overlay, and debug lines, and resets retained
   * scene state so the next frame renders seamlessly with identical visual output.
   */
  recover(): Result<number, KernelError> {
    const genRes = this.kernel.recoverDevice();
    if (!genRes.ok) return genRes;

    const builtinRes = initBuiltinDesktopResources(this.kernel, this.headless, this.surfaceFormat);
    if (!builtinRes.ok) return builtinRes;
    this.applyBuiltinResources(builtinRes.value);
    this.resetSceneStateForRecovery();

    const replayRes = this.replayCachedResourcesForRecovery();
    if (!replayRes.ok) return replayRes;

    return ok(genRes.value);
  }

  pollWindowEvents(): Result<readonly NativeWindowEvent[], KernelError> {
    return this.kernel.pollWindowEvents();
  }

  resizeWindow(width: number, height: number): Result<void, KernelError> {
    return this.kernel.resizeWindow(width, height);
  }

  getWindowPhysicalSize(): Result<readonly [number, number], KernelError> {
    return this.kernel.getWindowPhysicalSize();
  }

  getWindowFacts(): Result<NativeWindowFacts, KernelError> {
    return this.kernel.getWindowFacts();
  }

  requestRedraw(): Result<void, KernelError> {
    return this.kernel.requestRedraw();
  }

  setPointerLock(locked: boolean): Result<boolean, KernelError> {
    return this.kernel.setPointerLock(locked);
  }

  setImeArea(area: readonly [number, number, number, number] | null): Result<number, KernelError> {
    return this.kernel.setImeArea(area);
  }

  flush(): Result<void, KernelError> {
    return this.kernel.flush();
  }

  getStats(): Result<DesktopSceneStats, KernelError> {
    const thread = this.kernel.getThreadStats();
    if (!thread.ok) return thread;
    return ok({
      thread: thread.value,
      trackedObjects: this.trackedObjects.size,
      cachedMeshes: this.meshes.size,
      cachedMaterials: this.materials.size,
      cachedTextures: this.textures.size,
      sceneRevision: this.sceneRevision,
      framesSubmitted: this.frameCounter,
      lastDirtyTransformCount: this.lastDirtyTransformCount,
      lastUpsertCount: this.lastUpsertCount,
      lastRemoveCount: this.lastRemoveCount,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.kernel.dispose();
  }
}

export function createDesktopNativeSceneRenderer(
  options?: DesktopNativeSceneRendererOptions,
): Result<DesktopNativeSceneRenderer, KernelError> {
  const headless = options?.headless ?? options?.window === undefined;
  const kernelOptions: CreateNativeRenderKernelOptions = {
    maxInFlight: options?.maxInFlight ?? 2,
    ...(options?.addonPath !== undefined ? { addonPath: options.addonPath } : {}),
    ...(!headless && options?.window !== undefined ? { window: options.window } : {}),
  };
  const kernelRes = createNativeRenderKernel(kernelOptions);
  if (!kernelRes.ok) return kernelRes;
  const kernel = kernelRes.value;

  const initStatsRes = kernel.getThreadStats();
  if (!initStatsRes.ok) {
    kernel.dispose();
    return initStatsRes;
  }
  const surfaceFormat = (initStatsRes.value.surfaceFormat ?? 'bgra8unorm') as GPUTextureFormat;
  const builtinRes = initBuiltinDesktopResources(kernel, headless, surfaceFormat);
  if (!builtinRes.ok) {
    kernel.dispose();
    return builtinRes;
  }

  return ok(
    new DesktopNativeSceneRenderer(kernel, {
      ...builtinRes.value,
      headless,
      surfaceFormat,
      shadowMapSize: options?.shadowMapSize ?? 1024,
      defaultClearColor: options?.defaultClearColor ?? [0.05, 0.08, 0.14, 1],
      defaultAmbientColor: options?.defaultAmbientColor ?? [0.14, 0.17, 0.22],
    }),
  );
}
