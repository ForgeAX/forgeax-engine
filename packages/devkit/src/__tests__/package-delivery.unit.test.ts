import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { decodeDocumentText } from '@forgeax/engine-codec';
import { expect, it, vi } from 'vitest';
import { packageCommand } from '../commands.js';
import { writeDistManifest } from '../dist.js';

vi.mock('../host.js', () => ({
  buildProject: async () => ({ ok: true, value: {} }),
  createEngineWorkspaceResolverForProject: async () => undefined,
}));
vi.mock('../engine-binding.js', () => ({
  engineStatusCommand: async () => ({
    ok: true,
    value: { mode: 'sdk', resolved: { version: '1.2.3' }, workspace: null },
  }),
}));

function unzip(bytes: Buffer) {
  const entries = new Map<string, Buffer>();
  for (let offset = 0; bytes.readUInt32LE(offset) === 0x0403_4b50; ) {
    const method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extra;
    const body = bytes.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(body) : body);
    offset = start + size;
  }
  return entries;
}

it('preserves the exact player directory named by its receipt and preview command', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'package-delivery-')));
  try {
    await mkdir(join(root, 'dist/shaders'), { recursive: true });
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'package.json'), '{"name":"delivery-fixture"}');
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'delivery-fixture',
        name: 'Delivery Fixture',
        roots: {},
      }),
    );
    await writeFile(join(root, 'README.md'), '# Fixture\n');
    await writeFile(join(root, 'docs/feedback.md'), '# Feedback\n');
    await writeFile(join(root, 'dist/index.html'), '<title>player</title>');
    await writeFile(join(root, 'dist/pack-index.json'), '[]');
    await writeFile(join(root, 'dist/shaders/manifest.json'), '{}');
    await writeDistManifest(
      {
        root,
        id: 'delivery-fixture',
        name: 'Delivery Fixture',
        roots: {},
        assetRoots: [],
        assetLibraries: [],
        packageJson: {},
      },
      './',
    );
    const result = await packageCommand({ root, compress: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const receipt = result.value as {
      archive: { path: string };
      distManifestSha256: string;
      delivery: { type: string; servedDirectory: string };
      source: { kind: string };
      engine: { version: string };
      run: { local: string; localArgv: string[] };
    };
    expect(receipt.delivery.type).toBe('player');
    expect(receipt.source.kind).toBe('unversioned');
    expect(receipt.engine.version).toBe('1.2.3');
    expect(receipt.run.localArgv).toEqual([
      'forgeax',
      'project',
      'preview',
      '--root',
      root,
      '--dist',
      receipt.delivery.servedDirectory,
    ]);
    expect(receipt.run.local).toContain('--dist');
    const archive = unzip(await readFile(receipt.archive.path));
    const manifestBytes = await readFile(
      join(receipt.delivery.servedDirectory, 'forgeax-dist.json'),
    );
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(
      receipt.distManifestSha256,
    );
    expect(manifestBytes).toEqual(archive.get('forgeax-dist.json'));
    for (const entry of JSON.parse(manifestBytes.toString()).artifacts) {
      expect(await readFile(join(receipt.delivery.servedDirectory, entry.path))).toEqual(
        archive.get(entry.path),
      );
    }
    // Repeating a deterministic package verifies and reuses the same immutable directory.
    expect((await packageCommand({ root, compress: false })).ok).toBe(true);
    await writeFile(join(receipt.delivery.servedDirectory, 'index.html'), 'tampered');
    expect((await packageCommand({ root, compress: false })).ok).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps native compressed shader documents in ordinary single HTML delivery', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'single-html-native-documents-')));
  const shader = JSON.stringify({
    entries: [],
    materialShaders: [],
    diagnostic: 'shared shader facts '.repeat(8192),
  });
  try {
    await mkdir(join(root, 'dist/shaders'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"native-documents-fixture"}');
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'native-documents',
        name: 'Native documents',
        roots: {},
      }),
    );
    await writeFile(
      join(root, 'dist/index.html'),
      '<script type="module" src="./main.js"></script>',
    );
    await writeFile(join(root, 'dist/main.js'), 'globalThis.nativeDocumentFixture = true;');
    await writeFile(join(root, 'dist/pack-index.json'), '[]');
    await writeFile(join(root, 'dist/shaders/manifest.json'), shader);
    await writeDistManifest(
      {
        root,
        id: 'native-documents',
        name: 'Native documents',
        roots: {},
        assetRoots: [],
        assetLibraries: [],
        packageJson: {},
      },
      './',
    );
    const result = await packageCommand({ root, format: 'single-html' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw result.error;
    const html = await readFile((result.value as { html: { path: string } }).html.path, 'utf8');
    const manifest = JSON.parse(
      html.match(/id="forgeax-asset-payload"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '[]',
    );
    const row = manifest.find((item: { path: string }) => item.path === 'shaders/manifest.json');
    expect(row).toBeDefined();
    const source = html.match(
      new RegExp(`data-forgeax-asset-index="${row.index}">([A-Za-z0-9+/=]+)</script>`),
    )?.[1];
    expect(source).toBeDefined();
    if (source === undefined) throw new Error('Missing embedded shader document');
    const stored = Buffer.from(source, 'base64');
    const wire = row.encoding === 'gzip' ? gunzipSync(stored) : stored;
    expect(wire.subarray(0, 4).toString('hex')).toBe('28b52ffd');
    const decoded = await decodeDocumentText(wire);
    if (!decoded.ok) throw decoded.error;
    expect(decoded.value).toBe(shader);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
