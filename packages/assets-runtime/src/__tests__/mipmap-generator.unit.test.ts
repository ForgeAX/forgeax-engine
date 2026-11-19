// @forgeax/engine-assets-runtime -- mipmap-generator coverage (fix issue #709).
// numMipLevels formula + per-device pipeline cache + generateMipmaps (async
// build) + blitMipmapsSync (prewarmed) exercised against an in-memory device
// stub (no real GPU). Mirrors the runtime-project mipmap tests, but imports the
// relative `../mipmap-generator` so coverage attributes to src/, not dist/.

import { type RhiDevice, ok as rhiOk, type ShaderModule, type Texture } from '@forgeax/engine-rhi';
import { numMipLevels } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  blitMipmapsSync,
  encodeMipmaps,
  generateMipmaps,
  getOrCreateMipmapPipeline,
  type MipmapShaderModuleFactory,
  mipmapCacheSize,
  mipmapTemporaryByteLength,
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

function makeBlitDevice(
  renderPasses?: unknown[],
  log?: BlitLog,
  backendKind: RhiDevice['caps']['backendKind'] = 'webgpu',
): RhiDevice {
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
    caps: { backendKind },
    createSampler: () => ok({ tag: `sampler-${nextId++}` }),
    createBindGroupLayout: () => ok({ tag: `bgl-${nextId++}` }),
    createPipelineLayout: () => ok({ tag: `pl-${nextId++}` }),
    createRenderPipeline: (desc: { fragment?: { targets?: ReadonlyArray<{ format?: string }> } }) =>
      ok({ tag: `pipeline-${nextId++}`, format: desc.fragment?.targets?.[0]?.format }),
    createTexture: () => ok({ tag: `tex-${nextId++}` }),
    createBindGroup: () => ok({ tag: `bg-${nextId++}` }),
    createTextureView: (texture: unknown, desc: { baseMipLevel: number }) =>
      ok({ tag: `view-${nextId++}`, texture, ...desc }),
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
  it.each([
    'webgpu',
    'wgpu-webgl2',
  ] as const)('keeps LOD-zero clamping scoped to WebGL2 (%s)', async (backendKind) => {
    const base = makeBlitDevice();
    const device = { ...base, caps: { ...base.caps, backendKind } };
    const descriptors: unknown[] = [];
    device.createSampler = (desc) => {
      descriptors.push(desc);
      return base.createSampler(desc);
    };
    expect((await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory)).ok).toBe(
      true,
    );
    expect(descriptors).toHaveLength(1);
    if (backendKind === 'wgpu-webgl2') expect(descriptors[0]).toHaveProperty('lodMaxClamp', 0);
    else expect(descriptors[0]).not.toHaveProperty('lodMaxClamp');
  });

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
  for (const backendKind of ['webgpu', 'wgpu-native'] as const)
    it.each([
      1, 4, 6,
    ])(`writes disjoint mips of every layer without scratch/copies (${backendKind}, %i layers)`, async (arrayLayerCount) => {
      const renderPasses: unknown[] = [];
      const log: BlitLog = { copies: [], destroyed: [] };
      const device = makeBlitDevice(renderPasses, log, backendKind);
      await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
      const allocations = vi.spyOn(device, 'createTexture');
      const groups = vi.spyOn(device, 'createBindGroup');
      const texture = {} as Texture;
      blitMipmapsSync(device, texture, {
        format: 'rgba8unorm',
        width: 8,
        height: 2,
        arrayLayerCount,
      }).unwrap();
      expect(renderPasses).toHaveLength(3 * arrayLayerCount);
      expect(log.copies).toEqual([]);
      expect(log.destroyed).toEqual([]);
      expect(allocations).not.toHaveBeenCalled();
      for (let layer = 0; layer < arrayLayerCount; layer++)
        for (let level = 1; level < 4; level++) {
          const index = layer * 3 + level - 1;
          expect(renderPasses[index]).toMatchObject({
            colorAttachments: [
              {
                view: {
                  texture,
                  baseMipLevel: level,
                  mipLevelCount: 1,
                  baseArrayLayer: layer,
                  arrayLayerCount: 1,
                  dimension: '2d',
                },
              },
            ],
          });
          const input = groups.mock.calls[index]?.[0].entries.find((entry) => entry.binding === 1);
          expect(input?.resource).toMatchObject({
            kind: 'textureView',
            value: {
              texture,
              baseMipLevel: level - 1,
              mipLevelCount: 1,
              baseArrayLayer: layer,
              arrayLayerCount: 1,
              dimension: '2d',
            },
          });
        }
    });

  it.each([
    1, 4, 6,
  ])('retains physical WebGL2 staging and retires it (%i layers)', async (arrayLayerCount) => {
    const renderPasses: unknown[] = [];
    const log: BlitLog = { copies: [], destroyed: [] };
    const device = makeBlitDevice(renderPasses, log, 'wgpu-webgl2');
    await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
    const texture = {} as Texture;
    blitMipmapsSync(device, texture, {
      format: 'rgba8unorm',
      width: 8,
      height: 2,
      arrayLayerCount,
    }).unwrap();
    expect(renderPasses).toHaveLength(arrayLayerCount === 1 ? 4 : arrayLayerCount * 3);
    expect(log.copies).toHaveLength(arrayLayerCount === 1 ? 3 : arrayLayerCount * 4);
    expect(log.destroyed).toHaveLength(4);
    expect(log.destroyed).not.toContain(texture);
    for (const pass of renderPasses) {
      const view = (pass as { colorAttachments: Array<{ view: { texture: unknown } }> })
        .colorAttachments[0]?.view;
      expect(view?.texture).not.toBe(texture);
    }
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

describe('normal-roughness mip ownership', () => {
  it.each([
    'webgpu',
    'wgpu-webgl2',
  ] as const)('retains transient means until caller cleanup on %s', async (backend) => {
    const passes: unknown[] = [],
      log: BlitLog = { copies: [], destroyed: [] };
    const device = makeBlitDevice(passes, log, backend);
    const factory = vi.fn(async () => rhiOk({} as ShaderModule));
    await Promise.all(
      [0, 1].map(() =>
        getOrCreateMipmapPipeline(device, 'rgba8unorm', factory, 'normal-roughness'),
      ),
    );
    expect(factory).toHaveBeenCalledTimes(2); // Shared box module plus one lazy normal module.
    expect(mipmapCacheSize(device)).toBe(2);
    const texture = {} as Texture;
    const command = device.createCommandEncoder();
    if (!command.ok) throw command.error;
    const encoder = command.value;
    const encoded = encodeMipmaps(device, encoder, texture, {
      format: 'rgba8unorm',
      width: 8,
      height: 4,
      levels: 4,
      arrayLayerCount: 2,
      filter: 'normal-roughness',
    });
    expect(encoded.ok).toBe(true);
    expect(passes).toHaveLength(6);
    expect(log.destroyed).toHaveLength(0);
    encoded.unwrap()();
    encoded.unwrap()();
    expect(log.destroyed).toHaveLength(backend === 'webgpu' ? 3 : 5);
    expect(new Set(log.destroyed).size).toBe(log.destroyed.length);
    expect(log.copies).toHaveLength(backend === 'webgpu' ? 0 : 4);
  });
  it('refuses an unsupported normal storage format without generating mips', async () => {
    const device = makeBlitDevice();
    const result = await getOrCreateMipmapPipeline(
      device,
      'rgba16float',
      async () => rhiOk({} as ShaderModule),
      'normal-roughness',
    );
    expect(result.ok).toBe(false);
  });
});

it('accounts for every normal mip temporary independently of array layer count', () => {
  const descriptor = {
    width: 8,
    height: 4,
    levels: 4,
    format: 'rgba8unorm' as const,
    filter: 'normal-roughness' as const,
    arrayLayerCount: 2,
  };
  expect(mipmapTemporaryByteLength(descriptor, 'webgpu')).toBe(88);
  expect(mipmapTemporaryByteLength(descriptor, 'wgpu-webgl2')).toBe(248);
  expect(mipmapTemporaryByteLength({ ...descriptor, arrayLayerCount: 100 }, 'wgpu-webgl2')).toBe(
    248,
  );
  expect(mipmapTemporaryByteLength({ ...descriptor, filter: 'box' }, 'webgpu')).toBe(0);
  expect(mipmapTemporaryByteLength({ ...descriptor, filter: 'box' }, 'wgpu-webgl2')).toBe(172);
});
