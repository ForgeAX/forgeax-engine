import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectHostWebSocket } from '@forgeax/engine-host/transport';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { afterEach, expect, it } from 'vitest';
import { createDevKitBackend, devKitBackendServerPlugin } from '../backend.js';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { discoverHostPackTools } from '../tools/project-tools.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-backend-'));
  roots.push(root);
  return root;
}

it('serves Engine capabilities without opening a project or starting a browser', async () => {
  const backend = await createDevKitBackend(await directory());
  let stopped = false;
  try {
    expect(backend.host.context.engineWorkspace.project).toBeUndefined();
    await (
      await backend.host.context.plugin(devKitBackendServerPlugin, {
        stop: () => {
          stopped = true;
        },
      })
    ).await();
    const connection = backend.host.context.devkitBackendServer;
    const url = new URL(connection.endpoint);
    url.searchParams.set('token', connection.token);
    const client = await connectHostWebSocket(url.href);
    try {
      const capabilities = (await client.request('engine.workspace.capabilities', undefined)) as {
        operations: { id: string }[];
      };
      expect(
        capabilities.operations.some((operation) => operation.id === 'engine.project.open'),
      ).toBe(true);
      expect(
        capabilities.operations.some((operation) => operation.id === 'engine.run.observe'),
      ).toBe(true);
      expect(backend.host.context.engineWorkspace.project).toBeUndefined();
      const toolContract = (await client.request('engine.backend.tool.list', undefined)) as {
        commands: { id: string; path: string[]; argsSchema?: string }[];
      };
      const tree = toolContract.commands.find((command) => command.id === 'engine.scene.tree.get');
      expect(tree?.path).toEqual(['engine', 'scene', 'tree', 'get']);
      expect(JSON.parse(tree?.argsSchema ?? '{}').required).toContain('targetId');
      expect(toolContract.commands.every((command) => command.path.join('.') === command.id)).toBe(
        true,
      );
      expect(toolContract.commands.some((command) => command.id === 'engine.scene-tree.get')).toBe(
        false,
      );
      await expect(
        client.request('engine.backend.call', { operation: 'absent' }),
      ).resolves.toMatchObject({
        outcome: 'failed',
        failure: { code: 'tool-capability-unavailable' },
      });
      const frontend = backend.host.transport.connect({ kind: 'frontend' });
      try {
        await expect(frontend.request('engine.backend.stop', undefined)).rejects.toThrow(
          'authenticated Engine owner',
        );
      } finally {
        frontend.close();
      }
      expect(stopped).toBe(false);
      await client.request('engine.backend.stop', undefined);
      await new Promise((done) => setTimeout(done, 10));
      expect(stopped).toBe(true);
    } finally {
      client.close();
    }
  } finally {
    await backend.dispose();
  }
});

const packageId = '01900000-0000-7000-8000-000000008101';
const pluginGuid = (key: string) =>
  AssetGuid.format(AssetGuid.derive(definePackageId(packageId), key));

async function hostProject(root: string, otherRoots = false) {
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      id: 'fixture',
      name: 'Fixture',
      roots: {
        host: pluginGuid('host'),
        ...(otherRoots
          ? {
              engine: pluginGuid('engine'),
              frontend: pluginGuid('frontend'),
            }
          : {}),
      },
    }),
  );
  await writeFile(
    join(root, 'assets', 'host.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId,
      assets: Object.fromEntries(
        ['host', 'engine', 'frontend'].map((key) => [
          key,
          {
            kind: 'plugin',
            payload: { module: { specifier: `./${key}.mjs` } },
          },
        ]),
      ),
    }),
  );
  for (const key of ['engine', 'frontend'])
    await writeFile(
      join(root, 'assets', `${key}.mjs`),
      `throw new Error('must not execute ${key}'); export default { apply() {} };`,
    );
}

it('activates only the host root and releases it before removing compiled modules', async () => {
  const root = await directory();
  await hostProject(root, true);
  await writeFile(
    join(root, 'assets', 'host.mjs'),
    `
    import { existsSync } from 'node:fs';
    export default {
      name: 'fixture', inject: ['devkitBackend'], provide: ['fixture'],
      apply(ctx) {
        const state = { host: ctx.devkitBackend.host, disposed: false, modulesPresent: false, modulesPresentBefore: existsSync(new URL(import.meta.url)) };
        ctx.provide('fixture', state);
        ctx.effect(() => async () => {
          await new Promise(resolve => setTimeout(resolve, 30));
          state.modulesPresent = existsSync(new URL(import.meta.url));
          state.disposed = true;
        });
      }
    };
  `,
  );
  const backend = await createDevKitBackend(root);
  const fixture = backend.host.context.get('fixture') as {
    host: unknown;
    disposed: boolean;
    modulesPresent: boolean;
  };
  try {
    expect(fixture).toMatchObject({ modulesPresentBefore: true });
    expect(fixture.host).toBe(backend.host);
    expect(backend.host.context.engineWorkspace.project).toBeUndefined();
    expect(await readdir(join(root, '.forgeax', 'host'))).toHaveLength(1);
  } finally {
    await backend.dispose();
  }
  expect(fixture).toMatchObject({ disposed: true, modulesPresent: true });
  expect(await readdir(join(root, '.forgeax', 'host'))).toEqual([]);
});

it('removes partial compilation and activation after host startup fails', async () => {
  const root = await directory();
  await hostProject(root);
  await writeFile(
    join(root, 'assets', 'host.mjs'),
    `export default { apply() { throw new Error('broken host'); } };`,
  );
  await expect(createDevKitBackend(root)).rejects.toMatchObject({ code: 'plugin-startup-failed' });
  expect(await readdir(join(root, '.forgeax', 'host'))).toEqual([]);
});

it('loads a selected external host Pack without adding View assets to the game project', async () => {
  const workspace = await directory();
  const extension = await directory();
  await mkdir(join(extension, 'node_modules', '@forgeax'), { recursive: true });
  await symlink(
    join(import.meta.dirname, '../../../engine'),
    join(extension, 'node_modules', '@forgeax', 'engine'),
    'dir',
  );
  const pack = join(extension, 'host.pack.json');
  await writeFile(
    pack,
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId,
      assets: {
        'plugin/main': {
          kind: 'plugin',
          payload: {
            module: { specifier: './host.mjs' },
            toolContract: { specifier: './commands.mjs' },
          },
        },
      },
    }),
  );
  await writeFile(
    join(extension, 'host.mjs'),
    `export default {
    name: 'external-host', inject: ['devkitBackend'], provide: ['externalHost'],
    apply(ctx) { ctx.provide('externalHost', ctx.devkitBackend.hostPackageRoot); }
  };`,
  );
  await writeFile(
    join(extension, 'commands.mjs'),
    `export default {
    schemaVersion: '1.0.0', commands: [{
      id: 'external.status', path: ['external', 'status'], title: 'External status',
      summary: 'Read external status', realm: 'host',
    }],
  };`,
  );
  const tools = await discoverHostPackTools(pack);
  expect(tools.map((tool) => tool.declaration.id)).toEqual(['external.status']);
  const backend = await createDevKitBackend(workspace, { hostPack: pack });
  try {
    expect(backend.host.context.get('externalHost')).toBe(await realpath(extension));
    expect(backend.host.context.engineWorkspace.project).toBeUndefined();
  } finally {
    await backend.dispose();
  }
});

it('keeps resident host modules outside generated browser and Worker program tables', async () => {
  const root = await directory();
  await hostProject(root);
  await writeFile(
    join(root, 'assets', 'host.mjs'),
    `import 'node:fs'; throw new Error('backend only'); export default { apply() {} };`,
  );
  const facts = await readProjectFacts(root);
  if (!facts.ok) throw new Error(facts.error.hint);
  const config = await createViteConfig(facts.value, 'serve');
  if (!config.root) throw new Error('Missing generated root');
  const source = await readFile(join(config.root, 'main.ts'), 'utf8');
  expect(source).not.toContain('assets/host.mjs');
  const worker = await readFile(join(config.root, 'execution-bootstrap.ts'), 'utf8');
  expect(worker).not.toContain('assets/host.mjs');
});

it('requires resident source changes to restart before another browser candidate', async () => {
  const root = await directory();
  await hostProject(root);
  await writeFile(join(root, 'assets', 'host.mjs'), `export default { apply() {} };`);
  const backend = await createDevKitBackend(root);
  try {
    await expect(backend.host.context.devkitBackend.assertCurrent()).resolves.toBeUndefined();
    await writeFile(join(root, 'assets', 'new-helper.pack.ts'), 'export const value = 1;');
    await expect(backend.host.context.devkitBackend.assertCurrent()).rejects.toThrow(
      'restart the backend',
    );
    await rm(join(root, 'assets', 'new-helper.pack.ts'));
    await writeFile(
      join(root, 'assets', 'host.mjs'),
      `export default { apply() { /* changed */ } };`,
    );
    await expect(backend.host.context.devkitBackend.assertCurrent()).rejects.toThrow(
      'restart the backend',
    );
  } finally {
    await backend.dispose();
  }
});

it('releases an upgraded backend socket when its peer never acknowledges close', async () => {
  const backend = await createDevKitBackend(await directory());
  await (await backend.host.context.plugin(devKitBackendServerPlugin, { stop() {} })).await();
  const { endpoint, token } = backend.host.context.devkitBackendServer;
  const url = new URL(endpoint);
  const socket = connect(Number(url.port), url.hostname);
  const closed = new Promise<void>((done) => socket.once('close', () => done()));
  try {
    await new Promise<void>((done, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          `GET /host?token=${token} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      socket.once('data', (bytes) => {
        expect(bytes.toString()).toContain('101 Switching Protocols');
        done();
      });
    });
    // Read the native close frame without replying: a stalled or disappearing
    // browser must not retain the backend's upgraded TCP connection.
    socket.on('data', () => {});
    await Promise.race([
      backend.dispose().then(() => closed),
      new Promise<never>((_done, reject) => {
        const timer = setTimeout(
          () => reject(new Error('backend retained its upgraded socket')),
          1000,
        );
        closed.then(() => clearTimeout(timer));
      }),
    ]);
  } finally {
    socket.destroy();
    await backend.dispose();
  }
});
