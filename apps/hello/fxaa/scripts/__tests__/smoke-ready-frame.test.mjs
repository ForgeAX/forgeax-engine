import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';

const source = readFileSync(new URL('../smoke-dawn.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function renderAndRead(');
const helper = source.slice(start, source.indexOf('\n// Pass 1:', start));

function runRead(receipts) {
  const events = [];
  const lease = Object.freeze({ generation: 3 });
  let submissions = 0;
  const renderer = {
    draw(request) {
      assert.equal(request.source, lease);
      const facts = receipts[submissions++];
      assert.ok(facts, 'unexpected extra submission');
      events.push(`submit:${facts.presentation}`);
      return {
        ok: true,
        value: {
          frameId: submissions,
          ...facts,
          completed: Promise.resolve().then(() => {
            events.push(`complete:${facts.presentation}`);
            return facts.completion ?? { ok: true, unwrap() {} };
          }),
        },
      };
    },
  };
  const renderAndRead = runInNewContext(`${helper}; renderAndRead`, {
    renderer,
    drawReadyFrame,
    device: { queue: { async onSubmittedWorkDone() { events.push('queue'); } } },
    doReadPixels() { events.push('read'); return new Uint8Array([1, 2, 3, 255]); },
  });
  return {
    events,
    result: renderAndRead({ update() { events.push('update'); return { unwrap() {} }; } }, lease),
  };
}

test('FXAA smoke credits pixels only after the ready picture completes', async () => {
  const run = runRead([{ presentation: 'pending' }, { presentation: 'ready' }]);
  assert.deepEqual(Array.from(await run.result), [1, 2, 3, 255]);
  assert.deepEqual(run.events, [
    'update', 'submit:pending', 'complete:pending', 'submit:ready', 'complete:ready', 'queue', 'read',
  ]);
});

test('FXAA smoke retains failed completion without reading pixels', async () => {
  const failure = new Error('native submission failed');
  const run = runRead([{
    presentation: 'ready',
    completion: { ok: false, error: failure, unwrap() { throw failure; } },
  }]);
  await assert.rejects(run.result, (error) => error === failure);
  assert.deepEqual(run.events, ['update', 'submit:ready', 'complete:ready']);
});
