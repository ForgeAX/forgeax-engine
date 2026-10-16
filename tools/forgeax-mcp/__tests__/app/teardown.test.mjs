import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { retireViewResources } from '../../src/app/retire-view.ts';

test('real App teardown acknowledges child cleanup before bridge removal', async () => {
  const [host, child] = InMemoryTransport.createLinkedPair();
  const app = new App({ name: 'child', version: '1' }, {}, { autoResize: false });
  const bridge = new AppBridge(null, { name: 'host', version: '1' }, { serverTools: {} });
  const order = [];
  app.onteardown = async () => {
    order.push('child-cleanup');
    return {};
  };
  await bridge.connect(host);
  await app.connect(child);
  const close = bridge.close.bind(bridge);
  bridge.close = async () => {
    order.push('bridge-close');
    await close();
  };
  await retireViewResources(
    [
      {
        bridge,
        frame: {
          remove() {
            order.push('frame-remove');
          },
        },
      },
    ],
    [
      {
        close() {
          order.push('host-close');
        },
      },
    ],
    () => order.push('runtime-dispose'),
  );
  assert.deepEqual(order, [
    'child-cleanup',
    'bridge-close',
    'frame-remove',
    'host-close',
    'runtime-dispose',
  ]);
  await app.close();
});

test('one failed child still retires every sibling, Host lease and network runtime', async () => {
  const order = [];
  const frames = ['failed', 'healthy'].map((name) => ({
    frame: {
      remove() {
        order.push(`${name}-remove`);
      },
    },
    bridge: {
      getAppVersion() { return { name, version: '1' }; },
      async teardownResource() {
        if (name === 'failed') throw new Error('child failed');
      },
      async close() {
        order.push(`${name}-close`);
      },
    },
  }));
  await assert.rejects(
    retireViewResources(
      frames,
      [
        {
          async close() {
            order.push('host-close');
          },
        },
      ],
      () => order.push('runtime-dispose'),
    ),
    (error) => error instanceof AggregateError && error.errors.length === 1,
  );
  assert.equal(order.filter((value) => value.endsWith('-remove')).length, 2);
  assert.deepEqual(order.slice(-2), ['host-close', 'runtime-dispose']);
});

test('a surface cancelled before App initialization closes without waiting for teardown', async () => {
  const order = [];
  await retireViewResources([{ bridge: {
    getAppVersion: () => undefined,
    teardownResource() { throw new Error('Uninitialized App must not receive teardown'); },
    async close() { order.push('bridge-close'); },
  }, frame: { remove() { order.push('frame-remove'); } } }], [], () => order.push('runtime-dispose'));
  assert.deepEqual(order, ['bridge-close', 'frame-remove', 'runtime-dispose']);
});
