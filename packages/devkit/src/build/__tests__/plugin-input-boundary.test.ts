import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertPluginSourceInputs,
  capturePluginProgramInputs,
  discoverPluginAssets,
} from '../plugin-assets.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-input-boundary-')));
  roots.push(root);
  const write = async (path: string, text: string) => {
    const file = resolve(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    return file;
  };
  await write('package.json', '{"type":"module"}');
  await write(
    'assets/main.pack.json',
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000000981',
      assets: { main: { kind: 'plugin', payload: { module: { specifier: './main.ts' } } } },
    }),
  );
  await write('assets/main.ts', "import './helper.ts'; export default { apply() {} };");
  await write('assets/helper.ts', 'export const value = 1;');
  return { root, write, inventory: await discoverPluginAssets({ root, assetRoots: ['assets'] }) };
}
it('ignores unrelated host state and unreferenced code regardless of its directory spelling', async () => {
  const { root, inventory, write } = await fixture();
  for (const path of [
    '.game-builder/state/status.json',
    '.other-host/state/status.json',
    'host-status/status.json',
    'assets/unreferenced.ts',
  ]) {
    await write(path, '{"revision":1}');
    await write(path, '{"revision":2}');
    expect(inventory.sourceInputs.has(resolve(root, path))).toBe(false);
  }
  await expect(assertPluginSourceInputs(inventory, root)).resolves.toBeUndefined();
});
it.each([
  '.game-builder/state/data.json',
  'dist/helper.ts',
  'artifacts/surface.wgsl',
])('fences an explicit dependency at %s', async (path) => {
  const { root, inventory, write } = await fixture();
  await write(path, path.endsWith('.ts') ? 'export const value=1;' : 'one');
  const entry = await write('assets/importer.ts', `import '../${path}';`);
  await capturePluginProgramInputs(root, inventory, entry);
  expect(inventory.sourceInputs.has(resolve(root, path))).toBe(true);
  await write(path, 'two');
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});
it('detects same-size writes with restored mtime and never caches a successful verification', async () => {
  const { root, inventory, write } = await fixture();
  await assertPluginSourceInputs(inventory, root);
  const file = resolve(root, 'assets/helper.ts'),
    before = await stat(file);
  await write('assets/helper.ts', 'export const value = 2;');
  await utimes(file, before.atime, before.mtime);
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});
it.each([
  'assets/added.pack.json',
  'assets/added.meta.json',
  'assets/added.pack.ts',
])('rejects new declaration membership without executing %s', async (path) => {
  const { root, inventory, write } = await fixture();
  await write(path, 'throw new Error("must never execute");');
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
    detail: { cause: { reason: 'source changed during plugin compilation' } },
  });
});
it('rejects deletion of an admitted declaration', async () => {
  const { root, inventory } = await fixture();
  await rm(resolve(root, 'assets/main.pack.json'));
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});
it('observes previously absent dependency policy files', async () => {
  const { root, inventory, write } = await fixture();
  await write('package-lock.json', '{}');
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});
it('rejects new extension candidates even when the compiler resolver retains its old result', async () => {
  const { root, inventory, write } = await fixture();
  const entry = await write('assets/resolution.ts', "import './choice.js';");
  const choice = await write('assets/choice.js', 'export const value=1;');
  await capturePluginProgramInputs(root, inventory, entry, async (specifier, importer) =>
    specifier.endsWith('choice.js') ? choice : resolve(dirname(importer), specifier),
  );
  await write('assets/choice.ts', 'export const value=2;');
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});
it('rejects resolver rebinding with unchanged file bytes', async () => {
  const { root, inventory, write } = await fixture();
  const entry = await write('assets/resolution.ts', "import 'selected';");
  let selected = await write('assets/one.ts', 'export const value=1;');
  const other = await write('assets/two.ts', 'export const value=1;');
  await capturePluginProgramInputs(root, inventory, entry, async (specifier) =>
    specifier === 'selected' ? selected : specifier,
  );
  selected = other;
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});
it('rejects an imported symlink rebound to identical bytes', async () => {
  const { root, inventory, write } = await fixture();
  const entry = await write('assets/resolution.ts', "import './linked.ts';");
  const one = await write('assets/one.ts', 'export const value=1;');
  const two = await write('assets/two.ts', 'export const value=1;');
  const alias = resolve(root, 'assets/linked.ts');
  await symlink(one, alias);
  await capturePluginProgramInputs(root, inventory, entry);
  await rm(alias);
  await symlink(two, alias);
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});

it('fences inherited compiler configuration outside the source directory', async () => {
  const { root, write } = await fixture();
  await write('tsconfig.json', '{"extends":"./config/compiler.json"}');
  await write('config/compiler.json', '{"compilerOptions":{"target":"ES2022"}}');
  const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
  await write('config/compiler.json', '{"compilerOptions":{"target":"ES2020"}}');
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});

it('retains the conservative fence for authored native filesystem readers', async () => {
  const { root, write } = await fixture();
  await write(
    'assets/main.ts',
    "import { readFile } from 'node:fs/promises'; export default { async apply() { await readFile('data.json'); } };",
  );
  await write('data.json', '{"value":1}');
  const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
  expect(inventory.filesystemInputs).toContain(resolve(root, 'data.json'));
  await write('data.json', '{"value":2}');
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});
