import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { createEngineWorkspaceRuntime } from '@forgeax/engine-app';
import { createOperationHistoryStore, createOperationHistoryTools } from '@forgeax/engine/devkit';
import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import { ViewWorkspaceClient } from '../packages/view-workspace-core/src/client.ts';

it('routes history to the selected native document and keeps frontend project isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'view-history-route-'));
  const previous = process.env.FORGEAX_HISTORY_DIR;
  process.env.FORGEAX_HISTORY_DIR = join(root, 'history');
  const backend = await createBackendHost();
  const api = backend.context.get('toolApi');
  const provider = api.registerProvider({
    providerId: 'history-test',
    sourceId: 'engine-workspace',
    realm: 'host',
    tools: createOperationHistoryTools(),
  });
  const runtimes = [];
  const owners = new Map();
  let unregister, broker;
  const clients = [];
  try {
    for (const name of ['first', 'second']) {
      const directory = join(root, name);
      await mkdir(directory);
      await (await createOperationHistoryStore(directory)).track(name, {}, async () => ({
        outcome: 'succeeded',
        result: {},
        artifacts: [],
      }));
      const runtime = createEngineWorkspaceRuntime({
        openProject: ({ root }) => ({ project: { id: root, root } }),
        closeProject() {},
        listAssets: () => [],
        openPreview() {
          throw new Error('No rendering is needed');
        },
      });
      await runtime.openProject({ root: directory });
      runtimes.push(runtime);
    }
    broker = new ViewWorkspaceBroker({
      toolApi: api,
      accessToken: 'history-test',
      engineForCaller: (caller) => {
        if (caller.kind !== 'frontend') return undefined;
        if (!owners.has(caller.connectionId))
          owners.set(caller.connectionId, runtimes[owners.size]);
        return owners.get(caller.connectionId);
      },
    });
    unregister = broker.registerTransport(backend.transport);
    const connect = (kind) => {
      const connection = backend.transport.connect({
        kind,
        sourceId: kind === 'frontend' ? 'view-frontend' : 'history-cli',
      });
      clients.push(connection);
      const client = new ViewWorkspaceClient({
        transport: connection,
        clientId: kind,
        token: broker.accessToken,
      });
      return {
        connection,
        call: (operation, args = {}) => client.call(operation, args, { reportError: false }),
      };
    };
    const cli = connect('cli');
    await assert.rejects(
      cli.call('history.list'),
      (error) => error.code === 'view-page-unavailable',
    );
    const first = connect('frontend');
    assert.equal((await cli.call('history.list')).items[0].operation, 'first');
    const second = connect('frontend');
    await assert.rejects(cli.call('history.list'), (error) => error.code === 'view-page-ambiguous');
    const selected = await cli.call('history.list', {
      connectionId: second.connection.caller.connectionId,
      root: '/forged',
    });
    assert.equal(selected.root, await realpath(join(root, 'second')));
    assert.equal(selected.items[0].operation, 'second');
    await assert.rejects(
      first.call('history.list', { connectionId: second.connection.caller.connectionId }),
      (error) => error.code === 'view-presentation-page-denied',
    );
  } finally {
    for (const client of clients) client.close();
    unregister?.();
    await broker?.dispose();
    for (const runtime of runtimes) await runtime.dispose();
    await provider.revoke();
    await backend.dispose();
    if (previous === undefined) delete process.env.FORGEAX_HISTORY_DIR;
    else process.env.FORGEAX_HISTORY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
