import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { textureContribution } from '@forgeax/engine-image';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ImporterRegistry, runImport } from '@forgeax/engine-import';
import { DirectionalLight, inspectVolumetricFog, validateVolumetricFog } from '@forgeax/engine-render';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { volumetricDensityImporter } from '../volumetric-density-importer';

const GUID = '019f0000-0000-7000-8000-0000000003f1';
const SOURCE_KEY = 'volumetric-fog/density.raw';
const GENERATION = 7;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('public volumetric fog MVD asset chain', () => {
  it('preserves one GUID, body digest, generation, shape and recovery evidence', async () => {
    const importers = new ImporterRegistry();
    importers.register(volumetricDensityImporter());
    const imported = await runImport({
      importer: 'volumetric-density', source: SOURCE_KEY,
      subAssets: [{ guid: GUID, kind: 'texture', sourceIndex: 0, sourceKey: 'density' }],
    }, importers, { readSource: async () => ({ ok: true, value: new TextEncoder().encode(JSON.stringify({ format: 'forgeax-volumetric-density', width: 64, height: 64, depth: 64, base: 19, gradient: 0 })) }) });
    expect(imported.ok).toBe(true);
    if (!imported.ok || 'skipped' in imported.value) throw new Error('Density source did not produce a publication');
    const row = imported.value.pack.assets[0]!;
    const body = row.artifacts.body;
    const bodyBytes = body?.bytes;
    if (bodyBytes === undefined) throw new Error('Density body artifact is absent');
    const bodyDigest = digest(bodyBytes);
    const packageUrl = 'https://density.invalid/density.pack.json';
    const publication = createRuntimePackPublication({ scopeId: 'asset-runtime', sourcePath: SOURCE_KEY, sourceRevision: String(GENERATION), packageUrl, pack: { assets: [{...row, artifacts: {body: {path: 'body.bin', mediaType: body!.mediaType, assetCodec: body!.assetCodec, contentEncoding: 'identity', byteLength: bodyBytes.byteLength, integrity: {algorithm: 'sha256', digest: bodyDigest}}}}] } });
    const packBytes = JSON.stringify(publication.pack, (_key, value) => ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value);
    const registry = new AssetRegistry();
    registry.installDecoder(textureContribution.kind, textureContribution.decoder);
    registry.setCatalogSource(createCatalogSource({
      entries: [{ guid: GUID, kind: 'texture', sourcePath: SOURCE_KEY, packageUrl, publication: publication.publication }],
      fetch: async input => String(input) === packageUrl ? new Response(packBytes) : new Response(bodyBytes.slice().buffer),
    }));
    const loaded = (await registry.load(GUID, 'texture')).unwrap();
    const payload = registry.read(loaded).unwrap();
    expect(payload.data).toEqual(new Uint8Array(64 * 64 * 64).fill(19));
    expect(digest(payload.data)).toBe(bodyDigest);
    expect(registry.source(loaded).unwrap()?.guid).toBe(GUID);
    expect(row.guid).toBe(GUID);
    if (payload.shape.viewDimension !== '3d') throw new Error('Density source is not 3D');
    const world = new World({ assets: registry });
    const light = world.spawn({component: DirectionalLight, data: { color: [1,1,1], intensity: 1 }}).unwrap();
    const validated = validateVolumetricFog({
      light,
      density: {
        guid: GUID,
        generation: GENERATION,
        shape: payload.shape,
        format: payload.format,
        colorSpace: payload.colorSpace,
      },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      extinction: [0.2, 0.2, 0.2],
      albedo: [0.8, 0.8, 0.8],
      emission: [0, 0, 0],
      anisotropy: 0,
      maxDistance: 50,
    });
    expect(validated.ok).toBe(true);
    const inspection = inspectVolumetricFog({
      authored: true,
      capability: 'available',
      recovery: {
        guid: GUID,
        generation: GENERATION,
        deviceEpoch: 0,
        status: 'accepted',
      },
      acceptedDigest: bodyDigest,
      format: 'r8unorm',
      passCount: 1,
      sampleCount: 1,
      memoryBytes: payload.data.byteLength,
    });
    expect(inspection).toMatchObject({
      status: 'available',
      resourceStage: 'accepted',
      guid: GUID,
      generation: GENERATION,
      digest: bodyDigest,
    });
  });
});
