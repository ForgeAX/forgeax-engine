import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBackendHost } from '@forgeax/engine-host';
import workspacePlugin from '@forgeax/view-workspace-core/backend';
import { createInspectorRequest, viewInspectorBackendPlugin } from '../packages/view-plugin-plugins/src/runtime.ts';

test('native Inspector tools drain before broker state is released and preserve the borrowed Host', async () => {
  const host = await createBackendHost();
  const workspace = host.context.plugin(workspacePlugin, { workspaceAccessToken: 'native-fixture' });
  await workspace.await();
  const inspector = host.context.plugin(viewInspectorBackendPlugin);
  await inspector.await();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  try {
    const api = host.context.toolApi;
    const broker = host.context.viewInspector;
    const owner = api.describe('plugins.sources', 'view-backend').find(record => record.callable)?.owner;
    assert.ok(owner);
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    broker.reports.set('drain-evidence', {});
    broker.sources = async () => { enter(); await blocked; return { sources: [] }; };
    const run = api.run('plugins.sources', createInspectorRequest('plugins.sources', {}, { clientId: 'test', token: 'native-fixture' }), owner);
    await entered;
    const closing = inspector.dispose();
    // Revocation signals the operation before resources used by it can go away.
    await run.terminal;
    assert.equal(broker.reports.has('drain-evidence'), true);
    release();
    await closing;
    assert.equal(broker.reports.size, 0);
    assert.equal(api.describe('plugins.sources', 'view-backend').some(record => record.callable), false);
    assert.equal(host.context.get('viewWorkspaceCore'), workspace.ctx.viewWorkspaceCore);
    assert.equal(host.assembly.activation.state, 'active');
  } finally { release(); await host.dispose(); }
});
