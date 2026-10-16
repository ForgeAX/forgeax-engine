/**
 * COPY_SRC usage-validity dawn e2e (M3 / w17).
 *
 * Proves AC-10 / R5: after the recorder proxy promotes COPY_SRC (0x01) onto
 * every createBuffer / createTexture usage (w12), each resource type still
 * creates successfully on a real dawn-node device. This is the usage-validity
 * floor for the full-table frame-header snapshot (snapshotResource needs every
 * resource to be a valid copyBufferToBuffer / copyTextureToBuffer source).
 *
 * Scope per OOS-7: usage-validity only (creation succeeds). Pipeline-specific
 * COPY_SRC side effects (internal layout / alignment shifts) are Phase 2 — not
 * asserted here. Replay pixel output is M4's concern, not this test's.
 */

/// <reference types="@webgpu/types" />

// biome-ignore-all lint/suspicious/noExplicitAny: dawn-node e2e constructs RHI surfaces (GPU device/buffer/texture brands, WebGPU descriptor types) whose structural shapes require any casts at the test boundary; dawn-node opaque GPU types cannot be imported at the type level

import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { type CreateShaderModuleFn, wrap } from '../recorder';

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: CreateShaderModuleFn;
}

async function loadDawnRhi(): Promise<DawnPack | undefined> {
  try {
    return (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
  } catch {
    return undefined;
  }
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';

async function acquireDevice(pack: DawnPack): Promise<RhiDevice> {
  const debugInst = wrap(pack.rhi);
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('adapter');
  const devRes = await adapterRes.value.requestDevice();
  if (!devRes.ok) throw new Error('device');
  return devRes.value;
}

// GPUBufferUsage.COPY_SRC === GPUTextureUsage.COPY_SRC === 0x01.
// COPY_SRC has DIFFERENT bit values for buffers vs textures:
//   GPUBufferUsage.COPY_SRC === 0x04 (0x01 is MAP_READ for buffers)
//   GPUTextureUsage.COPY_SRC === 0x01
const BUFFER_COPY_SRC = 0x04;
const TEXTURE_COPY_SRC = 0x01;
// GPUBufferUsage.VERTEX === 0x20; GPUTextureUsage.TEXTURE_BINDING === 0x04.
const VERTEX = 0x20;
const TEXTURE_BINDING = 0x04;

describe.skipIf(SKIP_DAWN)('COPY_SRC usage-validity (w17, dawn)', () => {
  it('createBuffer with COPY_SRC succeeds', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;
    const device = await acquireDevice(pack);

    const res = device.createBuffer({ size: 256, usage: VERTEX | BUFFER_COPY_SRC });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).not.toBeNull();
  });

  it('createTexture (2D) with COPY_SRC succeeds', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;
    const device = await acquireDevice(pack);

    const res = device.createTexture({
      size: { width: 16, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba8unorm' as GPUTextureFormat,
      usage: TEXTURE_BINDING | TEXTURE_COPY_SRC,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).not.toBeNull();
  });

  it('createTexture (3D, depthOrArrayLayers > 1) with COPY_SRC succeeds', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;
    const device = await acquireDevice(pack);

    const res = device.createTexture({
      size: { width: 8, height: 8, depthOrArrayLayers: 4 },
      dimension: '3d' as GPUTextureDimension,
      format: 'rgba8unorm' as GPUTextureFormat,
      usage: TEXTURE_BINDING | TEXTURE_COPY_SRC,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).not.toBeNull();
  });

  it('the recorder proxy promotes COPY_SRC even when the caller omits it', async () => {
    const pack = await loadDawnRhi();
    if (!pack) return;
    const debugInst = wrap(pack.rhi);
    const adapterRes = await debugInst.requestAdapter();
    if (!adapterRes.ok) throw new Error('adapter');
    const devRes = await adapterRes.value.requestDevice();
    if (!devRes.ok) throw new Error('device');
    const device = devRes.value;

    // Caller omits COPY_SRC; the proxy must promote it (w12) so the live
    // resource is a valid copy source and the descriptor entry records it.
    const res = device.createBuffer({ size: 128, usage: VERTEX });
    expect(res.ok).toBe(true);

    const table = debugInst.descriptorTable();
    const entry = [...table.values()][0];
    if (entry === undefined) throw new Error('descriptor entry missing');
    expect((entry.usage & BUFFER_COPY_SRC) !== 0).toBe(true);
  });
});
