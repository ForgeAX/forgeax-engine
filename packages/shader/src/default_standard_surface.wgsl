#define_import_path forgeax_material::default_standard_surface
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
#import forgeax_material::texture_coordinates::{materialUvLinear}
#endif

#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
#import forgeax_material::surface_sampling::{sampleSurfaceTexture, surfaceTextureFootprint}
#endif
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, scaleTangentSpaceNormal, applyTBN, perturbBumpNormal}
#ifdef ALPHA_HASH_AVAILABLE
#import forgeax_material::alpha_hash::{applyAlphaHash}
#endif
#ifdef ALPHA_CLIPPING_AVAILABLE
#ifndef SURFACE_COVERAGE_DEFERRED
#import forgeax_material::alpha_hash::{alphaCoverageValue, alphaCoverageClipThreshold}
#endif
#endif

// The default Surface owns only base facts. Standard's generated Material
// interface remains the source of the scalar and texture values; the
// Standard template owns physical-layer selection and lighting.
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
fn surfaceUv(input : SurfaceInput, transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>) -> vec2<f32> {
  var source = input.uv0;
  if (metadata.x >= 1.0) { source = input.uv1; }
  if (metadata.x >= 2.0) { source = input.uv2; }
  if (metadata.x >= 3.0) { source = input.uv3; }
  if (metadata.x >= 4.0) { source = input.uv4; }
  if (metadata.x >= 5.0) { source = input.uv5; }
  if (metadata.x >= 6.0) { source = input.uv6; }
  if (metadata.x >= 7.0) { source = input.uv7; }
  return materialUvLinear(source, transform, rotation) + transform.xy;
}

const SURFACE_TRIPLANAR_OBJECT : f32 = 2.0;

// Triplanar projection shared by every base slot of one Surface evaluation.
// Plane coordinates follow Three r184 triplanarTexture (x: yz, y: zx, z: xy);
// weights follow Unreal's world-aligned blend, pow(|n|, sharpness) normalized.
struct SurfaceProjection {
  position : vec3<f32>,
  positionDx : vec3<f32>,
  positionDy : vec3<f32>,
  normal : vec3<f32>,
  weights : vec3<f32>,
};

// The pipeline specialization bit travels as its own `triplanar` parameter,
// never as a struct field: uniformity analysis taints a whole struct that also
// carries varyings, and the UV branch's implicit-derivative sample needs a
// uniform branch. A contract without the triplanar fields keeps the UV
// projection and never references them.
#ifdef TRIPLANAR_PROJECTION_AVAILABLE
fn surfaceProjection(input : SurfaceInput, materialValue : MaterialParameters) -> SurfaceProjection {
  let objectSpace = materialValue.triplanarSpace > SURFACE_TRIPLANAR_OBJECT - 0.5;
  // n_os is proportional to transpose(M) * n_ws for any invertible M.
  let normalOS = normalize(input.vertexNormalWS * input.objectToWorld);
  let normal = select(normalize(input.vertexNormalWS), normalOS, objectSpace);
  let position = select(input.positionWS, input.positionOS, objectSpace) * materialValue.triplanarScale;
  let blend = pow(abs(normal), vec3<f32>(max(materialValue.triplanarSharpness, 1.0)));
  // Derivatives come from uniform control flow: slot sampling is gated only by
  // the pipeline specialization bit, never by a per-row material value.
#ifdef RAY_SURFACE_CONTEXT
  let dx = vec3<f32>(0.0);
  let dy = vec3<f32>(0.0);
#else
  let dx = dpdx(position);
  let dy = dpdy(position);
#endif
  return SurfaceProjection(
    position, dx, dy, normal,
    blend / max(blend.x + blend.y + blend.z, 1e-6),
  );
}

fn surfaceTriplanarObjectSpace(materialValue : MaterialParameters) -> bool {
  return materialValue.triplanarSpace > SURFACE_TRIPLANAR_OBJECT - 0.5;
}
#else
fn surfaceProjection(input : SurfaceInput, materialValue : MaterialParameters) -> SurfaceProjection {
  return SurfaceProjection(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
}

fn surfaceTriplanarObjectSpace(materialValue : MaterialParameters) -> bool {
  return false;
}
#endif

fn surfacePlaneSample(tex : texture_2d<f32>, smp : sampler, uv : vec2<f32>, dx : vec2<f32>, dy : vec2<f32>,
    transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>) -> vec4<f32> {
  let scale = metadata.zw;
  return textureSampleGrad(tex, smp, (materialUvLinear(uv, transform, rotation) + transform.xy) * scale,
    materialUvLinear(dx, transform, rotation) * scale, materialUvLinear(dy, transform, rotation) * scale);
}

struct SurfaceTriplanarSamples {
  x : vec4<f32>,
  y : vec4<f32>,
  z : vec4<f32>,
};

fn surfaceTriplanarSamples(tex : texture_2d<f32>, smp : sampler, projection : SurfaceProjection,
    transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>) -> SurfaceTriplanarSamples {
  let p = projection.position;
  let dx = projection.positionDx;
  let dy = projection.positionDy;
  return SurfaceTriplanarSamples(
    surfacePlaneSample(tex, smp, p.yz, dx.yz, dy.yz, transform, metadata, rotation),
    surfacePlaneSample(tex, smp, p.zx, dx.zx, dy.zx, transform, metadata, rotation),
    surfacePlaneSample(tex, smp, p.xy, dx.xy, dy.xy, transform, metadata, rotation),
  );
}

fn surfaceSample(tex : texture_2d<f32>, smp : sampler, input : SurfaceInput, triplanar : bool,
    projection : SurfaceProjection, transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>) -> vec4<f32> {
  if (triplanar) {
    let samples = surfaceTriplanarSamples(tex, smp, projection, transform, metadata, rotation);
    let w = projection.weights;
    return samples.x * w.x + samples.y * w.y + samples.z * w.z;
  }
  return sampleSurfaceTexture(tex, smp, surfaceUv(input, transform, metadata, rotation) * metadata.zw,
    surfaceTextureFootprint(input, transform, metadata));
}

// Whiteout-blended triplanar tangent normals (Golus 2017): each plane's
// tangent frame is its two projection axes, so no mesh tangent is needed.
fn surfaceTriplanarNormal(samples : SurfaceTriplanarSamples, projection : SurfaceProjection, scale : vec2<f32>) -> vec3<f32> {
  let n = projection.normal;
  let x = scaleTangentSpaceNormal(decodeTangentSpaceNormalRg(samples.x.rg), scale);
  let y = scaleTangentSpaceNormal(decodeTangentSpaceNormalRg(samples.y.rg), scale);
  let z = scaleTangentSpaceNormal(decodeTangentSpaceNormalRg(samples.z.rg), scale);
  let tx = vec3<f32>(x.xy + n.yz, abs(x.z) * n.x);
  let ty = vec3<f32>(y.xy + n.zx, abs(y.z) * n.y);
  let tz = vec3<f32>(z.xy + n.xy, abs(z.z) * n.z);
  let w = projection.weights;
  return normalize(tx.zxy * w.x + ty.yzx * w.y + tz * w.z);
}

// Object-to-world normal transform: cofactor(M) = det(M) * inverse(M)^T.
#endif

fn surfaceObjectNormalToWorld(input : SurfaceInput, normalOS : vec3<f32>) -> vec3<f32> {
  let m = input.objectToWorld;
  let cofactor = mat3x3<f32>(cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1]));
  return normalize(cofactor * normalOS) * sign(dot(m[0], cofactor[0]));
}

fn surfaceChannel(value : vec4<f32>, channel : u32) -> f32 {
  switch (channel) {
    case 0u: { return value.r; }
    case 1u: { return value.g; }
    case 2u: { return value.b; }
    default: { return value.a; }
  }
}

fn evaluate_standard_surface(sourceInput : SurfaceInput, materialValue : MaterialParameters) -> SurfaceData {
  var input = sourceInput;
#ifdef FLAT_SHADING_AVAILABLE
  input.vertexNormalWS = select(input.vertexNormalWS, input.geometricNormalWS, materialValue.flatShading != 0u);
#endif
#ifdef TRIPLANAR_PROJECTION_AVAILABLE
  let triplanar = standardUsesTriplanarProjection();
#else
  let triplanar = false;
#endif
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
  let projection = surfaceProjection(input, materialValue);
#endif
  var baseSample = vec4<f32>(1.0);
#ifdef BASE_COLOR_TEXTURE_AVAILABLE
  if (standardUsesBaseColorTexture()) {
  baseSample = surfaceSample(baseColorTexture, baseColorTexture_sampler, input, triplanar, projection, materialValue.baseColorTextureCoordinatesTransform, materialValue.baseColorTextureCoordinatesMetadata, materialValue.baseColorTextureCoordinatesRotation);
  }
#endif
  var metallicRoughnessSample = vec4<f32>(1.0);
#ifdef METALLIC_ROUGHNESS_TEXTURE_AVAILABLE
  if (standardUsesMetallicRoughnessTexture()) {
  metallicRoughnessSample = surfaceSample(metallicRoughnessTexture, metallicRoughnessTexture_sampler, input, triplanar, projection, materialValue.metallicRoughnessTextureCoordinatesTransform, materialValue.metallicRoughnessTextureCoordinatesMetadata, materialValue.metallicRoughnessTextureCoordinatesRotation);
  }
#endif
  // Each independent map replaces only its packed source. Scalar factors
  // still multiply the selected texel, and missing maps remain neutral.
  var metallicSample = metallicRoughnessSample;
  var roughnessSample = metallicRoughnessSample;
  var alpha = 1.0;
#ifdef METALLIC_TEXTURE_AVAILABLE
  if (standardUsesMetallicTexture()) {
    if (standardReusesMetallicTextureFromBaseColorTexture()) {
      metallicSample = baseSample;
    } else if (standardReusesMetallicTextureFromMetallicRoughnessTexture()) {
      metallicSample = metallicRoughnessSample;
    } else {
      metallicSample = surfaceSample(metallicTexture, metallicTexture_sampler, input, triplanar, projection, materialValue.metallicTextureCoordinatesTransform, materialValue.metallicTextureCoordinatesMetadata, materialValue.metallicTextureCoordinatesRotation);
    }
  }
#endif
#ifdef ROUGHNESS_TEXTURE_AVAILABLE
  if (standardUsesRoughnessTexture()) {
    if (standardReusesRoughnessTextureFromBaseColorTexture()) {
      roughnessSample = baseSample;
    } else if (standardReusesRoughnessTextureFromMetallicRoughnessTexture()) {
      roughnessSample = metallicRoughnessSample;
    } else if (standardReusesRoughnessTextureFromMetallicTexture()) {
      roughnessSample = metallicSample;
    } else {
      roughnessSample = surfaceSample(roughnessTexture, roughnessTexture_sampler, input, triplanar, projection, materialValue.roughnessTextureCoordinatesTransform, materialValue.roughnessTextureCoordinatesMetadata, materialValue.roughnessTextureCoordinatesRotation);
    }
  }
#endif
#ifdef ALPHA_TEXTURE_AVAILABLE
  if (standardUsesAlphaTexture()) {
    var alphaSample = vec4<f32>(1.0);
    if (standardReusesAlphaTextureFromBaseColorTexture()) {
      alphaSample = baseSample;
    } else if (standardReusesAlphaTextureFromMetallicRoughnessTexture()) {
      alphaSample = metallicRoughnessSample;
    } else if (standardReusesAlphaTextureFromMetallicTexture()) {
      alphaSample = metallicSample;
    } else if (standardReusesAlphaTextureFromRoughnessTexture()) {
      alphaSample = roughnessSample;
    } else {
      alphaSample = surfaceSample(alphaTexture, alphaTexture_sampler, input, triplanar, projection, materialValue.alphaTextureCoordinatesTransform, materialValue.alphaTextureCoordinatesMetadata, materialValue.alphaTextureCoordinatesRotation);
    }
    alpha = surfaceChannel(alphaSample, u32(materialValue.alphaChannel));
  }
#endif
  let faceDirection = select(-1.0, 1.0, input.frontFacing);
  var normal = normalize(input.vertexNormalWS) * faceDirection;
  var usesNormal = false;
#ifdef NORMAL_TEXTURE_AVAILABLE
  if (standardUsesNormalTexture()) {
  let transform = materialValue.normalTextureCoordinatesTransform;
  let metadata = materialValue.normalTextureCoordinatesMetadata;
  let rotation = materialValue.normalTextureCoordinatesRotation;
  if (triplanar) {
    let triplanarNormal = surfaceTriplanarNormal(
      surfaceTriplanarSamples(normalTexture, normalTexture_sampler, projection, transform, metadata, rotation),
      projection, materialValue.normalScale);
    normal = select(triplanarNormal, surfaceObjectNormalToWorld(input, triplanarNormal),
      surfaceTriplanarObjectSpace(materialValue)) * faceDirection;
  } else {
    let normalSample = sampleSurfaceTexture(normalTexture, normalTexture_sampler,
      surfaceUv(input, transform, metadata, rotation) * metadata.zw, surfaceTextureFootprint(input, transform, metadata));
#ifdef OBJECT_SPACE_NORMAL_AVAILABLE
    let objectSpaceNormal = standardUsesObjectSpaceNormal();
#else
    let objectSpaceNormal = false;
#endif
    if (objectSpaceNormal) {
      // Three r184 OBJECTSPACE_NORMALMAP: RGB carries the full object normal.
      let normalOS = vec3<f32>((normalSample.rg * 2.0 - 1.0) * materialValue.normalScale, normalSample.b * 2.0 - 1.0);
      normal = surfaceObjectNormalToWorld(input, normalOS) * faceDirection;
    } else {
      normal = applyTBN(input.vertexNormalWS, input.tangentWS,
        scaleTangentSpaceNormal(decodeTangentSpaceNormalRg(normalSample.rg), materialValue.normalScale)) * faceDirection;
    }
  }
  usesNormal = true;
  }
#endif
#ifdef BUMP_TEXTURE_AVAILABLE
  if (!usesNormal && standardUsesBumpTexture()) {
    let uv = surfaceUv(input, materialValue.bumpTextureCoordinatesTransform, materialValue.bumpTextureCoordinatesMetadata, materialValue.bumpTextureCoordinatesRotation) * materialValue.bumpTextureCoordinatesMetadata.zw;
    let dx = dpdx(uv);
    let dy = dpdy(uv);
    let height = textureSampleGrad(bumpTexture, bumpTexture_sampler, uv, dx, dy).r;
    let heightX = textureSampleGrad(bumpTexture, bumpTexture_sampler, uv + dx, dx, dy).r;
    let heightY = textureSampleGrad(bumpTexture, bumpTexture_sampler, uv + dy, dx, dy).r;
    normal = perturbBumpNormal(input.positionWS, normal,
      materialValue.bumpScale * vec2<f32>(heightX - height, heightY - height), faceDirection);
  }
#endif
  var emissiveSample = vec4<f32>(1.0);
#ifdef EMISSIVE_TEXTURE_AVAILABLE
  if (standardUsesEmissiveTexture()) {
  emissiveSample = surfaceSample(emissiveTexture, emissiveTexture_sampler, input, triplanar, projection, materialValue.emissiveTextureCoordinatesTransform, materialValue.emissiveTextureCoordinatesMetadata, materialValue.emissiveTextureCoordinatesRotation);
  }
#endif
  var occlusionSample = vec4<f32>(1.0);
#ifdef OCCLUSION_TEXTURE_AVAILABLE
  if (standardUsesOcclusionTexture()) {
  occlusionSample = surfaceSample(occlusionTexture, occlusionTexture_sampler, input, triplanar, projection, materialValue.occlusionTextureCoordinatesTransform, materialValue.occlusionTextureCoordinatesMetadata, materialValue.occlusionTextureCoordinatesRotation);
  }
#endif
  let vertexColor = input.vertexColor;
  let baseColor = materialValue.baseColor.rgb * baseSample.rgb * vertexColor.rgb;
  let metallic = clamp(
#ifdef METALLIC_TEXTURE_AVAILABLE
    materialValue.metallic * surfaceChannel(metallicSample, u32(materialValue.metallicChannel)),
#else
#ifdef METALLIC_ROUGHNESS_TEXTURE_AVAILABLE
    materialValue.metallic * surfaceChannel(metallicSample, u32(materialValue.metallicChannel)),
#else
    materialValue.metallic,
#endif
#endif
    0.0,
    1.0,
  );
  let roughness = clamp(
#ifdef ROUGHNESS_TEXTURE_AVAILABLE
    materialValue.roughness * surfaceChannel(roughnessSample, u32(materialValue.roughnessChannel)),
#else
#ifdef METALLIC_ROUGHNESS_TEXTURE_AVAILABLE
    materialValue.roughness * surfaceChannel(roughnessSample, u32(materialValue.roughnessChannel)),
#else
    materialValue.roughness,
#endif
#endif
    0.04,
    1.0,
  );
  let emissive = materialValue.emissive * materialValue.emissiveIntensity * emissiveSample.rgb;
#ifdef OCCLUSION_TEXTURE_AVAILABLE
  let occlusion = clamp(1.0 + (occlusionSample.r - 1.0) * materialValue.occlusionStrength, 0.0, 1.0);
#else
  let occlusion = 1.0;
#endif
  let sampledAlpha = clamp(materialValue.baseColor.a * baseSample.a * vertexColor.a * alpha, 0.0, 1.0);
  var alphaClipThreshold = 0.0;
#ifdef ALPHA_CLIPPING_AVAILABLE
#ifdef SURFACE_COVERAGE_DEFERRED
  let coverage = sampledAlpha;
  alphaClipThreshold = materialValue.alphaCutoff;
#else
  let coverage = alphaCoverageValue(sampledAlpha, materialValue.alphaCutoff,
#ifdef ALPHA_TO_COVERAGE_AVAILABLE
    materialValue.alphaToCoverage,
#else
    0.0,
#endif
  );
  alphaClipThreshold = alphaCoverageClipThreshold(materialValue.alphaCutoff,
#ifdef ALPHA_TO_COVERAGE_AVAILABLE
    materialValue.alphaToCoverage,
#else
    0.0,
#endif
  );
#endif
#else
  let coverage = sampledAlpha;
#endif
#ifdef ALPHA_HASH_AVAILABLE
  applyAlphaHash(coverage, input.positionOS, materialValue.alphaHash);
#endif
  return SurfaceData(
    baseColor,
    normal,
    metallic,
    roughness,
    emissive,
    occlusion,
    coverage,
    alphaClipThreshold,
  );
}

fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  return evaluate_standard_surface(input, material);
}
