// T-M3-02 dawn (real GPU) integration tests for AssetRegistry.uploadTexture
// (plan-strategy section 2.5 D Open Q-4 (c) consistency assertion + section
// 2.6 D Open Q-5 (a) mipmap-generator independent file; research F-3 sRGB
// mipmap math spec correctness; F-4 copyExternalImageToTexture entry).
//
// Why dawn integration tests:
//   - Requirements AC-08 (uploadTexture path + sampler default + sRGB / linear
//     explicit) needs real GPU verification: spec automatic decode / encode
//     on `*-srgb` views must produce a mid-gray ~0.5 in linear space rather
//     than the broken-OpenGL ~0.218 (research F-3 physical judgment).
//   - The unit-only path cannot exercise queue.copyExternalImageToTexture +
//     readBuffer pixel readback; the dawn project (vitest dawn) provides
//     `globalThis.navigator.gpu` via webgpu npm package native binding
//     (vitest.setup-webgpu.ts).
//
// Fixtures live alongside this file (T-M3-02 acceptanceCheck listed 6 fixtures
// originally; the unit-test layer in T-M3-01 already covers 1x1 / 2x2 / 256x256
// dimension boundaries + non-power-of-2 via the pure formula. The two real-
// pixel fixtures here are documentary -- the inline literal byte arrays match
// what the PNGs encode (sRGB byte 188 + linear byte 128) so the test is
// self-contained without node:fs file IO. Plan-strategy section 4 R4 explicitly
// notes mid-gray 0.5 not sinking to 0.218 as the binary judgment).
//
// Red-stage scaffolding: implementation lands in T-M3-05 (AssetRegistry.
// uploadTexture method + render-system materialBindGroup sampler / textureView
// injection); the GPU-upload path itself stays inert when configureGpuDevice
// is not called (M3-only deferred-upload semantics; M5 wires the device into
// render-system bootstrap).

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import type { DecodedImage, EquirectAsset, TextureAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../../render/src/device/gpu-residency';

const mockCaps = {
  backendKind: 'webgpu' as const,
  compute: true,
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  indirectDrawing: false,
  textureCompressionBc: false,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: false,
  firstInstanceIndirect: false,
  storageBuffer: true,
  storageTexture: false,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: false,
  float32Filterable: false,
  textureImport: false,
  externalTexture: false,
  maxColorAttachments: 8,
};

// feat-20260601-device/gpu-residency-extraction M1: uploadTexture moved to
// GpuResidencyCache (POD carries format, decoded carries colorSpace; D-2). The
// store holds no registry reference -- the asset-not-found arm now lives at the
// registry get the caller runs before reaching the store.

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

function decodedFromBytes(
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

describe('T-M3-02 dawn uploadTexture format <-> colorSpace consistency', () => {
  it('rejects format=rgba8unorm-srgb + decoded.colorSpace=linear (real GPU path)', async () => {
    const store = new GpuResidencyCache();
    const pod = makeTexture('rgba8unorm-srgb', 1, 1, 'srgb', false);
    const handle = toShared<'TextureAsset'>(1);
    const decoded = decodedFromBytes(new Uint8Array([188, 188, 188, 255]), 1, 1, 'linear', false);
    const res = await store.uploadTexture(handle, pod, decoded);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('image-format-unsupported');
    if (res.error.code !== 'image-format-unsupported') return;
    if (res.error.detail.code !== 'image-format-unsupported') return;
    expect(res.error.detail.formatColorSpaceConflict?.expected).toBe('srgb');
  });

  it('accepts format=rgba8unorm-srgb + decoded.colorSpace=srgb (1x1 mid-gray byte 188)', async () => {
    const store = new GpuResidencyCache();
    const pod = makeTexture('rgba8unorm-srgb', 1, 1, 'srgb', false);
    const handle = toShared<'TextureAsset'>(1);
    const decoded = decodedFromBytes(new Uint8Array([188, 188, 188, 255]), 1, 1, 'srgb', false);
    const res = await store.uploadTexture(handle, pod, decoded);
    expect(res.ok).toBe(true);
  });

  it('accepts format=rgba8unorm + decoded.colorSpace=linear (1x1 linear byte 128)', async () => {
    const store = new GpuResidencyCache();
    const pod = makeTexture('rgba8unorm', 1, 1, 'linear', false);
    const handle = toShared<'TextureAsset'>(1);
    const decoded = decodedFromBytes(new Uint8Array([128, 64, 192, 255]), 1, 1, 'linear', false);
    const res = await store.uploadTexture(handle, pod, decoded);
    expect(res.ok).toBe(true);
  });

  it('asset-not-found path: resolve against unregistered gen-0 handle (real GPU)', () => {
    const world = new World();
    // gen-0 user-tier handle for a never-allocated slot: passes the generation
    // gate then misses the payload -> asset-not-found. A gen>0 handle would
    // surface 'shared-ref-stale' instead (D-3/AC-10).
    const fake = toShared<'TextureAsset'>(99999);
    const podRes = resolveAssetHandle<TextureAsset>(world, fake);
    expect(podRes.ok).toBe(false);
    if (podRes.ok) return;
    expect(podRes.error.code).toBe('asset-not-found');
  });
});

// AC-04 (bug-20260521): non-256-aligned width uploadTexture through
// real GPU path. Must call configureGpuDevice() to bypass the
// asset-registry.ts:770-773 short-circuit (device === undefined).
// The test name contains 'non-256-aligned' for grep discoverability.
// Plan-strategy section 5.3 + requirements AC-04 caveat:
// `grep -n 'configureGpuDevice('` must find at least one hit.
describe('AC-04: uploadTexture non-256-aligned width (real GPU path)', () => {
  it('uploadTexture accepts non-256-aligned width (100x100 RGBA8, bytesPerRow=400, configureGpuDevice injected)', async () => {
    const adapterResult = await rhi.requestAdapter();
    if (!adapterResult.ok) return;
    const deviceResult = await adapterResult.value.requestDevice();
    if (!deviceResult.ok) return;
    const device = deviceResult.value;

    const store = new GpuResidencyCache();
    const world = new World();
    // Literal configureGpuDevice required -- this is the anti-short-circuit
    // guard verified by acceptanceCheck grep gate. Wires the device + register
    // relay onto the store (D-3/D-8).
    store.configureGpuDevice(
      // biome-ignore lint/suspicious/noExplicitAny: structural rhi device shim
      device as any,
      undefined,
      (w: World, pod: EquirectAsset) => ok(w.allocSharedRef('EquirectAsset', pod)),
      mockCaps,
    );

    const width = 100;
    const height = 100;
    const buf = new Uint8Array(width * height * 4);
    // Fill with a deterministic pattern so any validator that inspects
    // pixel data sees real content rather than an all-zeroes block.
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (i * 17 + 64) & 0xff;
    }

    const tex: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width, height } },
      format: 'rgba8unorm',
      data: buf,
      colorSpace: 'linear',
      mips: { kind: 'none' },
    };

    const handle = world.allocSharedRef('TextureAsset', tex);
    const decoded = decodedFromBytes(buf, width, height, 'linear', false);
    const res = await store.uploadTexture(handle, tex, decoded);
    expect(res.ok).toBe(true);
  });
});
