import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserConnection } from '../packages/viewer/src/plugins/browser-connection.ts';

const until = async predicate => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(done => setTimeout(done, 5));
  assert.ok(predicate());
};

test('connection owner retries with a bound and revokes late sessions on disposal', async () => {
  let calls = 0;
  const states = [];
  const owner = createBrowserConnection({
    delays: [1, 1],
    async connect() { calls++; throw new Error('network unavailable'); },
    onChange: state => states.push(state),
  });
  await owner.ready;
  await until(() => calls === 3 && states.at(-1)?.reconnectBusy === false);
  await owner.dispose();
  assert.equal(calls, 3);
  let resolve;
  let disposed = false;
  const late = createBrowserConnection({
    connect: () => new Promise(done => { resolve = done; }),
    onChange() {},
  });
  await late.ready;
  await until(() => resolve);
  await late.dispose();
  resolve({ async dispose() { disposed = true; } });
  await until(() => disposed);
});

test('explicit stop and authorization rejection do not trigger retries', async () => {
  let disconnect;
  let calls = 0;
  const owner = createBrowserConnection({
    delays: [1],
    async connect() {
      calls++;
      return { transport: { connected: true, onDisconnect(fn) { disconnect = fn; return () => {}; } }, async dispose() {} };
    },
    onChange() {},
  });
  await owner.ready;
  await until(() => disconnect);
  disconnect(new Error('resident View Host stopped'));
  await new Promise(done => setTimeout(done, 20));
  assert.equal(calls, 1);
  await owner.dispose();
});

test('rapid connect-close flapping consumes the same finite retry budget', async () => {
  let calls = 0;
  const states = [];
  const owner = createBrowserConnection({
    delays: [1, 1],
    async connect() {
      calls++;
      return {
        transport: { connected: true, onDisconnect(fn) {
          const timer = setTimeout(() => fn(new Error('network closed immediately')), 1);
          return () => clearTimeout(timer);
        } },
        async dispose() {},
      };
    },
    onChange: state => states.push(state),
  });
  try {
    await owner.ready;
    await until(() => states.at(-1)?.phase === 'disconnected' && states.at(-1)?.reconnectBusy === false);
    assert.equal(calls, 3);
  } finally { await owner.dispose(); }
});
