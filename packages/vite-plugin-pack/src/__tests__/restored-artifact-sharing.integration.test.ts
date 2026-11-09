import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, type ZlibOptions } from 'node:zlib';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it, vi } from 'vitest';
import { pluginPack } from '../plugin-pack.js';

const encoder = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:zlib', async () => {
  const native = await vi.importActual<typeof import('node:zlib')>('node:zlib');
  return {
    ...native,
    gzip(
      bytes: Uint8Array,
      options: ZlibOptions,
      callback: (error: Error | null, body: Buffer) => void,
    ) {
      encoder.calls++;
      native.gzip(bytes, options, callback);
    },
  };
});

// Keep the real HDR decoder and publication closure; generic binary MIME makes
// this small fixture eligible for the unchanged HTTP compression policy.
const importer: Importer = {
  ...imageImporter,
  async import(context) {
    const result = await imageImporter.import(context);
    if (!result.ok) return result;
    return {
      ...result,
      value: {
        ...result.value,
        assets: result.value.assets.map((asset) => ({
          ...asset,
          artifacts: Object.fromEntries(
            Object.entries(asset.artifacts ?? {}).map(([name, artifact]) => [
              name,
              { ...artifact, mediaType: 'application/octet-stream' },
            ]),
          ),
        })),
      },
    };
  },
};
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw Error('Missing fixture value');
  return value;
}

const GUIDS = ['019e4a26-3c29-7420-af5d-20f2724a16b0', '019e4a26-3c29-7420-af5d-20f2724a16b1'];
function hdr(seed: number): Uint8Array {
  const header = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 64 +X 8\n');
  const body = new Uint8Array(64 * 12);
  for (let row = 0; row < 64; row++) {
    const offset = row * 12;
    body.set([2, 2, 0, 8], offset);
    for (let channel = 0; channel < 4; channel++)
      body.set([136, (seed + channel * 17 + row * 3) & 255], offset + 4 + channel * 2);
  }
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  return bytes;
}
function request(url: URL, encoding: string) {
  return new Promise<{ status: number | undefined; encoding: string | undefined; bytes: Buffer }>(
    (resolve, reject) => {
      const req = get(url, { headers: { 'accept-encoding': encoding } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            encoding: response.headers['content-encoding'],
            bytes: Buffer.concat(chunks),
          }),
        );
      });
      req.on('error', reject);
    },
  );
}

it('shares validated restored bytes across Meta routes without retaining stale content after an edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-restored-artifact-sharing-'));
  const assets = join(root, 'assets'),
    ddc = join(root, '.forgeax', 'ddc');
  const binding = createStandaloneRuntimeAssetBinding(
    'restored-artifact-sharing',
    'restored-artifact-sharing',
  );
  const runtime = join(ddc, 'runtime', `${binding.scopeId}-${binding.generation}`);
  const heads = GUIDS.map((guid) => join(runtime, 'heads', `${guid}.json`));
  let server: ViteDevServer | undefined;
  const cwd = process.cwd();
  try {
    await mkdir(assets, { recursive: true });
    for (const [index, guid] of GUIDS.entries()) {
      const source = `environment-${index}.hdr`;
      await writeFile(join(assets, source), hdr(11));
      await writeFile(
        join(assets, `${source}.meta.json`),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source,
          importSettings: { colorSpace: 'linear', mipmap: 'none' },
          subAssets: [{ guid, sourceIndex: 0, kind: 'equirect' }],
        }),
      );
    }
    process.chdir(root);
    const open = async () => {
      const plugin = pluginPack({
        roots: [assets],
        importers: [importer],
        producerReadiness: 'before-consume',
        runtimeBinding: binding,
        ddc: { projectDdcRoot: ddc },
      });
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin],
        server: { host: '127.0.0.1', port: 0 },
      });
      await server.listen();
      const base = server.resolvedUrls?.local?.[0];
      if (!base) throw Error('Missing real Vite URL');
      for (let attempt = 0; attempt < 240; attempt++) {
        const response = await request(new URL(binding.catalogUrl, base), 'identity');
        if (response.status === 200) {
          const snapshot = JSON.parse(response.bytes.toString('utf8'));
          const catalog = decodeCatalogWire(snapshot.entries ?? snapshot).unwrap();
          if (GUIDS.every((guid) => catalog.some((row) => row.guid.toLowerCase() === guid))) {
            return Promise.all(
              GUIDS.map(async (guid) => {
                const row = catalog.find((row) => row.guid.toLowerCase() === guid);
                if (!row?.packageUrl) throw Error('Missing imported Pack URL');
                const packUrl = new URL(row.packageUrl, base);
                const pack = JSON.parse(
                  (await request(packUrl, 'identity')).bytes.toString('utf8'),
                ) as { assets: { guid: string; artifacts: Record<string, { path: string }> }[] };
                const descriptor = Object.values(
                  pack.assets.find((asset) => asset.guid === guid)?.artifacts ?? {},
                )[0];
                if (!descriptor) throw Error('Missing imported artifact');
                return new URL(descriptor.path, packUrl);
              }),
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw Error('Real Vite publication did not become ready');
    };
    const close = async () => {
      await server?.close();
      server = undefined;
    };
    const cold = await open();
    const expected = (await request(at(cold, 0), 'identity')).bytes;
    expect(expected.length).toBeGreaterThanOrEqual(1024);
    expect((await request(at(cold, 1), 'identity')).bytes).toEqual(expected);
    await close();
    const before = await Promise.all(
      heads.map(async (path) => ({
        bytes: await readFile(path),
        mtime: (await stat(path)).mtimeMs,
      })),
    );
    encoder.calls = 0;
    const warm = await open();
    expect(encoder.calls).toBe(1);
    for (const url of warm) {
      const response = await request(url, 'gzip');
      expect(response.status).toBe(200);
      expect(response.encoding).toBe('gzip');
      expect(gunzipSync(response.bytes)).toEqual(expected);
    }
    expect(encoder.calls).toBe(1);
    await close();
    for (const [index, path] of heads.entries()) {
      expect(await readFile(path)).toEqual(at(before, index).bytes);
      expect((await stat(path)).mtimeMs).toBe(at(before, index).mtime);
    }
    await writeFile(join(assets, 'environment-1.hdr'), hdr(97));
    encoder.calls = 0;
    const changed = await open();
    expect(encoder.calls).toBe(2);
    const first = await request(at(changed, 0), 'gzip'),
      second = await request(at(changed, 1), 'gzip');
    expect(gunzipSync(first.bytes)).toEqual(expected);
    expect(gunzipSync(second.bytes)).not.toEqual(expected);
    expect(await readFile(at(heads, 0))).toEqual(at(before, 0).bytes);
    expect(await readFile(at(heads, 1))).not.toEqual(at(before, 1).bytes);
  } finally {
    await server?.close();
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
