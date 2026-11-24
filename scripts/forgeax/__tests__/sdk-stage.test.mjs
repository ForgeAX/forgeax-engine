import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { sdkStage } from '../sdk-stage.mjs';

test('an unresolved SDK observation fails within its existing deadline', async () => {
  const outcome = await Promise.race([
    sdkStage('test.inspection', () => new Promise(() => {}), 20).then(
      () => 'unexpected success',
      (error) => error.message,
    ),
    sleep(250, 'unbounded observation'),
  ]);
  assert.equal(outcome, 'test.inspection timed out after 20ms');
});

test('SDK phase boundaries retain UTC timestamps without changing operation results', async () => {
  const messages = [];
  const log = mock.method(console, 'error', (message) => messages.push(String(message)));
  try {
    assert.equal(await sdkStage('test.timestamp', () => 7), 7);
  } finally {
    log.mock.restore();
  }
  assert.equal(messages.length, 2);
  assert.match(
    messages[0],
    /^\[sdk\] start test.timestamp.* at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
  );
  assert.match(
    messages[1],
    /^\[sdk\] complete test.timestamp elapsedMs=\d+ at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
  );
});
