import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  createBrowserGameSaves,
  EngineConfigurationError,
  prepareEngineStartup,
  withEngineSettings,
} from '@forgeax/engine-app';
import { createBrowserConfigurationHost } from '@forgeax/engine-app/browser';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { Context } from '@forgeax/engine-plugin';
import { transformWithOxc } from 'vite';
import { expect, it } from 'vitest';
import { gameProjectionSource } from '../host/game-projection-source.js';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { generatedPlayerQueries } from './generated-player-queries.js';
import { generatedRenderFeatures } from './generated-render-features.js';

it('projects the current Host audio consumer and resolves the native factory on every rebuild', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-host-audio-'));
  const context = new Context();
  type Consumer = { engine: { configured: boolean; disposed: boolean }; dispose(): void };
  const consumers: Consumer[] = [];
  const createHostAudioConsumer = (): Consumer => {
    const engine = { configured: false, disposed: false };
    const consumer = {
      engine,
      dispose: () => {
        engine.disposed = true;
      },
    };
    consumers.push(consumer);
    return consumer;
  };
  let current: Consumer | undefined;
  let createAudio: (() => Consumer) | undefined;
  let host: { readonly audio?: Consumer['engine'] } | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"host-audio","type":"module"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'host-audio',
        name: 'Host audio',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'build');
    const generated = await readFile(resolve(config.root ?? '', 'main.ts'), 'utf8');
    const start = generated.indexOf('    const runtimePacks = workerExecution ?');
    const end = generated.indexOf('    appState.current = app;', start);
    const hostStart = generated.indexOf('      const host = {', end);
    const hostEnd = generated.indexOf("      ctx.provide('gameHost', host);", hostStart);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(hostStart).toBeGreaterThan(end);
    expect(hostEnd).toBeGreaterThan(hostStart);
    // Execute generated createApp options and its borrowed GameHost projection,
    // with real native service visibility. App's own replacement/disposal path
    // is covered by worker-execution-stop.test.ts in the App owner.
    const source = `(async () => {
      ${gameProjectionSource}
      ${await generatedRenderFeatures(config.root)}
      ${generatedPlayerQueries(generated)}
      ${generated.slice(start, end)}
      ${generated.slice(hostStart, hostEnd)}
      publishHost(host);
    })()`
      .replaceAll('import.meta.env.DEV', 'false')
      .replaceAll('import.meta.url', "'https://game.example/main.js'");
    const transformed = await transformWithOxc(source, 'host-audio.ts', { lang: 'ts' });
    const bootstrap = context.plugin({
      name: 'host-audio/bootstrap',
      async apply(ctx) {
        await runInNewContext(transformed.code, {
          ctx,
          URL,
          URLSearchParams,
          EngineConfigurationError,
          withEngineSettings,
          createBrowserConfigurationHost,
          createBrowserGameSaves,
          createBrowserFileStore: () => ({}),
          location: { search: '' },
          workerExecution: true,
          canvas: {},
          animation: undefined,
          executionWorkers: {},
          programDeliveryChannel: undefined,
          gameChannel: undefined,
          pointerLockAllowed: undefined,
          bundler: {},
          document: { baseURI: 'https://game.example/', body: {}, querySelector: () => null },
          controlMode: { read: () => 'pointer', subscribe: () => () => {} },
          assets: {},
          uiRoot: undefined,
          HTMLElement: class {},
          forgeaxBundlerAdapter: () => ({}),
          createHostAudioConsumer,
          createApp: async (
            _canvas: unknown,
            _options: unknown,
            adapter: { createHostAudio?: () => Consumer },
          ) => {
            if (adapter.createHostAudio === undefined)
              throw new Error('Generated Host audio factory is missing');
            createAudio = adapter.createHostAudio;
            current = createAudio();
            return { ok: true, value: {} };
          },
          publishHost: (value: typeof host) => {
            host = value;
          },
        });
      },
    });
    await bootstrap.await();
    expect(host?.audio).toBe(current?.engine);
    expect(consumers).toHaveLength(1);

    // App.start precedes this frontend activation so native asset/frame work
    // can proceed. This game configures audio before it installs its play UI.
    const frontend = context
      .isolate('assets')
      .isolate('pluginPrograms')
      .isolate('runtimePacks')
      .plugin({
        name: 'host-audio/frontend',
        provide: 'executionHostAudioFactory',
        apply(ctx) {
          if (host?.audio === undefined) throw new Error('Host audio is missing');
          host.audio.configured = true;
          ctx.provide('executionHostAudioFactory', () => {
            const consumer = createHostAudioConsumer();
            consumer.engine.configured = true;
            return consumer;
          });
        },
      });
    await frontend.await();
    expect(host?.audio?.configured).toBe(true);
    for (let generation = 0; generation < 3; generation += 1) {
      const previous = current;
      previous?.dispose();
      current = createAudio?.();
      expect(current).not.toBe(previous);
      expect(previous?.engine.disposed).toBe(true);
      expect(current?.engine.configured).toBe(true);
      expect(host?.audio).toBe(current?.engine);
    }
    await frontend.dispose();
    current?.dispose();
    current = createAudio?.();
    expect(current?.engine.configured).toBe(false);
    expect(host?.audio).toBe(current?.engine);
    expect(consumers).toHaveLength(5);
  } finally {
    current?.dispose();
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('projects the main-realm audio engine used by the native backend into GameHost', async () => {
  const { createHostAudioConsumer, WebAudioEngine, webAudioPlugin } = await import(
    '@forgeax/engine-audio-webaudio'
  );
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-main-audio-'));
  const context = new Context();
  let host: { audio?: InstanceType<typeof WebAudioEngine> } | undefined;
  let consumer: ReturnType<typeof createHostAudioConsumer> | undefined;
  const budget = { maxCachedBytes: 4096, maxCachedSources: 2, maxPendingPlays: 3 };
  const namespace = '019fb7ce-4200-7000-8000-000000000101';
  const parsed = PackageId.parse(namespace);
  if (!parsed.ok) throw parsed.error;
  const build = AssetGuid.format(AssetGuid.derive(parsed.value, 'plugin/build'));
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"main-audio","type":"module"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'main-audio',
        name: 'Main audio',
        schemaVersion: '3.0.0',
        roots: { build },
      }),
    );
    await writeFile(
      resolve(root, 'assets/build.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: namespace,
        assets: {
          'plugin/build': {
            kind: 'plugin',
            payload: {
              module: { specifier: './build.ts' },
              config: {
                configuration: {
                  deviceProfile: 'MainAudioDevice',
                  deviceProfiles: [
                    {
                      id: 'MainAudioDevice',
                      extends: 'Default',
                      settings: { audio: { host: budget } },
                    },
                  ],
                },
              },
            },
          },
        },
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
    const config = await createViteConfig(facts.value, 'build');
    const generated = await readFile(resolve(config.root ?? '', 'main.ts'), 'utf8');
    const start = generated.indexOf('    const runtimePacks = workerExecution ?');
    const end = generated.indexOf('    appState.current = app;', start);
    const hostStart = generated.indexOf('gameHostPlugin({', end) + 'gameHostPlugin('.length;
    const hostEnd = generated.indexOf('}));', hostStart) + 1;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(hostStart).toBeGreaterThan(end);
    expect(hostEnd).toBeGreaterThan(hostStart);
    const source = `(async () => {
      ${gameProjectionSource}
      ${await generatedRenderFeatures(config.root)}
      ${generatedPlayerQueries(generated)}
      ${generated.slice(start, end)}
      publishHost(${generated.slice(hostStart, hostEnd)});
    })()`
      // The generated slice runs in a Node VM with the fixture's module bindings.
      .replaceAll(
        "import('./game-render-features')",
        'Promise.resolve({ createGameRenderFeatures })',
      )
      .replaceAll("import('./game-vfx')", 'Promise.resolve({ createGameVfx })')
      .replaceAll('import.meta.env.DEV', 'false')
      .replaceAll('import.meta.url', "'https://game.example/main.js'");
    const transformed = await transformWithOxc(source, 'main-audio.ts', { lang: 'ts' });
    await runInNewContext(transformed.code, {
      ctx: context,
      URL,
      URLSearchParams,
      EngineConfigurationError,
      withEngineSettings,
      createBrowserConfigurationHost,
      createBrowserGameSaves,
      createBrowserFileStore: () => ({}),
      location: { search: '' },
      crypto: { randomUUID: () => 'main-audio' },
      workerExecution: false,
      executionWorkers: null,
      bootstrapRoot: 'project-bootstrap',
      workspaceMode: false,
      workspaceGame: false,
      resource: undefined,
      recipeValue: null,
      canvas: {},
      animation: undefined,
      initialAssembly: { sessionGeneration: 1 },
      gameChannel: undefined,
      pointerLockAllowed: undefined,
      bundler: {},
      profiler: undefined,
      document: { baseURI: 'https://game.example/', body: {}, querySelector: () => null },
      controlMode: {},
      assets: {},
      uiRoot: undefined,
      HTMLElement: class {},
      runtimeScopeBinding: { scopeId: 'main-audio' },
      assetCatalog: {},
      createRuntimePackOptions: async () => ({}),
      enginePrograms: () => ({}),
      createGameVfx: () => undefined,
      isolateVfxViewGraph: false,
      vfxInstanceArenas: undefined,
      vfxNativePlanning: undefined,
      vfxRetainedResources: undefined,
      createHostAudioConsumer,
      WebAudioEngine,
      webAudioPlugin,
      audioPlugin: () => ({ name: 'test-audio-systems', apply() {} }),
      skinningPlugin: () => ({ name: 'test-skinning', apply() {} }),
      createApp: async (
        _canvas: unknown,
        options: import('@forgeax/engine-app').CreateAppOptions,
        adapter: import('@forgeax/engine-app').AppHostAdapter,
      ) => {
        expect(options.execution).toBeUndefined();
        if (options.configuration === undefined)
          throw new Error('Generated startup definition is missing');
        const plan = (
          await prepareEngineStartup(structuredClone(options.configuration), {
            readDeviceFacts: () => ({ platform: 'unknown' }),
          })
        ).unwrap();
        expect(plan.settings.audio?.host).toEqual(budget);
        expect(options.plugins?.map(({ name }) => name)).not.toContain('web-audio');
        if (adapter.createHostAudio === undefined)
          throw new Error('Generated Host audio factory is missing');
        consumer = adapter.createHostAudio(plan.settings.audio?.host);
        for (const plugin of options.plugins ?? []) await context.plugin(plugin).await();
        return { ok: true, value: {} };
      },
      publishHost: (value: typeof host) => {
        host = value;
      },
    });
    expect(host?.audio).toBeInstanceOf(WebAudioEngine);
    expect(host?.audio).toBe(consumer?.engine);
    const audio = host?.audio;
    if (!audio || !consumer) throw new Error('Main Host audio is missing');
    audio
      .configureBuses([
        { id: 'master', parent: null },
        { id: 'game', parent: 'master' },
      ])
      .unwrap();
    consumer.consume({
      kind: 'set-acoustic-routes',
      entityId: 99,
      routes: { fallback: 0, buses: [{ bus: 'game', gain: 1 }] },
    });
    expect(consumer.state().lastError).toBeNull();
  } finally {
    consumer?.dispose();
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
