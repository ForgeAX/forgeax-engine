import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';
import { defaultMaterialSnapshot } from '../render-system-extract';
import { TerrainLayers } from '../terrain/layers';
import { TerrainSourceCache } from '../terrain/source';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  return { device, store };
}

it('does not inspect an idle image-page projection or allocate its encoder', async () => {
  const { device, store } = await fixture();
  const create = vi.spyOn(device, 'createCommandEncoder');
  const pending = vi.spyOn(store.imagePages.texture, 'pending', 'get').mockImplementation(() => {
    throw new Error('idle projection was visited');
  });
  try {
    expect(store.prepareTextureMips().unwrap()).toBeUndefined();
    expect(pending).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  } finally {
    pending.mockRestore();
    create.mockRestore();
    store.destroyAll();
  }
});

it('retries direct image-page writes and preserves a write after preparation', async () => {
  const { device, store } = await fixture();
  const texture = store.imagePages.texture;
  const start = texture.allocate(4);
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  try {
    texture.write(start, new Uint8Array([1, 2, 3, 4]));
    const rejected = store.prepareTextureMips().unwrap();
    assert(rejected);
    rejected.complete(false);
    const accepted = store.prepareTextureMips().unwrap();
    assert(accepted);
    texture.write(start + 1, new Uint8Array([5, 6, 7, 8]));
    accepted.complete(true);
    accepted.complete(true);
    const later = store.prepareTextureMips().unwrap();
    assert(later);
    later.complete(true);
    expect(
      writes.mock.calls.map((call) =>
        Array.from(
          ArrayBuffer.isView(call[2])
            ? new Uint8Array(call[2].buffer, call[2].byteOffset, call[2].byteLength)
            : new Uint8Array(call[2]),
        ),
      ),
    ).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(store.prepareTextureMips().unwrap()).toBeUndefined();
  } finally {
    writes.mockRestore();
    store.destroyAll();
  }
});

it.each([
  'encoder',
  'projection',
  'finish',
] as const)('retains direct image-page work after %s rejection', async (stage) => {
  const { device, store } = await fixture();
  const texture = store.imagePages.texture;
  const start = texture.allocate(4);
  texture.writeRows(start, 2, new Uint8Array(16).fill(19));
  const failure = new RhiError({
    code: 'rhi-not-available',
    expected: 'test rejection',
    hint: 'retry',
  });
  const create = device.createCommandEncoder.bind(device);
  const encoding = vi.spyOn(device, 'createCommandEncoder');
  const projection = vi.spyOn(texture, 'encode');
  if (stage === 'encoder') encoding.mockReturnValueOnce(err(failure));
  else if (stage === 'projection')
    projection.mockImplementationOnce(() => {
      throw failure;
    });
  else
    encoding.mockImplementationOnce((descriptor) => {
      const result = create(descriptor);
      if (result.ok) result.value.finish = () => err(failure);
      return result;
    });
  try {
    expect(store.prepareTextureMips()).toMatchObject({ ok: false, error: failure });
    const retried = store.prepareTextureMips().unwrap();
    assert(retried?.buffer);
    retried.complete(true);
    expect(texture.pending).toBe(false);
    expect(store.prepareTextureMips().unwrap()).toBeUndefined();
  } finally {
    encoding.mockRestore();
    projection.mockRestore();
    store.destroyAll();
  }
});

it.each([
  'release',
  'device',
] as const)('does not resurrect image-page work after %s between preparation and completion', async (action) => {
  const { device, store } = await fixture();
  const texture = store.imagePages.texture;
  const start = texture.allocate(4);
  texture.write(start, new Uint8Array(16));
  const work = store.prepareTextureMips().unwrap();
  assert(work);
  if (action === 'release') texture.dispose();
  else store.configureGpuDevice(device, undefined, device.caps);
  work.complete(false);
  expect(store.prepareTextureMips().unwrap()).toBeUndefined();
  const next = store.imagePages.texture;
  next.write(next.allocate(1), new Uint8Array([1, 2, 3, 4]));
  const replacement = store.prepareTextureMips().unwrap();
  assert(replacement?.buffer);
  replacement.complete(true);
  expect(store.prepareTextureMips().unwrap()).toBeUndefined();
  store.destroyAll();
});

async function terrainFixture() {
  const { device, store } = await fixture();
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const material = assets
    .create({
      kind: 'material',
      colorSpace: 'linear',
      parameters: standardSurfaceParameters([]),
      values: { baseColor: [1, 1, 1, 1] },
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    })
    .unwrap();
  const handle = assets
    .create({
      kind: 'terrain',
      columns: 2,
      rows: 2,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array(4),
      weights: new Float32Array(4).fill(1),
      layers: [{ material, blend: 'weight' }],
    })
    .unwrap();
  const owner = new TerrainLayers(
    () => store,
    () => device,
    {
      createShaderModule: (descriptor) => rhi.createShaderModuleImmediate(device, descriptor),
    },
  );
  const source = new TerrainSourceCache().resolve(worldRenderResources(world), handle);
  const snapshot = { ...defaultMaterialSnapshot() };
  owner.bind(snapshot, owner.capture(worldRenderResources(world), source));
  return { device, store, owner, assets, snapshot };
}

it('tracks actual Terrain use without an empty encoder and retires only unused frames behind their fence', async () => {
  const { device, store, owner, assets, snapshot } = await terrainFixture();
  let resolve!: () => void;
  const completed = new Promise<undefined>((done) => {
    resolve = () => done(undefined);
  });
  const fence = vi.spyOn(device.queue, 'onSubmittedWorkDone').mockReturnValue(completed);
  const create = vi.spyOn(device, 'createCommandEncoder');
  const textures = vi.spyOn(device, 'createTexture');
  const destroyed = vi.spyOn(device, 'destroyTexture');
  try {
    const first = owner.texture(snapshot, 'terrainColorLayers');
    assert(first);
    store.prepareTextureMips().unwrap()?.complete(true);
    const arrays = textures.mock.calls.flatMap(([descriptor], index) =>
      descriptor.label?.startsWith('terrain-layer-')
        ? [textures.mock.results[index]?.value.unwrap()]
        : [],
    );
    expect(arrays).toHaveLength(4);
    expect(create).toHaveBeenCalledTimes(1);
    expect(owner.texture(snapshot, 'terrainColorLayers')?.textureView).toBe(first.textureView);
    const reused = store.prepareTextureMips().unwrap();
    assert(reused);
    expect(reused.buffer).toBeUndefined();
    reused.complete(true);
    const unused = store.prepareTextureMips().unwrap();
    assert(unused);
    expect(unused.buffer).toBeUndefined();
    unused.complete(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(destroyed.mock.calls.some(([texture]) => arrays.includes(texture))).toBe(false);
    resolve();
    await completed;
    await Promise.resolve();
    expect(destroyed.mock.calls.filter(([texture]) => arrays.includes(texture))).toHaveLength(4);
    expect(store.prepareTextureMips().unwrap()).toBeUndefined();
    // A held CPU snapshot can be replayed after its unused GPU projection retires.
    expect(owner.texture(snapshot, 'terrainColorLayers')?.textureView).not.toBe(first.textureView);
    const replay = store.prepareTextureMips().unwrap();
    assert(replay?.buffer);
    replay.complete(false);
  } finally {
    resolve();
    owner.dispose();
    store.destroyAll();
    assets.dispose();
    fence.mockRestore();
    create.mockRestore();
    textures.mockRestore();
    destroyed.mockRestore();
  }
});

it('retains a Terrain binding used after preparation', async () => {
  const { store, owner, assets, snapshot } = await terrainFixture();
  try {
    const first = owner.texture(snapshot, 'terrainColorLayers');
    assert(first);
    const initial = store.prepareTextureMips().unwrap();
    assert(initial?.buffer);
    initial.complete(true);
    const retiring = store.prepareTextureMips().unwrap();
    assert(retiring);
    expect(owner.texture(snapshot, 'terrainColorLayers')?.textureView).toBe(first.textureView);
    retiring.complete(true);
    expect(owner.texture(snapshot, 'terrainColorLayers')?.textureView).toBe(first.textureView);
    const reused = store.prepareTextureMips().unwrap();
    assert(reused);
    expect(reused.buffer).toBeUndefined();
    reused.complete(true);
  } finally {
    owner.dispose();
    store.destroyAll();
    assets.dispose();
  }
});

it('records queued image-page copies before a derived projection registered earlier', async () => {
  const { device, store } = await fixture();
  const order: string[] = [];
  const texture = store.imagePages.texture;
  const original = texture.encode.bind(texture);
  const encoded = vi.spyOn(texture, 'encode').mockImplementation((encoder) => {
    order.push('pages');
    return original(encoder);
  });
  store.queueTextureProjection(
    {
      encode: (encoder) => {
        order.push('derived');
        encoder().beginComputePass({ label: 'derived' }).end();
        return { complete() {} };
      },
    },
    device,
  );
  texture.write(texture.allocate(1), new Uint8Array([1, 2, 3, 4]));
  try {
    const work = store.prepareTextureMips().unwrap();
    assert(work?.buffer);
    work.complete(true);
    expect(order).toEqual(['pages', 'derived']);
    expect(store.prepareTextureMips().unwrap()).toBeUndefined();
  } finally {
    encoded.mockRestore();
    store.destroyAll();
  }
});

it.each([
  true,
  false,
])('settles every projection and mip scratch when a completion callback throws (submitted=%s)', async (submitted) => {
  const { device, store } = await fixture();
  store.configureGpuDevice(
    device,
    (owner, descriptor) => rhi.createShaderModule(owner, descriptor),
    device.caps,
  );
  (await store.prewarmMipmapPipeline(device, ['rgba8unorm'])).unwrap();
  const assets = new AssetRegistry();
  const texture = {
    kind: 'texture' as const,
    format: 'rgba8unorm' as const,
    colorSpace: 'linear' as const,
    shape: { viewDimension: '2d' as const, extent: { width: 8, height: 8 } },
    mips: { kind: 'generate' as const },
    data: new Uint8Array(256),
  };
  store.ensureResident(assets.create(texture).unwrap(), texture).unwrap();
  const notifications: boolean[] = [];
  let rejectCallback = true;
  store.queueTextureProjection(
    {
      encode: () => ({
        complete() {
          if (rejectCallback) throw new Error('first projection failed');
        },
      }),
    },
    device,
  );
  store.queueTextureProjection(
    {
      encode: () => ({
        complete(value) {
          notifications.push(value);
        },
      }),
    },
    device,
  );
  const created = vi.spyOn(device, 'createTexture');
  const destroyed = vi.spyOn(device, 'destroyTexture');
  const originalEncoder = device.createCommandEncoder.bind(device);
  const encoders = vi.spyOn(device, 'createCommandEncoder');
  if (!submitted)
    encoders.mockImplementationOnce((descriptor) => {
      const result = originalEncoder(descriptor);
      if (result.ok)
        result.value.finish = () =>
          err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'finish rejection',
              hint: 'retry',
            }),
          );
      return result;
    });
  try {
    if (submitted) {
      const work = store.prepareTextureMips().unwrap();
      assert(work?.buffer);
      expect(() => work.complete(true)).toThrow('first projection failed');
      work.complete(false);
      expect(store.prepareTextureMips().unwrap()).toBeUndefined();
    } else {
      expect(() => store.prepareTextureMips()).toThrow('texture projection preparation failed');
    }
    expect(notifications).toEqual([submitted]);
    const scratch = created.mock.calls.flatMap(([descriptor], index) =>
      descriptor.label === 'mipmap-scratch' ? [created.mock.results[index]?.value.unwrap()] : [],
    );
    expect(scratch).toHaveLength(1);
    expect(destroyed.mock.calls.filter(([texture]) => scratch.includes(texture))).toHaveLength(1);
    if (!submitted) {
      rejectCallback = false;
      store.prepareTextureMips().unwrap()?.complete(true);
      expect(notifications).toEqual([false, true]);
      expect(store.prepareTextureMips().unwrap()).toBeUndefined();
    }
  } finally {
    created.mockRestore();
    destroyed.mockRestore();
    encoders.mockRestore();
    store.destroyAll();
    assets.dispose();
  }
});
