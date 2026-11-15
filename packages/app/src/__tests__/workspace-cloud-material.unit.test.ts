import { createHash } from 'node:crypto';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import {
  type CloudMaterialSource,
  type CloudParameter,
  createCloudCookers,
} from '@forgeax/engine-render/authoring';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import { type ArtifactDescriptor, type Asset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { inspectEngineWorkspaceAsset } from '../workspace';
import { inspectWorkspaceCloudMaterial } from '../workspace-cloud-material';
import { publishWorkspaceAssets } from './workspace-asset-fixture';

it('inspects cooked cloud materials and their instance parent without creating a preview', async () => {
  const assets = new AssetRegistry({});
  const registry = new NativeCookerRegistry();
  for (const cooker of createCloudCookers({
    loadSource: async () => {
      throw new Error('uniform materials need no shader');
    },
    compilerIdentity: async () => 'unused',
    compile: async () => ok({ wgsl: '', bindings: [] }),
  }))
    registry.register(cooker);
  const materialGuid = '019a50a5-0000-7000-8000-000000000001';
  const instanceGuid = '019a50a5-0000-7000-8000-000000000002';
  const source = {
    version: 1,
    model: {
      kind: 'uniform',
      sample: {
        extinctionPerMeter: 0.002,
        albedo: [1, 0.9, 0.8],
        emissivePerMeter: [0, 0, 0],
        materialAO: 1,
      },
    },
    parameters: {},
  };
  const material = (
    await registry.runDraft('cloud-material', {
      guid: materialGuid,
      sourcePath: 'cloud.pack.ts',
      source,
    })
  ).unwrap();
  const instance = (
    await registry.runDraft('cloud-material-instance', {
      guid: instanceGuid,
      sourcePath: 'cloud.pack.ts',
      source: {
        version: 1,
        material: materialGuid,
        parameters: {},
        overrides: {},
      },
    })
  ).unwrap();
  publishWorkspaceAssets(assets, [
    { guid: materialGuid, asset: material.payload as Asset },
    { guid: instanceGuid, asset: instance.payload as Asset, refs: [materialGuid] },
  ]);
  expect(await inspectEngineWorkspaceAsset(assets, materialGuid)).toMatchObject({
    guid: materialGuid,
    meta: {
      kind: 'cloud-material',
      model: 'uniform',
      parameters: [],
      sample: source.model.sample,
      truncated: false,
      variants: [],
      declaredDependencies: [],
      dependenciesTruncated: false,
    },
  });
  expect(await inspectEngineWorkspaceAsset(assets, instanceGuid)).toMatchObject({
    guid: instanceGuid,
    meta: {
      kind: 'cloud-material-instance',
      material: { guid: materialGuid, kind: 'cloud-material' },
      parameters: [],
    },
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    inspectEngineWorkspaceAsset(assets, materialGuid, controller.signal),
  ).rejects.toThrow();
});

const materialGuid = '019a50a5-0000-7000-8000-000000000011';
const instanceGuid = '019a50a5-0000-7000-8000-000000000012';
const textureGuid = '019a50a5-0000-7000-8000-000000000013';
const overrideGuid = '019a50a5-0000-7000-8000-000000000014';

async function programFixture(
  parameters: Readonly<Record<string, CloudParameter>>,
  overrides: Record<string, unknown> = {},
) {
  const assets = new AssetRegistry({});
  const registry = new NativeCookerRegistry();
  for (const cooker of createCloudCookers({
    loadSource: async () => ({ source: '// inspection fixture', path: 'fixture.wgsl' }),
    compilerIdentity: async () => 'inspection-fixture-compiler',
    compile: async (wgsl) => ok({ wgsl, bindings: [{ entries: [] }] }),
  }))
    registry.register(cooker);
  const source: CloudMaterialSource = {
    version: 1,
    model: { kind: 'program', source: 'fixture.wgsl' },
    parameters,
  };
  const material = (
    await registry.runDraft('cloud-material', {
      guid: materialGuid,
      sourcePath: 'cloud.pack.ts',
      source,
    })
  ).unwrap();
  const instance = (
    await registry.runDraft('cloud-material-instance', {
      guid: instanceGuid,
      sourcePath: 'cloud.pack.ts',
      source: {
        version: 1,
        material: materialGuid,
        parameters,
        overrides,
      },
    })
  ).unwrap();
  const bytes = new Map<string, Uint8Array>();
  const artifacts = Object.fromEntries(
    Object.entries(material.artifacts).map(([name, artifact]) => {
      bytes.set(name, artifact.bytes);
      return [
        name,
        {
          path: name,
          mediaType: artifact.mediaType,
          contentEncoding: 'identity',
          byteLength: artifact.bytes.length,
          integrity: {
            algorithm: 'sha256',
            digest: `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`,
          },
        } satisfies ArtifactDescriptor,
      ];
    }),
  );
  const textureIds = [
    ...new Set([...material.refs, ...instance.refs.filter((guid) => guid !== materialGuid)]),
  ];
  const entries = [
    {
      guid: materialGuid,
      kind: 'cloud-material',
      payload: material.payload,
      refs: material.refs,
      artifacts,
    },
    {
      guid: instanceGuid,
      kind: 'cloud-material-instance',
      payload: instance.payload,
      refs: instance.refs,
      artifacts: {},
    },
    ...textureIds.map((guid) => ({
      guid,
      kind: 'texture',
      payload: {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: [255, 255, 255, 255],
      },
      refs: [],
      artifacts: {},
    })),
  ];
  const packageUrl = 'https://workspace.invalid/cloud/fixture.pack.json';
  const { pack, publication } = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'cloud.pack.ts',
    sourceRevision: 'fixture',
    packageUrl,
    pack: { assets: entries },
  });
  for (const contribution of defaultAssetDecoderContributions)
    assets.installDecoder(contribution.kind, contribution.decoder);
  assets.setCatalogSource(
    createCatalogSource({
      entries: entries.map(({ guid, kind }) => ({
        guid,
        kind,
        sourcePath: 'cloud.pack.ts',
        packageUrl,
        publication,
      })),
      fetch: async (input) => {
        const artifact = bytes.get(new URL(String(input)).pathname.split('/').at(-1) ?? '');
        return artifact ? new Response(artifact) : new Response(JSON.stringify(pack));
      },
    }),
  );
  return { assets, material, instance, publication };
}

it('reports cooked static identities and all declared references separately from resolved instance values', async () => {
  const texture: CloudParameter = {
    kind: 'texture',
    default: textureGuid,
    dimension: '2d',
    colorSpace: 'linear',
    mipLevels: 1,
  };
  const fixture = await programFixture(
    {
      width: { kind: 'scalar', default: 800, unit: 'm' },
      detail: { kind: 'static', default: false },
      noise: texture,
      duplicate: texture,
    },
    { width: 1600, detail: true, noise: overrideGuid },
  );
  try {
    const base = await inspectWorkspaceCloudMaterial(
      fixture.assets,
      materialGuid,
      'cloud-material',
    );
    const instance = await inspectWorkspaceCloudMaterial(
      fixture.assets,
      instanceGuid,
      'cloud-material-instance',
    );
    expect(instance.publication).toMatchObject(fixture.publication);
    expect(instance.meta.cookIdentity).toBe(base.meta.cookIdentity);
    expect(base.meta.variants).toHaveLength(2);
    expect(base.meta.variants.find((variant) => variant.selected)?.staticValues).toEqual({
      detail: false,
    });
    expect(instance.meta.variants.find((variant) => variant.selected)?.staticValues).toEqual({
      detail: true,
    });
    expect(instance.meta.variants.map(({ selected: _selected, ...variant }) => variant)).toEqual(
      base.meta.variants.map(({ selected: _selected, ...variant }) => variant),
    );
    expect(instance.meta.declaredDependencies).toEqual([
      { guid: materialGuid, kind: 'cloud-material', declaredBy: 'instance' },
      { guid: overrideGuid, kind: 'texture', declaredBy: 'instance' },
      { guid: textureGuid, kind: 'texture', declaredBy: 'material' },
    ]);
    expect(instance.meta.parameters.find((parameter) => parameter.name === 'noise')).toMatchObject({
      value: overrideGuid,
      definition: { default: textureGuid },
      overridden: true,
    });
    expect(instance.meta.dependenciesTruncated).toBe(false);
  } finally {
    fixture.assets.dispose();
  }
});

it('retains dependencies after the parameter display limit', async () => {
  const parameters: Record<string, CloudParameter> = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [
      `scalar${index}`,
      { kind: 'scalar', default: index, unit: 'm' },
    ]),
  );
  parameters.lastTexture = {
    kind: 'texture',
    default: textureGuid,
    dimension: '2d',
    colorSpace: 'linear',
    mipLevels: 1,
  };
  const fixture = await programFixture(parameters);
  try {
    const result = await inspectWorkspaceCloudMaterial(
      fixture.assets,
      materialGuid,
      'cloud-material',
    );
    expect(result.meta.parameters).toHaveLength(256);
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.declaredDependencies).toEqual([
      { guid: textureGuid, kind: 'texture', declaredBy: 'material' },
    ]);
    expect(result.meta.dependenciesTruncated).toBe(false);
  } finally {
    fixture.assets.dispose();
  }
});

it('preserves the selected program for value-only overrides and detaches returned static facts', async () => {
  const fixture = await programFixture(
    {
      width: { kind: 'scalar', default: 800, unit: 'm' },
      detail: { kind: 'static', default: false },
    },
    { width: 1600 },
  );
  try {
    const release = vi.spyOn(fixture.assets, 'release');
    const base = await inspectWorkspaceCloudMaterial(
      fixture.assets,
      materialGuid,
      'cloud-material',
    );
    const instance = await inspectWorkspaceCloudMaterial(
      fixture.assets,
      instanceGuid,
      'cloud-material-instance',
    );
    expect(instance.meta.variants).toEqual(base.meta.variants);
    expect(instance.meta.cookIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      instance.meta.variants.every(
        (variant) => variant.compilerIdentity === 'inspection-fixture-compiler',
      ),
    ).toBe(true);
    expect(instance.meta.parameters.find((parameter) => parameter.name === 'width')?.value).toBe(
      1600,
    );
    expect(release).toHaveBeenCalledTimes(3);
    const variant = instance.meta.variants[0];
    if (!variant) throw new Error('Expected a cooked static variant');
    Object.assign(variant.staticValues, { detail: true });
    const reread = await inspectWorkspaceCloudMaterial(
      fixture.assets,
      instanceGuid,
      'cloud-material-instance',
    );
    expect(reread.meta.variants).toEqual(base.meta.variants);
  } finally {
    fixture.assets.dispose();
    vi.restoreAllMocks();
  }
});

it('reports truncation for more than 512 distinct declared references', async () => {
  const parameters: Record<string, CloudParameter> = Object.fromEntries(
    Array.from({ length: 513 }, (_, index) => [
      `texture${index}`,
      {
        kind: 'texture',
        default: `019a50a6-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
        dimension: '2d',
        colorSpace: 'linear',
        mipLevels: 1,
      },
    ]),
  );
  const fixture = await programFixture(parameters);
  try {
    const result = await inspectWorkspaceCloudMaterial(
      fixture.assets,
      materialGuid,
      'cloud-material',
    );
    expect(result.meta.declaredDependencies).toHaveLength(512);
    expect(result.meta.dependenciesTruncated).toBe(true);
    expect(result.meta.truncated).toBe(true);
  } finally {
    fixture.assets.dispose();
  }
});

it.each([
  1, 2,
])('releases acquired handles when cancellation arrives after load %s', async (abortAfter) => {
  const fixture = await programFixture({ width: { kind: 'scalar', default: 800, unit: 'm' } });
  try {
    const controller = new AbortController();
    const release = vi.spyOn(fixture.assets, 'release');
    const load = fixture.assets.load.bind(fixture.assets);
    let loads = 0;
    vi.spyOn(fixture.assets, 'load').mockImplementation(async (...args) => {
      const result = await load(...args);
      if (++loads === abortAfter) controller.abort();
      return result;
    });
    await expect(
      inspectWorkspaceCloudMaterial(
        fixture.assets,
        instanceGuid,
        'cloud-material-instance',
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(abortAfter);
  } finally {
    fixture.assets.dispose();
    vi.restoreAllMocks();
  }
});
