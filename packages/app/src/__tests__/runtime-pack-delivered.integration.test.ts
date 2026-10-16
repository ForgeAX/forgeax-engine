import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { RuntimePackSnapshot } from '@forgeax/engine-import';
import { serializeCookedMaterialRecord } from '@forgeax/engine-pack';
import { createRuntimePackPublication, preparePackProgram } from '@forgeax/engine-pack/runtime';
import { projectScriptablePackSceneComponents } from '@forgeax/engine-pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { CatalogEntry, MeshAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { materialRecordFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-publication.js';
import { compressZstd } from '../../../codec/src/encode/index.js';
import { normaliseForPack } from '../../../import/src/import-runner.js';
import { meshAssetOutputProducer } from '../../../import/src/scriptable-pack-output-producers.js';
import { createAssetRuntimeAssembly } from '../assets-runtime-assembly.js';
import { assembleRuntimePacks } from '../runtime-packs.js';

const meshGuid = '01900000-0000-7000-8000-000000000951';
const materialGuid = '01900000-0000-7000-8000-000000000952';
const generatorId = '01900000-0000-7000-8000-000000000953';
const instanceId = '01900000-0000-7000-8000-000000000954';
const catalogUrl = 'https://shipped.invalid/pack-index.json';
const packageUrl = 'https://shipped.invalid/assets/base.pack.json';

async function delivered() {
  const geometry = createBoxGeometry(2, 3, 4).unwrap();
  const mesh = (
    await meshAssetOutputProducer.produce({ guid: meshGuid, sourceKey: 'mesh', asset: geometry })
  ).unwrap();
  const body = mesh.artifacts.body;
  if (!body) throw new Error('missing mesh artifact');
  const compressed = await compressZstd(body.bytes);
  if (!compressed.ok) throw compressed.error;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(body.bytes)));
  const digest = `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const material = materialRecordFixture({ guid: materialGuid });
  const publication = createRuntimePackPublication({
    scopeId: 'original-game',
    sourcePath: 'shipped-source',
    sourceRevision: 'shipped-version',
    packageUrl: '/assets/base.pack.json',
    pack: {
      assets: [
        {
          guid: meshGuid,
          kind: 'mesh',
          payload: normaliseForPack(mesh.payload),
          refs: [],
          artifacts: {
            body: {
              path: 'mesh.bin.zst',
              mediaType: body.mediaType,
              contentEncoding: 'zstd',
              assetCodec: body.assetCodec,
              byteLength: body.bytes.length,
              integrity: { algorithm: 'sha256', digest },
            },
          },
        },
        {
          guid: materialGuid,
          kind: 'material',
          payload: {
            kind: 'material',
            ...material.resolved,
            cooked: JSON.parse(serializeCookedMaterialRecord(material)),
          },
          refs: [],
          artifacts: Object.fromEntries(
            material.programs.map(({ artifact }) => [
              artifact.path,
              {
                path: artifact.path,
                mediaType: artifact.mediaType,
                contentEncoding: 'identity',
                byteLength: artifact.bytes.length,
                integrity: { algorithm: 'sha256', digest: artifact.digest },
              },
            ]),
          ),
        },
      ],
    },
  });
  // Shipped legacy rows legitimately omit packageId/sourceKey and use relative locators.
  const rows: CatalogEntry[] = publication.publication.outputs.map((output) => ({
    guid: output.guid,
    kind: output.kind,
    sourcePath: 'shipped-source',
    packageUrl: '/assets/base.pack.json',
    publication: publication.publication,
  }));
  const bodies = new Map([
    [new URL('mesh.bin.zst', packageUrl).href, compressed.value],
    ...material.programs.map(
      ({ artifact }) => [new URL(artifact.path, packageUrl).href, artifact.bytes] as const,
    ),
  ]);
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url) === catalogUrl) return new Response(JSON.stringify(rows));
    if (String(url) === packageUrl) return new Response(JSON.stringify(publication.pack));
    const bytes = bodies.get(String(url));
    return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 });
  });
  return {
    geometry,
    publication,
    fetcher,
    catalog: createCatalogSource({ url: catalogUrl, fetch: fetcher }),
  };
}

it('uses the default App dependency source and restores a generated Scene with shipped Mesh and cooked Material offline', async () => {
  const original = await delivered();
  const imports = {
    pack: { identity: 'test-engine', url: import.meta.resolve('@forgeax/engine-pack/source') },
  };
  const create = async (restoring: boolean) => {
    const world = new World();
    const context = await createWorldContext(world, []);
    const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    const offline = vi.fn<typeof fetch>(async () => {
      throw new Error('offline restore used the network');
    });
    const assembly = createAssetRuntimeAssembly(registry, {
      catalogSource: restoring ? createCatalogSource({ entries: [] }) : original.catalog,
      fetcher: restoring ? offline : original.fetcher,
    }).unwrap();
    const runtime = assembleRuntimePacks(context, assembly, {
      scopeId: restoring ? 'fresh-game' : 'original-game',
      imports,
    });
    return {
      runtime,
      registry,
      offline,
      async close() {
        await context.fiber.dispose();
        assembly.dispose();
      },
    };
  };
  const live = await create(false);
  let saved: RuntimePackSnapshot | undefined;
  try {
    const admission = await live.runtime.producer.admit({
      source: {
        schemaVersion: '2.0.0',
        kind: 'scriptable-pack-source',
        source: 'copy.js',
        packageId: generatorId,
        program: 'copy',
        runtime: { dependencies: [meshGuid, materialGuid] },
        parameters: [{ name: 'offset', type: 'f32', default: 0, minimum: 0, maximum: 10 }],
        sceneComponents: projectScriptablePackSceneComponents([
          Transform,
          MeshFilter,
          MeshRenderer,
        ]),
      },
      dependencies: Object.fromEntries(
        original.publication.publication.outputs.map((output) => [output.guid, output.digest]),
      ),
      programs: {
        copy: {
          artifact: preparePackProgram({
            entry: 'copy.js',
            export: 'build',
            imports: { pack: 'test-engine' },
            modules: {
              'copy.js': `import { AssetGuid } from 'pack'; export async function build({ readByGuid, values }) { const parsed = AssetGuid.parse('${meshGuid}'); if (!parsed.ok) return parsed; const mesh = await readByGuid(parsed.value); if (!mesh.ok) return mesh; return { ok: true, value: { copy: mesh.value, scene: { kind: 'scene', entities: { mesh: { components: { Transform: { pos: [values.offset, 0, 0] }, MeshFilter: { assetHandle: '${meshGuid}' }, MeshRenderer: { materials: ['${materialGuid}'] } } } } } } }; }`,
            },
          }).unwrap(),
        },
      },
    });
    expect(admission.ok, JSON.stringify(admission)).toBe(true);
    const generated = await live.runtime.producer.generate({
      schemaVersion: '3.0.0',
      packageId: instanceId,
      parent: generatorId,
      values: { offset: 2 },
    });
    expect(generated.ok, JSON.stringify(generated)).toBe(true);
    saved = JSON.parse(JSON.stringify(live.runtime.producer.snapshot()));
  } finally {
    await live.close();
  }
  original.fetcher.mockImplementation(async () => {
    throw new Error('original producer is gone');
  });
  const restored = await create(true);
  try {
    if (!saved) throw new Error('missing saved fixture');
    const result = await restored.runtime.producer.restore(saved);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const rows = (await restored.registry.enumerateCatalog()).unwrap();
    const mesh = (
      await restored.registry.loadByGuid<MeshAsset>(restored.registry.parseGuid(meshGuid))
    ).unwrap();
    expect(mesh.attributes.position).toEqual(original.geometry.attributes.position);
    expect(mesh.indices).toEqual(original.geometry.indices);
    expect((await restored.registry.loadByGuid(restored.registry.parseGuid(materialGuid))).ok).toBe(
      true,
    );
    const source = rows.find((row) => row.guid === meshGuid);
    expect(source?.packageId).toBeUndefined();
    expect(source?.sourceKey).toBeUndefined();
    expect(source?.publication?.generation).toBe(original.publication.pack.generation);
    expect(source?.publication?.digest).toBe(original.publication.pack.digest);
    expect(rows).toHaveLength(4);
    expect(restored.offline).not.toHaveBeenCalled();
  } finally {
    await restored.close();
  }
});
