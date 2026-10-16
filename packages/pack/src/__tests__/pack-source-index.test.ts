import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { listPackSources } from '../pack-source-index.js';

it('indexes zero-output and bad Pack siblings without executing scriptable sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-source-index-'));
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(
      join(root, 'assets', 'empty.pack.json'),
      JSON.stringify({ schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] }),
    );
    await writeFile(join(root, 'assets', 'bad.pack.json'), '{ bad json');
    await writeFile(join(root, 'assets', 'script.pack.ts'), 'throw new Error("must not execute");');
    await writeFile(
      join(root, 'assets', 'instance.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000809',
        parent: '01900000-0000-7000-8000-000000000808',
        values: {},
      }),
    );
    const rows = (await listPackSources(root)).sources;
    expect(rows.map((row) => row.sourcePath)).toEqual([
      'assets/bad.pack.json',
      'assets/empty.pack.json',
      'assets/instance.pack.json',
      'assets/script.pack.ts',
    ]);
    expect(rows[0]?.diagnostic).toBeDefined();
    expect(rows[1]?.outputs).toEqual([]);
    expect(rows[1]?.diagnostic).toBeUndefined();
    expect(rows[2]?.diagnostic).toBeUndefined();
    expect(rows[2]?.packageId).toBe('01900000-0000-7000-8000-000000000809');
    expect(rows[3]?.diagnostic?.code).toBe('pack-source-unmaterialized');
    expect(rows.every((row) => row.revision?.startsWith('sha256:'))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds the source page and never follows a linked Pack source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-source-index-bound-'));
  try {
    const source = JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [],
    });
    for (const name of ['a', 'b', 'c']) await writeFile(join(root, `${name}.pack.json`), source);
    await symlink(join(root, 'a.pack.json'), join(root, 'linked.pack.json'));
    const page = await listPackSources(root, 2);
    expect(page.sources.map((row) => row.sourcePath)).toEqual(['a.pack.json', 'b.pack.json']);
    expect(page.hasMore).toBe(true);
    expect((await listPackSources(root)).sources.map((row) => row.sourcePath)).toEqual([
      'a.pack.json',
      'b.pack.json',
      'c.pack.json',
    ]);
    await expect(listPackSources(root, 201)).rejects.toThrow(RangeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('limits discovery to configured directories before applying the source-page bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-source-directories-'));
  try {
    for (const directory of ['content/art', 'shared', 'src']) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(
        join(root, directory, 'item.pack.ts'),
        'throw new Error("must not execute");',
      );
    }
    const page = await listPackSources(root, 2, ['content', 'content/art', 'shared', 'missing']);
    expect(page.sources.map((row) => row.sourcePath)).toEqual([
      'content/art/item.pack.ts',
      'shared/item.pack.ts',
    ]);
    expect(page.hasMore).toBe(false);
    expect((await listPackSources(root, 2, [])).sources).toEqual([]);
    await expect(listPackSources(root, 2, ['../outside'])).rejects.toThrow(RangeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
