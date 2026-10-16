import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolApi, defineTool, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';
import { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { VIEW_WORKSPACE_OPERATIONS, VIEW_WORKSPACE_SERVICES } from '@forgeax/view-workspace-core/contract';
import { parameterDrafts, parameterValues, runtimePackTarget } from '../packages/view-plugin-content-browser/src/ui/runtime-packs.ts';

test('runtime content uses the project target independently of selected previews and runs', () => {
  const workspace = {
    project: { id: 'project' },
    projectTarget: { targetId: 'project-target', worldId: 'project-world' },
    preview: { target: { targetId: 'preview', worldId: 'preview-world' } },
    display: { target: { targetId: 'ai-run', worldId: 'ai-world' } },
  };
  assert.deepEqual(runtimePackTarget(workspace), { projectId: 'project', targetId: 'project-target', worldId: 'project-world' });
  assert.equal(runtimePackTarget({ ...workspace, projectTarget: undefined }), undefined);
  assert.equal(runtimePackTarget({ ...workspace, projectTarget: { targetId: 'new', worldId: 'pending:new' } }), undefined);
});

test('parameter drafts retain booleans, numeric vectors, enum scalars and explicit zero overrides', () => {
  const parameters = [
    { name: 'width', type: 'f32', default: 2 },
    { name: 'enabled', type: 'bool', default: true },
    { name: 'vector', type: 'vec3', default: [1, 2, 3] },
    { name: 'style', type: 'enum', default: 'plain', values: ['plain', 'ornate'] },
  ];
  const drafts = parameterDrafts(parameters, { width: 0, enabled: false });
  assert.deepEqual(parameterValues(parameters, drafts), { width: 0, enabled: false, vector: [1, 2, 3], style: 'plain' });
  assert.throws(() => parameterValues(parameters, { ...drafts, width: '' }), /Enter width/);
  assert.throws(() => parameterValues(parameters, { ...drafts, vector: '[1,' }));
  assert.throws(() => parameterValues(parameters, { ...drafts, style: 'unknown' }), /Choose a value/);
});

test('View forwards runtime content through the existing ToolApi with trusted caller and exact target', async () => {
  const toolApi = createToolApi();
  const calls = [];
  const schema = toolJsonSchema({ type: 'object' });
  const operations = VIEW_WORKSPACE_OPERATIONS.filter(operation => operation.startsWith('runtime-pack.'));
  const provider = toolApi.registerProvider({
    providerId: 'runtime-fixture', sourceId: 'engine-workspace', realm: 'host',
    tools: operations.map(operation => defineTool({
      id: `engine.${operation}`, path: ['engine', ...operation.split('.')],
      title: operation, summary: 'Transport boundary fixture', realm: 'host',
      argsSchema: schema, resultSchema: schema, inputSchema: {}, outputSchema: {}, evidence: [],
    }, (args, context) => {
      calls.push({ operation, args, caller: context.caller });
      return { operation, accepted: true };
    })),
  });
  const broker = new ViewWorkspaceBroker({ toolApi, accessToken: 'fixture' });
  const caller = { connectionId: 'trusted-view', kind: 'frontend' };
  const client = new ViewWorkspaceClient({ clientId: 'view', token: 'fixture', transport: {
    request(service, payload, options) {
      assert.equal(service, VIEW_WORKSPACE_SERVICES.call);
      return broker.call(payload, { ...options, caller });
    },
  } });
  try {
    const target = { projectId: 'p', targetId: 't', worldId: 'w' };
    for (const operation of operations) {
      assert.deepEqual(await client.call(operation, { ...target, connectionId: 'spoofed' }), { operation, accepted: true });
      assert.deepEqual(calls.at(-1).caller, caller);
      assert.deepEqual(calls.at(-1).args, { ...target, connectionId: 'spoofed', clientId: 'view' });
    }
    await provider.revoke();
    await assert.rejects(client.call('runtime-pack.inspect', target), { code: 'view-workspace-operation-unavailable' });
    assert.equal(calls.length, operations.length);
  } finally { await broker.dispose(); await toolApi.dispose(); }
});
