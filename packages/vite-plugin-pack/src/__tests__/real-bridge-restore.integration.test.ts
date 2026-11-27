import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcEntryStore, DdcLifecycle } from '@forgeax/engine-ddc';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { type CatalogEntry, createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import type { ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../plugin-pack.js';
import { createPackTestServer } from './vite-fixtures.js';

const GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const SCOPE_ID = 'real-bridge-restore';
const GAME_ID = 'real-bridge-restore';
const SOURCE_NAME = 'environment.hdr';
const META_NAME = `${SOURCE_NAME}.meta.json`;

interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bytes: Uint8Array;
  readonly text: string;
}

interface PackArtifactDescriptor {
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

interface PackBody {
  readonly assets: readonly {
    readonly guid: string;
    readonly artifacts?: Readonly<Record<string, PackArtifactDescriptor>>;
  }[];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tinyHdr(seed: number, height: number): Uint8Array {
  const header = new TextEncoder().encode(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X 8\n`,
  );
  const scanline = new Uint8Array([2, 2, 0, 8]);
  const body = new Uint8Array(height * (scanline.length + 8));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (scanline.length + 8);
    body.set(scanline, offset);
    for (let channel = 0; channel < 4; channel += 1) {
      body.set([136, (seed + channel * 17 + row * 3) & 0xff], offset + 4 + channel * 2);
    }
  }
  const result = new Uint8Array(header.length + body.length);
  result.set(header);
  result.set(body, header.length);
  return result;
}

function sourceMeta(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: SOURCE_NAME,
    importSettings: { colorSpace: 'linear', mipmap: 'none' },
    subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'equirect' }],
  };
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<HttpResult> {
  const response = await fetch(new URL(path, baseUrl), init);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    bytes,
    text: new TextDecoder().decode(bytes),
  };
}

async function waitForCatalog(baseUrl: string, catalogUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const response = await request(baseUrl, catalogUrl);
    if (response.status === 200) {
      try {
        const catalog = decodeCatalogWire(JSON.parse(response.text)).unwrap();
        if (catalog.some((entry) => entry.guid?.toLowerCase() === GUID)) return;
      } catch {
        // The plugin exposes the Catalog only after the startup publication fence.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('real plugin Catalog did not become ready');
}

async function closure(
  baseUrl: string,
  catalogUrl: string,
): Promise<{
  readonly row: CatalogEntry;
  readonly pack: PackBody;
  readonly artifact: HttpResult;
}> {
  const catalogResponse = await request(baseUrl, catalogUrl);
  expect(catalogResponse.status).toBe(200);
  // Failure recovery deliberately reads accepted rows from a degraded scope.
  const catalog = decodeCatalogWire(JSON.parse(catalogResponse.text).entries).unwrap();
  const row = catalog.find((entry) => entry.guid?.toString().toLowerCase() === GUID);
  if (row === undefined || typeof row.packageUrl !== 'string') {
    throw new Error('real plugin Catalog omitted the imported GUID');
  }
  const packageResponse = await request(baseUrl, row.packageUrl);
  expect(packageResponse.status).toBe(200);
  const pack = JSON.parse(packageResponse.text) as PackBody;
  const asset = pack.assets.find((candidate) => candidate.guid.toLowerCase() === GUID);
  const descriptor = Object.values(asset?.artifacts ?? {})[0];
  if (descriptor === undefined) throw new Error('imported Pack omitted its artifact descriptor');
  const artifactPath = new URL(descriptor.path, new URL(row.packageUrl, baseUrl)).pathname;
  const artifact = await request(baseUrl, artifactPath);
  return { row, pack, artifact };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function waitForFailedPublication(
  lifecycle: DdcLifecycle,
  headPath: string,
  acceptedKey: string,
  state: 'failed' | 'stale',
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const raw = await readJson(headPath).catch(() => undefined);
    const desiredKey = typeof raw?.desiredKey === 'string' ? raw.desiredKey : '';
    if (raw !== undefined && raw.active === undefined && desiredKey !== '') {
      const candidate = await lifecycle.inspect(GUID, desiredKey);
      // A committed B head can briefly look stable before the failed
      // transport restores A. Wait for that terminal restore itself.
      if (
        candidate.desiredKey !== acceptedKey &&
        candidate.state === state &&
        candidate.currentKey === acceptedKey
      ) {
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('live B transport failure did not settle');
}

describe('real Vite/pluginPack import restore bridge', () => {
  let root: string | undefined;
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it.each([
    'DDC staging',
    'route commit',
  ] as const)('serves the accepted HDR closure through a failed %s and retries on the same plugin', async (phase) => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-real-bridge-restore-'));
    const projectRoot = join(root, 'project');
    const assetsRoot = join(projectRoot, 'assets');
    const ddcProjectRoot = join(projectRoot, '.forgeax', 'ddc');
    const ddcRoot = join(ddcProjectRoot, 'runtime', `${SCOPE_ID}-1`);
    const sourcePath = join(assetsRoot, SOURCE_NAME);
    const metaPath = join(assetsRoot, META_NAME);
    const failStaging = phase === 'DDC staging';
    const binding = createStandaloneRuntimeAssetBinding(GAME_ID, SCOPE_ID);
    const bindingsDirectory = join(projectRoot, '.forgeax', 'generated');
    const blockedPath = failStaging ? join(ddcRoot, 'staging') : bindingsDirectory;
    const headPath = join(ddcRoot, 'heads', `${encodeURIComponent(GUID)}.json`);
    const sourceA = tinyHdr(11, 1);
    const sourceB = tinyHdr(97, 2);
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(sourcePath, sourceA);
    await writeFile(metaPath, `${JSON.stringify(sourceMeta(), null, 2)}\n`);

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const plugin = pluginPack({
        roots: [assetsRoot],
        importers: [imageImporter],
        producerReadiness: 'before-consume',
        runtimeBinding: binding,
        ddc: { projectDdcRoot: ddcProjectRoot },
      });
      server = await createPackTestServer(projectRoot, plugin);
      await server.listen();
      const baseUrl = server.resolvedUrls?.local?.[0];
      if (baseUrl === undefined) throw new Error('Vite did not expose a loopback URL');
      await waitForCatalog(baseUrl, binding.catalogUrl);

      const accepted = await closure(baseUrl, binding.catalogUrl);
      expect(accepted.artifact.status).toBe(200);
      const acceptedRaw = await readJson(headPath);
      const acceptedDesiredKey = acceptedRaw.desiredKey;
      if (typeof acceptedDesiredKey !== 'string') {
        throw new Error('healthy control did not publish a DDC head');
      }
      const lifecycle = new DdcLifecycle(ddcRoot);
      const store = new DdcEntryStore(ddcRoot);
      const acceptedHead = await lifecycle.inspect(GUID, acceptedDesiredKey);
      const acceptedKey = acceptedHead.currentKey;
      if (acceptedKey === undefined) throw new Error('healthy control did not commit a DDC key');
      const acceptedBytes = accepted.artifact.bytes;
      const descriptor = accepted.pack.assets[0]?.artifacts?.body;
      if (descriptor === undefined) throw new Error('expected HDR body');
      expect(descriptor).toMatchObject({
        path: `${GUID}/body.bin`,
        mediaType: 'application/x-forgeax-rgba16f',
        byteLength: 64,
      });
      expect(await store.read(acceptedKey)).toMatchObject({
        artifacts: { [descriptor.path]: { bytes: acceptedBytes, mediaType: descriptor.mediaType } },
        payload: { assets: accepted.pack.assets },
      });

      await rm(blockedPath, { recursive: true });
      await writeFile(blockedPath, `block ${phase}`);
      await writeFile(sourcePath, sourceB);

      const failedHead = await waitForFailedPublication(
        lifecycle,
        headPath,
        acceptedKey,
        failStaging ? 'failed' : 'stale',
      );

      const candidateKey = failedHead.desiredKey;
      if (candidateKey === undefined)
        throw new Error('failed publication lacked a candidate identity');
      expect(failedHead.currentKey).toBe(acceptedKey);
      expect(failedHead.revision).toBeGreaterThan(acceptedHead.revision ?? 0);
      expect(failedHead.generation).toBe(2);
      if (!failStaging) expect(failedHead.revision).toBe(3);
      expect([...(await store.listKeys())].sort()).toEqual(
        (failStaging ? [acceptedKey] : [acceptedKey, candidateKey]).sort(),
      );
      const failed = await closure(baseUrl, binding.catalogUrl);
      expect(failed.row.revision).toMatchObject({ digest: acceptedKey });
      expect(failed.pack).toEqual(accepted.pack);
      expect(failed.artifact.status).toBe(200);
      expect(sha256(failed.artifact.bytes)).toBe(sha256(acceptedBytes));
      expect((await stat(blockedPath)).isFile()).toBe(true);
      expect((await store.read(acceptedKey))?.artifacts[descriptor.path]?.bytes).toEqual(
        acceptedBytes,
      );

      await rm(blockedPath);
      if (failStaging) await mkdir(blockedPath);
      const retry = await request(baseUrl, `${binding.importUrlBase}/${GUID}`, {
        method: 'POST',
        headers: { 'x-forgeax-import-mode': 'rebuild' },
      });
      expect(retry.status).toBe(200);
      const retried = await closure(baseUrl, binding.catalogUrl);
      expect(retried.artifact.status).toBe(200);
      expect(retried.artifact.bytes.byteLength).toBeGreaterThan(acceptedBytes.byteLength);
      expect(sha256(retried.artifact.bytes)).not.toBe(sha256(acceptedBytes));
      const retryHead = await lifecycle.inspect(GUID, candidateKey);
      expect(retryHead.state).toBe('current');
      expect(retryHead.currentKey).toBe(candidateKey);
      expect(retryHead.generation).toBe(3);
      expect(retryHead.revision).toBeGreaterThan(failedHead.revision ?? 0);
      expect((await store.read(candidateKey))?.artifacts[descriptor.path]?.bytes).toEqual(
        retried.artifact.bytes,
      );
    } finally {
      process.chdir(originalCwd);
    }
  }, 90_000);
});
