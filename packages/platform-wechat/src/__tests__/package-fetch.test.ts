/// <reference types="node" />
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { meshAssetOutputProducer, normaliseForPack } from '@forgeax/engine-import';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { MeshAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWechatPackageFetcher, type WechatPackageSource } from '../package-fetch.js';

const baseUrl = 'https://published.invalid/game/';
const guid = '01900000-0000-7000-8000-000000000041';
afterEach(() => vi.unstubAllGlobals());

function files(bodies: Map<string, Uint8Array>): WechatPackageSource {
  return {
    getFileSystemManager: () => ({
      readFile(options) {
        const body = bodies.get(options.filePath);
        queueMicrotask(() =>
          body === undefined
            ? options.fail({ errMsg: 'readFile:fail file not found' })
            : options.success({ data: body.slice().buffer }),
        );
      },
      readCompressedFile(options) {
        const body = bodies.get(options.filePath);
        if (!body) {
          options.fail(new Error('missing compressed file'));
          return;
        }
        try {
          options.success({ data: new Uint8Array(brotliDecompressSync(body)).buffer });
        } catch (cause) {
          options.fail(cause);
        }
      },
    }),
  };
}

describe('native package transport', () => {
  it.each([
    { failure: undefined, compressed: false },
    { failure: 'digest', compressed: false },
    { failure: 'truncated', compressed: false },
    { failure: undefined, compressed: true },
    { failure: 'digest', compressed: true },
    { failure: 'truncated', compressed: true },
  ])('loads and verifies a produced binary mesh without browser globals (%j)', async ({
    failure,
    compressed,
  }) => {
    const mesh = createBoxGeometry(2, 3, 4).unwrap();
    const product = (
      await meshAssetOutputProducer.produce({ guid, sourceKey: 'box', asset: mesh })
    ).unwrap();
    const body = product.artifacts.body;
    if (!body) throw new Error('mesh producer omitted its binary body');
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(body.bytes));
    const digest = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const packageUrl = `${baseUrl}mesh/pack.json`;
    const { pack } = createRuntimePackPublication({
      scopeId: 'native-game',
      sourcePath: 'mesh',
      sourceRevision: 'fixed',
      packageUrl,
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
    });
    const bodies = new Map([
      ['graphics/mesh/pack.json', new TextEncoder().encode(JSON.stringify(pack))],
      ['graphics/mesh/mesh.bin', new Uint8Array(body.bytes)],
    ]);
    if (failure === 'digest') {
      const stored = bodies.get('graphics/mesh/mesh.bin');
      if (!stored) throw new Error('missing test body');
      stored[0] = (stored[0] ?? 0) ^ 1;
    }
    if (failure === 'truncated')
      bodies.set('graphics/mesh/mesh.bin', new Uint8Array(body.bytes).slice(0, -1));
    const published: Map<string, Uint8Array> = compressed
      ? new Map([...bodies].map(([path, bytes]) => [`${path}.br`, brotliCompressSync(bytes)]))
      : bodies;
    const fetcher = createWechatPackageFetcher(files(published), {
      root: 'graphics',
      baseUrl,
      ...(compressed ? { encoding: 'br' as const } : {}),
    });
    for (const name of ['fetch', 'Request', 'Response', 'Headers', 'crypto'])
      vi.stubGlobal(name, undefined);
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(
      createCatalogSource({
        fetch: fetcher,
        entries: [{ guid, kind: 'mesh', packageUrl, sourcePath: 'mesh', sourceKey: 'box' }],
      }),
    );
    try {
      let result = await registry.loadByGuid<MeshAsset>(registry.parseGuid(guid));
      if (failure) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'asset-artifact-integrity-mismatch' },
        });
        expect(registry.lookup(guid)).toBeUndefined();
        published.set(
          `graphics/mesh/mesh.bin${compressed ? '.br' : ''}`,
          compressed ? brotliCompressSync(body.bytes) : new Uint8Array(body.bytes),
        );
        result = await registry.loadByGuid<MeshAsset>(registry.parseGuid(guid));
      }
      const loaded = result.unwrap();
      expect(loaded.attributes.position).toEqual(mesh.attributes.position);
      expect(loaded.indices).toEqual(mesh.indices);
      expect(loaded.aabb).toEqual(mesh.aabb);
    } finally {
      registry.clearCatalogSource();
    }
  });

  it.each([
    'before',
    'after',
  ] as const)('fences cancellation %s native success and can retry the same file', async (timing) => {
    let pending:
      | Parameters<ReturnType<WechatPackageSource['getFileSystemManager']>['readFile']>[0]
      | undefined;
    const fetcher = createWechatPackageFetcher(
      {
        getFileSystemManager: () => ({
          readFile(options) {
            pending = options;
          },
        }),
      },
      { root: 'graphics', baseUrl },
    );
    const controller = new AbortController();
    const failure = new Error('reader stopped');
    const first = fetcher('scene.json', { signal: controller.signal });
    const observed = expect(first).rejects.toBe(failure);
    if (timing === 'after')
      pending?.success({ data: new TextEncoder().encode('{"old":true}').buffer });
    controller.abort(failure);
    pending?.success({ data: new TextEncoder().encode('{"old":true}').buffer });
    await observed;
    const second = fetcher('scene.json');
    pending?.success({ data: new TextEncoder().encode('{"current":true}').buffer });
    const response = await second;
    expect(await response.json()).toEqual({ current: true });
    await expect(response.arrayBuffer()).rejects.toThrow('already been consumed');
  });

  it('preserves native failure and confines reads to the producer namespace', async () => {
    const cause = { errMsg: 'native read failure', errno: 123 };
    const read = vi.fn(
      (
        options: Parameters<ReturnType<WechatPackageSource['getFileSystemManager']>['readFile']>[0],
      ) => options.fail(cause),
    );
    const fetcher = createWechatPackageFetcher(
      { getFileSystemManager: () => ({ readFile: read }) },
      { root: 'graphics', baseUrl },
    );
    await expect(fetcher('missing.pack.json')).rejects.toMatchObject({ cause });
    await expect(fetcher('../escape')).rejects.toThrow('outside');
    await expect(fetcher('https://other.invalid/file')).rejects.toThrow('outside');
    await expect(fetcher('%2e%2e%2fescape')).rejects.toThrow('invalid');
    await expect(fetcher('file', { method: 'POST' })).rejects.toThrow('read-only');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
