#define_import_path forgeax_material::standard_physical_inputs
#import forgeax_view::common::{sampleMaterialTextureBiased}
#import forgeax_material::texture_coordinates::{materialUvLinear}
#import forgeax_pbr::tbn::{applyTBN, decodeTangentSpaceNormalRg, scaleTangentSpaceNormal}

// Composed with the selected MaterialParameters provider. Each layer evaluates
// its declared maps before the pass consumes the physical parameters.
#ifdef STANDARD_SINGLE_UV_SET
alias PhysicalMaterialUvs = vec2<f32>;
#else
alias PhysicalMaterialUvs = array<vec4<f32>, 4>;
#endif

#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
fn transformedMaterialUv(transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>, uvs : PhysicalMaterialUvs) -> vec2<f32> {
#ifdef STANDARD_SINGLE_UV_SET
  let source = uvs;
#else
  var source = uvs[0].xy;
  if (metadata.x >= 1.0) { source = uvs[0].zw; }
  if (metadata.x >= 2.0) { source = uvs[1].xy; }
  if (metadata.x >= 3.0) { source = uvs[1].zw; }
  if (metadata.x >= 4.0) { source = uvs[2].xy; }
  if (metadata.x >= 5.0) { source = uvs[2].zw; }
  if (metadata.x >= 6.0) { source = uvs[3].xy; }
  if (metadata.x >= 7.0) { source = uvs[3].zw; }
#endif
  return materialUvLinear(source, transform, rotation) + transform.xy;
}
#endif

fn finiteScalar(value : f32, fallback : f32) -> f32 {
  let bounded = clamp(value, -65504.0, 65504.0);
  return select(fallback, bounded, value == value);
}

fn finiteColor(value : vec3<f32>, fallback : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    finiteScalar(value.x, fallback.x),
    finiteScalar(value.y, fallback.y),
    finiteScalar(value.z, fallback.z),
  );
}

fn evaluateStandardSpecular(uvs : PhysicalMaterialUvs, metallic : f32, dielectricF0 : f32) -> vec4<f32> {
  var specularColor = material.specularColor;
#ifdef SPECULAR_COLOR_TEXTURE_AVAILABLE
  if (standardUsesSpecularColorTexture()) {
    let specularUv = transformedMaterialUv(
      material.specularColorTextureCoordinatesTransform,
      material.specularColorTextureCoordinatesMetadata,
      material.specularColorTextureCoordinatesRotation,
      uvs,
    );
    specularColor = specularColor * sampleMaterialTextureBiased(
      specularColorTexture,
      specularColorTexture_sampler,
      specularUv,
      material.specularColorTextureCoordinatesMetadata.zw,
    ).rgb;
  }
#endif
  var specularWeight = clamp(finiteScalar(material.specular, 1.0), 0.0, 1.0);
#ifdef SPECULAR_TEXTURE_AVAILABLE
  if (standardUsesSpecularTexture()) {
    let specularWeightUv = transformedMaterialUv(
      material.specularTextureCoordinatesTransform,
      material.specularTextureCoordinatesMetadata,
      material.specularTextureCoordinatesRotation,
      uvs,
    );
    specularWeight = specularWeight * sampleMaterialTextureBiased(
      specularTexture,
      specularTexture_sampler,
      specularWeightUv,
      material.specularTextureCoordinatesMetadata.zw,
    ).a;
  }
#endif
  let dielectricSpecular = min(vec3<f32>(dielectricF0) * specularColor, vec3<f32>(1.0));
  return vec4<f32>(dielectricSpecular * specularWeight, mix(specularWeight, 1.0, metallic));
}

#ifdef ANISOTROPY_AVAILABLE
fn evaluateStandardAnisotropy(uvs : PhysicalMaterialUvs) -> vec4<f32> {
  var anisotropyStrength = finiteScalar(material.anisotropyStrength, 0.0);
  let anisotropyRotation = finiteScalar(material.anisotropyRotation, 0.0);
  var anisotropyDirection = vec2<f32>(1.0, 0.0);
#ifdef ANISOTROPY_TEXTURE_AVAILABLE
  if (standardUsesAnisotropyTexture()) {
    let anisotropyUv = transformedMaterialUv(
      material.anisotropyTextureCoordinatesTransform,
      material.anisotropyTextureCoordinatesMetadata,
      material.anisotropyTextureCoordinatesRotation,
      uvs,
    );
    let anisotropySample = sampleMaterialTextureBiased(
      anisotropyTexture,
      anisotropyTexture_sampler,
      anisotropyUv,
      material.anisotropyTextureCoordinatesMetadata.zw,
    );
    let encodedAnisotropyDirection = 2.0 * anisotropySample.rg - vec2<f32>(1.0, 1.0);
    if (dot(encodedAnisotropyDirection, encodedAnisotropyDirection) >= 1e-6) {
      anisotropyDirection = normalize(encodedAnisotropyDirection);
    }
    anisotropyStrength = anisotropyStrength * anisotropySample.b;
  }
#endif
  return vec4<f32>(anisotropyDirection, anisotropyStrength, anisotropyRotation);
}
#endif

#ifdef IRIDESCENCE_AVAILABLE
fn evaluateStandardIridescence(uvs : PhysicalMaterialUvs) -> vec3<f32> {
  var iridescenceStrength = finiteScalar(material.iridescence, 0.0);
  var iridescenceThicknessFactor = 1.0;
#ifdef IRIDESCENCE_TEXTURE_AVAILABLE
  if (standardUsesIridescenceTexture()) {
    let iridescenceUv = transformedMaterialUv(
      material.iridescenceTextureCoordinatesTransform,
      material.iridescenceTextureCoordinatesMetadata,
      material.iridescenceTextureCoordinatesRotation,
      uvs,
    );
    let iridescenceSample = sampleMaterialTextureBiased(
      iridescenceTexture,
      iridescenceTexture_sampler,
      iridescenceUv,
      material.iridescenceTextureCoordinatesMetadata.zw,
    );
    iridescenceStrength = iridescenceStrength * iridescenceSample.r;
  }
#endif
#ifdef IRIDESCENCE_THICKNESS_TEXTURE_AVAILABLE
  if (standardUsesIridescenceThicknessTexture()) {
    let iridescenceThicknessUv = transformedMaterialUv(
      material.iridescenceThicknessTextureCoordinatesTransform,
      material.iridescenceThicknessTextureCoordinatesMetadata,
      material.iridescenceThicknessTextureCoordinatesRotation,
      uvs,
    );
    let iridescenceThicknessSample = sampleMaterialTextureBiased(
      iridescenceThicknessTexture,
      iridescenceThicknessTexture_sampler,
      iridescenceThicknessUv,
      material.iridescenceThicknessTextureCoordinatesMetadata.zw,
    );
    iridescenceThicknessFactor = clamp(iridescenceThicknessSample.g, 0.0, 1.0);
  }
#endif
  let filmThickness = mix(
    finiteScalar(material.iridescenceThicknessMinimum, 100.0),
    finiteScalar(material.iridescenceThicknessMaximum, 400.0),
    iridescenceThicknessFactor,
  );
  return vec3<f32>(iridescenceStrength, finiteScalar(material.iridescenceIor, 1.3), filmThickness);
}
#endif

#ifdef TRANSMISSION_AVAILABLE
struct StandardTransmissionParameters {
  factor : f32,
  thickness : f32,
  thicknessSample : f32,
  attenuationColor : vec3<f32>,
  attenuationDistance : f32,
}

fn evaluateStandardTransmission(uvs : PhysicalMaterialUvs) -> StandardTransmissionParameters {
  var transmissionSample = 1.0;
#ifdef TRANSMISSION_TEXTURE_AVAILABLE
  if (standardUsesTransmissionTexture()) {
    let transmissionUv = transformedMaterialUv(
      material.transmissionTextureCoordinatesTransform,
      material.transmissionTextureCoordinatesMetadata,
      material.transmissionTextureCoordinatesRotation,
      uvs,
    );
    transmissionSample = sampleMaterialTextureBiased(
      transmissionTexture,
      transmissionTexture_sampler,
      transmissionUv,
      material.transmissionTextureCoordinatesMetadata.zw,
    ).r;
  }
#endif
  var thicknessSample = 1.0;
#ifdef THICKNESS_TEXTURE_AVAILABLE
  if (standardUsesThicknessTexture()) {
    let thicknessUv = transformedMaterialUv(
      material.thicknessTextureCoordinatesTransform,
      material.thicknessTextureCoordinatesMetadata,
      material.thicknessTextureCoordinatesRotation,
      uvs,
    );
    thicknessSample = sampleMaterialTextureBiased(
      thicknessTexture,
      thicknessTexture_sampler,
      thicknessUv,
      material.thicknessTextureCoordinatesMetadata.zw,
    ).g;
  }
#endif
  let transmissionFactor = clamp(
    finiteScalar(material.transmission, 0.0) * finiteScalar(transmissionSample, 1.0),
    0.0,
    1.0,
  );
  return StandardTransmissionParameters(
    transmissionFactor,
    finiteScalar(material.thickness, 0.0),
    finiteScalar(thicknessSample, 1.0),
    clamp(finiteColor(material.attenuationColor, vec3<f32>(1.0)), vec3<f32>(0.0), vec3<f32>(1.0)),
    max(finiteScalar(material.attenuationDistance, 0.0), 0.0),
  );
}
#endif

#ifdef DIFFUSE_TRANSMISSION_AVAILABLE
fn evaluateStandardDiffuseTransmission(uvs : PhysicalMaterialUvs) -> vec4<f32> {
  var diffuseTransmissionSample = 1.0;
#ifdef DIFFUSE_TRANSMISSION_TEXTURE_AVAILABLE
  if (standardUsesDiffuseTransmissionTexture()) {
    let diffuseTransmissionUv = transformedMaterialUv(
      material.diffuseTransmissionTextureCoordinatesTransform,
      material.diffuseTransmissionTextureCoordinatesMetadata,
      material.diffuseTransmissionTextureCoordinatesRotation,
      uvs,
    );
    diffuseTransmissionSample = sampleMaterialTextureBiased(
      diffuseTransmissionTexture,
      diffuseTransmissionTexture_sampler,
      diffuseTransmissionUv,
      material.diffuseTransmissionTextureCoordinatesMetadata.zw,
    ).a;
  }
#endif
  var diffuseTransmissionTint = finiteColor(material.diffuseTransmissionColor, vec3<f32>(1.0));
#ifdef DIFFUSE_TRANSMISSION_COLOR_TEXTURE_AVAILABLE
  if (standardUsesDiffuseTransmissionColorTexture()) {
    let diffuseTransmissionColorUv = transformedMaterialUv(
      material.diffuseTransmissionColorTextureCoordinatesTransform,
      material.diffuseTransmissionColorTextureCoordinatesMetadata,
      material.diffuseTransmissionColorTextureCoordinatesRotation,
      uvs,
    );
    diffuseTransmissionTint = diffuseTransmissionTint * sampleMaterialTextureBiased(
      diffuseTransmissionColorTexture,
      diffuseTransmissionColorTexture_sampler,
      diffuseTransmissionColorUv,
      material.diffuseTransmissionColorTextureCoordinatesMetadata.zw,
    ).rgb;
  }
#endif
  let diffuseTransmissionFactor = clamp(
    finiteScalar(material.diffuseTransmission, 0.0) * finiteScalar(diffuseTransmissionSample, 1.0),
    0.0,
    1.0,
  );
  return vec4<f32>(clamp(diffuseTransmissionTint, vec3<f32>(0.0), vec3<f32>(1.0)), diffuseTransmissionFactor);
}
#endif

#ifdef SHEEN_AVAILABLE
fn evaluateStandardSheen(uvs : PhysicalMaterialUvs, roughness : f32) -> vec4<f32> {
  var sheenColor = material.sheenColor;
  var sheenRoughnessFactor = 1.0;
#ifdef SHEEN_COLOR_TEXTURE_AVAILABLE
  if (standardUsesSheenColorTexture()) {
    let sheenColorUv = transformedMaterialUv(
      material.sheenColorTextureCoordinatesTransform,
      material.sheenColorTextureCoordinatesMetadata,
      material.sheenColorTextureCoordinatesRotation,
      uvs,
    );
    sheenColor = sheenColor * sampleMaterialTextureBiased(
      sheenColorTexture,
      sheenColorTexture_sampler,
      sheenColorUv,
      material.sheenColorTextureCoordinatesMetadata.zw,
    ).rgb;
  }
#endif
#ifdef SHEEN_ROUGHNESS_TEXTURE_AVAILABLE
  if (standardUsesSheenRoughnessTexture()) {
    let sheenRoughnessUv = transformedMaterialUv(
      material.sheenRoughnessTextureCoordinatesTransform,
      material.sheenRoughnessTextureCoordinatesMetadata,
      material.sheenRoughnessTextureCoordinatesRotation,
      uvs,
    );
    sheenRoughnessFactor = sampleMaterialTextureBiased(
      sheenRoughnessTexture,
      sheenRoughnessTexture_sampler,
      sheenRoughnessUv,
      material.sheenRoughnessTextureCoordinatesMetadata.zw,
    ).a;
  }
#endif
  let sheenRoughness = clamp(
    roughness * sheenRoughnessFactor,
    0.0,
    1.0,
  );
  return vec4<f32>(sheenColor, sheenRoughness);
}
#endif

#ifdef CLEARCOAT_AVAILABLE
fn evaluateStandardClearcoat(uvs : PhysicalMaterialUvs) -> vec2<f32> {
  var clearcoatFactor = clamp(material.clearcoat, 0.0, 1.0);
#ifdef CLEARCOAT_TEXTURE_AVAILABLE
  if (standardUsesClearcoatTexture()) {
    let clearcoatUv = transformedMaterialUv(
      material.clearcoatTextureCoordinatesTransform,
      material.clearcoatTextureCoordinatesMetadata,
      material.clearcoatTextureCoordinatesRotation,
      uvs,
    );
    clearcoatFactor = clamp(
      material.clearcoat * sampleMaterialTextureBiased(
        clearcoatTexture,
        clearcoatTexture_sampler,
        clearcoatUv,
        material.clearcoatTextureCoordinatesMetadata.zw,
      ).r,
      0.0,
      1.0,
    );
  }
#endif
  var clearcoatRoughnessValue = clamp(max(material.clearcoatRoughness, 0.04), 0.04, 1.0);
#ifdef CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE
  if (standardUsesClearcoatRoughnessTexture()) {
    let clearcoatRoughnessUv = transformedMaterialUv(
      material.clearcoatRoughnessTextureCoordinatesTransform,
      material.clearcoatRoughnessTextureCoordinatesMetadata,
      material.clearcoatRoughnessTextureCoordinatesRotation,
      uvs,
    );
    clearcoatRoughnessValue = clamp(
      max(material.clearcoatRoughness, 0.04) * sampleMaterialTextureBiased(
        clearcoatRoughnessTexture,
        clearcoatRoughnessTexture_sampler,
        clearcoatRoughnessUv,
        material.clearcoatRoughnessTextureCoordinatesMetadata.zw,
      ).g,
      0.04,
      1.0,
    );
  }
#endif
  return vec2<f32>(clearcoatFactor, clearcoatRoughnessValue);
}

fn evaluateStandardClearcoatNormal(uvs : PhysicalMaterialUvs, clearcoatBaseNormal : vec3<f32>, tangent : vec4<f32>) -> vec3<f32> {
  var clearcoatNormalValue = normalize(clearcoatBaseNormal);
#ifdef CLEARCOAT_NORMAL_TEXTURE_AVAILABLE
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  if (standardUsesClearcoatNormalTexture()) {
    let clearcoatNormalUv = transformedMaterialUv(
      material.clearcoatNormalTextureCoordinatesTransform,
      material.clearcoatNormalTextureCoordinatesMetadata,
      material.clearcoatNormalTextureCoordinatesRotation,
      uvs,
    );
    clearcoatNormalValue = applyTBN(
      clearcoatBaseNormal,
      tangent,
      scaleTangentSpaceNormal(
        decodeTangentSpaceNormalRg(sampleMaterialTextureBiased(
          clearcoatNormalTexture,
          clearcoatNormalTexture_sampler,
          clearcoatNormalUv,
          material.clearcoatNormalTextureCoordinatesMetadata.zw,
        ).rg),
        vec2<f32>(material.clearcoatNormalScale),
      ),
    );
  }
#endif
#endif
  return clearcoatNormalValue;
}
#endif
