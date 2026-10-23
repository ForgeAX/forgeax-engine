import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { commandContribution } from '@forgeax/engine-tool-runtime';
import { build, createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPluginSourceInputs,
  discoverPluginAssets,
  type PluginSourceRecord,
  publishedPluginInventory,
} from '../build/plugin-assets.js';
import {
  assertStaticPluginImports,
  pluginProgramSource,
  pluginRuntimeProjection,
  projectPluginPrograms,
  projectPluginRuntimeSource,
} from '../build/plugin-programs.js';
import { compileNodePluginPrograms } from '../build/plugin-programs-node.js';
import { projectToolProjection } from '../tools/project-tools.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const source = `import { definePack as pack } from '@forgeax/engine/pack/source';
export const token = Symbol('shared');
export const first = { apply() { return token; } };
export const second = { apply() { return token; } };
export default pack({ build: async () => { const compiler = await import('node:fs'); return compiler; } });`;
function record(module: string, name: string): PluginSourceRecord {
  return {
    module,
    export: name,
    sourcePath: module,
    sourceKey: name,
    refs: [],
    source: { kind: 'plugin', module: { specifier: module, export: name } },
    definition: {
      guid: name,
      asset: { kind: 'plugin', program: `project:source.pack.ts#${name}` },
      evidence: { kind: 'source', revision: 'one', digest: 'one' },
    },
  };
}

async function distHostFixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-dist-host-')));
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-dist-host-output-'));
  roots.push(root, temporary);
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(
    resolve(import.meta.dirname, '../../../engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'dir',
  );
  await mkdir(resolve(root, 'dist'));
  await writeFile(
    resolve(root, 'package.json'),
    JSON.stringify({
      name: 'host-fixture',
      type: 'module',
      exports: { './executor': './dist/executor.mjs' },
    }),
  );
  const packageId = '01900000-0000-7000-8000-000000000322';
  const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
  const sourcePath = resolve(root, 'host.pack.json');
  await writeFile(
    sourcePath,
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId,
      assets: {
        behavior: {
          kind: 'plugin',
          payload: {
            module: { specifier: './dist/plugin.mjs' },
            toolContract: { specifier: './dist/commands.mjs' },
          },
        },
      },
    }),
  );
  const files = {
    'plugin.mjs': `import { Transform } from '@forgeax/engine/scene';
      import { state } from './shared.mjs';
      globalThis.distPluginEvaluated = true;
      export default { apply(ctx) { state.value = 41; ctx.probe.sameToken = ctx.probe.expected === Transform; } };`,
    'shared.mjs': 'export const state = { value: 0 };',
    'commands.mjs': `import { title } from './command-title.mjs';
      export default { schemaVersion: '1.0.0', commands: [{
        id: 'dist.run', title, summary: '', realm: 'host', executor: 'host-fixture/executor'
      }] };`,
    'command-title.mjs': 'export const title = "Run dist tool";',
    'executor.mjs': `import { state } from './shared.mjs';
      globalThis.distExecutorEvaluated = true;
      export default async () => ++state.value + (await import('./lazy.mjs')).extra;`,
    'lazy.mjs': 'export const extra = 1;',
    'unrelated.mjs': 'throw new Error("unrelated output must not be consumed");',
  };
  for (const [name, source] of Object.entries(files))
    await writeFile(resolve(root, 'dist', name), source);
  const facts = {
    root,
    id: 'dist-host',
    name: 'Dist Host',
    roots: { host: guid },
    assetRoots: ['host.pack.json'],
    assetLibraries: [],
    packageJson: {},
  };
  return { root, temporary, facts, sourcePath, files };
}
describe('plugin program projection', () => {
  it('fences imported WGSL bytes while ignoring unrelated shader additions', async () => {
    const { root, facts } = await distHostFixture();
    const shader = resolve(root, 'surface.wgsl');
    await writeFile(shader, '#define_import_path fixture::surface\nconst value = 1.0;\n');
    await appendFile(resolve(root, 'dist/plugin.mjs'), "\nimport '../surface.wgsl?raw';\n");
    const initial = await discoverPluginAssets(facts);
    const path = await realpath(shader);
    const revision = `sha256:${createHash('sha256')
      .update(await readFile(shader))
      .digest('hex')}`;
    expect(initial.sourceInputs.get(path)).toBe(revision);
    await writeFile(shader, '#define_import_path fixture::surface\nconst value = 2.0;\n');
    await expect(assertPluginSourceInputs(initial, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: { cause: { reason: 'source changed during plugin compilation' } },
    });
    expect(initial.sourceInputs.get(path)).toBe(revision);
    const current = await discoverPluginAssets(facts);
    expect(current.sourceInputs.get(path)).not.toBe(revision);
    await writeFile(resolve(root, 'added.wgsl'), '#define_import_path fixture::added\n');
    await expect(assertPluginSourceInputs(current, root)).resolves.toBeUndefined();
  });

  it.each([
    ['./dist/runtime.js', 'dist/runtime.ts'],
    ['./dist/runtime', 'dist/runtime/index.ts'],
  ])('defers %s file selection to the actual compiler', async (specifier, filename) => {
    const { root, facts, temporary, sourcePath } = await distHostFixture();
    const source = JSON.parse(await readFile(sourcePath, 'utf8'));
    source.assets.behavior.payload.module.specifier = specifier;
    await writeFile(sourcePath, JSON.stringify(source));
    const path = resolve(root, filename);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'export default { apply() {} };');
    const inventory = await discoverPluginAssets(facts);
    await compileNodePluginPrograms(facts, 'host', inventory, temporary);
    expect(inventory.sourceInputs.has(path)).toBe(true);
  });

  it('does not choose a build environment during source discovery', async () => {
    const { root, facts } = await distHostFixture();
    const environment = { ...process.env };
    delete environment.NODE_ENV;
    const module = pathToFileURL(resolve(import.meta.dirname, '../build/plugin-assets.ts')).href;
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      // Node executes owner sources directly; preserve TypeScript's relative .js resolution.
      const owner = new URL('../', ${JSON.stringify(module)}).href;
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(owner) && specifier.startsWith('.') && specifier.endsWith('.js'))
          return nextResolve(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context);
        return nextResolve(specifier, context);
      } });
      const { discoverPluginAssets } = await import(${JSON.stringify(module)});
      assert.equal(process.env.NODE_ENV, undefined);
      await discoverPluginAssets(${JSON.stringify(facts)});
      assert.equal(process.env.NODE_ENV, undefined);
      const { resolveConfig } = await import(${JSON.stringify(import.meta.resolve('vite'))});
      const config = await resolveConfig({ root: ${JSON.stringify(root)}, configFile: false, envFile: false }, 'build', 'production', 'production');
      assert.equal(config.isProduction, true);
      console.log('environment-preserved');
    `,
      ],
      { cwd: root, env: environment },
    );
    expect(result.stdout).toContain('environment-preserved');
  });

  it('fences the actual JS graph including self-package and package-import edges', async () => {
    const { root, facts, temporary } = await distHostFixture();
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({
        name: 'host-fixture',
        type: 'module',
        exports: {
          './executor': './dist/executor.mjs',
          './state': { browser: './dist/browser-state.mjs', default: './dist/node-state.mjs' },
        },
        imports: {
          '#shared': './dist/shared.mjs',
          '#mode': { development: './dist/development.mjs', production: './dist/production.mjs' },
        },
      }),
    );
    await writeFile(
      resolve(root, 'dist/shared.mts'),
      'throw new Error("author sibling is not the selected runtime file");',
    );
    await writeFile(resolve(root, 'dist/node-state.mjs'), 'export { state } from "#shared";');
    await writeFile(resolve(root, 'dist/browser-state.mjs'), 'export { state } from "#shared";');
    await writeFile(resolve(root, 'dist/development.mjs'), 'export const value = 40;');
    await writeFile(resolve(root, 'dist/production.mjs'), 'export const value = 41;');
    await writeFile(
      resolve(root, 'dist/plugin.mjs'),
      `import { state } from 'host-fixture/state'; import { value } from '#mode'; export default { apply() { state.value = value; } };`,
    );
    const inventory = await discoverPluginAssets(facts);
    await compileNodePluginPrograms(facts, 'host', inventory, temporary, {
      plugins: [
        {
          name: 'fixture:production-node',
          config: () => ({ ssr: { resolve: { conditions: ['node', 'production'] } } }),
        },
      ],
    });
    for (const name of ['shared.mjs', 'production.mjs', 'node-state.mjs'])
      expect(inventory.sourceInputs.has(resolve(root, 'dist', name)), name).toBe(true);
    expect(inventory.sourceInputs.has(resolve(root, 'dist/browser-state.mjs'))).toBe(false);
    expect(inventory.sourceInputs.has(resolve(root, 'dist/development.mjs'))).toBe(false);
    await compileNodePluginPrograms(facts, 'host', inventory, temporary, {
      plugins: [
        {
          name: 'fixture:development-browser',
          config: () => ({ ssr: { resolve: { conditions: ['browser', 'development'] } } }),
        },
      ],
    });
    expect(inventory.sourceInputs.has(resolve(root, 'dist/browser-state.mjs'))).toBe(true);
    expect(inventory.sourceInputs.has(resolve(root, 'dist/development.mjs'))).toBe(true);
    expect(inventory.sourceInputs.has(resolve(root, 'dist/shared.mts'))).toBe(false);
  });

  it('compiles declared dist Host Pack programs and self-package tool executors without eager runtime execution', async () => {
    const fixture = await distHostFixture();
    const { root, facts, temporary } = fixture;
    const inventory = await discoverPluginAssets(facts);
    const compiled = await compileNodePluginPrograms(facts, 'host', inventory, temporary);
    expect(Reflect.get(globalThis, 'distPluginEvaluated')).toBeUndefined();
    expect(Reflect.get(globalThis, 'distExecutorEvaluated')).toBeUndefined();
    for (const name of Object.keys(fixture.files).filter((name) => name !== 'unrelated.mjs'))
      expect(inventory.sourceInputs.has(resolve(root, 'dist', name)), name).toBe(true);
    expect(inventory.sourceInputs.has(resolve(root, 'dist/unrelated.mjs'))).toBe(false);
    await writeFile(resolve(root, 'dist/unrelated.mjs'), 'export const output = 2;');
    await expect(assertPluginSourceInputs(inventory, root)).resolves.toBeUndefined();
    // A new process proves native Engine identity and one shared plugin/executor graph.
    await writeFile(
      resolve(root, 'probe.mjs'),
      `
      import assert from 'node:assert/strict';
      import { Context } from '@forgeax/engine/plugin';
      import { Transform } from '@forgeax/engine/scene';
        import { createPrograms } from ${JSON.stringify(pathToFileURL(compiled.entry).href)};
      const programs = createPrograms('test', 'host', 1).programs;
      assert.equal(globalThis.distPluginEvaluated, undefined);
      assert.equal(globalThis.distExecutorEvaluated, undefined);
      const context = new Context(); const probe = { expected: Transform }; context.provide('probe', probe);
      const fiber = await context.plugin(await programs.get('project:dist/plugin.mjs#default').load());
      await fiber.await(); assert.equal(probe.sameToken, true);
      assert.equal(await (await programs.get('npm:host-fixture/executor#default').load())(), 43);
      await context.fiber.dispose(); console.log('dist-host-pass');
    `,
    );
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve(import.meta.dirname, 'fixtures/cli-owner-imports.mjs')).href,
        resolve(root, 'probe.mjs'),
      ],
      { cwd: root },
    );
    expect(result.stdout).toContain('dist-host-pass');
  });

  it.each([
    'shared.mjs',
    'command-title.mjs',
    'lazy.mjs',
  ])('keeps declared dist %s frozen across repeated tool projection and compilation', async (name) => {
    const { root, facts, temporary } = await distHostFixture();
    const inventory = await discoverPluginAssets(facts);
    await projectToolProjection(root, inventory);
    await compileNodePluginPrograms(facts, 'host', inventory, temporary);
    const path = resolve(root, 'dist', name);
    const frozen = inventory.sourceInputs.get(path);
    expect(frozen).toBeTypeOf('string');
    await writeFile(path, 'throw new Error("changed frozen program");');
    await expect(
      compileNodePluginPrograms(facts, 'host', inventory, temporary),
    ).rejects.toMatchObject({ code: 'plugin-bootstrap-failed' });
    expect(inventory.sourceInputs.get(path)).toBe(frozen);
  });

  it('captures declared dist programs for plugins first discovered in ordinary publication', async () => {
    const { root, facts, temporary } = await distHostFixture();
    const discovered = await discoverPluginAssets(facts);
    const bootstrap = {
      ...discovered,
      assets: new Map(),
    };
    const published = await publishedPluginInventory(root, bootstrap, {
      readPluginDefinitions: async () =>
        [...discovered.assets.values()].map(({ definition, sourcePath, refs }) => ({
          definition,
          sourcePath,
          refs,
        })),
    });
    await projectToolProjection(root, published);
    await compileNodePluginPrograms(facts, 'host', published, temporary);
    expect(published.sourceInputs.has(resolve(root, 'dist/plugin.mjs'))).toBe(true);
    expect(published.sourceInputs.has(resolve(root, 'dist/shared.mjs'))).toBe(true);
  });
  it('lowers a same-Pack tool export through the same runtime projection and rejects conflicting program keys', () => {
    const projectRoot = resolve('/project');
    const module = resolve(projectRoot, 'assets/source.pack.ts');
    const first = record(module, 'first');
    const second = record(module, 'second');
    const records = [first, second].map((item) => ({
      ...item,
      definition: {
        ...item.definition,
        asset: {
          ...item.definition.asset,
          program: `project:assets/source.pack.ts#${item.export}`,
        },
      },
    }));
    const declaration = {
      id: 'test.run',
      title: 'Run',
      summary: '',
      realm: 'engine' as const,
      executor: './source.pack.ts',
      exportName: 'second',
    };
    const tool = {
      assetGuid: 'first',
      declaration,
      realm: 'engine' as const,
      moduleName: resolve(projectRoot, 'assets/contract.ts'),
      executor: module,
      sourceRevision: 'one',
      contractDigest: 'one',
      contribution: commandContribution(declaration),
    };
    const projection = projectPluginPrograms(records, 'engine', [tool], projectRoot);
    expect(projection.programs.size).toBe(2);
    expect(projection.programs.get('project:assets/source.pack.ts#second')).toEqual({
      module: `${module}?forgeax-plugin-runtime`,
      export: 'second',
    });
    expect(projection.tools.get('first')?.commands[0]).toMatchObject({
      executor: 'project:assets/source.pack.ts#second',
    });
    expect(projection.tools.get('first')?.commands[0]?.exportName).toBeUndefined();
    expect(projection.tools.get('second')?.commands).toEqual([]);
    expect(() =>
      projectPluginPrograms(
        [first, { ...first, module: '/project/assets/other.pack.ts' }],
        'engine',
        [],
        '/project',
      ),
    ).toThrow('conflicting delivered program');
    expect(() =>
      projectPluginPrograms(
        records,
        'engine',
        [{ ...tool, declaration: { ...declaration, exportName: 'default' } }],
        '/project',
      ),
    ).toThrow('requires a named export');
  });

  it('compiled Node plugins share component tokens with the installed Host realm', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-native-'));
    const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-compiled-'));
    roots.push(root, temporary);
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(import.meta.dirname, '../../../engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await mkdir(resolve(root, 'assets'));
    const packageId = '01900000-0000-7000-8000-000000000321';
    const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
    await writeFile(
      resolve(root, 'assets/behavior.mjs'),
      `
      import { Transform } from '@forgeax/engine/scene';
      export default { inject: ['world', 'probe'], apply(ctx) {
        ctx.probe.sameToken = ctx.probe.expected === Transform;
        ctx.probe.entities = [...ctx.world.query({ read: [Transform] }).unwrap()].length;
      } };`,
    );
    await writeFile(
      resolve(root, 'assets/foreign.mjs'),
      "import 'browser-only-not-installed'; export default { apply() {} };",
    );
    await writeFile(
      resolve(root, 'assets/behavior.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: {
          behavior: { kind: 'plugin', payload: { module: { specifier: './behavior.mjs' } } },
          foreign: { kind: 'plugin', payload: { module: { specifier: './foreign.mjs' } } },
        },
      }),
    );
    const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
    const compiled = await compileNodePluginPrograms(
      {
        root,
        id: 'native-test',
        name: 'Native test',
        roots: { host: guid },
        assetRoots: ['assets'],
        assetLibraries: [],
        packageJson: {},
      },
      'host',
      inventory,
      temporary,
    );
    await writeFile(
      resolve(root, 'probe.mjs'),
      `
      import assert from 'node:assert/strict';
      import { World, createWorldContext } from '@forgeax/engine/ecs';
      import { Transform, scenePlugin } from '@forgeax/engine/scene';
        import { createPrograms } from ${JSON.stringify(pathToFileURL(compiled.entry).href)};
      const world = new World();
      const context = await createWorldContext(world, [scenePlugin()]);
      world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();
      const probe = { expected: Transform }; context.provide('probe', probe);
      const delivered = createPrograms('test', 'host', 1);
      assert.equal(delivered.programs.size, 1); assert.equal(delivered.tools.size, 1);
      const program = [...delivered.programs.values()][0];
      const fiber = await context.plugin(await program.load()); await fiber.await();
      assert.equal(probe.sameToken, true); assert.equal(probe.entities, 1);
      await context.fiber.dispose(); console.log('native-token-pass');
    `,
    );
    const result = await promisify(execFile)(process.execPath, [resolve(root, 'probe.mjs')], {
      cwd: root,
    });
    expect(result.stdout).toContain('native-token-pass');
  });
  it('fences author files while allowing disposable asset cache updates', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-inputs-'));
    roots.push(root);
    await mkdir(resolve(root, 'assets'));
    await mkdir(resolve(root, '.assetlib'));
    const author = resolve(root, 'assets/helper.ts');
    const cache = resolve(root, '.assetlib/catalog.json');
    await writeFile(author, 'export const speed = 1;');
    await writeFile(cache, '{"generation":1}');
    const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
    await inventory.sourceSnapshot.inventory(author);
    await writeFile(cache, '{"generation":2}');
    await expect(assertPluginSourceInputs(inventory, root)).resolves.toBeUndefined();
    await writeFile(author, 'export const speed = 2;');
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: { sourcePath: await realpath(author) },
    });
  });
  it('treats a symlinked project root as the same plugin source inventory', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-root-alias-'));
    roots.push(parent);
    const project = resolve(parent, 'project');
    const alias = resolve(parent, 'alias');
    await mkdir(resolve(project, 'assets'), { recursive: true });
    const root = await realpath(project);
    await writeFile(resolve(root, 'assets/view.ts'), 'export default { apply() {} };');
    await writeFile(
      resolve(root, 'assets/view.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '019fb7ce-3a00-7000-8000-000000000000',
        assets: {
          'plugin/view': { kind: 'plugin', payload: { module: { specifier: './view.ts' } } },
        },
      }),
    );
    await symlink(root, alias, 'dir');
    const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
    await expect(assertPluginSourceInputs(inventory, alias)).resolves.toBeUndefined();
  });
  it('resolves generated virtual imports in a fresh external consumer process', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-consumer-'));
    roots.push(root);
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(import.meta.dirname, '../../../engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await writeFile(
      resolve(root, 'entry.js'),
      'import { createPrograms } from "virtual:programs"; globalThis.probe = createPrograms("test", "host", 1);',
    );
    const code = pluginProgramSource([], 'host', []);
    await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { build } from ${JSON.stringify(import.meta.resolve('vite'))};
        await build({ configFile: false, logLevel: 'silent', plugins: [{
          name: 'consumer-programs',
          resolveId: id => id === 'virtual:programs' ? '\\0virtual:programs' : null,
          load: id => id === '\\0virtual:programs' ? ${JSON.stringify(code)} : null,
        }], build: { write: false, rollupOptions: { input: 'entry.js' } } });`,
      ],
      { cwd: root },
    );
  });
  it('removes only the recognized Pack declaration and rejects unknown dynamic specifiers', () => {
    const projected = projectPluginRuntimeSource(source, 'source.pack.ts').code;
    expect(projected).toContain('export const first');
    expect(projected).not.toContain("import('node:fs')");
    expect(() => assertStaticPluginImports(projected, 'source.pack.ts')).not.toThrow();
    expect(() =>
      assertStaticPluginImports('export const load = name => import(name)', 'bad.ts'),
    ).toThrow('literal');
    expect(() => projectPluginRuntimeSource('export default other({})', 'bad.pack.ts')).toThrow(
      'definePack',
    );
  });
  it('refuses changed lazy modules in an existing Vite session', async () => {
    const root = await mkdtemp(resolve(import.meta.dirname, '../..', '.program-snapshot-'));
    roots.push(root);
    const path = resolve(root, 'plugin.ts');
    const original = 'export default { apply() { return 1; } };';
    await writeFile(path, original);
    const inputs = new Map([
      [path, `sha256:${createHash('sha256').update(original).digest('hex')}`],
    ]);
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true },
      plugins: [pluginRuntimeProjection(root, inputs)],
    });
    try {
      expect((await server.transformRequest('/plugin.ts'))?.code).toContain('return 1');
      const changed = 'export default { apply() { return 2; } };';
      await writeFile(path, changed);
      // A caller cannot rebind an accepted session by mutating the source map.
      inputs.set(path, `sha256:${createHash('sha256').update(changed).digest('hex')}`);
      server.moduleGraph.invalidateAll();
      await expect(server.transformRequest('/plugin.ts')).rejects.toThrow('source changed');
    } finally {
      await server.close();
    }
  });
  it('bundles same-file exports with only the public SDK dependency and rejects missing exports', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-program-'));
    roots.push(root);
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(import.meta.dirname, '../../../engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await mkdir(resolve(root, 'assets'));
    const module = resolve(root, 'assets/source.pack.ts');
    await writeFile(module, source);
    const entry = resolve(root, 'entry.ts');
    const virtual = 'virtual:forgeax/plugin-programs/engine';
    let programSource = pluginProgramSource(
      [record(module, 'first'), record(module, 'second')],
      'engine',
      [],
    );
    await writeFile(
      entry,
      `import { createPrograms } from '${virtual}';
      globalThis.probe = createPrograms("test", "engine", 1);`,
    );
    const config = {
      root,
      configFile: false as const,
      logLevel: 'silent' as const,
      plugins: [
        pluginRuntimeProjection(),
        {
          name: 'program-fixture',
          resolveId: (id: string) => (id === virtual ? `\0${virtual}` : null),
          load: (id: string) => (id === `\0${virtual}` ? programSource : null),
        },
      ],
      build: {
        write: false,
        minify: false as const,
        rollupOptions: { input: entry },
        target: 'esnext',
      },
    };
    const result = await build(config);
    const output = !Array.isArray(result) && 'output' in result ? result.output : [];
    const chunks = output.flatMap((item) => (item.type === 'chunk' ? [item] : []));
    expect(
      chunks.filter((chunk) =>
        Object.keys(chunk.modules).includes(`${module}?forgeax-plugin-runtime`),
      ),
    ).toHaveLength(1);
    expect(chunks.map((chunk) => chunk.code).join('\n')).not.toContain('node:fs');
    programSource = pluginProgramSource([record(module, 'missing')], 'engine', []);
    await expect(build(config)).rejects.toThrow(/missing/);
  });
});

describe('published plugin entry', () => {
  it('bundles native Context through browser and Worker package conditions', async () => {
    const root = await mkdtemp(resolve(import.meta.dirname, '../..', '.browser-entry-'));
    roots.push(root);
    await writeFile(resolve(root, 'index.html'), '<script type="module" src="/main.ts"></script>');
    await writeFile(
      resolve(root, 'main.ts'),
      `import { Context } from '@forgeax/engine-plugin';
      globalThis.context = new Context(); globalThis.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });`,
    );
    await writeFile(
      resolve(root, 'worker.ts'),
      `import { Context } from '@forgeax/engine-plugin'; postMessage(new Context().fiber.uid);`,
    );
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      build: { write: false, minify: false },
      worker: { format: 'es' },
    });
    const output = !Array.isArray(result) && 'output' in result ? result.output : [];
    expect(output.some((entry) => entry.fileName.includes('worker'))).toBe(true);
  });
});
