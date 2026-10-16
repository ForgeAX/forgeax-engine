import assert from 'node:assert/strict';
import test from 'node:test';
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
