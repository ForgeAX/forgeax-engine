// @perf-budget-skip: real filesystem transaction and Vite source closure compilation.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { afterEach, expect, it } from 'vitest';
import { parseAllDocuments, stringify } from 'yaml';
import { assetSourceImportCommand } from '../source-transfer.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const namespace = '01900000-0000-7000-8000-000000000101';
const parsed = PackageId.parse(namespace);
if (!parsed.ok) throw parsed.error;
const childGuid = AssetGuid.format(AssetGuid.derive(parsed.value, 'plugin/child'));
async function fixture() {
  const base = await mkdtemp(resolve(tmpdir(), 'forgeax-transfer-'));
  roots.push(base);
  const source = resolve(base, 'source'),
    target = resolve(base, 'target');
  for (const root of [source, target]) {
    await mkdir(resolve(root, 'assets'), { recursive: true });
    await writeFile(resolve(root, 'package.json'), '{"name":"transfer-fixture"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({ id: 'transfer', name: 'Transfer', schemaVersion: '3.0.0', roots: {} }),
    );
    await symlink(resolve(process.cwd(), 'node_modules'), resolve(root, 'node_modules'), 'dir');
  }
  await writeFile(
    resolve(source, 'assets/role.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: namespace,
      assets: {
        'plugin/root': {
          kind: 'plugin',
          payload: { module: { specifier: './role.ts' }, config: { child: { $asset: childGuid } } },
        },
        'plugin/child': { kind: 'plugin', payload: { module: { specifier: './child.ts' } } },
      },
    }),
  );
  await writeFile(
    resolve(source, 'assets/role.ts'),
    "import child from './child'; export default { apply() { child.apply(); } };",
  );
  await writeFile(
    resolve(source, 'assets/child.ts'),
    "export default { apply() { throw new Error('transfer must never activate'); } };",
  );
  return { source, target };
}
it('imports a complete code closure and preserves identities without activating plugins', async () => {
  const { source, target } = await fixture();
  const result = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/role',
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const pack = JSON.parse(
    await readFile(resolve(target, 'assets/role/assets/role.pack.json'), 'utf8'),
  );
  expect(pack.packageId).toBe(namespace);
  const reused = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/role',
  });
  expect(reused, JSON.stringify(reused)).toMatchObject({ ok: true, value: { reused: true } });
  expect(await readFile(resolve(target, 'assets/role/assets/child.ts'), 'utf8')).toContain(
    'transfer must never activate',
  );
});
it('clones the same closure with independent namespaces and rewritten references', async () => {
  const { source, target } = await fixture();
  const result = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/clone',
    cloneIdentities: true,
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const pack = JSON.parse(
    await readFile(resolve(target, 'assets/clone/assets/role.pack.json'), 'utf8'),
  );
  expect(pack.packageId).not.toBe(namespace);
  const identity = PackageId.parse(pack.packageId);
  if (!identity.ok) throw identity.error;
  expect(pack.assets['plugin/root'].payload.config.child.$asset).toBe(
    AssetGuid.format(AssetGuid.derive(identity.value, 'plugin/child')),
  );
  expect(
    JSON.parse(await readFile(resolve(source, 'assets/role.pack.json'), 'utf8')).packageId,
  ).toBe(namespace);
});
it('rejects duplicate identities and missing modules before publishing files', async () => {
  const { source, target } = await fixture();
  await writeFile(
    resolve(target, 'assets/existing.pack.json'),
    await readFile(resolve(source, 'assets/role.pack.json')),
  );
  const duplicate = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/role',
  });
  expect(duplicate.ok).toBe(false);
  await expect(
    readFile(resolve(target, 'assets/role/assets/role.pack.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(resolve(source, 'assets/child.ts'));
  const missing = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/missing',
    cloneIdentities: true,
  });
  expect(missing.ok).toBe(false);
  await expect(
    readFile(resolve(target, 'assets/missing/assets/role.pack.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a changed expected source revision without leaving a destination', async () => {
  const { source, target } = await fixture();
  const result = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/stale',
    expectedRevision: 'sha256:stale',
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'pack-source-revision-conflict' } });
  await expect(
    readFile(resolve(target, 'assets/stale/assets/role.pack.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('imports an exact locked npm dependency and rejects target version conflicts', async () => {
  const { source, target } = await fixture();
  const repoLockDocuments = parseAllDocuments(
    await readFile(resolve(import.meta.dirname, '../../../../pnpm-lock.yaml'), 'utf8'),
  );
  const repoLock = repoLockDocuments.at(-1)?.toJSON();
  const envLockfile = repoLockDocuments[0]?.toString();
  expect(repoLockDocuments.length).toBe(2);
  expect(envLockfile).toContain('packageManagerDependencies:');
  const dependency = repoLock.importers['packages/devkit'].dependencies.yaml;
  const rootPackage = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../../../../package.json'), 'utf8'),
  );
  const targetPackagePath = resolve(target, 'package.json');
  const targetPackage = JSON.parse(await readFile(targetPackagePath, 'utf8'));
  targetPackage.packageManager = rootPackage.packageManager;
  await writeFile(targetPackagePath, JSON.stringify(targetPackage));
  await writeFile(
    resolve(target, 'pnpm-lock.yaml'),
    `${envLockfile}---\n${stringify({
      lockfileVersion: repoLock.lockfileVersion,
      settings: repoLock.settings,
      importers: { '.': {} },
      packages: {},
      snapshots: {},
    })}`,
  );
  await writeFile(
    resolve(source, 'package.json'),
    JSON.stringify({ name: 'source', dependencies: { yaml: dependency.specifier } }),
  );
  await writeFile(
    resolve(source, 'pnpm-lock.yaml'),
    stringify({ ...repoLock, importers: { '.': { dependencies: { yaml: dependency } } } }),
  );
  await writeFile(
    resolve(source, 'assets/child.ts'),
    "import { parse } from 'yaml'; export default { apply() { return parse('a: 1'); } };",
  );
  const imported = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/dependent',
  });
  expect(imported, JSON.stringify(imported)).toMatchObject({ ok: true });
  const targetLockDocuments = parseAllDocuments(
    await readFile(resolve(target, 'pnpm-lock.yaml'), 'utf8'),
  );
  expect(targetLockDocuments).toHaveLength(2);
  expect(
    targetLockDocuments[0]?.getIn([
      'importers',
      '.',
      'packageManagerDependencies',
      'pnpm',
      'version',
    ]),
  ).toBe(rootPackage.packageManager.slice('pnpm@'.length));
  const targetLock = targetLockDocuments.at(-1)?.toJSON();
  expect(targetLock.importers['.'].dependencies.yaml.version).toBe(dependency.version);
  expect(
    JSON.parse(await readFile(resolve(target, 'node_modules/yaml/package.json'), 'utf8')).version,
  ).toBe(dependency.version);
  targetLock.importers['.'].dependencies.yaml.version = '1.0.0';
  await writeFile(resolve(target, 'pnpm-lock.yaml'), `${envLockfile}---\n${stringify(targetLock)}`);
  const staleReuse = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/dependent',
  });
  expect(staleReuse).toMatchObject({ ok: false, error: { code: 'pack-source-revision-conflict' } });
  const conflict = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/conflict',
    cloneIdentities: true,
  });
  expect(conflict).toMatchObject({ ok: false, error: { code: 'pack-source-revision-conflict' } });
  await expect(
    readFile(resolve(target, 'assets/conflict/assets/role.pack.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
}, 180_000);

it('rejects symlink destinations and extra files in an existing import', async () => {
  const { source, target } = await fixture();
  const outside = resolve(target, '../outside');
  await mkdir(outside);
  await symlink(outside, resolve(target, 'assets/link'), 'dir');
  const options = {
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/link/role',
  };
  expect(await assetSourceImportCommand(options)).toMatchObject({
    ok: false,
    error: { code: 'pack-source-revision-conflict' },
  });
  await expect(readFile(resolve(outside, 'role/assets/role.pack.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  options.targetPath = 'assets/role';
  expect(await assetSourceImportCommand(options)).toMatchObject({ ok: true });
  await writeFile(resolve(target, 'assets/role/extra.ts'), 'export default 1;');
  expect(await assetSourceImportCommand(options)).toMatchObject({
    ok: false,
    error: { code: 'pack-source-revision-conflict' },
  });
});

it('resolves already locked dependencies before evaluating candidate pack.ts sources', async () => {
  const { source, target } = await fixture();
  const dependency = '@transfer-fixture/author-helper';
  for (const root of [source, target]) {
    await rm(resolve(root, 'node_modules'));
    await mkdir(resolve(root, 'node_modules', dependency), { recursive: true });
    await writeFile(
      resolve(root, 'node_modules', dependency, 'package.json'),
      JSON.stringify({ name: dependency, version: '0.0.0', type: 'module', exports: './index.js' }),
    );
    await writeFile(
      resolve(root, 'node_modules', dependency, 'index.js'),
      'export const speed = 7;',
    );
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({
        name: 'scriptable-transfer',
        dependencies: { [dependency]: '0.0.0' },
      }),
    );
    await writeFile(
      resolve(root, 'pnpm-lock.yaml'),
      stringify({
        lockfileVersion: '9.0',
        importers: {
          '.': {
            dependencies: {
              [dependency]: { specifier: '0.0.0', version: '0.0.0' },
            },
          },
        },
        packages: { [`${dependency}@0.0.0`]: { resolution: { integrity: 'sha512-fixture' } } },
        snapshots: { [`${dependency}@0.0.0`]: {} },
      }),
    );
  }
  await writeFile(
    resolve(source, 'assets/behavior.pack.ts'),
    `
import { speed } from '@transfer-fixture/author-helper';
export default { schemaVersion: '2.0.0', plugins: true,
  packageId: new Uint8Array([1,144,0,0,0,0,112,0,128,0,0,0,0,0,1,113]),
  build: () => ({ ok: true, value: { 'plugin/root': {
    kind: 'plugin', module: { specifier: './child.ts' }, config: { speed },
  } } }) };`,
  );
  const result = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/behavior.pack.ts',
    targetPath: 'assets/behavior',
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(
    await readFile(resolve(target, 'assets/behavior/assets/behavior.pack.ts'), 'utf8'),
  ).toContain('@transfer-fixture/author-helper');
});

it('clones project shader identities with their material references before publication', async () => {
  const { source, target } = await fixture();
  const path = resolve(source, 'assets/role.pack.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  original.assets['material/local'] = {
    kind: 'material',
    refs: [],
    payload: {
      passes: [{ name: 'forward', program: { module: 'role::surface' } }],
    },
  };
  await writeFile(path, JSON.stringify(original));
  await mkdir(resolve(source, 'assets/shaders'));
  await writeFile(
    resolve(source, 'assets/shaders/surface.wgsl'),
    '#define_import_path role::surface\n#import role::noise::{noise}\n',
  );
  await writeFile(
    resolve(source, 'assets/shaders/noise.wgsl'),
    '#define_import_path role::noise\nfn noise() -> f32 { return 1.0; }\n',
  );
  const imported = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/original',
  });
  expect(imported, JSON.stringify(imported)).toMatchObject({ ok: true });
  const cloned = await assetSourceImportCommand({
    root: target,
    sourceRoot: target,
    sourcePath: 'assets/original/assets/role.pack.json',
    targetPath: 'assets/clone',
    cloneIdentities: true,
  });
  expect(cloned, JSON.stringify(cloned)).toMatchObject({ ok: true });
  const base = resolve(target, 'assets/clone/assets/original/assets');
  const pack = JSON.parse(await readFile(resolve(base, 'role.pack.json'), 'utf8'));
  const module = pack.assets['material/local'].payload.passes[0].program.module;
  expect(module).not.toBe('role::surface');
  const shader = await readFile(resolve(base, 'shaders/surface.wgsl'), 'utf8');
  expect(shader).toContain(`#define_import_path ${module}`);
  const noise = (await readFile(resolve(base, 'shaders/noise.wgsl'), 'utf8'))
    .split('\n')[0]
    ?.slice('#define_import_path '.length);
  expect(noise).not.toBe('role::noise');
  expect(shader).toContain(`#import ${noise}::{noise}`);
  expect(
    await readFile(resolve(target, 'assets/original/assets/shaders/surface.wgsl'), 'utf8'),
  ).toContain('#define_import_path role::surface');
});

it('imports into an asset directory selected by the target project manifest', async () => {
  const { source, target } = await fixture();
  await mkdir(resolve(target, 'content'));
  await writeFile(
    resolve(target, 'forge.json'),
    JSON.stringify({
      id: 'transfer',
      name: 'Transfer',
      schemaVersion: '3.0.0',
      roots: {},
      assetRoots: ['content'],
    }),
  );
  const result = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'content/role',
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(await readFile(resolve(target, 'content/role/assets/role.pack.json'), 'utf8')).toContain(
    namespace,
  );
  const outside = await assetSourceImportCommand({
    root: target,
    sourceRoot: source,
    sourcePath: 'assets/role.pack.json',
    targetPath: 'assets/other',
  });
  expect(outside).toMatchObject({ ok: false });
});
