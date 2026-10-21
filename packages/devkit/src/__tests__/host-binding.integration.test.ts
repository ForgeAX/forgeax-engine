import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { createFrontendHost } from '@forgeax/engine-host/frontend';
import {
  canonicalHostJson,
  createHostAssembly,
  type HostAssembly,
} from '@forgeax/engine-host/protocol';
import {
  createHostWebSocketClient,
  HOST_ACTIVATION_REPORT_SERVICE,
  HOST_ASSEMBLY_SERVICE,
} from '@forgeax/engine-host/transport';
import { Context, startNativePlugin } from '@forgeax/engine-plugin';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createViteConfig, devKitHostBridge } from '../host.js';
import { composeBoundHostAssembly, validateHostBinding } from '../host-binding.js';
import { readProjectFacts } from '../project.js';

async function fixture(workspace = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-host-binding-'));
  const events: string[] = [];
  const backend = await createBackendHost({
    startupPlugins: [
      {
        apply(ctx) {
          events.push('backend-active');
          ctx.effect(() => () => {
            events.push('backend-disposed');
          });
        },
      },
    ],
  });
  const binding = {
    backend,
    ...(workspace
      ? { workspace: { sessionId: 'session', targetId: 'target', admissionToken: 'token' } }
      : {}),
  };
  const assembly = composeBoundHostAssembly(
    binding,
    createHostAssembly({ root: { program: 'fixture#root', codeRevision: 'one' } }),
  );
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [devKitHostBridge(binding, assembly)],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `ws://127.0.0.1:${address.port}/__forgeax/host`;
  return {
    backend,
    binding,
    events,
    server,
    url,
    async dispose() {
      await server.close();
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe('borrowed Host root binding', () => {
  it('activates a native frontend over a real socket and releases only borrowed contributions', async () => {
    const f = await fixture();
    const client = await createHostWebSocketClient(new WebSocket(f.url));
    try {
      const host = await createFrontendHost({
        transport: client,
        resolveRoot: async (root) => {
          expect(root.program).toBe('fixture#root');
          return {
            apply(ctx) {
              f.events.push('frontend-active');
              ctx.effect(() => () => {
                f.events.push('frontend-disposed');
              });
            },
          };
        },
      });
      expect(host.status.state).toBe('active');
      await host.dispose();
      client.close();
      await f.server.close();
      expect(f.events).toEqual(['backend-active', 'frontend-active', 'frontend-disposed']);
      expect(f.backend.context.fiber.uid).not.toBeNull();
      expect(f.backend.assembly.current.root).toBeUndefined();
    } finally {
      client.close();
      await f.dispose();
    }
  });
  it('does not promote query parameters to an admitted workspace identity', async () => {
    const f = await fixture();
    const callerSeen = new Promise<import('@forgeax/engine-host/transport').HostCallerIdentity>(
      (resolve) => {
        f.backend.transport.onClientConnect(resolve);
      },
    );
    let client: Awaited<ReturnType<typeof createHostWebSocketClient>> | undefined;
    try {
      client = await createHostWebSocketClient(
        new WebSocket(
          `${f.url}?forgeaxWorkspaceSession=forged&forgeaxWorkspaceTarget=forged&forgeaxWorkspaceToken=forged`,
        ),
      );
      const caller = await callerSeen;
      expect(caller.kind).toBe('websocket');
      expect(caller.sourceId).toBeUndefined();
    } finally {
      client?.close();
      await f.dispose();
    }
  });
  it('does not restore an old root over a newer owner revision', async () => {
    const f = await fixture();
    try {
      const newer = await f.backend.update({ root: { program: 'owner#new', codeRevision: 'two' } });
      await f.server.close();
      expect(f.backend.assembly.current).toEqual(newer);
    } finally {
      await f.dispose();
    }
  });
  it('rejects duplicate binding and conflicting roots', async () => {
    const f = await fixture();
    try {
      expect(() => validateHostBinding(f.binding)).toThrow();
      expect(() =>
        composeBoundHostAssembly(
          f.binding,
          createHostAssembly({ root: { program: 'other', codeRevision: 'one' } }),
        ),
      ).toThrow();
    } finally {
      await f.dispose();
    }
  });
  it('accepts only the admitted workspace socket and replaces the old connection', async (context) => {
    const began = performance.now();
    const stages: { stage: string; elapsedMs: number }[] = [];
    const record = (stage: string) => stages.push({ stage, elapsedMs: performance.now() - began });
    context.onTestFailed(async () => {
      const output = resolve(import.meta.dirname, '../../../../artifacts/devkit-host-binding');
      await mkdir(output, { recursive: true });
      await writeFile(resolve(output, 'failed-stage.json'), JSON.stringify(stages, null, 2));
    });
    record('fixture');
    const f = await fixture(true);
    const callers: import('@forgeax/engine-host/transport').HostCallerIdentity[] = [];
    f.backend.transport.onClientConnect((caller) => {
      callers.push(caller);
    });
    const url = (token: string) =>
      `${f.url}?forgeaxWorkspaceSession=session&forgeaxWorkspaceTarget=target&forgeaxWorkspaceToken=${token}`;
    let first: Awaited<ReturnType<typeof createHostWebSocketClient>> | undefined;
    let second: Awaited<ReturnType<typeof createHostWebSocketClient>> | undefined;
    try {
      record('wrong-admission');
      await expect(createHostWebSocketClient(new WebSocket(url('wrong')))).rejects.toBeDefined();
      record('first-admission');
      first = await createHostWebSocketClient(new WebSocket(url('token')));
      record('replacement-admission');
      second = await createHostWebSocketClient(new WebSocket(url('token')));
      record('first-disconnected');
      await expect.poll(() => first?.connected).toBe(false);
      expect(callers).toHaveLength(2);
      for (const caller of callers) {
        expect(caller.kind).toBe('frontend');
        expect(caller.sourceId).toBe('forgeax-workspace:session:target');
        expect(caller.capability).toBeTruthy();
      }
      expect(callers[0]?.connectionId).not.toBe(callers[1]?.connectionId);
      record('assembly-request');
      const assembly = await second.request<undefined, HostAssembly>(
        HOST_ASSEMBLY_SERVICE,
        undefined,
      );
      record('activation-report');
      await expect(
        second.request(HOST_ACTIVATION_REPORT_SERVICE, {
          state: 'active',
          revision: assembly.revision,
          sessionGeneration: assembly.sessionGeneration,
        }),
      ).resolves.toEqual({ accepted: true });
      record('stale-generation-report');
      await expect(
        second.request(HOST_ACTIVATION_REPORT_SERVICE, {
          state: 'active',
          revision: assembly.revision,
          sessionGeneration: assembly.sessionGeneration - 1,
        }),
      ).rejects.toBeDefined();
    } finally {
      record('clients-close');
      first?.close();
      second?.close();
      record('fixture-dispose');
      await f.dispose();
      record('disposed');
    }
  });
});

it.each([
  'default',
  'panel',
])('resolves an external %s export using its explicit locator and rejects obsolete descriptors', async (exportName) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-external-frontend-'));
  const backend = await createBackendHost();
  const ctx = new Context();
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({ schemaVersion: '3.0.0', id: 'external', name: 'External', roots: {} }),
    );
    const specifier = pathToFileURL(resolve(root, 'frontend.mjs')).href;
    await writeFile(
      resolve(root, 'frontend.mjs'),
      `const plugin = { provide: ['externalValue'], apply(ctx, config) { ctx.provide('externalValue', config.value); } };
      ${exportName === 'default' ? 'export default plugin;' : 'export const panel = plugin;'} `,
    );
    const frontendAssembly = createHostAssembly({
      root: {
        program: 'product:panel#opaque',
        codeRevision: 'immutable-release-one',
        config: { value: 42 },
      },
    });
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    await expect(
      createViteConfig(facts.value, 'serve', '/', { host: { backend, frontendAssembly } }),
    ).rejects.toMatchObject({
      code: 'host-assembly-invalid',
      detail: { reason: expect.stringContaining('frontendModule') },
    });
    const binding = {
      backend,
      frontendAssembly,
      frontendModule: { specifier, export: exportName },
    };
    const config = await createViteConfig(facts.value, 'serve', '/', { host: binding });
    if (!config.root) throw new Error('generated host root missing');
    const generatedRoot = config.root;
    const lifecycle = (config.plugins ?? [])
      .flat()
      .find(
        (plugin) =>
          plugin &&
          typeof plugin === 'object' &&
          'name' in plugin &&
          plugin.name === 'forgeax:project-session',
      ) as import('vite').Plugin;
    if (typeof lifecycle.hotUpdate !== 'function') throw new Error('project HMR owner missing');
    const update = lifecycle.hotUpdate;
    await expect(
      update.call(
        { environment: { name: 'client' } } as never,
        {
          file: resolve(generatedRoot, '.forgeax/generated/assets.d.ts').replaceAll('\\', '/'),
        } as never,
      ),
    ).resolves.toEqual([]);
    await expect(
      update.call(
        { environment: { name: 'client' } } as never,
        { file: resolve(`${config.root}-sibling`, 'assets.d.ts').replaceAll('\\', '/') } as never,
      ),
    ).resolves.toEqual([]);
    const changedModules = new Set<import('vite').ModuleNode>();
    const updateFile = (file: string) =>
      update.call(
        { environment: { name: 'client' } } as never,
        { file, server: { moduleGraph: { getModulesByFile: () => changedModules } } } as never,
      );
    await expect(
      updateFile(resolve(root, '..', 'tsconfig.tmp.tsbuildinfo')),
    ).resolves.toBeUndefined();
    const dependency = resolve(root, '..', 'external-dependency.mjs');
    await expect(updateFile(dependency)).resolves.toBeUndefined();
    changedModules.add({ file: dependency, importers: new Set() } as import('vite').ModuleNode);
    await expect(updateFile(dependency)).rejects.toThrow(
      expect.objectContaining({ code: 'host-assembly-invalid' }),
    );
    const source = await readFile(resolve(config.root, 'main.ts'), 'utf8');
    const start = source.indexOf('activateRoot: ') + 'activateRoot: '.length;
    const end = source.indexOf(',\n  ...(hostTransport', start);
    const entry = resolve(root, 'activate.mjs');
    await writeFile(
      entry,
      `export default (canonicalHostJson, startNativePlugin, hostRoot, hostDescriptor) => (${source.slice(start, end)});`,
    );
    const activate = (await import(pathToFileURL(entry).href)).default(
      canonicalHostJson,
      startNativePlugin,
      null,
      null,
    );
    await expect(
      activate(ctx, { ...frontendAssembly.root, codeRevision: 'obsolete' }, undefined),
    ).rejects.toThrow('snapshot mismatch');
    const installed = await activate(ctx, frontendAssembly.root, undefined);
    expect(ctx.get('externalValue')).toBe(42);
    await installed.dispose();
    expect(ctx.get('externalValue')).toBeUndefined();
    await expect(
      createViteConfig(
        { ...facts.value, roots: { frontend: '00000000-0000-4000-8000-000000000001' } },
        'serve',
        '/',
        { host: binding },
      ),
    ).rejects.toMatchObject({
      code: 'host-assembly-invalid',
      detail: { reason: expect.stringContaining('external and project frontend roots') },
    });
    const missing = await createViteConfig(facts.value, 'serve', '/', {
      host: { ...binding, frontendModule: { specifier, export: 'absent' } },
    });
    if (!missing.root) throw new Error('generated host root missing');
    const missingSource = await readFile(resolve(missing.root, 'main.ts'), 'utf8');
    const missingStart = missingSource.indexOf('activateRoot: ') + 'activateRoot: '.length;
    const missingEnd = missingSource.indexOf(',\n  ...(hostTransport', missingStart);
    const missingEntry = resolve(root, 'missing.mjs');
    await writeFile(
      missingEntry,
      `export default (canonicalHostJson, startNativePlugin, hostRoot, hostDescriptor) => (${missingSource.slice(missingStart, missingEnd)});`,
    );
    const invalid = (await import(pathToFileURL(missingEntry).href)).default(
      canonicalHostJson,
      startNativePlugin,
      null,
      null,
    );
    await expect(invalid(ctx, frontendAssembly.root, undefined)).rejects.toThrow(
      'selected native plugin export',
    );
  } finally {
    await ctx.fiber.dispose();
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('serves a package-owned frontend module when the game has no host package dependency', async () => {
  const parent = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-package-frontend-')));
  const gameRoot = resolve(parent, 'game');
  const packageRoot = resolve(parent, 'host-package');
  const frontend = resolve(packageRoot, 'frontend.mjs');
  const backend = await createBackendHost();
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await mkdir(gameRoot);
    await mkdir(resolve(gameRoot, 'assets'));
    await mkdir(packageRoot);
    await writeFile(
      resolve(gameRoot, 'forge.json'),
      JSON.stringify({ schemaVersion: '3.0.0', id: 'game', name: 'Game', roots: {} }),
    );
    await writeFile(resolve(gameRoot, 'package.json'), '{"name":"fixture-game","type":"module"}');
    await writeFile(
      resolve(gameRoot, 'entry.mjs'),
      "import value from 'host-fixture/frontend'; export default value;",
    );
    await writeFile(
      resolve(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'host-fixture',
        type: 'module',
        exports: { './frontend': './frontend.mjs' },
      }),
    );
    await writeFile(frontend, "export default 'package frontend';");
    await (
      await backend.context.plugin({
        name: 'fixture:host-package',
        provide: ['devkitBackend'],
        apply(ctx) {
          ctx.provide('devkitBackend', {
            host: backend,
            root: gameRoot,
            hostPackageRoot: packageRoot,
            assertCurrent: async () => {},
          });
        },
      })
    ).await();
    expect(backend.context.get('devkitBackend')?.hostPackageRoot).toBe(packageRoot);
    const facts = await readProjectFacts(gameRoot);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve', '/', {
      host: {
        backend,
        frontendAssembly: createHostAssembly({
          root: { program: 'host-fixture/frontend', codeRevision: '1' },
        }),
        frontendModule: { specifier: 'host-fixture/frontend' },
      },
    });
    server = await createServer({
      configFile: false,
      root: gameRoot,
      logLevel: 'silent',
      resolve: { alias: config.resolve?.alias ?? [] },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        host: '127.0.0.1',
        port: 0,
        fs: { allow: config.server?.fs?.allow ?? [] },
      },
    });
    await server.listen();
    expect((await server.transformRequest('/entry.mjs'))?.code).toContain('frontend.mjs');
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const served = await fetch(
      `http://127.0.0.1:${address.port}/@fs${pathToFileURL(await realpath(frontend)).pathname}`,
    );
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('package frontend');
  } finally {
    await server?.close();
    await backend.dispose();
    await rm(parent, { recursive: true, force: true });
  }
});

it('prepares a native platform before the generated Host connection and drains it on cleanup', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-platform-binding-'));
  const backend = await createBackendHost();
  let context: Context | undefined;
  try {
    const specifier = pathToFileURL(resolve(root, 'platform.mjs')).href;
    await writeFile(
      resolve(root, 'platform.mjs'),
      `
      export const preparePlatform = {
        provide: ['frontendPlatform'],
        apply(ctx, config) {
          ctx.provide('frontendPlatform', { window: { location: new URL(config.url) } });
        }
      };
      export default { inject: ['frontendPlatform'], apply(ctx) {} };
    `,
    );
    const assembly = createHostAssembly({
      root: {
        program: 'fixture/platform',
        codeRevision: 'one',
        config: { url: 'https://host.example/editor?target=one' },
      },
    });
    const binding = {
      backend,
      frontendAssembly: assembly,
      frontendModule: { specifier, prepare: 'preparePlatform' },
    };
    const config = await createViteConfig(
      { root, id: 'platform', name: 'Platform', assetRoots: [], packageJson: {}, roots: {} },
      'serve',
      '/',
      { host: binding },
    );
    if (!config.root) throw new Error('Generated frontend root must be configured');
    const source = await readFile(resolve(config.root, 'main.ts'), 'utf8');
    const preparation = source.slice(
      source.indexOf('const hostContext ='),
      source.indexOf('const bootstrapRoot ='),
    );
    const cleanup = source.slice(
      source.indexOf('const hostLifecyclePlugin ='),
      source.indexOf('const hostTransport ='),
    );
    const module = resolve(root, 'generated-platform.mjs');
    await writeFile(
      module,
      `export default async (Context, startNativePlugin, initialAssembly, hostTransport) => {
      ${preparation}
      let removeWorkspaceAssemblySubscription;
      ${cleanup}
      return { hostContext, frontendPlatform, location, hostLifecyclePlugin };
    };`,
    );
    let connectionClosed = false;
    const generated = await (await import(pathToFileURL(module).href)).default(
      Context,
      startNativePlugin,
      assembly,
      {
        close() {
          connectionClosed = true;
        },
      },
    );
    context = generated.hostContext;
    if (!context) throw new Error('Prepared frontend Context must be installed');
    expect(generated.location.href).toBe('https://host.example/editor?target=one');
    expect(context.get('frontendPlatform')).toBe(generated.frontendPlatform);
    const lifecycle = context.plugin(generated.hostLifecyclePlugin);
    await lifecycle.await();
    await lifecycle.dispose();
    expect(connectionClosed).toBe(true);
    expect(context.get('frontendPlatform', false)).toBeUndefined();
    const invalid = { ...binding, frontendModule: { specifier, prepare: '' } };
    expect(() => validateHostBinding(invalid)).toThrow(
      expect.objectContaining({
        code: 'host-assembly-invalid',
        detail: { reason: expect.stringContaining('nonempty') },
      }),
    );
  } finally {
    await context?.fiber.dispose();
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
