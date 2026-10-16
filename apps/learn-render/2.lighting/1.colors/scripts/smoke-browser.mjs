// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 2.lighting/1.colors (a static scene: colored cube + lamp +
// directional light, first-person controls input-gated so no motion without
// input). Delegates to the shared harness; this file only supplies the demo's
// identity, live-pixel hook (window.__captureColors, installed by src/index.ts),
// and producer-owned tape contracts.
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (pixelDeltaAbsMean <= eps).
// This is the check that proves "offline replay == the demo's actual render".
//
// Local-only gate (no Chrome+WebGPU on CI runners), same as the other
// scripts/smoke-browser.mjs in this repo.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const textureAlpha = process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA ?? '';
const samplerMaxAnisotropy =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY ?? '';
const samplerAddress =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS ?? '';
const samplerMagFilter =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER ?? '';
const samplerMinFilter =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER ?? '';
const samplerMipmapFilter =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER ?? '';
const samplerLodMaxClamp =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP ?? '';
const samplerLodMinClamp =
  process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP ?? '';
const textureMipmap = process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_MIPMAP ?? '';
const textureSrgb = process.env.VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SRGB ?? '';
const metallicRoughnessSampler =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER ?? '';
const metallicRoughnessSamplerMagFilter =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER ?? '';
const metallicRoughnessSamplerMinFilter =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER ?? '';
const metallicRoughnessSamplerAddress =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS ?? '';
const metallicRoughnessSamplerMipmapFilter =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER ?? '';
const metallicRoughnessSamplerLodMinClamp =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP ?? '';
const metallicRoughnessSamplerLodMaxClamp =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP ?? '';
const metallicRoughnessSamplerMaxAnisotropy =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY ?? '';
const metallicRoughnessTextureMipmap =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP ?? '';
const metallicRoughnessTextureUvTransform =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM ?? '';
const metallicRoughnessTextureUvSet =
  process.env.VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET ?? '';
const metallicChannel = process.env.VITE_FALSIFY_MATERIAL_METALLIC_CHANNEL ?? '';
const roughnessChannel = process.env.VITE_FALSIFY_MATERIAL_ROUGHNESS_CHANNEL ?? '';
const clearcoat = process.env.VITE_FALSIFY_MATERIAL_CLEARCOAT ?? '';
const clearcoatRoughness = process.env.VITE_FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS ?? '';
const emissiveIntensity = process.env.VITE_FALSIFY_MATERIAL_EMISSIVE_INTENSITY ?? '';
const alphaCutoff = process.env.VITE_FALSIFY_MATERIAL_ALPHA_CUTOFF ?? '';
const occlusionStrength = process.env.VITE_FALSIFY_MATERIAL_OCCLUSION_STRENGTH ?? '';

if (alphaCutoff !== '' && !['0', '1'].includes(alphaCutoff)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_ALPHA_CUTOFF=${alphaCutoff}; expected 0 or 1`,
  );
  process.exit(1);
}

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-2-lighting-1-colors',
  label: 'learn-render 2.1 colors',
  mode: alphaCutoff === '' ? 'pixel' : 'structural',
  liveHook: '__captureColors',
  rtIdx: 0,
  // Uses the harness default thresholds (mean 0.02 / maxChannel 0.10 /
  // coveredMean 0.03). After the srgb-preserving replay fix the measured delta
  // is 0.00000 across the board, so the tight defaults hold with room to spare.
  appDir: dirname(here),
  assertTape: textureAlpha === '' && samplerMaxAnisotropy === '' && samplerAddress === '' && samplerMagFilter === '' && samplerMinFilter === '' && samplerMipmapFilter === '' && samplerLodMaxClamp === '' && samplerLodMinClamp === '' && textureMipmap === '' && textureSrgb === '' && metallicRoughnessSampler === '' && metallicRoughnessSamplerMagFilter === '' && metallicRoughnessSamplerMinFilter === '' && metallicRoughnessSamplerAddress === '' && metallicRoughnessSamplerMipmapFilter === '' && metallicRoughnessSamplerLodMinClamp === '' && metallicRoughnessSamplerLodMaxClamp === '' && metallicRoughnessSamplerMaxAnisotropy === '' && metallicRoughnessTextureMipmap === '' && metallicRoughnessTextureUvTransform === '' && metallicRoughnessTextureUvSet === '' && metallicChannel === '' && roughnessChannel === '' && clearcoat === '' && clearcoatRoughness === '' && emissiveIntensity === '' && alphaCutoff === '' && occlusionStrength === ''
    ? undefined
    : ({ tape }) => {
        if (textureAlpha !== '') {
          const expected = textureAlpha === '0.5' ? 128 : textureAlpha === '0' ? 0 : null;
          if (expected === null) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA=${textureAlpha}; expected 0 or 0.5`,
            );
          }
          const texture = tape.events.find(
            (event) =>
              event.kind === 'createTexture' &&
              event.desc?.format === 'rgba8unorm' &&
              event.desc?.size?.width === 2 &&
              event.desc?.size?.height === 2,
          );
          const seed = texture === undefined
            ? undefined
            : tape.events.find(
                (event) => event.kind === 'initialData' && event.handleId === texture.handleId,
              );
          const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
          const bytes = data === undefined ? undefined : new Uint8Array(data);
          const matches = bytes !== undefined && bytes.length === 16 && bytes.every((value, index) => {
            const channel = index % 4;
            return value === (channel === 3 ? expected : 255);
          });
          if (!matches) {
            throw new Error(`capture tape is missing white RGBA8 texture payload with alpha=${expected}`);
          }
          console.log(`[learn-render 2.1 colors] tape texture payload alpha=${expected}`);
        }
        if (samplerMaxAnisotropy !== '') {
          if (!['0', '1'].includes(samplerMaxAnisotropy)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY=${samplerMaxAnisotropy}; expected 0 or 1`,
            );
          }
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === 'linear' &&
              event.desc?.addressModeU === 'repeat' &&
              event.desc?.addressModeV === 'repeat' &&
              event.desc?.addressModeW === 'repeat',
          );
          const actual = sampler?.desc?.maxAnisotropy;
          const expected = samplerMaxAnisotropy === '1' ? 16 : undefined;
          if (actual !== expected) {
            throw new Error(
              `capture tape sampler maxAnisotropy=${String(actual)}; expected ${String(expected)}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape base-color sampler maxAnisotropy=${String(actual)}`,
          );
        }
        if (samplerAddress !== '') {
          if (!['0', '1'].includes(samplerAddress)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS=${samplerAddress}; expected 0 or 1`,
            );
          }
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === 'nearest',
          );
          const expected = samplerAddress === '1' ? 'clamp-to-edge' : 'repeat';
          const actual = [
            sampler?.desc?.addressModeU,
            sampler?.desc?.addressModeV,
            sampler?.desc?.addressModeW,
          ];
          if (actual.some((value) => value !== expected)) {
            throw new Error(
              `capture tape sampler addressModes=${actual.join('/')}; expected ${expected}/${expected}/${expected}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape base-color sampler addressModes=${actual.join('/')}`,
          );
        }
        if (samplerMagFilter !== '') {
          if (!['0', '1'].includes(samplerMagFilter)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER=${samplerMagFilter}; expected 0 or 1`,
            );
          }
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === 'nearest' &&
              event.desc?.addressModeU === 'repeat' &&
              event.desc?.addressModeV === 'repeat' &&
              event.desc?.addressModeW === 'repeat',
          );
          const expected = samplerMagFilter === '1' ? 'nearest' : 'linear';
          const actual = sampler?.desc?.magFilter;
          if (actual !== expected) {
            throw new Error(
              `capture tape sampler magFilter=${String(actual)}; expected ${expected}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape base-color sampler magFilter=${actual}`,
          );
        }
        if (samplerMinFilter !== '') {
          if (!['0', '1'].includes(samplerMinFilter)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER=${samplerMinFilter}; expected 0 or 1`,
            );
          }
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.mipmapFilter === 'linear' &&
              event.desc?.addressModeU === 'clamp-to-edge' &&
              event.desc?.addressModeV === 'clamp-to-edge' &&
              event.desc?.addressModeW === 'clamp-to-edge' &&
              event.desc?.lodMinClamp === 1 &&
              event.desc?.lodMaxClamp === 1,
          );
          const expected = samplerMinFilter === '1' ? 'nearest' : 'linear';
          const actual = sampler?.desc?.minFilter;
          if (actual !== expected) {
            throw new Error(
              `capture tape sampler minFilter=${String(actual)}; expected ${expected}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape base-color sampler minFilter=${actual}`,
          );
        }
        if (samplerMipmapFilter !== '') {
          if (!['0', '1'].includes(samplerMipmapFilter)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER=${samplerMipmapFilter}; expected 0 or 1`,
            );
          }
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.addressModeU === 'repeat' &&
              event.desc?.addressModeV === 'repeat' &&
              event.desc?.addressModeW === 'repeat',
          );
          const expected = samplerMipmapFilter === '1' ? 'linear' : 'nearest';
          const actual = sampler?.desc?.mipmapFilter;
          if (actual !== expected) {
            throw new Error(
              `capture tape sampler mipmapFilter=${String(actual)}; expected ${expected}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape base-color sampler mipmapFilter=${actual}`,
          );
        }
        if (samplerLodMaxClamp !== '') {
          if (!['0', '1'].includes(samplerLodMaxClamp)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP=${samplerLodMaxClamp}; expected 0 or 1`,
            );
          }
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === 'linear' &&
              event.desc?.addressModeU === 'repeat' &&
              event.desc?.addressModeV === 'repeat' &&
              event.desc?.addressModeW === 'repeat' &&
              event.desc?.lodMinClamp === 0,
          );
          const expected = samplerLodMaxClamp === '1' ? 0 : 1;
          const actual = sampler?.desc?.lodMaxClamp;
          if (actual !== expected) {
            throw new Error(
              `capture tape sampler lodMaxClamp=${String(actual)}; expected ${expected}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape base-color sampler lodMaxClamp=${String(actual)}`,
          );
        }
        if (samplerLodMinClamp !== '') {
          if (!['0', '1'].includes(samplerLodMinClamp)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP=${samplerLodMinClamp}; expected 0 or 1`,
            );
          }
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === 'linear' &&
              event.desc?.addressModeU === 'repeat' &&
              event.desc?.addressModeV === 'repeat' &&
              event.desc?.addressModeW === 'repeat' &&
              event.desc?.lodMaxClamp === 1,
          );
          const expected = samplerLodMinClamp === '1' ? 1 : 0;
          const actual = sampler?.desc?.lodMinClamp;
          if (actual !== expected) {
            throw new Error(
              `capture tape sampler lodMinClamp=${String(actual)}; expected ${expected}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape base-color sampler lodMinClamp=${String(actual)}`,
          );
        }
        if (textureMipmap !== '') {
          if (!['0', '1'].includes(textureMipmap)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_MIPMAP=${textureMipmap}; expected 0 or 1`,
            );
          }
          const texture = tape.events.find(
            (event) =>
              event.kind === 'createTexture' &&
              event.desc?.format === 'rgba8unorm' &&
              event.desc?.size?.width === 4 &&
              event.desc?.size?.height === 4,
          );
          const actual = texture?.desc?.mipLevelCount;
          const expected = textureMipmap === '1' ? 3 : 1;
          if (actual !== expected) {
            throw new Error(
              `capture tape base-color mipLevelCount=${String(actual)}; expected ${expected}`,
            );
          }
          console.log(`[learn-render 2.1 colors] tape base-color mipLevelCount=${actual}`);
        }
        if (textureSrgb !== '') {
          if (!['0', '1'].includes(textureSrgb)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SRGB=${textureSrgb}; expected 0 or 1`,
            );
          }
          const expected = textureSrgb === '1' ? 'rgba8unorm-srgb' : 'rgba8unorm';
          const texture = tape.events.find(
            (event) =>
              event.kind === 'createTexture' &&
              event.desc?.size?.width === 1 &&
              event.desc?.size?.height === 1 &&
              event.desc?.size?.depthOrArrayLayers === 1 &&
              event.desc?.usage === 23,
          );
          const actual = texture?.desc?.format;
          if (actual !== expected) {
            throw new Error(
              `capture tape base-color format=${String(actual)}; expected ${expected}`,
            );
          }
          console.log(`[learn-render 2.1 colors] tape base-color format=${actual}`);
        }
        if (metallicRoughnessSampler !== '') {
          if (!['0', '1'].includes(metallicRoughnessSampler)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER=${metallicRoughnessSampler}; expected 0 or 1`,
            );
          }
          const expected = metallicRoughnessSampler === '1' ? 'nearest' : 'linear';
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === expected &&
              event.desc?.minFilter === expected &&
              event.desc?.mipmapFilter === expected &&
              event.desc?.addressModeU === 'clamp-to-edge' &&
              event.desc?.addressModeV === 'clamp-to-edge' &&
              event.desc?.addressModeW === 'clamp-to-edge',
          );
          if (sampler === undefined) {
            throw new Error(
              `capture tape is missing metallic-roughness sampler filters=${expected}/${expected}/${expected} address=clamp-to-edge`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness sampler filters=${sampler.desc.magFilter}/${sampler.desc.minFilter}/${sampler.desc.mipmapFilter} address=${sampler.desc.addressModeU}`,
          );
        }
        if (metallicRoughnessSamplerMagFilter !== '') {
          if (!['0', '1'].includes(metallicRoughnessSamplerMagFilter)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER=${metallicRoughnessSamplerMagFilter}; expected 0 or 1`,
            );
          }
          const expected = metallicRoughnessSamplerMagFilter === '1' ? 'nearest' : 'linear';
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === expected &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === 'nearest' &&
              event.desc?.addressModeU === 'clamp-to-edge' &&
              event.desc?.addressModeV === 'clamp-to-edge' &&
              event.desc?.addressModeW === 'clamp-to-edge',
          );
          if (sampler === undefined) {
            throw new Error(
              `capture tape is missing metallic-roughness sampler magFilter=${expected} filters=${expected}/linear/nearest address=clamp-to-edge`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness sampler magFilter=${sampler.desc.magFilter} filters=${sampler.desc.magFilter}/${sampler.desc.minFilter}/${sampler.desc.mipmapFilter} address=${sampler.desc.addressModeU}`,
          );
        }
        if (metallicRoughnessSamplerMinFilter !== '') {
          if (!['0', '1'].includes(metallicRoughnessSamplerMinFilter)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER=${metallicRoughnessSamplerMinFilter}; expected 0 or 1`,
            );
          }
          const expected = metallicRoughnessSamplerMinFilter === '1' ? 'nearest' : 'linear';
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === expected &&
              event.desc?.mipmapFilter === 'linear' &&
              event.desc?.addressModeU === 'clamp-to-edge' &&
              event.desc?.addressModeV === 'clamp-to-edge' &&
              event.desc?.addressModeW === 'clamp-to-edge' &&
              event.desc?.lodMinClamp === 0.5 &&
              event.desc?.lodMaxClamp === 0.5,
          );
          if (sampler === undefined) {
            throw new Error(
              `capture tape is missing metallic-roughness sampler minFilter=${expected} filters=linear/${expected}/linear address=clamp-to-edge lod=0.5/0.5`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness sampler minFilter=${sampler.desc.minFilter} filters=${sampler.desc.magFilter}/${sampler.desc.minFilter}/${sampler.desc.mipmapFilter} address=${sampler.desc.addressModeU}`,
          );
        }
        if (metallicRoughnessSamplerMipmapFilter !== '') {
          if (!['0', '1'].includes(metallicRoughnessSamplerMipmapFilter)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER=${metallicRoughnessSamplerMipmapFilter}; expected 0 or 1`,
            );
          }
          const expected = metallicRoughnessSamplerMipmapFilter === '1' ? 'nearest' : 'linear';
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === expected &&
              event.desc?.addressModeU === 'clamp-to-edge' &&
              event.desc?.addressModeV === 'clamp-to-edge' &&
              event.desc?.addressModeW === 'clamp-to-edge' &&
              event.desc?.lodMinClamp === 0.5 &&
              event.desc?.lodMaxClamp === 0.5,
          );
          if (sampler === undefined) {
            throw new Error(
              `capture tape is missing metallic-roughness sampler mipmapFilter=${expected} filters=linear/linear/${expected} address=clamp-to-edge lod=0.5/0.5`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness sampler mipmapFilter=${sampler.desc.mipmapFilter} filters=${sampler.desc.magFilter}/${sampler.desc.minFilter}/${sampler.desc.mipmapFilter} address=${sampler.desc.addressModeU}`,
          );
        }
        if (metallicRoughnessSamplerAddress !== '') {
          if (!['0', '1'].includes(metallicRoughnessSamplerAddress)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS=${metallicRoughnessSamplerAddress}; expected 0 or 1`,
            );
          }
          const expected = metallicRoughnessSamplerAddress === '1' ? 'clamp-to-edge' : 'repeat';
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'nearest' &&
              event.desc?.minFilter === 'nearest' &&
              event.desc?.mipmapFilter === 'nearest' &&
              event.desc?.addressModeU === expected &&
              event.desc?.addressModeV === expected &&
              event.desc?.addressModeW === expected,
          );
          if (sampler === undefined) {
            throw new Error(
              `capture tape is missing metallic-roughness sampler address=${expected} filters=nearest/nearest/nearest`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness sampler address=${sampler.desc.addressModeU} filters=${sampler.desc.magFilter}/${sampler.desc.minFilter}/${sampler.desc.mipmapFilter}`,
          );
        }
        if (metallicRoughnessSamplerLodMinClamp !== '') {
          if (!['0', '1'].includes(metallicRoughnessSamplerLodMinClamp)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP=${metallicRoughnessSamplerLodMinClamp}; expected 0 or 1`,
            );
          }
          const expected = metallicRoughnessSamplerLodMinClamp === '1' ? 1 : 0;
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === 'linear' &&
              event.desc?.addressModeU === 'clamp-to-edge' &&
              event.desc?.addressModeV === 'clamp-to-edge' &&
              event.desc?.addressModeW === 'clamp-to-edge' &&
              event.desc?.lodMinClamp === expected &&
              event.desc?.lodMaxClamp === 1,
          );
          if (sampler === undefined) {
            throw new Error(
              `capture tape is missing metallic-roughness sampler lodMinClamp=${expected} lodMaxClamp=1 filters=linear/linear/linear address=clamp-to-edge`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness sampler lodMinClamp=${sampler.desc.lodMinClamp} lodMaxClamp=${sampler.desc.lodMaxClamp} filters=${sampler.desc.magFilter}/${sampler.desc.minFilter}/${sampler.desc.mipmapFilter} address=${sampler.desc.addressModeU}`,
          );
        }
        if (metallicRoughnessSamplerLodMaxClamp !== '') {
          if (!['0', '1'].includes(metallicRoughnessSamplerLodMaxClamp)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP=${metallicRoughnessSamplerLodMaxClamp}; expected 0 or 1`,
            );
          }
          const expected = metallicRoughnessSamplerLodMaxClamp === '1' ? 0 : 1;
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === 'linear' &&
              event.desc?.addressModeU === 'clamp-to-edge' &&
              event.desc?.addressModeV === 'clamp-to-edge' &&
              event.desc?.addressModeW === 'clamp-to-edge' &&
              event.desc?.lodMinClamp === 0 &&
              event.desc?.lodMaxClamp === expected,
          );
          if (sampler === undefined) {
            throw new Error(
              `capture tape is missing metallic-roughness sampler lodMinClamp=0 lodMaxClamp=${expected} filters=linear/linear/linear address=clamp-to-edge`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness sampler lodMinClamp=${sampler.desc.lodMinClamp} lodMaxClamp=${sampler.desc.lodMaxClamp} filters=${sampler.desc.magFilter}/${sampler.desc.minFilter}/${sampler.desc.mipmapFilter} address=${sampler.desc.addressModeU}`,
          );
        }
        if (metallicRoughnessSamplerMaxAnisotropy !== '') {
          if (!['0', '1'].includes(metallicRoughnessSamplerMaxAnisotropy)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY=${metallicRoughnessSamplerMaxAnisotropy}; expected 0 or 1`,
            );
          }
          const expected = metallicRoughnessSamplerMaxAnisotropy === '1' ? 16 : undefined;
          const sampler = tape.events.find(
            (event) =>
              event.kind === 'createSampler' &&
              event.desc?.magFilter === 'linear' &&
              event.desc?.minFilter === 'linear' &&
              event.desc?.mipmapFilter === 'linear' &&
              event.desc?.addressModeU === 'clamp-to-edge' &&
              event.desc?.addressModeV === 'clamp-to-edge' &&
              event.desc?.addressModeW === 'clamp-to-edge' &&
              event.desc?.maxAnisotropy === expected,
          );
          if (sampler === undefined) {
            throw new Error(
              `capture tape is missing metallic-roughness sampler maxAnisotropy=${expected ?? 1} filters=linear/linear/linear address=clamp-to-edge`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness sampler maxAnisotropy=${sampler.desc.maxAnisotropy ?? 1} descriptor=${String(sampler.desc.maxAnisotropy)} filters=${sampler.desc.magFilter}/${sampler.desc.minFilter}/${sampler.desc.mipmapFilter} address=${sampler.desc.addressModeU}`,
          );
        }
        if (metallicRoughnessTextureMipmap !== '') {
          if (!['0', '1'].includes(metallicRoughnessTextureMipmap)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP=${metallicRoughnessTextureMipmap}; expected 0 or 1`,
            );
          }
          const texture = tape.events.find(
            (event) =>
              event.kind === 'createTexture' &&
              event.desc?.format === 'rgba8unorm' &&
              event.desc?.size?.width === 4 &&
              event.desc?.size?.height === 4,
          );
          const expected = metallicRoughnessTextureMipmap === '1' ? 3 : 1;
          const actual = texture?.desc?.mipLevelCount;
          if (actual !== expected) {
            throw new Error(
              `capture tape metallic-roughness mipLevelCount=${String(actual)}; expected ${expected}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness texture mipLevelCount=${actual} size=4x4 format=rgba8unorm`,
          );
        }
        if (metallicRoughnessTextureUvTransform !== '') {
          if (!['0', '1'].includes(metallicRoughnessTextureUvTransform)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM=${metallicRoughnessTextureUvTransform}; expected 0 or 1`,
            );
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const upload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.size === 512,
              );
          const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
          if (data === undefined || data.byteLength < 160) {
            throw new Error(
              'capture tape is missing the 512-byte standard material UBO upload for metallic-roughness UV coordinates',
            );
          }
          const f32 = new Float32Array(data);
          const expected = metallicRoughnessTextureUvTransform === '1'
            ? [0.25, 0.25, 0, 0, 0, 0, 1, 1]
            : [0, 0, 1, 1, 0, 0, 1, 1];
          const actual = [...f32.slice(32, 40)];
          if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
            throw new Error(
              `capture tape metallic-roughness UV coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness UV transform offset=${actual[0]},${actual[1]} scale=${actual[2]},${actual[3]} set=${actual[4]} rotation=${actual[5]} textureScale=${actual[6]},${actual[7]}`,
          );
        }
        if (metallicRoughnessTextureUvSet !== '') {
          if (!['0', '1'].includes(metallicRoughnessTextureUvSet)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET=${metallicRoughnessTextureUvSet}; expected 0 or 1`,
            );
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const upload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.size === 512,
              );
          const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
          if (data === undefined || data.byteLength < 160) {
            throw new Error(
              'capture tape is missing the 512-byte standard material UBO upload for metallic-roughness UV set',
            );
          }
          const f32 = new Float32Array(data);
          const expected = metallicRoughnessTextureUvSet === '1'
            ? [0, 0, 1, 1, 1, 0, 1, 1]
            : [0, 0, 1, 1, 0, 0, 1, 1];
          const actual = [...f32.slice(32, 40)];
          if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
            throw new Error(
              `capture tape metallic-roughness UV coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallic-roughness UV set=${actual[4]} offset=${actual[0]},${actual[1]} scale=${actual[2]},${actual[3]} rotation=${actual[5]} textureScale=${actual[6]},${actual[7]}`,
          );
        }
        if (metallicChannel !== '') {
          if (!['0', '2'].includes(metallicChannel)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_METALLIC_CHANNEL=${metallicChannel}; expected 0 or 2`,
            );
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const upload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.size === 512,
              );
          const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
          if (data === undefined || data.byteLength < 28) {
            throw new Error(
              'capture tape is missing the 512-byte standard material UBO upload for metallic channel',
            );
          }
          const actual = new Float32Array(data)[6];
          const expected = Number.parseInt(metallicChannel, 10);
          if (Math.abs(actual - expected) > 1e-6) {
            throw new Error(
              `capture tape metallicChannel=${actual}; expected ${expected} at UBO byte offset 24`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape metallicChannel=${actual} UBO byteOffset=24`,
          );
        }
        if (roughnessChannel !== '') {
          if (!['1', '2'].includes(roughnessChannel)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_ROUGHNESS_CHANNEL=${roughnessChannel}; expected 1 or 2`,
            );
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const upload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.size === 512,
              );
          const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
          if (data === undefined || data.byteLength < 32) {
            throw new Error(
              'capture tape is missing the 512-byte standard material UBO upload for roughness channel',
            );
          }
          const actual = new Float32Array(data)[7];
          const expected = Number.parseInt(roughnessChannel, 10);
          if (Math.abs(actual - expected) > 1e-6) {
            throw new Error(
              `capture tape roughnessChannel=${actual}; expected ${expected} at UBO byte offset 28`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape roughnessChannel=${actual} UBO byteOffset=28`,
          );
        }
        if (clearcoat !== '') {
          if (!['0', '1'].includes(clearcoat)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_CLEARCOAT=${clearcoat}; expected 0 or 1`,
            );
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const upload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.size === 512,
              );
          const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
          if (data === undefined || data.byteLength < 76) {
            throw new Error(
              'capture tape is missing the 512-byte standard material UBO upload for clearcoat',
            );
          }
          const actual = new Float32Array(data)[18];
          const expected = Number.parseFloat(clearcoat);
          if (Math.abs(actual - expected) > 1e-6) {
            throw new Error(
              `capture tape clearcoat=${actual}; expected ${expected} at UBO byte offset 72`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape clearcoat=${actual} UBO byteOffset=72`,
          );
        }
        if (emissiveIntensity !== '') {
          if (!['0', '1'].includes(emissiveIntensity)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_EMISSIVE_INTENSITY=${emissiveIntensity}; expected 0 or 1`,
            );
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const upload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.size === 512,
              );
          const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
          if (data === undefined || data.byteLength < 64) {
            throw new Error(
              'capture tape is missing the 512-byte standard material UBO upload for emissive intensity',
            );
          }
          const actual = new Float32Array(data)[15];
          const expected = Number.parseFloat(emissiveIntensity);
          if (Math.abs(actual - expected) > 1e-6) {
            throw new Error(
              `capture tape emissiveIntensity=${actual}; expected ${expected} at UBO byte offset 60`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape emissiveIntensity=${actual} UBO byteOffset=60`,
          );
        }
        if (occlusionStrength !== '') {
          if (!['0', '1'].includes(occlusionStrength)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_OCCLUSION_STRENGTH=${occlusionStrength}; expected 0 or 1`,
            );
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const upload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.size === 512,
              );
          const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
          if (data === undefined || data.byteLength < 68) {
            throw new Error(
              'capture tape is missing the 512-byte standard material UBO upload for occlusion strength',
            );
          }
          const actual = new Float32Array(data)[16];
          const expected = Number.parseFloat(occlusionStrength);
          if (Math.abs(actual - expected) > 1e-6) {
            throw new Error(
              `capture tape occlusionStrength=${actual}; expected ${expected} at UBO byte offset 64`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape occlusionStrength=${actual} UBO byteOffset=64`,
          );
        }
        if (alphaCutoff !== '') {
          if (!['0', '1'].includes(alphaCutoff)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_ALPHA_CUTOFF=${alphaCutoff}; expected 0 or 1`,
            );
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const upload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.size === 512,
              );
          const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
          if (data === undefined || data.byteLength < 72) {
            throw new Error(
              'capture tape is missing the 512-byte standard material UBO upload for alpha cutoff',
            );
          }
          const actual = new Float32Array(data)[17];
          const expected = Number.parseFloat(alphaCutoff) * 0.5;
          if (Math.abs(actual - expected) > 1e-6) {
            throw new Error(
              `capture tape alphaCutoff=${actual}; expected ${expected} at UBO byte offset 68`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape alphaCutoff=${actual} UBO byteOffset=68`,
          );
        }
        if (clearcoatRoughness !== '') {
          if (!['0.5', '1'].includes(clearcoatRoughness)) {
            throw new Error(
              `unsupported VITE_FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS=${clearcoatRoughness}; expected 0.5 or 1`,
            );
          }
          const materialBuffer = tape.events.find(
            (event) =>
              event.kind === 'createBuffer' &&
              event.desc?.size === 524288 &&
              event.desc?.usage === 76,
          );
          const upload = materialBuffer === undefined
            ? undefined
            : tape.events.find(
                (event) =>
                  event.kind === 'writeBuffer' &&
                  event.handleId === materialBuffer.handleId &&
                  event.size === 512,
              );
          const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
          if (data === undefined || data.byteLength < 80) {
            throw new Error(
              'capture tape is missing the 512-byte standard material UBO upload for clearcoat roughness',
            );
          }
          const actual = new Float32Array(data)[19];
          const expected = Number.parseFloat(clearcoatRoughness);
          if (Math.abs(actual - expected) > 1e-6) {
            throw new Error(
              `capture tape clearcoatRoughness=${actual}; expected ${expected} at UBO byte offset 76`,
            );
          }
          console.log(
            `[learn-render 2.1 colors] tape clearcoatRoughness=${actual} UBO byteOffset=76`,
          );
        }
      },
});
