import { AssetGuid, definePackageId, gpuTextureOutputs } from '@forgeax/engine-pack/source';
import { expect, it } from 'vitest';
import { prepareRuntimePackContent, RuntimePackProducer } from '../../../import/src/runtime-pack';
import { prepareTextureGeneratorPrograms } from '../../../render/src/__tests__/texture-generators.commands';
import { AssetRegistry } from '../asset-registry';
import { gpuTextureContribution } from '../loaders/gpu-texture';
import { textureGeneratorContribution } from '../loaders/texture-generator';
import { validateAssetPublication } from '../validate-publication';

const packageId = definePackageId('01900000-0000-7000-8000-000000000010');
const shape = { viewDimension: '2d', extent: { width: 16, height: 16 } } as const;
const decoders = [gpuTextureContribution, textureGeneratorContribution];

it('publishes and loads a GPU texture recipe without a pixel artifact or CPU byte array', async () => {
  const programs = await prepareTextureGeneratorPrograms();
  const content = gpuTextureOutputs(packageId, 'paint', {
    values: { seed: 42, wear: 0 },
    inputs: {},
    programs,
    outputs: {
      albedo: { shape, format: 'rgba8unorm-srgb', colorSpace: 'srgb', mips: { kind: 'generate' } },
      orm: { shape, format: 'rgba8unorm', colorSpace: 'linear', mips: { kind: 'generate' } },
      normal: { shape, format: 'rgba8unorm', colorSpace: 'linear', mips: { kind: 'generate' } },
    },
    transient: { height: { shape, format: 'r16float' } },
    passes: [
      {
        kind: 'raster',
        program: { module: 'test::gpu-paint', fragmentEntry: 'paint' },
        reads: {},
        writes: ['albedo', 'orm', 'height'],
      },
      {
        kind: 'raster',
        program: { module: 'test::gpu-normal', fragmentEntry: 'normal' },
        reads: { height: { kind: 'local', name: 'height' } },
        writes: ['normal'],
      },
    ],
  });
  const prepared = (
    await prepareRuntimePackContent('01900000-0000-7000-8000-000000000010', content)
  ).unwrap();
  const producer: RuntimePackProducer = new RuntimePackProducer({
    scopeId: 'gpu-texture-test',
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(
        state.rows,
        fetcher,
        { catalog: producer.catalog, fetcher: producer.fetch },
        { dependencies, decoders },
      ),
  });
  const registry = new AssetRegistry();
  for (const decoder of decoders) registry.installDecoder(decoder.kind, decoder.decoder);
  registry.setCatalogSource(producer.catalog, producer.fetch);
  try {
    const publication = (await producer.admit(prepared)).unwrap();
    expect(publication.rows).toHaveLength(4);
    const guid = AssetGuid.format(AssetGuid.derive(packageId, 'gpu-texture/paint/albedo'));
    const handle = (await registry.load(guid, 'gpu-texture')).unwrap();
    const texture = registry.read(handle).unwrap();
    expect(texture.source?.kind).toBe('generated');
    expect(texture).not.toHaveProperty('data');
    expect(texture.shape).toEqual(shape);
    expect(texture.mips).toEqual({ kind: 'generate' });
    expect(registry.read(handle, ['shape', 'format']).unwrap()).toEqual({
      shape,
      format: 'rgba8unorm-srgb',
    });
    expect(JSON.stringify(prepared)).not.toContain('application/x-forgeax-rgba');
    expect(JSON.stringify(prepared)).not.toContain('"data"');
    const generator = (
      await registry.load(
        AssetGuid.format(AssetGuid.derive(packageId, 'generator/paint')),
        'texture-generator',
      )
    ).unwrap();
    const orm = (
      await registry.load(
        AssetGuid.format(AssetGuid.derive(packageId, 'gpu-texture/paint/orm')),
        'gpu-texture',
      )
    ).unwrap();
    const before = registry.read(generator).unwrap();
    const larger = { viewDimension: '2d', extent: { width: 32, height: 32 } } as const;
    registry
      .update(generator, {
        values: { seed: 42, wear: 0.5 },
        outputs: Object.fromEntries(
          Object.entries(before.outputs).map(([name, descriptor]) => [
            name,
            { ...descriptor, shape: larger },
          ]),
        ),
        transient: { height: { shape: larger, format: 'r16float' } },
      })
      .unwrap();
    expect(registry.read(handle, ['shape']).unwrap()).toEqual({ shape: larger });
    expect(registry.read(orm).unwrap().shape).toEqual(larger);
    const accepted = registry.read(generator).unwrap();
    // Removing an in-use output must reject the entire group, retaining every sibling.
    expect(
      registry.update(generator, {
        outputs: { orm: accepted.outputs.orm as (typeof before.outputs)[string] },
      }).ok,
    ).toBe(false);
    expect(registry.read(generator).unwrap()).toEqual(accepted);
    expect(registry.read(handle, ['shape']).unwrap()).toEqual({ shape: larger });
    expect(registry.replace(generator, { kind: 'texture-generator', values: {} } as never).ok).toBe(
      false,
    );
    expect(
      registry.writeRange(handle, {
        origin: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
        data: new Uint8Array(4),
      }).ok,
    ).toBe(false);
    // Prepared programs survive publication/restore without an ambient shader manifest.
    expect(accepted.programs?.entries).toHaveLength(2);
    expect(prepared).not.toHaveProperty('device');
    const saved = JSON.parse(JSON.stringify(producer.snapshot()));
    expect(JSON.stringify(saved)).not.toContain('"data"');
    const restored: RuntimePackProducer = new RuntimePackProducer({
      scopeId: 'gpu-texture-restored',
      validate: (state, fetcher, dependencies) =>
        validateAssetPublication(
          state.rows,
          fetcher,
          { catalog: restored.catalog, fetcher: restored.fetch },
          { dependencies, decoders },
        ),
    });
    const restoredAssets = new AssetRegistry();
    for (const decoder of decoders) restoredAssets.installDecoder(decoder.kind, decoder.decoder);
    restoredAssets.setCatalogSource(restored.catalog, restored.fetch);
    try {
      (await restored.restore(saved)).unwrap();
      const recovered = (await restoredAssets.load(guid, 'gpu-texture')).unwrap();
      expect(restoredAssets.read(recovered).unwrap()).toEqual(texture);
    } finally {
      restoredAssets.dispose();
      restored.dispose();
    }
    const raw = {
      ...content,
      'generator/paint': { ...content['generator/paint'], programs: undefined },
    };
    expect(
      (await prepareRuntimePackContent('01900000-0000-7000-8000-000000000010', raw as never)).ok,
    ).toBe(false);
  } finally {
    registry.dispose();
    producer.dispose();
  }
});
