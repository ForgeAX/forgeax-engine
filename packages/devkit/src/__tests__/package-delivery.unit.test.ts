import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { packageCommand } from '../commands.js';
import { writeDistManifest } from '../dist.js';

vi.mock('../host.js', () => ({ buildProject: async () => ({ ok: true, value: {} }) }));
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
  const root = await mkdtemp(join(tmpdir(), 'package-delivery-'));
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
