import { createBoxGeometry } from '@forgeax/engine-geometry';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  type CatalogDelta,
  type CatalogEntry,
  createStandaloneRuntimeAssetBinding,
  ok,
  type PluginAsset,
} from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { normaliseForPack } from '../../../import/src/import-runner.js';
import { meshAssetOutputProducer } from '../../../import/src/scriptable-pack-output-producers.js';
import { AssetRegistry } from '../asset-registry.js';
import type { CatalogSource } from '../catalog-source.js';
import { defined } from './assert-defined.js';

const guid = '01900000-0000-7000-8000-000000000041';
const other = '01900000-0000-7000-8000-000000000042';
describe('explicit producer source and content transport', () => {
  it.each([
    false,
    true,
  ])('loads the real binary Mesh through its source with a prior dev binding: %s', async (bound) => {
    const original = createBoxGeometry(2, 3, 4).unwrap();
    const product = (
      await meshAssetOutputProducer.produce({ guid, sourceKey: 'box', asset: original })
    ).unwrap();
    const body = defined(product.artifacts.body);
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(body.bytes));
    const digest = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const packageUrl = 'https://runtime.invalid/mesh/pack.json';
    const { pack } = createRuntimePackPublication({
      pack: {
        assets: [
          {
            guid,
            kind: 'mesh',
            payload: normaliseForPack(product.payload),
            refs: [],
            artifacts: {
              body: {
                path: 'mesh.bin',
                mediaType: body.mediaType,
                assetCodec: body.assetCodec,
                byteLength: body.bytes.byteLength,
                integrity: { algorithm: 'sha256', digest },
              },
            },
          },
        ],
      },
      scopeId: 'runtime-mesh',
      sourcePath: 'mesh',
      sourceRevision: 'mesh',
      packageUrl,
    });
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input) === packageUrl
        ? new Response(JSON.stringify(pack))
        : String(input) === new URL('mesh.bin', packageUrl).href
          ? new Response(new Uint8Array(body.bytes))
          : new Response('', { status: 404 }),
    );
    const registry = new AssetRegistry({} as never);
    if (bound)
      registry.configureRuntimeBinding(createStandaloneRuntimeAssetBinding('runtime-mesh'));
    registry.setCatalogSource({
      openPackage: () => fetcher,
      enumerate: async () =>
        ok([{ guid, kind: 'mesh', packageUrl, sourcePath: 'mesh', sourceKey: 'box' }]),
      subscribe: () => () => {},
    });
    const loaded = (await registry.loadByGuid<MeshAsset>(registry.parseGuid(guid))).unwrap();
    expect(loaded.attributes.position).toEqual(original.attributes.position);
    expect(loaded.indices).toEqual(original.indices);
    expect(loaded.aabb).toEqual(original.aabb);
    expect(fetcher).toHaveBeenCalledTimes(2);
    registry.clearCatalogSource();
  });
  it('loads newly published definitions without a pack-index URL and invalidates only changed GUIDs', async () => {
    const rows: CatalogEntry[] = [];
    const listeners = new Set<(delta: CatalogDelta) => void>();
    const bodies = new Map<string, unknown>();
    const catalog: CatalogSource = {
      enumerate: async () => ok([...rows]),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const body = bodies.get(String(input));
      return new Response(body === undefined ? '' : JSON.stringify(body), {
        status: body === undefined ? 404 : 200,
      });
    });
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(catalog, fetcher);
    expect((await registry.enumerateCatalog()).unwrap()).toEqual([]);
    const publish = (id: string, generation: number) => {
      const packageUrl = `https://runtime.invalid/${id}/${generation}/pack.json`;
      const row = {
        guid: id,
        kind: 'plugin',
        packageUrl,
        sourcePath: `runtime/${id}`,
        sourceKey: 'plugin',
      };
      bodies.set(packageUrl, {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        scopeId: 'runtime-fixture',
        generation,
        digest: `sha256:${'a'.repeat(64)}`,
        outputSetDigest: `sha256:${'b'.repeat(64)}`,
        assets: [
          {
            guid: id,
            kind: 'plugin',
            payload: { kind: 'plugin', program: `runtime:${id}`, config: { generation } },
            refs: [],
            artifacts: {},
          },
        ],
      });
      const index = rows.findIndex((value) => value.guid === id);
      if (index < 0) rows.push(row);
      else rows[index] = row;
      for (const listener of listeners)
        listener({ added: index < 0 ? [row] : [], changed: index < 0 ? [] : [row], removed: [] });
    };
    publish(guid, 1);
    publish(other, 1);
    expect(
      (await registry.enumerateCatalog())
        .unwrap()
        .map((row) => row.guid)
        .sort(),
    ).toEqual([guid, other].sort());
    const first = (await registry.loadByGuid<PluginAsset>(registry.parseGuid(guid))).unwrap();
    const bystander = (await registry.loadByGuid<PluginAsset>(registry.parseGuid(other))).unwrap();
    expect(first.config).toEqual({ generation: 1 });
    expect((await registry.readPluginDefinition(guid)).unwrap().asset.config).toEqual({
      generation: 1,
    });
    publish(guid, 2);
    const updated = (await registry.loadByGuid<PluginAsset>(registry.parseGuid(guid))).unwrap();
    expect(updated.config).toEqual({ generation: 2 });
    expect(first.config).toEqual({ generation: 1 });
    expect((await registry.loadByGuid<PluginAsset>(registry.parseGuid(other))).unwrap()).toBe(
      bystander,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(registry.packIndexUrl).toBeUndefined();
    rows.splice(
      rows.findIndex((row) => row.guid === guid),
      1,
    );
    for (const listener of listeners) listener({ added: [], changed: [], removed: [guid] });
    expect((await registry.loadByGuid<PluginAsset>(registry.parseGuid(guid))).ok).toBe(false);
    expect(registry.lookup(guid)).toBeUndefined();
    registry.clearCatalogSource();
    expect(listeners.size).toBe(0);
  });
});
