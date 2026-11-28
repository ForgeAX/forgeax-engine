import assert from 'node:assert/strict';
import { test } from 'node:test';
import { halfFloat } from '@forgeax/engine/math';
import type { TextureAsset } from '@forgeax/engine/types';
import { referenceTexture, type CloudTextureRole, type CloudTextureValues } from '../../../../forgeax-engine-assets/demo-assets/volumetric-clouds/assets/reference-textures.ts';
import { alpineGpuRecipe } from '../nubis/alpine-gpu.ts';
import { makeAlpineTexture } from '../nubis/alpine-textures.ts';
import { DAWN_SIZE } from '../nubis/dawn-textures.ts';
import { bakeCloudTextures, type CloudBake } from '../nubis/gpu-bake.ts';
import { nubisGpuRecipe } from '../nubis/nubis-gpu.ts';
import { NUBIS_MODES } from '../nubis/presets.ts';
import { referenceGpuRecipe } from '../nubis/reference-gpu.ts';
import { makeNubisTexture, NUBIS_ROLES } from '../nubis/textures.ts';

function compareTexels(actual: TextureAsset, expected: TextureAsset, name: string) {
  assert.deepEqual(actual.shape, expected.shape, name);
  assert.deepEqual(actual.mips, expected.mips, name);
  assert.equal(actual.colorSpace, expected.colorSpace, name);
  assert.equal(actual.format, expected.format, name);
  const output = actual.data;
  const baseline = expected.data;
  assert.ok(output instanceof Uint8Array && baseline instanceof Uint8Array, name);
  assert.equal(output.byteLength, baseline.byteLength, name);
  const half = actual.format === 'rgba16float';
  const stride = half ? 2 : 1;
  const a = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const b = new DataView(baseline.buffer, baseline.byteOffset, baseline.byteLength);
  let maxError = 0;
  for (let i = 0; i < output.byteLength; i += stride) {
    const difference = half ? halfFloat.f16ToF32(a.getUint16(i, true)) - halfFloat.f16ToF32(b.getUint16(i, true))
      : a.getUint8(i) - b.getUint8(i);
    maxError = Math.max(maxError, Math.abs(difference));
  }
  assert.ok(maxError <= (half ? 0.001 : 1), `${name}: maximum pixel error ${maxError}`);
}

function referenceBakeBaseline(role: CloudTextureRole, values: CloudTextureValues): TextureAsset {
  const texture = referenceTexture(role, values);
  if (role !== 'mask' && role !== 'body') return texture;

  // Generated Clouds packs the shared CPU reference's RGBA values into BGRA8.
  const half = role === 'body';
  assert.equal(texture.format, half ? 'rgba16float' : 'rgba8unorm');
  assert.ok(texture.data instanceof Uint8Array);
  const input = new DataView(texture.data.buffer, texture.data.byteOffset, texture.data.byteLength);
  const data = new Uint8Array(input.byteLength / (half ? 2 : 1));
  const channels = [2, 1, 0, 3] as const;
  for (let i = 0; i < data.length; i += 4) {
    for (const channel of channels) {
      const lane = i + channel;
      const value = half
        ? Math.round(255 * Math.max(0, Math.min(1, halfFloat.f16ToF32(input.getUint16(lane * 2, true)))))
        : input.getUint8(lane);
      data[i + channels[channel]] = value;
    }
  }
  return { ...texture, format: 'bgra8unorm', data };
}

// The ordinary unit suite runs without GPU access. This verifies the real GPU path on demand.
test('hardware cloud bakes preserve all twenty cooked texture contracts and channel values', {
  skip: process.env.VC_TEST_HARDWARE !== '1',
}, async () => {
  const values: CloudTextureValues = {
    seed: 0x4e554245, resolution: 'preview', patternFrequency: 8, patternCoverage: 0.5,
    maskFrequency: 4, maskContrast: 1, profileBaseOffset: 0, profileThickness: 1,
    profileSoftness: 0.15, bodyFrequency: 4, bodyWorleyMix: 0.5, bodyDetail: 0.35,
  };
  const recipes: Record<string, CloudBake> = {};
  const expected = new Map<string, () => TextureAsset>();
  function add(name: string, recipe: CloudBake, baseline: () => TextureAsset) {
    recipes[name] = recipe;
    expected.set(name, baseline);
  }
  for (const role of NUBIS_ROLES) {
    const size = role === 'body-noise' ? 24 : 64;
    for (const mode of NUBIS_MODES) {
      // Exercise the shipped weather resampling and 3D cellular grid for the sunrise set.
      const bakeSize = mode === 'nubis-dawn' ? DAWN_SIZE[role] : size;
      add(`${mode}/${role}`, nubisGpuRecipe(mode, role, bakeSize), () => makeNubisTexture(mode, role, bakeSize));
    }
    add(`alpine/${role}`, alpineGpuRecipe(role, size), () => makeAlpineTexture(role, size));
  }
  for (const role of ['pattern', 'mask', 'profile', 'body'] satisfies CloudTextureRole[]) {
    add(`generated/${role}`, referenceGpuRecipe(role, values), () => referenceBakeBaseline(role, values));
  }
  const actual = await bakeCloudTextures(recipes);
  assert.equal(expected.size, 20);
  for (const [name, baseline] of expected) compareTexels(actual[name]!, baseline(), name);
});
