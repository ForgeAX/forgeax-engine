import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { prepareRuntimePackContent } from '@forgeax/engine-import';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import type { PluginPrograms } from '@forgeax/engine-plugin';
import type { MeshAsset, PackageFetcher, PackV2 } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected defined value');
  return value;
}

import { createAssetRuntimeAssembly } from '../assets-runtime-assembly.js';
import { assembleRuntimePacks } from '../runtime-packs.js';

async function fixture(programs?: PluginPrograms) {
  const assets = new AssetRegistry({} as never);
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({ entries: [] }),
  }).unwrap();
  const context = await createWorldContext(new World(), []);
  if (programs) context.provide('pluginPrograms', programs);
  const runtime = assembleRuntimePacks(context, assembly, { scopeId: 'prepared-integration' });
  assets.setCatalogSource(runtime.catalog, runtime.fetcher);
  return {
    assets,
    context,
    runtime,
    dispose: async () => {
      assets.clearCatalogSource();
      await context.fiber.dispose();
      assembly.dispose();
    },
  };
}

it('loads native Mesh without transport, exports only on demand, and survives fresh-reader decode', async () => {
  const f = await fixture();
  const other = new AssetRegistry({} as never);
  try {
    const mesh = createBoxGeometry(2, 3, 4).unwrap();
    const content = (
      await prepareRuntimePackContent('01900000-0000-7000-8000-000000000901', { mesh })
    ).unwrap();
    const read = vi.fn();
    const source = {
      ...f.runtime.catalog,
      openPackage(url: string) {
        const fetcher = f.runtime.catalog.openPackage?.(url);
        return fetcher === undefined
          ? undefined
          : (((input, init) => {
              read(String(input));
              return fetcher(String(input), init);
            }) satisfies PackageFetcher);
      },
    };
    f.assets.setCatalogSource(source, f.runtime.fetcher);
    const receipt = (await f.runtime.producer.admit(content)).unwrap();
    expect(receipt).not.toHaveProperty('content');
    expect(receipt.publication).not.toHaveProperty('pack');
    mesh.vertices.fill(99);
    const guid = defined(receipt.rows[0]).guid;
    const native = (await f.assets.loadByGuid<MeshAsset>(f.assets.parseGuid(guid))).unwrap();
    expect(read).not.toHaveBeenCalled();
    expect(native.vertices).toEqual(createBoxGeometry(2, 3, 4).unwrap().vertices);
    expect((await f.assets.loadByGuid(f.assets.parseGuid(guid))).unwrap()).toBe(native);
    other.setCatalogSource(source, f.runtime.fetcher);
    const decoded = (await other.loadByGuid<MeshAsset>(other.parseGuid(guid))).unwrap();
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const key of [
      'vertices',
      'indices',
      'attributes',
      'submeshes',
      'materialSlots',
      'aabb',
    ] as const)
      expect(decoded[key]).toEqual(native[key]);
    const first = await (
      await f.runtime.producer.fetch(defined(receipt.rows[0]).packageUrl)
    ).text();
    const again = await (
      await f.runtime.producer.fetch(defined(receipt.rows[0]).packageUrl)
    ).text();
    expect(first).toBe(again);
    native.vertices.fill(55);
    f.assets.invalidate(guid);
    const reloaded = (await f.assets.loadByGuid<MeshAsset>(f.assets.parseGuid(guid))).unwrap();
    expect(reloaded.vertices).toEqual(decoded.vertices);
  } finally {
    other.clearCatalogSource();
    await f.dispose();
  }
});

it('restores the provider when synchronous notification invalidates a candidate', async () => {
  const original: PluginPrograms = {
    target: 'engine',
    sessionId: 'prepared-test',
    contextId: 'prepared-test',
    sessionGeneration: 1,
    programs: new Map(),
    tools: new Map(),
    definitions: new Map(),
  };
  const f = await fixture(original);
  try {
    const set = f.context.set.bind(f.context);
    const patched = vi.spyOn(f.context, 'set').mockImplementation(((
      name: string,
      value: unknown,
    ) => {
      const result = set(name as never, value as never);
      if (name === 'pluginPrograms' && value !== original) f.assets.invalidateAll();
      return result;
    }) as typeof f.context.set);
    const content = (
      await prepareRuntimePackContent(
        '01900000-0000-7000-8000-000000000902',
        {
          behavior: { kind: 'plugin', module: { specifier: './behavior.js' } },
        },
        {
          programs: {
            behavior: {
              artifact: preparePackProgram({
                entry: 'behavior.js',
                export: 'default',
                modules: {
                  'behavior.js':
                    'export default { apply() { throw new Error("admission must not execute"); } };',
                },
              }).unwrap(),
            },
          },
        },
      )
    ).unwrap();
    const result = await f.runtime.producer.admit(content);
    expect(result.ok).toBe(false);
    expect(f.context.pluginPrograms).toBe(original);
    expect(f.runtime.producer.rows()).toEqual([]);
    expect(f.assets.loadState.get('01900000-0000-7000-8000-000000000902')).toBeUndefined();
    patched.mockRestore();
  } finally {
    await f.dispose();
  }
});

it.each([
  { coherent: false, body: false },
  { coherent: true, body: false },
  { coherent: true, body: true },
])('validates native Mesh artifacts before visibility (%j)', async ({ coherent, body }) => {
  const f = await fixture();
  const other = new AssetRegistry({} as never);
  try {
    const mesh = createBoxGeometry(2, 3, 4).unwrap();
    if (!coherent) mesh.vertices[0] = (mesh.vertices[0] ?? 0) + 10;
    const bytes = new Uint8Array([1, 2, 3]);
    const notePath = `${AssetGuid.format(AssetGuid.derive(definePackageId('01900000-0000-7000-8000-000000000903'), 'mesh'))}/body`;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    const content = {
      source: {
        schemaVersion: '3.0.0' as const,
        packageId: '01900000-0000-7000-8000-000000000903',
        assets: {
          mesh: {
            kind: 'mesh' as const,
            payload: mesh as unknown as Record<string, unknown>,
            refs: [],
            artifacts: {
              [body ? 'body' : 'note']: {
                path: notePath,
                mediaType: 'application/octet-stream',
                byteLength: 3,
                contentEncoding: 'identity',
                integrity: { algorithm: 'sha256', digest: `sha256:${digest}` },
              },
            },
          },
        },
      },
      blobs: { [notePath]: bytes },
    };
    const result = await f.runtime.producer.admit(content);
    expect(result.ok).toBe(coherent && !body);
    if (!result.ok) {
      expect(f.runtime.producer.rows()).toEqual([]);
      return;
    }
    const row = defined(result.value.rows[0]);
    const response = await f.runtime.producer.fetch(row.packageUrl);
    const pack = (await response.json()) as PackV2;
    expect(defined(defined(pack.assets[0]).artifacts.note).path).toBe(notePath);
    expect(
      new Uint8Array(
        await (
          await f.runtime.producer.fetch(new URL(notePath, row.packageUrl).href)
        ).arrayBuffer(),
      ),
    ).toEqual(bytes);
    other.setCatalogSource(f.runtime.catalog, f.runtime.fetcher);
    const restored = (await other.loadByGuid<MeshAsset>(other.parseGuid(row.guid))).unwrap();
    expect(restored.vertices).toEqual(mesh.vertices);
  } finally {
    other.clearCatalogSource();
    await f.dispose();
  }
});
