import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Context } from '@forgeax/engine-plugin';
import { createHostTransport } from '@forgeax/engine-host/transport';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { WebSocket } from 'ws';
import workspacePlugin from '../packages/view-workspace-core/src/frontend-plugin.ts';
import { connectViewWorkspace, startViewHostServer } from '../packages/view-workspace-core/src/resident.ts';
import { ViewWorkspaceClient, workspaceBrowserEndpoint } from '../packages/view-workspace-core/src/client.ts';
import { VIEW_WORKSPACE_SERVICES } from '../packages/view-workspace-core/src/contract.ts';

test('workspace API owns a resident frontend connection with no CLI authority', async () => {
  const host = await createBackendHost();
  const transport = host.transport;
  const callers = [];
  const removed = [];
  transport.onClientConnect(caller => callers.push(caller));
  transport.onClientDisconnect(caller => removed.push(caller));
  const server = await startViewHostServer({ transport, accessToken: 'test-token' });
  const context = new Context();
  let socket;
  try {
    const fiber = context.plugin(workspacePlugin, {
      window: { WebSocket: class extends WebSocket { constructor(url) { super(url); socket = this; } } },
      workspace: { clientId: 'test-view', token: 'test-token', endpoint: server.frontendEndpoint,
        frontendTicket: server.frontendTicket },
    });
    await fiber.await();
    await context.get('viewOperationClient').getState().catch(() => {});
    for (let attempt = 0; attempt < 20 && callers.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(callers.length, 1);
    assert.equal(callers[0].kind, 'frontend');
    assert.equal(callers[0].sourceId, 'view-frontend');
    const closed = once(socket, 'close');
    await fiber.dispose();
    await closed;
    for (let attempt = 0; attempt < 20 && removed.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(removed.length, 1);
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    await context.fiber.dispose();
    await server.close();
    await host.dispose();
  }
});

test('workspace Fiber borrows embedding transport without closing it', async () => {
  const transport = createHostTransport();
  const borrowed = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const context = new Context();
  context.provide('hostTransport', borrowed);
  try {
    const fiber = context.plugin(workspacePlugin, {
      window: { WebSocket: class { constructor() { throw new Error('second page socket is forbidden'); } } },
      workspace: { clientId: 'embedded', token: 'test-token', endpoint: 'ws://unused.invalid/socket' },
    });
    await fiber.await();
    assert.equal(context.get('viewOperationClient').transport, borrowed);
    assert.equal(transport.connectedClients, 1);
    await fiber.dispose();
    assert.equal(borrowed.connected, true);
  } finally { await context.fiber.dispose(); transport.close(); }
});

test('View entry activates its client while a cold project open is pending', async () => {
  let finishOpen;
  const opening = new Promise(resolve => { finishOpen = resolve; });
  const calls = [];
  const owner = createHostTransport();
  owner.register(VIEW_WORKSPACE_SERVICES.call, ({ payload: request }) => {
      calls.push(request.operation);
      if (request.operation === 'tabs.get') return Promise.resolve({ revision: 1 });
      if (request.operation === 'project.open') return opening;
      throw new Error(`unexpected operation ${request.operation}`);
  });
  const transport = owner.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const window = {
    location: { href: 'http://localhost:8000/?project=%2Fgame', assign() {} },
    history: { replaceState() {} },
    performance: { getEntriesByType: () => [{ type: 'navigate' }] },
  };
  const context = new Context();
  context.provide('hostTransport', transport);
  let timer;
  try {
    const fiber = context.plugin(workspacePlugin, {
      window, workspace: { clientId: 'entry', token: 'test-token' },
    });
    await Promise.race([
      fiber.await(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('View entry activation waited for project.open')), 2000); }),
    ]);
    assert.ok(context.get('viewOperationClient'));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(calls.includes('tabs.get'));
    assert.equal(calls.filter(operation => operation === 'project.open').length, 1);
    assert.equal(calls.at(-1), 'project.open');
    finishOpen({ project: { id: 'game', root: '/game' }, projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new' } });
    await context.get('viewOperationClient').projectSession.ready;
  } finally {
    clearTimeout(timer);
    finishOpen?.({});
    await context.fiber.dispose();
    owner.close();
  }
});

test('disposing a connecting workspace Fiber closes its pending socket', async () => {
  const server = createServer();
  const accepted = once(server, 'upgrade');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const context = new Context();
  let socket;
  let peer;
  try {
    const fiber = context.plugin(workspacePlugin, {
      window: { WebSocket: class extends WebSocket { constructor(url) { super(url); socket = this; } } },
      workspace: { clientId: 'test-view', token: 'test-token', endpoint: `ws://127.0.0.1:${server.address().port}` },
    });
    const pending = fiber.await().catch(() => {});
    [, peer] = await accepted;
    const closed = once(socket, 'close').catch(() => {});
    await fiber.dispose();
    await pending;
    await closed;
    assert.notEqual(socket.readyState, WebSocket.OPEN);
  } finally { peer?.destroy(); await context.fiber.dispose(); await new Promise(done => server.close(done)); }
});

test('browser endpoint preserves frontend ticket and rejects non-WebSocket protocols', () => {
  const url = new URL(workspaceBrowserEndpoint('ws://localhost:8000/api', 'token', undefined, 'frontend', 'ticket'));
  assert.equal(url.searchParams.get('role'), 'frontend');
  assert.equal(url.searchParams.get('frontendTicket'), 'ticket');
  assert.equal(url.searchParams.get('token'), 'token');
  assert.throws(() => workspaceBrowserEndpoint('https://example.com', 'token'), /ws:/);
});


test('workspace connection entrypoints retain their missing-input diagnostics', async () => {
  assert.throws(() => new ViewWorkspaceClient(), {
    name: 'TypeError', message: 'View workspace client requires an Engine Host transport',
  });
  await assert.rejects(connectViewWorkspace(), {
    code: 'view-workspace-invalid-args', detail: { field: 'endpoint' },
  });
});
