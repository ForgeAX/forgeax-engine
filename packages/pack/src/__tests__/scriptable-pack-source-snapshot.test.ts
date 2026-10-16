import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import type { PackAuthoringError } from '../pack-authoring.js';
import { loadScriptablePack } from '../scriptable-pack-node.js';
import { createScriptablePackSourceSnapshot } from '../scriptable-pack-source-snapshot.js';

const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-source-snapshot-')));
  roots.push(root);
  const source = join(root, 'asset.pack.ts');
  const dependency = join(root, 'shape.js');
  await writeFile(source, "export { shape } from './shape.js';");
  await writeFile(dependency, 'export const shape = 1;');
  return { root, source, dependency };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('does not retain a failed metadata evaluation across timeout policies', async () => {
  const snapshot = createScriptablePackSourceSnapshot();
  const error = {
    code: 'pack-source-revision-conflict',
    expected: 'metadata evaluation to succeed',
    hint: 'retry with the caller timeout',
    detail: {},
  } satisfies PackAuthoringError;
  const evaluate = vi.fn(async () => err(error));
  expect((await snapshot.metadata('/fixture.pack.ts', evaluate)).ok).toBe(false);
  expect((await snapshot.metadata('/fixture.pack.ts', evaluate)).ok).toBe(false);
  expect(evaluate).toHaveBeenCalledTimes(2);
});

it('shares one immutable input across roots and refuses a changed generation', async () => {
  const { source, dependency } = await fixture();
  const snapshot = createScriptablePackSourceSnapshot();
  const first = await snapshot.inventory(source);
  const before = await stat(dependency);
  await writeFile(dependency, 'export const shape = 2;');
  await utimes(dependency, before.atime, before.mtime);
  expect(await snapshot.inventory(source)).toEqual(first);
  expect(await snapshot.readText(dependency)).toBe('export const shape = 1;');
  expect(await snapshot.verify()).toMatchObject({
    ok: false,
    error: { code: 'pack-source-revision-conflict' },
  });
  expect(await createScriptablePackSourceSnapshot().inventory(source)).not.toEqual(first);
});

it('captures failed resolution probes, deletion and symlink rebinding', async () => {
  const { root, source, dependency } = await fixture();
  const snapshot = createScriptablePackSourceSnapshot();
  await snapshot.inventory(source);
  await writeFile(join(root, 'shape.ts'), 'export const shape = 3;');
  expect((await snapshot.verify()).ok).toBe(false);
  const next = createScriptablePackSourceSnapshot();
  expect((await next.inventory(source)).map((entry) => entry.path)).toContain(
    join(root, 'shape.ts'),
  );
  await unlink(join(root, 'shape.ts'));
  expect((await next.verify()).ok).toBe(false);
  const alias = join(root, 'alias.js');
  await symlink(dependency, alias);
  const linked = createScriptablePackSourceSnapshot();
  await linked.readText(alias);
  await unlink(alias);
  await symlink(source, alias);
  expect((await linked.verify()).ok).toBe(false);
});

it('revalidates custom resolution and never mistakes directory metadata for source identity', async () => {
  const { root, source, dependency } = await fixture();
  const other = join(root, 'other.js');
  await writeFile(other, await readFile(dependency));
  let target = dependency;
  const resolveImport = vi.fn(async () => target);
  const snapshot = createScriptablePackSourceSnapshot();
  await snapshot.inventory(source, undefined, resolveImport);
  await snapshot.inventory(source, undefined, resolveImport);
  expect(resolveImport).toHaveBeenCalledTimes(1);
  expect((await snapshot.verify()).ok).toBe(true);
  target = other;
  expect((await snapshot.verify()).ok).toBe(false);
});

it('keeps captured module text usable after source deletion and isolates returned records', async () => {
  const { source, dependency } = await fixture();
  const snapshot = createScriptablePackSourceSnapshot();
  const captured = await snapshot.moduleSources(source);
  await unlink(dependency);
  expect(captured.entry).toBe(source);
  expect(captured.sources[dependency]).toBe('export const shape = 1;');
  captured.sources[dependency] = 'corrupted consumer copy';
  expect((await snapshot.moduleSources(source)).sources[dependency]).toBe(
    'export const shape = 1;',
  );
  expect((await snapshot.verify()).ok).toBe(false);
});

it('executes an aliased entry and its captured relative closure after dependency deletion', async () => {
  const { root, source, dependency } = await fixture();
  await writeFile(
    dependency,
    "export const schemaVersion = '2.0.0'; export const packageId = new Uint8Array(16).fill(5);",
  );
  await writeFile(
    source,
    "import { schemaVersion, packageId } from './shape.js'; export default { schemaVersion, packageId, build() { return { ok: true, value: {} }; } };",
  );
  const alias = join(root, 'linked');
  await symlink(root, alias, 'dir');
  const entry = join(alias, 'asset.pack.ts');
  const snapshot = createScriptablePackSourceSnapshot();
  const captured = await snapshot.moduleSources(entry);
  expect(captured.entry).toBe(source);
  expect(Object.keys(captured.sources).sort()).toEqual([source, dependency].sort());
  await unlink(dependency);
  const loaded = await loadScriptablePack(entry, { sourceSnapshot: snapshot, metadataOnly: true });
  expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
  expect((await snapshot.verify()).ok).toBe(false);
});

it('captures JSON data as a dependency and verifies its bytes without source imports', async () => {
  const { root, source } = await fixture();
  const data = join(root, 'data.json');
  const text = '{"note":"import hidden from \'./never-read.js\'","value":1}';
  await writeFile(data, text);
  await writeFile(
    source,
    "import data from './data.json' with { type: 'json' }; export default data;",
  );
  const snapshot = createScriptablePackSourceSnapshot();
  const captured = await snapshot.moduleSources(source);
  expect(Object.keys(captured.sources).sort()).toEqual([source, data].sort());
  expect(captured.sources[data]).toBe(text);
  expect((await snapshot.verify()).ok).toBe(true);
  await writeFile(data, text.replace('"value":1', '"value":2'));
  expect(captured.sources[data]).toBe(text);
  expect((await snapshot.verify()).ok).toBe(false);
});

it('preserves original BOM bytes across text reads and repeated inventories', async () => {
  const { source } = await fixture();
  const text = '\uFEFFexport const value = 1;';
  await writeFile(source, text);
  const snapshot = createScriptablePackSourceSnapshot();
  await snapshot.inventory(source);
  expect(await snapshot.readText(source)).toBe(text);
  await expect(snapshot.inventory(source, await snapshot.readText(source))).resolves.toHaveLength(
    1,
  );
  expect((await snapshot.verify()).ok).toBe(true);
});

it('retires borrowed resolvers after their live verification while retaining byte evidence', async () => {
  const { source, dependency } = await fixture();
  const snapshot = createScriptablePackSourceSnapshot();
  let live = true;
  await snapshot.inventory(source, undefined, async () => {
    if (!live) throw new Error('compiler retired');
    return dependency;
  });
  expect((await snapshot.verify()).ok).toBe(true);
  snapshot.releaseResolvers();
  live = false;
  expect((await snapshot.verify()).ok).toBe(true);
  await writeFile(dependency, 'export const shape = 2;');
  expect((await snapshot.verify()).ok).toBe(false);
});

it('rechecks producer discovery membership independently of byte identities', async () => {
  const { root, source } = await fixture();
  const snapshot = createScriptablePackSourceSnapshot();
  let paths = [source];
  await snapshot.observePaths(root, async () => paths);
  await snapshot.inventory(source);
  paths = [...paths, `${root}/added.wgsl`];
  expect(await snapshot.verify()).toMatchObject({
    ok: false,
    error: { detail: { reason: 'source discovery membership changed' } },
  });
});
