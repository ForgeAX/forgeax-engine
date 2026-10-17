import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  VIEW_EXTENSION_CAPABILITIES,
  VIEW_EXTENSION_ID,
  createViewExtensionTransport,
  createViewExtensionWorkspaceClient,
} from '@forgeax/view-workspace-core/extension-bridge';

describe('Scene View extension capability bridge', () => {
  it('forwards a read operation through the host without a resident token', async () => {
    const calls = [];
    const client = createViewExtensionWorkspaceClient({
      clientId: 'scene-frame',
      capabilities: [VIEW_EXTENSION_CAPABILITIES.read],
      invoke: (request) => {
        calls.push(request);
        return { revision: 1, project: null };
      },
    });

    assert.deepEqual(await client.getState(), { revision: 1, project: null });
    assert.equal(calls[0].extensionId, VIEW_EXTENSION_ID);
    assert.equal(calls[0].capability, VIEW_EXTENSION_CAPABILITIES.read);
    assert.equal(calls[0].request.token, undefined);
  });

  it('rejects authoring operations until the host grants the author capability', async () => {
    const transport = createViewExtensionTransport({
      capabilities: [VIEW_EXTENSION_CAPABILITIES.read],
      invoke: () => assert.fail('a denied operation must not reach the host'),
    });
    await assert.rejects(
      transport.request('forgeax.view.workspace.call', { operation: 'asset.source.rebuild' }),
      (error) => error?.code === 'view-extension-capability-denied'
        && error.detail.capability === VIEW_EXTENSION_CAPABILITIES.author,
    );
  });

  it('treats source-file preview as a read capability', async () => {
    const calls = [];
    const transport = createViewExtensionTransport({
      capabilities: [VIEW_EXTENSION_CAPABILITIES.read],
      invoke: (request) => {
        calls.push(request);
        return { kind: 'text', content: 'export {}\n' };
      },
    });
    const preview = await transport.request('forgeax.view.file.get', { path: 'assets/world.pack.ts' });
    assert.equal(preview.content, 'export {}\n');
    assert.equal(calls[0].capability, VIEW_EXTENSION_CAPABILITIES.read);
    assert.equal(calls[0].service, 'forgeax.view.file.get');
  });
});


it('extension entrypoints retain the missing host invoke diagnostic', () => {
  for (const create of [createViewExtensionTransport, createViewExtensionWorkspaceClient]) {
    assert.throws(() => create(), {
      name: 'TypeError', message: 'View extension transport requires a host capability invoke function',
    });
  }
});
