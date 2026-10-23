// @perf-budget-skip: intentional standalone Vite and ScriptablePack composition integration gate.
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { assembleAssetRuntime, assembleRuntimePacks } from '@forgeax/engine-app';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { FixedTime, Time, World } from '@forgeax/engine-ecs';
import { decodeCatalogWire, type RuntimeCatalogWire } from '@forgeax/engine-pack';
import { BUILTIN_MESH_ASSETS } from '@forgeax/engine-pack/builtin';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { Context } from '@forgeax/engine-plugin';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { RUNTIME_CATALOG_SNAPSHOT_SCHEMA } from '@forgeax/engine-types';
import { transformWithOxc } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverPluginAssets } from '../build/plugin-assets.js';
import { createViteConfig, devKitDdcRoots, ignoreDevKitCatalogPath } from '../host.js';
import { readLiveProjectInputs } from '../live-project-inputs.js';
import { readProjectFacts } from '../project.js';
import { generatedPlayerQueries } from './generated-player-queries.js';

type PackContext = {
  readonly emitFile: (asset: {
    readonly fileName?: string;
    readonly name?: string;
    readonly source: string | Uint8Array;
  }) => string;
  readonly getFileName: (referenceId: string) => string;
};

type PackPlugin = {
  readonly name: 'forgeax:pack';
  readonly generateBundle: (this: PackContext, ...args: readonly unknown[]) => void | Promise<void>;
  readonly closeBundle: (...args: readonly unknown[]) => void | Promise<void>;
};

type EngineWorkspaceResolverPlugin = {
  readonly name: 'forgeax:devkit-engine-workspace-resolver';
  readonly resolveId: (
    this: { readonly resolve: (...args: readonly unknown[]) => Promise<unknown> },
    source: string,
    importer?: string,
  ) => Promise<unknown>;
};

function hasPluginNamed(plugins: readonly unknown[] | undefined, name: string): boolean {
  return (plugins ?? []).some(
    (plugin) =>
      typeof plugin === 'object' &&
      plugin !== null &&
      !Array.isArray(plugin) &&
      'name' in plugin &&
      plugin.name === name,
  );
}

describe('standalone host', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('binds ordinary project animation cadence to both generated App placements and the build identity', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-animation-assembly-')));
    try {
      await mkdir(resolve(root, 'assets'));
      await writeFile(resolve(root, 'package.json'), '{"name":"animation-assembly"}\n');
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          id: 'animation-assembly',
          name: 'Animation assembly',
          schemaVersion: '3.0.0',
          roots: {},
        }),
      );
      const facts = await readProjectFacts(root);
      if (!facts.ok) throw facts.error;
      const identities: string[] = [];
      for (const cadence of ['update', 'fixed']) {
        vi.stubEnv('FORGEAX_ANIMATION_PLAYBACK', JSON.stringify({ cadence }));
        for (const command of ['build', 'serve'] as const) {
          const config = await createViteConfig(facts.value, command);
          const source = await readFile(resolve(config.root ?? '', 'main.ts'), 'utf8');
          const bootstrap = await readFile(
            resolve(config.root ?? '', 'execution-bootstrap.ts'),
            'utf8',
          );
          const options = /const animation = (\{[^\n]+\});/.exec(source)?.[1];
          expect(options).toBeDefined();
          expect(JSON.parse(options ?? 'null')).toEqual({ cadence });
          const call = source.slice(
            source.indexOf('const result = await createApp('),
            source.indexOf('if (!result.ok) throw result.error;'),
          );
          expect(call.match(/\banimation,/g)).toHaveLength(2);
          expect(call.match(/\bdynamicGeometryMeshBudgetBytes,/g)).toHaveLength(2);
          const budgetExpression = source.slice(
            source.indexOf('const dynamicGeometryMeshBudgetBytes ='),
            source.indexOf('const cpuProfileRequested ='),
          );
          for (const [queryString, expected] of [
            ['', undefined],
            ['forgeax-dynamic-mesh-budget-bytes=536870912', 536870912],
            ['forgeax-dynamic-mesh-budget-bytes=0', 0],
          ] as const) {
            expect(
              runInNewContext(`${budgetExpression}\ndynamicGeometryMeshBudgetBytes`, {
                query: new URLSearchParams(queryString),
              }),
            ).toBe(expected);
          }
          const identity = /ssrIdentity: (\{[^\n]+\}),/.exec(bootstrap)?.[1];
          expect(identity).toBeDefined();
          if (command === 'build') identities.push(JSON.parse(identity ?? '{}').buildSha256);
        }
      }
      expect(identities[0]).not.toBe(identities[1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects native build-root App options into dev/build before both App placements', async () => {
    const root = await mkdtemp(resolve(import.meta.dirname, '../../..', '.app-options-fixture-'));
    const namespace = PackageId.parse('019fb7ce-4200-7000-8000-000000000000');
    if (!namespace.ok) throw namespace.error;
    const guid = AssetGuid.format(AssetGuid.derive(namespace.value, 'plugin/build'));
    const packPath = resolve(root, 'assets/build.pack.json');
    try {
      await mkdir(resolve(root, 'assets'));
      await writeFile(resolve(root, 'package.json'), '{"name":"app-options","type":"module"}');
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          id: 'app-options',
          name: 'App options',
          schemaVersion: '3.0.0',
          roots: { build: guid },
        }),
      );
      await writeFile(
        resolve(root, 'assets/build.ts'),
        `export default {
        provide: ['devkitAppOptions'], apply(ctx, config) { ctx.provide('devkitAppOptions', config); }
      };`,
      );
      const facts = await readProjectFacts(root);
      if (!facts.ok) throw facts.error;
      const identities: string[] = [];
      const pipelineLibrary = {
        version: 1,
        backend: 'webgpu',
        shaders: [],
        bindGroupLayouts: [],
        pipelineLayouts: [],
        renderPipelines: [],
        computePipelines: [],
      };
      const time = {
        fixedDeltaSeconds: 1 / 20,
        maxStepsPerUpdate: 2,
        maxDeltaSeconds: 3 * (1 / 20),
      };
      for (const budget of [256 * 1024 * 1024, 128 * 1024 * 1024]) {
        const standardProfile = {
          ...DEFAULT_STANDARD_PROFILE,
          volumetricFog: { quality: 'low', depth: 48, tileSize: 16 },
        };
        await writeFile(
          packPath,
          JSON.stringify({
            schemaVersion: '3.0.0',
            packageId: '019fb7ce-4200-7000-8000-000000000000',
            assets: {
              'plugin/build': {
                kind: 'plugin',
                payload: {
                  module: { specifier: './build.ts' },
                  config: {
                    dynamicGeometryMeshBudgetBytes: budget,
                    assetBudgetBytes: budget * 16,
                    standardProfile,
                    pipelineLibrary,
                    time,
                  },
                },
              },
            },
          }),
        );
        for (const command of ['build', 'serve'] as const) {
          const config = await createViteConfig(facts.value, command);
          try {
            const source = await readFile(resolve(config.root ?? '', 'main.ts'), 'utf8');
            // The page realm reads the catalog through its one installed source.
            expect(source).not.toContain('configurePackIndex(');
            const expression = source.slice(
              source.indexOf('const dynamicGeometryMeshBudgetBytes ='),
              source.indexOf('const cpuProfileRequested ='),
            );
            for (const [queryString, expected] of [
              ['', budget],
              ['forgeax-dynamic-mesh-budget-bytes=512', 512],
              ['forgeax-dynamic-mesh-budget-bytes=0', 0],
            ] as const)
              expect(
                runInNewContext(`${expression}\ndynamicGeometryMeshBudgetBytes`, {
                  query: new URLSearchParams(queryString),
                }),
              ).toBe(expected);
            const call = source.slice(
              source.indexOf('const result = await createApp('),
              source.indexOf('if (!result.ok) throw result.error;'),
            );
            expect(call.match(/\bdynamicGeometryMeshBudgetBytes,/g)).toHaveLength(2);
            expect(call.match(/\bpipelineLibrary,/g)).toHaveLength(2);
            // Both placements receive the stub selected by ?forgeax-gpu-stub=1.
            expect(call.split('...(gpuStub === undefined ? {} : { gpuStub }),')).toHaveLength(3);
            // Both execution placements receive the admitted AssetRegistry content budget.
            expect(call.split(`assetBudgetBytes: ${budget * 16},`)).toHaveLength(3);
            expect(call.split(`time: ${JSON.stringify(time)},`)).toHaveLength(3);
            const appCall = (
              await transformWithOxc(
                call
                  .replaceAll('import.meta.env.DEV', String(command === 'serve'))
                  .replaceAll('import.meta.url', JSON.stringify('https://game.test/main.js')),
                'app-call.ts',
                { lang: 'ts' },
              )
            ).code;
            for (const workerExecution of [false, true]) {
              const world = (await runInNewContext(
                `(async () => { ${appCall} return result; })()`,
                {
                  canvas: {},
                  document: { querySelector: () => null, baseURI: 'https://game.test/' },
                  URL,
                  workerExecution,
                  animation: {},
                  dynamicGeometryMeshBudgetBytes: budget,
                  pipelineLibrary,
                  gpuStub: undefined,
                  executionWorkers: {},
                  programDeliveryChannel: 'test',
                  isolateVfxViewGraph: false,
                  vfxInstanceArenas: true,
                  vfxNativePlanning: true,
                  vfxRetainedResources: true,
                  gameChannel: undefined,
                  cpuProfileRequested: false,
                  rhiCaptureRequested: false,
                  gpuPassTiming: undefined,
                  shadowWorkload: undefined,
                  geometryLane: undefined,
                  gbufferBatchOrderDiagnostic: undefined,
                  featureReadOnlyDepthBatchDiagnostic: undefined,
                  renderTaskYield: 'none',
                  renderPipelineCapacity: 3,
                  pointerLockAllowed: undefined,
                  runtimeScopeBinding: {},
                  bundler: {},
                  ctx: { root: {} },
                  assetCatalog: {},
                  pluginPrograms: {},
                  runtimePacks: {},
                  profiler: undefined,
                  workspaceGame: false,
                  workspaceMode: false,
                  gameVfx: undefined,
                  mainAudio: undefined,
                  webAudioPlugin: () => ({}),
                  audioPlugin: () => ({}),
                  skinningPlugin: () => ({}),
                  createApp: (_canvas: unknown, options: ConstructorParameters<typeof World>[0]) =>
                    new World(options),
                },
              )) as World;
              world.update(1 / 60).unwrap();
              expect(world.getResource(Time).maxDeltaSeconds).toBe(time.maxDeltaSeconds);
              expect(world.getResource(FixedTime)).toMatchObject({
                delta: time.fixedDeltaSeconds,
                maxStepsPerUpdate: 2,
              });
            }
            expect(
              JSON.parse(
                await readFile(resolve(config.root ?? '', 'pipeline-library.json'), 'utf8'),
              ),
            ).toEqual(pipelineLibrary);
            expect(source).toContain(
              "import pipelineLibraryUrl from './pipeline-library.json?url'",
            );
            expect(source.indexOf('await fetch(pipelineLibraryUrl)')).toBeLessThan(
              source.indexOf('const result = await createApp('),
            );
            // Execute the generated renderer-realm hook, including failure propagation.
            const bootstrap = await readFile(
              resolve(config.root ?? '', 'execution-bootstrap.ts'),
              'utf8',
            );
            const script = (
              await transformWithOxc(
                bootstrap
                  .replace(/^import .*;\n/gm, '')
                  .replace('export default ', '')
                  .replaceAll('import.meta.env.DEV', 'false'),
                'execution-bootstrap.ts',
                { lang: 'ts' },
              )
            ).code;
            const prepared = await runInNewContext(`${script}\nexecutionBootstrap()`, {
              createGameVfx: () => ({}),
              createRuntimePackOptions: async () => ({}),
              runtimeBinding: { scopeId: 'test-profile' },
              createPrograms: () => ({}),
              audioPlugin: () => ({}),
              skinningPlugin: () => ({}),
              crypto: { randomUUID: () => 'test-profile' },
              root: null,
            });
            let applied: unknown;
            await prepared.configureRenderer({
              setProfile(profile: unknown) {
                applied = profile;
                return { ok: true };
              },
            });
            expect(applied).toEqual(standardProfile);
            const failure = new Error('renderer profile rejected');
            expect(() =>
              prepared.configureRenderer({
                setProfile: () => ({ ok: false, error: failure }),
              }),
            ).toThrow(failure);
            expect(call).toContain(`standardProfile: ${JSON.stringify(standardProfile)}`);
            if (command === 'build') {
              const bootstrap = await readFile(
                resolve(config.root ?? '', 'execution-bootstrap.ts'),
                'utf8',
              );
              identities.push(
                JSON.parse(/ssrIdentity: (\{[^\n]+\}),/.exec(bootstrap)?.[1] ?? '{}').buildSha256,
              );
            }
          } finally {
            for (const plugin of config.plugins ?? []) {
              if (
                plugin &&
                typeof plugin === 'object' &&
                'closeBundle' in plugin &&
                typeof plugin.closeBundle === 'function'
              )
                await plugin.closeBundle.call({} as never);
            }
          }
        }
      }
      expect(identities[0]).not.toBe(identities[1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('changes the generated SSR input identity when same-path WGSL bytes change', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-ssr-source-identity-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await writeFile(resolve(root, 'package.json'), '{"name":"ssr-input-fixture"}\n');
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          id: 'ssr-input-fixture',
          name: 'SSR input fixture',
          schemaVersion: '3.0.0',
          roots: {},
        }),
      );
      const shader = resolve(root, 'assets/custom.wgsl');
      await writeFile(shader, '#define_import_path fixture::custom\nconst value = 1.0;\n');
      const facts = await readProjectFacts(root);
      if (!facts.ok) throw facts.error;
      const readIdentity = async (config: Awaited<ReturnType<typeof createViteConfig>>) => {
        const source = await readFile(resolve(config.root ?? '', 'execution-bootstrap.ts'), 'utf8');
        const json = /ssrIdentity: (\{[^\n]+\}),/.exec(source)?.[1];
        if (json === undefined) throw new Error('generated SSR identity missing');
        return JSON.parse(json) as import('@forgeax/engine-render').SsrAdmissionIdentity;
      };
      const beforeConfig = await createViteConfig(facts.value, 'build');
      const before = await readIdentity(beforeConfig);
      expect(before.sourceHead).toBe('project:ssr-input-fixture');
      for (const field of ['sourceTree', 'lockSha256', 'buildSha256'] as const)
        expect(before[field]).toMatch(/^sha256:[a-f0-9]{64}$/);
      const page = await readFile(resolve(beforeConfig.root ?? '', 'main.ts'), 'utf8');
      expect(page).toContain(`ssrIdentity: ${JSON.stringify(before)},`);
      await writeFile(shader, '#define_import_path fixture::custom\nconst value = 2.0;\n');
      const after = await readIdentity(await createViteConfig(facts.value, 'build'));
      expect(after.sourceHead).toBe(before.sourceHead);
      expect(after.lockSha256).toBe(before.lockSha256);
      expect(after.sourceTree).not.toBe(before.sourceTree);
      expect(after.buildSha256).not.toBe(before.buildSha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pins the generated host mode to the DevKit command', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-mode-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'host-mode-game',
            name: 'Host Mode Game',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"host-mode-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;

      vi.stubEnv('NODE_ENV', 'development');
      const build = await createViteConfig(facts.value, 'build');
      const serve = await createViteConfig(facts.value, 'serve');
      expect(build.define).toMatchObject({ 'import.meta.env.DEV': 'false' });
      expect(serve.define).toMatchObject({ 'import.meta.env.DEV': 'true' });
      const generated = await readFile(resolve(serve.root ?? '', 'main.ts'), 'utf8');
      const start = generated.indexOf("    const scope = ctx.isolate('assets')");
      const end = generated.indexOf('  },\n  ...(hostTransport', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const context = new Context();
      const unrelatedProducer = {};
      context.provide('runtimePacks', unrelatedProducer);
      let frontend: Context | undefined;
      try {
        await runInNewContext(`(async () => { ${generated.slice(start, end)} })()`, {
          ctx: context,
          Context,
          ShaderRegistry,
          AssetRegistry,
          assembleAssetRuntime,
          assembleRuntimePacks,
          assetCatalog: createCatalogSource({ entries: [] }),
          runtimeScopeBinding: { scopeId: 'frontend-test' },
          initialAssembly: { sessionGeneration: 1 },
          crypto: { randomUUID: () => 'frontend-test' },
          hostRoot: 'test-root',
          signal: undefined,
          startupTimeoutMs: 30_000,
          hostPrograms: () => ({
            sessionId: 'test',
            contextId: 'frontend',
            sessionGeneration: 1,
            target: 'frontend',
            tools: new Map(),
            definitions: new Map(),
            programs: new Map(),
          }),
          createRuntimePackOptions: (scopeId: string) => ({ scopeId }),
          activateExecutionRoot: async (ctx: Context) => {
            frontend = ctx;
          },
        });
        expect(frontend).toBeDefined();
        expect(frontend?.get('runtimePacks')).not.toBe(unrelatedProducer);
        expect(frontend?.get('assets')).toBeDefined();
        expect(context.get('runtimePacks')).toBe(unrelatedProducer);
      } finally {
        await context.fiber.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('installs the RHI-debug capture provider only for opted-in serve hosts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-rhi-debug-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'rhi-debug-game',
            name: 'RHI Debug Game',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"rhi-debug-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;

      const ordinary = await createViteConfig(facts.value, 'serve');
      expect(hasPluginNamed(ordinary.plugins, 'forgeax:rhi-debug')).toBe(false);

      vi.stubEnv('FORGEAX_ENGINE_RHI_DEBUG', '1');
      const debugServe = await createViteConfig(facts.value, 'serve');
      expect(hasPluginNamed(debugServe.plugins, 'forgeax:rhi-debug')).toBe(true);

      const debugBuild = await createViteConfig(facts.value, 'build');
      expect(hasPluginNamed(debugBuild.plugins, 'forgeax:rhi-debug')).toBe(false);
      vi.stubEnv('FORGEAX_PREVIEW_RHI_WINDOW', '1');
      const automatic = await createViteConfig(facts.value, 'serve');
      const automaticSource = await readFile(resolve(automatic.root ?? '', 'main.ts'), 'utf8');
      expect(automaticSource).not.toContain('async function previewRhiDiagnostic');
      vi.stubEnv('FORGEAX_ENGINE_RHI_DEBUG', '0');
      const windowConfig = await createViteConfig(facts.value, 'serve');
      expect(hasPluginNamed(windowConfig.plugins, 'forgeax:rhi-debug')).toBe(true);
      const plugin = windowConfig.plugins?.find(
        (value) =>
          value &&
          typeof value === 'object' &&
          'name' in value &&
          value.name === 'forgeax:rhi-debug',
      );
      if (
        !plugin ||
        typeof plugin !== 'object' ||
        !('config' in plugin) ||
        typeof plugin.config !== 'function'
      )
        throw new Error('RHI transport config missing');
      const configured = await Reflect.apply(plugin.config, {}, [
        {},
        { command: 'serve', mode: 'test' },
      ]);
      expect(configured?.define?.['import.meta.env.FORGEAX_ENGINE_RHI_DEBUG']).toBe('"0"');
      const windowSource = await readFile(resolve(windowConfig.root ?? '', 'main.ts'), 'utf8');
      const start = windowSource.indexOf('async function previewRhiDiagnostic');
      const end = windowSource.indexOf('const previewVfxHosts', start);
      expect(start).toBeGreaterThan(0);
      const source = windowSource
        .slice(start, end)
        .replaceAll("import('@forgeax/engine/rhi-webgpu')", 'Promise.resolve(testBackend)')
        .replaceAll("import('@forgeax/engine/rhi-wgpu')", 'Promise.resolve(testBackend)');
      const callbackStart = windowSource.indexOf(
        'async ({ context, canvas: previewCanvas, asset, targetId }) => {',
      );
      const callbackEnd = windowSource.indexOf('} } : {}),', callbackStart);
      const calls: string[] = [];
      const arm = vi.fn(async (world: string) => {
        calls.push(`arm:${world}`);
      });
      const diagnosticFactory = vi.fn(
        async (_context: unknown, _canvas: unknown, _targetId: string) => ({
          options: { rhi: 'own-recorder' },
          arm,
        }),
      );
      const createApp = vi.fn(async (_canvas: unknown, _options: unknown) => {
        calls.push('create');
        return { ok: true, value: { world: { identity: 'own-world' } } };
      });
      const callback = runInNewContext(
        `(${windowSource.slice(callbackStart, callbackEnd + 1).replaceAll('import.meta.env.DEV', 'true')})`,
        {
          app: { pluginContext: { get: () => undefined } },
          assetCatalog: {},
          runtimeScopeBinding: {},
          physicsComponentsPlugin: () => ({}),
          previewRhiDiagnostic: diagnosticFactory,
          createApp,
          bundler: {},
        },
      );
      const context = {};
      const meshCanvas = {};
      await callback({
        context,
        canvas: meshCanvas,
        asset: { kind: 'mesh' },
        targetId: 'actual-child',
      });
      expect(diagnosticFactory).toHaveBeenCalledWith(context, meshCanvas, 'actual-child');
      expect(createApp.mock.calls[0]?.[1]).toMatchObject({ rhi: 'own-recorder' });
      expect(calls).toEqual(['create', 'arm:own-world']);
      await callback({ context, canvas: {}, asset: { kind: 'scene' }, targetId: 'scene-child' });
      expect(diagnosticFactory).toHaveBeenCalledOnce();
      expect(createApp.mock.calls[1]?.[1]).not.toHaveProperty('rhi');
      for (const hasGpu of [true, false]) {
        const cleanup: (() => Promise<void>)[] = [];
        let listener: (event: unknown) => void = () => {};
        let resolveCapture: (result: unknown) => void = () => {};
        const attachment = {
          backend: {
            rhi: {},
            unwrapDeviceForSurface: (device: unknown) => ({ ok: true, value: device }),
          },
          captureFrames: vi.fn(
            (
              _frames: number,
              _options: { seed: { maxResourceBytes: number }; signal: AbortSignal },
            ) =>
              new Promise((resolve) => {
                resolveCapture = resolve;
              }),
          ),
          frameBoundary: vi.fn(async () => ({ ok: true })),
          dispose: vi.fn(async () => ({ ok: true })),
          deviceLost: vi.fn(),
        };
        const ensureReady = vi.fn(async () => {});
        const remove = vi.fn();
        const uploadTape = vi.fn(async () => ({
          ok: true,
          value: { kind: 'rhi-tape', path: '/evidence/own.rhitape' },
        }));
        const canvas = { dataset: {} as Record<string, string> };
        const subscribe = vi.fn((_canvas: unknown, callback: (event: unknown) => void) => {
          listener = callback;
          return remove;
        });
        const create = runInNewContext(`${source} previewRhiDiagnostic`, {
          navigator: hasGpu ? { gpu: {} } : {},
          AbortController,
          testBackend: { ...(hasGpu ? {} : { ensureReady }) },
          attachRecorder: () => ({ ok: true, value: attachment }),
          subscribeBrowserFrameSubmitted: subscribe,
          uploadTape,
        });
        const diagnostic = await create(
          { effect: (effect: () => () => Promise<void>) => cleanup.push(effect()) },
          canvas,
          'actual-child',
        );
        await diagnostic.arm('world-4');
        expect(attachment.captureFrames).toHaveBeenCalledWith(4, {
          seed: { maxResourceBytes: 0 },
          signal: expect.any(AbortSignal),
        });
        expect(attachment.frameBoundary).toHaveBeenCalledOnce();
        expect(subscribe.mock.calls[0]?.[0]).toBe(canvas);
        expect(ensureReady).toHaveBeenCalledTimes(hasGpu ? 0 : 1);
        for (let frameId = 1; frameId <= 4; frameId++)
          listener({
            frameId,
            deviceGeneration: 0,
            worldIdentity: !hasGpu && frameId === 4 ? 'another-world' : 'world-4',
            receipt: {
              frameId,
              deviceGeneration: 0,
              presentation: 'pending',
              completed: new Promise(() => {}),
            },
          });
        const state = JSON.parse(canvas.dataset.forgeaxPreviewRhiWindow ?? '{}');
        expect(state).toMatchObject({
          targetId: 'actual-child',
          worldIdentity: 'world-4',
          mapping: hasGpu ? 'complete' : 'partial',
          seed: 'omitted',
          evidence: 'commands-and-bindings',
        });
        expect(state.frames.map((row: { tapeFrameIndex: number }) => row.tapeFrameIndex)).toEqual([
          0, 1, 2, 3,
        ]);
        resolveCapture({ ok: true, value: { byteLength: 0 } });
        await vi.waitFor(() => expect(uploadTape).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
          expect(JSON.parse(canvas.dataset.forgeaxPreviewRhiWindow ?? '{}').status).toBe(
            'uploaded',
          ),
        );
        await cleanup[0]?.();
        expect(remove).toHaveBeenCalledOnce();
        expect(attachment.dispose).toHaveBeenCalledOnce();
        expect(attachment.captureFrames.mock.calls[0]?.[1].signal.aborted).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits the opt-in workspace command bridge into the project browser page', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-workspace-bridge-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({ id: 'workspace-bridge', name: 'Workspace Bridge', schemaVersion: '3.0.0', roots: {} })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"workspace-bridge"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      const config = await createViteConfig(facts.value, 'serve', '/', {
        server: { port: 0, strictPort: false },
      });
      const generatedRoot = config.root;
      if (generatedRoot === undefined)
        throw new Error('serve config must expose its generated root');
      const generated = await readFile(resolve(generatedRoot, 'main.ts'), 'utf8');
      await expect(
        transformWithOxc(generated, 'generated/main.ts', { lang: 'ts' }),
      ).resolves.toBeDefined();
      expect(generated).toContain('ctx.plugin(engineWorkspaceBrowserPlugin');
      expect(generated).toContain('if (workspaceMode) await activateWorkspace?.()');
      expect(generated).toContain('notifyWorkspacePageLost?.();');
      expect(generated).not.toContain('executeWorkspaceCommand');
      expect(generated).not.toContain('cancelledWorkspaceCommands');
      const previewStart = generated.indexOf(
        'async ({ context, canvas: previewCanvas, asset, targetId }) => {',
      );
      const previewEnd = generated.indexOf('} } : {}),', previewStart);
      expect(previewStart).toBeGreaterThan(0);
      expect(previewEnd).toBeGreaterThan(previewStart);
      const catalog = createCatalogSource({ entries: [] });
      const createApp = vi.fn(async (_canvas: unknown, _options: unknown, _bundler: unknown) => ({
        ok: true,
        value: { preview: true },
      }));
      const preview = runInNewContext(
        `(${generated.slice(previewStart, previewEnd + 1).replaceAll('import.meta.env.DEV', 'true')})`,
        {
          app: { pluginContext: { get: () => ({ catalog }) } },
          assetCatalog: createCatalogSource({ entries: [] }),
          createApp,
          physicsComponentsPlugin: () => ({}),
          runtimeScopeBinding: { scopeId: 'preview-test' },
          bundler: {},
        },
      );
      await preview({ context: {}, canvas: {}, asset: { kind: 'mesh' } });
      expect(createApp.mock.calls[0]?.[1]).toMatchObject({ assetCatalog: catalog });
      expect(createApp.mock.calls[0]?.[1]).not.toHaveProperty('runtimePacks');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('owns canonical project and build DDC roots', () => {
    expect(devKitDdcRoots('/workspace/game')).toEqual({
      buildCacheRoot: resolve('/workspace/game', '.forgeax/ddc/build-cache'),
      projectDdcRoot: resolve('/workspace/game', '.forgeax/ddc/v2'),
    });
  });

  it('resolves Engine workspace packages for external projects without installed links', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-external-resolution-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'external-game',
            name: 'External Game',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"external-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      const config = await createViteConfig(facts.value, 'build');
      const resolver = (config.plugins ?? []).find(
        (plugin): plugin is EngineWorkspaceResolverPlugin => {
          if (typeof plugin !== 'object' || plugin === null || Array.isArray(plugin)) return false;
          const candidate = plugin as { readonly name?: unknown; readonly resolveId?: unknown };
          return (
            candidate.name === 'forgeax:devkit-engine-workspace-resolver' &&
            typeof candidate.resolveId === 'function'
          );
        },
      );
      expect(resolver).toBeDefined();
      if (resolver === undefined) return;
      const context = { resolve: async () => null };
      const importer = resolve(root, '.forgeax/generated/main.ts');
      const app = await resolver.resolveId.call(context, '@forgeax/engine-app', importer);
      const guid = await resolver.resolveId.call(context, '@forgeax/engine-pack/guid', importer);
      expect(String(app)).toMatch(/packages[\\/]app[\\/]dist[\\/]index\.mjs$/);
      expect(String(guid)).toMatch(/packages[\\/]pack[\\/]dist[\\/]guid\.mjs$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes only missing Engine builtin mesh descriptors for standalone projects', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-builtins-'));
    try {
      await mkdir(resolve(root, 'assets'));
      const cube = BUILTIN_MESH_ASSETS.find((asset) => asset.geometry === 'procedural-cube');
      expect(cube).toBeDefined();
      if (cube === undefined) return;
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'builtin-game',
            name: 'Builtin Game',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"builtin-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
        writeFile(
          resolve(root, 'assets/authored.pack.json'),
          `${JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: cube.guid,
                kind: 'mesh',
                payload: { geometry: 'procedural-cube' },
                refs: [],
                artifacts: {},
              },
            ],
          })}\n`,
        ),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      await createViteConfig(facts.value, 'build');
      const generated = JSON.parse(
        await readFile(resolve(root, '.forgeax/generated/engine-builtins.pack.json'), 'utf8'),
      ) as {
        readonly assets: readonly {
          readonly guid: string;
          readonly payload: { readonly geometry: string };
        }[];
      };
      const generatedGuids = generated.assets.map((asset) => asset.guid.toLowerCase());
      expect(generatedGuids).not.toContain(cube.guid.toLowerCase());
      expect(generatedGuids).toHaveLength(BUILTIN_MESH_ASSETS.length - 1);
      expect(generated.assets.map((asset) => asset.payload.geometry)).toContain(
        'procedural-sphere',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps shader inputs out while admitting project-owned importer assets', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-'));
    const shader = resolve(root, 'assets/shaders/custom.wgsl.meta.json');
    const targetProfile = resolve(root, 'assets/target-profile.json.meta.json');
    const image = resolve(root, 'assets/image.png.meta.json');
    await mkdir(resolve(root, 'assets/shaders'), { recursive: true });
    await Promise.all([
      writeFile(shader, '{"importer":"shader"}\n'),
      writeFile(targetProfile, '{"importer":"game-default-target-profile"}\n'),
      writeFile(image, '{"importer":"image"}\n'),
    ]);
    expect(ignoreDevKitCatalogPath(shader)).toBe(true);
    expect(ignoreDevKitCatalogPath(targetProfile)).toBe(false);
    expect(ignoreDevKitCatalogPath(image)).toBe(false);
  });

  it('generates native project roots and keeps resource preview independent of gameplay', async () => {
    const template = resolve(import.meta.dirname, '../../../../templates/empty');
    const facts = await readProjectFacts(template);
    if (!facts.ok) throw facts.error;
    const project = await createViteConfig(facts.value, 'serve');
    const resource = await createViteConfig(facts.value, 'serve', '/', {
      bootstrapRoot: 'resource-bootstrap',
    });
    if (!project.root) throw new Error('required fixture project.root missing');
    if (!resource.root) throw new Error('required fixture resource.root missing');
    const generated = await readFile(resolve(project.root, 'main.ts'), 'utf8');
    const worker = await readFile(resolve(project.root, 'execution-bootstrap.ts'), 'utf8');
    const resourceSource = await readFile(resolve(resource.root, 'main.ts'), 'utf8');
    expect(generated).toContain('activateExecutionRoot');
    expect(generated).toContain('virtual:forgeax/plugin-programs/frontend');
    expect(worker).toContain('virtual:forgeax/plugin-programs/engine');
    expect(generated).not.toContain('defaultScene');
    expect(generated).not.toContain('CatalogLoader');
    const appReady = generated.indexOf('const app = appState.current;');
    const frameCredit = generated.indexOf('app.start().unwrap();', appReady);
    const frontendActivation = generated.indexOf('await frontendHost.activate();', appReady);
    expect(frameCredit).toBeGreaterThan(appReady);
    expect(frontendActivation).toBeGreaterThan(frameCredit);
    expect(resourceSource).toContain('resource-bootstrap');
    expect(resourceSource).not.toContain('game-3d/player');
    await expect(transformWithOxc(generated, 'main.ts', { lang: 'ts' })).resolves.toBeDefined();
    for (const config of [project, resource]) {
      const server = await (await import('vite')).createServer({
        ...config,
        plugins: (config.plugins as import('vite').Plugin[]).filter(
          (plugin) => plugin.name === 'forgeax:generated-host-owner',
        ),
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true },
      });
      await server.close();
    }
  });

  it('keeps accepted author inputs stable when a failed serving host retires its generated files', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-retired-inputs-')));
    const dependencyRoot = await realpath(
      await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-input-dependency-')),
    );
    let server: import('vite').ViteDevServer | undefined;
    try {
      await mkdir(resolve(root, 'assets'));
      await writeFile(resolve(root, 'package.json'), '{"name":"retired-inputs"}');
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          id: 'retired-inputs',
          name: 'Retired inputs',
          schemaVersion: '3.0.0',
          roots: {},
        }),
      );
      const authored = resolve(root, 'assets/authored.pack.json');
      await writeFile(
        authored,
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [],
        }),
      );
      const facts = await readProjectFacts(root);
      if (!facts.ok) throw facts.error;
      const dependency = resolve(dependencyRoot, 'helper.ts');
      await writeFile(dependency, 'export const value = 1;');
      const sources = await discoverPluginAssets(facts.value);
      await sources.sourceSnapshot.digest(dependency);
      const config = await createViteConfig(facts.value, 'serve', '/', { initialSources: sources });
      // The Pack compiler can observe Engine builtins while preparing a real game.
      // Use that same retained snapshot and its native observation method here.
      await sources.sourceSnapshot.digest(
        resolve(String(config.root), 'engine-builtins.pack.json'),
      );
      const plugins = config.plugins as import('vite').Plugin[];
      const session = plugins.find(
        (plugin) => plugin.name === 'forgeax:project-session',
      ) as import('vite').Plugin & { inputPaths(): readonly string[] };
      server = await (await import('vite')).createServer({
        ...config,
        plugins: plugins.filter((plugin) => plugin.name === 'forgeax:generated-host-owner'),
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true },
      });
      const paths = session.inputPaths();
      const before = await readLiveProjectInputs(root, paths);
      await server.close();
      server = undefined;
      await expect(
        readFile(resolve(String(config.root), 'engine-builtins.pack.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readLiveProjectInputs(root, paths)).toBe(before);
      await writeFile(dependency, 'export const value = 200;');
      expect(await readLiveProjectInputs(root, paths)).not.toBe(before);
      const afterDependency = await readLiveProjectInputs(root, paths);
      await writeFile(
        authored,
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [],
          name: 'changed',
        }),
      );
      expect(await readLiveProjectInputs(root, paths)).not.toBe(afterDependency);
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
      await rm(dependencyRoot, { recursive: true, force: true });
    }
  });

  it('projects package.json startup policy into generated App and Host startup paths', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-startup-policy-'));
    try {
      await mkdir(resolve(root, 'assets'), { recursive: true });
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'startup-policy',
            name: 'Startup Policy',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(
          resolve(root, 'package.json'),
          `${JSON.stringify({
            name: 'startup-policy',
            forgeax: { startupTimeoutMs: 120_000, frameTimeoutMs: 5000 },
          })}\n`,
        ),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      expect(facts.value.startupTimeoutMs).toBe(120_000);
      const config = await createViteConfig(facts.value, 'serve');
      if (!config.root) throw new Error('required generated root missing');
      const generated = await readFile(resolve(config.root, 'main.ts'), 'utf8');
      expect(generated).toContain('startupTimeoutMs: 120000');
      expect(generated).toContain('frameTimeoutMs: 5000');
      expect(generated).toContain('timeoutMs: 120000');
      await expect(transformWithOxc(generated, 'main.ts', { lang: 'ts' })).resolves.toBeDefined();

      await writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({ name: 'startup-policy', forgeax: { startupTimeoutMs: null, frameTimeoutMs: null } })}\n`,
      );
      const unboundedFacts = await readProjectFacts(root);
      expect(unboundedFacts.ok).toBe(true);
      if (!unboundedFacts.ok) return;
      const unboundedConfig = await createViteConfig(unboundedFacts.value, 'serve');
      if (!unboundedConfig.root) throw new Error('required generated root missing');
      const unbounded = await readFile(resolve(unboundedConfig.root, 'main.ts'), 'utf8');
      expect(unbounded).toContain('startupTimeoutMs: null');
      expect(unbounded).toContain('frameTimeoutMs: null');
      expect(unbounded).toContain('timeoutMs: null');
      await expect(transformWithOxc(unbounded, 'main.ts', { lang: 'ts' })).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects the requested static base and output directory into Vite', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-'));
    const output = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-output-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'game',
          name: 'Game',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
    ]);
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    const config = await createViteConfig(facts.value, 'build', '/games/game/', {
      outDir: output,
    });
    expect(config.base).toBe('/games/game/');
    expect(config.build?.outDir).toBe(output);
    const generatedRoot = await realpath(resolve(root, '.forgeax/generated'));
    expect(config.build?.rollupOptions?.input).toEqual({
      index: resolve(generatedRoot, 'index.html'),
      'execution-bootstrap': resolve(generatedRoot, 'execution-bootstrap.ts'),
    });
    // Real Vite progress must not corrupt the CLI result stream.
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(config.customLogger).toBeDefined();
      expect(config.logLevel).toBe('warn');
      config.customLogger?.warn('palace-build-progress');
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('palace-build-progress'),
        expect.anything(),
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    const generatedHtml = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    expect(generatedHtml).toContain('formatStartupFailure');
    expect(generatedHtml).toContain('appendStructuredFailure');
    for (const prefix of ['ForgeaX game failed to start.', 'ForgeaX game stopped.']) {
      expect(generatedHtml).toContain(`${prefix}\\n`);
      expect(generatedHtml).not.toContain(`${prefix}\n`);
    }
  });

  it('keeps structured startup causes instead of collapsing objects to [object Object]', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'game',
          name: 'Game',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
    ]);
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    await createViteConfig(facts.value, 'build');
    const generatedHtml = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    const inlineScript = generatedHtml.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
    expect(inlineScript).toBeDefined();

    class HostElement {
      textContent = '';
      readonly style = { display: 'none' };
    }
    const notice = new HostElement();
    const listeners = new Map<string, (event: { readonly reason: unknown }) => void>();
    const start = () =>
      runInNewContext(inlineScript ?? '', {
        document: { querySelector: () => notice },
        HTMLElement: HostElement,
        window: {
          addEventListener: (
            type: string,
            listener: (event: { readonly reason: unknown }) => void,
          ) => listeners.set(type, listener),
        },
      });
    start();
    listeners.get('unhandledrejection')?.({
      reason: {
        name: 'AssetError',
        message: 'pack-index.json could not be loaded',
        code: 'asset-not-imported',
        hint: 'rebuild the asset catalog',
      },
    });

    expect(notice.textContent).toContain('AssetError');
    expect(notice.textContent).toContain('asset-not-imported');
    expect(notice.textContent).toContain('pack-index.json could not be loaded');
    expect(notice.textContent).toContain('rebuild the asset catalog');
    expect(notice.textContent).not.toContain('[object Object]');

    start();
    listeners.get('unhandledrejection')?.({
      reason: {
        name: 'EngineEnvironmentError',
        message: 'forgeax-engine: no usable backend',
        detail: {
          webgpuError: {
            name: 'RhiError',
            code: 'adapter-unavailable',
            hint: 'browser-native WebGPU adapter was not available',
          },
          wgpuError: {
            name: 'RhiError',
            code: 'rhi-not-available',
            hint: 'wgpu/WebGL2 initialization failed',
          },
        },
      },
    });
    expect(notice.textContent).toContain('detail.webgpuError: RhiError adapter-unavailable');
    expect(notice.textContent).toContain('detail.wgpuError: RhiError rhi-not-available');
    expect(notice.textContent).toContain('supports browser WebGPU and a wgpu/WebGL2 fallback');
    let reason: unknown = {
      code: 'asset-package-invalid',
      detail: { component: 'CustomSceneTag' },
    };
    for (let index = 0; index < 8; index++)
      reason = { code: 'plugin-startup-failed', cause: reason };
    start();
    listeners.get('unhandledrejection')?.({ reason });
    expect(notice.textContent).toContain('asset-package-invalid');
    expect(notice.textContent).toContain('CustomSceneTag');
    const circular: { cause?: unknown } = {};
    circular.cause = circular;
    start();
    listeners.get('unhandledrejection')?.({ reason: circular });
    expect(notice.textContent).toContain('[circular]');
    for (let index = 0; index < 80; index++) reason = { cause: reason };
    start();
    listeners.get('unhandledrejection')?.({ reason });
    expect(notice.textContent).toContain('[diagnostic node limit]');
  });

  it('exercises the generated startup lifecycle through its inline page fixture', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-startup-page-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'startup-page',
          name: 'Startup Page',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"startup-page"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
    ]);

    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    await createViteConfig(facts.value, 'build');
    const generatedHtml = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    const inlineScript = generatedHtml.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
    expect(inlineScript).toBeDefined();
    if (inlineScript === undefined) return;

    class FixtureElement {
      capture?: (type: string, event: Record<string, unknown>) => void;
      textContent = '';
      readonly style = { display: '' };
      readonly attributes = new Map<string, string>();
      readonly listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
      focused = false;

      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }

      addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      dispatch(type: string, event: Record<string, unknown> = {}): void {
        const observed = { target: this, ...event };
        this.capture?.(type, observed);
        for (const listener of this.listeners.get(type) ?? []) listener(observed);
      }

      contains(target: unknown): boolean {
        if (!(target instanceof FixtureElement)) throw new TypeError('Expected Node');
        return target === this;
      }

      focus(): void {
        this.focused = true;
      }

      listenerCount(): number {
        let count = 0;
        for (const listeners of this.listeners.values()) count += listeners.size;
        return count;
      }
    }

    class FixtureWindow {
      readonly listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();

      addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      dispatch(type: string, event: Record<string, unknown> = {}): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      listenerCount(): number {
        let count = 0;
        for (const listeners of this.listeners.values()) count += listeners.size;
        return count;
      }
    }

    const execute = (search: string) => {
      const elements = new Map<string, FixtureElement>([
        ['#app', new FixtureElement()],
        ['#forgeax-loading', new FixtureElement()],
        ['#forgeax-loading-status', new FixtureElement()],
        ['#forgeax-loading-slow', new FixtureElement()],
        ['#forgeax-loading-reload', new FixtureElement()],
        ['#forgeax-fatal', new FixtureElement()],
        ['#forgeax-fatal-message', new FixtureElement()],
        ['#forgeax-fatal-details', new FixtureElement()],
        ['#forgeax-fatal-reload', new FixtureElement()],
      ]);
      const canvas = elements.get('#app');
      const loading = elements.get('#forgeax-loading');
      const loadingStatus = elements.get('#forgeax-loading-status');
      const loadingSlow = elements.get('#forgeax-loading-slow');
      const loadingReload = elements.get('#forgeax-loading-reload');
      const fatal = elements.get('#forgeax-fatal');
      const fatalMessage = elements.get('#forgeax-fatal-message');
      const fatalDetails = elements.get('#forgeax-fatal-details');
      const fatalReload = elements.get('#forgeax-fatal-reload');
      if (
        canvas === undefined ||
        loading === undefined ||
        loadingStatus === undefined ||
        loadingSlow === undefined ||
        loadingReload === undefined ||
        fatal === undefined ||
        fatalMessage === undefined ||
        fatalDetails === undefined ||
        fatalReload === undefined
      ) {
        throw new Error('startup fixture elements are incomplete');
      }
      const window = new FixtureWindow();
      canvas.capture = (type, event) => window.dispatch(type, event);
      const timers = new Map<number, () => void>();
      const history: {
        readonly id: number;
        readonly delay: number;
        readonly callback: () => void;
      }[] = [];
      let timerId = 0;
      let now = 0;
      const location = { search, reload: vi.fn() };
      const document = {
        visibilityState: 'visible',
        querySelector: (selector: string) => elements.get(selector) ?? null,
      };
      const context = {
        document,
        HTMLElement: FixtureElement,
        Node: FixtureElement,
        URLSearchParams,
        location,
        window,
        performance: { now: () => now },
        matchMedia: () => ({ matches: false }),
        setTimeout: (callback: () => void, delay: number) => {
          const id = ++timerId;
          timers.set(id, callback);
          history.push({ id, delay, callback });
          return id;
        },
        clearTimeout: (id: number) => {
          timers.delete(id);
        },
      };
      runInNewContext(inlineScript, context);
      const startup = (
        context as typeof context & {
          readonly __forgeaxStartup: {
            readonly prepare: () => void;
            readonly fail: (reason: unknown, execution?: { readonly fault: unknown }) => void;
            readonly destroy: () => void;
            readonly enter: (event: unknown) => void;
            readonly bindInput: (callback: (enabled: boolean) => void) => () => void;
            readonly bindSession: (session: string) => void;
          };
        }
      ).__forgeaxStartup;
      const runTimer = (id: number | undefined): void => {
        if (id === undefined) return;
        const callback = timers.get(id);
        if (callback === undefined) return;
        timers.delete(id);
        callback();
      };
      return {
        canvas,
        loading,
        loadingStatus,
        loadingSlow,
        loadingReload,
        fatal,
        fatalMessage,
        fatalDetails,
        fatalReload,
        window,
        timers,
        history,
        location,
        setNow: (value: number) => {
          now = value;
        },
        runTimer,
        startup,
      };
    };

    const page = execute('');
    expect(() => page.window.dispatch('keydown', { target: page.window })).not.toThrow();
    const inputStates: boolean[] = [];
    page.startup.bindInput((enabled) => inputStates.push(enabled));
    page.startup.bindSession('session-a');
    const blocked = {
      target: page.canvas,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation: vi.fn(),
      stopPropagation: vi.fn(),
    };
    page.window.dispatch('keydown', blocked);
    expect(blocked.defaultPrevented).toBe(true);

    page.canvas.dispatch('forgeax:frame-submitted', {
      detail: { frameId: 1, deviceGeneration: 1, worldIdentity: 'session-a' },
    });
    page.canvas.dispatch('forgeax:frame-completed', {
      detail: {
        frameId: 1,
        deviceGeneration: 1,
        worldIdentity: 'session-a',
        presentation: 'ready',
      },
    });
    expect(page.loading.style.display).toBe('grid');

    const overlap = execute('');
    overlap.startup.bindSession('session-overlap');
    overlap.startup.prepare();
    overlap.canvas.dispatch('forgeax:frame-submitted', {
      detail: { frameId: 10, deviceGeneration: 1, worldIdentity: 'session-overlap' },
    });
    overlap.canvas.dispatch('forgeax:frame-submitted', {
      detail: { frameId: 11, deviceGeneration: 1, worldIdentity: 'session-overlap' },
    });
    overlap.canvas.dispatch('forgeax:frame-completed', {
      detail: {
        frameId: 12,
        deviceGeneration: 1,
        worldIdentity: 'session-overlap',
        presentation: 'ready',
      },
    });
    expect(overlap.loading.style.display).toBe('grid');
    overlap.canvas.dispatch('forgeax:frame-completed', {
      detail: {
        frameId: 10,
        deviceGeneration: 1,
        worldIdentity: 'session-overlap',
        presentation: 'ready',
      },
    });
    expect(overlap.loading.attributes.get('data-fading')).toBe('true');
    const overlapFade = overlap.history.find((entry) => entry.delay === 150)?.id;
    expect(overlapFade).toBeDefined();
    overlap.runTimer(overlapFade);
    expect(overlap.loading.style.display).toBe('none');

    const pending = execute('');
    pending.startup.bindSession('session-pending');
    pending.startup.prepare();
    for (let frameId = 1; frameId <= 32; frameId += 1) {
      pending.canvas.dispatch('forgeax:frame-submitted', {
        detail: { frameId, deviceGeneration: 1, worldIdentity: 'session-pending' },
      });
      pending.canvas.dispatch('forgeax:frame-completed', {
        detail: {
          frameId,
          deviceGeneration: 1,
          worldIdentity: 'session-pending',
          presentation: 'pending',
        },
      });
    }
    pending.canvas.dispatch('forgeax:frame-completed', {
      detail: {
        frameId: 1,
        deviceGeneration: 1,
        worldIdentity: 'session-pending',
        presentation: 'ready',
      },
    });
    expect(pending.loading.style.display).toBe('grid');
    pending.canvas.dispatch('forgeax:frame-submitted', {
      detail: { frameId: 33, deviceGeneration: 1, worldIdentity: 'session-pending' },
    });
    pending.canvas.dispatch('forgeax:frame-completed', {
      detail: {
        frameId: 33,
        deviceGeneration: 1,
        worldIdentity: 'session-pending',
        presentation: 'ready',
      },
    });
    expect(pending.loading.attributes.get('data-fading')).toBe('true');
    const pendingFade = pending.history.find((entry) => entry.delay === 150)?.id;
    expect(pendingFade).toBeDefined();
    pending.runTimer(pendingFade);
    expect(pending.loading.style.display).toBe('none');

    const unbound = execute('');
    unbound.startup.prepare();
    unbound.canvas.dispatch('forgeax:frame-submitted', {
      detail: { frameId: 1, deviceGeneration: 1, worldIdentity: 'unbound' },
    });
    unbound.canvas.dispatch('forgeax:frame-completed', {
      detail: {
        frameId: 1,
        deviceGeneration: 1,
        worldIdentity: 'unbound',
        presentation: 'ready',
      },
    });
    expect(unbound.loading.style.display).toBe('');
    unbound.startup.destroy();

    page.startup.prepare();
    expect(page.loadingStatus.textContent).toBe('Preparing scene…');
    page.canvas.dispatch('forgeax:frame-submitted', {
      detail: { frameId: 2, deviceGeneration: 1, worldIdentity: 'session-a' },
    });
    page.canvas.dispatch('forgeax:frame-completed', {
      detail: {
        frameId: 2,
        deviceGeneration: 1,
        worldIdentity: 'session-a',
        presentation: 'ready',
      },
    });
    expect(page.loading.attributes.get('aria-hidden')).toBe('true');
    expect(page.loading.attributes.get('data-fading')).toBe('true');
    expect(inputStates.at(-1)).toBe(false);
    const staleFade = page.history.find((entry) => entry.delay === 150)?.callback;
    expect(staleFade).toBeDefined();

    page.startup.bindSession('session-b');
    expect(page.loading.style.display).toBe('grid');
    expect(page.loading.attributes.get('aria-hidden')).toBe('false');
    staleFade?.();
    expect(page.loading.style.display).toBe('grid');
    page.startup.prepare();
    expect(page.loadingStatus.textContent).toBe('Preparing scene…');

    page.canvas.dispatch('forgeax:frame-submitted', {
      detail: { frameId: 3, deviceGeneration: 2, worldIdentity: 'session-b' },
    });
    page.canvas.dispatch('forgeax:frame-completed', {
      detail: {
        frameId: 3,
        deviceGeneration: 2,
        worldIdentity: 'session-b',
        presentation: 'ready',
      },
    });
    const activeFade = page.history.find(
      (entry) => entry.delay === 150 && entry.callback !== staleFade,
    )?.id;
    expect(activeFade).toBeDefined();
    page.runTimer(activeFade);
    expect(page.loading.style.display).toBe('none');
    expect(inputStates.at(-1)).toBe(true);

    const readyInput = {
      target: page.canvas,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation: vi.fn(),
      stopPropagation: vi.fn(),
    };
    page.window.dispatch('keydown', readyInput);
    expect(readyInput.defaultPrevented).toBe(false);
    expect(page.window.listenerCount()).toBe(0);
    expect(page.canvas.listenerCount()).toBe(0);
    expect(page.timers.size).toBe(0);

    const generatedMain = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
    const errorBindingStart = generatedMain.indexOf('removeStartupErrorListener = app.onError(');
    const errorBindingEnd = generatedMain.indexOf(
      '\n      removeStartupInputBinding',
      errorBindingStart,
    );
    expect(errorBindingStart).toBeGreaterThanOrEqual(0);
    expect(errorBindingEnd).toBeGreaterThan(errorBindingStart);
    const runtimeErrorBinding = generatedMain.slice(errorBindingStart, errorBindingEnd);
    let runtimeErrorListener: ((error: unknown) => void) | undefined;
    let execution: { fault: unknown } = { fault: null };
    const pointerLockWarning = vi.fn();
    runInNewContext(`let removeStartupErrorListener;\n${runtimeErrorBinding}`, {
      startup: page.startup,
      console: { warn: pointerLockWarning },
      app: {
        execution: { report: () => execution },
        onError: (listener: (error: unknown) => void) => {
          runtimeErrorListener = listener;
          return () => {};
        },
      },
    });
    const runtimeFailure = {
      name: 'AppError',
      code: 'app-system-update-failed',
      detail: { cause: { phase: 'frame', timeoutMs: 15000 } },
    };
    runtimeErrorListener?.({ code: 'app-pointer-lock-failed' });
    expect(pointerLockWarning).toHaveBeenCalledTimes(1);
    expect(page.fatal.style.display).not.toBe('grid');
    // An error's name/message cannot establish a terminal execution owner.
    runtimeErrorListener?.(runtimeFailure);
    expect(page.fatal.style.display).not.toBe('grid');
    expect(inputStates.at(-1)).toBe(true);
    page.startup.fail(runtimeFailure);
    expect(page.fatal.style.display).not.toBe('grid');
    execution = {
      fault: {
        source: 'runtime',
        code: 'app-execution-deadline-exceeded',
        detail: { phase: 'frame', timeoutMs: 15000 },
        partialWrite: false,
        retryable: false,
      },
    };
    runtimeErrorListener?.(runtimeFailure);
    expect(page.fatal.style.display).toBe('grid');
    expect(page.fatalMessage.textContent).toBe('The game stopped because execution failed.');
    expect(page.loading.style.display).toBe('none');
    expect(inputStates.at(-1)).toBe(false);
    expect(page.fatalDetails.textContent).toContain('detail.cause.phase: frame');
    expect(page.fatalDetails.textContent).toContain('detail.cause.timeoutMs: 15000');
    expect(page.fatalReload.focused).toBe(true);
    page.startup.fail({ code: 'device-lost', message: 'WebGPU device lost' }, execution);
    expect(page.fatalDetails.textContent).toContain('detail.cause.timeoutMs: 15000');
    expect(page.fatalDetails.textContent).not.toContain('WebGPU device lost');
    page.fatalReload.dispatch('click');
    expect(page.location.reload).toHaveBeenCalledTimes(1);
    runtimeErrorListener?.(runtimeFailure);
    page.fatalReload.dispatch('click');
    expect(page.location.reload).toHaveBeenCalledTimes(1);
    expect(page.fatalReload.listenerCount()).toBe(0);

    const lateSession = execute('');
    lateSession.startup.bindSession('session-initial');
    lateSession.setNow(14_000);
    lateSession.startup.bindSession('session-late');
    const lateSlowTimer = lateSession.history.filter((entry) => entry.delay === 1_000).at(-1)?.id;
    expect(lateSlowTimer).toBeDefined();
    lateSession.setNow(15_000);
    lateSession.runTimer(lateSlowTimer);
    expect(lateSession.loadingSlow.style.display).toBe('block');
    expect(lateSession.loadingReload.style.display).toBe('inline-block');

    const publicationFailed = execute('');
    publicationFailed.startup.fail({
      message: 'webgpu-runtime-error: pipeline build raised',
      cause: {
        code: 'asset-read-failed',
        message: 'The shader publication could not be read.',
        detail: { status: 503, url: '/shaders/manifest.json' },
      },
    });
    expect(publicationFailed.fatalMessage.textContent).toBe('Unable to start the game.');
    expect(publicationFailed.fatalDetails.textContent).toContain('asset-read-failed');
    expect(publicationFailed.fatalDetails.textContent).toContain('cause.detail.status: 503');
    expect(publicationFailed.fatalDetails.textContent).toContain(
      'supports browser WebGPU and a wgpu/WebGL2 fallback',
    );
    publicationFailed.fatalReload.dispatch('click');
    expect(publicationFailed.location.reload).toHaveBeenCalledTimes(1);

    const failed = execute('');
    failed.startup.fail({
      name: 'AssetError',
      code: 'asset-not-imported',
      message: 'texture failed',
      detail: { guid: 'texture-guid', url: '/assets/texture.png', attempt: 2 },
    });
    expect(failed.fatal.style.display).toBe('grid');
    expect(failed.loading.style.display).toBe('none');
    expect(failed.fatalDetails.textContent).toContain('detail.guid: texture-guid');
    expect(failed.fatalDetails.textContent).toContain('detail.url: /assets/texture.png');
    expect(failed.fatalDetails.textContent).toContain('detail.attempt: 2');
    expect(failed.fatalReload.focused).toBe(true);
    // Scene teardown can emit secondary renderer failures; retain the original cause.
    failed.startup.fail({ code: 'render-system-no-camera', message: 'scene already retired' });
    expect(failed.fatalDetails.textContent).toContain('detail.guid: texture-guid');
    expect(failed.fatalDetails.textContent).not.toContain('scene already retired');
    const focusedReloadKey = {
      target: failed.fatalReload,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation: vi.fn(),
      stopPropagation: vi.fn(),
    };
    failed.fatalReload.dispatch('keydown', focusedReloadKey);
    expect(focusedReloadKey.stopPropagation).toHaveBeenCalledTimes(1);
    expect(focusedReloadKey.defaultPrevented).toBe(false);
    failed.fatalReload.dispatch('click');
    expect(failed.location.reload).toHaveBeenCalledTimes(1);
    failed.startup.fail({ name: 'RetryError', detail: { attempt: 3 } });
    expect(failed.fatalDetails.textContent).toContain('detail.attempt: 2');
    failed.fatalReload.dispatch('click');
    expect(failed.location.reload).toHaveBeenCalledTimes(1);
    expect(failed.fatalReload.listenerCount()).toBe(0);

    const play = execute('?forgeaxWorkspace=game');
    expect(play.loading.style.display).not.toBe('none');
    play.startup.bindSession('play-world');
    play.startup.prepare();
    expect(play.loadingStatus.textContent).toBe('Preparing scene…');
    play.canvas.dispatch('forgeax:frame-submitted', {
      detail: { worldIdentity: 'play-world', deviceGeneration: 0, frameId: 1 },
    });
    play.canvas.dispatch('forgeax:frame-completed', {
      detail: {
        worldIdentity: 'play-world',
        deviceGeneration: 0,
        frameId: 1,
        presentation: 'ready',
      },
    });
    expect(play.loading.attributes.get('aria-hidden')).toBe('true');
    const fade = play.history.find((entry) => entry.delay === 150);
    play.runTimer(fade?.id);
    expect(play.loading.style.display).toBe('none');

    const workspace = execute('?forgeaxWorkspace=1');
    expect(workspace.loading.style.display).toBe('none');
    workspace.startup.fail({ name: 'WorkspaceEntryError', message: 'entry 404' });
    expect(workspace.fatal.style.display).toBe('grid');
    expect(workspace.fatalReload.focused).not.toBe(true);
    expect(workspace.loading.style.display).toBe('none');

    const destroyed = execute('');
    expect(destroyed.window.listenerCount()).toBeGreaterThan(0);
    expect(destroyed.timers.size).toBeGreaterThan(0);
    destroyed.startup.prepare();
    destroyed.startup.destroy();
    expect(destroyed.window.listenerCount()).toBe(0);
    expect(destroyed.canvas.listenerCount()).toBe(0);
    expect(destroyed.timers.size).toBe(0);
    destroyed.startup.fail(runtimeFailure, execution);
    expect(destroyed.fatal.style.display).not.toBe('grid');
  });

  it('resource host wires the package-owned equirect kit into the canonical scene', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-resource-host-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'resource-game',
            name: 'Resource Game',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"resource-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      const config = await createViteConfig(facts.value, 'build', '/games/demo/', {
        bootstrapRoot: 'resource-bootstrap',
        animation: { cadence: 'fixed' },
      });
      const generated = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
      expect(generated).toContain("await loadOwned(canonicalEnvironmentGuid, 'equirect')");
      const inspectionStart = generated.indexOf('function exposeGameInspection(app)');
      const inspectionEnd = generated.indexOf(
        'async function prepareProject(app)',
        inspectionStart,
      );
      expect(Math.min(inspectionStart, inspectionEnd)).toBeGreaterThanOrEqual(0);
      const executionReport = {
        frame: { submitted: 3, completed: 2, inFlight: 1, highWater: 2, throttledTicks: 4 },
      };
      const lastError = {
        code: 'rhi-not-available',
        expected: 'an admitted frame',
        hint: 'inspect the owning renderer',
      };
      const rendererFrame = {
        frameId: 3,
        deviceGeneration: 1,
        pendingCompletionCount: 1,
        pendingCompletions: [
          {
            frameId: 3,
            deviceGeneration: 1,
            presentation: 'ready',
            queue: 'pending',
            reflection: 'pending',
          },
        ],
      };
      const rendererCapabilities = {
        backendKind: 'webgpu',
        compute: true,
        storageBuffer: false,
      };
      const rendererLimits = { maxStorageBuffersPerShaderStage: 0 };
      const inspected = runInNewContext(
        `${generated.slice(inspectionStart, inspectionEnd)}\nexposeGameInspection(app); globalThis.__forgeaxGameInspection.renderer();`,
        {
          app: {
            renderer: {
              inspect: () => ({
                state: 'alive',
                frame: rendererFrame,
                capabilities: rendererCapabilities,
                limits: rendererLimits,
              }),
            },
            execution: { report: () => executionReport },
            lastError,
          },
        },
      );
      expect(inspected.frame).toBe(rendererFrame);
      expect(inspected.capabilities).toBe(rendererCapabilities);
      expect(inspected.limits).toBe(rendererLimits);
      expect(inspected.execution).toBe(executionReport);
      expect(inspected.lastError).toBe(lastError);
      const installLine = generated
        .split('\n')
        .find((line) => line.includes('exposeGameInspection(app as App)'));
      expect(installLine).toBeDefined();
      if (installLine === undefined) throw new Error('generated inspection install line missing');
      for (const dev of [false, true]) {
        for (const cpuProfileRequested of [false, true]) {
          for (const workerExecution of [false, true]) {
            let installs = 0;
            runInNewContext(
              installLine.replace('import.meta.env.DEV', String(dev)).replace('app as App', 'app'),
              {
                app: {},
                cpuProfileRequested,
                workerExecution,
                executionWorkers: {},
                exposeGameInspection: () => {
                  installs++;
                },
              },
            );
            expect(installs).toBe(!workerExecution && (dev || cpuProfileRequested) ? 1 : 0);
          }
        }
      }

      // Execute the generated query and actual createApp call, not a duplicate
      // parser. The App owner remains responsible for Worker capability admission.
      const callStart = generated.indexOf('const runtimePacks = workerExecution ?');
      const callEnd = generated.indexOf('if (!result.ok)', callStart);
      expect(callStart).toBeGreaterThanOrEqual(0);
      expect(callEnd).toBeGreaterThan(callStart);
      const runtimeScopeBinding = {
        catalogUrl: 'http://localhost:5173/__pack/scopes/resource-game/1/catalog.json',
      };
      for (const dev of [false, true]) {
        const bootstrapCall = (
          await transformWithOxc(
            generated
              .slice(callStart, callEnd)
              .replaceAll('import.meta.env.DEV', String(dev))
              .replaceAll(
                'import.meta.url',
                JSON.stringify('https://game.test/games/demo/main.js'),
              ),
            'bootstrap-call.ts',
            { lang: 'ts' },
          )
        ).code;
        for (const workerExecution of [false, true]) {
          for (const search of [
            '',
            '?forgeax-gpu-pass-timing=0',
            '?forgeax-gpu-pass-timing=1',
            '?forgeax-shadow-workload=0',
            '?forgeax-shadow-workload=1',
            '?forgeax-geometry-lane=automatic',
            '?forgeax-geometry-lane=direct',
            '?forgeax-geometry-lane=invalid',
            ...(!workerExecution ? ['?forgeax-cpu-profile=0', '?forgeax-cpu-profile=1'] : []),
          ]) {
            const profilingCapability = {};
            const runtimeCatalog = {};
            const fallbackHost = {};
            const deliveredHost = {};
            const realmPrograms = { programHost: deliveredHost };
            let profilerAllocations = 0;
            const options = await runInNewContext(
              `(async () => { ${generatedPlayerQueries(generated)} ${bootstrapCall} return result; })()`,
              {
                location: { search },
                document: {
                  baseURI: 'https://game.test/games/demo/index.html',
                  querySelector: () => null,
                },
                URLSearchParams,
                URL,
                canvas: {},
                workerExecution,
                executionWorkers: {},
                bootstrapRoot: 'resource-bootstrap',
                animation: JSON.parse(
                  /const animation = (\{[^\n]+\});/.exec(generated)?.[1] ?? 'null',
                ),
                ctx: {
                  root: {},
                  get: (name: string) => {
                    expect(name).toBe('frontendPlatform');
                    return { createPackProgramHost: fallbackHost };
                  },
                },
                pointerLockAllowed: undefined,
                runtimeScopeBinding,
                assetCatalog: runtimeCatalog,
                enginePrograms: (
                  _session: string,
                  _context: string,
                  _generation: number,
                  host: unknown,
                ) => {
                  expect(host).toBe(fallbackHost);
                  return realmPrograms;
                },
                createRuntimePackOptions: (_scope: string, _prepared: unknown, native: unknown) => {
                  expect(native).toBe(fallbackHost);
                  return { programHost: fallbackHost };
                },
                initialAssembly: { sessionGeneration: 1 },
                crypto: { randomUUID: () => 'test-engine-context' },
                bundler: {},
                forgeaxBundlerAdapter: () => ({}),
                createProfiler: () => {
                  profilerAllocations++;
                  return profilingCapability;
                },
                programDeliveryChannel: 'test-program-channel',
                gameChannel: { port1: {}, port2: {} },
                createApp: (_canvas: unknown, options: unknown) => options,
              },
            );
            const expectedGpuPassTiming =
              new URLSearchParams(search).get('forgeax-gpu-pass-timing') === '1' ? {} : undefined;
            const expectedShadowWorkload =
              new URLSearchParams(search).get('forgeax-shadow-workload') === '1' ? true : undefined;
            expect(options.animation).toEqual({ cadence: 'fixed' });
            if (workerExecution) {
              expect(options.gpuPassTiming).toBeUndefined();
              expect(options.shadowWorkload).toBeUndefined();
              expect(options.execution.diagnostics.shadowWorkload).toBe(expectedShadowWorkload);
              expect(options.execution.diagnostics.gpuPassTiming).toEqual(expectedGpuPassTiming);
              expect(options.execution.diagnostics.geometryLane).toBe(
                new URLSearchParams(search).get('forgeax-geometry-lane') === 'direct'
                  ? 'direct'
                  : undefined,
              );
              expect(options.execution.bootstrapData).toEqual({
                programDeliveryChannel: 'test-program-channel',
                isolateVfxViewGraph: true,
                vfxInstanceArenas: true,
                vfxNativePlanning: true,
                vfxRetainedResources: true,
              });
            } else {
              expect(options).not.toHaveProperty('geometryLane');
              expect(options).not.toHaveProperty('execution');
              expect(options.gpuPassTiming).toEqual(expectedGpuPassTiming);
              expect(options.shadowWorkload).toBe(expectedShadowWorkload);
              expect(options.assetCatalog).toBe(runtimeCatalog);
              expect(options.pluginPrograms).toBe(realmPrograms);
              expect(options.runtimePacks.programHost).toBe(deliveredHost);
            }
            const cpuEnabled = new URLSearchParams(search).get('forgeax-cpu-profile') === '1';
            expect(options.profiler).toBe(cpuEnabled ? profilingCapability : undefined);
            expect(profilerAllocations).toBe(cpuEnabled ? 1 : 0);
            if (workerExecution) {
              expect(options.execution.assetCatalog).toEqual(
                dev
                  ? {
                      url: runtimeScopeBinding.catalogUrl,
                      expectedScope: runtimeScopeBinding,
                      runtimeBinding: runtimeScopeBinding,
                    }
                  : { url: 'https://game.test/games/demo/pack-index.json' },
              );
            }
          }
        }
      }
      expect(generated).toContain('data: { equirect: canonicalEnvironment }');
      expect(generated).toContain('fitToolPreviewCameraToAabb');
      expect(generated).toContain(
        'createTextureWorkspacePreview(app.world, assets, resourceHandle,',
      );
      expect(generated).toContain("resource.kind === 'texture'");
      expect(generated).toContain('rendererTextureResident');
      expect(generated).toContain('textureRendererObservation(');
      expect(generated).toContain('preparedResourceBinding,');
      expect(generated).toContain('forgeax:frame-submitted');
      expect(generated).toContain('textureDimensions(payload)');
      expect(generated).not.toContain('TEXTURE_VIEW_MATERIALS');
      expect(generated).toContain('texture: owner.texture');
      expect(generated).not.toContain('app.renderer.store.uploadTexture');
      expect(generated).toContain(
        'loadEngineWorkspaceMaterialSlots(assets, payload.materialSlots)',
      );
      await expect(
        transformWithOxc(generated, 'generated/main.ts', { lang: 'ts' }),
      ).resolves.toBeDefined();
      expect(generated).toContain('await cleanup();');
      expect(generated).not.toContain('app.renderer.drawCalls');
      expect(generated).toContain('observation: {');
      expect(generated).toContain('background: presentation.background');
      expect(generated).toContain('createApp(');
      expect(generated).toContain('plugins: [],');
      expect(generated).toContain('assetRuntimeBinding: runtimeScopeBinding');
      expect(generated).not.toContain('assets.setCatalogSource(assetCatalog)');
      expect(generated).toContain('await assets.enumerateCatalog()');
      expect(generated).toContain('loadEngineWorkspaceMaterialSlots');
      expect(generated).not.toContain('assets.installDecoder');
      expect(generated).not.toContain('assetDecoders:');
      expect(generated).not.toContain('component: Skylight, data: {}');
      expect(generated).not.toContain('component: SkyboxBackground, data: {}');
      expect(config.server?.fs?.allow).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/packages[\\/]preview[\\/]assets[\\/]canonical-kit$/),
        ]),
      );

      const payloadClassStart = generated.indexOf('function texturePayloadClass(payload)');
      const payloadClassEnd = generated.indexOf(
        'function selectedMaterialPass(payload)',
        payloadClassStart,
      );
      expect(Math.min(payloadClassStart, payloadClassEnd)).toBeGreaterThanOrEqual(0);
      const payloadHelpers = runInNewContext(
        `${generated.slice(payloadClassStart, payloadClassEnd)}\n({ texturePayloadClass });`,
        {},
      ) as { readonly texturePayloadClass: (payload: unknown) => string | undefined };
      expect(
        payloadHelpers.texturePayloadClass({
          format: 'rg8unorm',
          data: [255, 0, 255, 0],
        }),
      ).toBe('color');
      expect(
        payloadHelpers.texturePayloadClass({
          format: 'rgba8unorm',
          data: [255, 0, 255, 0],
        }),
      ).toBe('transparent');

      const helperStart = generated.indexOf(
        'function textureRendererObservation(inspection, expected, frame)',
      );
      const helperEnd = generated.indexOf('async function previewOwnerFacts', helperStart);
      expect(Math.min(helperStart, helperEnd)).toBeGreaterThanOrEqual(0);
      const previewHelpers = runInNewContext(
        `${generated.slice(helperStart, helperEnd)}\n({ textureRendererObservation });`,
        {},
      ) as {
        readonly textureRendererObservation: (
          inspection: unknown,
          expected: unknown,
          frame: unknown,
        ) => {
          readonly rendererTextureResident: boolean;
          readonly textureHandleCount: number;
        };
      };
      const bindingInspection = {
        frame: { frameId: 7, deviceGeneration: 3 },
        meshMaterialBindings: [
          {
            entityKey: 9,
            worldIdentity: 'world-a',
            bindings: [{ handle: 99 }],
            residency: [{ readiness: 'ready', textures: [{ handle: 999 }] }],
          },
        ],
      };
      expect(
        previewHelpers.textureRendererObservation(
          bindingInspection,
          {
            entityKey: 1,
            materialHandle: 99,
            textureHandle: 999,
          },
          { frameId: 7, deviceGeneration: 3 },
        ).rendererTextureResident,
      ).toBe(false);
      expect(
        previewHelpers.textureRendererObservation(
          bindingInspection,
          {
            entityKey: 9,
            worldIdentity: 'world-b',
            materialHandle: 99,
            textureHandle: 999,
          },
          { frameId: 7, deviceGeneration: 3 },
        ).rendererTextureResident,
      ).toBe(false);
      expect(
        previewHelpers.textureRendererObservation(
          bindingInspection,
          {
            entityKey: 9,
            worldIdentity: 'world-a',
            materialHandle: 99,
            textureHandle: 999,
          },
          { frameId: 7, deviceGeneration: 3 },
        ).rendererTextureResident,
      ).toBe(true);
      expect(
        previewHelpers.textureRendererObservation(
          bindingInspection,
          {
            entityKey: 9,
            worldIdentity: 'world-a',
            materialHandle: 99,
            textureHandle: 999,
          },
          { frameId: 6, deviceGeneration: 3 },
        ).rendererTextureResident,
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the host-owned importer set without a package asset registry', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-project-importer-'));
    try {
      await mkdir(resolve(root, 'assets'), { recursive: true });
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'importer-game',
            name: 'Importer Game',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"importer-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      await expect(createViteConfig(facts.value, 'build')).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cooks a zero-parameter Pack source through the standalone build composition root', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-scriptable-pack-'));
    const sceneGuid = '147386d9-3c73-5a8e-9b32-03bb1fe591cb';
    try {
      await mkdir(resolve(root, 'assets'));
      await symlink(resolve(process.cwd(), 'node_modules'), resolve(root, 'node_modules'), 'dir');
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'scriptable-game',
            name: 'Scriptable Game',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"scriptable-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
        writeFile(
          resolve(root, 'assets', 'default-scene.pack.ts'),
          `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';

const packageId = definePackageId('019ffa97-0000-7000-8000-000000000000');

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  name: 'Default Scene',
  build: () => ok({
    'scene/default': { kind: 'scene', name: 'Default Scene', entities: [] },
    'sampler/default': { kind: 'sampler', magFilter: 'linear' },
  }),
});
`,
        ),
      ]);

      const previous = process.cwd();
      process.chdir(root);
      try {
        const facts = await readProjectFacts(root);
        expect(facts.ok).toBe(true);
        if (!facts.ok) return;
        const config = await createViteConfig(facts.value, 'build');
        const pack = (config.plugins ?? []).find((plugin): plugin is PackPlugin => {
          if (typeof plugin !== 'object' || plugin === null || Array.isArray(plugin)) return false;
          const candidate = plugin as {
            readonly name?: unknown;
            readonly generateBundle?: unknown;
            readonly closeBundle?: unknown;
          };
          return (
            candidate.name === 'forgeax:pack' &&
            typeof candidate.generateBundle === 'function' &&
            typeof candidate.closeBundle === 'function'
          );
        });
        expect(pack).toBeDefined();
        if (pack === undefined || typeof pack.generateBundle !== 'function') return;
        const emitted = new Map<string, string | Uint8Array>();
        await pack.generateBundle.call({
          emitFile(asset) {
            const fileName = asset.fileName ?? asset.name ?? 'asset';
            emitted.set(fileName, asset.source);
            return fileName;
          },
          getFileName(referenceId) {
            return referenceId;
          },
        });
        await pack.closeBundle();
        const index = JSON.parse(String(emitted.get('pack-index.json'))) as RuntimeCatalogWire;
        expect(index.schemaVersion).toBe(RUNTIME_CATALOG_SNAPSHOT_SCHEMA);
        expect(index.authority).toBe('authoritative');
        expect(index.scopeId).not.toBe('');
        expect(Number.isSafeInteger(index.generation)).toBe(true);
        const scene = decodeCatalogWire(index)
          .unwrap()
          .find((entry) => entry.guid === sceneGuid);
        expect(scene).toMatchObject({ kind: 'scene', lifecycle: 'current' });
        if (scene === undefined) return;
        const packSource = emitted.get(scene.packageUrl.slice(1));
        if (packSource === undefined) throw new Error('missing emitted Pack body');
        const packBody = JSON.parse(
          typeof packSource === 'string' ? packSource : new TextDecoder().decode(packSource),
        ) as {
          readonly assets: readonly { readonly guid: string; readonly kind: string }[];
        };
        expect(packBody.assets).toEqual(
          expect.arrayContaining([expect.objectContaining({ guid: sceneGuid, kind: 'scene' })]),
        );
      } finally {
        process.chdir(previous);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('escapes the project name used as the generated page title', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-title-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'game',
          name: 'Game <One> & "Two"',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
    ]);
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    await createViteConfig(facts.value, 'build');
    const html = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    expect(html).toContain('<title>Game &lt;One&gt; &amp; &quot;Two&quot;</title>');
  });
});
