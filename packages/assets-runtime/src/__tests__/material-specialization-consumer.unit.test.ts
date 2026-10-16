import { createMaterialArtifactDigest, createMaterialProgramSetDigest } from '@forgeax/engine-pack';
import { ok } from '@forgeax/engine-rhi';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialParameter } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import type { MaterialReady } from '../material/loader.js';
import { MATERIAL_CONTEXT, materialRecordFixture } from './fixtures/material-publication.js';

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

describe('material specialization runtime consumer', () => {
  it('keeps immutable artifacts by specialization key and rejects conflicting bytes', () => {
    const assets = new AssetRegistry(createShaderRegistry());
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(1, 'key-a', 'variant-a'));
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(1, 'key-a', 'variant-a'));

    expect(() =>
      assets.recordMaterialReadiness(MATERIAL_GUID, ready(1, 'key-a', 'variant-b')),
    ).toThrow(/material-artifact-conflict/);
    expect(assets.getMaterialArtifact('key-a')?.bytes).toEqual(
      new TextEncoder().encode('variant-a'),
    );
  });

  it('keeps different specialization keys for one module without overwriting either artifact', () => {
    const assets = new AssetRegistry(createShaderRegistry());
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(1, 'key-a', 'variant-a'));
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(2, 'key-b', 'variant-b'));

    expect(assets.getMaterialArtifact('key-a')?.bytes).toEqual(
      new TextEncoder().encode('variant-a'),
    );
    expect(assets.getMaterialArtifact('key-b')?.bytes).toEqual(
      new TextEncoder().encode('variant-b'),
    );
  });

  it('rejects a specialization schema conflict even when artifact bytes are unchanged', () => {
    const assets = new AssetRegistry(createShaderRegistry());
    const parameters = [{ name: 'factor', type: 'f32' }] as const;
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(1, 'key-a', 'variant-a', MATERIAL_GUID));

    expect(() =>
      assets.recordMaterialReadiness(
        MATERIAL_GUID,
        ready(1, 'key-a', 'variant-a', MATERIAL_GUID, parameters),
      ),
    ).toThrow(/material-artifact-conflict/);
  });

  it('does not install an incoming authored module into the module registry', () => {
    const shaderRegistry = createShaderRegistry();
    const assets = new AssetRegistry(shaderRegistry);
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(1, 'key-a', 'variant-a'));

    expect(shaderRegistry.findMaterialArtifact('semantic::root').ok).toBe(false);
    expect(shaderRegistry.findMaterialArtifact('key-a').ok).toBe(true);
  });

  it('projects the latest publication generation for a GUID', () => {
    const assets = new AssetRegistry(createShaderRegistry());
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(1, 'key-a', 'variant-a'));
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(2, 'key-b', 'variant-b'));

    expect(assets.getMaterialProjection(MATERIAL_GUID)).toMatchObject({
      materialGuid: MATERIAL_GUID,
      publicationGeneration: 2,
      specializationKey: 'key-b',
      artifactHash: ready(2, 'key-b', 'variant-b').record.artifactDigest,
    });
  });

  it('resolves a values-only child to its cooked root program', () => {
    const assets = new AssetRegistry(createShaderRegistry());
    const root: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'semantic::root' } }],
      parameters: [],
    };
    expect(assets.catalog(MATERIAL_GUID, root).ok).toBe(true);
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(1, 'key-a', 'variant-a'));
    const child: MaterialAsset = {
      kind: 'material',
      parent: assets.parseGuid(MATERIAL_GUID),
      values: {},
    };
    expect(assets.getMaterialProjectionForPayload(child)?.specializationKey).toBe('key-a');
    expect(assets.getMaterialProjectionForPayload(child)).toBe(
      assets.getMaterialProjectionForPayload(root),
    );
  });

  it('keeps the projection attached to each payload across same-GUID recook', () => {
    const assets = new AssetRegistry(createShaderRegistry());
    const materialA = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'semantic::root' },
          renderState: { queue: 2000, tags: { LightMode: 'Forward' } },
        },
      ],
      values: {},
      parameters: [],
    } as unknown as MaterialAsset;
    const materialB = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'semantic::root' },
          renderState: { queue: 2000, tags: { LightMode: 'Forward' } },
        },
      ],
      values: {},
      parameters: [],
    } as unknown as MaterialAsset;

    expect(assets.catalog(MATERIAL_GUID, materialA).ok).toBe(true);
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(1, 'key-a', 'variant-a'));
    expect(assets.catalog(MATERIAL_GUID, materialB).ok).toBe(true);
    assets.recordMaterialReadiness(MATERIAL_GUID, ready(2, 'key-b', 'variant-b'));

    expect(assets.getMaterialProjectionForPayload(materialA)?.specializationKey).toBe('key-a');
    expect(assets.getMaterialProjectionForPayload(materialB)?.specializationKey).toBe('key-b');
  });
});
