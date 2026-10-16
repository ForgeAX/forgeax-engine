import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadPackProgram, preparePackProgram } from '@forgeax/engine-pack/runtime';
import { afterEach, expect, it } from 'vitest';
import {
  nativeModuleIdentity,
  nativeModuleKey,
  resolveNativeModuleKey,
} from '../native-module-identity.js';
import { createNodePackProgramHost } from '../pack-program-host.js';
import { createNodePackProgramImports } from '../pack-program-imports.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-native-import-')));
  roots.push(root);
  return root;
}
async function file(root: string, name: string, content: string) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return pathToFileURL(path).href;
}

it('keeps identical nested package instances independent after moving the entire installation', async () => {
  const root = await directory();
  await file(root, 'package.json', JSON.stringify({ dependencies: { a: '*', b: '*' } }));
  const urls: string[] = [];
  for (const name of ['a', 'b']) {
    await file(
      root,
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version: '1', dependencies: { counter: '*' } }),
    );
    await file(
      root,
      `node_modules/${name}/node_modules/counter/package.json`,
      JSON.stringify({ name: 'counter', version: '1', type: 'module' }),
    );
    urls.push(
      await file(
        root,
        `node_modules/${name}/node_modules/counter/index.js`,
        'let value = 0; export const next = () => ++value;',
      ),
    );
  }
  const keys = await Promise.all(urls.map((url) => nativeModuleKey(root, url)));
  expect(new Set(keys).size).toBe(2);
  const identities = await Promise.all(urls.map(nativeModuleIdentity));
  expect(new Set(identities).size).toBe(1);
  expect(keys.join()).not.toContain(root);
  const target = await directory();
  await cp(root, target, { recursive: true });
  await rm(root, { recursive: true });
  const imports = await createNodePackProgramImports(target, keys);
  expect(Object.values(imports).map((item) => item.identity)).toEqual(identities);
  const rebound = Object.values(imports).map((item) => item.url);
  const result = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `
    const [a, b] = await Promise.all(${JSON.stringify(rebound)}.map(url => import(url)));
    console.log(JSON.stringify([a.next(), b.next(), a.next(), b.next()]));
  `,
  ]);
  expect(JSON.parse(result.stdout)).toEqual([1, 1, 2, 2]);
  await file(
    target,
    'node_modules/b/node_modules/counter/index.js',
    'export const next = () => 99;',
  );
  const changed = await createNodePackProgramImports(target, keys);
  expect(Object.values(changed)[0]?.identity).toBe(identities[0]);
  expect(Object.values(changed)[1]?.identity).not.toBe(identities[1]);
  const selectedKey = keys[1];
  const selectedIdentity = identities[1];
  if (!selectedKey || !selectedIdentity) throw new TypeError('missing recorded package import');
  const program = preparePackProgram({
    entry: 'main.js',
    export: 'default',
    modules: {
      'main.js': `import { next } from ${JSON.stringify(selectedKey)}; export default next();`,
    },
    imports: { [selectedKey]: selectedIdentity },
  }).unwrap();
  expect(await loadPackProgram(program, changed, createNodePackProgramHost(target))).toMatchObject({
    ok: false,
    error: { code: 'pack-program-dependency-unavailable' },
  });
});

it('hashes the installed package outside a type-only subdirectory and includes resolved peers', async () => {
  const root = await directory();
  await file(root, 'package.json', '{"dependencies":{"library":"*"}}');
  await file(
    root,
    'node_modules/library/package.json',
    JSON.stringify({
      name: 'library',
      version: '1',
      type: 'module',
      peerDependencies: { peer: '*' },
    }),
  );
  await file(root, 'node_modules/library/modules/package.json', '{"type":"module"}');
  const entry = await file(
    root,
    'node_modules/library/modules/index.js',
    "export { value } from '../core.js'; export { peer } from 'peer';",
  );
  await file(root, 'node_modules/library/core.js', 'export const value = 1;');
  await file(
    root,
    'node_modules/peer/package.json',
    '{"name":"peer","version":"1","type":"module"}',
  );
  await file(root, 'node_modules/peer/index.js', 'export const peer = 1;');
  const original = await nativeModuleIdentity(entry);
  await file(root, 'node_modules/library/core.js', 'export const value = 2;');
  expect(await nativeModuleIdentity(entry)).not.toBe(original);
  await file(root, 'node_modules/library/core.js', 'export const value = 1;');
  expect(await nativeModuleIdentity(entry)).toBe(original);
  await file(root, 'node_modules/peer/index.js', 'export const peer = 2;');
  expect(await nativeModuleIdentity(entry)).not.toBe(original);
  const key = await nativeModuleKey(root, entry);
  expect(await resolveNativeModuleKey(root, key)).toBe(entry);
  await rm(join(root, 'node_modules/peer'), { recursive: true });
  await expect(nativeModuleIdentity(entry)).rejects.toThrow('dependency unavailable');
});

it('resolves imports from a nested authored package authority instead of the project root', async () => {
  const root = await directory();
  await file(root, 'package.json', '{}');
  await file(root, 'plugins/local/package.json', '{"dependencies":{"counter":"*"}}');
  await file(
    root,
    'plugins/local/node_modules/counter/package.json',
    '{"name":"counter","version":"1"}',
  );
  const entry = await file(
    root,
    'plugins/local/node_modules/counter/index.js',
    'export default 42;',
  );
  const importer = join(root, 'plugins/local/main.js');
  const key = await nativeModuleKey(root, entry, importer);
  expect(JSON.parse(decodeURIComponent(key.slice(4)))).toEqual([
    'plugins/local',
    ['counter'],
    'index.js',
  ]);
  expect(await resolveNativeModuleKey(root, key)).toBe(entry);
  await expect(nativeModuleKey(root, entry)).rejects.toThrow('not reachable');
  const target = await directory();
  await cp(root, target, { recursive: true });
  await rm(root, { recursive: true });
  const rebound = pathToFileURL(join(target, 'plugins/local/node_modules/counter/index.js')).href;
  expect(await resolveNativeModuleKey(target, key)).toBe(rebound);
  await file(target, 'plugins/local/package.json', '{}');
  await expect(resolveNativeModuleKey(target, key)).rejects.toThrow('no longer declared');
});

it.each([
  ['../outside', 'index.js'],
  ['plugins/../local', 'index.js'],
  ['./plugins/local', 'index.js'],
  ['plugins\\local', 'index.js'],
  ['C:/plugins/local', 'index.js'],
  ['C:plugins/local', 'index.js'],
  ['plugins/local', '../index.js'],
  ['plugins/local', './index.js'],
  ['plugins/local', 'nested\\index.js'],
  ['plugins/local', 'D:/index.js'],
  ['plugins/local', 'D:index.js'],
  ['plugins/local', '%2e%2e/index.js'],
  ['plugins/local', '%43%3aindex.js'],
  ['plugins/node_modules/local', 'index.js'],
])('rejects nonportable or escaping locator paths: %s -> %s', async (anchor, entry) => {
  const key = `npm:${encodeURIComponent(JSON.stringify([anchor, ['counter'], entry]))}`;
  await expect(resolveNativeModuleKey(await directory(), key)).rejects.toThrow(
    'invalid native module dependency route',
  );
});

it('rejects an authored anchor whose real path escapes the project', async () => {
  const root = await directory();
  const outside = await directory();
  await file(root, 'package.json', '{}');
  await file(outside, 'package.json', '{"dependencies":{"counter":"*"}}');
  await mkdir(join(root, 'plugins'));
  await symlink(
    outside,
    join(root, 'plugins/local'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const key = `npm:${encodeURIComponent(JSON.stringify(['plugins/local', ['counter'], 'index.js']))}`;
  await expect(resolveNativeModuleKey(root, key)).rejects.toThrow('anchor escapes project');
});

it('rejects an installed entry whose real path escapes its package', async () => {
  const root = await directory();
  const outside = await directory();
  await file(root, 'package.json', '{"dependencies":{"counter":"*"}}');
  await file(root, 'node_modules/counter/package.json', '{"name":"counter","version":"1"}');
  await file(outside, 'index.js', 'export default 99;');
  await symlink(
    outside,
    join(root, 'node_modules/counter/linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const key = `npm:${encodeURIComponent(JSON.stringify(['', ['counter'], 'linked/index.js']))}`;
  await expect(resolveNativeModuleKey(root, key)).rejects.toThrow('entry escapes package');
});

it('rebinds Node builtins with their own identity and executes without a compiler or Engine installation', async () => {
  const root = await directory();
  const imports = await createNodePackProgramImports(root, ['node:path']);
  const program = preparePackProgram({
    entry: 'main.js',
    export: 'default',
    modules: {
      'main.js': "import { basename } from 'node:path'; export default basename('/saved/file');",
    },
    imports: { 'node:path': `node:${process.versions.node}` },
  }).unwrap();
  expect((await loadPackProgram(program, imports, createNodePackProgramHost(root))).unwrap()).toBe(
    'file',
  );
});

it('preserves native URL query and fragment instances during fresh-process recovery', async () => {
  const root = await directory();
  await file(root, 'package.json', '{"dependencies":{"counter":"*"}}');
  await file(
    root,
    'node_modules/counter/package.json',
    '{"name":"counter","version":"1","type":"module"}',
  );
  const url = await file(
    root,
    'node_modules/counter/counter #1.js',
    'let n = 0; export const next = () => ++n;',
  );
  const originals = [`${url}?one&path=/node_modules/a#first/a/../b`, `${url}?two#second`];
  const keys = await Promise.all(originals.map((url) => nativeModuleKey(root, url)));
  expect(new Set(keys).size).toBe(2);
  const imports = await createNodePackProgramImports(root, keys);
  expect(Object.values(imports).map((value) => value.url)).toEqual(originals);
  const result = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `
    const [a, b] = await Promise.all(${JSON.stringify(Object.values(imports))}.map(item => import(item.url)));
    console.log(JSON.stringify([a.next(), b.next(), a.next(), b.next()]));
  `,
  ]);
  expect(JSON.parse(result.stdout)).toEqual([1, 1, 2, 2]);
});
