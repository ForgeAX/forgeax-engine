import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { decompressZstd } from '@forgeax/engine-codec';
import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { planAssetBundles } from '../delivery-bundles';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it.each([
  true,
  false,
])('preserves complete WGSL inventory with compression=%s', async (compressEntries) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-shader-groups-'));
  try {
    await mkdir(resolve(root, 'assets'));
    const bodies = Array.from({ length: 12 }, (_, index) =>
      Buffer.from(`// variant ${index}\n${'fn shared() { let value = 1.0; }\n'.repeat(400)}`),
    );
    const descriptors: Record<string, ArtifactDescriptor> = {};
    const artifacts = new Map();
    for (const [index, bytes] of bodies.entries()) {
      const path = `assets/program-${index}.wgsl`;
      await writeFile(resolve(root, path), bytes);
      artifacts.set(path, {
        path,
        bytes: bytes.length,
        sha256: hash(bytes),
        mediaType: 'text/wgsl',
      });
      descriptors[`program-${index}`] = {
        path: `program-${index}.wgsl`,
        mediaType: 'text/wgsl',
        contentEncoding: 'identity',
        byteLength: bytes.length,
        integrity: { algorithm: 'sha256', digest: `sha256:${hash(bytes)}` },
      };
    }
    const pack = 'assets/material.pack.json';
    const bytes = Buffer.from(JSON.stringify({ assets: [{ artifacts: descriptors }] }));
    await writeFile(resolve(root, pack), bytes);
    artifacts.set(pack, {
      path: pack,
      bytes: bytes.length,
      sha256: hash(bytes),
      mediaType: 'application/json',
    });
    const input = {
      sourceRoot: root,
      outputRoot: root,
      artifacts,
      catalog: [{ packageUrl: pack, sourcePath: 'assets/material.pack.ts' }],
      packIndexPath: 'pack-index.json',
      delivery: {},
      compressEntries,
      pathOf: (url: string, from: string) =>
        url.startsWith('assets/') ? url : resolve('/', from, '..', url).slice(1),
    };
    const result = await planAssetBundles(input);
    const rewritten = JSON.parse(await readFile(resolve(root, pack), 'utf8'));
    const rows = Object.values(rewritten.assets[0].artifacts) as ArtifactDescriptor[];
    expect(rows).toHaveLength(bodies.length);
    expect(rows.every((row) => row.decodedRange !== undefined)).toBe(compressEntries);
    expect(
      new Set(rows.map((row) => `${row.byteRange?.offset}:${row.byteRange?.length}`)).size,
    ).toBe(compressEntries ? 1 : bodies.length);
    for (const [index, row] of rows.entries()) {
      const range = row.byteRange;
      if (range === undefined) throw new Error('missing group transport window');
      const group = await readFile(resolve(root, 'assets', row.path));
      const stored = group.subarray(range.offset, range.offset + range.length);
      const result = compressEntries
        ? await decompressZstd(stored)
        : { ok: true as const, value: stored };
      if (!result.ok) throw new Error(result.error.code);
      const decoded = result.value;
      const window = row.decodedRange ?? { offset: 0, length: row.byteLength ?? 0 };
      const restored = decoded.subarray(window.offset, window.offset + window.length);
      expect(Buffer.from(restored)).toEqual(bodies[index]);
      expect(`sha256:${hash(restored)}`).toBe(row.integrity?.digest);
    }
    expect(result.report.entries).toBe(bodies.length);
    // Reusing a prepared delivery must preserve logical entry counts and group bytes.
    for (const artifact of result.written) artifacts.set(artifact.path, artifact);
    const repeated = await planAssetBundles(input);
    expect(repeated.report).toEqual(result.report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
