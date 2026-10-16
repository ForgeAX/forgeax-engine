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

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-2-lighting-2-basic-lighting',
  label: 'learn-render 2.2 basic-lighting',
  mode: alphaCutoff === '' && alphaBlend === '' ? 'pixel' : 'structural',
  liveHook: '__captureBasicLighting',
  rtIdx: 0,
  appDir: dirname(here),
  assertTape: pointLightIntensity === '' && pointLightRange === '' && pointLightColor === '' && pointLightPosition === '' && materialMetallic === '' && materialRoughness === '' && materialBaseColor === '' && materialBaseColorTexture === '' && materialBaseColorTextureSampler === '' && materialBaseColorTextureUvTransform === '' && materialBaseColorTextureUvSet === '' && materialMetallicRoughnessTexture === '' && materialMetallicRoughnessTextureSampler === '' && materialMetallicRoughnessTextureUvTransform === '' && materialMetallicRoughnessTextureUvSet === '' && materialMetallicChannel === '' && materialRoughnessChannel === '' && materialEmissive === '' && materialEmissiveIntensity === '' && materialEmissiveTexture === '' && materialEmissiveTextureSampler === '' && materialEmissiveTextureUvTransform === '' && materialEmissiveTextureUvSet === '' && materialClearcoat === '' && materialNormalScale === '' && materialNormalTexture === '' && materialNormalTextureUvSet === '' && materialNormalTextureSampler === '' && materialNormalTextureUvTransform === '' && materialNormalTextureMagFilter === '' && materialNormalTextureMinFilter === '' && materialNormalTextureMipmapFilter === '' && materialNormalTextureAddressModeU === '' && materialNormalTextureAddressModeV === '' && materialNormalTextureAddressModeW === '' && materialNormalTextureSamplerLodMinClamp === '' && materialNormalTextureSamplerLodMaxClamp === '' && materialNormalTextureSamplerMaxAnisotropy === '' && materialOcclusionStrength === '' && materialOcclusionTextureSampler === '' && materialOcclusionTextureUvTransform === '' && materialOcclusionTextureUvSet === '' && materialSpecularColor === '' && materialSpecularColorTexture === '' && materialSpecularColorTextureSampler === '' && materialSpecularColorTextureUvTransform === '' && materialSpecularColorTextureUvSet === '' && alphaCutoff === '' && alphaBlend === ''
    ? undefined
    : ({ tape }) => {
        const lightDataBuffer = tape.events.find(
          (event) =>
            event.kind === 'createBuffer' &&
            event.desc?.size === 20480 &&
            event.desc?.usage === 136,
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
        const floats = new Float32Array(data);
        if (alphaCutoff !== '') {
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
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
          const materialData = materialUpload === undefined
            ? undefined
            : tape.blobPool.get(materialUpload.dataHash);
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
            `[learn-render 2.2 basic-lighting] tape materialAlphaCutoff=${actual} materialUBO byteOffset=68 baseColorAlpha=0.25`,
          );
        }
        if (alphaBlend !== '') {
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
          const blendPipelineUse = tape.events.find(
            (event) =>
              event.kind === 'setPipeline' && event.pipelineHandleId === blendPipeline.handleId,
          );
          if (blendPipelineUse === undefined) {
            throw new Error('capture tape alpha blend pipeline was never selected for a draw');
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
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
          const materialData = materialUpload === undefined
            ? undefined
            : tape.blobPool.get(materialUpload.dataHash);
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
            `[learn-render 2.2 basic-lighting] tape materialAlphaBlend=${alphaBlend} baseColorAlpha=${baseColorAlpha} blend=src-alpha/one-minus-src-alpha depthWriteEnabled=false queue=3000`,
          );
        }
        if (materialMetallic !== '' || materialRoughness !== '' || materialBaseColor !== '' || materialBaseColorTexture !== '' || materialBaseColorTextureSampler !== '' || materialBaseColorTextureUvTransform !== '' || materialBaseColorTextureUvSet !== '' || materialMetallicRoughnessTexture !== '' || materialMetallicRoughnessTextureSampler !== '' || materialMetallicRoughnessTextureUvTransform !== '' || materialMetallicRoughnessTextureUvSet !== '' || materialEmissive !== '' || materialEmissiveIntensity !== '' || materialEmissiveTexture !== '' || materialEmissiveTextureSampler !== '' || materialEmissiveTextureUvTransform !== '' || materialEmissiveTextureUvSet !== '' || materialClearcoat !== '' || materialNormalScale !== '' || materialNormalTexture !== '' || materialNormalTextureUvSet !== '' || materialNormalTextureSampler !== '' || materialNormalTextureUvTransform !== '' || materialNormalTextureMagFilter !== '' || materialNormalTextureMinFilter !== '' || materialNormalTextureMipmapFilter !== '' || materialNormalTextureAddressModeU !== '' || materialNormalTextureAddressModeV !== '' || materialNormalTextureAddressModeW !== '' || materialNormalTextureSamplerLodMinClamp !== '' || materialNormalTextureSamplerLodMaxClamp !== '' || materialNormalTextureSamplerMaxAnisotropy !== '' || materialOcclusionStrength !== '' || materialOcclusionTextureSampler !== '' || materialOcclusionTextureUvTransform !== '' || materialOcclusionTextureUvSet !== '' || materialSpecularColor !== '' || materialSpecularColorTexture !== '' || materialSpecularColorTextureSampler !== '' || materialSpecularColorTextureUvTransform !== '' || materialSpecularColorTextureUvSet !== '') {
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
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
          const materialData = materialUpload === undefined ? undefined : tape.blobPool.get(materialUpload.dataHash);
          if (materialData === undefined || materialData.byteLength < 80) {
            throw new Error('capture tape is missing the 512-byte Standard PBR material upload');
          }
          const materialFloats = new Float32Array(materialData);
          if (materialEmissiveTextureUvTransform !== '') {
            const actual = Array.from(materialFloats.slice(56, 64));
            const expected = [0.25, 0.25, 0, 0, 0, 0, 1, 1];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape emissiveTexture coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 224..252`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialEmissiveTextureUvTransform=1 coordinates=${JSON.stringify(actual)} materialUBO byteOffsets=224,228,232,236,240,244,248,252`,
            );
          }
          if (materialEmissiveTextureUvSet !== '') {
            const actual = Array.from(materialFloats.slice(56, 64));
            const expected = [0, 0, 1, 1, 1, 0, 1, 1];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape emissiveTexture coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 224..252`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialEmissiveTextureUvSet=1 coordinates=${JSON.stringify(actual)} materialUBO byteOffsets=224,228,232,236,240,244,248,252`,
            );
          }
          if (materialBaseColor !== '') {
            const actual = [materialFloats[0], materialFloats[1], materialFloats[2], materialFloats[3]];
            const authored = materialBaseColor === 'warm' ? [1.0, 0.5, 0.31] : [0.2, 0.5, 1.0];
            const expected = [...authored.map(srgbToLinear), 1.0];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape material baseColor=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 0,4,8,12`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialBaseColor=${materialBaseColor} baseColor=${JSON.stringify(actual)} materialUBO byteOffsets=0,4,8,12`,
            );
          }
          if (materialBaseColorTexture !== '') {
            const expectedBytes = [0, 64, 255, 255];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 1 ||
                event.desc?.size?.height !== 1
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the blue 1x1 baseColorTexture initialData payload',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 1 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 2 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed baseColorTexture bindings at 1/2',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialBaseColorTexture=blue payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=baseColorTexture bindings=1/2`,
            );
          }
          if (materialBaseColorTextureSampler !== '') {
            const expectedBytes = [
              0, 64, 255, 255,
              255, 255, 255, 255,
              255, 255, 255, 255,
              0, 64, 255, 255,
            ];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 2 ||
                event.desc?.size?.height !== 2
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the 2x2 baseColorTexture sampler checker initialData payload',
              );
            }
            const sampler = tape.events.find(
              (event) =>
                event.kind === 'createSampler' &&
                event.desc?.magFilter === 'nearest' &&
                event.desc?.minFilter === 'nearest' &&
                event.desc?.mipmapFilter === 'nearest' &&
                event.desc?.addressModeU === 'clamp-to-edge' &&
                event.desc?.addressModeV === 'clamp-to-edge' &&
                event.desc?.addressModeW === 'clamp-to-edge',
            );
            if (sampler === undefined) {
              throw new Error(
                'capture tape is missing the baseColorTexture sampler nearest/clamp-to-edge descriptor',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 1 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 2 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId) &&
                event.resourceHandleIds.includes(sampler.handleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed baseColorTexture sampler bindings at 1/2',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialBaseColorTextureSampler=nearest payload=${JSON.stringify(expectedBytes)} colorSpace=linear sampler=nearest/clamp-to-edge engineManagedRegion=baseColorTexture bindings=1/2`,
            );
          }
          if (materialBaseColorTextureUvTransform !== '') {
            const actual = Array.from(materialFloats.slice(24, 32));
            const expected = [0.25, 0.25, 0, 0, 0, 0, 1, 1];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape baseColorTexture coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 384..412`,
              );
            }
            const expectedBytes = [
              0, 64, 255, 255,
              255, 255, 255, 255,
              255, 255, 255, 255,
              0, 64, 255, 255,
            ];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 2 ||
                event.desc?.size?.height !== 2
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the 2x2 baseColorTexture UV-transform checker initialData payload',
              );
            }
            const sampler = tape.events.find(
              (event) =>
                event.kind === 'createSampler' &&
                event.desc?.magFilter === 'nearest' &&
                event.desc?.minFilter === 'nearest' &&
                event.desc?.mipmapFilter === 'nearest' &&
                event.desc?.addressModeU === 'clamp-to-edge' &&
                event.desc?.addressModeV === 'clamp-to-edge' &&
                event.desc?.addressModeW === 'clamp-to-edge',
            );
            if (sampler === undefined) {
              throw new Error(
                'capture tape is missing the baseColorTexture UV-transform nearest/clamp-to-edge sampler descriptor',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 1 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 2 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId) &&
                event.resourceHandleIds.includes(sampler.handleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed baseColorTexture UV-transform bindings at 1/2',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialBaseColorTextureUvTransform=1 coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(expectedBytes)} colorSpace=linear sampler=nearest/clamp-to-edge engineManagedRegion=baseColorTexture bindings=1/2 materialUBO byteOffsets=384,388,392,396,400,404,408,412`,
            );
          }
          if (materialBaseColorTextureUvSet !== '') {
            const actual = Array.from(materialFloats.slice(24, 32));
            const expected = [0, 0, 1, 1, 1, 0, 1, 1];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape baseColorTexture coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 384..412`,
              );
            }
            const expectedBytes = [
              0, 64, 255, 255,
              255, 255, 255, 255,
              255, 255, 255, 255,
              0, 64, 255, 255,
            ];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 2 ||
                event.desc?.size?.height !== 2
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the 2x2 baseColorTexture UV-set checker initialData payload',
              );
            }
            const sampler = tape.events.find(
              (event) =>
                event.kind === 'createSampler' &&
                event.desc?.magFilter === 'nearest' &&
                event.desc?.minFilter === 'nearest' &&
                event.desc?.mipmapFilter === 'nearest' &&
                event.desc?.addressModeU === 'clamp-to-edge' &&
                event.desc?.addressModeV === 'clamp-to-edge' &&
                event.desc?.addressModeW === 'clamp-to-edge',
            );
            if (sampler === undefined) {
              throw new Error(
                'capture tape is missing the baseColorTexture UV-set nearest/clamp-to-edge sampler descriptor',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 1 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 2 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId) &&
                event.resourceHandleIds.includes(sampler.handleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed baseColorTexture UV-set bindings at 1/2',
              );
            }
            const uv1Pipeline = tape.events.find(
              (event) =>
                event.kind === 'createRenderPipeline' &&
                event.desc?.vertex?.buffers?.some(
                  (buffer) =>
                    buffer.arrayStride === 56 &&
                    buffer.attributes?.some(
                      (attribute) => attribute.shaderLocation === 6 && attribute.offset === 48,
                    ),
                ),
            );
            if (uv1Pipeline === undefined) {
              throw new Error(
                'capture tape is missing the 56-byte real UV1 vertex layout at shader location 6 offset 48',
              );
            }
            const uv1Buffer = tape.events.find(
              (event) => event.kind === 'createBuffer' && event.desc?.size === 1344,
            );
            const uv1Seed = uv1Buffer === undefined
              ? undefined
              : tape.events.find(
                  (event) => event.kind === 'initialData' && event.handleId === uv1Buffer.handleId,
                );
            const uv1Data = uv1Seed === undefined ? undefined : tape.blobPool.get(uv1Seed.dataHash);
            const uv1Floats = uv1Data === undefined ? undefined : new Float32Array(uv1Data);
            if (
              uv1Floats === undefined ||
              uv1Floats.length !== 24 * 14 ||
              Array.from({ length: 24 }, (_, index) => {
                const offset = index * 14 + 12;
                return uv1Floats[offset] === 0.25 && uv1Floats[offset + 1] === 0.25;
              }).some((value) => !value)
            ) {
              throw new Error(
                'capture tape is missing the producer-owned UV1=[0.25,0.25] bytes in the 14-float mesh stride',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialBaseColorTextureUvSet=1 coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(expectedBytes)} sampler=nearest/clamp-to-edge engineManagedRegion=baseColorTexture bindings=1/2 vertexStride=56 uv1Location=6 uv1Offset=48 uv1=[0.25,0.25] materialUBO byteOffsets=384,388,392,396,400,404,408,412`,
            );
          }
          if (materialMetallicChannel !== '') {
            const materialChannels = [materialFloats[4], materialFloats[6], materialFloats[7]];
            const expectedChannels = [0.5, 0, 1];
            if (materialChannels.some((value, index) => Math.abs(value - expectedChannels[index]) > 1e-6)) {
              throw new Error(
                `capture tape metallicChannel material=${JSON.stringify(materialChannels)}; expected metallic=0.5, metallicChannel=0, roughnessChannel=1 at global byte offsets 16,24,28`,
              );
            }
            const expectedBytes = [255, 255, 0, 255];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 1 ||
                event.desc?.size?.height !== 1
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the red 1x1 metallicChannel initialData payload',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 3 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 4 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed metallicChannel texture bindings at 3/4',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialMetallicChannel=${materialMetallicChannel} payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO metallic=0.5 metallicChannel=red roughnessChannel=green byteOffsets=16,24,28`,
            );
          }
          if (materialRoughnessChannel !== '') {
            const materialChannels = [materialFloats[4], materialFloats[6], materialFloats[7]];
            const expectedChannels = [0.5, 2, 2];
            if (materialChannels.some((value, index) => Math.abs(value - expectedChannels[index]) > 1e-6)) {
              throw new Error(
                `capture tape roughnessChannel material=${JSON.stringify(materialChannels)}; expected metallic=0.5, metallicChannel=2, roughnessChannel=2 at global byte offsets 16,24,28`,
              );
            }
            const expectedBytes = [0, 0, 255, 255];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 1 ||
                event.desc?.size?.height !== 1
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the blue 1x1 roughnessChannel initialData payload',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 3 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 4 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed roughnessChannel texture bindings at 3/4',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialRoughnessChannel=${materialRoughnessChannel} payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO metallic=0.5 metallicChannel=blue roughnessChannel=blue byteOffsets=16,24,28`,
            );
          }
          if (materialMetallicRoughnessTexture !== '') {
            const materialChannels = [materialFloats[4], materialFloats[6], materialFloats[7]];
            const expectedChannels = [0.5, 2, 1];
            if (materialChannels.some((value, index) => Math.abs(value - expectedChannels[index]) > 1e-6)) {
              throw new Error(
                `capture tape metallicRoughness material=${JSON.stringify(materialChannels)}; expected metallic=0.5, metallicChannel=2, roughnessChannel=1 at global byte offsets 16,24,28`,
              );
            }
            const expectedBytes = [0, 0, 255, 255];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 1 ||
                event.desc?.size?.height !== 1
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the blue 1x1 metallicRoughnessTexture initialData payload',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 3 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 4 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed metallicRoughnessTexture bindings at 3/4',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialMetallicRoughnessTexture=blue payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO metallic=0.5 metallicChannel=blue roughnessChannel=green byteOffsets=16,24,28`,
            );
          }
          if (materialMetallicRoughnessTextureSampler !== '') {
            const materialChannels = [materialFloats[4], materialFloats[6], materialFloats[7]];
            const expectedChannels = [0.5, 2, 1];
            if (materialChannels.some((value, index) => Math.abs(value - expectedChannels[index]) > 1e-6)) {
              throw new Error(
                `capture tape metallicRoughness sampler material=${JSON.stringify(materialChannels)}; expected metallic=0.5, metallicChannel=2, roughnessChannel=1 at global byte offsets 16,24,28`,
              );
            }
            const expectedBytes = [
              0, 0, 255, 255,
              0, 255, 0, 255,
              0, 255, 0, 255,
              0, 0, 255, 255,
            ];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 2 ||
                event.desc?.size?.height !== 2
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the 2x2 metallicRoughnessTexture checker initialData payload',
              );
            }
            const sampler = tape.events.find(
              (event) =>
                event.kind === 'createSampler' &&
                event.desc?.magFilter === 'nearest' &&
                event.desc?.minFilter === 'nearest' &&
                event.desc?.mipmapFilter === 'nearest' &&
                event.desc?.addressModeU === 'clamp-to-edge' &&
                event.desc?.addressModeV === 'clamp-to-edge' &&
                event.desc?.addressModeW === 'clamp-to-edge',
            );
            if (sampler === undefined) {
              throw new Error(
                'capture tape is missing the metallicRoughnessTexture nearest/clamp-to-edge sampler descriptor',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 3 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 4 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId) &&
                event.resourceHandleIds.includes(sampler.handleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed metallicRoughnessTexture sampler/texture bindings at 3/4',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialMetallicRoughnessTextureSampler=nearest payload=${JSON.stringify(expectedBytes)} colorSpace=linear sampler=nearest/clamp-to-edge engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO metallic=0.5 metallicChannel=blue roughnessChannel=green byteOffsets=16,24,28`,
            );
          }
          if (materialMetallicRoughnessTextureUvTransform !== '') {
            const actual = Array.from(materialFloats.slice(32, 40));
            const expected = [0.75, 0.25, 0, 0, 0, 0, 1, 1];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape metallicRoughnessTexture coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 128..156`,
              );
            }
            const expectedBytes = [
              0, 0, 255, 255,
              0, 255, 0, 255,
              0, 255, 0, 255,
              0, 0, 255, 255,
            ];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 2 ||
                event.desc?.size?.height !== 2
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the 2x2 metallicRoughnessTexture transform checker initialData payload',
              );
            }
            const sampler = tape.events.find(
              (event) =>
                event.kind === 'createSampler' &&
                event.desc?.magFilter === 'nearest' &&
                event.desc?.minFilter === 'nearest' &&
                event.desc?.mipmapFilter === 'nearest' &&
                event.desc?.addressModeU === 'clamp-to-edge' &&
                event.desc?.addressModeV === 'clamp-to-edge' &&
                event.desc?.addressModeW === 'clamp-to-edge',
            );
            if (sampler === undefined) {
              throw new Error(
                'capture tape is missing the metallicRoughnessTexture transform nearest/clamp-to-edge sampler descriptor',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 3 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 4 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId) &&
                event.resourceHandleIds.includes(sampler.handleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed metallicRoughnessTexture transform bindings at 3/4',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialMetallicRoughnessTextureUvTransform=1 coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(expectedBytes)} colorSpace=linear sampler=nearest/clamp-to-edge engineManagedRegion=metallicRoughnessTexture bindings=3/4 materialUBO byteOffsets=128,132,136,140,144,148,152,156`,
            );
          }
          if (materialMetallicRoughnessTextureUvSet !== '') {
            const actual = Array.from(materialFloats.slice(32, 40));
            const expected = [0, 0, 1, 1, 1, 0, 1, 1];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape metallicRoughnessTexture coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 128..156`,
              );
            }
            const expectedBytes = [
              0, 0, 255, 255,
              0, 255, 0, 255,
              0, 255, 0, 255,
              0, 0, 255, 255,
            ];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== 2 ||
                event.desc?.size?.height !== 2
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the 2x2 metallicRoughnessTexture UV-set checker initialData payload',
              );
            }
            const sampler = tape.events.find(
              (event) =>
                event.kind === 'createSampler' &&
                event.desc?.magFilter === 'nearest' &&
                event.desc?.minFilter === 'nearest' &&
                event.desc?.mipmapFilter === 'nearest' &&
                event.desc?.addressModeU === 'clamp-to-edge' &&
                event.desc?.addressModeV === 'clamp-to-edge' &&
                event.desc?.addressModeW === 'clamp-to-edge',
            );
            if (sampler === undefined) {
              throw new Error(
                'capture tape is missing the metallicRoughnessTexture UV-set nearest/clamp-to-edge sampler descriptor',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 3 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 4 && entry.resourceKind === 'textureView') &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId) &&
                event.resourceHandleIds.includes(sampler.handleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed metallicRoughnessTexture UV-set bindings at 3/4',
              );
            }
            const uv1Pipeline = tape.events.find(
              (event) =>
                event.kind === 'createRenderPipeline' &&
                event.desc?.vertex?.buffers?.some(
                  (buffer) =>
                    buffer.arrayStride === 56 &&
                    buffer.attributes?.some(
                      (attribute) => attribute.shaderLocation === 6 && attribute.offset === 48,
                    ),
                ),
            );
            if (uv1Pipeline === undefined) {
              throw new Error(
                'capture tape is missing the 56-byte real UV1 vertex layout at shader location 6 offset 48',
              );
            }
            const uv1Buffer = tape.events.find(
              (event) => event.kind === 'createBuffer' && event.desc?.size === 1344,
            );
            const uv1Seed = uv1Buffer === undefined
              ? undefined
              : tape.events.find(
                  (event) =>
                    event.kind === 'initialData' && event.handleId === uv1Buffer.handleId,
                );
            const uv1Data = uv1Seed === undefined ? undefined : tape.blobPool.get(uv1Seed.dataHash);
            const uv1Floats = uv1Data === undefined ? undefined : new Float32Array(uv1Data);
            if (
              uv1Floats === undefined ||
              uv1Floats.length !== 24 * 14 ||
              Array.from({ length: 24 }, (_, index) => {
                const offset = index * 14 + 12;
                return uv1Floats[offset] === 0.75 && uv1Floats[offset + 1] === 0.25;
              }).some((value) => !value)
            ) {
              throw new Error(
                'capture tape is missing the producer-owned UV1=[0.75,0.25] bytes in the 14-float mesh stride',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialMetallicRoughnessTextureUvSet=1 coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(expectedBytes)} sampler=nearest/clamp-to-edge engineManagedRegion=metallicRoughnessTexture bindings=3/4 vertexStride=56 uv1Location=6 uv1Offset=48 uv1=[0.75,0.25] materialUBO byteOffsets=128,132,136,140,144,148,152,156`,
            );
          }
          if (materialMetallic !== '') {
            const actual = materialFloats[4];
            const expected = materialMetallic === 'dielectric' ? 0.0 : 1.0;
            if (Math.abs(actual - expected) > 1e-6) {
              throw new Error(
                `capture tape material metallic=${actual}; expected ${expected} at global byte offset 16`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialMetallic=${materialMetallic} metallic=${actual} materialUBO byteOffset=16`,
            );
          }
          if (materialRoughness !== '') {
            const actual = materialFloats[5];
            const expected = materialRoughness === 'smooth' ? 0.2 : 0.8;
            if (Math.abs(actual - expected) > 1e-6) {
              throw new Error(
                `capture tape material roughness=${actual}; expected ${expected} at global byte offset 20`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialRoughness=${materialRoughness} roughness=${actual} materialUBO byteOffset=20`,
            );
          }
          if (materialEmissive !== '') {
            const actual = [materialFloats[12], materialFloats[13], materialFloats[14]];
            const authored = materialEmissive === 'red' ? [1.0, 0.05, 0.02] : [0.02, 0.2, 1.0];
            const expected = authored.map(srgbToLinear);
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape material emissive=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 48,52,56`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialEmissive=${materialEmissive} emissive=${JSON.stringify(actual)} materialUBO byteOffsets=48,52,56 emissiveIntensity=${materialFloats[15]}`,
            );
          }
          if (materialEmissiveIntensity !== '') {
            const emissive = [materialFloats[12], materialFloats[13], materialFloats[14]];
            const expectedEmissive = [1.0, 0.05, 0.02].map(srgbToLinear);
            if (emissive.some((value, index) => Math.abs(value - expectedEmissive[index]) > 1e-6)) {
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
              `[learn-render 2.2 basic-lighting] tape materialEmissiveIntensity=${materialEmissiveIntensity} emissiveIntensity=${actual} materialUBO byteOffset=60 emissive=${JSON.stringify(emissive)}`,
            );
          }
          if (materialClearcoat !== '') {
            const actual = [materialFloats[18], materialFloats[19]];
            const expected = [1.0, 0.05];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape material clearcoat=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 72,76`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialClearcoat=${materialClearcoat} clearcoat=${actual[0]} clearcoatRoughness=${actual[1]} materialUBO byteOffsets=72,76`,
            );
          }
          if (materialNormalScale !== '') {
            const actual = Array.from(materialFloats.slice(24, 26));
            const expected = [0.0, 0.0];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape material normalScale=${actual}; expected ${expected} at global byte offsets 96,100`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialNormalScale=${materialNormalScale} normalScale=${actual} materialUBO byteOffsets=96,100 texture=rg-normal`,
            );
          }
          if (materialNormalTexture !== '' || materialNormalTextureUvSet !== '' || materialNormalTextureSampler !== '' || materialNormalTextureUvTransform !== '' || materialNormalTextureMagFilter !== '' || materialNormalTextureMinFilter !== '' || materialNormalTextureMipmapFilter !== '' || materialNormalTextureAddressModeU !== '' || materialNormalTextureAddressModeV !== '' || materialNormalTextureAddressModeW !== '' || materialNormalTextureSamplerLodMinClamp !== '' || materialNormalTextureSamplerLodMaxClamp !== '' || materialNormalTextureSamplerMaxAnisotropy !== '') {
            const actual = Array.from(materialFloats.slice(40, 48));
            const expected = materialNormalTextureUvTransform !== ''
              ? [0.25, 0.25, 0, 0, 0, 0, 1, 1]
              : materialNormalTextureUvSet === ''
              ? [0, 0, 1, 1, 0, 0, 1, 1]
              : [0, 0, 1, 1, 1, 0, 1, 1];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape normalTexture coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 160..188`,
              );
            }
            const expectedBytes = materialNormalTexture === 'tilt'
              ? [128, 255, 128, 255]
              : [
                  255, 128, 255, 255,
                  128, 255, 128, 255,
                  128, 128, 255, 255,
                  255, 255, 128, 255,
                ];
            const expectedWidth = materialNormalTexture === 'tilt' ? 1 : 2;
            const expectedHeight = materialNormalTexture === 'tilt' ? 1 : 2;
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== expectedWidth ||
                event.desc?.size?.height !== expectedHeight
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(`capture tape is missing the ${expectedWidth}x${expectedHeight} linear normalTexture initialData payload`);
            }
            const sampler = materialNormalTexture === '' && materialNormalTextureSampler === '' && materialNormalTextureUvTransform === '' && materialNormalTextureMagFilter === '' && materialNormalTextureMinFilter === '' && materialNormalTextureMipmapFilter === '' && materialNormalTextureAddressModeU === '' && materialNormalTextureAddressModeV === '' && materialNormalTextureAddressModeW === '' && materialNormalTextureSamplerLodMinClamp === '' && materialNormalTextureSamplerLodMaxClamp === '' && materialNormalTextureSamplerMaxAnisotropy === ''
              ? undefined
              : tape.events.find(
                  (event) =>
                    event.kind === 'createSampler' &&
                    event.desc?.magFilter === (materialNormalTextureSamplerMaxAnisotropy !== '' || materialNormalTextureMagFilter === 'linear' ? 'linear' : 'nearest') &&
                    event.desc?.minFilter === (materialNormalTextureSamplerMaxAnisotropy !== '' || materialNormalTextureMinFilter === 'linear' ? 'linear' : 'nearest') &&
                    event.desc?.mipmapFilter === (materialNormalTextureSamplerMaxAnisotropy !== '' || materialNormalTextureMipmapFilter === 'linear' ? 'linear' : 'nearest') &&
                    event.desc?.addressModeU === (materialNormalTextureAddressModeU === 'repeat' ? 'repeat' : 'clamp-to-edge') &&
                    event.desc?.addressModeV === (materialNormalTextureAddressModeV === 'repeat' ? 'repeat' : 'clamp-to-edge') &&
                    event.desc?.addressModeW === (materialNormalTextureAddressModeW === 'repeat' ? 'repeat' : 'clamp-to-edge') &&
                    (materialNormalTextureSamplerLodMinClamp === '' || event.desc?.lodMinClamp === (materialNormalTextureSamplerLodMinClamp === '1' ? 1 : 0)) &&
                    (materialNormalTextureSamplerLodMinClamp === '' || event.desc?.lodMaxClamp === 1) &&
                    (materialNormalTextureSamplerLodMaxClamp === '' || event.desc?.lodMinClamp === 0) &&
                    (materialNormalTextureSamplerLodMaxClamp === '' || event.desc?.lodMaxClamp === (materialNormalTextureSamplerLodMaxClamp === '1' ? 1 : 0)) &&
                    (materialNormalTextureSamplerMaxAnisotropy === '' || event.desc?.maxAnisotropy === (materialNormalTextureSamplerMaxAnisotropy === '1' ? 16 : undefined)),
                );
            if ((materialNormalTexture !== '' || materialNormalTextureSampler !== '' || materialNormalTextureUvTransform !== '' || materialNormalTextureMagFilter !== '' || materialNormalTextureMinFilter !== '' || materialNormalTextureMipmapFilter !== '' || materialNormalTextureAddressModeU !== '' || materialNormalTextureAddressModeV !== '' || materialNormalTextureAddressModeW !== '' || materialNormalTextureSamplerLodMinClamp !== '' || materialNormalTextureSamplerLodMaxClamp !== '' || materialNormalTextureSamplerMaxAnisotropy !== '') && sampler === undefined) {
              throw new Error('capture tape is missing the normalTexture sampler descriptor');
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some((entry) => entry.binding === 5 && entry.resourceKind === 'sampler') &&
                event.entries.some((entry) => entry.binding === 6 && entry.resourceKind === 'textureView') &&
                (sampler === undefined || event.resourceHandleIds.includes(sampler.handleId)) &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId),
            );
            if (binding === undefined) {
              throw new Error('capture tape is missing the engine-managed normalTexture bindings at 5/6');
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialNormalTexture profile=${materialNormalTextureSamplerMaxAnisotropy !== '' ? 'max-anisotropy' : materialNormalTextureSamplerLodMaxClamp !== '' ? 'lod-max-clamp' : materialNormalTextureSamplerLodMinClamp !== '' ? 'lod-min-clamp' : materialNormalTextureAddressModeW !== '' ? 'address-mode-w' : materialNormalTextureAddressModeV !== '' ? 'address-mode-v' : materialNormalTextureAddressModeU !== '' ? 'address-mode-u' : materialNormalTextureMipmapFilter !== '' ? 'mipmap-filter' : materialNormalTextureMinFilter !== '' ? 'min-filter' : materialNormalTextureMagFilter !== '' ? 'mag-filter' : materialNormalTexture !== '' ? 'texture' : materialNormalTextureUvTransform !== '' ? 'uv-transform' : materialNormalTextureSampler !== '' ? 'sampler' : 'uv-set'} sampler=${materialNormalTextureMagFilter || materialNormalTextureSampler || 'nearest'} minFilter=${materialNormalTextureMinFilter || 'nearest'} mipmapFilter=${materialNormalTextureMipmapFilter || 'nearest'} addressModeU=clamp-to-edge addressModeV=${materialNormalTextureAddressModeV || 'clamp-to-edge'} addressModeW=${materialNormalTextureAddressModeW || 'clamp-to-edge'} lodMinClamp=${materialNormalTextureSamplerMaxAnisotropy !== '' ? '0' : materialNormalTextureSamplerLodMaxClamp !== '' ? '0' : materialNormalTextureSamplerLodMinClamp === '' ? 'default' : materialNormalTextureSamplerLodMinClamp} lodMaxClamp=${materialNormalTextureSamplerMaxAnisotropy !== '' ? '1' : materialNormalTextureSamplerLodMaxClamp !== '' ? materialNormalTextureSamplerLodMaxClamp : materialNormalTextureSamplerLodMinClamp === '' ? 'default' : '1'} maxAnisotropy=${materialNormalTextureSamplerMaxAnisotropy === '' ? 'default' : materialNormalTextureSamplerMaxAnisotropy === '1' ? '16' : '1'} coordinates=${JSON.stringify(actual)} payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=normalTexture bindings=5/6 materialUBO byteOffsets=160,164,168,172,176,180,184,188`,
            );
          }
          if (
            materialOcclusionStrength !== '' ||
            materialOcclusionTextureSampler !== '' ||
            materialOcclusionTextureUvTransform !== '' ||
            materialOcclusionTextureUvSet !== ''
          ) {
            const actual = materialFloats[16];
            const expectedStrength = materialOcclusionStrength === '' ? 1 : 0;
            if (Math.abs(actual - expectedStrength) > 1e-6) {
              throw new Error(
                `capture tape material occlusionStrength=${actual}; expected ${expectedStrength} at global byte offset 64`,
              );
            }
            const texture = tape.events
              .filter(
                (event) =>
                  event.kind === 'createTexture' &&
                  event.desc?.format === 'rgba8unorm' &&
                  event.desc?.size?.width === 1 &&
                  event.desc?.size?.height === 1 &&
                  event.desc?.usage === 23,
              )
              .find((event) => {
                const seed = tape.events.find(
                  (candidate) =>
                    candidate.kind === 'initialData' && candidate.handleId === event.handleId,
                );
                const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
                const bytes = data === undefined ? undefined : new Uint8Array(data);
                return (
                  bytes !== undefined &&
                  bytes.length === 4 &&
                  bytes.every((value, index) => value === (index === 3 ? 255 : 0))
                );
              });
            const seed = texture === undefined
              ? undefined
              : tape.events.find(
                  (event) => event.kind === 'initialData' && event.handleId === texture.handleId,
                );
            const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
            const bytes = data === undefined ? undefined : new Uint8Array(data);
            if (
              bytes === undefined ||
              bytes.length !== 4 ||
              bytes.some((value, index) => value !== (index === 3 ? 255 : 0))
            ) {
              throw new Error('capture tape is missing the 1x1 black linear occlusion texture payload');
            }
            if (
              materialOcclusionTextureSampler !== '' ||
              materialOcclusionTextureUvTransform !== '' ||
              materialOcclusionTextureUvSet !== ''
            ) {
              const sampler = tape.events.find(
                (event) =>
                  event.kind === 'createSampler' &&
                  event.desc?.magFilter === 'nearest' &&
                  event.desc?.minFilter === 'nearest' &&
                  event.desc?.mipmapFilter === 'nearest' &&
                  event.desc?.addressModeU === 'clamp-to-edge' &&
                  event.desc?.addressModeV === 'clamp-to-edge' &&
                  event.desc?.addressModeW === 'clamp-to-edge',
              );
              if (sampler === undefined) {
                throw new Error(
                  'capture tape is missing the occlusionTexture sampler nearest/clamp-to-edge descriptor',
                );
              }
              const view = tape.events.find(
                (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
              );
              const binding = tape.events.find(
                (event) =>
                  event.kind === 'createBindGroup' &&
                  event.entries.some(
                    (entry) => entry.binding === 18 && entry.resourceKind === 'sampler',
                  ) &&
                  event.entries.some(
                    (entry) => entry.binding === 19 && entry.resourceKind === 'textureView',
                  ) &&
                  view !== undefined &&
                  event.resourceHandleIds.includes(view.resultHandleId) &&
                  event.resourceHandleIds.includes(sampler.handleId),
              );
              if (binding === undefined) {
                throw new Error(
                  'capture tape is missing the engine-managed occlusionTexture bindings at 18/19',
                );
              }
              if (materialOcclusionTextureUvSet !== '') {
                const coordinates = Array.from(materialFloats.slice(64, 72));
                const expectedCoordinates = [0, 0, 1, 1, 1, 0, 1, 1];
                if (
                  coordinates.some(
                    (value, index) => Math.abs(value - expectedCoordinates[index]) > 1e-6,
                  )
                ) {
                  throw new Error(
                    `capture tape occlusionTexture coordinates=${JSON.stringify(coordinates)}; expected ${JSON.stringify(expectedCoordinates)} at global byte offsets 256..284`,
                  );
                }
                const uv1Pipeline = tape.events.find(
                  (event) =>
                    event.kind === 'createRenderPipeline' &&
                    event.desc?.vertex?.buffers?.some(
                      (buffer) =>
                        buffer.arrayStride === 56 &&
                        buffer.attributes?.some(
                          (attribute) => attribute.shaderLocation === 6 && attribute.offset === 48,
                        ),
                    ),
                );
                if (uv1Pipeline === undefined) {
                  throw new Error(
                    'capture tape is missing the 56-byte real UV1 vertex layout at shader location 6 offset 48',
                  );
                }
                const uv1Buffer = tape.events.find(
                  (event) => event.kind === 'createBuffer' && event.desc?.size === 1344,
                );
                const uv1Seed = uv1Buffer === undefined
                  ? undefined
                  : tape.events.find(
                      (event) => event.kind === 'initialData' && event.handleId === uv1Buffer.handleId,
                    );
                const uv1Data = uv1Seed === undefined ? undefined : tape.blobPool.get(uv1Seed.dataHash);
                const uv1Floats = uv1Data === undefined ? undefined : new Float32Array(uv1Data);
                if (
                  uv1Floats === undefined ||
                  uv1Floats.length !== 24 * 14 ||
                  Array.from({ length: 24 }, (_, index) => {
                    const offset = index * 14 + 12;
                    return uv1Floats[offset] === 0.75 && uv1Floats[offset + 1] === 0.75;
                  }).some((value) => !value)
                ) {
                  throw new Error(
                    'capture tape is missing the producer-owned UV1=[0.75,0.75] bytes in the 14-float mesh stride',
                  );
                }
                console.log(
                  `[learn-render 2.2 basic-lighting] tape materialOcclusionTextureUvSet=1 coordinates=${JSON.stringify(coordinates)} occlusionStrength=${actual} texture=rgba8unorm 1x1 black sampler=nearest/clamp-to-edge engineManagedRegion=occlusionTexture bindings=18/19 vertexStride=56 uv1Location=6 uv1Offset=48 uv1=[0.75,0.75] materialUBO byteOffsets=256,260,264,268,272,276,280,284`,
                );
              } else if (materialOcclusionTextureUvTransform !== '') {
                const coordinates = Array.from(materialFloats.slice(64, 72));
                const expectedCoordinates = [0.25, 0.25, 0, 0, 0, 0, 1, 1];
                if (
                  coordinates.some(
                    (value, index) => Math.abs(value - expectedCoordinates[index]) > 1e-6,
                  )
                ) {
                  throw new Error(
                    `capture tape occlusionTexture coordinates=${JSON.stringify(coordinates)}; expected ${JSON.stringify(expectedCoordinates)} at global byte offsets 256..284`,
                  );
                }
                console.log(
                  `[learn-render 2.2 basic-lighting] tape materialOcclusionTextureUvTransform=1 coordinates=${JSON.stringify(coordinates)} occlusionStrength=${actual} texture=rgba8unorm 1x1 black sampler=nearest/clamp-to-edge engineManagedRegion=occlusionTexture bindings=18/19 materialUBO byteOffsets=256,260,264,268,272,276,280,284`,
                );
              } else {
                console.log(
                  `[learn-render 2.2 basic-lighting] tape materialOcclusionTextureSampler=nearest occlusionStrength=${actual} texture=rgba8unorm 1x1 black sampler=nearest/clamp-to-edge engineManagedRegion=occlusionTexture bindings=18/19 materialUBO byteOffset=64`,
                );
              }
            } else {
              console.log(
                `[learn-render 2.2 basic-lighting] tape materialOcclusionStrength=zero occlusionStrength=${actual} materialUBO byteOffset=64 texture=rgba8unorm 1x1 black`,
              );
            }
          }
          if (materialSpecularColor !== '') {
            const actual = [materialFloats[20], materialFloats[21], materialFloats[22]];
            const expected = [0.0, srgbToLinear(0.8), 1.0];
            if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
              throw new Error(
                `capture tape material specularColor=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 80,84,88`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialSpecularColor=cool specularColor=${JSON.stringify(actual)} materialUBO byteOffsets=80,84,88`,
            );
          }
          if (
            materialSpecularColorTexture !== '' ||
            materialSpecularColorTextureSampler !== '' ||
            materialSpecularColorTextureUvTransform !== '' ||
            materialSpecularColorTextureUvSet !== ''
          ) {
            const expectedBytes = materialSpecularColorTextureUvTransform === '' && materialSpecularColorTextureUvSet === ''
              ? [0, 64, 255, 255]
              : [
                  0, 64, 255, 255,
                  0, 0, 0, 255,
                  0, 0, 0, 255,
                  0, 0, 0, 255,
                ];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== (materialSpecularColorTextureUvTransform === '' && materialSpecularColorTextureUvSet === '' ? 1 : 2) ||
                event.desc?.size?.height !== (materialSpecularColorTextureUvTransform === '' && materialSpecularColorTextureUvSet === '' ? 1 : 2)
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return (
                bytes !== undefined &&
                bytes.length === expectedBytes.length &&
                bytes.every((value, index) => value === expectedBytes[index])
              );
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the expected specularColorTexture initialData payload',
              );
            }
            const sampler = tape.events.find(
              (event) =>
                event.kind === 'createSampler' &&
                event.desc?.magFilter === 'nearest' &&
                event.desc?.minFilter === 'nearest' &&
                event.desc?.mipmapFilter === 'nearest' &&
                event.desc?.addressModeU === 'clamp-to-edge' &&
                event.desc?.addressModeV === 'clamp-to-edge' &&
                event.desc?.addressModeW === 'clamp-to-edge',
            );
            if (sampler === undefined) {
              throw new Error(
                'capture tape is missing the specularColorTexture sampler nearest/clamp-to-edge descriptor',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some(
                  (entry) => entry.binding === 7 && entry.resourceKind === 'sampler',
                ) &&
                event.entries.some(
                  (entry) => entry.binding === 8 && entry.resourceKind === 'textureView',
                ) &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId) &&
                event.resourceHandleIds.includes(sampler.handleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the specularColorTexture user-region bindings at 7/8',
              );
            }
            if (materialSpecularColorTextureUvTransform !== '') {
              const actual = Array.from(materialFloats.slice(48, 56));
              const expected = [0.25, 0.25, 0, 0, 0, 0, 1, 1];
              if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
                throw new Error(
                  `capture tape specularColorTexture coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 192..220`,
                );
              }
              console.log(
                `[learn-render 2.2 basic-lighting] tape materialSpecularColorTextureUvTransform=1 coordinates=${JSON.stringify(actual)} materialUBO byteOffsets=192,196,200,204,208,212,216,220`,
              );
            } else if (materialSpecularColorTextureUvSet !== '') {
              const actual = Array.from(materialFloats.slice(48, 56));
              const expected = [0, 0, 1, 1, 1, 0, 1, 1];
              if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
                throw new Error(
                  `capture tape specularColorTexture coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at global byte offsets 192..220`,
                );
              }
              const uv1Pipeline = tape.events.find(
                (event) =>
                  event.kind === 'createRenderPipeline' &&
                  event.desc?.vertex?.buffers?.some(
                    (buffer) =>
                      buffer.arrayStride === 56 &&
                      buffer.attributes?.some(
                        (attribute) => attribute.shaderLocation === 6 && attribute.offset === 48,
                      ),
                  ),
              );
              if (uv1Pipeline === undefined) {
                throw new Error(
                  'capture tape is missing the 56-byte real UV1 vertex layout at shader location 6 offset 48',
                );
              }
              const uv1Buffer = tape.events.find(
                (event) => event.kind === 'createBuffer' && event.desc?.size === 1344,
              );
              const uv1Seed = uv1Buffer === undefined
                ? undefined
                : tape.events.find(
                    (event) => event.kind === 'initialData' && event.handleId === uv1Buffer.handleId,
                  );
              const uv1Data = uv1Seed === undefined ? undefined : tape.blobPool.get(uv1Seed.dataHash);
              const uv1Floats = uv1Data === undefined ? undefined : new Float32Array(uv1Data);
              if (
                uv1Floats === undefined ||
                uv1Floats.length !== 24 * 14 ||
                Array.from({ length: 24 }, (_, index) => {
                  const offset = index * 14 + 12;
                  return uv1Floats[offset] === 0.75 && uv1Floats[offset + 1] === 0.75;
                }).some((value) => !value)
              ) {
                throw new Error(
                  'capture tape is missing the producer-owned UV1=[0.75,0.75] bytes in the 14-float mesh stride',
                );
              }
              console.log(
                `[learn-render 2.2 basic-lighting] tape materialSpecularColorTextureUvSet=1 coordinates=${JSON.stringify(actual)} materialUBO byteOffsets=192,196,200,204,208,212,216,220 texture=rgba8unorm 2x2 sampler=nearest/clamp-to-edge userRegion=specularColorTexture bindings=7/8 vertexStride=56 uv1Location=6 uv1Offset=48 uv1=[0.75,0.75]`,
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialSpecularColorTexture=${materialSpecularColorTexture === '' ? 'default' : 'blue'} sampler=nearest payload=${JSON.stringify(expectedBytes)} colorSpace=linear sampler=nearest/clamp-to-edge userRegion=specularColorTexture bindings=7/8`,
            );
          }
          if (materialEmissiveTexture !== '') {
            const expectedBytes = materialEmissiveTextureUvTransform === '' && materialEmissiveTextureUvSet === ''
              ? [0, 64, 255, 255]
              : [
                  0, 64, 255, 255,
                  0, 0, 0, 255,
                  0, 0, 0, 255,
                  0, 0, 0, 255,
                ];
            const texture = tape.events.find((event) => {
              if (
                event.kind !== 'createTexture' ||
                event.desc?.format !== 'rgba8unorm' ||
                event.desc?.size?.width !== (materialEmissiveTextureUvTransform === '' && materialEmissiveTextureUvSet === '' ? 1 : 2) ||
                event.desc?.size?.height !== (materialEmissiveTextureUvTransform === '' && materialEmissiveTextureUvSet === '' ? 1 : 2)
              ) {
                return false;
              }
              const seed = tape.events.find(
                (candidate) => candidate.kind === 'initialData' && candidate.handleId === event.handleId,
              );
              const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
              const bytes = data === undefined ? undefined : new Uint8Array(data);
              return bytes !== undefined && bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
            });
            if (texture === undefined) {
              throw new Error(
                'capture tape is missing the blue 1x1 emissiveTexture initialData payload',
              );
            }
            const sampler = materialEmissiveTextureSampler === ''
              ? undefined
              : tape.events.find(
                  (event) =>
                    event.kind === 'createSampler' &&
                    event.desc?.magFilter === 'nearest' &&
                    event.desc?.minFilter === 'nearest' &&
                    event.desc?.mipmapFilter === 'nearest' &&
                    event.desc?.addressModeU === 'clamp-to-edge' &&
                    event.desc?.addressModeV === 'clamp-to-edge' &&
                    event.desc?.addressModeW === 'clamp-to-edge',
                );
            if (materialEmissiveTextureSampler !== '' && sampler === undefined) {
              throw new Error(
                'capture tape is missing the emissiveTexture nearest sampler descriptor',
              );
            }
            const view = tape.events.find(
              (event) => event.kind === 'createTextureView' && event.sourceHandleId === texture.handleId,
            );
            const binding = tape.events.find(
              (event) =>
                event.kind === 'createBindGroup' &&
                event.entries.some(
                  (entry) => entry.binding === 16 && entry.resourceKind === 'sampler',
                ) &&
                event.entries.some(
                  (entry) => entry.binding === 17 && entry.resourceKind === 'textureView',
                ) &&
                (sampler === undefined || event.resourceHandleIds.includes(sampler.handleId)) &&
                view !== undefined &&
                event.resourceHandleIds.includes(view.resultHandleId),
            );
            if (binding === undefined) {
              throw new Error(
                'capture tape is missing the engine-managed emissiveTexture bindings at 16/17',
              );
            }
            console.log(
              `[learn-render 2.2 basic-lighting] tape materialEmissiveTexture=blue payload=${JSON.stringify(expectedBytes)} colorSpace=linear engineManagedRegion=emissiveTexture bindings=16/17 sampler=${materialEmissiveTextureSampler || 'default'} uvTransform=${materialEmissiveTextureUvTransform || 'default'} uvSet=${materialEmissiveTextureUvSet || 'default'}`,
            );
          }
        }
        if (pointLightPosition !== '') {
          const expected = pointLightPosition === 'near' ? [0.9, 0.8, 1.6] : [1.5, 1.0, 2.4];
          const actual = [floats[0], floats[1], floats[2]];
          if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-5)) {
            throw new Error(
              `capture tape Cluster light_data position=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at byte offsets 0,4,8`,
            );
          }
          console.log(
            `[learn-render 2.2 basic-lighting] tape clusterLightData position=${pointLightPosition} position=${JSON.stringify(actual)} byteOffsets=0,4,8`,
          );
        }
        if (pointLightIntensity !== '') {
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
          console.log(
            `[learn-render 2.2 basic-lighting] tape clusterLightData intensity=${actual} byteOffset=16`,
          );
        }
        if (pointLightRange !== '') {
          const actual = floats[3];
          const range = Number.parseFloat(pointLightRange);
          const expected = 1 / (range * range);
          if (Math.abs(actual - expected) > 1e-6) {
            throw new Error(
              `capture tape Cluster light_data invRangeSquared=${actual}; expected ${expected} for range ${range} at byte offset 12`,
            );
          }
          console.log(
            `[learn-render 2.2 basic-lighting] tape clusterLightData range=${range} invRangeSquared=${actual} byteOffset=12`,
          );
        }
        if (pointLightColor !== '') {
          const expectedColor = pointLightColor === 'amber' ? [1.0, 0.8, 0.6] : [1.0, 0.85, 0.7];
          const expectedIntensity = 100;
          const actual = [floats[4], floats[5], floats[6]];
          const expected = expectedColor.map((value) => value * expectedIntensity);
          if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-5)) {
            throw new Error(
              `capture tape Cluster light_data colorTimesIntensity=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} at byte offsets 16,20,24`,
            );
          }
          console.log(
            `[learn-render 2.2 basic-lighting] tape clusterLightData color=${pointLightColor} colorTimesIntensity=${JSON.stringify(actual)} byteOffsets=16,20,24`,
          );
        }
      },
});
