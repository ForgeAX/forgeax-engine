import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { build, type Plugin } from 'vite';
import { afterEach, expect, it } from 'vitest';
import {
  assertPluginSourceInputs,
  capturePluginProgramInputs,
  discoverPluginAssets,
  hasPluginSourceInput,
  pluginSourceInputRevision,
} from '../plugin-assets.js';
import { pluginRuntimeProjection, pluginRuntimeQuery } from '../plugin-programs.js';

const roots: string[] = [];
const source = 'export const plugin = true;';
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const slash = (path: string) => path.replaceAll('\\', '/');
const native = (path: string) => path.replaceAll('/', '\\');
const packSource = `import { definePack } from '@forgeax/engine/pack/source';\n${source}\nexport default definePack({});`;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-e02-path-')));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  await writeFile(resolve(root, 'package.json'), '{"name":"path-fixture","type":"module"}');
  return root;
}

function transform(plugin: Plugin, text: string, id: string) {
  if (typeof plugin.transform !== 'function')
    throw new TypeError('runtime projection transform is missing');
  return Reflect.apply(plugin.transform, undefined, [text, id]);
}

async function load(plugin: Plugin, id: string) {
  if (typeof plugin.load !== 'function') throw new TypeError('runtime projection load is missing');
  return Reflect.apply(plugin.load, { addWatchFile() {} }, [id]);
}

it('recognizes native Windows paths, current cwd and Vite slash IDs as one snapshot', async () => {
  const root = await fixture();
  const filename = resolve(root, 'assets', 'plugin.ts');
  await writeFile(filename, source);
  for (const key of [native(filename), slash(filename)]) {
    const inputs = new Map([[key, digest(source)]]);
    const plugin = pluginRuntimeProjection(root, inputs);
    const ids = process.platform === 'win32' ? [native(filename), slash(filename)] : [filename];
    for (const id of ids) {
      expect(hasPluginSourceInput(inputs, id)).toBe(true);
      expect(pluginSourceInputRevision(inputs, id)).toBe(digest(source));
      expect(() => transform(plugin, source, id)).not.toThrow();
      expect(() => transform(plugin, source, `${id}?v=1`)).not.toThrow();
    }
  }
});

it('rejects changed captured bytes while leaving unrelated page modules to Vite', async () => {
  const root = await fixture();
  const filename = resolve(root, 'assets', 'engine-a', 'plugin.ts');
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, `${source}\n`);
  const plugin = pluginRuntimeProjection(root, new Map([[native(filename), digest(source)]]));
  expect(() => transform(plugin, source, slash(filename))).toThrow('source changed');
  await writeFile(filename, source);
  for (const id of [
    resolve(root, 'assets', 'engine-a', 'other.ts'),
    resolve(root, 'assets', 'engine-b', 'plugin.ts'),
    resolve(root, 'other', 'engine-a', 'plugin.ts'),
  ]) {
    await mkdir(dirname(id), { recursive: true });
    await writeFile(id, source);
    expect(() => transform(plugin, source, slash(id))).not.toThrow();
  }
  expect(() =>
    transform(plugin, source, `${slash(root)}/assets/engine-a/../engine-a/plugin.ts`),
  ).not.toThrow();
});

it('uses physical file identity for case aliases while retaining the original-byte fence', async () => {
  const root = await fixture();
  const filename = resolve(root, 'assets', 'plugin.ts');
  const alias = resolve(root, 'assets', 'Plugin.ts');
  await writeFile(filename, source);
  const plugin = pluginRuntimeProjection(root, new Map([[native(filename), digest(source)]]));
  await writeFile(alias, source);
  if ((await realpath(alias)) === (await realpath(filename))) {
    expect(() => transform(plugin, source, slash(alias))).not.toThrow();
    await writeFile(alias, `${source}\n`);
    expect(() => transform(plugin, source, slash(alias))).toThrow('source changed');
  } else {
    // A case-sensitive filesystem gives this ordinary page module a distinct
    // identity. Explicit program admission must still reject the unknown file.
    expect(transform(plugin, source, slash(alias))).toBeNull();
    await expect(load(plugin, `${slash(alias)}${pluginRuntimeQuery}`)).rejects.toThrow(
      'source changed',
    );
  }
});

it('rejects conflicting snapshots under both separator spellings and insertion orders', async () => {
  const root = await fixture();
  const filename = resolve(root, 'assets', 'plugin.ts');
  await writeFile(filename, source);
  const rows: [string, string][] = [
    [native(filename), digest(`${source}\n`)],
    [slash(filename), digest(source)],
  ];
  for (const entries of [rows, [...rows].reverse()]) {
    const inputs = new Map(entries);
    expect(pluginSourceInputRevision(inputs, slash(filename))).toBeUndefined();
    expect(() => transform(pluginRuntimeProjection(root, inputs), source, slash(filename))).toThrow(
      'source changed',
    );
  }
});

it('excludes root, parent, sibling, foreign-drive and ignored paths from projection', () => {
  const root = resolve(process.cwd(), 'fixture-root');
  const ids = [
    root,
    resolve(root, '..', 'outside.ts'),
    `${root}-other/plugin.ts`,
    resolve(root, 'node_modules', 'plugin.ts'),
    resolve(root, '.forgeax', 'plugin.ts'),
  ];
  if (process.platform === 'win32') ids.push('Z:/outside/plugin.ts');
  for (const id of ids) {
    const plugin = pluginRuntimeProjection(root, new Map([[native(id), digest(source)]]));
    expect(transform(plugin, source, slash(id))).toBeNull();
  }
});

it('accepts native snapshots in a real Vite build and rejects changed source', async () => {
  const root = await fixture();
  const entry = resolve(root, 'assets', 'plugin.ts');
  await writeFile(entry, source);
  const inventory = await discoverPluginAssets({ root, assetRoots: [] });
  await capturePluginProgramInputs(root, inventory, entry);
  const run = () =>
    build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [pluginRuntimeProjection(root, inventory.sourceInputs)],
      build: { write: false, minify: false, rollupOptions: { input: slash(entry) } },
    });
  const result = await run();
  const outputs = Array.isArray(result) ? result : [result];
  expect(
    outputs.some(
      (output) =>
        'output' in output &&
        output.output.some(
          (chunk) => chunk.type === 'chunk' && Object.hasOwn(chunk.modules, slash(entry)),
        ),
    ),
  ).toBe(true);
  await writeFile(entry, `${source}\n`);
  await expect(run()).rejects.toThrow('source changed');
});

it('checks original bytes in real metadata projection without treating lowered code as source', async () => {
  const root = await fixture();
  const filename = resolve(root, 'assets', 'feature.pack.ts');
  await writeFile(filename, packSource);
  const inventory = await discoverPluginAssets({ root, assetRoots: [] });
  await capturePluginProgramInputs(root, inventory, filename);
  const plugin = pluginRuntimeProjection(root, inventory.sourceInputs);
  const id = `${slash(filename)}${pluginRuntimeQuery}`;
  const projected = await load(plugin, id);
  expect(projected.code).toContain(source);
  expect(projected.code).not.toContain('definePack');
  expect(() => transform(plugin, projected.code, id)).not.toThrow();
  await writeFile(filename, `${packSource}\n`);
  await expect(load(plugin, id)).rejects.toThrow('source changed');
});

it('requires an exact snapshot for another program even when its metadata bytes match', async () => {
  const root = await fixture();
  const first = resolve(root, 'assets', 'first.pack.ts');
  const second = resolve(root, 'assets', 'second.pack.ts');
  await writeFile(first, packSource);
  await writeFile(second, packSource);
  const plugin = pluginRuntimeProjection(root, new Map([[native(first), digest(packSource)]]));
  await expect(load(plugin, `${slash(second)}${pluginRuntimeQuery}`)).rejects.toThrow(
    'source changed',
  );
});

it('rejects metadata paths outside the root and aliases to external directories', async () => {
  const root = await fixture();
  const outside = await fixture();
  const filename = resolve(outside, 'assets', 'outside.pack.ts');
  await writeFile(filename, packSource);
  const alias = resolve(root, 'assets', 'alias');
  await symlink(
    resolve(outside, 'assets'),
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const aliasFile = resolve(alias, 'outside.pack.ts');
  const plugin = pluginRuntimeProjection(
    root,
    new Map([
      [native(filename), digest(packSource)],
      [native(aliasFile), digest(packSource)],
    ]),
  );
  await expect(load(plugin, `${slash(filename)}${pluginRuntimeQuery}`)).rejects.toThrow(
    'source escapes project root',
  );
  await expect(load(plugin, `${slash(aliasFile)}${pluginRuntimeQuery}`)).rejects.toThrow(
    'source real path escapes project root',
  );
});

it('preserves failure fences for metadata changes and conflicting captured snapshots', async () => {
  const root = await fixture();
  const entry = resolve(root, 'assets', 'plugin.ts');
  const metadata = resolve(root, 'assets', 'fixture.pack.json');
  await writeFile(entry, source);
  await writeFile(metadata, '{"revision":1}');
  const inventory = await discoverPluginAssets({ root, assetRoots: [] });
  await inventory.sourceSnapshot.digest(metadata);
  await capturePluginProgramInputs(root, inventory, entry);
  await expect(assertPluginSourceInputs(inventory, root)).resolves.toBeUndefined();
  await writeFile(metadata, '{"revision":2}');
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
  await expect(inventory.sourceSnapshot.inventory(entry, `${source}\n`)).rejects.toMatchObject({
    code: 'pack-source-revision-conflict',
  });
});
