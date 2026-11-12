import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createServer } from 'vite';
import { expect, it, vi } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

const encoder = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:zlib', async () => {
  const native = await vi.importActual<typeof import('node:zlib')>('node:zlib');
  return {
    ...native,
    gzip(...args: Parameters<typeof native.gzip>) {
      encoder.calls++;
      return native.gzip(...args);
    },
  };
});

it.each([
  'bytes',
  'mime',
])('shares separate authored products and invalidates changed %s', async (change) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-authored-artifact-sharing-'));
  const assets = join(root, 'assets');
  const binding = createStandaloneRuntimeAssetBinding('authored-artifact-sharing');
  const source = (index: number, marker = 7, mime = 'application/octet-stream') => `export default {
    schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(${index + 1}),
    build() { return { ok: true, value: {
      body: { kind: 'fixture-shared-binary', execution: 'cooked', source: { marker: ${marker}, mime: '${mime}' } }
    } }; }
  };`;
  const cook = vi.fn<NativeCooker['cook']>(({ guid, source }) => {
    const { marker, mime } = source as { marker: number; mime: string };
    return {
      guid,
      payload: { kind: 'fixture-shared-binary', marker },
      refs: [],
      artifacts: { body: { mediaType: mime, bytes: new Uint8Array(2048).fill(marker) } },
      inputFingerprint: `${marker}:${mime}`,
    };
  });
  const open = async () => {
    encoder.calls = 0;
    const plugin = createPluginPackInternal({
      roots: [assets],
      watch: false,
      runtimeBinding: binding,
      cookers: [{ key: 'fixture-shared-binary', cacheIdentity: () => 'fixture/1', cook }],
      ddc: {
        buildCacheRoot: join(root, 'build-cache'),
        identityRoot: root,
        projectDdcRoot: join(root, 'project-ddc'),
      },
    });
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    try {
      await server.listen();
      await plugin.ready();
      const base = server.resolvedUrls?.local?.[0];
      if (!base) throw Error('Missing actual Vite URL');
      const catalogResponse = await fetch(new URL(binding.catalogUrl, base));
      expect(catalogResponse.status).toBe(200);
      const wire = await catalogResponse.json();
      const catalog = decodeCatalogWire(wire.entries ?? wire).unwrap();
      expect(catalog).toHaveLength(2);
      const responses = [];
      for (const row of [...catalog].sort((a, b) => a.guid.localeCompare(b.guid))) {
        const packUrl = new URL(row.packageUrl, base);
        const packResponse = await fetch(packUrl);
        expect(packResponse.status).toBe(200);
        const pack = await packResponse.json();
        const descriptor = pack.assets[0]?.artifacts.body;
        if (!descriptor) throw Error('Missing accepted artifact descriptor');
        const response = await fetch(new URL(descriptor.path, packUrl), {
          headers: { 'accept-encoding': 'gzip' },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-encoding')).toBe('gzip');
        expect(response.headers.get('content-type')).toBe(descriptor.mediaType);
        // Node fetch decodes the actual wire representation. Compare its full
        // bytes with both the producer and the accepted integrity descriptor.
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes).toEqual(new Uint8Array(2048).fill(pack.assets[0].payload.marker));
        responses.push(bytes);
      }
      return responses;
    } finally {
      await server.close();
    }
  };
  try {
    await mkdir(assets);
    for (const index of [0, 1]) await writeFile(join(assets, `${index}.pack.ts`), source(index));
    await open();
    expect(encoder.calls).toBe(1);
    expect(cook).toHaveBeenCalledTimes(2);
    await open();
    expect(encoder.calls).toBe(1);
    expect(cook).toHaveBeenCalledTimes(2);
    await writeFile(
      join(assets, '1.pack.ts'),
      change === 'bytes' ? source(1, 9) : source(1, 7, 'text/plain'),
    );
    const changed = await open();
    expect(encoder.calls).toBe(2);
    expect(cook).toHaveBeenCalledTimes(3);
    expect(changed[0]).toEqual(new Uint8Array(2048).fill(7));
    expect(changed[1]).toEqual(new Uint8Array(2048).fill(change === 'bytes' ? 9 : 7));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
