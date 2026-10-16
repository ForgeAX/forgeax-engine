#define_import_path forgeax_material::sprite
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis PER_INSTANCE_REGION

#import forgeax_clipping::planes::{applyViewClipping}
#import forgeax_view::common::{View, Mesh, meshMotionValid, InstanceData, view, meshes, instances, sampleMaterialTexture}
#import forgeax_view::fog::{translucent_fog}
#import forgeax_scene_temporal::{packSceneTemporalV1WithValidity}

// @forgeax/engine-shader - sprite.wgsl (feat-20260520-2d-sprite-layer-mvp /
// M-3 / w19). 2D sprite material — third variant of the MaterialAsset
// closed union (after 'unlit' and 'standard'). Pairs with the sprite
// alpha-blend pipeline (LDR + HDR variants; w24 createRenderer registration).
//
// Anchors:
//   - requirements §3 AC-04 (vertex pos_local = (uv - pivot) * size +
//     uv_atlas single-mad Q7 origin+size; fragment textureSample *
//     colorTint; sprite is unlit per Q14; HDR clamp 0..1 R6 mitigation)
//   - requirements §2.1.D shader table
//   - requirements §6 R5 mitigation (sprite shader must NOT read the
//     directional-light fields of the View UBO — sprite is unlit per Q14,
//     9/9 industry-default; charter P4 consistent abstraction)
//   - requirements §6 R6 mitigation (HDR alpha blend boundary; sprite
//     fragment output strictly clamped to [0, 1] before premultiplied
//     alpha multiply)
//   - plan-strategy §2 D-1 candidate (b) (sprite material reuses the PBR
//     7-entry BindGroup layout; 4 unused entries 3..6 default to
//     `pipelineState.defaultSampler` + `pipelineState.defaultWhiteTextureView`;
//     0 lines new code on the BindGroup placeholders, 4 lines binding ref)
//   - plan-strategy §2 D-9 (sprite shares the 112 B std140 View UBO with
//     PBR; do NOT split off a sprite-specific View — charter P4 abstraction
//     uniformity; static reads of the directional-light fields simply
//     never happen, GPU pays zero perf for the unused fields)
//   - research §Finding C-1 (`common.wgsl:17-22` View struct + naga_oil
//     0.22 Composer #import resolves View / Mesh / view / meshes at compile
//     time; ShaderRegistry manifest path loadEngineShaderEntries adds a
//     4th entry in w20)
//
// Material bindings are derived from the sprite paramSchema; view, mesh and
// instance groups remain shared with the ordinary material pipeline:
//
//   @group(0) @binding(0) view                       uniform   (sprite reads
//                                                               view.worldViewProj
//                                                               only)
//   @group(1) @binding(0) material                   uniform   (sprite layout:
//                                                               colorTint vec4
//                                                               + region vec4
//                                                               + pivotAndSize
//                                                               vec4; 48 B)
//   @group(1) @binding(1) baseColorSampler           sampler
//   @group(1) @binding(2) baseColorTexture           texture_2d<f32>
//   @group(2) @binding(0) meshes                     storage   (sprite reads
//                                                               meshes[0]
//                                                               .worldFromLocal
//                                                               only — normal
//                                                               matrix unused)
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance
//                                                               mat4; see
//                                                               common.wgsl)
//
// SSOT:
//   sprite is unlit; do NOT read the directional-light fields of the
//   View UBO — sprite.wgsl 1+1 line hard rule above and below; R5
//   mitigation.
//
// @reuses forgeax_view::common View (112 B std140) — w19 imports the same
//   View struct PBR / unlit consume so the 4-BindGroupLayout chain is
//   pipeline-pipeline shareable; w24 sprite alpha-blend pipeline reuses
//   pipelineState.viewBindGroupLayout / .materialBindGroupLayout /
//   .meshBindGroupLayout / .instancesBindGroupLayout without a new BGL.
// @reuses MaterialBindGroup 7-entry PBR layout (4 unused entries 3..6 bind
//   pipelineState.defaultSampler + pipelineState.defaultWhiteTextureView —
//   plan-strategy D-1 candidate (b); 0 lines new GPU resource, 4 lines new
//   binding ref).
// @new-surface sprite fragment output strictly clamped to [0, 1] before
//   premultiplied-alpha multiply (R6 HDR alpha blend boundary mitigation;
//   the sprite path runs through the same HDR rgba16float target as PBR
//   when the active camera carries `tonemap !== 'none'`, so unclamped
//   output would otherwise feed NaN / Inf into the tonemap fullscreen pass).

struct Material {
  // .xyz multiplies textureSample.rgb; .w multiplies textureSample.a.
  // AI users supply via SpriteMaterialAsset.colorTint (default [1,1,1,1]).
  colorTint    : vec4<f32>,
  // Atlas region: .xy = (uMin, vMin) origin, .zw = (uW, vH) size. Single
  // mad uv_atlas = uv * region.zw + region.xy. Host folds flipX / flipY
  // into region (flipX -> region.x += region.z; region.z = -region.z;
  // analog for Y) so the shader does not need an extra flip uniform.
  region       : vec4<f32>,
  // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w11 (D-6):
  // pivotAndSize.xy = pivot (0..1 normalised; (0,0)=top-left, (1,1)=
  // bottom-left of texture UV space). The legacy .zw=size pair is now
  // a DEAD SLOT — the sprite quad is a local-space unit quad (1x1) and
  // world scale flows entirely through meshes[i].worldFromLocal, no
  // longer double-applied by both the UBO size factor and the world
  // matrix (research F-4 "scale^2 -> scale^1" correction). The .zw
  // half stays in the struct so the std140 layout slot 2 is byte-stable
  // for the generic UBO writer (plan-strategy D-2 derive(uboLayout)
  // offsets); shaders MUST NOT read material.pivotAndSize.zw post-w11.
  pivotAndSize : vec4<f32>,
  // 9-slice placeholder (feat-20260527-sprite-nineslice M1 / w3): .xyz =
  // L/T/R/B inset values folded into a single vec4 by the schema-driven
  // UBO writer (M2), .w = mode signed-encoded (positive = stretch / 0,
  // negative = tile per plan-strategy section D-3 sliceMode-on-vec4.w
  // sentinel). M1 is placeholder-only — vs_main / fs_main do NOT read
  // this field; the field exists so the std140 layout has slot 3 reserved
  // at the wgsl side, letting the M2 record-stage writer hit a byte-stable
  // offset (plan-strategy D-7 byte-stable UBO write contract).
  // sprite UBO grows 48 B -> 64 B; legacy sprite renders byte-identically
  // because slicesAndMode is never sampled in the vertex / fragment paths
  // when slices=[0,0,0,0] (zero-branch GPU path).
  slicesAndMode : vec4<f32>,
  baseColorTextureCoordinatesTransform : vec4<f32>,
  baseColorTextureCoordinatesMetadata : vec4<f32>,
  baseColorTextureCoordinatesRotation : vec4<f32>,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
// Preserve filtering reflection for the bound texture passed to the helper.
fn materialTextureFilteringWitness() {
  let base = baseColorTexture;
  let baseWitness = textureSample(base, baseColorSampler, vec2<f32>(0.0));
}

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

struct VsOut {
  @builtin(position) @invariant clip     : vec4<f32>,
  // Atlas-space UV: already folded through region origin + size by the
  // vertex stage so the fragment can sample the bound material texture at
  // `in.uv_atlas` without any host-side region
  // re-write per draw.
  @location(0) uv_atlas       : vec2<f32>,
  @location(1) worldPos        : vec3<f32>,
};

struct SpriteVertex {
  posLocal : vec3<f32>,
  uvAtlas : vec2<f32>,
};

fn resolveSpriteVertex(in : VsIn, idx : u32, vertex_index : u32) -> SpriteVertex {
  // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w11 (D-6):
  // pos_local = (uv - pivot) * 1, NOT (uv - pivot) * size. The sprite quad
  // is now a UNIT QUAD in local space ([-pivot, 1-pivot]) and world scale
  // flows entirely through meshes[i].worldFromLocal. Pre-w11 the UBO's
  // pivotAndSize.zw scaled the local quad AND the world matrix also scaled
  // it, producing the scale^2 visual size debt that research F-4 flagged.
  // Post-w11 there is one and only one scale source: the entity's
  // GlobalTransform.world. The mesh's built-in vertex.pos is NOT consumed (sprite
  // geometry is fully re-derived from uv + pivot) so HANDLE_QUAD's mesh.pos
  // remains a placeholder driving vertex count (4) and topology only.
  //
  // Compensation: since bug-20260601-procedural-geometry-uv-v-axis-vs-webgpu-sampler-ori
  // M1 flipped procedural HANDLE_QUAD from bottom-left V (1-t) to top-left
  // V (t) to match the WebGPU sampler convention, the sprite's uv-derived
  // geometry must be restored to the pre-M1 bottom-left convention so that
  // position, triangle winding (cull:back, frontFace:ccw), and atlas sampling
  // are byte-identical. We define uv_eff = (in.uv.x, 1 - in.uv.y) and consume
  // it in BOTH pos_local and uv_atlas below.
  let pivot = material.pivotAndSize.xy;

  // feat-20260527-sprite-nineslice M3 / w15 (plan-strategy section D-3 + D-4):
  // 9-region map. Early-out when slicesAndMode is the all-zero sentinel so
  // the legacy single-quad path stays byte-identical for sprites without
  // slices (zero-slice sprite users pay zero perf for the new feature). When
  // useSlices fires, the 16-vertex HANDLE_NINESLICE_QUAD mesh is bound by
  // the record stage (D-2); we reinterpret vertex_index as a 4x4 grid (i =
  // column 0..3, j = row 0..3) and route each grid point through 4 anchor
  // lanes:
  //   u_pos_arr / v_pos_arr -> position anchors (atlas-UV space, mapped to
  //                              world via legacy `(u - pivot) * 1`)
  //   u_uv_arr / v_uv_arr   -> atlas UV anchors (region-local, then folded
  //                              through region.zw / region.xy)
  // Stretch mode (slicesAndMode.w >= 0): u/v_uv_arr == u/v_pos_arr, the
  // middle band UV stays in [slice, 1-slice]. Tile mode (slicesAndMode.w
  // < 0): the middle UV anchors are pushed past 1.0 so the sampler with
  // addressMode='repeat' (D-4 sampler.repeat path; D-9 register-time
  // soft-warn flags missing repeat) wraps the middle band and re-emits
  // the texture. Vertex shader does NOT call wgsl `fract` — the wrap is
  // entirely sampler-driven (charter P3 + plan-strategy D-4 fract veto).
  let useSlices = any(material.slicesAndMode != vec4<f32>(0.0));
  var pos_local : vec3<f32>;
  var uv_atlas : vec2<f32>;
  if (useSlices) {
    let abs_slices = abs(material.slicesAndMode);
    let is_tile = material.slicesAndMode.w < 0.0;
    let i = vertex_index % 4u;
    let j = vertex_index / 4u;

    // 4 anchors in atlas-UV space (top-left convention).
    let u_pos_arr = array<f32, 4>(0.0, abs_slices.x, 1.0 - abs_slices.z, 1.0);
    let v_pos_arr = array<f32, 4>(0.0, abs_slices.y, 1.0 - abs_slices.w, 1.0);
    let u_pos = u_pos_arr[i];
    let v_pos_top = v_pos_arr[j];
    // Flip V to bottom-left convention before the legacy `(u - pivot) * 1`.
    let v_pos_eff = 1.0 - v_pos_top;
    pos_local = vec3<f32>(u_pos - pivot.x, v_pos_eff - pivot.y, 0.0);

    // UV anchors. Stretch == position anchors. Tile pushes middle past 1.
    var u_uv_arr = array<f32, 4>(0.0, abs_slices.x, 1.0 - abs_slices.z, 1.0);
    var v_uv_arr = array<f32, 4>(0.0, abs_slices.y, 1.0 - abs_slices.w, 1.0);
    if (is_tile) {
      let mid_u = 1.0 - abs_slices.x - abs_slices.z;
      let mid_v = 1.0 - abs_slices.y - abs_slices.w;
      // One full retile across the middle band: anchor[2] = corner_left +
      // 2 * mid; anchor[3] keeps the right-corner UV span attached.
      u_uv_arr[2] = abs_slices.x + 2.0 * mid_u;
      u_uv_arr[3] = u_uv_arr[2] + abs_slices.z;
      v_uv_arr[2] = abs_slices.y + 2.0 * mid_v;
      v_uv_arr[3] = v_uv_arr[2] + abs_slices.w;
    }
    let uv_u = u_uv_arr[i];
    let uv_v_top = v_uv_arr[j];
    let uv_v_eff = 1.0 - uv_v_top;
    uv_atlas = vec2<f32>(uv_u, uv_v_eff) * material.region.zw + material.region.xy;
  } else {
    let uv_eff = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
    pos_local = vec3<f32>(uv_eff - pivot, 0.0);
    // Q7 single-mad uv_atlas = uv * region.zw + region.xy. host folds
    // flipX / flipY by negating region.zw + offsetting region.xy so this
    // formula handles every flip case without a per-fragment branch.
    //
    // M2 compensation note: uv_eff restores the pre-M1 bottom-left V
    // convention for the vertex stage. The host fold of flipY into region
    // operates on atlas-space coordinates independently — no double-flip
    // risk, because the region adjustment is a linear transform applied
    // after uv_eff and neither path depends on the other's sign convention.
    //
    // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M2 /
    // w7 (plan-strategy §2 D-5 + research §Q-R-4.4): when the sprite
    // pipeline composes this module with PER_INSTANCE_REGION=true the
    // region source is the per-instance value carried in
    // `instances[idx].region` (host-uploaded 80 B-per-instance interleaved
    // buffer; D-1 + D-9). When PER_INSTANCE_REGION is unset (legacy
    // sprite-atlas / non-SpriteInstances entities) the region still comes
    // from the material UBO. The 9-slice branch above keeps reading
    // `material.region` regardless — 9-slice config is material-level by
    // construction (OOS-3 + D-5) and the two region semantics do not mix.
    var region_src = material.region;
#if PER_INSTANCE_REGION == true
    region_src = instances[idx].region;
#endif
    uv_atlas = uv_eff * region_src.zw + region_src.xy;
  }

  // feat-20260604-instances-per-instance-transform-shader-group3-bin M2 / w8:
  // entity world from meshes[0] (dynamic-offset window already aimed at
  // this entity), per-instance local from instances[idx].localFromInstance.
  // sprite is unlit — normal matrix unused.
  var out : SpriteVertex;
  out.posLocal = pos_local;
  out.uvAtlas = uv_atlas;
  return out;
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex_index : u32) -> VsOut {
  let vertex = resolveSpriteVertex(in, idx, vertex_index);
  let world = meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(vertex.posLocal, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.uv_atlas = vertex.uvAtlas;
  out.worldPos = world.xyz;
  return out;
}

// linear_to_srgb: per-channel IEC 61966-2-1 transfer function used by the
// LDR fragment entry to encode linear premultiplied RGB into the bgra8unorm
// swap-chain storage. The bgra8unorm target is not hardware-sRGB-encoded
// (unlike bgra8unorm-srgb), so the shader must supply the encoding.
// Alpha is NOT encoded -- the blend equation operates on raw alpha.
fn linear_to_srgb(linear : f32) -> f32 {
  let c = clamp(linear, 0.0, 1.0);
  return select(c * 12.92, pow(c, 1.0 / 2.4) * 1.055 - 0.055, c > 0.0031308);
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  applyViewClipping(in.worldPos, false);
  let texel = sampleMaterialTexture(baseColorTexture, baseColorSampler, in.uv_atlas, material.baseColorTextureCoordinatesMetadata.zw);
  // R6 mitigation: strict clamp 0..1 before premultiplied alpha multiply.
  let rgba = clamp(texel * material.colorTint, vec4<f32>(0.0), vec4<f32>(1.0));
  // Premultiplied alpha: rgb pre-multiplied by alpha for srcFactor='one' /
  // dstFactor='one-minus-src-alpha' blend.
  let premult = vec4<f32>(translucent_fog(view, in.worldPos, rgba.rgb * rgba.a, rgba.a), rgba.a);
  // LDR target is bgra8unorm (blendable per WebGPU spec); hardware does not
  // sRGB-encode bgra8unorm, so apply the transfer function in the shader.
  // Only RGB channels are encoded; alpha is linear throughout the blend.
  return vec4<f32>(
    linear_to_srgb(premult.r),
    linear_to_srgb(premult.g),
    linear_to_srgb(premult.b),
    premult.a,
  );
}

// HDR variant: outputs linear premultiplied alpha for the rgba16float
// offscreen target; the tonemap fullscreen pass handles sRGB encoding.
@fragment
fn fs_main_hdr(in : VsOut) -> @location(0) vec4<f32> {
  applyViewClipping(in.worldPos, false);
  let texel = sampleMaterialTexture(baseColorTexture, baseColorSampler, in.uv_atlas, material.baseColorTextureCoordinatesMetadata.zw);
  // R6 mitigation: strict clamp 0..1 before premultiplied alpha multiply.
  let rgba = clamp(texel * material.colorTint, vec4<f32>(0.0), vec4<f32>(1.0));
  return vec4<f32>(translucent_fog(view, in.worldPos, rgba.rgb * rgba.a, rgba.a), rgba.a);
}

struct TemporalVsOut {
  @location(3) clippingPositionWS : vec3<f32>,
  @builtin(position) @invariant clip : vec4<f32>,
  @location(0) uvAtlas : vec2<f32>,
  @location(1) @interpolate(perspective) currentClip : vec4<f32>,
  @location(2) @interpolate(perspective) previousClip : vec4<f32>,
};

@vertex
fn vs_temporal(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex_index : u32) -> TemporalVsOut {
  let vertex = resolveSpriteVertex(in, idx, vertex_index);
  let currentWorld = meshes[0].worldFromLocal *
    instances[idx].localFromInstance * vec4<f32>(vertex.posLocal, 1.0);
  var previousWorld = currentWorld;
#if STORAGE_BUFFER_AVAILABLE == true
  previousWorld = meshes[0].previousWorldFromLocal *
    instances[idx].previousLocalFromInstance * vec4<f32>(vertex.posLocal, 1.0);
#endif
  var out : TemporalVsOut;
  out.clippingPositionWS = currentWorld.xyz;
  out.currentClip = view.temporalCurrentViewProj * currentWorld;
  out.clip = view.worldViewProj * currentWorld;
  out.previousClip = view.temporalPreviousViewProj * previousWorld;
  out.uvAtlas = vertex.uvAtlas;
  return out;
}

@fragment
fn fs_temporal(in : TemporalVsOut) -> @location(0) vec4<f32> {
  applyViewClipping(in.clippingPositionWS, false);
  let texel = sampleMaterialTexture(baseColorTexture, baseColorSampler, in.uvAtlas, material.baseColorTextureCoordinatesMetadata.zw);
  let alpha = clamp(texel.a * material.colorTint.a, 0.0, 1.0);
  if (alpha <= 0.0) {
    discard;
  }
  var motionValid = true;
#if STORAGE_BUFFER_AVAILABLE == true
  motionValid = meshMotionValid(meshes[0].temporal.y);
#endif
  return packSceneTemporalV1WithValidity(
    in.currentClip,
    in.previousClip,
    view.temporalProjection,
    1.0,
    motionValid,
  );
}
// sprite is unlit; do NOT read the directional-light fields of the View
// UBO -- same SSOT hard rule as the header comment above; R5 mitigation.
