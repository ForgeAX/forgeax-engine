#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#if TERRAIN_GEOMETRY_AVAILABLE == true
#import forgeax_material::terrain_vertex::{terrainVertex, terrainNormal}
#endif
#pragma variant_axis SKINNING_DISABLED
#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_EXPLICIT
#pragma variant_axis ALPHA_MASK
#pragma variant_axis VERTEX_COLOR_AVAILABLE
#pragma material_slot surface
#import forgeax_material::displacement::{displaceVertex, displacedNormal}
#define_import_path forgeax::default-shadow-caster
#import forgeax_clipping::planes::{applyViewClipping, applyLocalClipping}
#import forgeax_material::slot::surface::{evaluate_surface, evaluate_standard_surface}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{material}

#import forgeax_view::common::{applyLodCoverage, View, Mesh, InstanceData, ShadowCasterCascade, view, shadowCasterCascade, sampleMaterialTexture}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw, sceneIndexMorphPosition, sceneInstances, SCENE_INDEX_LOCAL_IDENTITY}
#else
#import forgeax_view::common::{meshes, instances}
#endif

// The depth pass shares the Standard Surface contract with Forward/Deferred.
// Alpha-mask and GPU scene-index variants add only producer-owned bindings;
// ordinary casters keep the same four-slot pipeline layout.

struct VsInput {
  @location(0) position : vec3<f32>,
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
  @location(1) normal : vec3<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(2) uv : vec2<f32>,
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  @location(3) tangent : vec4<f32>,
#endif
#if VERTEX_COLOR_AVAILABLE == true
  @location(13) color : vec4<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(6) uv1 : vec2<f32>,
  @location(7) uv2 : vec2<f32>,
  @location(8) uv3 : vec2<f32>,
  @location(9) uv4 : vec2<f32>,
  @location(10) uv5 : vec2<f32>,
  @location(11) uv6 : vec2<f32>,
  @location(12) uv7 : vec2<f32>,
#endif
#endif
#if SKINNING_DISABLED == false
  @location(4) skinIndex : vec4<u32>,
  @location(5) skinWeight : vec4<f32>,
#endif
};

struct VsOut {
  // Surface specialization must not perturb identical caster position arithmetic.
  @builtin(position) @invariant clip : vec4<f32>,
  @location(1) positionWS : vec3<f32>,
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
#ifndef STANDARD_OBJECT_POSITION_UNUSED
  @location(0) positionOS : vec3<f32>,
#endif
  @location(2) normalWS : vec3<f32>,
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  @location(3) tangentWS : vec4<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  // UV sets travel in pairs so the flat object basis fits the same budget.
  @location(4) uv0And1 : vec4<f32>,
  @location(5) uv2And3 : vec4<f32>,
  @location(6) uv4And5 : vec4<f32>,
  @location(10) uv6And7 : vec4<f32>,
#endif
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  @location(7) @interpolate(flat) objectBasis0 : vec3<f32>,
  @location(8) @interpolate(flat) objectBasis1 : vec3<f32>,
  @location(9) @interpolate(flat) objectBasis2 : vec3<f32>,
#endif
#if VERTEX_COLOR_AVAILABLE == true
  @location(12) color : vec4<f32>,
#endif
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  @location(11) @interpolate(flat) materialAddress : vec2<u32>,
#endif
};

#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
#endif

#if SKINNING_DISABLED == false
#import forgeax_skin::task::{skinTaskDescriptor, skinTaskBlend, skinTaskDirectCandidate}
#endif

fn _cascadeLightViewProj(layer : u32) -> mat4x4<f32> {
  switch (layer) {
    case 0u: { return view.lightViewProj_A; }
    case 1u: { return view.lightViewProj_B; }
    case 2u: { return view.lightViewProj_C; }
    default: { return view.lightViewProj_D; }
  }
}

fn standardVertexPosition(in : VsInput) -> vec3<f32> {
#if TERRAIN_GEOMETRY_AVAILABLE == true
  return terrainVertex(in.position, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
#else
#ifdef DISPLACEMENT_TEXTURE_AVAILABLE
  if (standardUsesDisplacementTexture()) {
    return displaceVertex(in.position, in.normal, displacementTexture, displacementTexture_sampler,
      material.displacementScale, material.displacementBias,
      material.displacementTextureCoordinatesTransform, material.displacementTextureCoordinatesMetadata, material.displacementTextureCoordinatesRotation,
      array<vec2<f32>, 8>(in.uv, in.uv1, in.uv2, in.uv3, in.uv4, in.uv5, in.uv6, in.uv7));
  }
#endif
  return in.position;
#endif
}

fn shadowVertex(source : VsInput, idx : u32, vertex : u32) -> VsOut {
  var in = source;
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // visible = (scene instance row, material row, candidate row, LOD fade).
  let visible = visibleItems[idx];
  in.position = sceneIndexMorphPosition(visible.x, vertex, in.position);
  let materialIndex = visible.y;
  let lodFadeBits = visible.w;
  let sceneDraw = sceneIndexDraw(visible.x);
  material = sceneMaterials[materialIndex];
#if SKINNING_DISABLED == false
  let paletteBase = visible.z;
  // The palette already carries world space; keep the shared scene rows bound.
  _ = sceneDraw.world;
#endif
#else
#if SKINNING_DISABLED == false
  let paletteBase = skinTaskDirectCandidate();
#endif
#endif
  let localPosition = standardVertexPosition(in);
#if SKINNING_DISABLED == false
  let descriptor = skinTaskDescriptor(paletteBase);
  let skinMatrix = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, false);
  let worldPos = skinMatrix * vec4<f32>(localPosition, 1.0);
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
  let worldNormal = normalize((skinMatrix * vec4<f32>(in.normal, 0.0)).xyz);
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  let worldTangent = normalize((skinMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
#endif
  let objectToWorld = skinMatrix;
#endif
#else
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  let worldMatrix = sceneDraw.world * SCENE_INDEX_LOCAL_IDENTITY;
#else
  let worldMatrix = meshes[0u].worldFromLocal * instances[idx].localFromInstance;
#endif
  let worldPos = worldMatrix * vec4<f32>(localPosition, 1.0);
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
  let worldNormal = normalize((worldMatrix * vec4<f32>(in.normal, 0.0)).xyz);
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  let worldTangent = normalize((worldMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
#endif
  let objectToWorld = worldMatrix;
#endif
#endif

  var out : VsOut;
  if (shadowCasterCascade.isSpot == 1u) {
    out.clip = shadowCasterCascade.spotLightViewProj * worldPos;
  } else {
    out.clip = _cascadeLightViewProj(shadowCasterCascade.index) * worldPos;
  }
  out.positionWS = worldPos.xyz;
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
#ifndef STANDARD_OBJECT_POSITION_UNUSED
  out.positionOS = localPosition;
#endif
  #if TERRAIN_GEOMETRY_AVAILABLE == true
  let terrainN = terrainNormal(in.position, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
  out.normalWS = normalize((objectToWorld * vec4<f32>(terrainN, 0.0)).xyz);
#else
  out.normalWS = worldNormal;
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  #if TERRAIN_GEOMETRY_AVAILABLE == true
  let terrainT = normalize(vec3<f32>(terrainN.y, -terrainN.x, 0.0));
  out.tangentWS = vec4<f32>(normalize((objectToWorld * vec4<f32>(terrainT, 0.0)).xyz), -1.0);
#else
  out.tangentWS = vec4<f32>(worldTangent, in.tangent.w);
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  #if TERRAIN_GEOMETRY_AVAILABLE == true
  out.uv0And1 = vec4<f32>((localPosition.xz - material.terrainSection.xy) / material.terrainSection.z, in.uv1);
#else
  out.uv0And1 = vec4<f32>(in.uv, in.uv1);
#endif
  out.uv2And3 = vec4<f32>(in.uv2, in.uv3);
  out.uv4And5 = vec4<f32>(in.uv4, in.uv5);
  out.uv6And7 = vec4<f32>(in.uv6, in.uv7);
#endif
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  out.objectBasis0 = objectToWorld[0].xyz;
  out.objectBasis1 = objectToWorld[1].xyz;
  out.objectBasis2 = objectToWorld[2].xyz;
#endif
#if VERTEX_COLOR_AVAILABLE == true
  out.color = in.color;
#endif
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  out.materialAddress = vec2<u32>(materialIndex, lodFadeBits);
#endif
  return out;
}

@vertex
fn vs_main(in : VsInput, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return shadowVertex(in, idx, vertex);
}

// Scene-index shadow batches use a receipt-owned entry point so the indirect
// lane cannot silently reinterpret the visible stream as instance indices.
@vertex
fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return shadowVertex(in, idx, vertex);
}

fn evaluateShadowSurface(in : VsOut, frontFacing : bool) -> SurfaceData {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Keep custom shadow helpers on the same producer-selected scene row as the
  // Standard Surface path. The scene compiler maps `material` to a private
  // per-invocation provider for this variant.
  material = sceneMaterials[in.materialAddress.x];
  applyLodCoverage(in.clip.xy, bitcast<f32>(in.materialAddress.y));
#endif

  applyViewClipping(in.positionWS, true);
#ifdef MATERIAL_CLIPPING_AVAILABLE
  applyLocalClipping(in.positionWS, true, array<vec4<f32>, 6>(material.clippingPlaneA, material.clippingPlaneB, material.clippingPlaneC, material.clippingPlaneD, material.clippingPlaneE, material.clippingPlaneF), material.clippingControl);
#endif
#ifdef OPAQUE_SHADOW_COVERAGE_AVAILABLE
  // The selected opaque Surface has no geometry inputs. Keep clipping and
  // LOD coverage above, without asking its caster for unused UVs or tangents.
  return evaluate_surface(SurfaceInput());
#else
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
  let viewDirectionWS = vec3<f32>(0.0);
#else
  let viewDirectionWS = normalize(view.cameraPos - in.positionWS);
#endif
  let input = SurfaceInput(
#ifdef STANDARD_OBJECT_POSITION_UNUSED
    vec3<f32>(0.0),
#else
    in.positionOS,
#endif
    in.positionWS,
    normalize(cross(dpdy(in.positionWS), dpdx(in.positionWS))) * select(-1.0, 1.0, frontFacing),
    in.normalWS,
#ifdef STANDARD_TANGENT_INPUT_UNUSED
    vec4<f32>(0.0),
#else
    in.tangentWS,
#endif
    viewDirectionWS,
#ifdef STANDARD_UV_INPUT_UNUSED
    vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0),
    vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0),
#else
    in.uv0And1.xy,
    in.uv0And1.zw,
    in.uv2And3.xy,
    in.uv2And3.zw,
    in.uv4And5.xy,
    in.uv4And5.zw,
    in.uv6And7.xy,
    in.uv6And7.zw,
#endif
#if VERTEX_COLOR_AVAILABLE == true
    in.color,
#else
    vec4<f32>(1.0),
#endif
    frontFacing,
    vec4<f32>(0.0), vec4<f32>(0.0),
#ifdef STANDARD_OBJECT_BASIS_UNUSED
    mat3x3<f32>(),
#else
    mat3x3<f32>(in.objectBasis0, in.objectBasis1, in.objectBasis2),
#endif
    view.fogHeightOpacity.w,
  );
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
  var shadowMaterial = material;
  var shadowInput = input;
#ifdef SHADOW_ALPHA_MODE_AVAILABLE
  // GPU Scene supplies per-invocation material values. Keep derivative-bearing
  // Surface evaluation outside divergent flow, including the native mode.
  let textureOnly = material.shadowAlphaMode > 0.5;
  shadowMaterial.baseColor.a = select(material.baseColor.a, 1.0, textureOnly);
#ifdef ALPHA_HASH_AVAILABLE
  shadowMaterial.alphaHash = select(material.alphaHash, 0.0, textureOnly);
#endif
#ifdef ALPHA_TO_COVERAGE_AVAILABLE
  shadowMaterial.alphaToCoverage = select(material.alphaToCoverage, 0.0, textureOnly);
#endif
  shadowInput.vertexColor.a = select(input.vertexColor.a, 1.0, textureOnly);
#endif
  return evaluate_standard_surface(shadowInput, shadowMaterial);
#else
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#if ALPHA_MASK == true
  return evaluate_standard_surface(input, material);
#else
  return evaluate_surface(input);
#endif
#else
  return evaluate_surface(input);
#endif
#endif
#endif
}

fn alphaTestShadowSurface(surface : SurfaceData) {
  if (surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold) {
    discard;
  }
}

// The depth-only pass has no color target; alpha clipping still runs through
// the selected Standard Surface before depth is committed.
@fragment
fn fs_shadow(in : VsOut, @builtin(front_facing) frontFacing : bool) {
  alphaTestShadowSurface(evaluateShadowSurface(in, frontFacing));
}

// Keep fs_main available for material consumers that explicitly request it.
@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) {
  alphaTestShadowSurface(evaluateShadowSurface(in, frontFacing));
}
