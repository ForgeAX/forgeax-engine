import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostTransport } from '@forgeax/engine-host';
import { ViewInspectorBroker, ViewInspectorClient, createInspectorRequest } from '../packages/view-plugin-plugins/src/runtime.ts';

function fixture() {
  const server = createHostTransport();
  const broker = new ViewInspectorBroker({ transport: server, accessToken: 'test-token' });
  const dispose = broker.install({ dispatch: ({ payload, caller }) => broker.report(payload, caller) });
  return { server, broker, dispose() { dispose(); server.close(); } };
}
const report = { sourceId: 'view-frontend', actual: { state: 'active' }, plugins: [] };

for (const [kind, sourceId, accepted] of [
  ['frontend', 'view-frontend', true],
  ['frontend', 'forgeax-workspace:session:target', true],
  ['frontend', 'forgeax-workspace::target', false],
  ['frontend', 'forgeax-workspace:session:', false],
  ['websocket', 'forgeax-workspace:session:target', false],
  ['cli', 'view-frontend', false],
]) {
  test(`inspector admission for ${kind}/${sourceId}`, async () => {
    const f = fixture();
    const transport = f.server.connect({ kind, sourceId });
    const client = new ViewInspectorClient({ transport, clientId: 'test', token: 'test-token' });
    try {
      if (accepted) {
        const result = await client.report(report);
        assert.notEqual(result.sourceId, report.sourceId);
        assert.equal(f.broker.reports.size, 1);
        await assert.rejects(new ViewInspectorClient({ transport, clientId: 'test', token: 'wrong' }).report(report));
      } else await assert.rejects(client.report(report), { code: 'view-inspector-unauthorized' });
      transport.close();
      assert.equal(f.broker.reports.size, 0);
      assert.equal(f.broker.frontendCapabilities.size, 0);
    } finally { f.dispose(); }
  });
}

test('workspace report identity and capability remain connection-owned across reconnect', async () => {
  const f = fixture();
  const callers = [];
  f.server.onClientConnect(caller => callers.push(caller));
  const connect = () => {
    const transport = f.server.connect({ kind: 'frontend', sourceId: 'forgeax-workspace:session:target' });
    return { transport, client: new ViewInspectorClient({ transport, clientId: 'test', token: 'test-token' }) };
  };
  const first = connect(), second = connect();
  try {
    const a = await first.client.report(report), b = await second.client.report(report);
    assert.notEqual(a.sourceId, b.sourceId);
    first.transport.close();
    assert.equal(f.broker.reports.has(a.sourceId), false);
    assert.equal(f.broker.reports.has(b.sourceId), true);
    const request = createInspectorRequest('plugins.report', { report }, { clientId: 'test', token: 'test-token' });
    await assert.rejects(f.broker.report(request, callers[0]), { code: 'view-inspector-unauthorized' });
    await assert.rejects(f.broker.report(request, { ...callers[1], capability: callers[0].capability }), { code: 'view-inspector-unauthorized' });
    assert.equal((await second.client.report(report)).sourceId, b.sourceId);
  } finally { f.dispose(); }
});


test('inspector preserves missing transport and dispatch diagnostics', () => {
  assert.throws(() => new ViewInspectorBroker(), {
    name: 'TypeError', message: 'View inspector requires an Engine Host transport',
  });
  assert.throws(() => new ViewInspectorClient(), {
    name: 'TypeError', message: 'View inspector client requires an Engine Host transport',
  });
  assert.throws(() => createInspectorRequest('plugins.sources'), {
    code: 'view-workspace-invalid-args', detail: { field: 'clientId' },
  });
  const server = createHostTransport();
  const broker = new ViewInspectorBroker({ transport: server, accessToken: 'test-token' });
  try {
    assert.throws(() => broker.install(), {
      name: 'TypeError', message: 'View inspector requires an Engine ToolApi dispatch adapter',
    });
  } finally { server.close(); }
});

test('frontend reports reject primitives without changing an admitted source', async () => {
  const f = fixture();
  const transport = f.server.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  const client = new ViewInspectorClient({ transport, clientId: 'test', token: 'test-token' });
  try {
    const accepted = await client.report(report);
    for (const invalid of ['bad', 42]) {
      await assert.rejects(client.report(invalid), { code: 'view-inspector-invalid-report' });
      assert.equal(f.broker.reports.size, 1);
      assert.equal(f.broker.reports.get(accepted.sourceId).generation, accepted.generation);
    }
  } finally { transport.close(); f.dispose(); }
});
