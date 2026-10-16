// @perf-budget-skip: prepares the ordinary game project and its native program publication.
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { RuntimePackOptions } from '@forgeax/engine-app';
import * as pack from '@forgeax/engine-pack/runtime';
import * as browserPack from '@forgeax/engine-pack/runtime-browser';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { createViteConfig } from '../../host.js';
import { readProjectFacts } from '../../project.js';
import { pluginProgramSource } from '../plugin-programs.js';

it('loads the ordinary packaged vase program without an HTTP or ServiceWorker host', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-tauri-program-'));
  const repository = resolve(import.meta.dirname, '../../../../..');
  try {
    await cp(resolve(repository, 'templates/game-3d'), root, {
      recursive: true,
      filter: (path) => !['node_modules', '.forgeax'].includes(basename(path)),
    });
    await symlink(resolve(repository, 'node_modules'), resolve(root, 'node_modules'), 'dir');
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    await createViteConfig(facts.value, 'build', './', { target: 'tauri' });
    const source = await readFile(resolve(root, '.forgeax/generated/runtime-packs.ts'), 'utf8');
    const imports = Object.fromEntries(
      ['@forgeax/engine/geometry', '@forgeax/engine/pack/source'].map((name) => [
        name,
        { identity: `test:${name}`, url: `tauri://localhost/${name}.mjs` },
      ]),
    );
    const nativeRequire = createRequire(resolve(root, 'package.json'));
    const exports = {} as {
      createRuntimePackOptions(scopeId: string): Promise<RuntimePackOptions>;
    };
    runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText,
      {
        exports,
        require: (name: string) => {
          if (name === '@forgeax/engine/pack/runtime') return pack;
          if (name === '@forgeax/engine/pack/runtime-browser') return browserPack;
          if (name === 'virtual:forgeax/pack-program-imports')
            return { __esModule: true, default: imports };
          return nativeRequire(name);
        },
      },
    );
    const options = await exports.createRuntimePackOptions('tauri-test');
    expect(options.imports).toEqual(imports);
    const providerExports = {} as {
      createPrograms(
        session: string,
        context: string,
        generation: number,
        host: unknown,
      ): {
        programHost: pack.PackProgramHost;
      };
    };
    // The production bootstrap composes the native runtime host with the
    // delivered plugin host. Preserve that composition in this regression.
    const providerSource = pluginProgramSource([], 'engine', [], [], root, '.programs.json')
      .replace('"__forgeax_native_program_entries__"', '["delivered-plugin.mjs"]')
      .replace('import.meta.url', '"tauri://localhost/assets/plugins.js"');
    runInNewContext(
      ts.transpileModule(providerSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText,
      {
        exports: providerExports,
        URL,
        fetch: () => {
          throw new Error('A native runtime program must not fetch the unrelated plugin archive');
        },
        require: (name: string) => {
          if (name === '@forgeax/engine/pack/runtime') return pack;
          if (name === 'virtual:forgeax/pack-program-imports')
            return { __esModule: true, default: imports };
          return nativeRequire(name);
        },
      },
    );
    const composed = providerExports.createPrograms('test', 'engine', 1, options.programHost);
    const programSource = await readFile(
      resolve(root, 'assets/runtime-vase/vase.program.mjs'),
      'utf8',
    );
    const prepare = (source: string) =>
      pack
        .preparePackProgram({
          entry: 'vase.program.mjs',
          export: 'build',
          imports: Object.fromEntries(
            Object.entries(imports).map(([name, value]) => [name, value.identity]),
          ),
          modules: { 'vase.program.mjs': source },
        })
        .unwrap();
    const loaded = await pack.loadPackProgram(
      prepare(programSource),
      options.imports,
      composed.programHost,
    );
    expect(loaded.ok ? typeof loaded.value : loaded.error).toBe('function');
    expect(
      (
        await pack.loadPackProgram(
          prepare(`${programSource}\n`),
          options.imports,
          composed.programHost,
        )
      ).ok,
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('imports a delivered plugin through its own URL when composed with a native package loader', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-native-program-composition-'));
  const fallback = {
    publish: vi.fn(),
    importModule: vi.fn(() => {
      throw new Error('The fallback does not own delivered plugin URLs');
    }),
  };
  const nativeSource = 'export default { ready: true };';
  const program = pack
    .preparePackProgram({
      entry: 'delivered-plugin.mjs',
      export: 'default',
      modules: { 'delivered-plugin.mjs': nativeSource },
    })
    .unwrap();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        imports: {},
        programs: { delivered: program },
        urls: { 'delivered-plugin.mjs': './delivered-plugin.mjs' },
      }),
    ),
  );
  try {
    await writeFile(resolve(root, 'delivered-plugin.mjs'), nativeSource);
    const providerSource = pluginProgramSource([], 'engine', [], [], root, '.programs.json')
      .replace('"__forgeax_native_program_entries__"', '["delivered-plugin.mjs"]')
      .replace(
        "'@forgeax/engine/pack/runtime'",
        JSON.stringify(import.meta.resolve('@forgeax/engine-pack/runtime')),
      )
      .replace(
        "'virtual:forgeax/pack-program-imports'",
        "'data:text/javascript,export default {}'",
      );
    await writeFile(resolve(root, 'provider.mjs'), providerSource);
    const provider = await import(pathToFileURL(resolve(root, 'provider.mjs')).href);
    const host = provider.createPrograms('test', 'engine', 1, fallback).programHost;
    const loaded = await pack.loadPackProgram(program, {}, host);
    expect(loaded.ok ? loaded.value : loaded.error).toEqual({ ready: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fallback.publish).not.toHaveBeenCalled();
    expect(fallback.importModule).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
