import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { productionCspCommands } from './production-csp.commands.mjs';

test('production fixture closes unfinished HTTP connections through the Preview owner', {
  timeout: 10_000,
}, async (t) => {
  const { url } = await productionCspCommands.prepareWgpuProductionFixture(undefined, false);
  const pending = request(url, {
    method: 'POST',
    headers: { Expect: '100-continue', 'Content-Length': '1' },
  });
  // The real server acknowledges the headers, but the client retains its body.
  // Teardown owns this unfinished connection; raw close waits for its expiry.
  pending.on('error', () => {});
  t.signal.addEventListener('abort', () => pending.destroy(), { once: true });
  let closing;
  let timeout;
  try {
    const accepted = once(pending, 'continue');
    pending.flushHeaders();
    await accepted;
    const closed = new Promise((resolve) => pending.once('close', resolve));
    closing = productionCspCommands.releaseWgpuProductionFixture();
    await Promise.race([
      closing,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Preview shutdown retained an unfinished connection')),
          2_000,
        );
      }),
    ]);
    await closed;
    assert.equal(pending.destroyed, true);
    await productionCspCommands.releaseWgpuProductionFixture();
  } finally {
    clearTimeout(timeout);
    pending.destroy();
    await closing;
    await productionCspCommands.releaseWgpuProductionFixture();
  }
});
