#import forgeax_geometry::tangent_frame32::{decodeTangentFrame32}
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#if TERRAIN_GEOMETRY_AVAILABLE == true
#import forgeax_material::terrain_vertex::{terrainVertex, terrainNormal}
#endif
#pragma variant_axis SKINNING_DISABLED
#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_EXPLICIT
#pragma variant_axis ALPHA_MASK
#pragma variant_axis CLIPPING_PLANES
#pragma variant_axis LOD_DITHER
#pragma variant_axis STANDARD_LEAN_INPUTS
#pragma variant_axis VERTEX_COLOR_AVAILABLE
#pragma material_slot surface
#pragma material_slot deformation
#pragma variant_axis WATER_WAVES_AVAILABLE
#pragma variant_axis WATER_INFO_RGBA16
#if WATER_WAVES_AVAILABLE == true
#import forgeax_material::water_waves::{waterMeshTileVertex, waterMeshCoverageContains, waterDynamicBoundsContains, waterMaterialDrawData, waterMeshSourceBodyIndex, waterMeshInstanceTransformIndex}
#if MATERIAL_WATER_DEFORMATION_AVAILABLE == true
#import forgeax_material::slot::deformation::{deform_water_vertex}
#import forgeax_material::water_deformation_input::{waterDeformationInput, waterVertexFlowXZ, waterVertexFlowMPerSec, waterMeshFarContinuity}
#endif
#endif
#import forgeax_material::displacement::{evaluateStandardVertexPosition}
#define_import_path forgeax::default-shadow-caster
#import forgeax_shadow::surface::{projectShadowPosition}
#import forgeax_clipping::planes::{applyViewClipping, applyLocalClipping}
#import forgeax_material::slot::surface::{evaluate_surface, evaluate_standard_surface, evaluate_standard_coverage}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{material}

#import forgeax_view::common::{applyLodCoverage, View, Mesh, InstanceData, view, sampleMaterialTexture, transformNormal}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw, sceneIndexMorphPosition, sceneIndexMorphNormal, sceneIndexMorphTangent, sceneInstances, SCENE_INDEX_LOCAL_IDENTITY}
#else
#import forgeax_view::common::{meshes, instances}
#endif

// The depth pass shares the Standard Surface contract with Forward/Deferred.
// Alpha-mask and GPU scene-index variants add only producer-owned bindings;
// ordinary casters keep the same four-slot pipeline layout.

struct VsInput {
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
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
#ifndef STANDARD_SINGLE_UV_SET
  @location(6) uv1 : vec2<f32>,
  @location(7) uv2 : vec2<f32>,
  @location(8) uv3 : vec2<f32>,
  @location(9) uv4 : vec2<f32>,
  @location(10) uv5 : vec2<f32>,
  @location(11) uv6 : vec2<f32>,
  @location(12) uv7 : vec2<f32>,
#endif
#endif
#endif
#if SKINNING_DISABLED == false
  @location(4) skinIndex : vec4<u32>,
  @location(5) skinWeight : vec4<f32>,
#endif
};

struct Frame32Input {
  @location(14) tangentFrame : u32,

  @location(0) position : vec3<f32>,
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(2) uv : vec2<f32>,
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
#endif
#if VERTEX_COLOR_AVAILABLE == true
  @location(13) color : vec4<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(6) uv1 : vec2<f32>,
  @location(7) uv2 : vec2<f32>,
  @location(8) uv3 : vec2<f32>,
  @location(9) uv4 : vec2<f32>,
  @location(10) uv5 : vec2<f32>,
  @location(11) uv6 : vec2<f32>,
  @location(12) uv7 : vec2<f32>,
#endif
#endif
#endif
#if SKINNING_DISABLED == false
  @location(4) skinIndex : vec4<u32>,
  @location(5) skinWeight : vec4<f32>,
#endif
};

fn frame32Input(input:Frame32Input)->VsInput {
  var output : VsInput;
  let frame=decodeTangentFrame32(input.tangentFrame);

  output.position = input.position;
  output.normal = frame.normal;
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
#ifndef STANDARD_UV_INPUT_UNUSED
  output.uv = input.uv;
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  output.tangent = frame.tangent;
#endif
#if VERTEX_COLOR_AVAILABLE == true
  output.color = input.color;
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  output.uv1 = input.uv1;
  output.uv2 = input.uv2;
  output.uv3 = input.uv3;
  output.uv4 = input.uv4;
  output.uv5 = input.uv5;
  output.uv6 = input.uv6;
  output.uv7 = input.uv7;
#endif
#endif
#endif
#if SKINNING_DISABLED == false
  output.skinIndex = input.skinIndex;
  output.skinWeight = input.skinWeight;
#endif
  return output;
}


struct VsOut {
  // Surface specialization must not perturb identical caster position arithmetic.
  @builtin(position) @invariant clip : vec4<f32>,
  @location(1) positionWS : vec3<f32>,
#if WATER_WAVES_AVAILABLE == true
  @location(13) waterCoverageXZ: vec3<f32>,
  @location(14) @interpolate(flat) waterTileIndex: u32,
#endif
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
#ifndef STANDARD_OBJECT_POSITION_UNUSED
  @location(0) positionOS : vec3<f32>,
#endif
  // A lean alpha-mask caster interpolates only position, UV0 and the material
  // row, as UE's depth-only pass carries the vertex factory interpolants only
  // for non-solid materials (DepthOnlyVertexShader.usf:15-16,75-78) and the
  // factory emits the tangent basis and extra TexCoords only when the material
  // reads them (LocalVertexFactoryCommon.ush:19-20,32-33).
#ifndef STANDARD_LEAN_INPUTS
  @location(2) normalWS : vec3<f32>,
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  @location(3) tangentWS : vec4<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  // UV sets travel in pairs so the flat object basis fits the same budget.
#ifdef STANDARD_SINGLE_UV_SET
  @location(4) uv0 : vec2<f32>,
#else
  @location(4) uv0And1 : vec4<f32>,
  @location(5) uv2And3 : vec4<f32>,
  @location(6) uv4And5 : vec4<f32>,
  @location(10) uv6And7 : vec4<f32>,
#endif
#endif
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  @location(7) @interpolate(flat) objectBasis0 : vec3<f32>,
  @location(8) @interpolate(flat) objectBasis1 : vec3<f32>,
  @location(9) @interpolate(flat) objectBasis2 : vec3<f32>,
#endif
  // The stock Surface reads vertex colour only for alpha coverage, which an
  // opaque caster never tests, so its colour interpolant drops as UE sets
  // INTERPOLATE_VERTEX_COLOR only when the material reads VertexColor
  // (HLSLMaterialTranslator.cpp:2311, LocalVertexFactoryCommon.ush:23-25).
#if VERTEX_COLOR_AVAILABLE == true
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
#if ALPHA_MASK == true
  @location(12) color : vec4<f32>,
#endif
#else
  @location(12) color : vec4<f32>,
#endif
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
#import forgeax_skin::task::{skinTaskDescriptor, skinTaskBlend, skinTaskPosition, skinTaskDirectCandidate}
#endif

fn standardVertexPosition(in : VsInput) -> vec3<f32> {
#if TERRAIN_GEOMETRY_AVAILABLE == true
  return terrainVertex(in.position, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
#else
#ifdef OPAQUE_SHADOW_COVERAGE_AVAILABLE
  return in.position;
#else
  return evaluateStandardVertexPosition(in.position, in.normal,
#ifdef STANDARD_UV_INPUT_UNUSED
    array<vec2<f32>, 8>(),
#else
#ifdef STANDARD_SINGLE_UV_SET
    array<vec2<f32>, 8>(in.uv, in.uv, in.uv, in.uv, in.uv, in.uv, in.uv, in.uv),
#else
    array<vec2<f32>, 8>(in.uv, in.uv1, in.uv2, in.uv3, in.uv4, in.uv5, in.uv6, in.uv7),
#endif
#endif
  );
#endif
#endif
}

fn shadowVertex(source : VsInput, idx : u32, vertex : u32) -> VsOut {
  var in = source;
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // visible = (scene instance row, material row, candidate row, LOD fade).
  let visible = visibleItems[idx];
  in.position = sceneIndexMorphPosition(visible.x, vertex, in.position);
  in.normal = sceneIndexMorphNormal(visible.x, vertex, in.normal);
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  in.tangent = sceneIndexMorphTangent(visible.x, vertex, in.tangent);
#endif
#endif
  let materialIndex = visible.y;
  let lodFadeBits = visible.w;
  let sceneDraw = sceneIndexDraw(visible.x);
  material = sceneMaterials[materialIndex];
#if SKINNING_DISABLED == false
  let paletteBase = visible.z;
  let meshTranslation = sceneDraw.world[3].xyz;
#endif
#else
#if SKINNING_DISABLED == false
  let paletteBase = skinTaskDirectCandidate();
  let meshTranslation = meshes[0u].worldFromLocal[3].xyz;
#endif
#endif
  var localPosition = standardVertexPosition(in);
#if WATER_WAVES_AVAILABLE == true
  let waterTile = waterMeshTileVertex(localPosition, idx);
  localPosition = waterTile.position;
#endif
#if TERRAIN_GEOMETRY_AVAILABLE == true
  let biasLocalNormal = terrainNormal(in.position, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
#else
  let biasLocalNormal = in.normal;
#endif
#if SKINNING_DISABLED == false
  let descriptor = skinTaskDescriptor(paletteBase);
  let skinMatrix = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, false);
#if WATER_WAVES_AVAILABLE == true
  let waterLocalToWorld = skinMatrix;
#endif
  var worldPos = skinTaskPosition(descriptor, skinMatrix, localPosition, meshTranslation);
  var biasNormal = transformNormal(skinMatrix, biasLocalNormal);
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
  var transformIndex = idx;
#if WATER_WAVES_AVAILABLE == true
  transformIndex = waterMeshInstanceTransformIndex(idx);
#endif
  let worldMatrix = meshes[0u].worldFromLocal * instances[transformIndex].localFromInstance;
#endif
#if WATER_WAVES_AVAILABLE == true
  let waterLocalToWorld = worldMatrix;
#endif
  var worldPos = worldMatrix * vec4<f32>(localPosition, 1.0);
  var biasNormal = transformNormal(worldMatrix, biasLocalNormal);
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
  let worldNormal = normalize((worldMatrix * vec4<f32>(in.normal, 0.0)).xyz);
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  let worldTangent = normalize((worldMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
#endif
  let objectToWorld = worldMatrix;
#endif
#endif

  var waterMask = 1.0;
#if WATER_WAVES_AVAILABLE == true
#if MATERIAL_WATER_DEFORMATION_AVAILABLE == true
  var waterVertexColor = vec4<f32>(1.0);
#ifdef VERTEX_COLOR_AVAILABLE
  waterVertexColor = in.color;
#endif
  let waterVertexFlow = waterVertexFlowMPerSec(waterVertexFlowXZ(waterVertexColor, waterLocalToWorld));
  let deformationInput = waterDeformationInput(waterTile.bodyIndex, waterTile.waveBodyIndex, worldPos.xyz, worldPos.xyz,
    normalize(biasNormal), view.cameraPos, waterTile.waveRelativeXZ, select(0u, 1u, waterTile.far), waterVertexFlow);
  let deformation = waterMeshFarContinuity(deformationInput, deform_water_vertex(deformationInput), idx);
  worldPos = vec4<f32>(deformation.currentPositionM, 1.0);
  biasNormal = deformation.currentNormalYUp;
  waterMask = deformation.waterMask;
#endif
#endif
  var out : VsOut;
#if WATER_WAVES_AVAILABLE == true
  out.waterCoverageXZ = vec3<f32>(waterTile.coverageXZ, waterMask);
  out.waterTileIndex = idx;
#endif
  out.clip = projectShadowPosition(worldPos, biasNormal);
  out.positionWS = worldPos.xyz;
#ifndef OPAQUE_SHADOW_COVERAGE_AVAILABLE
#ifndef STANDARD_OBJECT_POSITION_UNUSED
  out.positionOS = localPosition;
#endif
  #if TERRAIN_GEOMETRY_AVAILABLE == true
  let terrainN = terrainNormal(in.position, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
#ifndef STANDARD_LEAN_INPUTS
  out.normalWS = normalize((objectToWorld * vec4<f32>(terrainN, 0.0)).xyz);
#endif
#else
#ifndef STANDARD_LEAN_INPUTS
  out.normalWS = normalize(biasNormal);
#endif
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
#ifdef STANDARD_SINGLE_UV_SET
  out.uv0 = in.uv;
#else
  #if TERRAIN_GEOMETRY_AVAILABLE == true
  out.uv0And1 = vec4<f32>((localPosition.xz - material.terrainSection.xy) / material.terrainSection.z, in.uv1);
#else
  out.uv0And1 = vec4<f32>(in.uv, in.uv1);
#endif
  out.uv2And3 = vec4<f32>(in.uv2, in.uv3);
  out.uv4And5 = vec4<f32>(in.uv4, in.uv5);
  out.uv6And7 = vec4<f32>(in.uv6, in.uv7);
#endif
#endif
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  out.objectBasis0 = objectToWorld[0].xyz;
  out.objectBasis1 = objectToWorld[1].xyz;
  out.objectBasis2 = objectToWorld[2].xyz;
#endif
#if VERTEX_COLOR_AVAILABLE == true
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
#if ALPHA_MASK == true
  out.color = in.color;
#endif
#else
  out.color = in.color;
#endif
#endif
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  out.materialAddress = vec2<u32>(materialIndex, lodFadeBits);
#endif
  return out;
}

fn vs_main_impl_entry(in : VsInput, idx : u32, vertex : u32) -> VsOut {
  return shadowVertex(in, idx, vertex);
}

@vertex
fn vs_main(in : VsInput, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return vs_main_impl_entry(in, idx, vertex);
}

@vertex
fn vs_main_packed(input : Frame32Input, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return vs_main_impl_entry(frame32Input(input), idx, vertex);
}

// Scene-index shadow batches use a receipt-owned entry point so the indirect
// lane cannot silently reinterpret the visible stream as instance indices.
fn vs_scene_index_impl_entry(in : VsInput, idx : u32, vertex : u32) -> VsOut {
  return shadowVertex(in, idx, vertex);
}

@vertex
fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return vs_scene_index_impl_entry(in, idx, vertex);
}

@vertex
fn vs_scene_index_packed(input : Frame32Input, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return vs_scene_index_impl_entry(frame32Input(input), idx, vertex);
}

#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#if SKINNING_DISABLED == true
// Position-only stream for casters whose fragment stage can never discard
// (renderer: shadowCasterDepthOnly). UE binds PositionOnlyMain with zero
// interpolants when the material writes every pixel and does not move
// vertices (ShadowDepthVertexShader.usf:260-276, ShadowDepthRendering.cpp
// :2191-2194); masked / displaced casters keep vs_scene_index and its UV0
// (ShadowDepthVertexShader.usf:191-194). Deviation: UE's position-only stream
// has no normal; this caster keeps it for the slope-scaled receiver bias in
// projectShadowPosition, so the clip arithmetic matches shadowVertex exactly.
struct PositionOnlyVsInput {
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
};

struct PositionOnlyFrame32Input {
  @location(0) position:vec3<f32>,
  @location(14) tangentFrame:u32,
};


struct PositionOnlyVsOut {
  @builtin(position) @invariant clip : vec4<f32>,
};

fn shadowPositionOnly(in : PositionOnlyVsInput, idx : u32, vertex : u32) -> PositionOnlyVsOut {
  let visible = visibleItems[idx];
  let morphedPosition = sceneIndexMorphPosition(visible.x, vertex, in.position);
  let morphedNormal = sceneIndexMorphNormal(visible.x, vertex, in.normal);
  let sceneDraw = sceneIndexDraw(visible.x);
#if TERRAIN_GEOMETRY_AVAILABLE == true
  material = sceneMaterials[visible.y];
  let localPosition = terrainVertex(morphedPosition, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
  let biasLocalNormal = terrainNormal(morphedPosition, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
#else
  // Displacement makes the caster ineligible, so the authored position stands.
  let localPosition = morphedPosition;
  let biasLocalNormal = morphedNormal;
#endif
  let worldMatrix = sceneDraw.world * SCENE_INDEX_LOCAL_IDENTITY;
  var out : PositionOnlyVsOut;
  out.clip = projectShadowPosition(worldMatrix * vec4<f32>(localPosition, 1.0), transformNormal(worldMatrix, biasLocalNormal));
  return out;
}

@vertex
fn vs_scene_index_position_only(in : PositionOnlyVsInput, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> PositionOnlyVsOut {
  return shadowPositionOnly(in,idx,vertex);
}

@vertex
fn vs_scene_index_position_only_packed(input:PositionOnlyFrame32Input,@builtin(instance_index) idx:u32,@builtin(vertex_index) vertex:u32)->PositionOnlyVsOut {
  return shadowPositionOnly(PositionOnlyVsInput(input.position,decodeTangentFrame32(input.tangentFrame).normal),idx,vertex);
}
#endif
#endif

#if WATER_WAVES_AVAILABLE == true
var<private> shadowWaterCovered : bool = true;
#endif

fn evaluateShadowSurface(in : VsOut, frontFacing : bool) -> SurfaceData {
#if WATER_WAVES_AVAILABLE == true
  shadowWaterCovered = !(in.waterCoverageXZ.z <= 0.0) && waterMeshCoverageContains(in.waterTileIndex, in.waterCoverageXZ.xy)
    && waterDynamicBoundsContains(waterMeshSourceBodyIndex(in.waterTileIndex), in.positionWS);
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Keep custom shadow helpers on the same producer-selected scene row as the
  // Standard Surface path. The scene compiler maps `material` to a private
  // per-invocation provider for this variant.
  material = sceneMaterials[in.materialAddress.x];
#if LOD_DITHER == true
  applyLodCoverage(in.clip.xy, bitcast<f32>(in.materialAddress.y));
#endif
#endif

#if CLIPPING_PLANES == true
  applyViewClipping(in.positionWS, true);
#endif
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
  let geometricNormalWS = normalize(cross(dpdy(in.positionWS), dpdx(in.positionWS))) * select(-1.0, 1.0, frontFacing);
  let input = SurfaceInput(
#ifdef STANDARD_OBJECT_POSITION_UNUSED
    vec3<f32>(0.0),
#else
    in.positionOS,
#endif
    in.positionWS,
    geometricNormalWS,
#ifndef STANDARD_LEAN_INPUTS
    in.normalWS,
#else
    geometricNormalWS,
#endif
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
#ifdef STANDARD_SINGLE_UV_SET
    in.uv0, in.uv0, in.uv0, in.uv0, in.uv0, in.uv0, in.uv0, in.uv0,
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
#endif
#if VERTEX_COLOR_AVAILABLE == true
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
#if ALPHA_MASK == true
    in.color,
#else
    vec4<f32>(1.0),
#endif
#else
    in.color,
#endif
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
  return evaluate_standard_coverage(shadowInput, shadowMaterial);
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
#if ALPHA_MASK == true
  // The stock Surface raises the clip threshold only when the material declares
  // alphaCutoff; without it (hash-only or coverage-only) the cutoff test is
  // absent from the source. A custom Surface keeps the generic gate.
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
#ifdef ALPHA_CLIPPING_AVAILABLE
  if (surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold) {
    discard;
  }
#endif
#else
  if (surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold) {
    discard;
  }
#endif
#endif
}

// The depth-only pass has no color target; alpha clipping still runs through
// the selected Standard Surface before depth is committed.
@fragment
fn fs_shadow(in : VsOut, @builtin(front_facing) frontFacing : bool) {
  let surface = evaluateShadowSurface(in, frontFacing);
#if WATER_WAVES_AVAILABLE == true
  if (!shadowWaterCovered) { discard; }
#endif
  alphaTestShadowSurface(surface);
}

// Keep fs_main available for material consumers that explicitly request it.
@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) {
  let surface = evaluateShadowSurface(in, frontFacing);
#if WATER_WAVES_AVAILABLE == true
  if (!shadowWaterCovered) { discard; }
#endif
  alphaTestShadowSurface(surface);
}
