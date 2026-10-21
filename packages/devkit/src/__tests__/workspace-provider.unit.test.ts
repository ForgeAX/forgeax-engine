import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import {
  createApp,
  createEngineWorkspaceRuntime,
  ENGINE_WORKSPACE_COMMAND_TOPIC,
  type EngineWorkspaceRuntimePackRequest,
  type EngineWorkspaceTarget,
  engineWorkspaceBrowserPlugin,
  engineWorkspaceResultService,
} from '@forgeax/engine-app';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { createHostAssembly } from '@forgeax/engine-host/protocol';
import type { HostTransportClient } from '@forgeax/engine-host/transport';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { definePackageId } from '@forgeax/engine-pack/source';
import { startPluginAsset } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import type { ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createViteConfig: vi.fn(async () => ({})),
}));

vi.mock('../host.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../host.js')>()),
  createViteConfig: mocks.createViteConfig,
}));

import { validateHostBinding } from '../host-binding.js';
import { devKitWorkspacePlugin } from '../workspace-plugin.js';
import { createDevKitWorkspaceProvider, waitForRuntimeCatalog } from '../workspace-provider.js';

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-workspace-provider-'));
  roots.push(root);
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'workspace-game',
        name: 'Workspace Game',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    ),
    writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'workspace-game', forgeax: {} }),
    ),
  ]);
  return root;
}

afterEach(async () => {
  mocks.createViteConfig.mockClear();
  vi.unstubAllGlobals();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

function fakeServer() {
  return {
    resolvedUrls: { local: ['http://127.0.0.1:43123/'] },
    httpServer: undefined,
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as ViteDevServer;
}

async function ready(client: HostTransportClient, target: EngineWorkspaceTarget, root: string) {
  client.subscribe(ENGINE_WORKSPACE_COMMAND_TOPIC, (value) => {
    const command = value as WorkspaceCommandFixture;
    if (
      command.kind !== 'command' ||
      command.operation !== 'closeWorkspace' ||
      command.sessionId !== target.sessionId
    )
      return;
    void client.request(engineWorkspaceResultService(target.targetId), {
      kind: 'result',
      id: command.id,
      sessionId: target.sessionId,
      targetId: target.targetId,
      ok: true,
      value: { cleanup: 'completed' },
    });
  });
  await client.request(engineWorkspaceResultService(target.targetId), {
    kind: 'ready',
    id: target.sessionId,
    sessionId: target.sessionId,
    targetId: target.targetId,
    project: { id: 'workspace-game', root: await realpath(root), name: 'Workspace Game' },
    target,
  });
}

function frontendPage(
  backend: Awaited<ReturnType<typeof createBackendHost>>,
  target: EngineWorkspaceTarget,
): HostTransportClient {
  return backend.transport.connect({
    kind: 'frontend',
    sourceId: `forgeax-workspace:${target.sessionId}:${target.targetId}`,
  });
}

type WorkspaceCommandFixture = {
  readonly kind: 'command' | 'cancel';
  readonly id: string;
  readonly sessionId: string;
  readonly operation?: string;
  readonly input?: {
    readonly asset?: unknown;
    readonly previewOwner?: string;
    readonly targetId?: string;
    readonly previewTargetId?: string;
    readonly worldId?: string;
    readonly request?: EngineWorkspaceRuntimePackRequest;
    readonly connectionId?: string;
  };
};

describe('DevKit workspace provider', () => {
  it.each([
    false,
    true,
  ])('settles a closing page disconnect without waiting for timeout (prior failure: %s)', async (failed) => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    const server = fakeServer();
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => server,
    });
    let page: HostTransportClient | undefined;
    let closing: Promise<void> | undefined;
    try {
      const opened = await provider.openProject({ root });
      assert(opened.target);
      const target = { ...opened.target, worldId: 'closing-world' };
      page = frontendPage(backend, target);
      const client = page;
      client.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
        if (command.kind === 'command' && command.operation === 'closeWorkspace') client.close();
      });
      await client.request(engineWorkspaceResultService(target.targetId), {
        kind: 'ready',
        id: target.sessionId,
        sessionId: target.sessionId,
        targetId: target.targetId,
        project: opened.project,
        target,
      });
      if (failed)
        await client.request(engineWorkspaceResultService(target.targetId), {
          kind: 'failed',
          id: 'failed-world',
          sessionId: target.sessionId,
          targetId: target.targetId,
          error: {
            code: 'engine-workspace-target-failed',
            expected: 'A healthy World',
            hint: 'The old World failed.',
            detail: {},
          },
        });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      closing = Promise.resolve(provider.closeProject(opened));
      // The real Host disconnect must settle the pending close without advancing its deadline.
      await setImmediate();
      expect(server.close).toHaveBeenCalledOnce();
      await closing;
      expect(opened.failure).toMatchObject({
        code: 'engine-workspace-page-lost',
        detail: { cleanup: 'unconfirmed' },
      });
    } finally {
      await vi.advanceTimersByTimeAsync(120_000);
      vi.useRealTimers();
      await closing?.catch(() => {});
      page?.close();
      await Promise.resolve(provider.dispose?.()).catch(() => {});
      await backend.dispose();
    }
  });
  it('invalidates the headed target when its sampled presentation lease retires', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    const assembly = createHostAssembly({
      root: { program: 'fixture/frontend', codeRevision: 'one' },
    });
    const frontend = await backend.context.plugin({
      provide: ['devkitWorkspaceFrontend'],
      apply(ctx) {
        ctx.provide('devkitWorkspaceFrontend', {
          assembly,
          module: { specifier: 'fixture/frontend' },
        });
      },
    });
    await frontend.await();
    const provider = createDevKitWorkspaceProvider({
      hostBinding: {
        backend,
        get frontendAssembly() {
          return backend.context.get('devkitWorkspaceFrontend')?.assembly;
        },
      },
      viteServerFactory: async () => fakeServer(),
    });
    let page: HostTransportClient | undefined;
    try {
      const session = await provider.openProject({ root });
      assert(session.target);
      page = frontendPage(backend, session.target);
      await ready(page, session.target, root);
      expect(session.phase).toBe('running');
      await frontend.dispose();
      expect(session.phase).toBe('failed');
      expect(session.failure).toMatchObject({ code: 'engine-workspace-page-lost' });
      expect(backend.context.fiber.uid).not.toBeNull();
    } finally {
      await provider.dispose?.();
      page?.close();
      await backend.dispose();
    }
  });

  it.each([
    false,
    true,
  ])('retires an unacknowledged close after losing its original connection (reconnect: %s)', async (reconnect) => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      readyTimeoutMs: 50,
      viteServerFactory: async () => fakeServer(),
    });
    const runtime = createEngineWorkspaceRuntime(provider);
    let page: HostTransportClient | undefined;
    let replacement: HostTransportClient | undefined;
    try {
      const opened = await runtime.openProject({ root });
      assert(opened.target);
      const target = { ...opened.target, worldId: 'unacknowledged-world' };
      page = frontendPage(backend, target);
      let acknowledge!: () => void;
      const sent = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
        if (command.kind === 'command' && command.operation === 'closeWorkspace') acknowledge();
      });
      await page.request(engineWorkspaceResultService(target.targetId), {
        kind: 'ready',
        id: target.sessionId,
        sessionId: target.sessionId,
        targetId: target.targetId,
        project: opened.project,
        target,
      });
      const closing = expect(runtime.closeProject(opened)).rejects.toMatchObject({
        code: 'engine-workspace-result-timeout',
      });
      await sent;
      if (reconnect) replacement = frontendPage(backend, target);
      await closing;
      page.close();
      const reopened = await runtime.openProject({
        root,
        expectedTargetId: target.targetId,
        expectedTargetState: 'lost',
      });
      expect(reopened.target?.sessionId).not.toBe(target.sessionId);
      expect(opened.failure).toMatchObject({
        code: 'engine-workspace-page-lost',
        detail: { cleanup: 'unconfirmed' },
      });
    } finally {
      replacement?.close();
      page?.close();
      await runtime.dispose().catch(() => {});
      await backend.dispose();
    }
  });
  it('retains an incomplete close as the authority for later reopen and dispose attempts', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const servers = vi.fn(async () => fakeServer());
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: servers,
    });
    let page: HostTransportClient | undefined;
    try {
      const opened = await provider.openProject({ root });
      assert(opened.target);
      const target = { ...opened.target, worldId: 'cleanup-world' };
      page = frontendPage(backend, target);
      const client = page;
      client.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
        if (command.kind !== 'command' || command.operation !== 'closeWorkspace') return;
        void client.request(engineWorkspaceResultService(target.targetId), {
          kind: 'result',
          id: command.id,
          sessionId: target.sessionId,
          targetId: target.targetId,
          ok: false,
          error: {
            code: 'engine-workspace-plugin-cleanup-timeout',
            expected: 'Native cleanup to complete',
            hint: 'Cleanup is not complete',
            detail: { cleanup: 'timeout' },
          },
        });
      });
      await client.request(engineWorkspaceResultService(target.targetId), {
        kind: 'ready',
        id: target.sessionId,
        sessionId: target.sessionId,
        targetId: target.targetId,
        project: opened.project,
        target,
      });
      await expect(provider.closeProject(opened)).rejects.toMatchObject({
        code: 'engine-workspace-plugin-cleanup-timeout',
      });
      client.close();
      await expect(provider.openProject({ root })).rejects.toMatchObject({
        code: 'engine-workspace-plugin-cleanup-timeout',
      });
      expect(servers).toHaveBeenCalledOnce();
      await expect(provider.dispose?.()).rejects.toMatchObject({
        code: 'engine-workspace-plugin-cleanup-timeout',
      });
    } finally {
      page?.close();
      await Promise.resolve(provider.dispose?.()).catch(() => {});
      await backend.dispose();
    }
  });
  it.each([
    'healthy',
    'failed',
    'lost',
  ] as const)('closes pre-preview Workspace installations in a %s borrowed page while retaining the game App across project reopen', async (health) => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => fakeServer(),
    });
    const world = new World();
    const runtime = createEngineWorkspaceRuntime(provider);
    world.insertResource('project-plugin-fibers', new Set<number>());
    const app = (
      await createApp({
        platform: {
          now: () => ok(performance.now()),
          requestFrame: () => ok(() => {}),
          display: () =>
            ok({
              width: 64,
              height: 64,
              pixelRatio: 1,
              drawingWidth: 64,
              drawingHeight: 64,
              safeArea: { x: 0, y: 0, width: 64, height: 64 },
            }),
          visible: () => true,
          subscribe: () => ok(() => {}),
          dispose() {},
        },
        world,
        assets: new AssetRegistry({ shaderRegistry: {} as never }),
        assetCatalog: createCatalogSource({ entries: [] }),
        renderer: {
          ready: Promise.resolve({ ok: true, value: undefined }),
          draw: () => ({ ok: true, value: undefined }),
          onError: () => () => {},
          onLost: () => () => {},
          dispose() {},
        } as unknown as Renderer,
        pluginPrograms: {
          sessionId: 'test',
          contextId: 'engine',
          sessionGeneration: 1,
          target: 'engine',
          tools: new Map(),
          programs: new Map(),
          definitions: new Map(),
        },
        runtimePacks: { scopeId: 'workspace-close-test' },
      })
    ).unwrap();
    let page: HostTransportClient | undefined;
    try {
      const opened = await runtime.openProject({ root });
      assert(opened.target && provider.runtimePack);
      page = frontendPage(backend, opened.target);
      const target = { ...opened.target, worldId: world.identity };
      const browser = await app.pluginContext.plugin(engineWorkspaceBrowserPlugin, {
        app,
        project: opened.project,
        target,
        transport: page,
        canvas: {
          ownerDocument: { documentElement: { dataset: {}, removeAttribute() {} } },
        } as unknown as HTMLCanvasElement,
      });
      await browser.await();
      const packageId = '01900000-0000-7000-8000-000000000361';
      const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
      const input = {
        ...opened,
        targetId: target.targetId,
        worldId: target.worldId,
        connectionId: 'view-connection',
      };
      await provider.runtimePack({
        ...input,
        request: {
          operation: 'admit',
          content: {
            source: {
              schemaVersion: '3.0.0',
              packageId,
              assets: {
                behavior: { kind: 'plugin', payload: { module: { specifier: './behavior.js' } } },
              },
            },
            programs: {
              'project:workspace-close.js#default': {
                artifact: preparePackProgram({
                  entry: 'behavior.js',
                  export: 'default',
                  modules: {
                    'behavior.js': `export default { inject: ['world'], apply(ctx) {
            const entries = ctx.world.getResource('project-plugin-fibers'); const id = ctx.fiber.uid;
            ctx.effect(() => { entries.add(id); return () => entries.delete(id); });
          } };`,
                  },
                }).unwrap(),
              },
            },
          },
        },
      });
      const game = (await startPluginAsset(app.pluginContext, guid)).unwrap();
      expect(
        await provider.runtimePack({ ...input, request: { operation: 'plugin-install', guid } }),
      ).toMatchObject({ state: 'active' });
      const entries = world.getResource<Set<number>>('project-plugin-fibers');
      expect(entries?.size).toBe(2);
      if (health === 'failed')
        await page.request(engineWorkspaceResultService(target.targetId), {
          kind: 'failed',
          id: 'world-failed',
          sessionId: target.sessionId,
          targetId: target.targetId,
          error: {
            code: 'app-system-update-failed',
            expected: 'A healthy World',
            hint: 'Repair the failed system',
          },
        });
      if (health === 'lost') {
        page.close();
        await vi.waitFor(() => expect(entries?.size).toBe(1));
        expect(opened.phase).toBe('starting');
        expect(opened.failure).toBeUndefined();
      } else await runtime.closeProject(opened);
      expect(entries?.size).toBe(1);
      assert(game.uid !== null);
      expect(entries?.has(game.uid)).toBe(true);
      expect(page.connected).toBe(health !== 'lost');
      expect(app.pluginContext.runtimePacks?.producer.inspect().packs).toHaveLength(1);
      const reopened = await runtime.openProject({ root });
      if (health === 'lost') expect(opened.failure).toBeUndefined();
      await expect(
        provider.runtimePack({ ...input, request: { operation: 'plugin-install', guid } }),
      ).rejects.toMatchObject({ code: 'engine-workspace-session-closed' });
      expect(reopened.target?.sessionId).not.toBe(target.sessionId);
      assert(game.uid !== null);
      expect(entries?.has(game.uid)).toBe(true);
      await runtime.closeProject(reopened);
      await game.dispose();
      await browser.dispose();
    } finally {
      page?.close();
      await runtime.dispose();
      await app.dispose();
      await backend.dispose();
    }
  });
  it('prepares TS on the producer and sends only portable runtime content to the ready actual World', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => fakeServer(),
    });
    let page: HostTransportClient | undefined;
    try {
      const project = await provider.openProject({ root });
      assert(project.target && provider.runtimePack && provider.prepareRuntimePackProgram);
      page = frontendPage(backend, project.target);
      const target = { ...project.target, worldId: 'actual-content-world' };
      const prepared = await provider.prepareRuntimePackProgram({
        ...project,
        source: {
          entry: 'generator.ts',
          export: 'build',
          modules: {
            'generator.ts': 'export function build(value: number): number { return value * 2; }',
          },
        },
      });
      expect(prepared).toMatchObject({
        source: { entry: 'generator.ts' },
        artifact: {
          entry: 'generator.js',
          modules: { 'generator.js': expect.not.stringContaining(': number') },
        },
      });
      const commands: WorkspaceCommandFixture[] = [];
      const contentPage = page;
      const cancel = new Promise<void>((resolve) => {
        contentPage.subscribe(ENGINE_WORKSPACE_COMMAND_TOPIC, (value) => {
          const command = value as WorkspaceCommandFixture;
          if (command.operation === 'closeWorkspace') return;
          commands.push(command);
          if (command.kind === 'cancel') {
            resolve();
            return;
          }
          if (command.input?.request?.operation === 'generate') return;
          void contentPage.request(engineWorkspaceResultService(target.targetId), {
            kind: 'result',
            id: command.id,
            sessionId: target.sessionId,
            targetId: target.targetId,
            ok: true,
            value: { imports: {}, packs: [], executions: [] },
          });
        });
      });
      const input = {
        ...project,
        targetId: target.targetId,
        worldId: target.worldId,
        connectionId: 'view-connection',
      };
      const inspection = provider.runtimePack({ ...input, request: { operation: 'inspect' } });
      expect(commands).toHaveLength(0);
      await ready(page, target, root);
      await expect(inspection).resolves.toEqual({ imports: {}, packs: [], executions: [] });
      expect(project.target.worldId).toBe(target.worldId);
      expect(commands[0]?.input).toEqual({
        targetId: target.targetId,
        worldId: target.worldId,
        connectionId: 'view-connection',
        request: { operation: 'inspect' },
      });
      await expect(
        provider.runtimePack({
          ...input,
          worldId: 'pending:old-world',
          request: { operation: 'inspect' },
        }),
      ).rejects.toMatchObject({ code: 'engine-workspace-target-stale' });
      expect(commands).toHaveLength(1);
      const controller = new AbortController();
      const generating = provider.runtimePack({
        ...input,
        signal: controller.signal,
        request: {
          operation: 'generate',
          instance: {
            schemaVersion: '3.0.0',
            packageId: '01900000-0000-7000-8000-000000000351',
            parent: '01900000-0000-7000-8000-000000000350',
            values: {},
          },
        },
      });
      await vi.waitFor(() => expect(commands).toHaveLength(2));
      controller.abort();
      await expect(generating).rejects.toBeDefined();
      await cancel;
      expect(commands.at(-1)).toMatchObject({ kind: 'cancel', id: commands[1]?.id });
    } finally {
      page?.close();
      await provider.dispose?.();
      await backend.dispose();
    }
  });
  it.each([
    undefined,
    0,
    41234,
  ])('materializes the requested port %s before Vite starts', async (port) => {
    const root = await projectRoot();
    const provider = createDevKitWorkspaceProvider({
      ...(port === undefined ? {} : { port }),
      viteServerFactory: async () => fakeServer(),
    });
    try {
      await provider.openProject({ root });
      const call = mocks.createViteConfig.mock.calls[0] as unknown as [
        unknown,
        unknown,
        unknown,
        { server: { port: number; strictPort: boolean } },
      ];
      const options = call[3];
      expect(options.server.port).toBeGreaterThan(0);
      expect(options.server.strictPort).toBe(true);
      if (port) expect(options.server.port).toBe(port);
    } finally {
      await provider.dispose?.();
    }
  });

  it.each([
    undefined,
    { specifier: 'platform/frontend.mjs', prepare: 'preparePlatform' },
  ])('keeps editor and Play sessions on one backend with platform %j', async (frontendModule) => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const servers: ViteDevServer[] = [];
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      hostBinding: { backend, ...(frontendModule ? { frontendModule } : {}) },
      viteServerFactory: async () => {
        const server = fakeServer();
        servers.push(server);
        return server;
      },
    });
    try {
      const project = await provider.openProject({ root });
      assert(project.target && provider.startPlay);
      const editor = frontendPage(backend, project.target);
      await ready(editor, { ...project.target, worldId: 'editor-world' }, root);
      const oldAssembly = backend.assembly.current.revision;
      for (let cycle = 0; cycle < 10; cycle++) {
        const game = await provider.startPlay(project);
        assert(game.tools && game.close && game.target.url);
        expect(game.browserGeneration).toBe(0);
        const gameTools = game.tools;
        expect(game.target.targetId).not.toBe(project.target.targetId);
        expect(new URL(game.target.url).searchParams.get('forgeaxWorkspace')).toBe('game');
        const call = mocks.createViteConfig.mock.calls.at(-1) as unknown as [
          { root: string },
          string,
          string,
          {
            host: {
              backend: unknown;
              frontendAssembly?: unknown;
              frontendModule?: unknown;
              workspace: { execution: string };
            };
          },
        ];
        expect(call[0].root).toBe(await realpath(root));
        expect(call[3].host.backend).toBe(backend);
        expect(call[3].host.frontendAssembly).toBeUndefined();
        expect(call[3].host.frontendModule).toEqual(frontendModule);
        expect(call[3].host.workspace.execution).toBe('game');
        const page = frontendPage(backend, game.target);
        const commands: WorkspaceCommandFixture[] = [];
        const respond = (connection: typeof page) => (payload: unknown) => {
          const command = payload as WorkspaceCommandFixture;
          if (command.operation === 'closeWorkspace') return;
          if (command.sessionId !== game.target.sessionId || command.kind !== 'command') return;
          commands.push(command);
          void connection.request(engineWorkspaceResultService(game.target.targetId), {
            kind: 'result',
            id: command.id,
            sessionId: game.target.sessionId,
            targetId: game.target.targetId,
            ok: true,
            value:
              command.operation === 'resize'
                ? {
                    target: {
                      ...game.target,
                      width: (command.input as { width: number }).width,
                      height: (command.input as { height: number }).height,
                    },
                  }
                : { marker: 'actual-game' },
          });
        };
        const unsubscribe = page.subscribe(ENGINE_WORKSPACE_COMMAND_TOPIC, respond(page));
        let earlyTreeSettled = false;
        const earlyTree = Promise.resolve(game.tools.tree?.()).then((value) => {
          earlyTreeSettled = true;
          return value;
        });
        await setImmediate();
        expect(earlyTreeSettled).toBe(false);
        expect(commands).toHaveLength(0);
        await ready(page, { ...game.target, worldId: `game-${cycle}` }, call[0].root);
        expect(await earlyTree).toEqual({ marker: 'actual-game' });
        expect(commands.filter((command) => command.operation === 'scene.tree.get')).toHaveLength(
          1,
        );
        await game.ready();
        expect(game.browserGeneration).toBe(1);
        expect(game.target.worldId).toBe(`game-${cycle}`);
        expect(await game.tools.inspect({ entityId: 'entity' })).toEqual({
          marker: 'actual-game',
        });
        expect(game.resize).toBeDefined();
        const resized = await game.resize?.({
          targetId: game.target.targetId,
          width: 777,
          height: 444,
        });
        expect(resized).toMatchObject({ width: 777, height: 444 });
        expect(game.target).toMatchObject({ width: 777, height: 444 });
        if (cycle === 0) {
          page.close();
          await vi.waitFor(() => expect(game.phase).toBe('starting'));
          await expect(Promise.resolve().then(() => gameTools.tree())).rejects.toMatchObject({
            code: 'engine-workspace-browser-detached',
          });
          const replacement = frontendPage(backend, game.target);
          const unsubscribeReplacement = replacement.subscribe(
            ENGINE_WORKSPACE_COMMAND_TOPIC,
            respond(replacement),
          );
          await ready(replacement, { ...game.target, worldId: 'game-reloaded' }, call[0].root);
          expect(game.phase).toBe('running');
          expect(game.browserGeneration).toBe(2);
          expect(game.target.worldId).toBe('game-reloaded');
          await expect(gameTools.tree()).resolves.toEqual({ marker: 'actual-game' });
          unsubscribeReplacement();
          replacement.close();
        }
        await game.close();
        await game.close();
        expect(servers.at(-1)?.close).toHaveBeenCalledOnce();
        expect(servers[0]?.close).not.toHaveBeenCalled();
        expect(backend.assembly.current.revision).toBe(oldAssembly);
        unsubscribe();
        page.close();
      }
      await provider.closeProject(project);
      expect(servers[0]?.close).toHaveBeenCalledOnce();
      editor.close();
    } finally {
      await provider.dispose?.();
      await backend.dispose();
    }
  });
  it('stops catalog polling on a terminal producer failure and preserves its source', async () => {
    let requests = 0;
    const diagnostic = JSON.stringify({
      error: 'scan-failed',
      cause: { detail: { sourcePath: 'assets/character.pack.ts', timeoutMs: 120_000 } },
    });
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(diagnostic);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address !== null && typeof address !== 'string');
    try {
      await expect(
        waitForRuntimeCatalog(`http://127.0.0.1:${address.port}`, 'game', 120_000),
      ).rejects.toMatchObject({
        code: 'engine-workspace-catalog-not-ready',
        detail: { lastStatus: 500, lastResponseBody: diagnostic },
      });
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 5000);

  it('retains the bounded producer body when catalog readiness expires', async () => {
    const diagnostic = JSON.stringify({
      code: 'pack-producer-failed',
      stage: 'cook',
      detail: 'bad source',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(diagnostic, {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(
      waitForRuntimeCatalog('http://127.0.0.1:43123/', 'workspace-game', 25),
    ).rejects.toMatchObject({
      code: 'engine-workspace-catalog-not-ready',
      detail: expect.objectContaining({
        lastStatus: 503,
        lastResponseBody: diagnostic,
      }),
    });
  });

  it('cancels the real Pack catalog readiness probe with the caller signal', async () => {
    const root = await projectRoot();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort(new Error('catalog probe cancelled'));
      return { status: 503, ok: false, body: null };
    });
    vi.stubGlobal('fetch', fetchMock);
    let server: ReturnType<typeof fakeServer> | undefined;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 1_000,
      backendFactory: async () => createBackendHost(),
      viteServerFactory: async () => {
        server = { ...fakeServer(), httpServer: {} } as ReturnType<typeof fakeServer>;
        return server;
      },
    });
    const pending = provider.openProject({ root, signal: controller.signal });
    await expect(pending).rejects.toThrow('catalog probe cancelled');
    expect(fetchMock).toHaveBeenCalled();
    expect(server?.close).toHaveBeenCalledOnce();
  });

  it('returns a provisional loopback target and uses the display host page as the only browser realm', async () => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    let server: ReturnType<typeof fakeServer> | undefined;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => {
        server = fakeServer();
        return server;
      },
    });

    const opened = await provider.openProject({ root });
    const canonicalRoot = await realpath(root);
    expect(opened.project).toEqual({
      id: 'workspace-game',
      root: canonicalRoot,
      name: 'Workspace Game',
      assetRoots: ['assets'],
    });
    const target = opened.target;
    if (target === undefined) throw new Error('provider fixture did not return a target');
    expect(target.url).toMatch(/^http:\/\/127\.0\.0\.1:43123\/\?forgeaxWorkspace=1/);
    expect(target.worldId).toMatch(/^pending:workspace-/);
    expect(server?.listen).toHaveBeenCalledOnce();
    expect(mocks.createViteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'workspace-game', root: canonicalRoot }),
      'serve',
      '/',
      expect.objectContaining({ host: expect.objectContaining({ backend }) }),
    );

    if (backend === undefined) throw new Error('provider fixture did not open');
    const page = frontendPage(backend, target);
    const commands: unknown[] = [];
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
      if (command.operation === 'closeWorkspace') return;
      commands.push(command);
      if (typeof command !== 'object' || command === null || command.kind !== 'command') return;
      const value =
        command.operation === 'listAssets'
          ? [{ guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true }]
          : command.operation === 'openPreview'
            ? {
                target: { ...target, worldId: 'world-1', width: 800, height: 600 },
                asset: command.input?.asset,
                previewOwner: command.id,
              }
            : command.operation === 'capture'
              ? {
                  targetId: target.targetId,
                  frameId: 17,
                  width: 800,
                  height: 600,
                  png: 'data:image/png;base64,fixture',
                }
              : command.operation === 'camera.get'
                ? { camera: { position: [0, 1, 2] }, version: 0 }
                : command.operation === 'target.pick'
                  ? { entityId: 'entity', frameId: 17 }
                  : { closed: true, targetId: target.targetId };
      void page.request(engineWorkspaceResultService(target.targetId), {
        kind: 'result',
        id: command.id,
        sessionId: command.sessionId,
        targetId: target.targetId,
        ok: true,
        value,
      });
    });
    const firstAssets = provider.listAssets({ project: opened.project, handle: opened.handle });
    const secondAssets = provider.listAssets({ project: opened.project, handle: opened.handle });
    await ready(page, { ...target, worldId: 'world-1' }, root);

    const [assets, concurrentAssets] = await Promise.all([firstAssets, secondAssets]);
    expect(assets).toEqual([
      { guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true },
    ]);
    expect(concurrentAssets).toEqual(assets);
    const preview = await provider.openPreview({
      project: opened.project,
      projectHandle: opened.handle,
      asset:
        assets[0] ??
        (() => {
          throw new Error('fixture did not return an asset');
        })(),
      width: 800,
      height: 600,
    });
    expect(preview.target).toMatchObject({
      targetId: target.targetId,
      worldId: 'world-1',
      width: 800,
      height: 600,
    });
    const pickEvents: unknown[] = [];
    const unsubscribePick = page.subscribe('engine.workspace.picked', (event) =>
      pickEvents.push(event),
    );
    const previewOwner = (commands as WorkspaceCommandFixture[]).find(
      (command) => command.operation === 'openPreview',
    )?.id;
    for (const kind of ['picked', 'pick-error']) {
      await page.request(engineWorkspaceResultService(target.targetId), {
        kind,
        sessionId: target.sessionId,
        targetId: target.targetId,
        previewOwner,
        result: { entityId: 'entity' },
        error: { code: 'engine-workspace-frame-unavailable' },
      });
    }
    expect(pickEvents).toEqual([]);
    unsubscribePick();
    expect(await preview.tools?.pick?.({ x: 12, y: 34 })).toEqual({
      entityId: 'entity',
      frameId: 17,
    });
    expect((commands.at(-1) as WorkspaceCommandFixture).operation).toBe('target.pick');
    expect(await preview.getCamera({ targetId: preview.target.targetId })).toEqual({
      camera: { position: [0, 1, 2] },
      version: 0,
    });
    if (preview.capture === undefined) throw new Error('provider fixture did not return capture');
    expect(await preview.capture({ targetId: preview.target.targetId })).toEqual({
      targetId: target.targetId,
      frameId: 17,
      width: 800,
      height: 600,
      png: 'data:image/png;base64,fixture',
    });
    await provider.closeProject({ project: opened.project, handle: opened.handle });
    const commandsAfterClose = commands.length;
    await expect(
      preview.revokeConnection?.({
        targetId: preview.target.targetId,
        connectionId: 'disconnected-browser',
      }),
    ).resolves.toBeUndefined();
    expect(commands).toHaveLength(commandsAfterClose);
    expect(
      commands.some((command) => (command as WorkspaceCommandFixture).operation === 'openPreview'),
    ).toBe(true);
    expect(server?.close).toHaveBeenCalledOnce();
    expect(page.connected).toBe(false);
  });

  it.each([
    { failChild: false, failClose: false, scene: false },
    { failChild: true, failClose: false, scene: false },
    { failChild: false, failClose: true, scene: false },
    { failChild: false, failClose: false, scene: true },
  ])('keeps previews independent and reports close completion: %j', async ({
    failChild,
    failClose,
    scene,
  }) => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => fakeServer(),
    });
    const opened = await provider.openProject({ root });
    const openedTarget = opened.target;
    if (backend === undefined || openedTarget === undefined)
      throw new Error('provider fixture did not open');
    const page = frontendPage(backend, openedTarget);
    const commands: WorkspaceCommandFixture[] = [];
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
      if (command.operation === 'closeWorkspace') return;
      commands.push(command);
      if (command.kind !== 'command') return;
      if (command.operation === 'resize' || command.operation === 'listAssets') return;
      if (failClose && command.operation === 'closePreview') {
        void page.request(engineWorkspaceResultService(openedTarget.targetId), {
          kind: 'result',
          id: command.id,
          sessionId: command.sessionId,
          targetId: openedTarget.targetId,
          ok: false,
          error: {
            code: 'engine-workspace-session-closed',
            expected: 'The preview owner to acknowledge cleanup',
            hint: 'The owner was lost before cleanup completed.',
          },
        });
        return;
      }
      const value =
        command.operation === 'openPreview'
          ? {
              target: {
                ...openedTarget,
                targetId: command.input?.previewTargetId,
                worldId: 'world-1',
                width: 320,
                height: 240,
              },
              asset: command.input?.asset,
              previewOwner: command.id,
            }
          : command.operation === 'camera.get'
            ? { camera: { position: [0, 1, 2] }, version: 0 }
            : command.operation === 'capture'
              ? {
                  targetId: openedTarget.targetId,
                  frameId: 3,
                  width: 320,
                  height: 240,
                  png: 'data:image/png;base64,replacement',
                }
              : { closed: true, targetId: openedTarget.targetId };
      void page.request(engineWorkspaceResultService(openedTarget.targetId), {
        kind: 'result',
        id: command.id,
        sessionId: command.sessionId,
        targetId:
          command.operation === 'closePreview' ? command.input?.targetId : openedTarget.targetId,
        ok: true,
        value,
      });
    });
    await ready(page, { ...openedTarget, worldId: 'world-1' }, root);

    const first = await provider.openPreview({
      project: opened.project,
      projectHandle: opened.handle,
      asset: { guid: 'mesh-a', kind: scene ? 'scene' : 'mesh' },
      width: 320,
      height: 240,
    });
    const replacement = await provider.openPreview({
      project: opened.project,
      projectHandle: opened.handle,
      asset: { guid: 'mesh-b', kind: 'mesh' },
      width: 320,
      height: 240,
    });

    expect(first.target.targetId === openedTarget.targetId).toBe(scene);
    expect(replacement.target.targetId).not.toBe(openedTarget.targetId);
    expect(replacement.target.targetId).not.toBe(first.target.targetId);
    expect(await replacement.getCamera({ targetId: replacement.target.targetId })).toMatchObject({
      version: 0,
    });
    expect(commands.at(-1)?.input?.targetId).toBe(replacement.target.targetId);
    if (failChild) {
      await page.request(engineWorkspaceResultService(openedTarget.targetId), {
        kind: 'failed',
        id: 'child-failure',
        sessionId: openedTarget.sessionId,
        targetId: replacement.target.targetId,
        error: {
          code: 'app-system-update-failed',
          expected: 'A healthy target',
          hint: 'Close this preview.',
        },
      });
      await expect(
        Promise.resolve().then(() =>
          replacement.getCamera({ targetId: replacement.target.targetId }),
        ),
      ).rejects.toMatchObject({ code: 'app-system-update-failed' });
    }
    expect(await first.getCamera({ targetId: first.target.targetId })).toMatchObject({
      version: 0,
    });
    const projectAssets = Promise.resolve(
      provider.listAssets({ project: opened.project, handle: opened.handle }),
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(() =>
      expect(commands.some((command) => command.operation === 'listAssets')).toBe(true),
    );
    const resizing = first
      .resize?.({ targetId: first.target.targetId, width: 640, height: 360 })
      .then(
        () => undefined,
        (error) => error,
      );
    await vi.waitFor(() =>
      expect(commands.some((command) => command.operation === 'resize')).toBe(true),
    );
    const queuedResize = first
      .resize?.({ targetId: first.target.targetId, width: 800, height: 450 })
      .then(
        () => undefined,
        (error) => error,
      );
    for (let attempt = 0; attempt < 2; attempt++) {
      if (failClose)
        await expect(first.close?.()).rejects.toMatchObject({
          code: 'engine-workspace-session-closed',
        });
      else await first.close?.();
    }
    expect(await resizing).toMatchObject({ code: 'engine-workspace-preview-closed' });
    expect(await queuedResize).toMatchObject({ code: 'engine-workspace-preview-closed' });
    const assetRequest = commands.find((command) => command.operation === 'listAssets');
    if (!assetRequest) throw new Error('missing held project request');
    await page.request(engineWorkspaceResultService(openedTarget.targetId), {
      kind: 'result',
      id: assetRequest.id,
      sessionId: openedTarget.sessionId,
      targetId: openedTarget.targetId,
      ok: true,
      value: [],
    });
    expect(await projectAssets).toEqual({ value: [] });
    expect(
      commands.some((command) => command.kind === 'cancel' && command.id === assetRequest.id),
    ).toBe(false);
    expect(commands.filter((command) => command.operation === 'resize')).toHaveLength(1);
    const resize = commands.find((command) => command.operation === 'resize');
    expect(commands.some((command) => command.kind === 'cancel' && command.id === resize?.id)).toBe(
      true,
    );
    const beforeStale = commands.length;
    await expect(
      Promise.resolve().then(() => first.getCamera({ targetId: first.target.targetId })),
    ).rejects.toMatchObject({ code: 'engine-workspace-preview-closed' });
    expect(commands.length).toBe(beforeStale);
    if (!failChild)
      expect(await replacement.getCamera({ targetId: replacement.target.targetId })).toMatchObject({
        version: 0,
      });
    await provider.closeProject({ project: opened.project, handle: opened.handle });
    const closes = commands.filter((command) => command.operation === 'closePreview');
    expect(closes).toHaveLength(2);
    expect(closes.map((command) => command.input?.targetId)).toEqual([
      first.target.targetId,
      replacement.target.targetId,
    ]);
    expect(page.connected).toBe(false);
  });

  it('cancels readiness without publishing a command and cleans the Host/server session', async () => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    let server: ReturnType<typeof fakeServer> | undefined;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => {
        server = fakeServer();
        return server;
      },
    });
    const opened = await provider.openProject({ root });
    if (backend === undefined) throw new Error('provider fixture did not open');
    const target = opened.target;
    if (target === undefined) throw new Error('provider fixture did not return a target');
    const page = frontendPage(backend, target);
    const commands: unknown[] = [];
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) =>
      commands.push(command),
    );
    const controller = new AbortController();
    const pending = provider.listAssets({
      project: opened.project,
      handle: opened.handle,
      signal: controller.signal,
    });
    controller.abort(new Error('test cancellation'));
    await expect(pending).rejects.toThrow('test cancellation');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: 'cancel', sessionId: opened.target?.sessionId });
    await provider.closeProject({ project: opened.project, handle: opened.handle });
    expect(server?.close).toHaveBeenCalledOnce();
    expect(page.connected).toBe(false);
  });

  it.each([
    'message',
    'disconnect',
    'failure',
  ])('treats browser page loss through %s without replaying in-flight commands', async (loss) => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    let server: ReturnType<typeof fakeServer> | undefined;
    const changed = vi.fn();
    const provider = createDevKitWorkspaceProvider({
      onTargetChanged: changed,
      readyTimeoutMs: 500,
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => {
        server = fakeServer();
        return server;
      },
    });
    const opened = await provider.openProject({ root });
    if (backend === undefined || opened.target === undefined)
      throw new Error('provider fixture did not open');
    const page = frontendPage(backend, opened.target);
    const commands: unknown[] = [];
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) =>
      commands.push(command),
    );
    await ready(page, { ...opened.target, worldId: 'world-1' }, root);
    expect(changed).toHaveBeenCalledOnce();
    expect(opened.failure).toBeUndefined();
    if (loss === 'disconnect') page.close();
    else
      await page.request(engineWorkspaceResultService(opened.target.targetId), {
        kind: loss === 'failure' ? 'failed' : 'lost',
        error: {
          code: 'app-system-update-failed',
          expected: 'A healthy World',
          hint: 'Stop the failed run.',
        },
        id: `page-lost:${opened.target.sessionId}`,
        sessionId: opened.target.sessionId,
        targetId: opened.target.targetId,
      });
    expect(commands).toHaveLength(0);
    if (loss === 'failure') {
      const failure = { code: 'app-system-update-failed' };
      await vi.waitFor(() => expect(opened.failure).toMatchObject(failure));
      expect(opened.phase).toBe('failed');
      await expect(
        provider.listAssets({ project: opened.project, handle: opened.handle }),
      ).rejects.toMatchObject(failure);
      expect(commands).toHaveLength(0);
    } else {
      await vi.waitFor(() => expect(opened.phase).toBe('starting'));
      expect(opened.failure).toBeUndefined();
      expect(opened.browserGeneration).toBe(1);
      expect(server?.close).not.toHaveBeenCalled();
      const pendingAssets = provider.listAssets({
        project: opened.project,
        handle: opened.handle,
      });
      const detached = expect(pendingAssets).rejects.toMatchObject({
        code: 'engine-workspace-session-closed',
      });
      expect(commands).toHaveLength(0);
      await provider.closeProject({ project: opened.project, handle: opened.handle });
      await detached;
      expect(server?.close).toHaveBeenCalledOnce();
      expect(page.connected).toBe(false);
      return;
    }
    expect(changed).toHaveBeenCalledTimes(2);
    const observer = backend.transport.connect();
    expect(observer.connected).toBe(true);
    observer.close();
    await provider.closeProject({ project: opened.project, handle: opened.handle });
    expect(server?.close).toHaveBeenCalledOnce();
    expect(page.connected).toBe(false);
  });

  it.each([
    'replacement',
    'failure',
  ])('closes an in-flight Play server instead of adopting it after Editor %s', async (loss) => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    const editorServer = fakeServer();
    const gameServer = fakeServer();
    let release!: () => void;
    const prepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    const serverFactory = vi.fn(async () => {
      if (serverFactory.mock.calls.length === 1) return editorServer;
      await prepared;
      return gameServer;
    });
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: serverFactory,
    });
    const opened = await provider.openProject({ root });
    if (!opened.target || !provider.startPlay) throw new Error('workspace Play fixture missing');
    const page = frontendPage(backend, opened.target);
    await ready(page, { ...opened.target, worldId: 'old-world' }, root);
    const pending = provider.startPlay(opened);
    const failure = {
      code: 'app-system-update-failed',
      expected: 'healthy World',
      hint: 'Inspect the failed system.',
    };
    const rejected = expect(pending).rejects.toMatchObject(
      loss === 'failure' ? failure : { code: 'engine-workspace-browser-detached' },
    );
    await vi.waitFor(() => expect(serverFactory).toHaveBeenCalledTimes(2));
    let replacement = page;
    if (loss === 'failure')
      await page.request(engineWorkspaceResultService(opened.target.targetId), {
        kind: 'failed',
        id: 'failure',
        sessionId: opened.target.sessionId,
        targetId: opened.target.targetId,
        error: failure,
      });
    else {
      page.close();
      replacement = frontendPage(backend, opened.target);
      await ready(replacement, { ...opened.target, worldId: 'new-world' }, root);
    }
    release();
    await rejected;
    expect(gameServer.close).toHaveBeenCalledOnce();
    expect(editorServer.close).not.toHaveBeenCalled();
    replacement.close();
    await provider.closeProject(opened);
    await backend.dispose();
  });

  it('admits one browser generation for concurrent and repeated ready messages', async () => {
    const root = await projectRoot();
    const canonicalRoot = await realpath(root);
    const backend = await createBackendHost();
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => fakeServer(),
    });
    const opened = await provider.openProject({ root });
    if (!opened.target) throw new Error('workspace target missing');
    const target = opened.target;
    const page = frontendPage(backend, target);
    const message = {
      kind: 'ready',
      id: target.sessionId,
      sessionId: target.sessionId,
      targetId: target.targetId,
      project: { id: 'workspace-game', root: canonicalRoot, name: 'Workspace Game' },
      target: { ...target, worldId: 'world' },
    };
    await Promise.all([
      page.request(engineWorkspaceResultService(target.targetId), message),
      page.request(engineWorkspaceResultService(target.targetId), message),
    ]);
    expect(opened.browserGeneration).toBe(1);
    await page.request(engineWorkspaceResultService(target.targetId), {
      ...message,
      target: { ...target, worldId: 'unadmitted-world' },
    });
    expect(opened.browserGeneration).toBe(1);
    expect(opened.target?.worldId).toBe('world');
    page.close();
    await provider.closeProject(opened);
    await backend.dispose();
  });

  it('does not adopt a replacement after the project closes during retirement', async () => {
    const root = await projectRoot();
    const canonicalRoot = await realpath(root);
    const backend = await createBackendHost();
    const server = fakeServer();
    let retiring = false;
    let release!: () => void;
    const retirement = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => server,
      onTargetChanged: () => (retiring ? retirement : undefined),
    });
    const opened = await provider.openProject({ root });
    if (!opened.target) throw new Error('workspace target missing');
    const target = opened.target;
    const page = frontendPage(backend, target);
    await ready(page, { ...target, worldId: 'old-world' }, root);
    retiring = true;
    page.close();
    const replacement = frontendPage(backend, target);
    const admission = replacement.request(engineWorkspaceResultService(target.targetId), {
      kind: 'ready',
      id: target.sessionId,
      sessionId: target.sessionId,
      targetId: target.targetId,
      project: { id: 'workspace-game', root: canonicalRoot, name: 'Workspace Game' },
      target: { ...target, worldId: 'new-world' },
    });
    await setImmediate();
    const retired = expect(admission).rejects.toMatchObject({
      code: 'host-assembly-request-aborted',
    });
    await provider.closeProject(opened);
    release();
    await retired;
    expect(opened.browserGeneration).toBe(1);
    expect(opened.target?.worldId).toBe('old-world');
    expect(server.close).toHaveBeenCalledOnce();
    replacement.close();
    await backend.dispose();
  });

  it.each(
    ['assets', 'preview', 'play'].flatMap((operation) =>
      ['replacement', 'failure'].map((loss) => ({ operation, loss })),
    ),
  )('does not publish or allocate an old $operation request after browser $loss', async ({
    operation,
    loss,
  }) => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    const serverFactory = vi.fn(async () => fakeServer());
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      readyTimeoutMs: 500,
      viteServerFactory: serverFactory,
    });
    const opened = await provider.openProject({ root });
    if (!opened.target) throw new Error('workspace target missing');
    const target = opened.target;
    const old = frontendPage(backend, target);
    const commands: WorkspaceCommandFixture[] = [];
    old.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) =>
      commands.push(command),
    );
    await ready(old, { ...target, worldId: 'old-world' }, root);
    const pending =
      operation === 'assets'
        ? provider.listAssets(opened)
        : operation === 'preview'
          ? provider.openPreview({
              project: opened.project,
              projectHandle: opened.handle,
              asset: { guid: 'mesh', kind: 'mesh', previewable: true },
              width: 64,
              height: 64,
            })
          : provider.startPlay?.(opened);
    const failure = {
      code: 'app-system-update-failed',
      expected: 'healthy World',
      hint: 'Inspect the failed system.',
    };
    const rejected = expect(pending).rejects.toMatchObject(
      loss === 'failure' ? failure : { code: 'engine-workspace-browser-detached' },
    );
    let current = old;
    if (loss === 'failure')
      await old.request(engineWorkspaceResultService(target.targetId), {
        kind: 'failed',
        id: 'failure',
        sessionId: target.sessionId,
        targetId: target.targetId,
        error: failure,
      });
    else {
      current = frontendPage(backend, target);
      current.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) =>
        commands.push(command),
      );
    }
    await rejected;
    expect(commands).toEqual([]);
    expect(serverFactory).toHaveBeenCalledOnce();
    old.close();
    current.close();
    await provider.closeProject(opened);
    await backend.dispose();
  });

  it('sends each workspace write only to the current authenticated browser', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => fakeServer(),
    });
    const opened = await provider.openProject({ root });
    if (!opened.target) throw new Error('workspace target missing');
    const target = opened.target;
    const old = frontendPage(backend, target);
    const oldCommands: WorkspaceCommandFixture[] = [];
    old.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) =>
      oldCommands.push(command),
    );
    await ready(old, { ...target, worldId: 'old-world' }, root);
    const current = frontendPage(backend, target);
    const commands: WorkspaceCommandFixture[] = [];
    current.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
      if (command.operation !== 'runtimePack') return;
      commands.push(command);
      void current.request(engineWorkspaceResultService(target.targetId), {
        kind: 'result',
        id: command.id,
        sessionId: target.sessionId,
        targetId: target.targetId,
        ok: true,
        value: {},
      });
    });
    await ready(current, { ...target, worldId: 'current-world' }, root);
    try {
      assert(provider.runtimePack);
      await provider.runtimePack({
        ...opened,
        targetId: target.targetId,
        worldId: 'current-world',
        request: { operation: 'plugin-install', guid: '01900000-0000-7000-8000-000000000361' },
      });
      expect(oldCommands).toEqual([]);
      expect(commands).toHaveLength(1);
      await expect(
        old.request(engineWorkspaceResultService(target.targetId), {
          kind: 'result',
          id: commands[0]?.id,
          sessionId: target.sessionId,
          targetId: target.targetId,
          ok: true,
          value: {},
        }),
      ).rejects.toMatchObject({ code: 'engine-workspace-caller-mismatch' });
      old.close();
      expect(opened.phase).toBe('running');
      expect(opened.browserGeneration).toBe(2);
    } finally {
      old.close();
      current.close();
      await provider.closeProject(opened);
      await backend.dispose();
    }
  });

  it.each([
    false,
    true,
  ])('does not bypass an earlier retirement when a replacement disconnects (fails: %s)', async (fails) => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    let release!: () => void;
    const retirement = new Promise<void>((resolve) => {
      release = resolve;
    });
    let losses = 0;
    let opened: Awaited<
      ReturnType<ReturnType<typeof createDevKitWorkspaceProvider>['openProject']>
    >;
    const failure = {
      code: 'engine-workspace-plugin-cleanup-timeout',
      expected: 'confirmed cleanup',
      hint: 'Retry explicit cleanup.',
      detail: { cleanup: 'timeout' },
    };
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => fakeServer(),
      onTargetChanged: async () => {
        if (opened?.phase !== 'starting' || ++losses !== 1) return;
        await retirement;
        if (fails) throw failure;
      },
    });
    opened = await provider.openProject({ root });
    if (!opened.target) throw new Error('workspace target missing');
    const target = opened.target;
    const canonicalRoot = await realpath(root);
    const first = frontendPage(backend, target);
    await ready(first, { ...target, worldId: 'old-world' }, root);
    first.close();
    const second = frontendPage(backend, target);
    second.close();
    const third = frontendPage(backend, target);
    const admission = third.request(engineWorkspaceResultService(target.targetId), {
      kind: 'ready',
      id: target.sessionId,
      sessionId: target.sessionId,
      targetId: target.targetId,
      project: { id: 'workspace-game', root: canonicalRoot, name: 'Workspace Game' },
      target: { ...target, worldId: 'new-world' },
    });
    await setImmediate();
    try {
      expect(opened.phase).toBe('starting');
      expect(opened.browserGeneration).toBe(1);
    } finally {
      release();
      await admission;
    }
    expect(opened.phase).toBe(fails ? 'failed' : 'running');
    if (fails) expect(opened.failure).toMatchObject(failure);
    third.close();
    if (fails) await expect(provider.closeProject(opened)).rejects.toMatchObject(failure);
    else await provider.closeProject(opened);
    await backend.dispose().catch(() => {});
  });

  it.each([
    false,
    true,
  ])('preserves a retirement error when every subsequent notification also rejects (sync: %s)', async (sync) => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    let rejects = false;
    const failure = {
      code: 'engine-workspace-plugin-cleanup-timeout',
      expected: 'confirmed cleanup',
      hint: 'Retry explicit cleanup.',
      detail: { cleanup: 'timeout' },
    };
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => fakeServer(),
      onTargetChanged: () => {
        if (!rejects) return;
        if (sync) throw failure;
        return Promise.reject(failure);
      },
    });
    const opened = await provider.openProject({ root });
    if (!opened.target) throw new Error('workspace target missing');
    const page = frontendPage(backend, opened.target);
    await ready(page, { ...opened.target, worldId: 'world' }, root);
    rejects = true;
    page.close();
    await setImmediate();
    expect(opened.phase).toBe('failed');
    expect(opened.failure).toMatchObject(failure);
    await expect(provider.listAssets(opened)).rejects.toMatchObject(failure);
    await expect(provider.closeProject(opened)).rejects.toMatchObject(failure);
    await backend.dispose().catch(() => {});
  });

  it.each([
    false,
    true,
  ])('fences replacement readiness behind actual browser retirement (fails: %s)', async (fails) => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    let retiring = false;
    let release: (() => void) | undefined;
    const retirement = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = {
      code: 'engine-workspace-plugin-cleanup-timeout',
      expected: 'confirmed cleanup',
      hint: 'Retry explicit cleanup.',
      detail: { cleanup: 'timeout' },
    };
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      onTargetChanged: async () => {
        if (!retiring) return;
        await retirement;
        if (fails) {
          retiring = false;
          throw failure;
        }
      },
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => fakeServer(),
    });
    const opened = await provider.openProject({ root });
    if (!backend || !opened.target) throw new Error('workspace fixture did not open');
    const target = opened.target;
    const page = frontendPage(backend, target);
    await ready(page, { ...target, worldId: 'world-old' }, root);
    retiring = true;
    page.close();
    expect(opened.phase).toBe('starting');
    const replacement = frontendPage(backend, target);
    const canonicalRoot = await realpath(root);
    const admission = replacement.request(engineWorkspaceResultService(target.targetId), {
      kind: 'ready',
      id: target.sessionId,
      sessionId: target.sessionId,
      targetId: target.targetId,
      project: { id: 'workspace-game', root: canonicalRoot, name: 'Workspace Game' },
      target: { ...target, worldId: 'world-new' },
    });
    await setImmediate();
    expect(opened.phase).toBe('starting');
    expect(opened.browserGeneration).toBe(1);
    release?.();
    await admission;
    if (fails) {
      expect(opened.phase).toBe('failed');
      expect(opened.failure).toMatchObject(failure);
      await expect(
        provider.listAssets({ project: opened.project, handle: opened.handle }),
      ).rejects.toMatchObject(failure);
    } else {
      expect(opened.phase).toBe('running');
      expect(opened.browserGeneration).toBe(2);
      expect(opened.target?.worldId).toBe('world-new');
    }
    replacement.close();
    await Promise.resolve(
      provider.closeProject({ project: opened.project, handle: opened.handle }),
    ).catch(() => {});
  });

  it.each([
    false,
    true,
  ])('retires actual previews and Play before adopting a refreshed browser (cleanup fails: %s)', async (fails) => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    const fiber = backend.context.plugin(devKitWorkspacePlugin, {
      hostBinding: { backend },
      readyTimeoutMs: 500,
      viteServerFactory: async () => fakeServer(),
    });
    await fiber.await();
    const runtime = backend.context.engineWorkspace;
    if (!runtime) throw new Error('workspace runtime not installed');
    const opened = await runtime.openProject({ root });
    if (!opened.target) throw new Error('workspace target missing');
    const target = opened.target;
    const page = frontendPage(backend, target);
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
      if (command.operation !== 'openPreview') return;
      void page.request(engineWorkspaceResultService(target.targetId), {
        kind: 'result',
        id: command.id,
        sessionId: target.sessionId,
        targetId: target.targetId,
        ok: true,
        value: {
          previewOwner: command.id,
          asset: command.input?.asset,
          target: { ...target, targetId: command.input?.previewTargetId, worldId: 'old-child' },
        },
      });
    });
    await ready(page, { ...target, worldId: 'world-old' }, root);
    const preview = await runtime.openPreview({
      project: opened.project,
      asset: { guid: 'mesh', kind: 'mesh', previewable: true },
      width: 64,
      height: 64,
    });
    const play = await runtime.startPlay?.({ project: opened.project, handle: opened.handle });
    if (!play?.target) throw new Error('Play target missing');
    const gameTarget = play.target;
    const game = frontendPage(backend, gameTarget);
    let closeCommand: WorkspaceCommandFixture | undefined;
    game.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
      if (command.operation === 'closeWorkspace' && command.sessionId === gameTarget.sessionId)
        closeCommand = command;
    });
    await game.request(engineWorkspaceResultService(gameTarget.targetId), {
      kind: 'ready',
      id: gameTarget.sessionId,
      sessionId: gameTarget.sessionId,
      targetId: gameTarget.targetId,
      project: opened.project,
      target: { ...gameTarget, worldId: 'play-world' },
    });
    page.close();
    await vi.waitFor(() => expect(closeCommand).toBeDefined());
    expect(runtime.previews).toEqual([]);
    expect(runtime.play).toBe(play);
    const replacement = frontendPage(backend, target);
    const admission = replacement.request(engineWorkspaceResultService(target.targetId), {
      kind: 'ready',
      id: target.sessionId,
      sessionId: target.sessionId,
      targetId: target.targetId,
      project: opened.project,
      target: { ...target, worldId: 'world-new' },
    });
    await setImmediate();
    expect(runtime.project?.phase).toBe('starting');
    expect(runtime.project?.browserGeneration).toBe(1);
    const failure = {
      code: 'engine-workspace-plugin-cleanup-timeout',
      expected: 'confirmed cleanup',
      hint: 'Retry explicit cleanup.',
      detail: { cleanup: 'timeout' },
    };
    if (!closeCommand) throw new Error('close command missing');
    await game.request(engineWorkspaceResultService(gameTarget.targetId), {
      kind: 'result',
      id: closeCommand.id,
      sessionId: gameTarget.sessionId,
      targetId: gameTarget.targetId,
      ...(fails ? { ok: false, error: failure } : { ok: true, value: { cleanup: 'completed' } }),
    });
    await admission;
    await expect(
      Promise.resolve().then(() => preview.capture?.({ targetId: preview.target.targetId })),
    ).rejects.toMatchObject({ code: 'engine-workspace-preview-closed' });
    if (fails) {
      expect(runtime.play).toBe(play);
      expect(runtime.project?.phase).toBe('failed');
      await expect(runtime.listAssets(opened)).rejects.toMatchObject(failure);
    } else {
      expect(runtime.play).toBeUndefined();
      expect(runtime.project?.phase).toBe('running');
      expect(runtime.project?.browserGeneration).toBe(2);
    }
    replacement.close();
    game.close();
    await backend.dispose().catch(() => {});
  });

  it('reattaches a refreshed page without closing Vite or polling the catalog', async () => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    let server: ReturnType<typeof fakeServer> | undefined;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => {
        server = fakeServer();
        return server;
      },
    });
    const opened = await provider.openProject({ root });
    const target = opened.target;
    if (backend === undefined || target === undefined)
      throw new Error('provider fixture did not open');
    const page = frontendPage(backend, target);
    const sent: WorkspaceCommandFixture[] = [];
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
      if (command.kind === 'command' && command.operation === 'listAssets') sent.push(command);
    });
    await ready(page, { ...target, worldId: 'world-1' }, root);
    expect(opened.phase).toBe('running');
    expect(opened.browserGeneration).toBe(1);
    const inflight = provider.listAssets({ project: opened.project, handle: opened.handle });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const detached = expect(inflight).rejects.toMatchObject({
      code: 'engine-workspace-browser-detached',
    });
    page.close();
    await detached;
    await vi.waitFor(() => expect(opened.phase).toBe('starting'));
    expect(server?.close).not.toHaveBeenCalled();
    const replacement = frontendPage(backend, target);
    const commands: WorkspaceCommandFixture[] = [];
    replacement.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
      if (command.kind !== 'command' || command.operation !== 'listAssets') return;
      commands.push(command);
      void replacement.request(engineWorkspaceResultService(target.targetId), {
        kind: 'result',
        id: command.id,
        sessionId: command.sessionId,
        targetId: target.targetId,
        ok: true,
        value: [{ guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true }],
      });
    });
    const assets = provider.listAssets({ project: opened.project, handle: opened.handle });
    expect(commands).toHaveLength(0);
    await ready(replacement, { ...target, worldId: 'world-1' }, root);
    await expect(assets).resolves.toEqual([
      { guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true },
    ]);
    expect(commands).toHaveLength(1);
    expect(opened.phase).toBe('running');
    expect(opened.browserGeneration).toBe(2);
    expect(opened.failure).toBeUndefined();
    expect(server?.close).not.toHaveBeenCalled();
    expect(server?.listen).toHaveBeenCalledOnce();
    await provider.closeProject({ project: opened.project, handle: opened.handle });
    expect(server?.close).toHaveBeenCalledOnce();
  });

  it('publishes the workspace URL after the Pack plugin ready promise and does not poll', async () => {
    const root = await projectRoot();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let releaseCatalog: (() => void) | undefined;
    const catalogReady = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let readyCalls = 0;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 1_000,
      backendFactory: async () => createBackendHost(),
      viteServerFactory: async () =>
        ({
          ...fakeServer(),
          httpServer: {},
          config: {
            plugins: [
              {
                name: 'forgeax:pack',
                ready: () => {
                  readyCalls += 1;
                  return catalogReady;
                },
              },
            ],
          },
        }) as unknown as ViteDevServer,
    });
    let settled = false;
    const pending = Promise.resolve(provider.openProject({ root })).then((opened) => {
      settled = true;
      return opened;
    });
    await vi.waitFor(() => expect(readyCalls).toBe(1));
    expect(settled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    releaseCatalog?.();
    const opened = await pending;
    expect(opened.project.id).toBe('workspace-game');
    expect(fetchMock).not.toHaveBeenCalled();
    await provider.dispose?.();
  });

  it('rejects workspace results from an old or unassociated caller', async () => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    const provider = createDevKitWorkspaceProvider({
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => fakeServer(),
    });
    const opened = await provider.openProject({ root });
    if (backend === undefined || opened.target === undefined)
      throw new Error('provider fixture did not open');
    const oldPage = backend.transport.connect({
      kind: 'frontend',
      sourceId: `forgeax-workspace:old:${opened.target.targetId}`,
    });
    await expect(
      oldPage.request(engineWorkspaceResultService(opened.target.targetId), {
        kind: 'ready',
        id: opened.target.sessionId,
        sessionId: opened.target.sessionId,
        targetId: opened.target.targetId,
        project: opened.project,
        target: opened.target,
      }),
    ).rejects.toMatchObject({ code: 'engine-workspace-caller-mismatch' });
    oldPage.close();
    await provider.dispose?.();
  });

  it('closes a server acquired after the borrowed host has shut down', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    let releaseServer: ((server: ViteDevServer) => void) | undefined;
    let serverStarted: (() => void) | undefined;
    const serverStart = new Promise<void>((resolve) => {
      serverStarted = resolve;
    });
    const serverReady = new Promise<ViteDevServer>((resolve) => {
      releaseServer = resolve;
    });
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => {
        serverStarted?.();
        return serverReady;
      },
    });
    const opening = provider.openProject({ root });
    await serverStart;
    await backend.dispose();
    const lateServer = fakeServer();
    releaseServer?.(lateServer);
    await expect(opening).rejects.toMatchObject({ code: 'engine-workspace-session-closed' });
    expect(lateServer.close).toHaveBeenCalledOnce();
    await provider.dispose?.();
  });

  it('waits for an opening session before completing provider disposal', async () => {
    const root = await projectRoot();
    let releaseBackend:
      | ((backend: Awaited<ReturnType<typeof createBackendHost>>) => void)
      | undefined;
    let backendStarted: (() => void) | undefined;
    const backendStart = new Promise<void>((resolve) => {
      backendStarted = resolve;
    });
    const backendReady = new Promise<Awaited<ReturnType<typeof createBackendHost>>>((resolve) => {
      releaseBackend = resolve;
    });
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    const provider = createDevKitWorkspaceProvider({
      backendFactory: async () => {
        backendStarted?.();
        backend = await backendReady;
        return backend;
      },
      viteServerFactory: async () => fakeServer(),
    });
    const opening = provider.openProject({ root });
    await backendStart;
    const disposing = provider.dispose?.();
    if (releaseBackend === undefined)
      throw new Error('provider fixture did not expose backend gate');
    releaseBackend(await createBackendHost());
    await expect(opening).rejects.toMatchObject({
      code: 'engine-workspace-provider-disposed',
    });
    await disposing;
    expect(backend?.assembly.activation.state).toBe('disposed');
  });
});

describe('DevKit workspace provider borrowed host lifecycle', () => {
  it('keeps the borrowed Host alive across session close and rebind', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const binding = { backend };
    const ownerClient = backend.transport.connect();
    const servers: ReturnType<typeof fakeServer>[] = [];
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      hostBinding: binding,
      viteServerFactory: async () => {
        const server = fakeServer();
        servers.push(server);
        return server;
      },
    });
    try {
      const first = await provider.openProject({ root });
      expect(mocks.createViteConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'workspace-game' }),
        'serve',
        '/',
        // The provider derives a per-session workspace identity over the
        // borrowed binding; the Host itself stays the borrowed instance.
        expect.objectContaining({ host: expect.objectContaining({ backend }) }),
      );
      const firstTarget = first.target;
      if (firstTarget === undefined) throw new Error('borrowed fixture did not return a target');
      const page = frontendPage(backend, firstTarget);
      page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
        if (command.operation === 'closeWorkspace') return;
        // The borrowed Host keeps this page connected after closeProject, so
        // the subscription must only answer ITS session's commands; commands
        // broadcast for a later session belong to the new page.
        if (command.kind !== 'command' || command.sessionId !== firstTarget.sessionId) return;
        void page.request(engineWorkspaceResultService(firstTarget.targetId), {
          kind: 'result',
          id: command.id,
          sessionId: command.sessionId,
          targetId: firstTarget.targetId,
          ok: true,
          value: [{ guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true }],
        });
      });
      const firstAssets = provider.listAssets({ project: first.project, handle: first.handle });
      await ready(page, firstTarget, root);
      expect(await firstAssets).toEqual([
        { guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true },
      ]);

      await provider.closeProject({ project: first.project, handle: first.handle });
      expect(servers[0]?.close).toHaveBeenCalledOnce();
      // The borrowed Host outlives the session: prior owner connections stay
      // up and the transport still accepts new clients.
      expect(ownerClient.connected).toBe(true);
      expect(page.connected).toBe(true);

      const second = await provider.openProject({ root });
      const secondTarget = second.target;
      if (secondTarget === undefined) throw new Error('borrowed rebind did not return a target');
      expect(secondTarget.sessionId).not.toBe(firstTarget.sessionId);
      const secondPage = frontendPage(backend, secondTarget);
      secondPage.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
        if (command.operation === 'closeWorkspace') return;
        if (command.kind !== 'command' || command.sessionId !== secondTarget.sessionId) return;
        void secondPage.request(engineWorkspaceResultService(secondTarget.targetId), {
          kind: 'result',
          id: command.id,
          sessionId: command.sessionId,
          targetId: secondTarget.targetId,
          ok: true,
          value: [],
        });
      });
      const secondAssets = provider.listAssets({
        project: second.project,
        handle: second.handle,
      });
      await ready(secondPage, secondTarget, root);
      expect(await secondAssets).toEqual([]);
      await provider.closeProject({ project: second.project, handle: second.handle });
      expect(ownerClient.connected).toBe(true);
      expect(servers).toHaveLength(2);
      await provider.dispose?.();
      expect(ownerClient.connected).toBe(true);
      expect(backend.assembly.activation.state).not.toBe('disposed');
    } finally {
      ownerClient.close();
      await provider.dispose?.();
      await backend.dispose();
    }
  });

  it('rejects a malformed borrowed frontend projection before attaching a session', async () => {
    const backend = await createBackendHost();
    try {
      expect(() =>
        validateHostBinding({
          backend,
          frontendAssembly: { ...backend.assembly.current, revision: 'tampered' },
        }),
      ).toThrow();
    } finally {
      await backend.dispose();
    }
  });
});

it('inspects authored asset identity and source revision without any View or browser', async () => {
  const root = await projectRoot();
  const packageId = '01900000-0000-7000-8000-000000000091';
  const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'scene/main'));
  await mkdir(resolve(root, 'assets'));
  await writeFile(
    resolve(root, 'assets/direct.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId,
      assets: { 'scene/main': { kind: 'scene', payload: { exposure: 1.25 }, refs: [] } },
    }),
  );
  const provider = createDevKitWorkspaceProvider();
  if (!provider.inspectAsset) throw new Error('production provider must expose inspection');
  try {
    const inspection = await provider.inspectAsset({
      project: { id: 'workspace-game', root },
      guid,
    });
    expect(inspection).toMatchObject({
      guid,
      asset: { guid, kind: 'scene', sourceKey: 'scene/main' },
      source: { path: 'assets/direct.pack.json', revision: expect.any(String) },
      meta: { packageId, format: 'direct', properties: { exposure: 1.25 } },
      revision: expect.any(String),
    });
    expect((inspection as { meta: Record<string, unknown> }).meta).toEqual({
      packageId,
      format: 'direct',
      properties: { exposure: 1.25 },
    });
  } finally {
    await provider.dispose?.();
  }
});

it('preserves live internal package inspection even when it carries a source key', async () => {
  const root = await projectRoot();
  const project = { id: 'workspace-game', root };
  const guid = '22592f07-d967-5116-b29c-fa9781929ba8';
  const asset = {
    guid,
    kind: 'mesh',
    sourceKey: 'mesh/main',
    path: '.forgeax/generated/serve-proof/engine-builtins.pack.json',
  };
  const inspection = { guid, asset, source: { path: asset.path }, meta: { vertexCount: 3 } };
  const handle = {
    project,
    inspectAsset: async () => inspection,
    listAssets: async () => [asset],
    target: { targetId: 'workspace-target' },
  };
  const provider = createDevKitWorkspaceProvider();
  try {
    expect(await provider.inspectAsset?.({ project, handle, guid })).toBe(inspection);
  } finally {
    await provider.dispose?.();
  }
});

it('attaches the open pack payload when a live catalog row has a disk source', async () => {
  const root = await projectRoot();
  const packageId = '01900000-0000-7000-8000-000000000092';
  const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'material/main'));
  await mkdir(resolve(root, 'assets'));
  await writeFile(
    resolve(root, 'assets/material.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId,
      assets: {
        'material/main': { kind: 'material', payload: { roughness: 0.4, metallic: 0 }, refs: [] },
        'material/other': { kind: 'material', payload: { roughness: 0.9 }, refs: [] },
      },
    }),
  );
  const project = { id: 'workspace-game', root };
  const asset = {
    guid,
    kind: 'material',
    packageId,
    sourceKey: 'material/main',
    path: 'assets/material.pack.json',
  };
  const handle = {
    project,
    inspectAsset: async () => ({ guid, asset, meta: { vertexCount: 24 } }),
    listAssets: async () => [asset],
    target: { targetId: 'workspace-target' },
  };
  const provider = createDevKitWorkspaceProvider();
  try {
    const inspection = await provider.inspectAsset?.({ project, handle, guid });
    expect(inspection).toMatchObject({
      guid,
      asset,
      source: { path: asset.path, revision: expect.any(String) },
      meta: { vertexCount: 24, properties: { roughness: 0.4, metallic: 0 } },
      revision: expect.any(String),
    });
    expect((inspection as { meta: Record<string, unknown> }).meta).not.toHaveProperty('assets');
    expect((inspection as { meta: Record<string, unknown> }).meta).not.toHaveProperty('payload');
  } finally {
    await provider.dispose?.();
  }
});

it('rejects a Pack source whose output GUID does not match the live Catalog row', async () => {
  const root = await projectRoot();
  const sourcePackageId = '01900000-0000-7000-8000-000000000093';
  const catalogPackageId = '01900000-0000-7000-8000-000000000094';
  const guid = AssetGuid.format(
    AssetGuid.derive(definePackageId(catalogPackageId), 'material/main'),
  );
  await mkdir(resolve(root, 'assets'));
  await writeFile(
    resolve(root, 'assets/material.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: sourcePackageId,
      assets: {
        'material/main': { kind: 'material', payload: { roughness: 0.9 }, refs: [] },
      },
    }),
  );
  const project = { id: 'workspace-game', root };
  const asset = {
    guid,
    kind: 'material',
    packageId: catalogPackageId,
    sourceKey: 'material/main',
    path: 'assets/material.pack.json',
  };
  const handle = {
    project,
    inspectAsset: async () => ({ guid, asset }),
    listAssets: async () => [asset],
    target: { targetId: 'workspace-target' },
  };
  const provider = createDevKitWorkspaceProvider();
  try {
    await expect(provider.inspectAsset?.({ project, handle, guid })).rejects.toMatchObject({
      code: 'asset-inspect-identity-mismatch',
    });
  } finally {
    await provider.dispose?.();
  }
});

it('reports an unreadable direct Pack source during live asset inspection', async () => {
  const root = await projectRoot();
  const project = { id: 'workspace-game', root };
  const guid = '24365a15-380e-5b19-9ea2-c9123e6cc045';
  const asset = {
    guid,
    kind: 'material',
    packageId: '01900000-0000-7000-8000-000000000095',
    sourceKey: 'material/main',
    path: 'assets/missing.pack.json',
  };
  const handle = {
    project,
    inspectAsset: async () => ({ guid, asset }),
    listAssets: async () => [asset],
    target: { targetId: 'workspace-target' },
  };
  const provider = createDevKitWorkspaceProvider();
  try {
    await expect(provider.inspectAsset?.({ project, handle, guid })).rejects.toMatchObject({
      code: 'pack-source-not-found',
      expected: expect.any(String),
      hint: expect.any(String),
    });
  } finally {
    await provider.dispose?.();
  }
});

it('inspects the active catalog without requiring a filesystem Pack index', async () => {
  const root = await projectRoot();
  const project = { id: 'workspace-game', root };
  const asset = {
    guid: '24365a15-380e-5b19-9ea2-c9123e6cc045',
    kind: 'scene',
    path: 'assets/proof.pack.ts',
  };
  const inspection = {
    guid: asset.guid,
    asset,
    source: { path: asset.path },
    meta: { materialSlots: [] },
  };
  const inspectAsset = vi.fn(async ({ guid }: { guid: string }) => {
    if (guid !== asset.guid) throw Object.assign(new Error('missing'), { code: 'asset-not-found' });
    return inspection;
  });
  const handle = {
    project,
    inspectAsset,
    listAssets: () => [asset],
    target: { targetId: 'workspace-target' },
  };
  const provider = createDevKitWorkspaceProvider();
  try {
    expect(await provider.inspectAsset?.({ project, handle, guid: asset.guid })).toEqual(
      inspection,
    );
    expect(inspectAsset).toHaveBeenCalledOnce();
    await expect(
      provider.inspectAsset?.({ project, handle, guid: 'missing' }),
    ).rejects.toMatchObject({ code: 'asset-not-found' });
    inspectAsset.mockRejectedValueOnce(new Error('engine-workspace-page-lost'));
    await expect(provider.inspectAsset?.({ project, handle, guid: asset.guid })).rejects.toThrow(
      'engine-workspace-page-lost',
    );
  } finally {
    await provider.dispose?.();
  }
});
