import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Execute the actual Blob prelude. The real Browser gate still destroys the GPU
// and verifies replacement, completed pixels, World identity and bounded ticks.
const source = readFileSync(
  new URL('../../../packages/app/__tests__/render-worker-bootstrap.ts', import.meta.url),
  'utf8',
);
const start = source.indexOf('          let device;');
const end = source.indexOf('          await import(', start);
assert.ok(start >= 0 && end > start);

for (const injected of [false, true])
  test(`Render Worker native destruction projects unexpected loss only when injected=${injected}`, async () => {
    let resolveLoss;
    let destroys = 0;
    let handler;
    const native = {
      lost: new Promise((resolve) => {
        resolveLoss = resolve;
      }),
      destroy() {
        destroys++;
        resolveLoss({ reason: 'destroyed', message: 'native device destroyed' });
      },
    };
    const gpu = { requestAdapter: async () => ({ requestDevice: async () => native }) };
    runInNewContext(`${source.slice(start, end)}; ready = true;`, {
      navigator: { gpu },
      addEventListener: (_name, listener) => {
        handler = listener;
      },
    });
    const device = await (await gpu.requestAdapter()).requestDevice();
    assert.equal(device, native);
    assert.equal(destroys, 0);
    if (injected) handler({ data: 'lose-device', stopImmediatePropagation() {} });
    else device.destroy();
    const loss = await device.lost;
    assert.equal(destroys, 1, 'the actual native destroy remains the loss trigger');
    assert.equal(loss.reason, injected ? 'unknown' : 'destroyed');
    assert.ok(loss.message.includes('native device destroyed'));
  });
