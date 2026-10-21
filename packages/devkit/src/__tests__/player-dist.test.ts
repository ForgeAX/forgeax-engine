import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { decompressZstd } from '@forgeax/engine-codec';
import { readAssetBundleTable } from '@forgeax/engine-pack/bundle';
import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type DistManifest, mediaType, verifyDist } from '../dist.js';
import { PLAYER_DELIVERY_FILE, preparePlayerDist } from '../player-dist.js';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function writeDist(base: string, files: ReadonlyMap<string, string | Uint8Array>) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-player-source-'));
  const artifacts: DistManifest['artifacts'][number][] = [];
  for (const [path, body] of files) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), body);
    const bytes = Buffer.from(body);
    artifacts.push({
      path,
      mediaType: mediaType(path),
      bytes: bytes.byteLength,
      sha256: sha(bytes),
    });
  }
  const manifest: DistManifest = {
    schemaVersion: '1.0.0',
    target: 'browser',
    project: { id: 'fixture', name: 'Fixture' },
    base,
    runtime: { packIndexUrl: 'pack-index.json', shaderManifestUrl: 'shaders/manifest.json' },
    artifacts,
  };
  await writeFile(resolve(root, 'forgeax-dist.json'), JSON.stringify(manifest));
  return { root, manifest };
}

async function fixture(base: string, table: boolean) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-player-source-'));
  const url = (path: string) => `${base}${path}`;
  const row = {
    guid: '01900000-0000-7000-8000-000000000001',
    kind: 'mesh',
    packageUrl: url('assets/main.pack.json'),
    cookReceiptUrl: url('assets/main.receipt.json'),
    projection: {
      lastKnownGood: {
        packageUrl: url('assets/main.pack.json'),
        receiptUrl: url('assets/prior.receipt.json'),
      },
    },
  };
  const catalog = table
    ? {
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: 'fixture',
        generation: 1,
        entries: {
          schemaVersion: 'pack-index-tables/1',
          entries: [row],
          publications: [],
          projections: [],
        },
      }
    : [row];
  const files = new Map<string, string | Uint8Array>([
    ['index.html', '<!doctype html><title>Player fixture</title>'],
    ['pack-index.json', JSON.stringify(catalog)],
    ['shaders/manifest.json', '{}'],
    ['assets/main.receipt.json', '{"status":"succeeded"}'],
    ['assets/prior.receipt.json', '{"status":"succeeded"}'],
    [
      'assets/main.pack.json',
      JSON.stringify({ assets: [{ payload: { receipt: { layoutIdentity: 'runtime-abi' } } }] }),
    ],
    ['assets/mesh.bin', new Uint8Array([1, 2, 3, 4])],
    ['assets/runtime-abi.receipt.json', '{"layoutIdentity":"runtime-abi"}'],
  ]);
  const artifacts: DistManifest['artifacts'][number][] = [];
  for (const [path, body] of files) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), body);
    const bytes = Buffer.from(body);
    artifacts.push({
      path,
      mediaType: mediaType(path),
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const manifest: DistManifest = {
    schemaVersion: '1.0.0',
    target: 'browser',
    project: { id: 'fixture', name: 'Fixture' },
    base,
    runtime: { packIndexUrl: 'pack-index.json', shaderManifestUrl: 'shaders/manifest.json' },
    artifacts,
  };
  await writeFile(resolve(root, 'forgeax-dist.json'), JSON.stringify(manifest));
  return { root, manifest };
}

describe('player distribution', () => {
  it.each([
    ['./', false],
    ['/games/fixture/', true],
  ] as const)('removes diagnostic receipt links and bodies for base %s', async (base, table) => {
    const source = await fixture(base, table);
    let playerRoot: string | undefined;
    try {
      expect((await verifyDist(source.root)).ok).toBe(true);
      const player = await preparePlayerDist(source.root, source.manifest);
      playerRoot = player.root;
      expect(await verifyDist(player.root)).toEqual({ ok: true, value: player.manifest });
      const catalog = await readFile(resolve(player.root, 'pack-index.json'), 'utf8');
      expect(catalog).not.toContain('cookReceiptUrl');
      expect(catalog).not.toContain('receiptUrl');
      expect(catalog).toContain('main.pack.json');
      for (const path of ['assets/main.receipt.json', 'assets/prior.receipt.json']) {
        expect(player.manifest.artifacts.some((artifact) => artifact.path === path)).toBe(false);
        await expect(access(resolve(player.root, path))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(resolve(source.root, path))).resolves.toBeUndefined();
      }
      for (const path of [
        'assets/mesh.bin',
        'assets/main.pack.json',
        'assets/runtime-abi.receipt.json',
      ]) {
        expect(await readFile(resolve(player.root, path))).toEqual(
          await readFile(resolve(source.root, path)),
        );
      }
      expect((await verifyDist(source.root)).ok).toBe(true);
      expect(await readFile(resolve(source.root, 'pack-index.json'), 'utf8')).toContain(
        'cookReceiptUrl',
      );
    } finally {
      await rm(source.root, { recursive: true, force: true });
      if (playerRoot !== undefined) await rm(playerRoot, { recursive: true, force: true });
    }
  });

  it('keeps catalog bytes and integrity unchanged when there are no diagnostic links', async () => {
    const source = await fixture('./', false);
    let playerRoot: string | undefined;
    try {
      const bytes = '[\n  {"guid":"fixture", "kind":"mesh"}\n]\n';
      await writeFile(resolve(source.root, 'pack-index.json'), bytes);
      const manifest: DistManifest = {
        ...source.manifest,
        artifacts: source.manifest.artifacts.map((artifact) =>
          artifact.path === 'pack-index.json'
            ? {
                ...artifact,
                bytes: Buffer.byteLength(bytes),
                sha256: createHash('sha256').update(bytes).digest('hex'),
              }
            : artifact,
        ),
      };
      const player = await preparePlayerDist(source.root, manifest);
      playerRoot = player.root;
      expect(player.manifest).toEqual(manifest);
      expect(await readFile(resolve(player.root, 'pack-index.json'), 'utf8')).toBe(bytes);
    } finally {
      await rm(source.root, { recursive: true, force: true });
      if (playerRoot !== undefined) await rm(playerRoot, { recursive: true, force: true });
    }
  });

  it('moves verified Pack artifacts into Asset Bundles and keeps streaming files', async () => {
    const body = (fill: number, length: number) => new Uint8Array(length).fill(fill);
    const bodies = {
      'assets/shared/a.bin': body(1, 4096),
      'assets/shared/b.bin': body(2, 64),
      'assets/shared/common.bin': body(3, 2048),
      'assets/shared/c.bin': body(4, 300),
      'assets/media/intro.jpg.bin': body(5, 32),
    };
    const descriptor = (path: string, delivery?: 'stream'): ArtifactDescriptor => {
      const bytes = bodies[`assets/${path}` as keyof typeof bodies];
      return {
        path,
        mediaType: 'application/octet-stream',
        contentEncoding: 'identity',
        byteLength: bytes.byteLength,
        integrity: { algorithm: 'sha256', digest: `sha256:${sha(bytes)}` },
        ...(delivery === undefined ? {} : { delivery }),
      };
    };
    const pack = (artifacts: Record<string, ArtifactDescriptor>) =>
      JSON.stringify({ schemaVersion: '2.0.0', assets: [{ guid: 'g', artifacts }] });
    const row = (name: string, sourcePath: string) => ({
      guid: `01900000-0000-7000-8000-00000000000${name.length}`,
      kind: 'mesh',
      packageUrl: `/assets/${name}.pack.json`,
      sourcePath,
    });
    const files = new Map<string, string | Uint8Array>([
      ['index.html', '<!doctype html>'],
      [
        'pack-index.json',
        JSON.stringify([
          row('map', 'assets/maps/dust2/map.pack.ts'),
          row('props', 'assets/maps/dust2/props.pack.ts'),
          row('ui', 'assets/ui.pack.json'),
        ]),
      ],
      ['shaders/manifest.json', '{}'],
      [PLAYER_DELIVERY_FILE, JSON.stringify({ bundles: { dust2: ['assets/maps/dust2/'] } })],
      [
        'assets/map.pack.json',
        pack({ a: descriptor('shared/a.bin'), s: descriptor('shared/common.bin') }),
      ],
      ['assets/props.pack.json', pack({ b: descriptor('shared/b.bin') })],
      [
        'assets/ui.pack.json',
        pack({
          c: descriptor('shared/c.bin'),
          s: descriptor('shared/common.bin'),
          intro: descriptor('media/intro.jpg.bin', 'stream'),
        }),
      ],
      ...Object.entries(bodies),
    ]);
    const source = await writeDist('/', files);
    let playerRoot: string | undefined;
    try {
      const player = await preparePlayerDist(source.root, source.manifest);
      playerRoot = player.root;
      expect(await verifyDist(player.root)).toEqual({ ok: true, value: player.manifest });
      const paths = player.manifest.artifacts.map((artifact) => artifact.path);
      expect(paths).not.toContain(PLAYER_DELIVERY_FILE);
      expect(paths.filter((path) => path.startsWith('assets/shared/'))).toEqual([]);
      expect(paths).toContain('assets/media/intro.jpg.bin');
      // dust2 (map + props), ui alone, and the bytes both Bundles use.
      expect(paths.filter((path) => path.startsWith('assets/bundles/'))).toHaveLength(3);
      expect(player.bundles).toMatchObject({ bundles: 3, entries: 4 });

      const windows = new Map<string, Set<string>>();
      for (const name of ['map', 'props', 'ui']) {
        const document = JSON.parse(
          await readFile(resolve(player.root, `assets/${name}.pack.json`), 'utf8'),
        );
        for (const [key, value] of Object.entries(document.assets[0].artifacts)) {
          const entry = value as ArtifactDescriptor;
          if (key === 'intro') {
            expect(entry).toEqual(descriptor('media/intro.jpg.bin', 'stream'));
            continue;
          }
          const range = entry.byteRange;
          if (range === undefined) throw new Error(`${name}.${key} was not bundled`);
          const file = new Uint8Array(await readFile(resolve(player.root, 'assets', entry.path)));
          expect(`sha256:${sha(file)}`).toBe(range.bundleDigest);
          expect(readAssetBundleTable(file).ok).toBe(true);
          const stored = file.slice(range.offset, range.offset + range.length);
          const decoded =
            entry.contentEncoding === 'zstd'
              ? await decompressZstd(stored)
              : { ok: true, value: stored };
          if (!decoded.ok) throw new Error('entry did not decode');
          expect(`sha256:${sha(decoded.value)}`).toBe(entry.integrity?.digest);
          windows.set(key, new Set([...(windows.get(key) ?? []), `${entry.path}@${range.offset}`]));
        }
      }
      // Shared bytes live in one window, used by both Packs.
      expect(windows.get('s')?.size).toBe(1);
      const bundleOf = (key: string) => [...(windows.get(key) ?? [])][0]?.split('@')[0];
      expect(bundleOf('a')).toBe(bundleOf('b'));
      expect(bundleOf('a')).not.toBe(bundleOf('c'));
      expect(bundleOf('s')).not.toBe(bundleOf('a'));
      // Compressible entries are stored with zstd; tiny ones stay identity.
      const map = JSON.parse(await readFile(resolve(player.root, 'assets/map.pack.json'), 'utf8'));
      expect(map.assets[0].artifacts.a.contentEncoding).toBe('zstd');
      const props = JSON.parse(
        await readFile(resolve(player.root, 'assets/props.pack.json'), 'utf8'),
      );
      expect(props.assets[0].artifacts.b.contentEncoding).toBe('identity');
      expect((await verifyDist(source.root)).ok).toBe(true);
    } finally {
      await rm(source.root, { recursive: true, force: true });
      if (playerRoot !== undefined) await rm(playerRoot, { recursive: true, force: true });
    }
  });

  it('rejects a Pack claimed by two named Bundles', async () => {
    const files = new Map<string, string | Uint8Array>([
      ['index.html', '<!doctype html>'],
      [
        'pack-index.json',
        JSON.stringify([
          {
            guid: 'g',
            kind: 'mesh',
            packageUrl: '/assets/map.pack.json',
            sourcePath: 'assets/maps/a.pack.ts',
          },
        ]),
      ],
      ['shaders/manifest.json', '{}'],
      [
        PLAYER_DELIVERY_FILE,
        JSON.stringify({ bundles: { one: ['assets/'], two: ['assets/maps/'] } }),
      ],
      ['assets/map.pack.json', JSON.stringify({ assets: [] })],
    ]);
    const source = await writeDist('/', files);
    try {
      await expect(preparePlayerDist(source.root, source.manifest)).rejects.toThrow(
        /matches Bundles one, two/,
      );
    } finally {
      await rm(source.root, { recursive: true, force: true });
    }
  });
});
