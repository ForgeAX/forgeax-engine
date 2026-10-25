#define_import_path forgeax_material::unlit
#ifdef MATERIAL_FRAGMENT_OUTPUT_AVAILABLE
#import forgeax_material::fragment_output::{applyFragmentOutput}
#endif
#import forgeax_clipping::planes::{applyViewClipping, applyLocalClipping}
#import forgeax_view::common::{View, Mesh, meshMotionValid, InstanceData, view, sampleMaterialTextureLinear}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw, applyLodCoverage}
#else
#import forgeax_view::common::{meshes, instances}
#endif
#import forgeax_shadow::surface::{projectShadowPosition}
#import forgeax_scene_temporal::{packSceneTemporalV1WithValidity}
#import forgeax_material::alpha_hash::{applyAlphaHash}
#import forgeax_material::alpha_hash::{alphaCoverage, materialOutputAlpha, materialOutputColor}
#import forgeax_material::texture_coordinates::{materialUvLinear}
#import forgeax_view::fog::{translucent_fog}
#import forgeax_material::oit::{OitOutput, oitAccumulate}

#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis VERTEX_COLOR_AVAILABLE
#pragma variant_axis COVERAGE_ONLY
#pragma variant_axis SKINNING_DISABLED
#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_AVAILABLE

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
  alphaCutoff : f32,
  alphaHash : f32,
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

fn selectSceneMaterial(address : vec2<u32>, position : vec2<f32>) {
  material = sceneMaterials[address.x];
  applyLodCoverage(position, bitcast<f32>(address.y));
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
#import forgeax_skin::task::{skinTaskDescriptor, skinTaskBlend, skinTaskDirectCandidate, skinTaskHistoryValid}
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
  @location(2) worldNormal : vec3<f32>,
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
  // Entity world from the dynamic-offset Mesh row times the per-instance local.
  let localToWorld = meshes[0].worldFromLocal * instances[idx].localFromInstance;
#endif
#endif
  let world = localToWorld * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  out.materialAddress = visible.yw;
#endif
  out.positionOS = in.pos;
  out.clip = view.worldViewProj * world;
  out.uv = unlitUv(in, material.baseColorTextureCoordinatesMetadata.x, material.baseColorTextureCoordinatesTransform, material.baseColorTextureCoordinatesRotation);
  out.alphaUv = unlitUv(in, material.alphaTextureCoordinatesMetadata.x, material.alphaTextureCoordinatesTransform, material.alphaTextureCoordinatesRotation);
  out.worldPos = world.xyz;
  if (material.shading > 0.5) {
    let m0 = localToWorld[0].xyz;
    let m1 = localToWorld[1].xyz;
    let m2 = localToWorld[2].xyz;
    // Only normal/MatCap modes consume normals. Preserve the cofactor for
    // their non-uniform scales and mirrored transforms.
    let normalMatrix = mat3x3<f32>(cross(m1, m2), cross(m2, m0), cross(m0, m1));
    out.worldNormal = normalMatrix * in.normal * sign(dot(m0, cross(m1, m2)));
  }
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
  out.clip = projectShadowPosition(vec4<f32>(out.worldPos, 1.0));
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
  let n = normalize(in.worldNormal) * select(-1.0, 1.0, frontFacing);
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

// Shaded, fogged straight-alpha color shared by the sorted and OIT entry points.
fn unlitColor(in : VsOut, frontFacing : bool) -> vec4<f32> {
  applyViewClipping(in.worldPos, false);
#ifdef MATERIAL_CLIPPING_AVAILABLE
  applyLocalClipping(in.worldPos, false, array<vec4<f32>, 6>(material.clippingPlaneA, material.clippingPlaneB, material.clippingPlaneC, material.clippingPlaneD, material.clippingPlaneE, material.clippingPlaneF), material.clippingControl);
#endif

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
  let coverage = alphaCoverage(material.baseColor.a * unlitTextureAlpha(texSample.a) * vertexColor.a * mappedAlpha, material.alphaCutoff, material.alphaToCoverage);
  applyAlphaHash(coverage, in.positionOS, material.alphaHash);
  let alpha = materialOutputAlpha(coverage, material.alphaMode);
  // Normal visualization is an exact encoded readback (Three fog: false).
  if (abs(material.shading - UNLIT_SHADING_NORMAL) < 0.5 || material.shading > 2.5) {
    var normalColor = unlitViewNormal(in, frontFacing) * 0.5 + 0.5;
    if (material.shading > 2.5) {
      normalColor = select(pow((normalColor + 0.055) / 1.055, vec3<f32>(2.4)), normalColor / 12.92, normalColor <= vec3<f32>(0.04045));
    }
    return vec4<f32>(materialOutputColor(normalColor, alpha, material.alphaMode), alpha);
  }
  let shaded = materialOutputColor(material.baseColor.rgb * texSample.rgb * vertexColor.rgb, alpha, material.alphaMode);
  let fogged = translucent_fog(view, in.worldPos, shaded, alpha);
  return vec4<f32>(fogged, alpha);
}

@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) -> @location(0) vec4<f32> {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress, in.clip.xy);
#endif
  let color = unlitColor(in, frontFacing);
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

// Weighted blended OIT accumulation for straight-alpha blend states.
@fragment
fn fs_oit(in : VsOut, @builtin(front_facing) frontFacing : bool) -> OitOutput {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress, in.clip.xy);
#endif
  let color = unlitColor(in, frontFacing);
  return oitAccumulate(color.rgb * color.a, color.a, distance(in.worldPos, view.cameraPos));
}

// Weighted blended OIT accumulation for premultiplied blend states.
@fragment
fn fs_oit_premultiplied(in : VsOut, @builtin(front_facing) frontFacing : bool) -> OitOutput {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress, in.clip.xy);
#endif
  let color = unlitColor(in, frontFacing);
  return oitAccumulate(color.rgb, color.a, distance(in.worldPos, view.cameraPos));
}

// Depth-only shadow variant. Keep alpha clipping identical to the color path,
// but return no color target because the shadow pass has a depth attachment only.
@fragment
fn fs_shadow(in : VsOut) {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress, in.clip.xy);
#endif
  applyViewClipping(in.worldPos, true);
#ifdef MATERIAL_CLIPPING_AVAILABLE
  applyLocalClipping(in.worldPos, true, array<vec4<f32>, 6>(material.clippingPlaneA, material.clippingPlaneB, material.clippingPlaneC, material.clippingPlaneD, material.clippingPlaneE, material.clippingPlaneF), material.clippingControl);
#endif

  let texSample = sampleMaterialTextureLinear(baseColorTexture, baseColorSampler, in.uv, material.baseColorTextureCoordinatesMetadata.zw);
  let vertexColor = materialVertexColor(in);
  let mappedAlpha = sampleMaterialTextureLinear(alphaTexture, alphaSampler, in.alphaUv, material.alphaTextureCoordinatesMetadata.zw)[u32(material.alphaChannel)];
  // Texture-only coverage ignores scalar opacity, vertex alpha and stochastic
  // coverage. Select instead of branching: a scene-index row is per draw, and
  // derivative-bearing coverage must stay in uniform control flow.
  let textureOnly = material.shadowAlphaMode > 0.5;
  let textureAlpha = unlitTextureAlpha(texSample.a) * mappedAlpha;
  let coverage = alphaCoverage(
    select(material.baseColor.a * vertexColor.a, 1.0, textureOnly) * textureAlpha,
    material.alphaCutoff,
    select(material.alphaToCoverage, 0.0, textureOnly),
  );
  applyAlphaHash(coverage, in.positionOS, select(material.alphaHash, 0.0, textureOnly));
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
#endif
};

@vertex
fn vs_temporal(in : VsIn, @builtin(instance_index) idx : u32) -> TemporalVsOut {
  let current = unlitVertex(in, idx);
#if SKINNING_DISABLED == false
  let descriptor = skinTaskDescriptor(unlitSkinCandidate(idx));
  let currentSkin = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, false);
  let currentWorld = currentSkin * vec4<f32>(in.pos, 1.0);
#else
  let currentWorld = vec4<f32>(current.worldPos, 1.0);
#endif
  var previousWorld = currentWorld;
#if SKINNING_DISABLED == false
  let previousSkin = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, true);
  previousWorld = previousSkin * vec4<f32>(in.pos, 1.0);
#else
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  previousWorld = sceneIndexDraw(visibleItems[idx].x).previousWorld * vec4<f32>(in.pos, 1.0);
#else
#if STORAGE_BUFFER_AVAILABLE == true
  previousWorld = meshes[0].previousWorldFromLocal *
    instances[idx].previousLocalFromInstance * vec4<f32>(in.pos, 1.0);
#endif
#endif
#endif
  var out : TemporalVsOut;
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  out.materialAddress = current.materialAddress;
  out.sceneTemporal = sceneIndexDraw(visibleItems[idx].x).temporal;
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

@fragment
fn fs_temporal(in : TemporalVsOut) -> @location(0) vec4<f32> {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  selectSceneMaterial(in.materialAddress, in.clip.xy);
#endif
  applyViewClipping(in.clippingPositionWS, false);
#ifdef MATERIAL_CLIPPING_AVAILABLE
  applyLocalClipping(in.clippingPositionWS, false, array<vec4<f32>, 6>(material.clippingPlaneA, material.clippingPlaneB, material.clippingPlaneC, material.clippingPlaneD, material.clippingPlaneE, material.clippingPlaneF), material.clippingControl);
#endif

  let texSample = sampleMaterialTextureLinear(baseColorTexture, baseColorSampler, in.uv, material.baseColorTextureCoordinatesMetadata.zw);
  let vertexColor = temporalVertexColor(in);
  let mappedAlpha = sampleMaterialTextureLinear(alphaTexture, alphaSampler, in.alphaUv, material.alphaTextureCoordinatesMetadata.zw)[u32(material.alphaChannel)];
  let coverage = alphaCoverage(material.baseColor.a * unlitTextureAlpha(texSample.a) * vertexColor.a * mappedAlpha, material.alphaCutoff, material.alphaToCoverage);
  applyAlphaHash(coverage, in.positionOS, material.alphaHash);
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
#if STORAGE_BUFFER_AVAILABLE == true
  reactive = meshes[0].temporal.x;
  motionValid = meshMotionValid(meshes[0].temporal.y);
#endif
#endif
  motionValid = motionValid && in.skinHistoryValid != 0u;
  // Material coverage is shared shader state, never copied into every Mesh row.
  if (material.alphaHash <= 0.5 && alpha < 1.0) { reactive = 1.0; }
  return packSceneTemporalV1WithValidity(
    in.currentClip,
    in.previousClip,
    view.temporalProjection,
    reactive,
    motionValid,
  );
}
