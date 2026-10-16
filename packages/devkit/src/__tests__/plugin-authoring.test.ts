import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@forgeax/engine-plugin';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginRuntimeProjection } from '../build/plugin-programs.js';
import { migrateStaticGroups, pluginMigrateCommand } from '../plugin/migration.js';
import {
  pluginCreateCommand,
  pluginInspectCommand,
  pluginRootCommand,
} from '../plugin-authoring.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(version = '3.0.0') {
  const parent = await mkdtemp(resolve(import.meta.dirname, '../..', '.author-fixture-'));
  temporary.push(parent);
  const root = resolve(parent, 'original');
  await mkdir(resolve(root, 'assets'), { recursive: true });
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(
    resolve(import.meta.dirname, '../../../engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'dir',
  );
  await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    resolve(root, 'forge.json'),
    JSON.stringify({
      id: 'game',
      name: 'Game',
      schemaVersion: version,
      ...(version === '3.0.0'
        ? { roots: {} }
        : { plugins: [{ id: 'game', name: './assets/game.ts', config: { speed: 2 } }] }),
    }),
  );
  await writeFile(
    resolve(root, 'assets/game.ts'),
    'export default { apply() { throw new Error("must not execute during authoring"); } };',
  );
  return { root, output: resolve(parent, 'candidate'), parent };
}
describe('plugin asset authoring', () => {
  it.each([
    'pack.ts',
    'pack.json',
  ])('inspects configured %s plugins through the JSON CLI', async (format) => {
    const { runUnifiedCli } = await import('../unified-cli.js');
    const { root } = await fixture();
    const config = JSON.parse('{"speed":3,"nested":{"__proto__":{"label":"data"}}}');
    const created = await pluginCreateCommand({
      root,
      path: `assets/inspect.${format}`,
      module: './game.ts',
      config,
    });
    expect(created).toMatchObject({ ok: true });
    const inspected = await runUnifiedCli(['asset', 'plugin', 'inspect', '--root', root, '--json']);
    expect(inspected).toMatchObject({ ok: true, value: { assets: [{ asset: { config } }] } });
    expect(JSON.parse(JSON.stringify(inspected))).toMatchObject({
      value: { assets: [{ asset: { config } }] },
    });
  }, 60_000);

  it('compiles generated named exports and preserves JSON keys across the build/runtime boundary', async () => {
    const { discoverPluginAssets } = await import('../build/plugin-assets.js');
    const { root } = await fixture();
    const config = JSON.parse('{"__proto__":{"speed":3},"label":"quotes \\" and `text`"}');
    const options = {
      root,
      path: 'assets/generated.pack.ts',
      export: 'movement',
      config,
    };
    const preview = await pluginCreateCommand({ ...options, dryRun: true });
    expect(preview).toMatchObject({ ok: true, value: { source: expect.any(String) } });
    await expect(readFile(resolve(root, options.path))).rejects.toMatchObject({ code: 'ENOENT' });
    const created = await pluginCreateCommand(options);
    if (!created.ok) throw created.error;
    expect((await pluginCreateCommand(options)).ok).toBe(false);
    const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
    expect([...inventory.assets.values()][0]?.definition.asset.config).toEqual(config);
    const entry = resolve(root, 'entry.ts');
    await writeFile(
      entry,
      `export { movement as default } from ${JSON.stringify(`${resolve(root, options.path)}?forgeax-plugin-runtime`)};`,
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [pluginRuntimeProjection()],
      build: {
        minify: false,
        target: 'esnext',
        lib: { entry, formats: ['es'], fileName: () => 'runtime.mjs' },
      },
    });
    const runtime = await import(pathToFileURL(resolve(root, 'dist/runtime.mjs')).href);
    const ctx = new Context();
    try {
      const fiber = ctx.plugin(runtime.default, config);
      await fiber.await();
      await fiber.dispose();
      expect([...ctx.registry.values()].flatMap((item) => item.fibers)).toHaveLength(0);
    } finally {
      await ctx.fiber.dispose();
    }
    expect(await readFile(resolve(root, 'dist/runtime.mjs'), 'utf8')).not.toContain('definePack');
  });

  it('requires an existing module for JSON and reserves the Pack default export', async () => {
    const { root } = await fixture();
    for (const options of [
      { path: 'assets/missing.pack.json' },
      { path: 'assets/wrong.pack.ts', export: 'default' },
    ]) {
      expect((await pluginCreateCommand({ root, ...options })).ok).toBe(false);
      await expect(readFile(resolve(root, options.path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(
      await pluginCreateCommand({
        root,
        path: 'assets/existing.pack.ts',
        module: './game.ts',
      }),
    ).toMatchObject({ ok: true });
    expect(await pluginInspectCommand({ root })).toMatchObject({ ok: true });
  });
  it('creates a same-file Pack through the CLI and resolves its named runtime export', async () => {
    const { runUnifiedCli } = await import('../unified-cli.js');
    const { discoverPluginAssets } = await import('../build/plugin-assets.js');
    const { root } = await fixture();
    const created = await runUnifiedCli([
      'asset',
      'plugin',
      'create',
      '--root',
      root,
      '--input',
      '{"path":"assets/movement.pack.ts","config":{"speed":3}}',
    ]);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    if (!created.ok) throw created.error;
    const guid = (created.value as { guid: string }).guid;
    const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
    expect(inventory.assets.get(guid)).toMatchObject({
      module: resolve(root, 'assets/movement.pack.ts'),
      export: 'plugin',
      definition: { asset: { config: { speed: 3 } } },
    });
    expect(await pluginRootCommand({ root, realm: 'engine', guid })).toMatchObject({ ok: true });
    const help = await runUnifiedCli(['help', 'project', 'root', 'set', '--root', root, '--json']);
    expect(help).toMatchObject({
      ok: true,
      value: {
        leaf: {
          inputSchema: {
            properties: { realm: { enum: expect.arrayContaining(['frontend']) } },
          },
        },
      },
    });
    expect(
      await runUnifiedCli([
        'project',
        'root',
        'set',
        '--root',
        root,
        '--realm',
        'frontend',
        '--guid',
        guid,
        '--json',
      ]),
    ).toMatchObject({ ok: true, value: { manifest: { roots: { engine: guid, frontend: guid } } } });
  }, 60_000);
  it('creates and inspects a definition without evaluating it, then changes only the project root reference', async () => {
    const { root } = await fixture();
    const created = await pluginCreateCommand({
      root,
      path: 'assets/game.pack.json',
      module: './game.ts',
      config: { speed: 2 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    const guid = (created.value as { guid: string }).guid;
    const source = await readFile(resolve(root, 'assets/game.pack.json'), 'utf8');
    expect(await pluginRootCommand({ root, realm: 'engine', guid })).toMatchObject({ ok: true });
    expect(await pluginInspectCommand({ root })).toMatchObject({
      ok: true,
      value: {
        roots: { engine: guid },
        assets: [{ lifecycle: 'definition', execution: 'not-observed' }],
      },
    });
    expect(await pluginRootCommand({ root, realm: 'engine', guid: null })).toMatchObject({
      ok: true,
    });
    expect(await readFile(resolve(root, 'assets/game.pack.json'), 'utf8')).toBe(source);
  });
  it('does not overwrite source or set an unresolved root', async () => {
    const { root } = await fixture();
    const options = { root, path: 'assets/game.pack.json', module: './game.ts' };
    expect((await pluginCreateCommand(options)).ok).toBe(true);
    const before = await readFile(resolve(root, 'assets/game.pack.json'), 'utf8');
    expect((await pluginCreateCommand({ ...options, config: 2 })).ok).toBe(false);
    expect(await readFile(resolve(root, 'assets/game.pack.json'), 'utf8')).toBe(before);
    expect(
      (
        await pluginRootCommand({
          root,
          realm: 'engine',
          guid: '00000000-0000-5000-8000-000000000000',
        })
      ).ok,
    ).toBe(false);
  });
});
describe('one-shot schema migration', () => {
  it('compiles a candidate without executing plugins or changing the original', async () => {
    const { root, output } = await fixture('2.0.0');
    const before = await readFile(resolve(root, 'forge.json'), 'utf8');
    const result = await pluginMigrateCommand({ root, output });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(await readFile(resolve(root, 'forge.json'), 'utf8')).toBe(before);
    expect(JSON.parse(await readFile(resolve(output, 'forge.json'), 'utf8'))).toMatchObject({
      schemaVersion: '3.0.0',
      roots: { engine: expect.any(String) },
    });
    expect((await pluginMigrateCommand({ root, output })).ok).toBe(false);
  }, 30_000);
  it('rejects missing module exports before publishing any candidate', async () => {
    const { root, output, parent } = await fixture('2.0.0');
    await writeFile(resolve(root, 'assets/game.ts'), 'export const wrong = {};');
    expect((await pluginMigrateCommand({ root, output })).ok).toBe(false);
    expect(await readdir(parent)).toEqual(['original']);
  }, 30_000);
  it('converts literal composition and reports dynamic state instead of guessing', () => {
    const input = `import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
    import child from './child'; export default definePluginGroup({ name: 'game', children: () => [usePlugin(child, { speed: 3 }, { key: 'child' })] });`;
    expect(migrateStaticGroups(input, 'assets/game.ts')).toContain(
      'ctx.plugin(child, { speed: 3 })',
    );
    expect(migrateStaticGroups(input, 'assets/game.ts')).not.toContain('definePluginGroup');
    expect(() =>
      migrateStaticGroups(input.replace('{ speed: 3 }', 'config'), 'assets/game.ts'),
    ).toThrow();
  });
});

it('sets and clears a root through the public CLI nullable GUID contract', async () => {
  const { runUnifiedCli } = await import('../unified-cli.js');
  const { root } = await fixture();
  const created = await pluginCreateCommand({
    root,
    path: 'assets/game.pack.json',
    module: './game.ts',
  });
  if (!created.ok) throw created.error;
  const guid = (created.value as { guid: string }).guid;
  const set = await runUnifiedCli([
    'project',
    'root',
    'set',
    '--root',
    root,
    '--realm',
    'engine',
    '--guid',
    guid,
  ]);
  expect(set, JSON.stringify(set)).toMatchObject({ ok: true });
  expect(JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')).roots).toEqual({
    engine: guid,
  });
  const clear = await runUnifiedCli([
    'project',
    'root',
    'set',
    '--root',
    root,
    '--realm',
    'engine',
    '--guid',
    'null',
  ]);
  expect(clear, JSON.stringify(clear)).toMatchObject({ ok: true });
  expect(JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')).roots).toEqual({});
  expect(
    await runUnifiedCli([
      'project',
      'root',
      'set',
      '--root',
      root,
      '--input',
      JSON.stringify({ realm: 'engine', guid: 42 }),
    ]),
  ).toMatchObject({ ok: false, error: { code: 'cli-parse-error' } });
});
