#define_import_path forgeax_view::common

// The texture view owns the texture transfer: an sRGB view decodes once during
// textureSample, while a linear view is returned unchanged. Authored scalar
// values are decoded by the material extraction path before the uniform upload.
fn sampleMaterialTextureLinear(
  texture : texture_2d<f32>,
  textureSampler : sampler,
  uv : vec2<f32>,
  uvScale : vec2<f32>,
) -> vec4<f32> {
  return textureSample(texture, textureSampler, uv * uvScale);
}

// Keep the established helper for the other material paths; the explicit
// linear name is the owner-facing entry point for the unlit parity path.
fn sampleMaterialTexture(
  texture : texture_2d<f32>,
  textureSampler : sampler,
  uv : vec2<f32>,
  uvScale : vec2<f32>,
) -> vec4<f32> {
  return sampleMaterialTextureLinear(texture, textureSampler, uv, uvScale);
}

// Keep linear HDR writes finite and representable by rgba16float without
// applying an LDR clamp. NaN/Inf remains an upstream producer failure.
fn clampLinearHdr(color : vec3<f32>) -> vec3<f32> {
  return clamp(color, vec3<f32>(0.0), vec3<f32>(65504.0));
}

// Shared linear-LDR -> display-sRGB OETF for raw swap-chain storage writes.
// The high branch deliberately locks Three.js r184's reference literal
// (`0.41666`) instead of spelling the mathematically exact `1.0 / 2.4`.
// That literal is part of the byte-level parity contract at 8-bit boundaries.
// sRGB texture views perform this conversion on attachment writes, but the
// native output and FXAA passes intentionally target the non-sRGB storage view.
fn linearToSrgbOetf(color : vec3<f32>) -> vec3<f32> {
  let safe = max(color, vec3<f32>(0.0));
  let high = pow(safe, vec3<f32>(0.41666)) * vec3<f32>(1.055) - vec3<f32>(0.055);
  let low = safe * vec3<f32>(12.92);
  return select(high, low, safe <= vec3<f32>(0.0031308));
}

// Shared final-surface dither.  The output transform and FXAA are both
// display-encoded fullscreen writers, so they must use one owner-level
// algorithm rather than carrying subtly different copies in each pass.
// The bounded shift is ±0.5/255 per channel, matching Three.js's optional
// material dithering amplitude while the screen-space hash remains stable for
// a still frame.  Callers decide whether this writer is the final 8-bit
// boundary; intermediate float targets must leave it disabled.
fn hash32(value : u32) -> u32 {
  var hash = value;
  hash = (hash ^ 61u) ^ (hash >> 16u);
  hash = hash + (hash << 3u);
  hash = hash ^ (hash >> 4u);
  hash = hash * 668265261u;
  hash = hash ^ (hash >> 15u);
  return hash;
}

fn ditherNoise(pixelPosition : vec2<f32>) -> f32 {
  let pixel = vec2<u32>(pixelPosition);
  let seed = (pixel.x * 1973u) ^ (pixel.y * 9277u) ^ 89173u;
  return f32(hash32(seed) & 1023u) / 1023.0;
}

fn ditherUnorm8(value : vec3<f32>, pixelPosition : vec2<f32>) -> vec3<f32> {
  let noise = ditherNoise(pixelPosition);
  var shift = vec3<f32>(0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0);
  shift = mix(2.0 * shift, -2.0 * shift, noise);
  return clamp(value + shift, vec3<f32>(0.0), vec3<f32>(1.0));
}

// @forgeax/engine-shader - common.wgsl (M5 T-18 feat-20260512-naga-oil-composition-hmr).
//
// Shared view + mesh structs extracted from pbr.wgsl + unlit.wgsl via
// naga_oil #define_import_path / #import (D-04 moduleId convention). Both
// material shaders pull View + Mesh from here so the RenderSystem can
// uniform-upload view + mesh storage once per frame for all pipelines.
//
// `View` carries the full PBR-superset field set (worldViewProj + light +
// cameraPos). Unlit only reads `worldViewProj`; the extra fields stay bound
// but unused in the unlit path (zero perf cost because the fragment shader
// never references them). This is the canonical "superset struct" pattern
// aligned with Bevy's bevy_view::common and matches charter proposition 5
// (consistent abstraction - one View struct everywhere).

// View UBO: 1296-byte payload, 1296-byte dynamic slot (256-byte alignment).
// view-ubo.ts owns matching host writes. Existing fields retain their offsets:
// [0..528) camera and directional-shadow facts; [528..784) spot matrices;
// [784..1024) temporal and cloud-shadow facts; [1024..1120) clipping planes;
// [1120..1136) clipping control (count, intersection, clipShadows, reserved);
// [1136..1168) analytic fog (color+density, heightFalloff/maxOpacity/translucent slot).
struct AtmosphereMedium {
  originRadius: vec4<f32>, // world ground origin in km, ground radius
  rayleigh: vec4<f32>, // scattering RGB, density scale height
  mie: vec4<f32>, // scattering, absorption, scale height, anisotropy
  absorption: vec4<f32>, // absorption RGB, peak height
  ground: vec4<f32>, // albedo RGB, absorption layer half width
  geometry: vec4<f32>, // atmosphere height, MS scale, AP start, AP distance scale
};
struct View {
  worldViewProj   : mat4x4<f32>,
  lightDir        : vec3<f32>,
  lightingChannels : u32,
  lightColor      : vec3<f32>,
  viewportWidth   : f32,
  cameraPos       : vec3<f32>,
  viewportHeight  : f32,
  lightViewProj_A : mat4x4<f32>,
  inverseViewProj : mat4x4<f32>,
  lightViewProj_B : mat4x4<f32>,
  lightViewProj_C : mat4x4<f32>,
  lightViewProj_D : mat4x4<f32>,
  splitPlanes     : array<vec4<f32>,4>,
  cascadeCount    : f32,
  cascadeBlend    : f32,
  depthBias       : f32,
  normalBias      : f32,
  directionalShadowFilter : vec4<f32>,
  // feat-20260625-spot-light-shadow-mapping w25: per-spot perspective
  // light-view-projection matrices, fragment-read. Auto-aligned to byte 528
  // (mat4 array align=16, after the four directional carrier lanes at byte 512); spans bytes
  // 528..784. Lane N = spot with shadowAtlasTile === N (cap = 4). Zeroed lanes
  // are safe (sample gated on shadowAtlasTile >= 0 in default-standard-pbr.wgsl).
  spotLightViewProj : array<mat4x4<f32>, 4>,
  temporalCurrentViewProj : mat4x4<f32>,
  temporalPreviousViewProj : mat4x4<f32>,
  // x = near, y = far, z = 1 for orthographic and 0 for perspective.
  temporalProjection : vec4<f32>,
  // Accepted camera origin at the previous submitted frame. This occupies
  // the existing tail padding and keeps temporal reprojection on one SSOT.
  temporalPreviousCameraPos : vec4<f32>,
  // SSR authoring facts share the fixed View UBO tail. x/y/z are the validated
  // maxDistance/thickness/maxRoughness values; w is a finite enabled sentinel.
  ssrParams : vec4<f32>,
  // Renderer-owned texel-snapped cloud shadow projection. The map itself is
  // group(0) bindings 16/17; these lanes carry its world-space basis and
  // bounded range/validity so every receiver can sample by world position.
  cloudShadowOrigin : vec4<f32>, // xyz projection origin, w cloud base height
  cloudShadowRight : vec4<f32>, // xyz projection right, w cloud thickness
  cloudShadowUp : vec4<f32>,
  cloudShadowProjection : vec4<f32>,
  clippingPlanes : array<vec4<f32>, 6>,
  clippingControl : vec4<f32>,
  // Analytic height fog shared by the opaque fog pass and translucent writers.
  // fogHeightOpacity = (heightFalloff, maxOpacity, translucent-writer slot flag, frame time).
  // The renderer frame clock is exposed through SurfaceInput.frameTime.
  fogColorDensity : vec4<f32>,
  fogHeightOpacity : vec4<f32>,
  atmosphere : AtmosphereMedium,
  // reference sample count (zero = LUT), sun radius, AP range km, enabled.
  atmosphereControl : vec4<f32>,
};

// Mesh contains only independent transform and temporal facts. Direct draws
// bind aligned 256-byte slots; GPU scene arrays pack the 160-byte storage row.
struct Mesh {
  worldFromLocal : mat4x4<f32>,
#if STORAGE_BUFFER_AVAILABLE == true
  previousWorldFromLocal : mat4x4<f32>,
  // x = color-history reactive mask, y = surface flag bits (meshMotionValid /
  // meshReceivesShadows), z = signed LOD coverage, w = GPU skin material row.
  // This vec4 is the sole host/shader metadata ABI.
  temporal : vec4<f32>,
#endif
  // x/y: visible-surface row/count; z: lossless surface direct-light mask.
  surface : vec4<u32>,
};

// GPU Scene rows read directly by scene-index vertex entries. Render derives
// the host layout from gpu-scene-schema.ts; a parity test pins these structs
// to that schema. A visible item is (instance row, material row, skin palette
// base, bitcast signed LOD fade); instance.primitiveIndex names the primitive.
struct GpuScenePrimitive {
  generation: u32,
  flags: u32,
  transformIndex: u32,
  materialIndex: u32,
  drawTemplateIndex: u32,
  instanceStart: u32,
  instanceCount: u32,
  assetHandle: u32,
  localBoundsMin: vec3<f32>,
  lightingChannels: u32,
  localBoundsMax: vec4<f32>,
};

struct GpuSceneInstance {
  primitiveIndex: u32,
  transformIndex: u32,
  customDataStart: u32,
  flags: u32,
};

struct GpuSceneTransform {
  currentWorld: mat4x4<f32>,
  previousWorld: mat4x4<f32>,
};

// One-submit temporal pulses written by the GPU Scene owner.
const GPU_SCENE_PRIMITIVE_REACTIVE : u32 = 8u;
const GPU_SCENE_PRIMITIVE_MOTION_INVALID : u32 = 16u;
// Persistent ShadowParticipation.receive opt-out.
const GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE : u32 = 32u;

// Mesh.temporal.y flag bits written by the host `meshSurfaceFlags`.
fn meshMotionValid(flags : f32) -> bool { return (u32(flags) & 1u) != 0u; }
fn meshReceivesShadows(flags : f32) -> bool { return (u32(flags) & 2u) == 0u; }

// Inverse-transpose direction without a redundant uploaded normal matrix.
// Match engine-math's singular fallback; preserve determinant sign for mirrors.
fn transformNormal(worldFromLocal: mat4x4<f32>, normal: vec3<f32>) -> vec3<f32> {
  let a = worldFromLocal[0].xyz;
  let b = worldFromLocal[1].xyz;
  let c = worldFromLocal[2].xyz;
  let cof0 = cross(b, c);
  let cof1 = cross(c, a);
  let cof2 = cross(a, b);
  let det = dot(a, cof0);
  if (abs(det) < 1e-8) { return normal; }
  return (cof0 * normal.x + cof1 * normal.y + cof2 * normal.z) / det;
}

// Retained CPU ProbeBlendRecord ABI: 4 scalar lanes plus 9 vec4 lanes = 160 B.
// The last lane carries padding for the 27 f32 SH coefficients. Sky residual
// is derived in lighting-probe.wgsl, never stored as a second fraction.
struct ProbeBlendRecord {
  objectKey         : f32,
  generation        : f32,
  localBlendFraction : f32,
  flags             : f32,
  shPreblend        : array<vec4<f32>, 9>,
};

// feat-20260519-light-casters-point-spot-pbr M4 / w21 (D-S1 + D-S2 +
// AC-04 b/c + AC-05 binding declaration). Punctual-light std430 storage
// types use the shared six-row host ABI in `light-buffer-layout.ts`:
//
//   Point/Spot/Rect direct slot (96 B / 24 u32-or-float lanes):
//     [ 0..2 ] position vec3<f32>
//     [   3 ] invRangeSquared f32 (Bevy color_inverse_square_range.w; 0
//             collapses range falloff to a pure 1/d^2 inverse-square law)
//     [ 4..6 ] colorTimesIntensity vec3<f32> (host pre-multiplied
//             color * intensity so the shader avoids the per-fragment mul)
//     [   7 ] Point decay exponent f32 (default 2, zero = range-only)
//
//   The metadata row carries kind, shadow, IES, and Cookie identities.
//     [ 0..2 ] position vec3<f32>
//     [   3 ] invRangeSquared f32
//     [ 4..6 ] colorTimesIntensity vec3<f32>
//     [   7 ] cosInner f32 (cos of half-angle inner cone; KHR
//             smoothstep falloff anchor)
//     [ 8..10] direction vec3<f32> (raw outgoing vector; shader reads
//             via dot(L, -direction) for cone angle test)
//     [  11 ] cosOuter f32
//     Spot row 3: [12] depthBias, [13] normalBias, [14] shadowIntensity,
//     [15] rollDeg. The unified slot has no separate pcf lane; the current
//     surface and volume receivers use the stable PCF3 profile.
//     Rect row 1/2/3: halfWidth, axisY + halfHeight, axisX + zero pad. The
//     final metadata row carries the kind,
//     shadow, IES, and Cookie identities.
//
// WGSL std430 alignment audit: vec3<f32> alignof=16 / sizeof=12. The
// f32 lane wedged immediately after each vec3 fills the 4 B remainder
// (WGSL struct member rule: next.offset = roundUp(prev.offset +
// prev.size, this.alignof) - for f32 alignof=4 the round-up is a
// no-op, so position[3] / color[3] / direction[3] sit at byte
// offsets 12 / 28 / 44 with zero internal padding). Point, Spot, and Rect all
// use the unified 96 B host packer; this shared slot is the sole local-light
// carrier.
//
struct DirectLightSlot {
  position            : vec4<f32>, // row0: position + inverse range
  colorTimesIntensity : vec4<f32>, // row1: color + Point decay / Spot cosInner / Rect halfWidth
  direction           : vec4<f32>, // row2: primary axis + second angular fact
  auxiliary           : vec4<f32>, // row3: auxiliary Rect axis
  metadata : vec4<u32>,
  channels : vec4<u32>,
};

@group(0) @binding(0) var<uniform> view : View;
// feat-20260520-directional-light-shadow-mapping M3 / w16 (D-1 / plan-strategy §8.1):
// shadowMap + shadowSampler consume @group(0) bindings 3/4 (smallest unused
// slots adjacent to view UBO at 0). M3 uses 3x3 PCF with textureLoad on
// shadowMap for 9-tap depth sampling; shadowSampler retained for GPU probe.
//
// feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-8 (plan-strategy §D-1 + §D-8):
// Binding 5 declares the cube_array shadow atlas (texture_depth_cube_array,
// layers=4, depth32float; one cube per shadow-casting point light, cap=4).
// Binding 6 declares the per-light shadow params buffer (URP only — proj
// constants for cube depth-ref reconstruction); HDRP rides the same constants
// on direct-light metadata so binding 6 stays unbound on
// the HDRP path. Sample-time gating by PointLight.shadowAtlasLayer >= 0.
// Each directional cascade owns one layer, so a cascade that re-rasters
// clears only its own layer and cached cascades keep their depth.
@group(0) @binding(3) var shadowMap       : texture_depth_2d_array;
@group(0) @binding(4) var shadowSampler   : sampler_comparison;
// feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-7 (plan-strategy §D-1 + §D-8):
// Bindings 5 + 6 carry the cube_array shadow atlas + per-light shadow params
// buffer. URP forward consumers (this file's `forgeax_view::common`) declare
// them only when the `POINT_SHADOW_AVAILABLE` naga_oil define is true so
// material shaders that share the URP BGL but do not yet require shadows
// keep validating with the lean BGL shape (binding 0..4) — the runtime
// `viewBindGroupLayout` in createRenderer.ts is the matching SSOT.
//
// Cube_array depth atlas (binding 5):
//   `texture_depth_cube_array` with `layers = 4` (= PointLightShadow
//   cardinality cap). Sampled via `sample_shadow_cube_hw2x2`
//   (forgeax_pbr::shadow_pcf) in lighting-punctual.wgsl when
//   `PointLight.shadowAtlasLayer >= 0`.
//
// Per-light shadow params (binding 6):
//   `array<vec4<f32>, 4>` carrying the URP-side proj constants for cube
//   depth-ref reconstruction (research L0.5 + L1.13). Each lane stores the
//   (near, far, depthBias, normalBias) for one shadow-casting point light;
//   slot N matches `PointLight.shadowAtlasLayer = N`. Direct and clustered
//   Standard consumers share this exact binding and authored bias payload.
#ifdef POINT_SHADOW_AVAILABLE
@group(0) @binding(5) var shadowAtlas : texture_depth_cube_array;
@group(0) @binding(6) var<uniform> shadowParams : array<vec4<f32>, 4>;
#endif

// feat-20260613-csm-cascaded-shadow-maps M5 / w28: shadowCasterCascade is
// a per-pass uniform consumed exclusively by `shadow_caster.wgsl`. The
// host writes `index = i` (in 0..3) before each cascade's shadow pass so
// the shadow_caster vertex shader picks the matching `view.lightViewProj_X`
// for that pass. Forward material shaders declare the binding (it lives
// in the shared view BGL) but never reference it -- WGSL accepts unused
// bindings. The `index` is a u32; the three trailing u32 lanes keep the
// struct at the 16-byte uniform-buffer alignment WebGL2 requires.
//
// Binding 7 (not 5) on 2026-06-13: bindings 5/6 went to point-shadow
// (cube_array atlas + params UBO; FRAGMENT-only) so the cascade UBO —
// which needs VERTEX|FRAGMENT visibility — moved to the next free slot.
// `pbr-pipeline.ts buildPbrViewBglEntries` is the matching SSOT.
// feat-20260625-spot-light-shadow-mapping M2 / w10 (D-1): the cascade UBO
// gains a spot-specific perspective light-view-projection matrix + an `isSpot`
// discriminant. The spot shadow pass writes its own perspective matrix into
// `spotLightViewProj` + sets `isSpot = 1u` before each tile pass; the
// shadow_caster vertex shader then routes through the spot matrix instead of
// the directional `view.lightViewProj_A..D` cascade slots. This keeps the spot
// matrix OUT of the directional View UBO (no same-frame write contention —
// directional and spot both need light-view-proj matrices in one frame). The
// `index` lane is unused on the spot path (spot tile order is tracked
// host-side via depthLoadOp clear/load counting, decoupled from directional
// cascadeIndex per D-2).
struct ShadowCasterCascade {
  index : u32,
  // feat-20260625 M2 / w10 (D-1): spot-path discriminant (0 = directional
  // cascade, 1 = spot perspective). Repurposes the former `shadowCasterPadA`
  // lane. The shadow_caster vertex shader branches on this.
  isSpot : u32,
  // Two trailing u32 pad lanes (zero-initialised host-side) keep `index`/
  // `isSpot` in the first 16 B vec4 so the `mat4x4<f32>` below starts at a
  // 16 B-aligned offset (WebGL2 GLES 3.0 requirement). Field names are unique
  // across the composed module surface so naga_oil's writeback substitution
  // does not collide with prior `pad0` / `pad1` members in other shared
  // structs (Material, SkylightUniforms).
  shadowCasterPadB : u32,
  shadowCasterPadC : u32,
  // feat-20260625 M2 / w10 (D-1): spot perspective light-view-projection
  // matrix (perspective(outerCone*2) x lookAt). Written per spot tile pass.
  // Ignored on the directional path (isSpot = 0).
  spotLightViewProj : mat4x4<f32>,
};
@group(0) @binding(7) var<uniform> shadowCasterCascade : ShadowCasterCascade;

// feat-20260625-spot-light-shadow-mapping M3 / w13 (plan-strategy D-5):
// Spot shadow array: one depth layer per `shadowAtlasTile` (cap 4), so each
// spot view clears and caches independently. Bound at @group(0) binding 8
// (smallest free slot after the cascade UBO at 7).
//
// ALWAYS-ON, no #ifdef gate (unlike the point cube_array atlas at binding 5,
// which rides POINT_SHADOW_AVAILABLE because cube_array is unavailable in the
// WebGPU compat profile). Spot shadows are `texture_depth_2d_array`, which is
// compat-safe everywhere, so the binding is unconditionally declared — keeping
// the BGL <-> WGSL alignment surface minimal (D-5: a define axis here would be
// pure burden). The matching runtime SSOT is `buildPbrViewBglEntries`
// (pbr-pipeline.ts) which declares binding 8 unconditionally.
//
// The comparison sampler is REUSED from binding 4 (`shadowSampler`): spot
// perspective-depth sampling needs the exact same descriptor (clamp-to-edge +
// compare greater) as directional/point, so no binding 9 sampler is introduced.
// The per-spot perspective lightViewProj matrices that the forward (fragment)
// shadow sample needs live in the View UBO (binding 0, `view.spotLightViewProj`)
// — folded there in feat-20260625 w25 (scope-amend) to keep the WebGL2 fallback
// fragment uniform-buffer count <= 11; binding 8 is the last view-BG binding.
@group(0) @binding(8) var spotShadowMap : texture_depth_2d_array;
// Extended-lighting resources are a real optional view topology.  The
// renderer selects the matching material variant and BGL together; keeping
// these declarations behind the same axis prevents a no-extension variant
// from consuming texture budget or requiring absent bindings.
#ifdef EXTENDED_LIGHTING_AVAILABLE
@group(0) @binding(9) var spotModifierSampler : sampler;
@group(0) @binding(11) var iesProfileTexture : texture_2d_array<f32>;
@group(0) @binding(12) var cookieTexture : texture_2d_array<f32>;
@group(0) @binding(13) var ltcLambertTexture : texture_2d<f32>;
@group(0) @binding(14) var ltcGgxTexture : texture_2d<f32>;
// One aspect-correction matrix per Cookie array slice. The matrix is kept in
// the shared view group so the same projected Cookie semantics are available
// to both the ordinary and clustered Standard PBR consumers.
@group(0) @binding(15) var<uniform> cookieMatrices : array<mat4x4<f32>, 32>;
#endif
#ifdef PROJECTOR_AVAILABLE
#if EXTENDED_LIGHTING_AVAILABLE == false
// Optional authored SpotLight projector. Surface and volume bind the same
// accepted TextureAsset view and linear-clamp sampler; an unprojected spot
// receives the renderer-owned white fallback. The declaration is capability
// gated because the complete HDRP PBR view/material ABI reaches the WebGPU
// minimum of 16 sampled textures without this optional cookie. Devices that
// cannot expose the 17th sampled texture select the matching white-projector
// shader variant and omit these resources from the view BGL.
@group(0) @binding(11) var projectorTexture : texture_2d<f32>;
@group(0) @binding(12) var projectorSampler : sampler;
#endif
#endif
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
// The scene-index variant binds the whole GPU Scene tables in the slots the
// direct variant gives `meshes`/`instances`, so a variant declares only one
// family.
@group(2) @binding(0) var<storage, read> sceneTransforms : array<GpuSceneTransform>;
#else
#if STORAGE_BUFFER_AVAILABLE == true
@group(2) @binding(0) var<storage, read> meshes : array<Mesh>;
#else
@group(2) @binding(0) var<uniform> meshes : array<Mesh, 128>;
#endif
#endif

// feat-20260604-instances-per-instance-transform-shader-group3-bin M1 / w3:
// Per-instance local transform (column-major mat4, 64 B per entry).
// Byte-for-byte isomorphic to the record-stage packed mat4 write in
// render-system-record.ts (inst.transforms, stride-16 row-major 16-float
// per-instance) and the identity 16-float mat4 in createRenderer.ts.
// @group(3) is the per-instance storage buffer — already uploaded by
// the record stage at render-system-record.ts:2958, bound via
// setBindGroup(3, instancesBg) at :2985, and drawn with
// drawIndexed(indexCount, instanceCount, 0, 0) at :2898.
//
// Reuses the STORAGE_BUFFER_AVAILABLE axis (D-2) — the uniform fallback
// array<InstanceData, 128> caps at MAX_UNIFORM_INSTANCES=128, same as
// the meshes array. No new INSTANCE_STORAGE_AVAILABLE axis.
//
// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M2 / w7
// (plan-strategy §2 D-1 + §2 D-4 + research §Q-R-4.1-4.4): the
// PER_INSTANCE_REGION axis is declared in sprite.wgsl ONLY (D-4 keeps
// pbr / unlit at their existing 2-variant count). When the sprite
// pipeline composes this module with `PER_INSTANCE_REGION = true`, the
// InstanceData struct grows from 64 B (mat4) to 96 B (mat4 + vec4) so
// the record stage can interleave per-instance UV regions into the same
// single GPU buffer that already carries the per-instance mat4 (single
// binding slot, BGL zero-modification per D-R-4). The conditional sits
// at the tail of the struct so the pre-feat 64 B layout stays
// byte-identical when PER_INSTANCE_REGION is undefined (sprite-atlas
// + every non-sprite material).
//
// Uniform-fallback safety (R-6): worst case is
//   96 B × MAX_UNIFORM_INSTANCES (128) = 10240 B
// which is below the WebGL2 UBO floor of 16384 B; the 128 cap survives
// the stride bump.
struct InstanceData {
  localFromInstance : mat4x4<f32>,
#if STORAGE_BUFFER_AVAILABLE == true
  previousLocalFromInstance : mat4x4<f32>,
#endif
#if PER_INSTANCE_REGION == true
  // Per-instance atlas region: .xy = (uMin, vMin), .zw = (uW, vH). Pairs
  // with the legacy `material.region` UBO field (sprite.wgsl Material
  // struct, 16 B at byte offset 16). Sprite vs_main picks between the
  // material-level fallback (legacy, single-material-per-draw) and the
  // per-instance value via the same `#if PER_INSTANCE_REGION == true`
  // gate so a single sprite.wgsl source supports both shapes.
  region : vec4<f32>,
#endif
};

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
@group(3) @binding(0) var<storage, read> sceneInstances : array<GpuSceneInstance>;
// Vertex-only: the fragment stage already spends the full storage-buffer
// budget.
@group(3) @binding(6) var<storage, read> scenePrimitives : array<GpuScenePrimitive>;

// Scene-index draws carry the composed world, so their instance-local factor
// is this identity; keeping the factor preserves the per-draw arithmetic.
const SCENE_INDEX_LOCAL_IDENTITY = mat4x4<f32>(
  vec4<f32>(1.0, 0.0, 0.0, 0.0),
  vec4<f32>(0.0, 1.0, 0.0, 0.0),
  vec4<f32>(0.0, 0.0, 1.0, 0.0),
  vec4<f32>(0.0, 0.0, 0.0, 1.0),
);

struct SceneIndexDraw {
  world : mat4x4<f32>,
  previousWorld : mat4x4<f32>,
  // x = color-history reactive mask, y = current-frame motion validity.
  temporal : vec2<f32>,
  // Retained ProbeBlendRecord identity: (primitive + 1, generation).
  probe : vec2<u32>,
  receivesShadows : bool,
  lightingChannels : u32,
};

// Explicit Instances rows compose the primitive root with their local
// transform. Other rows name the reserved identity row 0 and use the root
// directly, avoiding a local-row load and matrix product for every vertex.
fn sceneIndexDraw(instanceRow : u32) -> SceneIndexDraw {
  let instance = sceneInstances[instanceRow];
  let primitive = scenePrimitives[instance.primitiveIndex];
  let root = sceneTransforms[primitive.transformIndex];
  var draw : SceneIndexDraw;
  draw.world = root.currentWorld;
  draw.previousWorld = root.previousWorld;
  if (instance.transformIndex != 0u) {
    let local = sceneTransforms[instance.transformIndex];
    draw.world = root.currentWorld * local.currentWorld;
    draw.previousWorld = root.previousWorld * local.previousWorld;
  }
  draw.temporal = vec2<f32>(
    select(0.0, 1.0, (primitive.flags & GPU_SCENE_PRIMITIVE_REACTIVE) != 0u),
    select(1.0, 0.0, (primitive.flags & GPU_SCENE_PRIMITIVE_MOTION_INVALID) != 0u),
  );
  draw.probe = vec2<u32>(instance.primitiveIndex + 1u, primitive.generation);
  draw.lightingChannels = primitive.lightingChannels;
  draw.receivesShadows = (primitive.flags & GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE) == 0u;
  return draw;
}
#else
#if STORAGE_BUFFER_AVAILABLE == true
@group(3) @binding(0) var<storage, read> instances : array<InstanceData>;
#else
@group(3) @binding(0) var<uniform> instances : array<InstanceData, 128>;
#endif
#endif

// Fullscreen large-triangle SSOT (feat-20260519-tonemap-reinhard-mvp / T-M2.1,
// research F3 section 2.3). 3 vertices in clip-space:
//   index 0 -> (-1, -1)   bottom-left
//   index 1 -> ( 3, -1)   beyond right edge
//   index 2 -> (-1,  3)   beyond top edge
// The triangle fully covers [-1, 1]^2 NDC; the rasterizer clips the
// out-of-range portion. UV is derived from xy with Y flipped so the
// downstream textureSample returns the right-side-up image (WebGPU
// convention: UV (0, 0) is top-left of the texture).
//
// Consumers (tonemap.wgsl and any future post-process pass) call this
// in their @vertex stage:
//   @vertex fn vs(@builtin(vertex_index) i : u32) -> FullscreenOutput {
//     return fullscreen_triangle(i);
//   }
//
// Keep the TS port in
// `packages/shader/src/__tests__/fullscreen-triangle.test.ts` in lockstep.

struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

fn fullscreen_triangle(vertex_index : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (vertex_index == 1u) {
    x = 3.0;
  }
  if (vertex_index == 2u) {
    y = 3.0;
  }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

// Stable screen-space noise gives adjacent meshes complementary coverage even
// when their geometry/UVs differ. Zero is the exact no-transition path.
fn applyLodCoverage(position : vec2<f32>, fade : f32) {
  let noise = fract(52.9829189 * fract(dot(floor(position), vec2<f32>(0.06711056, 0.00583715))));
  if (fade > 0.0 && noise < fade) { discard; }
  if (fade < 0.0 && noise >= -fade) { discard; }
}

#ifdef ATMOSPHERE_AVAILABLE
@group(0) @binding(18) var atmosphereTransmittance: texture_2d<f32>;
@group(0) @binding(19) var atmosphereMultiple: texture_2d<f32>;
@group(0) @binding(20) var atmosphereAerialLuminance: texture_3d<f32>;
@group(0) @binding(21) var atmosphereAerialTransmittance: texture_3d<f32>;
@group(0) @binding(23) var atmosphereDistantSkyLight: texture_2d<f32>;
#endif

// Surface direct-light matching is independent of camera visibility and casting.
fn lightingChannelsMatch(light : u32, receiver : u32) -> bool {
  return (light & receiver) != 0u;
}
