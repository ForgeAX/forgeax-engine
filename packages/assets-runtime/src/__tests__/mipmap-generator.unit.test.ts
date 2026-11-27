// @forgeax/engine-assets-runtime -- mipmap-generator coverage (fix issue #709).
// numMipLevels formula + per-device pipeline cache + generateMipmaps (async
// build) + blitMipmapsSync (prewarmed) exercised against an in-memory device
// stub (no real GPU). Mirrors the runtime-project mipmap tests, but imports the
// relative `../mipmap-generator` so coverage attributes to src/, not dist/.

import {
  type RhiDevice,
  RhiError,
  err as rhiErr,
  ok as rhiOk,
  type ShaderModule,
  type Texture,
} from '@forgeax/engine-rhi';
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

async function prewarmFormat(device: RhiDevice, format: GPUTextureFormat = 'rgba8unorm') {
  const result = await getOrCreateMipmapPipeline(device, format, stubShaderFactory);
  if (!result.ok) throw result.error;
  return result.value;
}

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

  it('owns one reusable pipeline per device and format', async () => {
    const first = makeBlitDevice();
    const second = makeBlitDevice();
    expect(mipmapCacheSize(first)).toBe(0);
    expect(mipmapCacheSize(second)).toBe(0);
    const cached = await prewarmFormat(first);
    expect(await prewarmFormat(first)).toBe(cached);
    expect(mipmapCacheSize(first)).toBe(1);
    expect(await prewarmFormat(first, 'rgba8unorm-srgb')).not.toBe(cached);
    expect(mipmapCacheSize(first)).toBe(2);
    expect(await prewarmFormat(second)).not.toBe(cached);
    expect(mipmapCacheSize(second)).toBe(1);
  });

  it('propagates a shader-module factory failure', async () => {
    const device = makeBlitDevice();
    const failing: MipmapShaderModuleFactory = async () =>
      ({ ok: false, error: { code: 'x' } }) as never;
    const res = await getOrCreateMipmapPipeline(device, 'rgba8unorm', failing);
    expect(res.ok).toBe(false);
  });
});

describe('mipmap recording', () => {
  it.each([
    ['implicit', { format: 'rgba8unorm', width: 1, height: 1 }],
    ['explicit', { format: 'rgba8unorm', width: 256, height: 256, levels: 1 }],
  ] as const)('skips %s single-level mipmaps without any pipeline or render pass', async (_mode, input) => {
    const passes: unknown[] = [];
    const device = makeBlitDevice(passes);
    (await generateMipmaps(device, {} as Texture, input, stubShaderFactory)).unwrap();
    blitMipmapsSync(device, {} as Texture, input).unwrap();
    expect(mipmapCacheSize(device)).toBe(0);
    expect(passes).toHaveLength(0);
  });

  it.each([
    'async',
    'prewarmed',
  ] as const)('records the complete %s chain with WebGPU clear values', async (mode) => {
    const passes: Array<{ colorAttachments: Array<{ clearValue: unknown }> }> = [];
    const device = makeBlitDevice(passes);
    const target = {} as Texture;
    const input = { format: 'rgba8unorm', width: 4, height: 4 } as const;
    if (mode === 'async')
      (await generateMipmaps(device, target, input, stubShaderFactory)).unwrap();
    else {
      await prewarmFormat(device, input.format);
      blitMipmapsSync(device, target, input).unwrap();
    }
    expect(mipmapCacheSize(device)).toBe(1);
    expect(passes).toHaveLength(2);
    for (const pass of passes)
      expect(pass.colorAttachments[0]?.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
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

  it.each([
    false,
    true,
  ])('requires the specific format to be prewarmed (other format=%s)', async (prewarm) => {
    const device = makeBlitDevice();
    if (prewarm) await prewarmFormat(device);
    expect(
      blitMipmapsSync(device, {} as Texture, { format: 'bgra8unorm', width: 4, height: 4 }),
    ).toMatchObject({ ok: false, error: { code: 'rhi-not-available' } });
  });
});

it.each([
  'result',
  'throw',
] as const)('retains a real scratch destruction %s failure across repeated discard', async (mode) => {
  const device = makeBlitDevice();
  const failure = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'native scratch destruction',
    hint: 'retain unconfirmed scratch responsibility',
  });
  let attempts = 0;
  device.destroyTexture = () => {
    attempts++;
    if (mode === 'throw') throw failure;
    return rhiErr(failure);
  };
  await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory, 'normal-roughness');
  const work = prepareMipmaps(device, {} as Texture, {
    format: 'rgba8unorm',
    filter: 'normal-roughness',
    width: 2,
    height: 2,
  }).unwrap();
  expect(work.finish().ok).toBe(true);
  expect(() => work.discard()).toThrow(failure);
  expect(() => work.discard()).toThrow(failure);
  expect(attempts).toBe(1);
});

it.each([
  ['webgpu', 'result'],
  ['webgpu', 'throw'],
  ['wgpu-webgl2', 'result'],
  ['wgpu-webgl2', 'throw'],
] as const)('preserves primary and all scratch retirement failures on %s with cleanup %s', async (backendKind, mode) => {
  const device = makeBlitDevice();
  Object.assign(device.caps, { backendKind });
  const primary = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'mip bind group',
    hint: 'encoding failed after scratch allocation',
  });
  const cleanup = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'scratch destruction',
    hint: 'retain the failed scratch',
  });
  let attempts = 0;
  device.createBindGroup = () => rhiErr(primary);
  device.destroyTexture = () => {
    attempts++;
    if (mode === 'throw') throw cleanup;
    return rhiErr(cleanup);
  };
  const filter = backendKind === 'webgpu' ? 'normal-roughness' : 'box';
  await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory, filter);
  let observed: unknown;
  try {
    const result = prepareMipmaps(device, {} as Texture, {
      format: 'rgba8unorm',
      filter,
      width: backendKind === 'webgpu' ? 4 : 2,
      height: 2,
      arrayLayerCount: 2,
    });
    if (!result.ok) observed = result.error;
  } catch (cause) {
    observed = cause;
  }
  expect(observed).toBeInstanceOf(AggregateError);
  const failures = (value: unknown): unknown[] =>
    value instanceof AggregateError ? value.errors.flatMap(failures) : [value];
  expect(failures(observed)).toContain(primary);
  expect(failures(observed)).toContain(cleanup);
  expect(attempts).toBe(2);
});

it('rejects finish and honours cancellation from the initial work transfer before allocating scratch', async () => {
  const log: BlitLog = { copies: [], destroyed: [] };
  const device = makeBlitDevice(undefined, log);
  await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
  let created = 0;
  const create = device.createTexture.bind(device);
  device.createTexture = (descriptor) => {
    created++;
    return create(descriptor);
  };
  let work: import('../mipmap-generator').MipmapEncoderWork | undefined;
  const result = prepareMipmaps(
    device,
    {} as Texture,
    { format: 'rgba8unorm', width: 4, height: 4 },
    (value) => {
      work = value;
      expect(value.finish().ok).toBe(false);
      value.discard();
    },
  );
  expect(result.ok).toBe(false);
  expect(created).toBe(0);
  expect(log.destroyed).toHaveLength(0);
  expect(work?.finish().ok).toBe(false);
  expect(() => work?.discard()).not.toThrow();
});

it('defers reentrant discard until encoding stops appending scratch', async () => {
  const log: BlitLog = { copies: [], destroyed: [] };
  const device = makeBlitDevice(undefined, log);
  await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory, 'normal-roughness');
  let work: import('../mipmap-generator').MipmapEncoderWork | undefined;
  const create = device.createTexture.bind(device);
  let created = 0;
  device.createTexture = (descriptor) => {
    created++;
    work?.discard();
    expect(log.destroyed).toHaveLength(0);
    return create(descriptor);
  };
  const result = prepareMipmaps(
    device,
    {} as Texture,
    { format: 'rgba8unorm', filter: 'normal-roughness', width: 4, height: 4, arrayLayerCount: 2 },
    (value) => {
      work = value;
    },
  );
  expect(result.ok).toBe(false);
  expect(created).toBe(2);
  expect(log.destroyed).toHaveLength(2);
  expect(work?.finish().ok).toBe(false);
  work?.discard();
  expect(log.destroyed).toHaveLength(2);
});

it('retains the transferred scratch receipt when both encoding and its cleanup fail', async () => {
  const device = makeBlitDevice();
  const primary = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'mip bind group',
    hint: 'encoding failed',
  });
  const cleanup = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'scratch destruction',
    hint: 'keep the same receipt',
  });
  let attempts = 0;
  device.createBindGroup = () => rhiErr(primary);
  device.destroyTexture = () => {
    attempts++;
    return rhiErr(cleanup);
  };
  await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory, 'normal-roughness');
  let work: import('../mipmap-generator').MipmapEncoderWork | undefined;
  expect(() =>
    prepareMipmaps(
      device,
      {} as Texture,
      { format: 'rgba8unorm', filter: 'normal-roughness', width: 4, height: 4, arrayLayerCount: 2 },
      (value) => {
        work = value;
      },
    ),
  ).toThrow(AggregateError);
  expect(work).toBeDefined();
  expect(work?.finish().ok).toBe(false);
  expect(() => work?.discard()).toThrow(AggregateError);
  expect(() => work?.discard()).toThrow(AggregateError);
  expect(attempts).toBe(2);
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
