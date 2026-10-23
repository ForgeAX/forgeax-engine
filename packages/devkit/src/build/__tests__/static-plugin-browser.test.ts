import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createRuntimePackPublication,
  type PackProgram,
  verifyPackProgram,
} from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import { chromium } from 'playwright';
import { build, createServer, type Plugin, preview, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { defined } from '../../__tests__/assert-defined.js';
import { projectToolProjection } from '../../tools/project-tools.js';
import { executionWorkerEntries } from '../execution-workers.js';
import { discoverPluginAssets } from '../plugin-assets.js';
import { pluginProgramsBuild, pluginRuntimeProjection } from '../plugin-programs.js';
import { compileNodePluginPrograms } from '../plugin-programs-node.js';
import { runtimePacksSource } from '../runtime-packs-source.js';

it.each([
  ['build', 'json'],
  ['dev', 'json'],
  ['build', 'ts'],
  ['dev', 'ts'],
] as const)(
  '%s pack.%s keeps existing static plugin, tool and page component identity without ServiceWorker in main and Worker',
  async (mode, format) => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-static-browser-')));
    const base = '/games/static/';
    let helperExports: readonly string[] = [];
    let server: Awaited<ReturnType<typeof preview>> | undefined;
    let dev: ViteDevServer | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let consumerRoot: string | undefined;
    try {
      const repository = resolve(import.meta.dirname, '../../../../..');
      await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
      await symlink(
        resolve(repository, 'packages/engine'),
        resolve(root, 'node_modules/@forgeax/engine'),
        'dir',
      );
      await mkdir(resolve(root, 'assets'));
      await writeFile(
        resolve(root, 'package.json'),
        '{"name":"static-browser","type":"module","dependencies":{"@forgeax/engine":"workspace:*"}}',
      );
      const packageId = '01900000-0000-7000-8000-000000000994';
      const guid = (key: string) =>
        AssetGuid.format(AssetGuid.derive(definePackageId(packageId), key));
      await writeFile(
        resolve(root, 'assets/shared.js'),
        `
        import { defineComponent } from '@forgeax/engine/ecs';
        export const Tag = defineComponent('StaticTag', { value: 'u32' });
        export const state = { count: 0, active: 0 };
      `,
      );
      const pluginSource = `
        import { registerAssetTools } from '@forgeax/engine/plugin';
        import { Transform } from '@forgeax/engine/scene';
        import { Tag, state } from './shared.js';
        const increment: number = 1;
        globalThis.staticPluginEvaluations = (globalThis.staticPluginEvaluations ?? 0) + 1;
        export const main = { inject: ['world', 'toolApi', 'probe'], apply(ctx) {
          ctx.probe.sameEngineToken = Transform === ctx.probe.transform;
          ctx.probe.sameProjectToken = Tag === ctx.probe.tag;
          ctx.probe.entities = [...ctx.world.query({ read: [Tag, Transform] }).unwrap()].length;
          ctx.effect(() => { state.active += increment; return () => { state.active -= increment; }; });
          ctx.effect(() => registerAssetTools(ctx));
        } };
        export const sibling = { inject: ['probe'], apply(ctx) {
          ctx.probe.sameSiblingToken = Tag === ctx.probe.tag;
          ctx.effect(() => { state.active += 10; return () => { state.active -= 10; }; });
        } };
      `;
      await writeFile(
        resolve(root, 'assets/executor.js'),
        `
        import { Tag, state } from './shared.js';
        globalThis.staticExecutorEvaluations = (globalThis.staticExecutorEvaluations ?? 0) + 1;
        export default () => ({ count: ++state.count, active: state.active, component: Tag.name });
      `,
      );
      await writeFile(
        resolve(root, 'assets/backend.js'),
        "import fs from 'node:fs'; globalThis.backendProgramEvaluated = true; export default { apply() { fs.readFileSync('backend-only'); } };",
      );
      await writeFile(
        resolve(root, 'assets/contract.js'),
        `export default { schemaVersion: '1.0.0', commands: [
        { id: 'static.run', title: 'Run', summary: '', realm: 'engine', executor: './executor.js' }
      ] };`,
      );
      const module = format === 'ts' ? './behavior.pack.ts' : './plugin.ts';
      const definitions = {
        main: {
          kind: 'plugin',
          payload: {
            module: { specifier: module, export: 'main' },
            toolContract: { specifier: './contract.js' },
            config: { sibling: { $asset: guid('sibling') } },
          },
        },
        sibling: {
          kind: 'plugin',
          payload: { module: { specifier: module, export: 'sibling' } },
        },
        backend: { kind: 'plugin', payload: { module: { specifier: './backend.js' } } },
      };
      const sourcePath = resolve(root, `assets/behavior.pack.${format}`);
      if (format === 'ts') {
        const outputs = Object.fromEntries(
          Object.entries(definitions).map(([key, value]) => [
            key,
            { kind: value.kind, ...value.payload },
          ]),
        );
        await writeFile(
          sourcePath,
          `${pluginSource}
        import { definePack, definePackageId } from '@forgeax/engine/pack/source';
        import { ok } from '@forgeax/engine/types';
        export default definePack({ schemaVersion: '2.0.0', plugins: true, packageId: definePackageId(${JSON.stringify(packageId)}), build() { return ok(${JSON.stringify(outputs)}); } });
      `,
        );
      } else {
        await writeFile(resolve(root, 'assets/plugin.ts'), pluginSource);
        await writeFile(
          sourcePath,
          JSON.stringify({ schemaVersion: '3.0.0', packageId, assets: definitions }),
        );
      }
      await writeFile(
        resolve(root, 'index.html'),
        '<script type="module" src="/main.js"></script>',
      );
      await writeFile(
        resolve(root, 'probe.js'),
        await readFile(new URL('./fixtures/static-plugin-browser.mjs', import.meta.url), 'utf8'),
      );
      await writeFile(resolve(root, 'runtime-packs.ts'), runtimePacksSource);
      await writeFile(
        resolve(root, 'restore.js'),
        await readFile(new URL('./fixtures/static-plugin-restore.mjs', import.meta.url), 'utf8'),
      );
      await writeFile(resolve(root, 'backend.json'), '{}');
      await writeFile(
        resolve(root, 'main.js'),
        `
        import { runStaticPlugins, probeNativeRouting } from './probe.js';
        import { restoreStaticPlugins } from './restore.js';
        globalThis.restoreStaticPlugins = restoreStaticPlugins;
        globalThis.probeNativeRouting = probeNativeRouting;
        import workerUrl from 'virtual:static-worker';
        async function inWorker(message) {
          const worker = new Worker(workerUrl, { type: 'module' });
          try {
            return await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('static Worker timeout')), 15000);
              worker.onmessage = e => { clearTimeout(timeout); resolve(e.data); };
              worker.onerror = e => { clearTimeout(timeout); reject(new Error(e.message)); };
              worker.postMessage(message);
            });
          } finally { worker.terminate(); }
        }
        globalThis.restoreInWorker = snapshot => inWorker({kind: 'restore', snapshot});
        globalThis.run = async () => ({main: await runStaticPlugins(), worker: await inWorker({kind: 'run'})});
      `,
      );
      await writeFile(
        resolve(root, 'worker.js'),
        `
        import { runStaticPlugins } from './probe.js';
        import { restoreStaticPlugins } from './restore.js';
        self.onmessage = ({data}) => {
          const run = data.kind === 'restore' ? restoreStaticPlugins(data.snapshot) : runStaticPlugins();
          run.then(value => self.postMessage(value), error => self.postMessage({ error: String(error), detail: error.detail }));
        };
      `,
      );
      // Discover using the existing producer; the fixture provides its exact
      // publication to both the browser asset reader and program projection.
      const initial = await discoverPluginAssets({ root, assetRoots: ['assets'] });
      const records = [...initial.assets.values()];
      const publication = createRuntimePackPublication({
        scopeId: 'static',
        packageUrl: 'https://static.invalid/behavior.pack.json',
        sourcePath,
        sourceRevision: defined(initial.sourceInputs.get(sourcePath)),
        pack: {
          assets: records.map((record) => ({
            guid: record.definition.guid,
            kind: 'plugin',
            payload: record.definition.asset,
            refs: record.refs,
            artifacts: {},
          })),
        },
        sourceKeys: new Map(records.map((record) => [record.definition.guid, record.sourceKey])),
      });
      const rows = publication.publication.outputs.map((output) => ({
        guid: output.guid,
        kind: output.kind,
        sourcePath,
        sourceKey: output.sourceKey,
        packageUrl: 'https://static.invalid/behavior.pack.json',
        publication: publication.publication,
      }));
      await writeFile(
        resolve(root, 'publication.js'),
        `export const rows = ${JSON.stringify(rows)}; export const pack = ${JSON.stringify(publication.pack)}; export const main = ${JSON.stringify(guid('main'))}; export const sibling = ${JSON.stringify(guid('sibling'))};`,
      );
      const backendInventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
      const compiled = await compileNodePluginPrograms(
        {
          root,
          id: 'static',
          name: 'Static',
          roots: { host: guid('backend') },
          assetRoots: ['assets'],
          assetLibraries: [],
          packageJson: {},
        },
        'host',
        backendInventory,
        resolve(root, '.forgeax/backend-archive'),
      );
      const backend = (await import(pathToFileURL(compiled.entry).href)).createPrograms(
        'static',
        'host',
        1,
      );
      await writeFile(
        resolve(root, 'backend.json'),
        JSON.stringify({
          target: backend.target,
          tools: [...backend.tools],
          definitions: [...backend.definitions],
          programs: await Promise.all(
            [...backend.programs].map(async ([key, entry]) => [key, await entry.exportSource()]),
          ),
        }),
      );
      const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
      const { tools } = await projectToolProjection(root, inventory);
      const workerEntry: Plugin = {
        name: 'static-worker-entry',
        resolveId: (id) => (id === 'virtual:static-worker' ? '\0static-worker' : null),
        load(id) {
          if (id !== '\0static-worker') return null;
          if (mode === 'dev')
            return `export default new URL(${JSON.stringify(`${base}worker.js`)}, location.origin).href;`;
          const ref = this.emitFile({
            type: 'chunk',
            id: resolve(root, 'worker.js'),
            preserveSignature: 'strict',
          });
          return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
        },
      };
      const config = {
        root,
        base,
        configFile: false as const,
        logLevel: 'error' as const,
        plugins: [
          executionWorkerEntries([]),
          workerEntry,
          pluginRuntimeProjection(root, inventory.sourceInputs),
          pluginProgramsBuild({
            projectRoot: root,
            roots: { engine: guid('main') },
            tools,
            inventory: async () => inventory,
            binding: createStandaloneRuntimeAssetBinding('static'),
            pack: { ready: async () => {}, catalogSnapshot: () => rows } as unknown as PluginPack,
          }),
        ],
      };
      if (mode === 'build') {
        // Match createViteConfig: shared page/Worker chunks cannot use Vite's
        // document-dependent dynamic-import preload helper.
        const output = await build({
          ...config,
          build: {
            target: 'es2022',
            modulePreload: false,
            rollupOptions: { preserveEntrySignatures: 'strict' },
          },
        });
        if (Array.isArray(output) || !('output' in output)) throw new Error('missing bundle');
        const helper = output.output.find(
          (chunk) =>
            chunk.type === 'chunk' &&
            Object.hasOwn(chunk.modules, resolve(root, 'assets/shared.js').replaceAll('\\', '/')),
        );
        if (helper?.type !== 'chunk') throw new Error('missing shared helper');
        helperExports = helper.exports;
        // Only selected exports own an addressable program chunk; interior modules
        // live in their reachability group without a re-export facade file.
        const programChunks = output.output.filter(
          (chunk) => chunk.type === 'chunk' && /^program-[0-9a-f]{16}$/.test(chunk.name),
        );
        expect(programChunks.length).toBeGreaterThan(0);
        for (const chunk of programChunks)
          expect(chunk.type === 'chunk' && chunk.facadeModuleId?.startsWith('\0')).toBe(true);
        const archivePath = (await readdir(resolve(root, 'dist'), { recursive: true })).find(
          (path) => path.endsWith('.programs.json'),
        );
        const archive = JSON.parse(
          await readFile(resolve(root, 'dist', defined(archivePath)), 'utf8'),
        ) as { programs?: Record<string, PackProgram>; error?: string };
        expect(archive.error).toBeUndefined();
        const programs = Object.values(defined(archive.programs));
        expect(programs).toHaveLength(3);
        for (const program of programs) {
          expect(verifyPackProgram(program).ok).toBe(true);
          expect(program.modules).toEqual(programs[0]?.modules);
          const code = Object.values(program.modules).join('\n');
          expect(code).not.toContain('globalThis.run');
          expect(code).not.toContain('new Worker');
          expect(code).toContain('StaticTag');
          expect(code).toContain('staticExecutorEvaluations');
          expect(Object.keys(program.imports ?? {}).sort()).toEqual([
            '@forgeax/engine/ecs',
            '@forgeax/engine/plugin',
            '@forgeax/engine/scene',
          ]);
        }
        server = await preview({
          root,
          base,
          configFile: false,
          logLevel: 'error',
          preview: { host: '127.0.0.1', port: 0 },
        });
      } else {
        dev = await createServer({
          ...config,
          server: {
            host: '127.0.0.1',
            port: 0,
            ...(process.platform === 'darwin'
              ? { watch: { usePolling: true, interval: 100 } }
              : {}),
            fs: { allow: [root, repository] },
          },
        });
        await dev.listen();
        // The candidate is broken before the old session ever imports its lazy
        // executor. Its accepted bytes must survive Vite's cache invalidation.
        await writeFile(resolve(root, 'assets/executor.js'), 'export default BROKEN CANDIDATE');
        dev.environments.client?.moduleGraph.invalidateAll();
      }
      browser = await chromium.launch({
        ...(process.env.FORGEAX_CHROME_CHANNEL !== undefined
          ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
          : {}),
        headless: true,
        args: ['--disable-gpu'],
        chromiumSandbox: true,
      });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      await page.goto(defined(defined(defined(server ?? dev).resolvedUrls).local[0]));
      await page
        .waitForFunction(() => 'run' in globalThis)
        .catch((cause) => {
          throw new Error(JSON.stringify(errors), { cause });
        });
      if (mode === 'build') {
        const archiveResponse = await page.request.get(
          new URL(
            (await readdir(resolve(root, 'dist/assets'))).find((name) =>
              name.endsWith('.programs.json'),
            ) ?? '',
            new URL('assets/', defined(defined(defined(server).resolvedUrls).local[0])),
          ).href,
        );
        const archive = await archiveResponse.json();
        const artifact = Object.values(archive.programs)[0] as PackProgram;
        const route = '**/*.programs.json';
        await page.route(route, (route) => route.fulfill({ status: 404, body: 'unavailable' }));
        const missing = await page.evaluate(
          async (artifact) =>
            (
              globalThis as unknown as {
                probeNativeRouting(program: PackProgram, missing: boolean): Promise<unknown>;
              }
            ).probeNativeRouting(artifact, true),
          artifact,
        );
        expect(missing).toEqual({
          routedNew: 'https://fallback.invalid/new.js',
          nativeError: 'TypeError: plugin program archive unavailable: 404',
          fallbackCalls: ['new.js'],
        });
        await page.unroute(route);
        const routing = await page.evaluate(
          async ({ artifact, helperExports }) => {
            try {
              return await (
                globalThis as unknown as {
                  probeNativeRouting(
                    program: PackProgram,
                    missing: boolean,
                    names: readonly string[],
                  ): Promise<unknown>;
                }
              ).probeNativeRouting(artifact, false, helperExports);
            } catch (error) {
              throw new Error(JSON.stringify(error));
            }
          },
          { artifact, helperExports },
        );
        expect(routing).toMatchObject({
          routedNew: 'https://fallback.invalid/new.js',
          sameHelper: true,
          modified: Array(4).fill('https://fallback.invalid/new.js'),
          fallbackCalls: ['new.js', artifact.entry, artifact.entry, artifact.entry, artifact.entry],
        });
        expect((routing as { nativeUrl: string }).nativeUrl).toBe(
          new URL(artifact.entry, defined(defined(defined(server).resolvedUrls).local[0])).href,
        );
      }
      const value = await page.evaluate(async () => {
        try {
          return await (globalThis as unknown as { run(): Promise<unknown> }).run();
        } catch (error) {
          throw new Error(JSON.stringify(error));
        }
      });
      const expected = {
        lazyDefinition: true,
        exported: 3,
        lazyExecutor: true,
        sameEngineToken: true,
        sameProjectToken: true,
        sameSiblingToken: true,
        entityCount: 1,
        result: { count: 1, active: 11, component: 'StaticTag' },
        afterSibling: { count: 2, active: 1, component: 'StaticTag' },
        retired: 'failed',
        active: 0,
        programCount: 3,
        definitionCount: 3,
        backendExecutable: false,
        ...{
          restored: {
            sameProjectToken: true,
            sameEngineToken: true,
            sameSiblingToken: true,
            entityCount: 1,
            result: { count: 3, active: 11, component: 'StaticTag' },
            catalogCount: 3,
            backendExecutable: false,
            lazyRestore: true,
            beforeMount: { plugin: 1, executor: 1 },
            savedTargets: ['engine', 'host'],
          },
        },
      };
      expect(value).toEqual({ main: expected, worker: expected });
      expect(errors).toEqual([]);
      expect(context.serviceWorkers()).toEqual([]);
      if (mode === 'build') {
        const snapshot = await page.evaluate(
          () => (globalThis as unknown as { staticSnapshot: unknown }).staticSnapshot,
        );
        consumerRoot = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-static-consumer-')));
        await cp(resolve(root, 'dist'), resolve(consumerRoot, 'dist'), { recursive: true });
        await writeFile(resolve(consumerRoot, 'saved-pack.json'), JSON.stringify(snapshot));
        const originalUrl = defined(defined(defined(server).resolvedUrls).local[0]);
        const originalServer = defined(server);
        await browser.close();
        // Start another static delivery origin while the old one still owns its
        // port, then remove all author input and Node producer output.
        server = await preview({
          root: consumerRoot,
          base,
          configFile: false,
          logLevel: 'error',
          preview: { host: '127.0.0.1', port: 0 },
        });
        await new Promise<void>((done) => originalServer.httpServer.close(() => done()));
        await rm(root, { recursive: true, force: true });
        const consumerUrl = defined(defined(server.resolvedUrls).local[0]);
        expect(consumerUrl).not.toBe(originalUrl);
        browser = await chromium.launch({
          ...(process.env.FORGEAX_CHROME_CHANNEL !== undefined
            ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
            : {}),
          headless: true,
          args: ['--disable-gpu'],
          chromiumSandbox: true,
        });
        const coldContext = await browser.newContext({ serviceWorkers: 'block' });
        const coldPage = await coldContext.newPage();
        const coldErrors: string[] = [];
        const coldRequests: string[] = [];
        coldPage.on('pageerror', (error) => coldErrors.push(error.message));
        coldContext.on('request', (request) => coldRequests.push(request.url()));
        await coldPage.goto(consumerUrl);
        await coldPage.waitForFunction(() => 'restoreStaticPlugins' in globalThis);
        expect(await coldPage.evaluate(() => caches.keys())).toEqual([]);
        const saved = JSON.parse(await readFile(resolve(consumerRoot, 'saved-pack.json'), 'utf8'));
        const cold = await coldPage.evaluate(async (snapshot) => {
          try {
            const fixture = globalThis as unknown as {
              restoreStaticPlugins(snapshot: unknown): Promise<unknown>;
              restoreInWorker(snapshot: unknown): Promise<unknown>;
            };
            return {
              main: await fixture.restoreStaticPlugins(snapshot),
              worker: await fixture.restoreInWorker(snapshot),
            };
          } catch (cause) {
            throw new Error(JSON.stringify(cause));
          }
        }, saved);
        const coldExpected = {
          ...expected.restored,
          beforeMount: { plugin: 0, executor: 0 },
          result: { count: 1, active: 11, component: 'StaticTag' },
        };
        expect(cold).toEqual({ main: coldExpected, worker: coldExpected });
        expect(coldErrors).toEqual([]);
        expect(
          coldRequests.every((url) => new URL(url).origin === new URL(consumerUrl).origin),
        ).toBe(true);
        expect(coldContext.serviceWorkers()).toEqual([]);
      }
    } finally {
      await browser?.close();
      await dev?.close();
      await new Promise<void>((done) => (server ? server.httpServer.close(() => done()) : done()));
      await rm(root, { recursive: true, force: true });
      if (consumerRoot) await rm(consumerRoot, { recursive: true, force: true });
    }
  },
  60000,
);
