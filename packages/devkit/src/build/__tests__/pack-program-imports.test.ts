import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPackProgram, preparePackProgram } from '@forgeax/engine-pack/runtime';
import { describe, expect, it } from 'vitest';
import { createNodePackProgramImports } from '../pack-program-imports.js';
import { discoverPluginAssets } from '../plugin-assets.js';
import { compileNodePluginPrograms } from '../plugin-programs-node.js';

const specifier = '@forgeax/engine/render/authoring';

async function writeEngine(root: string, version: string): Promise<void> {
  await mkdir(resolve(root, 'dist'), { recursive: true });
  await writeFile(
    resolve(root, 'package.json'),
    JSON.stringify({
      name: '@forgeax/engine',
      version,
      type: 'module',
      exports: {
        './package.json': './package.json',
        './render/authoring': { import: './dist/authoring.mjs' },
      },
    }),
  );
  await writeFile(resolve(root, 'dist/authoring.mjs'), `export const version = '${version}';`);
}

describe('Node program Engine imports', () => {
  it('resolves the public import-only SDK exports from the game installation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-program-imports-'));
    try {
      await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
      await symlink(
        resolve(import.meta.dirname, '../../../../engine'),
        resolve(root, 'node_modules/@forgeax/engine'),
        'dir',
      );
      const imports = await createNodePackProgramImports(root);
      expect(imports['@forgeax/engine/scene']?.url).toMatch(/\/engine\/dist\/facades\/scene\.mjs$/);
      expect(imports['@forgeax/engine/scene']?.identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    'build',
    'host',
  ] as const)('uses the explicitly bound Engine for native %s programs and archive restore', async (target) => {
    const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-bound-program-')));
    try {
      const root = resolve(directory, 'game');
      const workspace = resolve(directory, 'workspace');
      const installed = resolve(root, 'node_modules/@forgeax/engine');
      const bound = resolve(workspace, 'packages/engine');
      await Promise.all([writeEngine(installed, '1.0.0'), writeEngine(bound, '2.0.0')]);
      await mkdir(resolve(root, '.forgeax'), { recursive: true });
      await mkdir(resolve(root, 'assets'));
      await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
      await writeFile(resolve(workspace, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
      await writeFile(
        resolve(root, 'assets/program.mjs'),
        `import { version } from '${specifier}'; export default { apply() { return version; } };`,
      );
      await writeFile(
        resolve(root, 'assets/program.pack.json'),
        JSON.stringify({
          schemaVersion: '3.0.0',
          packageId: '01900000-0000-7000-8000-000000000320',
          assets: {
            program: { kind: 'plugin', payload: { module: { specifier: './program.mjs' } } },
          },
        }),
      );

      const sdk = await createNodePackProgramImports(root, [specifier]);
      expect(sdk[specifier]?.url).toBe(
        pathToFileURL(resolve(installed, 'dist/authoring.mjs')).href,
      );
      await writeFile(
        resolve(root, '.forgeax/engine-binding.json'),
        JSON.stringify({ schemaVersion: '1.0.0', path: workspace }),
      );
      const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
      const definition = [...inventory.assets.values()][0]?.definition;
      if (definition === undefined) throw new Error('missing fixture plugin definition');
      const compiled = await compileNodePluginPrograms(
        {
          root,
          id: 'binding',
          name: 'Binding',
          roots: { [target]: definition.guid },
          assetRoots: ['assets'],
          assetLibraries: [],
          packageJson: {},
        },
        target,
        inventory,
        resolve(directory, 'compiled'),
      );
      const { createPrograms } = await import(pathToFileURL(compiled.entry).href);
      const { imports, programs, programHost } = createPrograms('test', target, 1);
      const program = programs.values().next().value;
      expect(imports[specifier].url).toBe(pathToFileURL(resolve(bound, 'dist/authoring.mjs')).href);
      expect(imports[specifier].identity).not.toBe(sdk[specifier]?.identity);
      expect((await program.load()).apply()).toBe('2.0.0');
      const archive = await program.exportSource();
      const keys = Object.keys(archive.imports);
      await writeFile(resolve(installed, 'dist/authoring.mjs'), "export const version = '1.0.1';");
      const restored = await createNodePackProgramImports(root, keys);
      expect(restored[specifier]).toEqual(imports[specifier]);
      expect(await loadPackProgram(archive, restored, programHost)).toMatchObject({ ok: true });

      await writeFile(resolve(bound, 'dist/authoring.mjs'), "export const version = '2.0.1';");
      const changed = await createNodePackProgramImports(root, keys);
      expect(await loadPackProgram(archive, changed, programHost)).toMatchObject({ ok: false });

      await rm(resolve(bound, 'dist/authoring.mjs'));
      await expect(createNodePackProgramImports(root, [specifier])).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'build',
    'host',
  ] as const)('keeps aliased Engine modules native in %s programs', async (target) => {
    const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-aliased-program-')));
    try {
      const root = resolve(directory, 'game');
      const workspace = resolve(directory, 'workspace');
      const installed = resolve(root, 'node_modules/@forgeax/engine');
      const bound = resolve(workspace, 'packages/engine');
      const nativeModule = resolve(bound, 'dist/authoring.mjs');
      await Promise.all([writeEngine(installed, '1.0.0'), writeEngine(bound, '2.0.0')]);
      await writeFile(
        nativeModule,
        `export const token = {};
export const version = '2.0.0';
export const load = (nativeModuleSpecifier) => import(nativeModuleSpecifier);`,
      );
      await mkdir(resolve(root, '.forgeax'), { recursive: true });
      await mkdir(resolve(root, 'assets'));
      await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
      await writeFile(resolve(workspace, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
      await writeFile(
        resolve(root, '.forgeax/engine-binding.json'),
        JSON.stringify({ schemaVersion: '1.0.0', path: workspace }),
      );
      const helper = resolve(root, 'assets/helper.mjs');
      const programSource = resolve(root, 'assets/program.mjs');
      await writeFile(helper, 'export const value = 42;');
      await writeFile(
        programSource,
        `import { token, version, load } from '${specifier}';
import { value } from 'fixture:helper';
export default { token, load, apply() { return { version, value }; } };`,
      );
      await writeFile(
        resolve(root, 'assets/program.pack.json'),
        JSON.stringify({
          schemaVersion: '3.0.0',
          packageId: '01900000-0000-7000-8000-000000000321',
          assets: {
            program: { kind: 'plugin', payload: { module: { specifier: './program.mjs' } } },
          },
        }),
      );
      const resolvedAliases: string[] = [];
      const resolution = {
        resolve: {
          alias: [
            {
              find: '@forgeax/engine',
              replacement: '@forgeax/engine',
              customResolver(id: string) {
                resolvedAliases.push(id);
                return id === specifier ? nativeModule : null;
              },
            },
            {
              find: 'fixture:helper',
              replacement: 'fixture:helper',
              customResolver(id: string) {
                resolvedAliases.push(id);
                return helper;
              },
            },
          ],
        },
      };
      const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
      const definition = [...inventory.assets.values()][0]?.definition;
      if (definition === undefined) throw new Error('missing fixture plugin definition');
      const facts = {
        root,
        id: 'aliases',
        name: 'Aliases',
        roots: { [target]: definition.guid },
        assetRoots: ['assets'],
        assetLibraries: [],
        packageJson: {},
      };
      const compiled = await compileNodePluginPrograms(
        facts,
        target,
        inventory,
        resolve(directory, 'compiled'),
        resolution,
      );
      expect(resolvedAliases).toContain('fixture:helper');
      expect(resolvedAliases).not.toContain(specifier);
      const { createPrograms } = await import(pathToFileURL(compiled.entry).href);
      const { imports, programs, programHost } = createPrograms('test', target, 1);
      const program = programs.values().next().value;
      const archive = await program.exportSource();
      expect(imports[specifier].url).toBe(pathToFileURL(nativeModule).href);
      expect(
        Object.keys(archive.imports).filter((name) => name.startsWith('@forgeax/engine')),
      ).toEqual([specifier]);
      expect(Object.values(archive.modules).join('\n')).not.toContain('nativeModuleSpecifier');
      const plugin = await program.load();
      const native = await import(pathToFileURL(nativeModule).href);
      expect(plugin.token).toBe(native.token);
      expect(plugin.apply()).toEqual({ version: '2.0.0', value: 42 });
      expect((await plugin.load('node:path')).resolve).toBe(resolve);
      const restored = await createNodePackProgramImports(root, Object.keys(archive.imports));
      expect(restored).toEqual(imports);
      const loaded = await loadPackProgram(archive, restored, programHost);
      expect(loaded.unwrap()).toBe(plugin);

      const computedImport = 'export default { apply(specifier) { return import(specifier); } };';
      await writeFile(programSource, computedImport);
      const rejected = await discoverPluginAssets({ root, assetRoots: ['assets'] });
      await expect(
        compileNodePluginPrograms(
          facts,
          target,
          rejected,
          resolve(directory, 'rejected'),
          resolution,
        ),
      ).rejects.toThrow('imports must have literal specifiers');
      expect(
        preparePackProgram({
          entry: 'program-0.mjs',
          export: 'default',
          modules: { 'program-0.mjs': computedImport },
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'pack-program-invalid',
          detail: {
            module: 'program-0.mjs',
            reason: expect.stringContaining('literal specifiers'),
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
