import { ShaderRegistry } from '@forgeax/engine-shader';
import { afterEach, expect, it, vi } from 'vitest';
import { materialContribution } from '../../../render/src/assets/asset-decoders';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { runtimeAssets } from '../internal/runtime-assets';
import { materialProductionFixture } from './fixtures/material-production';
import { materialRecordFixture } from './fixtures/material-publication';

const owners: AssetRegistry[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.unstubAllGlobals();
});

it('configures a URL-backed source through the same decoder and program admission path', async () => {
  const f = await fixture();
  const index = '/managed-pack-index.json';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === index ? new Response(JSON.stringify(f.entries)) : f.fetcher(input, init),
  );
  f.owner.configurePackIndex(index);
  const reference = (await f.owner.load(f.record.guid, 'material')).unwrap();
  const value = runtimeAssets(f.owner)
    .borrow<import('@forgeax/engine-types').MaterialAsset>(reference)
    .unwrap();
  expect(f.owner.getMaterialProjectionForPayload(value)?.specializationKey).toBe(
    f.record.specializationKey,
  );
});

it('requires an explicit source and its decoder instead of selecting another loader', async () => {
  const f = await fixture();
  const owner = new AssetRegistry();
  owners.push(owner);
  expect(await owner.load(f.record.guid, 'material')).toMatchObject({
    ok: false,
    error: { code: 'catalog-source-unconfigured' },
  });
  owner.setCatalogSource(createCatalogSource({ entries: f.entries, fetch: f.fetcher }));
  expect(await owner.load(f.record.guid, 'material')).toMatchObject({
    ok: false,
    error: { code: 'asset-decoder-missing' },
  });
});

async function fixture() {
  const publication = await materialProductionFixture(
    true,
    materialRecordFixture({
      parameters: [{ name: 'roughness', type: 'f32' }],
      values: { roughness: 0.3 },
    }),
  );
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === publication.entry.packageUrl) return new Response(JSON.stringify(publication.pack));
    const file = publication.files.get(url.replace(/^\//, ''));
    return file ? new Response(file.source as BodyInit) : new Response('', { status: 404 });
  });
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const owner = new AssetRegistry({
    shaderRegistry: shaders,
    catalog: createCatalogSource({ entries: publication.entries, fetch: fetcher }),
  });
  owner.installDecoder(materialContribution.kind, materialContribution.decoder);
  owners.push(owner);
  return { ...publication, owner, shaders, fetcher };
}

it('admits external material programs through the runtime-reference load and keeps numeric edits on that program', async () => {
  const f = await fixture();
  const reference = (await f.owner.load(f.record.guid, 'material')).unwrap();
  const source = runtimeAssets(f.owner)
    .borrow<import('@forgeax/engine-types').MaterialAsset>(reference)
    .unwrap();
  const projection = f.owner.getMaterialProjectionForPayload(source);
  expect(projection?.specializationKey).toBe(f.record.specializationKey);
  for (const program of f.record.programs)
    expect(f.shaders.findMaterialArtifact(program.specializationKey)).toMatchObject({
      ok: true,
      value: { source: new TextDecoder().decode(program.artifact.bytes) },
    });
  const reads = f.fetcher.mock.calls.length;
  f.owner.update(reference, { values: { roughness: 0.8 } }).unwrap();
  const next = runtimeAssets(f.owner)
    .borrow<import('@forgeax/engine-types').MaterialAsset>(reference)
    .unwrap();
  expect(f.owner.getMaterialProjectionForPayload(next)).toBe(projection);
  expect((await f.owner.load(f.record.guid, 'material')).unwrap()).toBe(reference);
  expect(f.fetcher).toHaveBeenCalledTimes(reads);
});

it('does not expose a runtime material whose inline shader bytes fail their material digest', async () => {
  const f = await fixture();
  const first = f.pack.assets[0];
  if (!first) throw new Error('missing material');
  const program = first.payload.cooked.programs[0];
  if (!program) throw new Error('missing program');
  program.artifact.bytes = Array.from({ length: f.firstProgram.artifact.bytes.length }, () => 0);
  const changes = f.owner.observe().unwrap();
  const result = await f.owner.load(f.record.guid, 'material');
  expect(result.ok).toBe(false);
  expect(f.shaders.findMaterialArtifact(f.firstProgram.specializationKey).ok).toBe(false);
  expect(changes.read().unwrap().changes).toHaveLength(0);
  changes.dispose();
});
