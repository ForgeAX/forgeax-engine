import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const compiled = await build({
  entryPoints: [new URL('../../src/app/host-poll.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { createHostPoll } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);
test('all realm connections share one tick and slow reads cannot accumulate', async () => {
  let calls = 0,
    active = 0,
    peak = 0;
  const counts = [];
  const poll = createHostPoll(async (params) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    counts.push(params.arguments.connectionIds.length);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active--;
    return {
      structuredContent: {
        connections: params.arguments.connectionIds.map((connectionId) => ({
          connectionId,
          response: { id: connectionId },
        })),
      },
    };
  }, 'transport');
  for (let tick = 0; tick < 3; tick++)
    assert.deepEqual(
      (await Promise.all(['view', 'editor', 'worker'].map((id) => poll.read(id)))).map(
        (value) => value.structuredContent.id,
      ),
      ['view', 'editor', 'worker'],
    );
  assert.equal(calls, 3);
  assert.deepEqual(counts, [3, 3, 3]);
  assert.equal(peak, 1);
  poll.close();
  await assert.rejects(poll.read('view'), /retired/);
});
