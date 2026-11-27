#define_import_path forgeax_material::unlit
#ifdef MATERIAL_FRAGMENT_OUTPUT_AVAILABLE
#import forgeax_material::fragment_output::{applyFragmentOutput}
#endif
#import forgeax_clipping::planes::{applyViewClipping, applyLocalClipping}
#import forgeax_view::common::{View, Mesh, meshMotionValid, InstanceData, view, sampleMaterialTextureLinear, transformNormal}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw, applyLodCoverage}
#else
#ifdef GPU_SCENE_DIRECT
#import forgeax_view::common::{sceneIndexDraw}
#else
#import forgeax_view::common::{meshes, instances}
#endif
#endif
#import forgeax_shadow::surface::{projectShadowPosition}
#import forgeax_scene_temporal::{encodeSceneVelocityRaster, packSceneTemporalV1WithValidity}
#import forgeax_material::alpha_hash::{alphaHashThreshold, alphaCoverageValue, materialOutputAlpha, materialOutputColor}
#import forgeax_material::texture_coordinates::{materialUvLinear}
#import forgeax_view::fog::{forward_fog}
#import forgeax_view::fog::{vertex_height_fog}
#import forgeax_material::oit::{OitOutput, oitAccumulate}

#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE
#pragma variant_axis VERTEX_COLOR_AVAILABLE
#pragma variant_axis COVERAGE_ONLY
#pragma variant_axis SKINNING_DISABLED
#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#pragma variant_axis LOD_DITHER
#pragma variant_axis GPU_SCENE_DIRECT
#pragma variant_axis ALPHA_MASK
#pragma variant_axis CLIPPING_PLANES

// @forgeax/engine-shader - unlit.wgsl (M5 feat-20260511-asset-system-v1;
// refactored M5 T-18 feat-20260512-naga-oil-composition-hmr to pull View +
// Mesh via naga_oil #import; expanded feat-20260518-pbr-direct-lighting-mvp
// M2 / w8 to share binding 0-6 layout + 12-floats VsIn with pbr.wgsl).
//
// Minimal unlit material shader: world * view * proj transform + flat
// fragment output of `material.baseColor * sample(baseColorTexture)`. No
// lighting, no normal mapping, no metallic/roughness. Consumed by
// RenderSystem when the material dispatch tag resolves to 'unlit'
// (plan-strategy D-P4 / requirements AC-07). The pipeline binds:
//
//   @group(0) @binding(0) view                       uniform   (see common.wgsl;
//                                                               unlit only reads
//                                                               worldViewProj)
//   @group(1) @binding(0) material                   uniform   (vec4 baseColor;
//                                                               metallic/roughness
//                                                               unused on this path)
//   @group(1) @binding(1) baseColorSampler           sampler
//   @group(1) @binding(2) baseColorTexture           texture_2d<f32>
//   @group(2) @binding(0) meshes                     storage   (see common.wgsl;
//                                                               temporal fields not
//                                                               consumed in unlit)
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance mat4;
//                                                               indexed by @builtin
//                                                               (instance_index);
//                                                               see common.wgsl)
//
// Material bindings are derived from the built-in paramSchema. The vertex stage
// reads position, normal (normal/MatCap modes) and uv (+ aliased uv1..7); it
// declares no tangent, which unlit shading never uses. A mesh still needs the
// normal and uv streams: MeshBuilder derives both for triangle submeshes, and
// UV-less layouts alias uv onto bytes inside the uploaded stride.

struct Material {
  baseColor : vec4<f32>,
#ifndef ALPHA_CLIPPING_DISABLED
  alphaCutoff : f32,
#endif
#ifndef ALPHA_HASH_DISABLED
  alphaHash : f32,
#endif
  shadowAlphaMode : f32,
  alphaMode : f32,
  alphaToCoverage : f32,
  // 0 = base shading, 1 = normal visualization, 2 = matcap. It fills the scalar
  // padding before the coordinate records, so every mode shares one UBO size.
  shading : f32,
  alphaChannel : f32,
  baseColorTextureCoordinatesTransform : vec4<f32>,
  baseColorTextureCoordinatesMetadata : vec4<f32>,
  baseColorTextureCoordinatesRotation : vec4<f32>,
  alphaTextureCoordinatesTransform : vec4<f32>,
  alphaTextureCoordinatesMetadata : vec4<f32>,
  alphaTextureCoordinatesRotation : vec4<f32>,
#ifdef MATERIAL_CLIPPING_AVAILABLE
  clippingControl : vec4<f32>,
  clippingPlaneA : vec4<f32>,
  clippingPlaneB : vec4<f32>,
  clippingPlaneC : vec4<f32>,
  clippingPlaneD : vec4<f32>,
  clippingPlaneE : vec4<f32>,
  clippingPlaneF : vec4<f32>,
#endif
#ifdef MATERIAL_FRAGMENT_OUTPUT_AVAILABLE
  fragmentOutput : vec4<f32>,
#endif

};

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
// Scene-index batches read each row's values from the GPU Scene material table.
// Every entry of this variant addresses the visible stream
// (instance row, material address, candidate row, LOD fade); the selected row
// is carried flat to the fragment stage, which reloads it into `material`.
@group(1) @binding(46) var<storage, read> sceneMaterials : array<Material>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
var<private> material : Material;
#if LOD_DITHER == true
var<private> unlitLodFade : f32;
#endif

fn selectSceneMaterial(address : vec2<u32>) {
  material = sceneMaterials[address.x];
#if LOD_DITHER == true
  unlitLodFade = bitcast<f32>(address.y);
#endif
}
#else
@group(1) @binding(0) var<uniform> material : Material;
#endif
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var alphaSampler : sampler;
@group(1) @binding(4) var alphaTexture : texture_2d<f32>;

// Preserve filtering reflection for the bound texture passed to the helper.
fn materialTextureFilteringWitness() {
  let base = baseColorTexture;
  let baseWitness = textureSample(base, baseColorSampler, vec2<f32>(0.0));
  let alphaWitness = textureSample(alphaTexture, alphaSampler, vec2<f32>(0.0));
}

#if SKINNING_DISABLED == false
#import forgeax_skin::task::{skinTaskDescriptor, skinTaskBlend, skinTaskPosition, skinTaskDirectCandidate, skinTaskPreviousTranslation, skinTaskHistoryValid}
#endif

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(6) uv1 : vec2<f32>,
  @location(7) uv2 : vec2<f32>,
  @location(8) uv3 : vec2<f32>,
  @location(9) uv4 : vec2<f32>,
  @location(10) uv5 : vec2<f32>,
  @location(11) uv6 : vec2<f32>,
  @location(12) uv7 : vec2<f32>,
#if SKINNING_DISABLED == false
  @location(4) skinIndex : vec4<u32>,
  @location(5) skinWeight : vec4<f32>,
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  @location(13) color : vec4<f32>,
#endif
};
struct VsOut {
  @location(3) positionOS : vec3<f32>,
  @builtin(position) @invariant clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(5) alphaUv : vec2<f32>,
  @location(1) worldPos : vec3<f32>,
  @location(2) worldNormal : vec4<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  @location(6) @interpolate(flat) materialAddress : vec2<u32>,
#endif
};

const UNLIT_SHADING_NORMAL : f32 = 1.0;

fn unlitUv(in : VsIn, uvSet : f32, transform : vec4<f32>, rotation : vec4<f32>) -> vec2<f32> {
  var source = in.uv;
  if (uvSet >= 1.0) { source = in.uv1; }
  if (uvSet >= 2.0) { source = in.uv2; }
  if (uvSet >= 3.0) { source = in.uv3; }
  if (uvSet >= 4.0) { source = in.uv4; }
  if (uvSet >= 5.0) { source = in.uv5; }
  if (uvSet >= 6.0) { source = in.uv6; }
  if (uvSet >= 7.0) { source = in.uv7; }
  return materialUvLinear(source, transform, rotation) + transform.xy;
}

#if SKINNING_DISABLED == false
// Skin task candidate of this draw: the visible stream names it for
// scene-index batches; direct draws read their dynamic task address.
fn unlitSkinCandidate(idx : u32) -> u32 {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  return visibleItems[idx].z;
#else
  return skinTaskDirectCandidate();
#endif
}
#endif

fn unlitVertex(in : VsIn, idx : u32) -> VsOut {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  let visible = visibleItems[idx];
  material = sceneMaterials[visible.y];
#endif
#if SKINNING_DISABLED == false
  // Palette entries are jointWorld * inverseBind; the mesh-node transform is
  // ignored for a skinned glTF mesh, as in the Standard skin vertex path.
  let descriptor = skinTaskDescriptor(unlitSkinCandidate(idx));
  let localToWorld = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, false);
#else
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  // Scene rows carry the composed object world.
  let localToWorld = sceneIndexDraw(visible.x).world;
#else
#ifdef GPU_SCENE_DIRECT
  // The draw's first instance is the slot's first scene instance row.
  let localToWorld = sceneIndexDraw(idx).world;
#else
  // Entity world from the dynamic-offset Mesh row times the per-instance local.
  let localToWorld = meshes[0].worldFromLocal * instances[idx].localFromInstance;
#endif
#endif
#endif
#if SKINNING_DISABLED == false
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  let translation = sceneIndexDraw(visible.x).world[3].xyz;
#else
  let translation = meshes[0u].worldFromLocal[3].xyz;
#endif
  let world = skinTaskPosition(descriptor, localToWorld, in.pos, translation);
#else
  let world = localToWorld * vec4<f32>(in.pos, 1.0);
#endif
  var out : VsOut;
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  out.materialAddress = visible.yw;
#endif
  out.positionOS = in.pos;
  out.clip = view.worldViewProj * world;
  out.uv = unlitUv(in, material.baseColorTextureCoordinatesMetadata.x, material.baseColorTextureCoordinatesTransform, material.baseColorTextureCoordinatesRotation);
  out.alphaUv = unlitUv(in, material.alphaTextureCoordinatesMetadata.x, material.alphaTextureCoordinatesTransform, material.alphaTextureCoordinatesRotation);
  out.worldPos = world.xyz;
  out.worldNormal = vec4<f32>(transformNormal(localToWorld, in.normal), vertex_height_fog(view, world.xyz));
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
  return out;
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  return unlitVertex(in, idx);
}

@vertex
fn vs_shadow(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  var out = unlitVertex(in, idx);
  out.clip = projectShadowPosition(vec4<f32>(out.worldPos, 1.0), out.worldNormal.xyz);
  return out;
}

// Camera basis in world space, recovered from the one inverse view-projection
// shared by every view. In-plane NDC deltas stay parallel to the camera axes
// under TAA jitter, so no extra View field is needed.
fn unlitViewBasis() -> mat3x3<f32> {
  let origin = view.inverseViewProj * vec4<f32>(0.0, 0.0, 0.5, 1.0);
  let rightPoint = view.inverseViewProj * vec4<f32>(1.0, 0.0, 0.5, 1.0);
  let upPoint = view.inverseViewProj * vec4<f32>(0.0, 1.0, 0.5, 1.0);
  let center = origin.xyz / origin.w;
  let right = normalize(rightPoint.xyz / rightPoint.w - center);
  let up = normalize(upPoint.xyz / upPoint.w - center);
  return mat3x3<f32>(right, up, cross(right, up));
}

// View-space shading normal (x right, y up, z toward the camera); back faces
// flip so double-sided surfaces visualize the side the camera sees.
fn unlitViewNormal(in : VsOut, frontFacing : bool) -> vec3<f32> {
  let n = normalize(in.worldNormal.xyz) * select(-1.0, 1.0, frontFacing);
  return normalize(n * unlitViewBasis());
}

// Three.js r184 matcap lookup: a view-direction-stabilized frame keeps the
// sphere image upright at screen edges. V flips because texture rows start at
// the image top here, while Three's flipY textures start at the bottom.
fn unlitMatcapUv(in : VsOut, frontFacing : bool) -> vec2<f32> {
  let viewDir = normalize(normalize(view.cameraPos - in.worldPos) * unlitViewBasis());
  let normal = unlitViewNormal(in, frontFacing);
  let x = normalize(vec3<f32>(viewDir.z, 0.0, -viewDir.x));
  let y = cross(viewDir, x);
  let uv = vec2<f32>(dot(x, normal), dot(y, normal)) * 0.495 + 0.5;
  return vec2<f32>(uv.x, 1.0 - uv.y);
}

// Only color mode reads texture alpha; matcap and normal modes keep Three's
// opacity contract (material and vertex alpha only).
fn unlitTextureAlpha(textureAlpha : f32) -> f32 {
  return select(1.0, textureAlpha, material.shading < 0.5);
}

fn materialVertexColor(in : VsOut) -> vec4<f32> {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color;
#else
  return vec4<f32>(1.0);
#endif
}

fn unlitAlphaCutoff() -> f32 {
#ifndef ALPHA_CLIPPING_DISABLED
  return material.alphaCutoff;
#else
  return 0.0;
#endif
}

fn unlitAlphaHash() -> f32 {
#ifndef ALPHA_HASH_DISABLED
  return material.alphaHash;
#else
  return 0.0;
#endif
}

struct UnlitCoverageTest {
  cutoff : f32,
  hash : f32,
  cutoffEnabled : bool,
  hashEnabled : bool,
};

// Derivatives precede every coverage, LOD and clipping discard. Color/depth
// omit this call entirely in the opaque variant; temporal keeps its existing
// exact material coverage even in the COVERAGE_ONLY publication lane.
fn unlitCoverageTest(positionOS : vec3<f32>, smoothing : f32, hash : f32) -> UnlitCoverageTest {
  let derivative = max(length(dpdx(positionOS)), length(dpdy(positionOS)));
  var threshold = 0.0;
  if (hash > 0.5) { threshold = alphaHashThreshold(positionOS, derivative); }
  let cutoff = unlitAlphaCutoff();
  return UnlitCoverageTest(select(cutoff, 0.0, smoothing > 0.5), threshold, cutoff > 0.0, hash > 0.5);
}

fn unlitCoverageRejected(coverage : f32, test : UnlitCoverageTest) -> bool {
  return (test.cutoffEnabled && coverage <= test.cutoff) || (test.hashEnabled && coverage < test.hash);
}

fn applyUnlitClipping(positionWS : vec3<f32>, pixel : vec2<f32>, shadow : bool) {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#if LOD_DITHER == true
  applyLodCoverage(pixel, unlitLodFade);
#endif
#endif
#if CLIPPING_PLANES == true
  applyViewClipping(positionWS, shadow);
#endif
#ifdef MATERIAL_CLIPPING_AVAILABLE
  applyLocalClipping(positionWS, shadow, array<vec4<f32>, 6>(material.clippingPlaneA, material.clippingPlaneB, material.clippingPlaneC, material.clippingPlaneD, material.clippingPlaneE, material.clippingPlaneF), material.clippingControl);
#endif
}

// Color and surface-data share the same compile-time material coverage lane.
fn unlitCoverageValue(textureAlpha : f32, vertexAlpha : f32, mappedAlpha : f32) -> f32 {
  let coverage = alphaCoverageValue(material.baseColor.a * unlitTextureAlpha(textureAlpha) * vertexAlpha * mappedAlpha, unlitAlphaCutoff(), material.alphaToCoverage);
  return coverage;
}

fn unlitColorCoverageRejected(coverage : f32, in : VsOut) -> bool {
#if ALPHA_MASK == true
  let test = unlitCoverageTest(in.positionOS, material.alphaToCoverage, unlitAlphaHash());
  return unlitCoverageRejected(coverage, test);
#else
  return false;
#endif
}

// Shading returns coverage rejection; only fragment entry points discard.
struct UnlitColor {
  color : vec4<f32>,
  rejected : bool,
};

// Shaded, fogged straight-alpha color shared by the sorted and OIT entry points.
fn unlitColor(in : VsOut, frontFacing : bool) -> UnlitColor {
  // Matcap reuses the base-color slot as its sphere image: one sample, one
  // binding layout, and only the lookup coordinate changes.
  var sampleUv = in.uv;
  var sampleScale = material.baseColorTextureCoordinatesMetadata.zw;
  // select evaluates both operands: keep mode-specific camera/normal work
  // behind the material-uniform branch instead of charging color fragments.
  if (abs(material.shading - 2.0) < 0.5) {
    sampleUv = unlitMatcapUv(in, frontFacing);
    sampleScale = vec2<f32>(1.0);
  }
  let texSample = sampleMaterialTextureLinear(baseColorTexture, baseColorSampler, sampleUv, sampleScale);
  let vertexColor = materialVertexColor(in);
  let mappedAlpha = sampleMaterialTextureLinear(alphaTexture, alphaSampler, in.alphaUv, material.alphaTextureCoordinatesMetadata.zw)[u32(material.alphaChannel)];
  let coverage = unlitCoverageValue(texSample.a, vertexColor.a, mappedAlpha);
  let rejected = unlitColorCoverageRejected(coverage, in);
  let alpha = materialOutputAlpha(coverage, material.alphaMode);
  // Normal visualization is an exact encoded readback (Three fog: false).
  if (abs(material.shading - UNLIT_SHADING_NORMAL) < 0.5 || material.shading > 2.5) {
    var normalColor = unlitViewNormal(in, frontFacing) * 0.5 + 0.5;
    if (material.shading > 2.5) {
      normalColor = select(pow((normalColor + 0.055) / 1.055, vec3<f32>(2.4)), normalColor / 12.92, normalColor <= vec3<f32>(0.04045));
    }
    return UnlitColor(vec4<f32>(materialOutputColor(normalColor, alpha, material.alphaMode), alpha), rejected);
  }
  let shaded = materialOutputColor(material.baseColor.rgb * texSample.rgb * vertexColor.rgb, alpha, material.alphaMode);
  let fogged = forward_fog(view, in.worldPos, in.worldNormal.w, shaded, alpha);
  return UnlitColor(vec4<f32>(fogged, alpha), rejected);
}

@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) -> @location(0) vec4<f32> {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress);
#endif
  let shaded = unlitColor(in, frontFacing);
#if ALPHA_MASK == true
  if (shaded.rejected) { discard; }
#endif
  applyUnlitClipping(in.worldPos, in.clip.xy, false);
  let color = shaded.color;
#ifdef COVERAGE_ONLY
  return vec4<f32>(1.0);
#else
  #ifdef MATERIAL_FRAGMENT_OUTPUT_AVAILABLE
  return applyFragmentOutput(color, material.fragmentOutput);
  #else
  return color;
  #endif
#endif
}

// Preserve the opaque Unlit color pass coverage while writing only depth.
@fragment
fn fs_depth_masked(in : VsOut) {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress);
#endif
  let texSample = sampleMaterialTextureLinear(baseColorTexture, baseColorSampler, in.uv, material.baseColorTextureCoordinatesMetadata.zw);
  let mappedAlpha = sampleMaterialTextureLinear(alphaTexture, alphaSampler, in.alphaUv, material.alphaTextureCoordinatesMetadata.zw)[u32(material.alphaChannel)];
  let coverage = unlitCoverageValue(texSample.a, materialVertexColor(in).a, mappedAlpha);
#if ALPHA_MASK == true
  if (unlitColorCoverageRejected(coverage, in)) { discard; }
#endif
  applyUnlitClipping(in.worldPos, in.clip.xy, false);
}

// Weighted blended OIT accumulation for straight-alpha blend states.
@fragment
fn fs_oit(in : VsOut, @builtin(front_facing) frontFacing : bool) -> OitOutput {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress);
#endif
  let shaded = unlitColor(in, frontFacing);
#if ALPHA_MASK == true
  if (shaded.rejected) { discard; }
#endif
  applyUnlitClipping(in.worldPos, in.clip.xy, false);
  let color = shaded.color;
  return oitAccumulate(color.rgb * color.a, color.a, distance(in.worldPos, view.cameraPos));
}

// Weighted blended OIT accumulation for premultiplied blend states.
@fragment
fn fs_oit_premultiplied(in : VsOut, @builtin(front_facing) frontFacing : bool) -> OitOutput {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress);
#endif
  let shaded = unlitColor(in, frontFacing);
#if ALPHA_MASK == true
  if (shaded.rejected) { discard; }
#endif
  applyUnlitClipping(in.worldPos, in.clip.xy, false);
  let color = shaded.color;
  return oitAccumulate(color.rgb, color.a, distance(in.worldPos, view.cameraPos));
}

// Depth-only shadow variant. Keep alpha clipping identical to the color path,
// but return no color target because the shadow pass has a depth attachment only.
@fragment
fn fs_shadow(in : VsOut) {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress);
#endif
  let texSample = sampleMaterialTextureLinear(baseColorTexture, baseColorSampler, in.uv, material.baseColorTextureCoordinatesMetadata.zw);
  let vertexColor = materialVertexColor(in);
  let mappedAlpha = sampleMaterialTextureLinear(alphaTexture, alphaSampler, in.alphaUv, material.alphaTextureCoordinatesMetadata.zw)[u32(material.alphaChannel)];
  // Texture-only coverage ignores scalar opacity, vertex alpha and stochastic
  // coverage. Select instead of branching: a scene-index row is per draw, and
  // derivative-bearing coverage must stay in uniform control flow.
  let textureOnly = material.shadowAlphaMode > 0.5;
  let textureAlpha = unlitTextureAlpha(texSample.a) * mappedAlpha;
  let smoothing = select(material.alphaToCoverage, 0.0, textureOnly);
  let coverage = alphaCoverageValue(
    select(material.baseColor.a * vertexColor.a, 1.0, textureOnly) * textureAlpha,
    unlitAlphaCutoff(),
    smoothing,
  );
#if ALPHA_MASK == true
  let test = unlitCoverageTest(in.positionOS, smoothing, select(unlitAlphaHash(), 0.0, textureOnly));
  if (unlitCoverageRejected(coverage, test)) { discard; }
#endif
  applyUnlitClipping(in.worldPos, in.clip.xy, true);
}

struct TemporalVsOut {
  @location(3) positionOS : vec3<f32>,
  @location(4) clippingPositionWS : vec3<f32>,
  @builtin(position) @invariant clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(5) alphaUv : vec2<f32>,
  @location(6) @interpolate(flat) skinHistoryValid : u32,
  @location(1) @interpolate(perspective) currentClip : vec4<f32>,
  @location(2) @interpolate(perspective) previousClip : vec4<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  @location(7) @interpolate(flat) materialAddress : vec2<u32>,
  // x = color-history reactive mask, y = current-frame motion validity.
  @location(8) @interpolate(flat) sceneTemporal : vec2<f32>,
#else
#ifdef GPU_SCENE_DIRECT
  @location(8) @interpolate(flat) sceneTemporal : vec2<f32>,
#endif
#endif
};

@vertex
fn vs_temporal(in : VsIn, @builtin(instance_index) idx : u32) -> TemporalVsOut {
  let current = unlitVertex(in, idx);
#if SKINNING_DISABLED == false
  let descriptor = skinTaskDescriptor(unlitSkinCandidate(idx));
  let currentSkin = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, false);
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  let draw = sceneIndexDraw(visibleItems[idx].x);
  let translation = draw.world[3].xyz;
  let previousTranslation = draw.previousWorld[3].xyz;
#else
  let translation = meshes[0u].worldFromLocal[3].xyz;
  let previousTranslation = skinTaskPreviousTranslation(meshes[0u]);
#endif
  let currentWorld = skinTaskPosition(descriptor, currentSkin, in.pos, translation);
#else
  let currentWorld = vec4<f32>(current.worldPos, 1.0);
#endif
  var previousWorld = currentWorld;
#if SKINNING_DISABLED == false
  let previousSkin = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, true);
  previousWorld = skinTaskPosition(descriptor, previousSkin, in.pos,
    select(translation, previousTranslation, skinTaskHistoryValid(descriptor)));
#else
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  previousWorld = sceneIndexDraw(visibleItems[idx].x).previousWorld * vec4<f32>(in.pos, 1.0);
#else
#ifdef GPU_SCENE_DIRECT
  previousWorld = sceneIndexDraw(idx).previousWorld * vec4<f32>(in.pos, 1.0);
#else
#if STORAGE_BUFFER_AVAILABLE == true
  previousWorld = meshes[0].previousWorldFromLocal *
    instances[idx].previousLocalFromInstance * vec4<f32>(in.pos, 1.0);
#endif
#endif
#endif
#endif
  var out : TemporalVsOut;
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  out.materialAddress = current.materialAddress;
  out.sceneTemporal = sceneIndexDraw(visibleItems[idx].x).temporal;
#else
#ifdef GPU_SCENE_DIRECT
  out.sceneTemporal = sceneIndexDraw(idx).temporal;
#endif
#endif
#if SKINNING_DISABLED == false
  out.skinHistoryValid = select(0u, 1u, skinTaskHistoryValid(descriptor));
#else
  out.skinHistoryValid = 1u;
#endif
  out.positionOS = in.pos;
  out.clippingPositionWS = currentWorld.xyz;
  out.currentClip = view.temporalCurrentViewProj * currentWorld;
  out.clip = view.worldViewProj * currentWorld;
  out.previousClip = view.temporalPreviousViewProj * previousWorld;
  out.uv = current.uv;
  out.alphaUv = current.alphaUv;
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
  return out;
}

fn temporalVertexColor(in : TemporalVsOut) -> vec4<f32> {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color;
#else
  return vec4<f32>(1.0);
#endif
}

struct UnlitTemporalCoverage {
  opacity : f32,
  rejected : bool,
}

fn unlitTemporalCoverage(in : TemporalVsOut) -> UnlitTemporalCoverage {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress);
#endif
  let texSample = sampleMaterialTextureLinear(baseColorTexture, baseColorSampler, in.uv, material.baseColorTextureCoordinatesMetadata.zw);
  let vertexColor = temporalVertexColor(in);
  let mappedAlpha = sampleMaterialTextureLinear(alphaTexture, alphaSampler, in.alphaUv, material.alphaTextureCoordinatesMetadata.zw)[u32(material.alphaChannel)];
  let coverage = unlitCoverageValue(texSample.a, vertexColor.a, mappedAlpha);
  let test = unlitCoverageTest(in.positionOS, material.alphaToCoverage, unlitAlphaHash());
  return UnlitTemporalCoverage(coverage, unlitCoverageRejected(coverage, test));
}

fn materialTemporal(in : TemporalVsOut, coverage : f32) -> vec4<f32> {
  applyUnlitClipping(in.clippingPositionWS, in.clip.xy, false);
  let alpha = materialOutputAlpha(coverage, material.alphaMode);
#ifdef COVERAGE_ONLY
  return vec4<f32>(1.0);
#endif
  var reactive = 0.0;
  var motionValid = true;
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  reactive = in.sceneTemporal.x;
  motionValid = in.sceneTemporal.y > 0.5;
#else
#ifdef GPU_SCENE_DIRECT
  reactive = in.sceneTemporal.x;
  motionValid = in.sceneTemporal.y > 0.5;
#else
#if STORAGE_BUFFER_AVAILABLE == true
  reactive = meshes[0].temporal.x;
  motionValid = meshMotionValid(meshes[0].temporal.y);
#endif
#endif
#endif
  motionValid = motionValid && in.skinHistoryValid != 0u;
  // Material coverage is shared shader state, never copied into every Mesh row.
  if (unlitAlphaHash() <= 0.5 && alpha < 1.0) { reactive = 1.0; }
  return packSceneTemporalV1WithValidity(
    in.currentClip,
    in.previousClip,
    view.temporalProjection,
    reactive,
    motionValid,
  );
}


@fragment
fn fs_temporal(in : TemporalVsOut) -> @location(0) vec4<f32> {
  let coverage = unlitTemporalCoverage(in);
  if (coverage.rejected) { discard; }
  return materialTemporal(in, coverage.opacity);
}

@fragment
fn fs_temporal_depth(in : TemporalVsOut) -> @location(0) vec4<f32> {
  let coverage = unlitTemporalCoverage(in);
  if (coverage.rejected) { discard; }
  return materialTemporal(in, coverage.opacity);
}

@fragment
fn fs_scene_velocity(in : TemporalVsOut) -> @location(0) vec2<u32> {
  let coverage = unlitTemporalCoverage(in);
  if (coverage.rejected) { discard; }
  return encodeSceneVelocityRaster(materialTemporal(in, coverage.opacity), in.previousClip);
}
