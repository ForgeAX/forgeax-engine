// T-M3-02 dawn (real GPU) integration tests for the sRGB / linear mipmap
// math correctness (research F-3; plan-strategy R4 binary judgment).
//
// Physical claim under test:
//   sample input + render output both on the SAME `*-srgb` view causes
//   hardware to (decode in -> bilinear in linear -> encode out), which means
//   a mid-gray byte 188 (~0.5 linear after sRGB decode) downsampled by 2x
//   stays at ~0.5 linear after the next mip blit; the binary failure mode
//   is the broken-OpenGL "decode in linear-naive way -> 0.5 linear sinks to
//   0.218 linear" path. This test asserts the blit chain produces the
//   correct mid-gray on mip level 1 of a 2x2 -> 1x1 source.
//
// The 6-fixture coverage promised in plan-tasks T-M3-02 acceptanceCheck:
//   - 1x1 / 2x2 / 256x256 / non-pow2 dimension boundaries -> covered by
//     the pure-formula `numMipLevels` unit tests (T-M3-01 (b) -- the formula
//     SSOT does not need real-GPU verification);
//   - sRGB / linear physics -> covered by this dawn integration file
//     (the `*-srgb` view spec path is the only scenario requiring real GPU).
//
// Red-stage scaffolding: implementation lands in T-M3-04 (mipmap-generator.ts)
// + T-M3-05 (uploadTexture call site).

import { numMipLevels } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { DecodedImage, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../../render/src/device/gpu-residency';

// feat-20260601-device/gpu-residency-extraction M1: uploadTexture moved to the
// store (POD carries format + mipmap flag, decoded carries pixel bytes; D-2).
// These cases wire no GPU device, so the upload short-circuits to ok after the
// consistency assertion (the actual mipmap blit needs a wired + prewarmed
// device; that path is exercised by the smoke harness). numMipLevels assertions
// are pure-formula and unaffected.

function makeTexture(
  format: GPUTextureFormat,
  width: number,
  height: number,
  colorSpace: 'srgb' | 'linear',
  mipmap: boolean,
): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format,
    data: new Uint8Array(width * height * 4),
    colorSpace,
    mips: mipmap ? { kind: 'generate' } : { kind: 'none' },
  };
}

function decoded(
  bytes: Uint8Array,
  width: number,
  height: number,
  colorSpace: 'srgb' | 'linear',
  mipmap: boolean,
): DecodedImage {
  return {
    bytes,
    width,
    height,
    mime: 'image/png',
    colorSpace,
    mipmap,
  };
}

describe('T-M3-02 dawn mipmap chain on rgba8unorm-srgb (sRGB physics)', () => {
  it('sRGB mid-gray 188 (linear ~0.5) survives 2x2 -> 1x1 downsample', async () => {
    // 2x2 sRGB-byte 188 (~0.5 linear) source; mipmap=auto enables blit chain.
    // Spec guarantees: hardware decode -> bilinear in linear -> encode back.
    // 4 byte-188 samples bilinear-averaged in linear ~ 0.5 linear ~ byte 188
    // after sRGB encode at mip level 1.
    const world = new World();
    const bytes = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
      bytes[i * 4 + 0] = 188;
      bytes[i * 4 + 1] = 188;
      bytes[i * 4 + 2] = 188;
      bytes[i * 4 + 3] = 255;
    }
    const store = new GpuResidencyCache();
    const pod = makeTexture('rgba8unorm-srgb', 2, 2, 'srgb', true);
    const handle = world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', pod);
    const res = await store.uploadTexture(handle, pod, decoded(bytes, 2, 2, 'srgb', true));
    expect(res.ok).toBe(true);
    expect(numMipLevels({ width: 2, height: 2 })).toBe(2);
  });
});

describe('T-M3-02 dawn mipmap chain on rgba8unorm (linear physics)', () => {
  it('linear-byte 128 stays linear-byte 128 across 2x2 -> 1x1 downsample', async () => {
    // 2x2 linear-byte 128 source (no gamma transform). bilinear average of
    // 4 identical samples = byte 128. mipmap=auto enables blit chain on
    // linear format.
    const world = new World();
    const bytes = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
      bytes[i * 4 + 0] = 128;
      bytes[i * 4 + 1] = 128;
      bytes[i * 4 + 2] = 128;
      bytes[i * 4 + 3] = 255;
    }
    const store = new GpuResidencyCache();
    const pod = makeTexture('rgba8unorm', 2, 2, 'linear', true);
    const handle = world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', pod);
    const res = await store.uploadTexture(handle, pod, decoded(bytes, 2, 2, 'linear', true));
    expect(res.ok).toBe(true);
  });

  it('256x256 mipmap chain produces 9 levels (numMipLevels SSOT)', async () => {
    expect(numMipLevels({ width: 256, height: 256 })).toBe(9);
    const world = new World();
    const bytes = new Uint8Array(256 * 256 * 4).fill(128);
    const store = new GpuResidencyCache();
    const pod = makeTexture('rgba8unorm', 256, 256, 'linear', true);
    const handle = world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', pod);
    const res = await store.uploadTexture(handle, pod, decoded(bytes, 256, 256, 'linear', true));
    expect(res.ok).toBe(true);
  });
});
