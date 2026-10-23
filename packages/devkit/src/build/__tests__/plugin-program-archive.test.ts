import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build, normalizePath } from 'vite';
import { expect, it } from 'vitest';
import { BrowserPluginProgramArchive } from '../plugin-programs-browser.js';

it.each([
  'image',
  'public-image',
  'css',
  'worker',
  'worker-url',
] as const)('refuses a partial portable program when Vite emits a %s resource', async (kind) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-resource-')));
  try {
    await mkdir(resolve(root, 'public'));
    await writeFile(resolve(root, 'public/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(
      resolve(root, 'main.js'),
      "import plugin from './plugin.js'; globalThis.plugin = plugin;",
    );
    await writeFile(
      resolve(root, 'image.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>',
    );
    await writeFile(resolve(root, 'style.css'), 'body { color: red; }');
    await writeFile(resolve(root, 'worker.js'), 'self.onmessage = () => self.postMessage(42);');
    await writeFile(
      resolve(root, 'plugin.js'),
      {
        image: "import image from './image.svg?url'; export default { image };",
        'public-image': "import image from '/image.svg?url'; export default { image };",
        css: "import './style.css'; export default { apply() {} };",
        worker: "import Worker from './worker.js?worker'; export default () => new Worker();",
        'worker-url':
          "export default () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
      }[kind],
    );
    const archive = new BrowserPluginProgramArchive();
    archive.entries.set('plugin', resolve(root, 'plugin.js'));
    let captured: unknown;
    let failure: unknown;
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'archive-probe',
          moduleParsed() {
            archive.preserveModules(this);
          },
          generateBundle: {
            order: 'post',
            handler(_options, bundle) {
              try {
                captured = archive.capture(this, bundle, 'engine');
              } catch (cause) {
                failure = cause;
              }
            },
          },
        },
      ],
      build: {
        write: false,
        assetsInlineLimit: 0,
        minify: false,
        modulePreload: false,
        rollupOptions: { input: resolve(root, 'main.js') },
      },
    });
    expect(captured).toBeUndefined();
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain('resource requires a portable producer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('groups static closures without evaluating a sibling plugin or a lazy import', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-group-')));
  const marker = `__forgeaxGroup${Date.now()}`;
  try {
    await writeFile(resolve(root, 'shared.js'), 'export const shared = {};');
    await writeFile(resolve(root, 'leaf.js'), 'export const leaf = 42;');
    await writeFile(
      resolve(root, 'a.js'),
      `import { shared } from './shared.js'; import { leaf } from './leaf.js'; export default { shared, leaf, lazy: () => import('./lazy.js') };`,
    );
    await writeFile(resolve(root, 'b.js'), `globalThis.${marker} = 'sibling'; export default {};`);
    await writeFile(
      resolve(root, 'lazy.js'),
      `globalThis.${marker} = 'lazy'; export const value = 7;`,
    );
    await writeFile(
      resolve(root, 'main.js'),
      `import { shared } from './shared.js'; globalThis.${marker}Shared = shared;`,
    );
    const archive = new BrowserPluginProgramArchive();
    const selections = new Map([
      ['a', resolve(root, 'a.js')],
      ['b', resolve(root, 'b.js')],
    ]);
    let files: readonly string[] = [];
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'archive-group-probe',
          buildStart() {
            for (const id of selections.values())
              this.emitFile({ type: 'chunk', id, preserveSignature: 'strict' });
          },
          load(id) {
            for (const [key, entry] of selections)
              if (normalizePath(id) === normalizePath(entry)) archive.entries.set(key, entry);
          },
          moduleParsed() {
            archive.preserveModules(this);
          },
          buildEnd() {
            archive.prepareGroups(this);
          },
          outputOptions(output) {
            return archive.groupedOutput(output);
          },
          generateBundle: {
            order: 'post',
            handler(_output, bundle) {
              files = archive.entryFiles(this);
              const programs = archive.capture(this, bundle, 'engine');
              expect(Object.keys(programs)).toEqual(['a', 'b']);
              const grouped = Object.values(bundle).filter(
                (chunk) => chunk.type === 'chunk' && Object.keys(chunk.modules).length > 1,
              );
              expect(grouped.length).toBeGreaterThan(0);
            },
          },
        },
      ],
      build: {
        outDir: resolve(root, 'dist'),
        minify: false,
        modulePreload: false,
        rollupOptions: {
          input: resolve(root, 'main.js'),
          preserveEntrySignatures: 'allow-extension',
          output: { entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
        },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!output || !('output' in output)) throw Error('Missing build output');
    const main = output.output.find(
      (chunk) =>
        chunk.type === 'chunk' && chunk.facadeModuleId === normalizePath(resolve(root, 'main.js')),
    );
    if (!main) throw Error('Missing main entry');
    await import(resolve(root, 'dist', main.fileName));
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
    let selected: { shared: unknown; leaf: number; lazy(): Promise<{ value: number }> } | undefined;
    for (const file of files) {
      const chunk = output.output.find((chunk) => chunk.fileName === file);
      if (
        chunk?.type === 'chunk' &&
        chunk.facadeModuleId === normalizePath(resolve(root, 'a.js'))
      ) {
        const entry = await import(resolve(root, 'dist', file));
        expect(Object.keys(entry)).toEqual(['default']);
        selected = entry.default;
      }
    }
    if (!selected) throw Error('Missing selected plugin');
    expect(selected.shared).toBe(Reflect.get(globalThis, `${marker}Shared`));
    expect(selected.leaf).toBe(42);
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
    expect((await selected.lazy()).value).toBe(7);
    expect(Reflect.get(globalThis, marker)).toBe('lazy');
  } finally {
    Reflect.deleteProperty(globalThis, marker);
    Reflect.deleteProperty(globalThis, `${marker}Shared`);
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps single-chunk and non-ES build output policies intact', () => {
  const archive = new BrowserPluginProgramArchive();
  const normal = { format: 'es' as const };
  expect(archive.groupedOutput(normal).codeSplitting).toMatchObject({
    includeDependenciesRecursively: false,
  });
  archive.entries.set('entry', '/entry.js');
  for (const output of [
    { format: 'iife' as const },
    { format: 'cjs' as const },
    { inlineDynamicImports: true },
    { codeSplitting: false as const },
  ])
    expect(archive.groupedOutput(output)).toBe(output);
});

it('walks each parsed module once and archives the same programs as a full walk per parse', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-incremental-')));
  try {
    const width = 24;
    for (let index = 0; index < width; index++)
      await writeFile(
        resolve(root, `leaf-${index}.js`),
        `${index + 1 < width ? `import './leaf-${index + 1}.js'; ` : ''}export const value${index} = ${index};`,
      );
    await writeFile(resolve(root, 'shared.js'), "import './leaf-0.js'; export const shared = {};");
    await writeFile(
      resolve(root, 'a.js'),
      "import { shared } from './shared.js'; export default { shared, lazy: () => import('./leaf-7.js') };",
    );
    await writeFile(
      resolve(root, 'b.js'),
      "import { shared } from './shared.js'; export default { shared };",
    );
    await writeFile(resolve(root, 'main.js'), "import './shared.js';");
    const selections = new Map([
      ['a', resolve(root, 'a.js')],
      ['b', resolve(root, 'b.js')],
    ]);
    const run = async (mode: 'full' | 'incremental') => {
      const archive = new BrowserPluginProgramArchive();
      let lookups = 0;
      let programs: unknown;
      const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: `archive-${mode}-probe`,
            buildStart() {
              for (const id of selections.values())
                this.emitFile({ type: 'chunk', id, preserveSignature: 'strict' });
            },
            load(id) {
              for (const [key, entry] of selections)
                if (normalizePath(id) === normalizePath(entry)) archive.entries.set(key, entry);
            },
            moduleParsed(info) {
              const counted = new Proxy(this, {
                get: (target, key) =>
                  key === 'getModuleInfo'
                    ? (id: string) => {
                        lookups++;
                        return target.getModuleInfo(id);
                      }
                    : Reflect.get(target, key),
              });
              if (mode === 'full') archive.preserveModules(counted);
              else archive.preserveParsedModule(counted, info.id);
            },
            buildEnd() {
              if (mode === 'incremental') archive.preserveModules(this);
              archive.prepareGroups(this);
            },
            outputOptions(output) {
              return archive.groupedOutput(output);
            },
            generateBundle: {
              order: 'post',
              handler(_output, bundle) {
                programs = archive.capture(this, bundle, 'engine');
              },
            },
          },
        ],
        build: {
          write: false,
          minify: false,
          modulePreload: false,
          rollupOptions: {
            input: resolve(root, 'main.js'),
            preserveEntrySignatures: 'allow-extension',
            output: { entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
          },
        },
      });
      const output = Array.isArray(result) ? result[0] : result;
      if (!output || !('output' in output)) throw Error('Missing build output');
      const files = output.output
        .map((item) => [item.fileName, item.type === 'chunk' ? item.code : ''] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      return { lookups, programs, files };
    };
    const full = await run('full');
    const incremental = await run('incremental');
    expect(incremental.programs).toEqual(full.programs);
    expect(incremental.files).toEqual(full.files);
    // The full walk repeats per parsed module; the incremental walk does not.
    expect(incremental.lookups).toBeLessThan(full.lookups / 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
