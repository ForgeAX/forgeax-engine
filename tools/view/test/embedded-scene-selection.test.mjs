import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostTransport } from '@forgeax/engine-host/transport';
import { createToolApi, defineTool, toolJsonSchema } from '@forgeax/engine/tool-runtime';
import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import { createViewWorkspaceClient } from '../packages/view-workspace-core/src/client.ts';

test('an embedded canvas selection reaches its owning Shell without changing independent pages', async () => {
  const transport = createHostTransport();
  const api = createToolApi();
  const project = { id: 'game', root: '/game' };
  const target = { sessionId: 'session', targetId: 'scene', worldId: 'world', generation: 1, headed: true, width: 800, height: 600 };
  const runtime = { project: { project, target, phase: 'running' }, preview: { target, asset: { guid: 'scene-asset', kind: 'scene' } } };
  const other = { project: { project, target: { ...target, sessionId: 'other-session', targetId: 'other-scene' }, phase: 'running' } };
  const schema = toolJsonSchema({ type: 'object' });
  const provider = api.registerProvider({ sourceId: 'engine-workspace', providerId: 'engine', realm: 'engine', tools:
    ['target.pick', 'entity.inspect', 'entity.highlight'].map(operation => defineTool({ id: `engine.${operation}`, title: operation,
      summary: operation, realm: 'engine', argsSchema: schema, resultSchema: schema, inputSchema: {}, outputSchema: {}, evidence: [] },
    args => operation === 'target.pick' ? { entityId: 'scene:world:cube' } : args.entityId ? { entityId: args.entityId } : {})) });
  let shellCaller;
  const broker = new ViewWorkspaceBroker({ toolApi: api, accessToken: 'token',
    engineForCaller(caller) {
      if (caller?.sourceId?.startsWith('forgeax-workspace:'))
        return caller.sourceId === `forgeax-workspace:${runtime.project.target.sessionId}:${runtime.project.target.targetId}` ? runtime : undefined;
      return !shellCaller || caller?.connectionId === shellCaller ? runtime : other;
    } });
  const remove = broker.registerTransport(transport);
  const shell = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  shellCaller = shell.caller.connectionId;
  const independent = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const canvas = transport.connect({ kind: 'frontend', sourceId: 'forgeax-workspace:session:scene' });
  const client = raw => createViewWorkspaceClient({ transport: raw, clientId: 'test', token: 'token' });
  const shellClient = client(shell), canvasClient = client(canvas), otherClient = client(independent);
  const observations = [];
  const unsubscribe = shellClient.subscribe(state => observations.push(state.sceneSelection?.primary.entityId ?? null));
  try {
    assert.deepEqual(broker.pages().pages.map(page => page.connectionId), [shellCaller, independent.caller.connectionId]);
    assert.equal(broker.resolvePageConnection(canvas.caller), shellCaller);
    await canvasClient.call('scene.pick', { targetId: 'scene', targetGeneration: 1, x: 40, y: 60 });
    assert.equal((await shellClient.getState()).sceneSelection?.primary.entityId, 'scene:world:cube');
    assert.equal(observations.at(-1), 'scene:world:cube');
    assert.equal((await otherClient.getState()).sceneSelection, null);
    await shellClient.call('scene.clear', { targetId: 'scene', targetGeneration: 1 });
    assert.equal((await canvasClient.getState()).sceneSelection, null);
    runtime.project.target = { ...target, targetId: 'replacement' };
    await assert.rejects(canvasClient.selectTab('forgeax-ai-display'), /view-page-gone/);
    runtime.project.target = target;
    canvas.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(broker.pageSessions.get(shellCaller).broker.disposing, false);
    await shellClient.call('scene.select', { targetId: 'scene', targetGeneration: 1, entityId: 'scene:world:tree' });
    assert.equal((await shellClient.getState()).sceneSelection.primary.entityId, 'scene:world:tree');
  } finally {
    unsubscribe(); remove(); transport.close(); await broker.dispose(); await provider.revoke(); await api.dispose();
  }
});
