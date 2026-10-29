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

const falsifyValues = [
  textureAlpha,
  samplerMaxAnisotropy,
  samplerAddress,
  samplerMagFilter,
  samplerMinFilter,
  samplerMipmapFilter,
  samplerLodMaxClamp,
  samplerLodMinClamp,
  textureMipmap,
  textureSrgb,
  metallicRoughnessSampler,
  metallicRoughnessSamplerMagFilter,
  metallicRoughnessSamplerMinFilter,
  metallicRoughnessSamplerAddress,
  metallicRoughnessSamplerMipmapFilter,
  metallicRoughnessSamplerLodMinClamp,
  metallicRoughnessSamplerLodMaxClamp,
  metallicRoughnessSamplerMaxAnisotropy,
  metallicRoughnessTextureMipmap,
  metallicRoughnessTextureUvTransform,
  metallicRoughnessTextureUvSet,
  metallicChannel,
  roughnessChannel,
  clearcoat,
  clearcoatRoughness,
  emissiveIntensity,
  alphaCutoff,
  occlusionStrength,
];

if (alphaCutoff !== '' && !['0', '1'].includes(alphaCutoff)) {
  console.error(
    `[smoke-browser] FAIL - unsupported VITE_FALSIFY_MATERIAL_ALPHA_CUTOFF=${alphaCutoff}; expected 0 or 1`,
  );
  process.exit(1);
}

function requireFalsifyChoice(envName, value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`unsupported ${envName}=${value}; expected ${allowed.join(' or ')}`);
  }
}

function findMetallicRoughnessSampler(tape, matches) {
  return tape.events.find((event) => event.kind === 'createSampler' && matches(event.desc));
}

function describeSamplerFilters(desc) {
  return `${desc.magFilter}/${desc.minFilter}/${desc.mipmapFilter}`;
}

/** The 512-byte standard material UBO upload; throws when it is absent or shorter than `minBytes`. */
function readStandardMaterialUbo(tape, minBytes, purpose) {
  const materialBuffer = tape.events.find(
    (event) => event.kind === 'createBuffer' && event.desc?.size === 524288 && event.desc?.usage === 76,
  );
  const upload =
    materialBuffer === undefined
      ? undefined
      : tape.events.find(
          (event) =>
            event.kind === 'writeBuffer' && event.handleId === materialBuffer.handleId && event.size === 512,
        );
  const data = upload === undefined ? undefined : tape.blobPool.get(upload.dataHash);
  if (data === undefined || data.byteLength < minBytes) {
    throw new Error(`capture tape is missing the 512-byte standard material UBO upload for ${purpose}`);
  }
  return data;
}

function assertStandardMaterialUboScalar(tape, label, purpose, floatIndex, expected) {
  const byteOffset = floatIndex * 4;
  const actual = new Float32Array(readStandardMaterialUbo(tape, byteOffset + 4, purpose))[floatIndex];
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(`capture tape ${label}=${actual}; expected ${expected} at UBO byte offset ${byteOffset}`);
  }
  console.log(`[learn-render 2.1 colors] tape ${label}=${actual} UBO byteOffset=${byteOffset}`);
}

function readMetallicRoughnessUvCoordinates(tape, purpose, expected) {
  const f32 = new Float32Array(readStandardMaterialUbo(tape, 160, purpose));
  const actual = [...f32.slice(32, 40)];
  if (actual.some((value, index) => Math.abs(value - expected[index]) > 1e-6)) {
    throw new Error(
      `capture tape metallic-roughness UV coordinates=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
    );
  }
  return actual;
}

function isWhiteTexturePayload(bytes, expectedAlpha) {
  return (
    bytes !== undefined &&
    bytes.length === 16 &&
    bytes.every((value, index) => value === (index % 4 === 3 ? expectedAlpha : 255))
  );
}

function assertBaseColorTextureAlpha(tape) {
  if (textureAlpha === '') return;
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
  const seed =
    texture === undefined
      ? undefined
      : tape.events.find((event) => event.kind === 'initialData' && event.handleId === texture.handleId);
  const data = seed === undefined ? undefined : tape.blobPool.get(seed.dataHash);
  const bytes = data === undefined ? undefined : new Uint8Array(data);
  if (!isWhiteTexturePayload(bytes, expected)) {
    throw new Error(`capture tape is missing white RGBA8 texture payload with alpha=${expected}`);
  }
  console.log(`[learn-render 2.1 colors] tape texture payload alpha=${expected}`);
}

function assertBaseColorSamplerMaxAnisotropy(tape) {
  if (samplerMaxAnisotropy === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MAX_ANISOTROPY', samplerMaxAnisotropy, [
    '0',
    '1',
  ]);
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
    throw new Error(`capture tape sampler maxAnisotropy=${String(actual)}; expected ${String(expected)}`);
  }
  console.log(`[learn-render 2.1 colors] tape base-color sampler maxAnisotropy=${String(actual)}`);
}

function assertBaseColorSamplerAddress(tape) {
  if (samplerAddress === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_ADDRESS', samplerAddress, ['0', '1']);
  const sampler = tape.events.find(
    (event) =>
      event.kind === 'createSampler' &&
      event.desc?.magFilter === 'linear' &&
      event.desc?.minFilter === 'linear' &&
      event.desc?.mipmapFilter === 'nearest',
  );
  const expected = samplerAddress === '1' ? 'clamp-to-edge' : 'repeat';
  const actual = [sampler?.desc?.addressModeU, sampler?.desc?.addressModeV, sampler?.desc?.addressModeW];
  if (actual.some((value) => value !== expected)) {
    throw new Error(
      `capture tape sampler addressModes=${actual.join('/')}; expected ${expected}/${expected}/${expected}`,
    );
  }
  console.log(`[learn-render 2.1 colors] tape base-color sampler addressModes=${actual.join('/')}`);
}

function assertBaseColorSamplerMagFilter(tape) {
  if (samplerMagFilter === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MAG_FILTER', samplerMagFilter, ['0', '1']);
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
    throw new Error(`capture tape sampler magFilter=${String(actual)}; expected ${expected}`);
  }
  console.log(`[learn-render 2.1 colors] tape base-color sampler magFilter=${actual}`);
}

function assertBaseColorSamplerMinFilter(tape) {
  if (samplerMinFilter === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MIN_FILTER', samplerMinFilter, ['0', '1']);
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
    throw new Error(`capture tape sampler minFilter=${String(actual)}; expected ${expected}`);
  }
  console.log(`[learn-render 2.1 colors] tape base-color sampler minFilter=${actual}`);
}

function assertBaseColorSamplerMipmapFilter(tape) {
  if (samplerMipmapFilter === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_MIPMAP_FILTER', samplerMipmapFilter, [
    '0',
    '1',
  ]);
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
    throw new Error(`capture tape sampler mipmapFilter=${String(actual)}; expected ${expected}`);
  }
  console.log(`[learn-render 2.1 colors] tape base-color sampler mipmapFilter=${actual}`);
}

function assertBaseColorSamplerLodMaxClamp(tape) {
  if (samplerLodMaxClamp === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_LOD_MAX_CLAMP', samplerLodMaxClamp, [
    '0',
    '1',
  ]);
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
    throw new Error(`capture tape sampler lodMaxClamp=${String(actual)}; expected ${expected}`);
  }
  console.log(`[learn-render 2.1 colors] tape base-color sampler lodMaxClamp=${String(actual)}`);
}

function assertBaseColorSamplerLodMinClamp(tape) {
  if (samplerLodMinClamp === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SAMPLER_LOD_MIN_CLAMP', samplerLodMinClamp, [
    '0',
    '1',
  ]);
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
    throw new Error(`capture tape sampler lodMinClamp=${String(actual)}; expected ${expected}`);
  }
  console.log(`[learn-render 2.1 colors] tape base-color sampler lodMinClamp=${String(actual)}`);
}

function findRgba8Texture4x4(tape) {
  return tape.events.find(
    (event) =>
      event.kind === 'createTexture' &&
      event.desc?.format === 'rgba8unorm' &&
      event.desc?.size?.width === 4 &&
      event.desc?.size?.height === 4,
  );
}

function assertBaseColorTextureMipmap(tape) {
  if (textureMipmap === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_MIPMAP', textureMipmap, ['0', '1']);
  const actual = findRgba8Texture4x4(tape)?.desc?.mipLevelCount;
  const expected = textureMipmap === '1' ? 3 : 1;
  if (actual !== expected) {
    throw new Error(`capture tape base-color mipLevelCount=${String(actual)}; expected ${expected}`);
  }
  console.log(`[learn-render 2.1 colors] tape base-color mipLevelCount=${actual}`);
}

function assertBaseColorTextureSrgb(tape) {
  if (textureSrgb === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_SRGB', textureSrgb, ['0', '1']);
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
    throw new Error(`capture tape base-color format=${String(actual)}; expected ${expected}`);
  }
  console.log(`[learn-render 2.1 colors] tape base-color format=${actual}`);
}

function assertMetallicRoughnessSampler(tape) {
  if (metallicRoughnessSampler === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER', metallicRoughnessSampler, [
    '0',
    '1',
  ]);
  const expected = metallicRoughnessSampler === '1' ? 'nearest' : 'linear';
  const sampler = findMetallicRoughnessSampler(
    tape,
    (desc) =>
      desc?.magFilter === expected &&
      desc?.minFilter === expected &&
      desc?.mipmapFilter === expected &&
      desc?.addressModeU === 'clamp-to-edge' &&
      desc?.addressModeV === 'clamp-to-edge' &&
      desc?.addressModeW === 'clamp-to-edge',
  );
  if (sampler === undefined) {
    throw new Error(
      `capture tape is missing metallic-roughness sampler filters=${expected}/${expected}/${expected} address=clamp-to-edge`,
    );
  }
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness sampler filters=${describeSamplerFilters(sampler.desc)} address=${sampler.desc.addressModeU}`,
  );
}

function assertMetallicRoughnessSamplerMagFilter(tape) {
  if (metallicRoughnessSamplerMagFilter === '') return;
  requireFalsifyChoice(
    'VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAG_FILTER',
    metallicRoughnessSamplerMagFilter,
    ['0', '1'],
  );
  const expected = metallicRoughnessSamplerMagFilter === '1' ? 'nearest' : 'linear';
  const sampler = findMetallicRoughnessSampler(
    tape,
    (desc) =>
      desc?.magFilter === expected &&
      desc?.minFilter === 'linear' &&
      desc?.mipmapFilter === 'nearest' &&
      desc?.addressModeU === 'clamp-to-edge' &&
      desc?.addressModeV === 'clamp-to-edge' &&
      desc?.addressModeW === 'clamp-to-edge',
  );
  if (sampler === undefined) {
    throw new Error(
      `capture tape is missing metallic-roughness sampler magFilter=${expected} filters=${expected}/linear/nearest address=clamp-to-edge`,
    );
  }
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness sampler magFilter=${sampler.desc.magFilter} filters=${describeSamplerFilters(sampler.desc)} address=${sampler.desc.addressModeU}`,
  );
}

function assertMetallicRoughnessSamplerMinFilter(tape) {
  if (metallicRoughnessSamplerMinFilter === '') return;
  requireFalsifyChoice(
    'VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIN_FILTER',
    metallicRoughnessSamplerMinFilter,
    ['0', '1'],
  );
  const expected = metallicRoughnessSamplerMinFilter === '1' ? 'nearest' : 'linear';
  const sampler = findMetallicRoughnessSampler(
    tape,
    (desc) =>
      desc?.magFilter === 'linear' &&
      desc?.minFilter === expected &&
      desc?.mipmapFilter === 'linear' &&
      desc?.addressModeU === 'clamp-to-edge' &&
      desc?.addressModeV === 'clamp-to-edge' &&
      desc?.addressModeW === 'clamp-to-edge' &&
      desc?.lodMinClamp === 0.5 &&
      desc?.lodMaxClamp === 0.5,
  );
  if (sampler === undefined) {
    throw new Error(
      `capture tape is missing metallic-roughness sampler minFilter=${expected} filters=linear/${expected}/linear address=clamp-to-edge lod=0.5/0.5`,
    );
  }
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness sampler minFilter=${sampler.desc.minFilter} filters=${describeSamplerFilters(sampler.desc)} address=${sampler.desc.addressModeU}`,
  );
}

function assertMetallicRoughnessSamplerMipmapFilter(tape) {
  if (metallicRoughnessSamplerMipmapFilter === '') return;
  requireFalsifyChoice(
    'VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MIPMAP_FILTER',
    metallicRoughnessSamplerMipmapFilter,
    ['0', '1'],
  );
  const expected = metallicRoughnessSamplerMipmapFilter === '1' ? 'nearest' : 'linear';
  const sampler = findMetallicRoughnessSampler(
    tape,
    (desc) =>
      desc?.magFilter === 'linear' &&
      desc?.minFilter === 'linear' &&
      desc?.mipmapFilter === expected &&
      desc?.addressModeU === 'clamp-to-edge' &&
      desc?.addressModeV === 'clamp-to-edge' &&
      desc?.addressModeW === 'clamp-to-edge' &&
      desc?.lodMinClamp === 0.5 &&
      desc?.lodMaxClamp === 0.5,
  );
  if (sampler === undefined) {
    throw new Error(
      `capture tape is missing metallic-roughness sampler mipmapFilter=${expected} filters=linear/linear/${expected} address=clamp-to-edge lod=0.5/0.5`,
    );
  }
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness sampler mipmapFilter=${sampler.desc.mipmapFilter} filters=${describeSamplerFilters(sampler.desc)} address=${sampler.desc.addressModeU}`,
  );
}

function assertMetallicRoughnessSamplerAddress(tape) {
  if (metallicRoughnessSamplerAddress === '') return;
  requireFalsifyChoice(
    'VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_ADDRESS',
    metallicRoughnessSamplerAddress,
    ['0', '1'],
  );
  const expected = metallicRoughnessSamplerAddress === '1' ? 'clamp-to-edge' : 'repeat';
  const sampler = findMetallicRoughnessSampler(
    tape,
    (desc) =>
      desc?.magFilter === 'nearest' &&
      desc?.minFilter === 'nearest' &&
      desc?.mipmapFilter === 'nearest' &&
      desc?.addressModeU === expected &&
      desc?.addressModeV === expected &&
      desc?.addressModeW === expected,
  );
  if (sampler === undefined) {
    throw new Error(
      `capture tape is missing metallic-roughness sampler address=${expected} filters=nearest/nearest/nearest`,
    );
  }
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness sampler address=${sampler.desc.addressModeU} filters=${describeSamplerFilters(sampler.desc)}`,
  );
}

function assertMetallicRoughnessSamplerLodMinClamp(tape) {
  if (metallicRoughnessSamplerLodMinClamp === '') return;
  requireFalsifyChoice(
    'VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MIN_CLAMP',
    metallicRoughnessSamplerLodMinClamp,
    ['0', '1'],
  );
  const expected = metallicRoughnessSamplerLodMinClamp === '1' ? 1 : 0;
  const sampler = findMetallicRoughnessSampler(
    tape,
    (desc) =>
      desc?.magFilter === 'linear' &&
      desc?.minFilter === 'linear' &&
      desc?.mipmapFilter === 'linear' &&
      desc?.addressModeU === 'clamp-to-edge' &&
      desc?.addressModeV === 'clamp-to-edge' &&
      desc?.addressModeW === 'clamp-to-edge' &&
      desc?.lodMinClamp === expected &&
      desc?.lodMaxClamp === 1,
  );
  if (sampler === undefined) {
    throw new Error(
      `capture tape is missing metallic-roughness sampler lodMinClamp=${expected} lodMaxClamp=1 filters=linear/linear/linear address=clamp-to-edge`,
    );
  }
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness sampler lodMinClamp=${sampler.desc.lodMinClamp} lodMaxClamp=${sampler.desc.lodMaxClamp} filters=${describeSamplerFilters(sampler.desc)} address=${sampler.desc.addressModeU}`,
  );
}

function assertMetallicRoughnessSamplerLodMaxClamp(tape) {
  if (metallicRoughnessSamplerLodMaxClamp === '') return;
  requireFalsifyChoice(
    'VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_LOD_MAX_CLAMP',
    metallicRoughnessSamplerLodMaxClamp,
    ['0', '1'],
  );
  const expected = metallicRoughnessSamplerLodMaxClamp === '1' ? 0 : 1;
  const sampler = findMetallicRoughnessSampler(
    tape,
    (desc) =>
      desc?.magFilter === 'linear' &&
      desc?.minFilter === 'linear' &&
      desc?.mipmapFilter === 'linear' &&
      desc?.addressModeU === 'clamp-to-edge' &&
      desc?.addressModeV === 'clamp-to-edge' &&
      desc?.addressModeW === 'clamp-to-edge' &&
      desc?.lodMinClamp === 0 &&
      desc?.lodMaxClamp === expected,
  );
  if (sampler === undefined) {
    throw new Error(
      `capture tape is missing metallic-roughness sampler lodMinClamp=0 lodMaxClamp=${expected} filters=linear/linear/linear address=clamp-to-edge`,
    );
  }
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness sampler lodMinClamp=${sampler.desc.lodMinClamp} lodMaxClamp=${sampler.desc.lodMaxClamp} filters=${describeSamplerFilters(sampler.desc)} address=${sampler.desc.addressModeU}`,
  );
}

function assertMetallicRoughnessSamplerMaxAnisotropy(tape) {
  if (metallicRoughnessSamplerMaxAnisotropy === '') return;
  requireFalsifyChoice(
    'VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_SAMPLER_MAX_ANISOTROPY',
    metallicRoughnessSamplerMaxAnisotropy,
    ['0', '1'],
  );
  const expected = metallicRoughnessSamplerMaxAnisotropy === '1' ? 16 : undefined;
  const sampler = findMetallicRoughnessSampler(
    tape,
    (desc) =>
      desc?.magFilter === 'linear' &&
      desc?.minFilter === 'linear' &&
      desc?.mipmapFilter === 'linear' &&
      desc?.addressModeU === 'clamp-to-edge' &&
      desc?.addressModeV === 'clamp-to-edge' &&
      desc?.addressModeW === 'clamp-to-edge' &&
      desc?.maxAnisotropy === expected,
  );
  if (sampler === undefined) {
    throw new Error(
      `capture tape is missing metallic-roughness sampler maxAnisotropy=${expected ?? 1} filters=linear/linear/linear address=clamp-to-edge`,
    );
  }
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness sampler maxAnisotropy=${sampler.desc.maxAnisotropy ?? 1} descriptor=${String(sampler.desc.maxAnisotropy)} filters=${describeSamplerFilters(sampler.desc)} address=${sampler.desc.addressModeU}`,
  );
}

function assertMetallicRoughnessTextureMipmap(tape) {
  if (metallicRoughnessTextureMipmap === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_MIPMAP', metallicRoughnessTextureMipmap, [
    '0',
    '1',
  ]);
  const expected = metallicRoughnessTextureMipmap === '1' ? 3 : 1;
  const actual = findRgba8Texture4x4(tape)?.desc?.mipLevelCount;
  if (actual !== expected) {
    throw new Error(`capture tape metallic-roughness mipLevelCount=${String(actual)}; expected ${expected}`);
  }
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness texture mipLevelCount=${actual} size=4x4 format=rgba8unorm`,
  );
}

function assertMetallicRoughnessTextureUvTransform(tape) {
  if (metallicRoughnessTextureUvTransform === '') return;
  requireFalsifyChoice(
    'VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_TRANSFORM',
    metallicRoughnessTextureUvTransform,
    ['0', '1'],
  );
  const expected =
    metallicRoughnessTextureUvTransform === '1' ? [0.25, 0.25, 0, 0, 0, 0, 1, 1] : [0, 0, 1, 1, 0, 0, 1, 1];
  const actual = readMetallicRoughnessUvCoordinates(tape, 'metallic-roughness UV coordinates', expected);
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness UV transform offset=${actual[0]},${actual[1]} scale=${actual[2]},${actual[3]} set=${actual[4]} rotation=${actual[5]} textureScale=${actual[6]},${actual[7]}`,
  );
}

function assertMetallicRoughnessTextureUvSet(tape) {
  if (metallicRoughnessTextureUvSet === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE_UV_SET', metallicRoughnessTextureUvSet, [
    '0',
    '1',
  ]);
  const expected = metallicRoughnessTextureUvSet === '1' ? [0, 0, 1, 1, 1, 0, 1, 1] : [0, 0, 1, 1, 0, 0, 1, 1];
  const actual = readMetallicRoughnessUvCoordinates(tape, 'metallic-roughness UV set', expected);
  console.log(
    `[learn-render 2.1 colors] tape metallic-roughness UV set=${actual[4]} offset=${actual[0]},${actual[1]} scale=${actual[2]},${actual[3]} rotation=${actual[5]} textureScale=${actual[6]},${actual[7]}`,
  );
}

function assertMetallicChannel(tape) {
  if (metallicChannel === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_METALLIC_CHANNEL', metallicChannel, ['0', '2']);
  assertStandardMaterialUboScalar(tape, 'metallicChannel', 'metallic channel', 6, Number.parseInt(metallicChannel, 10));
}

function assertRoughnessChannel(tape) {
  if (roughnessChannel === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_ROUGHNESS_CHANNEL', roughnessChannel, ['1', '2']);
  assertStandardMaterialUboScalar(
    tape,
    'roughnessChannel',
    'roughness channel',
    7,
    Number.parseInt(roughnessChannel, 10),
  );
}

function assertClearcoat(tape) {
  if (clearcoat === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_CLEARCOAT', clearcoat, ['0', '1']);
  assertStandardMaterialUboScalar(tape, 'clearcoat', 'clearcoat', 18, Number.parseFloat(clearcoat));
}

function assertEmissiveIntensity(tape) {
  if (emissiveIntensity === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_EMISSIVE_INTENSITY', emissiveIntensity, ['0', '1']);
  assertStandardMaterialUboScalar(
    tape,
    'emissiveIntensity',
    'emissive intensity',
    15,
    Number.parseFloat(emissiveIntensity),
  );
}

function assertOcclusionStrength(tape) {
  if (occlusionStrength === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_OCCLUSION_STRENGTH', occlusionStrength, ['0', '1']);
  assertStandardMaterialUboScalar(
    tape,
    'occlusionStrength',
    'occlusion strength',
    16,
    Number.parseFloat(occlusionStrength),
  );
}

function assertAlphaCutoff(tape) {
  if (alphaCutoff === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_ALPHA_CUTOFF', alphaCutoff, ['0', '1']);
  assertStandardMaterialUboScalar(tape, 'alphaCutoff', 'alpha cutoff', 17, Number.parseFloat(alphaCutoff) * 0.5);
}

function assertClearcoatRoughness(tape) {
  if (clearcoatRoughness === '') return;
  requireFalsifyChoice('VITE_FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS', clearcoatRoughness, ['0.5', '1']);
  assertStandardMaterialUboScalar(
    tape,
    'clearcoatRoughness',
    'clearcoat roughness',
    19,
    Number.parseFloat(clearcoatRoughness),
  );
}

function assertFalsifiedTape({ tape }) {
  assertBaseColorTextureAlpha(tape);
  assertBaseColorSamplerMaxAnisotropy(tape);
  assertBaseColorSamplerAddress(tape);
  assertBaseColorSamplerMagFilter(tape);
  assertBaseColorSamplerMinFilter(tape);
  assertBaseColorSamplerMipmapFilter(tape);
  assertBaseColorSamplerLodMaxClamp(tape);
  assertBaseColorSamplerLodMinClamp(tape);
  assertBaseColorTextureMipmap(tape);
  assertBaseColorTextureSrgb(tape);
  assertMetallicRoughnessSampler(tape);
  assertMetallicRoughnessSamplerMagFilter(tape);
  assertMetallicRoughnessSamplerMinFilter(tape);
  assertMetallicRoughnessSamplerMipmapFilter(tape);
  assertMetallicRoughnessSamplerAddress(tape);
  assertMetallicRoughnessSamplerLodMinClamp(tape);
  assertMetallicRoughnessSamplerLodMaxClamp(tape);
  assertMetallicRoughnessSamplerMaxAnisotropy(tape);
  assertMetallicRoughnessTextureMipmap(tape);
  assertMetallicRoughnessTextureUvTransform(tape);
  assertMetallicRoughnessTextureUvSet(tape);
  assertMetallicChannel(tape);
  assertRoughnessChannel(tape);
  assertClearcoat(tape);
  assertEmissiveIntensity(tape);
  assertOcclusionStrength(tape);
  assertAlphaCutoff(tape);
  assertClearcoatRoughness(tape);
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
  assertTape: falsifyValues.every((value) => value === '') ? undefined : assertFalsifiedTape,
});
