#define_import_path forgeax_material::default_standard_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::standard_surface_maps::{SurfaceProjection, SurfaceTriplanarSamples, surfaceUv, surfaceProjection, surfaceTriplanarObjectSpace, surfaceTriplanarSamples, surfaceSample, surfaceChannel, sampleStandardBaseColor, sampleStandardAlpha, sampledStandardOpacity, resolveStandardCoverage, evaluateStandardCoverageOnly}
#import forgeax_material::surface_sampling::{sampleSurfaceTexture, surfaceTextureFootprint}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, scaleTangentSpaceNormal, applyTBN, perturbBumpNormal}

// The default Surface owns only base facts. Standard's generated Material
// interface remains the source of the scalar and texture values; the
// Standard template owns physical-layer selection and lighting.
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
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
#else
  let projection = SurfaceProjection();
#endif
  let baseSample = sampleStandardBaseColor(input, materialValue, triplanar, projection);
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
#ifdef METALLIC_TEXTURE_AVAILABLE
  if (standardUsesMetallicTexture()) {
    if (standardReusesMetallicTextureFromMetallicRoughnessTexture()) {
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
  let alpha = sampleStandardAlpha(input, materialValue, triplanar, projection, baseSample,
    true, metallicRoughnessSample, metallicSample);
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
      surfaceUv(input, transform, metadata, rotation) * metadata.zw, surfaceTextureFootprint(input, transform, metadata), input.materialTextureMipBias);
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
// Bump reconstruction uses fragment derivatives. Ray hits use the explicit
// footprint from SurfaceInput for the supported material maps.
#ifndef RAY_SURFACE_CONTEXT
#ifdef BUMP_TEXTURE_AVAILABLE
  if (!usesNormal && standardUsesBumpTexture()) {
    let uv = surfaceUv(input, materialValue.bumpTextureCoordinatesTransform, materialValue.bumpTextureCoordinatesMetadata, materialValue.bumpTextureCoordinatesRotation) * materialValue.bumpTextureCoordinatesMetadata.zw;
    let dx = dpdx(uv);
    let dy = dpdy(uv);
    let gradX = dx * exp2(input.materialTextureMipBias);
    let gradY = dy * exp2(input.materialTextureMipBias);
    let height = textureSampleGrad(bumpTexture, bumpTexture_sampler, uv, gradX, gradY).r;
    let heightX = textureSampleGrad(bumpTexture, bumpTexture_sampler, uv + dx, gradX, gradY).r;
    let heightY = textureSampleGrad(bumpTexture, bumpTexture_sampler, uv + dy, gradX, gradY).r;
    normal = perturbBumpNormal(input.positionWS, normal,
      materialValue.bumpScale * vec2<f32>(heightX - height, heightY - height), faceDirection);
  }
#endif
#endif
  var emissiveSample = vec4<f32>(1.0);
#ifdef EMISSIVE_TEXTURE_AVAILABLE
  if (standardUsesEmissiveTexture()) {
  emissiveSample = surfaceSample(emissiveTexture, emissiveTexture_sampler, input, triplanar, projection, materialValue.emissiveTextureCoordinatesTransform, materialValue.emissiveTextureCoordinatesMetadata, materialValue.emissiveTextureCoordinatesRotation);
  }
#endif
  var occlusionSample = vec4<f32>(1.0);
#ifdef STANDARD_SURFACE_PACKED_ORM
  occlusionSample = metallicRoughnessSample;
#else
#ifdef OCCLUSION_TEXTURE_AVAILABLE
  if (standardUsesOcclusionTexture()) {
    if (standardReusesOcclusionTextureFromMetallicRoughnessTexture()) {
      occlusionSample = metallicRoughnessSample;
    } else {
    occlusionSample = surfaceSample(occlusionTexture, occlusionTexture_sampler, input, triplanar, projection, materialValue.occlusionTextureCoordinatesTransform, materialValue.occlusionTextureCoordinatesMetadata, materialValue.occlusionTextureCoordinatesRotation);
    }
  }
#endif
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
#ifdef STANDARD_SURFACE_PACKED_ORM
  let occlusion = clamp(1.0 + (occlusionSample.r - 1.0) * materialValue.occlusionStrength, 0.0, 1.0);
#else
  let occlusion = 1.0;
#endif
#endif
  let coverage = resolveStandardCoverage(
    sampledStandardOpacity(materialValue.baseColor.a, vertexColor.a, baseSample.a, alpha),
    input.positionOS, materialValue);
  return SurfaceData(
    baseColor,
    normal,
    metallic,
    roughness,
    emissive,
    occlusion,
    coverage.opacity,
    coverage.clipThreshold,
    0.0,
  );
}

fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  return evaluate_standard_surface(input, material);
}

#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
fn evaluate_standard_coverage(input : SurfaceInput, materialValue : MaterialParameters) -> SurfaceData {
  return evaluateStandardCoverageOnly(input, materialValue);
}
#endif
