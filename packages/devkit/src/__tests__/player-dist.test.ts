import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { decodeDocumentText, decompressZstd } from '@forgeax/engine-codec';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { readAssetBundleTable } from '@forgeax/engine-pack/bundle';
import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { PLAYER_DELIVERY_FILE, prepareDist } from '../delivery-dist.js';
import { type DistManifest, mediaType, verifyDist } from '../dist.js';

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
    sourcePath: 'assets/main.pack.ts',
    revision: { rootId: 'assets', digest: 'sha256:revision', observedAt: 1 },
    relations: [{ kind: 'depends-on', guid: '01900000-0000-7000-8000-000000000002' }],
    provenance: { provider: 'pack-ts', version: '1.0.0' },
    sourceIndex: 0,
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
  it('shares encoded build artifacts with Player packaging while retaining build diagnostics', async () => {
    const body = new Uint8Array(8192).fill(42);
    const encoded = await compressZstd(body);
    if (!encoded.ok) throw encoded.error;
    const catalog = [
      {
        guid: '01900000-0000-7000-8000-000000000001',
        kind: 'mesh',
        packageUrl: './assets/main.pack.json',
        sourcePath: 'assets/main.pack.ts',
        cookReceiptUrl: './assets/main.receipt.json',
        provenance: { provider: 'pack-ts' },
      },
    ];
    const source = await writeDist(
      './',
      new Map<string, string | Uint8Array>([
        ['index.html', '<!doctype html>'],
        ['pack-index.json', JSON.stringify(catalog)],
        ['shaders/manifest.json', '{}'],
        ['assets/main.receipt.json', '{"status":"succeeded"}'],
        ['assets/body.bin', body],
        ['assets/encoded.bin', encoded.value],
        [
          'assets/main.pack.json',
          JSON.stringify({
            assets: [
              {
                artifacts: {
                  body: {
                    path: 'body.bin',
                    mediaType: 'application/octet-stream',
                    contentEncoding: 'identity',
                    byteLength: body.length,
                    integrity: { algorithm: 'sha256', digest: `sha256:${sha(body)}` },
                  },
                  encoded: {
                    path: 'encoded.bin',
                    mediaType: 'application/octet-stream',
                    contentEncoding: 'zstd',
                    byteLength: body.length,
                    integrity: { algorithm: 'sha256', digest: `sha256:${sha(body)}` },
                  },
                },
              },
            ],
          }),
        ],
      ]),
    );
    const roots: string[] = [];
    try {
      const build = await prepareDist(source.root, source.manifest, { distribution: 'build' });
      expect(build.root).toBe(source.root);
      expect(await verifyDist(build.root)).toEqual({ ok: true, value: build.manifest });
      const read = async (root: string, path: string) => {
        const text = await decodeDocumentText(await readFile(resolve(root, path)));
        if (!text.ok) throw new Error(text.error.code);
        return JSON.parse(text.value);
      };
      expect(await read(build.root, 'pack-index.json')).toEqual(catalog);
      await expect(
        access(resolve(build.root, 'assets/main.receipt.json')),
      ).resolves.toBeUndefined();
      await expect(access(resolve(build.root, 'assets/body.bin'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const descriptor = (await read(build.root, 'assets/main.pack.json')).assets[0].artifacts.body;
      expect(descriptor).toMatchObject({
        contentEncoding: 'zstd',
        byteLength: body.length,
        integrity: { algorithm: 'sha256', digest: `sha256:${sha(body)}` },
      });
      const bundled = build.manifest.artifacts.filter((artifact) =>
        artifact.path.startsWith('assets/bundles/'),
      );
      expect(bundled).toHaveLength(1);
      const bundle = bundled[0];
      if (bundle === undefined) throw new Error('missing Bundle');
      const bytes = await readFile(resolve(build.root, bundle.path));
      const decoded = await decompressZstd(
        bytes.subarray(
          descriptor.byteRange.offset,
          descriptor.byteRange.offset + descriptor.byteRange.length,
        ),
      );
      expect(decoded).toEqual({ ok: true, value: body });
      for (const compressDocuments of [true, false]) {
        const player = await prepareDist(build.root, build.manifest, { compressDocuments });
        roots.push(player.root);
        expect(await verifyDist(player.root)).toEqual({ ok: true, value: player.manifest });
        expect(player.bundles).toEqual(build.bundles);
        expect(
          player.manifest.artifacts.filter((artifact) =>
            artifact.path.startsWith('assets/bundles/'),
          ),
        ).toEqual(bundled);
        expect(await readFile(resolve(player.root, bundle.path))).toEqual(bytes);
        expect(await read(player.root, 'pack-index.json')).toEqual(
          catalog.map(({ cookReceiptUrl, provenance, ...row }) => row),
        );
        expect((await read(player.root, 'assets/main.pack.json')).assets[0].artifacts.body).toEqual(
          descriptor,
        );
        if (!compressDocuments)
          expect(
            JSON.parse(await readFile(resolve(player.root, 'assets/main.pack.json'), 'utf8')),
          ).toBeDefined();
        await expect(
          access(resolve(player.root, 'assets/main.receipt.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const again = await prepareDist(build.root, build.manifest, { distribution: 'build' });
      expect(again.manifest).toEqual(build.manifest);
      expect(again.bundles).toEqual(build.bundles);
    } finally {
      await rm(source.root, { recursive: true, force: true });
      for (const root of roots) await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['./', false],
    ['/games/fixture/', true],
  ] as const)('removes diagnostic receipt links and bodies for base %s', async (base, table) => {
    const source = await fixture(base, table);
    let playerRoot: string | undefined;
    try {
      expect((await verifyDist(source.root)).ok).toBe(true);
      const player = await prepareDist(source.root, source.manifest, {
        compressDocuments: false,
      });
      playerRoot = player.root;
      expect(await verifyDist(player.root)).toEqual({ ok: true, value: player.manifest });
      const catalog = await readFile(resolve(player.root, 'pack-index.json'), 'utf8');
      expect(catalog).not.toContain('cookReceiptUrl');
      expect(catalog).not.toContain('receiptUrl');
      expect(catalog).toContain('main.pack.json');
      // Authoring-only row facts stay in the build catalog for `forgeax asset` queries.
      const row = JSON.parse(catalog).entries?.entries?.[0] ?? JSON.parse(catalog)[0];
      expect(row).toMatchObject({
        guid: '01900000-0000-7000-8000-000000000001',
        sourcePath: 'assets/main.pack.ts',
      });
      for (const field of ['revision', 'relations', 'provenance', 'sourceIndex'])
        expect(row).not.toHaveProperty(field);
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
      const sourceCatalog = await readFile(resolve(source.root, 'pack-index.json'), 'utf8');
      expect(sourceCatalog).toContain('cookReceiptUrl');
      expect(sourceCatalog).toContain('provenance');
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
      const player = await prepareDist(source.root, manifest, { compressDocuments: false });
      playerRoot = player.root;
      expect(player.manifest).toEqual(manifest);
      expect(await readFile(resolve(player.root, 'pack-index.json'), 'utf8')).toBe(bytes);
    } finally {
      await rm(source.root, { recursive: true, force: true });
      if (playerRoot !== undefined) await rm(playerRoot, { recursive: true, force: true });
    }
  });

  it('stores player JSON documents as zstd frames by default', async () => {
    const source = await fixture('./', false);
    const library = 'assets/pipeline-library-a1b2.json';
    await writeFile(resolve(source.root, library), '{"recipes":[]}');
    const manifest: DistManifest = {
      ...source.manifest,
      artifacts: [
        ...source.manifest.artifacts,
        { path: library, mediaType: 'application/json', bytes: 14, sha256: sha('{"recipes":[]}') },
      ],
    };
    const roots: string[] = [];
    try {
      const plain = await prepareDist(source.root, manifest, { compressDocuments: false });
      roots.push(plain.root);
      const player = await prepareDist(source.root, manifest);
      roots.push(player.root);
      expect(await verifyDist(player.root)).toEqual({ ok: true, value: player.manifest });
      for (const path of [
        'pack-index.json',
        'shaders/manifest.json',
        'assets/main.pack.json',
        library,
      ]) {
        const stored = new Uint8Array(await readFile(resolve(player.root, path)));
        expect([...stored.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
        const text = await decodeDocumentText(stored);
        expect(text).toEqual({
          ok: true,
          value: await readFile(resolve(plain.root, path), 'utf8'),
        });
      }
      for (const path of ['index.html', 'assets/mesh.bin', 'assets/runtime-abi.receipt.json'])
        expect(await readFile(resolve(player.root, path))).toEqual(
          await readFile(resolve(plain.root, path)),
        );
    } finally {
      await rm(source.root, { recursive: true, force: true });
      for (const root of roots) await rm(root, { recursive: true, force: true });
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
      const player = await prepareDist(source.root, source.manifest, {
        compressDocuments: false,
      });
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
      await expect(prepareDist(source.root, source.manifest)).rejects.toThrow(
        /matches Bundles one, two/,
      );
    } finally {
      await rm(source.root, { recursive: true, force: true });
    }
  });
});
