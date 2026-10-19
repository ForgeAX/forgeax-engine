// @forgeax/engine-assets-runtime -- mipmap-generator coverage (fix issue #709).
// numMipLevels formula + per-device pipeline cache + generateMipmaps (async
// build) + blitMipmapsSync (prewarmed) exercised against an in-memory device
// stub (no real GPU). Mirrors the runtime-project mipmap tests, but imports the
// relative `../mipmap-generator` so coverage attributes to src/, not dist/.

import { type RhiDevice, ok as rhiOk, type ShaderModule, type Texture } from '@forgeax/engine-rhi';
import { numMipLevels } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  blitMipmapsSync,
  generateMipmaps,
  getOrCreateMipmapPipeline,
  type MipmapShaderModuleFactory,
  mipmapCacheSize,
  prepareMipmaps,
} from '../mipmap-generator';

let nextId = 0;
// Only the observed backend operations are supplied by this test fixture.
function ok<T>(value: T) {
  return { ok: true as const, value };
}

type BlitLog = {
  readonly copies: Array<{ source: unknown; destination: unknown; size: unknown }>;
  readonly destroyed: unknown[];
};

function makeBlitDevice(renderPasses?: unknown[], log?: BlitLog): RhiDevice {
  const pass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    draw: () => {},
    end: () => {},
  };
  const encoder = {
    beginRenderPass: (desc: unknown) => {
      renderPasses?.push(desc);
      return pass;
    },
    copyTextureToTexture: (source: unknown, destination: unknown, size: unknown) => {
      log?.copies.push({ source, destination, size });
    },
    finish: () => ok({ tag: `cmdbuf-${nextId++}` }),
  };
  return {
    createSampler: () => ok({ tag: `sampler-${nextId++}` }),
    createBindGroupLayout: () => ok({ tag: `bgl-${nextId++}` }),
    createPipelineLayout: () => ok({ tag: `pl-${nextId++}` }),
    createRenderPipeline: (desc: { fragment?: { targets?: ReadonlyArray<{ format?: string }> } }) =>
      ok({ tag: `pipeline-${nextId++}`, format: desc.fragment?.targets?.[0]?.format }),
    createTexture: () => ok({ tag: `tex-${nextId++}` }),
    createBindGroup: () => ok({ tag: `bg-${nextId++}` }),
    createTextureView: (texture: unknown, desc: { baseMipLevel: number }) =>
      ok({ tag: `view-${nextId++}`, texture, baseMipLevel: desc.baseMipLevel }),
    destroyTexture: (texture: unknown) => {
      log?.destroyed.push(texture);
      return ok(undefined);
    },
    createCommandEncoder: () => ok(encoder),
    queue: { submit: () => ok(undefined) },
  } as unknown as RhiDevice;
}

const stubShaderFactory: MipmapShaderModuleFactory = async () =>
  rhiOk({ tag: `shader-${nextId++}` } as unknown as ShaderModule);

describe('numMipLevels', () => {
  it('256x256 -> 9', () => expect(numMipLevels({ width: 256, height: 256 })).toBe(9));
  it('1x1 -> 1', () => expect(numMipLevels({ width: 1, height: 1 })).toBe(1));
  it('0x0 -> 1 (max<=1 guard)', () => expect(numMipLevels({ width: 0, height: 0 })).toBe(1));
  it('non-square 300x200 -> 9', () => expect(numMipLevels({ width: 300, height: 200 })).toBe(9));
  it('17x5 -> 5', () => expect(numMipLevels({ width: 17, height: 5 })).toBe(5));
});

describe('getOrCreateMipmapPipeline + mipmapCacheSize', () => {
  it('fresh device starts at cache size 0', () => {
    expect(mipmapCacheSize(makeBlitDevice())).toBe(0);
  });

  it('same format twice -> cache hit (identical pipeline, size 1)', async () => {
    const device = makeBlitDevice();
    const a = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const b = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).toBe(b.value);
    expect(mipmapCacheSize(device)).toBe(1);
  });

  it('different formats -> separate slots (size 2)', async () => {
    const device = makeBlitDevice();
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    await getOrCreateMipmapPipeline(device, 'rgba8unorm-srgb', stubShaderFactory);
    expect(mipmapCacheSize(device)).toBe(2);
  });

  it('two devices keep independent caches', async () => {
    const d1 = makeBlitDevice();
    const d2 = makeBlitDevice();
    const r1 = await getOrCreateMipmapPipeline(d1, 'rgba8unorm', stubShaderFactory);
    const r2 = await getOrCreateMipmapPipeline(d2, 'rgba8unorm', stubShaderFactory);
    if (!r1.ok || !r2.ok) throw new Error('expected ok');
    expect(r1.value).not.toBe(r2.value);
  });

  it('propagates a shader-module factory failure', async () => {
    const device = makeBlitDevice();
    const failing: MipmapShaderModuleFactory = async () =>
      ({ ok: false, error: { code: 'x' } }) as never;
    const res = await getOrCreateMipmapPipeline(device, 'rgba8unorm', failing);
    expect(res.ok).toBe(false);
  });
});

describe('generateMipmaps (async build path)', () => {
  it('returns ok immediately when levels <= 1', async () => {
    const device = makeBlitDevice();
    const res = await generateMipmaps(
      device,
      {} as Texture,
      { format: 'rgba8unorm', width: 1, height: 1 },
      stubShaderFactory,
    );
    expect(res.ok).toBe(true);
    expect(mipmapCacheSize(device)).toBe(0); // never built a pipeline
  });

  it('mipmap disabled by an explicit single level never builds or records a pass', async () => {
    const renderPasses: unknown[] = [];
    const device = makeBlitDevice(renderPasses);
    const res = await generateMipmaps(
      device,
      {} as Texture,
      { format: 'rgba8unorm', width: 256, height: 256, levels: 1 },
      stubShaderFactory,
    );

    expect(res.ok).toBe(true);
    expect(mipmapCacheSize(device)).toBe(0);
    expect(renderPasses).toHaveLength(0);
  });

  it('builds + blits the full mip chain for a 4x4 texture', async () => {
    const device = makeBlitDevice();
    const res = await generateMipmaps(
      device,
      {} as Texture,
      { format: 'rgba8unorm', width: 4, height: 4 },
      stubShaderFactory,
    );
    expect(res.ok).toBe(true);
    expect(mipmapCacheSize(device)).toBe(1);
  });

  it('uses the WebGPU GPUColor object shape for clear values', async () => {
    const renderPasses: unknown[] = [];
    const device = makeBlitDevice(renderPasses);
    const res = await generateMipmaps(
      device,
      {} as Texture,
      { format: 'rgba8unorm', width: 4, height: 4 },
      stubShaderFactory,
    );
    expect(res.ok).toBe(true);
    expect(renderPasses).toHaveLength(2);
    for (const pass of renderPasses) {
      const clearValue = (pass as { colorAttachments: Array<{ clearValue: unknown }> })
        .colorAttachments[0]?.clearValue;
      expect(clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    }

    const syncPasses: unknown[] = [];
    const syncDevice = makeBlitDevice(syncPasses);
    const prewarm = await getOrCreateMipmapPipeline(syncDevice, 'rgba8unorm', stubShaderFactory);
    expect(prewarm.ok).toBe(true);
    expect(
      blitMipmapsSync(syncDevice, {} as Texture, { format: 'rgba8unorm', width: 4, height: 4 }).ok,
    ).toBe(true);
    for (const pass of syncPasses) {
      const clearValue = (pass as { colorAttachments: Array<{ clearValue: unknown }> })
        .colorAttachments[0]?.clearValue;
      expect(clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    }
  });
});

describe('blitMipmapsSync (prewarmed path)', () => {
  it('never renders into the texture it samples and copies every level back', async () => {
    const renderPasses: unknown[] = [];
    const log: BlitLog = { copies: [], destroyed: [] };
    const device = makeBlitDevice(renderPasses, log);
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const texture = {} as Texture;
    const res = blitMipmapsSync(device, texture, { format: 'rgba8unorm', width: 8, height: 2 });
    expect(res.ok).toBe(true);
    expect(renderPasses).toHaveLength(3);
    for (const pass of renderPasses) {
      const view = (pass as { colorAttachments: Array<{ view: { texture: unknown } }> })
        .colorAttachments[0]?.view;
      expect(view?.texture).not.toBe(texture);
    }
    const scratch = log.copies[0]?.source as { texture: unknown } | undefined;
    expect(log.copies).toEqual([
      {
        source: { texture: scratch?.texture, mipLevel: 0 },
        destination: { texture, mipLevel: 1, origin: { x: 0, y: 0, z: 0 } },
        size: [4, 1, 1],
      },
      {
        source: { texture: scratch?.texture, mipLevel: 1 },
        destination: { texture, mipLevel: 2, origin: { x: 0, y: 0, z: 0 } },
        size: [2, 1, 1],
      },
      {
        source: { texture: scratch?.texture, mipLevel: 2 },
        destination: { texture, mipLevel: 3, origin: { x: 0, y: 0, z: 0 } },
        size: [1, 1, 1],
      },
    ]);
    expect(log.destroyed).toEqual([scratch?.texture]);
  });

  it('shares one scratch texture across all array layers', async () => {
    const renderPasses: unknown[] = [];
    const log: BlitLog = { copies: [], destroyed: [] };
    const device = makeBlitDevice(renderPasses, log);
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const texture = {} as Texture;
    blitMipmapsSync(device, texture, {
      format: 'rgba8unorm',
      width: 8,
      height: 2,
      arrayLayerCount: 4,
    }).unwrap();
    expect(renderPasses).toHaveLength(12);
    expect(log.destroyed).toHaveLength(1);
    expect(
      new Set(log.copies.map((copy) => (copy.source as { texture: unknown }).texture)),
    ).toEqual(new Set(log.destroyed));
    for (let layer = 0; layer < 4; layer++)
      for (let mipLevel = 1; mipLevel < 4; mipLevel++)
        expect(log.copies[layer * 3 + mipLevel - 1]?.destination).toEqual({
          texture,
          mipLevel,
          origin: { x: 0, y: 0, z: layer },
        });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid array layer count %s before recording a blit', async (arrayLayerCount) => {
    const renderPasses: unknown[] = [];
    const device = makeBlitDevice(renderPasses);
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    expect(
      blitMipmapsSync(device, {} as Texture, {
        format: 'rgba8unorm',
        width: 4,
        height: 4,
        arrayLayerCount,
      }),
    ).toMatchObject({ ok: false, error: { code: 'webgpu-runtime-error' } });
    expect(renderPasses).toHaveLength(0);
  });

  it('prepares mip work without finishing or submitting', async () => {
    let finishCount = 0;
    let submitCount = 0;
    const device = makeBlitDevice();
    const originalEncoder = device.createCommandEncoder;
    device.createCommandEncoder = () => {
      const result = originalEncoder();
      if (!result.ok) return result;
      const encoder = result.value as { finish: () => unknown };
      const finish = encoder.finish;
      encoder.finish = () => {
        finishCount += 1;
        return finish();
      };
      return result;
    };
    device.queue.submit = () => {
      submitCount += 1;
      return rhiOk(undefined);
    };
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const prepared = prepareMipmaps(device, {} as Texture, {
      format: 'rgba8unorm',
      width: 4,
      height: 4,
    });
    expect(prepared.ok).toBe(true);
    expect(finishCount).toBe(0);
    expect(submitCount).toBe(0);
    if (!prepared.ok) return;
    const finished = prepared.value.finish();
    expect(finished.ok).toBe(true);
    expect(finishCount).toBe(1);
    expect(submitCount).toBe(0);
  });

  it('returns ok immediately when levels <= 1', () => {
    const res = blitMipmapsSync(makeBlitDevice(), {} as Texture, {
      format: 'rgba8unorm',
      width: 1,
      height: 1,
    });
    expect(res.ok).toBe(true);
  });

  it('errors when the device cache was never prewarmed', () => {
    const res = blitMipmapsSync(makeBlitDevice(), {} as Texture, {
      format: 'rgba8unorm',
      width: 4,
      height: 4,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('rhi-not-available');
  });

  it('errors when the requested format was not prewarmed', async () => {
    const device = makeBlitDevice();
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const res = blitMipmapsSync(device, {} as Texture, {
      format: 'bgra8unorm',
      width: 4,
      height: 4,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('rhi-not-available');
  });

  it('blits the full chain once the format is prewarmed', async () => {
    const device = makeBlitDevice();
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const res = blitMipmapsSync(device, {} as Texture, {
      format: 'rgba8unorm',
      width: 8,
      height: 8,
    });
    expect(res.ok).toBe(true);
  });
});
