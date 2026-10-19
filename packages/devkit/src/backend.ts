import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BackendHost, createBackendHost, type HostAssembly } from '@forgeax/engine-host';
import { attachHostWebSocketServer } from '@forgeax/engine-host/transport';
import {
  type Context,
  type Plugin,
  type PluginPrograms,
  startPluginAsset,
} from '@forgeax/engine-plugin';
import { GameProjectSchema } from '@forgeax/engine-project';
import {
  defineToolCommandContract,
  operationCommandPath,
  type ToolApi,
} from '@forgeax/engine-tool-runtime';
import { err, ok } from '@forgeax/engine-types';
import { WebSocketServer } from 'ws';
import { traceBackendStartup } from './backend-startup.js';
import {
  assertPluginSourceInputs,
  discoverPluginAssets,
  type PluginSourceInventory,
} from './build/plugin-assets.js';
import { compileNodePluginPrograms } from './build/plugin-programs-node.js';
import { readProjectFacts } from './project.js';
import type { ProjectFacts } from './types.js';
import { devKitWorkspacePlugin } from './workspace-plugin.js';

export interface DevKitBackend {
  readonly host: BackendHost;
  readonly root: string;
  readonly hostPackageRoot?: string;
  /** Fences browser replacement against this resident backend's source snapshot. */
  assertCurrent(): Promise<void>;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    devkitBackend: DevKitBackend;
    /** Optional native presentation plugin; sampled when explicitly opening a workspace. */
    devkitWorkspaceFrontend: {
      readonly assembly: HostAssembly;
      readonly module: NonNullable<import('./host-binding.js').DevKitHostBinding['frontendModule']>;
    };
  }
}

/** The resident workspace owns domain plugins; a Pack-owned host root remains optional. */
export async function createDevKitBackend(
  rootInput: string,
  options: { readonly hostPack?: string } = {},
) {
  const root = resolve(rootInput);
  const requestedHostPack = options.hostPack;
  const hostPack =
    requestedHostPack === undefined
      ? undefined
      : await traceBackendStartup('host-pack-path', () => realpath(requestedHostPack));
  const hostPackageRoot = hostPack === undefined ? undefined : dirname(hostPack);
  const project = await traceBackendStartup('project-config', () =>
    readFile(resolve(root, 'forge.json'), 'utf8').then(
      (value) => GameProjectSchema.parse(JSON.parse(value)),
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      },
    ),
  );
  const host = await traceBackendStartup('host-create', () => createBackendHost());
  let hostInventory: PluginSourceInventory | undefined;
  let hostSourceRoot: string | undefined;
  const assertCurrent = async () => {
    if (hostInventory) {
      try {
        await assertPluginSourceInputs(hostInventory, hostSourceRoot ?? root);
      } catch (cause) {
        throw new Error(
          'Resident host sources changed; restart the backend before replacing browser sessions.',
          { cause },
        );
      }
    }
    const current = await readProjectFacts(root);
    if (!hostPack && current.ok && current.value.roots.host !== project?.roots.host)
      throw new Error(
        'Resident host root changed; restart the backend before replacing browser sessions.',
      );
  };
  try {
    const owner: Plugin = {
      name: 'forgeax:devkit-backend',
      provide: ['devkitBackend'],
      apply(ctx: Context) {
        ctx.provide('devkitBackend', { host, root, hostPackageRoot, assertCurrent });
      },
    };
    await traceBackendStartup('host-owner', async () => {
      await (await host.context.plugin(owner)).await();
    });
    await traceBackendStartup('workspace-plugin', async () => {
      const workspace = await host.context.plugin(devKitWorkspacePlugin, {
        hostBinding: {
          backend: host,
          get frontendAssembly() {
            return host.context.get('devkitWorkspaceFrontend')?.assembly;
          },
          get frontendModule() {
            return host.context.get('devkitWorkspaceFrontend')?.module;
          },
        },
      });
      await workspace.await();
    });
    if (hostPack || project?.roots.host) {
      const projectFacts = await traceBackendStartup('project-facts', () => readProjectFacts(root));
      let facts: ProjectFacts;
      if (hostPack) {
        facts = {
          root: dirname(hostPack),
          id: projectFacts.ok ? projectFacts.value.id : 'host',
          name: projectFacts.ok ? projectFacts.value.name : 'Host',
          packageJson: projectFacts.ok ? projectFacts.value.packageJson : {},
          roots: {},
          assetRoots: [hostPack],
        };
      } else if (projectFacts.ok) facts = projectFacts.value;
      else throw projectFacts.error;
      const inventory = await traceBackendStartup('host-assets', () => discoverPluginAssets(facts));
      const hostRoot = hostPack
        ? [...inventory.assets.values()].find(
            (record) => record.sourcePath === hostPack && record.sourceKey === 'plugin/main',
          )?.definition.guid
        : project?.roots.host;
      if (!hostRoot) throw new Error(`Host Pack must define plugin/main: ${hostPack ?? root}`);
      hostInventory = inventory;
      hostSourceRoot = facts.root;
      const directory = resolve(root, '.forgeax', 'host');
      await mkdir(directory, { recursive: true });
      const temporary = await mkdtemp(resolve(directory, 'session-'));
      const hostFacts = { ...facts, roots: { ...facts.roots, host: hostRoot } };
      await host.context.effect(async function* () {
        yield () => rm(temporary, { recursive: true, force: true });
        const compiled = await traceBackendStartup('host-compile', () =>
          compileNodePluginPrograms(
            hostFacts,
            'host',
            inventory,
            temporary,
            {},
            traceBackendStartup,
          ),
        );
        if (hostPackageRoot !== undefined) {
          const localDependencies = resolve(hostPackageRoot, 'node_modules');
          const parentDependencies = dirname(hostPackageRoot);
          const dependencies = await access(localDependencies).then(
            () => localDependencies,
            () =>
              basename(parentDependencies) === 'node_modules' ? parentDependencies : undefined,
          );
          if (dependencies === undefined)
            throw new Error(`Host package dependencies are unavailable: ${hostPackageRoot}`);
          await symlink(dependencies, resolve(temporary, 'compiled', 'node_modules'), 'dir');
        }
        const module = await traceBackendStartup(
          'host-import',
          () => import(pathToFileURL(compiled.entry).href),
        );
        const programs: PluginPrograms = module.createPrograms(randomUUID(), 'host', 1);
        host.context.provide('pluginPrograms', programs);
        host.context.provide('assets', {
          async readPluginDefinition(guid: string) {
            const record = inventory.assets.get(guid);
            return record
              ? ok(structuredClone(record.definition))
              : err({
                  code: 'plugin-definition-missing',
                  expected: 'a source-discoverable host plugin asset',
                  hint: 'Repair the host root or its source-only dependency definition.',
                  detail: { guid },
                });
          },
        });
        const started = await traceBackendStartup('host-plugin-start', () =>
          startPluginAsset(host.context, hostRoot),
        );
        if (!started.ok) throw Object.assign(new Error(started.error.hint), started.error);
        // Service withdrawal can begin native unload before this effect runs.
        // Join that transition even when a concurrent disposer is already a no-op.
        yield async () => {
          await started.value.dispose();
          while (started.value.inertia) await started.value.inertia;
        };
      });
    }
    return { host, root, dispose: () => host.dispose() };
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

/** Authenticated native Host transport; no browser, project session, or game is started. */
export const devKitBackendServerPlugin = {
  name: 'forgeax:devkit-backend-server',
  inject: ['devkitBackend', 'toolApi'],
  provide: ['devkitBackendServer'],
  async apply(ctx: Context, options: { stop: () => void }) {
    const { host } = ctx.devkitBackend;
    const api = ctx.toolApi as ToolApi;
    const token = randomUUID();
    const http = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const sockets = new WebSocketServer({ noServer: true });
    const connections = new Set<() => void>();
    http.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/host' || url.searchParams.get('token') !== token) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        const detach = attachHostWebSocketServer(ws, host.transport, {
          kind: 'cli',
          sourceId: 'devkit-backend-client',
        });
        const close = () => {
          detach();
          // Authority is already detached; shutdown must release the native
          // socket even when a vanished peer never completes a close handshake.
          ws.terminate();
          connections.delete(close);
        };
        connections.add(close);
        ws.once('close', close);
      });
    });
    const status = host.transport.register('engine.backend.status', () => ({
      root: ctx.devkitBackend.root,
      phase: 'ready',
    }));
    const stop = host.transport.register('engine.backend.stop', ({ caller }) => {
      if (caller.kind !== 'cli' || caller.sourceId !== 'devkit-backend-client')
        throw new Error('Stop the backend through its authenticated Engine owner connection.');
      setTimeout(options.stop, 0);
      return { stopping: true };
    });
    const listTools = host.transport.register('engine.backend.tool.list', () => {
      const records = api.list().filter((record) => record.callable);
      return defineToolCommandContract(
        records
          .filter(
            (record) =>
              records.filter((candidate) => candidate.descriptor.id === record.descriptor.id)
                .length === 1,
          )
          .map(({ descriptor }) => ({
            id: descriptor.id,
            path: operationCommandPath(descriptor.id),
            title: descriptor.title,
            summary: descriptor.summary,
            realm: descriptor.realm,
            ...(descriptor.inputSchema === undefined
              ? {}
              : { argsSchema: JSON.stringify(descriptor.inputSchema) }),
            ...(descriptor.outputSchema === undefined
              ? {}
              : { resultSchema: JSON.stringify(descriptor.outputSchema) }),
            evidence: descriptor.evidence,
          })),
      );
    });
    const call = host.transport.register(
      'engine.backend.call',
      async ({ payload, caller, signal }) => {
        const input = payload as { operation?: unknown; args?: unknown };
        if (typeof input?.operation !== 'string')
          throw new TypeError('Backend call requires an operation');
        const owners = api
          .list()
          .filter((record) => record.callable && record.descriptor.id === input.operation);
        const owner = owners.length === 1 ? owners[0]?.owner : undefined;
        if (!owner)
          return {
            outcome: 'failed',
            artifacts: [],
            failure: {
              code: 'tool-capability-unavailable',
              expected: `one active provider for ${input.operation}`,
              hint: 'Enable the owning host plugin and retry the operation.',
              detail: { capability: input.operation, realm: 'host' },
            },
          };
        return api.run(input.operation, input.args ?? {}, {
          caller,
          signal,
          sourceId: owner.sourceId,
          providerId: owner.providerId,
          generation: owner.generation,
        }).terminal;
      },
    );
    ctx.effect(() => async () => {
      call();
      listTools();
      stop();
      status();
      for (const close of [...connections]) close();
      sockets.close();
      await new Promise<void>((resolveClosed) => http.close(() => resolveClosed()));
    });
    await once(http.listen(0, '127.0.0.1'), 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Backend did not bind a TCP port');
    ctx.provide('devkitBackendServer', { endpoint: `ws://127.0.0.1:${address.port}/host`, token });
  },
};

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    devkitBackendServer: { readonly endpoint: string; readonly token: string };
  }
}
