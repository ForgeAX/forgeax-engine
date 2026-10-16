// textures-srgb.dawn.test.ts -- vitest dawn project (AC-08 + AC-09 +
// AC-13 + AC-15 + AC-17 (a)) sRGB / linear consistency reverse-case
// proof for LearnOpenGL section 1.4 (M8 milestone, plan-strategy
// section 7 / T-M8-01 red phase).
//
// Trigger: root vitest.config.ts `dawn` project (`*.dawn.test.ts`
// glob, see vitest.config.ts comment block). Environment: dawn-node
// native binding (vitest.setup-webgpu.ts injects globalThis.navigator
// .gpu before module evaluation).
//
// Scope (T-M8-01 acceptanceCheck):
//   (a) AC-08 reverse case: hand-craft a TextureAsset with
//       `format='rgba8unorm-srgb'` paired with a DecodedImage carrying
//       `colorSpace='linear'`. AssetRegistry.uploadTexture must surface
//       `image-format-unsupported` ImageError + `.detail
//       .formatColorSpaceConflict = { format, colorSpace, expected }`
//       (charter P3 explicit failure -- the reverse of LO 1.4 wood-
//       container which authors srgb / srgb).
//   (b) Mirror inverted reverse case: format='rgba8unorm' (linear) +
//       decoded.colorSpace='srgb'. Same ImageError code, expected='linear'.
//   (c) AC-08 happy path: format='rgba8unorm-srgb' + decoded srgb
//       passes the consistency assertion (no GPU device wired in this
//       test so uploadTexture short-circuits to Result.ok(undefined),
//       which is the M3 milestone deferred-upload behaviour). The M5
//       smoke harness (T-M8-02) covers the actual GPU pipeline.
//
// Why this lives in the textures app, not packages/runtime: the
// section 1.4 example imports `@forgeax/engine-image` + `@forgeax/
// engine-runtime` together; this test asserts the joined surface
// remains audible at the application layer (charter P5 producer /
// consumer split: subagent runs the test, orchestrator reads the
// failure mode JSON).

import type { DecodedImage, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';


import { GpuResidencyCache } from '../../../../../../packages/render/src/device/gpu-residency';
import { toShared } from '@forgeax/engine-types';

function makeWoodTexture(format: GPUTextureFormat, colorSpace: 'srgb' | 'linear'): TextureAsset {
  // Hand-crafted 1x1 SaddleBrown stand-in for the consistency-assertion
  // plumbing. The real LO 1.4 container.jpg lives in the
  // forgeax-engine-assets submodule and is exercised by
  // textures-pixel.dawn.test.ts; this reverse-case test does not need
  // the actual bytes.
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format,
    data: new Uint8Array([139, 69, 19, 255]), // SaddleBrown wood-ish
    colorSpace,
    mips: { kind: 'none' },
  } as unknown as TextureAsset;
}

function makeDecodedWood(colorSpace: 'srgb' | 'linear'): DecodedImage {
  return {
    bytes: new Uint8Array([139, 69, 19, 255]),
    width: 1,
    height: 1,
    mime: 'image/jpeg',
    colorSpace,
    mipmap: false,
  };
}

describe('learn-render section 1.4 textures sRGB / linear consistency (AC-08 + AC-17 (a))', () => {
  it('AC-08 reverse: format=rgba8unorm-srgb + decoded colorSpace=linear emits image-format-unsupported', async () => {
    // feat-20260601-gpu-residency-extraction M1: the format <-> colorSpace
    // consistency assertion lives in GpuResidencyCache.uploadTexture; the POD
    // carries the format, the decoded image carries colorSpace (D-2).
    const store = new GpuResidencyCache();
    const pod = makeWoodTexture('rgba8unorm-srgb', 'srgb');
    const handle = toShared<'TextureAsset'>(1);
    const decoded = makeDecodedWood('linear');
    const res = await store.uploadTexture(handle, pod, decoded);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('image-format-unsupported');
    if (res.error.code !== 'image-format-unsupported') return;
    if (res.error.detail.code !== 'image-format-unsupported') return;
    expect(res.error.detail.formatColorSpaceConflict).toBeDefined();
    expect(res.error.detail.formatColorSpaceConflict?.format).toBe('rgba8unorm-srgb');
    expect(res.error.detail.formatColorSpaceConflict?.colorSpace).toBe('linear');
    expect(res.error.detail.formatColorSpaceConflict?.expected).toBe('srgb');
  });

  it('AC-08 reverse mirror: format=rgba8unorm + decoded colorSpace=srgb emits image-format-unsupported', async () => {
    const store = new GpuResidencyCache();
    const pod = makeWoodTexture('rgba8unorm', 'linear');
    const handle = toShared<'TextureAsset'>(1);
    const decoded = makeDecodedWood('srgb');
    const res = await store.uploadTexture(handle, pod, decoded);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('image-format-unsupported');
    if (res.error.code !== 'image-format-unsupported') return;
    if (res.error.detail.code !== 'image-format-unsupported') return;
    expect(res.error.detail.formatColorSpaceConflict?.format).toBe('rgba8unorm');
    expect(res.error.detail.formatColorSpaceConflict?.colorSpace).toBe('srgb');
    expect(res.error.detail.formatColorSpaceConflict?.expected).toBe('linear');
  });

  it('AC-08 happy: format=rgba8unorm-srgb + decoded colorSpace=srgb passes the assertion', async () => {
    const store = new GpuResidencyCache();
    const pod = makeWoodTexture('rgba8unorm-srgb', 'srgb');
    const handle = toShared<'TextureAsset'>(1);
    const decoded = makeDecodedWood('srgb');
    const res = await store.uploadTexture(handle, pod, decoded);
    // No GPU device wired (configureGpuDevice not called), so uploadTexture
    // short-circuits to Result.ok(undefined) after the consistency assertion.
    // The smoke harness covers the wired-device GPU upload path.
    expect(res.ok).toBe(true);
  });
});
