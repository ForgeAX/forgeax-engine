import type { RhiInstance } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { BootstrapResource, Tape, TapeBlob } from '../protocol/types';
import type { ReplayBackend } from '../replay/session';
import { openReplay } from '../replay/session';
import { READBACK_MATRIX_CASES } from './readback-matrix-fixture';

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: ReplayBackend['createShaderModule'];
}

async function loadDawn(): Promise<DawnPack> {
  return (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';

function colorResource(): BootstrapResource {
  return {
    handleId: 'texture:color',
    kind: 'texture',
    create: {
      kind: 'createTexture',
      handleId: 'texture:color',
      desc: {
        size: { width: 4, height: 4, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
        usage: 1,
      },
    },
    initialData: [],
  };
}

function depthResource(
  handleId: string,
  format: 'depth24plus' | 'depth24plus-stencil8' | 'depth32float',
): BootstrapResource {
  return {
    handleId,
    kind: 'texture',
    create: {
      kind: 'createTexture',
      handleId,
      desc: {
        size: { width: 4, height: 4, depthOrArrayLayers: 1 },
        format,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
        usage: 0x15,
      },
    },
    initialData: [],
  };
}

function matrixTextureResource(): BootstrapResource {
  return {
    handleId: 'texture:matrix',
    kind: 'texture',
    create: {
      kind: 'createTexture',
      handleId: 'texture:matrix',
      desc: {
        size: { width: 2, height: 2, depthOrArrayLayers: 12 },
        format: 'rgba8unorm',
        dimension: '2d',
        mipLevelCount: 2,
        sampleCount: 1,
        usage: 0x1f,
      },
    },
    initialData: [{ hash: 'matrix-texture', byteOffset: 0, byteLength: 240 }],
  };
}

function matrixBlob(): TapeBlob {
  return {
    hash: 'matrix-texture',
    bytes: Uint8Array.from({ length: 240 }, (_, index) => index),
    compression: 'none',
  };
}

describe.skipIf(SKIP_DAWN)('Dawn replay-owned readback matrix', () => {
  it('enumerates the canonical descriptor and subresource matrix', () => {
    expect(READBACK_MATRIX_CASES).toEqual([
      { format: 'rgba8unorm', dimension: '2d', aspect: 'all' },
      { format: 'depth32float', dimension: '2d', aspect: 'depth-only' },
      { format: 'depth24plus', dimension: '2d', aspect: 'depth-only' },
      { format: 'depth24plus-stencil8', dimension: '2d', aspect: 'stencil-only' },
      { format: 'rgba8unorm', dimension: '2d-array', aspect: 'all' },
      { format: 'rgba8unorm', dimension: 'cube', aspect: 'all' },
      { format: 'rgba8unorm', dimension: 'cube-array', aspect: 'all' },
    ]);
  });

  it('reads a color subresource on a fresh Dawn device', async () => {
    const pack = await loadDawn();
    const adapter = await pack.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) throw new Error(`Dawn admission failed: ${adapter.error.code}`);
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) throw new Error(`Dawn device admission failed: ${device.error.code}`);

    const tape: Tape = {
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
      bootstrap: [colorResource()],
      events: [],
      blobs: [],
    };
    const replay = await openReplay(tape, {
      device: device.value,
      createShaderModule: pack.createShaderModule,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    const pixels = await replay.value.readResource('texture:color', {
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'all',
    });
    expect(pixels.ok).toBe(true);
    if (!pixels.ok) throw new Error(pixels.error.hint);
    expect(pixels.value.bytes.byteLength).toBe(4 * 4 * 4);
    expect(pixels.value.provenance).toEqual({
      generation: replay.value.generation,
      resourceId: 'texture:color',
      subresource: { mipLevel: 0, arrayLayer: 0, aspect: 'all' },
    });
  });

  it.each([0x0c, 0x84, 0x184])('reads seeded buffer bytes for captured usage %i', async (usage) => {
    const pack = await loadDawn();
    const adapter = await pack.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) throw new Error(`Dawn admission failed: ${adapter.error.code}`);
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) throw new Error(`Dawn device admission failed: ${device.error.code}`);
    const replay = await openReplay(
      {
        header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 1 },
        bootstrap: [
          {
            handleId: 'buffer:known',
            kind: 'buffer',
            create: {
              kind: 'createBuffer',
              handleId: 'buffer:known',
              desc: { size: 8, usage },
            },
            initialData: [{ hash: 'buffer-known', byteOffset: 0, byteLength: 8 }],
          },
        ],
        events: [],
        blobs: [
          {
            hash: 'buffer-known',
            bytes: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
            compression: 'none',
          },
        ],
      },
      { device: device.value, createShaderModule: pack.createShaderModule },
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    const result = await replay.value.readResource('buffer:known', { offset: 2, size: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.hint);
    expect([...result.value.bytes]).toEqual([2, 3, 4, 5]);
    expect(result.value.provenance.subresource).toEqual({ offset: 2, size: 4 });
    await replay.value.dispose();
  });

  it('reads array, cube, cube-array, and view-local mip/layer subresources', async () => {
    const pack = await loadDawn();
    const adapter = await pack.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) throw new Error(`Dawn admission failed: ${adapter.error.code}`);
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) throw new Error(`Dawn device admission failed: ${device.error.code}`);
    const view = (handleId: string, dimension: string, baseArrayLayer: number, count: number) => ({
      handleId,
      kind: 'texture-view' as const,
      create: {
        kind: 'createTextureView',
        sourceHandleId: 'texture:matrix',
        resultHandleId: handleId,
        desc: {
          dimension,
          baseMipLevel: 1,
          mipLevelCount: 1,
          baseArrayLayer,
          arrayLayerCount: count,
        },
      },
      initialData: [],
    });
    const replay = await openReplay(
      {
        header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 1 },
        bootstrap: [
          matrixTextureResource(),
          view('view:array', '2d-array', 4, 2),
          view('view:cube', 'cube', 0, 6),
          view('view:cube-array', 'cube-array', 0, 12),
        ],
        events: [],
        blobs: [matrixBlob()],
      },
      { device: device.value, createShaderModule: pack.createShaderModule },
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    const arrayResult = await replay.value.readResource('view:array', {
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'all',
    });
    expect(arrayResult.ok).toBe(true);
    if (!arrayResult.ok) throw new Error(arrayResult.error.hint);
    expect(arrayResult.value.width).toBe(1);
    expect(arrayResult.value.height).toBe(1);
    expect([...arrayResult.value.bytes]).toEqual([96, 97, 98, 99]);
    // Omitting a request means local mip/layer zero, not texture mip/layer zero.
    const defaultResult = await replay.value.readResource('view:array');
    expect(defaultResult.ok).toBe(true);
    if (!defaultResult.ok) throw new Error(defaultResult.error.hint);
    expect(defaultResult.value.width).toBe(1);
    expect(defaultResult.value.height).toBe(1);
    expect([...defaultResult.value.bytes]).toEqual([...arrayResult.value.bytes]);
    const cubeResult = await replay.value.readResource('view:cube', {
      mipLevel: 0,
      arrayLayer: 5,
      aspect: 'all',
    });
    expect(cubeResult.ok).toBe(true);
    if (!cubeResult.ok) throw new Error(cubeResult.error.hint);
    expect(cubeResult.value.provenance.subresource).toEqual({
      mipLevel: 0,
      arrayLayer: 5,
      aspect: 'all',
    });
    const cubeArrayResult = await replay.value.readResource('view:cube-array', {
      mipLevel: 0,
      arrayLayer: 11,
      aspect: 'all',
    });
    expect(cubeArrayResult.ok).toBe(true);
    if (!cubeArrayResult.ok) throw new Error(cubeArrayResult.error.hint);
    expect([...cubeArrayResult.value.bytes]).toEqual([236, 237, 238, 239]);
    await replay.value.dispose();
  });

  it('reads depth32float through the direct depth aspect path', async () => {
    const pack = await loadDawn();
    const adapter = await pack.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) throw new Error(`Dawn admission failed: ${adapter.error.code}`);
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) throw new Error(`Dawn device admission failed: ${device.error.code}`);
    const replay = await openReplay(
      {
        header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
        bootstrap: [depthResource('texture:depth32', 'depth32float')],
        events: [],
        blobs: [],
      },
      { device: device.value, createShaderModule: pack.createShaderModule },
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    const result = await replay.value.readResource('texture:depth32', {
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'depth-only',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.hint);
    expect(result.value.bytes.byteLength).toBe(4 * 4 * 4);
    expect(result.value.provenance.subresource).toEqual({
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'depth-only',
    });
    await replay.value.dispose();
  });

  it('reads depth24plus through the replay-owned depth-to-color blit', async () => {
    const pack = await loadDawn();
    const adapter = await pack.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) throw new Error(`Dawn admission failed: ${adapter.error.code}`);
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) throw new Error(`Dawn device admission failed: ${device.error.code}`);

    const replay = await openReplay(
      {
        header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
        bootstrap: [depthResource('texture:depth24plus', 'depth24plus')],
        events: [],
        blobs: [],
      },
      { device: device.value, createShaderModule: pack.createShaderModule },
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    const pixels = await replay.value.readResource('texture:depth24plus', {
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'depth-only',
    });
    expect(pixels.ok).toBe(true);
    if (!pixels.ok) throw new Error(pixels.error.hint);
    expect(pixels.value.bytes.byteLength).toBe(4 * 4 * 4);
    expect([...new Float32Array(pixels.value.bytes.buffer)]).toHaveLength(16);
    expect(pixels.value.provenance.resourceId).toBe('texture:depth24plus');
    expect(pixels.value.provenance.subresource).toEqual({
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'depth-only',
    });
    await replay.value.dispose();
  });

  it('reads both explicit planes on depth24plus-stencil8', async () => {
    const pack = await loadDawn();
    const adapter = await pack.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) throw new Error(`Dawn admission failed: ${adapter.error.code}`);
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) throw new Error(`Dawn device admission failed: ${device.error.code}`);

    const replay = await openReplay(
      {
        header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
        bootstrap: [depthResource('texture:stencil', 'depth24plus-stencil8')],
        events: [],
        blobs: [],
      },
      { device: device.value, createShaderModule: pack.createShaderModule },
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    const depth = await replay.value.readResource('texture:stencil', {
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'depth-only',
    });
    expect(depth.ok).toBe(true);
    if (!depth.ok) throw new Error(depth.error.hint);
    expect(depth.value.bytes.byteLength).toBe(4 * 4 * 4);
    expect(depth.value.provenance.subresource).toEqual({
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'depth-only',
    });
    const pixels = await replay.value.readResource('texture:stencil', {
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'stencil-only',
    });
    expect(pixels.ok).toBe(true);
    if (!pixels.ok) throw new Error(pixels.error.hint);
    expect(pixels.value.bytes.byteLength).toBe(4 * 4);
    expect(pixels.value.provenance.subresource).toEqual({
      mipLevel: 0,
      arrayLayer: 0,
      aspect: 'stencil-only',
    });
    await replay.value.dispose();
  });
});
