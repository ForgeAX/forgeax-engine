/// <reference types="node" />
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { meshAssetOutputProducer, normaliseForPack } from '@forgeax/engine-import';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { MeshAsset, PackageRequest } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WechatCacheFiles } from '../download-cache.js';
import { createWechatRemotePackageFetcher, type WechatDownloadSource } from '../remote-fetch.js';

const baseUrl = 'https://cdn.example/game/';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  vi.unstubAllGlobals();
});

function complete<T>(
  promise: Promise<T>,
  options: { success(value: T): void; fail(cause: unknown): void },
): void {
  void promise.then(options.success, options.fail);
}

async function fixture(maxBytes = 4096) {
  const root = await fs.mkdtemp(join(tmpdir(), 'forgeax-download-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const cacheDirectory = join(root, 'cache');
  const files: WechatCacheFiles = {
    readFile: (options) =>
      complete(
        fs.readFile(options.filePath).then((data) => ({ data: new Uint8Array(data).buffer })),
        options,
      ),
    unlink: (options) => complete(fs.unlink(options.filePath), options),
    // Native wx rejects mkdir on an existing path, including recursive calls.
    mkdir: (options) => complete(fs.mkdir(options.dirPath), options),
    readdir: (options) =>
      complete(
        fs.readdir(options.dirPath).then((files) => ({ files })),
        options,
      ),
    stat: (options) =>
      complete(
        fs
          .stat(options.path)
          .then((stats) => ({ stats: { size: stats.size, lastModifiedTime: stats.mtimeMs } })),
        options,
      ),
    writeFile: (options) =>
      complete(fs.writeFile(options.filePath, new Uint8Array(options.data)), options),
    rename: (options) => complete(fs.rename(options.oldPath, options.newPath), options),
  };
  const bodies = new Map<string, Uint8Array>();
  const errors: unknown[] = [];
  const downloadFile = vi.fn<WechatDownloadSource['downloadFile']>((options) => {
    const path = options.filePath;
    let live = true;
    queueMicrotask(() => {
      const body = bodies.get(options.url);
      void fs.writeFile(path, body ?? new Uint8Array()).then(async () => {
        if (live) options.success({ filePath: path, statusCode: body ? 200 : 404 });
        else await fs.unlink(path);
      });
    });
    return {
      abort() {
        live = false;
        options.fail({ errMsg: 'downloadFile:fail abort' });
      },
    };
  });
  const source: WechatDownloadSource = {
    env: { USER_DATA_PATH: root },
    getFileSystemManager: () => files,
    downloadFile,
  };
  const options = {
    baseUrl,
    directory: cacheDirectory,
    onError: (cause: unknown) => errors.push(cause),
    cache: { publicationDigest: 'sha256:publication-a', maxBytes },
  };
  const create = (
    overrides: Partial<Omit<typeof options, 'cache'>> & {
      cache?: typeof options.cache | undefined;
    } = {},
  ) => {
    const { cache, ...rest } = { ...options, ...overrides };
    const reader = createWechatRemotePackageFetcher(source, {
      ...rest,
      ...(cache ? { cache } : {}),
    });
    cleanup.push(() => reader.dispose());
    return reader;
  };
  return { source, files, bodies, errors, root, cacheDirectory, options, downloadFile, create };
}

describe('native remote PackageFetcher', () => {
  it.each([
    false,
    true,
  ])('loads a producer Mesh through Catalog without browser fetch/crypto (corrupt=%s)', async (corrupt) => {
    const f = await fixture(32_000);
    const guid = '01900000-0000-7000-8000-000000000041';
    const mesh = createBoxGeometry(2, 3, 4).unwrap();
    const product = (
      await meshAssetOutputProducer.produce({ guid, sourceKey: 'box', asset: mesh })
    ).unwrap();
    const body = product.artifacts.body;
    if (!body) throw new Error('mesh body missing');
    const packageUrl = `${baseUrl}mesh/pack.json`;
    const { pack } = createRuntimePackPublication({
      scopeId: 'download-test',
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
                integrity: {
                  algorithm: 'sha256',
                  digest: `sha256:${createHash('sha256').update(body.bytes).digest('hex')}`,
                },
              },
            },
          },
        ],
      },
    });
    f.bodies.set(packageUrl, new TextEncoder().encode(JSON.stringify(pack)));
    const bytes = new Uint8Array(body.bytes).slice();
    if (corrupt) bytes[0] = (bytes[0] ?? 0) ^ 1;
    f.bodies.set(`${baseUrl}mesh/mesh.bin`, bytes);
    for (const name of ['fetch', 'Request', 'Response', 'Headers', 'crypto'])
      vi.stubGlobal(name, undefined);
    const reader = f.create();
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(
      createCatalogSource({
        fetch: reader.fetch,
        entries: [{ guid, kind: 'mesh', packageUrl, sourcePath: 'mesh', sourceKey: 'box' }],
      }),
    );
    try {
      const loaded = await registry.loadByGuid<MeshAsset>(registry.parseGuid(guid));
      if (corrupt)
        expect(loaded).toMatchObject({
          ok: false,
          error: { code: 'asset-artifact-integrity-mismatch' },
        });
      else {
        const value = loaded.unwrap();
        expect(value.attributes.position).toEqual(mesh.attributes.position);
        expect(value.indices).toEqual(mesh.indices);
        expect(value.aabb).toEqual(mesh.aabb);
      }
      expect(f.errors).toEqual([]);
    } finally {
      registry.clearCatalogSource();
    }
  });

  it('recovers a persisted cache, removes crash partials, and keeps publication revisions separate', async () => {
    const f = await fixture();
    f.bodies.set(`${baseUrl}body`, new TextEncoder().encode('published bytes'));
    const first = f.create();
    expect(await (await first.fetch('body')).text()).toBe('published bytes');
    await first.dispose();
    await fs.writeFile(join(f.cacheDirectory, `${'0'.repeat(64)}.part`), 'interrupted write');
    await fs.writeFile(
      join(f.cacheDirectory, `${'0'.repeat(64)}-1.download`),
      'interrupted download',
    );
    const second = f.create();
    expect(await (await second.fetch('body')).text()).toBe('published bytes');
    expect(f.downloadFile).toHaveBeenCalledTimes(1);
    expect((await fs.readdir(f.cacheDirectory)).filter((name) => name.endsWith('.part'))).toEqual(
      [],
    );
    expect(
      (await fs.readdir(f.cacheDirectory)).filter((name) => name.endsWith('.download')),
    ).toEqual([]);
    await second.dispose();
    f.bodies.set(`${baseUrl}body`, new TextEncoder().encode('next publication'));
    const next = f.create({
      cache: { ...f.options.cache, publicationDigest: 'sha256:publication-b' },
    });
    expect(await (await next.fetch('body')).text()).toBe('next publication');
    expect(f.downloadFile).toHaveBeenCalledTimes(2);
  });

  it('discards same-size corrupt cache bytes and downloads the same resource again', async () => {
    const f = await fixture();
    f.bodies.set(`${baseUrl}body`, new TextEncoder().encode('correct bytes'));
    const reader = f.create();
    await reader.fetch('body');
    const [name] = await fs.readdir(f.cacheDirectory);
    if (!name) throw new Error('cache missing');
    const path = join(f.cacheDirectory, name);
    const stored = await fs.readFile(path);
    stored[stored.length - 1] = (stored[stored.length - 1] ?? 0) ^ 1;
    await fs.writeFile(path, stored);
    expect(await (await reader.fetch('body')).text()).toBe('correct bytes');
    expect(f.downloadFile).toHaveBeenCalledTimes(2);
    expect(f.errors).toHaveLength(1);
    expect(String(f.errors[0])).toContain('checksum mismatch');
  });

  it('evicts bounded disk projections while retained response bytes remain usable', async () => {
    const f = await fixture(40);
    f.bodies.set(`${baseUrl}a`, new Uint8Array([1, 2, 3, 4]));
    f.bodies.set(`${baseUrl}b`, new Uint8Array([5, 6, 7, 8]));
    const reader = f.create();
    const a = await reader.fetch('a');
    await reader.fetch('b');
    const names = await fs.readdir(f.cacheDirectory);
    expect(names).toHaveLength(1);
    expect((await fs.stat(join(f.cacheDirectory, names[0] ?? ''))).size).toBeLessThanOrEqual(40);
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    await reader.fetch('a');
    expect(f.downloadFile).toHaveBeenCalledTimes(3);
  });

  it('preserves HTTP failure status and never caches its temporary error body', async () => {
    const f = await fixture();
    const reader = f.create();
    const response = await reader.fetch('missing');
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    expect(await fs.readdir(f.cacheDirectory)).toEqual([]);
    expect((await fs.readdir(f.root)).filter((name) => name.startsWith('download-'))).toEqual([]);
  });

  it('preserves native failure causes and permits a new attempt', async () => {
    const f = await fixture();
    const cause = { errMsg: 'downloadFile:fail domain not configured', errno: 42 };
    f.downloadFile.mockImplementationOnce((options) => {
      queueMicrotask(() => options.fail(cause));
      return { abort() {} };
    });
    const reader = f.create();
    await expect(reader.fetch('body')).rejects.toMatchObject({
      code: 'platform-operation-failed',
      detail: { operation: 'wx.downloadFile', cause },
    });
    f.bodies.set(`${baseUrl}body`, new Uint8Array([3]));
    expect(new Uint8Array(await (await reader.fetch('body')).arrayBuffer())).toEqual(
      new Uint8Array([3]),
    );
  });

  it('owns the native destination without caching and removes partial failed downloads', async () => {
    const f = await fixture();
    const reader = f.create({ cache: undefined });
    f.bodies.set(`${baseUrl}body`, new Uint8Array([1, 2]));
    expect(new Uint8Array(await (await reader.fetch('body')).arrayBuffer())).toEqual(
      new Uint8Array([1, 2]),
    );
    expect(f.downloadFile.mock.calls[0]?.[0].filePath).toMatch(
      new RegExp(`^${f.cacheDirectory}/[0-9a-f]{64}-[0-9]+\\.download$`),
    );
    expect(await fs.readdir(f.cacheDirectory)).toEqual([]);
    const cause = { errMsg: 'downloadFile:fail connection closed' };
    f.downloadFile.mockImplementationOnce((options) => {
      void fs.writeFile(options.filePath, 'partial').then(() => options.fail(cause));
      return { abort() {} };
    });
    await expect(reader.fetch('body')).rejects.toMatchObject({
      detail: { operation: 'wx.downloadFile', cause },
    });
    expect(await fs.readdir(f.cacheDirectory)).toEqual([]);
  });

  it('allows producer recovery to reload a repaired response and bypass persistence explicitly', async () => {
    const f = await fixture();
    f.bodies.set(`${baseUrl}body`, new TextEncoder().encode('damaged publication bytes'));
    const reader = f.create();
    await reader.fetch('body');
    f.bodies.set(`${baseUrl}body`, new TextEncoder().encode('repaired publication bytes'));
    expect(await (await reader.fetch('body', { cache: 'reload' })).text()).toBe(
      'repaired publication bytes',
    );
    f.bodies.delete(`${baseUrl}body`);
    expect(await (await reader.fetch('body')).text()).toBe('repaired publication bytes');
    f.bodies.set(`${baseUrl}private`, new Uint8Array([1, 2, 3]));
    await reader.fetch('private', { cache: 'no-store' });
    await reader.fetch('private', { cache: 'no-store' });
    expect(f.downloadFile).toHaveBeenCalledTimes(4);
    expect(await fs.readdir(f.cacheDirectory)).toHaveLength(1);
  });

  it('cancels native downloads, rejects new work after disposal and removes a late temporary file', async () => {
    const f = await fixture();
    let callbacks: Parameters<WechatDownloadSource['downloadFile']>[0] | undefined;
    const abort = vi.fn();
    f.downloadFile.mockImplementation((options) => {
      callbacks = options;
      return { abort };
    });
    const reader = f.create();
    const controller = new AbortController();
    const failure = new Error('caller retired');
    const pending = reader.fetch('body', { signal: controller.signal });
    const observed = expect(pending).rejects.toBe(failure);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    controller.abort(failure);
    await observed;
    expect(abort).toHaveBeenCalledTimes(1);
    let retired = false;
    const disposal = reader.dispose().then(() => {
      retired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(retired).toBe(false);
    expect(() => f.create()).toThrow('live Host owner');
    const path = callbacks?.filePath;
    if (!path) throw new Error('native download needs an owned destination');
    await fs.writeFile(path, 'late');
    callbacks?.success({ filePath: path, statusCode: 200 });
    await vi.waitFor(async () => expect(await fs.readdir(f.cacheDirectory)).toEqual([]));
    expect(await fs.readdir(f.cacheDirectory)).toEqual([]);
    await disposal;
    await expect(reader.fetch('body')).rejects.toMatchObject({ code: 'platform-disposed' });
    expect(f.errors).toEqual([]);
  });

  it('drains a native file read before releasing its cache lease on disposal', async () => {
    const f = await fixture();
    f.bodies.set(`${baseUrl}body`, new Uint8Array([1]));
    let read: Parameters<WechatCacheFiles['readFile']>[0] | undefined;
    f.files.readFile = (options) => {
      read = options;
    };
    const reader = f.create();
    const pending = reader.fetch('body');
    const observed = expect(pending).rejects.toMatchObject({ code: 'platform-disposed' });
    await vi.waitFor(() => expect(read).toBeDefined());
    let done = false;
    const disposed = reader.dispose().then(() => {
      done = true;
    });
    await observed;
    expect(done).toBe(false);
    expect(() => f.create()).toThrow('live Host owner');
    read?.success({ data: new Uint8Array([1]).buffer });
    await disposed;
    expect(await fs.readdir(f.cacheDirectory)).toEqual([]);
    const next = f.create();
    await reader.dispose();
    expect(() => f.create()).toThrow('live Host owner');
    await next.dispose();
  });

  it('keeps the caller abort reason when native abort synchronously calls fail', async () => {
    const f = await fixture();
    const nativeFailure = { errMsg: 'downloadFile:fail abort' };
    f.downloadFile.mockImplementation((options) => ({ abort: () => options.fail(nativeFailure) }));
    const reader = f.create();
    const controller = new AbortController();
    const reason = new Error('requested cancellation');
    const pending = reader.fetch('body', { signal: controller.signal });
    const observed = expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expect(f.downloadFile).toHaveBeenCalledOnce());
    controller.abort(reason);
    await observed;
  });

  it('does not evict or write after cancellation while cache initialization is awaiting native I/O', async () => {
    const f = await fixture(40);
    await fs.mkdir(f.cacheDirectory);
    const name = `${'1'.repeat(64)}.bin`;
    await fs.writeFile(join(f.cacheDirectory, name), new Uint8Array(80));
    let listing: Parameters<WechatCacheFiles['readdir']>[0] | undefined;
    f.files.readdir = (options) => {
      listing = options;
    };
    const reader = f.create();
    const controller = new AbortController();
    const reason = new Error('initialization cancelled');
    const pending = reader.fetch('body', { signal: controller.signal });
    const observed = expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expect(listing).toBeDefined());
    controller.abort(reason);
    listing?.success({ files: [name] });
    await observed;
    expect((await fs.stat(join(f.cacheDirectory, name))).size).toBe(80);
    expect(f.downloadFile).not.toHaveBeenCalled();
  });

  it('reports cache quota failure but retains downloaded bytes and clears the partial file', async () => {
    const f = await fixture();
    f.bodies.set(`${baseUrl}body`, new Uint8Array([1, 2]));
    const cause = { errMsg: 'writeFile:fail quota exceeded', errno: 28 };
    f.files.writeFile = (options) => {
      void fs.writeFile(options.filePath, new Uint8Array([0])).then(() => options.fail(cause));
    };
    const reader = f.create();
    expect(new Uint8Array(await (await reader.fetch('body')).arrayBuffer())).toEqual(
      new Uint8Array([1, 2]),
    );
    expect(f.errors).toEqual([
      expect.objectContaining({
        code: 'platform-operation-failed',
        detail: { operation: 'cache write', cause },
      }),
    ]);
    expect(await fs.readdir(f.cacheDirectory)).toEqual([]);
  });

  it('confines reads, cache writes and method semantics before native work', async () => {
    const f = await fixture();
    const reader = f.create();
    for (const url of [
      '../escape',
      '%2e%2e%2fescape',
      'https://other.example/game/file',
      'https://name:secret@cdn.example/game/file',
      'file?query=1',
      'file#fragment',
    ])
      await expect(reader.fetch(url)).rejects.toThrow('namespace');
    await expect(reader.fetch('file', { method: 'POST' })).rejects.toThrow('read-only');
    await expect(
      reader.fetch('file', { headers: { Authorization: 'unused' } } as PackageRequest),
    ).rejects.toThrow('only GET');
    expect(f.downloadFile).not.toHaveBeenCalled();
    expect(() => f.create({ directory: join(f.root, '../escape') })).toThrow('dedicated child');
  });
});
