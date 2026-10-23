// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 2.lighting/2.basic-lighting (static scene: lit cube + lamp,
// first-person controls input-gated so no motion without input). Delegates to
// the shared harness; this file only supplies the demo identity + its live-pixel
// hook (window.__captureBasicLighting, installed by src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (mean/maxChannel/coveredMean).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srgbToLinear = (value) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const pointLightIntensity = process.env.VITE_FALSIFY_POINT_LIGHT_INTENSITY ?? '';
const pointLightRange = process.env.VITE_FALSIFY_POINT_LIGHT_RANGE ?? '';
const pointLightColor = process.env.VITE_FALSIFY_POINT_LIGHT_COLOR ?? '';
const pointLightPosition = process.env.VITE_FALSIFY_POINT_LIGHT_POSITION ?? '';
const materialMetallic = process.env.VITE_FALSIFY_MATERIAL_METALLIC ?? '';
const materialRoughness = process.env.VITE_FALSIFY_MATERIAL_ROUGHNESS ?? '';
const materialBaseColor = process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR ?? '';
const materialBaseColorTexture = process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE ?? '';
const materialBaseColorTextureSampler =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER ?? '';
const materialBaseColorTextureUvTransform =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM ?? '';
const materialBaseColorTextureUvSet =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET ?? '';
const materialMetallicRoughnessTexture =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE ?? '';
const materialMetallicRoughnessTextureSampler =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER ?? '';
const materialMetallicRoughnessTextureUvTransform =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM ?? '';
const materialMetallicRoughnessTextureUvSet =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET ?? '';
const materialMetallicChannel = process.env.VITE_FALSIFY_MATERIAL_METALLIC_CHANNEL ?? '';
const materialRoughnessChannel = process.env.VITE_FALSIFY_MATERIAL_ROUGHNESS_CHANNEL ?? '';
const materialEmissive = process.env.VITE_FALSIFY_MATERIAL_EMISSIVE ?? '';
const materialEmissiveIntensity = process.env.VITE_FALSIFY_MATERIAL_EMISSIVE_INTENSITY ?? '';
const materialEmissiveTexture = process.env.VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE ?? '';
const materialEmissiveTextureSampler = process.env.VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_SAMPLER ?? '';
const materialEmissiveTextureUvTransform = process.env.VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_TRANSFORM ?? '';
const materialEmissiveTextureUvSet = process.env.VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_SET ?? '';
const materialClearcoat = process.env.VITE_FALSIFY_MATERIAL_CLEARCOAT ?? '';
const materialNormalScale = process.env.VITE_FALSIFY_MATERIAL_NORMAL_SCALE ?? '';
const materialNormalTexture = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE ?? '';
const materialNormalTextureUvSet = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_UV_SET ?? '';
const materialNormalTextureSampler = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER ?? '';
const materialNormalTextureUvTransform = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_UV_TRANSFORM ?? '';
const materialNormalTextureMagFilter = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_MAG_FILTER ?? '';
const materialNormalTextureMinFilter = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_MIN_FILTER ?? '';
const materialNormalTextureMipmapFilter = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_MIPMAP_FILTER ?? '';
const materialNormalTextureAddressModeU = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_ADDRESS_MODE_U ?? '';
const materialNormalTextureAddressModeV = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_ADDRESS_MODE_V ?? '';
const materialNormalTextureAddressModeW = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_ADDRESS_MODE_W ?? '';
const materialNormalTextureSamplerLodMinClamp = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER_LOD_MIN_CLAMP ?? '';
const materialNormalTextureSamplerLodMaxClamp = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER_LOD_MAX_CLAMP ?? '';
const materialNormalTextureSamplerMaxAnisotropy = process.env.VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER_MAX_ANISOTROPY ?? '';
const materialOcclusionStrength = process.env.VITE_FALSIFY_MATERIAL_OCCLUSION_STRENGTH ?? '';
const materialOcclusionTextureSampler =
  process.env.VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_SAMPLER ?? '';
const materialOcclusionTextureUvTransform =
  process.env.VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_UV_TRANSFORM ?? '';
const materialOcclusionTextureUvSet =
  process.env.VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_UV_SET ?? '';
const materialSpecularColor = process.env.VITE_FALSIFY_MATERIAL_SPECULAR_COLOR ?? '';
const materialSpecularColorTexture = process.env.VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE ?? '';
const materialSpecularColorTextureSampler =
  process.env.VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_SAMPLER ?? '';
const materialSpecularColorTextureUvTransform =
  process.env.VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_UV_TRANSFORM ?? '';
const materialSpecularColorTextureUvSet =
  process.env.VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_UV_SET ?? '';
const alphaCutoff = process.env.VITE_FALSIFY_MATERIAL_ALPHA_CUTOFF ?? '';
if (alphaCutoff !== '' && alphaCutoff !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_ALPHA_CUTOFF=${alphaCutoff}; expected 1`,
  );
  process.exit(1);
}
const alphaBlend = process.env.VITE_FALSIFY_MATERIAL_ALPHA_BLEND ?? '';
if (alphaBlend !== '' && alphaBlend !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_ALPHA_BLEND=${alphaBlend}; expected 1`,
  );
  process.exit(1);
}

if (materialEmissiveIntensity !== '' && materialEmissiveIntensity !== '2') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_EMISSIVE_INTENSITY=${materialEmissiveIntensity}; expected 2`,
  );
  process.exit(1);
}
if (
  materialEmissiveIntensity !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialMetallicChannel,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialNormalTextureMipmapFilter,
    materialNormalTextureAddressModeU,
    materialNormalTextureAddressModeV,
    materialNormalTextureAddressModeW,
    materialNormalTextureSamplerLodMinClamp,
    materialNormalTextureSamplerLodMaxClamp,
    materialNormalTextureSamplerMaxAnisotropy,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_INTENSITY cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (materialMetallicChannel !== '' && materialMetallicChannel !== 'red') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_METALLIC_CHANNEL=${materialMetallicChannel}; expected red`,
  );
  process.exit(1);
}
if (materialRoughnessChannel !== '' && materialRoughnessChannel !== 'blue') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_ROUGHNESS_CHANNEL=${materialRoughnessChannel}; expected blue`,
  );
  process.exit(1);
}
if (
  materialMetallicChannel !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveIntensity,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialNormalTextureMipmapFilter,
    materialNormalTextureAddressModeU,
    materialNormalTextureAddressModeV,
    materialNormalTextureAddressModeW,
    materialNormalTextureSamplerLodMinClamp,
    materialNormalTextureSamplerLodMaxClamp,
    materialNormalTextureSamplerMaxAnisotropy,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_METALLIC_CHANNEL cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialRoughnessChannel !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialMetallicChannel,
    materialEmissive,
    materialEmissiveIntensity,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialNormalTextureMipmapFilter,
    materialNormalTextureAddressModeU,
    materialNormalTextureAddressModeV,
    materialNormalTextureAddressModeW,
    materialNormalTextureSamplerLodMinClamp,
    materialNormalTextureSamplerLodMaxClamp,
    materialNormalTextureSamplerMaxAnisotropy,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_ROUGHNESS_CHANNEL cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}

if (pointLightIntensity !== '' && !['1', '4'].includes(pointLightIntensity)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_POINT_LIGHT_INTENSITY=${pointLightIntensity}; expected 1 or 4`,
  );
  process.exit(1);
}
if (pointLightRange !== '' && !['5', '50'].includes(pointLightRange)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_POINT_LIGHT_RANGE=${pointLightRange}; expected 5 or 50`,
  );
  process.exit(1);
}
if (pointLightColor !== '' && !['amber', 'gold'].includes(pointLightColor)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_POINT_LIGHT_COLOR=${pointLightColor}; expected amber or gold`,
  );
  process.exit(1);
}
if (pointLightPosition !== '' && !['near', 'far'].includes(pointLightPosition)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_POINT_LIGHT_POSITION=${pointLightPosition}; expected near or far`,
  );
  process.exit(1);
}
if (materialRoughness !== '' && !['smooth', 'rough'].includes(materialRoughness)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_ROUGHNESS=${materialRoughness}; expected smooth or rough`,
  );
  process.exit(1);
}
if (materialMetallic !== '' && !['dielectric', 'metal'].includes(materialMetallic)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_METALLIC=${materialMetallic}; expected dielectric or metal`,
  );
  process.exit(1);
}
if (materialBaseColor !== '' && !['warm', 'cool'].includes(materialBaseColor)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR=${materialBaseColor}; expected warm or cool`,
  );
  process.exit(1);
}
if (materialBaseColorTexture !== '' && materialBaseColorTexture !== 'blue') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE=${materialBaseColorTexture}; expected blue`,
  );
  process.exit(1);
}
if (materialBaseColorTextureSampler !== '' && materialBaseColorTextureSampler !== 'nearest') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER=${materialBaseColorTextureSampler}; expected nearest`,
  );
  process.exit(1);
}
if (materialBaseColorTextureUvTransform !== '' && materialBaseColorTextureUvTransform !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM=${materialBaseColorTextureUvTransform}; expected 1`,
  );
  process.exit(1);
}
if (materialBaseColorTextureUvSet !== '' && materialBaseColorTextureUvSet !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET=${materialBaseColorTextureUvSet}; expected 1`,
  );
  process.exit(1);
}
if (
  materialMetallicRoughnessTexture !== '' &&
  materialMetallicRoughnessTexture !== 'blue'
) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE=${materialMetallicRoughnessTexture}; expected blue`,
  );
  process.exit(1);
}
if (
  materialMetallicRoughnessTextureSampler !== '' &&
  materialMetallicRoughnessTextureSampler !== 'nearest'
) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER=${materialMetallicRoughnessTextureSampler}; expected nearest`,
  );
  process.exit(1);
}
if (
  materialMetallicRoughnessTextureUvTransform !== '' &&
  materialMetallicRoughnessTextureUvTransform !== '1'
) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM=${materialMetallicRoughnessTextureUvTransform}; expected 1`,
  );
  process.exit(1);
}
if (materialMetallicRoughnessTextureUvSet !== '' && materialMetallicRoughnessTextureUvSet !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET=${materialMetallicRoughnessTextureUvSet}; expected 1`,
  );
  process.exit(1);
}
if (materialEmissive !== '' && !['red', 'blue'].includes(materialEmissive)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_EMISSIVE=${materialEmissive}; expected red or blue`,
  );
  process.exit(1);
}
if (materialEmissiveTexture !== '' && materialEmissiveTexture !== 'blue') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE=${materialEmissiveTexture}; expected blue`,
  );
  process.exit(1);
}
if (materialEmissiveTextureSampler !== '' && materialEmissiveTextureSampler !== 'nearest') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_SAMPLER=${materialEmissiveTextureSampler}; expected nearest`,
  );
  process.exit(1);
}
if (materialEmissiveTextureSampler !== '' && materialEmissiveTexture !== 'blue') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_SAMPLER requires VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE=blue',
  );
  process.exit(1);
}
if (materialEmissiveTextureUvTransform !== '' && materialEmissiveTextureUvTransform !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_TRANSFORM=${materialEmissiveTextureUvTransform}; expected 1`,
  );
  process.exit(1);
}
if (materialEmissiveTextureUvTransform !== '' && materialEmissiveTexture !== 'blue') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_TRANSFORM requires VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE=blue',
  );
  process.exit(1);
}
if (materialEmissiveTextureUvTransform !== '' && materialEmissiveTextureSampler !== 'nearest') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_TRANSFORM requires VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_SAMPLER=nearest',
  );
  process.exit(1);
}
if (materialEmissiveTextureUvSet !== '' && materialEmissiveTextureUvSet !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_SET=${materialEmissiveTextureUvSet}; expected 1`,
  );
  process.exit(1);
}
if (materialEmissiveTextureUvSet !== '' && materialEmissiveTexture !== 'blue') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_SET requires VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE=blue',
  );
  process.exit(1);
}
if (materialEmissiveTextureUvSet !== '' && materialEmissiveTextureSampler !== 'nearest') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_SET requires VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_SAMPLER=nearest',
  );
  process.exit(1);
}
if (materialEmissiveTextureUvSet !== '' && materialEmissiveTextureUvTransform !== '') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_SET cannot be combined with VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_TRANSFORM',
  );
  process.exit(1);
}
if (materialClearcoat !== '' && materialClearcoat !== 'coat') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_CLEARCOAT=${materialClearcoat}; expected coat`,
  );
  process.exit(1);
}
if (materialNormalScale !== '' && materialNormalScale !== 'flat') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_SCALE=${materialNormalScale}; expected flat`,
  );
  process.exit(1);
}
if (materialNormalTexture !== '' && materialNormalTexture !== 'tilt') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE=${materialNormalTexture}; expected tilt`,
  );
  process.exit(1);
}
if (materialNormalTextureUvSet !== '' && materialNormalTextureUvSet !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_UV_SET=${materialNormalTextureUvSet}; expected 1`,
  );
  process.exit(1);
}
if (materialNormalTextureSampler !== '' && materialNormalTextureSampler !== 'nearest') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER=${materialNormalTextureSampler}; expected nearest`,
  );
  process.exit(1);
}
if (materialNormalTextureUvTransform !== '' && materialNormalTextureUvTransform !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_UV_TRANSFORM=${materialNormalTextureUvTransform}; expected 1`,
  );
  process.exit(1);
}
if (materialNormalTextureMagFilter !== '' && materialNormalTextureMagFilter !== 'linear') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_MAG_FILTER=${materialNormalTextureMagFilter}; expected linear`,
  );
  process.exit(1);
}
if (materialNormalTextureMinFilter !== '' && materialNormalTextureMinFilter !== 'linear') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_MIN_FILTER=${materialNormalTextureMinFilter}; expected linear`,
  );
  process.exit(1);
}
if (materialNormalTextureMipmapFilter !== '' && materialNormalTextureMipmapFilter !== 'linear') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_MIPMAP_FILTER=${materialNormalTextureMipmapFilter}; expected linear`,
  );
  process.exit(1);
}
if (materialNormalTextureAddressModeU !== '' && materialNormalTextureAddressModeU !== 'repeat') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_ADDRESS_MODE_U=${materialNormalTextureAddressModeU}; expected repeat`,
  );
  process.exit(1);
}
if (materialNormalTextureAddressModeV !== '' && materialNormalTextureAddressModeV !== 'repeat') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_ADDRESS_MODE_V=${materialNormalTextureAddressModeV}; expected repeat`,
  );
  process.exit(1);
}
if (materialNormalTextureAddressModeW !== '' && materialNormalTextureAddressModeW !== 'repeat') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_ADDRESS_MODE_W=${materialNormalTextureAddressModeW}; expected repeat`,
  );
  process.exit(1);
}
if (materialNormalTextureSamplerLodMinClamp !== '' && !['0', '1'].includes(materialNormalTextureSamplerLodMinClamp)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER_LOD_MIN_CLAMP=${materialNormalTextureSamplerLodMinClamp}; expected 0 or 1`,
  );
  process.exit(1);
}
if (materialNormalTextureSamplerLodMaxClamp !== '' && !['0', '1'].includes(materialNormalTextureSamplerLodMaxClamp)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER_LOD_MAX_CLAMP=${materialNormalTextureSamplerLodMaxClamp}; expected 0 or 1`,
  );
  process.exit(1);
}
if (materialNormalTextureSamplerMaxAnisotropy !== '' && !['0', '1'].includes(materialNormalTextureSamplerMaxAnisotropy)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER_MAX_ANISOTROPY=${materialNormalTextureSamplerMaxAnisotropy}; expected 0 or 1`,
  );
  process.exit(1);
}
if (materialOcclusionStrength !== '' && materialOcclusionStrength !== 'zero') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_OCCLUSION_STRENGTH=${materialOcclusionStrength}; expected zero`,
  );
  process.exit(1);
}
if (materialOcclusionTextureSampler !== '' && materialOcclusionTextureSampler !== 'nearest') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_SAMPLER=${materialOcclusionTextureSampler}; expected nearest`,
  );
  process.exit(1);
}
if (materialOcclusionTextureUvTransform !== '' && materialOcclusionTextureUvTransform !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_UV_TRANSFORM=${materialOcclusionTextureUvTransform}; expected 1`,
  );
  process.exit(1);
}
if (materialOcclusionTextureUvSet !== '' && materialOcclusionTextureUvSet !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_UV_SET=${materialOcclusionTextureUvSet}; expected 1`,
  );
  process.exit(1);
}
if (materialSpecularColor !== '' && materialSpecularColor !== 'cool') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_SPECULAR_COLOR=${materialSpecularColor}; expected cool`,
  );
  process.exit(1);
}
if (materialSpecularColorTexture !== '' && materialSpecularColorTexture !== 'blue') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE=${materialSpecularColorTexture}; expected blue`,
  );
  process.exit(1);
}
if (materialSpecularColorTextureSampler !== '' && materialSpecularColorTextureSampler !== 'nearest') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_SAMPLER=${materialSpecularColorTextureSampler}; expected nearest`,
  );
  process.exit(1);
}
if (materialSpecularColorTextureUvTransform !== '' && materialSpecularColorTextureUvTransform !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_UV_TRANSFORM=${materialSpecularColorTextureUvTransform}; expected 1`,
  );
  process.exit(1);
}
if (materialSpecularColorTextureUvSet !== '' && materialSpecularColorTextureUvSet !== '1') {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_UV_SET=${materialSpecularColorTextureUvSet}; expected 1`,
  );
  process.exit(1);
}
if (materialSpecularColorTextureUvTransform !== '' && materialSpecularColorTextureUvSet !== '') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_UV_TRANSFORM cannot be combined with VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_UV_SET',
  );
  process.exit(1);
}
if (
  materialSpecularColorTextureUvSet !== '' &&
  (materialSpecularColorTexture !== '' || materialSpecularColorTextureSampler !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_UV_SET cannot be combined with another specularColorTexture falsifier',
  );
  process.exit(1);
}
if (
  materialOcclusionTextureSampler !== '' &&
  materialOcclusionTextureUvTransform !== ''
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_SAMPLER cannot be combined with VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_UV_TRANSFORM',
  );
  process.exit(1);
}
if (materialOcclusionTextureSampler !== '' && materialOcclusionTextureUvSet !== '') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_SAMPLER cannot be combined with VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_UV_SET',
  );
  process.exit(1);
}
if (materialOcclusionTextureUvTransform !== '' && materialOcclusionTextureUvSet !== '') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_UV_TRANSFORM cannot be combined with VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE_UV_SET',
  );
  process.exit(1);
}
if (
  (materialOcclusionTextureSampler !== '' ||
    materialOcclusionTextureUvTransform !== '' ||
    materialOcclusionTextureUvSet !== '') &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_OCCLUSION_TEXTURE profile cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialBaseColorTexture !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialMetallicRoughnessTextureUvTransform,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialBaseColorTexture !== '' &&
  (materialBaseColorTextureSampler !== '' ||
    materialBaseColorTextureUvTransform !== '' ||
    materialBaseColorTextureUvSet !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE cannot be combined with another baseColorTexture falsifier',
  );
  process.exit(1);
}
if (
  materialBaseColorTextureSampler !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialBaseColorTextureUvTransform !== '' &&
  (materialBaseColorTexture !== '' ||
    materialBaseColorTextureSampler !== '' ||
    materialBaseColorTextureUvSet !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM cannot be combined with another baseColorTexture falsifier',
  );
  process.exit(1);
}
if (
  materialBaseColorTextureUvSet !== '' &&
  (materialBaseColorTexture !== '' ||
    materialBaseColorTextureSampler !== '' ||
    materialBaseColorTextureUvTransform !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET cannot be combined with another baseColorTexture falsifier',
  );
  process.exit(1);
}
if (
  materialBaseColorTextureUvSet !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialBaseColorTextureUvTransform !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialMetallicRoughnessTexture !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialMetallicRoughnessTextureSampler !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureUvTransform,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialMetallicRoughnessTextureUvTransform !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialMetallicRoughnessTextureUvSet !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialSpecularColor !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialEmissiveTexture,
    materialClearcoat,
    materialNormalScale,
    materialOcclusionStrength,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_SPECULAR_COLOR cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialSpecularColorTexture !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialEmissiveTexture,
    materialClearcoat,
    materialNormalScale,
    materialOcclusionStrength,
    materialSpecularColor,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (materialSpecularColorTexture !== '' && materialSpecularColorTextureSampler !== '') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE cannot be combined with VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_SAMPLER',
  );
  process.exit(1);
}
if (
  materialSpecularColorTextureUvTransform !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_UV_TRANSFORM cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialSpecularColorTextureUvSet !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTextureUvTransform,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_UV_SET cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialSpecularColorTextureSampler !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialSpecularColor,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_SPECULAR_COLOR_TEXTURE_SAMPLER cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialOcclusionStrength !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialEmissiveTexture,
    materialClearcoat,
    materialNormalScale,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_OCCLUSION_STRENGTH cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  pointLightPosition !== '' &&
  (pointLightColor !== '' || pointLightIntensity !== '' || pointLightRange !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_POINT_LIGHT_POSITION cannot be combined with another PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialRoughness !== '' &&
  (pointLightColor !== '' ||
    pointLightIntensity !== '' ||
    pointLightRange !== '' ||
    pointLightPosition !== '' ||
    materialMetallic !== '' ||
    materialBaseColor !== '' ||
    materialEmissive !== '' ||
    materialEmissiveTexture !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_ROUGHNESS cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialMetallic !== '' &&
  (pointLightColor !== '' ||
    pointLightIntensity !== '' ||
    pointLightRange !== '' ||
    pointLightPosition !== '' ||
    materialRoughness !== '' ||
    materialBaseColor !== '' ||
    materialEmissive !== '' ||
    materialEmissiveTexture !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_METALLIC cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialBaseColor !== '' &&
  (pointLightColor !== '' ||
    pointLightIntensity !== '' ||
    pointLightRange !== '' ||
    pointLightPosition !== '' ||
    materialMetallic !== '' ||
    materialRoughness !== '' ||
    materialEmissive !== '' ||
    materialEmissiveTexture !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_BASE_COLOR cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialEmissive !== '' &&
  (pointLightColor !== '' ||
    pointLightIntensity !== '' ||
    pointLightRange !== '' ||
    pointLightPosition !== '' ||
    materialMetallic !== '' ||
    materialRoughness !== '' ||
    materialBaseColor !== '' ||
    materialEmissiveTexture !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialClearcoat !== '' &&
  (pointLightColor !== '' ||
    pointLightIntensity !== '' ||
    pointLightRange !== '' ||
    pointLightPosition !== '' ||
    materialMetallic !== '' ||
    materialRoughness !== '' ||
    materialBaseColor !== '' ||
    materialEmissive !== '' ||
    materialEmissiveTexture !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_CLEARCOAT cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalScale !== '' &&
  (pointLightColor !== '' ||
    pointLightIntensity !== '' ||
    pointLightRange !== '' ||
    pointLightPosition !== '' ||
    materialMetallic !== '' ||
    materialRoughness !== '' ||
    materialBaseColor !== '' ||
    materialEmissive !== '' ||
    materialEmissiveTexture !== '' ||
    materialClearcoat !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_SCALE cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialEmissiveTexture !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialClearcoat,
    materialNormalScale,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialEmissiveTextureSampler !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialClearcoat,
    materialNormalScale,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_SAMPLER cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialEmissiveTextureUvTransform !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialClearcoat,
    materialNormalScale,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_TRANSFORM cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialEmissiveTextureUvSet !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialClearcoat,
    materialNormalScale,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_EMISSIVE_TEXTURE_UV_SET cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTextureUvSet !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialClearcoat,
    materialNormalScale,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_UV_SET cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTextureSampler !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialNormalTextureUvSet,
    materialNormalTextureUvTransform,
    materialClearcoat,
    materialNormalScale,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTextureUvTransform !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialClearcoat,
    materialNormalScale,
    materialOcclusionStrength,
    materialSpecularColor,
    materialSpecularColorTexture,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_UV_TRANSFORM cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTexture !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTextureMagFilter !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_MAG_FILTER cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTextureMinFilter !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_MIN_FILTER cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTextureMipmapFilter !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_MIPMAP_FILTER cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  (materialNormalTextureAddressModeU !== '' &&
    (materialNormalTextureAddressModeV !== '' || materialNormalTextureAddressModeW !== '')) ||
  (materialNormalTextureAddressModeV !== '' && materialNormalTextureAddressModeW !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_ADDRESS_MODE_U/V/W cannot be combined with each other',
  );
  process.exit(1);
}
if (
  (materialNormalTextureAddressModeU !== '' || materialNormalTextureAddressModeV !== '' || materialNormalTextureAddressModeW !== '') &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialNormalTextureMipmapFilter,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_ADDRESS_MODE_U/V/W cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTextureSamplerLodMinClamp !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialNormalTextureMipmapFilter,
    materialNormalTextureAddressModeU,
    materialNormalTextureAddressModeV,
    materialNormalTextureAddressModeW,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER_LOD_MIN_CLAMP cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTextureSamplerLodMaxClamp !== '' &&
  [
    materialNormalTextureSamplerLodMinClamp,
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialNormalTextureMipmapFilter,
    materialNormalTextureAddressModeU,
    materialNormalTextureAddressModeV,
    materialNormalTextureAddressModeW,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER_LOD_MAX_CLAMP cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  materialNormalTextureSamplerMaxAnisotropy !== '' &&
  [
    materialNormalTextureSamplerLodMinClamp,
    materialNormalTextureSamplerLodMaxClamp,
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialEmissive,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialNormalTextureMipmapFilter,
    materialNormalTextureAddressModeU,
    materialNormalTextureAddressModeV,
    materialNormalTextureAddressModeW,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_NORMAL_TEXTURE_SAMPLER_MAX_ANISOTROPY cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (pointLightColor !== '' && pointLightIntensity !== '') {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_POINT_LIGHT_COLOR cannot be combined with VITE_FALSIFY_POINT_LIGHT_INTENSITY',
  );
  process.exit(1);
}
if (
  alphaCutoff !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialMetallicChannel,
    materialRoughnessChannel,
    materialEmissive,
    materialEmissiveIntensity,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialNormalTextureMipmapFilter,
    materialNormalTextureAddressModeU,
    materialNormalTextureAddressModeV,
    materialNormalTextureAddressModeW,
    materialNormalTextureSamplerLodMinClamp,
    materialNormalTextureSamplerLodMaxClamp,
    materialNormalTextureSamplerMaxAnisotropy,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_ALPHA_CUTOFF cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}
if (
  alphaBlend !== '' &&
  [
    pointLightIntensity,
    pointLightRange,
    pointLightColor,
    pointLightPosition,
    materialMetallic,
    materialRoughness,
    materialBaseColor,
    materialBaseColorTexture,
    materialBaseColorTextureSampler,
    materialBaseColorTextureUvTransform,
    materialBaseColorTextureUvSet,
    materialMetallicRoughnessTexture,
    materialMetallicRoughnessTextureSampler,
    materialMetallicRoughnessTextureUvTransform,
    materialMetallicRoughnessTextureUvSet,
    materialMetallicChannel,
    materialRoughnessChannel,
    materialEmissive,
    materialEmissiveIntensity,
    materialEmissiveTexture,
    materialEmissiveTextureSampler,
    materialEmissiveTextureUvTransform,
    materialEmissiveTextureUvSet,
    materialClearcoat,
    materialNormalScale,
    materialNormalTexture,
    materialNormalTextureUvSet,
    materialNormalTextureSampler,
    materialNormalTextureUvTransform,
    materialNormalTextureMagFilter,
    materialNormalTextureMinFilter,
    materialNormalTextureMipmapFilter,
    materialNormalTextureAddressModeU,
    materialNormalTextureAddressModeV,
    materialNormalTextureAddressModeW,
    materialNormalTextureSamplerLodMinClamp,
    materialNormalTextureSamplerLodMaxClamp,
    materialNormalTextureSamplerMaxAnisotropy,
    materialOcclusionStrength,
    materialOcclusionTextureSampler,
    materialOcclusionTextureUvTransform,
    materialOcclusionTextureUvSet,
    materialSpecularColor,
    materialSpecularColorTexture,
    materialSpecularColorTextureSampler,
    materialSpecularColorTextureUvTransform,
    materialSpecularColorTextureUvSet,
    alphaCutoff,
  ].some((value) => value !== '')
) {
  console.error(
    '[smoke-browser] FAIL - VITE_FALSIFY_MATERIAL_ALPHA_BLEND cannot be combined with another material or PointLight falsifier',
  );
  process.exit(1);
}

const LOG_PREFIX = '[learn-render 2.2 basic-lighting]';
const BLUE_TEXEL = [0, 64, 255, 255];
const BASE_COLOR_CHECKER_BYTES = [
  0, 64, 255, 255,
  255, 255, 255, 255,
  255, 255, 255, 255,
  0, 64, 255, 255,
];
const METALLIC_ROUGHNESS_CHECKER_BYTES = [
  0, 0, 255, 255,
  0, 255, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
];
const BLUE_CORNER_BYTES = [
  0, 64, 255, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
];
const NORMAL_CHECKER_BYTES = [
  255, 128, 255, 255,
  128, 255, 128, 255,
  128, 128, 255, 255,
  255, 255, 128, 255,
];
const IDENTITY_UV0_COORDINATES = [0, 0, 1, 1, 0, 0, 1, 1];
const UV1_COORDINATES = [0, 0, 1, 1, 1, 0, 1, 1];
const QUARTER_TRANSFORM_COORDINATES = [0.25, 0.25, 0, 0, 0, 0, 1, 1];
const materialUploadFalsified = [
  materialMetallic,
  materialRoughness,
  materialBaseColor,
  materialBaseColorTexture,
  materialBaseColorTextureSampler,
  materialBaseColorTextureUvTransform,
  materialBaseColorTextureUvSet,
  materialMetallicRoughnessTexture,
  materialMetallicRoughnessTextureSampler,
  materialMetallicRoughnessTextureUvTransform,
  materialMetallicRoughnessTextureUvSet,
  materialEmissive,
  materialEmissiveIntensity,
  materialEmissiveTexture,
  materialEmissiveTextureSampler,
  materialEmissiveTextureUvTransform,
  materialEmissiveTextureUvSet,
  materialClearcoat,
  materialNormalScale,
  materialNormalTexture,
  materialNormalTextureUvSet,
  materialNormalTextureSampler,
  materialNormalTextureUvTransform,
  materialNormalTextureMagFilter,
  materialNormalTextureMinFilter,
  materialNormalTextureMipmapFilter,
  materialNormalTextureAddressModeU,
  materialNormalTextureAddressModeV,
  materialNormalTextureAddressModeW,
  materialNormalTextureSamplerLodMinClamp,
  materialNormalTextureSamplerLodMaxClamp,
  materialNormalTextureSamplerMaxAnisotropy,
  materialOcclusionStrength,
  materialOcclusionTextureSampler,
  materialOcclusionTextureUvTransform,
  materialOcclusionTextureUvSet,
  materialSpecularColor,
  materialSpecularColorTexture,
  materialSpecularColorTextureSampler,
  materialSpecularColorTextureUvTransform,
  materialSpecularColorTextureUvSet,
].some((value) => value !== '');
// Every normal-texture falsifier except the UV set selects an explicit sampler.
const normalTextureSamplerFalsified = [
  materialNormalTexture,
  materialNormalTextureSampler,
  materialNormalTextureUvTransform,
  materialNormalTextureMagFilter,
  materialNormalTextureMinFilter,
  materialNormalTextureMipmapFilter,
  materialNormalTextureAddressModeU,
  materialNormalTextureAddressModeV,
  materialNormalTextureAddressModeW,
  materialNormalTextureSamplerLodMinClamp,
  materialNormalTextureSamplerLodMaxClamp,
  materialNormalTextureSamplerMaxAnisotropy,
].some((value) => value !== '');
const normalTextureFalsified = normalTextureSamplerFalsified || materialNormalTextureUvSet !== '';
const occlusionTextureFalsified = [
  materialOcclusionTextureSampler,
  materialOcclusionTextureUvTransform,
  materialOcclusionTextureUvSet,
].some((value) => value !== '');
const specularColorTextureFalsified = [
  materialSpecularColorTexture,
  materialSpecularColorTextureSampler,
  materialSpecularColorTextureUvTransform,
  materialSpecularColorTextureUvSet,
].some((value) => value !== '');

function differs(actual, expected, epsilon) {
  return actual.some((value, index) => Math.abs(value - expected[index]) > epsilon);
}

function seededBytes(tape, handleId) {
  const seed = tape.events.find(
    (candidate) => candidate.kind === 'initialData' && candidate.handleId === handleId,
  );
  const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
  return data === undefined ? undefined : new Uint8Array(data);
}

function bytesEqual(bytes, expectedBytes) {
  return (
    bytes !== undefined &&
    bytes.length === expectedBytes.length &&
    bytes.every((value, index) => value === expectedBytes[index])
  );
}

function isRgba8Texture(event, width, height) {
  return (
    event.kind === 'createTexture' &&
    event.desc?.format === 'rgba8unorm' &&
    event.desc?.size?.width === width &&
    event.desc?.size?.height === height
  );
}

function requireSeededTexture(tape, width, height, expectedBytes, missingMessage) {
  const texture = tape.events.find(
    (event) =>
      isRgba8Texture(event, width, height) &&
      bytesEqual(seededBytes(tape, event.handleId), expectedBytes),
  );
  if (texture === undefined) {
    throw new Error(missingMessage);
  }
  return texture;
}

function isNearestClampSampler(event) {
  return (
    event.kind === 'createSampler' &&
    event.desc?.magFilter === 'nearest' &&
    event.desc?.minFilter === 'nearest' &&
    event.desc?.mipmapFilter === 'nearest' &&
    event.desc?.addressModeU === 'clamp-to-edge' &&
    event.desc?.addressModeV === 'clamp-to-edge' &&
    event.desc?.addressModeW === 'clamp-to-edge'
  );
}

function requireNearestClampSampler(tape, missingMessage) {
  const sampler = tape.events.find(isNearestClampSampler);
  if (sampler === undefined) {
    throw new Error(missingMessage);
  }
  return sampler;
}

// `sampler === undefined` accepts any sampler at `samplerBinding`.
function requireTextureBindGroup(tape, texture, sampler, samplerBinding, textureBinding, missingMessage) {
  const view = tape.events.find(
    (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
  );
  const binding = tape.events.find(
    (event) =>
      event.kind === 'createBindGroup' &&
      event.entries.some((entry) => entry.binding === samplerBinding && entry.resourceKind === 'sampler') &&
      event.entries.some((entry) => entry.binding === textureBinding && entry.resourceKind === 'textureView') &&
      (sampler === undefined || event.resourceHandleIds.includes(sampler.handleId)) &&
      view !== undefined &&
      event.resourceHandleIds.includes(view.resultHandleId),
  );
  if (binding === undefined) {
    throw new Error(missingMessage);
  }
}

function isUv1VertexPipeline(event) {
  return (
    event.kind === 'createRenderPipeline' &&
    event.desc?.vertex?.buffers?.some(
      (buffer) =>
        buffer.arrayStride === 56 &&
        buffer.attributes?.some((attribute) => attribute.shaderLocation === 6 && attribute.offset === 48),
    )
  );
}

function hasUniformUv1(uv1Floats, u, v) {
  if (uv1Floats === undefined || uv1Floats.length !== 24 * 14) {
    return false;
  }
  return Array.from({ length: 24 }, (_, index) => {
    const offset = index * 14 + 12;
    return uv1Floats[offset] === u && uv1Floats[offset + 1] === v;
  }).every((value) => value);
}

function assertUv1VertexStream(tape, u, v) {
  if (tape.events.find(isUv1VertexPipeline) === undefined) {
    throw new Error(
      'capture tape is missing the 56-byte real UV1 vertex layout at shader location 6 offset 48',
    );
  }
  const uv1Buffer = tape.events.find(
    (event) => event.kind === 'createBuffer' && event.desc?.size === 1344,
  );
  const uv1Seed = uv1Buffer === undefined
    ? undefined
    : tape.events.find((event) => event.kind === 'initialData' && event.handleId === uv1Buffer.handleId);
  const uv1Data = uv1Seed === undefined ? undefined : tape.blobPool.get(uv1Seed.dataHash);
  const uv1Floats = uv1Data === undefined ? undefined : new Float32Array(uv1Data);
  if (!hasUniformUv1(uv1Floats, u, v)) {
    throw new Error(
      `capture tape is missing the producer-owned UV1=[${u},${v}] bytes in the 14-float mesh stride`,
    );
  }
}

function assertTextureCoordinates(materialFloats, start, expected, name, byteRange) {
  const actual = Array.from(materialFloats.slice(start, start + 8));
  if (differs(actual, expected, 1e-6)) {
    throw new Error(
      `capture tape ${name} coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets ${byteRange}`,
    );
  }
  return actual;
}

function assertMetallicRoughnessChannels(materialFloats, label, expectedChannels) {
  const materialChannels = [materialFloats[4], materialFloats[6], materialFloats[7]];
  if (differs(materialChannels, expectedChannels, 1e-6)) {
    const [metallic, metallicChannel, roughnessChannel] = expectedChannels;
    throw new Error(
      `capture tape ${label} material=${JSON.stringify(materialChannels)}; expected metallic=${metallic}, metallicChannel=${metallicChannel}, roughnessChannel=${roughnessChannel} at global byte offsets 16,24,28`,
    );
  }
}

function findStandardMaterialUpload(tape) {
  const materialBuffer = tape.events.find(
    (event) =>
      event.kind === 'createBuffer' && event.desc?.size === 524288 && event.desc?.usage === 76,
  );
  const materialUpload = materialBuffer === undefined
    ? undefined
    : tape.events.find(
        (event) =>
          event.kind === 'writeBuffer' &&
          event.handleId === materialBuffer.handleId &&
          event.bufferOffset === 0 &&
          event.size === 512,
      );
  return materialUpload === undefined ? undefined : tape.blobPool.get(materialUpload.dataHash);
}

function readClusterLightFloats(tape) {
  const lightDataBuffer = tape.events.find(
    (event) =>
      event.kind === 'createBuffer' && event.desc?.size === 20480 && event.desc?.usage === 136,
  );
  const upload = lightDataBuffer === undefined
    ? undefined
    : tape.events.find(
        (event) =>
          event.kind === 'writeBuffer' &&
          event.handleId === lightDataBuffer.handleId &&
          event.bufferOffset === 0 &&
          event.size >= 80,
      );
  const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
  if (data === undefined || data.byteLength < 80) {
    throw new Error(
      'capture tape is missing the unified Cluster light_data upload at buffer offset 0',
    );
  }
  return new Float32Array(data);
}

function assertAlphaCutoffTape(tape) {
  const materialData = findStandardMaterialUpload(tape);
  if (materialData === undefined || materialData.byteLength < 72) {
    throw new Error(
      'capture tape is missing the 512-byte Standard PBR material upload for alpha cutoff',
    );
  }
  const actual = new Float32Array(materialData)[17];
  if (Math.abs(actual - 0.5) > 1e-6) {
    throw new Error(
      `capture tape material alphaCutoff=${actual}; expected 0.5 at global byte offset 68`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialAlphaCutoff=${actual} materialUBO byteOffset=68 baseColorAlpha=0.25`,
  );
}

function requireAlphaBlendPipeline(tape) {
  const blendPipeline = tape.events.find(
    (event) =>
      event.kind === 'createRenderPipeline' &&
      event.desc?.fragment?.targets?.[0]?.blend !== undefined,
  );
  if (blendPipeline === undefined) {
    throw new Error('capture tape is missing the producer-owned alpha blend pipeline');
  }
  const blend = blendPipeline.desc.fragment.targets[0].blend;
  const expectedColor = {
    srcFactor: 'src-alpha',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  };
  const expectedAlpha = {
    srcFactor: 'one',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  };
  if (
    JSON.stringify(blend.color) !== JSON.stringify(expectedColor) ||
    JSON.stringify(blend.alpha) !== JSON.stringify(expectedAlpha) ||
    blendPipeline.desc?.depthStencil?.depthWriteEnabled !== false
  ) {
    throw new Error(
      `capture tape alpha blend state drifted: ${JSON.stringify({ blend, depthWriteEnabled: blendPipeline.desc?.depthStencil?.depthWriteEnabled })}`,
    );
  }
  return blendPipeline;
}

function assertAlphaBlendTape(tape) {
  const blendPipeline = requireAlphaBlendPipeline(tape);
  const blendPipelineUse = tape.events.find(
    (event) => event.kind === 'setPipeline' && event.pipelineHandleId === blendPipeline.handleId,
  );
  if (blendPipelineUse === undefined) {
    throw new Error('capture tape alpha blend pipeline was never selected for a draw');
  }
  const materialData = findStandardMaterialUpload(tape);
  if (materialData === undefined || materialData.byteLength < 16) {
    throw new Error('capture tape is missing the alpha-blend Standard PBR material upload');
  }
  const baseColorAlpha = new Float32Array(materialData)[3];
  if (Math.abs(baseColorAlpha - 0.5) > 1e-6) {
    throw new Error(
      `capture tape alpha blend baseColor alpha=${baseColorAlpha}; expected 0.5 at global byte offset 12`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialAlphaBlend=${alphaBlend} baseColorAlpha=${baseColorAlpha} blend=src-alpha/one-minus-src-alpha depthWriteEnabled=false queue=3000`,
  );
}

function assertEmissiveTextureCoordinatesTape(materialFloats) {
  if (materialEmissiveTextureUvTransform !== '') {
    const actual = assertTextureCoordinates(materialFloats, 56, QUARTER_TRANSFORM_COORDINATES, 'emissiveTexture', '224..252');
    console.log(
      `${LOG_PREFIX} tape materialEmissiveTextureUvTransform=1 coordinates=${JSON.stringify(actual)} materialUBO byteOffsets=224,228,232,236,240,244,248,252`,
    );
  }
  if (materialEmissiveTextureUvSet !== '') {
    const actual = assertTextureCoordinates(materialFloats, 56, UV1_COORDINATES, 'emissiveTexture', '224..252');
    console.log(
      `${LOG_PREFIX} tape materialEmissiveTextureUvSet=1 coordinates=${JSON.stringify(actual)} materialUBO byteOffsets=224,228,232,236,240,244,248,252`,
    );
  }
}

function assertBaseColorFactorTape(materialFloats) {
  const actual = [materialFloats[0], materialFloats[1], materialFloats[2], materialFloats[3]];
  const authored = materialBaseColor === 'warm' ? [1.0, 0.5, 0.31] : [0.2, 0.5, 1.0];
  const expected = [...authored.map(srgbToLinear), 1.0];
  if (differs(actual, expected, 1e-6)) {
    throw new Error(
      `capture tape material baseColor=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 0,4,8,12`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialBaseColor=${materialBaseColor} baseColor=${JSON.stringify(actual)} materialUBO byteOffsets=0,4,8,12`,
  );
}

function assertBaseColorTextureTape(tape) {
  const texture = requireSeededTexture(tape, 1, 1, BLUE_TEXEL,
    'capture tape is missing the blue 1x1 baseColorTexture initialData payload',
  );
  requireTextureBindGroup(tape, texture, undefined, 1, 2,
    'capture tape is missing the engine-managed baseColorTexture bindings at 1/2',
  );
  console.log(
    `${LOG_PREFIX} tape materialBaseColorTexture=blue payload=${JSON.stringify(BLUE_TEXEL)} colorSpace=linear engineManagedRegion=baseColorTexture bindings=1/2`,
  );
}

function assertBaseColorTextureSamplerTape(tape) {
  const texture = requireSeededTexture(tape, 2, 2, BASE_COLOR_CHECKER_BYTES,
    'capture tape is missing the 2x2 baseColorTexture sampler checker initialData payload',
  );
  const sampler = requireNearestClampSampler(tape,
    'capture tape is missing the baseColorTexture sampler nearest/clamp-to-edge descriptor',
  );
  requireTextureBindGroup(tape, texture, sampler, 1, 2,
    'capture tape is missing the engine-managed baseColorTexture sampler bindings at 1/2',
  );
  console.log(
    `${LOG_PREFIX} tape materialBaseColorTextureSampler=nearest payload=${JSON.stringify(BASE_COLOR_CHECKER_BYTES)} colorSpace=linear sampler=nearest/clamp-to-edge engineManagedRegion=baseColorTexture bindings=1/2`,
  );
}

function assertBaseColorTextureUvTransformTape(tape, materialFloats) {
  const actual = assertTextureCoordinates(materialFloats, 24, QUARTER_TRANSFORM_COORDINATES, 'baseColorTexture', '384..412');
  const texture = requireSeededTexture(tape, 2, 2, BASE_COLOR_CHECKER_BYTES,
    'capture tape is missing the 2x2 baseColorTexture UV-transform checker initialData payload',
  );
  const sampler = requireNearestClampSampler(tape,
    'capture tape is missing the baseColorTexture UV-transform nearest/clamp-to-edge sampler descriptor',
  );
  requireTextureBindGroup(tape, texture, sampler, 1, 2,
    'capture tape is missing the engine-managed baseColorTexture UV-transform bindings at 1/2',
  );
  console.log(
    `${LOG_PREFIX} tape materialBaseColorTextureUvTransform=1 coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(BASE_COLOR_CHECKER_BYTES)} colorSpace=linear sampler=nearest/clamp-to-edge engineManagedRegion=baseColorTexture bindings=1/2 materialUBO byteOffsets=384,388,392,396,400,404,408,412`,
  );
}

function assertBaseColorTextureUvSetTape(tape, materialFloats) {
  const actual = assertTextureCoordinates(materialFloats, 24, UV1_COORDINATES, 'baseColorTexture', '384..412');
  const texture = requireSeededTexture(tape, 2, 2, BASE_COLOR_CHECKER_BYTES,
    'capture tape is missing the 2x2 baseColorTexture UV-set checker initialData payload',
  );
  const sampler = requireNearestClampSampler(tape,
    'capture tape is missing the baseColorTexture UV-set nearest/clamp-to-edge sampler descriptor',
  );
  requireTextureBindGroup(tape, texture, sampler, 1, 2,
    'capture tape is missing the engine-managed baseColorTexture UV-set bindings at 1/2',
  );
  assertUv1VertexStream(tape, 0.25, 0.25);
  console.log(
    `${LOG_PREFIX} tape materialBaseColorTextureUvSet=1 coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(BASE_COLOR_CHECKER_BYTES)} sampler=nearest/clamp-to-edge engineManagedRegion=baseColorTexture bindings=1/2 vertexStride=56 uv1Location=6 uv1Offset=48 uv1=[0.25,0.25] materialUBO byteOffsets=384,388,392,396,400,404,408,412`,
  );
}

function assertBaseColorTape(tape, materialFloats) {
  if (materialBaseColor !== '') {
    assertBaseColorFactorTape(materialFloats);
  }
  if (materialBaseColorTexture !== '') {
    assertBaseColorTextureTape(tape);
  }
  if (materialBaseColorTextureSampler !== '') {
    assertBaseColorTextureSamplerTape(tape);
  }
  if (materialBaseColorTextureUvTransform !== '') {
    assertBaseColorTextureUvTransformTape(tape, materialFloats);
  }
  if (materialBaseColorTextureUvSet !== '') {
    assertBaseColorTextureUvSetTape(tape, materialFloats);
  }
}

function assertMetallicChannelTape(tape, materialFloats) {
  assertMetallicRoughnessChannels(materialFloats, 'metallicChannel', [0.5, 0, 1]);
  const expectedBytes = [255, 255, 0, 255];
  const texture = requireSeededTexture(tape, 1, 1, expectedBytes,
    'capture tape is missing the red 1x1 metallicChannel initialData payload',
  );
  requireTextureBindGroup(tape, texture, undefined, 3, 4,
    'capture tape is missing the engine-managed metallicChannel texture bindings at 3/4',
  );
  console.log(
    `${LOG_PREFIX} tape materialMetallicChannel=${materialMetallicChannel} payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO metallic=0.5 metallicChannel=red roughnessChannel=green byteOffsets=16,24,28`,
  );
}

function assertRoughnessChannelTape(tape, materialFloats) {
  assertMetallicRoughnessChannels(materialFloats, 'roughnessChannel', [0.5, 2, 2]);
  const expectedBytes = [0, 0, 255, 255];
  const texture = requireSeededTexture(tape, 1, 1, expectedBytes,
    'capture tape is missing the blue 1x1 roughnessChannel initialData payload',
  );
  requireTextureBindGroup(tape, texture, undefined, 3, 4,
    'capture tape is missing the engine-managed roughnessChannel texture bindings at 3/4',
  );
  console.log(
    `${LOG_PREFIX} tape materialRoughnessChannel=${materialRoughnessChannel} payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO metallic=0.5 metallicChannel=blue roughnessChannel=blue byteOffsets=16,24,28`,
  );
}

function assertMetallicRoughnessTextureTape(tape, materialFloats) {
  assertMetallicRoughnessChannels(materialFloats, 'metallicRoughness', [0.5, 2, 1]);
  const expectedBytes = [0, 0, 255, 255];
  const texture = requireSeededTexture(tape, 1, 1, expectedBytes,
    'capture tape is missing the blue 1x1 metallicRoughnessTexture initialData payload',
  );
  requireTextureBindGroup(tape, texture, undefined, 3, 4,
    'capture tape is missing the engine-managed metallicRoughnessTexture bindings at 3/4',
  );
  console.log(
    `${LOG_PREFIX} tape materialMetallicRoughnessTexture=blue payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO metallic=0.5 metallicChannel=blue roughnessChannel=green byteOffsets=16,24,28`,
  );
}

function assertMetallicRoughnessTextureSamplerTape(tape, materialFloats) {
  assertMetallicRoughnessChannels(materialFloats, 'metallicRoughness sampler', [0.5, 2, 1]);
  const texture = requireSeededTexture(tape, 2, 2, METALLIC_ROUGHNESS_CHECKER_BYTES,
    'capture tape is missing the 2x2 metallicRoughnessTexture checker initialData payload',
  );
  const sampler = requireNearestClampSampler(tape,
    'capture tape is missing the metallicRoughnessTexture nearest/clamp-to-edge sampler descriptor',
  );
  requireTextureBindGroup(tape, texture, sampler, 3, 4,
    'capture tape is missing the engine-managed metallicRoughnessTexture sampler/texture bindings at 3/4',
  );
  console.log(
    `${LOG_PREFIX} tape materialMetallicRoughnessTextureSampler=nearest payload=${JSON.stringify(METALLIC_ROUGHNESS_CHECKER_BYTES)} colorSpace=linear sampler=nearest/clamp-to-edge engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO metallic=0.5 metallicChannel=blue roughnessChannel=green byteOffsets=16,24,28`,
  );
}

function assertMetallicRoughnessTextureUvTransformTape(tape, materialFloats) {
  const actual = assertTextureCoordinates(materialFloats, 32, [0.75, 0.25, 0, 0, 0, 0, 1, 1], 'metallicRoughnessTexture', '128..156');
  const texture = requireSeededTexture(tape, 2, 2, METALLIC_ROUGHNESS_CHECKER_BYTES,
    'capture tape is missing the 2x2 metallicRoughnessTexture transform checker initialData payload',
  );
  const sampler = requireNearestClampSampler(tape,
    'capture tape is missing the metallicRoughnessTexture transform nearest/clamp-to-edge sampler descriptor',
  );
  requireTextureBindGroup(tape, texture, sampler, 3, 4,
    'capture tape is missing the engine-managed metallicRoughnessTexture transform bindings at 3/4',
  );
  console.log(
    `${LOG_PREFIX} tape materialMetallicRoughnessTextureUvTransform=1 coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(METALLIC_ROUGHNESS_CHECKER_BYTES)} colorSpace=linear sampler=nearest/clamp-to-edge engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO byteOffsets=128,132,136,140,144,148,152,156`,
  );
}

function assertMetallicRoughnessTextureUvSetTape(tape, materialFloats) {
  const actual = assertTextureCoordinates(materialFloats, 32, UV1_COORDINATES, 'metallicRoughnessTexture', '128..156');
  const texture = requireSeededTexture(tape, 2, 2, METALLIC_ROUGHNESS_CHECKER_BYTES,
    'capture tape is missing the 2x2 metallicRoughnessTexture UV-set checker initialData payload',
  );
  const sampler = requireNearestClampSampler(tape,
    'capture tape is missing the metallicRoughnessTexture UV-set nearest/clamp-to-edge sampler descriptor',
  );
  requireTextureBindGroup(tape, texture, sampler, 3, 4,
    'capture tape is missing the engine-managed metallicRoughnessTexture UV-set bindings at 3/4',
  );
  assertUv1VertexStream(tape, 0.75, 0.25);
  console.log(
    `${LOG_PREFIX} tape materialMetallicRoughnessTextureUvSet=1 coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(METALLIC_ROUGHNESS_CHECKER_BYTES)} sampler=nearest/clamp-to-edge engineManagedRegion=metallicRoughnessTexture bindings=3/4 vertexStride=56 uv1Location=6 uv1Offset=48 uv1=[0.75,0.25] materialUBO byteOffsets=128,132,136,140,144,148,152,156`,
  );
}

function assertMetallicFactorTape(materialFloats) {
  const actual = materialFloats[4];
  const expected = materialMetallic === 'dielectric' ? 0.0 : 1.0;
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `capture tape material metallic=${actual}; expected ${expected} at global byte offset 16`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialMetallic=${materialMetallic} metallic=${actual} materialUBO byteOffset=16`,
  );
}

function assertRoughnessFactorTape(materialFloats) {
  const actual = materialFloats[5];
  const expected = materialRoughness === 'smooth' ? 0.2 : 0.8;
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `capture tape material roughness=${actual}; expected ${expected} at global byte offset 20`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialRoughness=${materialRoughness} roughness=${actual} materialUBO byteOffset=20`,
  );
}

function assertMetallicRoughnessTape(tape, materialFloats) {
  if (materialMetallicChannel !== '') {
    assertMetallicChannelTape(tape, materialFloats);
  }
  if (materialRoughnessChannel !== '') {
    assertRoughnessChannelTape(tape, materialFloats);
  }
  if (materialMetallicRoughnessTexture !== '') {
    assertMetallicRoughnessTextureTape(tape, materialFloats);
  }
  if (materialMetallicRoughnessTextureSampler !== '') {
    assertMetallicRoughnessTextureSamplerTape(tape, materialFloats);
  }
  if (materialMetallicRoughnessTextureUvTransform !== '') {
    assertMetallicRoughnessTextureUvTransformTape(tape, materialFloats);
  }
  if (materialMetallicRoughnessTextureUvSet !== '') {
    assertMetallicRoughnessTextureUvSetTape(tape, materialFloats);
  }
  if (materialMetallic !== '') {
    assertMetallicFactorTape(materialFloats);
  }
  if (materialRoughness !== '') {
    assertRoughnessFactorTape(materialFloats);
  }
}

function assertEmissiveFactorTape(materialFloats) {
  const actual = [materialFloats[12], materialFloats[13], materialFloats[14]];
  const authored = materialEmissive === 'red' ? [1.0, 0.05, 0.02] : [0.02, 0.2, 1.0];
  const expected = authored.map(srgbToLinear);
  if (differs(actual, expected, 1e-6)) {
    throw new Error(
      `capture tape material emissive=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 48,52,56`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialEmissive=${materialEmissive} emissive=${JSON.stringify(actual)} materialUBO byteOffsets=48,52,56 emissiveIntensity=${materialFloats[15]}`,
  );
}

function assertEmissiveIntensityTape(materialFloats) {
  const emissive = [materialFloats[12], materialFloats[13], materialFloats[14]];
  const expectedEmissive = [1.0, 0.05, 0.02].map(srgbToLinear);
  if (differs(emissive, expectedEmissive, 1e-6)) {
    throw new Error(
      `capture tape material emissive=${JSON.stringify(emissive)}; expected ${JSON.stringify(expectedEmissive)} for the intensity witness`,
    );
  }
  const actual = materialFloats[15];
  const expected = 2.0;
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `capture tape material emissiveIntensity=${actual}; expected ${expected} at global byte offset 60`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialEmissiveIntensity=${materialEmissiveIntensity} emissiveIntensity=${actual} materialUBO byteOffset=60 emissive=${JSON.stringify(emissive)}`,
  );
}

function assertClearcoatTape(materialFloats) {
  const actual = [materialFloats[18], materialFloats[19]];
  const expected = [1.0, 0.05];
  if (differs(actual, expected, 1e-6)) {
    throw new Error(
      `capture tape material clearcoat=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 72,76`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialClearcoat=${materialClearcoat} clearcoat=${actual[0]} clearcoatRoughness=${actual[1]} materialUBO byteOffsets=72,76`,
  );
}

function assertNormalScaleTape(materialFloats) {
  const actual = Array.from(materialFloats.slice(24, 26));
  const expected = [0.0, 0.0];
  if (differs(actual, expected, 1e-6)) {
    throw new Error(
      `capture tape material normalScale=${actual}; expected ${expected} at global byte offsets 96,100`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialNormalScale=${materialNormalScale} normalScale=${actual} materialUBO byteOffsets=96,100 texture=rg-normal`,
  );
}

function assertEmissiveAndSurfaceFactorsTape(materialFloats) {
  if (materialEmissive !== '') {
    assertEmissiveFactorTape(materialFloats);
  }
  if (materialEmissiveIntensity !== '') {
    assertEmissiveIntensityTape(materialFloats);
  }
  if (materialClearcoat !== '') {
    assertClearcoatTape(materialFloats);
  }
  if (materialNormalScale !== '') {
    assertNormalScaleTape(materialFloats);
  }
}

function expectedNormalTextureCoordinates() {
  if (materialNormalTextureUvTransform !== '') {
    return QUARTER_TRANSFORM_COORDINATES;
  }
  return materialNormalTextureUvSet === '' ? IDENTITY_UV0_COORDINATES : UV1_COORDINATES;
}

function expectedNormalFilter(selectedFilter) {
  return materialNormalTextureSamplerMaxAnisotropy !== '' || selectedFilter === 'linear'
    ? 'linear'
    : 'nearest';
}

function expectedNormalAddressMode(selectedMode) {
  return selectedMode === 'repeat' ? 'repeat' : 'clamp-to-edge';
}

function normalSamplerLodMatches(desc) {
  const lodMin = materialNormalTextureSamplerLodMinClamp;
  const lodMax = materialNormalTextureSamplerLodMaxClamp;
  const maxAnisotropy = materialNormalTextureSamplerMaxAnisotropy;
  return (
    (lodMin === '' || desc?.lodMinClamp === (lodMin === '1' ? 1 : 0)) &&
    (lodMin === '' || desc?.lodMaxClamp === 1) &&
    (lodMax === '' || desc?.lodMinClamp === 0) &&
    (lodMax === '' || desc?.lodMaxClamp === (lodMax === '1' ? 1 : 0)) &&
    (maxAnisotropy === '' || desc?.maxAnisotropy === (maxAnisotropy === '1' ? 16 : undefined))
  );
}

function isNormalTextureSampler(event) {
  return (
    event.kind === 'createSampler' &&
    event.desc?.magFilter === expectedNormalFilter(materialNormalTextureMagFilter) &&
    event.desc?.minFilter === expectedNormalFilter(materialNormalTextureMinFilter) &&
    event.desc?.mipmapFilter === expectedNormalFilter(materialNormalTextureMipmapFilter) &&
    event.desc?.addressModeU === expectedNormalAddressMode(materialNormalTextureAddressModeU) &&
    event.desc?.addressModeV === expectedNormalAddressMode(materialNormalTextureAddressModeV) &&
    event.desc?.addressModeW === expectedNormalAddressMode(materialNormalTextureAddressModeW) &&
    normalSamplerLodMatches(event.desc)
  );
}

// Reports the highest-priority normal-texture falsifier that is set.
function normalTextureProfile() {
  if (materialNormalTextureSamplerMaxAnisotropy !== '') return 'max-anisotropy';
  if (materialNormalTextureSamplerLodMaxClamp !== '') return 'lod-max-clamp';
  if (materialNormalTextureSamplerLodMinClamp !== '') return 'lod-min-clamp';
  if (materialNormalTextureAddressModeW !== '') return 'address-mode-w';
  if (materialNormalTextureAddressModeV !== '') return 'address-mode-v';
  if (materialNormalTextureAddressModeU !== '') return 'address-mode-u';
  if (materialNormalTextureMipmapFilter !== '') return 'mipmap-filter';
  if (materialNormalTextureMinFilter !== '') return 'min-filter';
  if (materialNormalTextureMagFilter !== '') return 'mag-filter';
  if (materialNormalTexture !== '') return 'texture';
  if (materialNormalTextureUvTransform !== '') return 'uv-transform';
  if (materialNormalTextureSampler !== '') return 'sampler';
  return 'uv-set';
}

function normalTextureLodMinClampLabel() {
  if (materialNormalTextureSamplerMaxAnisotropy !== '' || materialNormalTextureSamplerLodMaxClamp !== '') {
    return '0';
  }
  return materialNormalTextureSamplerLodMinClamp === '' ? 'default' : materialNormalTextureSamplerLodMinClamp;
}

function normalTextureLodMaxClampLabel() {
  if (materialNormalTextureSamplerMaxAnisotropy !== '') return '1';
  if (materialNormalTextureSamplerLodMaxClamp !== '') return materialNormalTextureSamplerLodMaxClamp;
  return materialNormalTextureSamplerLodMinClamp === '' ? 'default' : '1';
}

function normalTextureMaxAnisotropyLabel() {
  if (materialNormalTextureSamplerMaxAnisotropy === '') return 'default';
  return materialNormalTextureSamplerMaxAnisotropy === '1' ? '16' : '1';
}

function normalTextureSamplerLog() {
  return `sampler=${materialNormalTextureMagFilter || materialNormalTextureSampler || 'nearest'} minFilter=${materialNormalTextureMinFilter || 'nearest'} mipmapFilter=${materialNormalTextureMipmapFilter || 'nearest'} addressModeU=clamp-to-edge addressModeV=${materialNormalTextureAddressModeV || 'clamp-to-edge'} addressModeW=${materialNormalTextureAddressModeW || 'clamp-to-edge'} lodMinClamp=${normalTextureLodMinClampLabel()} lodMaxClamp=${normalTextureLodMaxClampLabel()} maxAnisotropy=${normalTextureMaxAnisotropyLabel()}`;
}

function assertNormalTextureTape(tape, materialFloats) {
  const actual = assertTextureCoordinates(materialFloats, 40, expectedNormalTextureCoordinates(), 'normalTexture', '160..188');
  const tilt = materialNormalTexture === 'tilt';
  const expectedBytes = tilt ? [128, 255, 128, 255] : NORMAL_CHECKER_BYTES;
  const expectedSize = tilt ? 1 : 2;
  const texture = requireSeededTexture(tape, expectedSize, expectedSize, expectedBytes,
    `capture tape is missing the ${expectedSize}x${expectedSize} linear normalTexture initialData payload`,
  );
  const sampler = normalTextureSamplerFalsified ? tape.events.find(isNormalTextureSampler) : undefined;
  if (normalTextureSamplerFalsified && sampler === undefined) {
    throw new Error('capture tape is missing the normalTexture sampler descriptor');
  }
  requireTextureBindGroup(tape, texture, sampler, 5, 6,
    'capture tape is missing the engine-managed normalTexture bindings at 5/6',
  );
  console.log(
    `${LOG_PREFIX} tape materialNormalTexture profile=${normalTextureProfile()} ${normalTextureSamplerLog()} coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=normalTexture bindings=5/6 materialUBO byteOffsets=160,164,168,172,176,180,184,188`,
  );
}

function requireBlackOcclusionTexture(tape) {
  const blackTexel = [0, 0, 0, 255];
  const texture = tape.events.find(
    (event) =>
      isRgba8Texture(event, 1, 1) &&
      event.desc?.usage === 23 &&
      bytesEqual(seededBytes(tape, event.handleId), blackTexel),
  );
  if (texture === undefined) {
    throw new Error('capture tape is missing the 1x1 black linear occlusion texture payload');
  }
  return texture;
}

function assertOcclusionTextureUvSetTape(tape, materialFloats, occlusionStrength) {
  const coordinates = assertTextureCoordinates(materialFloats, 64, UV1_COORDINATES, 'occlusionTexture', '256..284');
  assertUv1VertexStream(tape, 0.75, 0.75);
  console.log(
    `${LOG_PREFIX} tape materialOcclusionTextureUvSet=1 coordinates=${JSON.stringify(coordinates)} occlusionStrength=${occlusionStrength} texture=rgba8unorm 1x1 black sampler=nearest/clamp-to-edge engineManagedRegion=occlusionTexture bindings=18/19 vertexStride=56 uv1Location=6 uv1Offset=48 uv1=[0.75,0.75] materialUBO byteOffsets=256,260,264,268,272,276,280,284`,
  );
}

function assertOcclusionTextureUvTransformTape(materialFloats, occlusionStrength) {
  const coordinates = assertTextureCoordinates(materialFloats, 64, QUARTER_TRANSFORM_COORDINATES, 'occlusionTexture', '256..284');
  console.log(
    `${LOG_PREFIX} tape materialOcclusionTextureUvTransform=1 coordinates=${JSON.stringify(coordinates)} occlusionStrength=${occlusionStrength} texture=rgba8unorm 1x1 black sampler=nearest/clamp-to-edge engineManagedRegion=occlusionTexture bindings=18/19 materialUBO byteOffsets=256,260,264,268,272,276,280,284`,
  );
}

function assertOcclusionTextureTape(tape, materialFloats, texture, occlusionStrength) {
  const sampler = requireNearestClampSampler(tape,
    'capture tape is missing the occlusionTexture sampler nearest/clamp-to-edge descriptor',
  );
  requireTextureBindGroup(tape, texture, sampler, 18, 19,
    'capture tape is missing the engine-managed occlusionTexture bindings at 18/19',
  );
  if (materialOcclusionTextureUvSet !== '') {
    assertOcclusionTextureUvSetTape(tape, materialFloats, occlusionStrength);
  } else if (materialOcclusionTextureUvTransform !== '') {
    assertOcclusionTextureUvTransformTape(materialFloats, occlusionStrength);
  } else {
    console.log(
      `${LOG_PREFIX} tape materialOcclusionTextureSampler=nearest occlusionStrength=${occlusionStrength} texture=rgba8unorm 1x1 black sampler=nearest/clamp-to-edge engineManagedRegion=occlusionTexture bindings=18/19 materialUBO byteOffset=64`,
    );
  }
}

function assertOcclusionTape(tape, materialFloats) {
  const actual = materialFloats[16];
  const expectedStrength = materialOcclusionStrength === '' ? 1 : 0;
  if (Math.abs(actual - expectedStrength) > 1e-6) {
    throw new Error(
      `capture tape material occlusionStrength=${actual}; expected ${expectedStrength} at global byte offset 64`,
    );
  }
  const texture = requireBlackOcclusionTexture(tape);
  if (occlusionTextureFalsified) {
    assertOcclusionTextureTape(tape, materialFloats, texture, actual);
  } else {
    console.log(
      `${LOG_PREFIX} tape materialOcclusionStrength=zero occlusionStrength=${actual} materialUBO byteOffset=64 texture=rgba8unorm 1x1 black`,
    );
  }
}

function assertSpecularColorFactorTape(materialFloats) {
  const actual = [materialFloats[20], materialFloats[21], materialFloats[22]];
  const expected = [0.0, srgbToLinear(0.8), 1.0];
  if (differs(actual, expected, 1e-6)) {
    throw new Error(
      `capture tape material specularColor=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 80,84,88`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape materialSpecularColor=cool specularColor=${JSON.stringify(actual)} materialUBO byteOffsets=80,84,88`,
  );
}

function assertSpecularColorTextureCoordinatesTape(tape, materialFloats) {
  if (materialSpecularColorTextureUvTransform !== '') {
    const actual = assertTextureCoordinates(materialFloats, 48, QUARTER_TRANSFORM_COORDINATES, 'specularColorTexture', '192..220');
    console.log(
      `${LOG_PREFIX} tape materialSpecularColorTextureUvTransform=1 coordinates=${JSON.stringify(actual)} materialUBO byteOffsets=192,196,200,204,208,212,216,220`,
    );
  } else if (materialSpecularColorTextureUvSet !== '') {
    const actual = assertTextureCoordinates(materialFloats, 48, UV1_COORDINATES, 'specularColorTexture', '192..220');
    assertUv1VertexStream(tape, 0.75, 0.75);
    console.log(
      `${LOG_PREFIX} tape materialSpecularColorTextureUvSet=1 coordinates=${JSON.stringify(actual)} materialUBO byteOffsets=192,196,200,204,208,212,216,220 texture=rgba8unorm 2x2 sampler=nearest/clamp-to-edge userRegion=specularColorTexture bindings=7/8 vertexStride=56 uv1Location=6 uv1Offset=48 uv1=[0.75,0.75]`,
    );
  }
}

function assertSpecularColorTextureTape(tape, materialFloats) {
  const singleTexel = materialSpecularColorTextureUvTransform === '' && materialSpecularColorTextureUvSet === '';
  const expectedBytes = singleTexel ? BLUE_TEXEL : BLUE_CORNER_BYTES;
  const expectedSize = singleTexel ? 1 : 2;
  const texture = requireSeededTexture(tape, expectedSize, expectedSize, expectedBytes,
    'capture tape is missing the expected specularColorTexture initialData payload',
  );
  const sampler = requireNearestClampSampler(tape,
    'capture tape is missing the specularColorTexture sampler nearest/clamp-to-edge descriptor',
  );
  requireTextureBindGroup(tape, texture, sampler, 7, 8,
    'capture tape is missing the specularColorTexture user-region bindings at 7/8',
  );
  assertSpecularColorTextureCoordinatesTape(tape, materialFloats);
  console.log(
    `${LOG_PREFIX} tape materialSpecularColorTexture=${materialSpecularColorTexture === '' ? 'default' : 'blue'} sampler=nearest payload=${JSON.stringify(expectedBytes)} colorSpace=linear sampler=nearest/clamp-to-edge userRegion=specularColorTexture bindings=7/8`,
  );
}

function assertEmissiveTextureTape(tape) {
  const singleTexel = materialEmissiveTextureUvTransform === '' && materialEmissiveTextureUvSet === '';
  const expectedBytes = singleTexel ? BLUE_TEXEL : BLUE_CORNER_BYTES;
  const expectedSize = singleTexel ? 1 : 2;
  const texture = requireSeededTexture(tape, expectedSize, expectedSize, expectedBytes,
    'capture tape is missing the blue 1x1 emissiveTexture initialData payload',
  );
  const sampler = materialEmissiveTextureSampler === ''
    ? undefined
    : requireNearestClampSampler(tape, 'capture tape is missing the emissiveTexture nearest sampler descriptor');
  requireTextureBindGroup(tape, texture, sampler, 16, 17,
    'capture tape is missing the engine-managed emissiveTexture bindings at 16/17',
  );
  console.log(
    `${LOG_PREFIX} tape materialEmissiveTexture=blue payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=emissiveTexture bindings=16/17 sampler=${materialEmissiveTextureSampler || 'default'} uvTransform=${materialEmissiveTextureUvTransform || 'default'} uvSet=${materialEmissiveTextureUvSet || 'default'}`,
  );
}

function assertTextureSlotsTape(tape, materialFloats) {
  if (normalTextureFalsified) {
    assertNormalTextureTape(tape, materialFloats);
  }
  if (materialOcclusionStrength !== '' || occlusionTextureFalsified) {
    assertOcclusionTape(tape, materialFloats);
  }
  if (materialSpecularColor !== '') {
    assertSpecularColorFactorTape(materialFloats);
  }
  if (specularColorTextureFalsified) {
    assertSpecularColorTextureTape(tape, materialFloats);
  }
  if (materialEmissiveTexture !== '') {
    assertEmissiveTextureTape(tape);
  }
}

function assertMaterialUploadTape(tape) {
  const materialData = findStandardMaterialUpload(tape);
  if (materialData === undefined || materialData.byteLength < 80) {
    throw new Error('capture tape is missing the 512-byte Standard PBR material upload');
  }
  const materialFloats = new Float32Array(materialData);
  assertEmissiveTextureCoordinatesTape(materialFloats);
  assertBaseColorTape(tape, materialFloats);
  assertMetallicRoughnessTape(tape, materialFloats);
  assertEmissiveAndSurfaceFactorsTape(materialFloats);
  assertTextureSlotsTape(tape, materialFloats);
}

function assertPointLightPositionTape(floats) {
  const expected = pointLightPosition === 'near' ? [0.9, 0.8, 1.6] : [1.5, 1.0, 2.4];
  const actual = [floats[0], floats[1], floats[2]];
  if (differs(actual, expected, 1e-5)) {
    throw new Error(
      `capture tape Cluster light_data position=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at byte offsets 0,4,8`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape clusterLightData position=${pointLightPosition} position=${JSON.stringify(actual)} byteOffsets=0,4,8`,
  );
}

function assertPointLightIntensityTape(floats) {
  const actual = floats[4];
  const expected = Number.parseFloat(pointLightIntensity);
  if (
    Math.abs(actual - expected) > 1e-6 ||
    Math.abs(floats[5] - expected) > 1e-6 ||
    Math.abs(floats[6] - expected) > 1e-6
  ) {
    throw new Error(
      `capture tape Cluster light_data color*intensity=[${floats[4]},${floats[5]},${floats[6]}]; expected ${expected} at byte offset 16`,
    );
  }
  console.log(`${LOG_PREFIX} tape clusterLightData intensity=${actual} byteOffset=16`);
}

function assertPointLightRangeTape(floats) {
  const actual = floats[3];
  const range = Number.parseFloat(pointLightRange);
  const expected = 1 / (range * range);
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `capture tape Cluster light_data invRangeSquared=${actual}; expected ${expected} for range ${range} at byte offset 12`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape clusterLightData range=${range} invRangeSquared=${actual} byteOffset=12`,
  );
}

function assertPointLightColorTape(floats) {
  const expectedColor = pointLightColor === 'amber' ? [1.0, 0.8, 0.6] : [1.0, 0.85, 0.7];
  const expectedIntensity = 100;
  const actual = [floats[4], floats[5], floats[6]];
  const expected = expectedColor.map((value) => value * expectedIntensity);
  if (differs(actual, expected, 1e-5)) {
    throw new Error(
      `capture tape Cluster light_data colorTimesIntensity=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at byte offsets 16,20,24`,
    );
  }
  console.log(
    `${LOG_PREFIX} tape clusterLightData color=${pointLightColor} colorTimesIntensity=${JSON.stringify(actual)} byteOffsets=16,20,24`,
  );
}

function assertBasicLightingTape({ tape }) {
  const floats = readClusterLightFloats(tape);
  if (alphaCutoff !== '') {
    assertAlphaCutoffTape(tape);
  }
  if (alphaBlend !== '') {
    assertAlphaBlendTape(tape);
  }
  if (materialUploadFalsified) {
    assertMaterialUploadTape(tape);
  }
  if (pointLightPosition !== '') {
    assertPointLightPositionTape(floats);
  }
  if (pointLightIntensity !== '') {
    assertPointLightIntensityTape(floats);
  }
  if (pointLightRange !== '') {
    assertPointLightRangeTape(floats);
  }
  if (pointLightColor !== '') {
    assertPointLightColorTape(floats);
  }
}

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-2-lighting-2-basic-lighting',
  label: 'learn-render 2.2 basic-lighting',
  mode: alphaCutoff === '' && alphaBlend === '' ? 'pixel' : 'structural',
  liveHook: '__captureBasicLighting',
  rtIdx: 0,
  appDir: dirname(here),
  assertTape:
    !materialUploadFalsified &&
    [pointLightIntensity, pointLightRange, pointLightColor, pointLightPosition, materialMetallicChannel, materialRoughnessChannel, alphaCutoff, alphaBlend].every((value) => value === '')
      ? undefined
      : assertBasicLightingTape,
});
