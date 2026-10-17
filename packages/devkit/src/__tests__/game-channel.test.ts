import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';
import { expect, it, vi } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { generatedPlayerQueries } from './generated-player-queries.js';

async function evaluate(source: string, values: Record<string, unknown>, dev: boolean) {
  const transformed = await transformWithOxc(
    source
      .replaceAll('import.meta.env.DEV', String(dev))
      .replaceAll('import.meta.url', JSON.stringify('https://game.test/main.js')),
    'generated-channel.ts',
    { lang: 'ts' },
  );
  return runInNewContext(transformed.code, values);
}

it('connects isolated frontend/source ports through the generated App options and owns cleanup', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-game-channel-'));
  const channels: MessageChannel[] = [];
  const cleanups: Array<() => void> = [];
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'channel-game',
        name: 'Channel game',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    await writeFile(resolve(root, 'package.json'), '{"name":"channel-game"}');
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    await createViteConfig(facts.value, 'build');
    const generated = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
    const bootstrap = await readFile(
      resolve(root, '.forgeax/generated/execution-bootstrap.ts'),
      'utf8',
    );
    const pluginStart = generated.indexOf('const appBootstrapPlugin =');
    const applyStart =
      generated.indexOf('async apply(ctx) {', pluginStart) + 'async apply(ctx) {'.length;
    const callEnd = generated.indexOf('if (!result.ok)', applyStart);
    expect(pluginStart).toBeGreaterThan(-1);
    expect(callEnd).toBeGreaterThan(applyStart);
    const frontendStart = generated.indexOf(
      "const uiRoot = document.querySelector('#game-ui');",
      callEnd,
    );
    const frontendEnd = generated.indexOf("ctx.provide('gameHost', host);", frontendStart);
    const sourceMarker = "ctx.provide('gameHost', ";
    const sourceStart = bootstrap.indexOf(sourceMarker);
    const sourceEnd =
      bootstrap.indexOf('} satisfies GameHost);', sourceStart) + '} satisfies GameHost'.length;
    expect(frontendStart).toBeGreaterThan(callEnd);
    expect(sourceStart).toBeGreaterThan(-1);
    const requests: string[] = [];
    for (const dev of [false, true]) {
      for (const engine of [false, true]) {
        const presentationCanvas = {};
        const document = Object.assign(new EventTarget(), {
          baseURI: 'https://game.test/',
          querySelector: () => null,
          body: {},
          pointerLockElement: null as object | null,
        });
        const removeListener = vi.spyOn(document, 'removeEventListener');
        const { options, controlMode } = await evaluate(
          `(async () => { ${generatedPlayerQueries(generated)} ${generated.slice(applyStart, callEnd)} return { options: result, controlMode }; })()`,
          {
            crypto: globalThis.crypto,
            serveRuntimePackDelivery: () => () => {},
            URLSearchParams,
            location: { search: '' },
            bootstrapRoot: 'project-bootstrap',
            resource: undefined,
            recipeValue: null,
            workerExecution: true,
            executionWorkers: { engine },
            animation: JSON.parse(/const animation = (\{[^\n]+\});/.exec(generated)?.[1] ?? 'null'),
            canvas: presentationCanvas,
            bundler: {},
            runtimeScopeBinding: { catalogUrl: 'https://game.test/catalog.json' },
            document,
            window: {
              matchMedia: () => ({ matches: dev }),
              addEventListener: vi.fn(),
              removeEventListener: vi.fn(),
            },
            resizeObserver: { disconnect: vi.fn() },
            URL,
            forgeaxBundlerAdapter: () => ({}),
            ctx: { effect: (effect: () => () => void) => cleanups.push(effect()) },
            MessageChannel: class extends MessageChannel {
              constructor() {
                super();
                channels.push(this);
              }
            },
            createApp: (_canvas: unknown, value: unknown) => value,
          },
          dev,
        );
        expect(options.execution.bootstrapPort).toBeDefined();
        const channel = channels.at(-1);
        if (channel === undefined) throw new Error('generated host did not allocate a channel');
        expect(options.execution.bootstrapPort).toBe(channel.port2);
        expect(options.execution.workers.engine).toBe(engine);
        expect(controlMode.read()).toBe(dev ? 'touch' : 'pointer');
        const changed = vi.fn();
        const unsubscribeMode = controlMode.subscribe(changed);
        const pointer = (pointerType: string) => {
          document.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerType }));
        };
        pointer('touch');
        expect(controlMode.read()).toBe('touch');
        pointer('mouse');
        expect(controlMode.read()).toBe('pointer');
        const mouseNotifications = changed.mock.calls.length;
        pointer('pen');
        pointer('unknown');
        expect(changed).toHaveBeenCalledTimes(mouseNotifications);
        document.pointerLockElement = presentationCanvas;
        document.dispatchEvent(new Event('pointerlockchange'));
        expect(controlMode.read()).toBe('pointer-locked');
        document.pointerLockElement = null;
        document.dispatchEvent(new Event('pointerlockchange'));
        expect(controlMode.read()).toBe('pointer');
        unsubscribeMode();
        const notifications = changed.mock.calls.length;
        pointer('touch');
        expect(changed).toHaveBeenCalledTimes(notifications);
        // This check runs after the generated Host's own cleanup below.
        cleanups.unshift(() => {
          expect(removeListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), {
            capture: true,
          });
          expect(removeListener).toHaveBeenCalledWith('pointerlockchange', expect.any(Function));
          pointer('mouse');
          expect(controlMode.read()).toBe('touch');
        });
        const sourcePort = engine
          ? structuredClone(channel.port2, { transfer: [channel.port2] })
          : channel.port2;
        const provided = new Map<string, unknown>();
        let canvas = { width: 320, height: 180 };
        let sourceSize = { width: 320, height: 180 };
        const frontend = await evaluate(
          `${generated.slice(frontendStart, frontendEnd)} host;`,
          {
            document: { querySelector: () => ({}), body: {} },
            HTMLElement: class {},
            ctx: { provide: (key: string, value: unknown) => provided.set(key, value) },
            app: {
              get canvas() {
                return canvas;
              },
            },
            assets: {},
            canvas,
            gameChannel: channel,
            controlMode,
          },
          dev,
        );
        const source = await evaluate(
          `(${bootstrap.slice(sourceStart + sourceMarker.length, sourceEnd)})`,
          {
            ctx: {
              world: {},
              executionBootstrapHost: {
                port: sourcePort,
                drawingBufferSize: () => sourceSize,
              },
            },
            assets: {},
            gameProjection: {},
          },
          dev,
        );
        expect(frontend.port).toBe(channel.port1);
        expect(frontend.controlMode).toBe(controlMode);
        expect(source.port).toBe(sourcePort);
        expect(source.canvas).toBeUndefined();
        expect(source.drawingBufferSize()).toEqual(sourceSize);
        expect(frontend.drawingBufferSize()).toEqual(canvas);
        canvas = { width: 640, height: 360 };
        sourceSize = { width: 640, height: 360 };
        expect(source.drawingBufferSize()).toEqual(sourceSize);
        expect(frontend.drawingBufferSize()).toEqual(canvas);
        source.port.onmessage = (event: MessageEvent) => {
          requests.push(event.data.id);
          source.port.postMessage({ id: event.data.id, phase: 'playing' });
        };
        const id = `${dev}-${engine}`;
        const response = new Promise((resolveMessage) => {
          frontend.port.onmessage = (event: MessageEvent) => resolveMessage(event.data);
        });
        frontend.port.postMessage({ id, action: 'enter' });
        await expect(response).resolves.toEqual({ id, phase: 'playing' });
        // Keep all previous channels open: a later request must reach only its own source.
        expect(requests).toHaveLength(channels.length);
        if (engine) cleanups.push(() => sourcePort.close());
      }
    }
    const closing = channels.map((channel) => vi.spyOn(channel.port1, 'close'));
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    for (const close of closing) expect(close).toHaveBeenCalledOnce();

    // View binds a project to its Host and runs the Engine in that same realm.
    // The UI still needs the other end of the channel; otherwise its form
    // performs a browser navigation instead of sending a generate request.
    const bound = await createViteConfig(facts.value, 'serve', '/', {
      host: {
        backend: {
          assembly: { current: { sessionGeneration: 1 } },
          context: { get: () => undefined },
        },
        workspace: {
          execution: 'game',
          sessionId: 'game-session',
          targetId: 'game-target',
          admissionToken: 'game-token',
        },
      } as never,
    });
    if (!bound.root) throw new Error('Host-bound game root was not generated');
    const boundSource = await readFile(resolve(bound.root, 'main.ts'), 'utf8');
    expect(boundSource).toContain('const executionWorkers = null;');
    const channelStart = boundSource.indexOf('const gameChannel =');
    const channelEnd = boundSource.indexOf('const runtimePacks =', channelStart);
    expect(channelStart).toBeGreaterThan(-1);
    const channel = (await evaluate(
      `(() => { ${boundSource.slice(channelStart, channelEnd)} return gameChannel; })()`,
      {
        workerExecution: false,
        bootstrapRoot: 'project-bootstrap',
        workspaceMode: false,
        MessageChannel,
        ctx: { effect: (effect: () => () => void) => cleanups.push(effect()) },
      },
      true,
    )) as MessageChannel;
    expect(channel).toBeInstanceOf(MessageChannel);
    const response = new Promise((resolveMessage) => {
      channel.port1.onmessage = (event: MessageEvent) => resolveMessage(event.data);
    });
    channel.port2.postMessage({ channel: 'game-3d/runtime-vase', kind: 'state' });
    await expect(response).resolves.toEqual({ channel: 'game-3d/runtime-vase', kind: 'state' });
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});
