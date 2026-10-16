import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhoneGameplaySocket } from '../phone_gameplay_socket.mjs';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const callbacks = {},
    sends = [],
    failures = [],
    report = {};
  const options = {
    controlUrl: 'http://127.0.0.1:1234/deadline',
    runId: 'offline_deadline_contract',
    source: { manifestSha256: 'a'.repeat(64) },
  };
  const socket = createPhoneGameplaySocket(
    options,
    {
      connectSocket() {
        return {
          onOpen(fn) {
            callbacks.open = fn;
          },
          onClose(fn) {
            callbacks.close = fn;
          },
          onError(fn) {
            callbacks.error = fn;
          },
          onMessage(fn) {
            callbacks.message = fn;
          },
          send(value) {
            sends.push(JSON.parse(value.data));
            value.success({});
          },
          close(value) {
            value.success({});
            callbacks.close({ code: 1000 });
          },
        };
      },
    },
    report,
    { now: () => Date.now(), failure: (error) => failures.push(error) },
  );
  return {
    socket,
    sends,
    failures,
    report,
    async connect() {
      const opened = socket.connect();
      callbacks.open({});
      await opened;
    },
    reply(stage, action) {
      callbacks.message({
        data: JSON.stringify({
          kind: 'forgeax-phone-gameplay-control/1',
          runId: options.runId,
          source: options.source,
          stage,
          action,
        }),
      });
    },
  };
}

test('ready can await reviewed preparation past 20 seconds without another send or debug change', async (t) => {
  const f = fixture(t);
  await f.connect();
  const response = f.socket.exchange('ready', 'arm', {});
  t.mock.timers.tick(30000);
  f.reply('ready', 'arm');
  assert.equal((await response).action, 'arm');
  assert.deepEqual(
    f.sends.map((row) => row.stage),
    ['ready'],
  );
  assert.deepEqual(f.report.debugReceipts, []);
  assert.deepEqual(f.failures, []);
});

test('ready still expires at 120 seconds; release and explicit arm lead-in keep their deadlines', async (t) => {
  const f = fixture(t);
  await f.connect();
  for (const [stage, action, timeout, expected] of [
    ['ready', 'arm', undefined, 120000],
    ['release', 'released', undefined, 20000],
    ['armed', 'accepted', 2000, 2000],
  ]) {
    let settled = false;
    const response = f.socket.exchange(stage, action, {}, timeout);
    const rejected = assert.rejects(response, new RegExp(`${stage}: socket deadline`));
    response.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    t.mock.timers.tick(expected - 1);
    await new Promise(setImmediate);
    assert.equal(settled, false, stage);
    t.mock.timers.tick(1);
    await rejected;
  }
  assert.deepEqual(
    f.sends.map((row) => row.stage),
    ['ready', 'release', 'armed'],
  );
});
