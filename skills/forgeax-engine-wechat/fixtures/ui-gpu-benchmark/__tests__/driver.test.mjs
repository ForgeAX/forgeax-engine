import assert from 'node:assert/strict';
import test from 'node:test';
import { createBenchmarkDriver } from '../driver.js';

const settle = () => new Promise(setImmediate);
const methods = [
  'initialize',
  'active',
  'form',
  'performance',
  'cachedPerformance',
  'backgroundControl',
];
function fixture(overrides = {}) {
  const calls = [];
  const probe = Object.fromEntries(
    [...methods, 'dispose'].map((method) => [
      method,
      async (options) => {
        calls.push({ method, options });
        return { pass: true, nested: { preserved: true } };
      },
    ]),
  );
  return {
    calls,
    driver: createBenchmarkDriver({ ...probe, ...overrides }, { sha256: 'frozen-workload' }),
  };
}

test('starts each shared method once and pins full composition plus CPU correctness', async () => {
  const { calls, driver } = fixture();
  for (const method of methods) {
    assert.equal(driver.read().next, method === 'performance' ? 'dispose' : method);
    assert.equal(
      (method === 'performance' ? driver.startPerformance() : driver.startNext()).phase,
      'running',
    );
    driver.startNext();
    driver.dispose();
    await settle();
    assert.equal(driver.readStep(method).method, method);
  }
  assert.deepEqual(
    calls.map((call) => call.method),
    methods,
  );
  assert.deepEqual(calls[0].options, {
    backend: 'wgpu-webgl2',
    cpuReference: true,
    includeComposite: true,
  });
  assert.equal(driver.read().accepted, false);
  driver.startNext();
  await settle();
  assert.equal(driver.read().phase, 'complete');
  assert.equal(driver.read().accepted, true);
  assert.equal(driver.read().mode, 'performance');
  driver.startNext();
  driver.dispose();
  await settle();
  assert.equal(calls.filter((call) => call.method === 'dispose').length, 1);
});

test('default correctness journey stops after form and requires successful disposal', async () => {
  const { driver, calls } = fixture();
  driver.startPerformance();
  assert.deepEqual(calls, []);
  assert.equal(driver.read().mode, 'correctness');
  for (let i = 0; i < 3; i++) {
    driver.startNext();
    await settle();
  }
  assert.equal(driver.read().next, 'dispose');
  assert.equal(driver.read().accepted, false);
  driver.dispose();
  await settle();
  assert.equal(driver.read().mode, 'correctness');
  assert.equal(driver.read().accepted, true);
  driver.startPerformance();
  driver.startNext();
  await settle();
  assert.deepEqual(
    calls.map((call) => call.method),
    ['initialize', 'active', 'form', 'dispose'],
  );
  assert.equal(driver.readStep('performance'), null);
});

test('one extra startNext after correctness can only dispose, never start a timed workload', async () => {
  const { driver, calls } = fixture();
  for (let i = 0; i < 4; i++) {
    driver.startNext();
    await settle();
  }
  assert.equal(driver.read().accepted, true);
  assert.equal(driver.read().mode, 'correctness');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['initialize', 'active', 'form', 'dispose'],
  );
});

test('keeps a pending step isolated from repeat starts and concurrent disposal', async () => {
  let resolve;
  let disposed = false;
  const { driver } = fixture({
    initialize: () =>
      new Promise((done) => {
        resolve = done;
      }),
    dispose: () => {
      disposed = true;
    },
  });
  driver.startNext();
  await settle();
  assert.equal(driver.startNext().current, 'initialize');
  assert.equal(driver.dispose().current, 'initialize');
  assert.equal(disposed, false);
  resolve({ pixels: 'real-step-value' });
  await settle();
  assert.deepEqual(driver.readStep('initialize').value, { pixels: 'real-step-value' });
});

test('retains primary failures and permits cleanup without replaying the failed step', async () => {
  const { driver, calls } = fixture({
    initialize: () => {
      throw new Error('native WASM rejected');
    },
  });
  driver.startNext();
  await settle();
  assert.equal(driver.read().failure.error.message, 'native WASM rejected');
  assert.equal(driver.startNext().phase, 'failed');
  driver.dispose();
  await settle();
  assert.equal(driver.read().phase, 'failed');
  assert.equal(driver.read().accepted, false);
  assert.equal(driver.read().cleanup.success, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['dispose'],
  );
});

test('retains the structured native owner and operation instead of an object string', async () => {
  const { driver } = fixture({
    initialize: () => {
      throw {
        code: 'platform-unavailable',
        expected: 'native operation',
        hint: 'inspect the host',
        detail: { operation: 'wx.onShow' },
      };
    },
  });
  driver.startNext();
  await settle();
  assert.equal(driver.read().failure.error.code, 'platform-unavailable');
  assert.deepEqual(driver.read().failure.error.detail, { operation: 'wx.onShow' });
});

test('failed frame budget cannot become accepted merely because cleanup completes', async () => {
  const { driver } = fixture({
    performance: async () => ({ pass: false, frames: 60, completedThroughputFps: 12 }),
  });
  for (let index = 0; index <= methods.length; index++) {
    if (index === 3) driver.startPerformance();
    else driver.startNext();
    await settle();
  }
  assert.equal(driver.read().phase, 'complete');
  assert.equal(driver.read().accepted, false);
  assert.equal(driver.readStep('performance').value.completedThroughputFps, 12);
});

test('early or failed cleanup never claims the unexecuted budget', async () => {
  const early = fixture().driver;
  early.dispose();
  await settle();
  assert.equal(early.read().accepted, false);
  assert.deepEqual(early.read().completed, []);
  const failed = fixture({
    dispose: () => {
      throw new Error('surface cleanup failed');
    },
  }).driver;
  failed.dispose();
  await settle();
  assert.equal(failed.read().phase, 'failed');
  assert.equal(failed.read().cleanup.error.message, 'surface cleanup failed');
  assert.equal(failed.read().accepted, false);
});

test('automation snapshots cannot mutate retained step or cleanup evidence', async () => {
  const { driver } = fixture();
  driver.startNext();
  await settle();
  driver.readStep('initialize').value.nested.preserved = false;
  driver.read().identity.sha256 = 'changed';
  assert.equal(driver.readStep('initialize').value.nested.preserved, true);
  assert.equal(driver.read().identity.sha256, 'frozen-workload');
  driver.dispose();
  await settle();
  driver.readFacts().nested.preserved = false;
  assert.equal(driver.readFacts().nested.preserved, true);
  assert.equal('facts' in driver.read().cleanup, false);
});

test('final facts do not duplicate the receipts exported one phase per CLI call', async () => {
  const measured = { pass: true, receipts: [{ completedAt: 30 }] };
  const { driver } = fixture({
    performance: async () => measured,
    cachedPerformance: async () => measured,
    backgroundControl: async () => measured,
    dispose: async () => ({
      backend: 'wgpu-webgl2',
      width: 2532,
      performance: measured,
      cachedPerformance: measured,
      backgroundControl: measured,
    }),
  });
  for (let index = 0; index <= methods.length; index++) {
    if (index === 3) driver.startPerformance();
    else driver.startNext();
    await settle();
  }
  assert.deepEqual(driver.readFacts(), { backend: 'wgpu-webgl2', width: 2532 });
  for (const method of methods.slice(3)) assert.deepEqual(driver.readStep(method).value, measured);
  assert.equal(driver.read().accepted, true);
});
