import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostTransport } from '@forgeax/engine-host/transport';
import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import { ViewWorkspaceClient } from '../packages/view-workspace-core/src/client.ts';
import { attachPresentationResponder } from '../packages/view-workspace-core/src/presentation.ts';

const snapshot = { shellState: 'mounted', activePageId: null, pages: [], pageTypes: [], panels: [],
  hasMorePages: false, hasMorePageTypes: false, hasMorePanels: false,
  appearance: { theme: 'light', preference: 'system', language: 'en' } };

test('project presentation waits for exact old frame retirement and rejects cross-page claims', async () => {
  const transport = createHostTransport();
  const broker = new ViewWorkspaceBroker({ accessToken: 'present-test' });
  const unregister = broker.registerTransport(transport);
  const first = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const second = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const client = new ViewWorkspaceClient({ transport: second, clientId: 'test', token: broker.accessToken });
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const retired = new Promise(resolve => { release = resolve; });
  const detach = attachPresentationResponder(first, async operation => {
    assert.equal(operation, 'presentation.document.release');
    began();
    await retired;
    return snapshot;
  });
  try {
    const claiming = client.presentProject();
    await started;
    assert.equal(broker.projectDocumentOwnerId, first.caller.connectionId);
    assert.equal((await client.getState()).projectDocumentPresentation, 'observer');
    release();
    assert.equal((await claiming).projectDocumentPresentation, 'presenter');
    assert.equal(broker.projectDocumentOwnerId, second.caller.connectionId);
    await assert.rejects(client.call('project.present', { connectionId: first.caller.connectionId }), error => error.code === 'view-presentation-page-denied');
  } finally {
    release(); detach(); unregister(); first.close(); second.close(); await broker.dispose(); transport.close();
  }
});

test('failed renderer retirement preserves the original presenter', async () => {
  const transport = createHostTransport();
  const broker = new ViewWorkspaceBroker({ accessToken: 'present-test' });
  const unregister = broker.registerTransport(transport);
  const first = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const second = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const client = new ViewWorkspaceClient({ transport: second, clientId: 'test', token: broker.accessToken });
  const detach = attachPresentationResponder(first, () => { throw new Error('GPU cleanup failed'); });
  try {
    await assert.rejects(client.presentProject(), /GPU cleanup failed/);
    assert.equal(broker.projectDocumentOwnerId, first.caller.connectionId);
    assert.equal((await client.getState()).projectDocumentPresentation, 'observer');
  } finally { detach(); unregister(); first.close(); second.close(); await broker.dispose(); transport.close(); }
});
