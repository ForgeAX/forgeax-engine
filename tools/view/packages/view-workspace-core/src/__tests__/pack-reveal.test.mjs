import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostTransport } from '@forgeax/engine-host/transport';
import { ViewWorkspaceClient } from '../client.ts';
import { VIEW_PACK_REVEAL_TOPIC, VIEW_PACK_REVEAL_ACK_SERVICE } from '../contract.ts';
import { ViewWorkspaceBroker } from '../broker.ts';

test('Pack reveal counts the retained Shell and its project document as one page', async () => {
  const transport = createHostTransport();
  const target = { sessionId: 'session', targetId: 'target', generation: 1, worldId: 'world', headed: true };
  const status = { phase: 'running', sessionId: 'session', generation: 1, target,
    document: { sessionId: 'session', targetId: 'target', url: 'http://game.test/' }, browserGeneration: 1 };
  const engine = { project: { project: { id: 'project', root: '/project', assetRoots: ['assets'] }, status },
    projectStatus: status, subscribeProjectStatus() { return () => {}; } };
  const broker = new ViewWorkspaceBroker({ engine, engineForCaller: () => engine,
    packSources: async () => ({ sources: [{ sourcePath: 'assets/proof.pack.ts', revision: 'revision', outputs: [] }], hasMore: false }) });
  const unregister = broker.registerTransport(transport);
  const shell = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const project = transport.connect({ kind: 'frontend', sourceId: 'forgeax-workspace:session:target' });
  const input = { projectId: 'project', sourcePath: 'assets/proof.pack.ts', revision: 'revision' };
  const received = [];
  const detachShell = shell.subscribe(VIEW_PACK_REVEAL_TOPIC, intent => {
    received.push('shell');
    if (!intent.cancelled) void shell.request(VIEW_PACK_REVEAL_ACK_SERVICE, { ...input, requestId: intent.requestId, shown: true });
  });
  const detachProject = project.subscribe(VIEW_PACK_REVEAL_TOPIC, () => received.push('project'));
  try {
    assert.equal(broker.pageSessions.size, 2);
    assert.equal(broker.pages().pages.length, 1);
    const result = await broker.revealPack(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.connectionId, shell.caller.connectionId);
    assert.deepEqual(received, ['shell']);
  } finally {
    detachShell(); detachProject(); unregister(); shell.close(); project.close(); await broker.dispose(); transport.close();
  }
});

test('frontend Pack reveal selects its trusted caller among multiple View pages', async () => {
  const transport = createHostTransport();
  const broker = new ViewWorkspaceBroker({ accessToken: 'reveal-test',
    packSources: async () => ({ sources: [{ sourcePath: 'assets/link-demo.pack.ts', revision: 'revision', outputs: [] }], hasMore: false }) });
  const unregister = broker.registerTransport(transport);
  const first = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const second = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const current = new ViewWorkspaceClient({ transport: second, clientId: 'test', token: broker.accessToken });
  const input = { projectId: 'project', sourcePath: 'assets/link-demo.pack.ts', revision: 'revision' };
  const received = [];
  const detachFirst = first.subscribe(VIEW_PACK_REVEAL_TOPIC, intent => received.push({ page: 'other', intent }));
  const detachSecond = second.subscribe(VIEW_PACK_REVEAL_TOPIC, intent => {
    received.push({ page: 'current', intent });
    if (!intent.cancelled) void second.request(VIEW_PACK_REVEAL_ACK_SERVICE, { ...input, requestId: intent.requestId, shown: true });
  });
  try {
    assert.equal(broker.pageSessions.size, 2);
    for (const page of broker.pageSessions.values())
      Object.defineProperty(page.broker, 'project', { get: () => ({ id: 'project', root: '/project', assetRoots: ['assets'] }) });
    const result = await current.revealPack(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.connectionId, second.caller.connectionId);
    assert.deepEqual(received.map(value => value.page), ['current']);
    await assert.rejects(current.revealPack({ ...input, connectionId: first.caller.connectionId }), error => error.code === 'view-presentation-page-denied');
    const nonFrontend = await broker.call({ apiVersion: 'forgeax.view.workspace/2', operation: 'pack.reveal', args: input, clientId: 'cli', requestId: 'cli-reveal', token: broker.accessToken });
    assert.equal(nonFrontend.code, 'view-page-ambiguous');
    assert.equal(nonFrontend.ok, false);
  } finally {
    detachFirst(); detachSecond(); unregister(); first.close(); second.close(); await broker.dispose(); transport.close();
  }
});
