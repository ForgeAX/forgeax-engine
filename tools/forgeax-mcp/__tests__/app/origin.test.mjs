import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNetworkBroker } from '../../src/app/broker.mjs';
test('publicly admitted loopback services accept localhost and IPv4 spellings at the same port', () => {
  const broker = createNetworkBroker({ viewUrl: 'http://localhost:4100/' });
  try {
    assert.equal(broker.allow('http://127.0.0.1:4100/bootstrap').hostname, '127.0.0.1');
    broker.admit({ target: { url: 'http://localhost:4200/?forgeaxWorkspaceTarget=target' } });
    assert.equal(broker.allow('http://127.0.0.1:4200/shaders/manifest.json').port, '4200');
    assert.equal(broker.allow('ws://127.0.0.1:4200/host').protocol, 'ws:');
    assert.throws(() => broker.allow('http://127.0.0.1:4300/private'));
    assert.throws(() => broker.allow('http://example.org:4200/private'));
    assert.throws(() => broker.allow('file:///private/file'));
  } finally {
    broker.close();
  }
});
