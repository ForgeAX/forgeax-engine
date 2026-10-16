import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCatalogWire } from '../../packages/pack/dist/index.mjs';
import { createRuntimePackPublication } from '../../packages/pack/dist/runtime.mjs';
import { saveAuthoredPackage } from '../dev-verify/roi-18-19-skeletal-motion/provenance.mjs';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-skeletal-provenance-'));
  temporaryRoots.push(root);
  const dist = join(root, 'dist');
  const output = join(root, 'evidence');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await mkdir(output);
  const sourcePath = 'assets/skeletal-motion.pack.ts';
  const packageUrl = '/assets/skeletal-motion.pack.json';
  const { pack, publication } = createRuntimePackPublication({
    pack: {
      assets: [
        { guid: 'motion', kind: 'plugin', payload: { marker: 'ordinary-motion' }, refs: [] },
        { guid: 'scene', kind: 'scene', payload: { marker: 'ordinary-skin' }, refs: [] },
      ],
    },
    scopeId: 'skeletal-provenance-regression',
    sourcePath,
    sourceRevision: 'frozen-source',
    packageUrl,
  });
  const bytes = Buffer.from(JSON.stringify(pack));
  await writeFile(join(dist, packageUrl), bytes);
  const rows = publication.outputs.map((asset) => ({
    guid: asset.guid,
    kind: asset.kind,
    sourcePath,
    packageUrl,
    publication,
  }));
  return { dist, output, publication, bytes, wire: encodeCatalogWire(rows) };
}

describe('skeletal native evidence uses the ordinary Catalog wire consumer', () => {
  it('restores the shared publication and preserves exact producer bytes', async () => {
    const value = await fixture();
    expect(Array.isArray(value.wire)).toBe(false);
    await writeFile(join(value.dist, 'pack-index.json'), JSON.stringify(value.wire));

    const receipt = await saveAuthoredPackage(value.output, value.dist);

    expect(receipt.publication).toEqual(value.publication);
    expect(receipt.sha256).toBe(createHash('sha256').update(value.bytes).digest('hex'));
    expect(await readFile(join(value.output, 'authored-package.json'))).toEqual(value.bytes);
  });

  it('rejects a broken publication index through the canonical closed error', async () => {
    const value = await fixture();
    const wire = JSON.parse(JSON.stringify(value.wire));
    wire.entries[0].publicationIndex = 999;
    await writeFile(join(value.dist, 'pack-index.json'), JSON.stringify(wire));

    await expect(saveAuthoredPackage(value.output, value.dist)).rejects.toMatchObject({
      code: 'asset-parse-failed',
    });
    await expect(readFile(join(value.output, 'authored-package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
