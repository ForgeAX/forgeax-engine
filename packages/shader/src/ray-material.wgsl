#define_import_path forgeax_material::ray_surface
#pragma material_slot surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::ray_abi::{RayMaterialInput, RayMaterialSurface, encodeCardNormal}
#import forgeax_pbr::brdf::{standardOpaqueF0}
#import forgeax_material::slot::surface::{evaluate_surface}

#ifdef CARD_SURFACE_CONTEXT
struct CardTriangle { a: vec4f, b: vec4f, c: vec4f, ids: vec4u, maskData: vec4u }
struct CardAttributeVertex { position: vec4f, color: vec4f, uvA: vec4f, uvB: vec4f, uvC: vec4f, uvD: vec4f, normal: vec4f, tangent: vec4f }
struct CardAttributes { a: CardAttributeVertex, b: CardAttributeVertex, c: CardAttributeVertex }
struct CardProjection { viewProjection: mat4x4f, eye: vec4f, geometryCoverage: u32 }
@group(0) @binding(0) var<storage, read> cardTriangles: array<CardTriangle>;
@group(0) @binding(1) var<storage, read> cardAttributes: array<CardAttributes>;
@group(0) @binding(2) var<uniform> card: CardProjection;
#else
struct MaterialSelection { id: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> rayInputs: array<RayMaterialInput>;
@group(0) @binding(1) var<storage, read_write> raySurfaces: array<RayMaterialSurface>;
@group(0) @binding(2) var<uniform> materialSelection: MaterialSelection;

#endif

fn evaluateRayMaterial(record: RayMaterialInput) -> RayMaterialSurface {
  let input = raySurfaceInput(record);
  let surface = evaluate_surface(input);
  let f0 = standardOpaqueF0(surface.baseColor, surface.metallic, material.specularColor,
    clamp(material.specular, 0.0, 1.0), max(material.ior, 1.0));
  let geometricNormal = record.normal.xyz * select(-1.0, 1.0, input.frontFacing);
  // Preserve the shared Surface normal, including smoothed/mapped normals across
  // the geometric hemisphere. BSDF value/PDF own both hemisphere clips and null
  // events; this is not a malformed material and must not drop the whole sample.
  let admitted = surface.opacity >= 0.0 && surface.opacity <= 1.0
    && surface.alphaClipThreshold >= 0.0 && surface.alphaClipThreshold <= 1.0
    && all(surface.baseColor >= vec3f(0.0)) && all(surface.baseColor <= vec3f(1.0))
    && abs(dot(surface.normalWS, surface.normalWS) - 1.0) < 0.0001
    && all(f0 >= vec3f(0)) && all(f0 <= vec3f(1))
    && surface.occlusion >= 0.0 && surface.occlusion <= 1.0
    && surface.metallic >= 0.0 && surface.metallic <= 1.0
    && surface.roughness >= 0.04 && surface.roughness <= 1.0
    && all(surface.emissive >= vec3f(0.0)) && all(surface.emissive < vec3f(1e20));
  // Match Standard raster and shadow coverage, including equality at the cutoff.
  let clipped = surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold;
  let status = select(2u, select(1u, 3u, clipped), admitted);
  var directDfgMode = 0u;
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgMode = select(0u, 1u, material.directMultiscatteringLut != 0u);
#endif
  return RayMaterialSurface(vec4f(surface.baseColor, surface.opacity),
    vec4f(surface.normalWS, surface.roughness), vec4f(surface.emissive, surface.metallic),
    vec4f(f0, surface.occlusion), vec4u(status, 0u, directDfgMode, 0u), vec4f(geometricNormal,0));
}
#ifdef CARD_SURFACE_CONTEXT
struct CardVertex {
  @builtin(position) clip: vec4f,
  @location(0) positionOS: vec3f,
  @location(1) positionWS: vec3f,
  @location(2) color: vec4f,
  @location(3) uvA: vec4f,
  @location(4) uvB: vec4f,
  @location(5) uvC: vec4f,
  @location(6) uvD: vec4f,
  @location(7) @interpolate(flat) normalWS: vec3f,
  @location(8) vertexNormalWS: vec3f,
  @location(9) tangentWS: vec4f,
}
@vertex fn vs_card(@builtin(vertex_index) index: u32) -> CardVertex {
  let tri=cardTriangles[index/3u];let attr=cardAttributes[index/3u];
  var p=tri.a.xyz;var v=attr.a;
  if(index%3u==1u){p=tri.b.xyz;v=attr.b;}
  if(index%3u==2u){p=tri.c.xyz;v=attr.c;}
  let clip=card.viewProjection*vec4f(p,1);
  return CardVertex(clip,v.position.xyz,p,v.color,v.uvA,v.uvB,v.uvC,v.uvD,
    normalize(cross(tri.b.xyz-tri.a.xyz,tri.c.xyz-tri.a.xyz))*v.normal.w,v.normal.xyz,v.tangent);
}
struct CardOutput {
  @location(0) albedoRoughness: vec4f,
  @location(1) normals: vec4f,
  @location(2) emissionMetallic: vec4f,
  @location(3) f0Validity: vec4f,
}
@fragment fn fs_card(v: CardVertex,@builtin(front_facing) front: bool) -> CardOutput {
  var outgoing=card.eye.xyz;
  if(card.eye.w==1.0){outgoing=normalize(card.eye.xyz-v.positionWS);}
  let record=RayMaterialInput(vec4f(v.positionOS,1),vec4f(v.positionWS,1),vec4f(v.normalWS,select(0.0,1.0,front)),
    v.tangentWS,vec4f(outgoing,0),v.uvA,v.uvB,v.uvC,v.uvD,v.color,vec4f(0),vec4f(0),vec4f(v.vertexNormalWS,0),vec4u(0));
  let surface=evaluateRayMaterial(record);
  // UE LumenCardBasePass separates geometry validity from material opacity;
  // the physical material cache is a proxy, not an exact alpha visibility query.
  // The same evaluator still clips exact view captures and ray-hit candidates.
  if (surface.status.x == 3u && card.geometryCoverage == 0u) { discard; }
  let validity = select(surface.status.x, 1u, surface.status.x == 3u);
  let validityAndDfg = validity | (surface.status.z << 2u);
  return CardOutput(vec4f(surface.albedoOpacity.xyz,surface.normalRoughness.w),
    vec4f(encodeCardNormal(surface.normalRoughness.xyz),encodeCardNormal(surface.geometricNormal.xyz)),
    surface.emissionMetallic,vec4f(surface.f0Occlusion.xyz,f32(validityAndDfg)));
}
#else
#ifdef RAY_SURFACE_CONTEXT
@compute @workgroup_size(64) fn cs_surface(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rayInputs)) { return; }
  let input = rayInputs[id.x];
  if (input.identity.y == 0u || input.identity.x != materialSelection.id) { return; }
  raySurfaces[id.x] = evaluateRayMaterial(input);
}
#else
// The raster diagnostic uses interpolated UVs and float attachments, like a
// real raster material. Storage-loaded UVs do not represent an interpolant.
struct ProbeVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vs_probe(@builtin(vertex_index) index: u32) -> ProbeVertex {
  let p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  let uv = vec2f((p[index].x * 0.5 + 0.5) * 8.0 * rayInputs[0].footprintA.y, 0.5);
  return ProbeVertex(vec4f(p[index], 0, 1), uv);
}
@fragment fn fs_probe(input: ProbeVertex) -> @location(0) vec4f {
  var record = rayInputs[u32(input.position.x)];
  record.uvA = vec4f(record.uvA.xy, input.uv);
  let surface = evaluateRayMaterial(record);
  switch u32(input.position.y) {
    case 0u: { return surface.albedoOpacity; }
    case 1u: { return surface.normalRoughness; }
    case 2u: { return surface.emissionMetallic; }
    default: { return surface.f0Occlusion; }
  }
}
#endif

#endif

// Hit records carry world geometry only; an identity basis keeps object-space
// helpers finite while ray admission rejects object-space material inputs.
fn rayObjectToWorld(value: RayMaterialInput) -> mat3x3f {
  return mat3x3f(vec3f(1, 0, 0), vec3f(0, 1, 0), vec3f(0, 0, 1));
}

fn raySurfaceInput(value: RayMaterialInput) -> SurfaceInput {
  return SurfaceInput(value.positionOS.xyz, value.positionWS.xyz, value.normal.xyz, value.vertexNormal.xyz,
    value.tangent, value.outgoing.xyz, value.uvA.xy, value.uvA.zw,
    value.uvB.xy, value.uvB.zw, value.uvC.xy, value.uvC.zw,
    value.uvD.xy, value.uvD.zw, value.color, value.normal.w > 0.0,
    value.footprintA, value.footprintB, rayObjectToWorld(value), 0.0);
}
