import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkBroker } from '../../src/app/broker.mjs';
import { randomBytes } from 'node:crypto';
import { readResourceBytes } from '../../src/app/resource-bytes.ts';
test('resource references survive a full scene burst within the byte budget', async () => {
  const broker = createNetworkBroker({ viewUrl: 'http://localhost:12345/' });
  try {
    const original = randomBytes(70000);
    const reference = broker.store(original, 'application/octet-stream');
    for (let index = 0; index < 400; index++)
      broker.store(`material artifact ${index}`, 'application/json');
    assert.deepEqual(Buffer.from(await readResourceBytes(reference, input => broker.invoke(input))), original);
  } finally {
    broker.close();
  }
});

test('resource references retain exact wire bytes across MIME-independent encoding', async () => {
  const broker = createNetworkBroker({ viewUrl: 'http://127.0.0.1:1/' });
  try {
    const raw = Buffer.alloc(65536, 97);
    const compressed = broker.store(raw, 'text/javascript');
    const binary = broker.store(raw, 'application/octet-stream');
    assert.equal(binary.resourceId, compressed.resourceId);
    assert.equal(binary.encoding, 'gzip');
    const head = await broker.invoke({ action: 'chunk', resourceId: compressed.resourceId, offset: 0 });
    const wire = Buffer.from(head.base64, 'base64');
    assert.equal(wire.length, compressed.bytes);
    const { gunzipSync } = await import('node:zlib');
    assert.deepEqual(gunzipSync(wire), raw);
  } finally {
    broker.close();
  }
});
