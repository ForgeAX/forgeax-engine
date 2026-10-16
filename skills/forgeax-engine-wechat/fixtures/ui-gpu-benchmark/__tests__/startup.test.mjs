import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  hostStartupDocument,
  hostStartupScript,
} from '../../../../../packages/devkit/src/host/startup-source.ts';
import { createBlitzUi } from '../../../../../packages/ui-blitz/dist/index.mjs';
import { waitForStartupState } from '../driver.js';

const bytes = await readFile(
  new URL('../../../../../packages/ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url),
);
const wasm = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports),
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const createStartup = new Function('host', `return ${hostStartupScript(true, 'host').trim()}`);

test('two actual startup documents converge before parity without replacing their timers or text', {
  timeout: 6000,
}, async () => {
  const live = [];
  const create = async () => {
    const ui = await createBlitzUi({
      wasm,
      html: hostStartupDocument('Shared UI benchmark'),
      width: 844,
      height: 390,
      onError: (error) => {
        throw error;
      },
    });
    let time = 0;
    const surface = {};
    const startup = createStartup({
      document: ui.document,
      events: ui.document,
      surface: () => surface,
      now: () => time,
      visible: () => true,
      reducedMotion: false,
      reload: () => {
        throw new Error('Unexpected reload');
      },
    });
    live.push(() => {
      startup.destroy();
      ui.dispose();
    });
    const receipt = {
      worldIdentity: 'startup-parity-fixture',
      deviceGeneration: 1,
      frameId: 1,
      presentation: 'ready',
    };
    startup.bindSession(receipt.worldIdentity);
    startup.prepare();
    startup.submitted(receipt);
    startup.enter(receipt);
    return {
      document: ui.document,
      advance: () => {
        time = 3000;
      },
    };
  };
  try {
    const gpu = await create();
    gpu.advance();
    const deadline = performance.now() + 2000;
    while (
      gpu.document.querySelector('#forgeax-fps').textContent !== 'FPS 0.0' &&
      performance.now() < deadline
    )
      await pause(25);
    assert.equal(gpu.document.querySelector('#forgeax-fps').textContent, 'FPS 0.0');
    const cpu = await create();
    assert.equal(cpu.document.querySelector('#forgeax-fps').textContent, 'FPS --');
    let captured = false;
    await assert.rejects(
      async () => {
        await waitForStartupState(gpu.document, cpu.document, () => performance.now(), 60);
        captured = true;
      },
      (error) => {
        assert.equal(error.code, 'ui-benchmark-startup-state-timeout');
        assert.equal(error.detail.before.gpu.text, 'FPS 0.0');
        assert.equal(error.detail.after.cpu.text, 'FPS --');
        assert.equal(error.detail.timeoutMs, 60);
        return true;
      },
    );
    assert.equal(captured, false, 'divergent startup state must not reach pixel comparison');
    cpu.advance();
    const synchronized = await waitForStartupState(gpu.document, cpu.document, () =>
      performance.now(),
    );
    assert.equal(synchronized.before.gpu.text, 'FPS 0.0');
    assert.equal(synchronized.before.cpu.text, 'FPS --');
    assert.deepEqual(synchronized.after.gpu, { text: 'FPS 0.0', display: 'block' });
    assert.deepEqual(synchronized.after.cpu, synchronized.after.gpu);
    const equal = await waitForStartupState(gpu.document, cpu.document, () => performance.now());
    assert.deepEqual(equal.before, equal.after);
  } finally {
    for (const dispose of live.reverse()) dispose();
  }
});
