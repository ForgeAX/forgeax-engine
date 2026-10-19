import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Context } from '@forgeax/engine-plugin';
import { transformWithOxc } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { generatedPlayerQueries } from './generated-player-queries.js';

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
            options: { execution: { createHostAudio?: () => Consumer } },
          ) => {
            createAudio = options.execution.createHostAudio ?? createHostAudioConsumer;
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
  const { WebAudioEngine, webAudioPlugin } = await import('@forgeax/engine-audio-webaudio');
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-main-audio-'));
  const context = new Context();
  let host: { audio?: InstanceType<typeof WebAudioEngine> } | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"main-audio","type":"module"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'main-audio',
        name: 'Main audio',
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
    const hostStart = generated.indexOf('gameHostPlugin({', end) + 'gameHostPlugin('.length;
    const hostEnd = generated.indexOf('}));', hostStart) + 1;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(hostStart).toBeGreaterThan(end);
    expect(hostEnd).toBeGreaterThan(hostStart);
    const source = `(async () => {
      ${generatedPlayerQueries(generated)}
      ${generated.slice(start, end)}
      publishHost(${generated.slice(hostStart, hostEnd)});
    })()`
      .replaceAll('import.meta.env.DEV', 'false')
      .replaceAll('import.meta.url', "'https://game.example/main.js'");
    const transformed = await transformWithOxc(source, 'main-audio.ts', { lang: 'ts' });
    await runInNewContext(transformed.code, {
      ctx: context,
      URL,
      URLSearchParams,
      location: { search: '' },
      crypto: { randomUUID: () => 'main-audio' },
      workerExecution: false,
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
      WebAudioEngine,
      webAudioPlugin,
      audioPlugin: () => ({ name: 'test-audio-systems', apply() {} }),
      skinningPlugin: () => ({ name: 'test-skinning', apply() {} }),
      createApp: async (
        _canvas: unknown,
        options: { plugins: import('@forgeax/engine-plugin').Plugin[] },
      ) => {
        for (const plugin of options.plugins) await context.plugin(plugin).await();
        return { ok: true, value: {} };
      },
      publishHost: (value: typeof host) => {
        host = value;
      },
    });
    expect(host?.audio).toBeInstanceOf(WebAudioEngine);
    const audio = host?.audio;
    const backend = context.get('audio');
    if (!audio || !backend) throw new Error('Main Host audio is missing');
    audio
      .configureBuses([
        { id: 'master', parent: null },
        { id: 'game', parent: 'master' },
      ])
      .unwrap();
    backend.setAcousticRoutes(99, { fallback: 0, buses: [{ bus: 'game', gain: 1 }] });
    expect(backend.getState().lastError).toBeNull();
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
