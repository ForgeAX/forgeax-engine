import {
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  serializeCookedMaterialRecord,
} from '@forgeax/engine-pack';
import { ok } from '@forgeax/engine-rhi';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialParameter } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { runtimeAssets } from '../internal/runtime-assets.js';
import type { MaterialReady } from '../material/loader.js';
import { MATERIAL_CONTEXT, materialRecordFixture } from './fixtures/material-publication.js';
import { loadMaterialFixture } from './fixtures/runtime-material';
import { publishRuntimeAssets } from './fixtures/runtime-publication';

const MATERIAL_GUID = '019f0000-0000-7000-8000-000000000201';

function createShaderRegistry(): ShaderRegistry {
  const device: ShaderRegistryDevice = {
    createShaderModule: () => ok({} as never),
  };
  return new ShaderRegistry({ device, manifestUrl: undefined });
}

function ready(
  generation: number,
  specializationKey: string,
  source: string,
  guid = MATERIAL_GUID,
  parameters: readonly MaterialParameter[] = [],
): MaterialReady {
  const bytes = new TextEncoder().encode(source);
  const programs = [
    {
      specializationKey,
      artifact: {
        mediaType: 'text/wgsl',
        path: `artifacts/${specializationKey}.wgsl`,
        digest: createMaterialArtifactDigest(bytes),
        bytes,
      },
      selections: [{ pass: 'Forward', context: MATERIAL_CONTEXT }],
    },
  ];
  const base = materialRecordFixture({
    guid,
    generation,
    specializationKey,
    parameters,
    values: Object.fromEntries(
      parameters.map((parameter) => [parameter.name, parameter.default ?? 0]),
    ),
    passes: [
      {
        name: 'Forward',
        program: { module: 'semantic::root' },
        renderState: { queue: 2000, tags: { LightMode: 'Forward' } },
      },
    ],
  });
  const artifactDigest = createMaterialProgramSetDigest(programs, base.resolved.passes);
  const record = {
    ...base,
    artifactDigest,
    programs,
    receipt: { ...base.receipt, identity: { ...base.receipt.identity, artifactDigest } },
  };
  if (record.sourceClosure === undefined || record.parameterContract === undefined) {
    throw new Error('Incomplete publication fixture');
  }
  return {
    status: 'Ready',
    record,
  };
}

describe('material specialization runtime consumer', async () => {
  it('keeps immutable artifacts by specialization key and rejects conflicting bytes', async () => {
    const assets = new AssetRegistry({ shaderRegistry: createShaderRegistry() });
    (await loadMaterialFixture(assets, ready(1, 'key-a', 'variant-a').record)).unwrap();
    (await loadMaterialFixture(assets, ready(1, 'key-a', 'variant-a').record)).unwrap();
    await expect(
      loadMaterialFixture(assets, ready(1, 'key-a', 'variant-b').record),
    ).rejects.toMatchObject({ code: 'material-artifact-conflict' });
    expect(assets.getMaterialArtifact('key-a')?.bytes).toEqual(
      new TextEncoder().encode('variant-a'),
    );
  });
  it('keeps different specialization keys for one module without overwriting either artifact', async () => {
    const assets = new AssetRegistry({ shaderRegistry: createShaderRegistry() });
    (await loadMaterialFixture(assets, ready(1, 'key-a', 'variant-a').record)).unwrap();
    (await loadMaterialFixture(assets, ready(2, 'key-b', 'variant-b').record)).unwrap();
    expect(assets.getMaterialArtifact('key-a')?.bytes).toEqual(
      new TextEncoder().encode('variant-a'),
    );
    expect(assets.getMaterialArtifact('key-b')?.bytes).toEqual(
      new TextEncoder().encode('variant-b'),
    );
  });
  it('rejects a specialization schema conflict even when artifact bytes are unchanged', async () => {
    const assets = new AssetRegistry({ shaderRegistry: createShaderRegistry() });
    (await loadMaterialFixture(assets, ready(1, 'key-a', 'variant-a').record)).unwrap();
    await expect(
      loadMaterialFixture(
        assets,
        ready(1, 'key-a', 'variant-a', MATERIAL_GUID, [{ name: 'factor', type: 'f32' }]).record,
      ),
    ).rejects.toMatchObject({ code: 'material-artifact-conflict' });
  });
  it('does not install an incoming authored module into the module registry', async () => {
    const shaderRegistry = createShaderRegistry();
    const assets = new AssetRegistry({ shaderRegistry });
    (await loadMaterialFixture(assets, ready(1, 'key-a', 'variant-a').record)).unwrap();
    expect(shaderRegistry.findMaterialArtifact('semantic::root').ok).toBe(false);
    expect(shaderRegistry.findMaterialArtifact('key-a').ok).toBe(true);
  });
  it('projects the latest accepted publication generation', async () => {
    const assets = new AssetRegistry({ shaderRegistry: createShaderRegistry() });
    (await loadMaterialFixture(assets, ready(1, 'key-a', 'variant-a').record)).unwrap();
    const current = (
      await loadMaterialFixture(assets, ready(2, 'key-b', 'variant-b').record)
    ).unwrap();
    expect(current.projection).toMatchObject({
      materialGuid: MATERIAL_GUID,
      publicationGeneration: 2,
      specializationKey: 'key-b',
      artifactHash: ready(2, 'key-b', 'variant-b').record.artifactDigest,
    });
  });
  it('resolves source inheritance before admitting a complete runtime material', async () => {
    const assets = new AssetRegistry({ shaderRegistry: createShaderRegistry() });
    const record = ready(1, 'key-a', 'variant-a').record;
    const childGuid = '019f0000-0000-7000-8000-000000000202';
    publishRuntimeAssets(assets, [
      {
        guid: MATERIAL_GUID,
        asset: {
          kind: 'material',
          ...record.resolved,
          passes: record.resolved.passes as import('@forgeax/engine-types').MaterialPassList,
          cooked: JSON.parse(serializeCookedMaterialRecord(record)),
        } as MaterialAsset,
      },
      {
        guid: childGuid,
        asset: { kind: 'material', parent: MATERIAL_GUID as never, values: {} },
        refs: [MATERIAL_GUID],
      },
    ]);
    const child = (await assets.load(childGuid, 'material')).unwrap();
    const root = (await assets.load(MATERIAL_GUID, 'material')).unwrap();
    const runtimeChild = runtimeAssets(assets).borrow<MaterialAsset>(child).unwrap();
    expect(runtimeChild.parent).toBeUndefined();
    expect(assets.getMaterialProjectionForPayload(runtimeChild)).toBe(
      assets.getMaterialProjectionForPayload(
        runtimeAssets(assets).borrow<MaterialAsset>(root).unwrap(),
      ),
    );
  });
  it('keeps the projection attached to an independent copy across same-GUID recook', async () => {
    const assets = new AssetRegistry({ shaderRegistry: createShaderRegistry() });
    const a = (await loadMaterialFixture(assets, ready(1, 'key-a', 'variant-a').record)).unwrap();
    const copy = assets.copy(a.handle).unwrap();
    const b = (await loadMaterialFixture(assets, ready(2, 'key-b', 'variant-b').record)).unwrap();
    expect(
      assets.getMaterialProjectionForPayload(
        runtimeAssets(assets).borrow<MaterialAsset>(copy).unwrap(),
      )?.specializationKey,
    ).toBe('key-a');
    expect(b.projection?.specializationKey).toBe('key-b');
    assets.release(copy).unwrap();
  });
});

describe('runtime material program ownership', async () => {
  async function create() {
    const assets = new AssetRegistry({ shaderRegistry: createShaderRegistry() });
    const input: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'semantic::root' } }],
      parameters: [{ name: 'factor', type: 'f32' }],
      values: { factor: 0 },
    };
    const { handle } = (
      await loadMaterialFixture(
        assets,
        ready(1, 'key-a', 'variant-a', MATERIAL_GUID, input.parameters).record,
      )
    ).unwrap();
    assets.update(handle, { values: { factor: 0 } }).unwrap();
    const payload = runtimeAssets(assets).borrow<MaterialAsset>(handle).unwrap();
    expect(assets.getMaterialProjectionForPayload(payload)?.specializationKey).toBe('key-a');
    return { assets, handle, payload };
  }

  it.each([
    'update',
    'replace',
  ] as const)('retires incompatible program facts on %s', async (operation) => {
    const { assets, handle, payload } = await create();
    try {
      const snapshot = assets.snapshot(handle).unwrap();
      const passes = [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }] as const;
      if (operation === 'update') assets.update(handle, { passes }).unwrap();
      else assets.replace(handle, { kind: 'material', passes, values: {} }).unwrap();
      expect(runtimeAssets(assets).borrow(handle).unwrap()).toBe(payload);
      expect(assets.getMaterialProjectionForPayload(payload)).toBeUndefined();
      expect(snapshot.read<MaterialAsset>(handle).unwrap().passes?.[0]?.program.module).toBe(
        'semantic::root',
      );
      snapshot.dispose();
    } finally {
      assets.dispose();
    }
  });

  it('adopts the replacement material program without changing the runtime identity', async () => {
    const { assets, handle, payload } = await create();
    try {
      const guid = '019f0000-0000-7000-8000-000000000202';
      const source: MaterialAsset = {
        kind: 'material',
        passes: [{ name: 'Forward', program: { module: 'semantic::root' } }],
        parameters: [{ name: 'factor', type: 'f32' }],
        values: { factor: 0.75 },
      };
      const replacement = (
        await loadMaterialFixture(
          assets,
          ready(1, 'key-b', 'variant-b', guid, source.parameters).record,
        )
      ).unwrap();
      assets.update(replacement.handle, { values: { factor: 0.75 } }).unwrap();
      const accepted = runtimeAssets(assets).borrow<MaterialAsset>(replacement.handle).unwrap();
      const before = assets.snapshot(handle).unwrap();
      assets.replace(handle, accepted).unwrap();
      expect(runtimeAssets(assets).borrow(handle).unwrap()).toBe(payload);
      expect(assets.getMaterialProjectionForPayload(payload)?.specializationKey).toBe('key-b');
      expect(assets.read(handle).unwrap().values?.factor).toBe(0.75);
      expect(before.read<MaterialAsset>(handle).unwrap().values?.factor).toBe(0);
      before.dispose();
    } finally {
      assets.dispose();
    }
  });

  it('preserves program facts for parameter values and raster state alone', async () => {
    const { assets, handle, payload } = await create();
    try {
      const projection = assets.getMaterialProjectionForPayload(payload);
      assets.update(handle, { values: { factor: 0.2 } }).unwrap();
      expect(assets.getMaterialProjectionForPayload(payload)).toBe(projection);
      assets
        .update(handle, {
          passes: [
            {
              name: 'Forward',
              program: { module: 'semantic::root' },
              renderState: { queue: 3000, depthWrite: false },
            },
          ],
        })
        .unwrap();
      expect(assets.getMaterialProjectionForPayload(payload)).toBe(projection);
    } finally {
      assets.dispose();
    }
  });

  it('does not retire an accepted program when structural validation fails', async () => {
    const { assets, handle, payload } = await create();
    try {
      const projection = assets.getMaterialProjectionForPayload(payload);
      const revision = runtimeAssets(assets).version(handle).unwrap();
      expect(
        assets.update(handle, {
          passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
          values: { factor: Number.NaN },
        }).ok,
      ).toBe(false);
      expect(assets.getMaterialProjectionForPayload(payload)).toBe(projection);
      expect(runtimeAssets(assets).version(handle).unwrap()).toBe(revision);
    } finally {
      assets.dispose();
    }
  });

  it('keeps an independent copy on its original program', async () => {
    const { assets, handle, payload } = await create();
    try {
      const copy = assets.copy(handle).unwrap();
      assets
        .update(handle, {
          passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
        })
        .unwrap();
      expect(assets.getMaterialProjectionForPayload(payload)).toBeUndefined();
      expect(
        assets.getMaterialProjectionForPayload(
          runtimeAssets(assets).borrow<MaterialAsset>(copy).unwrap(),
        )?.specializationKey,
      ).toBe('key-a');
    } finally {
      assets.dispose();
    }
  });
});
